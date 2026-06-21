# Next session — discovery alert-only paper run

Paste the block below into a **fresh Claude Code on the web session**:
same environment (full network + `HELIUS_API_KEY` env var already set), repo
`sixtusagbo/miper`, branch **`claude/fervent-johnson-thvz0y`**. This container
can't reach RPC (it booted on the old network policy), which is why this runs
in a new session.

What's already done on this branch: research over 41 active wallets (299
snapshots), a backtest-tuned `research/discovery-profile.json` (66 smart
wallets, 54% winner-recall / 70% PnL-weighted at alert score 50), and the
scanner wired as `--source discovery`. Full findings:
`research/discovery-findings.md`. The two open questions this run answers are
**precision** (the backtest only measured recall) and whether the
fresh-creator penalty being off is safe live.

---

```
Continue the miper discovery work on branch claude/fervent-johnson-thvz0y.
Everything is built and pushed; HELIUS_API_KEY is in the environment (free
Helius plan — be careful with credits). Run `npm install` first.

STEP 1 — confirm the cluster-expansion wallets (cheap, ~30 RPC calls).
research/cluster-candidates.txt holds 25 non-target wallets the research
surfaced as the cohort our 41 targets trade alongside. Confirm they're alive
and worth trusting, then promote the good ones into the scanner:
  npm run triage-wallets -- --file research/cluster-candidates.txt \
      --out research/cluster-active.txt
  npm run vet-wallet -- --file research/cluster-active.txt
Add the PASSes to the "smartWallets" list in research/discovery-profile.json
(keep the existing 66), then re-confirm recall didn't regress:
  npm run backtest-discovery -- research/wallet-profile.json \
      --profile research/discovery-profile.json
Commit the updated profile if it improved or held.

STEP 2 — alert-only paper run, RPC-budget-aware. The scanner overshoots a
free Helius MONTHLY budget if run 24/7 (see RUNNING.md "RPC budget"), so run
it in a BOUNDED window during peak hours, no real money, recommended
threshold 50:
  DISCOVERY_ALERT_SCORE=50 MAX_RUN_HOURS=4 SIMULATE=true \
      npm run simulate:discovery
Let it run the full window (it auto-stops). It alerts on Telegram if
configured, and records every alert's post-alert peak into discovery.db.
Watch the rolling "rpc: N calls" status lines so the credit burn stays sane;
if it's pacing too hot, stop, raise DISCOVERY_SAMPLE_SEC / lower
DISCOVERY_WATCH_CAP, and restart.

STEP 3 — measure live precision (this is the real gate, not recall):
  npm run backtest-discovery -- research/wallet-profile.json --db discovery.db
Report: how many alerts resolved, what fraction reached >=2x or graduated,
the median post-alert peak, and the win rate bucketed by score. Separately
check the fresh-creator cohort — alerts on tokens from fresh (<50-tx)
creators — since the shipped profile turns that penalty off and this run is
what tells us whether that was safe.

STEP 4 — recommend, don't act. Based on precision, recommend whether to keep
alert score 50 or move it, and whether autobuy (DISCOVERY_AUTOBUY=true, still
SIMULATE=true first) is justified. Do NOT enable autobuy or go live without
explicit say-so. Commit any profile/threshold changes; push to the same
branch.

Be frugal with RPC throughout. If anything errors, diagnose and report rather
than burning credits retrying blindly.
```

---

After this run, the decision tree is: precision good → paper autobuy → (if
that holds) live with a tiny `BUY_AMOUNT_SOL`. Precision poor → tighten the
profile (raise the alert score, re-enable the fresh-creator penalty, or lean
harder on smart-wallet-only alerts) and re-run. Either way the kill switch is
`DISCOVERY_AUTOBUY=false`, and live trading needs `SIMULATE=false` — keep it
`true` until the numbers earn the switch.
