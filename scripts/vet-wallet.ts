// Wallet vetter: given one or more Solana wallet addresses, pull each
// wallet's recent on-chain trade history and score it against the copy-
// trading bar — so seed wallets are VERIFIED on-chain, not trusted from a
// leaderboard screenshot.
//
// It reuses extractLeaderTrade — the exact buy/sell parser the live copytrade
// listener uses — so the vetting reflects what the bot would actually see.
//
// Usage:
//   npx ts-node scripts/vet-wallet.ts <addr> [<addr> ...]
//   npx ts-node scripts/vet-wallet.ts --file wallets.txt   (one address/line)
//
// Caveats: (1) the sample is the most recent MAX_SIGNATURES txs — for a hyper-
// active wallet that may span only days; spanDays is reported so the depth is
// visible. (2) PnL counts only realized round-trips (token bought AND sold);
// a still-held winning bag is excluded, so PnL is conservative. (3) buy size
// includes fees, so realized PnL is mildly pessimistic. Good for a directional
// quality read, not exact accounting.

import 'dotenv/config';
import { Connection, PublicKey, ConfirmedSignatureInfo } from '@solana/web3.js';
import { extractLeaderTrade } from '../src/walletListener';
import { readWalletList } from './walletList';
import { retry } from '../src/concurrency';
import { resolveRpcUrls } from '../src/config';

// How many SUCCESSFUL txs to actually parse per wallet. Hyperactive wallets
// (snipers/MEV) bury their wins under thousands of reverts, so a flat "newest
// N" fetch can land entirely inside a revert burst and see zero round-trips.
// We scan signatures (cheap) up to MAX_SCAN_SIGNATURES, count the failed
// fraction over that window, and parse only the newest MAX_SIGNATURES
// non-errored ones. Both are env-overridable for a deep re-vet:
//   VET_OK_TARGET -> MAX_SIGNATURES        (successful txs to parse)
//   VET_MAX_SCAN  -> MAX_SCAN_SIGNATURES   (signature scan ceiling)
// Defaults keep a normal run to a few minutes; batched RPC (getParsedTransactions)
// is rejected by the free Helius tier, so everything is one page / one tx at a time.
const MAX_SIGNATURES = Number(process.env.VET_OK_TARGET) || 250;
const MAX_SCAN_SIGNATURES = Math.max(MAX_SIGNATURES, Number(process.env.VET_MAX_SCAN) || 250);
const SIG_PAGE = 1000; // getSignaturesForAddress hard cap per call

// Advisory PASS bar. Looser than the canonical 30-trades/60-day rule because
// the sample is bounded — the printed raw numbers are the real decision input.
const MIN_TRADES = 15;
// Realistic floor: good memecoin traders run 30-50% win rates (they cut losers
// fast and let winners pay for everything), so net realized PnL is the real
// gate, not win rate. 0.55 rejected every genuinely-profitable wallet.
const MIN_WIN_RATE = 0.3;
const MAX_LAST_TRADE_DAYS = 14;

// Above this failed-tx fraction the wallet is almost certainly an HFT/MEV bot
// spamming reverting buys, not a discretionary trader. Its edge is speed we
// can't replicate, and our copy listener skips errored txs anyway, so it is
// not a copyable leader regardless of headline PnL.
const MAX_FAILED_FRACTION = 0.6;

// A round-trip closed within this many seconds is a near-instant flip. A wallet
// that does this on a big share of trades is a sniper/MEV bot whose entry-to-
// exit speed we cannot mirror at our poll+land latency (it would dump before
// our copy-buy lands). Threshold from community vetting guides (~5s sells).
const FAST_FLIP_SEC = 5;
const MAX_FAST_FLIP_FRACTION = 0.2;

// Our copy latency is ~8s (poll interval + land time). A wallet whose MEDIAN
// hold sits below a small multiple of that exits the typical position before our
// copy-buy lands — we'd be buying its exit. The fast-flip fraction catches
// wallets that are *sometimes* instant; this catches wallets that are
// *consistently* faster than we can copy (e.g. a 6s median that ducks under the
// 5s fast-flip bar but is still uncopyable for us).
const MIN_MEDIAN_HOLD_SEC = 20;

// Wash-trade signature: most of the wallet's volume cycling through ONE token
// with very short holds. Flag when one token is >= this share of buy volume
// AND the median hold is under WASH_MAX_HOLD_MIN — the two together, not either
// alone (a legit trader can concentrate, or hold briefly, but rarely both).
const WASH_CONCENTRATION = 0.4;
const WASH_MAX_HOLD_MIN = 10;

interface WalletReport {
  wallet: string;
  fetchedTxs: number; // total signatures pulled (incl. failed)
  failedFraction: number;
  sampleTxs: number; // non-errored signatures actually parsed
  spanDays: number;
  trades: number; // completed round-trips
  winRate: number;
  realizedPnlSol: number;
  lastTradeAgoH: number;
  medianHoldMin: number; // median round-trip hold (first buy -> first sell)
  fastFlipFraction: number; // share of round-trips closed within FAST_FLIP_SEC
  maxTokenShare: number; // largest single token's share of total buy volume
  verdict: 'PASS' | 'FAIL';
  reasons: string[];
}

interface TokenAgg {
  buySol: number;
  sellSol: number;
  buys: number;
  sells: number;
  buyTimes: number[];
  sellTimes: number[];
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Page through a wallet's signatures (newest first), collecting the SUCCESSFUL
// ones up to MAX_SIGNATURES while scanning at most MAX_SCAN_SIGNATURES total.
// Returns the ok sigs to parse plus the scanned count so the caller can report
// the failed fraction over the whole window actually scanned.
async function collectSignatures(
  connection: Connection,
  wallet: string
): Promise<{ ok: ConfirmedSignatureInfo[]; scanned: number }> {
  const key = new PublicKey(wallet);
  const ok: ConfirmedSignatureInfo[] = [];
  let scanned = 0;
  let before: string | undefined;
  while (scanned < MAX_SCAN_SIGNATURES && ok.length < MAX_SIGNATURES) {
    const limit = Math.min(SIG_PAGE, MAX_SCAN_SIGNATURES - scanned);
    const batch = await retry(() => connection.getSignaturesForAddress(key, { limit, before }), {
      attempts: 4,
      baseDelayMs: 500,
      label: `getSignaturesForAddress ${wallet.slice(0, 8)}`,
    });
    if (batch.length === 0) break;
    scanned += batch.length;
    for (const s of batch) if (!s.err && ok.length < MAX_SIGNATURES) ok.push(s);
    before = batch[batch.length - 1].signature;
    if (batch.length < limit) break;
  }
  return { ok, scanned };
}

async function vetWallet(connection: Connection, wallet: string): Promise<WalletReport> {
  const { ok: sigs, scanned } = await collectSignatures(connection, wallet);
  const failedFraction = scanned > 0 ? (scanned - sigs.length) / scanned : 0;

  const byToken = new Map<string, TokenAgg>();
  const tradeTimes: number[] = [];
  const allTimes: number[] = [];

  for (const sig of sigs) {
    const blockTime = sig.blockTime ?? 0;
    if (blockTime) allTimes.push(blockTime);
    let tx;
    try {
      tx = await retry(
        () =>
          connection.getParsedTransaction(sig.signature, {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed',
          }),
        { attempts: 3, baseDelayMs: 400 }
      );
    } catch {
      continue; // transient RPC failure on one tx — skip it, don't kill the run
    }
    const trade = extractLeaderTrade(tx, wallet, sig.signature);
    if (!trade) continue;
    if (blockTime) tradeTimes.push(blockTime);
    const agg = byToken.get(trade.tokenMint) ?? {
      buySol: 0,
      sellSol: 0,
      buys: 0,
      sells: 0,
      buyTimes: [],
      sellTimes: [],
    };
    if (trade.kind === 'buy') {
      agg.buySol += trade.solAmount;
      agg.buys += 1;
      if (blockTime) agg.buyTimes.push(blockTime);
    } else {
      agg.sellSol += trade.solAmount;
      agg.sells += 1;
      if (blockTime) agg.sellTimes.push(blockTime);
    }
    byToken.set(trade.tokenMint, agg);
  }

  // A completed round-trip = a token the wallet both bought and sold.
  let trades = 0;
  let wins = 0;
  let realizedPnlSol = 0;
  let totalBuySol = 0;
  let maxTokenBuySol = 0;
  const holdSecs: number[] = [];
  for (const agg of byToken.values()) {
    totalBuySol += agg.buySol;
    if (agg.buySol > maxTokenBuySol) maxTokenBuySol = agg.buySol;
    if (agg.buys === 0 || agg.sells === 0) continue;
    trades += 1;
    const pnl = agg.sellSol - agg.buySol;
    realizedPnlSol += pnl;
    if (pnl > 0) wins += 1;
    // Hold = first buy -> first sell. Skip if the sample only caught a sell
    // that predates the buy (truncated window) -> negative, not a real hold.
    const hold = Math.min(...agg.sellTimes) - Math.min(...agg.buyTimes);
    if (Number.isFinite(hold) && hold >= 0) holdSecs.push(hold);
  }
  const winRate = trades > 0 ? wins / trades : 0;
  const medianHoldMin = holdSecs.length > 0 ? median(holdSecs) / 60 : 0;
  const fastFlipFraction =
    holdSecs.length > 0 ? holdSecs.filter((h) => h < FAST_FLIP_SEC).length / holdSecs.length : 0;
  const maxTokenShare = totalBuySol > 0 ? maxTokenBuySol / totalBuySol : 0;

  const now = Date.now() / 1000;
  const spanDays =
    allTimes.length > 1 ? (Math.max(...allTimes) - Math.min(...allTimes)) / 86_400 : 0;
  const lastTradeAgoH =
    tradeTimes.length > 0 ? (now - Math.max(...tradeTimes)) / 3_600 : Infinity;

  const reasons: string[] = [];
  if (failedFraction > MAX_FAILED_FRACTION)
    reasons.push(
      `${(failedFraction * 100).toFixed(0)}% of recent txs failed — likely an HFT/MEV bot, not copyable`
    );
  if (fastFlipFraction > MAX_FAST_FLIP_FRACTION)
    reasons.push(
      `${(fastFlipFraction * 100).toFixed(0)}% of round-trips flip in <${FAST_FLIP_SEC}s — sniper/bot, too fast to copy`
    );
  if (trades > 0 && medianHoldMin * 60 < MIN_MEDIAN_HOLD_SEC)
    reasons.push(
      `median hold ${(medianHoldMin * 60).toFixed(0)}s under ${MIN_MEDIAN_HOLD_SEC}s — too fast to copy at our ~8s latency`
    );
  if (maxTokenShare >= WASH_CONCENTRATION && medianHoldMin < WASH_MAX_HOLD_MIN && trades > 0)
    reasons.push(
      `wash-trade pattern: ${(maxTokenShare * 100).toFixed(0)}% of volume in one token with ${medianHoldMin.toFixed(1)}min median hold`
    );
  if (trades < MIN_TRADES) reasons.push(`only ${trades} round-trips (want >=${MIN_TRADES})`);
  if (winRate < MIN_WIN_RATE)
    reasons.push(`win rate ${(winRate * 100).toFixed(0)}% (want >=${MIN_WIN_RATE * 100}%)`);
  if (realizedPnlSol <= 0) reasons.push(`realized PnL ${realizedPnlSol.toFixed(2)} SOL not positive`);
  if (lastTradeAgoH / 24 > MAX_LAST_TRADE_DAYS)
    reasons.push(`last trade ${(lastTradeAgoH / 24).toFixed(0)}d ago (want <${MAX_LAST_TRADE_DAYS}d)`);

  return {
    wallet,
    fetchedTxs: scanned,
    failedFraction,
    sampleTxs: sigs.length,
    spanDays,
    trades,
    winRate,
    realizedPnlSol,
    lastTradeAgoH,
    medianHoldMin,
    fastFlipFraction,
    maxTokenShare,
    verdict: reasons.length === 0 ? 'PASS' : 'FAIL',
    reasons,
  };
}

function printReport(r: WalletReport): void {
  const ago =
    r.lastTradeAgoH === Infinity
      ? 'no trades'
      : r.lastTradeAgoH < 48
        ? `${r.lastTradeAgoH.toFixed(0)}h ago`
        : `${(r.lastTradeAgoH / 24).toFixed(0)}d ago`;
  console.log(`\n=== ${r.wallet} ===`);
  console.log(
    `  sample:       ${r.sampleTxs} ok txs over ${r.spanDays.toFixed(1)} days ` +
      `(${r.fetchedTxs} fetched, ${(r.failedFraction * 100).toFixed(0)}% failed)`
  );
  console.log(`  round-trips:  ${r.trades}  (last trade ${ago})`);
  console.log(`  win rate:     ${(r.winRate * 100).toFixed(0)}%`);
  console.log(`  realized PnL: ${r.realizedPnlSol >= 0 ? '+' : ''}${r.realizedPnlSol.toFixed(2)} SOL`);
  console.log(`  median hold:  ${r.medianHoldMin.toFixed(1)} min`);
  console.log(`  fast flips:   ${(r.fastFlipFraction * 100).toFixed(0)}% under ${FAST_FLIP_SEC}s`);
  console.log(`  concentration: ${(r.maxTokenShare * 100).toFixed(0)}% of buy vol in top token`);
  console.log(`  VERDICT: ${r.verdict}${r.reasons.length ? ' — ' + r.reasons.join('; ') : ''}`);
}

function readWallets(): string[] {
  const args = process.argv.slice(2);
  const fileIdx = args.indexOf('--file');
  if (fileIdx >= 0) {
    const path = args[fileIdx + 1];
    if (!path) throw new Error('--file needs a path');
    return readWalletList(path);
  }
  return args.filter((a) => !a.startsWith('--'));
}

async function main(): Promise<void> {
  const wallets = readWallets();
  if (wallets.length === 0) {
    console.error('Usage: ts-node scripts/vet-wallet.ts <addr> [<addr> ...] | --file wallets.txt');
    process.exit(1);
  }
  // Read-only diagnostic — it needs only an RPC endpoint, not the trading
  // config (no wallet key / API keys required).
  const { rpcUrl } = resolveRpcUrls();
  const connection = new Connection(rpcUrl, 'confirmed');
  console.log(`Vetting ${wallets.length} wallet(s) — newest ${MAX_SIGNATURES} txs each...`);

  const passed: string[] = [];
  for (const wallet of wallets) {
    try {
      const report = await vetWallet(connection, wallet);
      printReport(report);
      if (report.verdict === 'PASS') passed.push(wallet);
    } catch (err) {
      console.log(`\n=== ${wallet} ===\n  ERROR: ${(err as Error).message}`);
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`PASSED (${passed.length}/${wallets.length}) — candidate COPYTRADE_WALLETS:`);
  console.log(passed.join(',') || '  (none)');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
