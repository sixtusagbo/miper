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
