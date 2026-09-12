/**
 * Импорт 6 этажа из «6 этаж.xlsx» (контакты).
 * ИСИТ / ЦД / ПИ → ФИТ; ХТИТ и ИЭФ без изменений.
 *
 *   npx tsx src/seed/importFloor6FromXlsx.ts [путь/к/файлу.xlsx]
 */
import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { config } from '../config.js';
import { formatGroupCode } from '../domain/facultyGroup.js';
import { createPool, withTransaction } from '../db/pool.js';
import { materializeVersion } from '../services/rosterService.js';

interface PersonRow {
  room: string;
  last: string;
  first: string;
  faculty: string;
  course: number | null;
  groupNo: number | null;
  shift: number | null;
  phone: string | null;
  telegram: string | null;
}

/** Старое ФИО в БД → новое из бланка. */
const RENAMES: Array<{ from: [string, string]; to: [string, string] }> = [
  { from: ['Бунатин', 'Максим'], to: ['Букатин', 'Максимилиан'] },
];

function cellText(value: ExcelJS.CellValue): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' && 'text' in value) return String(value.text).trim() || null;
  return String(value).trim() || null;
}

function parseIntCell(value: ExcelJS.CellValue): number | null {
  const text = cellText(value);
  if (!text || text === '—' || text === '-') return null;
  const n = Number(text.replace(',', '.'));
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function normalizePhone(raw: string | null): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.startsWith('375') && digits.length === 12) return `+${digits}`;
  if (digits.startsWith('80') && digits.length === 11) return `+375${digits.slice(2)}`;
  if (digits.length === 9) return `+375${digits}`;
  return raw.startsWith('+') ? raw : digits ? `+${digits}` : null;
}

function normalizeTelegram(raw: string | null): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  return digits || null;
}

function resolveFaculty(code: string | null): string {
  if (!code) return '—';
  if (code === 'ИСИТ' || code === 'ЦД' || code === 'ПИ') return 'ФИТ';
  return code;
}

function parseFullName(raw: string | null): { last: string; first: string } | null {
  if (!raw) return null;
  const parts = raw.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  return { last: parts[0]!, first: parts[1]! };
}

async function readContactsXlsx(filePath: string): Promise<PersonRow[]> {
  const roomPattern = /^6\d{2}[АБ]$/;

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error('В файле нет листа');

  const rows: PersonRow[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber <= 2) return;
    const room = cellText(row.getCell(1).value);
    const name = parseFullName(cellText(row.getCell(3).value));
    if (!room || !name || !roomPattern.test(room)) return;

    const faculty = resolveFaculty(cellText(row.getCell(4).value));
    const course = parseIntCell(row.getCell(6).value);
    const groupNo = parseIntCell(row.getCell(7).value);
    const shift = parseIntCell(row.getCell(8).value);
    const phone = normalizePhone(cellText(row.getCell(9).value));
    const telegram = normalizeTelegram(cellText(row.getCell(10).value));

    rows.push({
      room,
      last: name.last,
      first: name.first,
      faculty,
      course,
      groupNo,
      shift,
      phone,
      telegram,
    });
  });

  if (rows.length === 0) throw new Error('Не найдено ни одной строки студента');
  return rows;
}

const xlsxPath = path.resolve(
  process.argv[2] ?? path.join(process.cwd(), 'data/floor6-contacts.xlsx'),
);
if (!fs.existsSync(xlsxPath)) {
  throw new Error(`Файл не найден: ${xlsxPath}`);
}

const RESIDENTS = await readContactsXlsx(xlsxPath);
console.log(`Прочитано из ${xlsxPath}: ${RESIDENTS.length} студентов`);

const db = createPool(config.databaseUrl);

await withTransaction(db, async (client) => {
  const floor = (
    await client.query<{ id: string; dormitory_id: string }>(
      'SELECT id, dormitory_id FROM floors WHERE number = 6',
    )
  ).rows[0];
  if (!floor) throw new Error('6 этаж не найден');

  const maxSort = (
    await client.query<{ n: number }>(
      'SELECT COALESCE(MAX(sort_order), 0)::int AS n FROM faculties WHERE dormitory_id = $1',
      [floor.dormitory_id],
    )
  ).rows[0]!.n;

  await client.query(
    `INSERT INTO faculties (dormitory_id, code, name, sort_order)
     VALUES ($1, 'ФИТ', 'Факультет информационных технологий', $2)
     ON CONFLICT (dormitory_id, code) DO NOTHING`,
    [floor.dormitory_id, maxSort + 1],
  );

  for (const [code, title] of [
    ['2', 'Вторая смена'],
  ] as const) {
    const exists = (
      await client.query(
        'SELECT 1 FROM study_shifts WHERE dormitory_id = $1 AND code = $2',
        [floor.dormitory_id, code],
      )
    ).rowCount;
    if (exists) continue;
    await client.query(
      `INSERT INTO study_shifts (dormitory_id, code, title, sort_order)
       VALUES ($1, $2, $3, COALESCE((SELECT MAX(sort_order)+1 FROM study_shifts), 0))`,
      [floor.dormitory_id, code, title],
    );
  }

  const faculties = new Map(
    (await client.query<{ id: string; code: string }>('SELECT id, code FROM faculties')).rows.map(
      (r) => [r.code, r.id],
    ),
  );
  const shifts = new Map(
    (
      await client.query<{ id: string; code: string }>(
        'SELECT id, code FROM study_shifts WHERE dormitory_id = $1 OR dormitory_id IS NULL',
        [floor.dormitory_id],
      )
    ).rows.map((r) => [r.code, r.id]),
  );
  const defaultShift = shifts.get('1') ?? [...shifts.values()][0];
  if (!defaultShift) throw new Error('Нет учебных смен');

  const roomId = async (number: string): Promise<string> => {
    const row = (
      await client.query<{ id: string }>(
        'SELECT id FROM rooms WHERE floor_id = $1 AND number = $2',
        [floor.id, number],
      )
    ).rows[0];
    if (!row) throw new Error(`Комната ${number} не найдена на 6 этаже`);
    return row.id;
  };

  const findStudent = async (last: string, first: string) => {
    const direct = (
      await client.query<{ id: string; role: string }>(
        `SELECT id, role FROM students
          WHERE floor_id = $1 AND last_name = $2 AND first_name = $3 AND status = 'active'`,
        [floor.id, last, first],
      )
    ).rows[0];
    if (direct) return direct;

    for (const rename of RENAMES) {
      if (rename.to[0] === last && rename.to[1] === first) {
        const old = (
          await client.query<{ id: string; role: string }>(
            `SELECT id, role FROM students
              WHERE floor_id = $1 AND last_name = $2 AND first_name = $3 AND status = 'active'`,
            [floor.id, rename.from[0], rename.from[1]],
          )
        ).rows[0];
        if (old) return old;
      }
    }
    return undefined;
  };

  const matchedIds = new Set<string>();
  let added = 0;
  let updated = 0;

  for (const person of RESIDENTS) {
    const rId = await roomId(person.room);
    const facultyId = faculties.get(person.faculty) ?? faculties.get('—');
    if (!facultyId) throw new Error(`Факультет ${person.faculty} не найден`);

    const shiftId =
      person.shift !== null ? (shifts.get(String(person.shift)) ?? defaultShift) : defaultShift;
    const groupCode =
      person.course !== null && person.groupNo !== null
        ? formatGroupCode(person.course, person.groupNo)
        : '—';

    const existing = await findStudent(person.last, person.first);
    if (existing) {
      matchedIds.add(existing.id);
      await client.query(
        `UPDATE students
            SET last_name = $2,
                first_name = $3,
                room_id = $4,
                faculty_id = $5,
                study_shift_id = $6,
                course = $7,
                group_code = $8,
                phone = COALESCE($9, phone),
                telegram_id = COALESCE($10, telegram_id),
                updated_at = now()
          WHERE id = $1`,
        [
          existing.id,
          person.last,
          person.first,
          rId,
          facultyId,
          shiftId,
          person.course,
          groupCode,
          person.phone,
          person.telegram,
        ],
      );
      await client.query(
        `UPDATE student_placements SET valid_to = current_date
          WHERE student_id = $1 AND valid_to IS NULL`,
        [existing.id],
      );
      await client.query(
        `INSERT INTO student_placements
           (student_id, floor_id, block_id, room_id,
            room_number_snapshot, block_code_snapshot, floor_number_snapshot, valid_from)
         SELECT $1, r.floor_id, r.block_id, r.id, r.number, b.code, fl.number, current_date
           FROM rooms r
           JOIN floors fl ON fl.id = r.floor_id
           LEFT JOIN blocks b ON b.id = r.block_id
          WHERE r.id = $2`,
        [existing.id, rId],
      );
      updated += 1;
      console.log(`~ ${person.room} ${person.last} ${person.first} → ${person.faculty} ${groupCode}`);
      continue;
    }

    const role = person.last === 'Шершнев' && person.first === 'Глеб' ? 'elder' : 'resident';
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO students
         (floor_id, room_id, last_name, first_name,
          faculty_id, study_shift_id, course, group_code, phone, telegram_id, role, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,0)
       RETURNING id`,
      [
        floor.id,
        rId,
        person.last,
        person.first,
        facultyId,
        shiftId,
        person.course,
        groupCode,
        person.phone,
        person.telegram,
        role,
      ],
    );
    matchedIds.add(rows[0]!.id);
    await client.query(
      `INSERT INTO student_placements
         (student_id, floor_id, block_id, room_id,
          room_number_snapshot, block_code_snapshot, floor_number_snapshot, valid_from)
       SELECT $1, r.floor_id, r.block_id, r.id, r.number, b.code, fl.number, current_date
         FROM rooms r
         JOIN floors fl ON fl.id = r.floor_id
         LEFT JOIN blocks b ON b.id = r.block_id
        WHERE r.id = $2`,
      [rows[0]!.id, rId],
    );
    added += 1;
    console.log(`+ ${person.room} ${person.last} ${person.first} → ${person.faculty} ${groupCode}`);
  }

  const toMoveOut = (
    await client.query<{ id: string; last_name: string; first_name: string }>(
      `SELECT id, last_name, first_name FROM students
        WHERE floor_id = $1 AND status = 'active'`,
      [floor.id],
    )
  ).rows.filter((s) => !matchedIds.has(s.id));

  for (const person of toMoveOut) {
    await client.query(
      `UPDATE students
          SET status = 'moved_out', left_at = current_date, updated_at = now()
        WHERE id = $1`,
      [person.id],
    );
    await client.query(
      `UPDATE student_placements SET valid_to = current_date
        WHERE student_id = $1 AND valid_to IS NULL`,
      [person.id],
    );
    console.log(`− ${person.last_name} ${person.first_name}`);
  }

  await client.query(
    `UPDATE students SET role = 'elder' WHERE floor_id = $1 AND last_name = 'Шершнев' AND first_name = 'Глеб'`,
    [floor.id],
  );

  await materializeVersion(client, floor.id, {
    source: 'import',
    note: `Импорт 6 этажа из ${path.basename(xlsxPath)} (ФИТ)`,
    force: true,
  });

  console.log(`\nОбновлено: ${updated}, добавлено: ${added}, выбыло: ${toMoveOut.length}`);
});

await db.end();
