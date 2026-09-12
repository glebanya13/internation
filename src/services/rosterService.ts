import type pg from 'pg';
import { withTransaction } from '../db/pool.js';
import {
  type RosterChangeSummary,
  type RosterEntry,
  type RosterSource,
  type RosterVersion,
  diffComposition,
  isEmptySummary,
  splitPatch,
} from '../domain/roster.js';

/**
 * Работа с составом этажа.
 *
 * Единственный вход для генерации графика — currentRoster(). Обхода комнат
 * здесь нет ни в одном методе: пустая комната, пустой блок и пустой этаж
 * просто не дают кандидатов, и это нормальные состояния.
 */

/** Студент числится в составе, пока не выселен. */
const IN_ROSTER_STATUSES = ['active', 'suspended'] as const;

export class RosterError extends Error {}
export class EmptyRosterError extends RosterError {}

export async function currentVersion(
  db: pg.Pool | pg.PoolClient,
  floorId: string,
): Promise<RosterVersion | null> {
  const { rows } = await db.query<RosterVersion>(
    `SELECT id, floor_id, version_no, status, source, effective_from,
            note, change_summary, confirmed_at
       FROM roster_versions
      WHERE floor_id = $1 AND status = 'confirmed'`,
    [floorId],
  );
  return rows[0] ?? null;
}

export async function entriesOf(
  db: pg.Pool | pg.PoolClient,
  versionId: string,
): Promise<RosterEntry[]> {
  const { rows } = await db.query<RosterEntry>(
    `SELECT * FROM roster_entries
      WHERE roster_version_id = $1
      ORDER BY sort_order, full_name_snapshot`,
    [versionId],
  );
  return rows;
}

export async function currentRoster(
  db: pg.Pool | pg.PoolClient,
  floorId: string,
): Promise<{ version: RosterVersion; entries: RosterEntry[] } | null> {
  const version = await currentVersion(db, floorId);
  if (!version) return null;
  return { version, entries: await entriesOf(db, version.id) };
}

/**
 * Кандидаты для генерации графика.
 *
 * Источник — только текущая подтверждённая версия состава. Ни students
 * напрямую, ни структура комнат, ни прошлые графики.
 */
export async function candidatesForSchedule(
  db: pg.Pool | pg.PoolClient,
  floorId: string,
): Promise<{ version: RosterVersion; candidates: RosterEntry[] }> {
  const roster = await currentRoster(db, floorId);
  if (!roster) {
    throw new EmptyRosterError(
      'Состав этажа не подтверждён. Откройте список этажа и подтвердите состав.',
    );
  }
  const candidates = roster.entries.filter((e) => e.student_status_snapshot === 'active');
  if (candidates.length === 0) {
    throw new EmptyRosterError('Невозможно сформировать график: на этаже нет активных студентов.');
  }
  return { version: roster.version, candidates };
}

/** Снимок текущего состава этажа из рабочей таблицы students. */
async function readCompositionFromStudents(
  client: pg.PoolClient,
  floorId: string,
): Promise<Omit<RosterEntry, 'id' | 'roster_version_id'>[]> {
  const { rows } = await client.query<Omit<RosterEntry, 'id' | 'roster_version_id'>>(
    `SELECT s.floor_id,
            s.id AS student_id,
            trim(concat_ws(' ', s.last_name, s.first_name, s.middle_name))
                                        AS full_name_snapshot,
            s.room_id,
            r.number                    AS room_number_snapshot,
            b.code                      AS block_code_snapshot,
            f.code                      AS faculty_code_snapshot,
            sh.code                     AS study_shift_code_snapshot,
            s.course                    AS course_snapshot,
            s.group_code                AS group_code_snapshot,
            s.status                    AS student_status_snapshot,
            s.sort_order
       FROM students s
       JOIN rooms r         ON r.id  = s.room_id
       LEFT JOIN blocks b   ON b.id  = r.block_id
       LEFT JOIN faculties f ON f.id = s.faculty_id
       LEFT JOIN study_shifts sh ON sh.id = s.study_shift_id
      WHERE s.floor_id = $1
        AND s.status = ANY($2::student_status[])
      ORDER BY r.sort_order, r.number, s.sort_order, s.last_name`,
    [floorId, IN_ROSTER_STATUSES],
  );
  return rows;
}

/**
 * Создаёт новую версию состава по текущему содержимому students.
 *
 * Вызывается ТОЛЬКО после операции, изменившей состав. Если состав
 * фактически не изменился — например, импорт поправил только факультет —
 * новая версия не создаётся и возвращается прежняя.
 */
export async function materializeVersion(
  client: pg.PoolClient,
  floorId: string,
  options: {
    source: RosterSource;
    note?: string | null;
    confirmedBy?: string | null;
    effectiveFrom?: string;
    force?: boolean;
  },
): Promise<{ version: RosterVersion; created: boolean; summary: RosterChangeSummary }> {
  const previous = await currentVersion(client, floorId);
  const previousEntries = previous ? await entriesOf(client, previous.id) : [];
  const nextComposition = await readCompositionFromStudents(client, floorId);

  const summary = diffComposition(
    previousEntries,
    nextComposition as unknown as readonly RosterEntry[],
  );

  if (previous && !options.force && isEmptySummary(summary)) {
    // Состав не изменился — версию не плодим.
    return { version: previous, created: false, summary };
  }

  if (previous) {
    await client.query(`UPDATE roster_versions SET status = 'superseded' WHERE id = $1`, [
      previous.id,
    ]);
  }

  const nextNo = (previous?.version_no ?? 0) + 1;
  const { rows } = await client.query<RosterVersion>(
    `INSERT INTO roster_versions
       (floor_id, version_no, status, source, effective_from, note,
        change_summary, confirmed_by, confirmed_at)
     VALUES ($1, $2, 'confirmed', $3, COALESCE($4::date, current_date), $5, $6, $7, now())
     RETURNING id, floor_id, version_no, status, source, effective_from,
               note, change_summary, confirmed_at`,
    [
      floorId,
      nextNo,
      options.source,
      options.effectiveFrom ?? null,
      options.note ?? null,
      JSON.stringify(summary),
      options.confirmedBy ?? null,
    ],
  );
  const version = rows[0];
  if (!version) throw new RosterError('Не удалось создать версию состава');

  // Пустая версия допустима: этаж без жильцов — валидное состояние.
  for (const entry of nextComposition) {
    await client.query(
      `INSERT INTO roster_entries
         (roster_version_id, floor_id, student_id, full_name_snapshot, room_id,
          room_number_snapshot, block_code_snapshot, faculty_code_snapshot,
          study_shift_code_snapshot, course_snapshot, group_code_snapshot,
          student_status_snapshot, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        version.id,
        entry.floor_id,
        entry.student_id,
        entry.full_name_snapshot,
        entry.room_id,
        entry.room_number_snapshot,
        entry.block_code_snapshot,
        entry.faculty_code_snapshot,
        entry.study_shift_code_snapshot,
        entry.course_snapshot,
        entry.group_code_snapshot,
        entry.student_status_snapshot,
        entry.sort_order,
      ],
    );
  }

  return { version, created: true, summary };
}

async function audit(
  client: pg.PoolClient,
  entry: {
    action: string;
    entity: string;
    entityId: string;
    before?: unknown;
    after?: unknown;
    actorId?: string | null;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (actor_type, actor_id, action, entity, entity_id, before, after)
     VALUES ('admin', $1, $2, $3, $4, $5, $6)`,
    [
      entry.actorId ?? null,
      entry.action,
      entry.entity,
      entry.entityId,
      entry.before === undefined ? null : JSON.stringify(entry.before),
      entry.after === undefined ? null : JSON.stringify(entry.after),
    ],
  );
}

async function openPlacement(
  client: pg.PoolClient,
  studentId: string,
  roomId: string,
  from: string,
): Promise<void> {
  await client.query(
    `UPDATE student_placements
        SET valid_to = ($2::date - 1)
      WHERE student_id = $1 AND valid_to IS NULL AND valid_from < $2::date`,
    [studentId, from],
  );
  // Запись, начатую сегодня же, закрывать нечем — её просто убираем.
  await client.query(
    `DELETE FROM student_placements
      WHERE student_id = $1 AND valid_to IS NULL AND valid_from >= $2::date`,
    [studentId, from],
  );
  await client.query(
    `INSERT INTO student_placements
       (student_id, floor_id, block_id, room_id,
        room_number_snapshot, block_code_snapshot, floor_number_snapshot, valid_from)
     SELECT $1, r.floor_id, r.block_id, r.id, r.number, b.code, fl.number, $3::date
       FROM rooms r
       JOIN floors fl ON fl.id = r.floor_id
       LEFT JOIN blocks b ON b.id = r.block_id
      WHERE r.id = $2`,
    [studentId, roomId, from],
  );
}

export interface NewStudentInput {
  floorId: string;
  roomId: string;
  lastName: string;
  firstName: string;
  middleName?: string | null;
  facultyId?: string | null;
  studyShiftId?: string | null;
  course?: number | null;
  groupCode?: string | null;
  telegramId?: string | null;
  phone?: string | null;
  sortOrder?: number;
}

/** Заселение. Меняет состав → новая версия. */
export async function addStudent(
  pool: pg.Pool,
  input: NewStudentInput,
  actorId?: string,
): Promise<{ studentId: string; version: RosterVersion }> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO students
         (floor_id, room_id, last_name, first_name, middle_name, faculty_id,
          study_shift_id, course, group_code, telegram_id, phone, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING id`,
      [
        input.floorId,
        input.roomId,
        input.lastName,
        input.firstName,
        input.middleName ?? null,
        input.facultyId ?? null,
        input.studyShiftId ?? null,
        input.course ?? null,
        input.groupCode ?? null,
        input.telegramId ?? null,
        input.phone ?? null,
        input.sortOrder ?? 0,
      ],
    );
    const studentId = rows[0]?.id;
    if (!studentId) throw new RosterError('Студент не создан');

    const today = new Date().toISOString().slice(0, 10);
    await openPlacement(client, studentId, input.roomId, today);
    await audit(client, {
      action: 'student.add',
      entity: 'students',
      entityId: studentId,
      after: input,
      actorId: actorId ?? null,
    });

    const { version } = await materializeVersion(client, input.floorId, {
      source: 'manual',
      note: `Заселён ${input.lastName} ${input.firstName}`,
      confirmedBy: actorId ?? null,
    });
    return { studentId, version };
  });
}

/** Переселение внутри этажа. Меняет состав → новая версия. */
export async function relocateStudent(
  pool: pg.Pool,
  studentId: string,
  roomId: string,
  actorId?: string,
): Promise<RosterVersion> {
  return withTransaction(pool, async (client) => {
    const { rows: before } = await client.query<{ floor_id: string; room_id: string }>(
      'SELECT floor_id, room_id FROM students WHERE id = $1',
      [studentId],
    );
    const prev = before[0];
    if (!prev) throw new RosterError('Студент не найден');

    // floor_id не трогаем: составной FK на rooms(id, floor_id) не позволит
    // переселить в комнату другого этажа — для этого есть transferStudent.
    await client.query(
      'UPDATE students SET room_id = $2, updated_at = now() WHERE id = $1',
      [studentId, roomId],
    );

    const today = new Date().toISOString().slice(0, 10);
    await openPlacement(client, studentId, roomId, today);
    await audit(client, {
      action: 'student.relocate',
      entity: 'students',
      entityId: studentId,
      before: { room_id: prev.room_id },
      after: { room_id: roomId },
      actorId: actorId ?? null,
    });

    const { version } = await materializeVersion(client, prev.floor_id, {
      source: 'manual',
      note: 'Переселение',
      confirmedBy: actorId ?? null,
    });
    return version;
  });
}

/**
 * Перевод на другой этаж. Меняет состав ОБОИХ этажей → две новые версии.
 * Прошлые графики остаются привязанными к старому этажу.
 */
export async function transferStudent(
  pool: pg.Pool,
  studentId: string,
  target: { floorId: string; roomId: string },
  actorId?: string,
): Promise<{ from: RosterVersion; to: RosterVersion }> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<{ floor_id: string }>(
      'SELECT floor_id FROM students WHERE id = $1',
      [studentId],
    );
    const sourceFloorId = rows[0]?.floor_id;
    if (!sourceFloorId) throw new RosterError('Студент не найден');
    if (sourceFloorId === target.floorId) {
      throw new RosterError('Студент уже на этом этаже — используйте переселение');
    }

    await client.query(
      'UPDATE students SET floor_id = $2, room_id = $3, updated_at = now() WHERE id = $1',
      [studentId, target.floorId, target.roomId],
    );

    const today = new Date().toISOString().slice(0, 10);
    await openPlacement(client, studentId, target.roomId, today);
    await audit(client, {
      action: 'student.transfer_floor',
      entity: 'students',
      entityId: studentId,
      before: { floor_id: sourceFloorId },
      after: { floor_id: target.floorId, room_id: target.roomId },
      actorId: actorId ?? null,
    });

    const from = await materializeVersion(client, sourceFloorId, {
      source: 'manual',
      note: 'Перевод студента на другой этаж',
      confirmedBy: actorId ?? null,
    });
    const to = await materializeVersion(client, target.floorId, {
      source: 'manual',
      note: 'Перевод студента с другого этажа',
      confirmedBy: actorId ?? null,
    });
    return { from: from.version, to: to.version };
  });
}

/** Выселение или приостановка. Меняет состав → новая версия. */
export async function setStudentStatus(
  pool: pg.Pool,
  studentId: string,
  status: 'active' | 'suspended' | 'moved_out',
  actorId?: string,
): Promise<RosterVersion> {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<{ floor_id: string; status: string }>(
      'SELECT floor_id, status FROM students WHERE id = $1',
      [studentId],
    );
    const prev = rows[0];
    if (!prev) throw new RosterError('Студент не найден');

    await client.query(
      `UPDATE students
          SET status = $2::student_status,
              left_at = CASE WHEN $2::student_status = 'moved_out'
                             THEN current_date ELSE left_at END,
              updated_at = now()
        WHERE id = $1`,
      [studentId, status],
    );
    if (status === 'moved_out') {
      await client.query(
        `UPDATE student_placements SET valid_to = current_date
          WHERE student_id = $1 AND valid_to IS NULL`,
        [studentId],
      );
    }
    await audit(client, {
      action: 'student.set_status',
      entity: 'students',
      entityId: studentId,
      before: { status: prev.status },
      after: { status },
      actorId: actorId ?? null,
    });

    const { version } = await materializeVersion(client, prev.floor_id, {
      source: 'manual',
      note: `Статус: ${status}`,
      confirmedBy: actorId ?? null,
    });
    return version;
  });
}

/**
 * Изменение атрибутов: ФИО, факультет, курс, группа, учебная смена,
 * telegram_id. Состав не меняется — новая версия НЕ создаётся,
 * изменение уходит в audit_log.
 *
 * Если в патче окажется поле состава, вызов отклоняется: для этого есть
 * relocateStudent, transferStudent и setStudentStatus, которые умеют
 * правильно вести историю проживания.
 */
export async function updateStudentAttributes(
  pool: pg.Pool,
  studentId: string,
  patch: Record<string, unknown>,
  actorId?: string,
): Promise<void> {
  const { composition, attributes } = splitPatch(patch);
  const compositionKeys = Object.keys(composition);
  if (compositionKeys.length > 0) {
    throw new RosterError(
      `Поля состава (${compositionKeys.join(', ')}) меняются отдельными операциями: ` +
        'relocateStudent, transferStudent, setStudentStatus',
    );
  }
  const keys = Object.keys(attributes);
  if (keys.length === 0) return;

  await withTransaction(pool, async (client) => {
    const { rows: beforeRows } = await client.query(
      `SELECT ${keys.map((k) => `"${k}"`).join(', ')} FROM students WHERE id = $1`,
      [studentId],
    );
    const assignments = keys.map((k, i) => `"${k}" = $${i + 2}`).join(', ');
    await client.query(
      `UPDATE students SET ${assignments}, updated_at = now() WHERE id = $1`,
      [studentId, ...keys.map((k) => attributes[k as keyof typeof attributes])],
    );
    await audit(client, {
      action: 'student.update_attributes',
      entity: 'students',
      entityId: studentId,
      before: beforeRows[0],
      after: attributes,
      actorId: actorId ?? null,
    });
    // materializeVersion здесь не вызывается намеренно.
  });
}

/** Подтверждение текущего состава, в том числе пустого. */
export async function confirmRoster(
  pool: pg.Pool,
  floorId: string,
  actorId?: string,
): Promise<RosterVersion> {
  return withTransaction(pool, async (client) => {
    const { version } = await materializeVersion(client, floorId, {
      source: 'manual',
      note: 'Подтверждение состава через админку',
      confirmedBy: actorId ?? null,
      force: true,
    });
    return version;
  });
}
