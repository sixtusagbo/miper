import { readFileSync } from 'fs';
import { logger } from './logger';

// Deterministic scoring for the discovery scanner. No LLM: R-live-8 showed
// the launch-time AI gate selects at the base rate, and the whole premise of
// discovery is that the target wallets' picks are explainable from public
// chain data. The same function scores live watch snapshots (src/discovery.ts)
// and historical research snapshots (scripts/backtest-discovery.ts), so a
// backtest is a statement about the production code path.

// What the target wallets' opportunities look like, measured by
// scripts/profile-wallets.ts. The scanner loads this from
// DISCOVERY_PROFILE (JSON) so a research re-run re-tunes the scanner
// without code changes; missing fields fall back to these defaults.
export interface DiscoveryProfile {
  // Entry band. The target wallets enter under ~$5-10k mcap; the ceiling has
  // headroom because our detection adds latency. Above it we veto — that is
  // simply not the opportunity class we're hunting.
  minEntryMcapUsd: number;
  maxEntryMcapUsd: number;
  // Veto tokens older than this at evaluation time.
  maxTokenAgeSec: number;
  // Creator's SOL co-deposit band in the create tx ("skin in the game", but
  // a huge self-buy is its own red flag — the band has two edges).
  devBuyMinSol: number;
  devBuyMaxSol: number;
  // Demand floors at evaluation time, measured on the wallets' entries.
  minBuyersPerMin: number;
  minTxPerMin: number;
  // Distinct buyers / parsed txs below this looks like one wallet churning
  // (wash texture), not many wallets arriving.
  minBuyerDiversity: number;
  // Creator reputation regimes (mirrors the analyzer's heuristics).
  freshCreatorMaxTxs: number;
  agedCreatorMinDays: number;
  // Wallet lists from research. smartWallets = the researched cluster —
  // seeing one of them buy is the strongest single feature.
  smartWallets: string[];
  knownGoodDeployers: string[];
  knownBadDeployers: string[];
  knownGoodFunders: string[];
  knownBadFunders: string[];
}

export const DEFAULT_DISCOVERY_PROFILE: DiscoveryProfile = {
  minEntryMcapUsd: 0,
  maxEntryMcapUsd: 15_000,
  maxTokenAgeSec: 1_800,
  devBuyMinSol: 0.5,
  devBuyMaxSol: 5,
  minBuyersPerMin: 8,
  minTxPerMin: 12,
  minBuyerDiversity: 0.5,
  freshCreatorMaxTxs: 50,
  agedCreatorMinDays: 7,
  smartWallets: [],
  knownGoodDeployers: [],
  knownBadDeployers: [],
  knownGoodFunders: [],
  knownBadFunders: [],
};

// One token's observable state at scoring time. Nullable fields mean "not
// measurable" (RPC failure, insufficient sample) and score zero points —
// unknown is never treated as good or bad.
export interface DiscoveryFeatures {
  tokenMint: string;
  platform: string;
  ageSec: number | null;
  mcapUsd: number | null;
  liquiditySol: number | null;
  devBuySol: number | null;
  // Sampled lower bound on distinct buyers (we parse a sample of curve txs,
  // not a census).
  uniqueBuyers: number | null;
  buyersPerMin: number | null;
  txPerMin: number | null;
  // Distinct fee-payers / parsed txs over the watch (0..1). Null when the
  // parsed sample is too small to mean anything.
  buyerDiversity: number | null;
  // Distinct researched wallets seen buying this token.
  smartWalletBuys: number;
  bundledLaunch: boolean;
  launchSlotBuyers: number;
  mayhem: boolean;
  creator: string | null;
  creatorPriorTxs: number | null;
  creatorAgeDays: number | null;
  creatorSaturated: boolean;
  funder: string | null;
  // Reputation resolved from the scanner's wallet_intel DB (compounds across
  // runs). Profile-list membership is resolved here in the scorer.
  creatorIntel: 'good' | 'bad' | null;
  funderIntel: 'good' | 'bad' | null;
  hasMetadata: boolean;
  // Creator observed selling during the watch — the classic pre-rug tell.
  devSold: boolean;
}

export interface DiscoveryScore {
  score: number;
  vetoed: boolean;
  reasons: string[];
}

// Rule weights. Tuned to the shape: a smart-wallet entry nearly clears the
// alert bar on its own; a token with no cluster activity can still alert on
// stacked organic signals (good deployer + demand + in-band entry).
const W = {
  smartWalletFirst: 30,
  smartWalletExtra: 15,
  smartWalletCap: 60,
  goodDeployer: 20,
  badDeployer: -40,
  goodFunder: 15,
  badFunder: -25,
  devBuyInBand: 10,
  buyersPerMin: 15,
  txPerMin: 10,
  washTexture: -20,
  agedCreator: 5,
  freshCreator: -10,
  metadata: 5,
  mcapInBand: 10,
} as const;

export function scoreDiscovery(
  f: DiscoveryFeatures,
  profile: DiscoveryProfile = DEFAULT_DISCOVERY_PROFILE
): DiscoveryScore {
  const reasons: string[] = [];

  // Hard vetoes: not "low score" — structurally outside the opportunity
  // class or an unsellable/manufactured trap.
  if (f.mayhem) {
    return { score: 0, vetoed: true, reasons: ['mayhem-mode coin (unsellable-trap risk)'] };
  }
  if (f.bundledLaunch) {
    return {
      score: 0,
      vetoed: true,
      reasons: [`bundled launch — ${f.launchSlotBuyers} buyers in the create slot`],
    };
  }
  if (f.devSold) {
    return { score: 0, vetoed: true, reasons: ['creator sold during the watch'] };
  }
  if (f.mcapUsd !== null && f.mcapUsd > profile.maxEntryMcapUsd) {
    return {
      score: 0,
      vetoed: true,
      reasons: [
        `mcap $${Math.round(f.mcapUsd)} above the $${profile.maxEntryMcapUsd} entry band`,
      ],
    };
  }
  if (f.ageSec !== null && f.ageSec > profile.maxTokenAgeSec) {
    return {
      score: 0,
      vetoed: true,
      reasons: [`token ${Math.round(f.ageSec)}s old (band max ${profile.maxTokenAgeSec}s)`],
    };
  }

  let score = 0;
  const add = (points: number, reason: string) => {
    score += points;
    reasons.push(`${points > 0 ? '+' : ''}${points} ${reason}`);
  };

  if (f.smartWalletBuys > 0) {
    const points = Math.min(
      W.smartWalletCap,
      W.smartWalletFirst + (f.smartWalletBuys - 1) * W.smartWalletExtra
    );
    add(points, `${f.smartWalletBuys} smart wallet(s) bought`);
  }

  const creatorGood =
    f.creatorIntel === 'good' ||
    (f.creator !== null && profile.knownGoodDeployers.includes(f.creator));
  const creatorBad =
    f.creatorIntel === 'bad' ||
    (f.creator !== null && profile.knownBadDeployers.includes(f.creator));
  if (creatorBad) add(W.badDeployer, 'deployer has a bad track record');
  else if (creatorGood) add(W.goodDeployer, 'deployer has a winning track record');

  const funderGood =
    f.funderIntel === 'good' ||
    (f.funder !== null && profile.knownGoodFunders.includes(f.funder));
  const funderBad =
    f.funderIntel === 'bad' ||
    (f.funder !== null && profile.knownBadFunders.includes(f.funder));
  if (funderBad) add(W.badFunder, 'funded by a known rug-funding wallet');
  else if (funderGood) add(W.goodFunder, 'funded by a known winning-cluster wallet');

  if (
    f.devBuySol !== null &&
    f.devBuySol >= profile.devBuyMinSol &&
    f.devBuySol <= profile.devBuyMaxSol
  ) {
    add(W.devBuyInBand, `dev buy ${f.devBuySol.toFixed(2)} SOL in band`);
  }

  if (f.buyersPerMin !== null && f.buyersPerMin >= profile.minBuyersPerMin) {
    add(W.buyersPerMin, `${f.buyersPerMin.toFixed(1)} buyers/min (floor ${profile.minBuyersPerMin})`);
  }
  if (f.txPerMin !== null && f.txPerMin >= profile.minTxPerMin) {
    add(W.txPerMin, `${f.txPerMin.toFixed(0)} tx/min (floor ${profile.minTxPerMin})`);
  }
  if (f.buyerDiversity !== null && f.buyerDiversity < profile.minBuyerDiversity) {
    add(W.washTexture, `buyer diversity ${f.buyerDiversity.toFixed(2)} — wash texture`);
  }

  // Saturated creator history = high-volume wallet of unknown age — neutral,
  // matching the analyzer's regime (c): never call it fresh OR aged.
  if (!f.creatorSaturated && f.creatorAgeDays !== null && f.creatorPriorTxs !== null) {
    if (f.creatorAgeDays >= profile.agedCreatorMinDays) {
      add(W.agedCreator, `creator wallet ${f.creatorAgeDays.toFixed(0)}d old`);
    } else if (f.creatorPriorTxs <= profile.freshCreatorMaxTxs) {
      add(W.freshCreator, `fresh disposable creator (${f.creatorPriorTxs} prior txs)`);
    }
  }

  if (f.hasMetadata) add(W.metadata, 'complete metadata');

  if (
    f.mcapUsd !== null &&
    f.mcapUsd >= profile.minEntryMcapUsd &&
    f.mcapUsd <= profile.maxEntryMcapUsd
  ) {
    add(W.mcapInBand, `mcap $${Math.round(f.mcapUsd)} in the entry band`);
  }

  return { score: Math.max(0, Math.min(100, Math.round(score))), vetoed: false, reasons };
}

// Load a profile JSON, merging recognized fields over the defaults so a
// partial profile (or one from an older research run) still yields a fully
// populated profile. Any failure falls back to the defaults — the scanner
// must come up even if the profile file is absent or malformed.
export function loadDiscoveryProfile(path: string): DiscoveryProfile {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    logger.info(`discovery: no profile at ${path} — using built-in defaults`);
    return { ...DEFAULT_DISCOVERY_PROFILE };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<DiscoveryProfile>;
    const merged = { ...DEFAULT_DISCOVERY_PROFILE };
    for (const key of Object.keys(DEFAULT_DISCOVERY_PROFILE) as (keyof DiscoveryProfile)[]) {
      const value = parsed[key];
      if (value === undefined) continue;
      const defaultValue = DEFAULT_DISCOVERY_PROFILE[key];
      if (Array.isArray(defaultValue)) {
        if (Array.isArray(value)) {
          (merged[key] as string[]) = (value as unknown[])
            .filter((v): v is string => typeof v === 'string')
            .map((v) => v.trim())
            .filter((v) => v.length > 0);
        }
      } else if (typeof value === 'number' && Number.isFinite(value)) {
        (merged[key] as number) = value;
      }
    }
    return merged;
  } catch (err) {
    logger.warn(
      `discovery: profile ${path} is not valid JSON (${(err as Error).message}) — using defaults`
    );
    return { ...DEFAULT_DISCOVERY_PROFILE };
  }
}
