import type pg from 'pg';
import { monthName } from '../domain/calendar.js';
import { displayGroupNumber } from '../domain/facultyGroup.js';
import { expandRosterDisplayRows, isChineseFaculty } from '../domain/printLayout.js';
import { formatFeasibility } from '../domain/feasibility.js';
import {
  type Actor,
  AuthError,
  ForbiddenError,
  assertCanManageSettings,
  assertDutyAccess,
  assertFloorAccess,
  assertScheduleAccess,
  assertStudentAccess,
  login,
  logout,
  resolveScope,
} from '../services/auth/authService.js';
import {
  confirmViolation,
  excuseViolation,
  markCancelled,
  markCompleted,
  markMissed,
  substitute,
} from '../services/dutyJournalService.js';
import { RosterExportService } from '../services/export/index.js';
import { ScheduleExportService } from '../services/export/scheduleExport.js';
import { renderScheduleXlsx } from '../services/export/scheduleXlsx.js';
import { ManualImportSource, XlsxImportSource } from '../services/import/xlsxSource.js';
import { apply, preview, reject } from '../services/importService.js';
import type { NotificationService } from '../services/notifications/NotificationService.js';
import { addStudent, confirmRoster, currentRoster, relocateStudent, setStudentStatus } from '../services/rosterService.js';
import {
  InfeasibleScheduleError,
  feasibility,
  generate,
  generationHistory,
  publish,
  publishPreview,
  rosterDrift,
} from '../services/scheduleService.js';
import { type Ctx, Router, escapeHtml, file, html, json, redirect } from './http.js';
import { clearSessionCookieHeader, sessionCookieHeader } from './sessionCookie.js';
import { clientIp } from '../services/auth/loginRateLimit.js';
import { type FloorOption, floorLabel, layout, loginPage, notice, table } from './layout.js';

/**
 * Маршруты админки.
 *
 * ГЛАВНОЕ ПРАВИЛО: любой обработчик, работающий с данными этажа,
 * начинается с currentFloor() или assert*Access(). Идентификатор этажа
 * из запроса всегда сверяется с областью видимости администратора,
 * поэтому данные 6 и 7 этажей смешаться не могут ни в интерфейсе,
 * ни в запросе, ни в экспорте.
 */

export function buildRouter(deps: { notifications?: NotificationService } = {}): Router {
  const router = new Router();

  // ── Health (без авторизации) ─────────────────────────────────────
  router.get('/health', async (ctx) => {
    json(ctx.res, 200, { status: 'ok' });
  }, { auth: false });

  router.get('/health/db', async (ctx) => {
    await ctx.db.query('SELECT 1');
    json(ctx.res, 200, { status: 'ok' });
  }, { auth: false });

  // ── Вход ────────────────────────────────────────────────────────
  router.get('/login', async (ctx) => {
    html(ctx.res, 200, loginPage());
  }, { auth: false });

  router.post('/login', async (ctx) => {
    try {
      const { token } = await login(
        ctx.db,
        String(ctx.body['email'] ?? ''),
        String(ctx.body['password'] ?? ''),
        ctx.req.headers['user-agent'],
        clientIp(ctx.req),
      );
      ctx.res.writeHead(302, {
        location: '/',
        'set-cookie': sessionCookieHeader(ctx.req, token),
      });
      ctx.res.end();
    } catch (error) {
      if (error instanceof AuthError) {
        html(ctx.res, 401, loginPage(error.message));
        return;
      }
      throw error;
    }
  }, { auth: false });

  router.post('/logout', async (ctx) => {
    const cookie = ctx.req.headers.cookie ?? '';
    const token = /dorm_session=([^;]+)/.exec(cookie)?.[1];
    if (token) await logout(ctx.db, decodeURIComponent(token));
    ctx.res.writeHead(302, {
      location: '/login',
      'set-cookie': clearSessionCookieHeader(ctx.req),
    });
    ctx.res.end();
  });

  // ── 1. Сводка ───────────────────────────────────────────────────
  router.get('/', async (ctx) => {
    const { actor, floors, floor } = await context(ctx);
    if (!floor) {
      html(ctx.res, 200, layout({
        title: 'Сводка',
        actor,
        active: 'dashboard',
        floors,
        body: notice('Нет доступных этажей. Обратитесь к администратору общежития.', 'warn'),
      }));
      return;
    }

    const [roster, schedules, violations, noTelegram] = await Promise.all([
      currentRoster(ctx.db, floor.id),
      ctx.db.query<{ year: number; month: number; status: string; id: string }>(
        `SELECT id, year, month, status FROM duty_schedules
          WHERE floor_id = $1 ORDER BY year DESC, month DESC LIMIT 6`,
        [floor.id],
      ),
      ctx.db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM violations v
           JOIN students s ON s.id = v.student_id
          WHERE s.floor_id = $1 AND v.state = 'reported'`,
        [floor.id],
      ),
      ctx.db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM students
          WHERE floor_id = $1 AND status = 'active' AND telegram_id IS NULL`,
        [floor.id],
      ),
    ]);

    const active = roster?.entries.filter((e) => e.student_status_snapshot === 'active') ?? [];
    const body = `
      <div class="grid">
        ${stat(String(active.length), 'Активных студентов')}
        ${stat(roster ? `v${roster.version.version_no}` : '—', 'Версия состава')}
        ${stat(violations.rows[0]!.count, 'Непроверенных пропусков')}
        ${stat(noTelegram.rows[0]!.count, 'Без Telegram ID')}
      </div>
      <h2>Графики</h2>
      ${table(
        ['Период', 'Статус', ''],
        schedules.rows.map((s) => [
          `${escapeHtml(monthName(s.month))} ${s.year}`,
          statusPill(s.status),
          `<a href="/schedules/${s.id}?floor=${floor.id}">Открыть</a>`,
        ]),
      )}
      <p class="muted">Этаж ${escapeHtml(floorLabel(floor))} · всё ниже относится только к нему.</p>`;

    html(ctx.res, 200, layout({
      title: 'Сводка',
      actor, floors, currentFloorId: floor.id, active: 'dashboard', body,
    }));
  });

  // ── 2. Этажи ────────────────────────────────────────────────────
  router.get('/floors', async (ctx) => {
    const { actor, floors } = await context(ctx);
    const { rows } = await ctx.db.query<{
      id: string; number: number; code: string | null; title: string | null;
      is_active: boolean; dormitory: string; template: string;
      print_min_rows: number | null; print_empty_rooms: boolean;
      rooms: string; students: string;
    }>(
      `SELECT f.id, f.number, f.code, f.title, f.is_active,
              d.number AS dormitory, t.name AS template,
              f.print_min_rows, f.print_empty_rooms,
              (SELECT count(*)::text FROM rooms WHERE floor_id = f.id) AS rooms,
              (SELECT count(*)::text FROM students
                WHERE floor_id = f.id AND status = 'active') AS students
         FROM floors f
         JOIN dormitories d         ON d.id = f.dormitory_id
         JOIN duty_slot_templates t ON t.id = f.slot_template_id
        WHERE f.id = ANY($1::uuid[])
        ORDER BY d.number, f.number`,
      [floors.map((f) => f.id)],
    );

    const body = `
      ${table(
        ['Этаж', 'Общежитие', 'Шаблон смен', 'Комнат', 'Активных', 'Печать', 'Статус'],
        rows.map((f) => [
          escapeHtml(f.code ?? `${f.number} этаж`),
          `№${escapeHtml(f.dormitory)}`,
          escapeHtml(f.template),
          f.rooms,
          f.students,
          `${f.print_min_rows ?? 'по факту'} стр. · ${f.print_empty_rooms ? 'с пустыми' : 'без пустых'}`,
          f.is_active ? '<span class="pill ok">активен</span>' : '<span class="pill">выключен</span>',
        ]),
      )}
      ${actor.role === 'floor_admin' ? '' : newFloorForm()}`;

    html(ctx.res, 200, layout({ title: 'Этажи', actor, floors, active: 'floors', body }));
  });

  router.post('/floors', async (ctx) => {
    assertCanManageSettings(ctx.actor!);
    const { rows: defaults } = await ctx.db.query<{
      dormitory_id: string; slot_template_id: string; rule_set_id: string;
    }>(
      `SELECT d.id AS dormitory_id,
              (SELECT id FROM duty_slot_templates LIMIT 1) AS slot_template_id,
              (SELECT id FROM duty_rule_sets LIMIT 1) AS rule_set_id
         FROM dormitories d ORDER BY d.number LIMIT 1`,
    );
    const base = defaults[0];
    if (!base) throw new Error('Сначала создайте общежитие');

    await ctx.db.query(
      `INSERT INTO floors (dormitory_id, number, code, title, slot_template_id, rule_set_id,
                           print_min_rows, print_empty_rooms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        base.dormitory_id,
        Number(ctx.body['number']),
        emptyToNull(ctx.body['code']),
        emptyToNull(ctx.body['title']),
        base.slot_template_id,
        base.rule_set_id,
        ctx.body['print_min_rows'] ? Number(ctx.body['print_min_rows']) : null,
        ctx.body['print_empty_rooms'] === 'on',
      ],
    );
    redirect(ctx.res, '/floors');
  });

  // ── 3. Комнаты и блоки ──────────────────────────────────────────
  router.get('/rooms', async (ctx) => {
    const { actor, floors, floor } = await context(ctx);
    if (!floor) return noFloor(ctx, actor, floors, 'rooms', 'Комнаты и блоки');

    const { rows } = await ctx.db.query<{
      id: string; number: string; block_code: string | null;
      occupants: string; print_min_rows: number | null; is_active: boolean;
    }>(
      `SELECT r.id, r.number, b.code AS block_code,
              (SELECT count(*)::text FROM students s
                WHERE s.room_id = r.id AND s.status <> 'moved_out') AS occupants,
              r.print_min_rows, r.is_active
         FROM rooms r
         LEFT JOIN blocks b ON b.id = r.block_id
        WHERE r.floor_id = $1
        ORDER BY b.sort_order NULLS FIRST, r.sort_order, r.number`,
      [floor.id],
    );

    const { rows: blocks } = await ctx.db.query<{ id: string; code: string; rooms: string }>(
      `SELECT b.id, b.code,
              (SELECT count(*)::text FROM rooms WHERE block_id = b.id) AS rooms
         FROM blocks b WHERE b.floor_id = $1 ORDER BY b.sort_order, b.code`,
      [floor.id],
    );

    const body = `
      ${notice(
        'Число жильцов — это факт заселения, а не вместимость комнаты. ' +
          'Комнату и блок можно создать заранее и оставить пустыми.',
      )}
      <h2>Комнаты</h2>
      ${table(
        ['Комната', 'Блок', 'Жильцов', 'Строк в бланке', 'Статус'],
        rows.map((r) => [
          escapeHtml(r.number),
          r.block_code ? escapeHtml(r.block_code) : '<span class="muted">без блока</span>',
          r.occupants === '0' ? '<span class="muted">0</span>' : r.occupants,
          r.print_min_rows === null ? '<span class="muted">по факту</span>' : String(r.print_min_rows),
          r.is_active ? '<span class="pill ok">активна</span>' : '<span class="pill">выключена</span>',
        ]),
      )}
      <h2>Блоки</h2>
      ${table(
        ['Блок', 'Комнат'],
        blocks.map((b) => [escapeHtml(b.code), b.rooms]),
      )}
      ${roomForms(floor.id, blocks)}`;

    html(ctx.res, 200, layout({
      title: 'Комнаты и блоки', actor, floors, currentFloorId: floor.id, active: 'rooms', body,
    }));
  });

  router.post('/rooms', async (ctx) => {
    const floorId = String(ctx.body['floor_id']);
    await assertFloorAccess(ctx.db, ctx.actor!, floorId);

    const from = String(ctx.body['from'] ?? '').trim();
    const to = String(ctx.body['to'] ?? '').trim();
    const blockId = emptyToNull(ctx.body['block_id']);

    const numbers = from && to && /^\d+$/.test(from) && /^\d+$/.test(to)
      ? rangeNumbers(Number(from), Number(to))
      : [from];

    for (const [index, number] of numbers.entries()) {
      if (!number) continue;
      await ctx.db.query(
        `INSERT INTO rooms (floor_id, block_id, number, sort_order)
         VALUES ($1,$2,$3,(SELECT COALESCE(max(sort_order),0)+1+$4 FROM rooms WHERE floor_id=$1))
         ON CONFLICT (floor_id, number) DO NOTHING`,
        [floorId, blockId, number, index],
      );
    }
    redirect(ctx.res, `/rooms?floor=${floorId}`);
  });

  router.post('/blocks', async (ctx) => {
    const floorId = String(ctx.body['floor_id']);
    await assertFloorAccess(ctx.db, ctx.actor!, floorId);

    const code = String(ctx.body['code'] ?? '').trim();
    const sections = String(ctx.body['sections'] ?? '')
      .split(',').map((s) => s.trim()).filter(Boolean);

    const { rows } = await ctx.db.query<{ id: string }>(
      `INSERT INTO blocks (floor_id, code, sort_order)
       VALUES ($1,$2,(SELECT COALESCE(max(sort_order),0)+1 FROM blocks WHERE floor_id=$1))
       ON CONFLICT (floor_id, code) DO UPDATE SET code = EXCLUDED.code
       RETURNING id`,
      [floorId, code],
    );
    // Блок можно создать и без секций — он останется пустым, это нормально.
    for (const [index, suffix] of sections.entries()) {
      await ctx.db.query(
        `INSERT INTO rooms (floor_id, block_id, number, sort_order)
         VALUES ($1,$2,$3,(SELECT COALESCE(max(sort_order),0)+1+$4 FROM rooms WHERE floor_id=$1))
         ON CONFLICT (floor_id, number) DO NOTHING`,
        [floorId, rows[0]!.id, `${code}${suffix}`, index],
      );
    }
    redirect(ctx.res, `/rooms?floor=${floorId}`);
  });

  // ── 4. Состав этажа ─────────────────────────────────────────────
  router.get('/roster', async (ctx) => {
    const { actor, floors, floor } = await context(ctx);
    if (!floor) return noFloor(ctx, actor, floors, 'roster', 'Состав этажа');

    const filters = {
      faculty: ctx.query.get('faculty') ?? '',
      block: ctx.query.get('block') ?? '',
      course: ctx.query.get('course') ?? '',
      shift: ctx.query.get('shift') ?? '',
      q: ctx.query.get('q') ?? '',
    };
    const hasPersonFilter = Boolean(
      filters.faculty || filters.course || filters.shift || filters.q,
    );
    const PAGE_SIZE = 25;
    const page = Math.max(1, Number(ctx.query.get('page') ?? '1') || 1);

    const filterParams = [
      floor.id,
      filters.faculty,
      filters.block,
      filters.course,
      filters.shift,
      filters.q,
    ] as const;

    const roster = await currentRoster(ctx.db, floor.id);
    const exportService = new RosterExportService(ctx.db);
    const floorRoster = await exportService.loadCurrent(floor.id);

    let tableHeaders = [
      'Комната',
      'Блок',
      'ФИО',
      'Телефон',
      'Telegram',
      'Факультет',
      'Курс',
      'Группа',
      'Смена',
      'Статус',
      '',
    ];
    let tableRows: string[][] = [];
    let tableRowClasses: string[] = [];
    let total = 0;
    let pagination = '';

    if (!hasPersonFilter) {
      const expanded = expandRosterDisplayRows(floorRoster).filter(
        (row) => !filters.block || row.room.blockCode === filters.block,
      );
      total = floorRoster.rooms.reduce((n, room) => n + room.people.length, 0);

      for (const row of expanded) {
        const trClass = [
          row.isPlaceholder ? 'placeholder' : '',
          row.isRoomStart ? 'room-start' : '',
        ]
          .filter(Boolean)
          .join(' ');

        if (row.isPlaceholder) {
          tableRows.push([
            row.isRoomStart ? escapeHtml(row.room.number) : '',
            row.isRoomStart
              ? row.room.blockCode
                ? escapeHtml(row.room.blockCode)
                : '<span class="muted">—</span>'
              : '',
            '<span class="muted">свободно</span>',
            '<span class="muted">—</span>',
            '<span class="muted">—</span>',
            '<span class="muted">—</span>',
            '<span class="muted">—</span>',
            '<span class="muted">—</span>',
            '<span class="muted">—</span>',
            '<span class="muted">—</span>',
            '',
          ]);
        } else {
          const p = row.person!;
          tableRows.push([
            row.isRoomStart ? escapeHtml(row.room.number) : '',
            row.isRoomStart
              ? row.room.blockCode
                ? escapeHtml(row.room.blockCode)
                : '<span class="muted">—</span>'
              : '',
            escapeHtml(p.displayName),
            p.phone ? escapeHtml(p.phone) : '<span class="pill warn">нет</span>',
            p.telegramId
              ? `<span class="pill ok">привязан</span>`
              : `<span class="pill warn">нет ID</span>`,
            escapeHtml(p.facultyCode ?? '—'),
            isChineseFaculty(p.facultyCode) || p.course === null
              ? '<span class="muted">—</span>'
              : String(p.course),
            isChineseFaculty(p.facultyCode)
              ? '<span class="muted">—</span>'
              : escapeHtml(displayGroupNumber(p.groupCode)),
            escapeHtml(p.studyShiftCode ?? '—'),
            p.status === 'active'
              ? '<span class="pill ok">активен</span>'
              : '<span class="pill warn">приостановлен</span>',
            studentActions(p.studentId, floor.id),
          ]);
        }
        tableRowClasses.push(trClass);
      }
    } else {
      const { rows: countRows } = await ctx.db.query<{ n: string }>(
        `SELECT count(*)::text AS n
           FROM students s
           JOIN rooms r ON r.id = s.room_id
           LEFT JOIN blocks b        ON b.id = r.block_id
           LEFT JOIN faculties f     ON f.id = s.faculty_id
           LEFT JOIN study_shifts sh ON sh.id = s.study_shift_id
          WHERE s.floor_id = $1
            AND s.status <> 'moved_out'
            AND ($2 = '' OR f.code = $2)
            AND ($3 = '' OR b.code = $3)
            AND ($4 = '' OR s.course::text = $4)
            AND ($5 = '' OR sh.code = $5)
            AND ($6 = '' OR s.last_name ILIKE '%' || $6 || '%')`,
        [...filterParams],
      );
      total = Number(countRows[0]?.n ?? 0);
      const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
      const safePage = Math.min(page, totalPages);
      const offset = (safePage - 1) * PAGE_SIZE;

      const { rows } = await ctx.db.query<{
        id: string;
        full_name: string;
        room: string;
        block_code: string | null;
        faculty: string | null;
        course: number | null;
        group_code: string | null;
        shift: string | null;
        status: string;
        telegram_id: string | null;
        phone: string | null;
      }>(
        `SELECT s.id,
                trim(concat_ws(' ', s.last_name, s.first_name, s.middle_name)) AS full_name,
                r.number AS room, b.code AS block_code, f.code AS faculty,
                s.course, s.group_code, sh.code AS shift, s.status, s.telegram_id,
                s.phone
           FROM students s
           JOIN rooms r ON r.id = s.room_id
           LEFT JOIN blocks b        ON b.id = r.block_id
           LEFT JOIN faculties f     ON f.id = s.faculty_id
           LEFT JOIN study_shifts sh ON sh.id = s.study_shift_id
          WHERE s.floor_id = $1
            AND s.status <> 'moved_out'
            AND ($2 = '' OR f.code = $2)
            AND ($3 = '' OR b.code = $3)
            AND ($4 = '' OR s.course::text = $4)
            AND ($5 = '' OR sh.code = $5)
            AND ($6 = '' OR s.last_name ILIKE '%' || $6 || '%')
          ORDER BY b.sort_order NULLS FIRST, r.sort_order, r.number, s.sort_order, s.last_name
          LIMIT $7 OFFSET $8`,
        [...filterParams, PAGE_SIZE, offset],
      );

      tableRows = rows.map((s) => [
        escapeHtml(s.room),
        s.block_code ? escapeHtml(s.block_code) : '<span class="muted">—</span>',
        escapeHtml(s.full_name),
        s.phone ? escapeHtml(s.phone) : '<span class="pill warn">нет</span>',
        s.telegram_id
          ? `<span class="pill ok">привязан</span>`
          : `<span class="pill warn">нет ID</span>`,
        escapeHtml(s.faculty ?? '—'),
        isChineseFaculty(s.faculty) || s.course === null
          ? '<span class="muted">—</span>'
          : String(s.course),
        isChineseFaculty(s.faculty)
          ? '<span class="muted">—</span>'
          : escapeHtml(displayGroupNumber(s.group_code)),
        escapeHtml(s.shift ?? '—'),
        s.status === 'active'
          ? '<span class="pill ok">активен</span>'
          : '<span class="pill warn">приостановлен</span>',
        studentActions(s.id, floor.id),
      ]);

      const filterQs = [
        `floor=${floor.id}`,
        filters.faculty ? `faculty=${encodeURIComponent(filters.faculty)}` : '',
        filters.block ? `block=${encodeURIComponent(filters.block)}` : '',
        filters.course ? `course=${encodeURIComponent(filters.course)}` : '',
        filters.shift ? `shift=${encodeURIComponent(filters.shift)}` : '',
        filters.q ? `q=${encodeURIComponent(filters.q)}` : '',
      ]
        .filter(Boolean)
        .join('&');

      pagination =
        total === 0
          ? ''
          : `<nav class="pagination" aria-label="Страницы">
          <span class="muted">${total} чел. · стр. ${safePage} из ${totalPages}</span>
          <span class="pagination-links">
            ${
              safePage > 1
                ? `<a href="/roster?${filterQs}&page=${safePage - 1}"><button type="button">← Назад</button></a>`
                : `<button type="button" disabled>← Назад</button>`
            }
            ${
              safePage < totalPages
                ? `<a href="/roster?${filterQs}&page=${safePage + 1}"><button type="button">Вперёд →</button></a>`
                : `<button type="button" disabled>Вперёд →</button>`
            }
          </span>
        </nav>`;
    }

    const roomCount = Number(
      (
        await ctx.db.query<{ n: string }>(
          'SELECT count(*)::text AS n FROM rooms WHERE floor_id = $1 AND is_active',
          [floor.id],
        )
      ).rows[0]?.n ?? 0,
    );
    const [faculties, blocks, shifts] = await Promise.all([
      ctx.db.query<{ code: string }>('SELECT code FROM faculties WHERE is_active ORDER BY sort_order'),
      ctx.db.query<{ code: string }>('SELECT code FROM blocks WHERE floor_id = $1 ORDER BY sort_order', [floor.id]),
      ctx.db.query<{ code: string }>('SELECT code FROM study_shifts WHERE is_active ORDER BY sort_order'),
    ]);

    const slotsNote = !hasPersonFilter
      ? notice(
          `${total} чел. · комнаты А — до 3 мест, Б — до 2; пустые строки для ручного ввода`,
        )
      : '';

    const body = `
      ${roster
        ? notice(
            `Актуальный состав: версия ${roster.version.version_no} от ${roster.version.effective_from} · ` +
              `${roster.entries.length} чел.`,
          )
        : `<div class="card">
             ${notice('Состав ещё не подтверждён. Можно подтвердить пустой этаж и сразу экспортировать бланк.', 'warn')}
             <form method="post" action="/roster/confirm" class="row" style="margin-top:12px">
               <input type="hidden" name="floor_id" value="${floor.id}">
               <button type="submit" class="primary">Подтвердить состав</button>
             </form>
           </div>`}

      ${roomCount === 0
        ? notice('На этаже нет комнат — сначала создайте структуру на вкладке «Комнаты и блоки».', 'warn')
        : ''}

      <form method="get" class="row">
        <input type="hidden" name="floor" value="${floor.id}">
        ${select('faculty', 'Факультет', faculties.rows.map((f) => f.code), filters.faculty)}
        ${select('block', 'Блок', blocks.rows.map((b) => b.code), filters.block)}
        ${select('shift', 'Смена', shifts.rows.map((s) => s.code), filters.shift)}
        <label>Курс<input name="course" value="${escapeHtml(filters.course)}" size="4"></label>
        <label>Фамилия<input name="q" value="${escapeHtml(filters.q)}"></label>
        <button type="submit">Фильтр</button>
        <a href="/roster?floor=${floor.id}"><button type="button">Сброс</button></a>
      </form>

      <div class="row">
        ${roomCount > 0
          ? `<a href="/roster/export.pdf?floor=${floor.id}"><button type="button">Скачать PDF</button></a>
        <a href="/roster/export.xlsx?floor=${floor.id}"><button type="button">Скачать XLSX</button></a>
        <a href="/roster/export.xlsx?floor=${floor.id}&contacts=1"><button type="button">XLSX с телефоном и ID</button></a>
        <a href="/roster/print?floor=${floor.id}" target="_blank"><button type="button">Печать</button></a>`
          : '<span class="muted">Экспорт доступен после создания комнат</span>'}
      </div>

      ${slotsNote}
      ${pagination}
      ${table(tableHeaders, tableRows, tableRowClasses)}
      ${pagination}
      ${addStudentForm(floor.id, faculties.rows.map((f) => f.code), shifts.rows.map((s) => s.code))}`;

    html(ctx.res, 200, layout({
      title: `Состав этажа · ${floorLabel(floor)}`,
      actor, floors, currentFloorId: floor.id, active: 'roster', body,
    }));
  });

  router.post('/roster/confirm', async (ctx) => {
    const floorId = String(ctx.body['floor_id']);
    await assertFloorAccess(ctx.db, ctx.actor!, floorId);
    await confirmRoster(ctx.db, floorId, ctx.actor!.adminId);
    redirect(ctx.res, `/roster?floor=${floorId}`);
  });

  router.post('/roster/students', async (ctx) => {
    const floorId = String(ctx.body['floor_id']);
    await assertFloorAccess(ctx.db, ctx.actor!, floorId);

    const { rows: room } = await ctx.db.query<{ id: string }>(
      'SELECT id FROM rooms WHERE floor_id = $1 AND number = $2',
      [floorId, String(ctx.body['room'] ?? '').trim()],
    );
    if (!room[0]) throw new Error('Комната не найдена на этом этаже');

    const facultyId = await lookupId(ctx.db, 'faculties', ctx.body['faculty']);
    const shiftId = await lookupId(ctx.db, 'study_shifts', ctx.body['shift']);

    await addStudent(ctx.db, {
      floorId,
      roomId: room[0].id,
      lastName: String(ctx.body['last_name'] ?? '').trim(),
      firstName: String(ctx.body['first_name'] ?? '').trim(),
      middleName: emptyToNull(ctx.body['middle_name']),
      facultyId,
      studyShiftId: shiftId,
      course: ctx.body['course'] ? Number(ctx.body['course']) : null,
      groupCode: emptyToNull(ctx.body['group_code']),
      telegramId: emptyToNull(ctx.body['telegram_id']),
      phone: emptyToNull(ctx.body['phone']),
    }, ctx.actor!.adminId);

    redirect(ctx.res, `/roster?floor=${floorId}`);
  });

  router.post('/roster/students/:id/telegram', async (ctx) => {
    const floorId = await assertStudentAccess(ctx.db, ctx.actor!, ctx.params['id']!);
    // Telegram ID заводит администратор — студент себе его не выбирает.
    await ctx.db.query('UPDATE students SET telegram_id = $2 WHERE id = $1', [
      ctx.params['id'],
      emptyToNull(ctx.body['telegram_id']),
    ]);
    redirect(ctx.res, `/roster?floor=${floorId}`);
  });

  router.post('/roster/students/:id/relocate', async (ctx) => {
    const floorId = await assertStudentAccess(ctx.db, ctx.actor!, ctx.params['id']!);
    const { rows } = await ctx.db.query<{ id: string }>(
      'SELECT id FROM rooms WHERE floor_id = $1 AND number = $2',
      [floorId, String(ctx.body['room'] ?? '').trim()],
    );
    if (!rows[0]) throw new Error('Комната не найдена на этом этаже');
    await relocateStudent(ctx.db, ctx.params['id']!, rows[0].id, ctx.actor!.adminId);
    redirect(ctx.res, `/roster?floor=${floorId}`);
  });

  router.post('/roster/students/:id/status', async (ctx) => {
    const floorId = await assertStudentAccess(ctx.db, ctx.actor!, ctx.params['id']!);
    const status = String(ctx.body['status']) as 'active' | 'suspended' | 'moved_out';
    await setStudentStatus(ctx.db, ctx.params['id']!, status, ctx.actor!.adminId);
    redirect(ctx.res, `/roster?floor=${floorId}`);
  });

  // ── Экспорт списка ──────────────────────────────────────────────
  router.get('/roster/export.pdf', async (ctx) => {
    const floor = await requireFloor(ctx);
    const service = new RosterExportService(ctx.db);
    const roster = await service.loadCurrent(floor.id);
    const options = { academicYear: ctx.query.get('year') ?? '' };
    try {
      const pdf = await service.pdf(roster, options);
      file(ctx.res, pdf, 'application/pdf', `Список_${floorLabel(floor)}.pdf`);
    } catch (error) {
      throw new Error(
        error instanceof Error && error.message.includes('PDF')
          ? error.message
          : 'Не удалось создать PDF. Скачайте XLSX или откройте печатную версию.',
      );
    }
  });

  router.get('/roster/export.xlsx', async (ctx) => {
    const floor = await requireFloor(ctx);
    const service = new RosterExportService(ctx.db);
    const roster = await service.loadCurrent(floor.id);
    const contacts = ctx.query.get('contacts') === '1';
    const xlsx = contacts
      ? await service.xlsxContacts(roster)
      : await service.xlsx(roster, { academicYear: ctx.query.get('year') ?? '' });
    const suffix = contacts ? '_контакты' : '';
    file(
      ctx.res,
      xlsx,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      `Список_${floorLabel(floor)}${suffix}.xlsx`,
    );
  });

  router.get('/roster/print', async (ctx) => {
    const floor = await requireFloor(ctx);
    const service = new RosterExportService(ctx.db);
    const roster = await service.loadCurrent(floor.id);
    html(ctx.res, 200, await service.html(roster, { academicYear: ctx.query.get('year') ?? '' }));
  });

  // ── 5. Импорт списка ────────────────────────────────────────────
  router.get('/import', async (ctx) => {
    const { actor, floors, floor } = await context(ctx);
    if (!floor) return noFloor(ctx, actor, floors, 'import', 'Импорт списка');

    const importId = ctx.query.get('preview');
    let previewBlock = '';
    if (importId) previewBlock = await renderImportPreview(ctx.db, importId, floor.id);

    const body = `
      ${notice('До нажатия «Применить» в системе не меняется ничего.')}
      <form method="post" action="/import" enctype="multipart/form-data" class="card">
        <input type="hidden" name="floor_id" value="${floor.id}">
        <label>Файл XLSX со списком этажа
          <input type="file" name="file" accept=".xlsx" required></label>
        <button type="submit" class="primary">Загрузить и сравнить</button>
      </form>
      ${previewBlock}`;

    html(ctx.res, 200, layout({
      title: `Импорт списка · ${floorLabel(floor)}`,
      actor, floors, currentFloorId: floor.id, active: 'import', body,
    }));
  });

  router.post('/import/:id/apply', async (ctx) => {
    const { rows } = await ctx.db.query<{ floor_id: string }>(
      'SELECT floor_id FROM roster_imports WHERE id = $1',
      [ctx.params['id']],
    );
    if (!rows[0]) throw new Error('Импорт не найден');
    await assertFloorAccess(ctx.db, ctx.actor!, rows[0].floor_id);

    const decisions = JSON.parse(String(ctx.body['decisions'] ?? '{}')) as Record<string, unknown>;
    const result = await apply(ctx.db, ctx.params['id']!, {
      decisions: decisions as never,
      appliedBy: ctx.actor!.adminId,
    });
    redirect(ctx.res, `/roster?floor=${rows[0].floor_id}&applied=${result.rosterVersionCreated ? 1 : 0}`);
  });

  router.post('/import/:id/reject', async (ctx) => {
    const { rows } = await ctx.db.query<{ floor_id: string }>(
      'SELECT floor_id FROM roster_imports WHERE id = $1',
      [ctx.params['id']],
    );
    if (!rows[0]) throw new Error('Импорт не найден');
    await assertFloorAccess(ctx.db, ctx.actor!, rows[0].floor_id);
    await reject(ctx.db, ctx.params['id']!, ctx.actor!.adminId);
    redirect(ctx.res, `/imports?floor=${rows[0].floor_id}`);
  });

  // ── 6. История импортов ─────────────────────────────────────────
  router.get('/imports', async (ctx) => {
    const { actor, floors, floor } = await context(ctx);
    if (!floor) return noFloor(ctx, actor, floors, 'imports', 'История импортов');

    const { rows } = await ctx.db.query<{
      id: string; file_name: string; state: string; uploaded_at: string;
      version_no: number | null;
    }>(
      `SELECT i.id, i.file_name, i.state, i.uploaded_at, rv.version_no
         FROM roster_imports i
         LEFT JOIN roster_versions rv ON rv.id = i.created_roster_version_id
        WHERE i.floor_id = $1 ORDER BY i.uploaded_at DESC LIMIT 50`,
      [floor.id],
    );

    const { rows: versions } = await ctx.db.query<{
      version_no: number; status: string; source: string; effective_from: string; entries: string;
    }>(
      `SELECT rv.version_no, rv.status, rv.source, rv.effective_from,
              (SELECT count(*)::text FROM roster_entries WHERE roster_version_id = rv.id) AS entries
         FROM roster_versions rv WHERE rv.floor_id = $1
        ORDER BY rv.version_no DESC`,
      [floor.id],
    );

    const body = `
      <h2>Импорты</h2>
      ${table(
        ['Файл', 'Состояние', 'Загружен', 'Версия состава'],
        rows.map((i) => [
          escapeHtml(i.file_name),
          escapeHtml(i.state),
          escapeHtml(String(i.uploaded_at).slice(0, 16).replace('T', ' ')),
          i.version_no === null ? '<span class="muted">состав не изменился</span>' : `v${i.version_no}`,
        ]),
      )}
      <h2>Версии состава</h2>
      ${table(
        ['Версия', 'Статус', 'Источник', 'Действует с', 'Человек'],
        versions.map((v) => [
          `v${v.version_no}`,
          v.status === 'confirmed' ? '<span class="pill ok">актуальная</span>' : '<span class="pill">архив</span>',
          escapeHtml(v.source),
          escapeHtml(v.effective_from),
          v.entries,
        ]),
      )}`;

    html(ctx.res, 200, layout({
      title: `История импортов · ${floorLabel(floor)}`,
      actor, floors, currentFloorId: floor.id, active: 'imports', body,
    }));
  });

  // ── 7. Генерация графика ────────────────────────────────────────
  router.get('/schedule/new', async (ctx) => {
    const { actor, floors, floor } = await context(ctx);
    if (!floor) return noFloor(ctx, actor, floors, 'generate', 'Генерация графика');

    const now = new Date();
    const year = Number(ctx.query.get('year') ?? now.getFullYear());
    const month = Number(ctx.query.get('month') ?? now.getMonth() + 1);

    let report = '';
    if (ctx.query.get('check')) {
      try {
        const result = await feasibility(ctx.db, { floorId: floor.id, year, month });
        report = `<div class="card"><pre class="mono">${escapeHtml(formatFeasibility(result))}</pre>
          ${
            result.feasible
              ? `<form method="post" action="/schedule/generate">
                   <input type="hidden" name="floor_id" value="${floor.id}">
                   <input type="hidden" name="year" value="${year}">
                   <input type="hidden" name="month" value="${month}">
                   <button type="submit" class="primary">Сформировать график</button>
                 </form>`
              : notice('Генерация невозможна — устраните причину выше.', 'error')
          }</div>`;
      } catch (error) {
        report = notice((error as Error).message, 'error');
      }
    }

    const body = `
      <div class="card" id="schedulePeriod">
        <div class="row">
          <label>Год<input id="schYear" name="year" type="number" value="${year}" required></label>
          <label>Месяц
            <select id="schMonth" name="month">
              ${Array.from({ length: 12 }, (_, i) =>
                `<option value="${i + 1}"${i + 1 === month ? ' selected' : ''}>${monthName(i + 1)}</option>`,
              ).join('')}
            </select>
          </label>
          <a id="schCheck" href="/schedule/new?floor=${floor.id}&year=${year}&month=${month}&check=1">
            <button type="button">Проверить выполнимость</button>
          </a>
        </div>
        <h2>Пустой бланк на месяц</h2>
        <p class="muted">Даты и смены из шаблона. XLSX скачивается сразу. PDF — через печать браузера (Сохранить как PDF), без ожидания на сервере.</p>
        <div class="row">
          <a id="schXlsx" href="/schedule/blank.xlsx?floor=${floor.id}&year=${year}&month=${month}">
            <button type="button" class="primary">Скачать XLSX</button>
          </a>
          <a id="schPdf" href="/schedule/blank/print?floor=${floor.id}&year=${year}&month=${month}&autoprint=1" target="_blank">
            <button type="button">Скачать PDF</button>
          </a>
          <a id="schPrint" href="/schedule/blank/print?floor=${floor.id}&year=${year}&month=${month}" target="_blank">
            <button type="button">Печать</button>
          </a>
        </div>
      </div>
      <script>
      (function () {
        var floor = ${JSON.stringify(floor.id)};
        var year = document.getElementById('schYear');
        var month = document.getElementById('schMonth');
        function qs() {
          return 'floor=' + encodeURIComponent(floor)
            + '&year=' + encodeURIComponent(year.value)
            + '&month=' + encodeURIComponent(month.value);
        }
        function sync() {
          document.getElementById('schCheck').href = '/schedule/new?' + qs() + '&check=1';
          document.getElementById('schXlsx').href = '/schedule/blank.xlsx?' + qs();
          document.getElementById('schPdf').href = '/schedule/blank/print?' + qs() + '&autoprint=1';
          document.getElementById('schPrint').href = '/schedule/blank/print?' + qs();
        }
        year.addEventListener('change', sync);
        year.addEventListener('input', sync);
        month.addEventListener('change', sync);
        sync();
      })();
      </script>
      ${report}`;

    html(ctx.res, 200, layout({
      title: `Генерация графика · ${floorLabel(floor)}`,
      actor, floors, currentFloorId: floor.id, active: 'generate', body,
    }));
  });

  router.get('/schedule/blank.xlsx', async (ctx) => {
    const floor = await requireFloor(ctx);
    const year = Number(ctx.query.get('year'));
    const month = Number(ctx.query.get('month'));
    const service = new ScheduleExportService(ctx.db);
    const doc = await service.loadBlank(floor.id, year, month);
    const xlsx = await renderScheduleXlsx(doc);
    file(
      ctx.res,
      xlsx,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      `${doc.fileBaseName}_бланк.xlsx`,
    );
  });

  router.get('/schedule/blank.pdf', async (ctx) => {
    // Серверный Chromium для бланка долгий и нестабилен — сразу на печать с авто-диалогом.
    const floor = await requireFloor(ctx);
    const year = encodeURIComponent(String(ctx.query.get('year') ?? ''));
    const month = encodeURIComponent(String(ctx.query.get('month') ?? ''));
    redirect(
      ctx.res,
      `/schedule/blank/print?floor=${floor.id}&year=${year}&month=${month}&autoprint=1`,
    );
  });

  router.get('/schedule/blank/print', async (ctx) => {
    const floor = await requireFloor(ctx);
    const year = Number(ctx.query.get('year'));
    const month = Number(ctx.query.get('month'));
    const service = new ScheduleExportService(ctx.db);
    let markup = await service.blankHtml(floor.id, year, month);
    if (ctx.query.get('autoprint') === '1') {
      markup = markup.replace(
        '</body>',
        `<script>
document.title = document.title || 'График';
window.addEventListener('load', function () {
  setTimeout(function () { window.print(); }, 250);
});
</script></body>`,
      );
    }
    html(ctx.res, 200, markup);
  });

  router.post('/schedule/generate', async (ctx) => {
    const floorId = String(ctx.body['floor_id']);
    await assertFloorAccess(ctx.db, ctx.actor!, floorId);
    try {
      const result = await generate(ctx.db, {
        floorId,
        year: Number(ctx.body['year']),
        month: Number(ctx.body['month']),
        createdBy: ctx.actor!.adminId,
      });
      redirect(ctx.res, `/schedules/${result.scheduleId}?floor=${floorId}`);
    } catch (error) {
      if (error instanceof InfeasibleScheduleError) {
        throw new Error(formatFeasibility(error.report));
      }
      throw error;
    }
  });

  // ── 8. Просмотр графика ─────────────────────────────────────────
  router.get('/schedules', async (ctx) => {
    const { actor, floors, floor } = await context(ctx);
    if (!floor) return noFloor(ctx, actor, floors, 'schedules', 'Графики');

    const { rows } = await ctx.db.query<{
      id: string; year: number; month: number; status: string;
      duties: string; assigned: string;
    }>(
      `SELECT s.id, s.year, s.month, s.status,
              (SELECT count(*)::text FROM duties WHERE schedule_id = s.id) AS duties,
              (SELECT count(*)::text FROM duties
                WHERE schedule_id = s.id AND student_id IS NOT NULL) AS assigned
         FROM duty_schedules s WHERE s.floor_id = $1
        ORDER BY s.year DESC, s.month DESC`,
      [floor.id],
    );

    const body = table(
      ['Период', 'Статус', 'Дежурств', 'Назначено', ''],
      rows.map((s) => [
        `${escapeHtml(monthName(s.month))} ${s.year}`,
        statusPill(s.status),
        s.duties,
        s.assigned,
        `<a href="/schedules/${s.id}?floor=${floor.id}">Открыть</a>`,
      ]),
    );

    html(ctx.res, 200, layout({
      title: `Графики · ${floorLabel(floor)}`,
      actor, floors, currentFloorId: floor.id, active: 'schedules', body,
    }));
  });

  router.get('/schedules/:id', async (ctx) => {
    const floorId = await assertScheduleAccess(ctx.db, ctx.actor!, ctx.params['id']!);
    const { actor, floors, floor } = await context(ctx, floorId);

    const scheduleId = ctx.params['id']!;
    const [previewData, drift, history, duties] = await Promise.all([
      publishPreview(ctx.db, scheduleId),
      rosterDrift(ctx.db, scheduleId),
      generationHistory(ctx.db, scheduleId),
      ctx.db.query<{
        duty_date: string; slot_order: number; time_from: string; time_to: string;
        student_name_snapshot: string | null; room_number_snapshot: string | null; status: string;
      }>(
        `SELECT duty_date, slot_order, time_from, time_to,
                student_name_snapshot, room_number_snapshot, status
           FROM duties WHERE schedule_id = $1 ORDER BY duty_date, slot_order`,
        [scheduleId],
      ),
    ]);

    const byDate = new Map<string, typeof duties.rows>();
    for (const duty of duties.rows) {
      byDate.set(duty.duty_date, [...(byDate.get(duty.duty_date) ?? []), duty]);
    }

    const gridRows = [...byDate.entries()].map(([date, list]) => [
      `<span class="mono">${escapeHtml(date.slice(8))}.${escapeHtml(date.slice(5, 7))}</span>`,
      ...list.map(
        (d) =>
          `<span class="mono muted">${escapeHtml(d.time_from.slice(0, 5))}</span> ` +
          `${escapeHtml(d.student_name_snapshot ?? '—')}` +
          (d.room_number_snapshot ? ` <span class="muted">${escapeHtml(d.room_number_snapshot)}</span>` : ''),
      ),
    ]);
    const maxSlots = Math.max(...[...byDate.values()].map((l) => l.length), 0);

    const body = `
      ${drift.drifted ? notice(drift.message!, 'warn') : ''}
      <div class="grid">
        ${stat(String(previewData.duties), 'Дежурств')}
        ${stat(String(previewData.students), 'Студентов')}
        ${stat(String(previewData.unassigned), 'Не назначено')}
        ${stat(`v${previewData.rosterVersionNo}`, 'Версия состава')}
      </div>

      <div class="row">
        <a href="/schedules/${scheduleId}/export.pdf"><button type="button">Скачать PDF</button></a>
        <a href="/schedules/${scheduleId}/export.xlsx"><button type="button">Скачать XLSX</button></a>
        <a href="/schedules/${scheduleId}/print" target="_blank"><button type="button">Печать</button></a>
      </div>

      ${
        previewData.blockers.length === 0
          ? publishForm(scheduleId, previewData, false)
          : `<div class="card">
               <h2>Публикация недоступна</h2>
               ${previewData.blockers.map((b) => notice(b, 'warn')).join('')}
               ${
                 // Устаревший состав — единственная причина, которую
                 // администратор может осознанно принять на себя.
                 previewData.rosterDrifted && previewData.unassigned === 0
                   ? publishForm(scheduleId, previewData, true)
                   : ''
               }
             </div>`
      }

      <h2>График</h2>
      ${table(
        ['Дата', ...Array.from({ length: maxSlots }, (_, i) => `Смена ${i + 1}`)],
        gridRows,
      )}

      <h2>История генераций</h2>
      ${table(
        ['Прогон', 'Алгоритм', 'Актуальный', 'Создан'],
        history.map((h) => [
          `#${h.attemptNo}`,
          `<span class="mono">${escapeHtml(h.algorithm)}</span>`,
          h.isCurrent ? '<span class="pill ok">да</span>' : '',
          escapeHtml(String(h.createdAt).slice(0, 16).replace('T', ' ')),
        ]),
      )}`;

    html(ctx.res, 200, layout({
      title: `${monthName(previewData.month)} ${previewData.year} · ${floorLabel(floor!)}`,
      actor, floors, currentFloorId: floorId, active: 'schedules', body,
    }));
  });

  router.post('/schedules/:id/publish', async (ctx) => {
    const floorId = await assertScheduleAccess(ctx.db, ctx.actor!, ctx.params['id']!);
    await publish(ctx.db, ctx.params['id']!, ctx.actor!.adminId, {
      acknowledgeRosterDrift: ctx.body['acknowledge_drift'] === 'on',
    });
    if (deps.notifications) await deps.notifications.schedulePublished(ctx.params['id']!);
    redirect(ctx.res, `/schedules/${ctx.params['id']}?floor=${floorId}&published=1`);
  });

  router.get('/schedules/:id/export.pdf', async (ctx) => {
    await assertScheduleAccess(ctx.db, ctx.actor!, ctx.params['id']!);
    const service = new ScheduleExportService(ctx.db);
    try {
      const pdf = await service.pdf(ctx.params['id']!);
      const doc = await service.load(ctx.params['id']!);
      file(ctx.res, pdf, 'application/pdf', `${doc.fileBaseName}.pdf`);
    } catch {
      throw new Error('Не удалось создать PDF. Скачайте XLSX или откройте печатную версию.');
    }
  });

  router.get('/schedules/:id/export.xlsx', async (ctx) => {
    await assertScheduleAccess(ctx.db, ctx.actor!, ctx.params['id']!);
    const service = new ScheduleExportService(ctx.db);
    const xlsx = await service.xlsx(ctx.params['id']!);
    const doc = await service.load(ctx.params['id']!);
    file(
      ctx.res,
      xlsx,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      `${doc.fileBaseName}.xlsx`,
    );
  });

  router.get('/schedules/:id/print', async (ctx) => {
    await assertScheduleAccess(ctx.db, ctx.actor!, ctx.params['id']!);
    const service = new ScheduleExportService(ctx.db);
    html(ctx.res, 200, await service.html(ctx.params['id']!));
  });

  // ── 9. Дежурства ────────────────────────────────────────────────
  router.get('/duties', async (ctx) => {
    const { actor, floors, floor } = await context(ctx);
    if (!floor) return noFloor(ctx, actor, floors, 'duties', 'Дежурства');

    const date = ctx.query.get('date') ?? new Date().toISOString().slice(0, 10);
    const { rows } = await ctx.db.query<{
      id: string; time_from: string; time_to: string; status: string;
      student_name_snapshot: string | null; room_number_snapshot: string | null;
      student_id: string | null;
    }>(
      `SELECT d.id, d.time_from, d.time_to, d.status,
              d.student_name_snapshot, d.room_number_snapshot, d.student_id
         FROM duties d
         JOIN duty_schedules s ON s.id = d.schedule_id
        WHERE s.floor_id = $1 AND s.status = 'published' AND d.duty_date = $2::date
        ORDER BY d.slot_order`,
      [floor.id, date],
    );

    const { rows: students } = await ctx.db.query<{ id: string; full_name: string }>(
      `SELECT id, trim(concat_ws(' ', last_name, first_name)) AS full_name
         FROM students WHERE floor_id = $1 AND status = 'active' ORDER BY last_name`,
      [floor.id],
    );

    const body = `
      <form method="get" class="row">
        <input type="hidden" name="floor" value="${floor.id}">
        <label>Дата<input type="date" name="date" value="${escapeHtml(date)}"></label>
        <button type="submit">Показать</button>
      </form>
      ${table(
        ['Время', 'Комната', 'ФИО', 'Статус', 'Действия'],
        rows.map((d) => [
          `<span class="mono">${escapeHtml(d.time_from.slice(0, 5))}–${escapeHtml(d.time_to.slice(0, 5))}</span>`,
          escapeHtml(d.room_number_snapshot ?? '—'),
          escapeHtml(d.student_name_snapshot ?? '—'),
          dutyPill(d.status),
          dutyActions(d.id, floor.id, students, d.status),
        ]),
      )}`;

    html(ctx.res, 200, layout({
      title: `Дежурства · ${floorLabel(floor)}`,
      actor, floors, currentFloorId: floor.id, active: 'duties', body,
    }));
  });

  router.post('/duties/:id/complete', async (ctx) => {
    const floorId = await assertDutyAccess(ctx.db, ctx.actor!, ctx.params['id']!);
    await markCompleted(ctx.db, ctx.params['id']!, ctx.actor!.adminId);
    redirect(ctx.res, backTo(ctx, `/duties?floor=${floorId}`));
  });

  router.post('/duties/:id/miss', async (ctx) => {
    const floorId = await assertDutyAccess(ctx.db, ctx.actor!, ctx.params['id']!);
    await markMissed(ctx.db, ctx.params['id']!, {
      reason: emptyToNull(ctx.body['reason']) ?? undefined,
      adminId: ctx.actor!.adminId,
      notifications: deps.notifications,
    });
    redirect(ctx.res, backTo(ctx, `/duties?floor=${floorId}`));
  });

  router.post('/duties/:id/cancel', async (ctx) => {
    const floorId = await assertDutyAccess(ctx.db, ctx.actor!, ctx.params['id']!);
    await markCancelled(ctx.db, ctx.params['id']!, ctx.actor!.adminId);
    redirect(ctx.res, backTo(ctx, `/duties?floor=${floorId}`));
  });

  router.post('/duties/:id/substitute', async (ctx) => {
    const floorId = await assertDutyAccess(ctx.db, ctx.actor!, ctx.params['id']!);
    await substitute(ctx.db, {
      dutyId: ctx.params['id']!,
      toStudentId: String(ctx.body['to_student_id']),
      reason: String(ctx.body['reason'] ?? '').trim() || 'Не указана',
      adminId: ctx.actor!.adminId,
      notifications: deps.notifications,
    });
    redirect(ctx.res, backTo(ctx, `/duties?floor=${floorId}`));
  });

  // ── 10. Пропуски ────────────────────────────────────────────────
  router.get('/violations', async (ctx) => {
    const { actor, floors, floor } = await context(ctx);
    if (!floor) return noFloor(ctx, actor, floors, 'violations', 'Пропуски');

    const { rows } = await ctx.db.query<{
      id: string; state: string; full_name: string; duty_date: string;
      time_from: string; reason: string | null; sequence_no: number | null;
    }>(
      `SELECT v.id, v.state, v.reason, v.sequence_no,
              trim(concat_ws(' ', s.last_name, s.first_name)) AS full_name,
              d.duty_date, d.time_from
         FROM violations v
         JOIN students s ON s.id = v.student_id
         JOIN duties d   ON d.id = v.duty_id
        WHERE s.floor_id = $1
        ORDER BY d.duty_date DESC`,
      [floor.id],
    );

    const body = table(
      ['Студент', 'Дата', 'Время', 'Состояние', '№', 'Причина', 'Действия'],
      rows.map((v) => [
        escapeHtml(v.full_name),
        escapeHtml(v.duty_date),
        `<span class="mono">${escapeHtml(v.time_from.slice(0, 5))}</span>`,
        violationPill(v.state),
        v.sequence_no === null ? '—' : String(v.sequence_no),
        escapeHtml(v.reason ?? '—'),
        v.state === 'reported'
          ? `<form method="post" action="/violations/${v.id}/confirm" class="inline">
               <input type="hidden" name="floor" value="${floor.id}">
               <button type="submit" class="danger">Подтвердить</button></form>
             <form method="post" action="/violations/${v.id}/excuse" class="inline">
               <input type="hidden" name="floor" value="${floor.id}">
               <button type="submit">Уважительная</button></form>`
          : '',
      ]),
    );

    html(ctx.res, 200, layout({
      title: `Пропуски · ${floorLabel(floor)}`,
      actor, floors, currentFloorId: floor.id, active: 'violations', body,
    }));
  });

  router.post('/violations/:id/confirm', async (ctx) => {
    await assertViolationAccess(ctx, ctx.params['id']!);
    await confirmViolation(ctx.db, ctx.params['id']!, {
      adminId: ctx.actor!.adminId,
      notifications: deps.notifications,
    });
    redirect(ctx.res, `/violations?floor=${ctx.body['floor']}`);
  });

  router.post('/violations/:id/excuse', async (ctx) => {
    await assertViolationAccess(ctx, ctx.params['id']!);
    await excuseViolation(ctx.db, ctx.params['id']!, ctx.actor!.adminId);
    redirect(ctx.res, `/violations?floor=${ctx.body['floor']}`);
  });

  // ── 11. Замены ──────────────────────────────────────────────────
  router.get('/changes', async (ctx) => {
    const { actor, floors, floor } = await context(ctx);
    if (!floor) return noFloor(ctx, actor, floors, 'changes', 'Замены');

    const { rows } = await ctx.db.query<{
      change_date: string; from_name: string | null; to_name: string | null;
      to_room: string | null; reason: string | null; source: string; changed_at: string;
      time_from: string | null; time_to: string | null;
    }>(
      `SELECT c.change_date, c.from_name_snapshot AS from_name,
              c.to_name_snapshot AS to_name, c.to_room_snapshot AS to_room,
              c.reason, c.source, c.changed_at, c.time_from, c.time_to
         FROM duty_changes c
         JOIN duties d         ON d.id = c.duty_id
         JOIN duty_schedules s ON s.id = d.schedule_id
        WHERE s.floor_id = $1
        ORDER BY c.changed_at DESC`,
      [floor.id],
    );

    const body = `
      ${notice('Замены печатаются в таблице «Изменения в графике дежурств» бланка.')}
      ${table(
        ['Дата', 'Время', 'Было', 'Стало', 'Комната', 'Причина', 'Кто', 'Когда'],
        rows.map((c) => [
          escapeHtml(c.change_date),
          c.time_from ? `<span class="mono">${escapeHtml(c.time_from.slice(0, 5))}</span>` : '—',
          escapeHtml(c.from_name ?? '—'),
          escapeHtml(c.to_name ?? '—'),
          escapeHtml(c.to_room ?? '—'),
          escapeHtml(c.reason ?? '—'),
          escapeHtml(c.source),
          escapeHtml(String(c.changed_at).slice(0, 16).replace('T', ' ')),
        ]),
      )}`;

    html(ctx.res, 200, layout({
      title: `Замены · ${floorLabel(floor)}`,
      actor, floors, currentFloorId: floor.id, active: 'changes', body,
    }));
  });

  // ── 12. Настройки ───────────────────────────────────────────────
  router.get('/settings', async (ctx) => {
    const { actor, floors } = await context(ctx);
    const [faculties, shifts, templates, dormitories] = await Promise.all([
      ctx.db.query<{ id: string; code: string; name: string | null; is_active: boolean; students: string }>(
        `SELECT f.id, f.code, f.name, f.is_active,
                (SELECT count(*)::text FROM students WHERE faculty_id = f.id) AS students
           FROM faculties f ORDER BY f.sort_order, f.code`,
      ),
      ctx.db.query<{
        id: string; code: string; title: string | null; busy_from: string | null;
        busy_to: string | null; is_active: boolean;
      }>('SELECT id, code, title, busy_from, busy_to, is_active FROM study_shifts ORDER BY sort_order'),
      ctx.db.query<{ id: string; name: string; rules: string }>(
        `SELECT t.id, t.name,
                (SELECT count(*)::text FROM duty_slot_rules WHERE template_id = t.id) AS rules
           FROM duty_slot_templates t ORDER BY t.name`,
      ),
      ctx.db.query<{ id: string; number: string; settings: Record<string, number> }>(
        'SELECT id, number, settings FROM dormitories ORDER BY number',
      ),
    ]);

    const slotRules = await ctx.db.query<{
      template_id: string; weekday: number; slot_order: number; time_from: string; time_to: string;
    }>('SELECT template_id, weekday, slot_order, time_from, time_to FROM duty_slot_rules ORDER BY weekday, slot_order');

    const dormitory = dormitories.rows[0];
    const settings = dormitory?.settings ?? {};

    const body = `
      <h2>Факультеты</h2>
      ${table(
        ['Код', 'Название', 'Студентов', 'Статус', ''],
        faculties.rows.map((f) => [
          `<span class="mono">${escapeHtml(f.code)}</span>`,
          escapeHtml(f.name ?? '—'),
          f.students,
          f.is_active ? '<span class="pill ok">активен</span>' : '<span class="pill">скрыт</span>',
          toggleForm('/settings/faculties', f.id, f.is_active),
        ]),
      )}
      ${simpleForm('/settings/faculties', [
        ['code', 'Код', 'text', true],
        ['name', 'Название', 'text', false],
      ], 'Добавить факультет')}

      <h2>Учебные смены</h2>
      ${notice(
        'Пока время учёбы не задано, ограничение по учебному времени не применяется — ' +
          'генератор сообщает об этом явно.',
        'warn',
      )}
      ${table(
        ['Код', 'Название', 'Учёба с', 'по', 'Статус', ''],
        shifts.rows.map((s) => [
          `<span class="mono">${escapeHtml(s.code)}</span>`,
          escapeHtml(s.title ?? '—'),
          s.busy_from ? escapeHtml(s.busy_from.slice(0, 5)) : '<span class="muted">не задано</span>',
          s.busy_to ? escapeHtml(s.busy_to.slice(0, 5)) : '<span class="muted">не задано</span>',
          s.is_active ? '<span class="pill ok">активна</span>' : '<span class="pill">скрыта</span>',
          `<form method="post" action="/settings/shifts/${s.id}" class="inline">
             <input type="time" name="busy_from" value="${s.busy_from ? escapeHtml(s.busy_from.slice(0, 5)) : ''}">
             <input type="time" name="busy_to" value="${s.busy_to ? escapeHtml(s.busy_to.slice(0, 5)) : ''}">
             <button type="submit">Сохранить</button></form>`,
        ]),
      )}
      ${simpleForm('/settings/shifts', [
        ['code', 'Код', 'text', true],
        ['title', 'Название', 'text', false],
      ], 'Добавить смену')}

      <h2>Шаблоны смен дежурств</h2>
      ${templates.rows
        .map(
          (t) => `<div class="card"><strong>${escapeHtml(t.name)}</strong>
        <span class="muted">· правил: ${t.rules}</span>
        ${table(
          ['День недели', 'Смена', 'С', 'По', ''],
          slotRules.rows
            .filter((r) => r.template_id === t.id)
            .map((r) => [
              weekdayLabel(r.weekday),
              String(r.slot_order),
              `<span class="mono">${escapeHtml(r.time_from.slice(0, 5))}</span>`,
              `<span class="mono">${escapeHtml(r.time_to.slice(0, 5))}</span>`,
              `<form method="post" action="/settings/slot-rules" class="inline">
                 <input type="hidden" name="template_id" value="${t.id}">
                 <input type="hidden" name="weekday" value="${r.weekday}">
                 <input type="hidden" name="slot_order" value="${r.slot_order}">
                 <input type="time" name="time_from" value="${escapeHtml(r.time_from.slice(0, 5))}">
                 <input type="time" name="time_to" value="${escapeHtml(r.time_to.slice(0, 5))}">
                 <button type="submit">Изменить</button></form>`,
            ]),
        )}</div>`,
        )
        .join('')}

      <h2>Пропуски и уведомления</h2>
      <form method="post" action="/settings/dormitory" class="card">
        <input type="hidden" name="dormitory_id" value="${dormitory?.id ?? ''}">
        <label>Порог пропусков для объяснительной
          <input type="number" name="violation_threshold" min="1"
                 value="${settings['violation_threshold'] ?? 3}"></label>
        <label>Напоминать за сколько часов
          <input type="number" name="reminder_hours_before" min="1"
                 value="${settings['reminder_hours_before'] ?? 24}"></label>
        <label>Месяц начала учебного года (период подсчёта пропусков)
          <input type="number" name="academic_year_start_month" min="1" max="12"
                 value="${settings['academic_year_start_month'] ?? 9}"></label>
        <button type="submit" class="primary">Сохранить</button>
      </form>

      <h2>Параметры печати</h2>
      ${table(
        ['Этаж', 'Строк на комнату', 'Пустые комнаты', ''],
        floors.map((f) => [
          escapeHtml(floorLabel(f)),
          '',
          '',
          `<form method="post" action="/settings/print" class="inline">
             <input type="hidden" name="floor_id" value="${f.id}">
             <input type="number" name="print_min_rows" placeholder="по факту" min="0" style="width:120px">
             <label style="display:inline"><input type="checkbox" name="print_empty_rooms" checked style="display:inline;width:auto"> печатать пустые</label>
             <button type="submit">Сохранить</button></form>`,
        ]),
      )}`;

    html(ctx.res, 200, layout({ title: 'Настройки', actor, floors, active: 'settings', body }));
  });

  router.post('/settings/faculties', async (ctx) => {
    assertCanManageSettings(ctx.actor!);
    if (ctx.body['toggle_id']) {
      await ctx.db.query('UPDATE faculties SET is_active = NOT is_active WHERE id = $1', [
        ctx.body['toggle_id'],
      ]);
    } else {
      await ctx.db.query(
        `INSERT INTO faculties (dormitory_id, code, name, sort_order)
         VALUES ((SELECT id FROM dormitories ORDER BY number LIMIT 1), $1, $2,
                 (SELECT COALESCE(max(sort_order),0)+1 FROM faculties))`,
        [String(ctx.body['code']).trim(), emptyToNull(ctx.body['name'])],
      );
    }
    redirect(ctx.res, '/settings');
  });

  router.post('/settings/shifts', async (ctx) => {
    assertCanManageSettings(ctx.actor!);
    await ctx.db.query(
      `INSERT INTO study_shifts (dormitory_id, code, title, sort_order)
       VALUES ((SELECT id FROM dormitories ORDER BY number LIMIT 1), $1, $2,
               (SELECT COALESCE(max(sort_order),0)+1 FROM study_shifts))`,
      [String(ctx.body['code']).trim(), emptyToNull(ctx.body['title'])],
    );
    redirect(ctx.res, '/settings');
  });

  router.post('/settings/shifts/:id', async (ctx) => {
    assertCanManageSettings(ctx.actor!);
    await ctx.db.query(
      'UPDATE study_shifts SET busy_from = $2, busy_to = $3 WHERE id = $1',
      [ctx.params['id'], emptyToNull(ctx.body['busy_from']), emptyToNull(ctx.body['busy_to'])],
    );
    redirect(ctx.res, '/settings');
  });

  router.post('/settings/slot-rules', async (ctx) => {
    assertCanManageSettings(ctx.actor!);
    await ctx.db.query(
      `UPDATE duty_slot_rules SET time_from = $4, time_to = $5
        WHERE template_id = $1 AND weekday = $2 AND slot_order = $3`,
      [
        ctx.body['template_id'],
        Number(ctx.body['weekday']),
        Number(ctx.body['slot_order']),
        ctx.body['time_from'],
        ctx.body['time_to'],
      ],
    );
    redirect(ctx.res, '/settings');
  });

  router.post('/settings/dormitory', async (ctx) => {
    assertCanManageSettings(ctx.actor!);
    await ctx.db.query(
      `UPDATE dormitories SET settings = jsonb_build_object(
         'violation_threshold', $2::int,
         'reminder_hours_before', $3::int,
         'academic_year_start_month', $4::int)
        WHERE id = $1`,
      [
        ctx.body['dormitory_id'],
        Number(ctx.body['violation_threshold']),
        Number(ctx.body['reminder_hours_before']),
        Number(ctx.body['academic_year_start_month']),
      ],
    );
    redirect(ctx.res, '/settings');
  });

  router.post('/settings/print', async (ctx) => {
    const floorId = String(ctx.body['floor_id']);
    await assertFloorAccess(ctx.db, ctx.actor!, floorId);
    await ctx.db.query(
      'UPDATE floors SET print_min_rows = $2, print_empty_rooms = $3 WHERE id = $1',
      [
        floorId,
        ctx.body['print_min_rows'] ? Number(ctx.body['print_min_rows']) : null,
        ctx.body['print_empty_rooms'] === 'on',
      ],
    );
    redirect(ctx.res, '/settings');
  });

  return router;
}

// ─────────────────────────── вспомогательное ───────────────────────────

/**
 * Контекст страницы: администратор, доступные ему этажи и выбранный этаж.
 * Единственный способ получить floor_id в обработчике — этот метод
 * или assert*Access, поэтому чужой этаж в запрос не попадёт.
 */
async function context(
  ctx: Ctx,
  forceFloorId?: string,
): Promise<{ actor: Actor; floors: FloorOption[]; floor: FloorOption | null }> {
  const actor = ctx.actor!;
  const scope = await resolveScope(ctx.db, actor);

  const { rows } = await ctx.db.query<FloorOption>(
    `SELECT id, number, code, title FROM floors
      WHERE id = ANY($1::uuid[]) AND is_active ORDER BY number`,
    [scope],
  );

  const requested = forceFloorId ?? ctx.query.get('floor');
  const floor =
    (requested ? rows.find((f) => f.id === requested) : undefined) ?? rows[0] ?? null;
  return { actor, floors: rows, floor };
}

async function requireFloor(ctx: Ctx): Promise<FloorOption> {
  const { floor } = await context(ctx);
  if (!floor) throw new ForbiddenError('Этаж недоступен');
  return floor;
}

function noFloor(
  ctx: Ctx,
  actor: Actor,
  floors: FloorOption[],
  active: string,
  title: string,
): void {
  html(ctx.res, 200, layout({
    title, actor, floors, active,
    body: notice('Нет доступных этажей.', 'warn'),
  }));
}

async function assertViolationAccess(ctx: Ctx, violationId: string): Promise<void> {
  const { rows } = await ctx.db.query<{ floor_id: string }>(
    `SELECT s.floor_id FROM violations v
       JOIN students s ON s.id = v.student_id WHERE v.id = $1`,
    [violationId],
  );
  if (!rows[0]) throw new ForbiddenError('Пропуск не найден');
  await assertFloorAccess(ctx.db, ctx.actor!, rows[0].floor_id);
}

async function lookupId(
  db: pg.Pool,
  tableName: 'faculties' | 'study_shifts',
  code: unknown,
): Promise<string | null> {
  const value = emptyToNull(code);
  if (!value) return null;
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM ${tableName} WHERE code = $1 LIMIT 1`,
    [value],
  );
  return rows[0]?.id ?? null;
}

function emptyToNull(value: unknown): string | null {
  const text = String(value ?? '').trim();
  return text === '' ? null : text;
}

function rangeNumbers(from: number, to: number): string[] {
  if (to < from || to - from > 500) return [String(from)];
  return Array.from({ length: to - from + 1 }, (_, i) => String(from + i));
}

function backTo(ctx: Ctx, fallback: string): string {
  const back = ctx.body['back'];
  return typeof back === 'string' && back.startsWith('/') ? back : fallback;
}

function stat(value: string, label: string): string {
  return `<div class="stat"><div class="value">${escapeHtml(value)}</div>
    <div class="label">${escapeHtml(label)}</div></div>`;
}

function statusPill(status: string): string {
  if (status === 'published') return '<span class="pill ok">опубликован</span>';
  if (status === 'archived') return '<span class="pill">архив</span>';
  return '<span class="pill warn">черновик</span>';
}

function dutyPill(status: string): string {
  switch (status) {
    case 'completed':
      return '<span class="pill ok">выполнено</span>';
    case 'missed':
      return '<span class="pill alert">пропущено</span>';
    case 'cancelled':
      return '<span class="pill">отменено</span>';
    default:
      return '<span class="pill">назначено</span>';
  }
}

function violationPill(state: string): string {
  switch (state) {
    case 'reported':
      return '<span class="pill warn">не проверен</span>';
    case 'confirmed':
      return '<span class="pill alert">подтверждён</span>';
    case 'excused':
      return '<span class="pill ok">уважительная</span>';
    case 'explanation_required':
      return '<span class="pill alert">нужна объяснительная</span>';
    default:
      return `<span class="pill">${escapeHtml(state)}</span>`;
  }
}

function weekdayLabel(weekday: number): string {
  return ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'][
    weekday - 1
  ] ?? String(weekday);
}

function publishForm(
  scheduleId: string,
  data: Awaited<ReturnType<typeof publishPreview>>,
  needsAcknowledge: boolean,
): string {
  return `<form method="post" action="/schedules/${scheduleId}/publish" class="card">
    <h2>Подтверждение публикации</h2>
    <p>Этаж <strong>${data.floorNumber}</strong> · общежитие №${escapeHtml(data.dormitoryNumber)}<br>
       Период <strong>${escapeHtml(data.monthName)} ${data.year}</strong><br>
       Студентов: <strong>${data.students}</strong><br>
       Дежурств: <strong>${data.duties}</strong></p>
    ${
      needsAcknowledge
        ? `<label><input type="checkbox" name="acknowledge_drift" required style="display:inline;width:auto">
             Публиковать по прежнему составу (версия ${data.rosterVersionNo})</label>`
        : ''
    }
    <button type="submit" class="primary">Опубликовать</button>
  </form>`;
}

function newFloorForm(): string {
  return `<form method="post" action="/floors" class="card">
    <h2>Новый этаж</h2>
    <label>Номер<input type="number" name="number" required></label>
    <label>Код (если этаж не просто число)<input name="code"></label>
    <label>Название<input name="title"></label>
    <label>Строк на комнату в бланке<input type="number" name="print_min_rows" min="0"></label>
    <label style="display:inline"><input type="checkbox" name="print_empty_rooms" checked
      style="display:inline;width:auto"> печатать пустые комнаты</label>
    <button type="submit" class="primary">Создать</button>
  </form>`;
}

function roomForms(floorId: string, blocks: Array<{ id: string; code: string }>): string {
  return `<div class="grid">
    <form method="post" action="/rooms" class="card">
      <h2>Комнаты</h2>
      <input type="hidden" name="floor_id" value="${floorId}">
      <label>С номера<input name="from" placeholder="601" required></label>
      <label>По номер (для диапазона)<input name="to" placeholder="620"></label>
      <label>Блок
        <select name="block_id"><option value="">без блока</option>
        ${blocks.map((b) => `<option value="${b.id}">${escapeHtml(b.code)}</option>`).join('')}
        </select></label>
      <button type="submit" class="primary">Создать</button>
    </form>
    <form method="post" action="/blocks" class="card">
      <h2>Блок</h2>
      <input type="hidden" name="floor_id" value="${floorId}">
      <label>Код блока<input name="code" placeholder="605" required></label>
      <label>Секции через запятую<input name="sections" placeholder="А, Б"></label>
      <button type="submit" class="primary">Создать</button>
    </form>
  </div>`;
}

function addStudentForm(floorId: string, faculties: string[], shifts: string[]): string {
  return `<form method="post" action="/roster/students" class="card">
    <h2>Заселить студента</h2>
    <input type="hidden" name="floor_id" value="${floorId}">
    <div class="grid">
      <label>Фамилия<input name="last_name" required></label>
      <label>Имя<input name="first_name" required></label>
      <label>Отчество<input name="middle_name"></label>
      <label>Комната<input name="room" required></label>
      <label>Факультет<select name="faculty"><option value=""></option>
        ${faculties.map((f) => `<option>${escapeHtml(f)}</option>`).join('')}</select></label>
      <label>Смена<select name="shift"><option value=""></option>
        ${shifts.map((s) => `<option>${escapeHtml(s)}</option>`).join('')}</select></label>
      <label>Курс<input type="number" name="course" min="1"></label>
      <label>Группа<input name="group_code"></label>
      <label>Телефон<input name="phone" type="tel" placeholder="+37529…"></label>
      <label>Telegram ID<input name="telegram_id" inputmode="numeric"></label>
    </div>
    <button type="submit" class="primary">Заселить</button>
  </form>`;
}

function studentActions(studentId: string, _floorId: string): string {
  const iconMove = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3"/><path d="M16 3h3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-3"/><path d="M12 8v8"/><path d="m9 11 3-3 3 3"/></svg>`;
  const iconOut = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>`;
  return `<div class="action-btns">
    <form method="post" action="/roster/students/${studentId}/relocate" class="inline"
      onsubmit="var r=prompt('Номер комнаты (например 612А)');if(!r)return false;this.room.value=r.trim();">
      <input type="hidden" name="room" value="">
      <button type="submit" class="icon-round" title="Переселить" aria-label="Переселить">${iconMove}</button></form>
    <form method="post" action="/roster/students/${studentId}/status" class="inline"
      onsubmit="return confirm('Выселить студента?');">
      <input type="hidden" name="status" value="moved_out">
      <button type="submit" class="danger icon-round" title="Выселить" aria-label="Выселить">${iconOut}</button></form>
  </div>`;
}

function dutyActions(
  dutyId: string,
  floorId: string,
  students: Array<{ id: string; full_name: string }>,
  status: string,
): string {
  const marks =
    status === 'scheduled'
      ? `<form method="post" action="/duties/${dutyId}/complete" class="inline">
           <button type="submit">Выполнено</button></form>
         <form method="post" action="/duties/${dutyId}/miss" class="inline">
           <input name="reason" placeholder="причина" size="10" style="display:inline;width:auto">
           <button type="submit" class="danger">Пропущено</button></form>`
      : `<form method="post" action="/duties/${dutyId}/complete" class="inline">
           <button type="submit">Выполнено</button></form>`;

  return `${marks}
    <form method="post" action="/duties/${dutyId}/substitute" class="inline">
      <select name="to_student_id" style="display:inline;width:auto">
        ${students.map((s) => `<option value="${s.id}">${escapeHtml(s.full_name)}</option>`).join('')}
      </select>
      <input name="reason" placeholder="причина" size="10" style="display:inline;width:auto">
      <button type="submit">Замена</button></form>`;
}

function toggleForm(action: string, id: string, isActive: boolean): string {
  return `<form method="post" action="${action}" class="inline">
    <input type="hidden" name="toggle_id" value="${id}">
    <button type="submit">${isActive ? 'Скрыть' : 'Вернуть'}</button></form>`;
}

function simpleForm(
  action: string,
  fields: Array<[string, string, string, boolean]>,
  submit: string,
): string {
  return `<form method="post" action="${action}" class="card">
    ${fields
      .map(
        ([name, label, type, required]) =>
          `<label>${escapeHtml(label)}<input name="${name}" type="${type}"${
            required ? ' required' : ''
          }></label>`,
      )
      .join('')}
    <button type="submit" class="primary">${escapeHtml(submit)}</button>
  </form>`;
}

function select(name: string, label: string, values: string[], selected: string): string {
  return `<label>${escapeHtml(label)}<select name="${name}">
    <option value="">все</option>
    ${values
      .map(
        (v) => `<option value="${escapeHtml(v)}"${v === selected ? ' selected' : ''}>${escapeHtml(v)}</option>`,
      )
      .join('')}
  </select></label>`;
}

async function renderImportPreview(
  db: pg.Pool,
  importId: string,
  floorId: string,
): Promise<string> {
  const { rows } = await db.query<{ diff: Record<string, unknown[]>; floor_id: string }>(
    'SELECT diff, floor_id FROM roster_imports WHERE id = $1',
    [importId],
  );
  const record = rows[0];
  if (!record || record.floor_id !== floorId) return '';

  const diff = record.diff;
  const count = (key: string): number => (diff[key] as unknown[] | undefined)?.length ?? 0;

  return `<div class="card">
    <h2>Результат сравнения</h2>
    <div class="grid">
      ${stat(String(count('added')), 'Новые')}
      ${stat(String(count('relocated')), 'Переселения')}
      ${stat(String(count('attributesOnly')), 'Изменены атрибуты')}
      ${stat(String(count('removed')), 'Исчезли')}
      ${stat(String(count('unchanged')), 'Без изменений')}
    </div>
    <form method="post" action="/import/${importId}/apply">
      <input type="hidden" name="decisions" value="{}">
      <button type="submit" class="primary">Применить</button>
    </form>
    <form method="post" action="/import/${importId}/reject">
      <button type="submit">Отклонить</button>
    </form>
  </div>`;
}

export { ManualImportSource, XlsxImportSource, preview };
