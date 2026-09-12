import { config } from '../config.js';
import { createPool } from '../db/pool.js';
import { DisabledNotificationChannel } from '../adapters/telegram/DisabledNotificationChannel.js';
import { TelegramClient } from '../adapters/telegram/TelegramClient.js';
import { TelegramNotificationAdapter } from '../adapters/telegram/TelegramNotificationAdapter.js';
import { NotificationService } from '../services/notifications/NotificationService.js';
import { runLoop } from '../worker/scheduler.js';

/** Точка входа планировщика. Периодические задачи живут только здесь. */
const db = createPool(config.databaseUrl);

const channel = config.telegramBotToken
  ? new TelegramNotificationAdapter(new TelegramClient(config.telegramBotToken))
  : new DisabledNotificationChannel();

if (!config.telegramBotToken) {
  console.log(
    'TELEGRAM_BOT_TOKEN не задан — доставка уведомлений отключена, очередь продолжает работать.',
  );
}

const notifications = new NotificationService(db, channel);

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`Получен ${signal}, остановка планировщика…`);
    stopping = true;
  });
}

console.log(`Планировщик запущен, интервал ${config.schedulerIntervalMinutes} мин.`);
await runLoop(db, notifications, {
  intervalMinutes: config.schedulerIntervalMinutes,
  shouldStop: () => stopping,
});
await db.end();
console.log('Планировщик остановлен.');
