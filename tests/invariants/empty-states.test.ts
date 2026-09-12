import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import {
  EmptyRosterError,
  candidatesForSchedule,
  currentRoster,
  setStudentStatus,
} from '../../src/services/rosterService.js';
import { type Seed, freshSeed, testPool } from '../helpers.js';

/**
 * Инварианты 3, 4, 5: структура существует независимо от заселения.
 *
 * Пустая комната, пустой блок и пустой этаж — нормальные состояния данных,
 * а не ошибки. Но пустой этаж не позволяет создать график, и студенты
 * других этажей для компенсации не используются.
 */
describe('пустые состояния', () => {
  let db: pg.Pool;
  let seed: Seed;

  beforeAll(async () => {
    db = testPool();
    seed = await freshSeed(db);
  });
  afterAll(async () => {
    await db.end();
  });

  it('3 · пустая комната валидна и не мешает составу', async () => {
    // 704 создана в seed и не заселена.
    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM students WHERE room_id = $1`,
      [seed.rooms['704']],
    );
    expect(rows[0]!.count).toBe('0');

    const roster = await currentRoster(db, seed.floors['7']!);
    expect(roster).not.toBeNull();
    expect(roster!.entries.some((e) => e.room_number_snapshot === '704')).toBe(false);
    expect(roster!.entries.length).toBeGreaterThan(0);
  });

  it('3a · комнату можно создать и оставить пустой', async () => {
    await db.query(
      `INSERT INTO rooms (floor_id, number, sort_order) VALUES ($1, '705', 99)`,
      [seed.floors['7']!],
    );
    const { rows } = await db.query<{ number: string }>(
      `SELECT r.number FROM rooms r
        LEFT JOIN students s ON s.room_id = r.id
       WHERE r.number = '705' AND s.id IS NULL`,
    );
    expect(rows).toHaveLength(1);
  });

  it('4 · пустой блок валиден', async () => {
    // Блок 607 создан в seed с двумя комнатами и без жильцов.
    const { rows } = await db.query<{ code: string; students: string }>(
      `SELECT b.code, count(s.id)::text AS students
         FROM blocks b
         JOIN rooms r   ON r.block_id = b.id
         LEFT JOIN students s ON s.room_id = r.id
        WHERE b.code = '607'
        GROUP BY b.code`,
    );
    expect(rows[0]!.students).toBe('0');
  });

  it('4a · пустой блок не даёт кандидатов для графика', async () => {
    const { candidates } = await candidatesForSchedule(db, seed.floors['6']!);
    expect(candidates.some((c) => c.block_code_snapshot === '607')).toBe(false);
  });

  it('5 · пустой этаж валиден как состояние данных', async () => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO floors (dormitory_id, number, slot_template_id, rule_set_id)
       SELECT $1, 9, slot_template_id, rule_set_id FROM floors LIMIT 1
       RETURNING id`,
      [seed.dormitoryId],
    );
    const emptyFloor = rows[0]!.id;

    await db.query(
      `INSERT INTO rooms (floor_id, number, sort_order) VALUES ($1, '901', 0)`,
      [emptyFloor],
    );

    // Пустая версия состава — допустима.
    const version = await db.query<{ id: string }>(
      `INSERT INTO roster_versions (floor_id, version_no, status, source, confirmed_at)
       VALUES ($1, 1, 'confirmed', 'setup', now()) RETURNING id`,
      [emptyFloor],
    );
    expect(version.rows[0]!.id).toBeTruthy();

    const roster = await currentRoster(db, emptyFloor);
    expect(roster!.entries).toHaveLength(0);
  });

  it('5a · на пустом этаже график создать нельзя', async () => {
    const { rows } = await db.query<{ id: string }>(
      `SELECT f.id FROM floors f WHERE f.number = 9 AND f.dormitory_id = $1`,
      [seed.dormitoryId],
    );
    const emptyFloor = rows[0]!.id;

    await expect(candidatesForSchedule(db, emptyFloor)).rejects.toBeInstanceOf(EmptyRosterError);
    await expect(candidatesForSchedule(db, emptyFloor)).rejects.toThrow(
      /нет активных студентов/,
    );
  });

  it('5b · этаж, где все выселены, тоже блокирует создание графика', async () => {
    const floor7 = seed.floors['7']!;
    const { rows } = await db.query<{ id: string }>(
      'SELECT id FROM students WHERE floor_id = $1',
      [floor7],
    );
    for (const row of rows) {
      await setStudentStatus(db, row.id, 'moved_out');
    }

    await expect(candidatesForSchedule(db, floor7)).rejects.toThrow(/нет активных студентов/);

    // И при этом ни один студент другого этажа не подставился.
    const roster = await currentRoster(db, floor7);
    expect(roster!.entries).toHaveLength(0);
  });

  it('5c · этаж без подтверждённого состава сообщает об этом отдельно', async () => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO floors (dormitory_id, number, slot_template_id, rule_set_id)
       SELECT $1, 10, slot_template_id, rule_set_id FROM floors LIMIT 1
       RETURNING id`,
      [seed.dormitoryId],
    );
    await expect(candidatesForSchedule(db, rows[0]!.id)).rejects.toThrow(/не подтверждён/);
  });
});
