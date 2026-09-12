import type pg from 'pg';
import { withTransaction } from '../db/pool.js';
import {
  type ExistingStudent,
  type ImportDecisions,
  type ImportDiff,
  type ImportSummary,
  type ParsedSource,
  buildDiff,
  diffChangesComposition,
  matchRows,
  normalizeRoom,
  pendingDecisions,
  summarize,
} from '../domain/import.js';
import { materializeVersion } from './rosterService.js';
import type { ImportInput, ImportSource } from './import/ImportSource.js';

export class ImportError extends Error {}

export interface ImportPreview {
  importId: string;
  floorId: string;
  floorNumber: number;
  fileName: string;
  summary: ImportSummary;
  diff: ImportDiff;
  recognizedColumns: ParsedSource['recognizedColumns'];
  unmappedColumns: string[];
  /** Решения, без которых Apply не запустится. */
  blocking: string[];
}

export interface ApplyResult {
  importId: string;
  rosterVersionCreated: boolean;
  rosterVersionId: string;
  versionNo: number;
  /** Понятная администратору формулировка результата. */
  message: string;
  applied: {
    added: number;
    relocated: number;
    attributesUpdated: number;
    deactivated: number;
    skipped: number;
  };
}

async function readExisting(
  db: pg.Pool | pg.PoolClient,
  floorId: string,
): Promise<ExistingStudent[]> {
  const { rows } = await db.query<ExistingStudent>(
    `SELECT s.id            AS "studentId",
            s.last_name     AS "lastName",
            s.first_name    AS "firstName",
            s.middle_name   AS "middleName",
            s.room_id       AS "roomId",
            r.number        AS "roomNumber",
            b.code          AS "blockCode",
            f.code          AS "facultyCode",
            sh.code         AS "studyShiftCode",
            s.course,
            s.group_code    AS "groupCode",
            s.telegram_id   AS "telegramId",
            s.status
       FROM students s
       JOIN rooms r ON r.id = s.room_id
       LEFT JOIN blocks b        ON b.id  = r.block_id
       LEFT JOIN faculties f     ON f.id  = s.faculty_id
       LEFT JOIN study_shifts sh ON sh.id = s.study_shift_id
      WHERE s.floor_id = $1
        AND s.status <> 'moved_out'
      ORDER BY r.sort_order, r.number, s.sort_order`,
    [floorId],
  );
  return rows;
}

async function floorNumberOf(db: pg.Pool | pg.PoolClient, floorId: string): Promise<number> {
  const { rows } = await db.query<{ number: number }>(
    'SELECT number FROM floors WHERE id = $1',
    [floorId],
  );
  const floor = rows[0];
  if (!floor) throw new ImportError('Этаж не найден');
  return floor.number;
}

/**
 * Шаг 1 и 2: Parse → Normalize → Diff.
 *
 * НИЧЕГО не записывает в students и не трогает текущий roster.
 * Результат сохраняется в roster_imports со статусом pending и живёт там,
 * пока администратор не подтвердит или не отклонит его.
 */
export async function preview(
  pool: pg.Pool,
  options: {
    floorId: string;
    source: ImportSource;
    input: ImportInput;
    decisions?: ImportDecisions;
    uploadedBy?: string;
  },
): Promise<ImportPreview> {
  const parsed = await options.source.parse(options.input);
  const floorNumber = await floorNumberOf(pool, options.floorId);
  const existing = await readExisting(pool, options.floorId);

  const matches = matchRows(parsed.rows, existing);
  const diff = buildDiff({
    matches,
    existing,
    targetFloorNumber: floorNumber,
    unparsed: parsed.unparsedRows,
  });

  const decisions = options.decisions ?? {};
  const summary = summarize(diff, existing.length, decisions);

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO roster_imports
       (floor_id, file_name, parsed_rows, diff, decisions, state, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, 'pending', $6)
     RETURNING id`,
    [
      options.floorId,
      options.input.fileName ?? `${options.source.kind}-импорт`,
      JSON.stringify(parsed.rows),
      JSON.stringify(diff),
      JSON.stringify(decisions),
      options.uploadedBy ?? null,
    ],
  );

  return {
    importId: rows[0]!.id,
    floorId: options.floorId,
    floorNumber,
    fileName: options.input.fileName ?? `${options.source.kind}-импорт`,
    summary,
    diff,
    recognizedColumns: parsed.recognizedColumns,
    unmappedColumns: parsed.unmappedColumns,
    blocking: pendingDecisions(diff, decisions),
  };
}

/** Пересчитывает превью с новыми решениями администратора, ничего не записывая. */
export async function withDecisions(
  pool: pg.Pool,
  importId: string,
  decisions: ImportDecisions,
): Promise<{ summary: ImportSummary; blocking: string[] }> {
  const state = await loadImport(pool, importId);
  await pool.query('UPDATE roster_imports SET decisions = $2 WHERE id = $1', [
    importId,
    JSON.stringify(decisions),
  ]);
  const existing = await readExisting(pool, state.floor_id);
  return {
    summary: summarize(state.diff, existing.length, decisions),
    blocking: pendingDecisions(state.diff, decisions),
  };
}

interface StoredImport {
  id: string;
  floor_id: string;
  state: string;
  diff: ImportDiff;
  decisions: ImportDecisions | null;
  parsed_rows: ParsedSource['rows'];
}

async function loadImport(
  db: pg.Pool | pg.PoolClient,
  importId: string,
): Promise<StoredImport> {
  const { rows } = await db.query<StoredImport>(
    'SELECT id, floor_id, state, diff, decisions, parsed_rows FROM roster_imports WHERE id = $1',
    [importId],
  );
  const found = rows[0];
  if (!found) throw new ImportError('Импорт не найден');
  return found;
}

/**
 * Шаг 3: Apply. Одна транзакция на всё.
 *
 * При любой ошибке откатывается целиком: students не обновятся частично,
 * версия roster не останется наполовину созданной, в audit_log не попадут
 * фиктивные записи.
 *
 * Новая версия состава создаётся, ТОЛЬКО если состав действительно изменился.
 * Повторная загрузка того же файла и правка одних лишь атрибутов версию
 * не создают.
 */
export async function apply(
  pool: pg.Pool,
  importId: string,
  options: { decisions?: ImportDecisions; appliedBy?: string } = {},
): Promise<ApplyResult> {
  return withTransaction(pool, async (client) => {
    const stored = await loadImport(client, importId);
    if (stored.state !== 'pending') {
      throw new ImportError(`Импорт уже обработан: ${stored.state}`);
    }

    const decisions = options.decisions ?? stored.decisions ?? {};
    const blocking = pendingDecisions(stored.diff, decisions);
    if (blocking.length > 0) {
      throw new ImportError(
        `Нельзя применить импорт, пока не приняты решения:\n${blocking.join('\n')}`,
      );
    }

    const floorId = stored.floor_id;
    const rowsByNumber = new Map(stored.parsed_rows.map((r) => [r.rowNumber, r]));
    const applied = { added: 0, relocated: 0, attributesUpdated: 0, deactivated: 0, skipped: 0 };

    const roomIdOf = async (roomNumber: string): Promise<string> => {
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM rooms
          WHERE floor_id = $1
            AND upper(regexp_replace(number, '\\s', '', 'g')) = $2`,
        [floorId, normalizeRoom(roomNumber)],
      );
      const room = rows[0];
      if (!room) {
        throw new ImportError(
          `Комната ${roomNumber} не найдена на этаже. Создайте её в структуре и повторите импорт.`,
        );
      }
      return room.id;
    };

    const lookupId = async (
      table: 'faculties' | 'study_shifts',
      code: string | null,
    ): Promise<string | null> => {
      if (!code) return null;
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM ${table} WHERE lower(code) = lower($1) ORDER BY is_active DESC LIMIT 1`,
        [code],
      );
      const found = rows[0];
      if (!found) {
        throw new ImportError(
          `Значение «${code}» отсутствует в справочнике. Добавьте его и повторите импорт.`,
        );
      }
      return found.id;
    };

    // ── Новые студенты ────────────────────────────────────────────────
    for (const added of stored.diff.added) {
      const row = rowsByNumber.get(added.rowNumber);
      if (!row) continue;
      await insertStudent(client, floorId, row, roomIdOf, lookupId);
      applied.added += 1;
    }

    // ── Переселения: изменение состава ────────────────────────────────
    for (const moved of stored.diff.relocated) {
      const row = rowsByNumber.get(moved.rowNumber);
      if (!row) continue;
      const roomId = await roomIdOf(moved.toRoom);
      await client.query(
        'UPDATE students SET room_id = $2, updated_at = now() WHERE id = $1',
        [moved.studentId, roomId],
      );
      await closeAndOpenPlacement(client, moved.studentId, roomId);
      if (moved.attributes.length > 0) {
        await updateAttributes(client, moved.studentId, row, lookupId);
      }
      await audit(client, 'import.relocate', moved.studentId, { room: moved.fromRoom }, {
        room: moved.toRoom,
      }, options.appliedBy);
      applied.relocated += 1;
    }

    // ── Только атрибуты: версию состава НЕ создаёт ────────────────────
    for (const changed of stored.diff.attributesOnly) {
      const row = rowsByNumber.get(changed.rowNumber);
      if (!row) continue;
      await updateAttributes(client, changed.studentId, row, lookupId);
      await audit(
        client,
        'import.update_attributes',
        changed.studentId,
        Object.fromEntries(changed.attributes.map((a) => [a.field, a.before])),
        Object.fromEntries(changed.attributes.map((a) => [a.field, a.after])),
        options.appliedBy,
      );
      applied.attributesUpdated += 1;
    }

    // ── Исчезнувшие: только по явному решению администратора ──────────
    for (const removed of stored.diff.removed) {
      const decision = decisions.removed?.[removed.studentId];
      if (decision !== 'deactivate') {
        applied.skipped += 1;
        continue;
      }
      await client.query(
        `UPDATE students
            SET status = 'moved_out', left_at = current_date, updated_at = now()
          WHERE id = $1`,
        [removed.studentId],
      );
      await client.query(
        `UPDATE student_placements SET valid_to = current_date
          WHERE student_id = $1 AND valid_to IS NULL`,
        [removed.studentId],
      );
      await audit(client, 'import.deactivate', removed.studentId, { status: 'active' }, {
        status: 'moved_out',
      }, options.appliedBy);
      applied.deactivated += 1;
    }

    // ── Неоднозначные ─────────────────────────────────────────────────
    for (const ambiguous of stored.diff.ambiguous) {
      const decision = decisions.ambiguous?.[ambiguous.rowNumber];
      const row = rowsByNumber.get(ambiguous.rowNumber);
      if (!row || !decision || decision === 'skip') {
        applied.skipped += 1;
        continue;
      }
      if (decision === 'create_new') {
        await insertStudent(client, floorId, row, roomIdOf, lookupId);
        applied.added += 1;
        continue;
      }
      // Администратор выбрал конкретного студента.
      const roomId = await roomIdOf(row.roomNumber!);
      const { rows: current } = await client.query<{ room_id: string }>(
        'SELECT room_id FROM students WHERE id = $1',
        [decision],
      );
      if (current[0] && current[0].room_id !== roomId) {
        await client.query('UPDATE students SET room_id = $2 WHERE id = $1', [decision, roomId]);
        await closeAndOpenPlacement(client, decision, roomId);
        applied.relocated += 1;
      }
      await updateAttributes(client, decision, row, lookupId);
      await audit(client, 'import.resolve_ambiguous', decision, null, { row: row.rowNumber },
        options.appliedBy);
    }

    // Строки чужого этажа не применяются никогда — этаж не исправляется
    // автоматически, решение остаётся за администратором.
    applied.skipped += stored.diff.foreignFloor.length;

    // ── Версия состава ────────────────────────────────────────────────
    const compositionChanged = diffChangesComposition(stored.diff, decisions);
    const result = await materializeVersion(client, floorId, {
      source: 'import',
      note: `Импорт: ${stored.diff.added.length} новых, ${stored.diff.relocated.length} переселений`,
      confirmedBy: options.appliedBy ?? null,
    });

    await client.query(
      `UPDATE roster_imports
          SET state = 'applied', decisions = $2, applied_by = $3, applied_at = now(),
              created_roster_version_id = $4
        WHERE id = $1`,
      [
        importId,
        JSON.stringify(decisions),
        options.appliedBy ?? null,
        result.created ? result.version.id : null,
      ],
    );
    await audit(
      client,
      'roster.import_applied',
      importId,
      null,
      { composition_changed: compositionChanged, version_created: result.created, applied },
      options.appliedBy,
      'roster_imports',
    );

    return {
      importId,
      rosterVersionCreated: result.created,
      rosterVersionId: result.version.id,
      versionNo: result.version.version_no,
      message: result.created
        ? `Создана версия состава №${result.version.version_no}.`
        : 'Изменений состава нет. Новая версия не требуется.',
      applied,
    };
  });
}

export async function reject(pool: pg.Pool, importId: string, by?: string): Promise<void> {
  const { rowCount } = await pool.query(
    `UPDATE roster_imports SET state = 'rejected', applied_by = $2, applied_at = now()
      WHERE id = $1 AND state = 'pending'`,
    [importId, by ?? null],
  );
  if (rowCount === 0) throw new ImportError('Импорт не найден или уже обработан');
}

// ───────────────────────────── вспомогательное ─────────────────────────────

type RoomLookup = (roomNumber: string) => Promise<string>;
type CodeLookup = (
  table: 'faculties' | 'study_shifts',
  code: string | null,
) => Promise<string | null>;

async function insertStudent(
  client: pg.PoolClient,
  floorId: string,
  row: ParsedSource['rows'][number],
  roomIdOf: RoomLookup,
  lookupId: CodeLookup,
): Promise<void> {
  const roomId = await roomIdOf(row.roomNumber!);
  const facultyId = await lookupId('faculties', row.facultyCode);
  const shiftId = await lookupId('study_shifts', row.studyShiftCode);

  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO students
       (floor_id, room_id, last_name, first_name, middle_name, faculty_id,
        study_shift_id, course, group_code, telegram_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id`,
    [
      floorId,
      roomId,
      row.lastName,
      row.firstName,
      row.middleName,
      facultyId,
      shiftId,
      row.course,
      row.groupCode,
      row.telegramId,
    ],
  );
  const studentId = rows[0]!.id;
  await client.query(
    `INSERT INTO student_placements
       (student_id, floor_id, block_id, room_id,
        room_number_snapshot, block_code_snapshot, floor_number_snapshot, valid_from)
     SELECT $1, r.floor_id, r.block_id, r.id, r.number, b.code, fl.number, current_date
       FROM rooms r
       JOIN floors fl ON fl.id = r.floor_id
       LEFT JOIN blocks b ON b.id = r.block_id
      WHERE r.id = $2`,
    [studentId, roomId],
  );
}

async function updateAttributes(
  client: pg.PoolClient,
  studentId: string,
  row: ParsedSource['rows'][number],
  lookupId: CodeLookup,
): Promise<void> {
  const facultyId = await lookupId('faculties', row.facultyCode);
  const shiftId = await lookupId('study_shifts', row.studyShiftCode);

  await client.query(
    `UPDATE students
        SET last_name      = COALESCE($2, last_name),
            first_name     = COALESCE($3, first_name),
            middle_name    = COALESCE($4, middle_name),
            faculty_id     = COALESCE($5, faculty_id),
            study_shift_id = COALESCE($6, study_shift_id),
            course         = COALESCE($7, course),
            group_code     = COALESCE($8, group_code),
            updated_at     = now()
      WHERE id = $1`,
    [
      studentId,
      row.lastName,
      row.firstName,
      row.middleName,
      facultyId,
      shiftId,
      row.course,
      row.groupCode,
    ],
  );
}

async function closeAndOpenPlacement(
  client: pg.PoolClient,
  studentId: string,
  roomId: string,
): Promise<void> {
  await client.query(
    `UPDATE student_placements SET valid_to = current_date - 1
      WHERE student_id = $1 AND valid_to IS NULL AND valid_from < current_date`,
    [studentId],
  );
  await client.query(
    `DELETE FROM student_placements
      WHERE student_id = $1 AND valid_to IS NULL AND valid_from >= current_date`,
    [studentId],
  );
  await client.query(
    `INSERT INTO student_placements
       (student_id, floor_id, block_id, room_id,
        room_number_snapshot, block_code_snapshot, floor_number_snapshot, valid_from)
     SELECT $1, r.floor_id, r.block_id, r.id, r.number, b.code, fl.number, current_date
       FROM rooms r
       JOIN floors fl ON fl.id = r.floor_id
       LEFT JOIN blocks b ON b.id = r.block_id
      WHERE r.id = $2`,
    [studentId, roomId],
  );
}

async function audit(
  client: pg.PoolClient,
  action: string,
  entityId: string,
  before: unknown,
  after: unknown,
  actorId?: string,
  entity = 'students',
): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (actor_type, actor_id, action, entity, entity_id, before, after)
     VALUES ('admin', $1, $2, $6, $3, $4, $5)`,
    [
      actorId ?? null,
      action,
      entityId,
      before === null || before === undefined ? null : JSON.stringify(before),
      after === null || after === undefined ? null : JSON.stringify(after),
      entity,
    ],
  );
}
