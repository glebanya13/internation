/**
 * Исправляет факультеты и группы по правилу:
 * группы 1–3 → ИСИТ, 4–5 → ЦД, 6–10 → ПИ; запись «2-3» = 2 курс, 3 группа.
 */
import { config } from '../config.js';
import { facultyForGroup, formatGroupCode } from '../domain/facultyGroup.js';
import { createPool } from '../db/pool.js';

const UPDATES: Array<{
  last: string;
  first: string;
  course: number | null;
  groupNo: number | null;
}> = [
  { last: 'Гануш', first: 'Матвей', course: 1, groupNo: 5 },
  { last: 'Морозова', first: 'Анастасия', course: 1, groupNo: 5 },
  { last: 'Цык', first: 'Владислав', course: 1, groupNo: 6 },
  { last: 'Феоктистов', first: 'Глеб', course: 1, groupNo: 4 },
  { last: 'Бобровский', first: 'Михаил', course: 1, groupNo: 4 },
  { last: 'Алехнович', first: 'Вячеслав', course: 1, groupNo: 7 },
  { last: 'Захаревич', first: 'Станислав', course: 1, groupNo: 6 },
  { last: 'Антонюк', first: 'Иван', course: 1, groupNo: 4 },
  { last: 'Кохненко', first: 'Роман', course: 1, groupNo: 6 },
  { last: 'Иванова', first: 'Марина', course: 1, groupNo: 4 },
  { last: 'Карлюк', first: 'Артём', course: 3, groupNo: 9 },
  { last: 'Милевский', first: 'Никита', course: 1, groupNo: 7 },
  { last: 'Сидорик', first: 'Ярослав', course: 3, groupNo: 4 },
  { last: 'Ильинковский', first: 'Арсений', course: 3, groupNo: 7 },
  { last: 'Бриштель', first: 'Михаил', course: 2, groupNo: 8 },
];

const db = createPool(config.databaseUrl);

try {
  const dorm = (await db.query<{ id: string }>('SELECT id FROM dormitories LIMIT 1')).rows[0];
  if (!dorm) throw new Error('Общежитие не найдено');

  await db.query(
    `INSERT INTO faculties (dormitory_id, code, name, sort_order)
     VALUES ($1, 'ИСИТ', 'Информационные системы и технологии', 0)
     ON CONFLICT (dormitory_id, code) DO NOTHING`,
    [dorm.id],
  );

  const faculties = new Map(
    (
      await db.query<{ id: string; code: string }>(
        'SELECT id, code FROM faculties WHERE dormitory_id = $1 OR dormitory_id IS NULL',
        [dorm.id],
      )
    ).rows.map((r) => [r.code, r.id]),
  );

  let updated = 0;
  for (const row of UPDATES) {
    const facultyCode = facultyForGroup(row.groupNo!);
    const facultyId = faculties.get(facultyCode);
    if (!facultyId) throw new Error(`Факультет ${facultyCode} не найден`);

    const result = await db.query(
      `UPDATE students
          SET course = $3,
              group_code = $4,
              faculty_id = $5,
              updated_at = now()
        WHERE last_name = $1 AND first_name = $2`,
      [
        row.last,
        row.first,
        row.course,
        formatGroupCode(row.course!, row.groupNo!),
        facultyId,
      ],
    );
    updated += result.rowCount ?? 0;
    console.log(
      `${row.last} ${row.first}: ${formatGroupCode(row.course!, row.groupNo!)} → ${facultyCode}`,
    );
  }

  console.log(`\nОбновлено студентов: ${updated}`);
} finally {
  await db.end();
}
