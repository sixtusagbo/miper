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

  // Fire-and-forget alert. Never throws. Pass markdown=true to render Telegram
  // legacy Markdown (monospace `code`, [links]) — only for messages we've kept
  // markdown-safe (trade alerts); plain alerts stay markdown=false so a stray
  // char in an error string can't make Telegram reject a critical alert.
  async alert(message: string, markdown = false): Promise<void> {
    if (!this.enabled) return;
    try {
      const body: Record<string, unknown> = {
        chat_id: this.chatId,
        // Trade alerts (markdown) are self-identifying (emoji + action) and the
        // chat is already named for the bot, so skip the "[miper]" prefix;
        // plain alerts (startup/breaker/heartbeat) keep it.
        text: `${markdown ? '' : '[miper] '}${message}`,
        disable_web_page_preview: true,
      };
      if (markdown) body.parse_mode = 'Markdown';
      const res = await fetch(
        `https://api.telegram.org/bot${this.token}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
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

// Module-level singleton so code that doesn't construct the Notifier (the
// position monitor / sell paths in positions.ts) can still push alerts. The
// snipe command calls initNotifier(cfg) at startup; notify() is a no-op until
// then and whenever Telegram is unconfigured.
let active: Notifier | null = null;

export function initNotifier(cfg: Config): Notifier {
  active = new Notifier(cfg);
  return active;
}

// Fire-and-forget convenience. Never throws, never blocks the caller.
export function notify(message: string, markdown = false): void {
  void active?.alert(message, markdown);
}

// Telegram legacy-Markdown body for a trade alert: a summary line, the full
// mint as tap-to-copy monospace, and chart/tx links (bonkbot-style). The caller
// builds `summary` and must run free text (symbols, errors) through mdSafe.
export function formatTradeAlert(summary: string, mint: string, signature?: string): string {
  const links =
    `[chart](https://dexscreener.com/solana/${mint})` +
    (signature ? ` · [view tx](https://solscan.io/tx/${signature})` : '');
  return `${summary}\n\`${mint}\`\n${links}`;
}

// Strip legacy-Markdown entity chars from free text so a stray * _ ` [ ] can't
// break the message and make Telegram reject the whole alert.
export function mdSafe(text: string): string {
  return text.replace(/[`*_[\]]/g, '');
}
