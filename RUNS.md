# Paper-Trading Run Log

A condensed history of paper-trading sessions on `pump-fun` so we have a reference before each `pump.db` / `pump.log` nuke. Append a new entry per meaningful run; old runs aren't backfilled in detail because the code state changes between them.

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

**Pre-R11 must-fix:** the `closeAllOpenPositions` hang seen in R10b. For a 24h unattended run where DNS could blip at any point, the sweep must time out per position and fall back to last-known price. Tracked as the first phase-2 prereq.

---

## Run R11 — *planned* — 24h continuous, last paper-trade gate before live
**Date:** _pending_
**Code state:** post-R10.
**Config:** R10's winning config, no changes between R10 and R11.
**Duration:** **24 hours**.
**Goal:** Spec section 6 calls for 3-7 days continuous before live. R11 is day 1 — also tests pump.fun activity variation across the full UTC day (US peak around 13:00-04:00 UTC matters; quieter hours might produce different score distributions). After R11, the live-readiness checklist in `npm run review:pump` is the gate: ≥20 finished positions, positive realized PnL, no recurring crashes.

---

## Future ideas — non-priority experiments

Things we've considered but explicitly *not* on the active roadmap. If we do build any of these, slot a numbered run for it; don't reorder R7-R11.

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
