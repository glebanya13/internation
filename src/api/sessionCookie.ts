import type { IncomingMessage } from 'node:http';
import { config } from '../config.js';
import { SESSION_COOKIE } from './http.js';

const SESSION_MAX_AGE = 14 * 86_400;

/** Определяет, нужен ли флаг Secure для cookie сессии. */
export function isSecureRequest(req: IncomingMessage): boolean {
  if (config.secureCookies) return true;
  const proto = req.headers['x-forwarded-proto'];
  if (typeof proto === 'string' && proto.split(',')[0]!.trim() === 'https') return true;
  return false;
}

export function sessionCookieHeader(
  req: IncomingMessage,
  token: string,
  maxAge = SESSION_MAX_AGE,
): string {
  const secure = isSecureRequest(req) ? '; Secure' : '';
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}

export function clearSessionCookieHeader(req: IncomingMessage): string {
  const secure = isSecureRequest(req) ? '; Secure' : '';
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`;
}
