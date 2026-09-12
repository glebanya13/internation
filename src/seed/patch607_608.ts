/**
 * Комнаты 607 и 608 (китайский сегмент, 6 этаж) + телефоны с бланков.
 *
 * 607А: Ипао Юй · 607Б: Лю Госи
 * 608А: Лю Лэяо, Лянь Вэньхун, Хуан Чжэсян (ХТИТ)
 * Курс у китайского сегмента не указываем.
 */
import { config } from '../config.js';
import { createPool, withTransaction } from '../db/pool.js';
import { materializeVersion } from '../services/rosterService.js';

interface Person {
  room: string;
  last: string;
  first: string;
  faculty: string;
  course: number | null;
  phone: string;
}

const RESIDENTS: Person[] = [
  { room: '607А', last: 'Ипао', first: 'Юй', faculty: 'ИЭФ', course: null, phone: '+375339938342' },
  { room: '607Б', last: 'Лю', first: 'Госи', faculty: 'ИЭФ', course: null, phone: '+375295571996' },
  { room: '608А', last: 'Лю', first: 'Лэяо', faculty: 'ХТИТ', course: null, phone: '+375297159656' },
  { room: '608А', last: 'Лянь', first: 'Вэньхун', faculty: 'ХТИТ', course: null, phone: '+375295361481' },
  { room: '608А', last: 'Хуан', first: 'Чжэсян', faculty: 'ХТИТ', course: null, phone: '+375295367002' },
];

const EXTRA_FACULTIES: Array<[string, string]> = [
  ['ИЭФ', 'Инженерно-экономический факультет'],
  ['ХТИТ', 'Химическая технология и техника'],
];

const db = createPool(config.databaseUrl);

await withTransaction(db, async (client) => {
  const floor = (
    await client.query<{ id: string }>('SELECT id FROM floors WHERE number = 6')
  ).rows[0];
  if (!floor) throw new Error('6 этаж не найден');

  const dorm = (
    await client.query<{ dormitory_id: string }>(
      'SELECT dormitory_id FROM floors WHERE id = $1',
      [floor.id],
    )
  ).rows[0]!;

  const maxSort = (
    await client.query<{ n: number }>(
      'SELECT COALESCE(MAX(sort_order), 0)::int AS n FROM faculties WHERE dormitory_id = $1',
      [dorm.dormitory_id],
    )
  ).rows[0]!.n;

  for (const [i, [code, name]] of EXTRA_FACULTIES.entries()) {
    await client.query(
      `INSERT INTO faculties (dormitory_id, code, name, sort_order)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (dormitory_id, code) DO NOTHING`,
      [dorm.dormitory_id, code, name, maxSort + i + 1],
    );
  }

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
    const rId = await roomId(person.room);
    const facultyId = faculties.get(person.faculty) ?? faculties.get('ХТИТ')!;

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
            SET room_id = $2, faculty_id = $3, course = $4, phone = $5,
                group_code = '—', updated_at = now()
          WHERE id = $1`,
        [existing.id, rId, facultyId, person.course, person.phone],
      );
      console.log(`~ ${person.room} ${person.last} ${person.first} ${person.phone}`);
      continue;
    }

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO students
         (floor_id, room_id, last_name, first_name,
          faculty_id, study_shift_id, course, group_code, phone, role, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'—',$8,'resident',0)
       RETURNING id`,
      [
        floor.id,
        rId,
        person.last,
        person.first,
        facultyId,
        shift.id,
        person.course,
        person.phone,
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
    console.log(`+ ${person.room} ${person.last} ${person.first} ${person.phone}`);
  }

  await materializeVersion(client, floor.id, {
    source: 'manual',
    note: 'Бланки 607/608 + телефоны',
    force: true,
  });
});

await db.end();
