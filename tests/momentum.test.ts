import { beforeEach, describe, expect, it, vi } from 'vitest';

// readBondingCurve is the watcher's only external dependency — mock it so the
// tests drive momentum logic directly without building curve account buffers.
const mocks = vi.hoisted(() => ({ readBondingCurve: vi.fn() }));
vi.mock('../src/bondingCurve', () => ({
  readBondingCurve: mocks.readBondingCurve,
}));

import { MomentumWatcher, MomentumConfig } from '../src/momentum';
import type { NewPool } from '../src/listener';

// minAgeMs: 0 — the band tests sweep immediately, so the min-age filter is
// disabled here and exercised in its own tests below.
const CFG: MomentumConfig = {
  windowMs: 60_000,
  sampleMs: 1_000,
  entryMultMin: 1.4,
  entryMultMax: 2.5,
  minAgeMs: 0,
  watchCap: 40,
};

function fakePool(mint: string): NewPool {
  return {
    poolAddress: `curve-${mint}`,
    tokenMint: mint,
    baseMint: 'So11111111111111111111111111111111111111112',
    quoteMint: mint,
    initialLiquiditySol: 1,
    txSignature: `sig-${mint}`,
    timestamp: Math.floor(Date.now() / 1000),
    creator: null,
  };
}

const price = (priceSol: number) => ({ kind: 'price' as const, priceSol });

beforeEach(() => {
  mocks.readBondingCurve.mockReset();
});

describe('MomentumWatcher', () => {
  it('emits entry when price climbs into the band', async () => {
    mocks.readBondingCurve
      .mockResolvedValueOnce(price(1e-7)) // add — baseline
      .mockResolvedValueOnce(price(2e-7)); // sweep — 2x, inside [1.4, 2.5]
    const watcher = new MomentumWatcher({} as never, CFG);
    const entries: NewPool[] = [];
    watcher.on('entry', (pool: NewPool) => entries.push(pool));

    await watcher.add(fakePool('AAA'));
    await watcher.sweep();

    expect(entries).toHaveLength(1);
    expect(entries[0].tokenMint).toBe('AAA');
    expect(watcher.watchlistSize).toBe(0);
  });

  it('keeps watching when price is still below the band', async () => {
    mocks.readBondingCurve
      .mockResolvedValueOnce(price(1e-7))
      .mockResolvedValueOnce(price(1.2e-7)); // 1.2x — under entryMultMin
    const watcher = new MomentumWatcher({} as never, CFG);
    const spy = vi.fn();
    watcher.on('entry', spy);
    await watcher.add(fakePool('BBB'));
    await watcher.sweep();
    expect(spy).not.toHaveBeenCalled();
    expect(watcher.watchlistSize).toBe(1);
  });

  it('drops a token that ran clean past the band without buying', async () => {
    mocks.readBondingCurve
      .mockResolvedValueOnce(price(1e-7))
      .mockResolvedValueOnce(price(5e-7)); // 5x — past entryMultMax
    const watcher = new MomentumWatcher({} as never, CFG);
    const spy = vi.fn();
    watcher.on('entry', spy);
    await watcher.add(fakePool('CCC'));
    await watcher.sweep();
    expect(spy).not.toHaveBeenCalled();
    expect(watcher.watchlistSize).toBe(0);
  });

  it('drops a token that expires the watch window', async () => {
    mocks.readBondingCurve.mockResolvedValueOnce(price(1e-7));
    const watcher = new MomentumWatcher({} as never, { ...CFG, windowMs: 1 });
    const spy = vi.fn();
    watcher.on('entry', spy);
    await watcher.add(fakePool('DDD'));
    await new Promise((r) => setTimeout(r, 10));
    await watcher.sweep();
    expect(spy).not.toHaveBeenCalled();
    expect(watcher.watchlistSize).toBe(0);
  });

  it('enforces the watchlist cap', async () => {
    mocks.readBondingCurve.mockResolvedValue(price(1e-7));
    const watcher = new MomentumWatcher({} as never, { ...CFG, watchCap: 2 });
    await watcher.add(fakePool('E1'));
    await watcher.add(fakePool('E2'));
    await watcher.add(fakePool('E3')); // over cap — ignored
    expect(watcher.watchlistSize).toBe(2);
  });

  it('skips a token whose curve cannot be priced', async () => {
    mocks.readBondingCurve.mockResolvedValueOnce({ kind: 'unavailable' });
    const watcher = new MomentumWatcher({} as never, CFG);
    await watcher.add(fakePool('FFF'));
    expect(watcher.watchlistSize).toBe(0);
  });

  it('drops a token that hit the band faster than minAgeMs', async () => {
    mocks.readBondingCurve
      .mockResolvedValueOnce(price(1e-7))
      .mockResolvedValueOnce(price(2e-7)); // in band, but age ~0 << minAgeMs
    const watcher = new MomentumWatcher({} as never, { ...CFG, minAgeMs: 60_000 });
    const spy = vi.fn();
    watcher.on('entry', spy);
    await watcher.add(fakePool('GGG'));
    await watcher.sweep();
    expect(spy).not.toHaveBeenCalled();
    expect(watcher.watchlistSize).toBe(0);
  });

  it('emits entry once a token is in the band and past minAgeMs', async () => {
    mocks.readBondingCurve
      .mockResolvedValueOnce(price(1e-7))
      .mockResolvedValueOnce(price(2e-7));
    const watcher = new MomentumWatcher({} as never, { ...CFG, minAgeMs: 5 });
    const spy = vi.fn();
    watcher.on('entry', spy);
    await watcher.add(fakePool('HHH'));
    await new Promise((r) => setTimeout(r, 15)); // age > minAgeMs
    await watcher.sweep();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('emits entry only after the pre-screen clears', async () => {
    mocks.readBondingCurve
      .mockResolvedValueOnce(price(1e-7))
      .mockResolvedValueOnce(price(2e-7));
    const prescreen = vi.fn().mockResolvedValue(true);
    const watcher = new MomentumWatcher({} as never, CFG, prescreen);
    const spy = vi.fn();
    watcher.on('entry', spy);
    await watcher.add(fakePool('III'));
    await watcher.sweep();
    expect(prescreen).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('does not emit entry when the pre-screen rejects the token', async () => {
    mocks.readBondingCurve
      .mockResolvedValueOnce(price(1e-7))
      .mockResolvedValueOnce(price(2e-7));
    const prescreen = vi.fn().mockResolvedValue(false);
    const watcher = new MomentumWatcher({} as never, CFG, prescreen);
    const spy = vi.fn();
    watcher.on('entry', spy);
    await watcher.add(fakePool('JJJ'));
    await new Promise((r) => setTimeout(r, 0)); // let the failed screen drop it
    await watcher.sweep();
    expect(spy).not.toHaveBeenCalled();
  });
});
