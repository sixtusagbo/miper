// Backtest the discovery scanner against the target wallets' actual history:
// replay the PRODUCTION scorer (src/discoveryScore.ts — the same function the
// live scanner calls) over the research snapshots and report, per threshold,
// how many of their entries would have alerted.
//
//   npx ts-node scripts/backtest-discovery.ts research/wallet-profile.json
//     [--profile research/discovery-profile.json]   thresholds to score against
//     [--db discovery.db]                           also print live alert precision
//
// Three recall flavors per threshold:
//   recall          — share of all snapshotted entries that would have alerted
//   winner recall   — share of entries the WALLET profited on (the ones worth catching)
//   PnL-weighted    — recall weighted by the wallet's realized SOL per entry
//
// Caveat printed in the output: launch-slot bundling, mayhem state and
// mid-watch dev sells are not reconstructible historically, so historical
// vetoes can't fire — recall here is an upper bound. Precision comes from the
// live scanner's own discovery_alerts outcomes (--db), not from this replay.

import 'dotenv/config';
import { readFileSync, existsSync } from 'fs';
import Database from 'better-sqlite3';
import {
  DEFAULT_DISCOVERY_PROFILE,
  DiscoveryProfile,
  loadDiscoveryProfile,
  scoreDiscovery,
} from '../src/discoveryScore';
import { EntrySnapshot, snapshotToFeatures } from '../src/walletResearch';

const THRESHOLDS = [40, 50, 55, 60, 70, 80];

interface ProfileFile {
  targetWallets?: string[];
  snapshots?: EntrySnapshot[];
  profile?: Partial<DiscoveryProfile>;
}

function arg(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

function pct(x: number): string {
  return `${(x * 100).toFixed(0)}%`;
}

function main(): void {
  const positional = process.argv.slice(2).filter((a, i, all) => {
    if (a.startsWith('--')) return false;
    const prev = all[i - 1];
    return !(prev === '--profile' || prev === '--db');
  });
  const inputPath = positional[0] ?? 'research/wallet-profile.json';
  if (!existsSync(inputPath)) {
    console.error(
      `no research file at ${inputPath} — run profile-wallets.ts first\n` +
        'usage: backtest-discovery.ts [wallet-profile.json] [--profile discovery-profile.json] [--db discovery.db]'
    );
    process.exit(1);
  }
  const file = JSON.parse(readFileSync(inputPath, 'utf8')) as ProfileFile;
  const snapshots = file.snapshots ?? [];
  if (snapshots.length === 0) {
    console.error(`${inputPath} has no snapshots — research run incomplete?`);
    process.exit(1);
  }

  // Threshold source priority: --profile file > the profile embedded in the
  // research output > built-in defaults.
  const profileArg = arg('--profile');
  const profile: DiscoveryProfile = profileArg
    ? loadDiscoveryProfile(profileArg)
    : file.profile
      ? { ...DEFAULT_DISCOVERY_PROFILE, ...file.profile }
      : { ...DEFAULT_DISCOVERY_PROFILE };

  console.log(`backtesting ${snapshots.length} entries from ${inputPath}`);
  console.log(
    `profile: mcap<=$${profile.maxEntryMcapUsd} age<=${profile.maxTokenAgeSec}s ` +
      `buyers/min>=${profile.minBuyersPerMin} | ${profile.smartWallets.length} smart wallets, ` +
      `${profile.knownGoodDeployers.length} known deployers, ${profile.knownGoodFunders.length} known funders\n`
  );

  const scored = snapshots.map((s) => ({
    snapshot: s,
    result: scoreDiscovery(snapshotToFeatures(s), profile),
  }));

  // Score distribution.
  const buckets = new Map<string, number>();
  for (const { result } of scored) {
    const b = result.vetoed ? 'vetoed' : `${Math.floor(result.score / 10) * 10}s`;
    buckets.set(b, (buckets.get(b) ?? 0) + 1);
  }
  console.log('score distribution (wallet-picked entries):');
  for (const [bucket, n] of [...buckets.entries()].sort()) {
    console.log(`  ${bucket.padStart(6)}: ${'#'.repeat(Math.min(60, n))} ${n}`);
  }

  const winners = scored.filter((x) => (x.snapshot.pnlSol ?? 0) > 0);
  const totalPnl = scored.reduce((s, x) => s + Math.max(0, x.snapshot.pnlSol ?? 0), 0);
  console.log(
    `\nentries: ${scored.length} | wallet-profitable: ${winners.length} ` +
      `(${pct(winners.length / Math.max(1, scored.length))}) | their positive PnL: ${totalPnl.toFixed(2)} SOL`
  );

  console.log('\nthreshold sweep (alert fires at score >= T):');
  console.log('  T    recall   winner-recall   PnL-weighted');
  for (const t of THRESHOLDS) {
    const caught = scored.filter((x) => !x.result.vetoed && x.result.score >= t);
    const caughtWinners = winners.filter((x) => !x.result.vetoed && x.result.score >= t);
    const caughtPnl = caughtWinners.reduce((s, x) => s + (x.snapshot.pnlSol ?? 0), 0);
    console.log(
      `  ${String(t).padEnd(4)} ${pct(caught.length / Math.max(1, scored.length)).padStart(5)}   ` +
        `${pct(caughtWinners.length / Math.max(1, winners.length)).padStart(8)}        ` +
        `${pct(totalPnl > 0 ? caughtPnl / totalPnl : 0).padStart(5)}`
    );
  }

  // The biggest winners the scanner would have missed at the live threshold —
  // the actionable list for tuning weights or adding wallets to the cluster.
  const liveThreshold = 55;
  const missed = winners
    .filter((x) => x.result.vetoed || x.result.score < liveThreshold)
    .sort((a, b) => (b.snapshot.pnlSol ?? 0) - (a.snapshot.pnlSol ?? 0))
    .slice(0, 10);
  if (missed.length > 0) {
    console.log(`\ntop misses at threshold ${liveThreshold} (their PnL | our score | why so low):`);
    for (const m of missed) {
      const why =
        m.result.reasons.length > 0 ? m.result.reasons.join('; ') : 'no positive signals measured';
      console.log(
        `  ${m.snapshot.tokenMint} +${(m.snapshot.pnlSol ?? 0).toFixed(2)} SOL | ${m.result.score} | ${why}`
      );
    }
  }

  console.log(
    '\nnote: bundle/mayhem/dev-sell vetoes cannot fire on historical snapshots — recall is an upper bound.'
  );

  // Live precision from the scanner's own alert outcomes.
  const dbPath = arg('--db');
  if (dbPath) {
    if (!existsSync(dbPath)) {
      console.error(`--db ${dbPath} not found`);
      process.exit(1);
    }
    const db = new Database(dbPath, { readonly: true });
    const rows = db
      .prepare(
        'SELECT score, peak_mult, outcome FROM discovery_alerts WHERE peak_mult IS NOT NULL'
      )
      .all() as Array<{ score: number; peak_mult: number; outcome: string }>;
    const pending = (
      db.prepare('SELECT COUNT(*) AS c FROM discovery_alerts WHERE peak_mult IS NULL').get() as {
        c: number;
      }
    ).c;
    db.close();
    console.log(`\nlive alert precision from ${dbPath} (${rows.length} resolved, ${pending} pending):`);
    if (rows.length > 0) {
      const wins = rows.filter((r) => r.outcome === 'win' || r.outcome === 'graduated');
      const mults = rows.map((r) => r.peak_mult).sort((a, b) => a - b);
      const median = mults[Math.floor(mults.length / 2)];
      console.log(
        `  ${wins.length}/${rows.length} (${pct(wins.length / rows.length)}) reached ${'>='}2x or graduated | median peak ${median.toFixed(2)}x`
      );
      for (const t of THRESHOLDS) {
        const at = rows.filter((r) => r.score >= t);
        const w = at.filter((r) => r.outcome === 'win' || r.outcome === 'graduated');
        if (at.length > 0) {
          console.log(`  score>=${t}: ${w.length}/${at.length} winners (${pct(w.length / at.length)})`);
        }
      }
    }
  }
}

main();
