import type { ScheduleDocument, ScheduleRow } from './scheduleDocument.js';

/**
 * HTML графика дежурств — общая вёрстка для веба, печати и PDF.
 * Повторяет бланк: блок подписей на каждой странице, две зеркальные
 * половины таблицы, объединённая ячейка даты, пустая графа «Подпись»
 * и таблица изменений со строкой подписи старосты.
 */

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderSide(row: ScheduleRow | undefined, side: string, columns: number): string {
  if (!row) {
    return Array.from({ length: columns }, () => `<td class="void"></td>`).join('');
  }
  const start = row.dayStart ? ' day-start' : '';
  const cells: string[] = [];

  if (row.date.rowSpan > 0) {
    const span = row.date.rowSpan > 1 ? ` rowspan="${row.date.rowSpan}"` : '';
    const sub = row.date.subText ? `<br><span class="wd">${esc(row.date.subText)}</span>` : '';
    cells.push(`<td class="c dt${start} ${side}"${span}>${esc(row.date.text)}${sub}</td>`);
  }
  cells.push(`<td class="c${start} ${side}">${esc(row.room.text)}</td>`);
  cells.push(`<td class="c tm${start} ${side}">${esc(row.time.text)}</td>`);
  cells.push(`<td class="nm${start} ${side}">${esc(row.name.text)}</td>`);
  cells.push(`<td class="sg${start} ${side}"></td>`);
  return cells.join('');
}

export function renderScheduleHtml(doc: ScheduleDocument): string {
  const headerCells = [...doc.headers, ...doc.headers].map((h) => `<th>${esc(h)}</th>`).join('');

  const [approve, warden, curator] = doc.approval;
  const approvalBlock = `<div class="approval">
  <div class="ap-row ap-top">
    <div class="ap ap-left">${approve ? approvalHtml(approve) : ''}</div>
    <div class="ap ap-right">${warden ? approvalHtml(warden) : ''}</div>
  </div>
  <div class="ap-curator">${curator ? approvalHtml(curator) : ''}</div>
</div>`;

  const changesTable = `<div class="changes-title">Изменения в графике дежурств (заполняется старостой)</div>
  <table class="changes">
    <thead><tr>${[...doc.changesHeaders, ...doc.changesHeaders]
      .map((h) => `<th>${esc(h)}</th>`)
      .join('')}<th>Подпись старосты</th></tr></thead>
    <tbody>
      ${doc.changesRows
        .map(
          (row) =>
            `<tr><td class="c">${esc(row.date)}</td><td class="c">${esc(row.room)}</td>` +
            `<td class="c">${esc(row.time)}</td><td>${esc(row.name)}</td>` +
            `<td class="c"></td><td class="c"></td><td class="c"></td><td></td><td></td></tr>`,
        )
        .join('\n      ')}
    </tbody>
  </table>`;

  const pages = doc.pages
    .map((page) => {
      const height = Math.max(page.left.rows.length, page.right?.rows.length ?? 0);
      const body = Array.from({ length: height }, (_, i) => {
        const left = renderSide(page.left.rows[i], 'l', 5);
        const right = renderSide(page.right?.rows[i], 'r', 5);
        return `<tr>${left}${right}</tr>`;
      }).join('\n');

      const draftMark =
        doc.status === 'blank'
          ? ''
          : doc.status !== 'published'
            ? `<div class="draft">ЧЕРНОВИК — не для подписи</div>`
            : '';

      // Бланк и подписанный график — без служебного футера (как в бумажном образце).
      const foot =
        doc.status === 'blank' || doc.status === 'published'
          ? ''
          : `<footer class="foot">
    <span>Сформировано ${esc(formatRuDate(doc.generatedAt))}</span>
    <span>стр. ${page.pageNumber} из ${doc.totalPages}</span>
  </footer>`;

      return `<section class="page">
  ${draftMark}
  ${approvalBlock}
  <div class="head">
    <div class="title">${esc(doc.title)}</div>
    <div class="subtitle">${esc(doc.subtitle)}</div>
    <div class="subtitle">${esc(doc.monthTitle)}</div>
  </div>
  <table class="main">
    <thead><tr>${headerCells}</tr></thead>
    <tbody>
${body || `<tr><td colspan="10" class="c">Дежурства не назначены</td></tr>`}
    </tbody>
  </table>
  ${changesTable}
  ${foot}
</section>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>${esc(doc.subtitle)} ${esc(doc.monthTitle)}</title>
<style>${SCHEDULE_CSS}</style>
</head>
<body>
${pages}
</body>
</html>`;
}

function approvalHtml(block: {
  verb: string;
  role: string;
  name: string;
  year: number;
}): string {
  return `<div>${esc(block.verb)}</div>
      <div>${esc(block.role)}</div>
      <div class="ap-name">${block.name ? esc(block.name) : '_________________'}</div>
      <div>«___» ________ ${block.year} г.</div>`;
}

function formatRuDate(iso: string): string {
  const MONTHS = [
    'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
    'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
  ];
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} г.`;
}

const SCHEDULE_CSS = `
@page { size: A4 portrait; margin: 7mm 7mm 8mm 7mm; }
* { box-sizing: border-box; }

body {
  margin: 0;
  font-family: "Times New Roman", "PT Serif", Times, serif;
  font-size: 10pt;
  color: #000;
  background: #fff;
}

.page {
  width: 196mm;
  margin: 0 auto;
  page-break-after: always;
  display: flex;
  flex-direction: column;
}
.page:last-child { page-break-after: auto; }

.draft {
  text-align: center;
  font-size: 8pt;
  letter-spacing: .08em;
  border: 0.8pt solid #000;
  padding: 0.5mm;
  margin-bottom: 1.5mm;
}

.approval { font-size: 8pt; line-height: 1.25; margin-bottom: 1.5mm; }
.ap-top {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 8mm;
}
.ap-left { width: 42%; text-align: left; }
.ap-right { width: 42%; text-align: right; margin-left: auto; }
.ap-curator {
  width: 42%;
  margin: 2mm auto 0;
  text-align: center;
}
.ap-name { margin: 0.3mm 0; }

.head { text-align: center; margin: 1.5mm 0 1.5mm; line-height: 1.2; }
.title { font-size: 12pt; font-weight: bold; }
.subtitle { font-size: 10pt; }

table { width: 100%; border-collapse: collapse; table-layout: fixed; }
th, td {
  border: 0.5pt solid #000;
  padding: 0.2mm 0.8mm;
  font-size: 8pt;
  height: 4.6mm;
  overflow-wrap: anywhere;
  vertical-align: middle;
}
th {
  font-weight: bold; text-align: center; font-size: 7.5pt;
  overflow-wrap: normal; word-break: keep-all;
  height: 5mm;
}
thead { display: table-header-group; }
tr { break-inside: avoid; page-break-inside: avoid; }

td.c { text-align: center; }
td.nm { text-align: left; }
td.dt { font-weight: bold; line-height: 1.1; }
td.tm { white-space: nowrap; font-size: 7.5pt; }
.wd { font-weight: normal; font-size: 7pt; }
td.day-start { border-top: 0.9pt solid #000; }
td.void { border: none; }
td.sg { }

.main th:nth-child(1), .main th:nth-child(6)  { width: 8%; }
.main th:nth-child(2), .main th:nth-child(7)  { width: 9%; }
.main th:nth-child(3), .main th:nth-child(8)  { width: 13%; }
.main th:nth-child(4), .main th:nth-child(9)  { width: 14%; }
.main th:nth-child(5), .main th:nth-child(10) { width: 6%; }

.changes-title { font-size: 8pt; margin: 2mm 0 0.8mm; }
.changes th, .changes td { height: 4.2mm; font-size: 7.5pt; }
.changes th:nth-child(9) { width: 14%; }

.foot {
  margin-top: 1.5mm; padding-top: 1mm;
  display: flex; justify-content: space-between; font-size: 7.5pt;
}

@media screen {
  body { background: #e9edf1; padding: 8mm 0; }
  .page {
    background: #fff; padding: 7mm;
    box-shadow: 0 1px 4px rgba(0,0,0,.18);
    min-height: 283mm; margin-bottom: 8mm;
  }
  .page:last-child { margin-bottom: 0; }
}
@media print {
  body { background: #fff; padding: 0; }
  .page { box-shadow: none; padding: 0; min-height: 0; margin: 0; width: auto; }
}
`;

export { SCHEDULE_CSS };
