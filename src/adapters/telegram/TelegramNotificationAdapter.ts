import type { NotificationChannel, OutgoingMessage } from '../../services/notifications/NotificationService.js';
import type { TelegramClient } from './TelegramClient.js';

/** Канал доставки уведомлений в Telegram. Предметной области не знает. */
export class TelegramNotificationAdapter implements NotificationChannel {
  readonly name = 'telegram';

  constructor(private readonly client: TelegramClient) {}

  async send(message: OutgoingMessage): Promise<void> {
    await this.client.sendMessage(message.telegramId, message.text);
  }
}
