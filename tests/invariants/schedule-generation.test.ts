import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { daysInMonth, expandMonth, isoWeekday } from '../../src/domain/calendar.js';
import { DEFAULT_RULES, isAvailable } from '../../src/domain/duty.js';
import { checkFeasibility } from '../../src/domain/feasibility.js';
import { generateSchedule } from '../../src/domain/scheduleGenerator.js';
import {
  InfeasibleScheduleError,
  ScheduleError,
  feasibility,
  generate,
  generationHistory,
  loadContext,
  publish,
  rosterDrift,
} from '../../src/services/scheduleService.js';
import {
  relocateStudent,
  setStudentStatus,
  transferStudent,
} from '../../src/services/rosterService.js';
import { type Seed, expectDbError, freshSeed, testPool } from '../helpers.js';

describe('генерация графика', () => {
  let db: pg.Pool;
  let seed: Seed;
  let floor6: string;
  let floor7: string;

  beforeEach(async () => {
    db = testPool();
    seed = await freshSeed(db);
    floor6 = seed.floors['6']!;
    floor7 = seed.floors['7']!;
  });
  afterEach(async () => {
    await db.end();
  });

  const dutiesOf = async (scheduleId: string) => {
    const { rows } = await db.query<{
      duty_date: string;
      slot_order: number;
      time_from: string;
      time_to: string;
      student_id: string | null;
      student_name_snapshot: string | null;
      floor_number_snapshot: number | null;
    }>(
      `SELECT duty_date, slot_order, time_from, time_to, student_id,
              student_name_snapshot, floor_number_snapshot
         FROM duties WHERE schedule_id = $1 ORDER BY duty_date, slot_order`,
      [scheduleId],
    );
    return rows;
  };

  it('1 · график создаётся только для выбранного этажа', async () => {
    const result = await generate(db, { floorId: floor6, year: 2026, month: 9 });
    const { rows } = await db.query<{ floor_id: string }>(
      'SELECT floor_id FROM duty_schedules WHERE id = $1',
      [result.scheduleId],
    );
    expect(rows[0]!.floor_id).toBe(floor6);

    const duties = await dutiesOf(result.scheduleId);
    expect(duties.every((d) => d.floor_number_snapshot === 6)).toBe(true);
  });

  it('2 · студент другого этажа никогда не попадает в график', async () => {
    const result = await generate(db, { floorId: floor6, year: 2026, month: 9 });
    const duties = await dutiesOf(result.scheduleId);

    const { rows: floor7Students } = await db.query<{ id: string }>(
      'SELECT id FROM students WHERE floor_id = $1',
      [floor7],
    );
    const foreign = new Set(floor7Students.map((s) => s.id));
    for (const duty of duties) {
      if (duty.student_id) expect(foreign.has(duty.student_id)).toBe(false);
    }

    // И кандидаты формируются только из своего этажа.
    const context = await loadContext(db, { floorId: floor6, year: 2026, month: 9 });
    expect(context.candidates.every((c) => c.floorId === floor6)).toBe(true);
  });

  it('2a · пустой этаж не заполняется студентами соседнего', async () => {
    const { rows } = await db.query<{ id: string }>(
      'SELECT id FROM students WHERE floor_id = $1',
      [floor7],
    );
    for (const row of rows) await setStudentStatus(db, row.id, 'moved_out');

    await expect(generate(db, { floorId: floor7, year: 2026, month: 9 })).rejects.toBeInstanceOf(
      InfeasibleScheduleError,
    );

    // График 6 этажа при этом строится и содержит только своих.
    const result = await generate(db, { floorId: floor6, year: 2026, month: 9 });
    expect(result.generation.stats.assignedSlots).toBeGreaterThan(0);
  });

  it('3 · количество слотов корректно для 28, 29, 30 и 31 дня', async () => {
    const context = await loadContext(db, { floorId: floor6, year: 2026, month: 9 });
    const cases: Array<[number, number, number]> = [
      [2027, 2, 28],
      [2028, 2, 29], // високосный
      [2026, 9, 30],
      [2026, 1, 31],
    ];

    for (const [year, month, expectedDays] of cases) {
      expect(daysInMonth(year, month)).toBe(expectedDays);
      const slots = expandMonth(context.template, year, month);
      const dates = new Set(slots.map((s) => s.date));
      expect(dates.size).toBe(expectedDays);
      // Сетка задаёт по 4 смены на каждый день недели.
      expect(slots).toHaveLength(expectedDays * 4);
    }
  });

  it('3a · февраль 2028 генерируется как 29 дней', async () => {
    const result = await generate(db, { floorId: floor6, year: 2028, month: 2 });
    const duties = await dutiesOf(result.scheduleId);
    const dates = new Set(duties.map((d) => d.duty_date));
    expect(dates.size).toBe(29);
    expect(duties).toHaveLength(29 * 4);
  });

  it('4 · воскресенье использует отдельную сетку', async () => {
    const result = await generate(db, { floorId: floor6, year: 2026, month: 9 });
    const duties = await dutiesOf(result.scheduleId);

    const sundays = duties.filter((d) => {
      const [y, m, day] = d.duty_date.split('-').map(Number);
      return isoWeekday(y!, m!, day!) === 7;
    });
    expect(sundays.length).toBeGreaterThan(0);

    const times = new Set(sundays.map((d) => `${d.time_from.slice(0, 5)}-${d.time_to.slice(0, 5)}`));
    expect(times).toContain('10:00-12:30');
    expect(times).toContain('12:30-15:00');
    expect(times).not.toContain('09:00-11:00');
  });

  it('5 · будни используют стандартную сетку', async () => {
    const result = await generate(db, { floorId: floor6, year: 2026, month: 9 });
    const duties = await dutiesOf(result.scheduleId);

    const weekdays = duties.filter((d) => {
      const [y, m, day] = d.duty_date.split('-').map(Number);
      return isoWeekday(y!, m!, day!) !== 7;
    });
    const times = new Set(
      weekdays.map((d) => `${d.time_from.slice(0, 5)}-${d.time_to.slice(0, 5)}`),
    );
    expect(times).toEqual(
      new Set(['09:00-11:00', '11:00-13:00', '19:00-21:00', '21:00-23:00']),
    );
  });

  it('6 · один студент не получает пересекающиеся дежурства', async () => {
    const result = await generate(db, { floorId: floor6, year: 2026, month: 9 });
    const duties = await dutiesOf(result.scheduleId);

    const byStudentDate = new Map<string, Array<[number, number]>>();
    const minutes = (t: string): number => {
      const [h, m] = t.split(':');
      return Number(h) * 60 + Number(m);
    };

    for (const duty of duties) {
      if (!duty.student_id) continue;
      const key = `${duty.student_id}|${duty.duty_date}`;
      const list = byStudentDate.get(key) ?? [];
      list.push([minutes(duty.time_from), minutes(duty.time_to)]);
      byStudentDate.set(key, list);
    }

    for (const [key, intervals] of byStudentDate) {
      intervals.sort((a, b) => a[0] - b[0]);
      for (let i = 1; i < intervals.length; i += 1) {
        expect(intervals[i]![0], `пересечение у ${key}`).toBeGreaterThanOrEqual(
          intervals[i - 1]![1],
        );
      }
    }
  });

  it('6a · один слот занят ровно одним студентом', async () => {
    const result = await generate(db, { floorId: floor6, year: 2026, month: 9 });
    const duties = await dutiesOf(result.scheduleId);
    const keys = duties.map((d) => `${d.duty_date}|${d.slot_order}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('7 · учебное время блокирует соответствующие слоты', async () => {
    // Первая смена учится 08:30–14:00 в Пн–Сб: утренние слоги ей закрыты.
    await db.query(
      `UPDATE study_shifts SET busy_from = '08:30', busy_to = '14:00' WHERE code = '1'`,
    );
    const context = await loadContext(db, { floorId: floor6, year: 2026, month: 9 });
    const shiftOne = context.candidates.filter((c) => c.studyShift?.code === '1');
    expect(shiftOne.length).toBeGreaterThan(0);

    const morningWeekday = context.slots.find(
      (s) => s.weekday !== 7 && s.timeFrom === '09:00',
    )!;
    const evening = context.slots.find((s) => s.weekday !== 7 && s.timeFrom === '19:00')!;

    for (const candidate of shiftOne) {
      expect(isAvailable(candidate, morningWeekday, context.rules)).toBe(false);
      expect(isAvailable(candidate, evening, context.rules)).toBe(true);
    }
  });

  it('7a · заблокированный студент не появляется в утренних слотах графика', async () => {
    await db.query(
      `UPDATE study_shifts SET busy_from = '08:30', busy_to = '14:00' WHERE code = '1'`,
    );
    const context = await loadContext(db, { floorId: floor6, year: 2026, month: 9 });
    const blocked = new Set(
      context.candidates.filter((c) => c.studyShift?.code === '1').map((c) => c.studentId),
    );

    const result = await generate(db, { floorId: floor6, year: 2026, month: 9 });
    const duties = await dutiesOf(result.scheduleId);

    const morning = duties.filter(
      (d) => d.time_from.slice(0, 5) === '09:00' || d.time_from.slice(0, 5) === '11:00',
    );
    for (const duty of morning) {
      if (duty.student_id) expect(blocked.has(duty.student_id)).toBe(false);
    }
  });

  it('8 · NULL учебное время не блокирует слот', async () => {
    const context = await loadContext(db, { floorId: floor6, year: 2026, month: 9 });
    expect(context.candidates.every((c) => c.studyShift?.busyFrom === null)).toBe(true);

    for (const slot of context.slots.slice(0, 8)) {
      for (const candidate of context.candidates) {
        expect(isAvailable(candidate, slot, context.rules)).toBe(true);
      }
    }
  });

  it('9 · warning появляется при отсутствии учебного времени', async () => {
    const report = await feasibility(db, { floorId: floor6, year: 2026, month: 9 });
    expect(report.warnings.join(' ')).toMatch(/Учебное время не задано для смен: 1, 2/);
    expect(report.warnings.join(' ')).toMatch(/не применяется/);

    const result = await generate(db, { floorId: floor6, year: 2026, month: 9 });
    expect(result.generation.warnings.join(' ')).toMatch(/Учебное время не задано/);
  });

  it('9a · заданное учебное время предупреждения не вызывает', async () => {
    await db.query(`UPDATE study_shifts SET busy_from = '08:30', busy_to = '13:00'`);
    const report = await feasibility(db, { floorId: floor6, year: 2026, month: 9 });
    expect(report.warnings.join(' ')).not.toMatch(/Учебное время не задано/);
  });

  it('10 · распределение максимально равномерное', async () => {
    const result = await generate(db, { floorId: floor6, year: 2026, month: 9 });
    const s = result.generation.stats;

    expect(s.assignedSlots).toBe(120);
    expect(s.students).toBe(7);
    // 120 / 7 = 17.14 → нагрузка обязана лежать в 17–18.
    expect(s.minLoad).toBe(17);
    expect(s.maxLoad).toBe(18);
    expect(s.loadSpread).toBeLessThanOrEqual(1);
  });

  it('10a · равномерность держится и на другом размере месяца', async () => {
    const result = await generate(db, { floorId: floor7, year: 2026, month: 2 });
    const s = result.generation.stats;
    // Февраль 2026: 28 дней × 4 = 112 слотов на 5 студентов.
    expect(s.totalSlots).toBe(112);
    expect(s.loadSpread).toBeLessThanOrEqual(1);
    expect(s.minLoad).toBe(22);
    expect(s.maxLoad).toBe(23);
  });

  it('11 · hard constraints не нарушаются ради равномерности', async () => {
    // Первая смена занята утром — равномерность не должна это перебить.
    await db.query(
      `UPDATE study_shifts SET busy_from = '08:30', busy_to = '14:00' WHERE code = '1'`,
    );
    const context = await loadContext(db, { floorId: floor6, year: 2026, month: 9 });
    const result = await generate(db, { floorId: floor6, year: 2026, month: 9 });

    const byId = new Map(context.candidates.map((c) => [c.studentId, c]));
    const slotByKey = new Map(context.slots.map((s) => [`${s.date}|${s.slotOrder}`, s]));
    const duties = await dutiesOf(result.scheduleId);

    for (const duty of duties) {
      if (!duty.student_id) continue;
      const candidate = byId.get(duty.student_id)!;
      const slot = slotByKey.get(`${duty.duty_date}|${duty.slot_order}`)!;
      expect(
        isAvailable(candidate, slot, context.rules),
        `${candidate.displayName} назначен в запрещённое время`,
      ).toBe(true);
    }
  });

  it('12 · soft constraints нарушаются, если иначе график невозможен', async () => {
    // 7 студентов на 120 слотов: интервал в 3 дня выдержать невозможно.
    const result = await generate(db, { floorId: floor6, year: 2026, month: 9 });
    expect(result.generation.stats.softViolations.minDaysBetween).toBeGreaterThan(0);

    // Но при этом все слоты закрыты и hard-ограничения целы.
    expect(result.generation.stats.unassignedSlots).toBe(0);
    expect(result.generation.stats.softViolations.sameDay).toBe(0);
  });

  it('13 · пустой roster → график невозможен', async () => {
    const { rows } = await db.query<{ id: string }>(
      'SELECT id FROM students WHERE floor_id = $1',
      [floor6],
    );
    for (const row of rows) await setStudentStatus(db, row.id, 'moved_out');

    const report = await feasibility(db, { floorId: floor6, year: 2026, month: 9 });
    expect(report.feasible).toBe(false);
    // Все выселены → в подтверждённом составе ноль строк.
    expect(report.reasons.join(' ')).toMatch(/состав этажа пуст/i);

    await expect(generate(db, { floorId: floor6, year: 2026, month: 9 })).rejects.toBeInstanceOf(
      InfeasibleScheduleError,
    );

    // Ни одного дежурства не создано.
    const { rows: created } = await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM duty_schedules WHERE floor_id = $1',
      [floor6],
    );
    expect(created[0]!.count).toBe('0');
  });

  it('14 · недостаточно кандидатов → feasibility объясняет причину', async () => {
    // Всем задано учебное время, закрывающее утренние смены будней.
    await db.query(`UPDATE study_shifts SET busy_from = '08:30', busy_to = '14:00'`);

    const report = await feasibility(db, { floorId: floor6, year: 2026, month: 9 });
    expect(report.feasible).toBe(false);
    expect(report.blockedSlots.length).toBeGreaterThan(0);
    expect(report.reasons.join(' ')).toMatch(/не имеют ни одного допустимого кандидата/);
    expect(report.suggestions.length).toBeGreaterThan(0);
    expect(report.suggestions.join(' ')).toMatch(/prefer_free|квоты/);

    await expect(generate(db, { floorId: floor6, year: 2026, month: 9 })).rejects.toThrow(
      InfeasibleScheduleError,
    );
  });

  it('14a · дефицит по группе слотов считается по условию Холла', () => {
    // Синтетический случай: часть слотов доступна только одному студенту,
    // и их больше, чем он способен взять при текущей квоте.
    const slots = Array.from({ length: 100 }, (_, i) => ({
      date: `2026-09-${String((i % 30) + 1).padStart(2, '0')}`,
      weekday: ((i % 7) + 1) as number,
      slotOrder: (i % 4) + 1,
      // Первые 60 слотов — «утренние», их закроет только вторая смена.
      timeFrom: i < 60 ? '09:00' : '19:00',
      timeTo: i < 60 ? '11:00' : '21:00',
      index: i,
    }));

    const busyMorning = {
      id: 's1',
      code: '1',
      busyFrom: '08:30',
      busyTo: '14:00',
      busyWeekdays: [1, 2, 3, 4, 5, 6, 7],
    };
    const candidates = [
      {
        studentId: 'a',
        floorId: 'f',
        displayName: 'Свободен утром',
        roomNumber: '1',
        studyShift: null,
        allowBusySlots: false,
        previousLoad: 0,
      },
      {
        studentId: 'b',
        floorId: 'f',
        displayName: 'Учится утром',
        roomNumber: '2',
        studyShift: busyMorning,
        allowBusySlots: false,
        previousLoad: 0,
      },
    ];

    const report = checkFeasibility({
      slots,
      candidates,
      rules: { ...DEFAULT_RULES, allowQuotaOverflow: false },
      rosterSize: candidates.length,
    });

    expect(report.feasible).toBe(false);
    expect(report.groups.length).toBeGreaterThan(0);
    const group = report.groups[0]!;
    expect(group.candidates).toBe(1);
    expect(group.slots).toBe(60);
    expect(group.deficit).toBeGreaterThan(0);
    expect(report.reasons.join(' ')).toMatch(/доступны только 1 студенту/);
  });

  it('15 · генерация создаёт draft, а не published', async () => {
    const result = await generate(db, { floorId: floor6, year: 2026, month: 9 });
    expect(result.status).toBe('draft');

    const { rows } = await db.query<{ status: string; published_at: string | null }>(
      'SELECT status, published_at FROM duty_schedules WHERE id = $1',
      [result.scheduleId],
    );
    expect(rows[0]!.status).toBe('draft');
    expect(rows[0]!.published_at).toBeNull();
  });

  it('16 · публикация сохраняет snapshot', async () => {
    const result = await generate(db, { floorId: floor6, year: 2026, month: 9 });
    await publish(db, result.scheduleId);

    const { rows } = await db.query<{
      status: string;
      published_at: string;
      roster_version_id: string;
      slot_template_snapshot: unknown;
      rule_set_snapshot: unknown;
      dormitory_snapshot: { dormitory_number: string; floor_number: number };
      approval_snapshot: { warden_name: string | null };
    }>('SELECT * FROM duty_schedules WHERE id = $1', [result.scheduleId]);
    const schedule = rows[0]!;

    expect(schedule.status).toBe('published');
    expect(schedule.published_at).toBeTruthy();
    expect(schedule.roster_version_id).toBeTruthy();
    expect(schedule.slot_template_snapshot).toBeTruthy();
    expect(schedule.dormitory_snapshot.floor_number).toBe(6);
    expect(schedule.approval_snapshot.warden_name).toBe('Круклинская Л.В.');
  });

  it('16a · график с незакрытыми слотами не публикуется', async () => {
    const result = await generate(db, { floorId: floor6, year: 2026, month: 9 });
    await db.query(
      `UPDATE duties SET student_id = NULL, student_name_snapshot = NULL,
              room_number_snapshot = NULL, floor_number_snapshot = NULL
        WHERE schedule_id = $1 AND duty_date = '2026-09-01' AND slot_order = 1`,
      [result.scheduleId],
    );
    await expect(publish(db, result.scheduleId)).rejects.toThrow(/незакрытыми слотами/);
  });

  it('17 · изменение roster после публикации не меняет график', async () => {
    const result = await generate(db, { floorId: floor6, year: 2026, month: 9 });
    await publish(db, result.scheduleId);
    const before = await dutiesOf(result.scheduleId);

    await relocateStudent(db, seed.students['Волков Егор']!, seed.rooms['607А']!);
    await setStudentStatus(db, seed.students['Морозов Артём']!, 'moved_out');
    await transferStudent(db, seed.students['Смирнов Алексей']!, {
      floorId: floor7,
      roomId: seed.rooms['704']!,
    });

    expect(await dutiesOf(result.scheduleId)).toEqual(before);

    const drift = await rosterDrift(db, result.scheduleId);
    expect(drift.drifted).toBe(true);
    expect(drift.message).toMatch(/Опубликованный график сохранён/);
    expect(drift.message).toMatch(/Рекомендуется создать новый график/);
  });

  it('17a · назначения опубликованного графика запрещены к правке в БД', async () => {
    const result = await generate(db, { floorId: floor6, year: 2026, month: 9 });
    await publish(db, result.scheduleId);

    const error = await expectDbError(() =>
      db.query(
        `UPDATE duties SET student_id = NULL WHERE schedule_id = $1 AND slot_order = 1`,
        [result.scheduleId],
      ),
    );
    // Прямая правка запрещена: изменение оформляется только заменой,
    // которая пишется в duty_changes и печатается в таблице изменений.
    expect(error.message).toMatch(/только через замену/);
  });

  it('18 · повторная генерация не ломает предыдущий опубликованный график', async () => {
    const september = await generate(db, { floorId: floor6, year: 2026, month: 9 });
    await publish(db, september.scheduleId);
    const before = await dutiesOf(september.scheduleId);

    // Перегенерация того же месяца отклоняется.
    await expect(generate(db, { floorId: floor6, year: 2026, month: 9 })).rejects.toThrow(
      /уже опубликован/,
    );

    // Другой месяц генерируется свободно.
    const october = await generate(db, { floorId: floor6, year: 2026, month: 10 });
    expect(october.scheduleId).not.toBe(september.scheduleId);
    expect(await dutiesOf(september.scheduleId)).toEqual(before);
  });

  it('18a · перегенерация черновика сохраняет историю прогонов', async () => {
    const first = await generate(db, { floorId: floor6, year: 2026, month: 9 });
    expect(first.attemptNo).toBe(1);

    const second = await generate(db, { floorId: floor6, year: 2026, month: 9 });
    expect(second.attemptNo).toBe(2);
    expect(second.scheduleId).toBe(first.scheduleId);

    const history = await generationHistory(db, first.scheduleId);
    expect(history).toHaveLength(2);
    expect(history[0]!.attemptNo).toBe(2);
    expect(history[0]!.isCurrent).toBe(true);
    expect(history[1]!.isCurrent).toBe(false);

    // Старый прогон сохранён целиком и неизменяем.
    const error = await expectDbError(() =>
      db.query(`UPDATE duty_generations SET assignments = '[]' WHERE attempt_no = 1`),
    );
    expect(error.message).toMatch(/нельзя переписать/);
  });

  it('18b · повторная генерация даёт тот же результат', async () => {
    const hash = (value: unknown): string =>
      createHash('sha256').update(JSON.stringify(value)).digest('hex');

    const first = await generate(db, { floorId: floor6, year: 2026, month: 9 });
    const second = await generate(db, { floorId: floor6, year: 2026, month: 9 });

    expect(hash(second.generation.assignments)).toBe(hash(first.generation.assignments));
    expect(second.generation.seed).toBe(first.generation.seed);
    expect(second.generation.algorithm).toBe(first.generation.algorithm);
  });

  it('18c · генератор детерминирован и без БД', () => {
    const context = {
      slots: expandMonth(
        {
          id: 't',
          name: 'Стандарт',
          rules: [
            { weekday: 1, slotOrder: 1, timeFrom: '09:00', timeTo: '11:00' },
            { weekday: 2, slotOrder: 1, timeFrom: '09:00', timeTo: '11:00' },
            { weekday: 3, slotOrder: 1, timeFrom: '09:00', timeTo: '11:00' },
            { weekday: 4, slotOrder: 1, timeFrom: '09:00', timeTo: '11:00' },
            { weekday: 5, slotOrder: 1, timeFrom: '09:00', timeTo: '11:00' },
            { weekday: 6, slotOrder: 1, timeFrom: '09:00', timeTo: '11:00' },
            { weekday: 7, slotOrder: 1, timeFrom: '10:00', timeTo: '12:30' },
          ],
        },
        2026,
        9,
      ),
      candidates: ['a', 'b', 'c'].map((id) => ({
        studentId: id,
        floorId: 'f',
        displayName: id,
        roomNumber: '1',
        studyShift: null,
        allowBusySlots: false,
        previousLoad: 0,
      })),
      rules: DEFAULT_RULES,
      seed: 'fixed',
    };

    const a = generateSchedule(context);
    const b = generateSchedule(context);
    expect(a.assignments).toEqual(b.assignments);
    expect(a.stats.loadSpread).toBeLessThanOrEqual(1);
  });

  it('19 · комнаты с 0, 1, 2 и 3 жильцами работают корректно', async () => {
    const context = await loadContext(db, { floorId: floor6, year: 2026, month: 9 });

    const perRoom = new Map<string, number>();
    for (const candidate of context.candidates) {
      perRoom.set(candidate.roomNumber, (perRoom.get(candidate.roomNumber) ?? 0) + 1);
    }
    expect(perRoom.get('601А')).toBe(3);
    expect(perRoom.get('605А')).toBe(2);
    expect(perRoom.get('601Б')).toBe(1);
    expect(perRoom.has('607А')).toBe(false); // пустая комната кандидатов не даёт

    const result = await generate(db, { floorId: floor6, year: 2026, month: 9 });
    const loads = result.generation.stats.perStudent;

    // Комната в математике не участвует: житель 601Б (один в комнате)
    // получает столько же, сколько каждый из троих в 601А.
    const alone = loads.find((l) => l.displayName === 'Кузнецов Дмитрий')!;
    const crowded = loads.find((l) => l.displayName === 'Иванов Иван')!;
    expect(Math.abs(alone.load - crowded.load)).toBeLessThanOrEqual(1);
  });

  it('19a · комната не влияет на суммарную нагрузку своих жильцов', async () => {
    const result = await generate(db, { floorId: floor6, year: 2026, month: 9 });
    const duties = await dutiesOf(result.scheduleId);

    const perRoom = new Map<string, number>();
    for (const duty of duties) {
      const { rows } = await db.query<{ number: string }>(
        `SELECT r.number FROM students s JOIN rooms r ON r.id = s.room_id WHERE s.id = $1`,
        [duty.student_id],
      );
      const room = rows[0]?.number;
      if (room) perRoom.set(room, (perRoom.get(room) ?? 0) + 1);
    }

    // 601А (3 жильца) получает примерно втрое больше, чем 601Б (1 жилец) —
    // потому что кандидат это студент, а не комната.
    expect(perRoom.get('601А')! / perRoom.get('601Б')!).toBeGreaterThan(2.5);
  });

  it('20 · графики 6 и 7 этажей полностью изолированы', async () => {
    const six = await generate(db, { floorId: floor6, year: 2026, month: 9 });
    const seven = await generate(db, { floorId: floor7, year: 2026, month: 9 });
    expect(six.scheduleId).not.toBe(seven.scheduleId);

    const dutiesSix = await dutiesOf(six.scheduleId);
    const dutiesSeven = await dutiesOf(seven.scheduleId);

    const idsSix = new Set(dutiesSix.map((d) => d.student_id).filter(Boolean));
    const idsSeven = new Set(dutiesSeven.map((d) => d.student_id).filter(Boolean));

    for (const id of idsSix) expect(idsSeven.has(id)).toBe(false);
    expect(dutiesSix.every((d) => d.floor_number_snapshot === 6)).toBe(true);
    expect(dutiesSeven.every((d) => d.floor_number_snapshot === 7)).toBe(true);
  });

  it('20a · график не может ссылаться на состав чужого этажа', async () => {
    const result = await generate(db, { floorId: floor6, year: 2026, month: 9 });
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM roster_versions WHERE floor_id = $1 AND status = 'confirmed'`,
      [floor7],
    );
    const error = await expectDbError(() =>
      db.query('UPDATE duty_schedules SET roster_version_id = $2 WHERE id = $1', [
        result.scheduleId,
        rows[0]!.id,
      ]),
    );
    expect(error.message).toMatch(/schedule_roster_same_floor|foreign key/i);
  });

  it('черновик без подтверждённого состава не создаётся', async () => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO floors (dormitory_id, number, slot_template_id, rule_set_id)
       SELECT $1, 11, slot_template_id, rule_set_id FROM floors LIMIT 1 RETURNING id`,
      [seed.dormitoryId],
    );
    await expect(
      generate(db, { floorId: rows[0]!.id, year: 2026, month: 9 }),
    ).rejects.toBeInstanceOf(ScheduleError);
  });
});
