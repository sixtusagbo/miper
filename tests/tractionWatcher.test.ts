import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TractionWatcher, TractionConfig } from '../src/tractionWatcher';
import { NewPool } from '../src/listener';
import { Config } from '../src/config';
import { decodeBondingCurve, bondingCurvePriceSol } from '../src/bondingCurve';
import { runSafetyChecks, PUMP_INITIAL_PRICE_SOL } from '../src/analyzer';

vi.mock('../src/bondingCurve', () => ({
  decodeBondingCurve: vi.fn(),
  bondingCurvePriceSol: vi.fn(),
}));

vi.mock('../src/analyzer', () => ({
  runSafetyChecks: vi.fn(),
  PUMP_INITIAL_PRICE_SOL: 1e-7,
}));

const mockDecode = vi.mocked(decodeBondingCurve);
const mockPrice = vi.mocked(bondingCurvePriceSol);
const mockSafety = vi.mocked(runSafetyChecks);

// A spendable pump.fun launch — poolAddress must be valid base58 so the
// watcher's `new PublicKey(...)` doesn't throw.
function makePool(mint: string): NewPool {
  return {
    poolAddress: 'So11111111111111111111111111111111111111112',
    tokenMint: mint,
    baseMint: 'So11111111111111111111111111111111111111112',
    quoteMint: mint,
    initialLiquiditySol: 5,
    txSignature: 'sig',
    timestamp: Date.now(),
    creator: 'creator',
  };
}

const baseCfg: TractionConfig = {
  windowMs: 0, // every entry is immediately past the observation window
  sampleMs: 1000,
  minBuyers: 20,
  maxEntryMult: 2.0,
  maxClusterPct: 25,
  watchCap: 40,
};

// A connection whose getAccountInfo always returns a (dummy) curve buffer —
// decodeBondingCurve is mocked, so the bytes don't matter.
function makeConnection(accountInfo: unknown = { data: Buffer.alloc(64) }) {
  return {
    getAccountInfo: vi.fn().mockResolvedValue(accountInfo),
  } as unknown as Parameters<typeof TractionWatcher.prototype.constructor>[0];
}

const appConfig = {} as Config;

// Defaults that clear every gate; individual tests override one at a time.
function passingCurve() {
  mockDecode.mockReturnValue({ complete: false, isMayhemMode: false } as never);
  mockPrice.mockReturnValue(PUMP_INITIAL_PRICE_SOL * 1.5);
  mockSafety.mockResolvedValue({
    passed: true,
    failures: [],
    holderCount: 30,
    topHolderPct: 10,
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('TractionWatcher.add', () => {
  it('adds a launch to the watchlist without buying', () => {
    const w = new TractionWatcher(makeConnection() as never, baseCfg, appConfig);
    const entry = vi.fn();
    w.on('entry', entry);
    w.add(makePool('mintA'));
    expect(w.watchlistSize).toBe(1);
    expect(entry).not.toHaveBeenCalled();
  });

  it('dedupes a launch already on the watchlist', () => {
    const w = new TractionWatcher(makeConnection() as never, baseCfg, appConfig);
    w.add(makePool('mintA'));
    w.add(makePool('mintA'));
    expect(w.watchlistSize).toBe(1);
  });

  it('respects the watch cap', () => {
    const w = new TractionWatcher(
      makeConnection() as never,
      { ...baseCfg, watchCap: 2 },
      appConfig
    );
    w.add(makePool('mintA'));
    w.add(makePool('mintB'));
    w.add(makePool('mintC'));
    expect(w.watchlistSize).toBe(2);
  });
});

describe('TractionWatcher.sweep — observation window', () => {
  it('leaves a launch on the watchlist until its window elapses', async () => {
    const w = new TractionWatcher(
      makeConnection() as never,
      { ...baseCfg, windowMs: 60_000 },
      appConfig
    );
    w.add(makePool('mintA'));
    await w.sweep();
    expect(w.watchlistSize).toBe(1);
  });

  it('assesses and removes a launch once its window has elapsed', async () => {
    passingCurve();
    const w = new TractionWatcher(makeConnection() as never, baseCfg, appConfig);
    w.add(makePool('mintA'));
    await w.sweep();
    expect(w.watchlistSize).toBe(0);
    expect(mockSafety).toHaveBeenCalledOnce();
  });
});

describe('TractionWatcher.assess — entry gate', () => {
  async function sweepOne(mint = 'mintA') {
    const w = new TractionWatcher(makeConnection() as never, baseCfg, appConfig);
    const entry = vi.fn();
    w.on('entry', entry);
    w.add(makePool(mint));
    await w.sweep();
    return entry;
  }

  it('emits entry when every gate passes', async () => {
    passingCurve();
    const entry = await sweepOne();
    expect(entry).toHaveBeenCalledOnce();
    expect(entry.mock.calls[0][1]).toBe(30); // holder count
  });

  it('does not emit when the curve is unreadable', async () => {
    passingCurve();
    const w = new TractionWatcher(
      makeConnection({ data: null }) as never,
      baseCfg,
      appConfig
    );
    const entry = vi.fn();
    w.on('entry', entry);
    w.add(makePool('mintA'));
    await w.sweep();
    expect(entry).not.toHaveBeenCalled();
  });

  it('does not emit when the launch graduated during the window', async () => {
    passingCurve();
    mockDecode.mockReturnValue({ complete: true, isMayhemMode: false } as never);
    const entry = await sweepOne();
    expect(entry).not.toHaveBeenCalled();
  });

  it('does not emit for a mayhem-mode coin', async () => {
    passingCurve();
    mockDecode.mockReturnValue({ complete: false, isMayhemMode: true } as never);
    const entry = await sweepOne();
    expect(entry).not.toHaveBeenCalled();
  });

  it('does not emit when the price ran past the landable cap', async () => {
    passingCurve();
    mockPrice.mockReturnValue(PUMP_INITIAL_PRICE_SOL * 3); // 3x > 2x cap
    const entry = await sweepOne();
    expect(entry).not.toHaveBeenCalled();
  });

  it('does not emit when the price is unreadable', async () => {
    passingCurve();
    mockPrice.mockReturnValue(null);
    const entry = await sweepOne();
    expect(entry).not.toHaveBeenCalled();
  });

  it('does not emit when safety checks fail', async () => {
    passingCurve();
    mockSafety.mockResolvedValue({
      passed: false,
      failures: ['mint authority not revoked'],
      holderCount: 30,
      topHolderPct: 10,
    } as never);
    const entry = await sweepOne();
    expect(entry).not.toHaveBeenCalled();
  });

  it('does not emit when there are too few holders (no traction)', async () => {
    passingCurve();
    mockSafety.mockResolvedValue({
      passed: true,
      failures: [],
      holderCount: 5, // < minBuyers 20
      topHolderPct: 10,
    } as never);
    const entry = await sweepOne();
    expect(entry).not.toHaveBeenCalled();
  });

  it('does not emit when supply is too concentrated', async () => {
    passingCurve();
    mockSafety.mockResolvedValue({
      passed: true,
      failures: [],
      holderCount: 30,
      topHolderPct: 40, // > maxClusterPct 25
    } as never);
    const entry = await sweepOne();
    expect(entry).not.toHaveBeenCalled();
  });
});

describe('TractionWatcher start/stop', () => {
  it('stop clears the watchlist and the sweep timer', () => {
    vi.useFakeTimers();
    try {
      const w = new TractionWatcher(makeConnection() as never, baseCfg, appConfig);
      w.add(makePool('mintA'));
      w.start();
      w.stop();
      expect(w.watchlistSize).toBe(0);
      vi.advanceTimersByTime(baseCfg.sampleMs * 3);
      // A cleared timer means no further sweeps fire.
      expect(w.watchlistSize).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
