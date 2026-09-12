import type { DocumentColumn, RosterDocument } from './rosterDocument.js';

/**
 * HTML списка этажа — общая вёрстка для веба, печати из браузера и PDF.
 *
 * Одна вёрстка на все три выхода: расхождение «на экране одно, на принтере
 * другое» исключено конструктивно. PDF получается прогоном этого же файла
 * через headless Chrome.
 *
 * Разбивка на страницы посчитана заранее, в rosterDocument, поэтому номера
 * страниц печатаются внутри самих страниц и не зависят от того, умеет ли
 * движок печати считать counter(page).
 */

const MONTHS = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

export function formatRuDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} г.`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderRow(
  doc: RosterDocument,
  page: { left: DocumentColumn; right: DocumentColumn },
  index: number,
): string {
  const left = page.left.rows[index];
  const right = page.right.rows[index];
  const cells: string[] = [];

  const push = (
    row: typeof left,
    side: 'l' | 'r',
  ): void => {
    if (!row) {
      cells.push(...doc.headers.map(() => `<td class="void ${side}"></td>`));
      return;
    }
    const start = row.roomStart ? ' room-start' : '';
    const order: Array<[keyof typeof row, string]> = [
      ['room', 'c room'],
      ['name', 'nm'],
      ['faculty', 'c'],
      ['courseGroup', 'c'],
    ];
    for (const [key, cls] of order) {
      const value = row[key];
      if (typeof value === 'boolean') continue;
      const c = value as { text: string; rowSpan: number };
      if (c.rowSpan === 0) continue; // ячейка поглощена объединением
      const span = c.rowSpan > 1 ? ` rowspan="${c.rowSpan}"` : '';
      cells.push(`<td class="${cls}${start} ${side}"${span}>${escapeHtml(c.text)}</td>`);
    }
  };

  push(left, 'l');
  push(right, 'r');
  return `<tr>${cells.join('')}</tr>`;
}

export function renderRosterHtml(
  doc: RosterDocument,
  options: { standalone?: boolean } = {},
): string {
  const standalone = options.standalone ?? true;
  const headerCells = [...doc.headers, ...doc.headers]
    .map((h) => `<th>${escapeHtml(h)}</th>`)
    .join('');

  const pagesHtml = doc.pages
    .map((page) => {
      const height = Math.max(page.left.rows.length, page.right.rows.length);
      const body = Array.from({ length: height }, (_, i) => renderRow(doc, page, i)).join('\n');

      const emptyNote =
        doc.stats.hiddenEmptyRooms > 0 && page.pageNumber === doc.totalPages
          ? `<div class="note">Комнаты без жильцов скрыты: ${doc.stats.hiddenEmptyRooms}</div>`
          : '';

      const signature =
        doc.signature && page.pageNumber === doc.totalPages
          ? `<div class="sign">
               <div class="sign-role">${escapeHtml(doc.signature.role)}</div>
               <div class="sign-line">_______________</div>
               <div class="sign-name">${escapeHtml(doc.signature.name)}</div>
             </div>`
          : '';

      return `<section class="page">
  <header class="head">
    <div class="title">${escapeHtml(doc.title)}</div>
    <div class="subtitle">${escapeHtml(doc.subtitle)}</div>
  </header>
  <table>
    <thead><tr>${headerCells}</tr></thead>
    <tbody>
${body || `<tr><td class="void" colspan="8">На этаже нет проживающих</td></tr>`}
    </tbody>
  </table>
  ${emptyNote}
  ${signature}
</section>`;
    })
    .join('\n');

  if (!standalone) return pagesHtml;

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>${escapeHtml(doc.title)}</title>
<style>
${ROSTER_CSS}
</style>
</head>
<body>
${pagesHtml}
</body>
</html>`;
}

/**
 * Ширины колонок заданы в процентах при table-layout: fixed — таблица
 * физически не может уехать за правый край. Длинная фамилия переносится
 * (overflow-wrap), а не растягивает колонку.
 */
const ROSTER_CSS = `
@page { size: A4 portrait; margin: 8mm 10mm 10mm 10mm; }

* { box-sizing: border-box; }

body {
  margin: 0;
  font-family: "Times New Roman", "PT Serif", Times, serif;
  font-size: 11pt;
  line-height: 1.25;
  color: #000;
  background: #fff;
}

.page {
  width: 190mm;
  margin: 0 auto 8mm;
  padding: 0;
  page-break-after: always;
  display: flex;
  flex-direction: column;
}
.page:last-child { page-break-after: auto; margin-bottom: 0; }

.head { text-align: center; margin-bottom: 2mm; }
.title { font-size: 12pt; font-weight: bold; line-height: 1.15; }
.subtitle { font-size: 9pt; margin-top: 0.5mm; }

table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
}

th, td {
  border: 0.5pt solid #000;
  padding: 0.4mm 1mm;
  font-size: 9pt;
  height: 5.2mm;
  overflow-wrap: anywhere;
  word-break: break-word;
  vertical-align: middle;
}

th {
  font-weight: bold;
  text-align: center;
  font-size: 7.5pt;
  line-height: 1.05;
  padding: 0.6mm 0.4mm;
  height: 6mm;
  /* Заголовки не переносятся посреди слова: «Комна/та» читается как брак. */
  overflow-wrap: normal;
  word-break: keep-all;
  hyphens: none;
}

/* Шапка повторяется на каждой печатной странице. */
thead { display: table-header-group; }
tr { break-inside: avoid; page-break-inside: avoid; }

td.c  { text-align: center; }
td.nm { text-align: left; }

/* Ширины двух зеркальных блоков совпадают — как в исходном бланке. */
th:nth-child(1) { width: 10%; }
th:nth-child(2) { width: 24%; }
th:nth-child(3) { width: 11%; }
th:nth-child(4) { width: 10%; }
th:nth-child(5) { width: 10%; }
th:nth-child(6) { width: 24%; }
th:nth-child(7) { width: 11%; }
th:nth-child(8) { width: 10%; }

td.room { font-weight: bold; }
td.room-start { border-top: 0.9pt solid #000; }
/* Колонка кончилась раньше соседней — рамок быть не должно:
   в бланке короткий блок просто заканчивается, а не тянет пустую сетку. */
td.void { border: none; background: #fff; }

.note { font-size: 8.5pt; margin-top: 2mm; font-style: italic; }

.sign { margin-top: 3mm; font-size: 9pt; display: flex; gap: 4mm; align-items: baseline; }
.sign-line { min-width: 40mm; }

@media screen {
  body { background: #e9edf1; padding: 8mm 0; }
  .page {
    background: #fff;
    padding: 10mm;
    box-shadow: 0 1px 4px rgba(0,0,0,.18);
    min-height: 277mm;
  }
}

@media print {
  body { background: #fff; padding: 0; }
  .page { box-shadow: none; padding: 0; }
}
`;

export { ROSTER_CSS };
