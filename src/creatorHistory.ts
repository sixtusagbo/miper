import { Connection, PublicKey } from '@solana/web3.js';
import { logger } from './logger';
import { retry } from './concurrency';

export interface CreatorHistory {
  // Number of signatures returned by getSignaturesForAddress in the window.
  // Capped at SIGNATURE_LIMIT — see txCountSaturated for whether the cap
  // was hit.
  totalRecentTxs: number;
  // Days since the oldest signature in the window. When `txCountSaturated`
  // is true this is a LOWER BOUND on wallet age — a wallet doing thousands
  // of txs per hour will report ~0.04 days even if it's months old. When
  // saturated AND oldest-in-window is recent, callers should treat true age
  // as unknown rather than concluding "fresh disposable wallet".
  oldestActivityDaysAgo: number | null;
  // True when getSignaturesForAddress returned the maximum (>= SIGNATURE_LIMIT)
  // entries, meaning the wallet has more recent activity than fits in one
  // page. The wallet is high-volume; we cannot determine whether it's also
  // long-lived without paginating further.
  txCountSaturated: boolean;
  // Timestamp this record was computed, used by the cache.
  fetchedAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
// API max for getSignaturesForAddress in a single call. Bumped from 200 so
// active wallets that previously saturated at 200 now resolve cleanly,
// reducing the false "0 days old" reading on traders/MEV/active devs.
const SIGNATURE_LIMIT = 1000;

const cache = new Map<string, CreatorHistory>();

export function clearCreatorHistoryCache(): void {
  cache.clear();
}

export async function fetchCreatorHistory(
  connection: Connection,
  creator: string
): Promise<CreatorHistory> {
  const cached = cache.get(creator);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached;
  }

  let history: CreatorHistory;
  try {
    const pk = new PublicKey(creator);
    const sigs = await retry(
      () => connection.getSignaturesForAddress(pk, { limit: SIGNATURE_LIMIT }),
      {
        attempts: 2,
        baseDelayMs: 300,
        label: `getSignaturesForAddress ${creator.slice(0, 8)}`,
      }
    );
    // getSignaturesForAddress returns newest-first, so the oldest in the
    // window is the last element.
    const nowSec = Math.floor(Date.now() / 1000);
    const oldestBlockTime =
      sigs.length > 0 ? sigs[sigs.length - 1].blockTime ?? null : null;
    const daysAgo =
      oldestBlockTime !== null ? (nowSec - oldestBlockTime) / 86400 : null;
    history = {
      totalRecentTxs: sigs.length,
      oldestActivityDaysAgo: daysAgo,
      txCountSaturated: sigs.length >= SIGNATURE_LIMIT,
      fetchedAt: Date.now(),
    };
  } catch (err) {
    logger.debug(`fetchCreatorHistory ${creator}: ${(err as Error).message}`);
    // Cache the failure briefly too so a flaky RPC doesn't turn one analysis
    // into a retry storm on every token from the same creator.
    history = {
      totalRecentTxs: 0,
      oldestActivityDaysAgo: null,
      txCountSaturated: false,
      fetchedAt: Date.now(),
    };
  }
  cache.set(creator, history);
  return history;
}
