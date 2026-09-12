/**
 * Перенос всех студентов с 7 на 6 этаж (те же номера комнат).
 */
import { config } from '../config.js';
import { createPool, withTransaction } from '../db/pool.js';
import { materializeVersion } from '../services/rosterService.js';

const db = createPool(config.databaseUrl);

await withTransaction(db, async (client) => {
  const floors = await client.query<{ id: string; number: number; elder_student_id: string | null }>(
    'SELECT id, number, elder_student_id FROM floors WHERE number IN (6, 7) ORDER BY number',
  );
  const floor6 = floors.rows.find((f) => f.number === 6);
  const floor7 = floors.rows.find((f) => f.number === 7);
  if (!floor6 || !floor7) throw new Error('Этажи 6 и 7 не найдены');

  const { rowCount } = await client.query(
    `UPDATE students s
        SET floor_id = $1,
            room_id = r6.id,
            updated_at = now()
       FROM rooms r7
       JOIN rooms r6 ON r6.floor_id = $1 AND r6.number = r7.number
      WHERE s.floor_id = $2
        AND r7.id = s.room_id
        AND s.status = 'active'`,
    [floor6.id, floor7.id],
  );

  // Закрыть старые placements и открыть новые на 6 этаже
  await client.query(
    `UPDATE student_placements sp
        SET valid_to = current_date
       FROM students s
      WHERE sp.student_id = s.id
        AND s.floor_id = $1
        AND sp.valid_to IS NULL
        AND sp.floor_id = $2`,
    [floor6.id, floor7.id],
  );

  await client.query(
    `INSERT INTO student_placements
       (student_id, floor_id, block_id, room_id,
        room_number_snapshot, block_code_snapshot, floor_number_snapshot, valid_from)
     SELECT s.id, r.floor_id, r.block_id, r.id, r.number, b.code, 6, current_date
       FROM students s
       JOIN rooms r ON r.id = s.room_id
       LEFT JOIN blocks b ON b.id = r.block_id
      WHERE s.floor_id = $1
        AND NOT EXISTS (
          SELECT 1 FROM student_placements sp
           WHERE sp.student_id = s.id AND sp.valid_to IS NULL
        )`,
    [floor6.id],
  );

  // Староста переезжает на 6 этаж
  if (floor7.elder_student_id) {
    await client.query('UPDATE floors SET elder_student_id = $2 WHERE id = $1', [
      floor6.id,
      floor7.elder_student_id,
    ]);
    await client.query('UPDATE floors SET elder_student_id = NULL WHERE id = $1', [floor7.id]);
  }

  await materializeVersion(client, floor6.id, {
    source: 'manual',
    note: 'Перенос всех студентов с 7 на 6 этаж',
    force: true,
  });
  await materializeVersion(client, floor7.id, {
    source: 'manual',
    note: 'Состав этажа опустел после переноса на 6',
    force: true,
  });

  const { rows } = await client.query<{ floor: number; count: string }>(
    `SELECT f.number AS floor, count(s.id)::text AS count
       FROM floors f
       LEFT JOIN students s ON s.floor_id = f.id AND s.status = 'active'
      WHERE f.number IN (6, 7)
      GROUP BY f.number
      ORDER BY f.number`,
  );

  console.log(`Перенесено студентов: ${rowCount}`);
  for (const row of rows) {
    console.log(`  ${row.floor} этаж: ${row.count} студентов`);
  }
});

await db.end();
