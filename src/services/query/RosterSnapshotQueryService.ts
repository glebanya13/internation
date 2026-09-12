import type pg from 'pg';
import {
  type FloorRoster,
  type RosterPerson,
  type RosterRoom,
  formatCourseGroup,
  formatDisplayName,
  formatInitials,
} from '../../domain/floorRoster.js';

/**
 * Исторический список этажа: конкретная версия состава.
 *
 * Читает ТОЛЬКО roster_entries. Ни одного соединения с students, faculties
 * или study_shifts здесь нет и быть не может: если студент сегодня перешёл
 * с ФИТ на ТОВ, старый список обязан по-прежнему показывать ФИТ.
 *
 * Следствие, о котором надо знать: пустые комнаты в исторической версии
 * недоступны. Снимок хранит людей, а состав помещений на тот момент нигде
 * не зафиксирован — дорисовать их из текущей структуры значило бы смешать
 * состояния внутри одного документа. Поэтому meta.emptyRoomsAvailable = false,
 * и печатная форма исторической версии показывает только комнаты с жильцами.
 */
export class RosterSnapshotQueryService {
  constructor(private readonly db: pg.Pool | pg.PoolClient) {}

  async getVersion(rosterVersionId: string): Promise<FloorRoster> {
    const { rows } = await this.db.query<SnapshotRow>(
      `
      SELECT rv.id                 AS version_id,
             rv.version_no,
             rv.status             AS version_status,
             rv.effective_from,
             f.id                  AS floor_id,
             f.number              AS floor_number,
             f.code                AS floor_code,
             f.title               AS floor_title,
             f.print_min_rows      AS floor_print_min_rows,
             f.print_empty_rooms   AS floor_print_empty_rooms,
             d.number              AS dormitory_number,
             d.name                AS dormitory_name,

             re.student_id,
             re.full_name_snapshot,
             re.room_id,
             re.room_number_snapshot,
             re.block_code_snapshot,
             re.faculty_code_snapshot,
             re.study_shift_code_snapshot,
             re.course_snapshot,
             re.group_code_snapshot,
             re.student_status_snapshot,
             re.sort_order
        FROM roster_versions rv
        JOIN floors f      ON f.id = rv.floor_id
        JOIN dormitories d ON d.id = f.dormitory_id
        LEFT JOIN roster_entries re ON re.roster_version_id = rv.id
       WHERE rv.id = $1
       ORDER BY re.block_code_snapshot NULLS FIRST,
                re.room_number_snapshot,
                re.sort_order,
                re.full_name_snapshot
      `,
      [rosterVersionId],
    );

    const head = rows[0];
    if (!head) throw new Error('Версия состава не найдена');

    const roomsByNumber = new Map<string, RosterRoom>();
    for (const row of rows) {
      if (!row.student_id || !row.room_number_snapshot) continue;

      let room = roomsByNumber.get(row.room_number_snapshot);
      if (!room) {
        room = {
          roomId: row.room_id,
          number: row.room_number_snapshot,
          blockId: null,
          blockCode: row.block_code_snapshot,
          sortOrder: roomsByNumber.size,
          printMinRows: null,
          people: [],
        };
        roomsByNumber.set(row.room_number_snapshot, room);
      }

      const parts = row.full_name_snapshot!.split(/\s+/);
      const lastName = parts[0] ?? row.full_name_snapshot!;
      const firstName = parts[1] ?? '';
      const middleName = parts.length > 2 ? parts.slice(2).join(' ') : null;

      const person: RosterPerson = {
        studentId: row.student_id,
        lastName,
        firstName,
        middleName,
        displayName: formatDisplayName({ lastName, firstName }),
        initialsName: formatInitials({ lastName, firstName, middleName }),
        facultyCode: row.faculty_code_snapshot,
        studyShiftCode: row.study_shift_code_snapshot,
        course: row.course_snapshot,
        groupCode: row.group_code_snapshot,
        courseGroup: formatCourseGroup(row.course_snapshot, row.group_code_snapshot),
        // Telegram ID и телефон в снимке не хранятся.
        phone: null,
        telegramId: null,
        status: row.student_status_snapshot ?? 'active',
        sortOrder: row.sort_order ?? 0,
      };
      room.people.push(person);
    }

    return {
      meta: {
        source: 'snapshot',
        floorId: head.floor_id,
        floorNumber: head.floor_number,
        floorCode: head.floor_code,
        floorTitle: head.floor_title,
        dormitoryNumber: head.dormitory_number,
        dormitoryName: head.dormitory_name,
        rosterVersionId: head.version_id,
        rosterVersionNo: head.version_no,
        rosterVersionStatus: head.version_status,
        effectiveFrom: head.effective_from,
        printMinRows: head.floor_print_min_rows,
        printEmptyRooms: head.floor_print_empty_rooms,
        emptyRoomsAvailable: false,
        generatedAt: new Date().toISOString(),
      },
      rooms: [...roomsByNumber.values()],
    };
  }
}

interface SnapshotRow {
  version_id: string;
  version_no: number;
  version_status: string;
  effective_from: string;
  floor_id: string;
  floor_number: number;
  floor_code: string | null;
  floor_title: string | null;
  floor_print_min_rows: number | null;
  floor_print_empty_rooms: boolean;
  dormitory_number: string;
  dormitory_name: string | null;
  student_id: string | null;
  full_name_snapshot: string | null;
  room_id: string | null;
  room_number_snapshot: string | null;
  block_code_snapshot: string | null;
  faculty_code_snapshot: string | null;
  study_shift_code_snapshot: string | null;
  course_snapshot: number | null;
  group_code_snapshot: string | null;
  student_status_snapshot: string | null;
  sort_order: number | null;
}
