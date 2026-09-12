/**
 * Локальный экспорт списка 6 этажа из data/floor6-contacts.xlsx (без БД/сервера).
 *
 *   npx tsx scripts/exportFloor6Local.ts [outdir]
 */
import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import type { FloorRoster, RosterPerson, RosterRoom } from '../src/domain/floorRoster.js';
import { formatCourseGroup, formatDisplayName, formatInitials } from '../src/domain/floorRoster.js';
import { buildRosterDocument } from '../src/services/export/rosterDocument.js';
import { renderRosterHtml } from '../src/services/export/htmlRenderer.js';
import { renderRosterXlsx } from '../src/services/export/xlsxRenderer.js';
import { findBrowser, renderRosterPdf } from '../src/services/export/pdfRenderer.js';

const FAC_MAP: Record<string, string> = { ИСИТ: 'ФИТ', ЦД: 'ФИТ', ПИ: 'ФИТ' };

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

function resolveFaculty(code: string | null): string | null {
  if (!code) return null;
  return FAC_MAP[code] ?? code;
}

async function loadPeople(filePath: string): Promise<Map<string, RosterPerson[]>> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error('Нет листа');

  const byRoom = new Map<string, RosterPerson[]>();
  let sort = 0;

  sheet.eachRow((row) => {
    const room = cellText(row.getCell(1).value);
    if (!room || !/^6\d{2}[АБ]$/u.test(room)) return;
    const name = cellText(row.getCell(3).value);
    if (!name) return;
    const parts = name.split(/\s+/).filter(Boolean);
    if (parts.length < 2) return;
    const lastName = parts[0]!;
    const firstName = parts.slice(1).join(' ');
    const facultyCode = resolveFaculty(cellText(row.getCell(4).value));
    const course = parseIntCell(row.getCell(6).value);
    const groupNo = parseIntCell(row.getCell(7).value);
    const groupCode = groupNo != null ? String(groupNo) : null;
    const person: RosterPerson = {
      studentId: `local-${sort}`,
      lastName,
      firstName,
      middleName: null,
      displayName: formatDisplayName({ lastName, firstName }),
      initialsName: formatInitials({ lastName, firstName, middleName: null }),
      facultyCode,
      studyShiftCode: null,
      course,
      groupCode,
      courseGroup: formatCourseGroup(course, groupCode),
      phone: null,
      telegramId: null,
      status: 'active',
      sortOrder: sort,
    };
    sort += 1;
    const list = byRoom.get(room) ?? [];
    list.push(person);
    byRoom.set(room, list);
  });

  return byRoom;
}

function buildRoster(byRoom: Map<string, RosterPerson[]>): FloorRoster {
  const rooms: RosterRoom[] = [];
  let sortOrder = 0;
  for (let n = 601; n <= 616; n += 1) {
    for (const suffix of ['А', 'Б'] as const) {
      const number = `${n}${suffix}`;
      rooms.push({
        roomId: null,
        number,
        blockId: null,
        blockCode: String(n),
        sortOrder,
        people: byRoom.get(number) ?? [],
        printMinRows: null,
      });
      sortOrder += 1;
    }
  }

  return {
    meta: {
      source: 'current',
      floorId: 'local-6',
      floorNumber: 6,
      floorCode: '6',
      floorTitle: null,
      dormitoryNumber: '4',
      dormitoryName: null,
      rosterVersionId: null,
      rosterVersionNo: null,
      rosterVersionStatus: null,
      effectiveFrom: null,
      printMinRows: null,
      printEmptyRooms: true,
      emptyRoomsAvailable: true,
      generatedAt: new Date().toISOString(),
    },
    rooms,
  };
}

async function main(): Promise<void> {
  const root = path.resolve(import.meta.dirname, '..');
  const srcXlsx = path.join(root, 'data', 'floor6-contacts.xlsx');
  const outDir = path.resolve(process.argv[2] ?? path.join(process.env.HOME ?? '', 'Downloads'));

  const byRoom = await loadPeople(srcXlsx);
  const roster = buildRoster(byRoom);
  const doc = buildRosterDocument(roster, { academicYear: '2025-2026' });

  fs.mkdirSync(outDir, { recursive: true });
  const base = path.join(outDir, 'Список_6_этажа');

  const html = renderRosterHtml(doc);
  fs.writeFileSync(`${base}.html`, html);

  const xlsx = await renderRosterXlsx(doc);
  fs.writeFileSync(`${base}.xlsx`, xlsx);

  let pdfOk = false;
  if (await findBrowser()) {
    try {
      const pdf = await renderRosterPdf(doc);
      fs.writeFileSync(`${base}.pdf`, pdf);
      pdfOk = true;
    } catch (err) {
      console.warn('PDF не собран:', err instanceof Error ? err.message : err);
    }
  }

  const people = roster.rooms.reduce((s, r) => s + r.people.length, 0);
  console.log(`Страниц: ${doc.totalPages}`);
  console.log(`Людей: ${people}`);
  console.log(`Строк слева/справа: ${doc.pages[0]!.left.rows.length} / ${doc.pages[0]!.right.rows.length}`);
  console.log(`HTML: ${base}.html`);
  console.log(`XLSX: ${base}.xlsx`);
  if (pdfOk) console.log(`PDF:  ${base}.pdf`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
