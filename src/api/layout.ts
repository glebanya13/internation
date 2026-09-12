import type { Actor } from '../services/auth/authService.js';
import { escapeHtml } from './http.js';

/**
 * Вёрстка админки. Server-rendered: без сборки фронтенда, без SPA.
 * Адаптивна — на телефоне навигация схлопывается в горизонтальную ленту,
 * широкие таблицы прокручиваются внутри своего контейнера.
 */

export interface FloorOption {
  id: string;
  number: number;
  code: string | null;
  title: string | null;
}

export function floorLabel(floor: FloorOption): string {
  return floor.code ?? String(floor.number);
}

interface LayoutOptions {
  title: string;
  actor: Actor;
  active: string;
  /** Этажи, доступные администратору, и выбранный. */
  floors?: FloorOption[];
  currentFloorId?: string | null;
  body: string;
}

const NAV = [
  ['/', 'Сводка', 'dashboard'],
  ['/floors', 'Этажи', 'floors'],
  ['/rooms', 'Комнаты и блоки', 'rooms'],
  ['/roster', 'Состав этажа', 'roster'],
  ['/import', 'Импорт списка', 'import'],
  ['/imports', 'История импортов', 'imports'],
  ['/schedule/new', 'Генерация графика', 'generate'],
  ['/schedules', 'Графики', 'schedules'],
  ['/duties', 'Дежурства', 'duties'],
  ['/violations', 'Пропуски', 'violations'],
  ['/changes', 'Замены', 'changes'],
  ['/settings', 'Настройки', 'settings'],
] as const;

export function layout(options: LayoutOptions): string {
  const floorQuery = options.currentFloorId ? `?floor=${options.currentFloorId}` : '';

  const nav = NAV.map(([href, label, key]) => {
    const link = href === '/floors' || href === '/settings' ? href : `${href}${floorQuery}`;
    const active = key === options.active ? ' class="active"' : '';
    return `<a href="${link}"${active}>${escapeHtml(label)}</a>`;
  }).join('');

  const floorPicker = options.floors?.length
    ? `<form method="get" class="floor-picker" id="floorPicker">
         <select name="floor" id="floorSelect" onchange="this.form.submit()" aria-label="Этаж">
           ${options.floors
             .map(
               (floor) =>
                 `<option value="${floor.id}"${
                   floor.id === options.currentFloorId ? ' selected' : ''
                 }>${escapeHtml(floorLabel(floor))}</option>`,
             )
             .join('')}
         </select>
       </form>`
    : '';

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.title)}</title>
<style>${CSS}</style>
</head>
<body>
<header class="top">
  <div class="brand"><a href="/">Дежурства</a></div>
  ${floorPicker}
  <div class="who">
    <span>${escapeHtml(options.actor.fullName ?? options.actor.email)}</span>
    <span class="role">${escapeHtml(roleName(options.actor.role))}</span>
    <form method="post" action="/logout"><button type="submit">Выйти</button></form>
  </div>
</header>
<nav class="side">${nav}</nav>
<main>
  <h1>${escapeHtml(options.title)}</h1>
  ${options.body}
</main>
</body>
</html>`;
}

export function roleName(role: string): string {
  switch (role) {
    case 'superadmin':
      return 'Суперадминистратор';
    case 'dorm_admin':
      return 'Администратор общежития';
    case 'floor_admin':
      return 'Администратор этажа';
    default:
      return role;
  }
}

export function loginPage(error?: string): string {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Вход</title>
<style>${CSS}</style>
</head>
<body class="centered">
<form method="post" action="/login" class="card login">
  <h1>Вход в админку</h1>
  ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
  <label>Электронная почта<input type="email" name="email" required autofocus></label>
  <label>Пароль<input type="password" name="password" required></label>
  <button type="submit" class="primary">Войти</button>
</form>
</body>
</html>`;
}

export function notice(text: string, kind: 'ok' | 'warn' | 'error' = 'ok'): string {
  return `<div class="notice ${kind}">${escapeHtml(text)}</div>`;
}

/** Таблица с горизонтальной прокруткой: страница вбок не едет никогда. */
export function table(
  headers: string[],
  rows: string[][],
  rowClasses?: string[],
): string {
  if (rows.length === 0) {
    return `<div class="empty">Записей нет</div>`;
  }
  return `<div class="scroll"><table>
    <thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows
      .map(
        (row, i) =>
          `<tr class="${escapeHtml(rowClasses?.[i] ?? '')}">${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`,
      )
      .join('')}</tbody>
  </table></div>`;
}

const CSS = `
:root{
  --bg:#f4f6f8; --surface:#fff; --line:#d2d9e2; --ink:#171c26; --muted:#5c6676;
  --accent:#23508f; --accent-soft:#e4ebf6; --ok:#2a6a4f; --ok-soft:#e2efe8;
  --warn:#8a5a12; --warn-soft:#f8eedc; --alert:#9e2740; --alert-soft:#f7e6e9;
}
*{box-sizing:border-box}
body{
  margin:0;background:var(--bg);color:var(--ink);
  font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  display:grid;grid-template-columns:210px 1fr;grid-template-rows:auto 1fr;
  grid-template-areas:"top top" "side main";min-height:100vh;
}
body.centered{display:flex;align-items:center;justify-content:center;padding:20px}

.top{
  grid-area:top;display:flex;align-items:center;gap:16px;flex-wrap:wrap;
  background:var(--surface);border-bottom:1px solid var(--line);padding:10px 18px;
}
.brand a{font-weight:600;color:var(--ink);text-decoration:none}
.who{margin-left:auto;display:flex;align-items:center;gap:10px;font-size:13px;color:var(--muted)}
.who .role{padding:2px 7px;border:1px solid var(--line);border-radius:3px}
.floor-picker{display:flex;align-items:center;gap:6px;font-size:13px;color:var(--muted)}

.side{
  grid-area:side;background:var(--surface);border-right:1px solid var(--line);
  padding:12px 8px;display:flex;flex-direction:column;gap:2px;
}
.side a{
  padding:7px 11px;border-radius:4px;color:var(--ink);text-decoration:none;font-size:14px;
}
.side a:hover{background:var(--bg)}
.side a.active{background:var(--accent-soft);color:var(--accent);font-weight:500}

main{grid-area:main;padding:20px 24px 60px;max-width:1200px}
h1{font-size:22px;margin:0 0 18px}
h2{font-size:17px;margin:26px 0 10px}

.card{background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:16px 18px;margin-bottom:16px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px}
.stat{background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:14px 16px}
.stat .value{font-size:26px;font-weight:600}
.stat .label{font-size:13px;color:var(--muted)}

.scroll{overflow-x:auto;background:var(--surface);border:1px solid var(--line);border-radius:6px}
table{border-collapse:collapse;width:100%;font-size:14px;min-width:560px}
th{
  text-align:left;font-size:11px;letter-spacing:.06em;text-transform:uppercase;
  color:var(--muted);padding:9px 12px;border-bottom:1px solid var(--line);white-space:nowrap;
}
td{padding:8px 12px;border-bottom:1px solid var(--line);vertical-align:top}
tr:last-child td{border-bottom:none}
tr.placeholder td{background:#fafbfc;color:var(--muted)}
tr.room-start td{border-top:2px solid var(--line)}

form.inline{display:inline}
label{display:block;font-size:13px;color:var(--muted);margin-bottom:10px}
input,select,textarea{
  display:block;width:100%;margin-top:4px;padding:7px 9px;font:inherit;
  border:1px solid var(--line);border-radius:4px;background:#fff;color:var(--ink);
}
button{
  font:inherit;padding:7px 13px;border:1px solid var(--line);border-radius:4px;
  background:var(--surface);color:var(--ink);cursor:pointer;
}
button:hover{background:var(--bg)}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
button.danger{border-color:var(--alert);color:var(--alert)}
button.icon-btn{display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
button.icon-btn svg{flex-shrink:0}
.action-btns{display:inline-flex;gap:6px;align-items:center}
button.icon-round{
  width:34px;height:34px;padding:0;border-radius:50%;
  display:inline-flex;align-items:center;justify-content:center;
}
button.icon-round:hover{background:var(--accent-soft)}
button.icon-round.danger:hover{background:var(--alert-soft)}
button:disabled{opacity:.5;cursor:not-allowed}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin-bottom:14px}
.row label{margin-bottom:0}
.pagination{
  display:flex;justify-content:space-between;align-items:center;gap:12px;
  flex-wrap:wrap;margin:10px 0 12px;
}
.pagination-links{display:flex;gap:8px;align-items:center}

.notice{padding:11px 14px;border-radius:4px;margin-bottom:14px;border-left:3px solid var(--line);background:var(--surface)}
.notice.ok{border-left-color:var(--ok);background:var(--ok-soft)}
.notice.warn{border-left-color:var(--warn);background:var(--warn-soft)}
.notice.error{border-left-color:var(--alert);background:var(--alert-soft)}
.error{color:var(--alert)}
.pill{display:inline-block;font-size:11px;padding:2px 7px;border-radius:3px;border:1px solid var(--line)}
.pill.ok{border-color:var(--ok);color:var(--ok);background:var(--ok-soft)}
.pill.warn{border-color:var(--warn);color:var(--warn);background:var(--warn-soft)}
.pill.alert{border-color:var(--alert);color:var(--alert);background:var(--alert-soft)}
.muted{color:var(--muted)}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}
.login{width:min(360px,100%)}
.login h1{font-size:19px}

/* Планшет и телефон: боковая навигация становится горизонтальной лентой. */
@media (max-width:860px){
  body{grid-template-columns:1fr;grid-template-areas:"top" "side" "main"}
  .side{flex-direction:row;overflow-x:auto;border-right:none;border-bottom:1px solid var(--line);padding:8px}
  .side a{white-space:nowrap}
  main{padding:16px 14px 50px}
  .who span:first-child{display:none}
}
@media (max-width:520px){
  .top{padding:8px 12px}
  h1{font-size:19px}
  .row{flex-direction:column;align-items:stretch}
}
`;
