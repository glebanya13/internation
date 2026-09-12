/**
 * Различие между изменением СОСТАВА и изменением АТРИБУТОВ.
 *
 * Это различие — не деталь реализации, а архитектурное правило:
 * состав определяет, кто попадёт в новый график, атрибуты — только то,
 * как студент выглядит в списке. Поэтому первое создаёт новую версию
 * roster, второе идёт в audit_log.
 */

/** Поля студента, изменение которых меняет состав этажа. */
export const COMPOSITION_FIELDS = ['floor_id', 'room_id', 'status'] as const;

/**
 * Поля, изменение которых состав не меняет: студент остаётся тем же
 * жильцом того же этажа. Новая версия roster не создаётся.
 */
export const ATTRIBUTE_FIELDS = [
  'last_name',
  'first_name',
  'middle_name',
  'faculty_id',
  'study_shift_id',
  'course',
  'group_code',
  'telegram_id',
  'telegram_username',
  'phone',
  'role',
  'sort_order',
  'allow_busy_slots',
  'exempt_from',
  'exempt_to',
] as const;

export type CompositionField = (typeof COMPOSITION_FIELDS)[number];
export type AttributeField = (typeof ATTRIBUTE_FIELDS)[number];

const compositionSet: ReadonlySet<string> = new Set(COMPOSITION_FIELDS);

/**
 * Операции, меняющие состав:
 *   добавление · заселение · переселение в комнату или блок ·
 *   перевод на другой этаж · деактивация · импорт, изменивший состав.
 *
 * Операции, не меняющие состав:
 *   опечатка в ФИО · telegram_id · факультет · курс · группа ·
 *   учебная смена · прочие атрибуты.
 */
export function isCompositionChange(changedFields: Iterable<string>): boolean {
  for (const field of changedFields) {
    if (compositionSet.has(field)) return true;
  }
  return false;
}

/** Разделяет патч на две части, чтобы вызывающий не решал это на глаз. */
export function splitPatch<T extends Record<string, unknown>>(
  patch: T,
): { composition: Partial<T>; attributes: Partial<T> } {
  const composition: Record<string, unknown> = {};
  const attributes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (compositionSet.has(key)) composition[key] = value;
    else attributes[key] = value;
  }
  return { composition: composition as Partial<T>, attributes: attributes as Partial<T> };
}

export type RosterStatus = 'draft' | 'confirmed' | 'superseded';
export type RosterSource = 'setup' | 'manual' | 'import';
export type StudentStatus = 'active' | 'suspended' | 'moved_out';

export interface RosterVersion {
  id: string;
  floor_id: string;
  version_no: number;
  status: RosterStatus;
  source: RosterSource;
  effective_from: string;
  note: string | null;
  change_summary: RosterChangeSummary | null;
  confirmed_at: string | null;
}

export interface RosterEntry {
  id: string;
  roster_version_id: string;
  floor_id: string;
  student_id: string;
  full_name_snapshot: string;
  room_id: string;
  room_number_snapshot: string;
  block_code_snapshot: string | null;
  faculty_code_snapshot: string | null;
  study_shift_code_snapshot: string | null;
  course_snapshot: number | null;
  group_code_snapshot: string | null;
  student_status_snapshot: StudentStatus;
  sort_order: number;
}

export interface RosterChangeSummary {
  added: Array<{ student_id: string; name: string; room: string }>;
  removed: Array<{ student_id: string; name: string; room: string }>;
  relocated: Array<{ student_id: string; name: string; from: string; to: string }>;
  status_changed: Array<{ student_id: string; name: string; from: string; to: string }>;
}

export function emptyChangeSummary(): RosterChangeSummary {
  return { added: [], removed: [], relocated: [], status_changed: [] };
}

export function isEmptySummary(summary: RosterChangeSummary): boolean {
  return (
    summary.added.length === 0 &&
    summary.removed.length === 0 &&
    summary.relocated.length === 0 &&
    summary.status_changed.length === 0
  );
}

/**
 * Сравнивает состав двух версий. Используется и при обычной правке,
 * и при импорте — чтобы решить, действительно ли состав изменился.
 */
export function diffComposition(
  previous: readonly RosterEntry[],
  next: readonly RosterEntry[],
): RosterChangeSummary {
  const summary = emptyChangeSummary();
  const before = new Map(previous.map((e) => [e.student_id, e]));
  const after = new Map(next.map((e) => [e.student_id, e]));

  for (const entry of next) {
    const old = before.get(entry.student_id);
    if (!old) {
      summary.added.push({
        student_id: entry.student_id,
        name: entry.full_name_snapshot,
        room: entry.room_number_snapshot,
      });
      continue;
    }
    if (old.room_id !== entry.room_id) {
      summary.relocated.push({
        student_id: entry.student_id,
        name: entry.full_name_snapshot,
        from: old.room_number_snapshot,
        to: entry.room_number_snapshot,
      });
    }
    if (old.student_status_snapshot !== entry.student_status_snapshot) {
      summary.status_changed.push({
        student_id: entry.student_id,
        name: entry.full_name_snapshot,
        from: old.student_status_snapshot,
        to: entry.student_status_snapshot,
      });
    }
  }

  for (const entry of previous) {
    if (!after.has(entry.student_id)) {
      summary.removed.push({
        student_id: entry.student_id,
        name: entry.full_name_snapshot,
        room: entry.room_number_snapshot,
      });
    }
  }

  return summary;
}
