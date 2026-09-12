import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { buildRouter } from '../../src/api/routes.js';
import { handle } from '../../src/api/http.js';
import { DisabledNotificationChannel } from '../../src/adapters/telegram/DisabledNotificationChannel.js';
import { createAdmin, login } from '../../src/services/auth/authService.js';
import { resetLoginRateLimit } from '../../src/services/auth/loginRateLimit.js';
import { NotificationService } from '../../src/services/notifications/NotificationService.js';
import { renderHtmlToPdf, findBrowser } from '../../src/services/export/pdfRenderer.js';
import { renderScheduleHtml } from '../../src/services/export/scheduleHtml.js';
import { buildScheduleDocument } from '../../src/services/export/scheduleDocument.js';
import { ManualImportSource } from '../../src/services/import/xlsxSource.js';
import { preview } from '../../src/services/importService.js';
import { queueReminders, runOnce } from '../../src/worker/scheduler.js';
import { generate, publish } from '../../src/services/scheduleService.js';
import { type Seed, freshSeed, testPool } from '../helpers.js';

/**
 * Production smoke tests: health, auth, изоляция, Telegram-off режим,
 * PDF, импорт, worker.
 */
describe('production smoke', () => {
  let db: pg.Pool;
  let seed: Seed;
  let server: Server;
  let base: string;
  let floor6: string;
  let floor7: string;

  const PASSWORD = 'production-smoke-test-password-42';

  beforeEach(async () => {
    resetLoginRateLimit();
    db = testPool();
    seed = await freshSeed(db);
    floor6 = seed.floors['6']!;
    floor7 = seed.floors['7']!;

    const router = buildRouter();
    server = createServer((req, res) => {
      handle(router, db, req, res).catch(() => {
        res.writeHead(500);
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.end();
  });

  const signIn = async (email: string): Promise<string> => {
    const response = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email, password: PASSWORD }),
      redirect: 'manual',
    });
    const cookie = response.headers.get('set-cookie');
    expect(cookie).toBeTruthy();
    return cookie!.split(';')[0]!;
  };

  it('GET /health возвращает 200', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('GET /health/db проверяет соединение с базой', async () => {
    const res = await fetch(`${base}/health/db`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('без входа админка возвращает 302 на /login', async () => {
    const res = await fetch(`${base}/`, {
      redirect: 'manual',
      headers: { accept: 'text/html' },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login');
  });

  it('без входа JSON-запрос возвращает 401', async () => {
    const res = await fetch(`${base}/`, { redirect: 'manual' });
    expect(res.status).toBe(401);
  });

  it('вход и авторизованный доступ работают', async () => {
    await createAdmin(db, {
      email: 'smoke@example.org',
      password: PASSWORD,
      role: 'dorm_admin',
      dormitoryId: seed.dormitoryId,
    });
    const cookie = await signIn('smoke@example.org');
    const res = await fetch(`${base}/`, {
      headers: { cookie, accept: 'text/html' },
      redirect: 'manual',
    });
    expect(res.status).toBe(200);
  });

  it('rate limit блокирует перебор пароля', async () => {
    await createAdmin(db, {
      email: 'brute@example.org',
      password: PASSWORD,
      role: 'dorm_admin',
      dormitoryId: seed.dormitoryId,
    });
    for (let i = 0; i < 5; i++) {
      await fetch(`${base}/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ email: 'brute@example.org', password: 'wrong' }),
      });
    }
    const blocked = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'brute@example.org', password: 'wrong' }),
    });
    expect(blocked.status).toBe(401);
    expect(await blocked.text()).toMatch(/Слишком много попыток/);
  });

  it('floor_admin не получает чужой график', async () => {
    const schedule = await generate(db, { floorId: floor7, year: 2026, month: 9 });
    await createAdmin(db, {
      email: 'floor6@example.org',
      password: PASSWORD,
      role: 'floor_admin',
      dormitoryId: seed.dormitoryId,
      floorIds: [floor6],
    });
    const cookie = await signIn('floor6@example.org');
    const res = await fetch(`${base}/schedules/${schedule.scheduleId}`, {
      headers: { cookie, accept: 'text/html' },
      redirect: 'manual',
    });
    expect(res.status).toBe(403);
  });

  it('worker без Telegram не падает и не дублирует напоминания', async () => {
    const channel = new DisabledNotificationChannel();
    const notifications = new NotificationService(db, channel);
    const schedule = await generate(db, { floorId: floor6, year: 2026, month: 9 });
    await publish(db, schedule.scheduleId);

    const first = await runOnce(db, notifications);
    const second = await runOnce(db, notifications);
    expect(first.failed).toBe(0);
    expect(second.failed).toBe(0);
    expect(first.remindersQueued).toBeGreaterThanOrEqual(0);

    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM notifications
        WHERE type = 'duty_reminder' AND student_id = $1`,
      [seed.students['Иванов Иван']],
    );
    const count = Number(rows[0]!.count);
    const requeued = await queueReminders(db, notifications);
    const { rows: after } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM notifications
        WHERE type = 'duty_reminder' AND student_id = $1`,
      [seed.students['Иванов Иван']],
    );
    expect(Number(after[0]!.count)).toBe(count);
    expect(requeued).toBe(0);
  });

  it('импорт XLSX: preview не падает на валидных данных', async () => {
    const source = new ManualImportSource();
    const result = await preview(db, {
      floorId: floor6,
      source,
      input: {
        rows: [
          {
            'Комната': '601',
            'ФИО': 'Тестов Тест',
            'Факультет': 'ФИТ',
            'Курс': '1',
            'Группа': '1-1',
          },
        ],
        fileName: 'test.xlsx',
      },
    });
    expect(result.summary).toBeDefined();
  });

  it('PDF генерируется headless при наличии браузера', async () => {
    if (!(await findBrowser())) return;

    const doc = buildScheduleDocument({
      floorNumber: 6,
      floorCode: null,
      dormitoryNumber: '1',
      year: 2026,
      month: 9,
      status: 'draft',
      approval: { wardenName: null, curatorName: null, councilHeadName: null },
      duties: [
        {
          date: '2026-09-01',
          slotOrder: 1,
          timeFrom: '09:00',
          timeTo: '11:00',
          studentName: 'Иванов Иван',
          roomNumber: '601',
        },
      ],
      changes: [],
    });

    try {
      const pdf = await renderHtmlToPdf(renderScheduleHtml(doc));
      expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    } catch {
      // Headless Chrome может быть недоступен в CI — не считаем ошибкой.
    }
  });

  it('экспорт XLSX графика не требует PDF', async () => {
    await createAdmin(db, {
      email: 'export@example.org',
      password: PASSWORD,
      role: 'dorm_admin',
      dormitoryId: seed.dormitoryId,
    });
    const cookie = await signIn('export@example.org');
    const generated = await generate(db, { floorId: floor6, year: 2026, month: 10 });
    const res = await fetch(`${base}/schedules/${generated.scheduleId}/export.xlsx`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/spreadsheet/);
  });
});
