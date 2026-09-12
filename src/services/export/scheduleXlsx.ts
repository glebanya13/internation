import ExcelJS from 'exceljs';
import { formatRuDate } from './htmlRenderer.js';
import type { ScheduleDocument, ScheduleRow } from './scheduleDocument.js';

/**
 * XLSX графика дежурств. Собирается из того же ScheduleDocument,
 * что HTML и PDF: набор строк, объединения и порядок колонок совпадают
 * с печатной формой по построению.
 */

const WIDTHS = [9, 10, 14, 22, 10, 9, 10, 14, 22, 10];

export async function renderScheduleXlsx(doc: ScheduleDocument): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Система учёта дежурств';

  const sheet = workbook.addWorksheet('График', {
    pageSetup: {
      paperSize: 9,
      orientation: 'portrait',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 },
    },
  });
  WIDTHS.forEach((w, i) => {
    sheet.getColumn(i + 1).width = w;
  });

  const wide = (text: string, size: number, bold = false, italic = false): void => {
    const row = sheet.addRow([text]);
    row.font = { name: 'Times New Roman', size, bold, italic };
    row.getCell(1).alignment = { horizontal: 'center' };
    sheet.mergeCells(row.number, 1, row.number, 10);
  };

  if (doc.status === 'blank') {
    // Пустой бланк — без водяного знака, чтобы заполнять ручкой/в Excel.
  } else if (doc.status !== 'published') {
    wide('ЧЕРНОВИК — не для подписи', 10, true);
  }

  // Блок подписей как в бланке: слева / справа, куратор по центру ниже.
  const [approve, warden, curator] = doc.approval;
  const approvalLine = (
    block: (typeof doc.approval)[number] | undefined,
    line: number,
  ): string => {
    if (!block) return '';
    if (line === 0) return block.verb;
    if (line === 1) return block.role;
    if (line === 2) return block.name || '_________________';
    return `«___» ________ ${block.year} г.`;
  };

  for (let line = 0; line < 4; line += 1) {
    const values: Array<string | null> = new Array(10).fill(null);
    values[0] = approvalLine(approve, line) || null;
    values[6] = approvalLine(warden, line) || null;
    const row = sheet.addRow(values);
    row.font = { name: 'Times New Roman', size: 8 };
    row.getCell(1).alignment = { horizontal: 'left' };
    row.getCell(7).alignment = { horizontal: 'right' };
  }
  for (let line = 0; line < 4; line += 1) {
    const values: Array<string | null> = new Array(10).fill(null);
    values[3] = approvalLine(curator, line) || null;
    const row = sheet.addRow(values);
    row.font = { name: 'Times New Roman', size: 8 };
    row.getCell(4).alignment = { horizontal: 'center' };
    sheet.mergeCells(row.number, 4, row.number, 7);
  }
  sheet.addRow([]);

  wide(doc.title, 13, true);
  wide(doc.subtitle, 11);
  wide(doc.monthTitle, 11);
  sheet.addRow([]);

  const header = sheet.addRow([...doc.headers, ...doc.headers]);
  header.font = { name: 'Times New Roman', size: 9, bold: true };
  header.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  header.eachCell((cell) => {
    cell.border = box();
  });
  sheet.pageSetup.printTitlesRow = `${header.number}:${header.number}`;

  const merges: Array<[number, number, number, number]> = [];

  for (const page of doc.pages) {
    const height = Math.max(page.left.rows.length, page.right?.rows.length ?? 0);
    for (let i = 0; i < height; i += 1) {
      const values: Array<string | null> = new Array(10).fill(null);

      const fill = (row: ScheduleRow | undefined, offset: number): void => {
        if (!row) return;
        if (row.date.rowSpan > 0) {
          const label = row.date.subText ? `${row.date.text} ${row.date.subText}` : row.date.text;
          values[offset] = label;
        }
        values[offset + 1] = row.room.text || null;
        values[offset + 2] = row.time.text || null;
        values[offset + 3] = row.name.text || null;
        values[offset + 4] = null; // графа «Подпись» — под ручку
      };
      fill(page.left.rows[i], 0);
      fill(page.right?.rows[i], 5);

      const excelRow = sheet.addRow(values);
      excelRow.font = { name: 'Times New Roman', size: 9 };
      excelRow.height = 14;
      excelRow.eachCell({ includeEmpty: true }, (cell, col) => {
        cell.border = box();
        cell.alignment = {
          horizontal: col === 4 || col === 9 ? 'left' : 'center',
          vertical: 'middle',
        };
      });

      const collectDate = (row: ScheduleRow | undefined, offset: number): void => {
        if (row && row.date.rowSpan > 1) {
          merges.push([
            excelRow.number,
            offset + 1,
            excelRow.number + row.date.rowSpan - 1,
            offset + 1,
          ]);
        }
      };
      collectDate(page.left.rows[i], 0);
      collectDate(page.right?.rows[i], 5);
    }
  }

  for (const [r1, c1, r2, c2] of merges) sheet.mergeCells(r1, c1, r2, c2);

  sheet.addRow([]);
  wide('Изменения в графике дежурств (заполняется старостой)', 9);

  const changesHeader = sheet.addRow([
    ...doc.changesHeaders,
    ...doc.changesHeaders,
    'Подпись старосты',
  ]);
  changesHeader.font = { name: 'Times New Roman', size: 9, bold: true };
  changesHeader.alignment = { horizontal: 'center', wrapText: true };
  changesHeader.eachCell((cell) => {
    cell.border = box();
  });

  for (const change of doc.changesRows) {
    const row = sheet.addRow([
      change.date || null,
      change.room || null,
      change.time || null,
      change.name || null,
      null,
      null,
      null,
      null,
      null,
    ]);
    row.font = { name: 'Times New Roman', size: 9 };
    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.border = box();
    });
  }

  sheet.addRow([]);
  if (doc.status !== 'blank' && doc.status !== 'published') {
    wide(
      `Сформировано ${formatRuDate(doc.generatedAt)} · дежурств ${doc.stats.assigned} из ${doc.stats.slots}`,
      8,
      false,
      true,
    );
  }

  sheet.pageSetup.printArea = `A1:J${sheet.rowCount}`;
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function box(): Partial<ExcelJS.Borders> {
  const thin = { style: 'thin' as const, color: { argb: 'FF000000' } };
  return { top: thin, left: thin, bottom: thin, right: thin };
}
