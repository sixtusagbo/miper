import { describe, expect, it } from 'vitest';
import {
  parseTrendingPools,
  passesTrendingFilter,
  TrendingCandidate,
  TrendingFilter,
} from '../src/trendingListener';

const SOL = 'So11111111111111111111111111111111111111112';

// A GeckoTerminal trending_pools pool entry, with overridable base/quote
// token ids and attributes so each test tweaks only what it exercises.
function gtPool(
  o: { base?: string; quote?: string; attrs?: Record<string, unknown> } = {}
) {
  return {
    id: 'solana_POOL1',
    type: 'pool',
    attributes: {
      address: 'POOL1',
      name: 'Doge / SOL',
      pool_created_at: new Date(Date.now() - 2 * 3600_000).toISOString(), // 2h old
      reserve_in_usd: '50000',
      fdv_usd: '125000',
      market_cap_usd: '120000',
      volume_usd: { h6: '90000', h24: '210000' },
      price_change_percentage: { h1: '4.5', h6: '33.0' },
      transactions: { h24: { buys: 120, sells: 90, buyers: 100, sellers: 75 } },
      ...o.attrs,
    },
    relationships: {
      base_token: { data: { id: o.base ?? 'solana_DOGEMINT' } },
      quote_token: { data: { id: o.quote ?? `solana_${SOL}` } },
      dex: { data: { id: 'raydium' } },
    },
  };
}

const DOGE_TOKEN = {
  id: 'solana_DOGEMINT',
  type: 'token',
  attributes: { address: 'DOGEMINT', name: 'Doge Coin', symbol: 'DOGE' },
};

function gtBody(pools: unknown[], included: unknown[] = [DOGE_TOKEN]) {
  return { data: pools, included };
}

const FILTER: TrendingFilter = {
  minLiquidityUsd: 10_000,
  maxLiquidityUsd: 250_000,
  minMcapUsd: 22_000,
  minVolumeUsd: 50_000,
  minAgeMin: 30,
  maxAgeHours: 24,
};

function candidate(o: Partial<TrendingCandidate> = {}): TrendingCandidate {
  return {
    poolAddress: 'POOL1',
    tokenMint: 'DOGEMINT',
    symbol: 'DOGE',
    name: 'Doge Coin',
    dex: 'raydium',
    liquidityUsd: 50_000,
    volumeH24Usd: 210_000,
    volumeH6Usd: 90_000,
    marketCapUsd: 120_000,
    priceChangeH1: 4.5,
    priceChangeH6: 33,
    ageMinutes: 120,
    buyersH24: 100,
    sellersH24: 75,
    ...o,
  };
}

describe('parseTrendingPools', () => {
  it('parses a pool into a candidate, taking the non-SOL side as the token', () => {
    const [c] = parseTrendingPools(gtBody([gtPool()]));
    expect(c.tokenMint).toBe('DOGEMINT');
    expect(c.symbol).toBe('DOGE');
    expect(c.poolAddress).toBe('POOL1');
    expect(c.liquidityUsd).toBe(50_000);
    expect(c.marketCapUsd).toBe(120_000);
    expect(c.volumeH24Usd).toBe(210_000);
    expect(c.dex).toBe('raydium');
    expect(c.ageMinutes).toBeGreaterThan(110);
    expect(c.ageMinutes).toBeLessThan(130);
  });

  it('falls back to fdv_usd when market_cap_usd is null', () => {
    const [c] = parseTrendingPools(gtBody([gtPool({ attrs: { market_cap_usd: null } })]));
    expect(c.marketCapUsd).toBe(125_000);
  });

  it('takes the quote side as the token when the base token is SOL', () => {
    const [c] = parseTrendingPools(
      gtBody([gtPool({ base: `solana_${SOL}`, quote: 'solana_DOGEMINT' })])
    );
    expect(c.tokenMint).toBe('DOGEMINT');
  });

  it('skips a pool where neither side is SOL or USDC', () => {
    expect(
      parseTrendingPools(gtBody([gtPool({ base: 'solana_AAA', quote: 'solana_BBB' })]))
    ).toHaveLength(0);
  });

  it('returns an empty array when the body has no data', () => {
    expect(parseTrendingPools({})).toHaveLength(0);
  });

  it('defaults the symbol when the included token metadata is missing', () => {
    const [c] = parseTrendingPools(gtBody([gtPool()], []));
    expect(c.symbol).toBe('?');
    expect(c.tokenMint).toBe('DOGEMINT');
  });
});

describe('passesTrendingFilter', () => {
  it('passes a candidate inside every bound', () => {
    expect(passesTrendingFilter(candidate(), FILTER)).toBe(true);
  });

  it('rejects liquidity below the minimum', () => {
    expect(passesTrendingFilter(candidate({ liquidityUsd: 5_000 }), FILTER)).toBe(false);
  });

  it('rejects liquidity above the maximum', () => {
    expect(passesTrendingFilter(candidate({ liquidityUsd: 400_000 }), FILTER)).toBe(false);
  });

  it('rejects a market cap below the minimum', () => {
    expect(passesTrendingFilter(candidate({ marketCapUsd: 10_000 }), FILTER)).toBe(false);
  });

  it('rejects 24h volume below the minimum', () => {
    expect(passesTrendingFilter(candidate({ volumeH24Usd: 20_000 }), FILTER)).toBe(false);
  });

  it('rejects a pool younger than the minimum age', () => {
    expect(passesTrendingFilter(candidate({ ageMinutes: 10 }), FILTER)).toBe(false);
  });

  it('rejects a pool older than the maximum age', () => {
    expect(passesTrendingFilter(candidate({ ageMinutes: 30 * 60 }), FILTER)).toBe(false);
  });
});
