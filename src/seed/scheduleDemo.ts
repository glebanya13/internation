import { config } from '../config.js';
import { createPool } from '../db/pool.js';
import { monthName, shortDate, weekdayShort } from '../domain/calendar.js';
import { formatFeasibility } from '../domain/feasibility.js';
import {
  InfeasibleScheduleError,
  feasibility,
  generate,
  generationHistory,
} from '../services/scheduleService.js';

/**
 * Демонстрация M4: отчёт о выполнимости, генерация, статистика.
 * Запуск: npx tsx src/seed/scheduleDemo.ts [месяц] [год]
 */

const month = Number(process.argv[2] ?? 9);
const year = Number(process.argv[3] ?? 2026);
const db = createPool(config.databaseUrl);

try {
  const { rows: floors } = await db.query<{ id: string; number: number }>(
    'SELECT id, number FROM floors WHERE is_active ORDER BY number',
  );

  for (const floor of floors) {
    console.log('='.repeat(70));
    console.log(`${floor.number} этаж · ${monthName(month)} ${year}`);
    console.log('='.repeat(70));

    const report = await feasibility(db, { floorId: floor.id, year, month });
    console.log(formatFeasibility(report));
    console.log();

    if (!report.feasible) {
      console.log('Генерация не запускается.\n');
      continue;
    }

    try {
      const result = await generate(db, { floorId: floor.id, year, month });
      const s = result.generation.stats;

      console.log(`Черновик создан · прогон #${result.attemptNo} · статус ${result.status}`);
      console.log(`Алгоритм: ${result.generation.algorithm}`);
      console.log();
      console.log(`Студентов: ${s.students}`);
      console.log(`Дежурств:  ${s.assignedSlots} из ${s.totalSlots}`);
      console.log(`Среднее:   ${s.averageLoad}`);
      console.log(`Минимум:   ${s.minLoad}`);
      console.log(`Максимум:  ${s.maxLoad}`);
      console.log(`Разброс:   ${s.loadSpread}`);
      console.log(
        `Конфликтов: ${s.unassignedSlots === 0 ? 0 : s.unassignedSlots} ` +
          `(незакрытых слотов)`,
      );
      console.log();
      console.log('Нарушения мягких правил:');
      console.log(`  два дежурства в один день: ${s.softViolations.sameDay}`);
      console.log(`  смены подряд:              ${s.softViolations.backToBack}`);
      console.log(`  интервал меньше нормы:     ${s.softViolations.minDaysBetween}`);
      console.log(`  пересечение с учёбой:      ${s.softViolations.studyOverlap}`);

      if (result.generation.relaxations.length > 0) {
        console.log();
        console.log('Ослабленные правила:');
        for (const r of result.generation.relaxations) {
          console.log(`  ${r.rule}: ${r.from} → ${r.to} — ${r.reason}`);
        }
      }
      if (result.generation.warnings.length > 0) {
        console.log();
        for (const w of result.generation.warnings) console.log(`Предупреждение: ${w}`);
      }

      console.log();
      console.log('Нагрузка по студентам:');
      for (const person of s.perStudent) {
        console.log(`  ${person.displayName.padEnd(24)} ${person.load}`);
      }

      // Первая неделя графика.
      const { rows: duties } = await db.query<{
        duty_date: string;
        slot_order: number;
        time_from: string;
        time_to: string;
        student_name_snapshot: string | null;
        room_number_snapshot: string | null;
      }>(
        `SELECT duty_date, slot_order, time_from, time_to,
                student_name_snapshot, room_number_snapshot
           FROM duties WHERE schedule_id = $1
          ORDER BY duty_date, slot_order LIMIT 28`,
        [result.scheduleId],
      );

      console.log();
      console.log('Первая неделя:');
      let currentDate = '';
      for (const duty of duties) {
        if (duty.duty_date !== currentDate) {
          currentDate = duty.duty_date;
          const weekday = new Date(`${duty.duty_date}T00:00:00Z`).getUTCDay();
          console.log(
            `\n  ${shortDate(duty.duty_date)} ${weekdayShort(weekday === 0 ? 7 : weekday)}`,
          );
        }
        const time = `${duty.time_from.slice(0, 5)}–${duty.time_to.slice(0, 5)}`;
        const who = duty.student_name_snapshot ?? '— не назначено —';
        const room = duty.room_number_snapshot ? ` (${duty.room_number_snapshot})` : '';
        console.log(`    ${time}  ${who}${room}`);
      }

      const history = await generationHistory(db, result.scheduleId);
      console.log();
      console.log(`История генераций: ${history.length}`);
      for (const item of history) {
        console.log(
          `  #${item.attemptNo}${item.isCurrent ? ' (актуальный)' : ''} · ${item.algorithm}`,
        );
      }
      console.log();
    } catch (error) {
      if (error instanceof InfeasibleScheduleError) {
        console.log(formatFeasibility(error.report));
      } else {
        throw error;
      }
    }
  }
} finally {
  await db.end();
}
