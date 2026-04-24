import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockFetch: vi.fn(),
  mockGetMint: vi.fn(),
  mockGetTokenLargestAccounts: vi.fn(),
}));

vi.mock('node-fetch', () => ({ default: mocks.mockFetch }));

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    messages = { create: mocks.mockCreate };
    constructor(_opts?: unknown) {}
  }
  return { default: MockAnthropic };
});

vi.mock('@solana/spl-token', async () => {
  const { PublicKey } = await import('@solana/web3.js');
  class TokenInvalidAccountOwnerError extends Error {
    name = 'TokenInvalidAccountOwnerError';
  }
  return {
    getMint: mocks.mockGetMint,
    TOKEN_2022_PROGRAM_ID: new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'),
    TokenInvalidAccountOwnerError,
  };
});

import { resetConfigCache, loadConfig } from '../src/config';
import {
  PUMP_INITIAL_PRICE_SOL,
  analyzeToken,
  fetchMarketData,
  pumpMarketData,
  runSafetyChecks,
  scoreWithAi,
} from '../src/analyzer';
import type { NewPool } from '../src/listener';

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  process.env.WALLET_PRIVATE_KEY = '';
  process.env.SIMULATE = 'true';
  process.env.LOG_LEVEL = 'error';
  process.env.MIN_AI_SCORE = '70';
  process.env.MIN_LIQUIDITY_USD = '5000';
  process.env.MAX_TOP_HOLDER_PCT = '30';
  process.env.REQUIRE_MINT_REVOKED = 'true';
  process.env.REQUIRE_FREEZE_REVOKED = 'true';
  process.env.MIPER_SAFETY_PRE_READ_DELAY_MS = '0';
  delete process.env.SOURCE;
  resetConfigCache();
  mocks.mockCreate.mockReset();
  mocks.mockFetch.mockReset();
  mocks.mockGetMint.mockReset();
  mocks.mockGetTokenLargestAccounts.mockReset();
});

function fakePool(overrides: Partial<NewPool> = {}): NewPool {
  return {
    poolAddress: 'POOL',
    tokenMint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    baseMint: 'So11111111111111111111111111111111111111112',
    quoteMint: 'MINT',
    initialLiquiditySol: 10,
    txSignature: 'SIG',
    timestamp: Math.floor(Date.now() / 1000),
    creator: null,
    ...overrides,
  };
}

function fakeConnection() {
  return {
    getTokenLargestAccounts: mocks.mockGetTokenLargestAccounts,
  } as any;
}

function mockFetchJson(json: unknown, ok = true, status = 200): void {
  mocks.mockFetch.mockResolvedValueOnce({
    ok,
    status,
    json: async () => json,
    text: async () => JSON.stringify(json),
  });
}

// ---------------------------------------------------------------------------
// runSafetyChecks
// ---------------------------------------------------------------------------

describe('runSafetyChecks', () => {
  function mockOnChain({
    mintAuthority = null,
    freezeAuthority = null,
    supply = 1_000_000n * 1_000_000n, // 1e12 raw = 1M tokens at 6 decimals
    decimals = 6,
    topAmount = '100000000000', // 100k at 6 decimals = 10% of 1M
  }: {
    mintAuthority?: unknown;
    freezeAuthority?: unknown;
    supply?: bigint;
    decimals?: number;
    topAmount?: string;
  } = {}): void {
    mocks.mockGetMint.mockResolvedValue({
      mintAuthority,
      freezeAuthority,
      supply,
      decimals,
    });
    mocks.mockGetTokenLargestAccounts.mockResolvedValue({
      value: [{ amount: topAmount }, { amount: '1' }, { amount: '1' }],
    });
  }

  it('passes when all conditions are met', async () => {
    mockOnChain();
    const cfg = loadConfig();
    const result = await runSafetyChecks(fakeConnection(), 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', 10_000, cfg);
    expect(result.passed).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.mintRevoked).toBe(true);
    expect(result.freezeRevoked).toBe(true);
    expect(result.topHolderPct).toBeCloseTo(10);
  });

  it('fails when mint authority is not revoked and flag is set', async () => {
    mockOnChain({ mintAuthority: { _bn: 1 } }); // truthy, non-null
    const cfg = loadConfig();
    const result = await runSafetyChecks(fakeConnection(), 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', 10_000, cfg);
    expect(result.passed).toBe(false);
    expect(result.failures.join(' ')).toMatch(/mint authority/);
  });

  it('fails when freeze authority is not revoked', async () => {
    mockOnChain({ freezeAuthority: { _bn: 1 } });
    const cfg = loadConfig();
    const result = await runSafetyChecks(fakeConnection(), 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', 10_000, cfg);
    expect(result.failures.join(' ')).toMatch(/freeze authority/);
  });

  it('fails when top holder exceeds max %', async () => {
    mockOnChain({ topAmount: '500000000000' }); // 500k = 50%
    const cfg = loadConfig();
    const result = await runSafetyChecks(fakeConnection(), 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', 10_000, cfg);
    expect(result.failures.some((f) => f.includes('top holder'))).toBe(true);
  });

  it('fails when liquidity is below minimum', async () => {
    mockOnChain();
    const cfg = loadConfig();
    const result = await runSafetyChecks(fakeConnection(), 'MINT', 100, cfg);
    expect(result.failures.some((f) => f.includes('liquidity'))).toBe(true);
  });

  it('skips mint/freeze checks when flags are off', async () => {
    process.env.REQUIRE_MINT_REVOKED = 'false';
    process.env.REQUIRE_FREEZE_REVOKED = 'false';
    resetConfigCache();
    mockOnChain({ mintAuthority: { _bn: 1 }, freezeAuthority: { _bn: 1 } });
    const cfg = loadConfig();
    const result = await runSafetyChecks(fakeConnection(), 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', 10_000, cfg);
    expect(result.passed).toBe(true);
  });

  it('records an error when on-chain calls throw', async () => {
    mocks.mockGetMint.mockRejectedValue(new Error('rpc timeout'));
    const cfg = loadConfig();
    const result = await runSafetyChecks(fakeConnection(), 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', 10_000, cfg);
    expect(result.passed).toBe(false);
    expect(result.failures.some((f) => f.includes('rpc timeout'))).toBe(true);
  });

  it('retries getMint with Token-2022 when the default program rejects the owner', async () => {
    // Import the mocked class so we can throw the exact type the handler
    // catches (instanceof check in getMintAcrossPrograms).
    const spl = await import('@solana/spl-token');
    const invalidOwner = new spl.TokenInvalidAccountOwnerError('');

    // First call (default SPL Token programId) rejects — pump.fun mint.
    // Second call (with TOKEN_2022_PROGRAM_ID) succeeds.
    mocks.mockGetMint
      .mockRejectedValueOnce(invalidOwner)
      .mockResolvedValueOnce({
        mintAuthority: null,
        freezeAuthority: null,
        supply: 1_000_000n * 1_000_000n,
        decimals: 6,
      });
    mocks.mockGetTokenLargestAccounts.mockResolvedValue({
      value: [{ amount: '50000000000' }],
    });

    const result = await runSafetyChecks(
      fakeConnection(),
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
      10_000,
      loadConfig()
    );
    expect(result.passed).toBe(true);
    expect(mocks.mockGetMint).toHaveBeenCalledTimes(2);
    // Second call must pass the Token-2022 program ID.
    const secondCallArgs = mocks.mockGetMint.mock.calls[1];
    expect(secondCallArgs[3].toBase58()).toBe('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
  });

  it('retries getMint when the mint has not propagated yet', async () => {
    // First two attempts: fresh mint not visible on the RPC (simulated
    // empty-message throw). Third attempt succeeds — the realistic case.
    mocks.mockGetMint
      .mockRejectedValueOnce(new Error(''))
      .mockRejectedValueOnce(new Error(''))
      .mockResolvedValueOnce({
        mintAuthority: null,
        freezeAuthority: null,
        supply: 1_000_000n * 1_000_000n,
        decimals: 6,
      });
    mocks.mockGetTokenLargestAccounts.mockResolvedValue({
      value: [{ amount: '50000000000' }], // 5% top holder
    });
    const result = await runSafetyChecks(
      fakeConnection(),
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
      10_000,
      loadConfig()
    );
    expect(result.passed).toBe(true);
    expect(mocks.mockGetMint).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// fetchMarketData
// ---------------------------------------------------------------------------

describe('fetchMarketData', () => {
  it('maps DexScreener pair data into MarketData', async () => {
    mockFetchJson({
      pairs: [
        {
          baseToken: { address: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', symbol: 'DOGE', name: 'Doge' },
          priceUsd: '0.0001',
          priceNative: '0.0000005',
          liquidity: { usd: 10_000, quote: 20 },
          marketCap: 1_000_000,
          volume: { h24: 50_000 },
        },
      ],
    });
    const md = await fetchMarketData(fakePool({ tokenMint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' }));
    expect(md.source).toBe('dexscreener');
    expect(md.symbol).toBe('DOGE');
    expect(md.priceUsd).toBe(0.0001);
    expect(md.liquidityUsd).toBe(10_000);
    expect(md.marketCapUsd).toBe(1_000_000);
    expect(md.volume24hUsd).toBe(50_000);
  });

  it('falls back to pool liquidity when DexScreener has no pairs', async () => {
    mockFetchJson({ pairs: [] }); // token fetch returns nothing
    mockFetchJson({ pairs: [{ priceUsd: '150' }] }); // SOL/USD lookup
    const md = await fetchMarketData(fakePool({ initialLiquiditySol: 5 }));
    expect(md.source).toBe('pool-fallback');
    expect(md.liquiditySol).toBe(5);
    expect(md.liquidityUsd).toBe(5 * 150 * 2); // 1500
  });

  it('returns pool fallback with null liquidityUsd when SOL price lookup also fails', async () => {
    mockFetchJson({ pairs: [] });
    mocks.mockFetch.mockRejectedValueOnce(new Error('network'));
    const md = await fetchMarketData(fakePool({ initialLiquiditySol: 3 }));
    expect(md.source).toBe('pool-fallback');
    expect(md.liquiditySol).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// scoreWithAi
// ---------------------------------------------------------------------------

describe('scoreWithAi', () => {
  const pool = fakePool();
  const market = {
    symbol: 'DOGE',
    name: 'Doge',
    priceUsd: 0.0001,
    priceSol: null,
    liquidityUsd: 10_000,
    liquiditySol: 20,
    marketCapUsd: 1_000_000,
    volume24hUsd: 50_000,
    supply: null,
    source: 'dexscreener' as const,
  };
  const safety = {
    mintRevoked: true,
    freezeRevoked: true,
    topHolderPct: 10,
    holderCount: 20,
    passed: true,
    failures: [],
  };

  function claudeResponse(text: string) {
    return {
      content: [{ type: 'text' as const, text }],
    };
  }

  it('parses a clean JSON response', async () => {
    mocks.mockCreate.mockResolvedValue(
      claudeResponse('{"score": 85, "reasoning": "good vibes"}')
    );
    const out = await scoreWithAi(pool, market, safety, loadConfig());
    expect(out.score).toBe(85);
    expect(out.reasoning).toBe('good vibes');
    expect(out.error).toBeUndefined();
  });

  it('extracts JSON embedded in surrounding prose', async () => {
    mocks.mockCreate.mockResolvedValue(
      claudeResponse('Here is my answer:\n{"score": 72, "reasoning": "ok"}\nthanks')
    );
    const out = await scoreWithAi(pool, market, safety, loadConfig());
    expect(out.score).toBe(72);
  });

  it('clamps scores above 100 and below 0', async () => {
    mocks.mockCreate.mockResolvedValue(
      claudeResponse('{"score": 150, "reasoning": "x"}')
    );
    expect((await scoreWithAi(pool, market, safety, loadConfig())).score).toBe(100);

    mocks.mockCreate.mockResolvedValue(
      claudeResponse('{"score": -20, "reasoning": "x"}')
    );
    expect((await scoreWithAi(pool, market, safety, loadConfig())).score).toBe(0);
  });

  it('returns score 0 with parse error when no JSON is present', async () => {
    mocks.mockCreate.mockResolvedValue(claudeResponse('no json here at all'));
    const out = await scoreWithAi(pool, market, safety, loadConfig());
    expect(out.score).toBe(0);
    expect(out.error).toBe('parse error');
  });

  it('returns score 0 with error when the API call throws', async () => {
    mocks.mockCreate.mockRejectedValue(new Error('rate limited'));
    const out = await scoreWithAi(pool, market, safety, loadConfig());
    expect(out.score).toBe(0);
    expect(out.error).toBe('rate limited');
  });
});

// ---------------------------------------------------------------------------
// analyzeToken (integration of the three stages)
// ---------------------------------------------------------------------------

describe('analyzeToken', () => {
  function mockAllOk(score: number) {
    mockFetchJson({
      pairs: [
        {
          baseToken: { address: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', symbol: 'OK' },
          priceUsd: '0.001',
          liquidity: { usd: 20_000, quote: 50 },
        },
      ],
    });
    mocks.mockGetMint.mockResolvedValue({
      mintAuthority: null,
      freezeAuthority: null,
      supply: 1_000_000n * 1_000_000n,
      decimals: 6,
    });
    mocks.mockGetTokenLargestAccounts.mockResolvedValue({
      value: [{ amount: '50000000000' }], // 5% of 1M
    });
    mocks.mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: `{"score": ${score}, "reasoning": "fine"}` }],
    });
  }

  it('returns shouldBuy=true when safety passes and AI clears the threshold', async () => {
    mockAllOk(85);
    const analysis = await analyzeToken(
      fakeConnection(),
      fakePool({ tokenMint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' })
    );
    expect(analysis.shouldBuy).toBe(true);
    expect(analysis.ai.score).toBe(85);
    expect(analysis.rejectionReason).toBeNull();
  });

  it('rejects when AI score is below threshold', async () => {
    mockAllOk(50);
    const analysis = await analyzeToken(
      fakeConnection(),
      fakePool({ tokenMint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' })
    );
    expect(analysis.shouldBuy).toBe(false);
    expect(analysis.rejectionReason).toMatch(/ai score 50/);
  });

  it('rejects on safety failure and skips the AI call', async () => {
    mockFetchJson({
      pairs: [
        {
          baseToken: { address: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' },
          liquidity: { usd: 100, quote: 0.5 }, // way below min
        },
      ],
    });
    mocks.mockGetMint.mockResolvedValue({
      mintAuthority: null,
      freezeAuthority: null,
      supply: 1_000_000n * 1_000_000n,
      decimals: 6,
    });
    mocks.mockGetTokenLargestAccounts.mockResolvedValue({
      value: [{ amount: '50000000000' }],
    });

    const analysis = await analyzeToken(
      fakeConnection(),
      fakePool({ tokenMint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' })
    );
    expect(analysis.shouldBuy).toBe(false);
    expect(analysis.rejectionReason).toMatch(/safety/);
    expect(mocks.mockCreate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Pump.fun source specifics
// ---------------------------------------------------------------------------

describe('pump source', () => {
  const VALID_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

  beforeEach(() => {
    process.env.SOURCE = 'pump';
    resetConfigCache();
  });

  it('pumpMarketData returns the bonding-curve initial price, not DexScreener', () => {
    const md = pumpMarketData(fakePool({ initialLiquiditySol: 0.3 }));
    expect(md.source).toBe('pump-curve');
    expect(md.priceSol).toBe(PUMP_INITIAL_PRICE_SOL);
    expect(md.liquiditySol).toBe(0.3);
    expect(md.supply).toBe(1_000_000_000);
  });

  it('runSafetyChecks skips holder distribution and min liquidity for pump source', async () => {
    // The bonding curve PDA holds 100% of supply at t=0 — Raydium defaults
    // would reject this, pump must tolerate it. We also can't call
    // getTokenLargestAccounts at all because the RPC rejects Token-2022
    // mints as "not a Token mint".
    mocks.mockGetMint.mockResolvedValue({
      mintAuthority: null,
      freezeAuthority: null,
      supply: 1_000_000n * 1_000_000n,
      decimals: 6,
    });
    const result = await runSafetyChecks(fakeConnection(), VALID_MINT, 50, loadConfig());
    expect(result.passed).toBe(true);
    expect(result.failures).toEqual([]);
    expect(mocks.mockGetTokenLargestAccounts).not.toHaveBeenCalled();
  });

  it('analyzeToken uses pump market data and skips DexScreener entirely', async () => {
    mocks.mockGetMint.mockResolvedValue({
      mintAuthority: null,
      freezeAuthority: null,
      supply: 1_000_000n * 1_000_000n,
      decimals: 6,
    });
    mocks.mockGetTokenLargestAccounts.mockResolvedValue({
      value: [{ amount: '1000000000000' }],
    });
    mocks.mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: '{"score": 80, "reasoning": "pump"}' }],
    });

    const analysis = await analyzeToken(fakeConnection(), fakePool({ tokenMint: VALID_MINT }));
    expect(analysis.market.source).toBe('pump-curve');
    expect(analysis.shouldBuy).toBe(true);
    expect(analysis.ai.score).toBe(80);
    expect(mocks.mockFetch).not.toHaveBeenCalled();
  });
});
