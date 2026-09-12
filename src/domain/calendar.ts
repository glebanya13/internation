/**
 * Календарь месяца и развёртывание сетки смен.
 *
 * Единственное место в системе, где считаются даты и дни недели.
 * Число дней в месяце нигде не задаётся вручную: 28, 29, 30 и 31
 * получаются из арифметики дат, високосный год обрабатывается сам.
 *
 * Интервалы времени берутся из duty_slot_rules и в код не попадают.
 */

export interface SlotRule {
  weekday: number; // ISO: 1 = Пн … 7 = Вс
  slotOrder: number;
  timeFrom: string; // HH:MM
  timeTo: string;
  label?: string | null;
}

export interface SlotTemplate {
  id: string;
  name: string;
  rules: SlotRule[];
}

export interface ScheduleSlot {
  /** YYYY-MM-DD */
  date: string;
  weekday: number;
  slotOrder: number;
  timeFrom: string;
  timeTo: string;
  /** Порядковый номер слота в месяце — стабильный ключ сортировки. */
  index: number;
}

export function daysInMonth(year: number, month: number): number {
  // Нулевой день следующего месяца — последний день текущего.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function isoWeekday(year: number, month: number, day: number): number {
  const jsDay = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return jsDay === 0 ? 7 : jsDay; // воскресенье: 0 → 7
}

export function formatDate(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Минуты от полуночи. Для сравнения интервалов. */
export function toMinutes(time: string): number {
  const [h, m] = time.split(':');
  return Number(h) * 60 + Number(m);
}

export function intervalsOverlap(
  aFrom: string,
  aTo: string,
  bFrom: string,
  bTo: string,
): boolean {
  return toMinutes(aFrom) < toMinutes(bTo) && toMinutes(bFrom) < toMinutes(aTo);
}

/**
 * Разворачивает шаблон в конкретные слоты месяца.
 *
 * Сколько смен в дне — определяется числом правил для этого дня недели.
 * Воскресенье получает свою сетку просто потому, что для weekday = 7
 * в шаблоне заданы другие интервалы.
 */
export function expandMonth(
  template: SlotTemplate,
  year: number,
  month: number,
  options: { excludedDates?: readonly string[] } = {},
): ScheduleSlot[] {
  const excluded = new Set(options.excludedDates ?? []);
  const byWeekday = new Map<number, SlotRule[]>();

  for (const rule of template.rules) {
    const list = byWeekday.get(rule.weekday) ?? [];
    list.push(rule);
    byWeekday.set(rule.weekday, list);
  }
  for (const list of byWeekday.values()) {
    list.sort((a, b) => a.slotOrder - b.slotOrder);
  }

  const slots: ScheduleSlot[] = [];
  const total = daysInMonth(year, month);

  for (let day = 1; day <= total; day += 1) {
    const date = formatDate(year, month, day);
    if (excluded.has(date)) continue;

    const weekday = isoWeekday(year, month, day);
    for (const rule of byWeekday.get(weekday) ?? []) {
      slots.push({
        date,
        weekday,
        slotOrder: rule.slotOrder,
        timeFrom: rule.timeFrom,
        timeTo: rule.timeTo,
        index: slots.length,
      });
    }
  }

  return slots;
}

const WEEKDAY_SHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

export function weekdayShort(weekday: number): string {
  return WEEKDAY_SHORT[weekday - 1] ?? '';
}

/** Названия месяцев заданы константой, чтобы совпадать с бумажным архивом. */
const MONTH_NOMINATIVE = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];

/** Форма для заголовка «на сентябрь месяц» — как в исходном бланке. */
const MONTH_FOR_TITLE = [
  'январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
  'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь',
];

export function monthName(month: number): string {
  return MONTH_NOMINATIVE[month - 1] ?? String(month);
}

export function monthForTitle(month: number): string {
  return MONTH_FOR_TITLE[month - 1] ?? String(month);
}

/** «01.09» — формат ячейки даты в бланке графика. Год не печатается. */
export function shortDate(date: string): string {
  const [, month, day] = date.split('-');
  return `${day}.${month}`;
}

/** Число дней между датами. Используется правилом min_days_between. */
export function daysBetween(a: string, b: string): number {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}
