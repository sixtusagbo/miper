import {
  ConfirmedSignatureInfo,
  Connection,
  LAMPORTS_PER_SOL,
  ParsedInstruction,
  ParsedTransactionWithMeta,
  PartiallyDecodedInstruction,
  PublicKey,
} from '@solana/web3.js';
import { extractLeaderTrade, LeaderTrade } from './walletListener';
import { bondingCurvePda } from './bondingCurve';
import { retry } from './concurrency';
import {
  DEFAULT_DISCOVERY_PROFILE,
  DiscoveryFeatures,
  DiscoveryProfile,
} from './discoveryScore';

// Research-side feature extraction for the discovery scanner: reconstruct the
// on-chain context of a wallet's historical entries (token age, mcap,
// liquidity, holders, deployer, funder — all AT entry time, from public RPC
// data only). scripts/profile-wallets.ts orchestrates these into
// research/wallet-profile.json; scripts/backtest-discovery.ts replays the
// production scorer over the snapshots.

export const PUMP_TOTAL_SUPPLY = 1_000_000_000;

// Venue/launchpad program IDs seen in a trade tx. Order matters: a Jupiter
// route THROUGH Raydium contains both programs, and the venue (not the
// router) is the interesting answer, so routers come last.
const PLATFORM_PROGRAMS: ReadonlyArray<{ id: string; label: string }> = [
  { id: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', label: 'pump' },
  { id: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', label: 'pumpswap' },
  { id: 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj', label: 'launchlab' },
  { id: 'MoonCVVNZFSYkqNXP6bxHLPL6QQJiMagDL3qcqUQTrG', label: 'moonshot' },
  { id: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', label: 'raydium' },
  { id: 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', label: 'raydium' },
  { id: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', label: 'raydium' },
  { id: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', label: 'meteora' },
  { id: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', label: 'jupiter' },
];

type AnyInstruction = ParsedInstruction | PartiallyDecodedInstruction;

function allProgramIds(tx: ParsedTransactionWithMeta): Set<string> {
  const ids = new Set<string>();
  const collect = (ixs: readonly AnyInstruction[] | undefined) => {
    for (const ix of ixs ?? []) {
      const pid = (ix as { programId?: PublicKey }).programId;
      if (pid) ids.add(pid.toBase58());
    }
  };
  collect(tx.transaction.message.instructions as AnyInstruction[]);
  for (const inner of tx.meta?.innerInstructions ?? []) {
    collect(inner.instructions as AnyInstruction[]);
  }
  return ids;
}

// Which venue a trade executed on, from the programs the tx touched.
export function classifyPlatform(tx: ParsedTransactionWithMeta): string {
  const ids = allProgramIds(tx);
  for (const p of PLATFORM_PROGRAMS) {
    if (ids.has(p.id)) return p.label;
  }
  return 'other';
}

// A leader trade annotated with where/when it landed.
export interface TimedTrade extends LeaderTrade {
  slot: number;
  blockTime: number | null;
}

// Net token-amount change for `wallet` in `mint` within one tx (human units).
export function tokenDeltaForWallet(
  tx: ParsedTransactionWithMeta,
  wallet: string,
  mint: string
): number {
  let delta = 0;
  for (const b of tx.meta?.postTokenBalances ?? []) {
    if (b.owner === wallet && b.mint === mint) delta += b.uiTokenAmount.uiAmount ?? 0;
  }
  for (const b of tx.meta?.preTokenBalances ?? []) {
    if (b.owner === wallet && b.mint === mint) delta -= b.uiTokenAmount.uiAmount ?? 0;
  }
  return delta;
}

export interface BuyTxEntry {
  // SOL/token actually paid. Prefers the bonding-curve account's balance
  // delta (the SOL that entered the pool — excludes our fees); falls back to
  // the wallet's own SOL delta (includes fees, mildly overstates price).
  entryPriceSol: number | null;
  // The curve PDA's post-tx SOL balance = real liquidity at the entry instant.
  curveSolAtEntry: number | null;
  buySolIn: number;
  tokensOut: number;
  platform: string;
}

// Reconstruct entry price and at-entry liquidity from the buy tx alone.
export function extractEntryFromBuyTx(
  tx: ParsedTransactionWithMeta,
  wallet: string,
  mint: string
): BuyTxEntry {
  const platform = classifyPlatform(tx);
  const keys = tx.transaction.message.accountKeys;
  const meta = tx.meta;
  const tokensOut = tokenDeltaForWallet(tx, wallet, mint);

  let buySolIn = 0;
  const walletIdx = keys.findIndex((k) => k.pubkey.toBase58() === wallet);
  if (walletIdx >= 0 && meta) {
    buySolIn = Math.max(0, (meta.preBalances[walletIdx] - meta.postBalances[walletIdx]) / LAMPORTS_PER_SOL);
  }

  let curveSolAtEntry: number | null = null;
  let curveSolDelta: number | null = null;
  try {
    const curve = bondingCurvePda(mint).toBase58();
    const curveIdx = keys.findIndex((k) => k.pubkey.toBase58() === curve);
    if (curveIdx >= 0 && meta) {
      curveSolAtEntry = meta.postBalances[curveIdx] / LAMPORTS_PER_SOL;
      curveSolDelta = (meta.postBalances[curveIdx] - meta.preBalances[curveIdx]) / LAMPORTS_PER_SOL;
    }
  } catch {
    // not a valid mint for PDA derivation — leave curve fields null
  }

  let entryPriceSol: number | null = null;
  if (tokensOut > 0) {
    if (curveSolDelta !== null && curveSolDelta > 0) entryPriceSol = curveSolDelta / tokensOut;
    else if (buySolIn > 0) entryPriceSol = buySolIn / tokensOut;
  }
  return { entryPriceSol, curveSolAtEntry, buySolIn, tokensOut, platform };
}

// The incoming SOL transfer that funded `wallet` in this tx, if any.
export function extractIncomingTransfer(
  tx: ParsedTransactionWithMeta,
  wallet: string
): { from: string; sol: number } | null {
  const scan = (ixs: readonly AnyInstruction[] | undefined) => {
    for (const ix of ixs ?? []) {
      const parsed = (ix as ParsedInstruction).parsed as
        | { type?: string; info?: { source?: string; destination?: string; lamports?: number } }
        | undefined;
      if (!parsed || typeof parsed !== 'object') continue;
      if (parsed.type !== 'transfer') continue;
      const info = parsed.info;
      if (info?.destination === wallet && info.source && info.source !== wallet) {
        return { from: info.source, sol: (info.lamports ?? 0) / LAMPORTS_PER_SOL };
      }
    }
    return null;
  };
  const top = scan(tx.transaction.message.instructions as AnyInstruction[]);
  if (top) return top;
  for (const inner of tx.meta?.innerInstructions ?? []) {
    const hit = scan(inner.instructions as AnyInstruction[]);
    if (hit) return hit;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Round trips and behavior stats
// ---------------------------------------------------------------------------

export interface TokenRoundTrip {
  tokenMint: string;
  firstBuySignature: string;
  firstBuySlot: number;
  firstBuyTime: number | null;
  buys: number;
  sells: number;
  buySol: number;
  sellSol: number;
  // First buy -> first sell, seconds. Null when not a completed round trip
  // (or the sample window truncated the pair).
  holdSec: number | null;
  pnlSol: number | null; // null while the position looks still open
}

export function buildRoundTrips(trades: TimedTrade[]): TokenRoundTrip[] {
  const byToken = new Map<
    string,
    { buys: TimedTrade[]; sells: TimedTrade[] }
  >();
  for (const t of trades) {
    const agg = byToken.get(t.tokenMint) ?? { buys: [], sells: [] };
    (t.kind === 'buy' ? agg.buys : agg.sells).push(t);
    byToken.set(t.tokenMint, agg);
  }
  const out: TokenRoundTrip[] = [];
  for (const [mint, agg] of byToken) {
    if (agg.buys.length === 0) continue; // a sell with no sampled buy — truncated
    const firstBuy = agg.buys.reduce((a, b) => (a.slot <= b.slot ? a : b));
    const buySol = agg.buys.reduce((s, t) => s + t.solAmount, 0);
    const sellSol = agg.sells.reduce((s, t) => s + t.solAmount, 0);
    let holdSec: number | null = null;
    if (agg.sells.length > 0) {
      const firstSell = agg.sells.reduce((a, b) => (a.slot <= b.slot ? a : b));
      if (firstBuy.blockTime !== null && firstSell.blockTime !== null) {
        const h = firstSell.blockTime - firstBuy.blockTime;
        if (h >= 0) holdSec = h;
      }
    }
    out.push({
      tokenMint: mint,
      firstBuySignature: firstBuy.signature,
      firstBuySlot: firstBuy.slot,
      firstBuyTime: firstBuy.blockTime,
      buys: agg.buys.length,
      sells: agg.sells.length,
      buySol,
      sellSol,
      holdSec,
      pnlSol: agg.sells.length > 0 ? sellSol - buySol : null,
    });
  }
  // Chronological — period bucketing below depends on it.
  return out.sort((a, b) => a.firstBuySlot - b.firstBuySlot);
}

export function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
}

export interface Distribution {
  n: number;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
}

export function distribution(xs: number[]): Distribution {
  return {
    n: xs.length,
    p10: percentile(xs, 10),
    p25: percentile(xs, 25),
    p50: percentile(xs, 50),
    p75: percentile(xs, 75),
    p90: percentile(xs, 90),
  };
}

export interface PeriodStats {
  label: string;
  roundTrips: number;
  winRate: number;
  pnlSol: number;
  medianHoldSec: number;
  medianBuySol: number;
}

function periodStats(label: string, trips: TokenRoundTrip[]): PeriodStats {
  const completed = trips.filter((t) => t.pnlSol !== null);
  const wins = completed.filter((t) => (t.pnlSol ?? 0) > 0).length;
  return {
    label,
    roundTrips: completed.length,
    winRate: completed.length > 0 ? wins / completed.length : 0,
    pnlSol: completed.reduce((s, t) => s + (t.pnlSol ?? 0), 0),
    medianHoldSec: percentile(
      completed.map((t) => t.holdSec).filter((h): h is number => h !== null),
      50
    ),
    medianBuySol: percentile(completed.map((t) => t.buySol), 50),
  };
}

export interface WalletBehavior {
  wallet: string;
  trades: number; // raw buy+sell events sampled
  tokens: number;
  roundTrips: number;
  winRate: number;
  realizedPnlSol: number;
  oneBuyOneSellFraction: number;
  fastFlipFraction: number; // round trips closed in < 5s
  holdSec: Distribution;
  buySol: Distribution;
  spanDays: number;
  // First half vs second half of the (chronological) round trips — a regime
  // change ("what changed when performance improved") shows as a step here.
  halves: [PeriodStats, PeriodStats];
  weekly: PeriodStats[];
}

const FAST_FLIP_SEC = 5;

export function summarizeWalletBehavior(wallet: string, trades: TimedTrade[]): WalletBehavior {
  const trips = buildRoundTrips(trades);
  const completed = trips.filter((t) => t.pnlSol !== null);
  const wins = completed.filter((t) => (t.pnlSol ?? 0) > 0).length;
  const holds = completed.map((t) => t.holdSec).filter((h): h is number => h !== null);
  const oneToOne = completed.filter((t) => t.buys === 1 && t.sells === 1).length;
  const times = trades.map((t) => t.blockTime).filter((t): t is number => t !== null);
  const spanDays = times.length > 1 ? (Math.max(...times) - Math.min(...times)) / 86_400 : 0;

  const mid = Math.floor(trips.length / 2);
  const halves: [PeriodStats, PeriodStats] = [
    periodStats('first half', trips.slice(0, mid)),
    periodStats('second half', trips.slice(mid)),
  ];

  const weekly: PeriodStats[] = [];
  const withTime = trips.filter((t) => t.firstBuyTime !== null);
  if (withTime.length > 0) {
    const byWeek = new Map<number, TokenRoundTrip[]>();
    for (const t of withTime) {
      const week = Math.floor((t.firstBuyTime ?? 0) / (7 * 86_400));
      byWeek.set(week, [...(byWeek.get(week) ?? []), t]);
    }
    for (const [week, ts] of [...byWeek.entries()].sort((a, b) => a[0] - b[0])) {
      const start = new Date(week * 7 * 86_400 * 1000).toISOString().slice(0, 10);
      weekly.push(periodStats(`week of ${start}`, ts));
    }
  }

  return {
    wallet,
    trades: trades.length,
    tokens: trips.length,
    roundTrips: completed.length,
    winRate: completed.length > 0 ? wins / completed.length : 0,
    realizedPnlSol: completed.reduce((s, t) => s + (t.pnlSol ?? 0), 0),
    oneBuyOneSellFraction: completed.length > 0 ? oneToOne / completed.length : 0,
    fastFlipFraction:
      holds.length > 0 ? holds.filter((h) => h < FAST_FLIP_SEC).length / holds.length : 0,
    holdSec: distribution(holds),
    buySol: distribution(completed.map((t) => t.buySol)),
    spanDays,
    halves,
    weekly,
  };
}

// ---------------------------------------------------------------------------
// RPC walkers (research-time; pacing + caps are the caller's RPC budget)
// ---------------------------------------------------------------------------

export interface WalkOptions {
  maxScanSignatures: number;
  maxParse: number;
  parseSpacingMs: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function getParsed(
  connection: Connection,
  signature: string
): Promise<ParsedTransactionWithMeta | null> {
  try {
    return await retry(
      () =>
        connection.getParsedTransaction(signature, {
          maxSupportedTransactionVersion: 0,
          commitment: 'confirmed',
        }),
      { attempts: 3, baseDelayMs: 400 }
    );
  } catch {
    return null; // one dead tx never kills a research run
  }
}

// Pull a wallet's recent trades (newest maxParse successful txs within a
// maxScanSignatures window), parsed with the same extractor the live
// listeners use. Returns the trades plus the raw parsed buy txs, which the
// snapshot stage mines for entry price / liquidity / platform.
export async function collectWalletTrades(
  connection: Connection,
  wallet: string,
  opts: WalkOptions,
  onProgress?: (done: number, total: number) => void
): Promise<{ trades: TimedTrade[]; buyTxs: Map<string, ParsedTransactionWithMeta> }> {
  const key = new PublicKey(wallet);
  const ok: ConfirmedSignatureInfo[] = [];
  let scanned = 0;
  let before: string | undefined;
  while (scanned < opts.maxScanSignatures && ok.length < opts.maxParse) {
    const limit = Math.min(1000, opts.maxScanSignatures - scanned);
    const batch = await retry(() => connection.getSignaturesForAddress(key, { limit, before }), {
      attempts: 4,
      baseDelayMs: 500,
      label: `getSignaturesForAddress ${wallet.slice(0, 8)}`,
    });
    if (batch.length === 0) break;
    scanned += batch.length;
    for (const s of batch) if (!s.err && ok.length < opts.maxParse) ok.push(s);
    before = batch[batch.length - 1].signature;
    if (batch.length < limit) break;
  }

  const trades: TimedTrade[] = [];
  const buyTxs = new Map<string, ParsedTransactionWithMeta>();
  let done = 0;
  for (const sig of ok) {
    if (done > 0) await sleep(opts.parseSpacingMs);
    done++;
    onProgress?.(done, ok.length);
    const tx = await getParsed(connection, sig.signature);
    if (!tx) continue;
    const trade = extractLeaderTrade(tx, wallet, sig.signature);
    if (!trade) continue;
    trades.push({ ...trade, slot: sig.slot, blockTime: sig.blockTime ?? null });
    if (trade.kind === 'buy') buyTxs.set(sig.signature, tx);
  }
  return { trades, buyTxs };
}

// Pre-entry context of a mint, anchored at a buy signature: everything that
// was publicly visible BEFORE the buy. Anchoring at the buy makes this cheap
// exactly when the entry was early (few prior txs), which is the regime the
// target wallets live in.
export interface PreEntryContext {
  // Total signatures on the mint strictly before the anchor. Null when the
  // scan cap was hit (the token already had deep history at entry).
  txsBeforeEntry: number | null;
  createSignature: string | null;
  createTime: number | null;
  ageSecAtEntry: number | null;
  creator: string | null;
  devBuySol: number | null;
  launchPlatform: string | null;
  // Distinct non-creator fee-payers among the parsed pre-entry txs — the
  // holders-at-entry proxy (exact when txsBeforeEntry <= the parse cap).
  earlyWallets: string[];
  holdersBeforeEntry: number | null;
  buyersPerMinAtEntry: number | null;
}

const PRE_ENTRY_SCAN_PAGES = 3; // x1000 sigs — beyond this the entry wasn't "early"

export async function preEntryContext(
  connection: Connection,
  mint: string,
  buySignature: string,
  buyTime: number | null,
  opts: WalkOptions
): Promise<PreEntryContext> {
  const key = new PublicKey(mint);
  const sigs: ConfirmedSignatureInfo[] = [];
  let before: string | undefined = buySignature;
  let exhausted = false;
  for (let page = 0; page < PRE_ENTRY_SCAN_PAGES; page++) {
    const batch = await retry(
      () => connection.getSignaturesForAddress(key, { limit: 1000, before }),
      { attempts: 4, baseDelayMs: 500, label: `mint history ${mint.slice(0, 8)}` }
    );
    sigs.push(...batch);
    if (batch.length < 1000) {
      exhausted = true;
      break;
    }
    before = batch[batch.length - 1].signature;
  }

  const ctx: PreEntryContext = {
    txsBeforeEntry: exhausted ? sigs.length : null,
    createSignature: null,
    createTime: null,
    ageSecAtEntry: null,
    creator: null,
    devBuySol: null,
    launchPlatform: null,
    earlyWallets: [],
    holdersBeforeEntry: null,
    buyersPerMinAtEntry: null,
  };

  // Oldest signature = the mint's creation tx (only knowable when the page
  // chain bottomed out).
  if (exhausted && sigs.length > 0) {
    const createSig = sigs[sigs.length - 1];
    ctx.createSignature = createSig.signature;
    ctx.createTime = createSig.blockTime ?? null;
    if (buyTime !== null && ctx.createTime !== null) {
      ctx.ageSecAtEntry = Math.max(0, buyTime - ctx.createTime);
    }
    const createTx = await getParsed(connection, createSig.signature);
    if (createTx) {
      ctx.launchPlatform = classifyPlatform(createTx);
      const keys = createTx.transaction.message.accountKeys;
      ctx.creator = (keys.find((k) => k.signer) ?? keys[0])?.pubkey.toBase58() ?? null;
      // Creator's SOL outlay in the create tx ≈ dev co-deposit (plus fees).
      if (ctx.creator) {
        const idx = keys.findIndex((k) => k.pubkey.toBase58() === ctx.creator);
        const meta = createTx.meta;
        if (idx >= 0 && meta) {
          ctx.devBuySol = Math.max(0, (meta.preBalances[idx] - meta.postBalances[idx]) / LAMPORTS_PER_SOL);
        }
      }
    }
  }

  // Holders proxy: parse the OLDEST pre-entry txs (launch-window buyers,
  // including any same-slot snipers) up to the budget.
  const toParse = sigs
    .filter((s) => !s.err)
    .slice(-Math.min(opts.maxParse, sigs.length))
    .reverse(); // oldest first
  const payers = new Set<string>();
  let parsed = 0;
  for (const s of toParse) {
    if (parsed > 0) await sleep(opts.parseSpacingMs);
    parsed++;
    const tx = await getParsed(connection, s.signature);
    if (!tx) continue;
    const payer = tx.transaction.message.accountKeys.find((k) => k.signer)?.pubkey.toBase58();
    if (payer && payer !== ctx.creator) payers.add(payer);
  }
  ctx.earlyWallets = [...payers];
  // Exact census only when we parsed everything that predated the entry.
  ctx.holdersBeforeEntry =
    exhausted && toParse.length === sigs.filter((s) => !s.err).length ? payers.size : null;
  if (ctx.holdersBeforeEntry !== null && ctx.ageSecAtEntry !== null && ctx.ageSecAtEntry > 0) {
    ctx.buyersPerMinAtEntry = ctx.holdersBeforeEntry / (ctx.ageSecAtEntry / 60);
  }
  return ctx;
}

export interface CreatorContext {
  priorTxs: number | null;
  ageDaysAtLaunch: number | null;
  saturated: boolean;
  funder: string | null;
  funderSol: number | null;
}

// The creator wallet's state AT LAUNCH TIME (history strictly before the
// create tx) plus its original funding source. Fresh disposable wallets —
// the interesting case — have tiny histories, so the funder walk is cheap
// exactly when it matters; saturated wallets return funder=null.
export async function creatorContext(
  connection: Connection,
  creator: string,
  createSignature: string,
  createTime: number | null,
  opts: WalkOptions
): Promise<CreatorContext> {
  const key = new PublicKey(creator);
  const sigs = await retry(
    () => connection.getSignaturesForAddress(key, { limit: 1000, before: createSignature }),
    { attempts: 4, baseDelayMs: 500, label: `creator history ${creator.slice(0, 8)}` }
  );
  const saturated = sigs.length >= 1000;
  const oldest = sigs.length > 0 ? sigs[sigs.length - 1] : null;
  const ageDaysAtLaunch =
    createTime !== null && oldest?.blockTime
      ? Math.max(0, (createTime - oldest.blockTime) / 86_400)
      : null;

  let funder: string | null = null;
  let funderSol: number | null = null;
  if (!saturated && oldest) {
    // The oldest pre-create tx is the wallet's first activity; for a fresh
    // wallet that is its funding transfer. Scan the oldest few in case the
    // very first was something else (e.g. an ATA create).
    const oldestFew = sigs.slice(-3).reverse();
    for (const s of oldestFew) {
      if (s.err) continue;
      const tx = await getParsed(connection, s.signature);
      if (!tx) continue;
      const incoming = extractIncomingTransfer(tx, creator);
      if (incoming) {
        funder = incoming.from;
        funderSol = incoming.sol;
        break;
      }
      await sleep(opts.parseSpacingMs);
    }
  }
  return { priorTxs: sigs.length, ageDaysAtLaunch, saturated, funder, funderSol };
}

// ---------------------------------------------------------------------------
// Cross-wallet analysis
// ---------------------------------------------------------------------------

export interface CoBuyGroup {
  tokenMint: string;
  wallets: string[];
  // Wallet pairs that bought in the SAME slot (the same-block signature).
  sameSlotWallets: string[][];
  // Seconds between the earliest and latest target-wallet entry.
  entrySpreadSec: number | null;
}

// Tokens bought by >=2 target wallets, with same-slot grouping — the
// "do they buy together, in the same block?" question, answered exactly
// from each wallet's own buy slots (no extra RPC).
export function findCoBuys(tripsByWallet: Map<string, TokenRoundTrip[]>): CoBuyGroup[] {
  const byToken = new Map<string, { wallet: string; slot: number; time: number | null }[]>();
  for (const [wallet, trips] of tripsByWallet) {
    for (const t of trips) {
      byToken.set(t.tokenMint, [
        ...(byToken.get(t.tokenMint) ?? []),
        { wallet, slot: t.firstBuySlot, time: t.firstBuyTime },
      ]);
    }
  }
  const groups: CoBuyGroup[] = [];
  for (const [mint, buys] of byToken) {
    if (buys.length < 2) continue;
    const bySlot = new Map<number, string[]>();
    for (const b of buys) bySlot.set(b.slot, [...(bySlot.get(b.slot) ?? []), b.wallet]);
    const sameSlot = [...bySlot.values()].filter((ws) => ws.length >= 2);
    const times = buys.map((b) => b.time).filter((t): t is number => t !== null);
    groups.push({
      tokenMint: mint,
      wallets: buys.map((b) => b.wallet),
      sameSlotWallets: sameSlot,
      entrySpreadSec: times.length >= 2 ? Math.max(...times) - Math.min(...times) : null,
    });
  }
  return groups.sort((a, b) => b.wallets.length - a.wallets.length);
}

// Addresses recurring across distinct tokens (serial deployers / shared
// funding wallets / suspected cluster members).
export function recurringAddresses(
  perToken: Map<string, string | string[] | null>,
  minTokens: number
): Array<{ address: string; tokens: number }> {
  const counts = new Map<string, Set<string>>();
  for (const [token, value] of perToken) {
    const addrs = value === null ? [] : Array.isArray(value) ? value : [value];
    for (const a of addrs) {
      if (!counts.has(a)) counts.set(a, new Set());
      counts.get(a)!.add(token);
    }
  }
  return [...counts.entries()]
    .map(([address, tokens]) => ({ address, tokens: tokens.size }))
    .filter((r) => r.tokens >= minTokens)
    .sort((a, b) => b.tokens - a.tokens);
}

// ---------------------------------------------------------------------------
// Entry snapshots — the per-buy evidence record the backtest replays
// ---------------------------------------------------------------------------

export interface EntrySnapshot {
  wallet: string;
  tokenMint: string;
  buySignature: string;
  buySlot: number;
  buyTime: number | null;
  platform: string;
  launchPlatform: string | null;
  entryPriceSol: number | null;
  entryMcapUsd: number | null;
  solUsdUsed: number | null;
  curveSolAtEntry: number | null;
  buySolIn: number;
  ageSecAtEntry: number | null;
  txsBeforeEntry: number | null;
  holdersBeforeEntry: number | null;
  buyersPerMinAtEntry: number | null;
  creator: string | null;
  createSignature: string | null;
  devBuySol: number | null;
  creatorPriorTxs: number | null;
  creatorAgeDaysAtLaunch: number | null;
  creatorSaturated: boolean;
  funder: string | null;
  // Other TARGET wallets relative to this entry (filled by the cross phase).
  targetCoBuyersSameSlot: string[];
  targetBuyersEarlier: string[];
  // Outcome of the wallet's own round trip on this token.
  pnlSol: number | null;
  holdSec: number | null;
  // Did any PUBLIC pre-entry signal exist? Decides whether a public-data
  // scanner can find this class of entry at all (see design doc).
  explainable: boolean;
  explainableReasons: string[];
}

// Map a research snapshot onto the live scanner's feature shape so the
// backtest scores with the production scoreDiscovery. Bundle/mayhem/devSold
// aren't reconstructible historically and default to "no veto" — backtest
// recall is therefore an upper bound, stated in the report.
export function snapshotToFeatures(s: EntrySnapshot): DiscoveryFeatures {
  const smartBuys = new Set([...s.targetBuyersEarlier, ...s.targetCoBuyersSameSlot]).size;
  return {
    tokenMint: s.tokenMint,
    platform: s.platform,
    ageSec: s.ageSecAtEntry,
    mcapUsd: s.entryMcapUsd,
    liquiditySol: s.curveSolAtEntry,
    devBuySol: s.devBuySol,
    uniqueBuyers: s.holdersBeforeEntry,
    buyersPerMin: s.buyersPerMinAtEntry,
    txPerMin:
      s.txsBeforeEntry !== null && s.ageSecAtEntry !== null && s.ageSecAtEntry > 0
        ? s.txsBeforeEntry / (s.ageSecAtEntry / 60)
        : null,
    buyerDiversity: null,
    smartWalletBuys: smartBuys,
    bundledLaunch: false,
    launchSlotBuyers: 0,
    mayhem: false,
    creator: s.creator,
    creatorPriorTxs: s.creatorPriorTxs,
    creatorAgeDays: s.creatorAgeDaysAtLaunch,
    creatorSaturated: s.creatorSaturated,
    funder: s.funder,
    creatorIntel: null,
    funderIntel: null,
    hasMetadata: true,
    devSold: false,
  };
}

// Distill the measured snapshots into scanner thresholds. Percentile-based
// with sane clamps so a thin sample can't produce a degenerate profile;
// fields without enough evidence keep the built-in defaults.
export function deriveDiscoveryProfile(
  snapshots: EntrySnapshot[],
  targetWallets: string[]
): DiscoveryProfile {
  const profile: DiscoveryProfile = { ...DEFAULT_DISCOVERY_PROFILE };
  const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

  const mcaps = snapshots
    .map((s) => s.entryMcapUsd)
    .filter((m): m is number => m !== null && m > 0);
  if (mcaps.length >= 5) {
    profile.maxEntryMcapUsd = Math.round(clamp(percentile(mcaps, 90) * 1.5, 6_000, 60_000));
  }
  const ages = snapshots
    .map((s) => s.ageSecAtEntry)
    .filter((a): a is number => a !== null);
  if (ages.length >= 5) {
    profile.maxTokenAgeSec = Math.round(clamp(percentile(ages, 90) * 2, 300, 7_200));
  }
  const devBuys = snapshots
    .map((s) => s.devBuySol)
    .filter((d): d is number => d !== null && d > 0);
  if (devBuys.length >= 5) {
    profile.devBuyMinSol = Number(clamp(percentile(devBuys, 10), 0, 5).toFixed(2));
    profile.devBuyMaxSol = Number(clamp(percentile(devBuys, 90) * 1.5, 1, 50).toFixed(2));
  }
  const buyerRates = snapshots
    .map((s) => s.buyersPerMinAtEntry)
    .filter((b): b is number => b !== null && b > 0);
  if (buyerRates.length >= 5) {
    profile.minBuyersPerMin = Number(clamp(percentile(buyerRates, 25), 1, 60).toFixed(1));
  }
  const txRates = snapshots
    .map((s) =>
      s.txsBeforeEntry !== null && s.ageSecAtEntry !== null && s.ageSecAtEntry > 0
        ? s.txsBeforeEntry / (s.ageSecAtEntry / 60)
        : null
    )
    .filter((t): t is number => t !== null && t > 0);
  if (txRates.length >= 5) {
    profile.minTxPerMin = Number(clamp(percentile(txRates, 25), 2, 120).toFixed(1));
  }

  profile.smartWallets = [...targetWallets];
  const byCreator = new Map<string, string | null>(
    snapshots.map((s) => [s.tokenMint, s.creator])
  );
  profile.knownGoodDeployers = recurringAddresses(byCreator, 2).map((r) => r.address);
  const byFunder = new Map<string, string | null>(snapshots.map((s) => [s.tokenMint, s.funder]));
  profile.knownGoodFunders = recurringAddresses(byFunder, 2).map((r) => r.address);
  return profile;
}
