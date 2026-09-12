import { createServer } from 'node:http';
import { assertProductionConfig, config } from '../config.js';
import { createPool } from '../db/pool.js';
import { buildRouter } from '../api/routes.js';
import { handle } from '../api/http.js';
import { TelegramClient } from '../adapters/telegram/TelegramClient.js';
import { TelegramNotificationAdapter } from '../adapters/telegram/TelegramNotificationAdapter.js';
import { NotificationService } from '../services/notifications/NotificationService.js';

/** Точка входа веб-админки. */
assertProductionConfig();

const db = createPool(config.databaseUrl);

// Уведомления подключаются, только если задан токен: без него админка
// работает полностью, просто ничего не рассылает.
const notifications = config.telegramBotToken
  ? new NotificationService(
      db,
      new TelegramNotificationAdapter(new TelegramClient(config.telegramBotToken)),
    )
  : undefined;

if (!config.telegramBotToken) {
  console.log('TELEGRAM_BOT_TOKEN не задан — уведомления из админки отключены.');
}

const router = buildRouter(notifications ? { notifications } : {});

const server = createServer((req, res) => {
  handle(router, db, req, res).catch((error: unknown) => {
    console.error('Необработанная ошибка:', (error as Error).message);
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Внутренняя ошибка' }));
    }
  });
});

server.listen(config.port, () => {
  console.log(`Админка запущена (NODE_ENV=${config.nodeEnv}, порт ${config.port})`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`Получен ${signal}, завершение…`);
    server.close(() => {
      void db.end().then(() => process.exit(0));
    });
  });
}
