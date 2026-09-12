import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { expandMonth, isoWeekday } from '../../src/domain/calendar.js';
import { DEFAULT_RULES, isAvailable } from '../../src/domain/duty.js';
import { generateSchedule } from '../../src/domain/scheduleGenerator.js';
import { generate, loadContext } from '../../src/services/scheduleService.js';
import { type Seed, freshSeed, testPool } from '../helpers.js';

/**
 * Разнообразие расстановки без случайности.
 *
 * До версии v2 при малом числе студентов график вырождался в жёсткую
 * недельную ротацию: 7 студентов × 4 смены = 28 назначений = 7 дней × 4,
 * состояние после каждой недели повторялось, и жадный выбор воспроизводил
 * ту же расстановку. Один и тот же человек получал вторник 09:00 все
 * четыре недели подряд.
 */
describe('разнообразие графика', () => {
  let db: pg.Pool;
  let seed: Seed;
  let floor6: string;

  beforeEach(async () => {
    db = testPool();
    seed = await freshSeed(db);
    floor6 = seed.floors['6']!;
  });
  afterEach(async () => {
    await db.end();
  });

  const dutiesOf = async (scheduleId: string) => {
    const { rows } = await db.query<{
      duty_date: string;
      slot_order: number;
      student_id: string | null;
      student_name_snapshot: string | null;
    }>(
      `SELECT duty_date, slot_order, student_id, student_name_snapshot
         FROM duties WHERE schedule_id = $1 ORDER BY duty_date, slot_order`,
      [scheduleId],
    );
    return rows.map((r) => ({
      ...r,
      weekday: isoWeekday(...(r.duty_date.split('-').map(Number) as [number, number, number])),
    }));
  };

  it('демо-сценарий с 7 студентами больше не даёт недельный повтор', async () => {
    const result = await generate(db, { floorId: floor6, year: 2026, month: 9 });
    const duties = await dutiesOf(result.scheduleId);

    // 01.09.2026 — вторник. Все вторники месяца, первая смена.
    const tuesdayMornings = duties
      .filter((d) => d.weekday === 2 && d.slot_order === 1)
      .map((d) => d.student_name_snapshot);

    expect(tuesdayMornings.length).toBeGreaterThanOrEqual(4);
    expect(
      new Set(tuesdayMornings).size,
      `все вторники 09:00 достались одному: ${tuesdayMornings.join(', ')}`,
    ).toBeGreaterThan(1);
  });

  it('ни одна пара «день недели + смена» не закреплена за одним человеком', async () => {
    const result = await generate(db, { floorId: floor6, year: 2026, month: 9 });
    const duties = await dutiesOf(result.scheduleId);

    const byPair = new Map<string, Set<string>>();
    const occurrences = new Map<string, number>();
    for (const duty of duties) {
      if (!duty.student_id) continue;
      const key = `${duty.weekday}:${duty.slot_order}`;
      byPair.set(key, (byPair.get(key) ?? new Set()).add(duty.student_id));
      occurrences.set(key, (occurrences.get(key) ?? 0) + 1);
    }

    const monopolised: string[] = [];
    for (const [key, students] of byPair) {
      // Пара встречается в месяце несколько раз, а достаётся одному —
      // это и есть периодичность, которую надо было убрать.
      if ((occurrences.get(key) ?? 0) >= 3 && students.size === 1) monopolised.push(key);
    }
    expect(monopolised, `монополизированные пары: ${monopolised.join(', ')}`).toEqual([]);
  });

  it('повторов одной пары у студента меньше, чем недель в месяце', async () => {
    const result = await generate(db, { floorId: floor6, year: 2026, month: 9 });
    const stats = result.generation.stats;

    // В сентябре 2026 каждый день недели встречается 4–5 раз.
    // Периодичный алгоритм давал бы maxPairRepeat = 4–5.
    expect(stats.diversity.maxPairRepeat).toBeLessThanOrEqual(3);
    expect(stats.diversity.averageUniquePairs).toBeGreaterThan(10);

    // Дни недели разнообразны. Полное покрытие всех семи не гарантируется:
    // приоритет у равномерности нагрузки, и ради лишнего дня недели
    // алгоритм не станет портить баланс.
    const reachable = Math.min(6, stats.minLoad);
    expect(stats.diversity.distinctWeekdaysMin).toBeGreaterThanOrEqual(reachable);
  });

  it('разнообразие не сломало равномерность', async () => {
    const result = await generate(db, { floorId: floor6, year: 2026, month: 9 });
    const stats = result.generation.stats;

    expect(stats.assignedSlots).toBe(120);
    expect(stats.loadSpread).toBeLessThanOrEqual(1);
    expect(stats.minLoad).toBe(17);
    expect(stats.maxLoad).toBe(18);

    // Баланс по типам смен тоже сохранился.
    const counts = stats.perSlotOrder.map((s) => s.assigned);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(2);
  });

  it('разнообразие не нарушает hard-ограничения', async () => {
    await db.query(
      `UPDATE study_shifts SET busy_from = '08:30', busy_to = '14:00' WHERE code = '1'`,
    );
    const context = await loadContext(db, { floorId: floor6, year: 2026, month: 9 });
    const result = await generate(db, { floorId: floor6, year: 2026, month: 9 });

    const byId = new Map(context.candidates.map((c) => [c.studentId, c]));
    const slotByKey = new Map(context.slots.map((s) => [`${s.date}|${s.slotOrder}`, s]));

    for (const duty of await dutiesOf(result.scheduleId)) {
      if (!duty.student_id) continue;
      const candidate = byId.get(duty.student_id)!;
      const slot = slotByKey.get(`${duty.duty_date}|${duty.slot_order}`)!;
      expect(
        isAvailable(candidate, slot, context.rules),
        `${candidate.displayName} назначен в учебное время`,
      ).toBe(true);
    }
  });

  it('разнообразие остаётся воспроизводимым', async () => {
    const hash = (value: unknown): string =>
      createHash('sha256').update(JSON.stringify(value)).digest('hex');

    const first = await generate(db, { floorId: floor6, year: 2026, month: 9 });
    const second = await generate(db, { floorId: floor6, year: 2026, month: 9 });
    const third = await generate(db, { floorId: floor6, year: 2026, month: 9 });

    expect(hash(second.generation.assignments)).toBe(hash(first.generation.assignments));
    expect(hash(third.generation.assignments)).toBe(hash(first.generation.assignments));
  });

  it('чистый генератор: 7 кандидатов не дают недельного повтора', () => {
    const template = {
      id: 't',
      name: 'Стандарт',
      rules: [1, 2, 3, 4, 5, 6].flatMap((weekday) => [
        { weekday, slotOrder: 1, timeFrom: '09:00', timeTo: '11:00' },
        { weekday, slotOrder: 2, timeFrom: '11:00', timeTo: '13:00' },
        { weekday, slotOrder: 3, timeFrom: '19:00', timeTo: '21:00' },
        { weekday, slotOrder: 4, timeFrom: '21:00', timeTo: '23:00' },
      ]).concat([
        { weekday: 7, slotOrder: 1, timeFrom: '10:00', timeTo: '12:30' },
        { weekday: 7, slotOrder: 2, timeFrom: '12:30', timeTo: '15:00' },
        { weekday: 7, slotOrder: 3, timeFrom: '19:00', timeTo: '21:00' },
        { weekday: 7, slotOrder: 4, timeFrom: '21:00', timeTo: '23:00' },
      ]),
    };

    const result = generateSchedule({
      slots: expandMonth(template, 2026, 9),
      candidates: Array.from({ length: 7 }, (_, i) => ({
        studentId: `s${i}`,
        floorId: 'f',
        displayName: `Студент ${i}`,
        roomNumber: '1',
        studyShift: null,
        allowBusySlots: false,
        previousLoad: 0,
      })),
      rules: DEFAULT_RULES,
      seed: 'fixed',
    });

    expect(result.stats.diversity.maxPairRepeat).toBeLessThanOrEqual(3);
    expect(result.stats.loadSpread).toBeLessThanOrEqual(1);

    // Первая смена всех вторников достаётся разным людям.
    const tuesdays = result.assignments.filter((a) => {
      const [y, m, d] = a.date.split('-').map(Number);
      return isoWeekday(y!, m!, d!) === 2 && a.slotOrder === 1;
    });
    expect(new Set(tuesdays.map((a) => a.studentId)).size).toBeGreaterThan(1);
  });
});
