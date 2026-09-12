import type { NotificationChannel, OutgoingMessage } from '../../services/notifications/NotificationService.js';

/**
 * Канал-заглушка: уведомления остаются в очереди, доставка отключена.
 * Используется, когда TELEGRAM_BOT_TOKEN не задан.
 */
export class DisabledNotificationChannel implements NotificationChannel {
  readonly name = 'disabled';
  readonly enabled = false;

  async send(_message: OutgoingMessage): Promise<void> {
    throw new Error('Telegram отключён');
  }
}
