import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const mocks = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockSellToken: vi.fn(),
  mockGetTokenBalance: vi.fn(),
}));

vi.mock('node-fetch', () => ({ default: mocks.mockFetch }));

vi.mock('../src/trader', () => ({
  sellToken: mocks.mockSellToken,
  getTokenBalance: mocks.mockGetTokenBalance,
}));

import { resetConfigCache } from '../src/config';
import {
  closeDb,
  createPosition,
  getDb,
  getPosition,
  getTradesForPosition,
  recordTrade,
  updatePosition,
} from '../src/db';
import {
  TIME_EXIT_TP_LEVEL,
  checkPosition,
  clearGraduatedCurves,
  clearPeakPrices,
  clearSellLocks,
  closeAllOpenPositions,
  executeAllInExit,
  executeStopLoss,
  executeTakeProfit,
  executeTimeExit,
  fetchPriceSol,
  isPastHoldLimit,
  positionAgeMinutes,
  shouldRideThroughLeaderExit,
} from '../src/positions';
import { loadConfig } from '../src/config';
import { clearBondingCurveCache } from '../src/bondingCurve';
import { logger } from '../src/logger';

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
  delete process.env.TRAILING_TP_ARM_MULT;
  delete process.env.TRAILING_TP_DROP_PCT;
  resetConfigCache();
  clearGraduatedCurves();
  clearSellLocks();
  clearPeakPrices();
  clearBondingCurveCache();
  mocks.mockFetch.mockReset();
  mocks.mockSellToken.mockReset();
  mocks.mockGetTokenBalance.mockReset();
  mocks.mockGetTokenBalance.mockResolvedValue(0);
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

  it('skips the bonding curve RPC after the first graduated reading', async () => {
    process.env.SOURCE = 'pump';
    resetConfigCache();
    const { loadConfig } = await import('../src/config');
    const { fetchPositionPriceSol } = await import('../src/positions');

    const completedBuf = (() => {
      const b = buildCurveBuffer(60n * 1_000_000_000n, 1_073_000_000n * 1_000_000n);
      b[b.length - 1] = 1;
      return b;
    })();
    const conn = {
      getAccountInfo: vi.fn().mockResolvedValue({ data: completedBuf }),
    } as any;
    mockPriceFetch(0.00099, MINT);
    mockPriceFetch(0.00099, MINT);
    const p = mkPosition({ poolAddress: 'So11111111111111111111111111111111111111112' });

    await fetchPositionPriceSol(p, loadConfig(), conn);
    await fetchPositionPriceSol(p, loadConfig(), conn);

    expect(conn.getAccountInfo).toHaveBeenCalledTimes(1);
    expect(mocks.mockFetch).toHaveBeenCalledTimes(2);
  });

  it('does NOT cache as graduated on transient RPC failure (R11 regression)', async () => {
    // R11 bug: a single ~600ms RPC blip flipped 48/50 open positions to
    // "graduated" forever and the bot never exited any of them. A throw
    // from getAccountInfo must not poison the cache — the next tick has to
    // hit the curve again and return a real price.
    process.env.SOURCE = 'pump';
    resetConfigCache();
    const { loadConfig } = await import('../src/config');
    const { fetchPositionPriceSol } = await import('../src/positions');

    const liveBuf = buildCurveBuffer(
      60n * 1_000_000_000n,
      1_073_000_000n * 1_000_000n
    );
    const conn = {
      getAccountInfo: vi
        .fn()
        .mockRejectedValueOnce(new Error('rpc down'))
        .mockResolvedValueOnce({ data: liveBuf }),
    } as any;
    mockPriceFetch(0.00099, MINT);
    const p = mkPosition({ poolAddress: 'So11111111111111111111111111111111111111112' });

    const first = await fetchPositionPriceSol(p, loadConfig(), conn);
    expect(first).toBe(0.00099);

    const second = await fetchPositionPriceSol(p, loadConfig(), conn);
    expect(second).toBeCloseTo(2 * (30 / 1_073_000_000), 12);

    expect(conn.getAccountInfo).toHaveBeenCalledTimes(2);
  });

  it('does NOT cache as graduated when account info is missing', async () => {
    // Same idea as the R11 regression but for the !info?.data branch —
    // an RPC that returns null without throwing also means "not right now"
    // not "permanently graduated".
    process.env.SOURCE = 'pump';
    resetConfigCache();
    const { loadConfig } = await import('../src/config');
    const { fetchPositionPriceSol } = await import('../src/positions');

    const liveBuf = buildCurveBuffer(
      60n * 1_000_000_000n,
      1_073_000_000n * 1_000_000n
    );
    const conn = {
      getAccountInfo: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ data: liveBuf }),
    } as any;
    mockPriceFetch(0.00099, MINT);
    const p = mkPosition({ poolAddress: 'So11111111111111111111111111111111111111112' });

    await fetchPositionPriceSol(p, loadConfig(), conn);
    const second = await fetchPositionPriceSol(p, loadConfig(), conn);

    expect(second).toBeCloseTo(2 * (30 / 1_073_000_000), 12);
    expect(conn.getAccountInfo).toHaveBeenCalledTimes(2);
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

  it('keeps the position open through repeated sell failures (no false write-off)', async () => {
    // A run of failed sells (transient mayhem flip, missed venue, dead route)
    // must NOT abandon the position: the block can clear and a later tick can
    // still land the sell, or the user can exit by hand. Booking a loss here
    // would throw away a recoverable position.
    const p = mkPosition();
    mockSellFailure('Transaction failed: {"InstructionError":[3,{"Custom":6024}]}');
    mockSellFailure('Transaction failed: {"InstructionError":[3,{"Custom":6024}]}');
    mockSellFailure('Transaction failed: {"InstructionError":[3,{"Custom":6024}]}');
    await executeStopLoss(p);
    await executeStopLoss(getPosition(p.id)!);
    await executeStopLoss(getPosition(p.id)!);

    const updated = getPosition(p.id)!;
    expect(updated.status).toBe('open');
    expect(updated.amount_tokens).toBeCloseTo(1_000_000);
    expect(mocks.mockSellToken).toHaveBeenCalledTimes(3);
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

  // Backdates a position's created_at by `minutes`. SQLite stores
  // datetime('now') as UTC text; we write the same format.
  function agePositionByMinutes(positionId: number, minutes: number): void {
    const past = new Date(Date.now() - minutes * 60_000);
    const iso = past.toISOString().replace('T', ' ').slice(0, 19);
    getDb().prepare('UPDATE positions SET created_at = ? WHERE id = ?').run(iso, positionId);
  }

  it('time-exit fires when MAX_HOLD_MINUTES has elapsed and TP/SL did not trigger', async () => {
    process.env.MAX_HOLD_MINUTES = '30';
    resetConfigCache();
    const p = mkPosition({ entryPriceSol: 0.0001 });
    agePositionByMinutes(p.id, 31);
    const aged = getPosition(p.id)!;
    mockPriceFetch(0.00012); // 1.2x — between SL (0.4x) and TP1 (2x)
    mockSellSuccess(0.06, 0.00012);
    await checkPosition(aged);

    const closed = getPosition(p.id)!;
    expect(closed.status).toBe('closed');
    expect(closed.tp_level).toBe(TIME_EXIT_TP_LEVEL);
    expect(closed.amount_tokens).toBe(0);
    expect(mocks.mockSellToken).toHaveBeenCalledTimes(1);
  });

  it('does NOT time-exit when MAX_HOLD_MINUTES=0 (default disabled)', async () => {
    delete process.env.MAX_HOLD_MINUTES;
    resetConfigCache();
    const p = mkPosition({ entryPriceSol: 0.0001 });
    agePositionByMinutes(p.id, 60 * 24); // a day old
    const aged = getPosition(p.id)!;
    mockPriceFetch(0.00012);
    await checkPosition(aged);

    expect(mocks.mockSellToken).not.toHaveBeenCalled();
    expect(getPosition(p.id)!.status).toBe('open');
  });

  it('does NOT time-exit when position is younger than MAX_HOLD_MINUTES', async () => {
    process.env.MAX_HOLD_MINUTES = '30';
    resetConfigCache();
    const p = mkPosition({ entryPriceSol: 0.0001 });
    // Fresh position — its default created_at is "now". Don't age it.
    mockPriceFetch(0.00012);
    await checkPosition(p);

    expect(mocks.mockSellToken).not.toHaveBeenCalled();
    expect(getPosition(p.id)!.status).toBe('open');
  });

  it('TP3 takes precedence over time-exit when both conditions hold', async () => {
    process.env.MAX_HOLD_MINUTES = '30';
    resetConfigCache();
    const p = mkPosition({ entryPriceSol: 0.0001 });
    agePositionByMinutes(p.id, 60); // past the limit
    const aged = getPosition(p.id)!;
    mockPriceFetch(0.001); // 10x — TP3 territory
    mockSellSuccess(0.5, 0.001);
    await checkPosition(aged);

    const closed = getPosition(p.id)!;
    expect(closed.status).toBe('closed');
    expect(closed.tp_level).toBe(3); // real TP3, not time-exit sentinel
  });

  it('SL takes precedence over time-exit when both conditions hold', async () => {
    process.env.MAX_HOLD_MINUTES = '30';
    resetConfigCache();
    const p = mkPosition({ entryPriceSol: 0.0001 });
    agePositionByMinutes(p.id, 60);
    const aged = getPosition(p.id)!;
    mockPriceFetch(0.00003); // 0.3x — SL territory
    mockSellSuccess(0.015, 0.00003);
    await checkPosition(aged);

    const updated = getPosition(p.id)!;
    expect(updated.status).toBe('stopped');
  });
});

describe('trailing take-profit', () => {
  function enableTrailing(armMult = 1.5, dropPct = 0.25) {
    // Isolate trailing as the only profit exit (matches prod: all-in @ a high
    // mult + trailing), so tiered TP levels don't fire first and mask it.
    process.env.EXIT_MODE = 'all-in';
    process.env.EXIT_AT_MULT = '100';
    process.env.TRAILING_TP_ARM_MULT = String(armMult);
    process.env.TRAILING_TP_DROP_PCT = String(dropPct);
    resetConfigCache();
  }

  it('exits the full bag when an armed runner falls below its trailing peak', async () => {
    enableTrailing(1.5, 0.25);
    const p = mkPosition({ entryPriceSol: 0.0001 });
    // Tick 1: runs to 1.8x — arms (>=1.5x) and records the peak. No exit yet.
    mockPriceFetch(0.00018);
    await checkPosition(p);
    expect(mocks.mockSellToken).not.toHaveBeenCalled();
    expect(getPosition(p.id)!.status).toBe('open');

    // Tick 2: fades to 1.3x, below peak(1.8) * (1 - 0.25) = 1.35x -> trail exit.
    mockPriceFetch(0.00013);
    mockSellSuccess(0.13, 0.00013);
    await checkPosition(getPosition(p.id)!);

    expect(mocks.mockSellToken).toHaveBeenCalledTimes(1);
    const closed = getPosition(p.id)!;
    expect(closed.status).toBe('closed');
    expect(closed.amount_tokens).toBe(0);
  });

  it('does not trail-exit a position that never armed', async () => {
    enableTrailing(1.5, 0.25);
    const p = mkPosition({ entryPriceSol: 0.0001 });
    // Peaks at 1.3x (below the 1.5x arm), then dips to 1.05x. No trailing exit.
    mockPriceFetch(0.00013);
    await checkPosition(p);
    mockPriceFetch(0.000105);
    await checkPosition(getPosition(p.id)!);

    expect(mocks.mockSellToken).not.toHaveBeenCalled();
    expect(getPosition(p.id)!.status).toBe('open');
  });

  it('rides through a leader exit once a tranche is banked, follows out otherwise', () => {
    process.env.TRAILING_TP_DROP_PCT = '0.35';
    process.env.TRAILING_TP_ARM_MULT = '2';
    resetConfigCache();
    const cfg = loadConfig();
    const banked = { ...mkPosition(), tp_level: 1 };
    const unproven = { ...mkPosition(), tp_level: 0 };
    // Proven runner: ride past the leader on the trailing stop.
    expect(shouldRideThroughLeaderExit(banked, cfg)).toBe(true);
    // Never hit 2x: still mirror the leader's exit to cut the loss.
    expect(shouldRideThroughLeaderExit(unproven, cfg)).toBe(false);
  });

  it('always follows the leader out when trailing is disabled', () => {
    delete process.env.TRAILING_TP_DROP_PCT;
    resetConfigCache();
    const cfg = loadConfig();
    const banked = { ...mkPosition(), tp_level: 2 };
    expect(shouldRideThroughLeaderExit(banked, cfg)).toBe(false);
  });

  it('rides higher peaks before trailing (does not exit on a shallow dip)', async () => {
    enableTrailing(1.5, 0.25);
    const p = mkPosition({ entryPriceSol: 0.0001 });
    mockPriceFetch(0.00018); // 1.8x, arms, peak 1.8
    await checkPosition(p);
    mockPriceFetch(0.0003); // 3.0x, new peak
    await checkPosition(getPosition(p.id)!);
    mockPriceFetch(0.00025); // 2.5x, only -17% off the 3.0x peak (< 25%) -> hold
    await checkPosition(getPosition(p.id)!);

    expect(mocks.mockSellToken).not.toHaveBeenCalled();
    expect(getPosition(p.id)!.status).toBe('open');
  });
});

describe('positionAgeMinutes', () => {
  it('computes minutes elapsed since created_at (read as UTC)', () => {
    const p = mkPosition();
    p.created_at = '2026-05-15 12:00:00';
    expect(
      positionAgeMinutes(p, new Date('2026-05-15T12:42:00Z'))
    ).toBeCloseTo(42, 5);
  });

  it('returns null when created_at is unparseable', () => {
    const p = mkPosition();
    p.created_at = 'not-a-date';
    expect(positionAgeMinutes(p)).toBeNull();
  });

  it('is a small non-negative number for a freshly created position', () => {
    const age = positionAgeMinutes(mkPosition());
    expect(age).not.toBeNull();
    expect(age!).toBeGreaterThanOrEqual(0);
    expect(age!).toBeLessThan(1);
  });
});

describe('isPastHoldLimit', () => {
  it('returns false when MAX_HOLD_MINUTES is 0 (disabled)', async () => {
    delete process.env.MAX_HOLD_MINUTES;
    resetConfigCache();
    const { loadConfig } = await import('../src/config');
    const p = mkPosition();
    expect(isPastHoldLimit(p, loadConfig())).toBe(false);
  });

  it('returns true when the position is older than the limit', async () => {
    process.env.MAX_HOLD_MINUTES = '30';
    resetConfigCache();
    const { loadConfig } = await import('../src/config');
    const p = mkPosition();
    // Backdate created_at to 31 minutes ago (UTC text format).
    const past = new Date(Date.now() - 31 * 60_000)
      .toISOString()
      .replace('T', ' ')
      .slice(0, 19);
    expect(isPastHoldLimit({ ...p, created_at: past }, loadConfig())).toBe(true);
  });

  it('returns false when the position is younger than the limit', async () => {
    process.env.MAX_HOLD_MINUTES = '30';
    resetConfigCache();
    const { loadConfig } = await import('../src/config');
    const p = mkPosition();
    expect(isPastHoldLimit(p, loadConfig())).toBe(false);
  });
});

describe('executeTimeExit', () => {
  it('sells the full bag at last-known price and marks tp_level=4', async () => {
    process.env.MAX_HOLD_MINUTES = '30';
    resetConfigCache();
    const { loadConfig } = await import('../src/config');
    const p = mkPosition({ entryPriceSol: 0.0001, amountTokens: 1_000_000 });
    updatePosition(p.id, { currentPriceSol: 0.00015 });
    const updated = getPosition(p.id)!;
    mockSellSuccess(0.15, 0.00015);
    await executeTimeExit(updated, loadConfig());

    const closed = getPosition(p.id)!;
    expect(closed.status).toBe('closed');
    expect(closed.tp_level).toBe(TIME_EXIT_TP_LEVEL);
    expect(closed.amount_tokens).toBe(0);
    expect(mocks.mockSellToken).toHaveBeenCalledTimes(1);
    // Full bag, not a partial.
    expect(mocks.mockSellToken.mock.calls[0][1]).toBeCloseTo(1_000_000);
  });

  it('logs the realized fill multiple, not a stale price-oracle reading', async () => {
    // Regression: the exit log read position.current_price_sol (the oracle),
    // which can be stale at exit and misreported (e.g. 0.51x for a 2.85x exit).
    // It must report the booked fill instead. Here the oracle says 0.5x while
    // the actual sale fills at 2x; the log must say 2.00x.
    const p = mkPosition({ entryPriceSol: 0.00000005, amountTokens: 1_000_000 });
    updatePosition(p.id, { currentPriceSol: 0.000000025 }); // stale 0.5x
    const updated = getPosition(p.id)!;
    mockSellSuccess(0.1, 0.0000001); // 0.1 SOL on a 0.05 cost basis = 2x
    const spy = vi.spyOn(logger, 'position');
    await executeTimeExit(updated, loadConfig());

    const call = spy.mock.calls.find((c) => c[0] === 'TIMEOUT');
    expect(call?.[2]).toContain('2.00x');
    expect(call?.[2]).not.toContain('0.50x');
    spy.mockRestore();
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

// ---------------------------------------------------------------------------
// closeAllOpenPositions — graceful shutdown
// ---------------------------------------------------------------------------

describe('closeAllOpenPositions', () => {
  it('returns zeros and is a no-op when nothing is open', async () => {
    const result = await closeAllOpenPositions();
    expect(result).toEqual({ closed: 0, failed: 0 });
    expect(mocks.mockSellToken).not.toHaveBeenCalled();
  });

  it('sells every open and partial position and marks them closed', async () => {
    const a = mkPosition({ tokenMint: 'AAA' });
    const b = mkPosition({ tokenMint: 'BBB' });
    const c = mkPosition({ tokenMint: 'CCC' });
    // Mark one partial; should still be closed by the shutdown sweep.
    updatePosition(b.id, { status: 'partial' });
    // Each call to closeAllOpenPositions does a price refresh per position;
    // mock the priceFetch + sell for all three.
    for (let i = 0; i < 3; i++) mockPriceFetch(0.0002, [a, b, c][i].token_mint);
    mockSellSuccess(0.05, 0.0002);
    mockSellSuccess(0.05, 0.0002);
    mockSellSuccess(0.05, 0.0002);

    const result = await closeAllOpenPositions();
    expect(result.closed).toBe(3);
    expect(result.failed).toBe(0);
    for (const p of [a, b, c]) {
      const updated = getPosition(p.id)!;
      expect(updated.status).toBe('closed');
      expect(updated.amount_tokens).toBe(0);
    }
  });

  it('counts failures separately and continues on a single sell error', async () => {
    const a = mkPosition({ tokenMint: 'AAA' });
    const b = mkPosition({ tokenMint: 'BBB' });
    mockPriceFetch(0.0002, 'AAA');
    mockPriceFetch(0.0002, 'BBB');
    mockSellSuccess(0.05, 0.0002);
    mockSellFailure('liquidity drained');

    const result = await closeAllOpenPositions();
    expect(result.closed).toBe(1);
    expect(result.failed).toBe(1);
    // The successful one is closed; the failed one stays open for review.
    expect(getPosition(a.id)!.status).toBe('closed');
    expect(getPosition(b.id)!.status).toBe('open');
  });

  it('falls back to last-known DB price when refresh hangs, then closes the position', async () => {
    const a = mkPosition({ tokenMint: 'AAA' });
    // Seed a last-known price on the position so the sell has something to use.
    updatePosition(a.id, { currentPriceSol: 0.0003 });
    // Price fetch never resolves — simulates DNS down / hung TCP.
    mocks.mockFetch.mockImplementationOnce(() => new Promise(() => {}));
    mockSellSuccess(0.05, 0.0003);

    const result = await closeAllOpenPositions(undefined, null, 30);

    expect(result.closed).toBe(1);
    expect(result.failed).toBe(0);
    const updated = getPosition(a.id)!;
    expect(updated.status).toBe('closed');
    expect(updated.amount_tokens).toBe(0);
    // Refresh failed, so the DB price stays at the seeded last-known value.
    expect(updated.current_price_sol).toBe(0.0003);
    // Sell still happened with the last-known price as the hint.
    expect(mocks.mockSellToken).toHaveBeenCalledTimes(1);
  });

  it('marks position as failed when the sell itself hangs past the timeout', async () => {
    const a = mkPosition({ tokenMint: 'AAA' });
    mockPriceFetch(0.0002, 'AAA');
    // The sell promise never resolves — e.g. live RPC blocked.
    mocks.mockSellToken.mockImplementationOnce(() => new Promise(() => {}));

    const result = await closeAllOpenPositions(undefined, null, 30);

    expect(result.closed).toBe(0);
    expect(result.failed).toBe(1);
    expect(getPosition(a.id)!.status).toBe('open');
  });
});

describe('per-position sell lock (double-sell guard)', () => {
  it('skips a concurrent second exit on the same position (only one sell tx)', async () => {
    const { loadConfig } = await import('../src/config');
    const p = mkPosition({ amountTokens: 1_000_000 });
    // Slow sell so both exits overlap: the first holds the lock across the await.
    mocks.mockSellToken.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                success: true,
                txSignature: 'SIM-1',
                amountIn: 0,
                amountOut: 0.06,
                pricePerToken: 0.00006,
                simulated: true,
              }),
            15
          )
        )
    );

    await Promise.all([
      executeAllInExit(p, loadConfig()),
      executeAllInExit(p, loadConfig()),
    ]);

    // The lock let only one exit through; the concurrent one was skipped.
    expect(mocks.mockSellToken).toHaveBeenCalledTimes(1);
    expect(getPosition(p.id)!.status).toBe('closed');
  });

  it('bails without selling when the position is already closed', async () => {
    const { loadConfig } = await import('../src/config');
    const p = mkPosition({ amountTokens: 1_000_000 });
    updatePosition(p.id, { status: 'closed', amountTokens: 0 });

    await executeAllInExit(p, loadConfig());

    // Fresh DB re-read inside the lock saw it closed and skipped the sell.
    expect(mocks.mockSellToken).not.toHaveBeenCalled();
  });
});

describe('sell give-up (no infinite fee-burn loop)', () => {
  it('closes the position after repeated failed sells instead of retrying forever', async () => {
    const p = mkPosition({ entryPriceSol: 0.0001, amountTokens: 1_000_000 });
    mocks.mockGetTokenBalance.mockResolvedValue(0); // tokens no longer in wallet
    // 10 failed stop-loss sells = 10 doPartialSell attempts; the cap is 10.
    for (let i = 0; i < 10; i++) {
      mockSellFailure('pump tx failed: {"InstructionError":[3,{"Custom":1}]}');
      await executeStopLoss(getPosition(p.id)!, loadConfig());
    }
    expect(getPosition(p.id)!.status).toBe('closed');
    expect(mocks.mockGetTokenBalance).toHaveBeenCalled();

    // A further tick must NOT submit another sell — the position is closed, so
    // the loop that once burned 1200+ tx fees is over.
    mocks.mockSellToken.mockClear();
    await executeStopLoss(getPosition(p.id)!, loadConfig());
    expect(mocks.mockSellToken).not.toHaveBeenCalled();
  });
});
