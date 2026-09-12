import { type ScheduleSlot, intervalsOverlap } from './calendar.js';

/**
 * Кандидаты, правила и проверка доступности.
 *
 * Кандидат — всегда СТУДЕНТ. Комната в математике распределения
 * не участвует: 605А с тремя жильцами и 605Б с двумя не получают
 * разное число дежурств «как комнаты».
 */

export interface StudyShiftInfo {
  id: string;
  code: string;
  /** NULL — учебное время не задано, ограничение не применяется. */
  busyFrom: string | null;
  busyTo: string | null;
  busyWeekdays: number[];
}

export interface Candidate {
  studentId: string;
  floorId: string;
  displayName: string;
  roomNumber: string;
  studyShift: StudyShiftInfo | null;
  /** Согласие дежурить в учебное время. */
  allowBusySlots: boolean;
  /** Нагрузка в предыдущем месяце — для переноса баланса. */
  previousLoad: number;
}

export type StudyShiftMode = 'ignore' | 'prefer_free' | 'block_on_overlap' | 'require_consent';

export interface DutyRules {
  maxDutiesPerDay: number;
  minDaysBetween: number;
  studyShiftMode: StudyShiftMode;
  balanceBySlot: boolean;
  carryOverBalance: boolean;
  allowQuotaOverflow: boolean;
  maxLoadSpread: number;
  /** Староста (role = elder) не получает дежурства. */
  elderExempt: boolean;
  excludedDates: string[];
}

export const DEFAULT_RULES: DutyRules = {
  maxDutiesPerDay: 1,
  minDaysBetween: 3,
  studyShiftMode: 'block_on_overlap',
  balanceBySlot: true,
  carryOverBalance: true,
  allowQuotaOverflow: false,
  maxLoadSpread: 1,
  elderExempt: false,
  excludedDates: [],
};

export function parseRules(settings: unknown): DutyRules {
  const raw = (settings ?? {}) as Record<string, unknown>;
  const num = (key: string, fallback: number): number =>
    typeof raw[key] === 'number' ? (raw[key] as number) : fallback;
  const bool = (key: string, fallback: boolean): boolean =>
    typeof raw[key] === 'boolean' ? (raw[key] as boolean) : fallback;

  const mode = raw['study_shift_mode'];
  return {
    maxDutiesPerDay: num('max_duties_per_day', DEFAULT_RULES.maxDutiesPerDay),
    minDaysBetween: num('min_days_between', DEFAULT_RULES.minDaysBetween),
    studyShiftMode: isMode(mode) ? mode : DEFAULT_RULES.studyShiftMode,
    balanceBySlot: bool('balance_by_slot', DEFAULT_RULES.balanceBySlot),
    carryOverBalance: bool('carry_over_balance', DEFAULT_RULES.carryOverBalance),
    allowQuotaOverflow: bool('allow_quota_overflow', DEFAULT_RULES.allowQuotaOverflow),
    maxLoadSpread: num('max_load_spread', DEFAULT_RULES.maxLoadSpread),
    elderExempt: bool('elder_exempt', DEFAULT_RULES.elderExempt),
    excludedDates: Array.isArray(raw['excluded_dates'])
      ? (raw['excluded_dates'] as string[])
      : [],
  };
}

function isMode(value: unknown): value is StudyShiftMode {
  return (
    value === 'ignore' ||
    value === 'prefer_free' ||
    value === 'block_on_overlap' ||
    value === 'require_consent'
  );
}

/**
 * Пересекается ли слот с учебным временем студента.
 *
 * Если учебное время не задано, ответ «нет» — часы учёбы не выдумываются.
 * Вместо этого генератор выдаёт предупреждение, что ограничение не применялось.
 */
export function overlapsStudy(candidate: Candidate, slot: ScheduleSlot): boolean {
  const shift = candidate.studyShift;
  if (!shift?.busyFrom || !shift.busyTo) return false;
  if (!shift.busyWeekdays.includes(slot.weekday)) return false;
  return intervalsOverlap(slot.timeFrom, slot.timeTo, shift.busyFrom, shift.busyTo);
}

/**
 * HARD-ограничение доступности: может ли студент в принципе занять слот.
 *
 * Проверяется до распределения и не ослабляется никогда — в отличие
 * от soft-предпочтений, которые генератор может нарушить, если иначе
 * график не построить.
 */
export function isAvailable(
  candidate: Candidate,
  slot: ScheduleSlot,
  rules: DutyRules,
): boolean {
  if (!overlapsStudy(candidate, slot)) return true;

  switch (rules.studyShiftMode) {
    case 'ignore':
    case 'prefer_free':
      return true; // мягкий режим: пересечение штрафуется, но не запрещает
    case 'block_on_overlap':
      return false;
    case 'require_consent':
      return candidate.allowBusySlots;
  }
}

export interface Assignment {
  slotIndex: number;
  date: string;
  slotOrder: number;
  timeFrom: string;
  timeTo: string;
  studentId: string | null;
}

/** Учебные смены без заданного времени — повод для предупреждения. */
export function shiftsWithoutSchedule(candidates: readonly Candidate[]): string[] {
  const codes = new Set<string>();
  for (const candidate of candidates) {
    const shift = candidate.studyShift;
    if (shift && (!shift.busyFrom || !shift.busyTo)) codes.add(shift.code);
  }
  return [...codes].sort();
}

/**
 * Проверка HARD-конфликта по времени: у одного студента не может быть
 * двух пересекающихся дежурств.
 */
export function conflictsInTime(
  existing: readonly Assignment[],
  slot: ScheduleSlot,
): boolean {
  return existing.some(
    (a) =>
      a.date === slot.date &&
      intervalsOverlap(a.timeFrom, a.timeTo, slot.timeFrom, slot.timeTo),
  );
}
