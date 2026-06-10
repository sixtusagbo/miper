// Wallet research harness: given the target wallets, reconstruct each entry's
// on-chain context (token age / mcap / liquidity / holders AT entry, deployer
// + funding-wallet history, launch platform, co-buy clustering) and each
// wallet's behavior profile (sizing, holds, one-buy-one-sell, performance
// over time). Emits:
//
//   research/wallet-profile.json     — full evidence (snapshots + stats)
//   research/discovery-profile.json  — derived scanner thresholds
//
// Usage:
//   npx ts-node scripts/profile-wallets.ts <addr> [<addr> ...]
//   npx ts-node scripts/profile-wallets.ts --file research/target-wallets.txt
//
// Env knobs (all optional):
//   HELIUS_API_KEY or SOLANA_RPC_URL   RPC endpoint (Helius recommended)
//   PROFILE_MAX_SCAN=5000     signature window scanned per wallet
//   PROFILE_MAX_PARSE=800     successful txs parsed per wallet
//   PROFILE_MAX_TOKENS=120    entry snapshots taken (unique mints, all wallets)
//   PROFILE_PRE_ENTRY_PARSE=100  pre-entry txs parsed per token (holder census)
//   PROFILE_SPACING_MS=120    delay between sequential tx parses
//   PROFILE_OUT / PROFILE_PROFILE_OUT  output paths
//
// The run is resumable in spirit: output is rewritten after every wallet and
// every 10 snapshots, so a crash loses minutes, not hours.

import 'dotenv/config';
import { Connection, ParsedTransactionWithMeta, PublicKey } from '@solana/web3.js';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import fetch from 'node-fetch';
import {
  collectWalletTrades,
  creatorContext,
  CreatorContext,
  distribution,
  EntrySnapshot,
  extractEntryFromBuyTx,
  extractIncomingTransfer,
  findCoBuys,
  buildRoundTrips,
  deriveDiscoveryProfile,
  preEntryContext,
  PUMP_TOTAL_SUPPLY,
  recurringAddresses,
  summarizeWalletBehavior,
  TimedTrade,
  TokenRoundTrip,
  WalkOptions,
  WalletBehavior,
} from '../src/walletResearch';
import { DEFAULT_DISCOVERY_PROFILE } from '../src/discoveryScore';
import { retry } from '../src/concurrency';
import { resolveRpcUrls } from '../src/config';

const MAX_SCAN = Number(process.env.PROFILE_MAX_SCAN) || 5000;
const MAX_PARSE = Number(process.env.PROFILE_MAX_PARSE) || 800;
const MAX_TOKENS = Number(process.env.PROFILE_MAX_TOKENS) || 120;
const PRE_ENTRY_PARSE = Number(process.env.PROFILE_PRE_ENTRY_PARSE) || 100;
const SPACING_MS = Number(process.env.PROFILE_SPACING_MS) || 120;
const OUT = process.env.PROFILE_OUT?.trim() || 'research/wallet-profile.json';
const PROFILE_OUT =
  process.env.PROFILE_PROFILE_OUT?.trim() || 'research/discovery-profile.json';

const log = (msg: string) => process.stderr.write(`${msg}\n`);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// --- historical SOL/USD (CoinGecko daily close, cached; falls back to the
// --- current DexScreener price so mcap is approximate rather than absent)
const solUsdByDate = new Map<string, number | null>();
let solUsdNow: number | null = null;

async function currentSolUsd(): Promise<number | null> {
  if (solUsdNow !== null) return solUsdNow;
  try {
    const res = await fetch(
      'https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112'
    );
    const json = (await res.json()) as {
      pairs?: Array<{ priceUsd?: string; quoteToken?: { symbol?: string } }> | null;
    };
    const pair =
      (json.pairs ?? []).find((p) => p.quoteToken?.symbol === 'USDC') ?? json.pairs?.[0];
    const price = pair?.priceUsd ? Number(pair.priceUsd) : null;
    if (price && Number.isFinite(price)) solUsdNow = price;
  } catch {
    /* fall through */
  }
  return solUsdNow;
}

async function solUsdAt(unixSec: number | null): Promise<number | null> {
  if (unixSec === null) return currentSolUsd();
  const d = new Date(unixSec * 1000);
  const key = `${String(d.getUTCDate()).padStart(2, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${d.getUTCFullYear()}`;
  if (solUsdByDate.has(key)) return solUsdByDate.get(key) ?? currentSolUsd();
  try {
    await sleep(1500); // free-tier CoinGecko rate limit
    const res = await fetch(`https://api.coingecko.com/api/v3/coins/solana/history?date=${key}`);
    const json = (await res.json()) as { market_data?: { current_price?: { usd?: number } } };
    const price = json.market_data?.current_price?.usd ?? null;
    solUsdByDate.set(key, price && Number.isFinite(price) ? price : null);
  } catch {
    solUsdByDate.set(key, null);
  }
  return solUsdByDate.get(key) ?? currentSolUsd();
}

// Funding source of an arbitrary wallet: page to its oldest txs (capped) and
// look for the incoming transfer. Used on the TARGET wallets themselves — a
// shared funder across targets is one-operator evidence.
async function walletFunder(connection: Connection, wallet: string): Promise<string | null> {
  try {
    const key = new PublicKey(wallet);
    let before: string | undefined;
    for (let page = 0; page < 5; page++) {
      const batch = await retry(
        () => connection.getSignaturesForAddress(key, { limit: 1000, before }),
        { attempts: 3, baseDelayMs: 500 }
      );
      if (batch.length === 0) break;
      before = batch[batch.length - 1].signature;
      if (batch.length < 1000) {
        // Bottomed out — the last few entries are the wallet's first txs.
        for (const s of batch.slice(-3).reverse()) {
          if (s.err) continue;
          const tx = await connection.getParsedTransaction(s.signature, {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed',
          });
          if (!tx) continue;
          const incoming = extractIncomingTransfer(tx, wallet);
          if (incoming) return incoming.from;
          await sleep(SPACING_MS);
        }
        return null;
      }
    }
    return null; // history too deep to bottom out — funder unknowable cheaply
  } catch {
    return null;
  }
}

function readWallets(): string[] {
  const args = process.argv.slice(2);
  const fileIdx = args.indexOf('--file');
  if (fileIdx >= 0) {
    const path = args[fileIdx + 1];
    if (!path) throw new Error('--file needs a path');
    return readFileSync(path, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'));
  }
  return args.filter((a) => !a.startsWith('--'));
}

function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}

const fmtUsd = (n: number | null) => (n === null ? '?' : `$${Math.round(n).toLocaleString()}`);
const fmtSec = (n: number | null) =>
  n === null ? '?' : n < 120 ? `${Math.round(n)}s` : `${(n / 60).toFixed(1)}min`;

// Early (pre-entry) wallets per snapshotted mint, mined for cluster members.
const earlyWalletsByMint = new Map<string, string[]>();

async function main(): Promise<void> {
  const wallets = readWallets();
  if (wallets.length === 0) {
    log('usage: profile-wallets.ts <addr> [...] | --file research/target-wallets.txt');
    process.exit(1);
  }
  const rpc = resolveRpcUrls().rpcUrl;
  const connection = new Connection(rpc, 'confirmed');
  const opts: WalkOptions = {
    maxScanSignatures: MAX_SCAN,
    maxParse: MAX_PARSE,
    parseSpacingMs: SPACING_MS,
  };
  log(`profiling ${wallets.length} wallet(s) via ${rpc}`);
  log(`caps: scan ${MAX_SCAN} sigs, parse ${MAX_PARSE} txs/wallet, ${MAX_TOKENS} token snapshots`);

  const output: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    partial: true,
    params: { MAX_SCAN, MAX_PARSE, MAX_TOKENS, PRE_ENTRY_PARSE },
    targetWallets: wallets,
  };
  const save = () => writeJson(OUT, output);

  // ---- Phase 1: trade history + behavior per wallet --------------------
  const behaviors: WalletBehavior[] = [];
  const tripsByWallet = new Map<string, TokenRoundTrip[]>();
  const tradesByWallet = new Map<string, TimedTrade[]>();
  const buyTxsByWallet = new Map<string, Map<string, ParsedTransactionWithMeta>>();
  for (const wallet of wallets) {
    log(`\n[phase 1/3] trade history: ${wallet}`);
    try {
      const { trades, buyTxs } = await collectWalletTrades(connection, wallet, opts, (d, t) => {
        if (d % 100 === 0) log(`  parsed ${d}/${t} txs`);
      });
      const behavior = summarizeWalletBehavior(wallet, trades);
      behaviors.push(behavior);
      tradesByWallet.set(wallet, trades);
      tripsByWallet.set(wallet, buildRoundTrips(trades));
      buyTxsByWallet.set(wallet, buyTxs);
      log(
        `  ${behavior.roundTrips} round-trips | win ${(behavior.winRate * 100).toFixed(0)}% | ` +
          `PnL ${behavior.realizedPnlSol.toFixed(2)} SOL | median hold ${fmtSec(behavior.holdSec.p50)} | ` +
          `1buy/1sell ${(behavior.oneBuyOneSellFraction * 100).toFixed(0)}%`
      );
      output.wallets = behaviors;
      save();
    } catch (err) {
      log(`  FAILED: ${(err as Error).message}`);
    }
  }

  // ---- Phase 2: co-buy structure (no extra RPC) -------------------------
  const coBuys = findCoBuys(tripsByWallet);
  const sameSlotGroups = coBuys.filter((g) => g.sameSlotWallets.length > 0);
  output.coBuys = coBuys;
  log(
    `\n[phase 2/3] co-buys: ${coBuys.length} tokens bought by >=2 targets; ` +
      `${sameSlotGroups.length} with same-slot entries`
  );

  // ---- Phase 3: entry snapshots -----------------------------------------
  // Co-bought tokens first (most informative), then newest-first singles.
  const earliestBuy = new Map<string, { wallet: string; trip: TokenRoundTrip }>();
  for (const [wallet, trips] of tripsByWallet) {
    for (const t of trips) {
      const cur = earliestBuy.get(t.tokenMint);
      if (!cur || t.firstBuySlot < cur.trip.firstBuySlot) {
        earliestBuy.set(t.tokenMint, { wallet, trip: t });
      }
    }
  }
  const coBuyMints = new Set(coBuys.map((g) => g.tokenMint));
  const ordered = [...earliestBuy.keys()].sort((a, b) => {
    const ca = coBuyMints.has(a) ? 1 : 0;
    const cb = coBuyMints.has(b) ? 1 : 0;
    if (ca !== cb) return cb - ca;
    return (
      (earliestBuy.get(b)?.trip.firstBuySlot ?? 0) - (earliestBuy.get(a)?.trip.firstBuySlot ?? 0)
    );
  });
  const selected = ordered.slice(0, MAX_TOKENS);
  log(`[phase 3/3] snapshotting ${selected.length}/${ordered.length} tokens (co-buys first)`);

  const preOpts: WalkOptions = { ...opts, maxParse: PRE_ENTRY_PARSE };
  const creatorCache = new Map<string, CreatorContext>();
  const snapshots: EntrySnapshot[] = [];
  let snapped = 0;
  for (const mint of selected) {
    snapped++;
    const anchor = earliestBuy.get(mint)!;
    try {
      const pre = await preEntryContext(
        connection,
        mint,
        anchor.trip.firstBuySignature,
        anchor.trip.firstBuyTime,
        preOpts
      );
      let creatorCtx: CreatorContext | null = null;
      if (pre.creator && pre.createSignature) {
        creatorCtx = creatorCache.get(pre.creator) ?? null;
        if (!creatorCtx) {
          creatorCtx = await creatorContext(
            connection,
            pre.creator,
            pre.createSignature,
            pre.createTime,
            opts
          );
          creatorCache.set(pre.creator, creatorCtx);
        }
      }

      // One snapshot per target wallet that bought this mint; entry price /
      // liquidity from each wallet's OWN buy tx, shared launch context from
      // the anchor walk. Holder census is exact only for the anchor buyer.
      for (const [wallet, trips] of tripsByWallet) {
        const trip = trips.find((t) => t.tokenMint === mint);
        if (!trip) continue;
        const buyTx = buyTxsByWallet.get(wallet)?.get(trip.firstBuySignature);
        const entry = buyTx ? extractEntryFromBuyTx(buyTx, wallet, mint) : null;
        const isAnchor = wallet === anchor.wallet;
        const platform = entry?.platform ?? 'other';
        const isPumpFamily = platform === 'pump' || platform === 'pumpswap';
        const solUsd = entry?.entryPriceSol ? await solUsdAt(trip.firstBuyTime) : null;
        const ageSec =
          trip.firstBuyTime !== null && pre.createTime !== null
            ? Math.max(0, trip.firstBuyTime - pre.createTime)
            : null;
        snapshots.push({
          wallet,
          tokenMint: mint,
          buySignature: trip.firstBuySignature,
          buySlot: trip.firstBuySlot,
          buyTime: trip.firstBuyTime,
          platform,
          launchPlatform: pre.launchPlatform,
          entryPriceSol: entry?.entryPriceSol ?? null,
          entryMcapUsd:
            entry?.entryPriceSol && solUsd && isPumpFamily
              ? entry.entryPriceSol * PUMP_TOTAL_SUPPLY * solUsd
              : null,
          solUsdUsed: solUsd,
          curveSolAtEntry: entry?.curveSolAtEntry ?? null,
          buySolIn: entry?.buySolIn ?? trip.buySol,
          ageSecAtEntry: ageSec,
          txsBeforeEntry: isAnchor ? pre.txsBeforeEntry : null,
          holdersBeforeEntry: isAnchor ? pre.holdersBeforeEntry : null,
          buyersPerMinAtEntry: isAnchor ? pre.buyersPerMinAtEntry : null,
          creator: pre.creator,
          createSignature: pre.createSignature,
          devBuySol: pre.devBuySol,
          creatorPriorTxs: creatorCtx?.priorTxs ?? null,
          creatorAgeDaysAtLaunch: creatorCtx?.ageDaysAtLaunch ?? null,
          creatorSaturated: creatorCtx?.saturated ?? false,
          funder: creatorCtx?.funder ?? null,
          targetCoBuyersSameSlot: [],
          targetBuyersEarlier: [],
          pnlSol: trip.pnlSol,
          holdSec: trip.holdSec,
          explainable: false,
          explainableReasons: [],
        });
      }
      // Keep earlyWallets for cluster mining.
      earlyWalletsByMint.set(mint, pre.earlyWallets);
    } catch (err) {
      log(`  snapshot failed for ${mint}: ${(err as Error).message}`);
    }
    if (snapped % 5 === 0 || snapped === selected.length) {
      log(`  ${snapped}/${selected.length} tokens snapshotted`);
      output.snapshots = snapshots;
      save();
    }
  }

  // ---- Cross-referencing and explainability ------------------------------
  // Target-wallet relations per snapshot, from the wallets' own buy slots.
  const buysByMint = new Map<string, Array<{ wallet: string; slot: number }>>();
  for (const [wallet, trips] of tripsByWallet) {
    for (const t of trips) {
      buysByMint.set(t.tokenMint, [
        ...(buysByMint.get(t.tokenMint) ?? []),
        { wallet, slot: t.firstBuySlot },
      ]);
    }
  }
  for (const s of snapshots) {
    const others = (buysByMint.get(s.tokenMint) ?? []).filter((b) => b.wallet !== s.wallet);
    s.targetCoBuyersSameSlot = others.filter((b) => b.slot === s.buySlot).map((b) => b.wallet);
    s.targetBuyersEarlier = others.filter((b) => b.slot < s.buySlot).map((b) => b.wallet);
  }

  const byCreator = new Map<string, string | null>(
    snapshots.map((s) => [s.tokenMint, s.creator])
  );
  const byFunder = new Map<string, string | null>(snapshots.map((s) => [s.tokenMint, s.funder]));
  const recurringCreators = recurringAddresses(byCreator, 2);
  const recurringFunders = recurringAddresses(byFunder, 2);
  const recurringCreatorSet = new Set(recurringCreators.map((r) => r.address));
  const recurringFunderSet = new Set(recurringFunders.map((r) => r.address));

  for (const s of snapshots) {
    const reasons: string[] = [];
    if (s.targetBuyersEarlier.length > 0)
      reasons.push(`target wallet(s) already in: ${s.targetBuyersEarlier.length}`);
    if (s.creator && recurringCreatorSet.has(s.creator)) reasons.push('recurring deployer');
    if (s.funder && recurringFunderSet.has(s.funder)) reasons.push('recurring funder');
    if (
      s.buyersPerMinAtEntry !== null &&
      s.buyersPerMinAtEntry >= DEFAULT_DISCOVERY_PROFILE.minBuyersPerMin
    )
      reasons.push(`holder surge ${s.buyersPerMinAtEntry.toFixed(1)} buyers/min`);
    s.explainable = reasons.length > 0;
    s.explainableReasons = reasons;
  }

  // Suspected cluster members: non-target wallets early in >=3 bought tokens.
  const creators = new Set([...byCreator.values()].filter((c): c is string => c !== null));
  const targetSet = new Set(wallets);
  const earlyMap = new Map<string, string[]>(earlyWalletsByMint);
  const suspectedCluster = recurringAddresses(
    new Map([...earlyMap.entries()].map(([m, ws]) => [m, ws])),
    3
  )
    .filter((r) => !targetSet.has(r.address) && !creators.has(r.address))
    .slice(0, 25);

  // Shared funding among the targets themselves (one-operator evidence).
  log('\nchecking target-wallet funding sources...');
  const targetFunders: Record<string, string | null> = {};
  for (const w of wallets) {
    targetFunders[w] = await walletFunder(connection, w);
    if (targetFunders[w]) log(`  ${w.slice(0, 8)}.. funded by ${targetFunders[w]}`);
  }

  // ---- Aggregate + profile ----------------------------------------------
  const anchorSnaps = snapshots.filter((s) => s.holdersBeforeEntry !== null || s.txsBeforeEntry !== null);
  const aggregate = {
    snapshots: snapshots.length,
    entryMcapUsd: distribution(
      snapshots.map((s) => s.entryMcapUsd).filter((m): m is number => m !== null)
    ),
    ageSecAtEntry: distribution(
      snapshots.map((s) => s.ageSecAtEntry).filter((a): a is number => a !== null)
    ),
    curveSolAtEntry: distribution(
      snapshots.map((s) => s.curveSolAtEntry).filter((c): c is number => c !== null)
    ),
    holdersBeforeEntry: distribution(
      anchorSnaps.map((s) => s.holdersBeforeEntry).filter((h): h is number => h !== null)
    ),
    buyersPerMinAtEntry: distribution(
      anchorSnaps.map((s) => s.buyersPerMinAtEntry).filter((b): b is number => b !== null)
    ),
    devBuySol: distribution(
      snapshots.map((s) => s.devBuySol).filter((d): d is number => d !== null)
    ),
    platforms: countBy(snapshots.map((s) => s.platform)),
    launchPlatforms: countBy(
      snapshots.map((s) => s.launchPlatform).filter((p): p is string => p !== null)
    ),
    explainableFraction:
      snapshots.length > 0 ? snapshots.filter((s) => s.explainable).length / snapshots.length : 0,
    sameSlotCoBuyGroups: sameSlotGroups.length,
  };

  const profile = deriveDiscoveryProfile(snapshots, wallets);

  output.partial = false;
  output.snapshots = snapshots;
  output.recurringCreators = recurringCreators;
  output.recurringFunders = recurringFunders;
  output.suspectedClusterWallets = suspectedCluster;
  output.targetFunders = targetFunders;
  output.aggregate = aggregate;
  output.profile = profile;
  save();
  writeJson(PROFILE_OUT, profile);

  // ---- Human report -------------------------------------------------------
  log(`\n${'='.repeat(72)}`);
  log('WALLET PROFILE REPORT');
  log('='.repeat(72));
  for (const b of behaviors) {
    log(`\n${b.wallet}`);
    log(
      `  ${b.roundTrips} round-trips over ${b.spanDays.toFixed(1)}d | win ${(b.winRate * 100).toFixed(0)}% | PnL ${b.realizedPnlSol >= 0 ? '+' : ''}${b.realizedPnlSol.toFixed(2)} SOL`
    );
    log(
      `  hold p25/p50/p75: ${fmtSec(b.holdSec.p25)}/${fmtSec(b.holdSec.p50)}/${fmtSec(b.holdSec.p75)} | fast flips <5s: ${(b.fastFlipFraction * 100).toFixed(0)}%`
    );
    log(
      `  size p25/p50/p75: ${b.buySol.p25.toFixed(2)}/${b.buySol.p50.toFixed(2)}/${b.buySol.p75.toFixed(2)} SOL | 1buy/1sell: ${(b.oneBuyOneSellFraction * 100).toFixed(0)}%`
    );
    const [h1, h2] = b.halves;
    log(
      `  halves: ${h1.roundTrips}rt ${(h1.winRate * 100).toFixed(0)}% ${h1.pnlSol.toFixed(2)} SOL -> ` +
        `${h2.roundTrips}rt ${(h2.winRate * 100).toFixed(0)}% ${h2.pnlSol.toFixed(2)} SOL` +
        ` | hold ${fmtSec(h1.medianHoldSec)} -> ${fmtSec(h2.medianHoldSec)} | size ${h1.medianBuySol.toFixed(2)} -> ${h2.medianBuySol.toFixed(2)} SOL`
    );
  }
  log(`\nCO-BUYS: ${coBuys.length} tokens bought by >=2 targets (${sameSlotGroups.length} same-slot)`);
  for (const g of coBuys.slice(0, 10)) {
    log(
      `  ${g.tokenMint} — ${g.wallets.length} wallets, spread ${fmtSec(g.entrySpreadSec)}` +
        (g.sameSlotWallets.length > 0 ? ` [SAME SLOT x${g.sameSlotWallets.length}]` : '')
    );
  }
  log(`\nENTRY CONTEXT (n=${aggregate.snapshots})`);
  log(`  mcap at entry   p25/p50/p75: ${fmtUsd(aggregate.entryMcapUsd.p25)} / ${fmtUsd(aggregate.entryMcapUsd.p50)} / ${fmtUsd(aggregate.entryMcapUsd.p75)}`);
  log(`  age at entry    p25/p50/p75: ${fmtSec(aggregate.ageSecAtEntry.p25)} / ${fmtSec(aggregate.ageSecAtEntry.p50)} / ${fmtSec(aggregate.ageSecAtEntry.p75)}`);
  log(`  curve SOL       p25/p50/p75: ${aggregate.curveSolAtEntry.p25.toFixed(1)} / ${aggregate.curveSolAtEntry.p50.toFixed(1)} / ${aggregate.curveSolAtEntry.p75.toFixed(1)}`);
  log(`  holders before  p25/p50/p75: ${aggregate.holdersBeforeEntry.p25} / ${aggregate.holdersBeforeEntry.p50} / ${aggregate.holdersBeforeEntry.p75} (n=${aggregate.holdersBeforeEntry.n})`);
  log(`  buyers/min      p25/p50/p75: ${aggregate.buyersPerMinAtEntry.p25.toFixed(1)} / ${aggregate.buyersPerMinAtEntry.p50.toFixed(1)} / ${aggregate.buyersPerMinAtEntry.p75.toFixed(1)}`);
  log(`  platforms: ${JSON.stringify(aggregate.platforms)}`);
  log(`  explainable from public data: ${(aggregate.explainableFraction * 100).toFixed(0)}%`);
  log(`\nRECURRING DEPLOYERS (${recurringCreators.length}):`);
  for (const r of recurringCreators.slice(0, 10)) log(`  ${r.address} — ${r.tokens} tokens`);
  log(`RECURRING FUNDERS (${recurringFunders.length}):`);
  for (const r of recurringFunders.slice(0, 10)) log(`  ${r.address} — ${r.tokens} tokens`);
  log(`SUSPECTED CLUSTER WALLETS (early in >=3 bought tokens): ${suspectedCluster.length}`);
  for (const r of suspectedCluster.slice(0, 10)) log(`  ${r.address} — ${r.tokens} tokens`);
  log(`\nwrote ${OUT} and ${PROFILE_OUT}`);
  log(
    `next: review the profile, then backtest with\n  npx ts-node scripts/backtest-discovery.ts --profile ${PROFILE_OUT} ${OUT}`
  );
}

function countBy(xs: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of xs) out[x] = (out[x] ?? 0) + 1;
  return out;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
