import { config } from '../config.js';
import { createPool } from '../db/pool.js';
import { TelegramBot } from '../adapters/telegram/bot.js';
import { TelegramClient } from '../adapters/telegram/TelegramClient.js';
import { BotService } from '../services/bot/BotService.js';

/** Точка входа Telegram-бота. Только сборка зависимостей. */
const token = config.telegramBotToken;
if (!token) {
  console.log('TELEGRAM_BOT_TOKEN не задан — Telegram-бот не запускается.');
  process.exit(0);
}

const db = createPool(config.databaseUrl);
const bot = new TelegramBot(new BotService(db), new TelegramClient(token));

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`Получен ${signal}, остановка бота…`);
    stopping = true;
  });
}

console.log('Telegram-бот запущен.');
await bot.runPolling(() => stopping);
await db.end();
console.log('Telegram-бот остановлен.');
