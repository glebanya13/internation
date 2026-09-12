import type pg from 'pg';
import { monthName } from '../../domain/calendar.js';
import * as messages from '../notifications/messages.js';

/**
 * Логика студенческого бота.
 *
 *   Telegram adapter → BotService → PostgreSQL
 *
 * Класс не знает ни про Telegram API, ни про кнопки, ни про разметку —
 * он принимает telegram_id и возвращает готовый текст. Добавить второй
 * интерфейс можно, не трогая ничего здесь.
 *
 * БЕЗОПАСНОСТЬ. Единственный вход — telegram_id. Ни один метод не
 * принимает student_id, floor_id или schedule_id снаружи: всё выводится
 * из карточки студента. Поэтому «/floor 7» физически не может вернуть
 * данные седьмого этажа — параметра, куда это подставить, не существует.
 */

export type BotAction = 'start' | 'my_duty' | 'my_schedule' | 'my_info' | 'menu' | 'unknown';

export interface BotReply {
  text: string;
  /** Подписи кнопок главного меню. Разметку строит адаптер. */
  buttons: string[];
  /** Распознан ли отправитель. Незарегистрированный не видит кнопок. */
  registered: boolean;
}

const MENU_BUTTONS = ['📅 Моё дежурство', '📋 Мой график', 'ℹ️ Моя информация'];

interface StudentContext {
  studentId: string;
  floorId: string;
  floorNumber: number;
  fullName: string;
  roomNumber: string;
  blockCode: string | null;
  facultyCode: string | null;
  studyShiftCode: string | null;
  course: number | null;
  groupCode: string | null;
  status: string;
}

export class BotService {
  constructor(private readonly db: pg.Pool | pg.PoolClient) {}

  /** Разрешение отправителя. Никаких других способов войти в систему нет. */
  async resolve(telegramId: string): Promise<StudentContext | null> {
    const { rows } = await this.db.query<StudentContext>(
      `SELECT s.id            AS "studentId",
              s.floor_id      AS "floorId",
              f.number        AS "floorNumber",
              trim(concat_ws(' ', s.last_name, s.first_name, s.middle_name)) AS "fullName",
              r.number        AS "roomNumber",
              b.code          AS "blockCode",
              fac.code        AS "facultyCode",
              sh.code         AS "studyShiftCode",
              s.course,
              s.group_code    AS "groupCode",
              s.status
         FROM students s
         JOIN rooms r  ON r.id = s.room_id
         JOIN floors f ON f.id = s.floor_id
         LEFT JOIN blocks b        ON b.id  = r.block_id
         LEFT JOIN faculties fac   ON fac.id = s.faculty_id
         LEFT JOIN study_shifts sh ON sh.id = s.study_shift_id
        WHERE s.telegram_id = $1
          AND s.status <> 'moved_out'`,
      [telegramId],
    );
    return rows[0] ?? null;
  }

  async handle(telegramId: string, action: BotAction): Promise<BotReply> {
    const student = await this.resolve(telegramId);
    if (!student) {
      return { text: messages.NOT_REGISTERED, buttons: [], registered: false };
    }

    switch (action) {
      case 'my_duty':
        return this.reply(await this.myDuty(student));
      case 'my_schedule':
        return this.reply(await this.mySchedule(student));
      case 'my_info':
        return this.reply(this.myInfo(student));
      case 'start':
      case 'menu':
        return this.reply(this.menu(student));
      case 'unknown':
        return this.reply('Выберите пункт меню.');
    }
  }

  private reply(text: string): BotReply {
    return { text, buttons: MENU_BUTTONS, registered: true };
  }

  private menu(student: StudentContext): string {
    return [
      '🏠 Главное меню',
      '',
      student.fullName,
      `🏢 ${student.floorNumber} этаж · 🚪 ${student.roomNumber}`,
      '',
      'Выберите пункт ниже.',
    ].join('\n');
  }

  /**
   * Ближайшее предстоящее дежурство.
   * Только опубликованные графики и только этого студента.
   */
  private async myDuty(student: StudentContext, today = new Date()): Promise<string> {
    const todayIso = today.toISOString().slice(0, 10);

    const { rows } = await this.db.query<{
      duty_date: string;
      time_from: string;
      time_to: string;
      floor_number_snapshot: number | null;
      room_number_snapshot: string | null;
    }>(
      `SELECT d.duty_date, d.time_from, d.time_to,
              d.floor_number_snapshot, d.room_number_snapshot
         FROM duties d
         JOIN duty_schedules s ON s.id = d.schedule_id
        WHERE d.student_id = $1
          AND s.status = 'published'
          AND d.status = 'scheduled'
          AND d.duty_date >= $2::date
        ORDER BY d.duty_date, d.slot_order
        LIMIT 1`,
      [student.studentId, todayIso],
    );

    const duty = rows[0];
    if (!duty) return 'На данный момент у вас нет запланированных дежурств.';

    const time = messages.timeRange(duty.time_from, duty.time_to);
    if (duty.duty_date === todayIso) {
      return ['🔔 Сегодня ваше дежурство', '', time].join('\n');
    }

    const days = Math.round(
      (Date.parse(`${duty.duty_date}T00:00:00Z`) - Date.parse(`${todayIso}T00:00:00Z`)) /
        86_400_000,
    );

    return [
      '📅 Ближайшее дежурство',
      '',
      `Дата: ${messages.longDate(duty.duty_date)}`,
      `День: ${messages.weekdayName(duty.duty_date)}`,
      `Время: ${time}`,
      '',
      `🏢 Этаж: ${duty.floor_number_snapshot ?? student.floorNumber}`,
      `🚪 Комната: ${duty.room_number_snapshot ?? student.roomNumber}`,
      '',
      `До дежурства: ${days} ${messages.plural(days, 'день', 'дня', 'дней')}`,
    ].join('\n');
  }

  /**
   * График самого студента за текущий месяц.
   * Полный график этажа студенту не показывается — это интерфейс админа.
   */
  private async mySchedule(student: StudentContext, today = new Date()): Promise<string> {
    const period = await this.visiblePeriod(student, today);
    if (!period) {
      const currentMonth = today.getUTCMonth() + 1;
      return [
        '📋 Мой график',
        `${monthName(currentMonth)} ${today.getUTCFullYear()}`,
        '',
        'Опубликованного графика на этот месяц нет.',
      ].join('\n');
    }
    const { year, month } = period;

    const { rows } = await this.db.query<{
      duty_date: string;
      time_from: string;
      time_to: string;
      status: string;
    }>(
      `SELECT d.duty_date, d.time_from, d.time_to, d.status
         FROM duties d
         JOIN duty_schedules s ON s.id = d.schedule_id
        WHERE d.student_id = $1
          AND s.status = 'published'
          AND s.year = $2 AND s.month = $3
        ORDER BY d.duty_date, d.slot_order`,
      [student.studentId, year, month],
    );

    if (rows.length === 0) {
      return [
        '📋 Мой график',
        `${monthName(month)} ${year}`,
        '',
        'В этом месяце у вас нет дежурств.',
      ].join('\n');
    }

    const lines = rows.map((row) => {
      const [, m, d] = row.duty_date.split('-');
      const mark =
        row.status === 'completed'
          ? ' ✅'
          : row.status === 'missed'
            ? ' ⚠️'
            : row.status === 'cancelled'
              ? ' ✖️'
              : '';
      return `${d}.${m} · ${messages.timeRange(row.time_from, row.time_to)}${mark}`;
    });

    return ['📋 Мой график', `${monthName(month)} ${year}`, '', ...lines].join('\n');
  }

  /**
   * Какой месяц показывать студенту.
   *
   * Сначала текущий, если он опубликован. Иначе ближайший опубликованный
   * впереди: в конце августа студенту нужен сентябрьский график, а не
   * сообщение «на этот месяц ничего нет».
   *
   * Выборка ограничена этажом студента — чужие графики недосягаемы.
   */
  private async visiblePeriod(
    student: StudentContext,
    today: Date,
  ): Promise<{ year: number; month: number } | null> {
    const year = today.getUTCFullYear();
    const month = today.getUTCMonth() + 1;

    const { rows } = await this.db.query<{ year: number; month: number }>(
      `SELECT year, month
         FROM duty_schedules
        WHERE floor_id = $1
          AND status = 'published'
          AND (year * 12 + month) >= ($2::int * 12 + $3::int)
        ORDER BY year, month
        LIMIT 1`,
      [student.floorId, year, month],
    );
    return rows[0] ?? null;
  }

  private myInfo(student: StudentContext): string {
    const lines = [`👤 ${student.fullName}`, '', `🏢 ${student.floorNumber} этаж`];
    if (student.blockCode) lines.push(`🧩 Блок ${student.blockCode}`);
    lines.push(`🚪 ${student.roomNumber}`);
    if (student.facultyCode) lines.push(`🏫 ${student.facultyCode}`);
    if (student.course !== null) lines.push(`📚 ${student.course} курс`);
    if (student.groupCode) {
      lines.push(`👥 Группа ${student.course ?? ''}-${student.groupCode}`.replace(' -', ' '));
    }
    if (student.studyShiftCode) lines.push(`🔄 ${student.studyShiftCode} смена`);
    return lines.join('\n');
  }
}
