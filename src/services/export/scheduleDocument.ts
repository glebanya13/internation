import { monthForTitle, monthName, shortDate, weekdayShort } from '../../domain/calendar.js';

/**
 * Модель печатного документа графика дежурств.
 *
 * Воспроизводит вёрстку исходного бланка: A4 книжная, блок подписей
 * на каждой странице, таблица в двух зеркальных блоках по 5 колонок
 * (Дата · № комнаты · Время · Ф.И.О · Подпись), дата объединена
 * по вертикали на все смены дня, под таблицей — таблица изменений
 * с подписью старосты.
 *
 * Формат-независима: одна структура уходит в HTML, PDF и XLSX.
 */

export interface ScheduleDutyRow {
  date: string;
  slotOrder: number;
  timeFrom: string;
  timeTo: string;
  studentName: string | null;
  roomNumber: string | null;
}

export interface ScheduleDocumentInput {
  floorNumber: number;
  floorCode: string | null;
  dormitoryNumber: string;
  year: number;
  month: number;
  status: string;
  duties: ScheduleDutyRow[];
  approval: {
    wardenName: string | null;
    curatorName: string | null;
    councilHeadName: string | null;
  };
  /** Строки таблицы изменений. Пустой массив — бланк под ручное заполнение. */
  changes?: Array<{
    date: string;
    roomNumber: string | null;
    time: string;
    studentName: string | null;
  }>;
  generatedAt?: string;
}

export interface ScheduleCell {
  text: string;
  subText?: string;
  rowSpan: number;
}

export interface ScheduleRow {
  date: ScheduleCell;
  room: ScheduleCell;
  time: ScheduleCell;
  name: ScheduleCell;
  /** Графа «Подпись» — всегда пустая, под ручку. */
  signature: ScheduleCell;
  dayStart: boolean;
}

export interface ScheduleColumn {
  rows: ScheduleRow[];
}

export interface SchedulePage {
  pageNumber: number;
  left: ScheduleColumn;
  right: ScheduleColumn | null;
}

export interface ScheduleDocument {
  title: string;
  subtitle: string;
  monthTitle: string;
  year: number;
  status: string;
  headers: string[];
  changesHeaders: string[];
  changesRows: Array<{ date: string; room: string; time: string; name: string }>;
  approval: Array<{ verb: string; role: string; name: string; year: number }>;
  pages: SchedulePage[];
  totalPages: number;
  stats: { days: number; slots: number; assigned: number; unassigned: number };
  generatedAt: string;
  fileBaseName: string;
}

export const SCHEDULE_HEADERS = ['Дата', '№ комнаты', 'Время', 'Ф.И.О', 'Подпись'];
export const CHANGES_HEADERS = ['Дата', '№ комн.', 'Время', 'Ф.И.О.'];

/** Пустых строк в таблице изменений — как в исходном бланке. */
const CHANGES_MIN_ROWS = 8;

function cell(text: string, rowSpan = 1, subText?: string): ScheduleCell {
  return subText === undefined ? { text, rowSpan } : { text, subText, rowSpan };
}

export function buildScheduleDocument(
  input: ScheduleDocumentInput,
  _options: { rowsPerColumn?: number } = {},
): ScheduleDocument {
  const generatedAt = input.generatedAt ?? new Date().toISOString();

  // Группируем по дате: число смен в дне берётся из данных, не из константы.
  const byDate = new Map<string, ScheduleDutyRow[]>();
  for (const duty of input.duties) {
    byDate.set(duty.date, [...(byDate.get(duty.date) ?? []), duty]);
  }
  const dates = [...byDate.keys()].sort();

  const dayChunks = dates.map((date) => {
    const duties = (byDate.get(date) ?? []).sort((a, b) => a.slotOrder - b.slotOrder);
    const weekday = isoWeekdayOf(date);

    const rows: ScheduleRow[] = duties.map((duty, index) => ({
      date:
        index === 0
          ? cell(shortDate(date), duties.length, weekdayShort(weekday))
          : cell('', 0),
      room: cell(duty.roomNumber ?? ''),
      time: cell(`${duty.timeFrom}-${duty.timeTo}`),
      name: cell(duty.studentName ?? ''),
      signature: cell(''), // всегда пустая
      dayStart: index === 0,
    }));
    return { rows };
  });

  // Как в бумажном бланке: 01–15 на стр. 1, 16–конец на стр. 2;
  // на каждой странице два столбца по дням.
  const pages = packPagesByDays(dayChunks);
  if (pages.length === 0) {
    pages.push({ pageNumber: 1, left: { rows: [] }, right: null });
  }

  const assigned = input.duties.filter((d) => d.studentName).length;
  const floorLabel = input.floorCode ?? String(input.floorNumber);

  const changes = input.changes ?? [];
  const changesRows = Array.from(
    { length: Math.max(CHANGES_MIN_ROWS, changes.length) },
    (_, i) => {
      const change = changes[i];
      return {
        date: change ? shortDate(change.date) : '',
        room: change?.roomNumber ?? '',
        time: change?.time ?? '',
        name: change?.studentName ?? '',
      };
    },
  );

  const wardenRole = `заведующий общежитием №${input.dormitoryNumber}`;
  const curatorRole = `куратор общежития №${input.dormitoryNumber}`;

  return {
    title: 'График',
    subtitle: `несения дежурства на ${floorLabel} этаже общежития №${input.dormitoryNumber}`,
    monthTitle: `на ${monthForTitle(input.month)} месяц`,
    year: input.year,
    status: input.status,
    headers: SCHEDULE_HEADERS,
    changesHeaders: CHANGES_HEADERS,
    changesRows,
    approval: [
      {
        verb: 'Утверждаю',
        role: 'председатель студсовета',
        name: input.approval.councilHeadName ?? '',
        year: input.year,
      },
      {
        verb: 'Согласовано',
        // В бланке ФИО заведующего стоит в строке должности.
        role: input.approval.wardenName
          ? `${wardenRole} ${input.approval.wardenName}`
          : wardenRole,
        name: '',
        year: input.year,
      },
      {
        verb: 'Согласовано',
        role: curatorRole,
        name: input.approval.curatorName ?? '',
        year: input.year,
      },
    ],
    pages,
    totalPages: pages.length,
    stats: {
      days: dates.length,
      slots: input.duties.length,
      assigned,
      unassigned: input.duties.length - assigned,
    },
    generatedAt,
    fileBaseName: `График_дежурств_${floorLabel}_этаж_${monthName(input.month)}_${input.year}`,
  };
}

/** Делит дни пополам между страницами, каждую страницу — на два столбца. */
function packPagesByDays(dayChunks: Array<{ rows: ScheduleRow[] }>): SchedulePage[] {
  if (dayChunks.length === 0) return [];

  const mid = Math.ceil(dayChunks.length / 2);
  const halves = [dayChunks.slice(0, mid), dayChunks.slice(mid)].filter((h) => h.length > 0);

  return halves.map((days, index) => {
    const split = Math.ceil(days.length / 2);
    const leftDays = days.slice(0, split);
    const rightDays = days.slice(split);
    return {
      pageNumber: index + 1,
      left: { rows: leftDays.flatMap((d) => d.rows) },
      right: rightDays.length > 0 ? { rows: rightDays.flatMap((d) => d.rows) } : null,
    };
  });
}

function isoWeekdayOf(date: string): number {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}
