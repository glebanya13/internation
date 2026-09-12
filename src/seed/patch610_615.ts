/**
 * Обновление комнат 610, 612, 613, 614, 615 по бланкам (6 этаж).
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
  course: number | null;
  groupNo: number | null;
  phone?: string;
}

const KEEP_OR_ADD: Person[] = [
  // 610
  { room: '610А', last: 'Никифорова', first: 'Анастасия', middle: 'Денисовна', course: 1, groupNo: 5 },
  { room: '610А', last: 'Иванова', first: 'Марина', middle: 'Дмитриевна', course: 1, groupNo: 4 },
  { room: '610А', last: 'Морозова', first: 'Анастасия', middle: 'Олеговна', course: 1, groupNo: 5 },
  { room: '610Б', last: 'Гулюк', first: 'Ульяна', middle: 'Ивановна', course: 2, groupNo: 5 },
  // 612
  { room: '612А', last: 'Гануш', first: 'Матвей', middle: 'Александрович', course: 1, groupNo: 5 },
  { room: '612А', last: 'Свириденко', first: 'Тимофей', middle: 'Александрович', course: 1, groupNo: 4 },
  { room: '612А', last: 'Сильчук', first: 'Александр', middle: 'Михайлович', course: 1, groupNo: 4 },
  { room: '612Б', last: 'Пацовский', first: 'Виктор', middle: 'Васильевич', course: 2, groupNo: 2, phone: '+375299529045' },
  { room: '612Б', last: 'Козел', first: 'Арсений', middle: 'Михайлович', course: 2, groupNo: 1 },
  // 613
  { room: '613А', last: 'Черник', first: 'Никита', middle: 'Юрьевич', course: 3, groupNo: 9, phone: '+375444734005' },
  { room: '613А', last: 'Карлюк', first: 'Артём', middle: 'Дмитриевич', course: 3, groupNo: 9, phone: '+375257086321' },
  { room: '613А', last: 'Антипов', first: 'Алексей', middle: 'Романович', course: 3, groupNo: 9, phone: '+375445329965' },
  { room: '613Б', last: 'Кохненко', first: 'Роман', middle: 'Александрович', course: 1, groupNo: 6 },
  { room: '613Б', last: 'Цык', first: 'Владислав', middle: 'Яковлевич', course: 1, groupNo: 6 },
  // 614
  { room: '614А', last: 'Богдан', first: 'Дарья', middle: 'Анатольевна', course: 2, groupNo: 6 },
  { room: '614А', last: 'Ивашко', first: 'Анна', middle: 'Викторовна', course: 2, groupNo: 6 },
  { room: '614А', last: 'Филон', first: 'Алина', middle: 'Алексеевна', course: 2, groupNo: 6 },
  { room: '614Б', last: 'Лютаревич', first: 'Виолетта', middle: 'Николаевна', course: 3, groupNo: 3 },
  { room: '614Б', last: 'Садовская', first: 'Анжелика', middle: 'Игоревна', course: 3, groupNo: 3 },
  // 615А (615Б: Бриштель, Шарабайко — без изменений)
  { room: '615А', last: 'Боярчук', first: 'Алексей', middle: 'Николаевич', course: 3, groupNo: 3, phone: '+375298849006' },
  { room: '615А', last: 'Даньков', first: 'Даниил', middle: 'Александрович', course: 2, groupNo: 7 },
];

const MOVE_OUT: Array<{ last: string; first: string }> = [
  { last: 'Угляница', first: 'Михаил' },
  { last: 'Слюсарев', first: 'Иван' },
];

const RENAMES: Array<{ fromLast: string; fromFirst: string; toLast: string }> = [
  { fromLast: 'Молодевич', fromFirst: 'Виолетта', toLast: 'Лютаревич' },
];

/** Нормализация: 8029… / 80… → +375… */
function normalizePhone(raw?: string): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.startsWith('375') && digits.length === 12) return `+${digits}`;
  if (digits.startsWith('80') && digits.length === 11) return `+375${digits.slice(2)}`;
  if (digits.length === 9) return `+375${digits}`;
  return raw.startsWith('+') ? raw : `+${digits}`;
}

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

  // Выселить из 610–615 всех активных, кого нет в KEEP_OR_ADD (кроме 615Б Бриштель/Шарабайко)
  const keepKeys = new Set(KEEP_OR_ADD.map((p) => `${p.last}|${p.first}`));
  keepKeys.add('Бриштель|Михаил');
  keepKeys.add('Шарабайко|Глеб');

  const { rows: current } = await client.query<{
    id: string;
    last_name: string;
    first_name: string;
    room: string;
  }>(
    `SELECT s.id, s.last_name, s.first_name, r.number AS room
       FROM students s
       JOIN rooms r ON r.id = s.room_id
      WHERE s.floor_id = $1 AND s.status = 'active'
        AND r.number ~ '^(610|612|613|614|615)'`,
    [floor.id],
  );

  for (const s of current) {
    if (keepKeys.has(`${s.last_name}|${s.first_name}`)) continue;
    await client.query(
      `UPDATE students
          SET status = 'moved_out', left_at = current_date, updated_at = now()
        WHERE id = $1`,
      [s.id],
    );
    await client.query(
      `UPDATE student_placements SET valid_to = current_date
        WHERE student_id = $1 AND valid_to IS NULL`,
      [s.id],
    );
    console.log(`− ${s.room} ${s.last_name} ${s.first_name} (нет в бланке)`);
  }

  for (const person of KEEP_OR_ADD) {
    const rId = await roomId(person.room);
    const groupCode =
      person.course !== null && person.groupNo !== null
        ? formatGroupCode(person.course, person.groupNo)
        : '—';
    const facultyId =
      person.groupNo !== null
        ? faculties.get(facultyForGroup(person.groupNo))!
        : faculties.get('—')!;
    const phone = normalizePhone(person.phone);

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
                middle_name = COALESCE($6, middle_name),
                phone = COALESCE($7, phone),
                updated_at = now()
          WHERE id = $1`,
        [existing.id, rId, person.course, groupCode, facultyId, person.middle ?? null, phone],
      );
      console.log(`~ ${person.room} ${person.last} ${person.first} → ${groupCode}${phone ? ` ${phone}` : ''}`);
      continue;
    }

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO students
         (floor_id, room_id, last_name, first_name, middle_name,
          faculty_id, study_shift_id, course, group_code, phone, role, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'resident',0)
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
        phone,
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
    console.log(`+ ${person.room} ${person.last} ${person.first} ${groupCode}${phone ? ` ${phone}` : ''}`);
  }

  await materializeVersion(client, floor.id, {
    source: 'manual',
    note: 'Бланки 610, 612, 613, 614, 615',
    force: true,
  });
});

await db.end();
