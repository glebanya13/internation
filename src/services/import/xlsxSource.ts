import ExcelJS from 'exceljs';
import {
  type KnownField,
  type ParsedSource,
  type SourceRow,
  parseCourseGroup,
  parseFullName,
} from '../../domain/import.js';
import { type ImportInput, type ImportSource, recognizeHeader } from './ImportSource.js';

/**
 * Разбор XLSX со списком этажа.
 *
 * Учитывает две особенности реальных документов:
 *
 * 1. Таблица свёрстана в ДВА зеркальных блока колонок, чтобы список
 *    поместился на страницу A4. Заголовки при этом повторяются:
 *    Комната · Фамилия Имя · Факультет · Смена · Курс-группа × 2.
 *    Повторение заголовка трактуется как начало второго блока.
 *
 * 2. Комната и факультет объединены по вертикали на все строки комнаты.
 *    В XLSX значение лежит только в верхней ячейке, остальные пустые,
 *    поэтому значения протягиваются вниз внутри блока.
 */
export class XlsxImportSource implements ImportSource {
  readonly kind = 'xlsx';

  async parse(input: ImportInput): Promise<ParsedSource> {
    if (!input.buffer) throw new Error('Для XLSX-импорта нужен файл');

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(input.buffer as unknown as ArrayBuffer);
    const sheet = workbook.worksheets[0];
    if (!sheet) throw new Error('В файле нет ни одного листа');

    const grid = readGrid(sheet);
    const headerIndex = findHeaderRow(grid);
    if (headerIndex === -1) {
      throw new Error(
        'Не найдена строка заголовков. Ожидались колонки вида «Комната», «Фамилия Имя», «Факультет».',
      );
    }

    const header = grid[headerIndex]!;
    const groups = splitIntoGroups(header);
    const recognizedColumns: ParsedSource['recognizedColumns'] = [];
    const unmappedColumns: string[] = [];

    for (const group of groups) {
      for (const column of group) {
        if (column.field) recognizedColumns.push({ header: column.header, field: column.field });
        else if (column.header) unmappedColumns.push(column.header);
      }
    }

    const rows: SourceRow[] = [];
    const unparsedRows: ParsedSource['unparsedRows'] = [];
    // Протяжка объединённых ячеек ведётся отдельно для каждого блока колонок.
    const carried = groups.map(() => ({
      roomNumber: null as string | null,
      blockCode: null as string | null,
      facultyCode: null as string | null,
    }));

    for (let r = headerIndex + 1; r < grid.length; r += 1) {
      const line = grid[r]!;
      // Номер строки — как в Excel: заголовок на headerIndex, счёт с единицы.
      const rowNumber = r + 1;

      for (const [groupIndex, group] of groups.entries()) {
        const raw: Record<string, string | null> = {};
        const values = new Map<KnownField, string>();

        for (const column of group) {
          const value = line[column.index] ?? null;
          if (column.header) raw[column.header] = value;
          if (column.field && value) values.set(column.field, value);
        }

        const carry = carried[groupIndex]!;
        // Пустая ячейка внутри объединённого диапазона — берём протянутое.
        const roomNumber = values.get('roomNumber') ?? carry.roomNumber;
        const blockCode = values.get('blockCode') ?? carry.blockCode;
        if (values.get('roomNumber')) {
          carry.roomNumber = values.get('roomNumber')!;
          // Новая комната — факультет протягивается заново.
          carry.facultyCode = values.get('facultyCode') ?? null;
        }
        if (values.get('blockCode')) carry.blockCode = values.get('blockCode')!;
        if (values.get('facultyCode')) carry.facultyCode = values.get('facultyCode')!;
        const facultyCode = values.get('facultyCode') ?? carry.facultyCode;

        const name = extractName(values);
        if (!name.lastName && !name.firstName) {
          // Строка без имени — это свободное место в комнате, а не ошибка.
          // Пустые комнаты в бланке выглядят именно так.
          continue;
        }
        if (!name.lastName || !name.firstName) {
          unparsedRows.push({
            rowNumber,
            reason: 'Не удалось разобрать ФИО: нужны как минимум фамилия и имя',
            raw,
          });
          continue;
        }
        if (!roomNumber) {
          unparsedRows.push({ rowNumber, reason: 'Не указана комната', raw });
          continue;
        }

        const courseGroup = extractCourseGroup(values);
        const floorRaw = values.get('floorNumber');
        const floorNumber = floorRaw ? Number.parseInt(floorRaw, 10) : null;

        rows.push({
          rowNumber,
          lastName: name.lastName,
          firstName: name.firstName,
          middleName: name.middleName,
          roomNumber,
          blockCode,
          facultyCode,
          studyShiftCode: values.get('studyShiftCode') ?? null,
          course: courseGroup.course,
          groupCode: courseGroup.groupCode,
          externalStudentId: values.get('externalStudentId') ?? null,
          telegramId: values.get('telegramId') ?? null,
          floorNumber: Number.isFinite(floorNumber) ? floorNumber : null,
          raw,
        });
      }
    }

    return { rows, recognizedColumns, unmappedColumns, unparsedRows };
  }
}

/** Источник для ручного ввода и тестов: строки приходят уже разобранными. */
export class ManualImportSource implements ImportSource {
  readonly kind = 'manual';

  async parse(input: ImportInput): Promise<ParsedSource> {
    const incoming = input.rows ?? [];
    const rows: SourceRow[] = [];
    const unparsedRows: ParsedSource['unparsedRows'] = [];
    const recognized = new Map<string, KnownField>();

    for (const [index, record] of incoming.entries()) {
      const rowNumber = index + 2;
      const values = new Map<KnownField, string>();
      for (const [key, value] of Object.entries(record)) {
        const field = recognizeHeader(key);
        if (field) {
          recognized.set(key, field);
          if (value) values.set(field, value);
        }
      }

      const name = extractName(values);
      if (!name.lastName || !name.firstName) {
        unparsedRows.push({ rowNumber, reason: 'Не удалось разобрать ФИО', raw: record });
        continue;
      }
      const roomNumber = values.get('roomNumber') ?? null;
      if (!roomNumber) {
        unparsedRows.push({ rowNumber, reason: 'Не указана комната', raw: record });
        continue;
      }

      const courseGroup = extractCourseGroup(values);
      const floorRaw = values.get('floorNumber');
      const floorNumber = floorRaw ? Number.parseInt(floorRaw, 10) : null;

      rows.push({
        rowNumber,
        lastName: name.lastName,
        firstName: name.firstName,
        middleName: name.middleName,
        roomNumber,
        blockCode: values.get('blockCode') ?? null,
        facultyCode: values.get('facultyCode') ?? null,
        studyShiftCode: values.get('studyShiftCode') ?? null,
        course: courseGroup.course,
        groupCode: courseGroup.groupCode,
        externalStudentId: values.get('externalStudentId') ?? null,
        telegramId: values.get('telegramId') ?? null,
        floorNumber: Number.isFinite(floorNumber) ? floorNumber : null,
        raw: record,
      });
    }

    const allKeys = new Set(incoming.flatMap((r) => Object.keys(r)));
    return {
      rows,
      recognizedColumns: [...recognized].map(([header, field]) => ({ header, field })),
      unmappedColumns: [...allKeys].filter((k) => !recognized.has(k)),
      unparsedRows,
    };
  }
}

// ───────────────────────────── вспомогательное ─────────────────────────────

function extractName(values: Map<KnownField, string>): {
  lastName: string | null;
  firstName: string | null;
  middleName: string | null;
} {
  const full = values.get('fullName');
  if (full) return parseFullName(full);
  return {
    lastName: values.get('lastName') ?? null,
    firstName: values.get('firstName') ?? null,
    middleName: null,
  };
}

function extractCourseGroup(values: Map<KnownField, string>): {
  course: number | null;
  groupCode: string | null;
} {
  const combined = values.get('courseGroup');
  if (combined) return parseCourseGroup(combined);

  const courseRaw = values.get('course');
  const parsedCourse = courseRaw ? Number.parseInt(courseRaw, 10) : null;
  return {
    course: Number.isFinite(parsedCourse) ? parsedCourse : null,
    groupCode: values.get('groupCode') ?? null,
  };
}

function cellText(value: ExcelJS.CellValue): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    if ('richText' in value && Array.isArray(value.richText)) {
      return value.richText.map((part) => part.text).join('').trim() || null;
    }
    if ('text' in value && typeof value.text === 'string') return value.text.trim() || null;
    if ('result' in value) return cellText(value.result as ExcelJS.CellValue);
  }
  return null;
}

function readGrid(sheet: ExcelJS.Worksheet): Array<Array<string | null>> {
  const grid: Array<Array<string | null>> = [];
  const width = sheet.columnCount;
  sheet.eachRow({ includeEmpty: true }, (row) => {
    const line: Array<string | null> = [];
    for (let c = 1; c <= width; c += 1) line.push(cellText(row.getCell(c).value));
    grid.push(line);
  });
  return grid;
}

/** Заголовком считается первая строка, где узнано не меньше двух колонок. */
function findHeaderRow(grid: Array<Array<string | null>>): number {
  for (const [index, line] of grid.entries()) {
    const recognized = line.filter((cell) => cell && recognizeHeader(cell)).length;
    if (recognized >= 2) return index;
  }
  return -1;
}

interface HeaderColumn {
  index: number;
  header: string;
  field: KnownField | null;
}

/**
 * Делит строку заголовков на блоки колонок. Повторное появление уже
 * встреченного поля означает начало нового зеркального блока.
 */
function splitIntoGroups(header: Array<string | null>): HeaderColumn[][] {
  const groups: HeaderColumn[][] = [];
  let current: HeaderColumn[] = [];
  let seen = new Set<KnownField>();

  header.forEach((cell, index) => {
    if (!cell) return;
    const field = recognizeHeader(cell);

    if (field && seen.has(field)) {
      groups.push(current);
      current = [];
      seen = new Set();
    }
    if (field) seen.add(field);
    current.push({ index, header: cell, field });
  });

  if (current.length > 0) groups.push(current);
  return groups.filter((group) => group.some((c) => c.field));
}
