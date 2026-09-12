import { config } from '../config.js';
import { createPool } from '../db/pool.js';
import { seedDemo } from './demo.js';

const db = createPool(config.databaseUrl);
try {
  const result = await seedDemo(db);
  console.log('Демо-данные загружены.');
  console.log(`  этажей: ${Object.keys(result.floors).length}`);
  console.log(`  комнат: ${Object.keys(result.rooms).length}`);
  console.log(`  студентов: ${Object.keys(result.students).length}`);
} finally {
  await db.end();
}
