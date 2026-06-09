import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ mockFetch: vi.fn() }));
vi.mock('node-fetch', () => ({ default: mocks.mockFetch }));

import { Notifier } from '../src/notifier';
import { Config } from '../src/config';

function cfg(overrides: Partial<Config> = {}): Config {
  return { telegramBotToken: '', telegramChatId: '', ...overrides } as Config;
}

beforeEach(() => {
  mocks.mockFetch.mockReset();
  mocks.mockFetch.mockResolvedValue({ ok: true, text: async () => '' });
});

afterEach(() => vi.restoreAllMocks());

describe('Notifier', () => {
  it('is a no-op when token/chat are unset (no network call)', async () => {
    const n = new Notifier(cfg());
    expect(n.enabled).toBe(false);
    await n.alert('hello');
    expect(mocks.mockFetch).not.toHaveBeenCalled();
  });

  it('posts to the Telegram sendMessage endpoint when configured', async () => {
    const n = new Notifier(cfg({ telegramBotToken: 'TOK', telegramChatId: 'CHAT' }));
    expect(n.enabled).toBe(true);
    await n.alert('boom');
    expect(mocks.mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mocks.mockFetch.mock.calls[0];
    expect(url).toBe('https://api.telegram.org/botTOK/sendMessage');
    const body = JSON.parse((opts as { body: string }).body);
    expect(body.chat_id).toBe('CHAT');
    expect(body.text).toContain('boom');
    expect(body.text).toContain('[miper]');
  });

  it('never throws when the Telegram call fails', async () => {
    mocks.mockFetch.mockRejectedValue(new Error('network down'));
    const n = new Notifier(cfg({ telegramBotToken: 'TOK', telegramChatId: 'CHAT' }));
    await expect(n.alert('x')).resolves.toBeUndefined();
  });

  it('swallows a non-ok HTTP response without throwing', async () => {
    mocks.mockFetch.mockResolvedValue({ ok: false, status: 429, text: async () => 'rate limited' });
    const n = new Notifier(cfg({ telegramBotToken: 'TOK', telegramChatId: 'CHAT' }));
    await expect(n.alert('x')).resolves.toBeUndefined();
  });
});

describe('formatDiscoveryAlert', () => {
  it('packs mint, mcap, liquidity, age, holders, score and reasons into one body', async () => {
    const { formatDiscoveryAlert } = await import('../src/notifier');
    const body = formatDiscoveryAlert({
      tokenMint: 'MintAddr111',
      symbol: 'DOG*',
      score: 78,
      reasons: ['+30 1 smart wallet(s) bought', '+10 mcap $5200 in the entry band'],
      mcapUsd: 5200,
      liquiditySol: 14.3,
      ageSec: 94,
      holderCount: 12,
      smartWalletBuys: 2,
    });
    expect(body).toContain('score 78/100');
    expect(body).toContain('*DOG*'); // bold-wrapped, symbol's own * stripped
    expect(body).not.toContain('DOG**');
    expect(body).toContain('MC $5.2k');
    expect(body).toContain('liq 14.3 SOL');
    expect(body).toContain('age 94s');
    expect(body).toContain('holders ≥12');
    expect(body).toContain('🧠 2 smart');
    expect(body).toContain('smart wallet(s) bought');
    expect(body).toContain('`MintAddr111`'); // tap-to-copy mint
    expect(body).toContain('dexscreener.com/solana/MintAddr111');
  });

  it('renders unknowns as ? and minutes past 120s', async () => {
    const { formatDiscoveryAlert } = await import('../src/notifier');
    const body = formatDiscoveryAlert({
      tokenMint: 'M',
      symbol: null,
      score: 60,
      reasons: [],
      mcapUsd: null,
      liquiditySol: null,
      ageSec: 300,
      holderCount: 0,
      smartWalletBuys: 0,
    });
    expect(body).toContain('MC ?');
    expect(body).toContain('liq ?');
    expect(body).toContain('age 5.0min');
    expect(body).not.toContain('🧠');
  });
});
