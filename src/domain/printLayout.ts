import type { FloorRoster, RosterPerson, RosterRoom } from './floorRoster.js';
import { countPeople, formatCourseGroup } from './floorRoster.js';

/** Факультеты китайского сегмента — без курса и группы в бланке и составе. */
export const CHINESE_FACULTY_CODES = new Set(['ИЭФ', 'ХТИТ']);

export function isChineseFaculty(facultyCode: string | null | undefined): boolean {
  return facultyCode != null && CHINESE_FACULTY_CODES.has(facultyCode);
}

/** Курс-группа для отображения; у китайцев — пусто. */
export function displayCourseGroup(
  facultyCode: string | null | undefined,
  course: number | null,
  groupCode: string | null,
): string | null {
  if (isChineseFaculty(facultyCode)) return null;
  if (groupCode === '—') return formatCourseGroup(course, null);
  return formatCourseGroup(course, groupCode);
}

/**
 * Минимум строк в бланке/составе по типу комнаты:
 * «605А» → 3 места, «605Б» → 2 места.
 * Явный print_min_rows комнаты или этажа переопределяет.
 */
export function effectivePrintMinRows(
  roomNumber: string,
  roomMinRows: number | null,
  floorMinRows: number | null,
): number {
  if (roomMinRows != null) return roomMinRows;
  if (/А$/u.test(roomNumber)) return 3;
  if (/Б$/u.test(roomNumber)) return 2;
  return floorMinRows ?? 0;
}

/** Сколько строк занимает комната (жильцы + пустые места). */
export function rowsForRoom(
  room: RosterRoom,
  floorMinRows: number | null,
  printEmptyRooms: boolean,
): number {
  const capacity = effectivePrintMinRows(room.number, room.printMinRows, floorMinRows);
  const n = room.people.length;

  if (n === 0) return printEmptyRooms ? Math.max(capacity, 1) : 0;

  // Б: при одном жильце — вторая строка для ручного ввода.
  if (/Б$/u.test(room.number) && n < capacity) return capacity;

  // А: добивка до 3, если жильцов меньше; при 3+ — без лишних пустых строк.
  if (/А$/u.test(room.number)) return n >= capacity ? n : capacity;

  return Math.max(n, capacity);
}

export interface RosterDisplayRow {
  room: RosterRoom;
  person: RosterPerson | null;
  isPlaceholder: boolean;
  /** Первая строка комнаты — для rowspan номера комнаты. */
  isRoomStart: boolean;
  roomRowSpan: number;
}

/** Разворачивает состав этажа в строки таблицы с пустыми местами. */
export function expandRosterDisplayRows(roster: FloorRoster): RosterDisplayRow[] {
  const printEmptyRooms = roster.meta.printEmptyRooms || countPeople(roster) === 0;
  const rows: RosterDisplayRow[] = [];

  for (const room of roster.rooms) {
    const total = rowsForRoom(room, roster.meta.printMinRows, printEmptyRooms);
    if (total === 0) continue;

    for (let i = 0; i < total; i += 1) {
      rows.push({
        room,
        person: room.people[i] ?? null,
        isPlaceholder: i >= room.people.length,
        isRoomStart: i === 0,
        roomRowSpan: i === 0 ? total : 0,
      });
    }
  }
  return rows;
}
