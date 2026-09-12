import pg from 'pg';
import { config } from '../config.js';

const { Pool } = pg;

/** Даты возвращаем строками YYYY-MM-DD, без сдвига часового пояса. */
pg.types.setTypeParser(1082, (value) => value);
/** bigint (telegram_id) — строкой, чтобы не терять точность. */
pg.types.setTypeParser(20, (value) => value);

export type Db = pg.Pool | pg.PoolClient;

let pool: pg.Pool | undefined;

export function getPool(connectionString = config.databaseUrl): pg.Pool {
  pool ??= new Pool({
    connectionString,
    max: config.pgPoolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  return pool;
}

export function createPool(connectionString: string): pg.Pool {
  return new Pool({
    connectionString,
    max: config.pgPoolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
}

export async function closePool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

/** Выполняет работу в транзакции, откатывая её при любой ошибке. */
export async function withTransaction<T>(
  db: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
