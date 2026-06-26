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

## Current state (last update 2026-06-23, 4h run 12:02→16:02 UTC)

**Run finished cleanly. Precision sample is TOO THIN to judge yet.**

| | value |
|---|---|
| run window | 4h, off-peak overlap with mid-day pump.fun |
| RPC calls | 27,668 (~1.9/s) |
| vetoes | 472 (301 mayhem, 171 bundled) |
| smart-wallet buys seen | 25 |
| **alerts** | **2** (scores 70 and 65, both ended flat 1.00x) |
| precision so far | 0/2 winners — sample too thin |

What the alerts looked like: both ~$1.9k mcap (in band), both had smart wallets co-buying + dev buy in band + complete metadata + (one) high tx velocity. Textbook by the scorer's lights, just no run. Not enough data to know if that's the norm.

## Next concrete action: get more alerts

Need ~50-100 alerts before precision means anything. Two options:

**A. Another bounded peak-hour window** (best for measuring NOW)
Run during US/EU peak (pump.fun is most active ~14:00-22:00 UTC). Bounded so it auto-stops, keeping RPC costs sane.
```
ssh miper.server "sudo -u miper env HOME=/home/miper bash -lc '
  tmux kill-session -t miper-discovery 2>/dev/null;
  cd ~/miper-discovery &&
  tmux new -d -s miper-discovery \"DISCOVERY_ALERT_SCORE=50 MAX_RUN_HOURS=4 SIMULATE=true npm run simulate:discovery > ~/miper-discovery/discovery-run.log 2>&1\"
'"
```
Then wait ~4h, re-read with the snippet above.

**B. Lower the alert threshold** (more alerts per hour, but more noise)
Drop to 40 (the backtest's PnL-weighted recall jumps 70%→76%, at the cost of more false alarms — which is precisely what we're measuring). Same launch command with `DISCOVERY_ALERT_SCORE=40`. Only do this AFTER option A if alerts stay thin at 50.

**Do NOT enable autobuy** (`DISCOVERY_AUTOBUY=true`) until at least 50 alerts have outcomes and precision is good — that's the gate.

## Files / scripts worth knowing

- `src/discoveryScore.ts` — the deterministic scorer (rule weights + vetoes). Tunable.
- `src/discovery.ts` — the live scanner. Watches launches, samples per token, scores, emits alert/candidate.
- `research/discovery-profile.json` — shipped thresholds (66 smart wallets, $15k mcap cap, etc).
- `research/discovery-findings.md` — the original research conclusions.
- `scripts/backtest-discovery.ts` — replay scorer over historical snapshots OR live alerts (`--db discovery.db` mode).
- `scripts/walletList.ts` — shared wallet-file reader (strips inline `#` comments).

## Recent code history (branch `claude/fervent-johnson-thvz0y`)

```
8be0e3e Skip the low-balance auto-shutdown for alert-only discovery runs
cb44cb4 Strip inline comments in wallet-list files via a shared reader
3cfcdf2 Add the discovery scanner's end goal to the README
88967e9 Add paste-ready kickoff prompt for the alert-only paper-run session
2a9dc40 Point the README at the completed discovery research and shipped profile
```

## Gotchas

- The first 4h run died after 5min because the copied `.env` carried `CLOSE_WHEN_BELOW_MIN_BALANCE=true` from copytrade; with no positions and a near-empty wallet the auto-close fired. Fixed in code (`8be0e3e`) and in the live `.env`. Don't re-enable that flag in the discovery worktree.
- Local-only smoke runs need `npm rebuild better-sqlite3` first (stale May binding in the parent worktree's `node_modules`).
- A free-tier Helius monthly budget can take a few bounded 4h runs comfortably, but 24/7 will overshoot. Stay bounded.
- DO NOT touch the `copytrade` branch or the `miper-copytrading` directory. Different strategy, different state.

## End goal (reminder)

Catch the same early pre-graduation pump.fun winners the smart-money cluster catches, by recognizing each token's public on-chain fingerprint in real time — not by copying their wallets. Alert-only first (zero capital, measuring precision); then autobuy behind a kill switch (`DISCOVERY_AUTOBUY=false` by default) once precision earns it.
