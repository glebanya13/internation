import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');

/**
 * Инвариант 12: в коде нет зашитой текущей конфигурации.
 *
 * 6 и 7 этаж, ФИТ и ТОВ, времена смен — это данные, которыми управляет
 * администратор. Они допустимы только в миграциях, seed и тестах.
 * Появление их в src/ означает, что добавление нового этажа или факультета
 * потребует правки кода — ровно то, чего быть не должно.
 */

const SEED_ONLY = ['seed/'];

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

async function scan(
  pattern: RegExp,
  options: { allow?: string[] } = {},
): Promise<Array<{ file: string; line: number; text: string }>> {
  const allow = options.allow ?? [];
  const hits: Array<{ file: string; line: number; text: string }> = [];

  for (const file of await sourceFiles(SRC)) {
    const rel = relative(SRC, file);
    if (allow.some((prefix) => rel.startsWith(prefix))) continue;

    const lines = (await readFile(file, 'utf8')).split('\n');
    lines.forEach((text, index) => {
      const code = text.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
      if (pattern.test(code)) hits.push({ file: rel, line: index + 1, text: text.trim() });
    });
  }
  return hits;
}

function report(hits: Array<{ file: string; line: number; text: string }>): string {
  return hits.map((h) => `  ${h.file}:${h.line}  ${h.text}`).join('\n');
}

describe('в коде нет зашитой конфигурации', () => {
  it('12 · нет сравнений с номерами этажей', async () => {
    // floor === 6, floorNumber == 7, number === 6 и подобное
    const hits = await scan(
      /\b(floor|floorNumber|floor_number|этаж)\w*\s*(===?|!==?)\s*['"]?\d+['"]?/i,
      { allow: SEED_ONLY },
    );
    expect(hits, `Номер этажа зашит в код:\n${report(hits)}`).toEqual([]);
  });

  it('12a · нет кодов факультетов', async () => {
    const hits = await scan(/['"](ФИТ|ТОВ|FIT|TOV)['"]/i, { allow: SEED_ONLY });
    expect(hits, `Код факультета зашит в код:\n${report(hits)}`).toEqual([]);
  });

  it('12b · нет литералов времени смен', async () => {
    const hits = await scan(/['"]\d{2}:\d{2}(:\d{2})?['"]/, { allow: SEED_ONLY });
    expect(hits, `Время смены зашито в код:\n${report(hits)}`).toEqual([]);
  });

  it('12c · нет предположения о числе смен в дне', async () => {
    const hits = await scan(/\b(slots?|смен\w*)\w*\s*(===?|!==?|length\s*===?)\s*\d+/i, {
      allow: SEED_ONLY,
    });
    expect(hits, `Число смен зашито в код:\n${report(hits)}`).toEqual([]);
  });

  it('12d · нет предположения о вместимости комнаты', async () => {
    // Речь именно о вместимости ПОМЕЩЕНИЯ. Слово capacity само по себе
    // законно: в feasibility оно означало бы «сколько дежурств потянут
    // студенты» — там оно переименовано в maxDuties во избежание путаницы.
    const hits = await scan(
      /\b(room_?capacity|roomCapacity|вместимост|max_?residents|room_?size|beds?_?count)\b/i,
    );
    expect(hits, `Вместимость комнаты появилась в коде:\n${report(hits)}`).toEqual([]);
  });

  it('12e · в схеме БД нет поля вместимости комнаты', async () => {
    const dir = join(ROOT, 'migrations');
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql'));
    const offenders: string[] = [];

    for (const name of files) {
      const lines = (await readFile(join(dir, name), 'utf8')).split('\n');
      lines.forEach((line, index) => {
        const code = line.replace(/--.*$/, '');
        if (/\b(capacity|max_residents|room_size)\b/i.test(code)) {
          offenders.push(`${name}:${index + 1}  ${line.trim()}`);
        }
      });
    }
    expect(offenders, `Вместимость в схеме:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('12f · этаж не связан с факультетом внешним ключом', async () => {
    const dir = join(ROOT, 'migrations');
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql'));
    const offenders: string[] = [];

    for (const name of files) {
      const sql = await readFile(join(dir, name), 'utf8');
      // Ищем описание таблицы floors и ссылку на faculties внутри него.
      const match = /CREATE TABLE floors \(([\s\S]*?)\n\);/.exec(sql);
      if (match && /facult/i.test(match[1]!.replace(/--.*$/gm, ''))) {
        offenders.push(`${name}: в таблице floors есть ссылка на факультет`);
      }
      if (/ALTER TABLE floors[\s\S]{0,200}?faculties/i.test(sql.replace(/--.*$/gm, ''))) {
        offenders.push(`${name}: floors связывается с faculties через ALTER`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
