/**
 * Добавляет Бриштеля и Шарабайко в 615Б на уже работающем production.
 * Шарабайко — староста 6 этажа, из дежурств исключается.
 */
import { config } from '../config.js';
import { createPool, withTransaction } from '../db/pool.js';
import { materializeVersion } from '../services/rosterService.js';

const db = createPool(config.databaseUrl);

await withTransaction(db, async (client) => {
  const floor = (
    await client.query<{ id: string; rule_set_id: string }>(
      'SELECT id, rule_set_id FROM floors WHERE number = 6',
    )
  ).rows[0];
  if (!floor) throw new Error('6 этаж не найден');

  const room = (
    await client.query<{ id: string }>(
      `SELECT id FROM rooms WHERE floor_id = $1 AND number = '615Б'`,
      [floor.id],
    )
  ).rows[0];
  if (!room) throw new Error('Комната 615Б не найдена');

  const facultyPi = (
    await client.query<{ id: string }>('SELECT id FROM faculties WHERE code = $1', ['ПИ'])
  ).rows[0]?.id;
  const facultyDash = (
    await client.query<{ id: string }>('SELECT id FROM faculties WHERE code = $1', ['—'])
  ).rows[0]?.id;
  const shift = (await client.query<{ id: string }>('SELECT id FROM study_shifts LIMIT 1')).rows[0]!;

  const exists = async (last: string, first: string): Promise<string | null> => {
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM students WHERE floor_id = $1 AND last_name = $2 AND first_name = $3`,
      [floor.id, last, first],
    );
    return rows[0]?.id ?? null;
  };

  const add = async (input: {
    last: string;
    first: string;
    middle: string;
    facultyId: string | null;
    course: number | null;
    group: string;
    telegramId?: string;
    role?: 'resident' | 'elder';
  }): Promise<string> => {
    const existing = await exists(input.last, input.first);
    if (existing) return existing;

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO students
         (floor_id, room_id, last_name, first_name, middle_name,
          faculty_id, study_shift_id, course, group_code, telegram_id, role, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,0)
       RETURNING id`,
      [
        floor.id,
        room.id,
        input.last,
        input.first,
        input.middle,
        input.facultyId,
        shift.id,
        input.course,
        input.group,
        input.telegramId ?? null,
        input.role ?? 'resident',
      ],
    );
    const id = rows[0]!.id;

    await client.query(
      `INSERT INTO student_placements
         (student_id, floor_id, block_id, room_id,
          room_number_snapshot, block_code_snapshot, floor_number_snapshot, valid_from)
       SELECT $1, r.floor_id, r.block_id, r.id, r.number, b.code, fl.number, current_date
         FROM rooms r
         JOIN floors fl ON fl.id = r.floor_id
         LEFT JOIN blocks b ON b.id = r.block_id
        WHERE r.id = $2`,
      [id, room.id],
    );
    return id;
  };

  const brishtelId = await add({
    last: 'Бриштель',
    first: 'Михаил',
    middle: 'Евгеньевич',
    facultyId: facultyPi ?? null,
    course: 2,
    group: '8ПИ',
    telegramId: '1034091923',
  });

  const elderId = await add({
    last: 'Шарабайко',
    first: 'Глеб',
    middle: 'Вячеславович',
    facultyId: facultyDash ?? null,
    course: null,
    group: '—',
    role: 'elder',
  });

  await client.query('UPDATE floors SET elder_student_id = $2 WHERE id = $1', [floor.id, elderId]);
  await client.query(
    `UPDATE duty_rule_sets
        SET settings = settings || '{"elder_exempt": true}'::jsonb
      WHERE id = $1`,
    [floor.rule_set_id],
  );

  await materializeVersion(client, floor.id, {
    source: 'manual',
    note: 'Добавлены Бриштель и Шарабайко (615Б), староста — Шарабайко',
    force: true,
  });

  console.log(`Добавлено: Бриштель (${brishtelId}), Шарабайко-староста (${elderId})`);
});

await db.end();
