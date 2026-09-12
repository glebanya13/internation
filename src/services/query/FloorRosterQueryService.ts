import type pg from 'pg';
import {
  type FloorRoster,
  type RosterPerson,
  type RosterRoom,
  formatDisplayName,
  formatInitials,
} from '../../domain/floorRoster.js';
import { displayCourseGroup } from '../../domain/printLayout.js';

/**
 * Текущий согласованный список этажа.
 *
 * ОДИН запрос — одно состояние. Все поля строки (комната, блок, ФИО,
 * факультет, смена, курс, группа) читаются из одного снимка транзакции,
 * поэтому смешать данные разных моментов физически невозможно.
 *
 * Состав здесь не берётся из roster_entries намеренно. Инвариант системы:
 * актуальная confirmed-версия по составу тождественна активным students
 * этажа. Читая students напрямую, мы получаем тот же состав, но с ЖИВЫМИ
 * атрибутами — поэтому исправление факультета видно в текущем списке
 * немедленно, не дожидаясь следующего изменения состава.
 *
 * Номер версии в meta — подпись документа, а не источник строк.
 */
export class FloorRosterQueryService {
  constructor(private readonly db: pg.Pool | pg.PoolClient) {}

  async getCurrent(floorId: string): Promise<FloorRoster> {
    const { rows } = await this.db.query<CurrentRow>(
      `
      WITH floor AS (
        SELECT f.id, f.number, f.code, f.title,
               f.print_min_rows, f.print_empty_rooms,
               d.number AS dormitory_number, d.name AS dormitory_name
          FROM floors f
          JOIN dormitories d ON d.id = f.dormitory_id
         WHERE f.id = $1
      ),
      version AS (
        SELECT id, version_no, status, effective_from
          FROM roster_versions
         WHERE floor_id = $1 AND status = 'confirmed'
      )
      SELECT floor.id                AS floor_id,
             floor.number            AS floor_number,
             floor.code              AS floor_code,
             floor.title             AS floor_title,
             floor.print_min_rows    AS floor_print_min_rows,
             floor.print_empty_rooms AS floor_print_empty_rooms,
             floor.dormitory_number,
             floor.dormitory_name,
             version.id              AS version_id,
             version.version_no      AS version_no,
             version.status          AS version_status,
             version.effective_from  AS version_effective_from,

             r.id                    AS room_id,
             r.number                AS room_number,
             r.sort_order            AS room_sort,
             r.print_min_rows        AS room_print_min_rows,
             b.id                    AS block_id,
             b.code                  AS block_code,
             b.sort_order            AS block_sort,

             s.id                    AS student_id,
             s.last_name,
             s.first_name,
             s.middle_name,
             s.course,
             s.group_code,
             s.telegram_id,
             s.phone,
             s.status                AS student_status,
             s.sort_order            AS student_sort,
             fac.code                AS faculty_code,
             sh.code                 AS study_shift_code
        FROM floor
        JOIN rooms r ON r.floor_id = floor.id AND r.is_active
        LEFT JOIN blocks b ON b.id = r.block_id
        LEFT JOIN version ON true
        -- LEFT JOIN: комната без жильцов остаётся в выборке одной строкой
        -- с пустым student_id. Пустая комната — валидное состояние.
        LEFT JOIN students s
               ON s.room_id = r.id
              AND s.floor_id = floor.id
              AND s.status <> 'moved_out'
        LEFT JOIN faculties    fac ON fac.id = s.faculty_id
        LEFT JOIN study_shifts sh  ON sh.id  = s.study_shift_id
       ORDER BY b.sort_order NULLS FIRST, b.code NULLS FIRST,
                r.sort_order, r.number,
                s.sort_order, s.last_name, s.first_name
      `,
      [floorId],
    );

    if (rows.length === 0) throw new Error('Этаж не найден или не содержит комнат');
    return assemble(rows, 'current', true);
  }
}

interface CurrentRow {
  floor_id: string;
  floor_number: number;
  floor_code: string | null;
  floor_title: string | null;
  floor_print_min_rows: number | null;
  floor_print_empty_rooms: boolean;
  dormitory_number: string;
  dormitory_name: string | null;
  version_id: string | null;
  version_no: number | null;
  version_status: string | null;
  version_effective_from: string | null;
  room_id: string;
  room_number: string;
  room_sort: number;
  room_print_min_rows: number | null;
  block_id: string | null;
  block_code: string | null;
  block_sort: number | null;
  student_id: string | null;
  last_name: string | null;
  first_name: string | null;
  middle_name: string | null;
  course: number | null;
  group_code: string | null;
  telegram_id: string | null;
  phone: string | null;
  student_status: string | null;
  student_sort: number | null;
  faculty_code: string | null;
  study_shift_code: string | null;
}

function assemble(
  rows: CurrentRow[],
  source: 'current',
  emptyRoomsAvailable: boolean,
): FloorRoster {
  const head = rows[0]!;
  const roomsById = new Map<string, RosterRoom>();

  for (const row of rows) {
    let room = roomsById.get(row.room_id);
    if (!room) {
      room = {
        roomId: row.room_id,
        number: row.room_number,
        blockId: row.block_id,
        blockCode: row.block_code,
        sortOrder: row.room_sort,
        printMinRows: row.room_print_min_rows,
        people: [],
      };
      roomsById.set(row.room_id, room);
    }
    if (!row.student_id || !row.last_name || !row.first_name) continue;

    const person: RosterPerson = {
      studentId: row.student_id,
      lastName: row.last_name,
      firstName: row.first_name,
      middleName: row.middle_name,
      displayName: formatDisplayName({ lastName: row.last_name, firstName: row.first_name }),
      initialsName: formatInitials({
        lastName: row.last_name,
        firstName: row.first_name,
        middleName: row.middle_name,
      }),
      facultyCode: row.faculty_code,
      studyShiftCode: row.study_shift_code,
      course: row.course,
      groupCode: row.group_code,
      courseGroup: displayCourseGroup(row.faculty_code, row.course, row.group_code),
      phone: row.phone,
      telegramId: row.telegram_id,
      status: row.student_status ?? 'active',
      sortOrder: row.student_sort ?? 0,
    };
    room.people.push(person);
  }

  return {
    meta: {
      source,
      floorId: head.floor_id,
      floorNumber: head.floor_number,
      floorCode: head.floor_code,
      floorTitle: head.floor_title,
      dormitoryNumber: head.dormitory_number,
      dormitoryName: head.dormitory_name,
      rosterVersionId: head.version_id,
      rosterVersionNo: head.version_no,
      rosterVersionStatus: head.version_status,
      effectiveFrom: head.version_effective_from,
      printMinRows: head.floor_print_min_rows,
      printEmptyRooms: head.floor_print_empty_rooms,
      emptyRoomsAvailable,
      generatedAt: new Date().toISOString(),
    },
    rooms: [...roomsById.values()],
  };
}
