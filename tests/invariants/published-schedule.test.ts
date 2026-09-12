import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import {
  currentRoster,
  relocateStudent,
  setStudentStatus,
  transferStudent,
  updateStudentAttributes,
} from '../../src/services/rosterService.js';
import { type Seed, expectDbError, freshSeed, testPool } from '../helpers.js';

/**
 * Инвариант 9: опубликованный график не меняется после изменения
 * текущего состава, комнат, факультетов, смен и настроек.
 *
 * Генератор появится в M4 — здесь график собирается вручную, потому что
 * проверяется свойство хранилища, а не алгоритма.
 */
describe('неизменяемость опубликованного графика', () => {
  let db: pg.Pool;
  let seed: Seed;
  let scheduleId: string;
  let rosterVersionId: string;

  const snapshot = async (): Promise<unknown[]> => {
    const { rows } = await db.query(
      `SELECT duty_date, slot_order, time_from, time_to, student_id,
              student_name_snapshot, room_number_snapshot, floor_number_snapshot
         FROM duties WHERE schedule_id = $1 ORDER BY duty_date, slot_order`,
      [scheduleId],
    );
    return rows;
  };

  beforeEach(async () => {
    db = testPool();
    seed = await freshSeed(db);

    const roster = await currentRoster(db, seed.floors['6']!);
    rosterVersionId = roster!.version.id;

    const schedule = await db.query<{ id: string }>(
      `INSERT INTO duty_schedules
         (floor_id, year, month, status, roster_version_id, slot_template_snapshot,
          rule_set_snapshot, dormitory_snapshot, approval_snapshot,
          generated_by, published_at)
       VALUES ($1, 2026, 9, 'published', $2,
               '{"1":[{"slot_order":1,"from":"09:00","to":"11:00"}]}',
               '{"min_days_between":3}',
               '{"dormitory_number":"4","floor_number":6}',
               '{"warden_name":"Круклинская Л.В."}',
               'algorithm', now())
       RETURNING id`,
      [seed.floors['6']!, rosterVersionId],
    );
    scheduleId = schedule.rows[0]!.id;

    let day = 1;
    for (const entry of roster!.entries.slice(0, 4)) {
      await db.query(
        `INSERT INTO duties
           (schedule_id, duty_date, slot_order, time_from, time_to, student_id,
            student_name_snapshot, room_number_snapshot, floor_number_snapshot)
         VALUES ($1, $2, 1, '09:00', '11:00', $3, $4, $5, 6)`,
        [
          scheduleId,
          `2026-09-0${day}`,
          entry.student_id,
          entry.full_name_snapshot,
          entry.room_number_snapshot,
        ],
      );
      day += 1;
    }
  });

  afterEach(async () => {
    await db.end();
  });

  it('9 · переселение студента не меняет опубликованный график', async () => {
    const before = await snapshot();
    await relocateStudent(db, seed.students['Иванов Иван']!, seed.rooms['607А']!);
    expect(await snapshot()).toEqual(before);
  });

  it('9a · перевод на другой этаж не меняет опубликованный график', async () => {
    const before = await snapshot();
    await transferStudent(db, seed.students['Иванов Иван']!, {
      floorId: seed.floors['7']!,
      roomId: seed.rooms['704']!,
    });

    const after = await snapshot();
    expect(after).toEqual(before);

    // Этаж в снимке остался прежним.
    const { rows } = await db.query<{ floor_number_snapshot: number }>(
      'SELECT floor_number_snapshot FROM duties WHERE schedule_id = $1 LIMIT 1',
      [scheduleId],
    );
    expect(rows[0]!.floor_number_snapshot).toBe(6);
  });

  it('9b · выселение не меняет опубликованный график', async () => {
    const before = await snapshot();
    await setStudentStatus(db, seed.students['Петров Пётр']!, 'moved_out');
    expect(await snapshot()).toEqual(before);
  });

  it('9c · переименование факультета и правка ФИО не меняют график', async () => {
    const before = await snapshot();
    await db.query(`UPDATE faculties SET code = 'ФИТиУ' WHERE id = $1`, [
      seed.faculties['ФИТ'],
    ]);
    await updateStudentAttributes(db, seed.students['Иванов Иван']!, {
      last_name: 'Иванченко',
    });
    expect(await snapshot()).toEqual(before);
  });

  it('9d · изменение шаблона смен не меняет график', async () => {
    const before = await snapshot();
    await db.query(
      `UPDATE duty_slot_rules SET time_from = '08:00', time_to = '10:00'
        WHERE weekday = 1 AND slot_order = 1`,
    );
    expect(await snapshot()).toEqual(before);
  });

  it('9e · переименование комнаты не меняет график', async () => {
    const before = await snapshot();
    await db.query(`UPDATE rooms SET number = '601В' WHERE id = $1`, [seed.rooms['601А']]);
    expect(await snapshot()).toEqual(before);
  });

  it('9f · roster-версию, на которой стоит график, нельзя удалить', async () => {
    // Защит две: FK из duty_schedules и RESTRICT из roster_entries.
    // Какая сработает первой — деталь; важно, что версия остаётся на месте.
    await expectDbError(() =>
      db.query('DELETE FROM roster_versions WHERE id = $1', [rosterVersionId]),
    );

    const { rows } = await db.query<{ id: string }>(
      'SELECT id FROM roster_versions WHERE id = $1',
      [rosterVersionId],
    );
    expect(rows).toHaveLength(1);
  });

  it('9g · связь графика с версией состава объявлена как RESTRICT', async () => {
    // Точная структурная проверка: без неё 9f прошёл бы и тогда, когда
    // версию удерживают только строки состава.
    const { rows } = await db.query<{ delete_rule: string }>(
      `SELECT rc.delete_rule
         FROM information_schema.referential_constraints rc
        WHERE rc.constraint_name = 'schedule_roster_same_floor'`,
    );
    expect(rows[0]!.delete_rule).toBe('RESTRICT');
  });

  it('9h · студента с историей дежурств нельзя удалить физически', async () => {
    const error = await expectDbError(() =>
      db.query('DELETE FROM students WHERE id = $1', [seed.students['Иванов Иван']]),
    );
    expect(error.message).toMatch(/foreign key|violates/i);
  });

  it('9i · график хранит собственную версию состава после обновления roster', async () => {
    await setStudentStatus(db, seed.students['Морозов Артём']!, 'moved_out');
    const current = await currentRoster(db, seed.floors['6']!);
    expect(current!.version.id).not.toBe(rosterVersionId);

    const { rows } = await db.query<{ roster_version_id: string }>(
      'SELECT roster_version_id FROM duty_schedules WHERE id = $1',
      [scheduleId],
    );
    expect(rows[0]!.roster_version_id).toBe(rosterVersionId);
  });
});
