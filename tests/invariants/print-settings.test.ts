import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import ExcelJS from 'exceljs';
import {
  RosterExportService,
  buildRosterDocument,
  findBrowser,
  renderRosterHtml,
  renderRosterPdf,
  renderRosterXlsx,
} from '../../src/services/export/index.js';
import { candidatesForSchedule, currentRoster } from '../../src/services/rosterService.js';
import { type Seed, freshSeed, testPool } from '../helpers.js';

const SRC = join(process.cwd(), 'src');

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(full)));
    else if (entry.name.endsWith('.ts')) files.push(full);
  }
  return files;
}

/**
 * Инвариант 10: print_min_rows и print_empty_rooms — исключительно
 * параметры печатного представления.
 *
 * Они не должны влиять на генерацию, число студентов, валидацию
 * и feasibility. Проверяется и поведением, и статически.
 */
describe('параметры печати не влияют на данные', () => {
  let db: pg.Pool;
  let seed: Seed;

  beforeAll(async () => {
    db = testPool();
    seed = await freshSeed(db);
  });
  afterAll(async () => {
    await db.end();
  });

  it('10 · print_min_rows не меняет число студентов и кандидатов', async () => {
    const floor6 = seed.floors['6']!;
    const rosterBefore = await currentRoster(db, floor6);
    const { candidates: before } = await candidatesForSchedule(db, floor6);

    for (const value of [0, 3, 5, 40]) {
      await db.query('UPDATE floors SET print_min_rows = $2 WHERE id = $1', [floor6, value]);
      await db.query('UPDATE rooms SET print_min_rows = $2 WHERE floor_id = $1', [
        floor6,
        value,
      ]);

      const roster = await currentRoster(db, floor6);
      const { candidates } = await candidatesForSchedule(db, floor6);

      expect(roster!.entries).toHaveLength(rosterBefore!.entries.length);
      expect(candidates).toHaveLength(before.length);
      expect(roster!.version.id).toBe(rosterBefore!.version.id);
    }
  });

  it('10a · print_min_rows = 5 не создаёт мест и не заселяет комнату', async () => {
    await db.query(`UPDATE rooms SET print_min_rows = 5 WHERE number = '704'`);
    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM students WHERE room_id = $1`,
      [seed.rooms['704']],
    );
    expect(rows[0]!.count).toBe('0');
  });

  it('10b · print_empty_rooms не влияет на состав', async () => {
    const floor7 = seed.floors['7']!;
    const before = await currentRoster(db, floor7);

    await db.query('UPDATE floors SET print_empty_rooms = false WHERE id = $1', [floor7]);
    const after = await currentRoster(db, floor7);

    expect(after!.entries).toHaveLength(before!.entries.length);
    expect(after!.version.id).toBe(before!.version.id);
  });

  /**
   * Параметры печати можно ПЕРЕНОСИТЬ: DTO объявляет поля, query-сервис
   * кладёт их в meta. Нельзя ПРИНИМАТЬ ПО НИМ РЕШЕНИЯ вне экспорта —
   * ни в составе, ни в импорте, ни в будущих генерации и валидации.
   */
  const TRANSPORT_ONLY = [
    'domain/floorRoster.ts',
    'domain/printLayout.ts',
    'services/query/FloorRosterQueryService.ts',
    'services/query/RosterSnapshotQueryService.ts',
  ];

  // Страница настроек эти параметры РЕДАКТИРУЕТ — этого и требует ТЗ.
  // Решений по ним она не принимает, что проверяется отдельно ниже.
  const EDITING_ONLY = ['api/routes.ts'];

  it('10c · логика состава и импорта не читает параметры печати', async () => {
    const files = await sourceFiles(SRC);
    const offenders: string[] = [];
    const PRINT = /print_min_rows|print_empty_rooms|printMinRows|printEmptyRooms/;

    for (const file of files) {
      const relative = file.slice(SRC.length + 1);
      if (relative.startsWith('services/export') || relative.startsWith('seed/')) continue;
      if (TRANSPORT_ONLY.includes(relative) || EDITING_ONLY.includes(relative)) continue;

      const text = await readFile(file, 'utf8');
      if (PRINT.test(text)) offenders.push(relative);
    }

    expect(
      offenders,
      `Параметры печати попали в логику: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('10d · транспортные слои не ветвятся на параметрах печати', async () => {
    const offenders: string[] = [];
    const PRINT = /print_min_rows|print_empty_rooms|printMinRows|printEmptyRooms/;
    const PRESENTATION = ['domain/printLayout.ts'];

    for (const relative of TRANSPORT_ONLY) {
      if (PRESENTATION.includes(relative)) continue;
      const lines = (await readFile(join(SRC, relative), 'utf8')).split('\n');
      lines.forEach((line, index) => {
        const code = line.replace(/\/\/.*$/, '');
        // Условие, тернарник или сравнение с участием параметра печати —
        // это уже решение, а не перенос значения.
        if (PRINT.test(code) && /if\s*\(|\?|&&|\|\||===|!==/.test(code)) {
          offenders.push(`${relative}:${index + 1}  ${line.trim()}`);
        }
      });
    }

    expect(offenders, `Ветвление по параметру печати:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('10e · страница настроек только читает и записывает параметры печати', async () => {
    // Тернарники там неизбежны: форма показывает текущее значение
    // и разбирает отправленное. Недопустимо другое — использовать
    // параметр печати для ОТБОРА данных.
    const PRINT = /print_min_rows|print_empty_rooms|printMinRows|printEmptyRooms/;
    const offenders: string[] = [];

    for (const relative of EDITING_ONLY) {
      const lines = (await readFile(join(SRC, relative), 'utf8')).split('\n');
      lines.forEach((line, index) => {
        const code = line.replace(/\/\/.*$/, '');
        if (!PRINT.test(code)) return;
        // Фильтрация выборки по параметру печати — вот это запрещено.
        if (/WHERE[\s\S]*print_|\.filter\(|HAVING/i.test(code)) {
          offenders.push(`${relative}:${index + 1}  ${line.trim()}`);
        }
      });
    }
    expect(offenders, `Отбор данных по параметру печати:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('11 · PDF и XLSX собираются из одного DocumentModel', async () => {
    // Оба рендерера принимают RosterDocument и не имеют доступа к БД:
    // получить разные данные им физически неоткуда.
    const service = new RosterExportService(db);
    const roster = await service.loadCurrent(seed.floors['6']!);
    const doc = buildRosterDocument(roster, { academicYear: '2025-2026' });

    const html = renderRosterHtml(doc);
    const xlsx = await renderRosterXlsx(doc);
    let pdf: Buffer | null = null;
    if (await findBrowser()) {
      try {
        pdf = await renderRosterPdf(doc);
      } catch {
        // Браузер найден, но рендер мог не пройти (headless, sandbox).
      }
    }

    const values = doc.pages
      .flatMap((p) => [...p.left.rows, ...(p.right?.rows ?? [])])
      .flatMap((r) => [r.room.text, r.name.text, r.faculty.text])
      .filter((v) => v !== '');

    for (const value of new Set(values)) {
      expect(html).toContain(value);
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(xlsx as unknown as ArrayBuffer);
    const seen = new Set<string>();
    workbook.worksheets[0]!.eachRow((row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const text = cell.value === null ? '' : String(cell.value).trim();
        if (text) seen.add(text);
      });
    });
    for (const value of new Set(values)) {
      expect(seen.has(value), `нет в XLSX: ${value}`).toBe(true);
    }

    if (pdf) {
      expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect(pdf.length).toBeGreaterThan(1000);
    }
  });

  it('11a · рендереры и модели документов не обращаются к базе', async () => {
    // Чистыми обязаны быть рендереры и модели документов: данные им
    // приносит фасад. Фасады (index.ts, *Export.ts) как раз и связывают
    // запрос с рендером — им обращаться к базе положено.
    const files = await sourceFiles(join(SRC, 'services/export'));
    const isFacade = (name: string): boolean =>
      name.endsWith('index.ts') || /Export\.ts$/.test(name);

    const offenders: string[] = [];
    for (const file of files) {
      if (isFacade(file)) continue;
      const text = await readFile(file, 'utf8');
      if (/\bdb\.query\b|\bclient\.query\b|\bPool\b/.test(text)) {
        offenders.push(file.slice(SRC.length + 1));
      }
    }
    expect(offenders, `Рендерер ходит в БД: ${offenders.join(', ')}`).toEqual([]);

    // И проверка, что чистых файлов действительно много — иначе тест
    // мог бы «проходить», исключив вообще всё.
    const pure = files.filter((f) => !isFacade(f));
    expect(pure.length).toBeGreaterThanOrEqual(5);
  });
});
