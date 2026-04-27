import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const mocks = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockSellToken: vi.fn(),
}));

vi.mock('node-fetch', () => ({ default: mocks.mockFetch }));

vi.mock('../src/trader', () => ({
  sellToken: mocks.mockSellToken,
}));

import { resetConfigCache } from '../src/config';
import {
  closeDb,
  createPosition,
  getPosition,
  getTradesForPosition,
  recordTrade,
} from '../src/db';
import {
  checkPosition,
  executeStopLoss,
  executeTakeProfit,
  fetchPriceSol,
} from '../src/positions';

let tempDir: string;

const MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'miper-pos-'));
  process.env.DB_PATH = path.join(tempDir, 'test.db');
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  process.env.OPENAI_API_KEY = 'sk-openai-test';  process.env.WALLET_PRIVATE_KEY = '';
  process.env.SIMULATE = 'true';
  process.env.LOG_LEVEL = 'error';
  process.env.TAKE_PROFIT_1 = '2';
  process.env.TAKE_PROFIT_2 = '3';
  process.env.TAKE_PROFIT_3 = '5';
  process.env.SELL_PCT_TP1 = '40';
  process.env.SELL_PCT_TP2 = '30';
  process.env.SELL_PCT_TP3 = '30';
  process.env.STOP_LOSS = '0.4';
  delete process.env.SOURCE;
  delete process.env.EXIT_MODE;
  delete process.env.EXIT_AT_MULT;
  resetConfigCache();
  mocks.mockFetch.mockReset();
  mocks.mockSellToken.mockReset();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function mkPosition(opts: {
  entryPriceSol?: number;
  amountTokens?: number;
  tokenMint?: string;
  poolAddress?: string;
} = {}) {
  const p = createPosition({
    tokenMint: opts.tokenMint ?? MINT,
    tokenSymbol: 'AAA',
    entryPriceSol: opts.entryPriceSol ?? 0.0001,
    amountTokens: opts.amountTokens ?? 1_000_000,
    amountSolSpent: 0.05,
    aiScore: 80,
    poolAddress: opts.poolAddress ?? 'POOL',
    entryTx: 'TX',
  });
  // Record the buy so executeTakeProfit can derive original bag size.
  recordTrade({
    positionId: p.id,
    type: 'buy',
    amountTokens: opts.amountTokens ?? 1_000_000,
    amountSol: 0.05,
    priceSol: opts.entryPriceSol ?? 0.0001,
    txSignature: 'TX',
    simulated: true,
  });
  return p;
}

function mockSellSuccess(solOut: number, pricePerToken: number) {
  mocks.mockSellToken.mockResolvedValueOnce({
    success: true,
    txSignature: 'SIM-1',
    amountIn: 0,
    amountOut: solOut,
    pricePerToken,
    simulated: true,
  });
}

function mockSellFailure(error = 'pool drained') {
  mocks.mockSellToken.mockResolvedValueOnce({
    success: false,
    txSignature: '',
    amountIn: 0,
    amountOut: 0,
    pricePerToken: 0,
    simulated: true,
    error,
  });
}

function mockPriceFetch(priceSol: number, mint = MINT) {
  mocks.mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({
      pairs: [{ baseToken: { address: mint }, priceNative: String(priceSol) }],
    }),
    text: async () => '',
  });
}

// ---------------------------------------------------------------------------
// fetchPriceSol
// ---------------------------------------------------------------------------

describe('fetchPriceSol', () => {
  it('returns the priceNative as a number', async () => {
    mockPriceFetch(0.00012, 'A1111111111111111111111111111111111111111112');
    const price = await fetchPriceSol('A1111111111111111111111111111111111111111112');
    expect(price).toBe(0.00012);
  });

  it('returns null when no pair is returned', async () => {
    mocks.mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ pairs: [] }),
      text: async () => '',
    });
    expect(await fetchPriceSol('B1111111111111111111111111111111111111111112')).toBeNull();
  });

  it('returns null when fetch throws', async () => {
    mocks.mockFetch.mockRejectedValueOnce(new Error('network'));
    expect(await fetchPriceSol('C1111111111111111111111111111111111111111112')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// fetchPositionPriceSol -- per-source price oracle dispatch
// ---------------------------------------------------------------------------

describe('fetchPositionPriceSol', () => {
  // Build a fake bonding curve account buffer for the connection mock.
  function buildCurveBuffer(virtualSolLamports: bigint, virtualTokens: bigint): Buffer {
    const buf = Buffer.alloc(8 + 5 * 8 + 1);
    let offset = 8;
    buf.writeBigUInt64LE(virtualTokens, offset); offset += 8;
    buf.writeBigUInt64LE(virtualSolLamports, offset); offset += 8;
    buf.writeBigUInt64LE(0n, offset); offset += 8;
    buf.writeBigUInt64LE(0n, offset); offset += 8;
    buf.writeBigUInt64LE(0n, offset); offset += 8;
    buf[offset] = 0;
    return buf;
  }

  it('reads the bonding curve when source=pump and the position has a pool address', async () => {
    process.env.SOURCE = 'pump';
    resetConfigCache();
    const { loadConfig } = await import('../src/config');
    const { fetchPositionPriceSol } = await import('../src/positions');

    const conn = {
      getAccountInfo: vi.fn().mockResolvedValue({
        data: buildCurveBuffer(60n * 1_000_000_000n, 1_073_000_000n * 1_000_000n),
      }),
    } as any;
    const p = mkPosition({ poolAddress: 'So11111111111111111111111111111111111111112' });
    const price = await fetchPositionPriceSol(p, loadConfig(), conn);
    // Doubled virtual SOL → 2× the launch price.
    expect(price).toBeCloseTo(2 * (30 / 1_073_000_000), 12);
    expect(conn.getAccountInfo).toHaveBeenCalledTimes(1);
    expect(mocks.mockFetch).not.toHaveBeenCalled();
  });

  it('falls back to DexScreener when the bonding curve has graduated', async () => {
    process.env.SOURCE = 'pump';
    resetConfigCache();
    const { loadConfig } = await import('../src/config');
    const { fetchPositionPriceSol } = await import('../src/positions');

    const completedBuf = (() => {
      const b = buildCurveBuffer(60n * 1_000_000_000n, 1_073_000_000n * 1_000_000n);
      b[b.length - 1] = 1; // complete=true
      return b;
    })();
    const conn = {
      getAccountInfo: vi.fn().mockResolvedValue({ data: completedBuf }),
    } as any;
    mockPriceFetch(0.00099, MINT);
    const p = mkPosition({ poolAddress: 'So11111111111111111111111111111111111111112' });
    const price = await fetchPositionPriceSol(p, loadConfig(), conn);
    expect(price).toBe(0.00099);
    expect(conn.getAccountInfo).toHaveBeenCalledTimes(1);
    expect(mocks.mockFetch).toHaveBeenCalledTimes(1);
  });

  it('uses DexScreener for raydium positions (no bonding curve)', async () => {
    process.env.SOURCE = 'raydium';
    resetConfigCache();
    const { loadConfig } = await import('../src/config');
    const { fetchPositionPriceSol } = await import('../src/positions');

    const conn = { getAccountInfo: vi.fn() } as any;
    mockPriceFetch(0.00007, MINT);
    const p = mkPosition();
    const price = await fetchPositionPriceSol(p, loadConfig(), conn);
    expect(price).toBe(0.00007);
    expect(conn.getAccountInfo).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// executeTakeProfit -- the TP sizing math
// ---------------------------------------------------------------------------

describe('executeTakeProfit', () => {
  it('TP1 sells 40% of the original bag and marks position as partial', async () => {
    const p = mkPosition({ amountTokens: 1_000_000 });
    mockSellSuccess(0.04, 0.0002);
    await executeTakeProfit(p, 1);

    const sellCall = mocks.mockSellToken.mock.calls[0];
    expect(sellCall[1]).toBeCloseTo(400_000); // 40% of 1M

    const updated = getPosition(p.id)!;
    expect(updated.tp_level).toBe(1);
    expect(updated.status).toBe('partial');
    expect(updated.amount_tokens).toBeCloseTo(600_000);
    expect(updated.amount_sol_received).toBeCloseTo(0.04);
  });

  it('TP2 sells 30% of the original bag (not 30% of remaining)', async () => {
    const p = mkPosition({ amountTokens: 1_000_000 });
    // Simulate that TP1 already fired
    p.amount_tokens = 600_000;
    p.tp_level = 1;
    p.status = 'partial';
    p.amount_sol_received = 0.04;
    // Persist that state by calling the same DB update path the real code uses
    const { updatePosition } = await import('../src/db');
    updatePosition(p.id, {
      amountTokens: 600_000,
      tpLevel: 1,
      status: 'partial',
      amountSolReceived: 0.04,
    });
    recordTrade({
      positionId: p.id,
      type: 'sell',
      amountTokens: 400_000,
      amountSol: 0.04,
      priceSol: 0.0001,
      txSignature: 'sim',
      simulated: true,
    });

    const fresh = getPosition(p.id)!;
    mockSellSuccess(0.06, 0.0003);
    await executeTakeProfit(fresh, 2);

    const sellCall = mocks.mockSellToken.mock.calls[0];
    expect(sellCall[1]).toBeCloseTo(300_000); // 30% of original 1M

    const updated = getPosition(p.id)!;
    expect(updated.tp_level).toBe(2);
    expect(updated.amount_tokens).toBeCloseTo(300_000);
  });

  it('TP3 sells all remaining tokens and closes the position', async () => {
    const p = mkPosition({ amountTokens: 1_000_000 });
    // Pretend TP1 and TP2 already happened, leaving 300k
    const { updatePosition } = await import('../src/db');
    updatePosition(p.id, { amountTokens: 300_000, tpLevel: 2, status: 'partial' });

    const fresh = getPosition(p.id)!;
    mockSellSuccess(0.15, 0.0005);
    await executeTakeProfit(fresh, 3);

    const sellCall = mocks.mockSellToken.mock.calls[0];
    expect(sellCall[1]).toBeCloseTo(300_000); // all remaining

    const closed = getPosition(p.id)!;
    expect(closed.status).toBe('closed');
    expect(closed.tp_level).toBe(3);
    expect(closed.amount_tokens).toBe(0);
  });

  it('does not advance tp_level when the sell fails', async () => {
    const p = mkPosition();
    mockSellFailure('liquidity vanished');
    await executeTakeProfit(p, 1);

    const updated = getPosition(p.id)!;
    expect(updated.tp_level).toBe(0);
    expect(updated.status).toBe('open');
    expect(updated.amount_tokens).toBeCloseTo(1_000_000); // unchanged
  });
});

// ---------------------------------------------------------------------------
// executeStopLoss
// ---------------------------------------------------------------------------

describe('executeStopLoss', () => {
  it('sells everything and marks the position as stopped', async () => {
    const p = mkPosition();
    mockSellSuccess(0.02, 0.00002);
    await executeStopLoss(p);

    const sellCall = mocks.mockSellToken.mock.calls[0];
    expect(sellCall[1]).toBeCloseTo(1_000_000);

    const updated = getPosition(p.id)!;
    expect(updated.status).toBe('stopped');
    expect(updated.amount_tokens).toBe(0);
    expect(updated.amount_sol_received).toBeCloseTo(0.02);
  });

  it('passes the position current price as a hint to sellToken', async () => {
    // Without this hint, paper-mode pump sells fall back to the bonding-curve
    // init price and book every exit at entry — fake breakeven on every
    // position. We rely on positions.ts threading current_price_sol through.
    const p = mkPosition({ entryPriceSol: 0.0001 });
    mockSellSuccess(0.015, 0.00003);
    await executeStopLoss(getPosition(p.id)!);
    const sellCall = mocks.mockSellToken.mock.calls[0];
    expect(sellCall[3]).toBe(0.0001); // mkPosition's seeded current_price_sol
  });

  it('leaves the position open when the sell fails', async () => {
    const p = mkPosition();
    mockSellFailure();
    await executeStopLoss(p);

    const updated = getPosition(p.id)!;
    expect(updated.status).toBe('open');
    expect(updated.amount_tokens).toBeCloseTo(1_000_000);
  });
});

// ---------------------------------------------------------------------------
// checkPosition -- the decision logic
// ---------------------------------------------------------------------------

describe('checkPosition', () => {
  it('triggers a stop-loss when price drops below SL multiplier', async () => {
    const p = mkPosition({ entryPriceSol: 0.0001 });
    mockPriceFetch(0.00003); // 0.3x entry, below 0.4 SL
    mockSellSuccess(0.015, 0.00003);
    await checkPosition(p);

    expect(mocks.mockSellToken).toHaveBeenCalledTimes(1);
    expect(getPosition(p.id)!.status).toBe('stopped');
  });

  it('passes the freshly-observed price to sellToken (not the stale tick-start value)', async () => {
    // Regression: when a TP triggers on the first successful price fetch,
    // the in-memory position.current_price_sol still equals entry. We must
    // refresh it before downstream sells, otherwise pump paper exits book
    // at zero PnL despite a real TP/SL multiplier firing.
    const p = mkPosition({ entryPriceSol: 0.0001 });
    expect(p.current_price_sol).toBe(0.0001); // sanity: starts at entry
    mockPriceFetch(0.00055); // 5.5x → triggers TP3
    mockSellSuccess(0.55, 0.00055);
    await checkPosition(p);

    const sellCall = mocks.mockSellToken.mock.calls[0];
    expect(sellCall[3]).toBe(0.00055);
  });

  it('triggers TP1 when price reaches 2x and tp_level is 0', async () => {
    const p = mkPosition({ entryPriceSol: 0.0001 });
    mockPriceFetch(0.00021); // > 2x
    mockSellSuccess(0.04, 0.00021);
    await checkPosition(p);

    expect(getPosition(p.id)!.tp_level).toBe(1);
  });

  it('all-in mode: full exit at EXIT_AT_MULT, ignores tiered TP levels', async () => {
    process.env.EXIT_MODE = 'all-in';
    process.env.EXIT_AT_MULT = '2';
    resetConfigCache();
    const p = mkPosition({ entryPriceSol: 0.0001 });
    mockPriceFetch(0.00021); // 2.1x — clears all-in target
    mockSellSuccess(0.105, 0.00021);
    await checkPosition(p);

    // All-in fires once and closes the position fully — not partial.
    const updated = getPosition(p.id)!;
    expect(updated.status).toBe('closed');
    expect(updated.amount_tokens).toBe(0);
    expect(updated.tp_level).toBe(3);
    expect(mocks.mockSellToken).toHaveBeenCalledTimes(1);
    // Should sell the full bag, not the 40% TP1 tranche.
    const sellArgs = mocks.mockSellToken.mock.calls[0];
    expect(sellArgs[1]).toBeCloseTo(1_000_000);
  });

  it('all-in mode: holds when multiplier is below EXIT_AT_MULT', async () => {
    process.env.EXIT_MODE = 'all-in';
    process.env.EXIT_AT_MULT = '5';
    resetConfigCache();
    const p = mkPosition({ entryPriceSol: 0.0001 });
    mockPriceFetch(0.00025); // 2.5x — well above tiered TP1 but under all-in 5x target
    await checkPosition(p);

    expect(mocks.mockSellToken).not.toHaveBeenCalled();
    expect(getPosition(p.id)!.status).toBe('open');
  });

  it('all-in mode: stop-loss still fires independently of EXIT_AT_MULT', async () => {
    process.env.EXIT_MODE = 'all-in';
    process.env.EXIT_AT_MULT = '5';
    resetConfigCache();
    const p = mkPosition({ entryPriceSol: 0.0001 });
    mockPriceFetch(0.00003); // 0.3x → SL
    mockSellSuccess(0.015, 0.00003);
    await checkPosition(p);

    expect(getPosition(p.id)!.status).toBe('stopped');
  });

  it('skips TP triggers when current price is null', async () => {
    const p = mkPosition();
    mocks.mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ pairs: [] }),
      text: async () => '',
    });
    await checkPosition(p);
    expect(mocks.mockSellToken).not.toHaveBeenCalled();
    // Status untouched
    expect(getPosition(p.id)!.status).toBe('open');
  });

  it('jumps directly to TP3 when price multiplier exceeds the highest target', async () => {
    const p = mkPosition({ entryPriceSol: 0.0001 });
    mockPriceFetch(0.001); // 10x, way past TP3 (5x)
    mockSellSuccess(0.5, 0.001);
    await checkPosition(p);

    const closed = getPosition(p.id)!;
    expect(closed.tp_level).toBe(3);
    expect(closed.status).toBe('closed');
  });

  it('closes a dust position without trying to sell', async () => {
    const p = mkPosition({ amountTokens: 1, entryPriceSol: 1e-20 });
    mockPriceFetch(1e-20);
    await checkPosition(p);
    expect(mocks.mockSellToken).not.toHaveBeenCalled();
    expect(getPosition(p.id)!.status).toBe('closed');
  });
});

// ---------------------------------------------------------------------------
// retry behavior on repeated sell failures
// ---------------------------------------------------------------------------

describe('sell failure retries', () => {
  it('keeps the position open through repeated failures', async () => {
    const p = mkPosition();
    for (let i = 0; i < 3; i++) {
      mockSellFailure();
      await executeStopLoss(getPosition(p.id)!);
    }
    expect(mocks.mockSellToken).toHaveBeenCalledTimes(3);
    expect(getPosition(p.id)!.status).toBe('open');
    expect(getPosition(p.id)!.amount_tokens).toBeCloseTo(1_000_000);
  });
});

// ---------------------------------------------------------------------------
// trade record side effects
// ---------------------------------------------------------------------------

describe('trade recording', () => {
  it('records a sell trade for each successful TP', async () => {
    const p = mkPosition();
    mockSellSuccess(0.04, 0.0002);
    await executeTakeProfit(p, 1);

    const trades = getTradesForPosition(p.id);
    const sells = trades.filter((t) => t.type === 'sell');
    expect(sells).toHaveLength(1);
    expect(sells[0].amount_sol).toBeCloseTo(0.04);
  });
});
