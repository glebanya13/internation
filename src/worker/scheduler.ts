import type pg from 'pg';
import { parseSettings } from '../services/dutyJournalService.js';
import type { NotificationService } from '../services/notifications/NotificationService.js';

/**
 * Планировщик фоновых задач.
 *
 * Вся периодическая логика собрана здесь, а не размазана по Telegram-
 * хендлерам: хендлер отвечает на сообщение студента и ничего не знает
 * про расписание рассылок.
 *
 * Задачи:
 *   · поставить напоминания о ближайших дежурствах;
 *   · отправить всё, чему подошло время.
 *
 * Автоматического определения пропусков нет намеренно: в MVP отметку
 * делает администратор.
 */

export interface SchedulerRun {
  remindersQueued: number;
  sent: number;
  failed: number;
  skipped: number;
}

/**
 * Ставит напоминания о дежурствах, до которых осталось меньше настроенного
 * числа часов. Повторный запуск ничего не дублирует: уникальный индекс
 * на (студент, дежурство, тип) пропустит вставку.
 */
export async function queueReminders(
  db: pg.Pool,
  notifications: NotificationService,
  now = new Date(),
): Promise<number> {
  const { rows: dormitories } = await db.query<{ id: string; settings: unknown }>(
    'SELECT id, settings FROM dormitories WHERE is_active',
  );

  let queued = 0;
  for (const dormitory of dormitories) {
    const settings = parseSettings(dormitory.settings);
    const horizon = new Date(now.getTime() + settings.reminderHoursBefore * 3_600_000);

    const { rows } = await db.query<{ id: string; student_id: string }>(
      `SELECT d.id, d.student_id
         FROM duties d
         JOIN duty_schedules s ON s.id = d.schedule_id
         JOIN floors f         ON f.id = s.floor_id
        WHERE f.dormitory_id = $1
          AND s.status = 'published'
          AND d.status = 'scheduled'
          AND d.student_id IS NOT NULL
          AND (d.duty_date + d.time_from) BETWEEN $2 AND $3`,
      [dormitory.id, now, horizon],
    );

    for (const duty of rows) {
      const id = await notifications.dutyReminder(
        duty.student_id,
        duty.id,
        settings.reminderHoursBefore,
      );
      if (id) queued += 1;
    }
  }
  return queued;
}

export async function runOnce(
  db: pg.Pool,
  notifications: NotificationService,
  now = new Date(),
): Promise<SchedulerRun> {
  const remindersQueued = await queueReminders(db, notifications, now);
  const dispatch = await notifications.dispatchPending(now);
  return { remindersQueued, ...dispatch };
}

/** Периодический запуск. Интервал в минутах. */
export async function runLoop(
  db: pg.Pool,
  notifications: NotificationService,
  options: { intervalMinutes?: number; shouldStop?: () => boolean } = {},
): Promise<void> {
  const interval = (options.intervalMinutes ?? 5) * 60_000;
  const shouldStop = options.shouldStop ?? ((): boolean => false);

  while (!shouldStop()) {
    try {
      const result = await runOnce(db, notifications);
      if (result.remindersQueued || result.sent || result.failed) {
        console.log(
          `[scheduler] напоминаний ${result.remindersQueued}, ` +
            `отправлено ${result.sent}, ошибок ${result.failed}, пропущено ${result.skipped}`,
        );
      }
    } catch (error) {
      console.error('[scheduler]', (error as Error).message);
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}
