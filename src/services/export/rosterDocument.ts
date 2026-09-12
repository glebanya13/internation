import type { FloorRoster, RosterRoom } from '../../domain/floorRoster.js';
import { displayCourseGroup, rowsForRoom } from '../../domain/printLayout.js';

/**
 * Модель печатного документа списка этажа.
 *
 * Формат-независима: одна и та же структура уходит в HTML, PDF и XLSX,
 * поэтому раскладка, объединения ячеек и разбивка на страницы не могут
 * разойтись между форматами.
 *
 * Воспроизводит вёрстку исходного бланка: A4 книжная, два зеркальных блока
 * по 5 колонок, комната и факультет объединены по вертикали на все строки
 * комнаты, свободные места остаются пустыми строками.
 */

export interface DocumentCell {
  text: string;
  /** Сколько строк занимает объединённая ячейка. 0 — ячейка поглощена. */
  rowSpan: number;
}

export interface DocumentRow {
  room: DocumentCell;
  name: DocumentCell;
  faculty: DocumentCell;
  courseGroup: DocumentCell;
  /** Строка-заполнитель: свободное место в комнате. */
  filler: boolean;
  /** Первая строка комнаты — по ней рисуется утолщённая граница. */
  roomStart: boolean;
}

/** Колонка страницы — один из двух зеркальных блоков. */
export interface DocumentColumn {
  rows: DocumentRow[];
}

export interface DocumentPage {
  pageNumber: number;
  left: DocumentColumn;
  /** Правый блок; после normalizePage всегда заполнен. */
  right: DocumentColumn;
}

export interface RosterDocument {
  title: string;
  subtitle: string;
  meta: FloorRoster['meta'];
  headers: string[];
  pages: DocumentPage[];
  totalPages: number;
  /** Сводка для подвала и веб-страницы. */
  stats: {
    people: number;
    rooms: number;
    occupiedRooms: number;
    emptyRooms: number;
    hiddenEmptyRooms: number;
  };
  /** Блок подписи внизу документа. */
  signature: { role: string; name: string } | null;
  fileBaseName: string;
}

export interface RosterDocumentOptions {
  /** Учебный год для заголовка и имени файла. */
  academicYear?: string;
  /** Кто подписывает список. */
  signature?: { role: string; name: string } | null;
}

export const ROSTER_HEADERS = ['Комната', 'Фамилия Имя', 'Факультет', 'Курс-группа'];

function cell(text: string | null | undefined, rowSpan = 1): DocumentCell {
  return { text: text ?? '', rowSpan };
}

/**
 * Сколько строк займёт комната в бланке: жильцы плюс добивка до минимума.
 * См. rowsForRoom в domain/printLayout.ts.
 */
function buildRoomRows(
  room: RosterRoom,
  floorMinRows: number | null,
  printEmptyRooms: boolean,
): DocumentRow[] {
  const total = rowsForRoom(room, floorMinRows, printEmptyRooms);
  if (total === 0) return [];

  const faculties = new Set(room.people.map((p) => p.facultyCode ?? ''));
  const mergeFaculty = room.people.length > 0 && faculties.size === 1;
  const sharedFaculty = mergeFaculty ? (room.people[0]!.facultyCode ?? '') : '';

  const rows: DocumentRow[] = [];
  for (let i = 0; i < total; i += 1) {
    const person = room.people[i];
    rows.push({
      room: i === 0 ? cell(room.number, total) : cell('', 0),
      name: cell(person?.displayName ?? ''),
      faculty: mergeFaculty
        ? i === 0
          ? cell(sharedFaculty, total)
          : cell('', 0)
        : cell(person?.facultyCode ?? ''),
      courseGroup: cell(
        person
          ? (displayCourseGroup(person.facultyCode, person.course, person.groupCode) ?? '')
          : '',
      ),
      filler: !person,
      roomStart: i === 0,
    });
  }
  return rows;
}

/**
 * Собирает печатный документ.
 *
 * Весь этаж — одна страница A4: левый и правый блоки, как в бумажном бланке
 * (601–608 слева, 609–616 справа). Комната не разрывается между блоками.
 */
export function buildRosterDocument(
  roster: FloorRoster,
  options: RosterDocumentOptions = {},
): RosterDocument {
  const floorMinRows = roster.meta.printMinRows;

  const allRooms = roster.rooms;
  const emptyRooms = allRooms.filter((r) => r.people.length === 0);
  const people = allRooms.reduce((sum, r) => sum + r.people.length, 0);

  // Пустой этаж всё равно печатается с комнатами — иначе экспорт бланка бессмысленен.
  const printEmptyRooms = roster.meta.printEmptyRooms || people === 0;

  const visibleRooms = printEmptyRooms
    ? allRooms
    : allRooms.filter((r) => r.people.length > 0);

  const roomChunks = visibleRooms
    .map((room) => ({ room, rows: buildRoomRows(room, floorMinRows, printEmptyRooms) }))
    .filter((chunk) => chunk.rows.length > 0);

  const [left, right] = packTwoColumns(roomChunks);

  const pages: DocumentPage[] =
    left.rows.length === 0 && right.rows.length === 0
      ? [{ pageNumber: 1, left: { rows: [] }, right: { rows: [] } }]
      : [{ pageNumber: 1, left, right }];

  const normalizedPages = pages.map(normalizePage);

  const floorLabel = roster.meta.floorCode ?? String(roster.meta.floorNumber);
  const period = options.academicYear ?? '';

  const subtitleParts = [`общежитие №${roster.meta.dormitoryNumber}`];
  if (period) subtitleParts.push(period);
  if (roster.meta.source === 'snapshot' && roster.meta.rosterVersionNo !== null) {
    subtitleParts.push(`версия состава №${roster.meta.rosterVersionNo}`);
  }

  return {
    title: `Список студентов ${floorLabel} этажа`,
    subtitle: subtitleParts.join(' · '),
    meta: roster.meta,
    headers: ROSTER_HEADERS,
    pages: normalizedPages,
    totalPages: normalizedPages.length,
    stats: {
      people,
      rooms: allRooms.length,
      occupiedRooms: allRooms.length - emptyRooms.length,
      emptyRooms: emptyRooms.length,
      hiddenEmptyRooms: printEmptyRooms ? 0 : emptyRooms.length,
    },
    signature: options.signature ?? null,
    fileBaseName: buildFileBaseName(floorLabel, period, roster.meta),
  };
}

/**
 * Раскладывает комнаты по колонкам страницы.
 *
 * В исходном бланке комнаты делятся ПОПОЛАМ между левым и правым блоком
 * (401–408 слева, 409–416 справа), а не заполняют левый блок доверху.
 * Поэтому сначала считается, сколько колонок нужно, а потом строки
 * распределяются между ними поровну.
 *
 * Комната целиком помещается в одну колонку: разрывать её между блоками
 * нельзя — объединённая ячейка номера комнаты потеряет смысл.
 */
function blankPadRow(): DocumentRow {
  return {
    room: cell(''),
    name: cell(''),
    faculty: cell(''),
    courseGroup: cell(''),
    filler: true,
    roomStart: false,
  };
}

/** Добивает колонку до высоты бланка — без белых дыр на странице. */
function padColumn(column: DocumentColumn, target: number): DocumentColumn {
  if (column.rows.length >= target) return column;
  const extra = Array.from({ length: target - column.rows.length }, blankPadRow);
  return { rows: [...column.rows, ...extra] };
}

function normalizePage(page: DocumentPage): DocumentPage {
  const target = Math.max(page.left.rows.length, page.right.rows.length);
  return {
    ...page,
    left: padColumn(page.left, target),
    right: padColumn(page.right, target),
  };
}

/**
 * Делит комнаты пополам между левым и правым блоками одной страницы.
 * Комната целиком попадает в один блок — объединённые ячейки не рвутся.
 */
function packTwoColumns(
  chunks: Array<{ rows: DocumentRow[] }>,
): [DocumentColumn, DocumentColumn] {
  if (chunks.length === 0) return [{ rows: [] }, { rows: [] }];
  if (chunks.length === 1) return [{ rows: chunks[0]!.rows }, { rows: [] }];

  const mid = Math.ceil(chunks.length / 2);
  return [
    { rows: chunks.slice(0, mid).flatMap((c) => c.rows) },
    { rows: chunks.slice(mid).flatMap((c) => c.rows) },
  ];
}

/**
 * Имя файла собирается из этажа и периода:
 *   Список_6_этажа_2025-2026
 * Для исторической версии добавляется её номер, чтобы файлы не путались.
 */
export function buildFileBaseName(
  floorLabel: string,
  period: string,
  meta: FloorRoster['meta'],
): string {
  const parts = ['Список', `${floorLabel}_этажа`];
  if (period) parts.push(period.replace(/\s+/g, '_'));
  if (meta.source === 'snapshot' && meta.rosterVersionNo !== null) {
    parts.push(`версия_${meta.rosterVersionNo}`);
  }
  return parts.join('_');
}

/** Сумма строк документа — используется тестами и вёрсткой. */
export function totalRows(doc: RosterDocument): number {
  return doc.pages.reduce(
    (sum, page) => sum + page.left.rows.length + page.right.rows.length,
    0,
  );
}
