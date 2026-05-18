# Launch-snipe v2 — early-traction entry

## Why

v1 bought at t=0 and picked at the base rate. R-live-8 and R-live-13: every
picked token sat dead-flat at the bonding-curve floor. The reason
(`research/launch-snipe-selection-signals.md`): **at t=0 a runner and a dud
are genuinely indistinguishable — the separating information does not exist
yet.** A buy-at-launch gate cannot beat the base rate.

v2 leaves t=0. It *observes* each launch for a short window, then buys only
the tokens that show real early traction — while the price is still low
enough that the buy lands.

## The momentum lesson — designed around

Momentum (R-live-9–12) died buying a price **climb**: by the time it pulled
the trigger the price was a moving target and the buy reverted (`6002`). v2's
trigger is **buyer traction, not price**, and it buys only while the price is
still near the floor. **Buy the calm with traction, not the climb.**

## Pipeline (v2.0 — the core)

1. Detect a new pump.fun launch (existing `PumpListener`). Do NOT buy — add it
   to an observation watchlist.
2. Observe for `TRACTION_WINDOW_SEC` (~60s).
3. At a checkpoint, one traction read per token: count **distinct buyer
   wallets** from the bonding curve's tx history (`getSignaturesForAddress` +
   parse). One read per token, not per sample — bounds the RPC cost.
4. Entry gate — all must hold:
   - **distinct buyers ≥ `TRACTION_MIN_BUYERS`** — organic traction: many real
     wallets, not one bundler.
   - **price ≤ `TRACTION_MAX_ENTRY_MULT` × launch floor** — landability: if it
     already ran, skip it and accept the miss (do not chase — that's the 6002
     trap).
   - **supply concentration < `TRACTION_MAX_CLUSTER_PCT`** — dev + early
     co-buyers don't hold too much.
   - **not mayhem-mode** — mayhem pump.fun coins can become unsellable
     (see the `mayhem-mode-unsellable-trap` memory); veto them outright.
   - safety: mint & freeze authority revoked (existing checks).
5. Buy via the existing pump bonding-curve buy (`BUY_AMOUNT_SOL=0.01`); manage
   with the existing exit engine.

No LLM gate — the research showed an LLM on create-tx data can't beat the base
rate; v2's entry is on-chain traction, not a score.

## v2.1 — follow-on vetoes (same branch, next commits)

- **Creator prior-launch outcomes** (research signal #1) — veto serial
  batch-launchers whose past tokens all died.
- **Creator funding-source provenance** (research signal #3) — veto
  fresh-wallet-funded-by-fresh-wallet (the bundler fingerprint).

Built after the v2.0 core compiles and runs clean.

## Honest expectation

The research is clear: these signals **reduce adverse selection** — they stop
the bot buying mechanically-identifiable duds — they do not manufacture edge.
v2.0's realistic outcome is *less-losing*; the buyer-diversity signal is the
one shot at *positively* finding a runner. Iterate from the data.

## Config knobs

`TRACTION_WINDOW_SEC`, `TRACTION_SAMPLE_SEC`, `TRACTION_MIN_BUYERS`,
`TRACTION_MAX_ENTRY_MULT`, `TRACTION_MAX_CLUSTER_PCT`, `TRACTION_WATCH_CAP`.

## Build steps

- [ ] `src/config.ts` — TRACTION_* config block
- [ ] `src/tractionWatcher.ts` — observe watchlist, buyer-diversity read, entry gate
- [ ] `src/index.ts` — rewire the pump path: launch → watcher → traction entry → buy
- [ ] tests — mock the tx-history / curve reads
- [ ] smoke test

## Reused as-is

`PumpListener`, the pump bonding-curve buy/sell (`trader.ts`), the exit engine
(`positions.ts`), `db.ts`, `bondingCurve.ts`. The new code is the traction
watcher plus the rewired pump entry path.
