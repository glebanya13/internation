import { config } from '../config.js';
import { createPool } from '../db/pool.js';
import { formatFeasibility } from '../domain/feasibility.js';
import { InfeasibleScheduleError, feasibility, generate } from '../services/scheduleService.js';

/**
 * Пример невозможного графика: учебное время закрывает утренние слоты
 * будней. Изменения откатываются в конце.
 * Запуск: npx tsx src/seed/infeasibleDemo.ts
 */
const db = createPool(config.databaseUrl);

try {
  const { rows } = await db.query<{ id: string; number: number }>(
    'SELECT id, number FROM floors ORDER BY number LIMIT 1',
  );
  const floor = rows[0]!;

  console.log('Сценарий: у обеих учебных смен задано время занятий,');
  console.log('перекрывающее утренние дежурства будней.\n');

  await db.query(
    `UPDATE study_shifts
        SET busy_from = '08:30', busy_to = '14:00', busy_weekdays = '{1,2,3,4,5,6}'`,
  );

  const report = await feasibility(db, { floorId: floor.id, year: 2026, month: 9 });
  console.log('='.repeat(66));
  console.log(`${floor.number} этаж · Сентябрь 2026`);
  console.log('='.repeat(66));
  console.log(formatFeasibility(report));

  if (report.blockedSlots.length > 0) {
    console.log(`\nЗаблокированных слотов: ${report.blockedSlots.length}`);
    for (const slot of report.blockedSlots.slice(0, 4)) {
      console.log(`  ${slot.date}  ${slot.timeFrom}–${slot.timeTo}`);
    }
    console.log('  …');
  }

  console.log('\nПопытка генерации:');
  try {
    await generate(db, { floorId: floor.id, year: 2026, month: 9 });
    console.log('  График создан (не ожидалось).');
  } catch (error) {
    if (error instanceof InfeasibleScheduleError) {
      console.log('  Отклонено. Черновик не создан, дежурства не записаны.');
    } else {
      throw error;
    }
  }

  const { rows: created } = await db.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM duty_schedules WHERE floor_id = $1',
    [floor.id],
  );
  console.log(`  Графиков в базе: ${created[0]!.count}`);
} finally {
  await db.query('UPDATE study_shifts SET busy_from = NULL, busy_to = NULL');
  await db.end();
}
