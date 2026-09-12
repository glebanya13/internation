/**
 * Комната 603 по бланку (6 этаж).
 *
 * 603А: Дегтярёва Алина (1-6), Серкова Анна (1-6), Котович Анна (1-6)
 * 603Б: Искрова Юлиана (2-6), Короткевич Алёна (2-6)
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

const RESIDENTS: Person[] = [
  { room: '603А', last: 'Дегтярёва', first: 'Алина', middle: 'Ивановна', course: 1, groupNo: 6 },
  { room: '603А', last: 'Серкова', first: 'Анна', middle: 'Михайловна', course: 1, groupNo: 6 },
  { room: '603А', last: 'Котович', first: 'Анна', course: 1, groupNo: 6 },
  { room: '603Б', last: 'Искрова', first: 'Юлиана', middle: 'Витальевна', course: 2, groupNo: 6 },
  { room: '603Б', last: 'Короткевич', first: 'Алёна', middle: 'Олеговна', course: 2, groupNo: 6 },
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

  for (const person of RESIDENTS) {
    const exists = (
      await client.query<{ id: string }>(
        `SELECT id FROM students
          WHERE floor_id = $1 AND last_name = $2 AND first_name = $3 AND status = 'active'`,
        [floor.id, person.last, person.first],
      )
    ).rows[0];
    if (exists) {
      console.log(`= уже есть ${person.last} ${person.first}`);
      continue;
    }

    const rId = await roomId(person.room);
    const groupCode = formatGroupCode(person.course, person.groupNo);
    const facultyId = faculties.get(facultyForGroup(person.groupNo))!;

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
    note: 'Бланк комнаты 603',
    force: true,
  });
});

await db.end();
