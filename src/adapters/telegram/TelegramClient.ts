/**
 * Минимальный клиент Telegram Bot API поверх fetch.
 *
 * Отдельной библиотеки не берём: используются три метода, и своя
 * обёртка честнее зависимости, тянущей за собой polling, парсеры
 * и собственную модель обновлений.
 */

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number; username?: string };
    chat: { id: number };
    text?: string;
  };
}

export class TelegramApiError extends Error {}

export class TelegramClient {
  private offset = 0;

  constructor(
    private readonly token: string,
    private readonly baseUrl = 'https://api.telegram.org',
  ) {}

  private async call<T>(method: string, body: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = (await response.json()) as { ok: boolean; result?: T; description?: string };
    if (!payload.ok) {
      throw new TelegramApiError(payload.description ?? `Ошибка метода ${method}`);
    }
    return payload.result as T;
  }

  async sendMessage(chatId: string, text: string, buttons?: string[]): Promise<void> {
    await this.call('sendMessage', {
      chat_id: chatId,
      text,
      reply_markup: buttons?.length
        ? { keyboard: buttons.map((b) => [{ text: b }]), resize_keyboard: true }
        : undefined,
    });
  }

  /** Long polling. Вебхук не нужен: одна машина, один процесс. */
  async getUpdates(timeoutSeconds = 25): Promise<TelegramUpdate[]> {
    const updates = await this.call<TelegramUpdate[]>('getUpdates', {
      offset: this.offset,
      timeout: timeoutSeconds,
    });
    for (const update of updates) {
      this.offset = Math.max(this.offset, update.update_id + 1);
    }
    return updates;
  }
}
