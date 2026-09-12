import { type ScheduleSlot, daysBetween, intervalsOverlap } from './calendar.js';
import {
  type Assignment,
  type Candidate,
  type DutyRules,
  isAvailable,
  overlapsStudy,
  shiftsWithoutSchedule,
} from './duty.js';

/**
 * Детерминированный генератор графика.
 *
 * Никакого AI и никакой случайности. Одни и те же roster, месяц, настройки
 * и шаблон смен дают побайтово одинаковый результат: все сравнения имеют
 * устойчивый tie-break по studentId, порядок обхода слотов фиксирован.
 *
 * Порядок работы:
 *   1. hard-ограничения — соблюдаются всегда;
 *   2. soft-предпочтения — оптимизируются, но могут быть нарушены,
 *      если иначе слот останется незакрытым;
 *   3. если слоты всё равно не закрываются — ослабляются настраиваемые
 *      пороги, и каждое ослабление записывается в метаданные прогона.
 *
 * Разнообразие (v2): при малом числе студентов состояние после каждой
 * недели повторялось, и жадный выбор воспроизводил ту же расстановку —
 * один и тот же человек получал вторник 09:00 все четыре недели подряд.
 * Счётчики weekdayLoad и pairLoad делают повтор дороже свежей комбинации,
 * оставаясь слабее шага равномерности. Случайность для этого не нужна.
 */

export const ALGORITHM = 'greedy-balanced-v2';

export interface GenerationStats {
  totalSlots: number;
  assignedSlots: number;
  unassignedSlots: number;
  students: number;
  minLoad: number;
  maxLoad: number;
  averageLoad: number;
  loadSpread: number;
  /** Нарушенные soft-предпочтения. */
  softViolations: {
    backToBack: number;
    sameDay: number;
    minDaysBetween: number;
    studyOverlap: number;
  };
  perStudent: Array<{ studentId: string; displayName: string; load: number }>;
  perSlotOrder: Array<{ slotOrder: number; assigned: number }>;
  /**
   * Разнообразие: насколько студент избегает одной и той же комбинации
   * «день недели + смена». maxPairRepeat = 1 означает, что повторов нет.
   */
  diversity: {
    maxPairRepeat: number;
    averageUniquePairs: number;
    distinctWeekdaysMin: number;
  };
}

export interface Relaxation {
  rule: string;
  from: number | string;
  to: number | string;
  reason: string;
}

export interface GenerationResult {
  assignments: Assignment[];
  stats: GenerationStats;
  warnings: string[];
  relaxations: Relaxation[];
  seed: string;
  algorithm: string;
}

interface State {
  byStudent: Map<string, Assignment[]>;
  bySlot: Map<number, string>;
  /** Сколько раз студент дежурил в смену с этим номером. */
  slotOrderLoad: Map<string, Map<number, number>>;
  /** Сколько раз студент дежурил в этот день недели. */
  weekdayLoad: Map<string, Map<number, number>>;
  /**
   * Сколько раз студент получал ту же пару «день недели + смена».
   * Именно этот счётчик ломает недельную ротацию: при малом числе
   * студентов состояние после каждой недели повторялось, и жадный выбор
   * воспроизводил ту же расстановку.
   */
  pairLoad: Map<string, Map<string, number>>;
}

const pairKey = (weekday: number, slotOrder: number): string => `${weekday}:${slotOrder}`;

function emptyState(candidates: readonly Candidate[]): State {
  const byStudent = new Map<string, Assignment[]>();
  const slotOrderLoad = new Map<string, Map<number, number>>();
  const weekdayLoad = new Map<string, Map<number, number>>();
  const pairLoad = new Map<string, Map<string, number>>();
  for (const candidate of candidates) {
    byStudent.set(candidate.studentId, []);
    slotOrderLoad.set(candidate.studentId, new Map());
    weekdayLoad.set(candidate.studentId, new Map());
    pairLoad.set(candidate.studentId, new Map());
  }
  return { byStudent, bySlot: new Map(), slotOrderLoad, weekdayLoad, pairLoad };
}

/**
 * HARD-ограничения. Не ослабляются НИКОГДА, ни ради равномерности,
 * ни ради закрытия слота.
 */
function violatesHard(
  candidate: Candidate,
  slot: ScheduleSlot,
  state: State,
  rules: DutyRules,
): boolean {
  // Студент недоступен для этого слота (в т.ч. запрещённое учебное время).
  if (!isAvailable(candidate, slot, rules)) return true;

  const existing = state.byStudent.get(candidate.studentId) ?? [];

  // Два пересекающихся по времени дежурства у одного человека.
  for (const assignment of existing) {
    if (
      assignment.date === slot.date &&
      intervalsOverlap(assignment.timeFrom, assignment.timeTo, slot.timeFrom, slot.timeTo)
    ) {
      return true;
    }
  }

  return false;
}

/** SOFT-предпочтения. Чем меньше стоимость, тем лучше кандидат. */
function cost(
  candidate: Candidate,
  slot: ScheduleSlot,
  state: State,
  rules: DutyRules,
  quota: Map<string, number>,
  limits: { maxPerDay: number; minDays: number },
): number {
  const existing = state.byStudent.get(candidate.studentId) ?? [];
  const load = existing.length;
  const target = quota.get(candidate.studentId) ?? 0;

  let penalty = 0;

  // Равномерность — главный критерий.
  penalty += load * 1000;
  if (load >= target) penalty += (load - target + 1) * 5000;

  const sameDay = existing.filter((a) => a.date === slot.date);
  if (sameDay.length > 0) {
    // Больше одного дежурства в день — нежелательно.
    penalty += 40_000;
    if (sameDay.length >= limits.maxPerDay) penalty += 120_000;

    // Смежные смены подряд (09–11 и сразу 11–13) — хуже, чем врозь.
    const adjacent = sameDay.some(
      (a) => a.timeTo === slot.timeFrom || slot.timeTo === a.timeFrom,
    );
    if (adjacent) penalty += 60_000;
  }

  // Слишком частые дежурства в короткий период.
  let closest = Number.POSITIVE_INFINITY;
  for (const assignment of existing) {
    const gap = Math.abs(daysBetween(assignment.date, slot.date));
    if (gap < closest) closest = gap;
  }
  if (closest < limits.minDays) {
    penalty += (limits.minDays - closest) * 8000;
  }

  // Равномерность по типам смен: поздние не должны доставаться одним и тем же.
  if (rules.balanceBySlot) {
    const perOrder = state.slotOrderLoad.get(candidate.studentId);
    penalty += (perOrder?.get(slot.slotOrder) ?? 0) * 700;
  }

  // ── Разнообразие ──────────────────────────────────────────────────
  // Все три штрафа заведомо слабее шага равномерности (1000 за дежурство):
  // разнообразие улучшает график, но никогда не перебивает баланс
  // и тем более hard-ограничения.

  // Одна и та же пара «день недели + смена» у одного человека.
  // Именно этот штраф ломает недельную ротацию: после первой недели
  // повтор становится дороже свежей комбинации.
  const pairCount = state.pairLoad.get(candidate.studentId)?.get(
    pairKey(slot.weekday, slot.slotOrder),
  ) ?? 0;
  penalty += pairCount * pairCount * 90;

  // Разнообразие дней недели: не сидеть каждый раз по вторникам.
  const weekdayCount = state.weekdayLoad.get(candidate.studentId)?.get(slot.weekday) ?? 0;
  penalty += weekdayCount * 45;

  // Мягкий режим учёта учёбы: пересечение штрафуется, но не запрещает.
  if (rules.studyShiftMode === 'prefer_free' && overlapsStudy(candidate, slot)) {
    penalty += 200_000;
  }

  // Перенос баланса с прошлого месяца.
  if (rules.carryOverBalance) penalty += candidate.previousLoad * 120;

  return penalty;
}

function assign(state: State, slot: ScheduleSlot, candidate: Candidate): void {
  const assignment: Assignment = {
    slotIndex: slot.index,
    date: slot.date,
    slotOrder: slot.slotOrder,
    timeFrom: slot.timeFrom,
    timeTo: slot.timeTo,
    studentId: candidate.studentId,
  };
  state.byStudent.get(candidate.studentId)!.push(assignment);
  state.bySlot.set(slot.index, candidate.studentId);
  shiftCounters(state, slot, candidate.studentId, +1);
}

/** Снимает назначение, возвращая все счётчики в согласованное состояние. */
function unassign(state: State, slot: ScheduleSlot, studentId: string): void {
  const list = state.byStudent.get(studentId);
  if (!list) return;
  const position = list.findIndex((a) => a.slotIndex === slot.index);
  if (position === -1) return;
  list.splice(position, 1);
  state.bySlot.delete(slot.index);
  shiftCounters(state, slot, studentId, -1);
}

function shiftCounters(
  state: State,
  slot: ScheduleSlot,
  studentId: string,
  delta: number,
): void {
  const perOrder = state.slotOrderLoad.get(studentId);
  if (perOrder) perOrder.set(slot.slotOrder, (perOrder.get(slot.slotOrder) ?? 0) + delta);

  const perWeekday = state.weekdayLoad.get(studentId);
  if (perWeekday) perWeekday.set(slot.weekday, (perWeekday.get(slot.weekday) ?? 0) + delta);

  const perPair = state.pairLoad.get(studentId);
  const key = pairKey(slot.weekday, slot.slotOrder);
  if (perPair) perPair.set(key, (perPair.get(key) ?? 0) + delta);
}

/**
 * Квоты. Излишек достаётся тем, у кого прошлый месяц был легче,
 * при равенстве — по studentId, чтобы результат был воспроизводим.
 */
function computeQuotas(
  slots: number,
  candidates: readonly Candidate[],
  rules: DutyRules,
): Map<string, number> {
  const quota = new Map<string, number>();
  const n = candidates.length;
  if (n === 0) return quota;

  const base = Math.floor(slots / n);
  const extra = slots % n;

  const ordered = [...candidates].sort((a, b) => {
    if (rules.carryOverBalance && a.previousLoad !== b.previousLoad) {
      return a.previousLoad - b.previousLoad;
    }
    return a.studentId < b.studentId ? -1 : a.studentId > b.studentId ? 1 : 0;
  });

  ordered.forEach((candidate, index) => {
    quota.set(candidate.studentId, base + (index < extra ? 1 : 0));
  });
  return quota;
}

function runPass(
  slots: readonly ScheduleSlot[],
  candidates: readonly Candidate[],
  rules: DutyRules,
  limits: { maxPerDay: number; minDays: number },
): State {
  const state = emptyState(candidates);
  const quota = computeQuotas(slots.length, candidates, rules);

  const eligible = new Map<number, Candidate[]>();
  for (const slot of slots) {
    eligible.set(
      slot.index,
      candidates.filter((c) => isAvailable(c, slot, rules)),
    );
  }

  // Most-constrained-first: слоты с наименьшим числом кандидатов идут
  // первыми. Tie-break по дате и номеру смены — порядок детерминирован.
  const order = [...slots].sort((a, b) => {
    const diff = (eligible.get(a.index)?.length ?? 0) - (eligible.get(b.index)?.length ?? 0);
    if (diff !== 0) return diff;
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return a.slotOrder - b.slotOrder;
  });

  for (const slot of order) {
    const pool = (eligible.get(slot.index) ?? []).filter(
      (c) => !violatesHard(c, slot, state, rules),
    );
    if (pool.length === 0) continue; // слот останется незакрытым

    let best = pool[0]!;
    let bestCost = cost(best, slot, state, rules, quota, limits);
    for (const candidate of pool.slice(1)) {
      const value = cost(candidate, slot, state, rules, quota, limits);
      // Строгое «меньше» плюс сортировка pool по id делает выбор устойчивым.
      if (value < bestCost || (value === bestCost && candidate.studentId < best.studentId)) {
        best = candidate;
        bestCost = value;
      }
    }
    assign(state, slot, best);
  }

  return state;
}

/**
 * Улучшение равномерности парными обменами.
 *
 * Обход детерминирован, число итераций ограничено. Обмен принимается,
 * только если он уменьшает разброс нагрузки и не нарушает hard-ограничения.
 */
function balance(
  state: State,
  slots: readonly ScheduleSlot[],
  candidates: readonly Candidate[],
  rules: DutyRules,
  maxIterations = 400,
): void {
  const byId = new Map(candidates.map((c) => [c.studentId, c]));
  const slotByIndex = new Map(slots.map((s) => [s.index, s]));

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const loads = [...state.byStudent.entries()]
      .map(([studentId, list]) => ({ studentId, load: list.length }))
      .sort((a, b) => (a.load !== b.load ? a.load - b.load : a.studentId < b.studentId ? -1 : 1));

    const lightest = loads[0];
    const heaviest = loads[loads.length - 1];
    if (!lightest || !heaviest || heaviest.load - lightest.load <= rules.maxLoadSpread) return;

    const donor = byId.get(heaviest.studentId);
    const receiver = byId.get(lightest.studentId);
    if (!donor || !receiver) return;

    const donorAssignments = [...(state.byStudent.get(donor.studentId) ?? [])].sort(
      (a, b) => a.slotIndex - b.slotIndex,
    );

    let moved = false;
    for (const assignment of donorAssignments) {
      const slot = slotByIndex.get(assignment.slotIndex);
      if (!slot) continue;
      if (violatesHard(receiver, slot, state, rules)) continue;

      unassign(state, slot, donor.studentId);
      assign(state, slot, receiver);
      moved = true;
      break;
    }

    if (!moved) return; // дальше улучшить нечем
  }
}

export function generateSchedule(options: {
  slots: readonly ScheduleSlot[];
  candidates: readonly Candidate[];
  rules: DutyRules;
  seed: string;
}): GenerationResult {
  const { slots, candidates, rules, seed } = options;
  const warnings: string[] = [];
  const relaxations: Relaxation[] = [];

  const missing = shiftsWithoutSchedule(candidates);
  if (missing.length > 0 && rules.studyShiftMode !== 'ignore') {
    warnings.push(
      `Учебное время не задано для смен: ${missing.join(', ')}. ` +
        'Ограничение по учебному времени не применяется.',
    );
  }

  // Лестница ослаблений. Hard-ограничения в неё не входят.
  const ladder: Array<{ maxPerDay: number; minDays: number }> = [];
  for (let minDays = rules.minDaysBetween; minDays >= 0; minDays -= 1) {
    ladder.push({ maxPerDay: rules.maxDutiesPerDay, minDays });
  }
  for (let perDay = rules.maxDutiesPerDay + 1; perDay <= 4; perDay += 1) {
    ladder.push({ maxPerDay: perDay, minDays: 0 });
  }

  let best: State | null = null;
  let bestLimits = ladder[0]!;

  for (const limits of ladder) {
    const state = runPass(slots, candidates, rules, limits);
    balance(state, slots, candidates, rules);

    if (!best || state.bySlot.size > best.bySlot.size) {
      best = state;
      bestLimits = limits;
    }
    if (state.bySlot.size === slots.length) break;
  }

  const state = best ?? emptyState(candidates);

  if (bestLimits.minDays !== rules.minDaysBetween) {
    relaxations.push({
      rule: 'min_days_between',
      from: rules.minDaysBetween,
      to: bestLimits.minDays,
      reason: 'Иначе часть слотов осталась бы незакрытой',
    });
  }
  if (bestLimits.maxPerDay !== rules.maxDutiesPerDay) {
    relaxations.push({
      rule: 'max_duties_per_day',
      from: rules.maxDutiesPerDay,
      to: bestLimits.maxPerDay,
      reason: 'Иначе часть слотов осталась бы незакрытой',
    });
  }
  for (const relaxation of relaxations) {
    warnings.push(
      `Ослаблено правило ${relaxation.rule}: ${relaxation.from} → ${relaxation.to}. ` +
        relaxation.reason.toLowerCase() + '.',
    );
  }

  const assignments: Assignment[] = slots.map((slot) => ({
    slotIndex: slot.index,
    date: slot.date,
    slotOrder: slot.slotOrder,
    timeFrom: slot.timeFrom,
    timeTo: slot.timeTo,
    studentId: state.bySlot.get(slot.index) ?? null,
  }));

  const unassigned = assignments.filter((a) => a.studentId === null).length;
  if (unassigned > 0) {
    warnings.push(
      `Не удалось закрыть ${unassigned} ${unassigned === 1 ? 'слот' : 'слотов'}. ` +
        'Пустой слот честнее назначения с нарушением ограничений.',
    );
  }

  return {
    assignments,
    stats: buildStats(assignments, candidates, slots, rules),
    warnings,
    relaxations,
    seed,
    algorithm: ALGORITHM,
  };
}

function buildStats(
  assignments: readonly Assignment[],
  candidates: readonly Candidate[],
  slots: readonly ScheduleSlot[],
  rules: DutyRules,
): GenerationStats {
  const byStudent = new Map<string, Assignment[]>();
  for (const candidate of candidates) byStudent.set(candidate.studentId, []);
  for (const assignment of assignments) {
    if (assignment.studentId) byStudent.get(assignment.studentId)?.push(assignment);
  }

  const loads = [...byStudent.values()].map((list) => list.length);
  const assigned = assignments.filter((a) => a.studentId !== null).length;
  const byId = new Map(candidates.map((c) => [c.studentId, c]));

  const soft = { backToBack: 0, sameDay: 0, minDaysBetween: 0, studyOverlap: 0 };
  const slotByIndex = new Map(slots.map((s) => [s.index, s]));

  for (const [studentId, list] of byStudent) {
    const sorted = [...list].sort((a, b) =>
      a.date === b.date ? a.slotOrder - b.slotOrder : a.date < b.date ? -1 : 1,
    );
    for (let i = 0; i < sorted.length; i += 1) {
      const current = sorted[i]!;
      const candidate = byId.get(studentId);
      const slot = slotByIndex.get(current.slotIndex);
      if (candidate && slot && overlapsStudy(candidate, slot)) soft.studyOverlap += 1;

      const next = sorted[i + 1];
      if (!next) continue;
      if (next.date === current.date) {
        soft.sameDay += 1;
        if (current.timeTo === next.timeFrom) soft.backToBack += 1;
      } else if (Math.abs(daysBetween(current.date, next.date)) < rules.minDaysBetween) {
        soft.minDaysBetween += 1;
      }
    }
  }

  const perSlotOrder = new Map<number, number>();
  for (const assignment of assignments) {
    if (!assignment.studentId) continue;
    perSlotOrder.set(assignment.slotOrder, (perSlotOrder.get(assignment.slotOrder) ?? 0) + 1);
  }

  let maxPairRepeat = 0;
  let uniquePairsTotal = 0;
  let distinctWeekdaysMin = Number.POSITIVE_INFINITY;
  let counted = 0;

  for (const list of byStudent.values()) {
    if (list.length === 0) continue;
    const pairs = new Map<string, number>();
    const weekdays = new Set<number>();
    for (const assignment of list) {
      const weekday = isoWeekdayOfDate(assignment.date);
      weekdays.add(weekday);
      const key = `${weekday}:${assignment.slotOrder}`;
      pairs.set(key, (pairs.get(key) ?? 0) + 1);
    }
    maxPairRepeat = Math.max(maxPairRepeat, ...pairs.values());
    uniquePairsTotal += pairs.size;
    distinctWeekdaysMin = Math.min(distinctWeekdaysMin, weekdays.size);
    counted += 1;
  }

  return {
    totalSlots: assignments.length,
    assignedSlots: assigned,
    unassignedSlots: assignments.length - assigned,
    students: candidates.length,
    minLoad: loads.length ? Math.min(...loads) : 0,
    maxLoad: loads.length ? Math.max(...loads) : 0,
    averageLoad: loads.length
      ? Number((loads.reduce((a, b) => a + b, 0) / loads.length).toFixed(2))
      : 0,
    loadSpread: loads.length ? Math.max(...loads) - Math.min(...loads) : 0,
    softViolations: soft,
    perStudent: [...byStudent.entries()]
      .map(([studentId, list]) => ({
        studentId,
        displayName: byId.get(studentId)?.displayName ?? '',
        load: list.length,
      }))
      .sort((a, b) => (b.load !== a.load ? b.load - a.load : a.displayName < b.displayName ? -1 : 1)),
    perSlotOrder: [...perSlotOrder.entries()]
      .map(([slotOrder, count]) => ({ slotOrder, assigned: count }))
      .sort((a, b) => a.slotOrder - b.slotOrder),
    diversity: {
      maxPairRepeat,
      averageUniquePairs: counted > 0 ? Number((uniquePairsTotal / counted).toFixed(2)) : 0,
      distinctWeekdaysMin: Number.isFinite(distinctWeekdaysMin) ? distinctWeekdaysMin : 0,
    },
  };
}

function isoWeekdayOfDate(date: string): number {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}
