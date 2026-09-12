import { AuthError } from './authService.js';

/**
 * Защита от перебора пароля на входе.
 * In-memory: для одного VPS с одним процессом API этого достаточно.
 */
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60_000;

interface Entry {
  count: number;
  resetAt: number;
}

const attempts = new Map<string, Entry>();

function keyFor(email: string, ip: string): string {
  return `${email.toLowerCase().trim()}|${ip}`;
}

export function clientIp(req: { headers: Record<string, string | string[] | undefined> }): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0]!.trim();
  }
  return 'unknown';
}

export function assertLoginAllowed(email: string, ip: string): void {
  const entry = attempts.get(keyFor(email, ip));
  if (!entry) return;
  if (Date.now() > entry.resetAt) {
    attempts.delete(keyFor(email, ip));
    return;
  }
  if (entry.count >= MAX_ATTEMPTS) {
    throw new AuthError('Слишком много попыток входа. Повторите через 15 минут.');
  }
}

export function recordLoginFailure(email: string, ip: string): void {
  const key = keyFor(email, ip);
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || now > entry.resetAt) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return;
  }
  entry.count += 1;
}

export function clearLoginFailures(email: string, ip: string): void {
  attempts.delete(keyFor(email, ip));
}

/** Сброс состояния — только для тестов. */
export function resetLoginRateLimit(): void {
  attempts.clear();
}
