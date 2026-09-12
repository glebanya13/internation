/**
 * 7 этаж: Наркевич → ФИТ; у китайцев без курса/группы.
 */
import { config } from '../config.js';
import { createPool, withTransaction } from '../db/pool.js';
import { materializeVersion } from '../services/rosterService.js';

const db = createPool(config.databaseUrl);

await withTransaction(db, async (client) => {
  const floor = (
    await client.query<{ id: string; dormitory_id: string }>(
      'SELECT id, dormitory_id FROM floors WHERE number = 7',
    )
  ).rows[0];
  if (!floor) throw new Error('7 этаж не найден');

  const fit = (
    await client.query<{ id: string }>(
      `SELECT id FROM faculties WHERE code = 'ФИТ' AND (dormitory_id = $1 OR dormitory_id IS NULL)`,
      [floor.dormitory_id],
    )
  ).rows[0];
  if (!fit) throw new Error('Факультет ФИТ не найден');

  await client.query(
    `UPDATE students SET faculty_id = $2, updated_at = now()
      WHERE floor_id = $1 AND last_name = 'Наркевич' AND first_name = 'Елена'`,
    [floor.id, fit.id],
  );
  console.log('~ Наркевич Елена → ФИТ');

  const { rowCount } = await client.query(
    `UPDATE students s
        SET course = NULL, group_code = NULL, updated_at = now()
       FROM faculties f
      WHERE s.faculty_id = f.id
        AND s.floor_id = $1
        AND f.code IN ('ИЭФ', 'ХТИТ')`,
    [floor.id],
  );
  console.log(`~ китайский сегмент: очищен курс/группа у ${rowCount} чел.`);

  await client.query(
    `UPDATE floors SET print_empty_rooms = true WHERE id = $1`,
    [floor.id],
  );

  await materializeVersion(client, floor.id, {
    source: 'manual',
    note: 'ФИТ для Наркевич; китайцы без курса/группы',
    force: true,
  });
});

await db.end();
