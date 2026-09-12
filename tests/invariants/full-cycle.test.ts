import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { BotService } from '../../src/services/bot/BotService.js';
import {
  type NotificationChannel,
  NotificationService,
  type OutgoingMessage,
} from '../../src/services/notifications/NotificationService.js';
import { confirmViolation, markCompleted, markMissed } from '../../src/services/dutyJournalService.js';
import { RosterExportService } from '../../src/services/export/index.js';
import { ScheduleExportService } from '../../src/services/export/scheduleExport.js';
import { ManualImportSource } from '../../src/services/import/xlsxSource.js';
import { apply, preview } from '../../src/services/importService.js';
import { generate, publish } from '../../src/services/scheduleService.js';
import { currentRoster } from '../../src/services/rosterService.js';
import { type Seed, freshSeed, testPool } from '../helpers.js';

class CapturingChannel implements NotificationChannel {
  readonly name = 'capture';
  readonly sent: OutgoingMessage[] = [];
  async send(message: OutgoingMessage): Promise<void> {
    this.sent.push(message);
  }
}

/**
 * Целевой сценарий целиком:
 *
 *   импорт списка → подтверждение состава → генерация графика →
 *   печать → публикация → дежурства в Telegram → отметка выполнения →
 *   подсчёт пропусков → уведомление об объяснительной
 */
describe('полный цикл', () => {
  let db: pg.Pool;
  let seed: Seed;
  let channel: CapturingChannel;
  let notifications: NotificationService;

  const TG = '700000001';

  beforeEach(async () => {
    db = testPool();
    seed = await freshSeed(db);
    channel = new CapturingChannel();
    notifications = new NotificationService(db, channel);
  });
  afterEach(async () => {
    await db.end();
  });

  it('проходит от импорта списка до требования объяснительной', async () => {
    const floor6 = seed.floors['6']!;

    // ── 1. Администратор загружает список этажа ─────────────────────
    const rows = [
      { Комната: '601А', 'Фамилия Имя': 'Иванов Иван', Факультет: 'ФИТ', Смена: '2', 'Курс-группа': '2-1' },
      { Комната: '601А', 'Фамилия Имя': 'Петров Пётр', Факультет: 'ФИТ', Смена: '2', 'Курс-группа': '2-1' },
      { Комната: '601А', 'Фамилия Имя': 'Смирнов Алексей', Факультет: 'ФИТ', Смена: '1', 'Курс-группа': '1-4' },
      { Комната: '601Б', 'Фамилия Имя': 'Кузнецов Дмитрий', Факультет: 'ФИТ', Смена: '1', 'Курс-группа': '1-4' },
      { Комната: '605А', 'Фамилия Имя': 'Соколов Никита', Факультет: 'ФИТ', Смена: '2', 'Курс-группа': '3-2' },
      { Комната: '605А', 'Фамилия Имя': 'Морозов Артём', Факультет: 'ТОВ', Смена: '1', 'Курс-группа': '2-7' },
      { Комната: '605Б', 'Фамилия Имя': 'Волков Егор', Факультет: 'ФИТ', Смена: '2', 'Курс-группа': '1-5' },
      { Комната: '607А', 'Фамилия Имя': 'Зайцев Роман', Факультет: 'ФИТ', Смена: '2', 'Курс-группа': '1-6' },
    ];
    const importPreview = await preview(db, {
      floorId: floor6,
      source: new ManualImportSource(),
      input: { rows, fileName: 'Список_6_этажа.xlsx' },
    });
    expect(importPreview.summary.added).toBe(1);
    expect(importPreview.blocking).toHaveLength(0);

    // ── 2. Подтверждение состава ────────────────────────────────────
    const applied = await apply(db, importPreview.importId);
    expect(applied.rosterVersionCreated).toBe(true);

    const roster = await currentRoster(db, floor6);
    expect(roster!.entries).toHaveLength(8);

    // ── 3. Печатный список ──────────────────────────────────────────
    const rosterExport = new RosterExportService(db);
    const rosterDoc = await rosterExport.loadCurrent(floor6);
    const rosterXlsx = await rosterExport.xlsx(rosterDoc, { academicYear: '2025-2026' });
    expect(rosterXlsx.length).toBeGreaterThan(1000);

    // ── 4. Генерация графика ────────────────────────────────────────
    const generated = await generate(db, { floorId: floor6, year: 2026, month: 9 });
    expect(generated.status).toBe('draft');
    expect(generated.generation.stats.unassignedSlots).toBe(0);
    expect(generated.generation.stats.loadSpread).toBeLessThanOrEqual(1);

    // ── 5. Печать графика ───────────────────────────────────────────
    const scheduleExport = new ScheduleExportService(db);
    const draftDoc = await scheduleExport.load(generated.scheduleId);
    expect(draftDoc.status).toBe('draft');
    expect(draftDoc.stats.assigned).toBe(120);

    // ── 6. Публикация ───────────────────────────────────────────────
    await publish(db, generated.scheduleId);

    // Телеграм студенту привязывает администратор.
    const zaytsev = roster!.entries.find((e) => e.full_name_snapshot === 'Зайцев Роман')!;
    await db.query('UPDATE students SET telegram_id = $2 WHERE id = $1', [
      zaytsev.student_id,
      TG,
    ]);

    const queued = await notifications.schedulePublished(generated.scheduleId);
    expect(queued).toBeGreaterThan(0);
    await notifications.dispatchPending();

    const published = channel.sent.find((m) => m.telegramId === TG);
    expect(published!.text).toMatch(/График дежурств опубликован/);
    expect(published!.text).toMatch(/Сентябрь 2026/);

    // ── 7. Студент видит свои дежурства в боте ──────────────────────
    const bot = new BotService(db);
    const mySchedule = await bot.handle(TG, 'my_schedule');
    expect(mySchedule.registered).toBe(true);
    expect(mySchedule.text).toMatch(/Сентябрь 2026/);

    const myInfo = await bot.handle(TG, 'my_info');
    expect(myInfo.text).toMatch(/Зайцев Роман/);
    expect(myInfo.text).toMatch(/6 этаж/);
    expect(myInfo.text).toMatch(/607А/);

    // ── 8. Администратор отмечает выполнение ────────────────────────
    const { rows: duties } = await db.query<{ id: string }>(
      `SELECT id FROM duties WHERE schedule_id = $1 AND student_id = $2
        ORDER BY duty_date LIMIT 5`,
      [generated.scheduleId, zaytsev.student_id],
    );
    await markCompleted(db, duties[0]!.id);

    const { rows: completed } = await db.query<{ status: string }>(
      'SELECT status FROM duties WHERE id = $1',
      [duties[0]!.id],
    );
    expect(completed[0]!.status).toBe('completed');

    // ── 9. Три подтверждённых пропуска ──────────────────────────────
    for (const duty of duties.slice(1, 4)) {
      const missed = await markMissed(db, duty.id, { notifications });
      const result = await confirmViolation(db, missed.violationId, { notifications });
      if (result.total === 3) expect(result.explanationRequired).toBe(true);
    }
    await notifications.dispatchPending();

    // ── 10. Уведомление об объяснительной ───────────────────────────
    const explanation = channel.sent.filter(
      (m) => m.telegramId === TG && /объяснительную/.test(m.text),
    );
    expect(explanation).toHaveLength(1);
    expect(explanation[0]!.text).toMatch(/накопилось 3 пропуска/);

    const missedMessages = channel.sent.filter(
      (m) => m.telegramId === TG && /Дежурство пропущено/.test(m.text),
    );
    expect(missedMessages).toHaveLength(3);
    expect(missedMessages[2]!.text).toMatch(/Всего пропусков за текущий учебный год: 3/);

    // ── Итог: опубликованный график не изменился ────────────────────
    const finalDoc = await scheduleExport.load(generated.scheduleId);
    expect(finalDoc.status).toBe('published');
    expect(finalDoc.stats.assigned).toBe(120);
    expect(finalDoc.approval[1]!.role).toMatch(/Круклинская Л\.В\./);
  });
});
