import pg from 'pg';
import { config } from '../src/config.js';
import { seedDemo } from '../src/seed/demo.js';

export type Seed = Awaited<ReturnType<typeof seedDemo>>;

export function testPool(): pg.Pool {
  return new pg.Pool({ connectionString: config.testDatabaseUrl, max: 5 });
}

/** Полная очистка данных между файлами тестов. Схема остаётся. */
export async function truncateAll(db: pg.Pool): Promise<void> {
  const { rows } = await db.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`,
  );
  if (rows.length === 0) return;
  const list = rows.map((r) => `"${r.tablename}"`).join(', ');
  // TRUNCATE обходит триггеры append-only — они защищают от UPDATE/DELETE,
  // а не от пересоздания тестовых данных.
  await db.query(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}

export async function freshSeed(db: pg.Pool): Promise<Seed> {
  await truncateAll(db);
  return seedDemo(db);
}

/** Ожидает, что запрос упадёт с ошибкой БД, и возвращает её. */
export async function expectDbError(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (error) {
    return error as Error;
  }
  throw new Error('Ожидалась ошибка базы данных, но операция прошла успешно');
}
