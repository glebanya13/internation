import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { createPool } from '../db/pool.js';
import { generate } from '../services/scheduleService.js';

/** Три прогона подряд должны дать побайтово одинаковые назначения. */
const db = createPool(config.databaseUrl);
try {
  const { rows } = await db.query<{ id: string }>(
    'SELECT id FROM floors ORDER BY number LIMIT 1',
  );
  const floorId = rows[0]!.id;
  const hashes: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    const result = await generate(db, { floorId, year: 2026, month: 9 });
    hashes.push(
      createHash('sha256')
        .update(JSON.stringify(result.generation.assignments))
        .digest('hex')
        .slice(0, 16),
    );
  }
  console.log(hashes.join('\n'));
  console.log(new Set(hashes).size === 1 ? 'ВОСПРОИЗВОДИМО' : 'РАСХОЖДЕНИЕ');
} finally {
  await db.end();
}
