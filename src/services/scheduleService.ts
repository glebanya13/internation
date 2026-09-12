import type pg from 'pg';
import { withTransaction } from '../db/pool.js';
import { type ScheduleSlot, type SlotTemplate, expandMonth, monthName } from '../domain/calendar.js';
import { type Candidate, type DutyRules, parseRules } from '../domain/duty.js';
import { type FeasibilityReport, checkFeasibility } from '../domain/feasibility.js';
import { type GenerationResult, generateSchedule } from '../domain/scheduleGenerator.js';
import { currentVersion, entriesOf } from './rosterService.js';

export class ScheduleError extends Error {}
export class InfeasibleScheduleError extends ScheduleError {
  constructor(readonly report: FeasibilityReport) {
    super(report.reasons.join(' '));
  }
}

export interface ScheduleContext {
  floorId: string;
  floorNumber: number;
  dormitoryNumber: string;
  year: number;
  month: number;
  rosterVersionId: string;
  rosterSize: number;
  template: SlotTemplate;
  slots: ScheduleSlot[];
  candidates: Candidate[];
  rules: DutyRules;
}

/**
 * Собирает всё, что нужно для генерации: календарь, шаблон, правила
 * и кандидатов.
 *
 * Кандидаты берутся ИСКЛЮЧИТЕЛЬНО из текущей подтверждённой версии состава
 * выбранного этажа. Никакого запасного пути «на этаже некому — возьмём
 * с соседнего» не существует и существовать не может.
 */
export async function loadContext(
  db: pg.Pool | pg.PoolClient,
  options: { floorId: string; year: number; month: number; ruleOverrides?: Partial<DutyRules> },
): Promise<ScheduleContext> {
  const { floorId, year, month } = options;

  const { rows: floorRows } = await db.query<{
    number: number;
    dormitory_number: string;
    slot_template_id: string;
    template_name: string;
    settings: unknown;
  }>(
    `SELECT f.number, d.number AS dormitory_number, f.slot_template_id,
            t.name AS template_name, rs.settings
       FROM floors f
       JOIN dormitories d        ON d.id = f.dormitory_id
       JOIN duty_slot_templates t ON t.id = f.slot_template_id
       JOIN duty_rule_sets rs     ON rs.id = f.rule_set_id
      WHERE f.id = $1`,
    [floorId],
  );
  const floor = floorRows[0];
  if (!floor) throw new ScheduleError('Этаж не найден');

  const { rows: ruleRows } = await db.query<{
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

  const rules = { ...parseRules(floor.settings), ...options.ruleOverrides };
  const slots = expandMonth(template, year, month, { excludedDates: rules.excludedDates });

  const version = await currentVersion(db, floorId);
  if (!version) {
    throw new ScheduleError(
      'Состав этажа не подтверждён. Откройте список этажа и подтвердите состав.',
    );
  }
  const entries = await entriesOf(db, version.id);

  const previousLoad = await loadPreviousMonth(db, floorId, year, month);
  const shiftIds = new Set<string>();
  const { rows: shiftRows } = await db.query<{
    id: string;
    code: string;
    busy_from: string | null;
    busy_to: string | null;
    busy_weekdays: number[];
  }>('SELECT id, code, busy_from, busy_to, busy_weekdays FROM study_shifts');
  const shiftsByCode = new Map(shiftRows.map((s) => [s.code, s]));

  const { rows: studentRows } = await db.query<{
    id: string;
    study_shift_id: string | null;
    allow_busy_slots: boolean;
    role: string;
  }>(
    `SELECT id, study_shift_id, allow_busy_slots, role FROM students WHERE floor_id = $1`,
    [floorId],
  );
  const studentMeta = new Map(studentRows.map((s) => [s.id, s]));

  const candidates: Candidate[] = entries
    .filter((entry) => entry.student_status_snapshot === 'active')
    .filter((entry) => {
      if (!rules.elderExempt) return true;
      return studentMeta.get(entry.student_id)?.role !== 'elder';
    })
    .map((entry) => {
      const meta = studentMeta.get(entry.student_id);
      const shift = entry.study_shift_code_snapshot
        ? shiftsByCode.get(entry.study_shift_code_snapshot)
        : undefined;
      if (shift) shiftIds.add(shift.id);

      return {
        studentId: entry.student_id,
        floorId,
        displayName: entry.full_name_snapshot,
        roomNumber: entry.room_number_snapshot,
        studyShift: shift
          ? {
              id: shift.id,
              code: shift.code,
              busyFrom: shift.busy_from ? shift.busy_from.slice(0, 5) : null,
              busyTo: shift.busy_to ? shift.busy_to.slice(0, 5) : null,
              busyWeekdays: shift.busy_weekdays,
            }
          : null,
        allowBusySlots: meta?.allow_busy_slots ?? false,
        previousLoad: previousLoad.get(entry.student_id) ?? 0,
      };
    })
    // Устойчивый порядок кандидатов — часть воспроизводимости результата.
    .sort((a, b) => (a.studentId < b.studentId ? -1 : a.studentId > b.studentId ? 1 : 0));

  return {
    floorId,
    floorNumber: floor.number,
    dormitoryNumber: floor.dormitory_number,
    year,
    month,
    rosterVersionId: version.id,
    rosterSize: entries.length,
    template,
    slots,
    candidates,
    rules,
  };
}

async function loadPreviousMonth(
  db: pg.Pool | pg.PoolClient,
  floorId: string,
  year: number,
  month: number,
): Promise<Map<string, number>> {
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? year - 1 : year;

  const { rows } = await db.query<{ student_id: string; load: string }>(
    `SELECT d.student_id, count(*)::text AS load
       FROM duties d
       JOIN duty_schedules s ON s.id = d.schedule_id
      WHERE s.floor_id = $1 AND s.year = $2 AND s.month = $3
        AND d.student_id IS NOT NULL
      GROUP BY d.student_id`,
    [floorId, prevYear, prevMonth],
  );
  return new Map(rows.map((r) => [r.student_id, Number(r.load)]));
}

/** Отчёт о выполнимости. Ничего не создаёт и не изменяет. */
export async function feasibility(
  db: pg.Pool | pg.PoolClient,
  options: { floorId: string; year: number; month: number; ruleOverrides?: Partial<DutyRules> },
): Promise<FeasibilityReport & { context: ScheduleContext }> {
  const context = await loadContext(db, options);
  const report = checkFeasibility({
    slots: context.slots,
    candidates: context.candidates,
    rules: context.rules,
    rosterSize: context.rosterSize,
  });
  return { ...report, context };
}

export interface GenerateResult {
  scheduleId: string;
  attemptNo: number;
  status: string;
  generation: GenerationResult;
  feasibility: FeasibilityReport;
}

/**
 * Создаёт или перегенерирует ЧЕРНОВИК.
 *
 * Опубликованный график не трогается никогда: перегенерация поверх него
 * отклоняется, а не переписывает подписанный документ.
 */
export async function generate(
  pool: pg.Pool,
  options: {
    floorId: string;
    year: number;
    month: number;
    ruleOverrides?: Partial<DutyRules>;
    createdBy?: string;
  },
): Promise<GenerateResult> {
  return withTransaction(pool, async (client) => {
    const context = await loadContext(client, options);

    const report = checkFeasibility({
      slots: context.slots,
      candidates: context.candidates,
      rules: context.rules,
      rosterSize: context.rosterSize,
    });
    if (!report.feasible) throw new InfeasibleScheduleError(report);

    // Seed выводится из входных данных, а не из времени и не из случайности:
    // повторный запуск на том же составе и месяце даёт тот же результат.
    const seed = [
      context.floorId,
      context.year,
      context.month,
      context.rosterVersionId,
      context.template.id,
    ].join(':');

    const generation = generateSchedule({
      slots: context.slots,
      candidates: context.candidates,
      rules: context.rules,
      seed,
    });

    const { rows: existing } = await client.query<{ id: string; status: string }>(
      'SELECT id, status FROM duty_schedules WHERE floor_id = $1 AND year = $2 AND month = $3',
      [context.floorId, context.year, context.month],
    );

    if (existing[0] && existing[0].status !== 'draft') {
      throw new ScheduleError(
        `График ${monthName(context.month)} ${context.year} уже опубликован. ` +
          'Опубликованный график не перегенерируется.',
      );
    }

    const snapshots = {
      template: JSON.stringify(context.template),
      rules: JSON.stringify(context.rules),
      dormitory: JSON.stringify({
        dormitory_number: context.dormitoryNumber,
        floor_number: context.floorNumber,
      }),
    };

    let scheduleId: string;
    if (existing[0]) {
      scheduleId = existing[0].id;
      await client.query(
        `UPDATE duty_schedules
            SET roster_version_id = $2, slot_template_snapshot = $3,
                rule_set_snapshot = $4, dormitory_snapshot = $5,
                validation_warnings = $6, updated_at = now()
          WHERE id = $1`,
        [
          scheduleId,
          context.rosterVersionId,
          snapshots.template,
          snapshots.rules,
          snapshots.dormitory,
          JSON.stringify(generation.warnings),
        ],
      );
      await client.query('DELETE FROM duties WHERE schedule_id = $1', [scheduleId]);
    } else {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO duty_schedules
           (floor_id, year, month, status, roster_version_id, slot_template_snapshot,
            rule_set_snapshot, dormitory_snapshot, generated_by, validation_warnings)
         VALUES ($1,$2,$3,'draft',$4,$5,$6,$7,'algorithm',$8)
         RETURNING id`,
        [
          context.floorId,
          context.year,
          context.month,
          context.rosterVersionId,
          snapshots.template,
          snapshots.rules,
          snapshots.dormitory,
          JSON.stringify(generation.warnings),
        ],
      );
      scheduleId = rows[0]!.id;
    }

    const byId = new Map(context.candidates.map((c) => [c.studentId, c]));
    for (const assignment of generation.assignments) {
      const candidate = assignment.studentId ? byId.get(assignment.studentId) : null;
      await client.query(
        `INSERT INTO duties
           (schedule_id, duty_date, slot_order, time_from, time_to, student_id,
            student_name_snapshot, room_number_snapshot, floor_number_snapshot)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          scheduleId,
          assignment.date,
          assignment.slotOrder,
          assignment.timeFrom,
          assignment.timeTo,
          candidate?.studentId ?? null,
          candidate?.displayName ?? null,
          candidate?.roomNumber ?? null,
          candidate ? context.floorNumber : null,
        ],
      );
    }

    // История генераций: предыдущий прогон не уничтожается.
    const { rows: attempts } = await client.query<{ max: number | null }>(
      'SELECT max(attempt_no) AS max FROM duty_generations WHERE schedule_id = $1',
      [scheduleId],
    );
    const attemptNo = (attempts[0]?.max ?? 0) + 1;

    await client.query(
      'UPDATE duty_generations SET is_current = false WHERE schedule_id = $1 AND is_current',
      [scheduleId],
    );
    await client.query(
      `INSERT INTO duty_generations
         (schedule_id, attempt_no, algorithm, seed, rule_set_snapshot, roster_version_id,
          assignments, stats, warnings, relaxations, is_current, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,$11)`,
      [
        scheduleId,
        attemptNo,
        generation.algorithm,
        generation.seed,
        snapshots.rules,
        context.rosterVersionId,
        JSON.stringify(generation.assignments),
        JSON.stringify(generation.stats),
        JSON.stringify(generation.warnings),
        JSON.stringify(generation.relaxations),
        options.createdBy ?? null,
      ],
    );

    return { scheduleId, attemptNo, status: 'draft', generation, feasibility: report };
  });
}

export interface PublishPreview {
  floorNumber: number;
  dormitoryNumber: string;
  year: number;
  month: number;
  monthName: string;
  students: number;
  duties: number;
  unassigned: number;
  rosterVersionNo: number;
  /** Состав изменился после генерации — публиковать такой график опасно. */
  rosterDrifted: boolean;
  driftMessage: string | null;
  blockers: string[];
}

/**
 * Данные для подтверждения перед публикацией: этаж, месяц, сколько
 * студентов и сколько дежурств. Ничего не изменяет.
 */
export async function publishPreview(
  db: pg.Pool | pg.PoolClient,
  scheduleId: string,
): Promise<PublishPreview> {
  const { rows } = await db.query<{
    year: number;
    month: number;
    status: string;
    floor_number: number;
    dormitory_number: string;
    roster_version_no: number;
    students: string;
    duties: string;
    unassigned: string;
  }>(
    `SELECT s.year, s.month, s.status,
            f.number AS floor_number,
            d.number AS dormitory_number,
            rv.version_no AS roster_version_no,
            (SELECT count(DISTINCT student_id)::text FROM duties
              WHERE schedule_id = s.id AND student_id IS NOT NULL) AS students,
            (SELECT count(*)::text FROM duties WHERE schedule_id = s.id) AS duties,
            (SELECT count(*)::text FROM duties
              WHERE schedule_id = s.id AND student_id IS NULL) AS unassigned
       FROM duty_schedules s
       JOIN floors f          ON f.id = s.floor_id
       JOIN dormitories d     ON d.id = f.dormitory_id
       JOIN roster_versions rv ON rv.id = s.roster_version_id
      WHERE s.id = $1`,
    [scheduleId],
  );
  const schedule = rows[0];
  if (!schedule) throw new ScheduleError('График не найден');

  const drift = await rosterDrift(db, scheduleId);
  const blockers: string[] = [];
  if (schedule.status !== 'draft') blockers.push('График уже опубликован.');
  if (Number(schedule.unassigned) > 0) {
    blockers.push(`Не закрыто дежурств: ${schedule.unassigned}.`);
  }
  if (drift.drifted) {
    blockers.push(
      `Состав этажа изменился после генерации (версия ${schedule.roster_version_no} устарела). ` +
        'Сгенерируйте заново или подтвердите публикацию по прежнему составу.',
    );
  }

  return {
    floorNumber: schedule.floor_number,
    dormitoryNumber: schedule.dormitory_number,
    year: schedule.year,
    month: schedule.month,
    monthName: monthName(schedule.month),
    students: Number(schedule.students),
    duties: Number(schedule.duties),
    unassigned: Number(schedule.unassigned),
    rosterVersionNo: schedule.roster_version_no,
    rosterDrifted: drift.drifted,
    driftMessage: drift.message,
    blockers,
  };
}

/**
 * Публикация. После неё назначения запираются триггером БД: изменение
 * состава не может переписать подписанный документ.
 *
 * Публикация графика, построенного по УСТАРЕВШЕМУ составу, требует
 * явного подтверждения: случайно опубликовать список, где половина
 * студентов уже выселена, не получится.
 */
export async function publish(
  pool: pg.Pool,
  scheduleId: string,
  publishedBy?: string,
  options: { acknowledgeRosterDrift?: boolean } = {},
): Promise<void> {
  const drift = await rosterDrift(pool, scheduleId);
  if (drift.drifted && !options.acknowledgeRosterDrift) {
    throw new ScheduleError(
      'Состав этажа изменился после генерации графика. ' +
        'Сгенерируйте заново или подтвердите публикацию по прежнему составу.',
    );
  }

  await withTransaction(pool, async (client) => {
    const { rows } = await client.query<{ status: string; floor_id: string }>(
      'SELECT status, floor_id FROM duty_schedules WHERE id = $1',
      [scheduleId],
    );
    const schedule = rows[0];
    if (!schedule) throw new ScheduleError('График не найден');
    if (schedule.status !== 'draft') throw new ScheduleError('График уже опубликован');

    const { rows: unassigned } = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM duties
        WHERE schedule_id = $1 AND student_id IS NULL`,
      [scheduleId],
    );
    if (Number(unassigned[0]!.count) > 0) {
      throw new ScheduleError(
        `Нельзя опубликовать график с незакрытыми слотами: ${unassigned[0]!.count}.`,
      );
    }

    const { rows: approval } = await client.query<{
      warden_name: string | null;
      curator_name: string | null;
      council_head_name: string | null;
    }>(
      `SELECT d.warden_name, d.curator_name, d.council_head_name
         FROM duty_schedules s
         JOIN floors f      ON f.id = s.floor_id
         JOIN dormitories d ON d.id = f.dormitory_id
        WHERE s.id = $1`,
      [scheduleId],
    );

    await client.query(
      `UPDATE duty_schedules
          SET status = 'published', published_at = now(), published_by = $2,
              approval_snapshot = $3, updated_at = now()
        WHERE id = $1`,
      [scheduleId, publishedBy ?? null, JSON.stringify(approval[0] ?? {})],
    );
  });
}

/**
 * Изменился ли состав этажа после создания графика.
 * Для опубликованного — только предупреждение: документ сохраняется как есть.
 */
export async function rosterDrift(
  db: pg.Pool | pg.PoolClient,
  scheduleId: string,
): Promise<{ drifted: boolean; message: string | null }> {
  const { rows } = await db.query<{
    status: string;
    roster_version_id: string;
    floor_id: string;
    current_version: string | null;
  }>(
    `SELECT s.status, s.roster_version_id, s.floor_id,
            (SELECT id FROM roster_versions
              WHERE floor_id = s.floor_id AND status = 'confirmed') AS current_version
       FROM duty_schedules s WHERE s.id = $1`,
    [scheduleId],
  );
  const schedule = rows[0];
  if (!schedule) throw new ScheduleError('График не найден');

  if (schedule.current_version === schedule.roster_version_id) {
    return { drifted: false, message: null };
  }

  return {
    drifted: true,
    message:
      schedule.status === 'published'
        ? 'Состав этажа изменился после создания графика. ' +
          'Опубликованный график сохранён. Рекомендуется создать новый график.'
        : 'Состав этажа изменился после генерации. Рекомендуется сгенерировать заново.',
  };
}

export async function generationHistory(
  db: pg.Pool | pg.PoolClient,
  scheduleId: string,
): Promise<
  Array<{
    attemptNo: number;
    algorithm: string;
    seed: string;
    isCurrent: boolean;
    stats: unknown;
    createdAt: string;
  }>
> {
  const { rows } = await db.query<{
    attempt_no: number;
    algorithm: string;
    seed: string;
    is_current: boolean;
    stats: unknown;
    created_at: string;
  }>(
    `SELECT attempt_no, algorithm, seed, is_current, stats, created_at
       FROM duty_generations WHERE schedule_id = $1 ORDER BY attempt_no DESC`,
    [scheduleId],
  );
  return rows.map((r) => ({
    attemptNo: r.attempt_no,
    algorithm: r.algorithm,
    seed: r.seed,
    isCurrent: r.is_current,
    stats: r.stats,
    createdAt: r.created_at,
  }));
}
