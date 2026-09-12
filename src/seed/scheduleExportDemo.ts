import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';
import { createPool } from '../db/pool.js';
import { ScheduleExportService } from '../services/export/scheduleExport.js';
import { generate, publish } from '../services/scheduleService.js';

/** Генерирует и выгружает график. Запуск: npx tsx src/seed/scheduleExportDemo.ts */
const outDir = process.argv[2] ?? join(process.cwd(), 'out');
const db = createPool(config.databaseUrl);

try {
  await mkdir(outDir, { recursive: true });
  const service = new ScheduleExportService(db);

  const { rows: floors } = await db.query<{ id: string; number: number }>(
    'SELECT id, number FROM floors WHERE is_active ORDER BY number',
  );

  for (const [index, floor] of floors.entries()) {
    const result = await generate(db, { floorId: floor.id, year: 2026, month: 9 });
    // Первый этаж публикуем, второй оставляем черновиком —
    // чтобы было видно обе печатные формы.
    if (index === 0) await publish(db, result.scheduleId);

    const files = await service.all(result.scheduleId);
    const base = join(outDir, files.fileBaseName);
    await writeFile(`${base}.html`, files.html, 'utf8');
    await writeFile(`${base}.xlsx`, files.xlsx);
    if (files.pdf) await writeFile(`${base}.pdf`, files.pdf);

    const doc = await service.load(result.scheduleId);
    console.log(
      `${floor.number} этаж · ${doc.status} · дней ${doc.stats.days} · ` +
        `дежурств ${doc.stats.assigned}/${doc.stats.slots} · страниц ${doc.totalPages}`,
    );
    console.log(`  ${files.fileBaseName}.html / .xlsx${files.pdf ? ' / .pdf' : ''}`);
  }
} finally {
  await db.end();
}
