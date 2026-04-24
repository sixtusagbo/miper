import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockGetMint: vi.fn(),
  mockGetBalance: vi.fn(),
  mockSendTransaction: vi.fn(),
  mockConfirmTransaction: vi.fn(),
  mockGetLatestBlockhash: vi.fn(),
}));

vi.mock('node-fetch', () => ({ default: mocks.mockFetch }));

vi.mock('@solana/spl-token', () => ({
  getMint: mocks.mockGetMint,
  getAssociatedTokenAddress: vi.fn().mockResolvedValue({
    toBase58: () => 'ATA',
  }),
}));

// Connection is a constructor inside trader.ts. We replace it with a class
// whose methods are wired to our spies.
vi.mock('@solana/web3.js', async () => {
  const actual = await vi.importActual<typeof import('@solana/web3.js')>('@solana/web3.js');
  class MockConnection {
    getBalance = mocks.mockGetBalance;
    sendTransaction = mocks.mockSendTransaction;
    confirmTransaction = mocks.mockConfirmTransaction;
    getLatestBlockhash = mocks.mockGetLatestBlockhash;
    getTokenAccountBalance = vi.fn().mockResolvedValue({ value: { uiAmount: 0 } });
    constructor(_url: string, _opts?: unknown) {}
  }
  return { ...actual, Connection: MockConnection };
});

import { resetConfigCache } from '../src/config';
import { buyToken, sellToken } from '../src/trader';

const VALID_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  process.env.WALLET_PRIVATE_KEY = '';
  process.env.SIMULATE = 'true';
  process.env.LOG_LEVEL = 'error';
  process.env.MAX_SLIPPAGE_BPS = '300';
  delete process.env.SOURCE;
  resetConfigCache();
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.mockGetMint.mockResolvedValue({ decimals: 6 });
});

afterEach(() => {
  // Clear the trader's module-level wallet/connection caches by invalidating modules.
  // We do this so each test gets a fresh wallet and config-derived state.
  vi.resetModules();
});

function jupiterQuote({ outAmount }: { outAmount: string }) {
  return {
    inputMint: 'IN',
    inAmount: '0',
    outputMint: 'OUT',
    outAmount,
    otherAmountThreshold: '0',
    swapMode: 'ExactIn',
    slippageBps: 300,
    priceImpactPct: '0',
  };
}

function mockJupiter(quote: unknown, ok = true) {
  mocks.mockFetch.mockResolvedValueOnce({
    ok,
    status: ok ? 200 : 500,
    json: async () => quote,
    text: async () => JSON.stringify(quote),
  });
}

describe('buyToken (simulate)', () => {
  it('returns a successful simulated swap with computed price per token', async () => {
    // 0.05 SOL spent, getting 1_000_000 tokens @ 6 decimals = 1e12 raw
    mockJupiter(jupiterQuote({ outAmount: '1000000000000' }));
    const result = await buyToken(VALID_MINT, 0.05);
    expect(result.success).toBe(true);
    expect(result.simulated).toBe(true);
    expect(result.amountIn).toBe(0.05);
    expect(result.amountOut).toBe(1_000_000);
    expect(result.pricePerToken).toBeCloseTo(0.05 / 1_000_000);
    expect(result.txSignature).toMatch(/^SIM-/);
  });

  it('propagates Jupiter errors as a failed result', async () => {
    mocks.mockFetch.mockRejectedValueOnce(new Error('jupiter down'));
    const result = await buyToken(VALID_MINT, 0.05);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/jupiter down/);
  });

  it('treats non-OK HTTP responses as failures', async () => {
    mocks.mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: async () => ({}),
      text: async () => 'bad gateway',
    });
    const result = await buyToken(VALID_MINT, 0.05);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Jupiter quote 502/);
  });
});

describe('buyToken (live mode balance guard)', () => {
  it('refuses to buy when remaining balance would be below the reserve', async () => {
    process.env.SIMULATE = 'false';
    // Provide a wallet so getWallet doesn't bail on missing key.
    // 32 bytes of zero is a valid (if useless) base58 secret-key seed wrapper.
    // Simpler: skip wallet and let getWallet throw. Use a generated keypair.
    const { Keypair } = await import('@solana/web3.js');
    const bs58 = (await import('bs58')).default;
    process.env.WALLET_PRIVATE_KEY = bs58.encode(Keypair.generate().secretKey);
    resetConfigCache();
    mocks.mockGetBalance.mockResolvedValue(0.001 * 1_000_000_000); // 0.001 SOL

    // Re-import to pick up new wallet
    vi.resetModules();
    const { buyToken: buy } = await import('../src/trader');
    const result = await buy(VALID_MINT, 0.05);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/insufficient balance/);
    // Jupiter shouldn't have been hit
    expect(mocks.mockFetch).not.toHaveBeenCalled();
  });
});

describe('buyToken (pump source)', () => {
  beforeEach(() => {
    process.env.SOURCE = 'pump';
    resetConfigCache();
  });

  it('paper-buys at the bonding-curve initial price without hitting Jupiter', async () => {
    const result = await buyToken(VALID_MINT, 0.05);
    expect(result.success).toBe(true);
    expect(result.simulated).toBe(true);
    expect(result.amountIn).toBe(0.05);
    // Initial price ≈ 30/1.073e9 ≈ 2.796e-8 SOL/token; 0.05 SOL → ~1.79M tokens.
    expect(result.amountOut).toBeGreaterThan(1_700_000);
    expect(result.amountOut).toBeLessThan(1_900_000);
    expect(result.txSignature).toMatch(/^SIM-/);
    expect(mocks.mockFetch).not.toHaveBeenCalled();
  });

  it('refuses live pump buys (phase 1 is paper-only)', async () => {
    process.env.SIMULATE = 'false';
    const { Keypair } = await import('@solana/web3.js');
    const bs58 = (await import('bs58')).default;
    process.env.WALLET_PRIVATE_KEY = bs58.encode(Keypair.generate().secretKey);
    resetConfigCache();

    vi.resetModules();
    const { buyToken: buy } = await import('../src/trader');
    const result = await buy(VALID_MINT, 0.05);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/pump\.fun/);
    expect(mocks.mockFetch).not.toHaveBeenCalled();
  });
});

describe('sellToken (simulate)', () => {
  it('returns success with computed price per token for a normal sell', async () => {
    // selling 1_000_000 tokens at 6 decimals = 1e12 raw, gets 0.1 SOL = 1e8 lamports
    mockJupiter(jupiterQuote({ outAmount: '100000000' }));
    const result = await sellToken(VALID_MINT, 1_000_000);
    expect(result.success).toBe(true);
    expect(result.simulated).toBe(true);
    expect(result.amountIn).toBe(1_000_000);
    expect(result.amountOut).toBeCloseTo(0.1);
    expect(result.pricePerToken).toBeCloseTo(0.1 / 1_000_000);
  });

  it('refuses dust amounts that round to zero raw units', async () => {
    const result = await sellToken(VALID_MINT, 1e-12);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/amount too small/);
    expect(mocks.mockFetch).not.toHaveBeenCalled();
  });

  it('propagates errors from the quote endpoint', async () => {
    mocks.mockFetch.mockRejectedValueOnce(new Error('boom'));
    const result = await sellToken(VALID_MINT, 1_000_000);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/boom/);
  });
});
