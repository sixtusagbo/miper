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
  minTrades: 5,
  maxEntryMult: 2.0,
  watchCap: 40,
};

// A connection mock. `signatures` is the list returned by
// getSignaturesForAddress; `sigsThrow` makes that call reject.
function makeConnection(opts: {
  accountInfo?: unknown;
  signatures?: { signature: string; err: unknown }[];
  sigsThrow?: boolean;
} = {}) {
  const sigs =
    opts.signatures ??
    Array.from({ length: 8 }, (_, i) => ({ signature: `s${i}`, err: null }));
  return {
    getAccountInfo: vi
      .fn()
      .mockResolvedValue(
        'accountInfo' in opts ? opts.accountInfo : { data: Buffer.alloc(64) }
      ),
    getSignaturesForAddress: opts.sigsThrow
      ? vi.fn().mockRejectedValue(new Error('rpc down'))
      : vi.fn().mockResolvedValue(sigs),
  } as never;
}

const appConfig = {} as Config;

// Curve + safety defaults that clear every gate; tests override one at a time.
function passingGates() {
  mockDecode.mockReturnValue({ complete: false, isMayhemMode: false } as never);
  mockPrice.mockReturnValue(PUMP_INITIAL_PRICE_SOL * 1.5);
  mockSafety.mockResolvedValue({ passed: true, failures: [] } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('TractionWatcher.add', () => {
  it('adds a launch to the watchlist without buying', () => {
    const w = new TractionWatcher(makeConnection(), baseCfg, appConfig);
    const entry = vi.fn();
    w.on('entry', entry);
    w.add(makePool('mintA'));
    expect(w.watchlistSize).toBe(1);
    expect(entry).not.toHaveBeenCalled();
  });

  it('dedupes a launch already on the watchlist', () => {
    const w = new TractionWatcher(makeConnection(), baseCfg, appConfig);
    w.add(makePool('mintA'));
    w.add(makePool('mintA'));
    expect(w.watchlistSize).toBe(1);
  });

  it('respects the watch cap', () => {
    const w = new TractionWatcher(makeConnection(), { ...baseCfg, watchCap: 2 }, appConfig);
    w.add(makePool('mintA'));
    w.add(makePool('mintB'));
    w.add(makePool('mintC'));
    expect(w.watchlistSize).toBe(2);
  });
});

describe('TractionWatcher.sweep — observation window', () => {
  it('leaves a launch on the watchlist until its window elapses', async () => {
    const w = new TractionWatcher(
      makeConnection(),
      { ...baseCfg, windowMs: 60_000 },
      appConfig
    );
    w.add(makePool('mintA'));
    await w.sweep();
    expect(w.watchlistSize).toBe(1);
  });

  it('assesses and removes a launch once its window has elapsed', async () => {
    passingGates();
    const w = new TractionWatcher(makeConnection(), baseCfg, appConfig);
    w.add(makePool('mintA'));
    await w.sweep();
    expect(w.watchlistSize).toBe(0);
    expect(mockSafety).toHaveBeenCalledOnce();
  });
});

describe('TractionWatcher.assess — entry gate', () => {
  async function sweepOne(connection = makeConnection(), mint = 'mintA') {
    const w = new TractionWatcher(connection, baseCfg, appConfig);
    const entry = vi.fn();
    w.on('entry', entry);
    w.add(makePool(mint));
    await w.sweep();
    return entry;
  }

  it('emits entry with the curve-trade count when every gate passes', async () => {
    passingGates();
    const entry = await sweepOne();
    expect(entry).toHaveBeenCalledOnce();
    expect(entry.mock.calls[0][1]).toBe(8); // eight curve trades
  });

  it('does not emit when the curve is unreadable', async () => {
    passingGates();
    const entry = await sweepOne(makeConnection({ accountInfo: { data: null } }));
    expect(entry).not.toHaveBeenCalled();
  });

  it('does not emit when the launch graduated during the window', async () => {
    passingGates();
    mockDecode.mockReturnValue({ complete: true, isMayhemMode: false } as never);
    const entry = await sweepOne();
    expect(entry).not.toHaveBeenCalled();
  });

  it('does not emit for a mayhem-mode coin', async () => {
    passingGates();
    mockDecode.mockReturnValue({ complete: false, isMayhemMode: true } as never);
    const entry = await sweepOne();
    expect(entry).not.toHaveBeenCalled();
  });

  it('does not emit when the price ran past the landable cap', async () => {
    passingGates();
    mockPrice.mockReturnValue(PUMP_INITIAL_PRICE_SOL * 3); // 3x > 2x cap
    const entry = await sweepOne();
    expect(entry).not.toHaveBeenCalled();
  });

  it('does not emit when the price is unreadable', async () => {
    passingGates();
    mockPrice.mockReturnValue(null);
    const entry = await sweepOne();
    expect(entry).not.toHaveBeenCalled();
  });

  it('does not emit when too few curve trades (no traction)', async () => {
    passingGates();
    const entry = await sweepOne(
      makeConnection({
        signatures: [
          { signature: 's0', err: null },
          { signature: 's1', err: null },
        ],
      })
    );
    expect(entry).not.toHaveBeenCalled();
  });

  it('excludes failed transactions from the trade count', async () => {
    passingGates();
    // 8 signatures but 5 failed — only 3 successful trades, below minTrades 5.
    const signatures = Array.from({ length: 8 }, (_, i) => ({
      signature: `s${i}`,
      err: i < 5 ? { InstructionError: [0, 'Custom'] } : null,
    }));
    const entry = await sweepOne(makeConnection({ signatures }));
    expect(entry).not.toHaveBeenCalled();
  });

  it('does not emit when the curve history is unreadable', async () => {
    passingGates();
    const entry = await sweepOne(makeConnection({ sigsThrow: true }));
    expect(entry).not.toHaveBeenCalled();
  });

  it('does not emit when safety checks fail', async () => {
    passingGates();
    mockSafety.mockResolvedValue({
      passed: false,
      failures: ['mint authority not revoked'],
    } as never);
    const entry = await sweepOne();
    expect(entry).not.toHaveBeenCalled();
  });
});

describe('TractionWatcher start/stop', () => {
  it('stop clears the watchlist and the sweep timer', () => {
    vi.useFakeTimers();
    try {
      const w = new TractionWatcher(makeConnection(), baseCfg, appConfig);
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
