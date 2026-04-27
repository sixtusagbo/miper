import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearCreatorHistoryCache, fetchCreatorHistory } from '../src/creatorHistory';

const CREATOR = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

function fakeConnection(result: unknown) {
  return {
    getSignaturesForAddress: vi.fn().mockResolvedValue(result),
  } as any;
}

beforeEach(() => {
  clearCreatorHistoryCache();
});

describe('fetchCreatorHistory', () => {
  it('reports zeros for a wallet with no recent activity', async () => {
    const conn = fakeConnection([]);
    const h = await fetchCreatorHistory(conn, CREATOR);
    expect(h.totalRecentTxs).toBe(0);
    expect(h.oldestActivityDaysAgo).toBeNull();
    expect(h.txCountSaturated).toBe(false);
  });

  it('computes total count and wallet age from the signature window', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const thirtyDaysAgo = nowSec - 30 * 86400;
    const oneDayAgo = nowSec - 86400;
    // getSignaturesForAddress returns newest-first.
    const conn = fakeConnection([
      { signature: 'newest', blockTime: oneDayAgo },
      { signature: 'middle', blockTime: nowSec - 15 * 86400 },
      { signature: 'oldest', blockTime: thirtyDaysAgo },
    ]);
    const h = await fetchCreatorHistory(conn, CREATOR);
    expect(h.totalRecentTxs).toBe(3);
    expect(h.oldestActivityDaysAgo).toBeCloseTo(30, 0);
    expect(h.txCountSaturated).toBe(false);
  });

  it('flags txCountSaturated=true when the window returns the API max', async () => {
    // Simulate a high-volume wallet where 1000 recent txs all happened in
    // the past hour. Without the saturation flag, the caller would think
    // the wallet is 0.04 days old (fresh) when it's actually ancient.
    const nowSec = Math.floor(Date.now() / 1000);
    const oneHourAgo = nowSec - 3600;
    const sigs = Array.from({ length: 1000 }, (_, i) => ({
      signature: `sig-${i}`,
      blockTime: nowSec - Math.floor((i / 1000) * 3600),
    }));
    // Newest-first: first element is most recent.
    sigs[sigs.length - 1].blockTime = oneHourAgo;
    const conn = fakeConnection(sigs);
    const h = await fetchCreatorHistory(conn, CREATOR);
    expect(h.totalRecentTxs).toBe(1000);
    expect(h.txCountSaturated).toBe(true);
    // Reported in-window age is still computed (lower bound) — but caller
    // is responsible for treating it as "age unknown".
    expect(h.oldestActivityDaysAgo).toBeLessThan(0.1);
  });

  it('caches results so the RPC is only hit once per TTL window', async () => {
    const conn = fakeConnection([{ signature: 's', blockTime: Math.floor(Date.now() / 1000) }]);
    await fetchCreatorHistory(conn, CREATOR);
    await fetchCreatorHistory(conn, CREATOR);
    await fetchCreatorHistory(conn, CREATOR);
    expect(conn.getSignaturesForAddress).toHaveBeenCalledTimes(1);
  });

  it('caches a zero-result response on RPC failure so retries do not storm', async () => {
    const conn = {
      getSignaturesForAddress: vi.fn().mockRejectedValue(new Error('rpc 500')),
    } as any;
    const h1 = await fetchCreatorHistory(conn, CREATOR);
    const h2 = await fetchCreatorHistory(conn, CREATOR);
    expect(h1.totalRecentTxs).toBe(0);
    expect(h1.oldestActivityDaysAgo).toBeNull();
    expect(h2).toEqual(h1);
    // Two attempts inside retry() + no second call because cached failure.
    expect(conn.getSignaturesForAddress).toHaveBeenCalledTimes(2);
  });
});
