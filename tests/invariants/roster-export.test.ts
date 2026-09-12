import ExcelJS from 'exceljs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { countPeople } from '../../src/domain/floorRoster.js';
import {
  RosterExportService,
  buildRosterDocument,
  renderRosterContactsXlsx,
  renderRosterHtml,
  renderRosterXlsx,
} from '../../src/services/export/index.js';
import { totalRows } from '../../src/services/export/rosterDocument.js';
import { FloorRosterQueryService } from '../../src/services/query/FloorRosterQueryService.js';
import { RosterSnapshotQueryService } from '../../src/services/query/RosterSnapshotQueryService.js';
import {
  currentRoster,
  setStudentStatus,
  updateStudentAttributes,
} from '../../src/services/rosterService.js';
import { type Seed, freshSeed, testPool } from '../helpers.js';

/**
 * M3 · печатный список этажа.
 *
 * Главное свойство: веб, PDF и XLSX собираются из одного DTO и одного
 * RosterDocument. Отдельных запросов «для PDF» не существует.
 */
describe('экспорт списка этажа', () => {
  let db: pg.Pool;
  let seed: Seed;
  let service: RosterExportService;
  let floor6: string;
  let floor7: string;

  beforeEach(async () => {
    db = testPool();
    seed = await freshSeed(db);
    service = new RosterExportService(db);
    floor6 = seed.floors['6']!;
    floor7 = seed.floors['7']!;
  });
  afterEach(async () => {
    await db.end();
  });

  const cellsOf = (doc: ReturnType<typeof buildRosterDocument>): string[] =>
    doc.pages.flatMap((page) =>
      [...page.left.rows, ...page.right.rows].flatMap((row) => [
        row.room.text,
        row.name.text,
        row.faculty.text,
        row.courseGroup.text,
      ]),
    );

  it('7 · пустая комната отображается и не создаёт студентов', async () => {
    const roster = await service.loadCurrent(floor7);
    // 704 заведена в структуре и не заселена.
    const room = roster.rooms.find((r) => r.number === '704');
    expect(room).toBeDefined();
    expect(room!.people).toHaveLength(0);
    expect(countPeople(roster)).toBe(5);

    const doc = buildRosterDocument(roster);
    expect(cellsOf(doc)).toContain('704');

    // Строка комнаты пустая: ни одного имени она не добавила.
    const names = doc.pages
      .flatMap((p) => [...p.left.rows, ...(p.right?.rows ?? [])])
      .filter((r) => r.room.text === '704')
      .map((r) => r.name.text);
    expect(names).toEqual(['']);
  });

  it('8 · полностью пустой блок отображается обеими комнатами', async () => {
    const roster = await service.loadCurrent(floor6);
    const emptyBlock = roster.rooms.filter((r) => r.blockCode === '607');
    expect(emptyBlock).toHaveLength(2);
    expect(emptyBlock.every((r) => r.people.length === 0)).toBe(true);

    const doc = buildRosterDocument(roster);
    const cells = cellsOf(doc);
    expect(cells).toContain('607А');
    expect(cells).toContain('607Б');
    expect(doc.stats.people).toBe(7);
  });

  it('9 · полностью пустой этаж даёт валидный документ', async () => {
    const { rows } = await db.query<{ id: string }>(
      'SELECT id FROM students WHERE floor_id = $1',
      [floor7],
    );
    for (const row of rows) await setStudentStatus(db, row.id, 'moved_out');

    const roster = await service.loadCurrent(floor7);
    expect(countPeople(roster)).toBe(0);
    expect(roster.rooms).toHaveLength(4); // структура на месте

    const doc = buildRosterDocument(roster);
    expect(doc.stats.people).toBe(0);
    expect(doc.stats.occupiedRooms).toBe(0);
    expect(doc.totalPages).toBe(1);

    const html = renderRosterHtml(doc);
    expect(html).toContain('Список студентов 7 этажа');
    // Документ существует и печатается, просто без жильцов.
    await expect(renderRosterXlsx(doc)).resolves.toBeInstanceOf(Buffer);
  });

  it('10 · частично заполненная комната печатается без выдумывания жильцов', async () => {
    const roster = await service.loadCurrent(floor6);
    const room = roster.rooms.find((r) => r.number === '605А');
    expect(room!.people).toHaveLength(2);

    // Без print_min_rows комната занимает ровно две строки.
    const doc = buildRosterDocument(roster);
    const rows = doc.pages
      .flatMap((p) => [...p.left.rows, ...(p.right?.rows ?? [])])
      .filter((r) => r.room.text === '605А' || r.room.rowSpan === 0);
    expect(doc.stats.people).toBe(7);
    expect(rows.length).toBeGreaterThan(0);

    const named = doc.pages
      .flatMap((p) => [...p.left.rows, ...(p.right?.rows ?? [])])
      .filter((r) => r.name.text !== '').length;
    expect(named).toBe(7);
  });

  it('11 · комнаты А и Б имеют минимум 3 и 2 строк в бланке', async () => {
    const doc = buildRosterDocument(await service.loadCurrent(floor6));
    const rows = doc.pages.flatMap((p) => [...p.left.rows, ...(p.right?.rows ?? [])]);

    const room601a = rows.find((r) => r.room.text === '601А');
    const room601b = rows.find((r) => r.room.text === '601Б');
    const room607a = rows.find((r) => r.room.text === '607А');
    const room607b = rows.find((r) => r.room.text === '607Б');

    expect(room601a!.room.rowSpan).toBe(3);
    expect(room601b!.room.rowSpan).toBe(2);
    expect(room607a!.room.rowSpan).toBe(3);
    expect(room607b!.room.rowSpan).toBe(2);
    expect(doc.stats.people).toBe(7);

    const named = rows.filter((r) => r.name.text !== '').length;
    expect(named).toBe(7);
  });

  it('11a · print_min_rows на комнате переопределяет этаж', async () => {
    await db.query('UPDATE floors SET print_min_rows = 2 WHERE id = $1', [floor6]);
    await db.query(`UPDATE rooms SET print_min_rows = 6 WHERE floor_id = $1 AND number = '601Б'`, [
      floor6,
    ]);

    const doc = buildRosterDocument(await service.loadCurrent(floor6));
    const roomRows = doc.pages
      .flatMap((p) => [...p.left.rows, ...(p.right?.rows ?? [])])
      .find((r) => r.room.text === '601Б');
    expect(roomRows!.room.rowSpan).toBe(6);
  });

  it('12 · print_empty_rooms скрывает пустые комнаты, не трогая состав', async () => {
    await db.query('UPDATE floors SET print_empty_rooms = false WHERE id = $1', [floor6]);
    const roster = await service.loadCurrent(floor6);

    // В данных пустые комнаты остались.
    expect(roster.rooms).toHaveLength(6);
    expect(roster.rooms.filter((r) => r.people.length === 0)).toHaveLength(2);
    expect(countPeople(roster)).toBe(7);

    // В печатной форме их нет.
    const doc = buildRosterDocument(roster);
    const cells = cellsOf(doc);
    expect(cells).not.toContain('607А');
    expect(cells).not.toContain('607Б');
    expect(doc.stats.hiddenEmptyRooms).toBe(2);
    expect(doc.stats.people).toBe(7);

    const html = renderRosterHtml(doc);
    expect(html).toContain('Комнаты без жильцов скрыты: 2');
  });

  it('13 · web, PDF и XLSX используют один набор данных', async () => {
    const roster = await service.loadCurrent(floor6);
    const options = { academicYear: '2025-2026' };

    // Один DTO → один документ → три рендерера.
    const doc = buildRosterDocument(roster, options);
    const html = renderRosterHtml(doc);
    const xlsxBuffer = await renderRosterXlsx(doc);

    const expected = cellsOf(doc).filter((v) => v !== '');

    // Каждое значение документа присутствует в HTML.
    for (const value of new Set(expected)) {
      expect(html, `нет в HTML: ${value}`).toContain(value);
    }

    // И в XLSX — читаем файл обратно.
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(xlsxBuffer as unknown as ArrayBuffer);
    const sheet = workbook.worksheets[0]!;
    const xlsxValues = new Set<string>();
    sheet.eachRow((row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const text = cell.value === null ? '' : String(cell.value).trim();
        if (text) xlsxValues.add(text);
      });
    });
    for (const value of new Set(expected)) {
      expect(xlsxValues.has(value), `нет в XLSX: ${value}`).toBe(true);
    }

    // Число людей совпадает во всех трёх представлениях.
    const namesInDoc = doc.pages
      .flatMap((p) => [...p.left.rows, ...(p.right?.rows ?? [])])
      .filter((r) => r.name.text !== '').length;
    expect(namesInDoc).toBe(countPeople(roster));
  });

  it('13a · повторная сборка документа даёт тот же результат', async () => {
    const roster = await service.loadCurrent(floor6);
    const a = buildRosterDocument(roster, { academicYear: '2025-2026' });
    const b = buildRosterDocument(roster, { academicYear: '2025-2026' });
    expect(cellsOf(a)).toEqual(cellsOf(b));
    expect(a.fileBaseName).toBe(b.fileBaseName);
  });

  it('13b · имя файла собирается из этажа и периода', async () => {
    const roster = await service.loadCurrent(floor6);
    const doc = buildRosterDocument(roster, { academicYear: '2025-2026' });
    expect(doc.fileBaseName).toBe('Список_6_этажа_2025-2026');
  });

  it('14 · изменение атрибута сразу видно в текущем списке', async () => {
    const before = await service.loadCurrent(floor6);
    const beforeVersion = before.meta.rosterVersionNo;
    const findIvanov = (r: typeof before) =>
      r.rooms.flatMap((room) => room.people).find((p) => p.lastName === 'Иванов');

    expect(findIvanov(before)!.facultyCode).toBe('ФИТ');

    await updateStudentAttributes(db, seed.students['Иванов Иван']!, {
      faculty_id: seed.faculties['ТОВ'],
    });

    const after = await service.loadCurrent(floor6);
    // Значение обновилось немедленно...
    expect(findIvanov(after)!.facultyCode).toBe('ТОВ');
    // ...и новой версии состава для этого не потребовалось.
    expect(after.meta.rosterVersionNo).toBe(beforeVersion);

    const html = renderRosterHtml(buildRosterDocument(after));
    expect(html).toContain('ТОВ');
  });

  it('14a · исправление ФИО и группы тоже видно сразу', async () => {
    await updateStudentAttributes(db, seed.students['Петров Пётр']!, {
      last_name: 'Петровский',
      group_code: '9',
    });
    const roster = await service.loadCurrent(floor6);
    const person = roster.rooms
      .flatMap((r) => r.people)
      .find((p) => p.studentId === seed.students['Петров Пётр']);

    expect(person!.displayName).toBe('Петровский Пётр');
    expect(person!.courseGroup).toBe('2-9');
  });

  it('15 · исторический snapshot не меняется после правки атрибутов', async () => {
    const version = (await currentRoster(db, floor6))!.version;
    const snapshotService = new RosterSnapshotQueryService(db);

    const before = await snapshotService.getVersion(version.id);
    const ivanovBefore = before.rooms
      .flatMap((r) => r.people)
      .find((p) => p.lastName === 'Иванов');
    expect(ivanovBefore!.facultyCode).toBe('ФИТ');

    await updateStudentAttributes(db, seed.students['Иванов Иван']!, {
      faculty_id: seed.faculties['ТОВ'],
      last_name: 'Иванченко',
    });

    const after = await snapshotService.getVersion(version.id);
    const ivanovAfter = after.rooms.flatMap((r) => r.people).find((p) => p.lastName === 'Иванов');

    // Снимок остался прежним: и факультет, и фамилия.
    expect(ivanovAfter).toBeDefined();
    expect(ivanovAfter!.facultyCode).toBe('ФИТ');
    expect(ivanovAfter!.displayName).toBe('Иванов Иван');

    // А текущий список показывает новое.
    const current = await service.loadCurrent(floor6);
    const now = current.rooms
      .flatMap((r) => r.people)
      .find((p) => p.studentId === seed.students['Иванов Иван']);
    expect(now!.displayName).toBe('Иванченко Иван');
    expect(now!.facultyCode).toBe('ТОВ');
  });

  it('15a · исторический документ помечен как снимок и не смешивает состояния', async () => {
    const version = (await currentRoster(db, floor6))!.version;
    const snapshot = await new RosterSnapshotQueryService(db).getVersion(version.id);

    expect(snapshot.meta.source).toBe('snapshot');
    // Пустые комнаты в снимке недоступны: состав помещений на тот момент
    // не зафиксирован, и дорисовывать их из текущей структуры нельзя.
    expect(snapshot.meta.emptyRoomsAvailable).toBe(false);
    expect(snapshot.rooms.every((r) => r.people.length > 0)).toBe(true);

    const doc = buildRosterDocument(snapshot, { academicYear: '2025-2026' });
    expect(doc.subtitle).toContain('версия состава №1');
    expect(doc.fileBaseName).toContain('версия_1');
  });

  it('15b · текущий список помечен как current', async () => {
    const roster = await service.loadCurrent(floor6);
    expect(roster.meta.source).toBe('current');
    expect(roster.meta.emptyRoomsAvailable).toBe(true);
    expect(roster.meta.rosterVersionNo).toBe(1);
  });

  it('этажи не смешиваются в документе', async () => {
    const roster6 = await service.loadCurrent(floor6);
    const roster7 = await service.loadCurrent(floor7);

    const names6 = new Set(roster6.rooms.flatMap((r) => r.people).map((p) => p.studentId));
    const names7 = new Set(roster7.rooms.flatMap((r) => r.people).map((p) => p.studentId));

    for (const id of names6) expect(names7.has(id)).toBe(false);
    expect(roster6.meta.floorNumber).toBe(6);
    expect(roster7.meta.floorNumber).toBe(7);
  });

  it('этаж с блоками и этаж без блоков печатаются одинаково корректно', async () => {
    const withBlocks = await service.loadCurrent(floor6);
    const flat = await service.loadCurrent(floor7);

    expect(withBlocks.rooms.every((r) => r.blockCode !== null)).toBe(true);
    expect(flat.rooms.every((r) => r.blockCode === null)).toBe(true);

    for (const roster of [withBlocks, flat]) {
      const doc = buildRosterDocument(roster);
      expect(doc.totalPages).toBeGreaterThanOrEqual(1);
      expect(renderRosterHtml(doc)).toContain('Комната');
      await expect(renderRosterXlsx(doc)).resolves.toBeInstanceOf(Buffer);
    }
  });

  it('смешанные факультеты в комнате печатаются построчно', async () => {
    // 605А: Соколов ФИТ, Морозов ТОВ — объединять факультет нельзя.
    const doc = buildRosterDocument(await service.loadCurrent(floor6));
    const rows = doc.pages
      .flatMap((p) => [...p.left.rows, ...(p.right?.rows ?? [])])
      .filter((r) => r.faculty.text === 'ФИТ' || r.faculty.text === 'ТОВ');

    const mixed = rows.filter((r) => r.faculty.rowSpan === 1);
    expect(mixed.length).toBeGreaterThan(0);
    expect(mixed.some((r) => r.faculty.text === 'ТОВ')).toBe(true);
  });

  it('однородный факультет в комнате объединяется', async () => {
    const doc = buildRosterDocument(await service.loadCurrent(floor6));
    const merged = doc.pages
      .flatMap((p) => [...p.left.rows, ...(p.right?.rows ?? [])])
      .find((r) => r.room.text === '601А');

    expect(merged!.room.rowSpan).toBe(3);
    expect(merged!.faculty.rowSpan).toBe(3);
    expect(merged!.faculty.text).toBe('ФИТ');
  });

  it('FloorRosterQueryService — единственный источник текущего списка', async () => {
    // Оба пути к текущему списку дают идентичный DTO.
    const direct = await new FloorRosterQueryService(db).getCurrent(floor6);
    const viaService = await service.loadCurrent(floor6);

    const strip = (r: typeof direct): unknown => ({
      rooms: r.rooms,
      floorNumber: r.meta.floorNumber,
      version: r.meta.rosterVersionNo,
    });
    expect(strip(viaService)).toEqual(strip(direct));
  });

  it('XLSX с контактами содержит телефон и Telegram ID', async () => {
    const { rows: student } = await db.query<{ id: string }>(
      `SELECT id FROM students WHERE floor_id = $1 AND status = 'active' LIMIT 1`,
      [floor6],
    );
    const id = student[0]!.id;
    await updateStudentAttributes(db, id, {
      phone: '+375291234567',
      telegram_id: '9876543210',
    });

    const roster = await service.loadCurrent(floor6);
    const buffer = await renderRosterContactsXlsx(roster);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    const sheet = workbook.getWorksheet('Контакты');
    expect(sheet).toBeTruthy();

    const texts: string[] = [];
    sheet!.eachRow((row) => {
      row.eachCell((cell) => {
        if (cell.text) texts.push(cell.text);
      });
    });
    expect(texts).toContain('Телефон');
    expect(texts).toContain('Telegram ID');
    expect(texts.some((t) => t.includes('+375291234567'))).toBe(true);
    expect(texts.some((t) => t.includes('9876543210'))).toBe(true);
  });
});
