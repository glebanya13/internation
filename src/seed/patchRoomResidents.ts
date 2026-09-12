/**
 * Жильцы по бланкам комнат 601, 604, 606, 613, 614, 616 (6 этаж).
 * Шершнев Г.А. — администратор, дежурства не выполняет (role = elder).
 */
import { config } from '../config.js';
import { facultyForGroup, formatGroupCode } from '../domain/facultyGroup.js';
import { createPool, withTransaction } from '../db/pool.js';
import { materializeVersion } from '../services/rosterService.js';

interface Resident {
  floor: 6;
  room: string;
  last: string;
  first: string;
  middle?: string;
  course: number | null;
  groupNo: number | null;
  role?: 'resident' | 'elder';
}

const RESIDENTS: Resident[] = [
  // 601 (актуальный бланк)
  { floor: 6, room: '601А', last: 'Бономо', first: 'Софи', course: 2, groupNo: 2 },
  { floor: 6, room: '601А', last: 'Лазук', first: 'Дарья', middle: 'Геннадьевна', course: 3, groupNo: 4 },
  { floor: 6, room: '601А', last: 'Пусовская', first: 'Ульяна', middle: 'Андреевна', course: 3, groupNo: 4 },
  { floor: 6, room: '601Б', last: 'Белова', first: 'Софья', middle: 'Александровна', course: 3, groupNo: 9 },
  { floor: 6, room: '601Б', last: 'Малевич', first: 'Виолетта', middle: 'Андреевна', course: 3, groupNo: 9 },
  // 603
  { floor: 6, room: '603А', last: 'Дегтярёва', first: 'Алина', middle: 'Ивановна', course: 1, groupNo: 6 },
  { floor: 6, room: '603А', last: 'Серкова', first: 'Анна', middle: 'Михайловна', course: 1, groupNo: 6 },
  { floor: 6, room: '603А', last: 'Котович', first: 'Анна', course: 1, groupNo: 6 },
  { floor: 6, room: '603Б', last: 'Искрова', first: 'Юлиана', middle: 'Витальевна', course: 2, groupNo: 6 },
  { floor: 6, room: '603Б', last: 'Короткевич', first: 'Алёна', middle: 'Олеговна', course: 2, groupNo: 6 },
  // 604
  { floor: 6, room: '604Б', last: 'Бунатин', first: 'Максим', middle: 'Моисеевич', course: 1, groupNo: 8 },
  { floor: 6, room: '604Б', last: 'Круговец', first: 'Руслан', middle: 'Николаевич', course: 1, groupNo: 2 },
  { floor: 6, room: '604А', last: 'Мойсеёнок', first: 'Денис', middle: 'Сергеевич', course: 3, groupNo: 2 },
  { floor: 6, room: '604А', last: 'Шершнев', first: 'Глеб', middle: 'Андреевич', course: 3, groupNo: 2, role: 'elder' },
  { floor: 6, room: '604А', last: 'Катков', first: 'Максим', middle: 'Игоревич', course: 3, groupNo: 6 },
  // 606
  { floor: 6, room: '606А', last: 'Лядович', first: 'Екатерина', middle: 'Александровна', course: 2, groupNo: 4 },
  { floor: 6, room: '606А', last: 'Вечерок', first: 'Яна', middle: 'Вадимовна', course: 2, groupNo: 4 },
  { floor: 6, room: '606А', last: 'Исаева', first: 'Диана', middle: 'Дмитриевна', course: 2, groupNo: 7 },
  { floor: 6, room: '606Б', last: 'Фролова', first: 'Александра', middle: 'Геннадьевна', course: 3, groupNo: 9 },
  { floor: 6, room: '606Б', last: 'Садковская', first: 'Дарья', middle: 'Александровна', course: 3, groupNo: 8 },
  // 607 / 608 — китайский сегмент (телефоны — в patch607_608)
  { floor: 6, room: '607А', last: 'Ипао', first: 'Юй', course: null, groupNo: null },
  { floor: 6, room: '607Б', last: 'Лю', first: 'Госи', course: null, groupNo: null },
  { floor: 6, room: '608А', last: 'Лю', first: 'Лэяо', course: null, groupNo: null },
  { floor: 6, room: '608А', last: 'Лянь', first: 'Вэньхун', course: null, groupNo: null },
  { floor: 6, room: '608А', last: 'Хуан', first: 'Чжэсян', course: null, groupNo: null },
  // 610
  { floor: 6, room: '610А', last: 'Никифорова', first: 'Анастасия', middle: 'Денисовна', course: 1, groupNo: 5 },
  { floor: 6, room: '610А', last: 'Иванова', first: 'Марина', middle: 'Дмитриевна', course: 1, groupNo: 4 },
  { floor: 6, room: '610А', last: 'Морозова', first: 'Анастасия', middle: 'Олеговна', course: 1, groupNo: 5 },
  { floor: 6, room: '610Б', last: 'Гулюк', first: 'Ульяна', middle: 'Ивановна', course: 2, groupNo: 5 },
  // 612
  { floor: 6, room: '612А', last: 'Гануш', first: 'Матвей', middle: 'Александрович', course: 1, groupNo: 5 },
  { floor: 6, room: '612А', last: 'Свириденко', first: 'Тимофей', middle: 'Александрович', course: 1, groupNo: 4 },
  { floor: 6, room: '612А', last: 'Сильчук', first: 'Александр', middle: 'Михайлович', course: 1, groupNo: 4 },
  { floor: 6, room: '612Б', last: 'Пацовский', first: 'Виктор', middle: 'Васильевич', course: 2, groupNo: 2 },
  { floor: 6, room: '612Б', last: 'Козел', first: 'Арсений', middle: 'Михайлович', course: 2, groupNo: 1 },
  // 613
  { floor: 6, room: '613А', last: 'Черник', first: 'Никита', middle: 'Юрьевич', course: 3, groupNo: 9 },
  { floor: 6, room: '613А', last: 'Карлюк', first: 'Артём', middle: 'Дмитриевич', course: 3, groupNo: 9 },
  { floor: 6, room: '613А', last: 'Антипов', first: 'Алексей', middle: 'Романович', course: 3, groupNo: 9 },
  { floor: 6, room: '613Б', last: 'Кохненко', first: 'Роман', middle: 'Александрович', course: 1, groupNo: 6 },
  { floor: 6, room: '613Б', last: 'Цык', first: 'Владислав', middle: 'Яковлевич', course: 1, groupNo: 6 },
  // 614
  { floor: 6, room: '614А', last: 'Богдан', first: 'Дарья', middle: 'Анатольевна', course: 2, groupNo: 6 },
  { floor: 6, room: '614А', last: 'Ивашко', first: 'Анна', middle: 'Викторовна', course: 2, groupNo: 6 },
  { floor: 6, room: '614А', last: 'Филон', first: 'Алина', middle: 'Алексеевна', course: 2, groupNo: 6 },
  { floor: 6, room: '614Б', last: 'Лютаревич', first: 'Виолетта', middle: 'Николаевна', course: 3, groupNo: 3 },
  { floor: 6, room: '614Б', last: 'Садовская', first: 'Анжелика', middle: 'Игоревна', course: 3, groupNo: 3 },
  // 615
  { floor: 6, room: '615А', last: 'Боярчук', first: 'Алексей', middle: 'Николаевич', course: 3, groupNo: 3 },
  { floor: 6, room: '615А', last: 'Даньков', first: 'Даниил', middle: 'Александрович', course: 2, groupNo: 7 },
  // 616 — китайский сегмент, 6 этаж
  { floor: 6, room: '616А', last: 'Сунь', first: 'Ивэнь', course: null, groupNo: null },
  { floor: 6, room: '616А', last: 'Се', first: 'Вэньми', course: null, groupNo: null },
  { floor: 6, room: '616А', last: 'Ван', first: 'Чэняо', course: null, groupNo: null },
  { floor: 6, room: '616Б', last: 'Юй', first: 'Мяо', course: null, groupNo: null },
  { floor: 6, room: '616Б', last: 'Чжао', first: 'На', course: null, groupNo: null },
];

/** Исправление по бланку комнаты 613. */
const UPDATES: Array<{ last: string; first: string; course: number; groupNo: number; room: string }> = [
  { last: 'Карлюк', first: 'Артём', course: 3, groupNo: 9, room: '613А' },
];

const db = createPool(config.databaseUrl);

await withTransaction(db, async (client) => {
  const faculties = new Map(
    (await client.query<{ id: string; code: string }>('SELECT id, code FROM faculties')).rows.map(
      (r) => [r.code, r.id],
    ),
  );
  const shift = (await client.query<{ id: string }>('SELECT id FROM study_shifts LIMIT 1')).rows[0]!;

  const floorId = async (num: number): Promise<string> => {
    const row = (await client.query<{ id: string }>('SELECT id FROM floors WHERE number = $1', [num]))
      .rows[0];
    if (!row) throw new Error(`Этаж ${num} не найден`);
    return row.id;
  };

  const roomId = async (fId: string, number: string): Promise<string> => {
    const row = (
      await client.query<{ id: string }>(
        'SELECT id FROM rooms WHERE floor_id = $1 AND number = $2',
        [fId, number],
      )
    ).rows[0];
    if (!row) throw new Error(`Комната ${number} не найдена`);
    return row.id;
  };

  let added = 0;
  let skipped = 0;

  for (const person of RESIDENTS) {
    const fId = await floorId(person.floor);
    const exists = (
      await client.query<{ id: string }>(
        'SELECT id FROM students WHERE floor_id = $1 AND last_name = $2 AND first_name = $3',
        [fId, person.last, person.first],
      )
    ).rows[0];
    if (exists) {
      skipped += 1;
      continue;
    }

    const rId = await roomId(fId, person.room);
    const facultyCode =
      person.groupNo !== null && person.course !== null
        ? facultyForGroup(person.groupNo)
        : 'ХТИТ';
    const groupCode =
      person.course !== null && person.groupNo !== null
        ? formatGroupCode(person.course, person.groupNo)
        : '—';

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO students
         (floor_id, room_id, last_name, first_name, middle_name,
          faculty_id, study_shift_id, course, group_code, role, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0)
       RETURNING id`,
      [
        fId,
        rId,
        person.last,
        person.first,
        person.middle ?? null,
        faculties.get(facultyCode) ?? faculties.get('—'),
        shift.id,
        person.course,
        groupCode,
        person.role ?? 'resident',
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
    added += 1;
    console.log(`+ ${person.floor}эт ${person.room} ${person.last} ${person.first} ${groupCode}`);
  }

  for (const u of UPDATES) {
    const fId = await floorId(6);
    const rId = await roomId(fId, u.room);
    const facultyId = faculties.get(facultyForGroup(u.groupNo))!;
    await client.query(
      `UPDATE students SET course = $3, group_code = $4, faculty_id = $5, room_id = $6, floor_id = $7
        WHERE last_name = $1 AND first_name = $2`,
      [u.last, u.first, u.course, formatGroupCode(u.course, u.groupNo), facultyId, rId, fId],
    );
    console.log(`~ ${u.last} ${u.first} → ${formatGroupCode(u.course, u.groupNo)}`);
  }

  // Шершнев — администратор: исключение старост/elders уже включено (elder_exempt)
  await client.query(
    `UPDATE students SET role = 'elder' WHERE last_name = 'Шершнев' AND first_name = 'Глеб'`,
  );

  await materializeVersion(client, await floorId(6), {
    source: 'manual',
    note: 'Бланки комнат: 601, 604, 606, 613, 614, 616',
    force: true,
  });

  console.log(`\nДобавлено: ${added}, пропущено (уже есть): ${skipped}`);
});

await db.end();
