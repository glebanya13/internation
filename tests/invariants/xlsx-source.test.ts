import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { XlsxImportSource } from '../../src/services/import/xlsxSource.js';

/**
 * Разбор XLSX в вёрстке реального документа: два зеркальных блока колонок
 * и объединённые по вертикали ячейки комнаты и факультета.
 */

const HEADER = [
  'Комната',
  'Фамилия Имя',
  'Факультет',
  'Смена',
  'Курс-группа',
  'Комната',
  'Фамилия Имя',
  'Факультет',
  'Смена',
  'Курс-группа',
];

/**
 * Строит книгу так же, как выглядит приложенный список 4 этажа:
 * комната и факультет заполнены только в первой строке комнаты,
 * остальные строки блока пустые, свободные места остаются пустыми.
 */
async function buildWorkbook(
  left: Array<{ room: string; faculty: string; people: Array<[string, string, string]> }>,
  right: Array<{ room: string; faculty: string; people: Array<[string, string, string]> }>,
  rowsPerRoom = 5,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Список');
  sheet.addRow(HEADER);

  const blocks = Math.max(left.length, right.length);
  for (let b = 0; b < blocks; b += 1) {
    for (let i = 0; i < rowsPerRoom; i += 1) {
      const line: Array<string | null> = new Array(10).fill(null);

      const leftRoom = left[b];
      if (leftRoom) {
        if (i === 0) {
          line[0] = leftRoom.room;
          line[2] = leftRoom.faculty;
        }
        const person = leftRoom.people[i];
        if (person) {
          line[1] = person[0];
          line[3] = person[1];
          line[4] = person[2];
        }
      }

      const rightRoom = right[b];
      if (rightRoom) {
        if (i === 0) {
          line[5] = rightRoom.room;
          line[7] = rightRoom.faculty;
        }
        const person = rightRoom.people[i];
        if (person) {
          line[6] = person[0];
          line[8] = person[1];
          line[9] = person[2];
        }
      }

      sheet.addRow(line);
    }
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

describe('разбор XLSX', () => {
  const source = new XlsxImportSource();

  it('читает два зеркальных блока колонок как один список', async () => {
    const buffer = await buildWorkbook(
      [
        {
          room: '601А',
          faculty: 'ФИТ',
          people: [
            ['Иванов Иван', '2', '2-1'],
            ['Петров Пётр', '2', '2-1'],
          ],
        },
        { room: '601Б', faculty: 'ФИТ', people: [['Смирнов Алексей', '1', '1-4']] },
      ],
      [
        {
          room: '605А',
          faculty: 'ТОВ',
          people: [
            ['Соколов Никита', '2', '3-2'],
            ['Морозов Артём', '1', '2-7'],
            ['Волков Егор', '2', '1-5'],
          ],
        },
        { room: '605Б', faculty: 'ФИТ', people: [['Кузнецов Дмитрий', '1', '1-4']] },
      ],
    );

    const parsed = await source.parse({ buffer, fileName: 'список.xlsx' });
    expect(parsed.rows).toHaveLength(7);

    const names = parsed.rows.map((r) => `${r.lastName} ${r.firstName}`);
    expect(names).toContain('Иванов Иван');
    expect(names).toContain('Волков Егор');
    expect(parsed.unparsedRows).toHaveLength(0);
    expect(parsed.unmappedColumns).toHaveLength(0);
  });

  it('протягивает объединённые ячейки комнаты и факультета', async () => {
    const buffer = await buildWorkbook(
      [
        {
          room: '601А',
          faculty: 'ФИТ',
          people: [
            ['Иванов Иван', '2', '2-1'],
            ['Петров Пётр', '2', '2-1'],
            ['Смирнов Алексей', '1', '1-4'],
          ],
        },
      ],
      [],
    );

    const parsed = await source.parse({ buffer });
    expect(parsed.rows).toHaveLength(3);
    for (const row of parsed.rows) {
      expect(row.roomNumber).toBe('601А');
      expect(row.facultyCode).toBe('ФИТ');
    }
  });

  it('факультет не протекает из предыдущей комнаты', async () => {
    // У второй комнаты факультет не указан — он не должен унаследоваться.
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Список');
    sheet.addRow(['Комната', 'Фамилия Имя', 'Факультет', 'Смена', 'Курс-группа']);
    sheet.addRow(['601А', 'Иванов Иван', 'ФИТ', '2', '2-1']);
    sheet.addRow([null, 'Петров Пётр', null, '2', '2-1']);
    sheet.addRow(['601Б', 'Сидоров Сидор', null, '1', '1-1']);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

    const parsed = await source.parse({ buffer });
    expect(parsed.rows[0]!.facultyCode).toBe('ФИТ');
    expect(parsed.rows[1]!.facultyCode).toBe('ФИТ');
    expect(parsed.rows[2]!.facultyCode).toBeNull();
  });

  it('пустые строки комнаты — свободные места, а не ошибки', async () => {
    // 607А и 607Б полностью пусты: комнаты есть в бланке, жильцов нет.
    const buffer = await buildWorkbook(
      [
        { room: '607А', faculty: '', people: [] },
        { room: '607Б', faculty: '', people: [] },
      ],
      [],
    );

    const parsed = await source.parse({ buffer });
    expect(parsed.rows).toHaveLength(0);
    expect(parsed.unparsedRows).toHaveLength(0);
  });

  it('разбирает курс-группу вида 2-1/2', async () => {
    const buffer = await buildWorkbook(
      [{ room: '402', faculty: 'ТОВ', people: [['Кучинский Владислав', '2', '2-1/2']] }],
      [],
    );
    const parsed = await source.parse({ buffer });
    expect(parsed.rows[0]!.course).toBe(2);
    expect(parsed.rows[0]!.groupCode).toBe('1/2');
  });

  it('сообщает о нераспознанных колонках, но не падает', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Список');
    sheet.addRow(['Комната', 'Фамилия Имя', 'Факультет', 'Примечание старосты']);
    sheet.addRow(['601А', 'Иванов Иван', 'ФИТ', 'что-то своё']);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

    const parsed = await source.parse({ buffer });
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.unmappedColumns).toEqual(['Примечание старосты']);
    expect(parsed.recognizedColumns.map((c) => c.field)).toEqual([
      'roomNumber',
      'fullName',
      'facultyCode',
    ]);
  });

  it('строка без комнаты уходит в нераспознанные, а не теряется', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Список');
    sheet.addRow(['Фамилия Имя', 'Факультет']);
    sheet.addRow(['Иванов Иван', 'ФИТ']);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

    const parsed = await source.parse({ buffer });
    expect(parsed.rows).toHaveLength(0);
    expect(parsed.unparsedRows).toHaveLength(1);
    expect(parsed.unparsedRows[0]!.reason).toMatch(/Не указана комната/);
  });

  it('файл без узнаваемых заголовков отклоняется с понятной ошибкой', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Лист');
    sheet.addRow(['абв', 'где']);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

    await expect(source.parse({ buffer })).rejects.toThrow(/Не найдена строка заголовков/);
  });
});
