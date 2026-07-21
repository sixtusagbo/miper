# Next session — discovery scanner pickup

This is the resume doc. Read it first; it tells you the current state in 30 seconds, then the next concrete action.

## Where the run lives

The precision run runs on the **Hetzner server**, NOT this local worktree. The local worktree is for editing code.

- Server SSH alias: `miper.server`
- Server worktree: `/home/miper/miper-discovery` (the discovery branch, `node_modules` symlinked to `~/miper`, `.env` is a copy of `~/miper/.env` with `CLOSE_WHEN_BELOW_MIN_BALANCE=false`)
- Run process: tmux session `miper-discovery` (detached, alert-only, Telegram on)
- Run output: `~/miper-discovery/discovery-run.log` + `~/miper-discovery/discovery.db`

### Check whether a run is live
```
ssh miper.server "sudo -u miper env HOME=/home/miper bash -lc '
  tmux ls 2>/dev/null | grep -i discovery || echo \"(no run live)\";
  tail -3 ~/miper-discovery/discovery-run.log 2>/dev/null
'"
```

### Read the latest run's results
```
ssh miper.server "sudo -u miper env HOME=/home/miper bash -lc 'cd ~/miper-discovery && node -e \"
const db=require(\\\"better-sqlite3\\\")(\\\"./discovery.db\\\",{readonly:true});
const a=db.prepare(\\\"SELECT id,score,token_mint,smart_wallet_buys,outcome,peak_mult,mcap_usd FROM discovery_alerts ORDER BY id\\\").all();
console.log(\\\"alerts:\\\",a.length);for(const r of a)console.log(r);
const w=db.prepare(\\\"SELECT outcome, COUNT(*) n FROM discovery_alerts GROUP BY outcome\\\").all();
console.log(\\\"by outcome:\\\",JSON.stringify(w));\"'"
```

## Current state (last update 2026-06-26, unbounded run started 12:30 UTC)

**An unbounded alert-only run is LIVE on the server** (no MAX_RUN_HOURS, will run until killed or RPC bites). Accruing the precision sample we couldn't get in a 4h window.

Prior 4h run (2026-06-23 12:02→16:02 UTC) only produced **2 alerts (both flat)** in 4h with 472 vetoes and ~28k RPC calls. Way too thin to judge precision. Hence: just let it run.

To check the running sample, use the "Read the latest run's results" snippet above. Sanity: each ~4h of runtime ≈ 28k RPC calls (~7k/hr).

## Latest state (2026-07-09)

The precision run was RPC-throttled 2026-07-03 (LordLong Helius free tier exhausted, 993k 429 retries). Swapped to the Salmon fluff 2 key. **5,284 alerts** across the first two threshold phases banked before that. Two shipped conclusions from analyzing that data:

**1. The scorer had a hole; fixed.** Score 70-79 was 0/98 wins because 62% of those alerts were essentially-empty curves (liquidity < 1 SOL, some literally `5e-9`). Commit `22d8cda` adds a hard veto below 1 SOL and a +10 bonus at ≥5 SOL. Also confirmed the same-data precision boost: score≥60 & liq≥5 → 16% (from 9%), score≥80 & liq≥5 → 21% (from 13%).

**2. Backtested the exit strategy against 5,284 alerts.** All-in @ 2x with SL 0.4x loses money at every filter. But **trailing arm 1.3x / drop 15% with SL 0.7x** turns profitable at every quality cohort:
- score≥60 & liq≥5 (n=322): **+11.4%/trade**
- score≥80 & liq≥5 (n=73): **+13.1%/trade**
- score≥80 & liq≥10 (n=42): **+16.8%/trade**

Simulated on peak-price data only; real-world slippage + gas will trim ~5-8%. Still profitable.

## The go-live plan (autobuy gate)

Exit params are already baked into `~/miper-discovery/.env`:
```
EXIT_MODE=all-in, EXIT_AT_MULT=100 (never fires; trailing bank owns exits)
STOP_LOSS=0.7, TRAILING_TP_ARM_MULT=1.3, TRAILING_TP_DROP_PCT=0.15
DISCOVERY_BUY_SCORE=80, BUY_AMOUNT_SOL=0.02, MAX_HOLD_MINUTES=30
DISCOVERY_AUTOBUY=false  ← still off; this is the gate
```
The banner on restart confirms these: `exit strategy: ALL-IN at 100x | stop-loss 0.7x | time-exit after 30min | buy 0.02 SOL | max 3 open | buy>=80 | autobuy off`.

**Before flipping autobuy:**
1. Wait ~2-3 days for the new (post-veto) scorer to bank ≥50 fresh alerts, verify precision at ≥60 holds (should improve, since low-liq zombies now veto before they alert).
2. Enable in paper first: `sed -i 's/^DISCOVERY_AUTOBUY=.*/DISCOVERY_AUTOBUY=true/' ~/miper-discovery/.env`, restart the tmux. `SIMULATE=true` is still set so trades write to DB with `simulated=1` but no real SOL leaves the wallet.
3. Read simulated PnL: `npm run review:discovery` (or query `positions` table). If it matches the +10-15%/trade simulation, remove SIMULATE from the launch command to go live.

## Files / scripts worth knowing

- `src/discoveryScore.ts` — the deterministic scorer (rule weights + vetoes). Tunable.
- `src/discovery.ts` — the live scanner. Watches launches, samples per token, scores, emits alert/candidate.
- `research/discovery-profile.json` — shipped thresholds (66 smart wallets, $15k mcap cap, etc).
- `research/discovery-findings.md` — the original research conclusions.
- `scripts/backtest-discovery.ts` — replay scorer over historical snapshots OR live alerts (`--db discovery.db` mode).
- `scripts/walletList.ts` — shared wallet-file reader (strips inline `#` comments).

## Files / scripts worth knowing

- `src/discoveryScore.ts` — the deterministic scorer (rule weights + vetoes). Tunable.
- `src/discovery.ts` — the live scanner. Watches launches, samples per token, scores, emits alert/candidate.
- `research/discovery-profile.json` — shipped thresholds (66 smart wallets, $15k mcap cap, etc).
- `research/discovery-findings.md` — the original research conclusions.
- `scripts/backtest-discovery.ts` — replay scorer over historical snapshots OR live alerts (`--db discovery.db` mode).
- `scripts/walletList.ts` — shared wallet-file reader (strips inline `#` comments).

## Recent code history (branch `main` — the discovery line became main on 2026-07-17; the old raydium-era main lives at `main-legacy`)

```
22d8cda Veto essentially-empty curves and reward real depth in the discovery scorer
4b53998 Reframe the run as unbounded server-managed, not bounded windows
4906157 Rewrite NEXT-SESSION as a current-state pickup doc
8be0e3e Skip the low-balance auto-shutdown for alert-only discovery runs
cb44cb4 Strip inline comments in wallet-list files via a shared reader
```

## Gotchas

- The first 4h run died after 5min because the copied `.env` carried `CLOSE_WHEN_BELOW_MIN_BALANCE=true` from copytrade. Don't re-enable that in the discovery worktree.
- Local-only smoke runs need `npm rebuild better-sqlite3` first (stale binding in the parent worktree's `node_modules`).
- Helius keys blow through the free tier in ~1-2 weeks of unbounded scanning. The `.env` on the local worktree has `# #### THE KEYS: #####` section with two labeled keys — rotate to the unused one when one exhausts (~993k 429 retries is the sign).
- DO NOT touch the `copytrade` branch or the `miper-copytrading` directory. Different strategy, different state.
- To read the results DB, the node script MUST run from `~/miper-discovery` (better-sqlite3 lives in the shared node_modules there). Running from `/tmp` errors.

## End goal (reminder)

Catch the same early pre-graduation pump.fun winners the smart-money cluster catches, by recognizing each token's public on-chain fingerprint in real time — not by copying their wallets. Alert-only first (zero capital, measuring precision); then autobuy behind a kill switch (`DISCOVERY_AUTOBUY=false` by default) once precision earns it.
