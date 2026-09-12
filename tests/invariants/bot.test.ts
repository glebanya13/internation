import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { BotService } from '../../src/services/bot/BotService.js';
import { parseAction } from '../../src/adapters/telegram/bot.js';
import {
  type NotificationChannel,
  NotificationService,
  type OutgoingMessage,
} from '../../src/services/notifications/NotificationService.js';
import {
  confirmViolation,
  markCompleted,
  markMissed,
  substitute,
} from '../../src/services/dutyJournalService.js';
import { generate, publish } from '../../src/services/scheduleService.js';
import { setStudentStatus } from '../../src/services/rosterService.js';
import { type Seed, freshSeed, testPool } from '../helpers.js';

/** Канал-заглушка: собирает отправленное вместо реальных запросов. */
class CapturingChannel implements NotificationChannel {
  readonly name = 'capture';
  readonly sent: OutgoingMessage[] = [];
  failNext = false;

  async send(message: OutgoingMessage): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('канал недоступен');
    }
    this.sent.push(message);
  }
}

describe('Telegram-бот и уведомления', () => {
  let db: pg.Pool;
  let seed: Seed;
  let bot: BotService;
  let channel: CapturingChannel;
  let notifications: NotificationService;
  let floor6: string;
  let floor7: string;

  const TG_IVANOV = '100000001';
  const TG_PETROV = '100000002';
  const TG_LEBEDEV = '200000001';

  beforeEach(async () => {
    db = testPool();
    seed = await freshSeed(db);
    floor6 = seed.floors['6']!;
    floor7 = seed.floors['7']!;
    bot = new BotService(db);
    channel = new CapturingChannel();
    notifications = new NotificationService(db, channel);

    // Telegram ID заводит администратор — сам студент его не выбирает.
    await db.query('UPDATE students SET telegram_id = $2 WHERE id = $1', [
      seed.students['Иванов Иван'],
      TG_IVANOV,
    ]);
    await db.query('UPDATE students SET telegram_id = $2 WHERE id = $1', [
      seed.students['Петров Пётр'],
      TG_PETROV,
    ]);
    await db.query('UPDATE students SET telegram_id = $2 WHERE id = $1', [
      seed.students['Лебедев Максим'],
      TG_LEBEDEV,
    ]);
  });
  afterEach(async () => {
    await db.end();
  });

  const publishSeptember = async (floorId: string): Promise<string> => {
    const result = await generate(db, { floorId, year: 2026, month: 9 });
    await publish(db, result.scheduleId);
    return result.scheduleId;
  };

  it('1 · зарегистрированный Telegram ID → правильный студент', async () => {
    const student = await bot.resolve(TG_IVANOV);
    expect(student).not.toBeNull();
    expect(student!.studentId).toBe(seed.students['Иванов Иван']);
    expect(student!.fullName).toBe('Иванов Иван');
    expect(student!.floorNumber).toBe(6);
  });

  it('2 · неизвестный Telegram ID → отказ', async () => {
    const reply = await bot.handle('999999999', 'start');
    expect(reply.registered).toBe(false);
    expect(reply.text).toMatch(/ещё не зарегистрирован/);
    expect(reply.buttons).toEqual([]);

    // И ни один другой раздел ему тоже недоступен.
    for (const action of ['my_duty', 'my_schedule', 'my_info'] as const) {
      const denied = await bot.handle('999999999', action);
      expect(denied.registered).toBe(false);
      expect(denied.text).toMatch(/ещё не зарегистрирован/);
    }
  });

  it('3 · студент получает только свои дежурства', async () => {
    await publishSeptember(floor6);
    const reply = await bot.handle(TG_IVANOV, 'my_schedule');

    const { rows: own } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM duties d
         JOIN duty_schedules s ON s.id = d.schedule_id
        WHERE d.student_id = $1 AND s.year = 2026 AND s.month = 9`,
      [seed.students['Иванов Иван']],
    );
    const lines = reply.text.split('\n').filter((l) => /^\d{2}\.\d{2} · /.test(l));
    expect(lines).toHaveLength(Number(own[0]!.count));

    // В тексте нет чужих фамилий — только даты и время.
    expect(reply.text).not.toMatch(/Петров|Соколов|Волков/);
  });

  it('4 · студент не получает данные другого этажа', async () => {
    await publishSeptember(floor6);
    await publishSeptember(floor7);

    const lebedev = await bot.handle(TG_LEBEDEV, 'my_schedule');
    const { rows } = await db.query<{ duty_date: string }>(
      `SELECT d.duty_date FROM duties d
         JOIN duty_schedules s ON s.id = d.schedule_id
        WHERE s.floor_id = $1 AND d.student_id = $2`,
      [floor7, seed.students['Лебедев Максим']],
    );
    const lines = lebedev.text.split('\n').filter((l) => /^\d{2}\.\d{2} · /.test(l));
    expect(lines).toHaveLength(rows.length);

    const info = await bot.handle(TG_LEBEDEV, 'my_info');
    expect(info.text).toMatch(/7 этаж/);
    expect(info.text).not.toMatch(/6 этаж/);
  });

  it('5 · параметра для выбора чужого этажа не существует', async () => {
    // Команда с параметром распознаётся как обычная, параметр отбрасывается.
    expect(parseAction('/floor 7')).toBe('unknown');
    expect(parseAction('/start 7')).toBe('start');
    expect(parseAction('/start')).toBe('start');

    // BotService принимает только telegram_id и действие: подставить
    // чужой student_id или floor_id физически некуда.
    const reply = await bot.handle(TG_IVANOV, 'my_info');
    expect(reply.text).toMatch(/6 этаж/);

    const source = await readFile(
      join(process.cwd(), 'src/services/bot/BotService.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/handle\([^)]*studentId/);
    expect(source).not.toMatch(/handle\([^)]*floorId/);
  });

  it('6 · ближайшее дежурство определяется правильно', async () => {
    await publishSeptember(floor6);
    const { rows } = await db.query<{ duty_date: string; time_from: string }>(
      `SELECT d.duty_date, d.time_from FROM duties d
         JOIN duty_schedules s ON s.id = d.schedule_id
        WHERE d.student_id = $1 AND s.status = 'published' AND d.duty_date >= current_date
        ORDER BY d.duty_date, d.slot_order LIMIT 1`,
      [seed.students['Иванов Иван']],
    );

    const reply = await bot.handle(TG_IVANOV, 'my_duty');
    if (rows.length === 0) {
      expect(reply.text).toMatch(/нет запланированных дежурств/);
      return;
    }
    const [, month, day] = rows[0]!.duty_date.split('-').map(Number);
    expect(reply.text).toMatch(new RegExp(`${day} `));
    expect(reply.text).toMatch(/Ближайшее дежурство|Сегодня ваше дежурство/);
    void month;
  });

  it('6a · без дежурств бот говорит об этом прямо', async () => {
    const reply = await bot.handle(TG_IVANOV, 'my_duty');
    expect(reply.text).toBe('На данный момент у вас нет запланированных дежурств.');
  });

  it('7 · воскресные интервалы отображаются правильно', async () => {
    await publishSeptember(floor6);
    const reply = await bot.handle(TG_IVANOV, 'my_schedule');

    const { rows } = await db.query<{ duty_date: string; time_from: string; time_to: string }>(
      `SELECT d.duty_date, d.time_from, d.time_to FROM duties d
         JOIN duty_schedules s ON s.id = d.schedule_id
        WHERE d.student_id = $1 AND s.year = 2026 AND s.month = 9
          AND extract(isodow FROM d.duty_date) = 7`,
      [seed.students['Иванов Иван']],
    );

    for (const duty of rows) {
      const [, m, d] = duty.duty_date.split('-');
      const expected = `${d}.${m} · ${duty.time_from.slice(0, 5)}–${duty.time_to.slice(0, 5)}`;
      expect(reply.text, `нет строки: ${expected}`).toContain(expected);
    }
    // Воскресные интервалы действительно отличаются от будних.
    const sundayTimes = new Set(rows.map((r) => r.time_from.slice(0, 5)));
    if (sundayTimes.size > 0) {
      expect([...sundayTimes].some((t) => t === '10:00' || t === '12:30' || t === '19:00' || t === '21:00')).toBe(true);
    }
  });

  it('8 · опубликованный график виден студенту', async () => {
    await publishSeptember(floor6);
    const reply = await bot.handle(TG_IVANOV, 'my_schedule');
    expect(reply.text).toMatch(/Сентябрь 2026/);
    expect(reply.text.split('\n').filter((l) => /^\d{2}\.\d{2} · /.test(l)).length)
      .toBeGreaterThan(0);
  });

  it('9 · черновик студенту не виден', async () => {
    await generate(db, { floorId: floor6, year: 2026, month: 9 });

    const schedule = await bot.handle(TG_IVANOV, 'my_schedule');
    expect(schedule.text).toMatch(/Опубликованного графика на этот месяц нет/);

    const duty = await bot.handle(TG_IVANOV, 'my_duty');
    expect(duty.text).toMatch(/нет запланированных дежурств/);
  });

  it('10 · замена отправляет уведомления обеим сторонам', async () => {
    const scheduleId = await publishSeptember(floor6);
    const { rows } = await db.query<{ id: string; student_id: string }>(
      `SELECT id, student_id FROM duties
        WHERE schedule_id = $1 AND student_id = $2
        ORDER BY duty_date LIMIT 1`,
      [scheduleId, seed.students['Иванов Иван']],
    );
    const duty = rows[0]!;

    await substitute(db, {
      dutyId: duty.id,
      toStudentId: seed.students['Петров Пётр']!,
      reason: 'Отъезд по семейным обстоятельствам',
      notifications,
    });
    await notifications.dispatchPending();

    const toIvanov = channel.sent.find((m) => m.telegramId === TG_IVANOV);
    const toPetrov = channel.sent.find((m) => m.telegramId === TG_PETROV);

    expect(toIvanov!.text).toMatch(/Дежурство переназначено/);
    expect(toIvanov!.text).toMatch(/Отъезд по семейным обстоятельствам/);
    expect(toPetrov!.text).toMatch(/Вам назначено дежурство/);

    // История не переписана молча.
    const { rows: changes } = await db.query<{
      from_student_id: string;
      to_student_id: string;
      reason: string;
      changed_at: string;
    }>('SELECT from_student_id, to_student_id, reason, changed_at FROM duty_changes');
    expect(changes).toHaveLength(1);
    expect(changes[0]!.from_student_id).toBe(seed.students['Иванов Иван']);
    expect(changes[0]!.to_student_id).toBe(seed.students['Петров Пётр']);
    expect(changes[0]!.changed_at).toBeTruthy();
  });

  it('10a · замена возможна только на студента того же этажа', async () => {
    const scheduleId = await publishSeptember(floor6);
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM duties WHERE schedule_id = $1 AND student_id IS NOT NULL LIMIT 1`,
      [scheduleId],
    );
    await expect(
      substitute(db, {
        dutyId: rows[0]!.id,
        toStudentId: seed.students['Лебедев Максим']!,
        reason: 'проверка',
      }),
    ).rejects.toThrow(/не найден на этом этаже/);
  });

  it('11 · MISSED увеличивает счётчик после подтверждения', async () => {
    const scheduleId = await publishSeptember(floor6);
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM duties WHERE schedule_id = $1 AND student_id = $2
        ORDER BY duty_date LIMIT 2`,
      [scheduleId, seed.students['Иванов Иван']],
    );

    const first = await markMissed(db, rows[0]!.id, { notifications });
    // Пропуск сам по себе ещё не нарушение.
    let count = await confirmedCount(db, seed.students['Иванов Иван']!);
    expect(count).toBe(0);

    const confirmed = await confirmViolation(db, first.violationId, { notifications });
    expect(confirmed.total).toBe(1);
    expect(confirmed.explanationRequired).toBe(false);

    count = await confirmedCount(db, seed.students['Иванов Иван']!);
    expect(count).toBe(1);

    const { rows: status } = await db.query<{ status: string }>(
      'SELECT status FROM duties WHERE id = $1',
      [rows[0]!.id],
    );
    expect(status[0]!.status).toBe('missed');
  });

  it('11a · отметка «выполнено» снимает ранее зафиксированный пропуск', async () => {
    const scheduleId = await publishSeptember(floor6);
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM duties WHERE schedule_id = $1 AND student_id = $2 LIMIT 1`,
      [scheduleId, seed.students['Иванов Иван']],
    );
    await markMissed(db, rows[0]!.id, {});
    await markCompleted(db, rows[0]!.id);

    const { rows: violations } = await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM violations WHERE duty_id = $1',
      [rows[0]!.id],
    );
    expect(violations[0]!.count).toBe('0');
  });

  it('12 · третий пропуск создаёт EXPLANATION_REQUIRED', async () => {
    const violations = await threeConfirmedMisses(db, seed, notifications, floor6);

    const { rows } = await db.query<{ state: string; sequence_no: number }>(
      'SELECT state, sequence_no FROM violations WHERE id = $1',
      [violations[2]!],
    );
    expect(rows[0]!.state).toBe('explanation_required');
    expect(rows[0]!.sequence_no).toBe(3);
  });

  it('13 · уведомление о трёх пропусках отправляется', async () => {
    await threeConfirmedMisses(db, seed, notifications, floor6);
    await notifications.dispatchPending();

    const explanation = channel.sent.filter((m) => /Необходимо предоставить объяснительную/.test(m.text));
    expect(explanation).toHaveLength(1);
    expect(explanation[0]!.telegramId).toBe(TG_IVANOV);
    expect(explanation[0]!.text).toMatch(/накопилось 3 пропуска/);
  });

  it('14 · повторное уведомление не отправляется бесконечно', async () => {
    await threeConfirmedMisses(db, seed, notifications, floor6);

    // Планировщик просыпается многократно — рассылка не дублируется.
    for (let i = 0; i < 5; i += 1) await notifications.dispatchPending();

    const explanation = channel.sent.filter((m) => /объяснительную/.test(m.text));
    expect(explanation).toHaveLength(1);

    const missed = channel.sent.filter((m) => /Дежурство пропущено/.test(m.text));
    expect(missed).toHaveLength(3);
  });

  it('15 · напоминание отправляется один раз', async () => {
    const { queueReminders } = await import('../../src/worker/scheduler.js');
    const scheduleId = await publishSeptember(floor6);

    const { rows } = await db.query<{ duty_date: string }>(
      'SELECT duty_date FROM duties WHERE schedule_id = $1 ORDER BY duty_date LIMIT 1',
      [scheduleId],
    );
    // Момент за 12 часов до первого дежурства месяца.
    const now = new Date(`${rows[0]!.duty_date}T00:00:00Z`);

    const first = await queueReminders(db, notifications, now);
    expect(first).toBeGreaterThan(0);

    // Повторные проходы планировщика ничего не добавляют.
    for (let i = 0; i < 4; i += 1) {
      expect(await queueReminders(db, notifications, now)).toBe(0);
    }

    await notifications.dispatchPending(now);
    await notifications.dispatchPending(now);

    const reminders = channel.sent.filter((m) => /Напоминание о дежурстве/.test(m.text));
    const perStudent = new Map<string, number>();
    for (const message of reminders) {
      perStudent.set(message.telegramId, (perStudent.get(message.telegramId) ?? 0) + 1);
    }
    for (const count of perStudent.values()) expect(count).toBe(1);
  });

  it('16 · Telegram handler не содержит бизнес-логики', async () => {
    const files = await readdir(join(process.cwd(), 'src/adapters/telegram'));
    // Ищем именно обращения к данным и предметную логику.
    // Грубый шаблон вроде /UPDATE / ловил бы «for (const update of …)».
    const forbidden =
      /generateSchedule|checkFeasibility|db\.query|client\.query|pg\b|INSERT\s+INTO|UPDATE\s+\w+\s+SET|SELECT\s+[\w*]+\s+FROM|violation|roster/i;

    for (const name of files) {
      const text = await readFile(join(process.cwd(), 'src/adapters/telegram', name), 'utf8');
      const code = text
        .split('\n')
        .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
        .join('\n');
      expect(forbidden.test(code), `бизнес-логика в ${name}`).toBe(false);
    }
  });

  it('16a · планировщик не живёт внутри Telegram-адаптера', async () => {
    const files = await readdir(join(process.cwd(), 'src/adapters/telegram'));
    for (const name of files) {
      const text = await readFile(join(process.cwd(), 'src/adapters/telegram', name), 'utf8');
      expect(/setInterval|cron|queueReminders/.test(text), `cron в ${name}`).toBe(false);
    }
  });

  it('17 · запрос одного студента не может получить данные другого', async () => {
    await publishSeptember(floor6);

    const ivanov = await bot.handle(TG_IVANOV, 'my_schedule');
    const petrov = await bot.handle(TG_PETROV, 'my_schedule');
    expect(ivanov.text).not.toBe(petrov.text);

    const ivanovInfo = await bot.handle(TG_IVANOV, 'my_info');
    expect(ivanovInfo.text).toMatch(/Иванов Иван/);
    expect(ivanovInfo.text).not.toMatch(/Петров/);

    // Telegram ID другого студента возвращает данные ТОГО студента,
    // а не запрошенного: единственный вход — сам идентификатор.
    const asPetrov = await bot.resolve(TG_PETROV);
    expect(asPetrov!.studentId).toBe(seed.students['Петров Пётр']);
  });

  it('18 · отключённый студент не получает новые уведомления', async () => {
    const scheduleId = await publishSeptember(floor6);
    await setStudentStatus(db, seed.students['Иванов Иван']!, 'moved_out');

    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM duties WHERE schedule_id = $1 AND student_id = $2 LIMIT 1`,
      [scheduleId, seed.students['Иванов Иван']],
    );
    const queued = await notifications.dutyReminder(seed.students['Иванов Иван']!, rows[0]!.id, 24);
    expect(queued).toBeNull();

    await notifications.dispatchPending();
    expect(channel.sent.some((m) => m.telegramId === TG_IVANOV)).toBe(false);

    // И бот его больше не узнаёт.
    expect(await bot.resolve(TG_IVANOV)).toBeNull();
  });

  it('18a · студент без Telegram ID не роняет рассылку', async () => {
    const scheduleId = await publishSeptember(floor6);
    const queued = await notifications.schedulePublished(scheduleId);
    expect(queued).toBeGreaterThan(0);

    const result = await notifications.dispatchPending();
    // У большинства демо-студентов Telegram ID не задан.
    expect(result.skipped).toBeGreaterThan(0);
    expect(result.sent).toBeGreaterThan(0);
    expect(result.failed).toBe(0);
  });

  it('18b · сбой канала не теряет уведомление', async () => {
    const scheduleId = await publishSeptember(floor6);
    await notifications.schedulePublished(scheduleId);

    channel.failNext = true;
    const first = await notifications.dispatchPending();
    expect(first.failed).toBe(1);

    // Уведомление осталось в очереди и уйдёт следующим проходом.
    const second = await notifications.dispatchPending();
    expect(second.sent).toBeGreaterThan(0);
  });
});

async function confirmedCount(db: pg.Pool, studentId: string): Promise<number> {
  const { rows } = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM violations
      WHERE student_id = $1
        AND state IN ('confirmed', 'explanation_required', 'explained')`,
    [studentId],
  );
  return Number(rows[0]!.count);
}

async function threeConfirmedMisses(
  db: pg.Pool,
  seed: Seed,
  notifications: NotificationService,
  floorId: string,
): Promise<string[]> {
  const result = await generate(db, { floorId, year: 2026, month: 9 });
  await publish(db, result.scheduleId);

  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM duties WHERE schedule_id = $1 AND student_id = $2
      ORDER BY duty_date LIMIT 3`,
    [result.scheduleId, seed.students['Иванов Иван']],
  );

  const violations: string[] = [];
  for (const duty of rows) {
    const missed = await markMissed(db, duty.id, { notifications });
    await confirmViolation(db, missed.violationId, { notifications });
    violations.push(missed.violationId);
  }
  return violations;
}
