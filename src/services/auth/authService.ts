import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type pg from 'pg';
import {
  assertLoginAllowed,
  clearLoginFailures,
  recordLoginFailure,
} from './loginRateLimit.js';

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

/**
 * Аутентификация администратора и разграничение доступа.
 *
 * Пароли хэшируются scrypt из стандартной библиотеки: отдельной
 * зависимости для этого не нужно. Сессия — случайный токен, в базе
 * лежит только его хэш.
 */

export type AdminRole = 'superadmin' | 'dorm_admin' | 'floor_admin';

export interface Actor {
  adminId: string;
  email: string;
  fullName: string | null;
  role: AdminRole;
  dormitoryId: string | null;
  /**
   * Этажи, доступные администратору.
   * null означает «все» — для superadmin и dorm_admin в своём общежитии.
   */
  floorScope: string[] | null;
}

export class AuthError extends Error {}
export class ForbiddenError extends Error {}

const SESSION_DAYS = 14;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algorithm, saltHex, keyHex] = stored.split('$');
  if (algorithm !== 'scrypt' || !saltHex || !keyHex) return false;

  const key = await scrypt(password, Buffer.from(saltHex, 'hex'), 64);
  const expected = Buffer.from(keyHex, 'hex');
  return key.length === expected.length && timingSafeEqual(key, expected);
}

function hashToken(token: string): string {
  // Токен уже случайный: солить незачем, нужен лишь необратимый
  // отпечаток для поиска по индексу.
  return createHash('sha256').update(token).digest('hex');
}

export async function createAdmin(
  db: pg.Pool,
  input: {
    email: string;
    password: string;
    fullName?: string;
    role: AdminRole;
    dormitoryId?: string | null;
    floorIds?: string[];
  },
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO admin_users (email, password_hash, full_name, role, dormitory_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [
      input.email.toLowerCase().trim(),
      await hashPassword(input.password),
      input.fullName ?? null,
      input.role,
      input.dormitoryId ?? null,
    ],
  );
  const adminId = rows[0]!.id;

  for (const floorId of input.floorIds ?? []) {
    await db.query(
      'INSERT INTO admin_floor_scopes (admin_user_id, floor_id) VALUES ($1, $2)',
      [adminId, floorId],
    );
  }
  return adminId;
}

export async function login(
  db: pg.Pool,
  email: string,
  password: string,
  userAgent?: string,
  clientIp = 'unknown',
): Promise<{ token: string; actor: Actor }> {
  assertLoginAllowed(email, clientIp);

  const { rows } = await db.query<{
    id: string;
    password_hash: string;
    is_active: boolean;
  }>('SELECT id, password_hash, is_active FROM admin_users WHERE email = $1', [
    email.toLowerCase().trim(),
  ]);
  const user = rows[0];

  // Одинаковая ошибка для неверного адреса и неверного пароля:
  // подсказывать, какой из них правильный, незачем.
  if (!user || !user.is_active || !(await verifyPassword(password, user.password_hash))) {
    recordLoginFailure(email, clientIp);
    throw new AuthError('Неверный адрес или пароль');
  }

  clearLoginFailures(email, clientIp);

  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await db.query(
    `INSERT INTO admin_sessions (token_hash, admin_id, expires_at, user_agent)
     VALUES ($1, $2, $3, $4)`,
    [hashToken(token), user.id, expires, userAgent?.slice(0, 255) ?? null],
  );

  const actor = await actorById(db, user.id);
  if (!actor) throw new AuthError('Учётная запись недоступна');
  return { token, actor };
}

export async function logout(db: pg.Pool, token: string): Promise<void> {
  await db.query('DELETE FROM admin_sessions WHERE token_hash = $1', [hashToken(token)]);
}

export async function actorByToken(db: pg.Pool, token: string): Promise<Actor | null> {
  const { rows } = await db.query<{ admin_id: string }>(
    `SELECT admin_id FROM admin_sessions
      WHERE token_hash = $1 AND expires_at > now()`,
    [hashToken(token)],
  );
  const session = rows[0];
  if (!session) return null;

  await db.query('UPDATE admin_sessions SET last_seen = now() WHERE token_hash = $1', [
    hashToken(token),
  ]);
  return actorById(db, session.admin_id);
}

export async function actorById(db: pg.Pool, adminId: string): Promise<Actor | null> {
  const { rows } = await db.query<{
    id: string;
    email: string;
    full_name: string | null;
    role: AdminRole;
    dormitory_id: string | null;
    is_active: boolean;
  }>(
    `SELECT id, email, full_name, role, dormitory_id, is_active
       FROM admin_users WHERE id = $1`,
    [adminId],
  );
  const user = rows[0];
  if (!user || !user.is_active) return null;

  let floorScope: string[] | null = null;
  if (user.role === 'floor_admin') {
    const { rows: scopes } = await db.query<{ floor_id: string }>(
      'SELECT floor_id FROM admin_floor_scopes WHERE admin_user_id = $1',
      [adminId],
    );
    floorScope = scopes.map((s) => s.floor_id);
  }

  return {
    adminId: user.id,
    email: user.email,
    fullName: user.full_name,
    role: user.role,
    dormitoryId: user.dormitory_id,
    floorScope,
  };
}

/**
 * Этажи, доступные администратору. Единственный источник ограничения
 * видимости: любой запрос к студентам, составу и графикам проходит
 * через этот список.
 */
export async function resolveScope(db: pg.Pool, actor: Actor): Promise<string[]> {
  if (actor.role === 'superadmin') {
    const { rows } = await db.query<{ id: string }>('SELECT id FROM floors');
    return rows.map((r) => r.id);
  }
  if (actor.role === 'dorm_admin') {
    const { rows } = await db.query<{ id: string }>(
      'SELECT id FROM floors WHERE dormitory_id = $1',
      [actor.dormitoryId],
    );
    return rows.map((r) => r.id);
  }
  return actor.floorScope ?? [];
}

/**
 * Проверка доступа к конкретному этажу.
 *
 * Вызывается ДО любого обращения к данным этажа. Если администратор
 * работает с 6 этажом, идентификатор 7 этажа сюда просто не пройдёт.
 */
export async function assertFloorAccess(
  db: pg.Pool,
  actor: Actor,
  floorId: string,
): Promise<void> {
  const scope = await resolveScope(db, actor);
  if (!scope.includes(floorId)) {
    throw new ForbiddenError('Этаж недоступен для этой учётной записи');
  }
}

/** Проверка доступа к этажу, которому принадлежит объект. */
export async function assertScheduleAccess(
  db: pg.Pool,
  actor: Actor,
  scheduleId: string,
): Promise<string> {
  const { rows } = await db.query<{ floor_id: string }>(
    'SELECT floor_id FROM duty_schedules WHERE id = $1',
    [scheduleId],
  );
  const floorId = rows[0]?.floor_id;
  if (!floorId) throw new ForbiddenError('График не найден');
  await assertFloorAccess(db, actor, floorId);
  return floorId;
}

export async function assertDutyAccess(
  db: pg.Pool,
  actor: Actor,
  dutyId: string,
): Promise<string> {
  const { rows } = await db.query<{ floor_id: string }>(
    `SELECT s.floor_id FROM duties d
       JOIN duty_schedules s ON s.id = d.schedule_id
      WHERE d.id = $1`,
    [dutyId],
  );
  const floorId = rows[0]?.floor_id;
  if (!floorId) throw new ForbiddenError('Дежурство не найдено');
  await assertFloorAccess(db, actor, floorId);
  return floorId;
}

export async function assertStudentAccess(
  db: pg.Pool,
  actor: Actor,
  studentId: string,
): Promise<string> {
  const { rows } = await db.query<{ floor_id: string }>(
    'SELECT floor_id FROM students WHERE id = $1',
    [studentId],
  );
  const floorId = rows[0]?.floor_id;
  if (!floorId) throw new ForbiddenError('Студент не найден');
  await assertFloorAccess(db, actor, floorId);
  return floorId;
}

/** Настройки справочников меняет только администратор общежития и выше. */
export function assertCanManageSettings(actor: Actor): void {
  if (actor.role === 'floor_admin') {
    throw new ForbiddenError('Изменение справочников доступно администратору общежития');
  }
}
