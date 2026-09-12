import type pg from 'pg';
import { withTransaction } from '../db/pool.js';
import { materializeVersion } from '../services/rosterService.js';

/**
 * ДЕМОНСТРАЦИОННЫЕ ДАННЫЕ.
 *
 * Всё содержимое этого файла — строки в таблицах, а не конфигурация кода.
 * Номера этажей, коды факультетов и времена смен здесь появляются ровно
 * один раз — при первичном заполнении — и дальше редактируются
 * администратором. В src/ нет ни одной проверки вида
 * `floor === 6` или `faculty === 'ФИТ'`; тест
 * tests/invariants/no-hardcoded-config.test.ts следит за этим.
 *
 * Специально смоделированы состояния, которые должны быть валидными:
 *   · блок с частичным заселением (605А — 2 человека, 605Б — 1);
 *   · полностью пустой блок (607А, 607Б — 0 человек);
 *   · пустая комната на этаже без блоков (704);
 *   · этаж со смешанным составом факультетов.
 */

/** Сетка смен из уточнённых требований. Пн–Сб одна, Вс другая. */
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
  elder_exempt: false,
  exclude_non_active: true,
  excluded_dates: [] as string[],
  allow_quota_overflow: false,
  max_load_spread: 1,
};

interface SeedResult {
  dormitoryId: string;
  floors: Record<string, string>;
  faculties: Record<string, string>;
  shifts: Record<string, string>;
  rooms: Record<string, string>;
  students: Record<string, string>;
}

export async function seedDemo(pool: pg.Pool): Promise<SeedResult> {
  return withTransaction(pool, async (client) => {
    const one = async <T extends pg.QueryResultRow>(
      sql: string,
      params: unknown[] = [],
    ): Promise<T> => {
      const { rows } = await client.query<T>(sql, params);
      const row = rows[0];
      if (!row) throw new Error(`Пустой результат: ${sql.slice(0, 60)}`);
      return row;
    };

    // ── Шаблон смен ───────────────────────────────────────────────────
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

    // ── Общежитие ─────────────────────────────────────────────────────
    const dormitory = await one<{ id: string }>(
      `INSERT INTO dormitories (number, name, warden_name, default_slot_template_id)
       VALUES ('4', 'Общежитие №4', 'Круклинская Л.В.', $1)
       RETURNING id`,
      [template.id],
    );

    // ── Справочники ───────────────────────────────────────────────────
    // Два факультета, чтобы «этаж ≠ факультет» было видно на данных,
    // а не только в схеме.
    const faculties: Record<string, string> = {};
    for (const [i, [code, name]] of (
      [
        ['ФИТ', 'Факультет информационных технологий'],
        ['ТОВ', 'Технологии органических веществ'],
      ] as const
    ).entries()) {
      const row = await one<{ id: string }>(
        `INSERT INTO faculties (dormitory_id, code, name, sort_order)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [dormitory.id, code, name, i],
      );
      faculties[code] = row.id;
    }

    // busy_from / busy_to намеренно NULL: фактические часы учёбы
    // ещё не заданы заказчиком. Пока они пусты, ограничение по учебному
    // времени не применяется, и генератор сообщает об этом явно.
    const shifts: Record<string, string> = {};
    for (const [i, [code, title]] of (
      [
        ['1', 'Первая смена'],
        ['2', 'Вторая смена'],
      ] as const
    ).entries()) {
      const row = await one<{ id: string }>(
        `INSERT INTO study_shifts (dormitory_id, code, title, sort_order)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [dormitory.id, code, title, i],
      );
      shifts[code] = row.id;
    }

    // ── Этажи ─────────────────────────────────────────────────────────
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

    const floor6 = floors['6']!;
    const floor7 = floors['7']!;
    const rooms: Record<string, string> = {};

    const addRoom = async (
      floorId: string,
      number: string,
      blockId: string | null,
      sortOrder: number,
    ): Promise<void> => {
      const row = await one<{ id: string }>(
        `INSERT INTO rooms (floor_id, block_id, number, sort_order)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [floorId, blockId, number, sortOrder],
      );
      rooms[number] = row.id;
    };

    // 6 этаж — с блоками. 607 остаётся полностью пустым: блок существует
    // в структуре, но в нём никто не живёт. Это валидное состояние.
    let sort = 0;
    for (const code of ['601', '605', '607']) {
      const block = await one<{ id: string }>(
        `INSERT INTO blocks (floor_id, code, sort_order) VALUES ($1, $2, $3) RETURNING id`,
        [floor6, code, sort],
      );
      for (const suffix of ['А', 'Б']) {
        await addRoom(floor6, `${code}${suffix}`, block.id, sort);
        sort += 1;
      }
    }

    // 7 этаж — плоская нумерация, без блоков. 704 останется пустой.
    sort = 0;
    for (const number of ['701', '702', '703', '704']) {
      await addRoom(floor7, number, null, sort);
      sort += 1;
    }

    // ── Студенты ──────────────────────────────────────────────────────
    const students: Record<string, string> = {};
    const addStudent = async (input: {
      floorId: string;
      room: string;
      last: string;
      first: string;
      faculty: string;
      shift: string;
      course: number;
      group: string;
      sortOrder: number;
    }): Promise<void> => {
      const row = await one<{ id: string }>(
        `INSERT INTO students
           (floor_id, room_id, last_name, first_name, faculty_id, study_shift_id,
            course, group_code, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id`,
        [
          input.floorId,
          rooms[input.room],
          input.last,
          input.first,
          faculties[input.faculty],
          shifts[input.shift],
          input.course,
          input.group,
          input.sortOrder,
        ],
      );
      students[`${input.last} ${input.first}`] = row.id;
      await client.query(
        `INSERT INTO student_placements
           (student_id, floor_id, block_id, room_id,
            room_number_snapshot, block_code_snapshot, floor_number_snapshot, valid_from)
         SELECT $1, r.floor_id, r.block_id, r.id, r.number, b.code, fl.number, current_date
           FROM rooms r
           JOIN floors fl ON fl.id = r.floor_id
           LEFT JOIN blocks b ON b.id = r.block_id
          WHERE r.id = $2`,
        [row.id, rooms[input.room]],
      );
    };

    // 601А заселена полностью, 601Б частично, 605А два человека,
    // 605Б один, 607А и 607Б пусты.
    const floor6People: Array<[string, string, string, string, string, number, string]> = [
      ['601А', 'Иванов', 'Иван', 'ФИТ', '2', 2, '1'],
      ['601А', 'Петров', 'Пётр', 'ФИТ', '2', 2, '1'],
      ['601А', 'Смирнов', 'Алексей', 'ФИТ', '1', 1, '4'],
      ['601Б', 'Кузнецов', 'Дмитрий', 'ФИТ', '1', 1, '4'],
      ['605А', 'Соколов', 'Никита', 'ФИТ', '2', 3, '2'],
      ['605А', 'Морозов', 'Артём', 'ТОВ', '1', 2, '7'],
      ['605Б', 'Волков', 'Егор', 'ФИТ', '2', 1, '5'],
    ];
    for (const [i, [room, last, first, faculty, shift, course, group]] of floor6People.entries()) {
      await addStudent({
        floorId: floor6,
        room,
        last,
        first,
        faculty,
        shift,
        course,
        group,
        sortOrder: i,
      });
    }

    const floor7People: Array<[string, string, string, string, string, number, string]> = [
      ['701', 'Лебедев', 'Максим', 'ФИТ', '2', 1, '3'],
      ['701', 'Козлов', 'Илья', 'ФИТ', '2', 1, '3'],
      ['702', 'Новиков', 'Кирилл', 'ФИТ', '1', 2, '6'],
      ['702', 'Орлов', 'Владислав', 'ТОВ', '2', 4, '9'],
      ['703', 'Макаров', 'Роман', 'ФИТ', '1', 3, '2'],
    ];
    for (const [i, [room, last, first, faculty, shift, course, group]] of floor7People.entries()) {
      await addStudent({
        floorId: floor7,
        room,
        last,
        first,
        faculty,
        shift,
        course,
        group,
        sortOrder: i,
      });
    }

    // ── Первичные версии состава ──────────────────────────────────────
    for (const floorId of [floor6, floor7]) {
      await materializeVersion(client, floorId, {
        source: 'setup',
        note: 'Первичное заполнение',
        force: true,
      });
    }

    return {
      dormitoryId: dormitory.id,
      floors,
      faculties,
      shifts,
      rooms,
      students,
    };
  });
}
