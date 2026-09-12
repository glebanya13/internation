import ExcelJS from 'exceljs';
import type { RosterDocument } from './rosterDocument.js';

/**
 * XLSX списка этажа.
 *
 * Собирается из того же RosterDocument, что HTML и PDF, поэтому набор строк,
 * объединения и порядок колонок совпадают с печатной формой по построению,
 * а не по совпадению.
 */

const COLUMN_WIDTHS = [8, 28, 10, 12, 8, 28, 10, 12];
const COLS = COLUMN_WIDTHS.length;

export async function renderRosterXlsx(doc: RosterDocument): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Система учёта дежурств';
  workbook.created = new Date(doc.meta.generatedAt);

  const sheet = workbook.addWorksheet('Список', {
    pageSetup: {
      paperSize: 9, // A4
      orientation: 'portrait',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
    },
    views: [{ state: 'frozen', ySplit: 3 }],
  });

  COLUMN_WIDTHS.forEach((width, i) => {
    sheet.getColumn(i + 1).width = width;
  });

  const titleRow = sheet.addRow([doc.title]);
  titleRow.font = { name: 'Times New Roman', size: 13, bold: true };
  sheet.mergeCells(titleRow.number, 1, titleRow.number, COLS);
  titleRow.getCell(1).alignment = { horizontal: 'center' };

  const subtitleRow = sheet.addRow([doc.subtitle]);
  subtitleRow.font = { name: 'Times New Roman', size: 10 };
  sheet.mergeCells(subtitleRow.number, 1, subtitleRow.number, COLS);
  subtitleRow.getCell(1).alignment = { horizontal: 'center' };

  const headerRow = sheet.addRow([...doc.headers, ...doc.headers]);
  headerRow.font = { name: 'Times New Roman', size: 10, bold: true };
  headerRow.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  headerRow.eachCell((cell) => {
    cell.border = box();
  });
  sheet.pageSetup.printTitlesRow = `${headerRow.number}:${headerRow.number}`;

  const merges: Array<[number, number, number, number]> = [];

  for (const page of doc.pages) {
    const height = Math.max(page.left.rows.length, page.right.rows.length);

    for (let i = 0; i < height; i += 1) {
      const left = page.left.rows[i];
      const right = page.right.rows[i];
      const values: Array<string | null> = new Array(COLS).fill(null);

      const fill = (row: typeof left, offset: number): void => {
        if (!row) return;
        const cells = [row.room, row.name, row.faculty, row.courseGroup];
        cells.forEach((cell, index) => {
          if (cell.rowSpan === 0) return;
          values[offset + index] = cell.text || null;
        });
      };
      fill(left, 0);
      fill(right, 4);

      const excelRow = sheet.addRow(values);
      excelRow.font = { name: 'Times New Roman', size: 10 };
      excelRow.height = 15;
      excelRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        cell.border = box();
        const isName = colNumber === 2 || colNumber === 6;
        cell.alignment = {
          horizontal: isName ? 'left' : 'center',
          vertical: 'middle',
          wrapText: true,
        };
      });

      const collect = (row: typeof left, offset: number): void => {
        if (!row) return;
        [row.room, row.faculty].forEach((cell, index) => {
          if (cell.rowSpan > 1) {
            const column = offset + (index === 0 ? 1 : 3);
            merges.push([excelRow.number, column, excelRow.number + cell.rowSpan - 1, column]);
          }
        });
      };
      collect(left, 0);
      collect(right, 4);
    }
  }

  for (const [r1, c1, r2, c2] of merges) sheet.mergeCells(r1, c1, r2, c2);

  if (doc.stats.hiddenEmptyRooms > 0) {
    sheet.addRow([]);
    const note = sheet.addRow([`Комнаты без жильцов скрыты: ${doc.stats.hiddenEmptyRooms}`]);
    note.font = { name: 'Times New Roman', size: 9, italic: true };
    sheet.mergeCells(note.number, 1, note.number, COLS);
  }

  if (doc.signature) {
    sheet.addRow([]);
    const sign = sheet.addRow([`${doc.signature.role}  _______________  ${doc.signature.name}`]);
    sign.font = { name: 'Times New Roman', size: 10 };
    sheet.mergeCells(sign.number, 1, sign.number, COLS);
  }

  const lastCol = String.fromCharCode('A'.charCodeAt(0) + COLS - 1);
  sheet.pageSetup.printArea = `A1:${lastCol}${sheet.rowCount}`;

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

function box(): Partial<ExcelJS.Borders> {
  const thin = { style: 'thin' as const, color: { argb: 'FF000000' } };
  return { top: thin, left: thin, bottom: thin, right: thin };
}
