/**
 * Соответствие номера группы и факультета в общежитии.
 *
 * Группы 1–3 → ИСИТ, 4–5 → ЦД, 6–10 → ПИ.
 * В students.group_code хранится только номер группы («2», «9»).
 * Курс — отдельно в students.course. Для печати «курс-группа» см. formatCourseGroup.
 */

export type FacultyCode = 'ИСИТ' | 'ЦД' | 'ПИ';

export function facultyForGroup(groupNo: number): FacultyCode {
  if (groupNo >= 1 && groupNo <= 3) return 'ИСИТ';
  if (groupNo >= 4 && groupNo <= 5) return 'ЦД';
  if (groupNo >= 6 && groupNo <= 10) return 'ПИ';
  throw new Error(`Неизвестный номер группы: ${groupNo}`);
}

/** Только номер группы (курс хранится отдельно). */
export function formatGroupCode(_course: number, groupNo: number): string {
  return String(groupNo);
}

/**
 * Для отображения: если в group_code ошибочно лежит «2-2»,
 * вернуть только группу («2»). Иначе как есть.
 */
export function displayGroupNumber(groupCode: string | null | undefined): string {
  if (!groupCode || groupCode === '—') return '—';
  const match = /^(\d+)\s*[-–—]\s*(.+)$/.exec(groupCode.trim());
  return match ? match[2]!.trim() : groupCode.trim();
}
