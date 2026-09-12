import type { KnownField, ParsedSource } from '../../domain/import.js';

/**
 * Источник импорта состава этажа.
 *
 *   ImportSource
 *    ├── XlsxImportSource
 *    ├── CsvImportSource      (позже)
 *    └── ManualImportSource
 *
 * ImportService работает только с этим интерфейсом и ничего не знает
 * ни про Excel, ни про разделители: список этажа может приходить откуда
 * угодно, и добавление формата не должно трогать логику diff и Apply.
 */
export interface ImportSource {
  /** Понятное администратору название формата. */
  readonly kind: string;
  parse(input: ImportInput): Promise<ParsedSource>;
}

export interface ImportInput {
  /** Содержимое файла. Для ручного ввода не используется. */
  buffer?: Buffer;
  fileName?: string;
  /** Готовые строки — для ManualImportSource и тестов. */
  rows?: Array<Record<string, string | null>>;
}

/**
 * Синонимы заголовков колонок. Список открыт: незнакомый заголовок
 * не роняет импорт, а попадает в unmappedColumns и показывается
 * администратору для ручного сопоставления.
 */
export const HEADER_ALIASES: Array<{ field: KnownField; patterns: RegExp }> = [
  { field: 'roomNumber', patterns: /^(комната|№\s*комнаты|номер\s*комнаты|room)$/i },
  { field: 'blockCode', patterns: /^(блок|block)$/i },
  { field: 'fullName', patterns: /^(фамилия\s*имя|фио|ф\.?\s*и\.?\s*о\.?|name)$/i },
  { field: 'lastName', patterns: /^(фамилия|last\s*name|surname)$/i },
  { field: 'firstName', patterns: /^(имя|first\s*name)$/i },
  { field: 'facultyCode', patterns: /^(факультет|faculty)$/i },
  { field: 'studyShiftCode', patterns: /^(смена|учебная\s*смена|shift)$/i },
  { field: 'courseGroup', patterns: /^(курс\s*[-–—]?\s*группа|курс\/группа)$/i },
  { field: 'course', patterns: /^(курс|course)$/i },
  { field: 'groupCode', patterns: /^(группа|group)$/i },
  { field: 'floorNumber', patterns: /^(этаж|floor)$/i },
  { field: 'telegramId', patterns: /^(telegram\s*id|телеграм\s*id|tg\s*id)$/i },
  { field: 'externalStudentId', patterns: /^(id|student\s*id|идентификатор|код\s*студента)$/i },
];

export function recognizeHeader(header: string): KnownField | null {
  const normalized = header.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  for (const alias of HEADER_ALIASES) {
    if (alias.patterns.test(normalized)) return alias.field;
  }
  return null;
}
