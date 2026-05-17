# Run Log

A condensed history of paper-trading and live runs on `pump-fun` so we have a reference before each `pump.db` / `pump.log` nuke. Append a new entry per meaningful run; old runs aren't backfilled in detail because the code state changes between them.

For each run record: date, code state, config, pipeline metrics, score distribution highlights, realized PnL, cost (if known), and what we learned.

---

## Run R1 — Token-2022 unblocking
**Date:** 2026-04-25
**Code state:** post pump.fun listener + Token-2022 fallback (`eecf3b5`); pre signal enrichment.
**Config:** Anthropic Sonnet 4, `MIN_AI_SCORE=70`, `--source pump`.
**Duration:** ~10 min.

| Metric | Value |
|---|---|
| Detected | 361 |
| Analyzed | 233 |
| BUYS | 0 |
| Score distribution | 210× 5, 9× 15, 0 ≥ 30 |

**Learning:** Without per-token differentiation, Sonnet correctly identified every fresh pump launch as structurally identical and gave them all 5/100. Confirmed need for signal enrichment — creator history + metadata + dev-commitment specifics. Drove the next architectural commits.

---

## Run R2 — First signal-enrichment validation
**Date:** 2026-04-25
**Code state:** post creator history + metadata wiring + relative-scoring prompt (`d98626b`); PnL bookkeeping bugs still latent.
**Config:** Sonnet 4, `MIN_AI_SCORE=70`, pump source.
**Duration:** ~10 min.

| Metric | Value |
|---|---|
| Detected | 121 |
| Analyzed | 79 |
| BUYS | 1 (`wcaoSRxc…pump`, score 72) |
| Outcome | Eventually stop-lossed |

**Learning:** First buy ever to fire — relative scoring works. But the stop-loss recorded `received = spent` (fake breakeven), exposing the pumpSell-uses-entry-price bug.

---

## Run R3 — Sonnet 4, full stack, 30 min
**Date:** 2026-04-26
**Code state:** PnL bookkeeping fixed (`6a5d1f8`, `8933c73`), bonding-curve polling shipped (`e52d34f`).
**Config:** Sonnet 4, `MIN_AI_SCORE=70`, pump source.
**Duration:** ~30 min.

| Metric | Value |
|---|---|
| Detected | 551 |
| Analyzed | 409 |
| BUYS | 7 |
| Closed positions | 3 (all wins) |
| Best trade | Position 6: closed at **27.11×**, +1.31 SOL |
| Realized PnL | **+1.70 SOL** on 0.55 SOL deployed (+308%) |
| Win rate (closed) | 3/3 = 100% (N=3, large variance) |
| Score distribution | bulk 15-25, sparse tail at 35-45, 1× 65, 1× 72, 3× 75 |

**Learning:** First evidence that the strategy can produce real winners at scale. One outlier carries most of the absolute PnL — small-sample variance is huge. Demonstrated the bonding-curve price polling working end-to-end (zero `No price for…` log entries).

---

## Run R4 — Sonnet 4, 3 min sanity check
**Date:** 2026-04-26
**Code state:** unchanged from R3.
**Config:** Sonnet 4, `MIN_AI_SCORE=70`, pump source.
**Duration:** ~3 min.

| Metric | Value |
|---|---|
| Detected | 119 |
| Analyzed | 69 |
| BUYS | 1 (`32zpFmwf…pump`, score 72) |
| Outcome | STOPLOSS at 0.27× → -0.04 SOL realized loss |
| Score distribution | 35× 15, 25× 25, 1× 35, 1× 65, 1× 72 |
| `No price for…` log entries | 0 |

**Learning:** Confirmed the PnL fix records real losses (not fake breakeven). Establishes a clean Sonnet-on-current-code baseline for the Haiku comparison.

---

## Run R5 — Anthropic Haiku 4.5
**Date:** 2026-04-26
**Code state:** unchanged from R4.
**Config:** Anthropic Haiku 4.5 (`claude-haiku-4-5`), `MIN_AI_SCORE=70`, pump source.
**Duration:** ~10 min.

| Metric | Value |
|---|---|
| Detected | 149 |
| Analyzed | 109 |
| BUYS | **0** |
| Max score | 35 |
| Score distribution | 75× 28 (massive bunch), 9× 15, 8× 32, 5× 35; nothing ≥ 70 |

**Learning:** Haiku weights creator-wallet age much more strictly than Sonnet — even tokens with 21.487 SOL dev buys scored 35 because the wallet read as "0.0 days old" (saturation artifact). Reasoning was valid but the risk profile was too conservative for this threshold. Drove the OpenAI evaluation and the creator-history saturation fix.

---

## Run R6 — OpenAI gpt-5-nano, 30 min
**Date:** 2026-04-27
**Code state:** post multi-provider plumbing (`f4cd803`), pre creator-history saturation fix.
**Config:** OpenAI `gpt-5-nano`, `MIN_AI_SCORE=70`, pump source.
**Duration:** ~30 min.

| Metric | Value |
|---|---|
| Detected | 361 |
| Analyzed | 320 |
| BUYS | 11 |
| Exits | 10 (2 TP3 full closes, 1 STOPLOSS, 7 partial TP1/TP2) |
| Best closed | `A9tDRhmS…` at 5× (+0.16 SOL); `FNdeEZ9x…` at 5× (+0.14 SOL) |
| Stopped | `A85osc81…` (-0.03 SOL) |
| Realized PnL | **+0.054 SOL** on 0.55 deployed (+10%, with 4 still open at -0.05 unrealized) |
| Score distribution | 184× 62, 28× 60, 23× 63, 13× 58 (bulk); 9× 72, 4× 68, 2× 70 (buy zone) |
| **API cost** | **$0.02** |

**Learning:** OpenAI default validated. ~50× cheaper than Sonnet at the same call volume. Score-72 picks are paying off (2/3 closed positions win). The bulk at 60-63 are tokens with strong dev commitment but missing metadata — we don't yet know if they have alpha (Run B will test). Note: large fraction of these were saturated-wallet readings, which Run R7+ should improve.

---

## Run R7 — saturation fix, threshold 70
**Date:** 2026-04-27
**Code state:** post creator-history saturation fix (`f9f4db6`).
**Config:** OpenAI `gpt-5-nano`, `MIN_AI_SCORE=70`, pump source.
**Duration:** ~32 min.

| Metric | Value |
|---|---|
| Detected | 615 |
| Analyzed | **87** (busy-gate dropping most — see below) |
| BUYS | 11 |
| Exits | 9 (8 TP1 partials, 1 TP2, 1 STOPLOSS-after-TP1) |
| Closed (full) | 0 |
| Realized "PnL so far" | -0.15 SOL on 0.55 spent — **mostly unrealized**: 4 still-open at -0.05 each + 7 partials still holding 60% of original bag |
| Score distribution | 54× 62, 11× 72, 4× 65, 4× 63, 3× 60, 2× 68, 2× 48 |
| Saturated-creator prompts | 26 emitted (the new "1000+ recent txs ... true wallet age unknown" phrasing) |

**Comparison vs R6 (pre-saturation-fix, same threshold):**
- **Buy density at threshold 70: 11/87 (13%) vs R6's 11/320 (3.4%)** — saturation fix roughly 4× more tokens cleared the bar at the same threshold. The fix is working: tokens with strong dev signals + saturated wallets are no longer being misread as "fresh disposable".
- Score-72 cluster grew (11 vs 9 in R6) — the bulk of the lift came from former 60-65 saturated-wallet tokens moving up.

**Caveats:**
1. **Analyzed count dropped 4× (320 → 87)** — the busy gate is dropping most detections. Reason: per-analysis latency is now ~3s (1.5s safety pre-read + getMint retry + metadata + creator history + AI call), and at 3 concurrent the queue can't drain fast enough on pump's ~20 tokens/min stream. Worth investigating; bumping `MAX_CONCURRENT_ANALYSES` from 3 to 5-6 or trimming the safety pre-read for already-aged mints could recover a lot.
2. **Realized PnL is mostly noise at this sample.** 1 fully-closed position is not a verdict. The 7 partials are mid-flight — they've taken TP1 profits but still hold 60% of bag exposed to drawdown. Real PnL depends on what those partials do over the next hours.

**Learning:** Saturation fix is doing what it should — more aged-but-active wallets clear the threshold. Whether their picks are better than R6's is genuinely unknown until R10 (4h sustained, N≥30 closed). Today's snapshot is a coin flip in either direction.

---

## Run R8 — threshold 60 experiment
**Date:** 2026-04-27
**Code state:** post saturation fix (`f9f4db6`) + concurrency bump 3→6 (`cc8217f`) + `MAX_OPEN_POSITIONS=50`. (An earlier 30-min attempt at the un-bumped caps was discarded — caps stalled the run on the position limit before the bumps landed. R8 here is the post-bump run only.)
**Config:** OpenAI `gpt-5-nano`, `MIN_AI_SCORE=60`, pump source.
**Duration:** **2h 54m** (07:38 → 10:32 UTC, normal user-stop after the gym session). Effectively crosses into R10 territory — much more substantive sample than originally planned.

| Metric | Value |
|---|---|
| Detected | 2,366 |
| Analyzed | 91 (busy-gate dropping the rest — even at concurrency 6 the stream is faster than we drain) |
| BUYS | 76 |
| Exits | 74 |
| **Status breakdown** | **7 closed, 19 stopped, 11 partial, 39 open** |
| Spent / received | 3.80 SOL / 2.81 SOL |
| Realized PnL | -0.99 SOL (mostly noise — 39 open + 11 partial still mid-flight at kill time) |
| **Win rate on finished (closed+stopped)** | **7/26 ≈ 27%** |
| **API cost** | **$0.01** over 2h 54m (≈ $0.0034/hr — much lower than R6's per-hour rate because position-cap saturation skipped most detections *before* the AI call, so we only paid for the 91 actual analyses) |

**Comparison vs R7 (threshold 70, same code):**
- Buy volume: 76 in ~hour vs R7's 11 in 32 min → ~7× more buys at threshold 60
- Win rate on finished: **27% (R8) vs ~67% (R6 baseline at threshold 70 with N=3)**
- Direction is the predicted one — the marginal 60-65 picks have noticeably lower win rate. Tokens with one strong signal but missing other signals (the bulk that scored 60-65 in R6) lose more than they win.

**Caveats:**
1. Run ended via normal user-stop (back from gym), not error. The 39 open + 11 partial positions are mid-flight at stop time — that's the snapshot, not a "killed early" artifact. Their final outcomes would shift realized PnL meaningfully but don't affect the win-rate-on-finished metric.
2. 26 finished positions is real sample (vs R7's 1) but at N=26 the 95% CI on win rate is still wide (~12%-46%). Treat as directional, not surgical.

**Learning:** Threshold 60 is too lenient. The 4× lift in buy density from R7→R8 came overwhelmingly from tokens that turned into stop-losses. **Recommend: stay at threshold 70 for R9-R11 unless a future experiment shows otherwise.** Also confirms two infrastructure bottlenecks at higher buy volume: the analyzer busy gate and the position cap. Both are now bumped (concurrency 6, position cap 50) ready for sustained R10.

---

## Run R9 — sustained threshold-70 baseline
**Date:** 2026-04-27
**Code state:** R8 codebase (saturation fix + concurrency 6 + position cap 50). No further changes during the run.
**Config:** OpenAI `gpt-5-nano`, `MIN_AI_SCORE=70`, pump source, default tiered TP.
**Duration:** **7h 1m** (10:56 → 17:57 UTC, normal user-stop).

| Metric | Value |
|---|---|
| Detected | 6,588 |
| Analyzed | 606 |
| BUYS | 66 |
| **Status breakdown** | **10 closed, 5 stopped, 8 partial, 43 open** |
| Spent / received | 3.30 SOL / 4.69 SOL |
| **Realized PnL** | **+1.39 SOL on 3.30 deployed (+42%)** |
| **Win rate on finished (closed+stopped)** | **10/15 ≈ 67%** |
| Score distribution | 374× 62, 60× 72, 21× 68, 13× 45, 12× 58, 11× 63, 11× 52, 8× 65 |
| **API cost** | **$0.05** over 7h ≈ $0.007/hr |

**Key comparisons:**

| | R8 (threshold 60) | R9 (threshold 70) |
|---|---|---|
| Buys per hour | ~25 | ~9 |
| Analyzed per buy | 1.2 | 9.2 |
| **Win rate on finished** | **27%** (7/26) | **67%** (10/15) |
| Realized PnL | -0.99 SOL (mostly noise — 39 unresolved) | **+1.39 SOL** |
| Saturation flagged in prompts | many | many |

**Learning:** Threshold 70 produces ~3× fewer buys than threshold 60 but **2.5× the win rate on finished positions**. Realized PnL flips from -0.99 (R8) to +1.39 (R9). At N=15 finished the confidence interval on 67% is still wide (~38%-88%) but the gap to 27% is large enough that the threshold-70 advantage is unlikely to be variance — particularly when paired with the +42% realized return. Confirms threshold 70 as the floor for live trading. Also no signs of memory leak or RPC drift over 7h sustained.

**Caveats:**
1. 43 open positions at stop time is a lot of mid-flight capital — outcomes there will move realized PnL one way or the other, but the 15 finished positions are already enough for a directional read.
2. The 60× score-72 cluster (vs R6's 9×) confirms the saturation fix is steadily lifting more aged-active wallets into the buy zone.

---

## Run R10 — all-in TP mode A/B/C (2× / 3× / 5×)

R10 is three sequential 2h sub-runs at threshold 70, varying only `EXIT_AT_MULT`. `MAX_RUN_HOURS=2` and `CLOSE_ON_SHUTDOWN=true` are set so each session auto-stops cleanly with no open exposure carried.

### R10a — `EXIT_AT_MULT=2`
**Date:** 2026-04-27
**Code state:** post `EXIT_MODE` switch (`211e0a5`) + auto-shutdown (`ecaa54f`).
**Config:** OpenAI `gpt-5-nano`, `MIN_AI_SCORE=70`, `EXIT_MODE=all-in`, `EXIT_AT_MULT=2`, `MAX_RUN_HOURS=2`, `CLOSE_ON_SHUTDOWN=true`.
**Duration:** **2h** exact (18:47 → 20:47 UTC, MAX_RUN_HOURS auto-stopped at the boundary).

| Metric | Value |
|---|---|
| Detected | 2,450 |
| Analyzed | 482 |
| BUYS | 70 |
| Real TP/SL exits during run | **15 TP3 (2× wins) + 4 STOPLOSS = 19 finished naturally** |
| Shutdown-sweep closes | 50 (CLOSE_ON_SHUTDOWN closed remaining at last-observed price) |
| **Win rate on real exits** | **15/19 ≈ 79%** |
| DB realized PnL | +1.23 SOL on 3.50 spent (heavily caveated — see below) |

**Critical caveat — internet outage:**
The home internet dropped around 19:55 UTC and was still flaky at the 20:47 auto-shutdown — ~52 min of the 2h ran with degraded fresh-price observations. Bonding-curve fetches and DexScreener calls hit `getaddrinfo ENOTFOUND` and `TypeError: fetch failed` (46k+ such error lines in the log). The bot survived without crashing — RPC websocket reconnected automatically; sell helpers fell back to last-observed price; CLOSE_ON_SHUTDOWN swept all 50 remaining positions cleanly even with DNS still down. **But:** most of the 50 shutdown-sweep closes happened at stale prices, so the +1.23 SOL realized PnL is not a fair number to compare against R9's tiered baseline. The clean signal is the 19 naturally-finished trades' 79% win rate.

**Working hypothesis (preliminary, N=19):** all-in 2× has a *higher* win rate than tiered (R9's 67% on N=15). This would track with intuition — 2× is reachable on more pump tokens than 5×, and the tiered ladder needs all three thresholds for the bag to fully exit profitably.

**Two infrastructure wins from this run:**
1. `MAX_RUN_HOURS` triggered exactly at the 2h boundary — the auto-shutdown feature works in production.
2. `CLOSE_ON_SHUTDOWN` survived degraded network conditions — every remaining position got recorded with a sell, no leaked open exposure.

### R10b — `EXIT_AT_MULT=3`
**Date:** 2026-04-27 → 2026-04-28
**Code state:** same as R10a (`6a760fb`).
**Config:** OpenAI `gpt-5-nano`, `MIN_AI_SCORE=70`, `EXIT_MODE=all-in`, `EXIT_AT_MULT=3`, `MAX_RUN_HOURS=2`, `CLOSE_ON_SHUTDOWN=true`.
**Duration:** **2h** exact (23:33 → 01:33 local, MAX_RUN_HOURS auto-stopped at the boundary).

| Metric | Value |
|---|---|
| Detected | 2,373 |
| Analyzed | 707 |
| BUYS | 66 |
| Real TP/SL exits during run | **9 TP3 (3× wins) + 7 STOPLOSS = 16 finished naturally** |
| Shutdown-sweep closes | **0** (sweep hung — see caveat below; 50 positions left in `open` state) |
| **Win rate on real exits** | **9/16 ≈ 56%** |
| Realized PnL on naturally-finished | **+1.087 SOL** on 0.80 spent (16 × 0.05) |
| Avg win | +0.150 SOL (3× entry as expected for all-in 3×) |
| Avg loss | -0.038 SOL (≈0.4× stop-loss boundary) |

**Critical caveat — internet outage + shutdown bug:**
DNS started failing at 01:24:22 — 8 minutes before the 2h auto-shutdown fired at 01:33:04. When the shutdown handler invoked `closeAllOpenPositions`, every per-position price refresh hit `getaddrinfo ENOTFOUND` (88k+ such errors logged). Unlike R10a, the sweep never completed — no `shutdown close: N closed` log line ever printed, the process kept retrying for hours, and was eventually killed manually. Result: 50 positions remained `status='open'` in `pump.db` with stale `current_price_sol` from before the outage. **Bug to fix before live:** `closeAllOpenPositions` needs a per-position timeout and a give-up-after-N-failures fallback that marks positions closed at last-known price even when the network is down. R10a got lucky — the network came back briefly during its sweep.

**Working hypothesis (preliminary, N=16):** at threshold 70, all-in 3× has a *lower* win rate than all-in 2× (R10a's 79% on N=19) but a *higher* per-win profit (3× vs 2× entry). EV per finished trade in R10b: ≈ +0.068 SOL (1.087 / 16). Per-trade EV doesn't tell us much yet because R10a's number was contaminated by the outage stale-price marks. Compare cleanly after R10c.

### R10c — `EXIT_AT_MULT=5`
**Date:** 2026-04-28
**Code state:** same as R10a/b (`c00f1ca`).
**Config:** OpenAI `gpt-5-nano`, `MIN_AI_SCORE=70`, `EXIT_MODE=all-in`, `EXIT_AT_MULT=5`, `MAX_RUN_HOURS=2`, `CLOSE_ON_SHUTDOWN=true`.
**Duration:** **2h** exact (15:31 → 17:31 local, MAX_RUN_HOURS auto-stopped at the boundary).

| Metric | Value |
|---|---|
| Detected | 2,949 |
| Analyzed | 537 |
| BUYS | 55 |
| Real TP/SL exits during run | **2 TP3 (5× wins) + 3 STOPLOSS = 5 finished naturally** |
| Shutdown-sweep closes | **50** (sweep ran cleanly in ~16s — no outage this run) |
| **Win rate on real exits** | **2/5 = 40%** |
| Realized PnL on naturally-finished | **+0.425 SOL** on 0.25 spent (5 × 0.05) |
| Realized PnL incl. swept | +0.471 SOL on 2.75 spent (swept 50 positions netted ≈+0.046 SOL — basically flat) |
| Avg win | +0.265 SOL (5× entry, slightly inflated by bonding-curve gradient) |
| Avg loss | -0.035 SOL |

**Infrastructure wins this run:**
1. No internet outage — clean comparison data, unlike R10a/b.
2. `CLOSE_ON_SHUTDOWN` swept all 50 remaining positions in ~16 seconds (vs R10b where it hung). Confirms the bug from R10b is specifically a network-down failure mode, not a general flaw — the sweep works fine when at least last-known prices are reachable in memory. Still worth fixing before live.

**Working observation (N=5):** sample is too small for any standalone read on 5×. Two clean wins at 5× returned +0.265 SOL each — those are the kind of payoffs the tiered ladder was designed to capture. But only ~2.5 finished trades/hour vs 9.5/hr at 2× and 8/hr at 3× — the 5× target dramatically slows position turnover.

### R10 summary — comparing tiered vs all-in 2× / 3× / 5×

All four runs at `MIN_AI_SCORE=70`. R9 is tiered baseline; R10a/b/c are all-in at increasing exit multiples. Each R10 sub-run is 2h with the same nuke-and-restart protocol.

| | R9 tiered | R10a all-in 2× | R10b all-in 3× | R10c all-in 5× |
|---|---|---|---|---|
| Buys (in 2h-equivalent) | ~18 | 70 | 66 | 55 |
| Naturally finished | 15 | 19 | 16 | 5 |
| **Win rate on natural** | **67%** | **79%** | **56%** | **40%** |
| Avg win (SOL) | n/a | +0.05 | +0.150 | +0.265 |
| Avg loss (SOL) | n/a | -0.038 | -0.038 | -0.035 |
| **EV per finished trade** | n/a | **+0.032** | **+0.067** | **+0.085** |
| Finished trades / hour | ~2 | 9.5 | 8 | 2.5 |
| **Throughput-weighted EV (SOL/hr)** | n/a | **+0.30** | **+0.54** | **+0.21** |
| Realized PnL on natural | +1.39 | (caveated by outage) | +1.087 | +0.425 |

**Reading the table:**

- **Per-trade EV climbs as the exit target rises** (+0.032 → +0.067 → +0.085). The bigger the win when you hit, the more it dwarfs the small losses — even at lower hit rates.
- **But finished-trades-per-hour collapses as the exit target rises** (9.5 → 8 → 2.5). At 5×, most positions never resolve in a 2h window, so the headline EV barely matters — you're stuck waiting.
- **Throughput-weighted (EV × finished/hr) suggests 3× is the sweet spot** at +0.54 SOL/hr, beating 2× (+0.30) and 5× (+0.21). The 3× target is high enough to make wins meaningful but low enough that pump tokens regularly hit it inside a 2h window.

**Caveats — these numbers are NOT statistically robust:**
- R10c's 40% win rate is N=5 (~50% noise band).
- R10b's 56% is N=16 (still wide CI ~30-78%).
- R10a's per-win average is contaminated by the internet outage marking shutdown-sweep closes at stale prices.
- Two hours per run isn't enough to see the long tail (a single 27× run like R6 saw could flip any of these).

**Provisional pick for R11 (the 24h gate):** **all-in 3×.** Reasoning: best throughput-weighted EV in the tiny sample, 56% win rate is plausible to hold over 24h, 3× exits compound nicely (+200% per win every ~7 min), and unlike 5× we won't be left with most of the bag in unresolved limbo at session-end. If R11 disagrees, we'll have the actual signal.

**Pre-R11 fix landed (`5503955`):** `closeAllOpenPositions` now bounds each position's price refresh and sell with a 5s `withTimeout`. On timeout we keep the DB-stored last-known price and proceed with the close, so a DNS blip during the 24h R11 window can't stall the sweep the way it stalled R10b. Covered by two new tests in `tests/positions.test.ts` (hung refresh, hung sell).

---

## Run R11a — *aborted at ~17h* — graduated-curve cache poisoning bug
**Date:** 2026-04-30 14:30 WAT → stopped 2026-05-01 ~07:45 WAT
**Code state:** post-R10 with the four pre-R11 commits (interval bump, max-positions short-circuit, **graduated-curve cache** in `ea7e0ac`, RPC counter).
**Config:** EXIT_MODE=all-in, EXIT_AT_MULT=3, MAX_RUN_HOURS=24, CLOSE_ON_SHUTDOWN=true.
**Outcome:** Aborted. Data invalid for PnL evaluation.

**Bug.** A single ~600 ms RPC blip at log time 17:12:46 (3h after launch) caused `getAccountInfo` to throw or return null for nearly every open position in one monitor tick. The graduated-curve cache from `ea7e0ac` collapsed three different null sources (RPC throw, missing account info, actually-graduated curve) into one signal and **permanently** marked **48 of 50 open positions** as graduated in ~600 ms. From then on every tick fell back to DexScreener, which doesn't index fresh pump tokens reliably, so prices froze and not a single position exited via TP3 or SL for the next 14 hours. New buys still came in (max=50 cap correctly short-circuited) but the bag never drained.

**Symptom that surfaced it.** User noticed multiple positions with the chart showing +189% on pump.fun while our DB price hadn't moved. DB confirmed: 42/50 open positions below entry, 8 above, none exiting; log confirmed the cascade — 48 "graduated?" messages within 600 ms.

**Fix shipped: `0452ab8` Distinguish graduated curves from transient RPC failures.** `fetchBondingCurvePrice` replaced with `readBondingCurve` returning a discriminated union (`'price'` / `'graduated'` / `'unavailable'`). Cache adds only on `'graduated'`. Two regression tests cover the two transient-null sources.

**Lessons.**
- Three different null sources collapsed into one signal is the canonical "any blip poisons the cache" footgun. Always distinguish "permanently absent" from "not right now" at the boundary of any cache.
- The new RPC counter from `c2e27dc` would have caught this earlier had we plotted `getAccountInfo` over time — its growth rate effectively went to zero after the cascade. Watch for this in R11b.

---

## Run R11b — 24h, completed — 2026-05-01 → 2026-05-02
**Date:** 2026-05-01 08:06 WAT → 2026-05-02 08:06 WAT (auto-stop on MAX_RUN_HOURS=24).
**Code state:** post-R11a fix (`0452ab8`) + banner enhancement (`223e5f3`).
**Config:** EXIT_MODE=all-in, EXIT_AT_MULT=3, MAX_RUN_HOURS=24, CLOSE_ON_SHUTDOWN=true, MAX_OPEN_POSITIONS=50.

**Headline numbers**
- 62 buys total, all in the first ~63 minutes (07:07-08:10 UTC).
- 11 naturally finished — 6 TP3 + 5 SL = **54.5% win rate** on natural exits.
- Realized PnL on natural exits: **+0.86 SOL** on 0.55 SOL spent (~+156%).
- Sweep-closed at shutdown: 51 positions, avg final mult **1.02× entry**, range 0.94-2.12×.
- Total realized PnL: **+0.92 SOL** on 3.10 SOL spent (+29.7%).
- ~273K Helius RPC calls.

**The graduated-curve fix held.** `graduated: 0`, `unavailable: 4914` — every transient null fell through to DexScreener for that single tick without poisoning the cache. The R11a regression test passed in production.

**Two new issues surfaced.**

**1. The bag became a graveyard after the first hour.** All 11 natural exits happened between 07:13 and 07:57 UTC (first ~45 min). For the next 23h: zero natural exits. The 50-position cap filled by 08:10 and stayed pegged. The 51 stuck positions averaged 1.02× entry — they never moved enough to hit TP3 (3×) or SL (0.4×). The all-in 3× strategy implicitly assumes every position eventually resolves; it doesn't. Tokens spike in the first 5-10 minutes then flatline. **Capital was idle for 23 of 24 hours.** Fixed in `850f93f` — new `MAX_HOLD_MINUTES` env forces a time-based exit at last price for any position past the threshold, draining the corpse bag and recycling capital.

**2. WebSocket died at T+15.5h and reconnect hung.** At 23:42 the listener stopped receiving events. The empty-window detector logged "RPC WebSocket may be dead" 96 consecutive times. The auto-reconnect fired exactly once at 00:00:00.215 ("Tearing down dead WebSocket subscription...") but never logged "re-subscribed", "reconnect failed", or any further attempt. Diagnosis: `await connection.removeOnLogsListener(subscriptionId)` hung indefinitely on the dead WebSocket; the `try/finally` never returned; `reconnecting` stayed pinned to `true`; every subsequent heartbeat skipped the reconnect path. 8.5 hours of zombie listener until auto-stop. Fixed in `6a6c694` — `removeOnLogsListener` is now wrapped in `withTimeout`, mirroring the close-on-shutdown sweep pattern.

**Lessons.**
- TP/SL alone is not sufficient exit logic for a memecoin sniper. A meaningful fraction of pumps die in flat ranges that never trigger either side. Time-based forced exit is the missing third leg.
- Any unbounded `await` against an external resource is a footgun. R10b had it for shutdown sweep, R11b had it for WS teardown. The remediation pattern is the same: `withTimeout`.
- The new `rpc:` heartbeat correctly showed the symptom — `getAccountInfo` growth flatlined to ~80/min over the dead-bag period (down from ~6000/min during the active first hour). Worth flagging in future runs.

---

## Run R12 — *planned* — 24h with time-exit and reconnect fixes
**Date:** _pending_
**Code state:** post-R11b fixes (time-exit + reconnect timeout).
**Config:** EXIT_MODE=all-in, EXIT_AT_MULT=3, MAX_RUN_HOURS=24, CLOSE_ON_SHUTDOWN=true, MAX_OPEN_POSITIONS=50, **MAX_HOLD_MINUTES=30** (new — drains stale positions so the bag doesn't fossilize).
**Duration:** 24 hours.
**Goal:** validate that time-exit recycles the bag at a reasonable cadence (target: ≥20 buys/hour sustained throughout the run, not just the first hour) and that the WebSocket reconnect actually re-establishes after a death. Live-readiness gate stays the same: ≥20 finished positions, positive realized PnL, no recurring crashes.

**Watch during the run.**
- `STATUS` heartbeat every 15 min: `closed` and `stopped` counts should grow continuously, not stall after hour 1.
- `listener heartbeat`: events should stay non-zero. If a "WebSocket may be dead" appears, look for "Listener re-subscribed" within the next 5 min — its absence is the bug recurring.
- `rpc:` line: `getAccountInfo` growth rate reflects open-bag size × tick rate; should NOT flatline.

---

## Run R-live-1 — first live pump run; pump V2 program upgrade
**Date:** 2026-05-15
**Code state:** circuit breaker shipped (`ed07789`); live pump buy/sell still on the hand-rolled legacy `buy` instruction (pre-SDK migration).
**Config:** LIVE (`SIMULATE=false`), `--source pump`. Validation sizing: `BUY_AMOUNT_SOL=0.02`, `MAX_OPEN_POSITIONS=3`, `MAX_RUN_HOURS=2`, `MAX_SLIPPAGE_BPS=500`, `MIN_AI_SCORE=70` (gpt-5-nano), `EXIT_MODE=all-in` 3×, `MAX_CONSECUTIVE_BUY_FAILURES=3`. Wallet funded with 0.3135 SOL.
**Duration:** ~33 s (15:02:09 → 15:02:42; circuit-breaker shutdown).

| Metric | Value |
|---|---|
| BUYING attempts | 3 (AI scores 72 / 72 / 75) |
| Buy failures | 3 — all `InstructionError [3, Custom:6062]` |
| Positions opened | 0 |
| Realized PnL | 0 SOL |
| Cost | ~0.0001 SOL (3 reverted-tx fees; not DB-tracked) |

**Outcome:** every buy reverted with pump program error `6062 BuybackFeeRecipientMissing`. The consecutive-buy-failure circuit breaker tripped at 3 and shut down gracefully — 0 positions opened, 0 SOL lost.

**Learning:** pump.fun had shipped a V2 program upgrade (`buy_v2`/`sell_v2`, a cashback/buyback system). The hand-rolled legacy `buy` matched the IDL's *static* account list, but the program now also requires buyback fee-recipient accounts passed as *remaining accounts*, which the static IDL doesn't surface. Hand-rolling instructions against a fast-moving program is a maintenance trap — migrated live buy/sell to the official `@pump-fun/pump-sdk` (`buy_v2`/`sell_v2`, commit `40e58a4`). The validation design held: small sizing plus the 3-strike breaker meant a wrong instruction cost ~$0 and surfaced an exact, fixable error in 33 seconds — exactly what a first live run is for.

---

## Run R-live-2 — first live trades on the pump SDK
**Date:** 2026-05-15
**Code state:** post-SDK migration — live buy/sell via `@pump-fun/pump-sdk` (`buy_v2`/`sell_v2`, commit `40e58a4`); launched with `make snipe-pump-fresh LABEL=R-live-2`.
**Config:** LIVE (`SIMULATE=false`), `--source pump`. Same validation sizing as R-live-1: `BUY_AMOUNT_SOL=0.02`, `MAX_OPEN_POSITIONS=3`, `MAX_SLIPPAGE_BPS=500`, `MIN_AI_SCORE=70` (gpt-5-nano), `EXIT_MODE=all-in` 3×, `MAX_CONSECUTIVE_BUY_FAILURES=3`.
**Duration:** ~2 min of activity (19:02:55 first BUYING → 19:05:01 manual SIGINT).

| Metric | Value |
|---|---|
| BUYING attempts | 5 |
| Buys landed | 3 — all `pump v2` |
| Buy failures | 2 — `block height exceeded` ×1, `Custom:6002 TooMuchSolRequired` ×1 |
| Positions | 3 opened, 3 closed |
| Realized PnL | **+0.009069 SOL** (spent 0.060, received 0.069) |
| Best exit | `BUhPmqd5…pump` — 3×-triggered all-in exit, 0.02 → 0.029 SOL |

**Outcome:** first successful live trades — the SDK migration fixed 6062, `buy_v2`/`sell_v2` build and land correctly. 3 of 5 buys landed; the 2 misses were a tx that expired before confirming and a slippage revert (`6002`) on a fast curve — operational, not structural. `BUhPmqd5` caught a 3× spike via the all-in exit. Run was stopped manually after the 2 failures.

**Learning / issues surfaced:**
- The pump SDK path is validated on-chain. The hand-rolled instruction layer is fully retired.
- `CLOSE_ON_SHUTDOWN` left a position open: a live SDK sell (4 RPC fetches + send-and-confirm) runs 10-20s, past the 5s per-position shutdown-sell timeout. Bumped `SHUTDOWN_PER_POSITION_TIMEOUT_MS` to 30s. The stranded position (`9iZnmeHg…pump`) was sold manually at ~breakeven; the DB row was reconciled.
- An all-in exit logs `tp_level=3` but the realized multiple is whatever the curve is when the sell *lands* — `BUhPmqd5` triggered at 3× but realized ~1.45×. On fast curves the booked `amount_sol_received` is the truth, not the trigger label.
- Failure levers if they recur: raise `PUMP_PRIORITY_MICROLAMPORTS` (tx not landing) or `MAX_SLIPPAGE_BPS` (slippage reverts).

---

## Run R-live-3 — first 2h attempt; circuit breaker tripped at 12 min
**Date:** 2026-05-15
**Code state:** post-SDK migration; shutdown-sell timeout widened to 30s (`4ef9918`). Launched with `make snipe-pump-fresh LABEL=R-live-3`.
**Config:** LIVE, `--source pump`. Validation sizing — `BUY_AMOUNT_SOL=0.02`, `MAX_OPEN_POSITIONS=3`, `MAX_RUN_HOURS=2`, `MAX_SLIPPAGE_BPS=500`, `PUMP_PRIORITY_MICROLAMPORTS=100000`, `MIN_AI_SCORE=70` (gpt-5-nano), `EXIT_MODE=all-in` 3×, `MAX_CONSECUTIVE_BUY_FAILURES=3`.
**Duration:** ~12.5 min (20:27:31 → 20:39:59; circuit-breaker shutdown — did not reach the 2h cap).

| Metric | Value |
|---|---|
| BUYING attempts | 12 |
| Buys landed | 4 |
| Buy failures | 8 — 6× `6002` slippage, 2× `block height exceeded` |
| Positions | 4 opened, 4 closed |
| Realized PnL | **−0.0154 SOL** (spent 0.080, received 0.065) |
| Outcomes | 1 stop-loss (−0.014), 2 ~breakeven exits, 1 manually reconciled at breakeven |

**Outcome:** 67% buy-failure rate. The circuit breaker tripped on 3 consecutive failures and shut down at 12.5 min — no 2h baseline yet. The 4 buys that landed produced zero winners.

**Learning:**
- Root cause is landing latency, not a bug. The bot is too slow: the curve moves >5% between our quote and the tx landing (`6002` slippage revert) or the tx expires before confirming (`block height exceeded`). `PUMP_PRIORITY_MICROLAMPORTS=100000` is far too low — raised to `1000000` for R-live-4.
- The shutdown sweep stranded a position again (`2N4Wf`) — its sell couldn't land within the 30s timeout (same latency). Manually sold at breakeven; DB reconciled.
- The breaker at 3 trips on slippage *clusters*, not just systematic faults — 3 hot launches in a row is enough. Now that the encoding is proven, the threshold should be raised so a measurement run can actually complete.
- Across R-live-2 + R-live-3: 7 landed buys, 1 winner. The code works; the strategy is unproven; no complete run yet.

---

## Run R-live-4 — priority-fee fix lands buys; mayhem-mode coins block sells
**Date:** 2026-05-15
**Code state:** post-SDK migration; `PUMP_PRIORITY_MICROLAMPORTS` raised to `1000000` and `MAX_CONSECUTIVE_BUY_FAILURES` to `8` after R-live-3. Launched with `make snipe-pump-fresh LABEL=R-live-4`.
**Config:** LIVE, `--source pump`. Validation sizing — `BUY_AMOUNT_SOL=0.02`, `MAX_OPEN_POSITIONS=3`, `MAX_RUN_HOURS=2`, `MAX_HOLD_MINUTES=10`, `MAX_SLIPPAGE_BPS=500`, `PUMP_PRIORITY_MICROLAMPORTS=1000000`, `MIN_AI_SCORE=70` (gpt-5-nano), `EXIT_MODE=all-in` 3×, `MAX_CONSECUTIVE_BUY_FAILURES=8`, `CLOSE_ON_SHUTDOWN=true`.
**Duration:** ~45 min (20:27 → ~21:12; manually stopped when sells began reverting — did not reach the 2h cap).

| Metric | Value |
|---|---|
| BUYING attempts | 14 |
| Buys landed | 10 (71%) |
| Buy failures | 4 |
| Positions | 10 opened, all terminal — 8 sold, 2 unsellable |
| Realized PnL | **−0.0703 SOL** (spent 0.200, received 0.130) |
| Outcomes | 1 marginal win, 5 small slippage losses, 2 stop-losses, 2 mayhem-mode write-offs |

**Outcome:** the priority-fee fix worked — buy landing jumped from 33% (R-live-3) to 71%. But a new blocker surfaced: 2 of the 10 coins were pump.fun **Mayhem Mode** coins, and their bonding-curve sells revert with `Custom:6024` ("Overflow", pump program `lib.rs:800`). The run was stopped manually when sells started failing. Strategy still unproven: 1 win / 10.

**Learning:**
- Priority fee fix validated — `1000000` micro-lamports lifted buy landing 33% → 71%. The breaker at 8 never tripped.
- New blocker: **mayhem-mode coins are unsellable.** Confirmed *not* a miper bug — pump.fun's own UI hits the identical `6024` revert (tx `29wGTLC7…`). A mayhem coin can enter a "Paused" state where its curve sell overflows; the position becomes unsellable by anyone. Capital trapped: −0.04 SOL (positions 1 `73TYbJ…`, 7 `93dbzwSct…`/CHUB). Both reconciled in `pump.db` as `closed` write-offs (tokens still held, unsellable).
- The 8 non-mayhem coins all sold fine — the sell path works for regular coins.
- **Fix shipped post-run:** the analyzer now decodes the mayhem flag (byte 81 of the bonding curve) and `runSafetyChecks` rejects mayhem-mode coins at buy time. The bot will never buy one again.
- Across R-live-2 → R-live-4: 21 landed buys, 2 winners. Buy-side latency is solved; the exit strategy is still unproven; no complete 2h run yet. Next: R-live-5 with the mayhem filter, full 2h, no manual intervention.

---

## Run R-live-5 — mayhem filter holds; buy landing collapses, breaker at 58 min
**Date:** 2026-05-16
**Code state:** mayhem-mode buy filter shipped (`613808b`). Launched with `make snipe-pump-fresh LABEL=R-live-5`.
**Config:** LIVE, `--source pump`. `BUY_AMOUNT_SOL=0.02`, `MAX_OPEN_POSITIONS=3`, `MAX_RUN_HOURS=2`, `MAX_HOLD_MINUTES=10`, `MAX_SLIPPAGE_BPS=500`, `PUMP_PRIORITY_MICROLAMPORTS=1000000` (static — pre dynamic-fee), `MIN_AI_SCORE=70` (gpt-5-nano), `EXIT_MODE=all-in` 3×, `MAX_CONSECUTIVE_BUY_FAILURES=8`, `CLOSE_ON_SHUTDOWN=true`.
**Duration:** ~58 min (04:02 → 05:00; circuit-breaker shutdown on 8 consecutive buy failures — did not reach the 2h cap).

| Metric | Value |
|---|---|
| BUYING attempts | ~31 |
| Buys landed | 8 (~26%) |
| Buy failures | 23 — 37 `block height exceeded` tx-expiry events |
| Mayhem coins rejected | 141 — filter working, **zero bought, zero `6024`** |
| Positions | 8 opened, all 8 finished (closed) |
| Realized PnL | **−0.0033 SOL** (spent 0.160, received 0.157) |
| Outcomes | all 8 time-exited at `MAX_HOLD_MINUTES`; 1 marginal win, 7 × −2.5% |

**Outcome:** the mayhem filter is validated — 141 mayhem coins rejected, none bought, no `6024` reverts. But buy landing collapsed to ~26% (R-live-4 was 71% at the same static fee), and the breaker tripped at 58 min. Still no clean 2h run. Of the 8 that landed, none reached the 3× target and none rugged — they all drifted sideways and force-exited flat.

**Learning:**
- Mayhem-mode blocker is closed. The filter works exactly as designed.
- **Buy landing is now the live blocker.** A static priority fee isn't competitive across network conditions — 71% landing in a calm window, 26% in a busy one. 37 `block height exceeded`: each tx was sent once, dropped by validators, then left to expire with nothing resending it. This is the third run killed by buy latency (R-live-3, R-live-5).
- The 8 landed trades say nothing yet about the strategy — a thin sample, all time-exited at flat. Strategy verdict still pending a clean run.
- **Fix shipped post-run:** `sendPumpTransaction` now sets a dynamic priority fee from `getRecentPrioritizationFees` (clamped floor..max via `PUMP_PRIORITY_MAX_MICROLAMPORTS`) and actively rebroadcasts the signed tx until it confirms or its blockhash truly expires. Next: R-live-6.

---

## Run R-live-6 — tx landing solved; buy slippage is the new wall
**Date:** 2026-05-16
**Code state:** dynamic priority fee + tx rebroadcast shipped (`860261e`). Launched with `make snipe-pump-fresh LABEL=R-live-6`.
**Config:** LIVE, `--source pump`. `BUY_AMOUNT_SOL=0.02`, `MAX_OPEN_POSITIONS=3`, `MAX_RUN_HOURS=2`, `MAX_HOLD_MINUTES=10`, `MAX_SLIPPAGE_BPS=500`, `PUMP_PRIORITY_MICROLAMPORTS=1000000` floor / `5000000` max (dynamic), `MIN_AI_SCORE=70` (gpt-5-nano), `EXIT_MODE=all-in` 3×, `MAX_CONSECUTIVE_BUY_FAILURES=8`.
**Duration:** ~64 min (08:28 → 09:32; circuit-breaker shutdown on 8 consecutive buy failures — did not reach the 2h cap).

| Metric | Value |
|---|---|
| BUYING attempts | 31 |
| tx landing | ~100% — **zero `block height exceeded`** (R-live-5 had 37) |
| Buys succeeded | 10 (32%) |
| Buy failures | 21 — all `Custom:6002` buy-slippage reverts |
| Mayhem coins rejected | 198 |
| Positions | 10 opened, all 10 finished (closed) |
| Realized PnL | **−0.0048 SOL** (spent 0.200, received 0.195) |
| Outcomes | all 10 time-exited at `MAX_HOLD_MINUTES`; 0 wins |

**Outcome:** the dynamic-fee + rebroadcast fix eliminated `block height exceeded` entirely — every tx landed, on the free RPC tier (no upgrade needed). The failure mode shifted: 21 of 31 buys (68%) landed and reverted with `Custom:6002` — the curve moved past the 5% slippage cap between the curve read and execution. In the final 12 minutes every buy hit it → breaker at 64 min.

**Learning:**
- Buy *landing* is solved. Dynamic priority fee + rebroadcast validated: `block height exceeded` 37 → 0. The free Helius tier is sufficient — the old static send-once path was the wall, not the RPC.
- Buy *slippage* is the new wall. 5% (`MAX_SLIPPAGE_BPS=500`) is too tight for hot pump.fun launches that move 5-15% in the 1-2s a tx takes to land. Fixed post-run: `MAX_SLIPPAGE_BPS` 500 → 1500.
- The 10 landed trades all time-exited flat at 10 min — none reached 3×, consistent with R-live-4/5. Strategy verdict still pending a complete run.
- Next: R-live-7 at 15% slippage — targeting the first complete 2h run.

---

## Run R-live-7 — first positive PnL; aborted by a connectivity gap
**Date:** 2026-05-16
**Code state:** `MAX_SLIPPAGE_BPS` raised to 1500 (15%). Launched with `make snipe-pump-fresh LABEL=R-live-7`.
**Config:** LIVE, `--source pump`. `BUY_AMOUNT_SOL=0.02`, `MAX_OPEN_POSITIONS=3`, `MAX_RUN_HOURS=2`, `MAX_HOLD_MINUTES=10`, `MAX_SLIPPAGE_BPS=1500`, `PUMP_PRIORITY_MICROLAMPORTS=1000000` floor / `5000000` max, `MIN_AI_SCORE=70` (gpt-5-nano), `EXIT_MODE=all-in` 3×, `MAX_CONSECUTIVE_BUY_FAILURES=8`.
**Duration:** ~35 min of trading (started 10:10; local internet data ran out ~10:35, killing the RPC WebSocket; hard-killed at 10:45). Did not reach the 2h cap.

| Metric | Value |
|---|---|
| Positions | 5 opened, all 5 finished (closed) |
| Realized PnL | **+0.0087 SOL** (spent 0.100, received 0.109) — first positive live run |
| Win rate | 40% (2/5) |
| Standout | #4 `3xozEyVu` time-exited at 1.52× for +0.01 SOL — the run's one real winner |
| Buy slippage | 15% cap held — no `Custom:6002` reverts in the window observed |

**Outcome:** first positive PnL across all live runs — but a 5-trade sample, aborted early, and the +0.0087 is essentially one 1.5× winner against an otherwise flat book. The 15% slippage cap stopped the `6002` reverts that broke R-live-6. The run ended when local internet data ran out: the WebSocket went dead at ~10:35, the bot detected it (`WS may be dead`) but did not self-heal, and the SIGINT shutdown then hung — the process had to be hard-killed.

**Learning:**
- First positive live run, but not significant — 5 trades, one winner. Still need a complete clean run.
- 15% slippage held — no slippage reverts observed.
- Two robustness bugs surfaced: (1) the listener detects a silently-dead WebSocket (zombie socket — open but delivering nothing) but only warns; it does not force a resubscribe or shut down, so the run goes blind. (2) Graceful shutdown hangs on SIGINT when the connection is dead.
- `MAX_HOLD_MINUTES=10` did all the selling — even the winner time-exited at 1.5×; the 3× target never fired.
- Next: fix the WS self-heal + the SIGINT hang, then R-live-8.

---

## Run R-live-8 — first complete 2h run; the launch-snipe thesis has no edge
**Date:** 2026-05-16
**Code state:** listener hardened against a dead WebSocket (`2efd9dc`). Launched with `make snipe-pump-fresh LABEL=R-live-8`.
**Config:** LIVE, `--source pump`. `BUY_AMOUNT_SOL=0.02`, `MAX_OPEN_POSITIONS=3`, `MAX_RUN_HOURS=2`, `MAX_HOLD_MINUTES=10`, `MAX_SLIPPAGE_BPS=1500`, dynamic priority fee, `MIN_AI_SCORE=70` (gpt-5-nano), `EXIT_MODE=all-in` 3×.
**Duration:** full 2h — auto-stopped at the `MAX_RUN_HOURS` cap. First run to complete cleanly: no breaker, no connectivity abort.

| Metric | Value |
|---|---|
| Positions | 31, all finished (#31 a buy that landed at the shutdown instant — sold manually for breakeven) |
| Realized PnL | **−0.0074 SOL** — essentially flat |
| Win rate | ~10% (3/31), best trade **1.12×** |
| 3× target hit | **0 times** — every position time-exited at 10 min |

**Outcome:** the plumbing held — first complete run, the engineering goal of R-live-3→8. But the strategy is net-flat with no real winners.

**Post-mortem** (`scripts/exit-postmortem.ts`): all 31 tokens checked 1–3h after entry — **every one sits 0.99–1.09× our entry, all parked at a near-identical ~$2.4k market cap** (the bonding-curve floor). Zero reached 2×. They were dead-on-arrival launches; holding longer would not have helped — there was nothing to ride.

**Learning:**
- It's the **entry**, not the exit. miper buys tokens that never pump — 31/31 duds. The launch-time AI gate (dev deposit / creator history / metadata) shows no edge: it selects at the base rate, and the base rate for pump.fun launches is ~total death.
- Paper looked good because simulation has no slippage or fees; live's ~2% per-trade drag exposed the absence of edge underneath.
- **Decision: abandon the launch-snipe thesis.** Pivot to a momentum entry — watch a token's first minutes and buy only on demonstrated traction, not predicted potential. See R-live-9+.

---

## Run R-live-9 — momentum entry, first run; the funnel works, the buy doesn't
**Date:** 2026-05-16
**Code state:** launch-snipe replaced with the `MomentumWatcher` + bundle-veto pre-screen (`cd29f44`). Launched with `make snipe-pump-fresh LABEL=R-live-9`. Startup banner still showed an AI score; dropped mid-run (`f0ac7b6`).
**Config:** LIVE, `--source pump`. `BUY_AMOUNT_SOL=0.02`, `MAX_OPEN_POSITIONS=3`, `MAX_RUN_HOURS=2`, `MAX_SLIPPAGE_BPS=1500`, momentum window 3min, band [1.4×, 2.5×], `MOMENTUM_BUNDLE_THRESHOLD=3`, `EXIT_MODE=all-in` 3×.
**Duration:** full 2h.

| Stage | Count |
|---|---|
| Tokens watched | ~983 |
| Triggered the band | ~80 |
| Bundle-vetoed | ~22 (28% of triggers) |
| Safety-vetoed | ~43 |
| Buy attempts | ~14 |
| Buys landed | **1** — the other 13 reverted `Custom:6002` (slippage) |

**Outcome:** the momentum funnel is sound — it watches ~1k launches and surfaces ~80 real climbers, and the bundle veto fires on a meaningful 28%. But 13 of 14 buys reverted on slippage: the trigger fired on a price up to one sample interval (25s) stale, and the buy couldn't land before the climbing token moved past the 15% cap.

**Learning:**
- The watch/score side works; the *entry execution* is the wall — same `6002` as R-live-6, now caused by stale-sample lag rather than launch heat.
- Decision: momentum v1.1 — add a **min-age filter** (drop band-crossings too fast to catch) and **pre-screen during the watch** so the entry path is just a buy. See R-live-10.

---

## Run R-live-10 — momentum v1.1; min-age filter holds, buys still can't land
**Date:** 2026-05-16
**Code state:** momentum v1.1 — min-age filter + pre-screen-during-watch (`9fb3cd1`). Launched with `make snipe-pump-fresh LABEL=R-live-10`.
**Config:** LIVE, `--source pump`. `BUY_AMOUNT_SOL=0.02`, `MAX_OPEN_POSITIONS=3`, `MAX_RUN_HOURS=2`, `MAX_SLIPPAGE_BPS=1500`, momentum window 3min, band [1.4×, 2.5×], `MOMENTUM_MIN_AGE_SEC=60`, `MOMENTUM_BUNDLE_THRESHOLD=3`, `EXIT_MODE=all-in` 3×.
**Duration:** full 2h. A 10–12 min local-internet gap mid-run; the bot recovered and ran to the cap.

| Stage | Count |
|---|---|
| Tokens watched | 1957 |
| Expired the window (never reached the band) | 993 |
| Dropped by the min-age filter (band hit too fast) | ~35 |
| Ran past the band | 3 |
| Pre-screen vetoed | 894 (505 mayhem, 389 bundled) |
| Clean entries (in-band, ≥60s old, screen passed) | **7** |
| Buys landed | **0** — all 7 reverted `Custom:6002` (slippage) |

**Outcome:** the min-age filter works as intended — it dropped the sub-60s spikes — and pre-screen-during-watch made the entry path a clean buy. But all 7 catchable entries (climbs of +42–64% over 71–123s) still reverted on slippage. The buy path already re-quotes a *fresh* curve, so this is genuine in-flight movement: a momentum token is under active buy pressure by construction and climbs >15% in the seconds the tx is airborne. Across R-live-9 + R-live-10, **20 of 21 momentum buys reverted `6002`**.

**Learning:**
- Not a tuning problem — a structural one. Detecting a 40%+ climb and then landing a buy at 15% slippage *while it is still climbing* is contradictory.
- Decision: R-live-11 raises `MAX_SLIPPAGE_BPS` to 4000 (40%) and caches `fetchGlobal`/`fetchFeeConfig` to cut buy-tx latency. Three clean outcomes: buys land and fills profit (momentum works), buys land and fills lose (momentum-entry dead — pivot with real fill data), or buys still fail (the bonding curve is uninvestable for a latency-bound bot).

---

## Future ideas — non-priority experiments

Things we've considered but explicitly *not* on the active roadmap. If we do build any of these, slot a numbered run for it; don't reorder R7-R11.

### DexScreener trending entry — a separate strategy, separate branch

**Idea:** stop trading the pump.fun bonding curve entirely. Instead trade *graduated* AMM tokens the way the user picks them by hand on DexScreener: poll for new pairs, keep only those that clear a liquidity / market-cap / volume / age filter, score the survivors, buy via Jupiter.

**The user's manual filter (proven by hand, screenshots 2026-05-17):**
- Liquidity ≥ ~$10k–100k
- Market cap ~$22k to ≥$100k
- Appears under DexScreener's "New — Trending 6H"
- Volume looks healthy relative to liquidity
- The token name/ticker is appealing (a human gut call)

**Why it's promising — it dodges every wall the bonding-curve runs hit:**
- Graduated tokens sit in real AMM pools → deep liquidity → no `6002` slippage wall (R-live-9/10/11's killer).
- They've already survived hours with real volume → none of the $2.4k dead-on-arrival duds that sank launch-snipe (R-live-8).
- The launch-time AI gate had no edge because there's nothing to judge at $2k. Here there's a real chart, real volume, a real name — and an LLM is genuinely good at the "do I like this name/vibe" call.

**Build sketch:** a DexScreener listener (poll `api.dexscreener.com` new-pairs / search, filter client-side to reconstruct "trending 6H") replacing the mint listener; reuse the Jupiter swap path and the exit engine; the AI score becomes a name/vibe judgement, not a stats gate.

**Status:** queued. Own branch off `main` once the momentum-v2 line resolves. Possibly a stronger bet than copy-trading — no winning-wallet sourcing dependency, and it is the user's own demonstrated edge.

### Rollover mode (casino, not income)

**Idea:** start with 1 SOL, take the FULL stack (capital + every prior win) into each next trade, exit fully at a target multiple, repeat until total pot reaches a stop target (e.g. 10 SOL) or a single trade SLs and the run ends.

**Why it's parking-lot, not roadmap:**
- Mathematically a casino bet — one stop-loss anywhere in the chain ends the entire run with most of the stack lost.
- At R8's measured 27% win rate: P(3 consecutive wins to 8×) ≈ 2%. Even at R6's 67%, P(3 consecutive) ≈ 30%, so 70%+ chance of going to ~zero.
- Bounded gain, near-total loss. That is fundamentally different from income generation, which is the user's stated goal for this project.

**If we ever do build it:** env switches `EXIT_MODE=rollover`, `ROLLOVER_TARGET_SOL=10`, single-position-at-a-time guard so the bot doesn't run multiple parallel rollover chains. ~50 lines of code. Worth it only as a one-off "for fun" run after the income strategy is validated and live, never as the primary mode.

---

## Process

Before nuking `pump.db` / `pump.log` after a meaningful run:

1. Note the commit hash (`git log --oneline -1`) and any non-default `.env` values.
2. Capture pipeline counts: detected / analyzed / skipped / BUYS / exits.
3. Capture score distribution: `grep -oE "AI scored [^:]+: [0-9]+/100" pump.log | grep -oE "[0-9]+/100" | sort -n | uniq -c | sort -rn`.
4. Capture realized PnL: `npm run review:pump`.
5. Append an entry here. Then nuke.
