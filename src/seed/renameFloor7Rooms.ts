/**
 * Переименование комнат и блоков 7 этажа: 601–616 → 701–716.
 */
import { config } from '../config.js';
import { createPool, withTransaction } from '../db/pool.js';
import { materializeVersion } from '../services/rosterService.js';

const db = createPool(config.databaseUrl);

function toFloor7Number(value: string): string {
  if (!/^6\d{2}/.test(value)) return value;
  return `7${value.slice(1)}`;
}

await withTransaction(db, async (client) => {
  const floor = (
    await client.query<{ id: string }>('SELECT id FROM floors WHERE number = 7')
  ).rows[0];
  if (!floor) throw new Error('7 этаж не найден');

  const blocks = (
    await client.query<{ id: string; code: string }>(
      'SELECT id, code FROM blocks WHERE floor_id = $1 ORDER BY code',
      [floor.id],
    )
  ).rows;

  for (const block of blocks) {
    const next = toFloor7Number(block.code);
    if (next === block.code) continue;
    await client.query('UPDATE blocks SET code = $2 WHERE id = $1', [block.id, next]);
    console.log(`block ${block.code} → ${next}`);
  }

  const rooms = (
    await client.query<{ id: string; number: string }>(
      'SELECT id, number FROM rooms WHERE floor_id = $1 ORDER BY number',
      [floor.id],
    )
  ).rows;

  for (const room of rooms) {
    const next = toFloor7Number(room.number);
    if (next === room.number) continue;
    await client.query('UPDATE rooms SET number = $2 WHERE id = $1', [room.id, next]);
    console.log(`room ${room.number} → ${next}`);
  }

  const { rowCount: placements } = await client.query(
    `UPDATE student_placements
        SET room_number_snapshot = '7' || substring(room_number_snapshot from 2),
            block_code_snapshot = CASE
              WHEN block_code_snapshot ~ '^6[0-9]{2}$'
              THEN '7' || substring(block_code_snapshot from 2)
              ELSE block_code_snapshot
            END
      WHERE floor_number_snapshot = 7
        AND room_number_snapshot ~ '^6[0-9]{2}'`,
  );
  console.log(`placements: ${placements}`);

  const { rowCount: duties } = await client.query(
    `UPDATE duties d
        SET room_number_snapshot = '7' || substring(d.room_number_snapshot from 2)
       FROM duty_schedules ds
      WHERE ds.id = d.schedule_id
        AND ds.floor_id = $1
        AND d.room_number_snapshot ~ '^6[0-9]{2}'`,
    [floor.id],
  );
  console.log(`duties: ${duties}`);

  await materializeVersion(client, floor.id, {
    source: 'manual',
    note: 'Переименование комнат 601–616 → 701–716',
    force: true,
  });
});

await db.end();
