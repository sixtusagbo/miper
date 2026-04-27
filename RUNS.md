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

**Comparison vs R7 (threshold 70, same code):**
- Buy volume: 76 in ~hour vs R7's 11 in 32 min → ~7× more buys at threshold 60
- Win rate on finished: **27% (R8) vs ~67% (R6 baseline at threshold 70 with N=3)**
- Direction is the predicted one — the marginal 60-65 picks have noticeably lower win rate. Tokens with one strong signal but missing other signals (the bulk that scored 60-65 in R6) lose more than they win.

**Caveats:**
1. Run ended via normal user-stop (back from gym), not error. The 39 open + 11 partial positions are mid-flight at stop time — that's the snapshot, not a "killed early" artifact. Their final outcomes would shift realized PnL meaningfully but don't affect the win-rate-on-finished metric.
2. 26 finished positions is real sample (vs R7's 1) but at N=26 the 95% CI on win rate is still wide (~12%-46%). Treat as directional, not surgical.

**Learning:** Threshold 60 is too lenient. The 4× lift in buy density from R7→R8 came overwhelmingly from tokens that turned into stop-losses. **Recommend: stay at threshold 70 for R9-R11 unless a future experiment shows otherwise.** Also confirms two infrastructure bottlenecks at higher buy volume: the analyzer busy gate and the position cap. Both are now bumped (concurrency 6, position cap 50) ready for sustained R10.

---

## Run R9 — *planned* — all-in TP mode (single exit at 2× / 3× / 5×)
**Date:** _pending_
**Code state:** R8 + a new env knob (not built yet).
**Config:** OpenAI `gpt-5-nano`, winning threshold from R7-R8, pump source. New env: `EXIT_MODE=tiered|all-in` and `EXIT_AT_MULT` for the all-in target.
**Duration:** 30 min × 3 (one each at 2×, 3×, 5× all-in target) — keep one config per run for clean comparison.
**Goal:** Settle the strategy debate from `miper-spec.md`: is "compound small profits, exit fully at 2×" actually better than the current tiered 40/30/30? Tiered wins when there's a long-tail outlier (R3's 27× wouldn't have been captured by a 5× exit). All-in 2× wins when most positions don't reach 3×+ before reversing. Empirical question — only data answers.
**Implementation note for when we build this:** the simplest shape is a config-time switch in `executeTakeProfit` — when `EXIT_MODE=all-in`, the level matching `EXIT_AT_MULT` sells 100% and other levels are no-ops. ~20 lines of code, mostly tests.

---

## Run R10 — *planned* — sustained 4h run at the winning config
**Date:** _pending_
**Code state:** post-R9.
**Config:** Best of R7-R9, pump source.
**Duration:** **4 hours**.
**Goal:** First run with statistical power. 30-min runs produce 5-10 closed positions; variance on N=10 is too high to draw real conclusions. A 4h run should produce ~30-60 closed positions, giving real win-rate confidence intervals. After this, the cost of being wrong about config is much lower.
**Cost estimate:** ~$0.16 OpenAI + RPC traffic. Trivial.

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
