import type { BotAction, BotService } from '../../services/bot/BotService.js';
import type { TelegramClient, TelegramUpdate } from './TelegramClient.js';

/**
 * Telegram-адаптер.
 *
 * Единственная его задача — превратить текст сообщения в BotAction
 * и отправить обратно то, что вернул BotService. Никакой бизнес-логики:
 * ни генерации, ни подсчёта пропусков, ни обращений к базе.
 */

const BUTTON_ACTIONS: Array<[RegExp, BotAction]> = [
  [/^\/start\b/i, 'start'],
  [/^\/menu\b|^🏠/i, 'menu'],
  [/дежурство/i, 'my_duty'],
  [/график/i, 'my_schedule'],
  [/информац/i, 'my_info'],
];

/** Разбор входящего текста. Параметров команды намеренно нет. */
export function parseAction(text: string | undefined): BotAction {
  const value = (text ?? '').trim();
  if (!value) return 'unknown';
  for (const [pattern, action] of BUTTON_ACTIONS) {
    if (pattern.test(value)) return action;
  }
  return 'unknown';
}

export class TelegramBot {
  /**
   * Готовый BotService приходит снаружи. Адаптер не создаёт соединений
   * и вообще не знает, что за ним база: заменить хранилище или добавить
   * второй интерфейс можно, не трогая этот файл.
   */
  constructor(
    private readonly service: BotService,
    private readonly client: TelegramClient,
  ) {}

  async handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    const from = message?.from;
    if (!message || !from) return;

    // Отправитель берётся ИЗ Telegram, а не из текста сообщения.
    // Подставить чужой идентификатор через «/floor 7» или «/student <id>»
    // некуда: BotService не принимает таких параметров.
    const reply = await this.service.handle(String(from.id), parseAction(message.text));
    await this.client.sendMessage(
      String(message.chat.id),
      reply.text,
      reply.registered ? reply.buttons : undefined,
    );
  }

  async runPolling(shouldStop: () => boolean = () => false): Promise<void> {
    while (!shouldStop()) {
      const updates = await this.client.getUpdates();
      for (const update of updates) {
        try {
          await this.handleUpdate(update);
        } catch (error) {
          console.error('Ошибка обработки обновления:', (error as Error).message);
        }
      }
    }
  }
}
