import type pg from 'pg';
import * as messages from './messages.js';

/**
 * Единая точка отправки уведомлений.
 *
 *   NotificationService
 *        └── TelegramNotificationAdapter
 *
 * Сервис ставит сообщения в очередь и решает, кому и что писать.
 * Канал доставки за интерфейсом: добавление второго канала не потребует
 * трогать бизнес-логику. Отправка нигде больше в коде не встречается.
 */

export type NotificationType =
  | 'schedule_published'
  | 'duty_reminder'
  | 'duty_missed'
  | 'explanation_required'
  | 'substituted_in'
  | 'substituted_out';

export interface OutgoingMessage {
  telegramId: string;
  text: string;
}

/** Канал доставки. Реализация не знает ничего о предметной области. */
export interface NotificationChannel {
  readonly name: string;
  /** false — планировщик не пытается отправлять (Telegram отключён). */
  readonly enabled?: boolean;
  send(message: OutgoingMessage): Promise<void>;
}

interface Recipient {
  studentId: string;
  telegramId: string | null;
  status: string;
}

export class NotificationService {
  constructor(
    private readonly db: pg.Pool,
    private readonly channel: NotificationChannel,
  ) {}

  /**
   * Ставит уведомление в очередь.
   *
   * Идемпотентность обеспечивает уникальный индекс: сколько бы раз
   * ни просыпался планировщик, одно и то же уведомление не встанет
   * в очередь дважды.
   */
  private async enqueue(options: {
    studentId: string;
    type: NotificationType;
    text: string;
    dutyId?: string | null;
    violationId?: string | null;
    dutyChangeId?: string | null;
    scheduledAt?: Date;
  }): Promise<string | null> {
    const recipient = await this.recipient(options.studentId);
    // Выселенный или приостановленный студент новых уведомлений не получает.
    if (!recipient || recipient.status !== 'active') return null;

    const { rows } = await this.db.query<{ id: string }>(
      `INSERT INTO notifications
         (student_id, duty_id, violation_id, duty_change_id, type, payload, scheduled_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        options.studentId,
        options.dutyId ?? null,
        options.violationId ?? null,
        options.dutyChangeId ?? null,
        options.type,
        JSON.stringify({ text: options.text }),
        options.scheduledAt ?? new Date(),
      ],
    );
    return rows[0]?.id ?? null;
  }

  private async recipient(studentId: string): Promise<Recipient | null> {
    const { rows } = await this.db.query<Recipient>(
      `SELECT id AS "studentId", telegram_id AS "telegramId", status
         FROM students WHERE id = $1`,
      [studentId],
    );
    return rows[0] ?? null;
  }

  private async dutyView(dutyId: string): Promise<messages.DutyView | null> {
    const { rows } = await this.db.query<{
      duty_date: string;
      time_from: string;
      time_to: string;
      floor_number_snapshot: number | null;
      room_number_snapshot: string | null;
    }>(
      `SELECT duty_date, time_from, time_to, floor_number_snapshot, room_number_snapshot
         FROM duties WHERE id = $1`,
      [dutyId],
    );
    const duty = rows[0];
    if (!duty) return null;
    return {
      date: duty.duty_date,
      timeFrom: duty.time_from,
      timeTo: duty.time_to,
      floorNumber: duty.floor_number_snapshot ?? 0,
      roomNumber: duty.room_number_snapshot,
    };
  }

  // ─────────────────────────── события ───────────────────────────

  /** Рассылка всем студентам этажа после публикации графика. */
  async schedulePublished(scheduleId: string): Promise<number> {
    const { rows: schedule } = await this.db.query<{
      year: number;
      month: number;
      status: string;
    }>('SELECT year, month, status FROM duty_schedules WHERE id = $1', [scheduleId]);
    const head = schedule[0];
    if (!head || head.status !== 'published') return 0;

    const { rows } = await this.db.query<{
      student_id: string;
      duty_count: string;
      next_date: string | null;
      next_from: string | null;
      next_to: string | null;
      next_floor: number | null;
      next_room: string | null;
    }>(
      `SELECT d.student_id,
              count(*)::text AS duty_count,
              (array_agg(d.duty_date ORDER BY d.duty_date, d.slot_order))[1] AS next_date,
              (array_agg(d.time_from ORDER BY d.duty_date, d.slot_order))[1] AS next_from,
              (array_agg(d.time_to   ORDER BY d.duty_date, d.slot_order))[1] AS next_to,
              (array_agg(d.floor_number_snapshot ORDER BY d.duty_date, d.slot_order))[1] AS next_floor,
              (array_agg(d.room_number_snapshot  ORDER BY d.duty_date, d.slot_order))[1] AS next_room
         FROM duties d
        WHERE d.schedule_id = $1 AND d.student_id IS NOT NULL
        GROUP BY d.student_id`,
      [scheduleId],
    );

    let queued = 0;
    for (const row of rows) {
      const text = messages.schedulePublished({
        year: head.year,
        month: head.month,
        dutyCount: Number(row.duty_count),
        nearest: row.next_date
          ? {
              date: row.next_date,
              timeFrom: row.next_from!,
              timeTo: row.next_to!,
              floorNumber: row.next_floor ?? 0,
              roomNumber: row.next_room,
            }
          : null,
      });
      const id = await this.enqueue({
        studentId: row.student_id,
        type: 'schedule_published',
        text,
        // Ключ идемпотентности — тип плюс студент; график привязываем
        // через первое дежурство, чтобы разные месяцы не схлопывались.
        dutyId: await this.firstDutyOf(scheduleId, row.student_id),
      });
      if (id) queued += 1;
    }
    return queued;
  }

  private async firstDutyOf(scheduleId: string, studentId: string): Promise<string | null> {
    const { rows } = await this.db.query<{ id: string }>(
      `SELECT id FROM duties
        WHERE schedule_id = $1 AND student_id = $2
        ORDER BY duty_date, slot_order LIMIT 1`,
      [scheduleId, studentId],
    );
    return rows[0]?.id ?? null;
  }

  async dutyReminder(
    studentId: string,
    dutyId: string,
    hoursBefore: number,
  ): Promise<string | null> {
    const duty = await this.dutyView(dutyId);
    if (!duty) return null;
    return this.enqueue({
      studentId,
      dutyId,
      type: 'duty_reminder',
      text: messages.dutyReminder(duty, hoursBefore),
    });
  }

  async dutyMissed(
    studentId: string,
    dutyId: string,
    info: { reason: string | null; totalViolations: number },
  ): Promise<string | null> {
    const duty = await this.dutyView(dutyId);
    if (!duty) return null;
    return this.enqueue({
      studentId,
      dutyId,
      type: 'duty_missed',
      text: messages.dutyMissed({ duty, ...info }),
    });
  }

  async explanationRequired(
    studentId: string,
    violationId: string,
    info: { total: number },
  ): Promise<string | null> {
    return this.enqueue({
      studentId,
      violationId,
      type: 'explanation_required',
      text: messages.explanationRequired(info.total),
    });
  }

  async substitutedIn(
    studentId: string,
    dutyId: string,
    changeId: string,
    reason: string,
  ): Promise<string | null> {
    const duty = await this.dutyView(dutyId);
    if (!duty) return null;
    return this.enqueue({
      studentId,
      dutyId,
      dutyChangeId: changeId,
      type: 'substituted_in',
      text: messages.substitutedIn(duty, reason),
    });
  }

  async substitutedOut(
    studentId: string,
    dutyId: string,
    changeId: string,
    reason: string,
  ): Promise<string | null> {
    const duty = await this.dutyView(dutyId);
    if (!duty) return null;
    return this.enqueue({
      studentId,
      dutyId,
      dutyChangeId: changeId,
      type: 'substituted_out',
      text: messages.substitutedOut(duty, reason),
    });
  }

  // ─────────────────────────── доставка ───────────────────────────

  /**
   * Отправляет всё, чему подошло время. Вызывается планировщиком.
   * Каждое сообщение отмечается сразу после отправки, поэтому повторный
   * запуск не приведёт к дублю.
   */
  async dispatchPending(now = new Date()): Promise<{ sent: number; failed: number; skipped: number }> {
    if (this.channel.enabled === false) {
      return { sent: 0, failed: 0, skipped: 0 };
    }

    const { rows } = await this.db.query<{
      id: string;
      payload: { text: string };
      telegram_id: string | null;
      status: string;
    }>(
      `SELECT n.id, n.payload, s.telegram_id, s.status
         FROM notifications n
         JOIN students s ON s.id = n.student_id
        WHERE n.state = 'pending' AND n.scheduled_at <= $1
        ORDER BY n.scheduled_at
        LIMIT 200`,
      [now],
    );

    let sent = 0;
    let failed = 0;
    let skipped = 0;

    for (const row of rows) {
      // Студент без Telegram ID или выведенный из состава пропускается.
      if (!row.telegram_id || row.status !== 'active') {
        await this.db.query(
          `UPDATE notifications SET state = 'skipped', error = $2 WHERE id = $1`,
          [row.id, row.telegram_id ? 'студент неактивен' : 'нет Telegram ID'],
        );
        skipped += 1;
        continue;
      }

      try {
        await this.channel.send({ telegramId: row.telegram_id, text: row.payload.text });
        await this.db.query(
          `UPDATE notifications SET state = 'sent', sent_at = now() WHERE id = $1`,
          [row.id],
        );
        sent += 1;
      } catch (error) {
        await this.db.query(
          `UPDATE notifications
              SET state = CASE WHEN attempts >= 4 THEN 'failed' ELSE 'pending' END,
                  attempts = attempts + 1,
                  error = $2
            WHERE id = $1`,
          [row.id, (error as Error).message.slice(0, 500)],
        );
        failed += 1;
      }
    }

    return { sent, failed, skipped };
  }
}
