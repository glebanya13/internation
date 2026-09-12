import { monthName, weekdayShort } from '../../domain/calendar.js';

/**
 * Тексты уведомлений — в одном месте, а не размазаны по коду.
 * Функции чистые: ни базы, ни Telegram.
 */

const WEEKDAY_FULL = [
  'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье',
];
const MONTH_GENITIVE = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

export function isoWeekday(date: string): number {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

/** «15 сентября» */
export function longDate(date: string): string {
  const [, month, day] = date.split('-').map(Number);
  return `${day} ${MONTH_GENITIVE[month! - 1]}`;
}

export function weekdayName(date: string): string {
  return WEEKDAY_FULL[isoWeekday(date) - 1] ?? '';
}

export function timeRange(from: string, to: string): string {
  return `${from.slice(0, 5)}–${to.slice(0, 5)}`;
}

export function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

export interface DutyView {
  date: string;
  timeFrom: string;
  timeTo: string;
  floorNumber: number;
  roomNumber: string | null;
}

export function schedulePublished(input: {
  year: number;
  month: number;
  dutyCount: number;
  nearest: DutyView | null;
}): string {
  const lines = [
    '📢 График дежурств опубликован',
    '',
    `${monthName(input.month)} ${input.year}`,
    '',
    `У вас запланировано: ${input.dutyCount} ${plural(
      input.dutyCount,
      'дежурство',
      'дежурства',
      'дежурств',
    )}.`,
  ];
  if (input.nearest) {
    lines.push('', 'Ближайшее:');
    lines.push(
      `${longDate(input.nearest.date)} · ${timeRange(input.nearest.timeFrom, input.nearest.timeTo)}`,
    );
  }
  return lines.join('\n');
}

export function dutyReminder(duty: DutyView, hoursBefore: number): string {
  return [
    '🔔 Напоминание о дежурстве',
    '',
    `Дата: ${longDate(duty.date)}`,
    `День: ${weekdayName(duty.date)}`,
    `Время: ${timeRange(duty.timeFrom, duty.timeTo)}`,
    '',
    `🏢 Этаж: ${duty.floorNumber}`,
    duty.roomNumber ? `🚪 Комната: ${duty.roomNumber}` : '',
    '',
    `Осталось примерно ${hoursBefore} ${plural(hoursBefore, 'час', 'часа', 'часов')}.`,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

export function dutyMissed(input: {
  duty: DutyView;
  reason: string | null;
  totalViolations: number;
}): string {
  return [
    '⚠️ Дежурство пропущено',
    '',
    `${longDate(input.duty.date)} · ${timeRange(input.duty.timeFrom, input.duty.timeTo)}`,
    '',
    input.reason ? `Причина: ${input.reason}` : 'Причина не указана.',
    '',
    `Всего пропусков за текущий учебный год: ${input.totalViolations}.`,
  ].join('\n');
}

export function explanationRequired(total: number): string {
  return [
    '⚠️ Важно',
    '',
    `У вас накопилось ${total} ${plural(total, 'пропуск', 'пропуска', 'пропусков')} дежурства.`,
    '',
    'Необходимо предоставить объяснительную.',
    '',
    'Обратитесь к ответственному.',
  ].join('\n');
}

export function substitutedIn(duty: DutyView, reason: string): string {
  return [
    '🔄 Вам назначено дежурство',
    '',
    `Дата: ${longDate(duty.date)}`,
    `День: ${weekdayName(duty.date)}`,
    `Время: ${timeRange(duty.timeFrom, duty.timeTo)}`,
    '',
    `🏢 Этаж: ${duty.floorNumber}`,
    duty.roomNumber ? `🚪 Комната: ${duty.roomNumber}` : '',
    '',
    `Причина замены: ${reason}`,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

export function substitutedOut(duty: DutyView, reason: string): string {
  return [
    '🔄 Дежурство переназначено',
    '',
    `${longDate(duty.date)} · ${timeRange(duty.timeFrom, duty.timeTo)}`,
    '',
    'Это дежурство закреплено за другим студентом.',
    '',
    `Причина: ${reason}`,
  ].join('\n');
}

export const NOT_REGISTERED =
  'Ваш Telegram ID ещё не зарегистрирован. Обратитесь к администратору.';

export function shortWeekday(date: string): string {
  return weekdayShort(isoWeekday(date));
}
