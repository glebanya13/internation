import { config } from '../config.js';
import { createPool } from '../db/pool.js';
import { seedProduction } from './production.js';

/**
 * Удаляет демо-данные и загружает production-состав.
 * Учётные записи администраторов сохраняются.
 */
const PRESERVE = new Set([
  'schema_migrations',
  'admin_users',
  'admin_sessions',
  'admin_floor_scopes',
]);

const db = createPool(config.databaseUrl);

try {
  const { rows } = await db.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'`,
  );

  const toTruncate = rows
    .map((r) => r.tablename)
    .filter((name) => !PRESERVE.has(name));

  if (toTruncate.length > 0) {
    // CASCADE с dormitories снёс бы admin_users по FK. Сначала отвязываем админов.
    await db.query('UPDATE admin_users SET dormitory_id = NULL');
    await db.query('DELETE FROM admin_sessions');
    await db.query('DELETE FROM admin_floor_scopes');
    const list = toTruncate.map((n) => `"${n}"`).join(', ');
    await db.query(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
    console.log(`Очищено таблиц: ${toTruncate.length} (admin_users сохранены)`);
  }

  await seedProduction(db);
  console.log('Production-данные загружены.');

  const { rows: counts } = await db.query<{ floor: number; students: string }>(
    `SELECT f.number AS floor, count(s.id)::text AS students
       FROM floors f
       LEFT JOIN students s ON s.floor_id = f.id AND s.status = 'active'
      GROUP BY f.number
      ORDER BY f.number`,
  );
  for (const row of counts) {
    console.log(`  ${row.floor} этаж: ${row.students} студентов`);
  }

  console.log('\nКитайцы также живут в 607, 608, 616 — добавьте через админку при необходимости.');
} finally {
  await db.end();
}
