import { IncomingMessage, ServerResponse } from 'node:http';
import type pg from 'pg';
import { type Actor, ForbiddenError, actorByToken } from '../services/auth/authService.js';

/**
 * Минимальный HTTP-слой. Фреймворк не берём: нужны маршрутизация,
 * разбор тела и cookie — три десятка строк, которые понятнее зависимости.
 */

export const SESSION_COOKIE = 'dorm_session';

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  db: pg.Pool;
  url: URL;
  params: Record<string, string>;
  query: URLSearchParams;
  actor: Actor | null;
  body: Record<string, unknown>;
}

export type Handler = (ctx: Ctx) => Promise<void>;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
  /** Требуется ли вход. Публичны только страница входа и статика. */
  auth: boolean;
}

export class Router {
  private readonly routes: Route[] = [];

  add(method: string, path: string, handler: Handler, options: { auth?: boolean } = {}): this {
    const keys: string[] = [];
    const pattern = new RegExp(
      `^${path.replace(/:[a-zA-Z]+/g, (match) => {
        keys.push(match.slice(1));
        return '([^/]+)';
      })}$`,
    );
    this.routes.push({ method, pattern, keys, handler, auth: options.auth ?? true });
    return this;
  }

  get(path: string, handler: Handler, options?: { auth?: boolean }): this {
    return this.add('GET', path, handler, options);
  }
  post(path: string, handler: Handler, options?: { auth?: boolean }): this {
    return this.add('POST', path, handler, options);
  }

  match(method: string, pathname: string): { route: Route; params: Record<string, string> } | null {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const match = route.pattern.exec(pathname);
      if (!match) continue;
      const params: Record<string, string> = {};
      route.keys.forEach((key, index) => {
        params[key] = decodeURIComponent(match[index + 1]!);
      });
      return { route, params };
    }
    return null;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name) result[name] = decodeURIComponent(rest.join('='));
  }
  return result;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // Импорт списков идёт отдельным путём; обычное тело не бывает большим.
    if (size > 25 * 1024 * 1024) throw new Error('Тело запроса слишком велико');
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};

  const type = req.headers['content-type'] ?? '';
  if (type.includes('application/json')) return JSON.parse(raw) as Record<string, unknown>;
  if (type.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  return { raw };
}

export function json(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

export function html(res: ServerResponse, status: number, markup: string): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(markup),
  });
  res.end(markup);
}

export function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { location });
  res.end();
}

export function file(
  res: ServerResponse,
  buffer: Buffer,
  contentType: string,
  fileName: string,
): void {
  const ascii = fileName.replace(/[^\x20-\x7E]/g, '_');
  res.writeHead(200, {
    'content-type': contentType,
    // filename — для старых браузеров; filename* — кириллица.
    'content-disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    'content-length': buffer.length,
    'cache-control': 'no-store',
  });
  res.end(buffer);
}

export async function handle(
  router: Router,
  db: pg.Pool,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const matched = router.match(req.method ?? 'GET', url.pathname);

  if (!matched) {
    json(res, 404, { error: 'Страница не найдена' });
    return;
  }

  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[SESSION_COOKIE];
  const actor = token ? await actorByToken(db, token) : null;

  if (matched.route.auth && !actor) {
    if ((req.headers.accept ?? '').includes('text/html')) {
      redirect(res, '/login');
    } else {
      json(res, 401, { error: 'Требуется вход' });
    }
    return;
  }

  try {
    const ctx: Ctx = {
      req,
      res,
      db,
      url,
      params: matched.params,
      query: url.searchParams,
      actor,
      body: req.method === 'POST' ? await readBody(req) : {},
    };
    await matched.route.handler(ctx);
  } catch (error) {
    const message = (error as Error).message;
    const status = error instanceof ForbiddenError ? 403 : 400;

    if ((req.headers.accept ?? '').includes('text/html')) {
      html(res, status, errorPage(status, message));
    } else {
      json(res, status, { error: message });
    }
  }
}

function errorPage(status: number, message: string): string {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<title>Ошибка ${status}</title>
<style>body{font-family:system-ui,sans-serif;padding:40px;max-width:640px;margin:0 auto;color:#1a1f2b}
h1{font-size:20px}p{color:#5c6676}a{color:#23508f}</style></head>
<body><h1>Ошибка ${status}</h1><p>${escapeHtml(message)}</p>
<p><a href="/">Вернуться на главную</a></p></body></html>`;
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
