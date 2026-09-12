import type { ScheduleSlot } from './calendar.js';
import { type Candidate, type DutyRules, isAvailable, shiftsWithoutSchedule } from './duty.js';

/**
 * Проверка выполнимости до генерации.
 *
 * Смысл: не строить заведомо плохой график, а объяснить администратору,
 * какое ограничение делает задачу нерешаемой и что можно смягчить.
 */

export interface SlotGroupReport {
  label: string;
  slots: number;
  candidates: number;
  maxDuties: number;
  deficit: number;
}

export interface FeasibilityReport {
  feasible: boolean;
  totalSlots: number;
  totalStudents: number;
  availableStudents: number;
  /** Слоты, на которые нет ни одного допустимого кандидата. */
  blockedSlots: Array<{ date: string; slotOrder: number; timeFrom: string; timeTo: string }>;
  averagePerStudent: number;
  minQuota: number;
  maxQuota: number;
  groups: SlotGroupReport[];
  reasons: string[];
  warnings: string[];
  suggestions: string[];
}

/** Максимум дежурств на ОДНОГО СТУДЕНТА при текущих правилах. */
function maxDutiesPerStudent(
  totalSlots: number,
  students: number,
  rules: DutyRules,
): number {
  if (students === 0) return 0;
  const quota = Math.ceil(totalSlots / students);
  return rules.allowQuotaOverflow ? totalSlots : quota + rules.maxLoadSpread;
}

/**
 * Условие Холла на подмножествах, порождённых слотами.
 *
 * Слоты группируются по одинаковому множеству допустимых кандидатов.
 * Для каждой группы берётся объединение её кандидатов и считается,
 * сколько слотов вообще может быть закрыто только этими людьми.
 * Так ловится основной практический случай: утренние смены доступны
 * лишь части студентов.
 */
function checkGroups(
  slots: readonly ScheduleSlot[],
  eligible: Map<number, Candidate[]>,
  rules: DutyRules,
  perStudent: number,
): SlotGroupReport[] {
  const signatureOf = (slot: ScheduleSlot): string =>
    (eligible.get(slot.index) ?? [])
      .map((c) => c.studentId)
      .sort()
      .join(',');

  const groups = new Map<string, ScheduleSlot[]>();
  for (const slot of slots) {
    const key = signatureOf(slot);
    groups.set(key, [...(groups.get(key) ?? []), slot]);
  }

  const reports: SlotGroupReport[] = [];
  for (const [signature, groupSlots] of groups) {
    const members = new Set(signature ? signature.split(',') : []);
    if (members.size === 0) continue; // пустые группы — отдельная ветка

    // Все слоты, которые могут быть закрыты ТОЛЬКО этими людьми.
    const demand = slots.filter((slot) => {
      const candidates = eligible.get(slot.index) ?? [];
      return candidates.length > 0 && candidates.every((c) => members.has(c.studentId));
    }).length;

    const maxDuties = members.size * perStudent;
    if (demand > maxDuties) {
      reports.push({
        label: describeGroup(groupSlots),
        slots: demand,
        candidates: members.size,
        maxDuties,
        deficit: demand - maxDuties,
      });
    }
  }

  // Одинаковые дефициты схлопываются: один и тот же перекос не должен
  // повторяться в отчёте десять раз.
  const unique = new Map<string, SlotGroupReport>();
  for (const report of reports) {
    const key = `${report.label}|${report.slots}|${report.candidates}`;
    if (!unique.has(key)) unique.set(key, report);
  }
  return [...unique.values()].sort((a, b) => b.deficit - a.deficit);
}

function describeGroup(slots: readonly ScheduleSlot[]): string {
  const times = new Set(slots.map((s) => `${s.timeFrom}–${s.timeTo}`));
  const list = [...times].sort();
  const weekdayKinds = new Set(slots.map((s) => (s.weekday === 7 ? 'воскресенье' : 'будни')));
  const when = [...weekdayKinds].join(' и ');
  return list.length <= 2
    ? `${list.join(', ')} (${when})`
    : `${list.length} интервалов (${when})`;
}

export function checkFeasibility(options: {
  slots: readonly ScheduleSlot[];
  candidates: readonly Candidate[];
  rules: DutyRules;
  rosterSize: number;
}): FeasibilityReport {
  const { slots, candidates, rules, rosterSize } = options;

  const reasons: string[] = [];
  const warnings: string[] = [];
  const suggestions: string[] = [];

  // Учебное время не выдумывается: если оно не задано, ограничение
  // не применяется, и об этом говорится прямо.
  const missing = shiftsWithoutSchedule(candidates);
  if (missing.length > 0 && rules.studyShiftMode !== 'ignore') {
    warnings.push(
      `Учебное время не задано для смен: ${missing.join(', ')}. ` +
        'Ограничение по учебному времени не применяется.',
    );
  }

  const eligible = new Map<number, Candidate[]>();
  for (const slot of slots) {
    eligible.set(
      slot.index,
      candidates.filter((c) => isAvailable(c, slot, rules)),
    );
  }

  const blockedSlots = slots
    .filter((slot) => (eligible.get(slot.index) ?? []).length === 0)
    .map((slot) => ({
      date: slot.date,
      slotOrder: slot.slotOrder,
      timeFrom: slot.timeFrom,
      timeTo: slot.timeTo,
    }));

  const totalSlots = slots.length;
  const students = candidates.length;
  const availableStudents = candidates.filter((c) =>
    slots.some((slot) => isAvailable(c, slot, rules)),
  ).length;

  if (rosterSize === 0) {
    reasons.push('Подтверждённый состав этажа пуст.');
    suggestions.push('Заполните список этажа или загрузите его из файла.');
  } else if (students === 0) {
    reasons.push('На этаже нет активных студентов.');
    suggestions.push('Проверьте статусы студентов и освобождения от дежурств.');
  }

  const perStudent = maxDutiesPerStudent(totalSlots, students, rules);

  if (students > 0 && blockedSlots.length > 0) {
    const sample = blockedSlots[0]!;
    reasons.push(
      `${blockedSlots.length} ${plural(blockedSlots.length, 'слот', 'слота', 'слотов')} ` +
        `не имеют ни одного допустимого кандидата ` +
        `(например, ${sample.date}, ${sample.timeFrom}–${sample.timeTo}).`,
    );
    suggestions.push(
      'Смягчите учёт учебной смены до «предпочтительно» (study_shift_mode = prefer_free).',
    );
  }

  const groups =
    students > 0 ? checkGroups(slots, eligible, rules, perStudent) : [];

  for (const group of groups) {
    reasons.push(
      `${group.slots} ${plural(group.slots, 'слот', 'слота', 'слотов')} ` +
        `${group.label} доступны только ${group.candidates} ` +
        `${plural(group.candidates, 'студенту', 'студентам', 'студентам')}. ` +
        `Максимум при текущей квоте: ${group.maxDuties}. Дефицит: ${group.deficit}.`,
    );
  }

  if (groups.length > 0) {
    suggestions.push('Разрешите превышение квоты (allow_quota_overflow).');
    suggestions.push('Смягчите учёт учебной смены до «предпочтительно».');
    suggestions.push('Отметьте студентов, готовых дежурить в учебное время.');
    suggestions.push('Измените сетку смен для будних дней.');
  }

  if (students > 0 && totalSlots > students * perStudent) {
    reasons.push(
      `Всего слотов ${totalSlots}, максимум при текущей квоте — ${students * perStudent}.`,
    );
    suggestions.push('Разрешите превышение квоты или увеличьте допустимый разброс.');
  }

  const average = students > 0 ? totalSlots / students : 0;

  return {
    feasible: reasons.length === 0,
    totalSlots,
    totalStudents: students,
    availableStudents,
    blockedSlots,
    averagePerStudent: Number(average.toFixed(2)),
    minQuota: students > 0 ? Math.floor(totalSlots / students) : 0,
    maxQuota: students > 0 ? Math.ceil(totalSlots / students) : 0,
    groups,
    reasons,
    warnings,
    suggestions: [...new Set(suggestions)],
  };
}

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/** Текст отчёта для администратора. */
export function formatFeasibility(report: FeasibilityReport): string {
  const lines: string[] = [];
  if (report.feasible) {
    lines.push('График можно построить.');
  } else {
    lines.push('График невозможно построить.');
    lines.push('');
    lines.push('Причина:');
    for (const reason of report.reasons) lines.push(`  ${reason}`);
  }

  lines.push('');
  lines.push(`Слотов: ${report.totalSlots}`);
  lines.push(`Студентов: ${report.totalStudents}`);
  lines.push(`Доступно для дежурств: ${report.availableStudents}`);
  if (report.totalStudents > 0) {
    lines.push(
      `Квота: ${report.minQuota}–${report.maxQuota} (в среднем ${report.averagePerStudent})`,
    );
  }

  if (report.warnings.length > 0) {
    lines.push('');
    for (const warning of report.warnings) lines.push(`Предупреждение: ${warning}`);
  }

  if (!report.feasible && report.suggestions.length > 0) {
    lines.push('');
    lines.push('Что можно изменить:');
    for (const suggestion of report.suggestions) lines.push(`  · ${suggestion}`);
  }

  return lines.join('\n');
}
