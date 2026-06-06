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
import { Connection, PublicKey } from '@solana/web3.js';
import { readFileSync } from 'fs';
import { extractLeaderTrade } from '../src/walletListener';

// Newest N signatures to pull per wallet (getSignaturesForAddress caps at 1000).
// Newest N signatures to pull per wallet. Fetched and parsed one at a time —
// batched RPC (getParsedTransactions) is rejected by the free Helius tier —
// so this is kept modest to keep a vetting run to a few minutes per wallet.
const MAX_SIGNATURES = 250;

// Advisory PASS bar. Looser than the canonical 30-trades/60-day rule because
// the sample is bounded — the printed raw numbers are the real decision input.
const MIN_TRADES = 15;
// Realistic floor: good memecoin traders run 30-50% win rates (they cut losers
// fast and let winners pay for everything), so net realized PnL is the real
// gate, not win rate. 0.55 rejected every genuinely-profitable wallet.
const MIN_WIN_RATE = 0.3;
const MAX_LAST_TRADE_DAYS = 14;

interface WalletReport {
  wallet: string;
  sampleTxs: number;
  spanDays: number;
  trades: number; // completed round-trips
  winRate: number;
  realizedPnlSol: number;
  lastTradeAgoH: number;
  verdict: 'PASS' | 'FAIL';
  reasons: string[];
}

interface TokenAgg {
  buySol: number;
  sellSol: number;
  buys: number;
  sells: number;
}

async function vetWallet(connection: Connection, wallet: string): Promise<WalletReport> {
  const sigInfos = await connection.getSignaturesForAddress(new PublicKey(wallet), {
    limit: MAX_SIGNATURES,
  });
  const sigs = sigInfos.filter((s) => !s.err);

  const byToken = new Map<string, TokenAgg>();
  const tradeTimes: number[] = [];
  const allTimes: number[] = [];

  for (const sig of sigs) {
    const tx = await connection.getParsedTransaction(sig.signature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    });
    const blockTime = sig.blockTime ?? 0;
    if (blockTime) allTimes.push(blockTime);
    const trade = extractLeaderTrade(tx, wallet, sig.signature);
    if (!trade) continue;
    if (blockTime) tradeTimes.push(blockTime);
    const agg = byToken.get(trade.tokenMint) ?? { buySol: 0, sellSol: 0, buys: 0, sells: 0 };
    if (trade.kind === 'buy') {
      agg.buySol += trade.solAmount;
      agg.buys += 1;
    } else {
      agg.sellSol += trade.solAmount;
      agg.sells += 1;
    }
    byToken.set(trade.tokenMint, agg);
  }

  // A completed round-trip = a token the wallet both bought and sold.
  let trades = 0;
  let wins = 0;
  let realizedPnlSol = 0;
  for (const agg of byToken.values()) {
    if (agg.buys === 0 || agg.sells === 0) continue;
    trades += 1;
    const pnl = agg.sellSol - agg.buySol;
    realizedPnlSol += pnl;
    if (pnl > 0) wins += 1;
  }
  const winRate = trades > 0 ? wins / trades : 0;

  const now = Date.now() / 1000;
  const spanDays =
    allTimes.length > 1 ? (Math.max(...allTimes) - Math.min(...allTimes)) / 86_400 : 0;
  const lastTradeAgoH =
    tradeTimes.length > 0 ? (now - Math.max(...tradeTimes)) / 3_600 : Infinity;

  const reasons: string[] = [];
  if (trades < MIN_TRADES) reasons.push(`only ${trades} round-trips (want >=${MIN_TRADES})`);
  if (winRate < MIN_WIN_RATE)
    reasons.push(`win rate ${(winRate * 100).toFixed(0)}% (want >=${MIN_WIN_RATE * 100}%)`);
  if (realizedPnlSol <= 0) reasons.push(`realized PnL ${realizedPnlSol.toFixed(2)} SOL not positive`);
  if (lastTradeAgoH / 24 > MAX_LAST_TRADE_DAYS)
    reasons.push(`last trade ${(lastTradeAgoH / 24).toFixed(0)}d ago (want <${MAX_LAST_TRADE_DAYS}d)`);

  return {
    wallet,
    sampleTxs: sigs.length,
    spanDays,
    trades,
    winRate,
    realizedPnlSol,
    lastTradeAgoH,
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
  console.log(`  sample:       ${r.sampleTxs} txs over ${r.spanDays.toFixed(1)} days`);
  console.log(`  round-trips:  ${r.trades}  (last trade ${ago})`);
  console.log(`  win rate:     ${(r.winRate * 100).toFixed(0)}%`);
  console.log(`  realized PnL: ${r.realizedPnlSol >= 0 ? '+' : ''}${r.realizedPnlSol.toFixed(2)} SOL`);
  console.log(`  VERDICT: ${r.verdict}${r.reasons.length ? ' — ' + r.reasons.join('; ') : ''}`);
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

async function main(): Promise<void> {
  const wallets = readWallets();
  if (wallets.length === 0) {
    console.error('Usage: ts-node scripts/vet-wallet.ts <addr> [<addr> ...] | --file wallets.txt');
    process.exit(1);
  }
  // Read-only diagnostic — it needs only an RPC endpoint, not the trading
  // config (no wallet key / API keys required).
  const rpcUrl = process.env.SOLANA_RPC_URL?.trim() || 'https://api.mainnet-beta.solana.com';
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
