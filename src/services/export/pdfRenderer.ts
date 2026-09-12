import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { renderRosterHtml } from './htmlRenderer.js';
import type { RosterDocument } from './rosterDocument.js';

const run = promisify(execFile);

/**
 * PDF списка этажа.
 *
 * Рендерится headless-браузером из ТОЙ ЖЕ вёрстки, что уходит в веб
 * и в печать по Ctrl+P. Собирать таблицу вручную в PDF-библиотеке — значит
 * получить вторую раскладку, которая рано или поздно разойдётся с первой,
 * и отдельно решать проблемы кириллицы, переносов и повтора шапки.
 *
 * Браузер берётся системный: скачивать Chromium в зависимости проекта
 * незачем. Путь переопределяется переменной CHROME_PATH.
 */

const CANDIDATE_BROWSERS = [
  process.env['CHROME_PATH'],
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter((path): path is string => Boolean(path));

/** Флаги для headless Chromium в Docker / без GUI. Без --single-process. */
const CHROME_ARGS = [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-software-rasterizer',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-default-apps',
  '--disable-sync',
  '--disable-translate',
  '--disable-crash-reporter',
  '--disable-breakpad',
  '--hide-scrollbars',
  '--metrics-recording-only',
  '--mute-audio',
  '--no-first-run',
  '--safebrowsing-disable-auto-update',
  '--run-all-compositor-stages-before-draw',
  '--no-pdf-header-footer',
];

export class PdfUnavailableError extends Error {}

export async function findBrowser(): Promise<string | null> {
  const { access } = await import('node:fs/promises');
  for (const path of CANDIDATE_BROWSERS) {
    try {
      await access(path);
      return path;
    } catch {
      // пробуем следующий
    }
  }
  return null;
}

export async function renderRosterPdf(doc: RosterDocument): Promise<Buffer> {
  return renderHtmlToPdf(renderRosterHtml(doc, { standalone: true }));
}

/** Рендер любой печатной вёрстки системы в PDF. */
export async function renderHtmlToPdf(html: string): Promise<Buffer> {
  const browser = await findBrowser();
  if (!browser) {
    throw new PdfUnavailableError(
      'Не найден браузер для рендеринга PDF. Укажите путь в переменной CHROME_PATH.',
    );
  }

  const dir = await mkdtemp(join(tmpdir(), 'roster-pdf-'));
  const htmlPath = join(dir, 'roster.html');
  const pdfPath = join(dir, 'roster.pdf');

  try {
    await writeFile(htmlPath, html, 'utf8');
    try {
      await run(
        browser,
        [
          ...CHROME_ARGS,
          // Номера страниц печатаются внутри самих страниц: разбивка
          // посчитана в rosterDocument, а не отдана движку печати.
          `--print-to-pdf=${pdfPath}`,
          '--virtual-time-budget=5000',
          `file://${htmlPath}`,
        ],
        {
          timeout: 60_000,
          killSignal: 'SIGKILL',
          // dbus-шум Chromium не должен попадать в ответ пользователю
          maxBuffer: 2 * 1024 * 1024,
        },
      );
    } catch (error) {
      const message = (error as Error).message;
      // Chromium пишет в stderr даже при успешном PDF — проверяем файл.
      try {
        const pdf = await readFile(pdfPath);
        if (pdf.length > 100 && pdf.subarray(0, 5).toString('latin1') === '%PDF-') {
          return pdf;
        }
      } catch {
        // файла нет
      }
      console.error('[pdf]', message.slice(0, 500));
      throw new PdfUnavailableError('Не удалось создать PDF. Попробуйте позже или скачайте XLSX.');
    }

    try {
      const pdf = await readFile(pdfPath);
      if (pdf.length > 100 && pdf.subarray(0, 5).toString('latin1') === '%PDF-') {
        return pdf;
      }
    } catch {
      // ниже общая ошибка
    }
    throw new PdfUnavailableError('Не удалось создать PDF. Попробуйте позже или скачайте XLSX.');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
