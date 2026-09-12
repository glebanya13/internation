import { config } from '../config.js';
import { createPool } from '../db/pool.js';
import { ManualImportSource } from '../services/import/xlsxSource.js';
import { preview } from '../services/importService.js';

/**
 * Показывает превью импорта на демо-данных, ничего не применяя.
 * Запуск: npx tsx src/seed/importDemo.ts
 */

const db = createPool(config.databaseUrl);

try {
  const { rows: floors } = await db.query<{ id: string; number: number }>(
    'SELECT id, number FROM floors ORDER BY number LIMIT 1',
  );
  const floor = floors[0];
  if (!floor) throw new Error('Нет ни одного этажа. Запустите npm run seed.');

  // Файл: Волков переехал, у Иванова сменился факультет, у Петрова группа,
  // появился новый студент, Морозов исчез, одна строка чужого этажа.
  const rows = [
    { Комната: '601А', 'Фамилия Имя': 'Иванов Иван', Факультет: 'ТОВ', Смена: '2', 'Курс-группа': '2-1' },
    { Комната: '601А', 'Фамилия Имя': 'Петров Пётр', Факультет: 'ФИТ', Смена: '2', 'Курс-группа': '2-2' },
    { Комната: '601А', 'Фамилия Имя': 'Смирнов Алексей', Факультет: 'ФИТ', Смена: '1', 'Курс-группа': '1-4' },
    { Комната: '601Б', 'Фамилия Имя': 'Кузнецов Дмитрий', Факультет: 'ФИТ', Смена: '1', 'Курс-группа': '1-4' },
    { Комната: '605А', 'Фамилия Имя': 'Соколов Никита', Факультет: 'ФИТ', Смена: '2', 'Курс-группа': '3-2' },
    { Комната: '607А', 'Фамилия Имя': 'Волков Егор', Факультет: 'ФИТ', Смена: '2', 'Курс-группа': '1-5' },
    { Комната: '605Б', 'Фамилия Имя': 'Зайцев Роман', Факультет: 'ФИТ', Смена: '2', 'Курс-группа': '1-6' },
    { Комната: '701', 'Фамилия Имя': 'Чужой Студент', Факультет: 'ФИТ', Смена: '2', 'Курс-группа': '1-1', Этаж: '7' },
  ];

  const p = await preview(db, {
    floorId: floor.id,
    source: new ManualImportSource(),
    input: { rows, fileName: `Список_${floor.number}_этажа.xlsx` },
  });

  const s = p.summary;
  console.log(`\n${floor.number} этаж · ${p.fileName}`);
  console.log(`Текущий roster: ${s.currentRosterSize}\n`);
  console.log(`Новые:         ${s.added}`);
  console.log(`Переселились:  ${s.relocated}`);
  console.log(`Изменились:    ${s.attributesOnly}   (только атрибуты)`);
  console.log(`Исчезли:       ${s.removed}`);
  console.log(`Без изменений: ${s.unchanged}`);
  if (s.foreignFloor) console.log(`Чужой этаж:    ${s.foreignFloor}`);
  if (s.ambiguous) console.log(`Неоднозначно:  ${s.ambiguous}`);
  console.log(`\nИтого после применения: ${s.projectedRosterSize}`);
  console.log(
    `Состав ${s.compositionChanges ? 'изменится' : 'не изменится'} → ` +
      `новая версия ${s.compositionChanges ? 'будет создана' : 'не требуется'}\n`,
  );

  console.log('─'.repeat(64));
  for (const a of p.diff.added) {
    console.log(`+ Новый          ${a.name} — ${a.roomNumber}, ${a.facultyCode}, ${a.courseGroup}`);
  }
  for (const r of p.diff.relocated) {
    console.log(`↔ Переселение    ${r.name}: ${r.fromRoom} → ${r.toRoom}   [состав]`);
    for (const attr of r.attributes) {
      console.log(`                   ${attr.label}: ${attr.before} → ${attr.after}`);
    }
  }
  for (const c of p.diff.attributesOnly) {
    console.log(`~ Изменение      ${c.name} — ${c.roomNumber}   [атрибуты]`);
    for (const attr of c.attributes) {
      console.log(`                   ${attr.label}: ${attr.before ?? '—'} → ${attr.after}`);
    }
  }
  for (const r of p.diff.removed) {
    console.log(`− Исчез          ${r.name} — ${r.roomNumber}`);
    console.log('                   Отсутствует в новом списке. Что сделать?');
    console.log('                   [ деактивировать ] [ оставить активным ] [ отменить ]');
  }
  for (const f of p.diff.foreignFloor) {
    console.log(`⚠ Чужой этаж     строка ${f.rowNumber}: ${f.name} — ${f.roomNumber}`);
    console.log(`                   В файле указан ${f.declaredFloor} этаж, импорт для ${f.targetFloor}.`);
    console.log('                   Этаж НЕ исправляется автоматически.');
  }
  console.log('─'.repeat(64));

  console.log('\nРаспознанные колонки:');
  for (const c of p.recognizedColumns) console.log(`  ${c.header} → ${c.field}`);
  if (p.unmappedColumns.length) {
    console.log('\nТребуют ручного сопоставления:');
    for (const c of p.unmappedColumns) console.log(`  ${c}`);
  }

  if (p.blocking.length) {
    console.log('\nApply заблокирован, пока не приняты решения:');
    for (const b of p.blocking) console.log(`  · ${b}`);
  }
  console.log();
} finally {
  await db.end();
}
