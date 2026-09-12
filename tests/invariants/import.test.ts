import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { ImportError, apply, preview, reject } from '../../src/services/importService.js';
import { ManualImportSource } from '../../src/services/import/xlsxSource.js';
import { candidatesForSchedule, currentRoster } from '../../src/services/rosterService.js';
import { type Seed, freshSeed, testPool } from '../helpers.js';

/**
 * M2 · импорт состава этажа.
 *
 * Ключевое свойство, которое проверяется почти в каждом тесте:
 * до Apply в students, roster и графиках не меняется НИЧЕГО.
 */

const source = new ManualImportSource();

/** Текущий состав 6 этажа в виде строк файла — «тот же самый список». */
function rowsFromSeed(): Array<Record<string, string | null>> {
  return [
    row('601А', 'Иванов Иван', 'ФИТ', '2', '2-1'),
    row('601А', 'Петров Пётр', 'ФИТ', '2', '2-1'),
    row('601А', 'Смирнов Алексей', 'ФИТ', '1', '1-4'),
    row('601Б', 'Кузнецов Дмитрий', 'ФИТ', '1', '1-4'),
    row('605А', 'Соколов Никита', 'ФИТ', '2', '3-2'),
    row('605А', 'Морозов Артём', 'ТОВ', '1', '2-7'),
    row('605Б', 'Волков Егор', 'ФИТ', '2', '1-5'),
  ];
}

function row(
  room: string,
  name: string,
  faculty: string,
  shift: string,
  courseGroup: string,
  extra: Record<string, string | null> = {},
): Record<string, string | null> {
  return {
    Комната: room,
    'Фамилия Имя': name,
    Факультет: faculty,
    Смена: shift,
    'Курс-группа': courseGroup,
    ...extra,
  };
}

describe('импорт состава', () => {
  let db: pg.Pool;
  let seed: Seed;
  let floor6: string;

  const run = async (
    rows: Array<Record<string, string | null>>,
    floorId = floor6,
  ): ReturnType<typeof preview> =>
    preview(db, { floorId, source, input: { rows, fileName: 'Список_6_этажа.xlsx' } });

  beforeEach(async () => {
    db = testPool();
    seed = await freshSeed(db);
    floor6 = seed.floors['6']!;
  });
  afterEach(async () => {
    await db.end();
  });

  it('1 · тот же самый файл → новая версия НЕ создаётся', async () => {
    const before = await currentRoster(db, floor6);
    const p = await run(rowsFromSeed());

    expect(p.summary.added).toBe(0);
    expect(p.summary.relocated).toBe(0);
    expect(p.summary.removed).toBe(0);
    expect(p.summary.unchanged).toBe(7);
    expect(p.summary.compositionChanges).toBe(false);

    const result = await apply(db, p.importId);
    expect(result.rosterVersionCreated).toBe(false);
    expect(result.message).toMatch(/Изменений состава нет/);

    const after = await currentRoster(db, floor6);
    expect(after!.version.id).toBe(before!.version.id);
    expect(after!.version.version_no).toBe(1);
  });

  it('2 · новый студент → новая версия', async () => {
    const rows = [...rowsFromSeed(), row('605Б', 'Зайцев Роман', 'ФИТ', '2', '1-6')];
    const p = await run(rows);

    expect(p.summary.added).toBe(1);
    expect(p.diff.added[0]!.name).toBe('Зайцев Роман');
    expect(p.summary.projectedRosterSize).toBe(8);
    expect(p.summary.compositionChanges).toBe(true);

    const result = await apply(db, p.importId);
    expect(result.rosterVersionCreated).toBe(true);
    expect(result.versionNo).toBe(2);

    const after = await currentRoster(db, floor6);
    expect(after!.entries).toHaveLength(8);
    expect(after!.entries.some((e) => e.full_name_snapshot === 'Зайцев Роман')).toBe(true);
  });

  it('3 · исчезнувший студент определяется в diff', async () => {
    const rows = rowsFromSeed().filter((r) => r['Фамилия Имя'] !== 'Волков Егор');
    const p = await run(rows);

    expect(p.diff.removed).toHaveLength(1);
    expect(p.diff.removed[0]!.name).toBe('Волков Егор');
    expect(p.diff.removed[0]!.roomNumber).toBe('605Б');
    expect(p.diff.removed[0]!.requiresDecision).toBe(true);
  });

  it('4 · исчезнувший студент не удаляется автоматически', async () => {
    const rows = rowsFromSeed().filter((r) => r['Фамилия Имя'] !== 'Волков Егор');
    const p = await run(rows);

    // Без решения Apply вообще не запускается.
    expect(p.blocking).toHaveLength(1);
    expect(p.blocking[0]).toMatch(/Волков Егор/);
    await expect(apply(db, p.importId)).rejects.toBeInstanceOf(ImportError);

    // Решение «оставить активным» — студент остаётся в составе.
    const p2 = await run(rows);
    const result = await apply(db, p2.importId, {
      decisions: { removed: { [p2.diff.removed[0]!.studentId]: 'keep_active' } },
    });
    expect(result.rosterVersionCreated).toBe(false);

    const roster = await currentRoster(db, floor6);
    expect(roster!.entries.some((e) => e.full_name_snapshot === 'Волков Егор')).toBe(true);

    const { rows: check } = await db.query<{ status: string }>(
      'SELECT status FROM students WHERE id = $1',
      [p2.diff.removed[0]!.studentId],
    );
    expect(check[0]!.status).toBe('active');
  });

  it('4a · решение «деактивировать» убирает из состава и создаёт версию', async () => {
    const rows = rowsFromSeed().filter((r) => r['Фамилия Имя'] !== 'Волков Егор');
    const p = await run(rows);
    const studentId = p.diff.removed[0]!.studentId;

    const result = await apply(db, p.importId, {
      decisions: { removed: { [studentId]: 'deactivate' } },
    });
    expect(result.rosterVersionCreated).toBe(true);
    expect(result.applied.deactivated).toBe(1);

    const roster = await currentRoster(db, floor6);
    expect(roster!.entries).toHaveLength(6);

    const { rows: check } = await db.query<{ status: string; left_at: string }>(
      'SELECT status, left_at FROM students WHERE id = $1',
      [studentId],
    );
    expect(check[0]!.status).toBe('moved_out');
    expect(check[0]!.left_at).toBeTruthy();
  });

  it('5 · переселение → изменение состава → новая версия', async () => {
    const rows = rowsFromSeed().map((r) =>
      r['Фамилия Имя'] === 'Волков Егор' ? { ...r, Комната: '607А' } : r,
    );
    const p = await run(rows);

    expect(p.diff.relocated).toHaveLength(1);
    expect(p.diff.relocated[0]!.fromRoom).toBe('605Б');
    expect(p.diff.relocated[0]!.toRoom).toBe('607А');
    expect(p.summary.compositionChanges).toBe(true);

    const result = await apply(db, p.importId);
    expect(result.rosterVersionCreated).toBe(true);

    const roster = await currentRoster(db, floor6);
    const moved = roster!.entries.find((e) => e.full_name_snapshot === 'Волков Егор');
    expect(moved!.room_number_snapshot).toBe('607А');
  });

  it('6 · изменение факультета → версия состава НЕ создаётся', async () => {
    const before = await currentRoster(db, floor6);
    const rows = rowsFromSeed().map((r) =>
      r['Фамилия Имя'] === 'Иванов Иван' ? { ...r, Факультет: 'ТОВ' } : r,
    );
    const p = await run(rows);

    expect(p.diff.attributesOnly).toHaveLength(1);
    expect(p.diff.attributesOnly[0]!.attributes[0]!.label).toBe('Факультет');
    expect(p.diff.attributesOnly[0]!.attributes[0]!.before).toBe('ФИТ');
    expect(p.diff.attributesOnly[0]!.attributes[0]!.after).toBe('ТОВ');
    expect(p.summary.compositionChanges).toBe(false);

    const result = await apply(db, p.importId);
    expect(result.rosterVersionCreated).toBe(false);
    expect(result.applied.attributesUpdated).toBe(1);

    const after = await currentRoster(db, floor6);
    expect(after!.version.id).toBe(before!.version.id);

    // Но сам факультет в students обновился.
    const { rows: check } = await db.query<{ code: string }>(
      `SELECT f.code FROM students s JOIN faculties f ON f.id = s.faculty_id
        WHERE s.id = $1`,
      [seed.students['Иванов Иван']],
    );
    expect(check[0]!.code).toBe('ТОВ');
  });

  it('7 · изменение группы → версия состава НЕ создаётся', async () => {
    const before = await currentRoster(db, floor6);
    const rows = rowsFromSeed().map((r) =>
      r['Фамилия Имя'] === 'Петров Пётр' ? { ...r, 'Курс-группа': '2-9' } : r,
    );
    const p = await run(rows);

    expect(p.diff.attributesOnly).toHaveLength(1);
    expect(p.summary.compositionChanges).toBe(false);

    const result = await apply(db, p.importId);
    expect(result.rosterVersionCreated).toBe(false);

    const after = await currentRoster(db, floor6);
    expect(after!.version.id).toBe(before!.version.id);

    const { rows: check } = await db.query<{ group_code: string }>(
      'SELECT group_code FROM students WHERE id = $1',
      [seed.students['Петров Пётр']],
    );
    expect(check[0]!.group_code).toBe('9');
  });

  it('8 · изменение учебной смены → версия состава НЕ создаётся', async () => {
    const before = await currentRoster(db, floor6);
    const rows = rowsFromSeed().map((r) =>
      r['Фамилия Имя'] === 'Соколов Никита' ? { ...r, Смена: '1' } : r,
    );
    const p = await run(rows);

    expect(p.diff.attributesOnly).toHaveLength(1);
    expect(p.diff.attributesOnly[0]!.attributes[0]!.label).toBe('Учебная смена');

    const result = await apply(db, p.importId);
    expect(result.rosterVersionCreated).toBe(false);

    const after = await currentRoster(db, floor6);
    expect(after!.version.id).toBe(before!.version.id);

    const { rows: check } = await db.query<{ code: string }>(
      `SELECT sh.code FROM students s JOIN study_shifts sh ON sh.id = s.study_shift_id
        WHERE s.id = $1`,
      [seed.students['Соколов Никита']],
    );
    expect(check[0]!.code).toBe('1');
  });

  it('9 · комната, опустевшая после импорта, валидна и не удаляется', async () => {
    // 605Б был с одним жильцом — переселяем его, комната становится пустой.
    const rows = rowsFromSeed().map((r) =>
      r['Фамилия Имя'] === 'Волков Егор' ? { ...r, Комната: '601Б' } : r,
    );
    const p = await run(rows);
    await apply(db, p.importId);

    const { rows: room } = await db.query<{ id: string; is_active: boolean }>(
      `SELECT id, is_active FROM rooms WHERE floor_id = $1 AND number = '605Б'`,
      [floor6],
    );
    expect(room).toHaveLength(1);
    expect(room[0]!.is_active).toBe(true);

    const { rows: occupants } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM students
        WHERE room_id = $1 AND status <> 'moved_out'`,
      [room[0]!.id],
    );
    expect(occupants[0]!.count).toBe('0');
  });

  it('10 · блок, полностью опустевший после импорта, не удаляется', async () => {
    // Уводим обоих жильцов блока 605 в блок 601.
    const rows = rowsFromSeed().map((r) => {
      if (r['Фамилия Имя'] === 'Соколов Никита') return { ...r, Комната: '601Б' };
      if (r['Фамилия Имя'] === 'Морозов Артём') return { ...r, Комната: '601Б' };
      if (r['Фамилия Имя'] === 'Волков Егор') return { ...r, Комната: '601Б' };
      return r;
    });
    const p = await run(rows);
    await apply(db, p.importId);

    const { rows: block } = await db.query<{ code: string; occupants: string }>(
      `SELECT b.code, count(s.id) FILTER (WHERE s.status <> 'moved_out')::text AS occupants
         FROM blocks b
         JOIN rooms r ON r.block_id = b.id
         LEFT JOIN students s ON s.room_id = r.id
        WHERE b.floor_id = $1 AND b.code = '605'
        GROUP BY b.code`,
      [floor6],
    );
    expect(block).toHaveLength(1);
    expect(block[0]!.occupants).toBe('0');
  });

  it('11 · пустой список → версия с нулевым составом, но график невозможен', async () => {
    const p = await run([]);
    expect(p.summary.added).toBe(0);
    expect(p.summary.removed).toBe(7);

    const decisions = {
      removed: Object.fromEntries(
        p.diff.removed.map((r) => [r.studentId, 'deactivate' as const]),
      ),
    };
    const result = await apply(db, p.importId, { decisions });
    expect(result.rosterVersionCreated).toBe(true);

    const roster = await currentRoster(db, floor6);
    expect(roster).not.toBeNull();
    expect(roster!.entries).toHaveLength(0);

    await expect(candidatesForSchedule(db, floor6)).rejects.toThrow(/нет активных студентов/);

    // Комнаты и блоки остались в структуре.
    const { rows: structure } = await db.query<{ rooms: string; blocks: string }>(
      `SELECT (SELECT count(*)::text FROM rooms  WHERE floor_id = $1) AS rooms,
              (SELECT count(*)::text FROM blocks WHERE floor_id = $1) AS blocks`,
      [floor6],
    );
    expect(structure[0]!.rooms).toBe('6');
    expect(structure[0]!.blocks).toBe('3');
  });

  it('12 · запись другого этажа не применяется', async () => {
    const rows = [
      ...rowsFromSeed(),
      row('701', 'Чужой Студент', 'ФИТ', '2', '1-1', { Этаж: '7' }),
    ];
    const p = await run(rows);

    expect(p.diff.foreignFloor).toHaveLength(1);
    expect(p.diff.foreignFloor[0]!.declaredFloor).toBe(7);
    expect(p.diff.foreignFloor[0]!.targetFloor).toBe(6);
    expect(p.diff.added).toHaveLength(0);

    // Без явного решения Apply заблокирован.
    expect(p.blocking.some((b) => /Чужой Студент/.test(b))).toBe(true);
    await expect(apply(db, p.importId)).rejects.toThrow(/не приняты решения/);

    const p2 = await run(rows);
    await apply(db, p2.importId, {
      decisions: { foreignFloor: { [p2.diff.foreignFloor[0]!.rowNumber]: 'skip' } },
    });

    // Ни на одном этаже студент не появился, этаж не «исправлен» автоматически.
    const { rows: check } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM students WHERE last_name = 'Чужой'`,
    );
    expect(check[0]!.count).toBe('0');
  });

  it('13 · неоднозначный студент требует ручного решения', async () => {
    // Заводим тёзку в другой комнате того же этажа.
    const withTwin = [...rowsFromSeed(), row('601Б', 'Иванов Иван', 'ФИТ', '1', '1-2')];
    const p0 = await run(withTwin);
    await apply(db, p0.importId);

    // Теперь файл, где у тёзки не указана комната — сопоставить нельзя.
    const ambiguousRows = [
      ...rowsFromSeed().filter((r) => r['Фамилия Имя'] !== 'Иванов Иван'),
      { 'Фамилия Имя': 'Иванов Иван', Комната: '605А', Факультет: 'ФИТ' },
    ];
    const p = await run(ambiguousRows);

    expect(p.diff.ambiguous).toHaveLength(1);
    expect(p.diff.ambiguous[0]!.candidates.length).toBeGreaterThan(1);
    expect(p.diff.ambiguous[0]!.requiresDecision).toBe(true);
    expect(p.blocking.some((b) => /несколько подходящих/.test(b))).toBe(true);

    await expect(apply(db, p.importId)).rejects.toThrow(/не приняты решения/);
  });

  it('13a · совпадение по Telegram ID разрешает неоднозначность ФИО', async () => {
    await db.query('UPDATE students SET telegram_id = $2 WHERE id = $1', [
      seed.students['Иванов Иван'],
      '555000111',
    ]);
    const rows = rowsFromSeed().map((r) =>
      r['Фамилия Имя'] === 'Иванов Иван'
        ? { ...r, Комната: '605А', 'Telegram ID': '555000111' }
        : r,
    );
    const p = await run(rows);

    expect(p.diff.ambiguous).toHaveLength(0);
    expect(p.diff.added).toHaveLength(0);
    expect(p.diff.relocated).toHaveLength(1);
    expect(p.diff.relocated[0]!.studentId).toBe(seed.students['Иванов Иван']);
  });

  it('14 · ошибка во время Apply откатывает всё', async () => {
    // Комната 999 не существует в структуре — Apply упадёт на середине,
    // уже добавив первого нового студента.
    const rows = [
      ...rowsFromSeed(),
      row('601Б', 'Первый Новичок', 'ФИТ', '2', '1-1'),
      row('999', 'Второй Новичок', 'ФИТ', '2', '1-1'),
    ];
    const p = await run(rows);
    expect(p.summary.added).toBe(2);

    const versionsBefore = await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM roster_versions WHERE floor_id = $1',
      [floor6],
    );
    const auditBefore = await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM audit_log',
    );

    await expect(apply(db, p.importId)).rejects.toThrow(/Комната 999 не найдена/);

    // students не изменились даже частично.
    const { rows: students } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM students WHERE floor_id = $1`,
      [floor6],
    );
    expect(students[0]!.count).toBe('7');
    expect(
      (await db.query(`SELECT 1 FROM students WHERE last_name = 'Первый'`)).rowCount,
    ).toBe(0);

    // Версия roster не создана даже наполовину.
    const versionsAfter = await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM roster_versions WHERE floor_id = $1',
      [floor6],
    );
    expect(versionsAfter.rows[0]!.count).toBe(versionsBefore.rows[0]!.count);

    // В audit_log нет фиктивных записей.
    const auditAfter = await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM audit_log',
    );
    expect(auditAfter.rows[0]!.count).toBe(auditBefore.rows[0]!.count);

    // Импорт остался pending — его можно поправить и применить снова.
    const { rows: state } = await db.query<{ state: string }>(
      'SELECT state FROM roster_imports WHERE id = $1',
      [p.importId],
    );
    expect(state[0]!.state).toBe('pending');
  });

  it('15 · старая версия состава не меняется после импорта', async () => {
    const before = await currentRoster(db, floor6);
    const beforeIds = before!.entries.map((e) => e.student_id).sort();

    const rows = [...rowsFromSeed(), row('607А', 'Зайцев Роман', 'ФИТ', '2', '1-6')];
    const p = await run(rows);
    await apply(db, p.importId);

    const oldAgain = await db.query<{ student_id: string }>(
      'SELECT student_id FROM roster_entries WHERE roster_version_id = $1',
      [before!.version.id],
    );
    expect(oldAgain.rows.map((r) => r.student_id).sort()).toEqual(beforeIds);

    const { rows: status } = await db.query<{ status: string }>(
      'SELECT status FROM roster_versions WHERE id = $1',
      [before!.version.id],
    );
    expect(status[0]!.status).toBe('superseded');
  });

  it('16 · после Apply состав current roster совпадает со students', async () => {
    const rows = [
      ...rowsFromSeed().filter((r) => r['Фамилия Имя'] !== 'Волков Егор'),
      row('607Б', 'Зайцев Роман', 'ФИТ', '2', '1-6'),
    ];
    const p = await run(rows);
    await apply(db, p.importId, {
      decisions: { removed: { [p.diff.removed[0]!.studentId]: 'deactivate' } },
    });

    const roster = await currentRoster(db, floor6);
    const { rows: students } = await db.query<{ id: string; number: string }>(
      `SELECT s.id, r.number FROM students s
         JOIN rooms r ON r.id = s.room_id
        WHERE s.floor_id = $1 AND s.status <> 'moved_out'`,
      [floor6],
    );

    expect(roster!.entries.map((e) => e.student_id).sort()).toEqual(
      students.map((s) => s.id).sort(),
    );
    // И комнаты совпадают — состав, а не только список идентификаторов.
    const roomById = new Map(students.map((s) => [s.id, s.number]));
    for (const entry of roster!.entries) {
      expect(entry.room_number_snapshot).toBe(roomById.get(entry.student_id));
    }
  });

  it('17 · повторный импорт того же состояния идемпотентен', async () => {
    const rows = [...rowsFromSeed(), row('607А', 'Зайцев Роман', 'ФИТ', '2', '1-6')];

    const first = await run(rows);
    const firstResult = await apply(db, first.importId);
    expect(firstResult.rosterVersionCreated).toBe(true);
    expect(firstResult.versionNo).toBe(2);

    // Тот же файл во второй раз.
    const second = await run(rows);
    expect(second.summary.added).toBe(0);
    expect(second.summary.relocated).toBe(0);
    expect(second.summary.removed).toBe(0);
    expect(second.summary.unchanged).toBe(8);

    const secondResult = await apply(db, second.importId);
    expect(secondResult.rosterVersionCreated).toBe(false);
    expect(secondResult.versionNo).toBe(2);

    // И третий — тоже без новых версий.
    const third = await run(rows);
    const thirdResult = await apply(db, third.importId);
    expect(thirdResult.rosterVersionCreated).toBe(false);

    const { rows: versions } = await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM roster_versions WHERE floor_id = $1',
      [floor6],
    );
    expect(versions[0]!.count).toBe('2');
  });

  it('превью ничего не записывает в students до Apply', async () => {
    const snapshot = async (): Promise<unknown[]> =>
      (
        await db.query(
          `SELECT id, room_id, faculty_id, status FROM students
            WHERE floor_id = $1 ORDER BY id`,
          [floor6],
        )
      ).rows;

    const before = await snapshot();
    await run([
      ...rowsFromSeed().map((r) => ({ ...r, Факультет: 'ТОВ' })),
      row('607А', 'Новый Человек', 'ФИТ', '2', '1-1'),
    ]);
    expect(await snapshot()).toEqual(before);

    const roster = await currentRoster(db, floor6);
    expect(roster!.version.version_no).toBe(1);
  });

  it('отклонённый импорт нельзя применить', async () => {
    const p = await run([...rowsFromSeed(), row('607А', 'Зайцев Роман', 'ФИТ', '2', '1-6')]);
    await reject(db, p.importId);
    await expect(apply(db, p.importId)).rejects.toThrow(/уже обработан/);
  });
});
