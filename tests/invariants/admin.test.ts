import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { buildRouter } from '../../src/api/routes.js';
import { handle } from '../../src/api/http.js';
import { ForbiddenError, assertFloorAccess, createAdmin, login } from '../../src/services/auth/authService.js';
import { generate, publish, publishPreview } from '../../src/services/scheduleService.js';
import { setStudentStatus } from '../../src/services/rosterService.js';
import { type Seed, freshSeed, testPool } from '../helpers.js';

/**
 * Админка: доступ, изоляция этажей и сквозной цикл.
 *
 * Проверки идут по HTTP, как их видит браузер: сессия в cookie,
 * формы отправляются как формы.
 */
describe('админка', () => {
  let db: pg.Pool;
  let seed: Seed;
  let server: Server;
  let base: string;
  let floor6: string;
  let floor7: string;

  const PASSWORD = 'очень-длинный-пароль-42';

  beforeEach(async () => {
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
    expect(cookie, 'вход не удался').toBeTruthy();
    return cookie!.split(';')[0]!;
  };

  const get = (path: string, cookie?: string): Promise<Response> =>
    fetch(`${base}${path}`, {
      headers: {
        accept: 'text/html',
        ...(cookie ? { cookie } : {}),
      },
      redirect: 'manual',
    });

  const post = (path: string, cookie: string, body: Record<string, string>): Promise<Response> =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' },
      body: new URLSearchParams(body),
      redirect: 'manual',
    });

  const makeAdmin = async (
    email: string,
    role: 'superadmin' | 'dorm_admin' | 'floor_admin',
    floorIds?: string[],
  ): Promise<void> => {
    await createAdmin(db, {
      email,
      password: PASSWORD,
      role,
      dormitoryId: seed.dormitoryId,
      ...(floorIds ? { floorIds } : {}),
    });
  };

  it('без входа админка недоступна', async () => {
    for (const path of ['/', '/roster', '/schedules', '/settings', '/duties']) {
      const response = await get(path);
      expect(response.status, path).toBe(302);
      expect(response.headers.get('location')).toBe('/login');
    }
  });

  it('неверный пароль не пускает', async () => {
    await makeAdmin('admin@example.org', 'dorm_admin');
    const response = await fetch(`${base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'admin@example.org', password: 'неверный' }),
      redirect: 'manual',
    });
    expect(response.status).toBe(401);
    expect(response.headers.get('set-cookie')).toBeNull();

    const text = await response.text();
    // Не подсказываем, что именно не так: адрес или пароль.
    expect(text).toMatch(/Неверный адрес или пароль/);
  });

  it('администратор общежития видит все свои этажи', async () => {
    await makeAdmin('dorm@example.org', 'dorm_admin');
    const cookie = await signIn('dorm@example.org');

    const response = await get('/floors', cookie);
    const text = await response.text();
    expect(text).toMatch(/6 этаж/);
    expect(text).toMatch(/7 этаж/);
  });

  it('администратор этажа не видит чужой этаж', async () => {
    await makeAdmin('floor6@example.org', 'floor_admin', [floor6]);
    const cookie = await signIn('floor6@example.org');

    const floors = await (await get('/floors', cookie)).text();
    expect(floors).toMatch(/6 этаж/);
    expect(floors).not.toMatch(/7 этаж/);

    // Явная подстановка чужого этажа в адрес отклоняется.
    const roster = await get(`/roster?floor=${floor7}`, cookie);
    const rosterText = await roster.text();
    // Показан свой этаж, а не запрошенный чужой.
    expect(rosterText).toMatch(/Иванов Иван/);
    expect(rosterText).not.toMatch(/Лебедев Максим/);
  });

  it('операции над чужим этажом отклоняются с 403', async () => {
    await makeAdmin('floor6@example.org', 'floor_admin', [floor6]);
    const cookie = await signIn('floor6@example.org');

    const created = await post('/rooms', cookie, {
      floor_id: floor7,
      from: '799',
      to: '',
    });
    expect(created.status).toBe(403);

    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM rooms WHERE floor_id = $1 AND number = '799'`,
      [floor7],
    );
    expect(rows[0]!.count).toBe('0');
  });

  it('чужой график и дежурство недоступны', async () => {
    const schedule = await generate(db, { floorId: floor7, year: 2026, month: 9 });
    await makeAdmin('floor6@example.org', 'floor_admin', [floor6]);
    const cookie = await signIn('floor6@example.org');

    expect((await get(`/schedules/${schedule.scheduleId}`, cookie)).status).toBe(403);
    expect((await get(`/schedules/${schedule.scheduleId}/export.xlsx`, cookie)).status).toBe(403);

    const { rows } = await db.query<{ id: string }>(
      'SELECT id FROM duties WHERE schedule_id = $1 LIMIT 1',
      [schedule.scheduleId],
    );
    expect((await post(`/duties/${rows[0]!.id}/complete`, cookie, {})).status).toBe(403);
  });

  it('администратор этажа не меняет справочники', async () => {
    await makeAdmin('floor6@example.org', 'floor_admin', [floor6]);
    const cookie = await signIn('floor6@example.org');

    const response = await post('/settings/faculties', cookie, { code: 'НОВЫЙ' });
    expect(response.status).toBe(403);

    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM faculties WHERE code = 'НОВЫЙ'`,
    );
    expect(rows[0]!.count).toBe('0');
  });

  it('assertFloorAccess — единственная дверь к данным этажа', async () => {
    const admin = await createAdmin(db, {
      email: 'scoped@example.org',
      password: PASSWORD,
      role: 'floor_admin',
      dormitoryId: seed.dormitoryId,
      floorIds: [floor6],
    });
    const { actor } = await login(db, 'scoped@example.org', PASSWORD);
    expect(actor.adminId).toBe(admin);

    await expect(assertFloorAccess(db, actor, floor6)).resolves.toBeUndefined();
    await expect(assertFloorAccess(db, actor, floor7)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('состав этажа показывает все требуемые поля', async () => {
    await db.query('UPDATE students SET telegram_id = $2 WHERE id = $1', [
      seed.students['Иванов Иван'],
      '555000111',
    ]);
    await makeAdmin('dorm@example.org', 'dorm_admin');
    const cookie = await signIn('dorm@example.org');

    const text = await (await get(`/roster?floor=${floor6}`, cookie)).text();
    for (const header of [
      'Комната', 'Блок', 'ФИО', 'Telegram', 'Факультет', 'Курс', 'Группа', 'Смена', 'Статус',
    ]) {
      expect(text, `нет колонки ${header}`).toContain(header);
    }
    expect(text).toMatch(/Иванов Иван/);
    expect(text).toMatch(/ФИТ/);
    expect(text).toMatch(/привязан/);   // Telegram есть
    expect(text).toMatch(/нет ID/);     // у остальных нет
  });

  it('комнаты с 0, 1, 2 и 3 жильцами показываются корректно', async () => {
    await makeAdmin('dorm@example.org', 'dorm_admin');
    const cookie = await signIn('dorm@example.org');

    const text = await (await get(`/rooms?floor=${floor6}`, cookie)).text();
    // 607А и 607Б пусты, но в списке присутствуют.
    expect(text).toMatch(/607А/);
    expect(text).toMatch(/607Б/);
    expect(text).toMatch(/601А/);
    // Число жильцов подписано как факт, а не как вместимость.
    expect(text).toMatch(/Жильцов/);
    expect(text).toMatch(/не вместимость комнаты/);
  });

  it('комнату и блок можно создать отдельно от заселения', async () => {
    await makeAdmin('dorm@example.org', 'dorm_admin');
    const cookie = await signIn('dorm@example.org');

    await post('/blocks', cookie, { floor_id: floor6, code: '609', sections: 'А, Б' });
    await post('/rooms', cookie, { floor_id: floor6, from: '650', to: '652', block_id: '' });

    const { rows } = await db.query<{ number: string; occupants: string }>(
      `SELECT r.number,
              (SELECT count(*)::text FROM students WHERE room_id = r.id) AS occupants
         FROM rooms r WHERE r.floor_id = $1 AND r.number IN ('609А','609Б','650','651','652')
        ORDER BY r.number`,
      [floor6],
    );
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.occupants === '0')).toBe(true);
  });

  it('перед публикацией показывается подтверждение с составом', async () => {
    const schedule = await generate(db, { floorId: floor6, year: 2026, month: 9 });
    await makeAdmin('dorm@example.org', 'dorm_admin');
    const cookie = await signIn('dorm@example.org');

    const text = await (await get(`/schedules/${schedule.scheduleId}`, cookie)).text();
    expect(text).toMatch(/Подтверждение публикации/);
    expect(text).toMatch(/Сентябрь 2026/);
    expect(text).toMatch(/Студентов:/);
    expect(text).toMatch(/Дежурств:/);

    const preview = await publishPreview(db, schedule.scheduleId);
    expect(preview.students).toBe(7);
    expect(preview.duties).toBe(120);
    expect(preview.blockers).toEqual([]);
  });

  it('график по неактуальному составу не публикуется случайно', async () => {
    const schedule = await generate(db, { floorId: floor6, year: 2026, month: 9 });
    // Состав изменился уже после генерации.
    await setStudentStatus(db, seed.students['Морозов Артём']!, 'moved_out');

    const preview = await publishPreview(db, schedule.scheduleId);
    expect(preview.rosterDrifted).toBe(true);
    expect(preview.blockers.join(' ')).toMatch(/Состав этажа изменился/);

    await expect(publish(db, schedule.scheduleId)).rejects.toThrow(/Состав этажа изменился/);

    // Публикация возможна только с явным подтверждением.
    await makeAdmin('dorm@example.org', 'dorm_admin');
    const cookie = await signIn('dorm@example.org');

    const page = await (await get(`/schedules/${schedule.scheduleId}`, cookie)).text();
    expect(page).toMatch(/Публикация недоступна/);
    expect(page).toMatch(/acknowledge_drift/);

    const denied = await post(`/schedules/${schedule.scheduleId}/publish`, cookie, {});
    expect(denied.status).toBe(400);

    const allowed = await post(`/schedules/${schedule.scheduleId}/publish`, cookie, {
      acknowledge_drift: 'on',
    });
    expect(allowed.status).toBe(302);

    const { rows } = await db.query<{ status: string }>(
      'SELECT status FROM duty_schedules WHERE id = $1',
      [schedule.scheduleId],
    );
    expect(rows[0]!.status).toBe('published');
  });

  it('экспорт после реальных изменений отражает их', async () => {
    await makeAdmin('dorm@example.org', 'dorm_admin');
    const cookie = await signIn('dorm@example.org');

    // Заселяем нового студента через админку.
    await post('/roster/students', cookie, {
      floor_id: floor6,
      last_name: 'Зайцев',
      first_name: 'Роман',
      room: '607А',
      faculty: 'ФИТ',
      shift: '2',
      course: '1',
      group_code: '6',
    });

    const xlsx = await get(`/roster/export.xlsx?floor=${floor6}`, cookie);
    expect(xlsx.status).toBe(200);
    expect(xlsx.headers.get('content-type')).toMatch(/spreadsheetml/);
    const buffer = Buffer.from(await xlsx.arrayBuffer());
    expect(buffer.length).toBeGreaterThan(2000);

    const printed = await (await get(`/roster/print?floor=${floor6}`, cookie)).text();
    expect(printed).toMatch(/Зайцев Роман/);
    expect(printed).toMatch(/607А/);
  });

  it('сквозной цикл администратора проходит через интерфейс', async () => {
    await makeAdmin('dorm@example.org', 'dorm_admin');
    const cookie = await signIn('dorm@example.org');

    // 1. Сводка
    expect((await get('/', cookie)).status).toBe(200);

    // 2. Комнаты
    expect((await get(`/rooms?floor=${floor6}`, cookie)).status).toBe(200);

    // 3. Состав
    expect((await get(`/roster?floor=${floor6}`, cookie)).status).toBe(200);

    // 4. Проверка выполнимости
    const check = await get(`/schedule/new?floor=${floor6}&year=2026&month=9&check=1`, cookie);
    const checkText = await check.text();
    expect(checkText).toMatch(/График можно построить/);
    expect(checkText).toMatch(/Сформировать график/);

    // 5. Генерация
    const generated = await post('/schedule/generate', cookie, {
      floor_id: floor6,
      year: '2026',
      month: '9',
    });
    expect(generated.status).toBe(302);
    const scheduleId = /\/schedules\/([0-9a-f-]+)/.exec(generated.headers.get('location')!)![1]!;

    // 6. Просмотр и экспорт
    expect((await get(`/schedules/${scheduleId}`, cookie)).status).toBe(200);
    const xlsx = await get(`/schedules/${scheduleId}/export.xlsx`, cookie);
    expect(xlsx.status).toBe(200);

    // 7. Публикация с подтверждением
    const published = await post(`/schedules/${scheduleId}/publish`, cookie, {});
    expect(published.status).toBe(302);

    // 8. Дежурства: отметка и замена
    const { rows: duties } = await db.query<{ id: string; duty_date: string }>(
      'SELECT id, duty_date FROM duties WHERE schedule_id = $1 ORDER BY duty_date LIMIT 2',
      [scheduleId],
    );
    const dutiesPage = await get(
      `/duties?floor=${floor6}&date=${duties[0]!.duty_date}`,
      cookie,
    );
    expect((await dutiesPage.text())).toMatch(/Выполнено/);

    expect((await post(`/duties/${duties[0]!.id}/complete`, cookie, {})).status).toBe(302);
    expect((await post(`/duties/${duties[1]!.id}/miss`, cookie, { reason: 'не вышел' })).status)
      .toBe(302);

    // 9. Пропуски
    const violationsPage = await (await get(`/violations?floor=${floor6}`, cookie)).text();
    expect(violationsPage).toMatch(/не проверен/);

    const { rows: violations } = await db.query<{ id: string }>(
      'SELECT id FROM violations LIMIT 1',
    );
    expect(
      (await post(`/violations/${violations[0]!.id}/confirm`, cookie, { floor: floor6 })).status,
    ).toBe(302);

    const { rows: confirmed } = await db.query<{ state: string }>(
      'SELECT state FROM violations WHERE id = $1',
      [violations[0]!.id],
    );
    expect(confirmed[0]!.state).toBe('confirmed');

    // 10. Замены и настройки открываются
    expect((await get(`/changes?floor=${floor6}`, cookie)).status).toBe(200);
    expect((await get('/settings', cookie)).status).toBe(200);
    expect((await get(`/imports?floor=${floor6}`, cookie)).status).toBe(200);
  });

  it('настройки редактируют справочники без правки кода', async () => {
    await makeAdmin('dorm@example.org', 'dorm_admin');
    const cookie = await signIn('dorm@example.org');

    await post('/settings/faculties', cookie, { code: 'МСФ', name: 'Механический' });
    const { rows: faculty } = await db.query<{ code: string }>(
      `SELECT code FROM faculties WHERE code = 'МСФ'`,
    );
    expect(faculty).toHaveLength(1);

    // Время учёбы смены задаётся здесь, а не в коде.
    const { rows: shift } = await db.query<{ id: string }>(
      `SELECT id FROM study_shifts WHERE code = '1'`,
    );
    await post(`/settings/shifts/${shift[0]!.id}`, cookie, {
      busy_from: '08:30',
      busy_to: '14:00',
    });
    const { rows: updated } = await db.query<{ busy_from: string | null }>(
      'SELECT busy_from FROM study_shifts WHERE id = $1',
      [shift[0]!.id],
    );
    expect(updated[0]!.busy_from).toMatch(/^08:30/);

    // Порог пропусков и период подсчёта.
    await post('/settings/dormitory', cookie, {
      dormitory_id: seed.dormitoryId,
      violation_threshold: '5',
      reminder_hours_before: '12',
      academic_year_start_month: '8',
    });
    const { rows: settings } = await db.query<{ settings: Record<string, number> }>(
      'SELECT settings FROM dormitories WHERE id = $1',
      [seed.dormitoryId],
    );
    expect(settings[0]!.settings['violation_threshold']).toBe(5);
    expect(settings[0]!.settings['reminder_hours_before']).toBe(12);
  });

  it('вёрстка адаптивна и не едет вбок', async () => {
    await makeAdmin('dorm@example.org', 'dorm_admin');
    const cookie = await signIn('dorm@example.org');
    const text = await (await get(`/roster?floor=${floor6}`, cookie)).text();

    expect(text).toMatch(/<meta name="viewport" content="width=device-width, initial-scale=1">/);
    // Мобильная раскладка и горизонтальная прокрутка таблиц.
    expect(text).toMatch(/@media \(max-width:860px\)/);
    expect(text).toMatch(/@media \(max-width:520px\)/);
    expect(text).toMatch(/\.scroll\{overflow-x:auto/);
  });
});
