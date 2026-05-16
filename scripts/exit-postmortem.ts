// Exit post-mortem: for every position in a run's DB, fetch the token's
// CURRENT price and compare it to our entry. Answers "did the tokens we
// time-exited keep running after we sold?" — i.e. is the hold window too
// short, or is the entry selection just not picking winners?
//
// Caveats: (1) current price is a LOWER bound on what a longer hold could
// have caught — a token may have spiked higher and fallen back; the 24h%
// column hints at the trajectory. (2) entry_price_sol is the booked curve
// init price; the real slipped fill was up to ~15% higher, so multiples
// are optimistic by roughly that much. Good enough for a directional read.
//
// Usage: npx ts-node scripts/exit-postmortem.ts [dbPath]
import Database from 'better-sqlite3';
import fetch from 'node-fetch';

const DB_PATH = process.argv[2] ?? './pump.db';

interface PositionRow {
  id: number;
  token_mint: string;
  amount_sol_spent: number;
  entry_price_sol: number;
  created_at: string;
}

interface DexPair {
  baseToken?: { address?: string };
  priceNative?: string;
  marketCap?: number;
  fdv?: number;
  liquidity?: { usd?: number };
  priceChange?: { h6?: number; h24?: number };
}

async function fetchPairs(mints: string[]): Promise<Map<string, DexPair>> {
  const byMint = new Map<string, DexPair>();
  for (let i = 0; i < mints.length; i += 30) {
    const batch = mints.slice(i, i + 30);
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${batch.join(',')}`
    );
    if (!res.ok) {
      console.error(`DexScreener ${res.status} for batch starting ${i}`);
      continue;
    }
    const json = (await res.json()) as { pairs?: DexPair[] | null };
    for (const pair of json.pairs ?? []) {
      const addr = pair.baseToken?.address;
      if (!addr) continue;
      // Keep the deepest-liquidity pair when a token has several.
      const cur = byMint.get(addr);
      if (!cur || (pair.liquidity?.usd ?? 0) > (cur.liquidity?.usd ?? 0)) {
        byMint.set(addr, pair);
      }
    }
  }
  return byMint;
}

function hoursSince(iso: string): number {
  return (Date.now() - Date.parse(`${iso}Z`)) / 3_600_000;
}

async function main(): Promise<void> {
  const db = new Database(DB_PATH, { readonly: true });
  const rows = db
    .prepare(
      'SELECT id, token_mint, amount_sol_spent, entry_price_sol, created_at FROM positions ORDER BY id'
    )
    .all() as PositionRow[];
  db.close();

  const pairs = await fetchPairs(rows.map((r) => r.token_mint));

  const results = rows.map((r) => {
    const pair = pairs.get(r.token_mint);
    const cur = pair?.priceNative ? Number(pair.priceNative) : NaN;
    const multiple =
      Number.isFinite(cur) && cur > 0 && r.entry_price_sol > 0
        ? cur / r.entry_price_sol
        : null;
    return {
      id: r.id,
      mint: r.token_mint,
      hoursAgo: hoursSince(r.created_at),
      multiple,
      mcap: pair?.marketCap ?? pair?.fdv ?? null,
      h24: pair?.priceChange?.h24 ?? null,
    };
  });
  results.sort((a, b) => (b.multiple ?? -1) - (a.multiple ?? -1));

  console.log(`\nExit post-mortem — ${results.length} positions (${DB_PATH})\n`);
  console.log('   #  age(h)     now x   mcap          24h%   mint');
  for (const r of results) {
    const mult = r.multiple === null ? 'no data' : `${r.multiple.toFixed(2)}x`;
    const mcap = r.mcap === null ? '-' : `$${Math.round(r.mcap).toLocaleString()}`;
    const h24 = r.h24 === null ? '-' : `${r.h24}%`;
    console.log(
      `  ${String(r.id).padStart(2)}  ${r.hoursAgo.toFixed(1).padStart(6)}  ${mult.padStart(8)}  ${mcap.padStart(12)}  ${h24.padStart(6)}  ${r.mint}`
    );
  }

  const found = results.filter(
    (r): r is typeof r & { multiple: number } => r.multiple !== null
  );
  const ge = (x: number) => found.filter((r) => r.multiple >= x).length;
  console.log(`\nSummary — ${found.length}/${results.length} found on DexScreener:`);
  console.log(`  currently >= 10x : ${ge(10)}`);
  console.log(`  currently >=  5x : ${ge(5)}`);
  console.log(`  currently >=  3x : ${ge(3)}`);
  console.log(`  currently >=  2x : ${ge(2)}`);
  console.log(`  currently >=  1x : ${ge(1)}  (above our entry)`);
  console.log(`  below 0.2x       : ${found.filter((r) => r.multiple < 0.2).length}  (effectively dead)`);
  console.log(`  not found        : ${results.length - found.length}  (no indexed pair — illiquid/dead)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
