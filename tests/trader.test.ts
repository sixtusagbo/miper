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
  getAssociatedTokenAddressSync: vi.fn().mockReturnValue({
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
    // detectTokenProgram reads the mint's owning program off the account.
    getAccountInfo = vi.fn().mockResolvedValue({ owner: 'TOKEN_PROGRAM' });
    constructor(_url: string, _opts?: unknown) {}
  }
  return { ...actual, Connection: MockConnection };
});

import { loadConfig, resetConfigCache } from '../src/config';
import {
  buyToken,
  computePriorityMicrolamports,
  confirmWithRebroadcast,
  isNonSystematicBuyError,
  sellToken,
} from '../src/trader';

const VALID_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  process.env.OPENAI_API_KEY = 'sk-openai-test';  process.env.WALLET_PRIVATE_KEY = '';
  process.env.SIMULATE = 'true';
  process.env.LOG_LEVEL = 'error';
  process.env.MAX_SLIPPAGE_BPS = '300';
  // Pin the default source explicitly. Tests that re-import after
  // vi.resetModules() re-run dotenv.config(), which would otherwise fill an
  // unset SOURCE from the developer's real .env (now SOURCE=pump for live).
  process.env.SOURCE = 'raydium';
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

  it('reports market cap on a jupiter buy (supply + SOL price available)', async () => {
    // Distinct mint so the module-level mint cache (populated with a
    // no-supply mock by the test above) doesn't mask the supply here.
    const MC_MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
    // 1e9-token supply (raw 1e15 @ 6 decimals); 0.05 SOL -> 1e6 tokens.
    mocks.mockGetMint.mockResolvedValue({ supply: 1_000_000_000_000_000n, decimals: 6 });
    mockJupiter(jupiterQuote({ outAmount: '1000000000000' })); // fetch #1: quote
    // fetch #2: getSolUsd (CoinGecko) inside marketCapUsd
    mocks.mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ solana: { usd: 150 } }),
      text: async () => '',
    });
    const result = await buyToken(MC_MINT, 0.05);
    expect(result.success).toBe(true);
    // MC = supply(1e9) * price(0.05/1e6) * solUsd(150) = ~$7,500
    expect(result.marketCapUsd).toBeCloseTo(7500, 0);
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

});

describe('sellToken (pump source)', () => {
  beforeEach(() => {
    process.env.SOURCE = 'pump';
    resetConfigCache();
  });

  it('uses the supplied current price hint so paper PnL reflects realized loss/gain', async () => {
    // 5x drawdown vs the bonding-curve init: 1M tokens sold at the new price
    // should yield 1/5 of what an init-priced sell would produce.
    const initPrice = 30 / 1_073_000_000;
    const crashedPrice = initPrice / 5;
    const result = await sellToken(VALID_MINT, 1_000_000, undefined, crashedPrice);
    expect(result.success).toBe(true);
    expect(result.pricePerToken).toBe(crashedPrice);
    expect(result.amountOut).toBeCloseTo(1_000_000 * crashedPrice, 12);
    expect(mocks.mockFetch).not.toHaveBeenCalled();
  });

  it('falls back to the bonding-curve init price when no hint is provided', async () => {
    const initPrice = 30 / 1_073_000_000;
    const result = await sellToken(VALID_MINT, 1_000_000);
    expect(result.success).toBe(true);
    expect(result.pricePerToken).toBeCloseTo(initPrice, 12);
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

describe('computePriorityMicrolamports', () => {
  function cfgWith(floor: number, max: number) {
    process.env.PUMP_PRIORITY_MICROLAMPORTS = String(floor);
    process.env.PUMP_PRIORITY_MAX_MICROLAMPORTS = String(max);
    resetConfigCache();
    return loadConfig();
  }
  const conn = (fees: number[] | Error) =>
    ({
      getRecentPrioritizationFees:
        fees instanceof Error
          ? vi.fn().mockRejectedValue(fees)
          : vi
              .fn()
              .mockResolvedValue(fees.map((f) => ({ slot: 0, prioritizationFee: f }))),
    }) as any;

  it('returns the floor when no recent fees are available', async () => {
    const fee = await computePriorityMicrolamports(conn([]), cfgWith(100_000, 5_000_000));
    expect(fee).toBe(100_000);
  });

  it('returns the floor when recent fees are all below it', async () => {
    const fee = await computePriorityMicrolamports(
      conn([100, 200, 300, 400]),
      cfgWith(100_000, 5_000_000)
    );
    expect(fee).toBe(100_000);
  });

  it('targets the 75th percentile with headroom above the floor', async () => {
    // p75 of [200000 x4] = 200000; x1.3 headroom = 260000
    const fee = await computePriorityMicrolamports(
      conn([200_000, 200_000, 200_000, 200_000]),
      cfgWith(100_000, 5_000_000)
    );
    expect(fee).toBe(260_000);
  });

  it('caps the fee at the configured maximum during congestion', async () => {
    const fee = await computePriorityMicrolamports(
      conn([50_000_000]),
      cfgWith(100_000, 5_000_000)
    );
    expect(fee).toBe(5_000_000);
  });

  it('falls back to the floor when the RPC fee lookup fails', async () => {
    const fee = await computePriorityMicrolamports(
      conn(new Error('rpc down')),
      cfgWith(100_000, 5_000_000)
    );
    expect(fee).toBe(100_000);
  });
});

describe('confirmWithRebroadcast', () => {
  const bh = { blockhash: 'bh', lastValidBlockHeight: 100 };
  const raw = new Uint8Array([1, 2, 3]);

  it('returns the signature once the tx confirms', async () => {
    const conn = {
      sendRawTransaction: vi.fn().mockResolvedValue('SIG'),
      confirmTransaction: vi.fn().mockResolvedValue({ value: { err: null } }),
    } as any;
    const sig = await confirmWithRebroadcast(conn, raw, bh, 5);
    expect(sig).toBe('SIG');
    expect(conn.sendRawTransaction).toHaveBeenCalled();
  });

  it('keeps rebroadcasting the tx while confirmation is pending', async () => {
    let resolveConfirm: (v: unknown) => void = () => {};
    const confirmP = new Promise((r) => {
      resolveConfirm = r;
    });
    const conn = {
      sendRawTransaction: vi.fn().mockResolvedValue('SIG'),
      confirmTransaction: vi.fn().mockReturnValue(confirmP),
    } as any;
    const p = confirmWithRebroadcast(conn, raw, bh, 2);
    await new Promise((r) => setTimeout(r, 16)); // ~8 rebroadcast intervals
    expect(conn.sendRawTransaction.mock.calls.length).toBeGreaterThan(1);
    resolveConfirm({ value: { err: null } });
    await expect(p).resolves.toBe('SIG');
  });

  it('throws when the tx confirms with a program error', async () => {
    const conn = {
      sendRawTransaction: vi.fn().mockResolvedValue('SIG'),
      confirmTransaction: vi.fn().mockResolvedValue({
        value: { err: { InstructionError: [2, { Custom: 6002 }] } },
      }),
    } as any;
    await expect(confirmWithRebroadcast(conn, raw, bh, 5)).rejects.toThrow(
      /pump tx failed/
    );
  });
});

describe('isNonSystematicBuyError (circuit-breaker classification)', () => {
  it('treats fresh-launch (Custom:1) and other per-token reverts as non-systematic', () => {
    expect(isNonSystematicBuyError('pump tx failed: {"InstructionError":[3,{"Custom":1}]}')).toBe(true);
    expect(isNonSystematicBuyError('pump tx failed: {"InstructionError":[2,{"Custom":6001}]}')).toBe(true);
    expect(isNonSystematicBuyError('{"InstructionError":[3,{"Custom":6010}]}')).toBe(true);
    expect(isNonSystematicBuyError('no route found for mint')).toBe(true);
    expect(isNonSystematicBuyError('Signature x has expired: block height exceeded.')).toBe(true);
  });

  it('keeps slippage (6002) and a drained wallet HARD so the breaker still catches them', () => {
    expect(isNonSystematicBuyError('pump tx failed: {"InstructionError":[3,{"Custom":6002}]}')).toBe(false);
    expect(isNonSystematicBuyError('insufficient balance: 0.01 SOL, need 0.17')).toBe(false);
  });
});
