import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';
import { createPool } from '../db/pool.js';
import { RosterExportService, buildRosterDocument } from '../services/export/index.js';

/**
 * Выгружает список каждого этажа во всех форматах.
 * Запуск: npx tsx src/seed/exportDemo.ts [каталог]
 */

const outDir = process.argv[2] ?? join(process.cwd(), 'out');
const db = createPool(config.databaseUrl);

try {
  await mkdir(outDir, { recursive: true });
  const service = new RosterExportService(db);

  const { rows: floors } = await db.query<{ id: string; number: number }>(
    'SELECT id, number FROM floors WHERE is_active ORDER BY number',
  );

  for (const floor of floors) {
    const roster = await service.loadCurrent(floor.id);
    const options = {
      academicYear: '2025-2026',
      signature: { role: 'Заведующий общежитием', name: 'Круклинская Л.В.' },
    };
    const doc = buildRosterDocument(roster, options);
    const result = await service.all(roster, options);

    const base = join(outDir, result.fileBaseName);
    await writeFile(`${base}.html`, result.html, 'utf8');
    await writeFile(`${base}.xlsx`, result.xlsx);
    if (result.pdf) await writeFile(`${base}.pdf`, result.pdf);

    console.log(
      `${floor.number} этаж · ${doc.stats.people} чел. · ` +
        `комнат ${doc.stats.rooms} (пустых ${doc.stats.emptyRooms}) · ` +
        `страниц ${doc.totalPages}`,
    );
    console.log(`  ${result.fileBaseName}.html / .xlsx${result.pdf ? ' / .pdf' : ''}`);
    if (!result.pdf) console.log('  PDF пропущен: браузер не найден (задайте CHROME_PATH)');
  }

  console.log(`\nФайлы в ${outDir}`);
} finally {
  await db.end();
}
