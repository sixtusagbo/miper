// Recency triage for the research targets: ONE getSignaturesForAddress call
// per wallet (limit 25) ranks every candidate by last-activity time and
// rough recent cadence — so the expensive profiler only runs on wallets that
// are still alive. Leaderboards rotate; snapshots go stale; this costs ~70
// RPC credits to find out which of ours did.
//
//   npx ts-node scripts/triage-wallets.ts --file research/target-wallets.txt
//     [--max-idle-days 14]      activity bar (default 14)
//     [--out research/target-wallets.active.txt]
//
// Writes the still-active wallets (newest activity first) to --out, ready for:
//   npm run profile-wallets -- --file research/target-wallets.active.txt

import 'dotenv/config';
import { Connection, PublicKey } from '@solana/web3.js';
import { readFileSync, writeFileSync } from 'fs';
import { retry } from '../src/concurrency';
import { resolveRpcUrls } from '../src/config';

const SPACING_MS = 150; // ~6 req/s, polite to a free-tier 10 req/s cap

interface Triage {
  wallet: string;
  lastTxAgoH: number | null; // null = no history visible
  txsLast24h: number; // within the 25-sig probe window
  error?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function readWallets(path: string): string[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
}

async function main(): Promise<void> {
  const file = arg('--file', 'research/target-wallets.txt');
  const out = arg('--out', 'research/target-wallets.active.txt');
  const maxIdleDays = Number(arg('--max-idle-days', '14'));
  const wallets = readWallets(file);
  if (wallets.length === 0) {
    console.error(`no wallets in ${file}`);
    process.exit(1);
  }
  const rpc = resolveRpcUrls().rpcUrl;
  const connection = new Connection(rpc, 'confirmed');
  process.stderr.write(`triaging ${wallets.length} wallets (1 call each)...\n`);

  const now = Date.now() / 1000;
  const results: Triage[] = [];
  for (const [i, wallet] of wallets.entries()) {
    if (i > 0) await sleep(SPACING_MS);
    try {
      const sigs = await retry(
        () => connection.getSignaturesForAddress(new PublicKey(wallet), { limit: 25 }),
        { attempts: 3, baseDelayMs: 600, label: `triage ${wallet.slice(0, 8)}` }
      );
      const newest = sigs.find((s) => s.blockTime)?.blockTime ?? null;
      results.push({
        wallet,
        lastTxAgoH: newest ? (now - newest) / 3600 : null,
        txsLast24h: sigs.filter((s) => s.blockTime && now - s.blockTime < 86_400).length,
      });
    } catch (err) {
      results.push({ wallet, lastTxAgoH: null, txsLast24h: 0, error: (err as Error).message });
    }
    if ((i + 1) % 10 === 0) process.stderr.write(`  ${i + 1}/${wallets.length}\n`);
  }

  const active = results
    .filter((r) => r.lastTxAgoH !== null && r.lastTxAgoH <= maxIdleDays * 24)
    .sort((a, b) => (a.lastTxAgoH ?? 0) - (b.lastTxAgoH ?? 0));
  const stale = results.filter((r) => !active.includes(r));

  console.log(`\n${'='.repeat(64)}`);
  console.log(`ACTIVE (last tx <= ${maxIdleDays}d): ${active.length}/${results.length}`);
  for (const r of active) {
    const ago =
      (r.lastTxAgoH ?? 0) < 48
        ? `${(r.lastTxAgoH ?? 0).toFixed(1)}h ago`
        : `${((r.lastTxAgoH ?? 0) / 24).toFixed(1)}d ago`;
    const cadence = r.txsLast24h >= 25 ? '25+ txs/24h' : `${r.txsLast24h} txs/24h`;
    console.log(`  ${r.wallet}  ${ago.padStart(10)}  ${cadence}`);
  }
  console.log(`\nSTALE/DEAD: ${stale.length}`);
  for (const r of stale) {
    const why = r.error
      ? `error: ${r.error.slice(0, 40)}`
      : r.lastTxAgoH === null
        ? 'no visible history'
        : `last tx ${((r.lastTxAgoH ?? 0) / 24).toFixed(0)}d ago`;
    console.log(`  ${r.wallet}  ${why}`);
  }

  const header =
    `# Active research targets — triaged ${new Date().toISOString().slice(0, 10)} ` +
    `(last tx <= ${maxIdleDays}d), newest first. Source: ${file}\n`;
  writeFileSync(out, header + active.map((r) => r.wallet).join('\n') + '\n');
  console.log(`\nwrote ${active.length} wallets to ${out}`);
  console.log(`next: npm run profile-wallets -- --file ${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
