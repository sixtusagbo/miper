import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  DEFAULT_DISCOVERY_PROFILE,
  DiscoveryFeatures,
  DiscoveryProfile,
  loadDiscoveryProfile,
  scoreDiscovery,
} from '../src/discoveryScore';

// Neutral baseline: every field unknown/empty so it scores 0 points. Tests
// flip one feature at a time and assert the delta.
function features(overrides: Partial<DiscoveryFeatures> = {}): DiscoveryFeatures {
  return {
    tokenMint: 'Mint11111111111111111111111111111111111111',
    platform: 'pump',
    ageSec: null,
    mcapUsd: null,
    liquiditySol: null,
    devBuySol: null,
    uniqueBuyers: null,
    buyersPerMin: null,
    txPerMin: null,
    buyerDiversity: null,
    smartWalletBuys: 0,
    bundledLaunch: false,
    launchSlotBuyers: 0,
    mayhem: false,
    creator: null,
    creatorPriorTxs: null,
    creatorAgeDays: null,
    creatorSaturated: false,
    funder: null,
    creatorIntel: null,
    funderIntel: null,
    hasMetadata: false,
    devSold: false,
    ...overrides,
  };
}

describe('scoreDiscovery', () => {
  it('scores a fully-unknown token at zero with no veto', () => {
    const r = scoreDiscovery(features());
    expect(r.score).toBe(0);
    expect(r.vetoed).toBe(false);
    expect(r.reasons).toHaveLength(0);
  });

  it('vetoes mayhem-mode coins', () => {
    const r = scoreDiscovery(features({ mayhem: true, smartWalletBuys: 3 }));
    expect(r.vetoed).toBe(true);
    expect(r.score).toBe(0);
    expect(r.reasons[0]).toContain('mayhem');
  });

  it('vetoes bundled launches', () => {
    const r = scoreDiscovery(features({ bundledLaunch: true, launchSlotBuyers: 5 }));
    expect(r.vetoed).toBe(true);
    expect(r.reasons[0]).toContain('bundled');
  });

  it('vetoes a creator sell', () => {
    const r = scoreDiscovery(features({ devSold: true }));
    expect(r.vetoed).toBe(true);
  });

  it('vetoes mcap above the entry band but not inside it', () => {
    const above = scoreDiscovery(features({ mcapUsd: 100_000 }));
    expect(above.vetoed).toBe(true);
    const inside = scoreDiscovery(features({ mcapUsd: 8_000 }));
    expect(inside.vetoed).toBe(false);
    expect(inside.score).toBe(10); // mcap-in-band bonus
  });

  it('vetoes tokens older than the band', () => {
    const r = scoreDiscovery(features({ ageSec: 100_000 }));
    expect(r.vetoed).toBe(true);
    expect(scoreDiscovery(features({ ageSec: 60 })).vetoed).toBe(false);
  });

  it('vetoes essentially-empty bonding curves (2026-07 precision finding)', () => {
    expect(scoreDiscovery(features({ liquiditySol: 0.5 })).vetoed).toBe(true);
    expect(scoreDiscovery(features({ liquiditySol: 5e-9 })).vetoed).toBe(true);
    expect(scoreDiscovery(features({ liquiditySol: 1 })).vetoed).toBe(false);
    expect(scoreDiscovery(features({ liquiditySol: null })).vetoed).toBe(false);
  });

  it('rewards curves with real depth (>= minStrongLiquiditySol)', () => {
    expect(scoreDiscovery(features({ liquiditySol: 4.9 })).score).toBe(0);
    expect(scoreDiscovery(features({ liquiditySol: 5 })).score).toBe(10);
    expect(scoreDiscovery(features({ liquiditySol: 20 })).score).toBe(10);
  });

  it('scores smart-wallet buys 30 for the first, +15 each, capped at 60', () => {
    expect(scoreDiscovery(features({ smartWalletBuys: 1 })).score).toBe(30);
    expect(scoreDiscovery(features({ smartWalletBuys: 2 })).score).toBe(45);
    expect(scoreDiscovery(features({ smartWalletBuys: 5 })).score).toBe(60);
  });

  it('recognizes known-good and known-bad deployers from the profile lists', () => {
    const profile: DiscoveryProfile = {
      ...DEFAULT_DISCOVERY_PROFILE,
      knownGoodDeployers: ['GoodDev'],
      knownBadDeployers: ['BadDev'],
    };
    expect(scoreDiscovery(features({ creator: 'GoodDev' }), profile).score).toBe(20);
    const bad = scoreDiscovery(features({ creator: 'BadDev' }), profile);
    expect(bad.score).toBe(0); // clamped from -40
    expect(bad.reasons[0]).toContain('bad track record');
  });

  it('lets intel from the wallet_intel DB drive deployer reputation', () => {
    expect(scoreDiscovery(features({ creatorIntel: 'good' })).score).toBe(20);
    expect(scoreDiscovery(features({ creatorIntel: 'bad' })).reasons[0]).toContain('bad');
  });

  it('bad reputation wins over good when both apply', () => {
    const profile: DiscoveryProfile = {
      ...DEFAULT_DISCOVERY_PROFILE,
      knownGoodDeployers: ['Dev'],
    };
    const r = scoreDiscovery(features({ creator: 'Dev', creatorIntel: 'bad' }), profile);
    expect(r.reasons).toHaveLength(1);
    expect(r.reasons[0]).toContain('bad track record');
  });

  it('scores funder reputation', () => {
    const profile: DiscoveryProfile = {
      ...DEFAULT_DISCOVERY_PROFILE,
      knownGoodFunders: ['Hub'],
      knownBadFunders: ['RugHub'],
    };
    expect(scoreDiscovery(features({ funder: 'Hub' }), profile).score).toBe(15);
    expect(scoreDiscovery(features({ funder: 'RugHub' }), profile).score).toBe(0);
    expect(scoreDiscovery(features({ funderIntel: 'good' })).score).toBe(15);
  });

  it('scores a dev buy inside the band only', () => {
    expect(scoreDiscovery(features({ devBuySol: 1 })).score).toBe(10);
    expect(scoreDiscovery(features({ devBuySol: 0.01 })).score).toBe(0);
    expect(scoreDiscovery(features({ devBuySol: 50 })).score).toBe(0);
  });

  it('scores demand floors: buyers/min and tx/min', () => {
    expect(scoreDiscovery(features({ buyersPerMin: 10 })).score).toBe(15);
    expect(scoreDiscovery(features({ buyersPerMin: 2 })).score).toBe(0);
    expect(scoreDiscovery(features({ txPerMin: 20 })).score).toBe(10);
    expect(scoreDiscovery(features({ txPerMin: 5 })).score).toBe(0);
  });

  it('penalizes wash texture (low buyer diversity)', () => {
    const r = scoreDiscovery(features({ buyersPerMin: 10, buyerDiversity: 0.2 }));
    expect(r.score).toBe(0); // +15 - 20 clamped at 0
    expect(r.reasons.some((x) => x.includes('wash'))).toBe(true);
    expect(scoreDiscovery(features({ buyerDiversity: 0.9 })).score).toBe(0);
  });

  it('rates creator age: aged +5, fresh disposable -10, saturated neutral', () => {
    expect(
      scoreDiscovery(features({ creatorAgeDays: 30, creatorPriorTxs: 500 })).score
    ).toBe(5);
    const fresh = scoreDiscovery(features({ creatorAgeDays: 0.1, creatorPriorTxs: 3 }));
    expect(fresh.score).toBe(0); // clamped from -10
    expect(fresh.reasons[0]).toContain('fresh disposable');
    expect(
      scoreDiscovery(
        features({ creatorAgeDays: 0.1, creatorPriorTxs: 1000, creatorSaturated: true })
      ).score
    ).toBe(0);
  });

  it('scores metadata completeness', () => {
    expect(scoreDiscovery(features({ hasMetadata: true })).score).toBe(5);
  });

  it('stacks signals and clamps at 100', () => {
    const r = scoreDiscovery(
      features({
        smartWalletBuys: 4, // 60 (capped)
        creatorIntel: 'good', // 20
        funderIntel: 'good', // 15
        devBuySol: 2, // 10
        buyersPerMin: 20, // 15
        txPerMin: 30, // 10
        mcapUsd: 5_000, // 10
        hasMetadata: true, // 5
      })
    );
    expect(r.score).toBe(100);
    expect(r.vetoed).toBe(false);
    expect(r.reasons.length).toBeGreaterThanOrEqual(8);
  });

  it('a no-cluster token can still alert on stacked organic signals', () => {
    const r = scoreDiscovery(
      features({
        creatorIntel: 'good',
        devBuySol: 1.5,
        buyersPerMin: 12,
        txPerMin: 20,
        mcapUsd: 6_000,
        creatorAgeDays: 30,
        creatorPriorTxs: 400,
        hasMetadata: true,
      })
    );
    expect(r.score).toBe(75);
  });
});

describe('loadDiscoveryProfile', () => {
  it('returns defaults when the file is missing', () => {
    const p = loadDiscoveryProfile('/nonexistent/profile.json');
    expect(p).toEqual(DEFAULT_DISCOVERY_PROFILE);
  });

  it('returns defaults when the file is malformed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'miper-prof-'));
    const path = join(dir, 'bad.json');
    writeFileSync(path, 'not json{{{');
    expect(loadDiscoveryProfile(path)).toEqual(DEFAULT_DISCOVERY_PROFILE);
  });

  it('merges recognized fields over defaults and ignores junk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'miper-prof-'));
    const path = join(dir, 'partial.json');
    writeFileSync(
      path,
      JSON.stringify({
        maxEntryMcapUsd: 9_000,
        smartWallets: ['W1', '', 42, ' W2 '],
        minBuyersPerMin: 'not-a-number',
        unknownKey: true,
      })
    );
    const p = loadDiscoveryProfile(path);
    expect(p.maxEntryMcapUsd).toBe(9_000);
    expect(p.smartWallets).toEqual(['W1', 'W2']);
    expect(p.minBuyersPerMin).toBe(DEFAULT_DISCOVERY_PROFILE.minBuyersPerMin);
    expect(p.maxTokenAgeSec).toBe(DEFAULT_DISCOVERY_PROFILE.maxTokenAgeSec);
  });
});
