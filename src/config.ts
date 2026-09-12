import 'dotenv/config';

/**
 * Конфигурация читается только из окружения. Никаких номеров этажей,
 * кодов факультетов и времён смен здесь нет и быть не может — это данные,
 * которыми управляет администратор.
 */
function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`Не задана переменная окружения ${name}`);
  return value;
}

const nodeEnv = process.env['NODE_ENV'] ?? 'development';
const isProduction = nodeEnv === 'production';

export const config = {
  nodeEnv,
  isProduction,
  isDevelopment: nodeEnv === 'development',
  databaseUrl: required(
    'DATABASE_URL',
    isProduction ? undefined : 'postgres://localhost:5432/dorm_duty',
  ),
  testDatabaseUrl: required('TEST_DATABASE_URL', 'postgres://localhost:5432/dorm_duty_test'),
  sessionSecret: process.env['SESSION_SECRET'],
  publicBaseUrl: process.env['PUBLIC_BASE_URL'] ?? 'http://localhost:3000',
  port: Number(process.env['PORT'] ?? 3000),
  pgPoolMax: Number(process.env['PG_POOL_MAX'] ?? (isProduction ? 3 : 5)),
  secureCookies: process.env['SECURE_COOKIES'] === 'true',
  telegramBotToken: process.env['TELEGRAM_BOT_TOKEN']?.trim() || undefined,
  schedulerIntervalMinutes: Number(process.env['SCHEDULER_INTERVAL_MINUTES'] ?? 5),
};

/** Проверки, обязательные перед запуском в production. */
export function assertProductionConfig(): void {
  if (!config.isProduction) return;

  if (!config.sessionSecret || config.sessionSecret.length < 32) {
    throw new Error(
      'В production требуется SESSION_SECRET длиной не менее 32 символов. ' +
        'Сгенерируйте: openssl rand -base64 48',
    );
  }

  if (config.databaseUrl.includes('localhost') && !process.env['DATABASE_URL']) {
    throw new Error('В production нельзя использовать DATABASE_URL по умолчанию для localhost');
  }
}
