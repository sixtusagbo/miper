import fetch from 'node-fetch';
import { Config } from './config';
import { logger } from './logger';

// Optional Telegram push alerts. A live unattended bot is invisible otherwise:
// a crash-loop or a silent zero-trade run goes unnoticed until someone tails
// the journal. When TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are set, alert()
// pushes a message to the chat; otherwise it is a no-op. Every send is
// best-effort and fully caught, so a Telegram outage can never crash the bot.
export class Notifier {
  private readonly token: string;
  private readonly chatId: string;

  constructor(cfg: Config) {
    this.token = cfg.telegramBotToken;
    this.chatId = cfg.telegramChatId;
  }

  get enabled(): boolean {
    return this.token !== '' && this.chatId !== '';
  }

  // Fire-and-forget alert. Never throws.
  async alert(message: string): Promise<void> {
    if (!this.enabled) return;
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${this.token}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: this.chatId,
            text: `[miper] ${message}`,
            disable_web_page_preview: true,
          }),
        }
      );
      if (!res.ok) {
        const body = await res.text();
        logger.debug(`telegram alert failed ${res.status}: ${body.slice(0, 200)}`);
      }
    } catch (err) {
      logger.debug(`telegram alert error: ${(err as Error).message}`);
    }
  }
}
