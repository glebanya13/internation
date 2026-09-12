import { afterAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import {
  currentRoster,
  currentVersion,
  entriesOf,
  relocateStudent,
  setStudentStatus,
  transferStudent,
  updateStudentAttributes,
} from '../../src/services/rosterService.js';
import { type Seed, expectDbError, freshSeed, testPool } from '../helpers.js';

/**
 * Инварианты 6, 7, 8: различие состава и атрибутов, неизменяемость версий.
 */
describe('версионирование состава', () => {
  let db: pg.Pool;
  let seed: Seed;

  beforeEach(async () => {
    db = testPool();
    seed = await freshSeed(db);
  });
  afterEach(async () => {
    await db.end();
  });
  afterAll(async () => {
    /* пул закрывается в afterEach */
  });

  it('6 · переселение в другую комнату создаёт новую версию', async () => {
    const floor6 = seed.floors['6']!;
    const before = await currentVersion(db, floor6);
    expect(before!.version_no).toBe(1);

    await relocateStudent(db, seed.students['Волков Егор']!, seed.rooms['607А']!);

    const after = await currentVersion(db, floor6);
    expect(after!.version_no).toBe(2);
    expect(after!.id).not.toBe(before!.id);
    expect(after!.change_summary!.relocated).toHaveLength(1);
    expect(after!.change_summary!.relocated[0]!.from).toBe('605Б');
    expect(after!.change_summary!.relocated[0]!.to).toBe('607А');
  });

  it('6a · переселение в другой блок создаёт новую версию', async () => {
    const floor6 = seed.floors['6']!;
    // 601А и 605А — разные блоки.
    await relocateStudent(db, seed.students['Смирнов Алексей']!, seed.rooms['605А']!);
    const after = await currentRoster(db, floor6);
    expect(after!.version.version_no).toBe(2);

    const moved = after!.entries.find(
      (e) => e.student_id === seed.students['Смирнов Алексей'],
    );
    expect(moved!.block_code_snapshot).toBe('605');
  });

  it('6b · деактивация создаёт новую версию и убирает из кандидатов', async () => {
    const floor6 = seed.floors['6']!;
    await setStudentStatus(db, seed.students['Морозов Артём']!, 'moved_out');

    const after = await currentRoster(db, floor6);
    expect(after!.version.version_no).toBe(2);
    expect(after!.version.change_summary!.removed).toHaveLength(1);
    expect(after!.entries.some((e) => e.student_id === seed.students['Морозов Артём'])).toBe(
      false,
    );
  });

  it('6c · перевод на другой этаж создаёт версии на обоих этажах', async () => {
    const student = seed.students['Волков Егор']!;
    const { from, to } = await transferStudent(db, student, {
      floorId: seed.floors['7']!,
      roomId: seed.rooms['704']!,
    });

    expect(from.version_no).toBe(2);
    expect(to.version_no).toBe(2);
    expect(from.change_summary!.removed).toHaveLength(1);
    expect(to.change_summary!.added).toHaveLength(1);

    const roster6 = await currentRoster(db, seed.floors['6']!);
    const roster7 = await currentRoster(db, seed.floors['7']!);
    expect(roster6!.entries.some((e) => e.student_id === student)).toBe(false);
    expect(roster7!.entries.some((e) => e.student_id === student)).toBe(true);
  });

  it('7 · изменение факультета НЕ создаёт новую версию', async () => {
    const floor6 = seed.floors['6']!;
    const before = await currentVersion(db, floor6);

    await updateStudentAttributes(db, seed.students['Иванов Иван']!, {
      faculty_id: seed.faculties['ТОВ'],
    });

    const after = await currentVersion(db, floor6);
    expect(after!.id).toBe(before!.id);
    expect(after!.version_no).toBe(1);
  });

  it('7a · опечатка в ФИО, курс, группа, смена и telegram_id — тоже не состав', async () => {
    const floor6 = seed.floors['6']!;
    const before = await currentVersion(db, floor6);
    const student = seed.students['Петров Пётр']!;

    await updateStudentAttributes(db, student, { last_name: 'Петровский' });
    await updateStudentAttributes(db, student, { course: 3, group_code: '9' });
    await updateStudentAttributes(db, student, { study_shift_id: seed.shifts['1'] });
    await updateStudentAttributes(db, student, { telegram_id: '123456789' });

    const after = await currentVersion(db, floor6);
    expect(after!.id).toBe(before!.id);

    // Всё ушло в audit_log.
    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_log
        WHERE entity = 'students' AND entity_id = $1
          AND action = 'student.update_attributes'`,
      [student],
    );
    expect(Number(rows[0]!.count)).toBe(4);
  });

  it('7b · поле состава нельзя протащить через правку атрибутов', async () => {
    await expect(
      updateStudentAttributes(db, seed.students['Иванов Иван']!, {
        room_id: seed.rooms['605А'],
      }),
    ).rejects.toThrow(/relocateStudent/);

    await expect(
      updateStudentAttributes(db, seed.students['Иванов Иван']!, { status: 'moved_out' }),
    ).rejects.toThrow(/setStudentStatus/);
  });

  it('7c · исторический график берёт данные из своего snapshot, а не из students', async () => {
    // Атрибуты меняются свободно — печать графика от них не зависит,
    // потому что duties хранит student_name_snapshot.
    const student = seed.students['Иванов Иван']!;
    const roster = await currentRoster(db, seed.floors['6']!);

    const schedule = await db.query<{ id: string }>(
      `INSERT INTO duty_schedules
         (floor_id, year, month, roster_version_id, slot_template_snapshot,
          rule_set_snapshot, dormitory_snapshot, generated_by)
       VALUES ($1, 2026, 9, $2, '{}', '{}', '{}', 'algorithm') RETURNING id`,
      [seed.floors['6']!, roster!.version.id],
    );
    await db.query(
      `INSERT INTO duties
         (schedule_id, duty_date, slot_order, time_from, time_to, student_id,
          student_name_snapshot, room_number_snapshot, floor_number_snapshot)
       VALUES ($1, '2026-09-01', 1, '09:00', '11:00', $2, 'Иванов Иван', '601А', 6)`,
      [schedule.rows[0]!.id, student],
    );

    await updateStudentAttributes(db, student, { last_name: 'Иванченко' });

    const { rows } = await db.query<{ student_name_snapshot: string }>(
      'SELECT student_name_snapshot FROM duties WHERE schedule_id = $1',
      [schedule.rows[0]!.id],
    );
    expect(rows[0]!.student_name_snapshot).toBe('Иванов Иван');
  });

  it('8 · старая версия состава не меняется после новой', async () => {
    const floor6 = seed.floors['6']!;
    const v1 = await currentVersion(db, floor6);
    const v1Entries = await entriesOf(db, v1!.id);
    const v1Ids = v1Entries.map((e) => e.student_id).sort();

    await setStudentStatus(db, seed.students['Морозов Артём']!, 'moved_out');
    await relocateStudent(db, seed.students['Волков Егор']!, seed.rooms['607Б']!);

    const v3 = await currentVersion(db, floor6);
    expect(v3!.version_no).toBe(3);

    // v1 осталась ровно такой, какой была.
    const v1Again = await entriesOf(db, v1!.id);
    expect(v1Again.map((e) => e.student_id).sort()).toEqual(v1Ids);
    expect(v1Again.find((e) => e.student_id === seed.students['Волков Егор'])!
      .room_number_snapshot).toBe('605Б');

    const { rows } = await db.query<{ status: string }>(
      'SELECT status FROM roster_versions WHERE id = $1',
      [v1!.id],
    );
    expect(rows[0]!.status).toBe('superseded');
  });

  it('8a · строки старой версии физически неизменяемы', async () => {
    const v1 = await currentVersion(db, seed.floors['6']!);
    const entries = await entriesOf(db, v1!.id);

    const updateError = await expectDbError(() =>
      db.query('UPDATE roster_entries SET room_number_snapshot = $2 WHERE id = $1', [
        entries[0]!.id,
        'XXX',
      ]),
    );
    expect(updateError.message).toMatch(/только для вставки/);

    const deleteError = await expectDbError(() =>
      db.query('DELETE FROM roster_entries WHERE id = $1', [entries[0]!.id]),
    );
    expect(deleteError.message).toMatch(/только для вставки/);
  });

  it('8b · на этаже не может быть двух актуальных версий', async () => {
    const error = await expectDbError(() =>
      db.query(
        `INSERT INTO roster_versions (floor_id, version_no, status, source, confirmed_at)
         VALUES ($1, 99, 'confirmed', 'manual', now())`,
        [seed.floors['6']!],
      ),
    );
    expect(error.message).toMatch(/roster_one_confirmed_per_floor|duplicate key/i);
  });
});
