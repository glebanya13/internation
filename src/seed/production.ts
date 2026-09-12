import type pg from 'pg';
import { facultyForGroup, formatGroupCode } from '../domain/facultyGroup.js';
import { withTransaction } from '../db/pool.js';
import { materializeVersion } from '../services/rosterService.js';

/**
 * Реальные данные общежития. Заменяет демо-наполнение.
 *
 * Этаж 6 — все реальные жильцы (русские и китайский сегмент).
 * Этаж 7 — структура комнат есть, заселение пока пустое.
 *
 * Структура на каждом этаже: блоки 601–616, в каждом комнаты А и Б.
 */

const WEEKDAY_SLOTS: Array<[number, string, string]> = [
  [1, '09:00', '11:00'],
  [2, '11:00', '13:00'],
  [3, '19:00', '21:00'],
  [4, '21:00', '23:00'],
];

const SUNDAY_SLOTS: Array<[number, string, string]> = [
  [1, '10:00', '12:30'],
  [2, '12:30', '15:00'],
  [3, '19:00', '21:00'],
  [4, '21:00', '23:00'],
];

const DEFAULT_RULES = {
  duties_per_student: 'auto',
  max_duties_per_day: 1,
  min_days_between: 3,
  study_shift_mode: 'block_on_overlap',
  room_spacing: 'soft',
  block_spacing: 'off',
  faculty_spacing: 'off',
  balance_by_slot: true,
  carry_over_balance: true,
  elder_exempt: true,
  exclude_non_active: true,
  excluded_dates: [] as string[],
  allow_quota_overflow: false,
  max_load_spread: 1,
};

interface StudentInput {
  room: string;
  last: string;
  first: string;
  middle?: string;
  course: number | null;
  /** Номер группы 1–10; факультет выводится автоматически. */
  groupNo: number | null;
  telegramId?: string;
  role?: 'resident' | 'elder';
  makeFloorElder?: boolean;
}

/** Нормализует номер комнаты: 612а → 612А */
function normRoom(value: string): string {
  return value
    .trim()
    .replace(/а$/i, 'А')
    .replace(/б$/i, 'Б')
    .replace(/a$/i, 'А')
    .replace(/b$/i, 'Б');
}

const FLOOR_6_STUDENTS: StudentInput[] = [
  { room: '605А', last: 'Люй', first: 'Ханхуэй', course: null, groupNo: null, telegramId: '295362084' },
  { room: '605А', last: 'Ван', first: 'Чэнхао', course: null, groupNo: null, telegramId: '295361400' },
  { room: '605А', last: 'Чэнь', first: 'Вэнь', course: null, groupNo: null, telegramId: '295368972' },
  { room: '612А', last: 'Гануш', first: 'Матвей', middle: 'Александрович', course: 1, groupNo: 5, telegramId: '1609358556' },
  { room: '610А', last: 'Морозова', first: 'Анастасия', middle: 'Олеговна', course: 1, groupNo: 5, telegramId: '1535160261' },
  { room: '613Б', last: 'Цык', first: 'Владислав', middle: 'Яковлевич', course: 1, groupNo: 6, telegramId: '1985422211' },
  { room: '602А', last: 'Феоктистов', first: 'Глеб', middle: 'Олегович', course: 1, groupNo: 4, telegramId: '1026780853' },
  { room: '602А', last: 'Бобровский', first: 'Михаил', middle: 'Алексеевич', course: 1, groupNo: 4, telegramId: '1126697478' },
  { room: '609А', last: 'Алехнович', first: 'Вячеслав', middle: 'Алексеевич', course: 1, groupNo: 7, telegramId: '5065534055' },
  { room: '609А', last: 'Захаревич', first: 'Станислав', middle: 'Александрович', course: 1, groupNo: 6, telegramId: '5544933745' },
  { room: '602А', last: 'Антонюк', first: 'Иван', middle: 'Константинович', course: 1, groupNo: 4, telegramId: '1361629343' },
  { room: '612Б', last: 'Козел', first: 'Арсений', middle: 'Михайлович', course: null, groupNo: null, telegramId: '5829131773' },
  { room: '613Б', last: 'Кохненко', first: 'Роман', middle: 'Александрович', course: 1, groupNo: 6, telegramId: '875959064' },
  { room: '610А', last: 'Иванова', first: 'Марина', middle: 'Дмитриевна', course: 1, groupNo: 4, telegramId: '1111874920' },
  { room: '613А', last: 'Карлюк', first: 'Артём', middle: 'Дмитриевич', course: 3, groupNo: 9, telegramId: '1051407653' },
  { room: '609А', last: 'Милевский', first: 'Никита', middle: 'Евгеньевич', course: 1, groupNo: 7, telegramId: '959985331' },
  { room: '602Б', last: 'Сидорик', first: 'Ярослав', middle: 'Андреевич', course: 3, groupNo: 4, telegramId: '1819313874' },
  { room: '602Б', last: 'Ильинковский', first: 'Арсений', middle: 'Станиславович', course: 3, groupNo: 7, telegramId: '1099247282' },
  { room: '615Б', last: 'Бриштель', first: 'Михаил', middle: 'Евгеньевич', course: 2, groupNo: 8, telegramId: '1034091923' },
  { room: '615Б', last: 'Шарабайко', first: 'Глеб', middle: 'Вячеславович', course: 2, groupNo: 8, role: 'elder', makeFloorElder: true },
];

const FLOOR_7_STUDENTS: StudentInput[] = [];

const FACULTIES: Array<[string, string]> = [
  ['ИСИТ', 'Информационные системы и технологии'],
  ['ЦД', 'Цифровые технологии'],
  ['ПИ', 'Программная инженерия'],
  ['ХТИТ', 'Химическая технология и техника'],
  ['—', 'Не указан'],
];

export async function seedProduction(pool: pg.Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    const one = async <T extends pg.QueryResultRow>(
      sql: string,
      params: unknown[] = [],
    ): Promise<T> => {
      const { rows } = await client.query<T>(sql, params);
      const row = rows[0];
      if (!row) throw new Error(`Пустой результат: ${sql.slice(0, 60)}`);
      return row;
    };

    const template = await one<{ id: string }>(
      `INSERT INTO duty_slot_templates (name) VALUES ('Стандарт') RETURNING id`,
    );
    for (let weekday = 1; weekday <= 7; weekday += 1) {
      const slots = weekday === 7 ? SUNDAY_SLOTS : WEEKDAY_SLOTS;
      for (const [order, from, to] of slots) {
        await client.query(
          `INSERT INTO duty_slot_rules (template_id, weekday, slot_order, time_from, time_to)
           VALUES ($1, $2, $3, $4, $5)`,
          [template.id, weekday, order, from, to],
        );
      }
    }

    const ruleSet = await one<{ id: string }>(
      `INSERT INTO duty_rule_sets (name, settings) VALUES ('По умолчанию', $1) RETURNING id`,
      [JSON.stringify(DEFAULT_RULES)],
    );

    const dormitory = await one<{ id: string }>(
      `INSERT INTO dormitories (number, name, warden_name, default_slot_template_id)
       VALUES ('4', 'Общежитие №4', 'Круклинская Л.В.', $1)
       RETURNING id`,
      [template.id],
    );

    const faculties: Record<string, string> = {};
    for (const [i, [code, name]] of FACULTIES.entries()) {
      const row = await one<{ id: string }>(
        `INSERT INTO faculties (dormitory_id, code, name, sort_order)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [dormitory.id, code, name, i],
      );
      faculties[code] = row.id;
    }

    const shift = await one<{ id: string }>(
      `INSERT INTO study_shifts (dormitory_id, code, title, sort_order)
       VALUES ($1, '1', 'Первая смена', 0) RETURNING id`,
      [dormitory.id],
    );

    const floors: Record<string, string> = {};
    for (const number of [6, 7]) {
      const row = await one<{ id: string }>(
        `INSERT INTO floors (dormitory_id, number, slot_template_id, rule_set_id,
                             print_min_rows, print_empty_rooms)
         VALUES ($1, $2, $3, $4, NULL, true)
         RETURNING id`,
        [dormitory.id, number, template.id, ruleSet.id],
      );
      floors[String(number)] = row.id;
    }

    const rooms: Record<string, Record<string, string>> = { '6': {}, '7': {} };

    for (const floorNum of [6, 7] as const) {
      const floorId = floors[String(floorNum)]!;
      let sort = 0;
      for (let blockNo = 601; blockNo <= 616; blockNo += 1) {
        const displayBlockNo = floorNum === 7 ? blockNo + 100 : blockNo;
        const code = String(displayBlockNo);
        const block = await one<{ id: string }>(
          `INSERT INTO blocks (floor_id, code, sort_order) VALUES ($1, $2, $3) RETURNING id`,
          [floorId, code, sort],
        );
        for (const suffix of ['А', 'Б']) {
          const number = `${code}${suffix}`;
          const row = await one<{ id: string }>(
            `INSERT INTO rooms (floor_id, block_id, number, sort_order)
             VALUES ($1, $2, $3, $4) RETURNING id`,
            [floorId, block.id, number, sort],
          );
          rooms[String(floorNum)][number] = row.id;
          sort += 1;
        }
      }
    }

    const addStudent = async (
      floorNum: 6 | 7,
      input: StudentInput,
      sortOrder: number,
    ): Promise<void> => {
      const room = normRoom(input.room);
      const roomId = rooms[String(floorNum)][room];
      if (!roomId) throw new Error(`Комната ${room} не найдена на ${floorNum} этаже`);

      const facultyCode =
        input.groupNo !== null && input.course !== null
          ? facultyForGroup(input.groupNo)
          : input.last === 'Люй' || input.last === 'Ван' || input.last === 'Чэнь'
            ? 'ХТИТ'
            : '—';
      const facultyId = faculties[facultyCode] ?? faculties['—']!;
      const groupCode =
        input.course !== null && input.groupNo !== null
          ? formatGroupCode(input.course, input.groupNo)
          : '—';

      const row = await one<{ id: string }>(
        `INSERT INTO students
           (floor_id, room_id, last_name, first_name, middle_name,
            faculty_id, study_shift_id, course, group_code, telegram_id, sort_order, role)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING id`,
        [
          floors[String(floorNum)]!,
          roomId,
          input.last,
          input.first,
          input.middle ?? null,
          facultyId,
          shift.id,
          input.course,
          groupCode,
          input.telegramId ?? null,
          sortOrder,
          input.role ?? 'resident',
        ],
      );

      if (input.makeFloorElder) {
        await client.query('UPDATE floors SET elder_student_id = $2 WHERE id = $1', [
          floors[String(floorNum)]!,
          row.id,
        ]);
      }

      await client.query(
        `INSERT INTO student_placements
           (student_id, floor_id, block_id, room_id,
            room_number_snapshot, block_code_snapshot, floor_number_snapshot, valid_from)
         SELECT $1, r.floor_id, r.block_id, r.id, r.number, b.code, fl.number, current_date
           FROM rooms r
           JOIN floors fl ON fl.id = r.floor_id
           LEFT JOIN blocks b ON b.id = r.block_id
          WHERE r.id = $2`,
        [row.id, roomId],
      );
    };

    for (const [i, student] of FLOOR_6_STUDENTS.entries()) {
      await addStudent(6, student, i);
    }
    for (const [i, student] of FLOOR_7_STUDENTS.entries()) {
      await addStudent(7, student, i);
    }

    for (const floorId of [floors['6']!, floors['7']!]) {
      await materializeVersion(client, floorId, {
        source: 'setup',
        note: 'Первичное заполнение (production)',
        force: true,
      });
    }
  });
}
