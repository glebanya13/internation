/**
 * Единая read model списка этажа.
 *
 * Один и тот же DTO отдают оба сервиса запросов и потребляют все три
 * рендерера. Трёх разных SQL-запросов, способных разойтись, не существует:
 *
 *     FloorRosterQueryService   (текущее состояние)
 *     RosterSnapshotQueryService (исторический снимок)
 *                  ↓
 *              FloorRoster
 *          ├── Web renderer
 *          ├── PDF renderer
 *          └── XLSX renderer
 *
 * Ключевое правило: внутри одного документа никогда не смешиваются
 * текущее состояние и исторический снимок. Источник фиксируется
 * в meta.source и виден потребителю.
 */

export type RosterSource = 'current' | 'snapshot';

export interface RosterMeta {
  source: RosterSource;

  floorId: string;
  floorNumber: number;
  floorCode: string | null;
  floorTitle: string | null;
  dormitoryNumber: string;
  dormitoryName: string | null;

  /** Версия состава: для current — актуальная, для snapshot — та, что запрошена. */
  rosterVersionId: string | null;
  rosterVersionNo: number | null;
  rosterVersionStatus: string | null;
  effectiveFrom: string | null;

  /** Параметры печатной формы. Только представление, к данным отношения не имеют. */
  printMinRows: number | null;
  printEmptyRooms: boolean;

  /**
   * Есть ли в выборке комнаты без жильцов.
   *
   * Для current — да: структура этажа известна целиком.
   * Для snapshot — нет: снимок хранит только людей, а состав помещений
   * на тот момент нигде не зафиксирован. Дорисовать их из текущей структуры
   * значило бы смешать состояния внутри одного документа.
   */
  emptyRoomsAvailable: boolean;

  generatedAt: string;
}

export interface RosterPerson {
  studentId: string;
  lastName: string;
  firstName: string;
  middleName: string | null;
  /** «Фамилия Имя» — формат колонки в исходном бланке списка. */
  displayName: string;
  /** «Фамилия И. О.» — формат колонки «Ф.И.О» в бланке графика. */
  initialsName: string;
  facultyCode: string | null;
  studyShiftCode: string | null;
  course: number | null;
  groupCode: string | null;
  /** Готовая строка «курс-группа»: 2-1, 4-10, 2-1/2. */
  courseGroup: string | null;
  phone: string | null;
  telegramId: string | null;
  status: string;
  sortOrder: number;
}

export interface RosterRoom {
  roomId: string | null;
  number: string;
  blockId: string | null;
  blockCode: string | null;
  sortOrder: number;
  /** Может быть пустым: комната существует, жильцов нет. */
  people: RosterPerson[];
  /** Переопределение минимума строк для этой комнаты в бланке. */
  printMinRows: number | null;
}

export interface FloorRoster {
  meta: RosterMeta;
  rooms: RosterRoom[];
}

export function formatDisplayName(p: {
  lastName: string;
  firstName: string;
}): string {
  return `${p.lastName} ${p.firstName}`.trim();
}

export function formatInitials(p: {
  lastName: string;
  firstName: string;
  middleName?: string | null;
}): string {
  const initials = [p.firstName, p.middleName]
    .filter((part): part is string => Boolean(part))
    .map((part) => `${part[0]!.toUpperCase()}.`)
    .join(' ');
  return initials ? `${p.lastName} ${initials}` : p.lastName;
}

export function formatCourseGroup(
  course: number | null,
  groupCode: string | null,
): string | null {
  if (course === null && !groupCode) return null;
  if (course === null) return groupCode;
  return groupCode ? `${course}-${groupCode}` : String(course);
}

/** Число жильцов этажа. Считается по людям, а не по комнатам. */
export function countPeople(roster: FloorRoster): number {
  return roster.rooms.reduce((sum, room) => sum + room.people.length, 0);
}

export function countOccupiedRooms(roster: FloorRoster): number {
  return roster.rooms.filter((room) => room.people.length > 0).length;
}
