import { EventEmitter } from 'events';
import fetch from 'node-fetch';
import { logger } from './logger';
import { trimSeen } from './listener';

const GECKOTERMINAL_API = 'https://api.geckoterminal.com/api/v2';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// A graduated AMM token surfaced by GeckoTerminal's trending list, carrying
// the metrics the filter and the LLM score read.
export interface TrendingCandidate {
  poolAddress: string;
  tokenMint: string;
  symbol: string;
  name: string;
  dex: string;
  liquidityUsd: number;
  volumeH24Usd: number;
  volumeH6Usd: number;
  marketCapUsd: number;
  priceChangeH1: number;
  priceChangeH6: number;
  ageMinutes: number;
  buyersH24: number;
  sellersH24: number;
}

// The liquidity / market-cap / volume / age gate — the user's hand-proven
// DexScreener criteria.
export interface TrendingFilter {
  minLiquidityUsd: number;
  maxLiquidityUsd: number;
  minMcapUsd: number;
  minVolumeUsd: number;
  minAgeMin: number;
  maxAgeHours: number;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Pull the raw mint out of a GeckoTerminal token id like "solana_<mint>".
function mintFromId(id: string): string {
  return id.startsWith('solana_') ? id.slice('solana_'.length) : id;
}

// Parse a GeckoTerminal trending_pools response into candidates. The token of
// interest is whichever side of the pair is not SOL/USDC; a pool where both
// or neither side is a quote asset is skipped.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseTrendingPools(body: any): TrendingCandidate[] {
  const pools = Array.isArray(body?.data) ? body.data : [];
  const included = Array.isArray(body?.included) ? body.included : [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tokenById = new Map<string, any>();
  for (const t of included) {
    if (t?.id) tokenById.set(t.id, t.attributes ?? {});
  }
  const now = Date.now();
  const candidates: TrendingCandidate[] = [];
  for (const pool of pools) {
    const a = pool?.attributes;
    const rel = pool?.relationships;
    if (!a || !rel) continue;
    const baseId: string | undefined = rel.base_token?.data?.id;
    const quoteId: string | undefined = rel.quote_token?.data?.id;
    if (!baseId || !quoteId) continue;
    const baseQuoteAsset = isQuoteAsset(mintFromId(baseId));
    const quoteQuoteAsset = isQuoteAsset(mintFromId(quoteId));
    let tokenId: string;
    if (baseQuoteAsset && !quoteQuoteAsset) tokenId = quoteId;
    else if (!baseQuoteAsset && quoteQuoteAsset) tokenId = baseId;
    else continue; // both or neither side is SOL/USDC — not a clean pair
    const tok = tokenById.get(tokenId) ?? {};
    const created = Date.parse(a.pool_created_at ?? '');
    candidates.push({
      poolAddress: a.address ?? '',
      tokenMint: mintFromId(tokenId),
      symbol: tok.symbol ?? '?',
      name: tok.name ?? a.name ?? '?',
      dex: rel.dex?.data?.id ?? '?',
      liquidityUsd: num(a.reserve_in_usd),
      volumeH24Usd: num(a.volume_usd?.h24),
      volumeH6Usd: num(a.volume_usd?.h6),
      marketCapUsd: num(a.market_cap_usd) || num(a.fdv_usd),
      priceChangeH1: num(a.price_change_percentage?.h1),
      priceChangeH6: num(a.price_change_percentage?.h6),
      ageMinutes: Number.isFinite(created) ? (now - created) / 60_000 : 0,
      buyersH24: num(a.transactions?.h24?.buyers),
      sellersH24: num(a.transactions?.h24?.sellers),
    });
  }
  return candidates;
}

function isQuoteAsset(mint: string): boolean {
  return mint === WSOL_MINT || mint === USDC_MINT;
}

// True when a candidate clears the liquidity / mcap / volume / age gate.
export function passesTrendingFilter(c: TrendingCandidate, f: TrendingFilter): boolean {
  return (
    c.tokenMint !== '' &&
    c.poolAddress !== '' &&
    c.liquidityUsd >= f.minLiquidityUsd &&
    c.liquidityUsd <= f.maxLiquidityUsd &&
    c.marketCapUsd >= f.minMcapUsd &&
    c.volumeH24Usd >= f.minVolumeUsd &&
    c.ageMinutes >= f.minAgeMin &&
    c.ageMinutes <= f.maxAgeHours * 60
  );
}

// Polls GeckoTerminal's Solana trending pools (6h window — the user's
// "Trending 6H") and emits the ones that clear the filter, each at most once.
//
// Emits: 'candidate' (c: TrendingCandidate)
export class TrendingListener extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private readonly seen = new Set<string>();
  private polling = false;

  constructor(
    private readonly filter: TrendingFilter,
    private readonly pollMs: number
  ) {
    super();
  }

  start(): void {
    if (this.timer) return;
    logger.info(
      `trending: polling GeckoTerminal every ${(this.pollMs / 1000).toFixed(0)}s`
    );
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.pollMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // One poll cycle. Network and parse errors are swallowed — a bad cycle just
  // means we retry on the next interval. Guarded so a slow poll can't overlap.
  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const url =
        `${GECKOTERMINAL_API}/networks/solana/trending_pools` +
        `?include=base_token,quote_token&duration=6h`;
      const res = await fetch(url, {
        headers: { Accept: 'application/json;version=20230302' },
      });
      if (!res.ok) {
        logger.debug(`trending: GeckoTerminal responded ${res.status}`);
        return;
      }
      const candidates = parseTrendingPools(await res.json());
      for (const c of candidates) {
        if (this.seen.has(c.tokenMint)) continue;
        if (!passesTrendingFilter(c, this.filter)) continue;
        this.seen.add(c.tokenMint);
        trimSeen(this.seen);
        logger.info(
          `trending: ${c.symbol} — $${(c.liquidityUsd / 1000).toFixed(0)}k liq, ` +
            `$${(c.marketCapUsd / 1000).toFixed(0)}k mc, ` +
            `$${(c.volumeH24Usd / 1000).toFixed(0)}k vol, ` +
            `${(c.ageMinutes / 60).toFixed(1)}h old`
        );
        this.emit('candidate', c);
      }
    } catch (err) {
      logger.debug(`trending: poll failed — ${(err as Error).message}`);
    } finally {
      this.polling = false;
    }
  }
}
