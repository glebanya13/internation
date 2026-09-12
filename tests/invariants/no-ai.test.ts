import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

/**
 * AI из системы исключён полностью: ни API, ни LLM-генерации, ни зависимостей.
 * Тест держит это свойство, а не полагается на память разработчика.
 */

async function walk(dir: string, ext: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full, ext)));
    else if (entry.name.endsWith(ext)) files.push(full);
  }
  return files;
}

describe('AI в системе отсутствует', () => {
  it('в коде нет обращений к AI и LLM', async () => {
    const files = await walk(join(ROOT, 'src'), '.ts');
    const pattern =
      /\b(anthropic|openai|claude|gpt-?\d|llm|langchain|gemini|mistral|ollama)\b/i;
    const hits: string[] = [];

    for (const file of files) {
      const lines = (await readFile(file, 'utf8')).split('\n');
      lines.forEach((line, index) => {
        if (pattern.test(line)) {
          hits.push(`${relative(ROOT, file)}:${index + 1}  ${line.trim()}`);
        }
      });
    }
    expect(hits, `Найдены следы AI:\n${hits.join('\n')}`).toEqual([]);
  });

  it('в зависимостях нет AI-пакетов', async () => {
    const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const names = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ];
    const suspicious = names.filter((name) =>
      /anthropic|openai|langchain|llm|gemini|mistral|ollama/i.test(name),
    );
    expect(suspicious).toEqual([]);
  });

  it('в схеме нет таблиц и полей под AI', async () => {
    const files = await walk(join(ROOT, 'migrations'), '.sql');
    const hits: string[] = [];

    for (const file of files) {
      const lines = (await readFile(file, 'utf8')).split('\n');
      lines.forEach((line, index) => {
        const code = line.replace(/--.*$/, '');
        if (/\bai_generations\b|'ai'/.test(code) && !/DROP|IN \('algorithm'/.test(code)) {
          hits.push(`${relative(ROOT, file)}:${index + 1}  ${line.trim()}`);
        }
      });
    }
    expect(hits, `AI в схеме:\n${hits.join('\n')}`).toEqual([]);
  });

  it('generated_by допускает только algorithm и manual', async () => {
    const files = await walk(join(ROOT, 'migrations'), '.sql');
    let found = false;
    for (const file of files) {
      const sql = await readFile(file, 'utf8');
      if (/generated_by IN \('algorithm', 'manual'\)/.test(sql)) found = true;
    }
    expect(found).toBe(true);
  });
});
