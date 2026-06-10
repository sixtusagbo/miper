// Leader discovery: given the token mints WE already won on, find the wallets
// that bought those tokens EARLY (the first launch-window buys). A wallet that
// shows up early across MULTIPLE of our winners is high-signal smart money
// operating in our exact niche — no leaderboard to trust.
//
// Discovery is deliberately noisy: snipers, MEV bots and the dev wallet also
// buy early. It only produces CANDIDATES. The quality gate is vet-wallet.ts —
// run the ranked output through it; the >=2-winner wallets first.
//
// Usage:
//   DOTENV_CONFIG_PATH=.env.vet npx ts-node scripts/find-cobuyers.ts <mint> [<mint> ...]
//   DOTENV_CONFIG_PATH=.env.vet npx ts-node scripts/find-cobuyers.ts --file mints.txt
//
// Reuses extractLeaderTrade — the exact parser the live listener uses — so a
// detected "buy" here is a buy the bot would also recognise.

import 'dotenv/config';
import { Connection, PublicKey } from '@solana/web3.js';
import { readFileSync } from 'fs';
import { extractLeaderTrade } from '../src/walletListener';
import { retry } from '../src/concurrency';
import { resolveRpcUrls } from '../src/config';

// Oldest N signatures per mint to inspect — the launch window where the smart
// early buyers land. Bigger = more candidates but more RPC.
const EARLY_TX = 200;
// Cap pagination so a mega-volume token can't run the crawl away. 40 pages of
// 1000 = 40k txs; far more than any pump token has in its first hours.
const MAX_PAGES = 40;
const PAGE = 1000;

// Our own bot wallet + current leaders never count as candidates (the bot
// bought these winners by copying, so it shows up as an "early buyer").
const EXCLUDE = new Set<string>([
  'EcehC76ATmta8RBiYnMwSTDTGYCxSzodCq7XQbeBuQL2', // our bot wallet
  'BQVz7fQ1WsQmSTMY3umdPEPPTm1sdcBcX9sP7o6kPRmB', // Limfork
  'DVMkhiQe1D8yenuEgsW44NjRn9LfVQjGEpZcez5x7Mff', // iceman
  '525LueqAyZJueCoiisfWy6nyh4MTvmF4X9jSqi6efXJT', // Joji
  '6S8GezkxYUfZy9JPtYnanbcZTMB87Wjt1qx3c6ELajKC', // Nyhrox
]);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Page newest->oldest until the chain of signatures is exhausted (or the cap),
// then return only the OLDEST EARLY_TX of them — the launch window.
async function oldestSignatures(conn: Connection, mint: string): Promise<string[]> {
  const key = new PublicKey(mint);
  let before: string | undefined;
  const ok: string[] = [];
  for (let p = 0; p < MAX_PAGES; p++) {
    const batch = await retry(() => conn.getSignaturesForAddress(key, { limit: PAGE, before }), {
      attempts: 4,
      baseDelayMs: 500,
      label: `getSignaturesForAddress ${mint.slice(0, 8)}`,
    });
    if (batch.length === 0) break;
    for (const b of batch) if (!b.err) ok.push(b.signature);
    before = batch[batch.length - 1].signature;
    if (batch.length < PAGE) break;
    await sleep(120);
  }
  return ok.slice(Math.max(0, ok.length - EARLY_TX));
}

async function earlyBuyers(conn: Connection, mint: string): Promise<Set<string>> {
  const sigs = await oldestSignatures(conn, mint);
  const buyers = new Set<string>();
  for (const sig of sigs) {
    let tx;
    try {
      tx = await retry(
        () =>
          conn.getParsedTransaction(sig, {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed',
          }),
        { attempts: 3, baseDelayMs: 400 }
      );
    } catch {
      continue;
    }
    if (!tx) continue;
    const keys = tx.transaction.message.accountKeys;
    const feePayer = (keys.find((k) => k.signer) ?? keys[0])?.pubkey.toBase58();
    if (!feePayer || EXCLUDE.has(feePayer)) continue;
    const trade = extractLeaderTrade(tx, feePayer, sig);
    if (trade && trade.kind === 'buy' && trade.tokenMint === mint) buyers.add(feePayer);
    await sleep(60);
  }
  return buyers;
}

async function main(): Promise<void> {
  const rpc = resolveRpcUrls().rpcUrl;
  const conn = new Connection(rpc, 'confirmed');

  let args = process.argv.slice(2);
  if (args[0] === '--file') {
    args = readFileSync(args[1], 'utf8')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const mints = args.filter(Boolean);
  if (mints.length === 0) {
    console.error('usage: find-cobuyers.ts <mint> [<mint> ...]  |  --file mints.txt');
    process.exit(1);
  }

  // wallet -> set of winner mints it bought early
  const hits = new Map<string, Set<string>>();
  for (const mint of mints) {
    process.stderr.write(`scanning ${mint} ...\n`);
    const buyers = await earlyBuyers(conn, mint);
    process.stderr.write(`  ${buyers.size} early buyers\n`);
    for (const w of buyers) {
      if (!hits.has(w)) hits.set(w, new Set());
      hits.get(w)!.add(mint);
    }
  }

  const ranked = [...hits.entries()]
    .map(([wallet, ms]) => ({ wallet, winners: ms.size }))
    .sort((a, b) => b.winners - a.winners);

  const shortlist = ranked.filter((r) => r.winners >= 2);
  process.stderr.write(
    `\n${ranked.length} distinct early buyers across ${mints.length} winners; ` +
      `${shortlist.length} hit >=2.\n`
  );
  // Stdout = machine-friendly: the wallets, strongest first. Pipe the >=2 list
  // straight into vet-wallet.ts.
  console.log(JSON.stringify({ mints: mints.length, ranked }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
