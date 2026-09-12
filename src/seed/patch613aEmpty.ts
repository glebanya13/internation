/**
 * 613А пустая; для печати — 5 строк на комнату (ручной ввод в пустых).
 */
import { config } from '../config.js';
import { createPool, withTransaction } from '../db/pool.js';
import { materializeVersion } from '../services/rosterService.js';

const MOVE_OUT: Array<{ last: string; first: string }> = [
  { last: 'Антипов', first: 'Алексей' },
  { last: 'Карлюк', first: 'Артём' },
  { last: 'Черник', first: 'Никита' },
];

/** Строк на комнату в бланке списка (как на бумажном бланке). */
const FLOOR_PRINT_MIN_ROWS = 5;

const db = createPool(config.databaseUrl);

await withTransaction(db, async (client) => {
  const floor = (
    await client.query<{ id: string }>('SELECT id FROM floors WHERE number = 6')
  ).rows[0];
  if (!floor) throw new Error('6 этаж не найден');

  for (const person of MOVE_OUT) {
    const { rows } = await client.query<{ id: string }>(
      `UPDATE students
          SET status = 'moved_out', left_at = current_date, updated_at = now()
        WHERE floor_id = $1 AND last_name = $2 AND first_name = $3
          AND status = 'active'
          AND room_id = (SELECT id FROM rooms WHERE floor_id = $1 AND number = '613А')
      RETURNING id`,
      [floor.id, person.last, person.first],
    );
    for (const row of rows) {
      await client.query(
        `UPDATE student_placements SET valid_to = current_date
          WHERE student_id = $1 AND valid_to IS NULL`,
        [row.id],
      );
      console.log(`− 613А ${person.last} ${person.first}`);
    }
  }

  await client.query(
    `UPDATE floors
        SET print_min_rows = $2, print_empty_rooms = true, updated_at = now()
      WHERE id = $1`,
    [floor.id, FLOOR_PRINT_MIN_ROWS],
  );
  console.log(`~ 6 этаж: print_min_rows = ${FLOOR_PRINT_MIN_ROWS}, print_empty_rooms = true`);

  await materializeVersion(client, floor.id, {
    source: 'manual',
    note: '613А пустая; бланк — 5 строк на комнату',
    force: true,
  });
});

await db.end();
