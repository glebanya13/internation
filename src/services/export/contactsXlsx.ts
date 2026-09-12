import ExcelJS from 'exceljs';
import { displayGroupNumber } from '../../domain/facultyGroup.js';
import type { FloorRoster } from '../../domain/floorRoster.js';
import { formatRuDate } from './htmlRenderer.js';

/**
 * Табличный XLSX со списком этажа: телефон и Telegram ID.
 * Отдельно от печатного бланка — одна строка на студента.
 */

const HEADERS = [
  'Комната',
  'Блок',
  'Фамилия Имя',
  'Факультет',
  'Курс',
  'Группа',
  'Смена',
  'Телефон',
  'Telegram ID',
];

export async function renderRosterContactsXlsx(roster: FloorRoster): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Система учёта дежурств';
  workbook.created = new Date(roster.meta.generatedAt);

  const sheet = workbook.addWorksheet('Контакты', {
    views: [{ state: 'frozen', ySplit: 2 }],
  });

  const widths = [10, 8, 28, 10, 6, 8, 8, 16, 16];
  widths.forEach((w, i) => {
    sheet.getColumn(i + 1).width = w;
  });

  const floorLabel = roster.meta.floorCode ?? String(roster.meta.floorNumber);
  const title = sheet.addRow([`Список ${floorLabel} этажа · контакты`]);
  title.font = { name: 'Times New Roman', size: 12, bold: true };
  sheet.mergeCells(title.number, 1, title.number, HEADERS.length);

  const headerRow = sheet.addRow(HEADERS);
  headerRow.font = { name: 'Times New Roman', size: 10, bold: true };
  headerRow.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  headerRow.eachCell((cell) => {
    cell.border = box();
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF4F6F8' } };
  });

  for (const room of roster.rooms) {
    for (const person of room.people) {
      const row = sheet.addRow([
        room.number,
        room.blockCode ?? '',
        person.displayName,
        person.facultyCode ?? '',
        person.course ?? '',
        displayGroupNumber(person.groupCode),
        person.studyShiftCode ?? '',
        person.phone ?? '',
        person.telegramId ?? '',
      ]);
      row.font = { name: 'Times New Roman', size: 10 };
      row.eachCell((cell, col) => {
        cell.border = box();
        cell.alignment = {
          horizontal: col === 3 ? 'left' : 'center',
          vertical: 'middle',
          wrapText: true,
        };
        // Telegram ID — текст, чтобы Excel не превращал в экспоненту.
        if (col === 9 && person.telegramId) {
          cell.numFmt = '@';
        }
      });
    }
  }

  sheet.addRow([]);
  const people = roster.rooms.reduce((n, r) => n + r.people.length, 0);
  const footer = sheet.addRow([
    `Сформировано ${formatRuDate(roster.meta.generatedAt)} · ${people} чел.`,
  ]);
  footer.font = { name: 'Times New Roman', size: 9, italic: true };
  sheet.mergeCells(footer.number, 1, footer.number, HEADERS.length);

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

function box(): Partial<ExcelJS.Borders> {
  const thin = { style: 'thin' as const, color: { argb: 'FF000000' } };
  return { top: thin, left: thin, bottom: thin, right: thin };
}
