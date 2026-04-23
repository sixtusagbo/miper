import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resetConfigCache } from '../src/config';
import {
  closeDb,
  countOpenPositions,
  createPosition,
  getActivityWindow,
  getFinishedPositions,
  getOpenPositions,
  getPnlSummary,
  getPosition,
  getRejectionCount,
  getTopRejectionReasons,
  getTradesForPosition,
  isTokenKnown,
  recordRejection,
  recordTrade,
  updatePosition,
} from '../src/db';

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'miper-db-'));
  process.env.DB_PATH = path.join(tempDir, 'test.db');
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  process.env.WALLET_PRIVATE_KEY = '';
  process.env.SIMULATE = 'true';
  process.env.LOG_LEVEL = 'error';
  resetConfigCache();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function mkPosition(overrides: Partial<Parameters<typeof createPosition>[0]> = {}) {
  return createPosition({
    tokenMint: 'MINT_A',
    tokenSymbol: 'AAA',
    entryPriceSol: 0.0001,
    amountTokens: 1_000_000,
    amountSolSpent: 0.05,
    aiScore: 75,
    poolAddress: 'POOL_A',
    entryTx: 'TX_A',
    ...overrides,
  });
}

describe('db: positions', () => {
  it('creates and retrieves a position', () => {
    const p = mkPosition();
    expect(p.id).toBeGreaterThan(0);
    expect(p.status).toBe('open');
    expect(p.tp_level).toBe(0);
    expect(p.amount_sol_received).toBe(0);

    const fetched = getPosition(p.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.token_mint).toBe('MINT_A');
    expect(fetched!.entry_price_sol).toBe(0.0001);
  });

  it('returns null for missing position', () => {
    expect(getPosition(999)).toBeNull();
  });

  it('updates partial fields without clobbering others', () => {
    const p = mkPosition();
    updatePosition(p.id, { currentPriceSol: 0.00015, status: 'partial', tpLevel: 1 });
    const updated = getPosition(p.id)!;
    expect(updated.current_price_sol).toBe(0.00015);
    expect(updated.status).toBe('partial');
    expect(updated.tp_level).toBe(1);
    expect(updated.amount_tokens).toBe(1_000_000); // untouched
    expect(updated.entry_price_sol).toBe(0.0001); // untouched
  });

  it('lists open and partial positions, excludes closed/stopped', () => {
    const open = mkPosition({ tokenMint: 'MINT_OPEN' });
    const partial = mkPosition({ tokenMint: 'MINT_PARTIAL' });
    updatePosition(partial.id, { status: 'partial' });
    const closed = mkPosition({ tokenMint: 'MINT_CLOSED' });
    updatePosition(closed.id, { status: 'closed' });
    const stopped = mkPosition({ tokenMint: 'MINT_STOPPED' });
    updatePosition(stopped.id, { status: 'stopped' });

    const opens = getOpenPositions();
    expect(opens.map((p) => p.id).sort()).toEqual([open.id, partial.id].sort());
    expect(countOpenPositions()).toBe(2);
  });
});

describe('db: trades', () => {
  it('records trades in insertion order', () => {
    const p = mkPosition();
    recordTrade({
      positionId: p.id,
      type: 'buy',
      amountTokens: 1_000_000,
      amountSol: 0.05,
      priceSol: 0.0001,
      txSignature: 'buy-tx',
      simulated: true,
    });
    recordTrade({
      positionId: p.id,
      type: 'sell',
      amountTokens: 400_000,
      amountSol: 0.08,
      priceSol: 0.0002,
      txSignature: 'sell-tx',
      simulated: true,
    });
    const trades = getTradesForPosition(p.id);
    expect(trades).toHaveLength(2);
    expect(trades[0].type).toBe('buy');
    expect(trades[1].type).toBe('sell');
    expect(trades[0].simulated).toBe(1);
  });
});

describe('db: rejections and isTokenKnown', () => {
  it('returns true for a mint with an open position', () => {
    mkPosition({ tokenMint: 'MINT_POSITION' });
    expect(isTokenKnown('MINT_POSITION')).toBe(true);
  });

  it('returns true for a mint in rejected_tokens', () => {
    recordRejection({
      tokenMint: 'MINT_REJECTED',
      reason: 'safety failed',
      aiScore: 10,
      poolAddress: 'POOL',
    });
    expect(isTokenKnown('MINT_REJECTED')).toBe(true);
  });

  it('returns false for an unknown mint', () => {
    expect(isTokenKnown('UNSEEN_MINT')).toBe(false);
  });
});

describe('db: PnL summary', () => {
  it('computes spent, received, realized PnL, and win rate', () => {
    // Winner: spent 0.05, received 0.10
    const winner = mkPosition({ tokenMint: 'W', amountSolSpent: 0.05 });
    updatePosition(winner.id, { status: 'closed', amountSolReceived: 0.1 });

    // Loser: spent 0.05, received 0.02
    const loser = mkPosition({ tokenMint: 'L', amountSolSpent: 0.05 });
    updatePosition(loser.id, { status: 'stopped', amountSolReceived: 0.02 });

    // Open: spent 0.05, no receipt yet
    mkPosition({ tokenMint: 'O', amountSolSpent: 0.05 });

    const pnl = getPnlSummary();
    expect(pnl.totalSpent).toBeCloseTo(0.15);
    expect(pnl.totalReceived).toBeCloseTo(0.12);
    expect(pnl.realizedPnlSol).toBeCloseTo(-0.03);
    expect(pnl.openCount).toBe(1);
    expect(pnl.closedCount).toBe(1);
    expect(pnl.stoppedCount).toBe(1);
    expect(pnl.winRate).toBeCloseTo(0.5); // 1 win out of 2 finished
  });

  it('returns zero win rate when no positions are finished', () => {
    mkPosition();
    const pnl = getPnlSummary();
    expect(pnl.winRate).toBe(0);
    expect(pnl.openCount).toBe(1);
  });
});

describe('db: review helpers', () => {
  it('getFinishedPositions sorts by pnl descending and skips open positions', () => {
    const big = mkPosition({ tokenMint: 'BIG', amountSolSpent: 0.05 });
    updatePosition(big.id, { status: 'closed', amountSolReceived: 0.25 }); // +0.20

    const mid = mkPosition({ tokenMint: 'MID', amountSolSpent: 0.05 });
    updatePosition(mid.id, { status: 'closed', amountSolReceived: 0.08 }); // +0.03

    const loser = mkPosition({ tokenMint: 'LOSER', amountSolSpent: 0.05 });
    updatePosition(loser.id, { status: 'stopped', amountSolReceived: 0.02 }); // -0.03

    mkPosition({ tokenMint: 'OPEN' }); // still open — must not appear

    const finished = getFinishedPositions();
    expect(finished.map((p) => p.token_mint)).toEqual(['BIG', 'MID', 'LOSER']);
    expect(finished[0].pnl_sol).toBeCloseTo(0.2);
    expect(finished[0].multiplier).toBeCloseTo(5);
    expect(finished[2].pnl_sol).toBeCloseTo(-0.03);
  });

  it('getTopRejectionReasons groups by reason and ranks by count', () => {
    const rej = (reason: string, mint: string) =>
      recordRejection({ tokenMint: mint, reason, aiScore: null, poolAddress: null });
    rej('safety: top holder 95%', 'A');
    rej('safety: top holder 95%', 'B');
    rej('safety: top holder 95%', 'C');
    rej('safety: liquidity low', 'D');
    rej('ai score too low', 'E');
    rej('ai score too low', 'F');

    const top = getTopRejectionReasons(10);
    expect(top[0]).toEqual({ reason: 'safety: top holder 95%', count: 3 });
    expect(top[1]).toEqual({ reason: 'ai score too low', count: 2 });
    expect(top[2]).toEqual({ reason: 'safety: liquidity low', count: 1 });
    expect(getRejectionCount()).toBe(6);
  });

  it('getActivityWindow spans both positions and rejections', () => {
    mkPosition();
    recordRejection({
      tokenMint: 'REJ',
      reason: 'safety',
      aiScore: null,
      poolAddress: null,
    });
    const w = getActivityWindow();
    expect(w.first).not.toBeNull();
    expect(w.last).not.toBeNull();
    // first <= last
    expect((w.first ?? '') <= (w.last ?? '')).toBe(true);
  });

  it('getActivityWindow returns nulls for an empty DB', () => {
    const w = getActivityWindow();
    expect(w.first).toBeNull();
    expect(w.last).toBeNull();
  });
});
