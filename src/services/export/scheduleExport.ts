import type pg from 'pg';
import { expandMonth, type SlotTemplate } from '../../domain/calendar.js';
import { parseRules } from '../../domain/duty.js';
import { renderScheduleHtml } from './scheduleHtml.js';
import { renderScheduleXlsx } from './scheduleXlsx.js';
import { type ScheduleDocument, buildScheduleDocument } from './scheduleDocument.js';
import { findBrowser, renderHtmlToPdf } from './pdfRenderer.js';

export { buildScheduleDocument, type ScheduleDocument } from './scheduleDocument.js';
export { renderScheduleHtml } from './scheduleHtml.js';
export { renderScheduleXlsx } from './scheduleXlsx.js';

/**
 * Выдача графика во всех форматах из одного ScheduleDocument.
 * Отдельных запросов «для PDF» и «для веба» не существует.
 */
export class ScheduleExportService {
  constructor(private readonly db: pg.Pool | pg.PoolClient) {}

  /**
   * Пустой бланк на месяц: даты и смены из шаблона этажа, ФИО и комнаты пустые.
   * Не пишет в БД и не требует состава — для ручного заполнения.
   */
  async loadBlank(floorId: string, year: number, month: number): Promise<ScheduleDocument> {
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new Error('Некорректный год');
    }
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      throw new Error('Некорректный месяц');
    }

    const { rows: floorRows } = await this.db.query<{
      number: number;
      code: string | null;
      dormitory_number: string;
      slot_template_id: string;
      template_name: string;
      settings: unknown;
      warden_name: string | null;
      curator_name: string | null;
      council_head_name: string | null;
    }>(
      `SELECT f.number, f.code, d.number AS dormitory_number, f.slot_template_id,
              t.name AS template_name, rs.settings,
              d.warden_name, d.curator_name, d.council_head_name
         FROM floors f
         JOIN dormitories d         ON d.id = f.dormitory_id
         JOIN duty_slot_templates t ON t.id = f.slot_template_id
         JOIN duty_rule_sets rs     ON rs.id = f.rule_set_id
        WHERE f.id = $1`,
      [floorId],
    );
    const floor = floorRows[0];
    if (!floor) throw new Error('Этаж не найден');

    const { rows: ruleRows } = await this.db.query<{
      weekday: number;
      slot_order: number;
      time_from: string;
      time_to: string;
      label: string | null;
    }>(
      `SELECT weekday, slot_order, time_from, time_to, label
         FROM duty_slot_rules WHERE template_id = $1
        ORDER BY weekday, slot_order`,
      [floor.slot_template_id],
    );

    const template: SlotTemplate = {
      id: floor.slot_template_id,
      name: floor.template_name,
      rules: ruleRows.map((r) => ({
        weekday: r.weekday,
        slotOrder: r.slot_order,
        timeFrom: r.time_from.slice(0, 5),
        timeTo: r.time_to.slice(0, 5),
        label: r.label,
      })),
    };

    const rules = parseRules(floor.settings);
    const slots = expandMonth(template, year, month, { excludedDates: rules.excludedDates });
    if (slots.length === 0) {
      throw new Error('На этот месяц нет смен по шаблону этажа');
    }

    return buildScheduleDocument({
      floorNumber: floor.number,
      floorCode: floor.code,
      dormitoryNumber: floor.dormitory_number,
      year,
      month,
      status: 'blank',
      approval: {
        wardenName: floor.warden_name,
        curatorName: floor.curator_name,
        councilHeadName: floor.council_head_name,
      },
      duties: slots.map((slot) => ({
        date: slot.date,
        slotOrder: slot.slotOrder,
        timeFrom: slot.timeFrom,
        timeTo: slot.timeTo,
        studentName: null,
        roomNumber: null,
      })),
      changes: [],
    });
  }

  async blankHtml(floorId: string, year: number, month: number): Promise<string> {
    return renderScheduleHtml(await this.loadBlank(floorId, year, month));
  }

  async blankXlsx(floorId: string, year: number, month: number): Promise<Buffer> {
    return renderScheduleXlsx(await this.loadBlank(floorId, year, month));
  }

  async blankPdf(floorId: string, year: number, month: number): Promise<Buffer> {
    const doc = await this.loadBlank(floorId, year, month);
    return renderHtmlToPdf(renderScheduleHtml(doc));
  }

  async load(scheduleId: string): Promise<ScheduleDocument> {
    const { rows } = await this.db.query<{
      year: number;
      month: number;
      status: string;
      dormitory_snapshot: { dormitory_number: string; floor_number: number };
      approval_snapshot: {
        warden_name?: string | null;
        curator_name?: string | null;
        council_head_name?: string | null;
      } | null;
      floor_code: string | null;
      warden_name: string | null;
      curator_name: string | null;
      council_head_name: string | null;
    }>(
      `SELECT s.year, s.month, s.status, s.dormitory_snapshot, s.approval_snapshot,
              f.code AS floor_code,
              d.warden_name, d.curator_name, d.council_head_name
         FROM duty_schedules s
         JOIN floors f      ON f.id = s.floor_id
         JOIN dormitories d ON d.id = f.dormitory_id
        WHERE s.id = $1`,
      [scheduleId],
    );
    const schedule = rows[0];
    if (!schedule) throw new Error('График не найден');

    const { rows: duties } = await this.db.query<{
      duty_date: string;
      slot_order: number;
      time_from: string;
      time_to: string;
      student_name_snapshot: string | null;
      room_number_snapshot: string | null;
    }>(
      `SELECT duty_date, slot_order, time_from, time_to,
              student_name_snapshot, room_number_snapshot
         FROM duties WHERE schedule_id = $1 ORDER BY duty_date, slot_order`,
      [scheduleId],
    );

    const { rows: changes } = await this.db.query<{
      change_date: string;
      to_room_snapshot: string | null;
      to_name_snapshot: string | null;
      time_from: string | null;
      time_to: string | null;
    }>(
      `SELECT c.change_date, c.to_room_snapshot, c.to_name_snapshot, c.time_from, c.time_to
         FROM duty_changes c
         JOIN duties d ON d.id = c.duty_id
        WHERE d.schedule_id = $1
        ORDER BY c.changed_at`,
      [scheduleId],
    );

    // Опубликованный график печатает подписантов из своего снимка,
    // черновик — текущие реквизиты общежития.
    const snapshot = schedule.approval_snapshot ?? {};
    const approval =
      schedule.status === 'published'
        ? {
            wardenName: snapshot.warden_name ?? null,
            curatorName: snapshot.curator_name ?? null,
            councilHeadName: snapshot.council_head_name ?? null,
          }
        : {
            wardenName: schedule.warden_name,
            curatorName: schedule.curator_name,
            councilHeadName: schedule.council_head_name,
          };

    return buildScheduleDocument({
      floorNumber: schedule.dormitory_snapshot.floor_number,
      floorCode: schedule.floor_code,
      dormitoryNumber: schedule.dormitory_snapshot.dormitory_number,
      year: schedule.year,
      month: schedule.month,
      status: schedule.status,
      approval,
      duties: duties.map((d) => ({
        date: d.duty_date,
        slotOrder: d.slot_order,
        timeFrom: d.time_from.slice(0, 5),
        timeTo: d.time_to.slice(0, 5),
        studentName: d.student_name_snapshot,
        roomNumber: d.room_number_snapshot,
      })),
      changes: changes.map((c) => ({
        date: c.change_date,
        roomNumber: c.to_room_snapshot,
        time: c.time_from && c.time_to ? `${c.time_from.slice(0, 5)}-${c.time_to.slice(0, 5)}` : '',
        studentName: c.to_name_snapshot,
      })),
    });
  }

  async html(scheduleId: string): Promise<string> {
    return renderScheduleHtml(await this.load(scheduleId));
  }

  async xlsx(scheduleId: string): Promise<Buffer> {
    return renderScheduleXlsx(await this.load(scheduleId));
  }

  async pdf(scheduleId: string): Promise<Buffer> {
    const doc = await this.load(scheduleId);
    const html = renderScheduleHtml(doc);
    return renderHtmlToPdf(html);
  }

  async all(
    scheduleId: string,
  ): Promise<{ html: string; xlsx: Buffer; pdf: Buffer | null; fileBaseName: string }> {
    const doc = await this.load(scheduleId);
    const html = renderScheduleHtml(doc);
    let pdf: Buffer | null = null;
    if (await findBrowser()) {
      try {
        pdf = await renderHtmlToPdf(html);
      } catch {
        // PDF не обязателен: браузер найден, но рендер мог не пройти.
      }
    }
    return {
      html,
      xlsx: await renderScheduleXlsx(doc),
      pdf,
      fileBaseName: doc.fileBaseName,
    };
  }
}
