import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { candidatesForSchedule, currentRoster } from '../../src/services/rosterService.js';
import { type Seed, expectDbError, freshSeed, testPool } from '../helpers.js';

/**
 * Инварианты 1 и 2: жёсткая изоляция этажей.
 *
 * Проверяется, что изоляция обеспечена базой и сервисом, а не интерфейсом:
 * все попытки идут в обход админки, прямыми запросами.
 */
describe('изоляция этажей', () => {
  let db: pg.Pool;
  let seed: Seed;

  beforeAll(async () => {
    db = testPool();
    seed = await freshSeed(db);
  });
  afterAll(async () => {
    await db.end();
  });

  const floor6 = () => seed.floors['6']!;
  const floor7 = () => seed.floors['7']!;

  it('1 · студент 6 этажа не может попасть в roster 7 этажа', async () => {
    const version7 = await currentRoster(db, floor7());
    const student6 = seed.students['Иванов Иван']!;

    // Прямая вставка в состав чужого этажа.
    const error = await expectDbError(() =>
      db.query(
        `INSERT INTO roster_entries
           (roster_version_id, floor_id, student_id, full_name_snapshot, room_id,
            room_number_snapshot, student_status_snapshot)
         VALUES ($1, $2, $3, 'Иванов Иван', $4, '701', 'active')`,
        [version7!.version.id, floor7(), student6, seed.rooms['701']],
      ),
    );
    expect(error.message).toMatch(/другому этажу|another/i);
  });

  it('1a · подмена floor_id в строке состава тоже отклоняется', async () => {
    const version7 = await currentRoster(db, floor7());
    const student6 = seed.students['Петров Пётр']!;

    // Здесь floor_id указан «правильный» для студента, но не совпадает
    // с этажом версии — ловит составной FK на roster_versions.
    const error = await expectDbError(() =>
      db.query(
        `INSERT INTO roster_entries
           (roster_version_id, floor_id, student_id, full_name_snapshot, room_id,
            room_number_snapshot, student_status_snapshot)
         VALUES ($1, $2, $3, 'Петров Пётр', $4, '601А', 'active')`,
        [version7!.version.id, floor6(), student6, seed.rooms['601А']],
      ),
    );
    expect(error.message).toMatch(/roster_entry_version_floor|foreign key/i);
  });

  it('1b · студент не может быть привязан к комнате чужого этажа', async () => {
    const student6 = seed.students['Иванов Иван']!;
    const error = await expectDbError(() =>
      db.query('UPDATE students SET room_id = $2 WHERE id = $1', [
        student6,
        seed.rooms['701'],
      ]),
    );
    expect(error.message).toMatch(/student_room_same_floor|foreign key/i);
  });

  it('2 · кандидаты для графика 7 этажа не содержат студентов 6 этажа', async () => {
    const { candidates } = await candidatesForSchedule(db, floor7());
    expect(candidates.length).toBeGreaterThan(0);

    const { rows } = await db.query<{ id: string }>(
      'SELECT id FROM students WHERE floor_id = $1',
      [floor6()],
    );
    const floor6Ids = new Set(rows.map((r) => r.id));

    for (const candidate of candidates) {
      expect(candidate.floor_id).toBe(floor7());
      expect(floor6Ids.has(candidate.student_id)).toBe(false);
    }
  });

  it('2a · график не может ссылаться на состав другого этажа', async () => {
    const roster6 = await currentRoster(db, floor6());
    const error = await expectDbError(() =>
      db.query(
        `INSERT INTO duty_schedules
           (floor_id, year, month, roster_version_id, slot_template_snapshot,
            rule_set_snapshot, dormitory_snapshot, generated_by)
         VALUES ($1, 2026, 9, $2, '{}', '{}', '{}', 'algorithm')`,
        [floor7(), roster6!.version.id],
      ),
    );
    expect(error.message).toMatch(/schedule_roster_same_floor|foreign key/i);
  });

  it('2b · факультет не сужает состав этажа', async () => {
    // На 6 этаже живут студенты двух факультетов — оба должны быть
    // кандидатами. Этаж и факультет независимы.
    const { candidates } = await candidatesForSchedule(db, floor6());
    const faculties = new Set(candidates.map((c) => c.faculty_code_snapshot));
    expect(faculties.size).toBeGreaterThan(1);
  });
});
