// Per-leader copytrade scorecard: landed buys, failed copies (entry-race
// losses), landed rate, finished positions, and realized PnL. This is the read
// side of the positions.leader / rejected_tokens.leader attribution — the input
// for the Nyhrox trial call and ongoing leader rotation.
//
// Read-only; safe to run against the live DB while the bot trades.
//
// Usage (from the repo root, with the copytrade .env in place):
//   npx ts-node scripts/leader-stats.ts

import 'dotenv/config';
import Database from 'better-sqlite3';
import { loadConfig } from '../src/config';

interface PosRow {
  leader: string;
  landed: number;
  finished: number;
  pnl: number | null;
}

const db = new Database(loadConfig().dbPath, { readonly: true });

const pos = db
  .prepare(
    `SELECT COALESCE(leader, '(none)') AS leader,
            COUNT(*) AS landed,
            SUM(CASE WHEN status IN ('closed','stopped') THEN 1 ELSE 0 END) AS finished,
            ROUND(SUM(amount_sol_received - amount_sol_spent), 4) AS pnl
     FROM positions GROUP BY leader`
  )
  .all() as PosRow[];

const fails = db
  .prepare(
    `SELECT COALESCE(leader, '(none)') AS leader, COUNT(*) AS failed
     FROM rejected_tokens WHERE reason LIKE 'buy failed%' GROUP BY leader`
  )
  .all() as { leader: string; failed: number }[];
const failMap = new Map(fails.map((f) => [f.leader, f.failed]));

console.log('leader         landed  failed  land%  finished    pnlSOL');
console.log('-'.repeat(58));
for (const r of pos.sort((a, b) => (b.pnl ?? 0) - (a.pnl ?? 0))) {
  const failed = failMap.get(r.leader) ?? 0;
  const attempts = r.landed + failed;
  const rate = attempts > 0 ? `${Math.round((100 * r.landed) / attempts)}%` : '-';
  console.log(
    r.leader.padEnd(14),
    String(r.landed).padStart(6),
    String(failed).padStart(7),
    rate.padStart(6),
    String(r.finished).padStart(9),
    String(r.pnl ?? 0).padStart(10)
  );
}
