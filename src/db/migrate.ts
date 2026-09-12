import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { config } from '../config.js';
import { createPool } from './pool.js';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '../../migrations');

async function ensureMigrationsTable(db: pg.Pool): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function listMigrations(): Promise<string[]> {
  const files = await readdir(migrationsDir);
  return files.filter((f) => f.endsWith('.sql')).sort();
}

/**
 * Прогоняет непринятые миграции. Каждая выполняется в собственной
 * транзакции: неудачная не оставляет схему в половинчатом состоянии.
 */
export async function migrateUp(db: pg.Pool, log = console.log): Promise<string[]> {
  await ensureMigrationsTable(db);
  const { rows } = await db.query<{ name: string }>('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.name));
  const pending = (await listMigrations()).filter((name) => !applied.has(name));

  for (const name of pending) {
    const sql = await readFile(join(migrationsDir, name), 'utf8');
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
      await client.query('COMMIT');
      log(`  применена ${name}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw new Error(`Миграция ${name} не применена: ${(error as Error).message}`, {
        cause: error,
      });
    } finally {
      client.release();
    }
  }
  return pending;
}

/** Полностью очищает схему. Только для разработки и тестов. */
export async function resetSchema(db: pg.Pool): Promise<void> {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'up';
  const db = createPool(config.databaseUrl);
  try {
    if (command === 'reset') {
      await resetSchema(db);
      console.log('Схема очищена.');
      const applied = await migrateUp(db);
      console.log(`Применено миграций: ${applied.length}`);
    } else if (command === 'status') {
      await ensureMigrationsTable(db);
      const { rows } = await db.query<{ name: string }>(
        'SELECT name FROM schema_migrations ORDER BY name',
      );
      const all = await listMigrations();
      const applied = new Set(rows.map((r) => r.name));
      for (const name of all) {
        console.log(`${applied.has(name) ? '✓' : '·'} ${name}`);
      }
    } else {
      const pending = await migrateUp(db);
      console.log(
        pending.length ? `Применено миграций: ${pending.length}` : 'Все миграции уже применены.',
      );
    }
  } finally {
    await db.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error('Ошибка миграции:', (error as Error).message);
    process.exit(1);
  });
}
