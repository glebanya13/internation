/**
 * Предметная область импорта состава этажа.
 *
 * Здесь нет ни обращений к БД, ни знания про XLSX: только нормализация,
 * сопоставление студентов и вычисление diff. Благодаря этому один и тот же
 * код обслуживает любой ImportSource — XLSX, CSV или ручной ввод.
 */

/** Строка, как её отдал источник импорта, до сопоставления с базой. */
export interface SourceRow {
  /** Номер строки в исходном файле — нужен для сообщений администратору. */
  rowNumber: number;
  lastName: string | null;
  firstName: string | null;
  middleName: string | null;
  roomNumber: string | null;
  blockCode: string | null;
  facultyCode: string | null;
  studyShiftCode: string | null;
  course: number | null;
  groupCode: string | null;
  /** Устойчивые идентификаторы, если источник их содержит. */
  externalStudentId: string | null;
  telegramId: string | null;
  /** Этаж, если он указан в файле явно. */
  floorNumber: number | null;
  /** Исходные значения — показываются администратору при разборе проблем. */
  raw: Record<string, string | null>;
}

/** Результат разбора файла источником. */
export interface ParsedSource {
  rows: SourceRow[];
  /** Колонки, которые система узнала автоматически. */
  recognizedColumns: Array<{ header: string; field: KnownField }>;
  /** Колонки, назначение которых определить не удалось. */
  unmappedColumns: string[];
  /** Строки, которые не удалось разобрать вовсе. */
  unparsedRows: Array<{ rowNumber: number; reason: string; raw: Record<string, string | null> }>;
}

export type KnownField =
  | 'lastName'
  | 'firstName'
  | 'fullName'
  | 'roomNumber'
  | 'blockCode'
  | 'facultyCode'
  | 'studyShiftCode'
  | 'course'
  | 'groupCode'
  | 'courseGroup'
  | 'externalStudentId'
  | 'telegramId'
  | 'floorNumber';

/** Текущий студент этажа, как он известен базе. */
export interface ExistingStudent {
  studentId: string;
  lastName: string;
  firstName: string;
  middleName: string | null;
  roomId: string;
  roomNumber: string;
  blockCode: string | null;
  facultyCode: string | null;
  studyShiftCode: string | null;
  course: number | null;
  groupCode: string | null;
  telegramId: string | null;
  status: 'active' | 'suspended' | 'moved_out';
}

// ─────────────────────────── нормализация ───────────────────────────

/**
 * Приводит текст к сравнимому виду: убирает лишние пробелы, регистр
 * и различие е/ё, из-за которого «Артём» и «Артем» считались бы разными людьми.
 */
export function normalizeText(value: string | null | undefined): string {
  if (!value) return '';
  return value
    .replace(/ /g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/ё/g, 'е');
}

/**
 * Номер комнаты. Регистр и пробелы не значимы, но буква значима:
 * 605А и 605Б — разные комнаты.
 */
export function normalizeRoom(value: string | null | undefined): string {
  if (!value) return '';
  return value.replace(/\s+/g, '').toUpperCase();
}

/**
 * Разбирает «Фамилия Имя» и «Фамилия Имя Отчество».
 * В исходных документах отчества нет, но форма графика печатает «Ф.И.О»,
 * поэтому третья часть поддерживается.
 */
export function parseFullName(value: string | null | undefined): {
  lastName: string | null;
  firstName: string | null;
  middleName: string | null;
} {
  const parts = (value ?? '')
    .replace(/ /g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return {
    lastName: parts[0] ?? null,
    firstName: parts[1] ?? null,
    middleName: parts.length > 2 ? parts.slice(2).join(' ') : null,
  };
}

/** «2-1/2» → курс 2, группа «1/2». «4-10» → курс 4, группа «10». */
export function parseCourseGroup(value: string | null | undefined): {
  course: number | null;
  groupCode: string | null;
} {
  const text = (value ?? '').trim();
  if (!text) return { course: null, groupCode: null };
  const match = /^(\d+)\s*[-–—]\s*(.+)$/.exec(text);
  if (!match) {
    const asNumber = Number(text);
    return Number.isInteger(asNumber) && asNumber > 0
      ? { course: asNumber, groupCode: null }
      : { course: null, groupCode: text };
  }
  return { course: Number(match[1]), groupCode: match[2]!.trim() };
}

// ─────────────────────────── сопоставление ───────────────────────────

export type MatchMethod =
  | 'external_id'
  | 'telegram_id'
  | 'name_and_room'
  | 'unique_name'
  | 'none';

export interface MatchResult {
  row: SourceRow;
  studentId: string | null;
  method: MatchMethod;
  /** Кандидаты, если однозначно сопоставить не удалось. */
  candidates: ExistingStudent[];
}

function nameKey(s: {
  lastName: string | null;
  firstName: string | null;
  middleName: string | null;
}): string {
  return [s.lastName, s.firstName, s.middleName].map(normalizeText).join('|');
}

/**
 * Сопоставляет строки файла со студентами базы.
 *
 * Порядок стратегий задан требованием: сначала устойчивые идентификаторы,
 * потом комбинация нормализованных данных, и только затем — имя целиком.
 * Совпадение по одному ФИО НИКОГДА не считается достаточным, если таких
 * ФИО больше одного: такие строки уходят администратору на решение.
 */
export function matchRows(
  rows: readonly SourceRow[],
  existing: readonly ExistingStudent[],
): MatchResult[] {
  const byExternal = new Map<string, ExistingStudent>();
  const byTelegram = new Map<string, ExistingStudent>();
  const byNameRoom = new Map<string, ExistingStudent[]>();
  const byName = new Map<string, ExistingStudent[]>();

  for (const student of existing) {
    byExternal.set(student.studentId, student);
    if (student.telegramId) byTelegram.set(student.telegramId, student);

    const nk = nameKey(student);
    const nrk = `${nk}#${normalizeRoom(student.roomNumber)}`;
    byNameRoom.set(nrk, [...(byNameRoom.get(nrk) ?? []), student]);
    byName.set(nk, [...(byName.get(nk) ?? []), student]);
  }

  const taken = new Set<string>();
  const results: MatchResult[] = [];

  const claim = (row: SourceRow, student: ExistingStudent, method: MatchMethod): MatchResult => {
    taken.add(student.studentId);
    return { row, studentId: student.studentId, method, candidates: [] };
  };

  // Проход 1 — устойчивые идентификаторы.
  const unresolved: SourceRow[] = [];
  for (const row of rows) {
    const byId = row.externalStudentId ? byExternal.get(row.externalStudentId) : undefined;
    if (byId && !taken.has(byId.studentId)) {
      results.push(claim(row, byId, 'external_id'));
      continue;
    }
    const byTg = row.telegramId ? byTelegram.get(row.telegramId) : undefined;
    if (byTg && !taken.has(byTg.studentId)) {
      results.push(claim(row, byTg, 'telegram_id'));
      continue;
    }
    unresolved.push(row);
  }

  // Проход 2 — ФИО вместе с комнатой.
  const stillUnresolved: SourceRow[] = [];
  for (const row of unresolved) {
    const key = `${nameKey(row)}#${normalizeRoom(row.roomNumber)}`;
    const free = (byNameRoom.get(key) ?? []).filter((s) => !taken.has(s.studentId));
    if (free.length === 1) {
      results.push(claim(row, free[0]!, 'name_and_room'));
    } else if (free.length > 1) {
      // Два одинаковых ФИО в одной комнате — решает человек.
      results.push({ row, studentId: null, method: 'none', candidates: free });
    } else {
      stillUnresolved.push(row);
    }
  }

  // Проход 3 — только ФИО, и только если оно единственное.
  for (const row of stillUnresolved) {
    const free = (byName.get(nameKey(row)) ?? []).filter((s) => !taken.has(s.studentId));
    if (free.length === 1) {
      results.push(claim(row, free[0]!, 'unique_name'));
    } else if (free.length > 1) {
      results.push({ row, studentId: null, method: 'none', candidates: free });
    } else {
      results.push({ row, studentId: null, method: 'none', candidates: [] });
    }
  }

  return results.sort((a, b) => a.row.rowNumber - b.row.rowNumber);
}

// ─────────────────────────────── diff ───────────────────────────────

export interface AttributeChange {
  field: string;
  label: string;
  before: string | null;
  after: string | null;
}

export interface DiffAdded {
  rowNumber: number;
  name: string;
  roomNumber: string;
  facultyCode: string | null;
  courseGroup: string | null;
}

export interface DiffRemoved {
  studentId: string;
  name: string;
  roomNumber: string;
  /** Что сделать: решает администратор, значения по умолчанию нет. */
  requiresDecision: true;
}

export interface DiffRelocated {
  studentId: string;
  rowNumber: number;
  name: string;
  fromRoom: string;
  toRoom: string;
  /** Атрибуты, изменившиеся заодно с переселением. */
  attributes: AttributeChange[];
}

export interface DiffAttributesOnly {
  studentId: string;
  rowNumber: number;
  name: string;
  roomNumber: string;
  attributes: AttributeChange[];
}

export interface DiffAmbiguous {
  rowNumber: number;
  name: string;
  roomNumber: string | null;
  candidates: Array<{ studentId: string; name: string; roomNumber: string }>;
  requiresDecision: true;
}

export interface DiffForeignFloor {
  rowNumber: number;
  name: string;
  roomNumber: string | null;
  declaredFloor: number;
  targetFloor: number;
  requiresDecision: true;
}

export interface ImportDiff {
  added: DiffAdded[];
  removed: DiffRemoved[];
  relocated: DiffRelocated[];
  attributesOnly: DiffAttributesOnly[];
  unchanged: Array<{ studentId: string; name: string }>;
  ambiguous: DiffAmbiguous[];
  foreignFloor: DiffForeignFloor[];
  unparsed: Array<{ rowNumber: number; reason: string }>;
}

export function emptyDiff(): ImportDiff {
  return {
    added: [],
    removed: [],
    relocated: [],
    attributesOnly: [],
    unchanged: [],
    ambiguous: [],
    foreignFloor: [],
    unparsed: [],
  };
}

const ATTRIBUTE_LABELS: Array<[keyof ExistingStudent, string]> = [
  ['lastName', 'Фамилия'],
  ['firstName', 'Имя'],
  ['middleName', 'Отчество'],
  ['facultyCode', 'Факультет'],
  ['studyShiftCode', 'Учебная смена'],
  ['course', 'Курс'],
  ['groupCode', 'Группа'],
];

function compareAttributes(before: ExistingStudent, row: SourceRow): AttributeChange[] {
  const after: Partial<Record<keyof ExistingStudent, string | number | null>> = {
    lastName: row.lastName,
    firstName: row.firstName,
    middleName: row.middleName,
    facultyCode: row.facultyCode,
    studyShiftCode: row.studyShiftCode,
    course: row.course,
    groupCode: row.groupCode,
  };

  const changes: AttributeChange[] = [];
  for (const [field, label] of ATTRIBUTE_LABELS) {
    const next = after[field];
    // Пустое значение в файле трактуем как «не указано», а не как «стереть»:
    // в реальных списках колонки бывают заполнены не до конца.
    if (next === null || next === undefined || next === '') continue;

    const prev = before[field] as string | number | null;
    if (normalizeText(String(prev ?? '')) !== normalizeText(String(next))) {
      changes.push({
        field: field as string,
        label,
        before: prev === null || prev === undefined ? null : String(prev),
        after: String(next),
      });
    }
  }
  return changes;
}

/**
 * Строит diff между текущим составом и содержимым файла.
 *
 * Ключевое разделение: переселение — изменение СОСТАВА, смена факультета,
 * курса, группы или учебной смены при той же комнате — изменение АТРИБУТОВ.
 * Первое потребует новой версии roster, второе нет.
 */
export function buildDiff(options: {
  matches: readonly MatchResult[];
  existing: readonly ExistingStudent[];
  targetFloorNumber: number;
  unparsed?: ParsedSource['unparsedRows'];
}): ImportDiff {
  const { matches, existing, targetFloorNumber } = options;
  const diff = emptyDiff();
  const byId = new Map(existing.map((s) => [s.studentId, s]));
  const seen = new Set<string>();

  for (const match of matches) {
    const { row } = match;
    const displayName =
      [row.lastName, row.firstName, row.middleName].filter(Boolean).join(' ') || '(без имени)';

    // Записи чужого этажа не применяются и этаж не исправляется автоматически.
    if (row.floorNumber !== null && row.floorNumber !== targetFloorNumber) {
      diff.foreignFloor.push({
        rowNumber: row.rowNumber,
        name: displayName,
        roomNumber: row.roomNumber,
        declaredFloor: row.floorNumber,
        targetFloor: targetFloorNumber,
        requiresDecision: true,
      });
      continue;
    }

    if (match.candidates.length > 0) {
      diff.ambiguous.push({
        rowNumber: row.rowNumber,
        name: displayName,
        roomNumber: row.roomNumber,
        candidates: match.candidates.map((c) => ({
          studentId: c.studentId,
          name: `${c.lastName} ${c.firstName}`,
          roomNumber: c.roomNumber,
        })),
        requiresDecision: true,
      });
      continue;
    }

    if (!match.studentId) {
      diff.added.push({
        rowNumber: row.rowNumber,
        name: displayName,
        roomNumber: row.roomNumber ?? '',
        facultyCode: row.facultyCode,
        courseGroup:
          row.course !== null || row.groupCode
            ? `${row.course ?? ''}${row.groupCode ? `-${row.groupCode}` : ''}`
            : null,
      });
      continue;
    }

    const before = byId.get(match.studentId);
    if (!before) continue;
    seen.add(before.studentId);

    const attributes = compareAttributes(before, row);
    const roomChanged =
      row.roomNumber !== null &&
      normalizeRoom(row.roomNumber) !== normalizeRoom(before.roomNumber);

    if (roomChanged) {
      diff.relocated.push({
        studentId: before.studentId,
        rowNumber: row.rowNumber,
        name: displayName,
        fromRoom: before.roomNumber,
        toRoom: row.roomNumber!,
        attributes,
      });
    } else if (attributes.length > 0) {
      diff.attributesOnly.push({
        studentId: before.studentId,
        rowNumber: row.rowNumber,
        name: displayName,
        roomNumber: before.roomNumber,
        attributes,
      });
    } else {
      diff.unchanged.push({
        studentId: before.studentId,
        name: `${before.lastName} ${before.firstName}`,
      });
    }
  }

  // Исчезнувшие. Автоматически НЕ удаляются и НЕ деактивируются.
  for (const student of existing) {
    if (seen.has(student.studentId)) continue;
    diff.removed.push({
      studentId: student.studentId,
      name: `${student.lastName} ${student.firstName}`,
      roomNumber: student.roomNumber,
      requiresDecision: true,
    });
  }

  diff.unparsed = (options.unparsed ?? []).map((u) => ({
    rowNumber: u.rowNumber,
    reason: u.reason,
  }));

  return diff;
}

/**
 * Изменится ли СОСТАВ, если применить этот diff с такими решениями.
 *
 * Смена факультета, курса, группы, учебной смены и опечатка в ФИО
 * состав не меняют — новая версия roster не потребуется.
 */
export function diffChangesComposition(
  diff: ImportDiff,
  decisions: ImportDecisions = {},
): boolean {
  if (diff.added.length > 0) return true;
  if (diff.relocated.length > 0) return true;

  // Исчезнувший студент меняет состав, только если решено деактивировать.
  for (const removed of diff.removed) {
    if (decisions.removed?.[removed.studentId] === 'deactivate') return true;
  }
  // Разрешённая неоднозначность может добавить нового студента.
  for (const ambiguous of diff.ambiguous) {
    if (decisions.ambiguous?.[ambiguous.rowNumber] === 'create_new') return true;
  }
  return false;
}

export type RemovedDecision = 'deactivate' | 'keep_active' | 'skip';
export type AmbiguousDecision = string | 'create_new' | 'skip';

export interface ImportDecisions {
  /** studentId → что сделать с исчезнувшим студентом. */
  removed?: Record<string, RemovedDecision>;
  /** rowNumber → studentId выбранного кандидата, либо create_new / skip. */
  ambiguous?: Record<number, AmbiguousDecision>;
  /** rowNumber → применять ли строку чужого этажа. Всегда явное решение. */
  foreignFloor?: Record<number, 'skip'>;
}

export interface ImportSummary {
  currentRosterSize: number;
  added: number;
  relocated: number;
  attributesOnly: number;
  removed: number;
  unchanged: number;
  ambiguous: number;
  foreignFloor: number;
  unparsed: number;
  /** Итоговый размер состава, если применить с текущими решениями. */
  projectedRosterSize: number;
  compositionChanges: boolean;
}

export function summarize(
  diff: ImportDiff,
  currentRosterSize: number,
  decisions: ImportDecisions = {},
): ImportSummary {
  const deactivated = diff.removed.filter(
    (r) => decisions.removed?.[r.studentId] === 'deactivate',
  ).length;
  const createdFromAmbiguous = diff.ambiguous.filter(
    (a) => decisions.ambiguous?.[a.rowNumber] === 'create_new',
  ).length;

  return {
    currentRosterSize,
    added: diff.added.length,
    relocated: diff.relocated.length,
    attributesOnly: diff.attributesOnly.length,
    removed: diff.removed.length,
    unchanged: diff.unchanged.length,
    ambiguous: diff.ambiguous.length,
    foreignFloor: diff.foreignFloor.length,
    unparsed: diff.unparsed.length,
    projectedRosterSize:
      currentRosterSize + diff.added.length + createdFromAmbiguous - deactivated,
    compositionChanges: diffChangesComposition(diff, decisions),
  };
}

/** Решения, без которых Apply запускать нельзя. */
export function pendingDecisions(diff: ImportDiff, decisions: ImportDecisions = {}): string[] {
  const missing: string[] = [];
  for (const removed of diff.removed) {
    if (!decisions.removed?.[removed.studentId]) {
      missing.push(`Исчезнувший студент ${removed.name} (${removed.roomNumber}) — нужно решение`);
    }
  }
  for (const ambiguous of diff.ambiguous) {
    if (!decisions.ambiguous?.[ambiguous.rowNumber]) {
      missing.push(
        `Строка ${ambiguous.rowNumber}: ${ambiguous.name} — несколько подходящих студентов`,
      );
    }
  }
  for (const foreign of diff.foreignFloor) {
    if (!decisions.foreignFloor?.[foreign.rowNumber]) {
      missing.push(
        `Строка ${foreign.rowNumber}: ${foreign.name} относится к ${foreign.declaredFloor} этажу`,
      );
    }
  }
  return missing;
}
