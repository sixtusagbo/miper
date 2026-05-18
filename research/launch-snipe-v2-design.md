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
3. At a checkpoint, one traction read per token: count **trade events on the
   bonding curve** via `getSignaturesForAddress` (one call, no batch). One
   read per token, not per sample — bounds the RPC cost.
4. Entry gate — all must hold:
   - **curve trades ≥ `TRACTION_MIN_TRADES`** — traction: a dead launch sees
     only a handful of txs (create + dev buy); a launch drawing real interest
     sees many. (True distinct-wallet diversity would need per-tx data, but
     the current RPC plan rejects batched tx fetches — see v2.1.)
   - **price ≤ `TRACTION_MAX_ENTRY_MULT` × launch floor** — landability: if it
     already ran, skip it and accept the miss (do not chase — that's the 6002
     trap).
   - **not mayhem-mode** — mayhem pump.fun coins can become unsellable
     (see the `mayhem-mode-unsellable-trap` memory); veto them outright.
   - safety: mint & freeze authority revoked (existing checks).
5. Buy via the existing pump bonding-curve buy (`BUY_AMOUNT_SOL=0.01`); manage
   with the existing exit engine.

No LLM gate — the research showed an LLM on create-tx data can't beat the base
rate; v2's entry is on-chain traction, not a score.

## v2.1 — follow-on vetoes (same branch, next commits)

- **Distinct-wallet traction** — replace the raw curve-trade count with a
  count of *distinct* trader wallets, so a bundler spamming the curve from one
  wallet can't fake traction. Needs per-tx data: `getParsedTransactions` (or
  Helius enhanced txs), which requires a **paid RPC plan** — the current plan
  rejects batched tx fetches (`403 "Batch requests ... paid plans"`).
- **Supply concentration** — veto a launch where the dev + early co-buyers
  hold too much supply. Dropped from v2.0: on a bonding-curve token the curve
  PDA holds ~100% of supply by design, and `getTokenLargestAccounts` throws on
  Token-2022 mints — there's no cheap top-holder read. Measuring real
  concentration means parsing per-wallet buy sizes from the curve tx history
  (same paid-plan dependency as above).
- **Creator prior-launch outcomes** (research signal #1) — veto serial
  batch-launchers whose past tokens all died.
- **Creator funding-source provenance** (research signal #3) — veto
  fresh-wallet-funded-by-fresh-wallet (the bundler fingerprint).

Built after the v2.0 core compiles and runs clean.

## Honest expectation

The research is clear: these signals **reduce adverse selection** — they stop
the bot buying mechanically-identifiable duds — they do not manufacture edge.
v2.0's realistic outcome is *less-losing*; the curve-trade-activity signal is
the one shot at *positively* finding a runner (and v2.1's distinct-wallet
refinement sharpens it). Iterate from the data.

## Logging — make misses legible

A skipped or failed entry must read as a **miss**, not a cryptic code. Log
`entry missed: <token> — <reason>` for: a launch that ran past
`TRACTION_MAX_ENTRY_MULT` before we could buy, a buy that reverted on
slippage (`6002`), and a launch dropped for too few buyers. The run log
should let you scan and count the misses at a glance.

## Config knobs

`TRACTION_WINDOW_SEC`, `TRACTION_SAMPLE_SEC`, `TRACTION_MIN_TRADES`,
`TRACTION_MAX_ENTRY_MULT`, `TRACTION_WATCH_CAP`.

## Build steps

- [x] `src/config.ts` — TRACTION_* config block
- [x] `src/tractionWatcher.ts` — observe watchlist, distinct-trader read, entry gate
- [x] `src/index.ts` — rewire the pump path: launch → watcher → traction entry → buy
- [x] tests — mock the tx-history / curve reads
- [x] smoke test

## Reused as-is

`PumpListener`, the pump bonding-curve buy/sell (`trader.ts`), the exit engine
(`positions.ts`), `db.ts`, `bondingCurve.ts`. The new code is the traction
watcher plus the rewired pump entry path.
