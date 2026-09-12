/**
 * Обновление комнаты 606 по актуальному бланку (6 этаж).
 *
 * 606А: Лядович Екатерина (2-4), Вечерок Яна (2-4), Исаева Диана (2-7)
 * 606Б: Фролова Александра (3-9), Садковская Дарья (3-8)
 *
 * Выбывает: Жибак Мария. Виерок → Вечерок, Сорковская → Садковская.
 */
import { config } from '../config.js';
import { facultyForGroup, formatGroupCode } from '../domain/facultyGroup.js';
import { createPool, withTransaction } from '../db/pool.js';
import { materializeVersion } from '../services/rosterService.js';

interface Person {
  room: string;
  last: string;
  first: string;
  middle?: string;
  course: number;
  groupNo: number;
}

const KEEP_OR_ADD: Person[] = [
  { room: '606А', last: 'Лядович', first: 'Екатерина', middle: 'Александровна', course: 2, groupNo: 4 },
  { room: '606А', last: 'Вечерок', first: 'Яна', middle: 'Вадимовна', course: 2, groupNo: 4 },
  { room: '606А', last: 'Исаева', first: 'Диана', middle: 'Дмитриевна', course: 2, groupNo: 7 },
  { room: '606Б', last: 'Фролова', first: 'Александра', middle: 'Геннадьевна', course: 3, groupNo: 9 },
  { room: '606Б', last: 'Садковская', first: 'Дарья', middle: 'Александровна', course: 3, groupNo: 8 },
];

const MOVE_OUT: Array<{ last: string; first: string }> = [
  { last: 'Жибак', first: 'Мария' },
];

/** Исправление ошибочно записанных фамилий (тот же человек). */
const RENAMES: Array<{ fromLast: string; fromFirst: string; toLast: string }> = [
  { fromLast: 'Виерок', fromFirst: 'Яна', toLast: 'Вечерок' },
  { fromLast: 'Сорковская', fromFirst: 'Дарья', toLast: 'Садковская' },
];

const db = createPool(config.databaseUrl);

await withTransaction(db, async (client) => {
  const floor = (
    await client.query<{ id: string }>('SELECT id FROM floors WHERE number = 6')
  ).rows[0];
  if (!floor) throw new Error('6 этаж не найден');

  const faculties = new Map(
    (await client.query<{ id: string; code: string }>('SELECT id, code FROM faculties')).rows.map(
      (r) => [r.code, r.id],
    ),
  );
  const shift = (await client.query<{ id: string }>('SELECT id FROM study_shifts LIMIT 1')).rows[0]!;

  const roomId = async (number: string): Promise<string> => {
    const row = (
      await client.query<{ id: string }>(
        'SELECT id FROM rooms WHERE floor_id = $1 AND number = $2',
        [floor.id, number],
      )
    ).rows[0];
    if (!row) throw new Error(`Комната ${number} не найдена`);
    return row.id;
  };

  for (const rename of RENAMES) {
    const { rowCount } = await client.query(
      `UPDATE students SET last_name = $3, updated_at = now()
        WHERE floor_id = $1 AND last_name = $2 AND first_name = $4 AND status = 'active'`,
      [floor.id, rename.fromLast, rename.toLast, rename.fromFirst],
    );
    if (rowCount) console.log(`~ фамилия ${rename.fromLast} → ${rename.toLast}`);
  }

  for (const person of MOVE_OUT) {
    const { rows } = await client.query<{ id: string }>(
      `UPDATE students
          SET status = 'moved_out', left_at = current_date, updated_at = now()
        WHERE floor_id = $1 AND last_name = $2 AND first_name = $3 AND status = 'active'
      RETURNING id`,
      [floor.id, person.last, person.first],
    );
    for (const row of rows) {
      await client.query(
        `UPDATE student_placements SET valid_to = current_date
          WHERE student_id = $1 AND valid_to IS NULL`,
        [row.id],
      );
      console.log(`− ${person.last} ${person.first}`);
    }
  }

  for (const person of KEEP_OR_ADD) {
    const rId = await roomId(person.room);
    const groupCode = formatGroupCode(person.course, person.groupNo);
    const facultyId = faculties.get(facultyForGroup(person.groupNo))!;

    const existing = (
      await client.query<{ id: string }>(
        `SELECT id FROM students
          WHERE floor_id = $1 AND last_name = $2 AND first_name = $3 AND status = 'active'`,
        [floor.id, person.last, person.first],
      )
    ).rows[0];

    if (existing) {
      await client.query(
        `UPDATE students
            SET room_id = $2, course = $3, group_code = $4, faculty_id = $5,
                middle_name = COALESCE($6, middle_name), updated_at = now()
          WHERE id = $1`,
        [existing.id, rId, person.course, groupCode, facultyId, person.middle ?? null],
      );
      console.log(`~ ${person.room} ${person.last} ${person.first} → ${groupCode}`);
      continue;
    }

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO students
         (floor_id, room_id, last_name, first_name, middle_name,
          faculty_id, study_shift_id, course, group_code, role, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'resident',0)
       RETURNING id`,
      [
        floor.id,
        rId,
        person.last,
        person.first,
        person.middle ?? null,
        facultyId,
        shift.id,
        person.course,
        groupCode,
      ],
    );

    await client.query(
      `INSERT INTO student_placements
         (student_id, floor_id, block_id, room_id,
          room_number_snapshot, block_code_snapshot, floor_number_snapshot, valid_from)
       SELECT $1, r.floor_id, r.block_id, r.id, r.number, b.code, fl.number, current_date
         FROM rooms r
         JOIN floors fl ON fl.id = r.floor_id
         LEFT JOIN blocks b ON b.id = r.block_id
        WHERE r.id = $2`,
      [rows[0]!.id, rId],
    );
    console.log(`+ ${person.room} ${person.last} ${person.first} ${groupCode}`);
  }

  await materializeVersion(client, floor.id, {
    source: 'manual',
    note: 'Обновление бланка комнаты 606',
    force: true,
  });
});

await db.end();
