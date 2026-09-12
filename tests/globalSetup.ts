import pg from 'pg';
import { config } from '../src/config.js';
import { migrateUp } from '../src/db/migrate.js';

/**
 * Тестовая база пересоздаётся с нуля перед прогоном: инварианты проверяются
 * на схеме, собранной ровно теми же миграциями, что уйдут в продакшен.
 */
export default async function setup(): Promise<void> {
  const db = new pg.Pool({ connectionString: config.testDatabaseUrl, max: 2 });
  try {
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrateUp(db, () => {});
  } finally {
    await db.end();
  }
}
