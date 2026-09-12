import type pg from 'pg';
import { withTransaction } from '../db/pool.js';
import type { NotificationService } from './notifications/NotificationService.js';

/**
 * Журнал исполнения дежурств: отметки, пропуски, замены.
 *
 * Бизнес-логика живёт здесь и только здесь. Telegram-адаптер её не
 * содержит и не дублирует — он лишь показывает результат.
 *
 * В MVP отметку делает администратор. Самоподтверждения студентом,
 * геолокации, фото и QR нет намеренно.
 */

export class JournalError extends Error {}

export interface DormitorySettings {
  violationThreshold: number;
  reminderHoursBefore: number;
  academicYearStartMonth: number;
}

const DEFAULTS: DormitorySettings = {
  violationThreshold: 3,
  reminderHoursBefore: 24,
  academicYearStartMonth: 9,
};

export function parseSettings(raw: unknown): DormitorySettings {
  const value = (raw ?? {}) as Record<string, unknown>;
  const num = (key: string, fallback: number): number =>
    typeof value[key] === 'number' ? (value[key] as number) : fallback;
  return {
    violationThreshold: num('violation_threshold', DEFAULTS.violationThreshold),
    reminderHoursBefore: num('reminder_hours_before', DEFAULTS.reminderHoursBefore),
    academicYearStartMonth: num('academic_year_start_month', DEFAULTS.academicYearStartMonth),
  };
}

async function settingsFor(
  db: pg.Pool | pg.PoolClient,
  dutyId: string,
): Promise<DormitorySettings> {
  const { rows } = await db.query<{ settings: unknown }>(
    `SELECT d.settings
       FROM duties du
       JOIN duty_schedules s ON s.id = du.schedule_id
       JOIN floors f         ON f.id = s.floor_id
       JOIN dormitories d    ON d.id = f.dormitory_id
      WHERE du.id = $1`,
    [dutyId],
  );
  return parseSettings(rows[0]?.settings);
}

/** Границы учебного года, в котором лежит дата. */
export function academicYearBounds(
  date: string,
  startMonth: number,
): { from: string; to: string } {
  const [year, month] = date.split('-').map(Number);
  const startYear = (month ?? 1) >= startMonth ? year! : year! - 1;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return {
    from: `${startYear}-${pad(startMonth)}-01`,
    to: `${startYear + 1}-${pad(startMonth)}-01`,
  };
}

export async function markCompleted(
  pool: pg.Pool,
  dutyId: string,
  adminId?: string,
): Promise<void> {
  await withTransaction(pool, async (client) => {
    const duty = await lockDuty(client, dutyId);
    if (duty.status === 'cancelled') throw new JournalError('Дежурство отменено');

    await client.query(
      `UPDATE duties SET status = 'completed', closed_at = now(), closed_by = $2
        WHERE id = $1`,
      [dutyId, adminId ?? null],
    );
    // Ранее отмеченный пропуск снимается вместе с его последствиями.
    await client.query('DELETE FROM violations WHERE duty_id = $1', [dutyId]);
    await audit(client, 'duty.completed', dutyId, adminId);
  });
}

/**
 * Отметка пропуска.
 *
 * Пропуск сам по себе ещё не нарушение: violation создаётся в состоянии
 * reported, и счётчик растёт только после подтверждения администратором.
 */
export async function markMissed(
  pool: pg.Pool,
  dutyId: string,
  options: {
    reason?: string | undefined;
    adminId?: string | undefined;
    notifications?: NotificationService | undefined;
  } = {},
): Promise<{ violationId: string }> {
  const result = await withTransaction(pool, async (client) => {
    const duty = await lockDuty(client, dutyId);
    if (!duty.student_id) throw new JournalError('Дежурство никому не назначено');

    await client.query(
      `UPDATE duties SET status = 'missed', closed_at = now(), closed_by = $2
        WHERE id = $1`,
      [dutyId, options.adminId ?? null],
    );

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO violations (student_id, duty_id, state, reason, reported_by)
       VALUES ($1, $2, 'reported', $3, $4)
       ON CONFLICT (duty_id) DO UPDATE
         SET state = 'reported', reason = EXCLUDED.reason
       RETURNING id`,
      [duty.student_id, dutyId, options.reason ?? null, options.adminId ?? null],
    );
    await audit(client, 'duty.missed', dutyId, options.adminId);
    return { violationId: rows[0]!.id, studentId: duty.student_id };
  });

  if (options.notifications) {
    const settings = await settingsFor(pool, dutyId);
    // В сообщении студенту — все зафиксированные пропуски, включая
    // только что отмеченный. Это информирование, а не обвинение.
    // Порог объяснительной считается ОТДЕЛЬНО и только по подтверждённым:
    // пропуск сам по себе нарушением ещё не является.
    const count = await recordedViolationCount(pool, result.studentId, dutyId, settings);
    await options.notifications.dutyMissed(result.studentId, dutyId, {
      reason: options.reason ?? null,
      totalViolations: count,
    });
  }
  return { violationId: result.violationId };
}

/** Отмена дежурства: слот больше не требует исполнения. */
export async function markCancelled(
  pool: pg.Pool,
  dutyId: string,
  adminId?: string,
): Promise<void> {
  await withTransaction(pool, async (client) => {
    await lockDuty(client, dutyId);
    await client.query(
      `UPDATE duties SET status = 'cancelled', closed_at = now(), closed_by = $2
        WHERE id = $1`,
      [dutyId, adminId ?? null],
    );
    await client.query('DELETE FROM violations WHERE duty_id = $1', [dutyId]);
    await audit(client, 'duty.cancelled', dutyId, adminId);
  });
}

/**
 * Подтверждение пропуска администратором. Только после этого пропуск
 * становится нарушением и попадает в счётчик.
 *
 * При достижении порога создаётся требование объяснительной — один раз
 * на каждое достижение порога, а не при каждом последующем пропуске.
 */
export async function confirmViolation(
  pool: pg.Pool,
  violationId: string,
  options: {
    adminId?: string | undefined;
    notifications?: NotificationService | undefined;
  } = {},
): Promise<{ total: number; explanationRequired: boolean }> {
  const outcome = await withTransaction(pool, async (client) => {
    const { rows } = await client.query<{
      student_id: string;
      duty_id: string;
      state: string;
    }>('SELECT student_id, duty_id, state FROM violations WHERE id = $1 FOR UPDATE', [
      violationId,
    ]);
    const violation = rows[0];
    if (!violation) throw new JournalError('Пропуск не найден');

    const settings = await settingsFor(client, violation.duty_id);
    await client.query(
      `UPDATE violations SET state = 'confirmed', resolved_by = $2, resolved_at = now()
        WHERE id = $1`,
      [violationId, options.adminId ?? null],
    );

    const total = await confirmedViolationCount(
      client,
      violation.student_id,
      violation.duty_id,
      settings,
    );
    await client.query('UPDATE violations SET sequence_no = $2 WHERE id = $1', [
      violationId,
      total,
    ]);

    // Порог достигнут ровно сейчас — кратность позволяет сработать
    // и на 6-м, и на 9-м пропуске, но не на каждом подряд.
    const reached = total > 0 && total % settings.violationThreshold === 0;
    if (reached) {
      await client.query(
        `UPDATE violations SET state = 'explanation_required' WHERE id = $1`,
        [violationId],
      );
    }
    await audit(client, 'violation.confirmed', violation.duty_id, options.adminId);
    return { total, reached, studentId: violation.student_id, violationId };
  });

  if (outcome.reached && options.notifications) {
    await options.notifications.explanationRequired(outcome.studentId, outcome.violationId, {
      total: outcome.total,
    });
  }
  return { total: outcome.total, explanationRequired: outcome.reached };
}

/** Уважительная причина. В счётчик нарушений не идёт. */
export async function excuseViolation(
  pool: pg.Pool,
  violationId: string,
  adminId?: string,
): Promise<void> {
  await withTransaction(pool, async (client) => {
    await client.query(
      `UPDATE violations SET state = 'excused', resolved_by = $2, resolved_at = now(),
              sequence_no = NULL
        WHERE id = $1`,
      [violationId, adminId ?? null],
    );
  });
}

/**
 * Все зафиксированные пропуски за учебный год, кроме признанных
 * уважительными. Используется для информационного сообщения студенту.
 */
export async function recordedViolationCount(
  db: pg.Pool | pg.PoolClient,
  studentId: string,
  referenceDutyId: string,
  settings: DormitorySettings,
): Promise<number> {
  return countViolations(db, studentId, referenceDutyId, settings, [
    'reported',
    'confirmed',
    'explanation_required',
    'explained',
  ]);
}

/**
 * Подтверждённые нарушения. Только они считаются порогом объяснительной:
 * между «пропущено» и «нарушение» всегда стоит решение администратора.
 */
export async function confirmedViolationCount(
  db: pg.Pool | pg.PoolClient,
  studentId: string,
  referenceDutyId: string,
  settings: DormitorySettings,
): Promise<number> {
  return countViolations(db, studentId, referenceDutyId, settings, [
    'confirmed',
    'explanation_required',
    'explained',
  ]);
}

async function countViolations(
  db: pg.Pool | pg.PoolClient,
  studentId: string,
  referenceDutyId: string,
  settings: DormitorySettings,
  states: readonly string[],
): Promise<number> {
  const { rows: ref } = await db.query<{ duty_date: string }>(
    'SELECT duty_date FROM duties WHERE id = $1',
    [referenceDutyId],
  );
  const bounds = academicYearBounds(
    ref[0]?.duty_date ?? new Date().toISOString().slice(0, 10),
    settings.academicYearStartMonth,
  );

  const { rows } = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM violations v
       JOIN duties d ON d.id = v.duty_id
      WHERE v.student_id = $1
        AND v.state = ANY($4::violation_state[])
        AND d.duty_date >= $2::date AND d.duty_date < $3::date`,
    [studentId, bounds.from, bounds.to, states],
  );
  return Number(rows[0]!.count);
}

/**
 * Замена дежурного.
 *
 * Оригинальное назначение не переписывается молча: сначала создаётся
 * запись в duty_changes с обеими сторонами, причиной, автором и временем,
 * и только потом обновляется само дежурство. Триггер БД не пропустит
 * изменение опубликованного графика без такой записи.
 */
export async function substitute(
  pool: pg.Pool,
  options: {
    dutyId: string;
    toStudentId: string;
    reason: string;
    adminId?: string | undefined;
    notifications?: NotificationService | undefined;
  },
): Promise<{ changeId: string }> {
  const result = await withTransaction(pool, async (client) => {
    const duty = await lockDuty(client, options.dutyId);

    const { rows: floorRows } = await client.query<{ floor_id: string }>(
      `SELECT s.floor_id FROM duties d
         JOIN duty_schedules s ON s.id = d.schedule_id
        WHERE d.id = $1`,
      [options.dutyId],
    );
    const floorId = floorRows[0]!.floor_id;

    // Замена возможна только на студента ТОГО ЖЕ этажа.
    const { rows: replacement } = await client.query<{
      id: string;
      full_name: string;
      room_number: string;
      floor_number: number;
      status: string;
    }>(
      `SELECT s.id,
              trim(concat_ws(' ', s.last_name, s.first_name, s.middle_name)) AS full_name,
              r.number AS room_number, f.number AS floor_number, s.status
         FROM students s
         JOIN rooms r  ON r.id = s.room_id
         JOIN floors f ON f.id = s.floor_id
        WHERE s.id = $1 AND s.floor_id = $2`,
      [options.toStudentId, floorId],
    );
    const target = replacement[0];
    if (!target) {
      throw new JournalError('Заменяющий студент не найден на этом этаже');
    }
    if (target.status !== 'active') {
      throw new JournalError('Заменяющий студент неактивен');
    }
    if (target.id === duty.student_id) {
      throw new JournalError('Студент уже назначен на это дежурство');
    }

    const { rows: changeRows } = await client.query<{ id: string }>(
      `INSERT INTO duty_changes
         (duty_id, change_date, from_student_id, from_name_snapshot, from_room_snapshot,
          to_student_id, to_name_snapshot, to_room_snapshot,
          time_from, time_to, reason, source, changed_by_admin_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'admin',$12)
       RETURNING id`,
      [
        options.dutyId,
        duty.duty_date,
        duty.student_id,
        duty.student_name_snapshot,
        duty.room_number_snapshot,
        target.id,
        target.full_name,
        target.room_number,
        duty.time_from,
        duty.time_to,
        options.reason,
        options.adminId ?? null,
      ],
    );

    await client.query(
      `UPDATE duties
          SET student_id = $2, student_name_snapshot = $3,
              room_number_snapshot = $4, floor_number_snapshot = $5,
              status = 'scheduled', updated_at = now()
        WHERE id = $1`,
      [options.dutyId, target.id, target.full_name, target.room_number, target.floor_number],
    );

    await audit(client, 'duty.substituted', options.dutyId, options.adminId);
    return {
      changeId: changeRows[0]!.id,
      fromStudentId: duty.student_id,
      toStudentId: target.id,
    };
  });

  if (options.notifications) {
    // Уведомление получают обе стороны.
    if (result.fromStudentId) {
      await options.notifications.substitutedOut(
        result.fromStudentId,
        options.dutyId,
        result.changeId,
        options.reason,
      );
    }
    await options.notifications.substitutedIn(
      result.toStudentId,
      options.dutyId,
      result.changeId,
      options.reason,
    );
  }
  return { changeId: result.changeId };
}

interface DutyRow {
  id: string;
  schedule_id: string;
  duty_date: string;
  time_from: string;
  time_to: string;
  student_id: string | null;
  student_name_snapshot: string | null;
  room_number_snapshot: string | null;
  status: string;
}

async function lockDuty(client: pg.PoolClient, dutyId: string): Promise<DutyRow> {
  const { rows } = await client.query<DutyRow>(
    `SELECT id, schedule_id, duty_date, time_from, time_to, student_id,
            student_name_snapshot, room_number_snapshot, status
       FROM duties WHERE id = $1 FOR UPDATE`,
    [dutyId],
  );
  const duty = rows[0];
  if (!duty) throw new JournalError('Дежурство не найдено');
  return duty;
}

async function audit(
  client: pg.PoolClient,
  action: string,
  dutyId: string,
  adminId?: string,
): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (actor_type, actor_id, action, entity, entity_id)
     VALUES ('admin', $1, $2, 'duties', $3)`,
    [adminId ?? null, action, dutyId],
  );
}
