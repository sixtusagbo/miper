import { Connection, PublicKey } from '@solana/web3.js';
import { logger } from './logger';
import { retry } from './concurrency';

export interface CreatorHistory {
  // Number of signatures returned by getSignaturesForAddress, capped at
  // SIGNATURE_LIMIT. Rough proxy for "how active is this wallet" — a fresh
  // disposable wallet will have 0-2, a seasoned trader will hit the cap.
  totalRecentTxs: number;
  // Days since the oldest signature we can see. A brand-new wallet signals
  // likely-rug; an aged wallet is marginally reassuring (sophisticated
  // ruggers can still age wallets, so treat this as lower-bound signal).
  oldestActivityDaysAgo: number | null;
  // Timestamp this record was computed, used by the cache.
  fetchedAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
// Large enough to distinguish "new wallet" from "experienced one" but small
// enough to keep a single RPC call under a few hundred ms on a decent RPC.
const SIGNATURE_LIMIT = 200;

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
      fetchedAt: Date.now(),
    };
  } catch (err) {
    logger.debug(`fetchCreatorHistory ${creator}: ${(err as Error).message}`);
    // Cache the failure briefly too so a flaky RPC doesn't turn one analysis
    // into a retry storm on every token from the same creator.
    history = {
      totalRecentTxs: 0,
      oldestActivityDaysAgo: null,
      fetchedAt: Date.now(),
    };
  }
  cache.set(creator, history);
  return history;
}
