# Launch-Snipe Selection Signals: What miper Is Missing

Research target: miper's launch-snipe gate (runs `R-live-8`, `R-live-13`) picks pump.fun
tokens **at the base rate** — nearly every pick stays dead-flat at the bonding-curve floor
(~$2-4k cap). The current signals carry no predictive power.

This document covers **signals miper does NOT currently use**. It deliberately does *not*
re-derive the post-launch flow signals (buyer velocity, unique-buyer count, bundle/sniper
clustering, holder concentration) already detailed in `research/memecoin-entry-signals.md` —
read that first. The one structural note carried over: **miper has no `bundleCheck.ts`**
despite the CLAUDE.md claim — bundle detection is *unimplemented*. So "bundle detection" is
both a gap in this doc's scope and a lie in the project's own docs.

---

## The core diagnosis

miper's gate evaluates a pump.fun token using **only data observable in the create
transaction itself**: creator wallet tx-count/age, dev SOL deposit, metadata strings, mint
vanity. It then asks an LLM to score 0-100 and buys at >= 70.

Every one of those inputs is either (a) **structurally identical across ~all launches** (so it
carries zero differentiating signal — the prompt even admits this), or (b) **trivially gamed**
by the deployer for a few cents of compute. The result is mathematically forced to be the base
rate. An LLM cannot manufacture signal that is not in its inputs; it is laundering noise into a
confident-sounding number.

The fix is not a better prompt. It is **better inputs**. There are exactly two families of
genuinely-informative inputs miper is not reading:

1. **Provenance** — where the creator wallet's SOL came from, and what this creator's *prior
   launches actually did* (not how many txs the wallet has). This is computable at launch
   time, before any buyers arrive.
2. **Post-launch flow in a short observation window** — who is buying in the first 15-60s and
   whether they are organic/clustered/reputable. This requires *waiting* a few seconds and
   watching trades. Covered in the other doc; the gap here is that miper currently decides at
   t=0 and never opens an observation window at all.

The single most important architectural change: **miper must stop deciding at t=0.** A
launch-time-only gate on pump.fun is structurally incapable of beating the base rate, because
at t=0 a runner and a dud are nearly indistinguishable — the information that separates them
*does not exist yet*. The bot needs a short post-launch observation window (a few seconds to
~60s) before committing capital. This trades a little entry price for actual signal, and it is
the prerequisite for almost every signal below being useful.

---

## Ranked shortlist — new signals miper should add

Ranked by `(expected edge) x (cheapness/speed) / (gameability)`.

| # | Signal | Type | When computable | Difficulty | Genuine edge? |
|---|--------|------|-----------------|------------|---------------|
| 1 | Creator prior-launch **outcomes** (not tx count) | Veto + score | t=0, ~1-3 RPC calls | Medium | **Yes** — strong rug veto |
| 2 | Post-launch observation window (organic buyer diversity in first 15-60s) | Positive gate | t+15..60s | Medium-High | **Yes** — the only real positive signal |
| 3 | Creator wallet **funding-source provenance** | Veto + score | t=0, 1-2 RPC calls | Medium | Partial — good veto, gameable |
| 4 | Dev-buy + co-buyer **supply concentration** at launch slot | Veto | t=0..t+1 slot | Medium | **Yes** — direct dump-risk veto |
| 5 | Metadata **image/social provenance** (real, reused, or absent) | Score nudge | t=0, 1-3 HTTP calls | Medium | Weak-Medium — minor edge |

If only one thing is built: **#1**. If two: **#1 + #2**. #2 is the only one that can
*positively* identify a runner; the rest mostly filter losers.

---

## Detailed signal analysis

### 1. Creator prior-launch OUTCOMES (not tx count)

**What it is.** miper's `creatorHistory.ts` counts the creator wallet's recent signatures and
estimates wallet age. That is the wrong question. The question that predicts a dud/rug is:
**what happened to the tokens this wallet launched before?** A wallet that has deployed 40
pump.fun tokens that all flat-lined at $3k is a serial launcher — its 41st token is
overwhelmingly likely to do the same. Conversely a wallet whose prior launches actually
*traded* (reached $30k+, or graduated) is a different population.

The serial-launcher base rate is brutal and well-documented: across 138,885 tokens from the
seven most prolific deployer wallets, only 729 graduated — a **0.52% success rate**, *below*
the platform average ([CoinMarketCap / Arkham coverage](https://coinmarketcap.com/academy/article/pumpfun-controls-95percent-of-token-graduation-market), [Medium/Arkham analysis](https://medium.com/@porwalabhay830301/pump-fun-deployers-exposed-arkham-analytics-reveals-3-8m-profit-pattern-7540d37cc181)).
The Arkham analysis found elite deployers run **clusters of 6-10 tokens at uniform 12-23s
intervals** — a fingerprint that is itself detectable. Twelve wallet clusters between Jan-Apr
2025 averaged ~320 launches each (cited in the sister doc). **A creator who launches tokens in
rapid batches is the dominant dud signature, and miper currently cannot see it.**

**Why it predicts.** Asymmetric. A bad track record reliably predicts a bad token (the
deployer is running a volume business; your token is inventory). A good track record is weaker
but real — it at least removes the wallet from the serial-launcher population. Note the arxiv
study found "prolific creator = good" had *limited* statistical support, so use prior-launch
*outcomes* (did the coins trade) not prior-launch *count* as the positive read.

**How to compute at launch time.**
- The pump.fun `create` instruction stores a `creator` field; the bonding-curve account also
  carries the creator. miper already captures `pool.creator`.
- pump.fun derives the bonding curve and mint PDAs deterministically per creator+token. To
  find prior mints by a creator: query an indexer. Cheapest options:
  - **Bitquery Pump.fun API** — GraphQL query `instructions` filtered by `Instruction.Program`
    = pump.fun, method `create`, `Transaction.Signer` = creator wallet. Returns every prior
    mint by that wallet with timestamps. One HTTP call. Then a second query for each prior
    mint's peak market cap / graduation flag, or batch it.
    ([Bitquery PumpFun docs](https://docs.bitquery.io/docs/blockchain/Solana/PumpFun/))
  - **Moralis / Shyft / Helius** enriched APIs expose "tokens created by wallet" similarly.
  - Pure-RPC fallback: `getSignaturesForAddress(creator)` (miper already does this) then
    filter to txs touching the pump.fun program with the `create` discriminator. miper
    *already fetches the signatures* — it just throws away the per-signature detail. Decoding
    which of those are `create` calls is cheap; getting the *outcome* of each prior mint needs
    one `getAccountInfo` on each prior bonding curve to read `realSolReserves` / complete flag.
- **Derived metrics to feed the model (or hard-gate):**
  - `prior_launch_count` — total pump.fun creates by this wallet.
  - `prior_launches_last_24h` — batch-launcher detector. >3 in 24h is a strong dud signal.
  - `min_inter_launch_seconds` — Arkham's 12-23s uniform-interval fingerprint. Tight uniform
    spacing = automated volume operation.
  - `prior_graduation_rate` and `prior_max_mcap_median` — did this wallet's coins ever trade?
  - **Hard veto candidate:** `prior_launches_last_24h >= 4` OR (`prior_launch_count >= 10` AND
    `prior_graduation_rate == 0`).

**Difficulty.** Medium. The Bitquery route is one or two extra HTTP calls and a schema; the
pure-RPC route reuses signatures miper already pulls but needs `create`-discriminator decoding
and N curve reads. Both fit in the existing parallel `buildPumpContext` fan-out. Add a TTL
cache keyed by creator (the wallet recurs across its own batch of launches — high cache hit
rate, which also makes the batch-launcher visible for free).

**Caveats / gameability.** Gameable but **expensively**: evading it requires a *fresh wallet
per launch*, which then has no history at all — and "brand-new wallet, zero pump.fun history,
funded minutes ago" is itself signal #3's red flag. The deployer cannot simultaneously have a
clean track record *and* a fresh wallet. That bind is what makes this signal robust. The
honest limit: a fresh-wallet rugger evades the *outcome* lookup, so #1 must be paired with #3
(funding provenance) to cover that escape hatch. Genuine edge as a **veto**; weak as a buy
signal.

---

### 2. Post-launch observation window — organic buyer diversity in the first 15-60s

**What it is.** Instead of deciding at t=0, miper waits a short, fixed window (e.g. 15s, 30s,
or up to 60s) and watches who buys. The decision input becomes the *shape of early demand*,
not the static launch facts.

**Why it predicts — and why it is the only true positive signal.** This is the headline
finding of the only large-N academic study on pump.fun (655,770 tokens): **liquidity velocity
and first-30s buyer wallet diversity were the most informative graduation predictors**
([arxiv 2602.14860](https://arxiv.org/html/2602.14860v1)). Vendor "graduation gap" coverage
echoes it: the pattern that separates the ~1% that graduate "begins in the first three
minutes" and they reach $69k "within 30 minutes" ([VoluTools / openPR](https://www.openpr.com/news/4455934/the-pump-fun-graduation-gap-what-the-1-of-solana-tokens-that)).
At t=0 a runner and a dud are indistinguishable; by t+30s a runner has *many distinct
independent wallets arriving and accelerating*, and a dud has silence or a tight cluster.
**This is the information that does not exist at t=0** — which is precisely why miper's
t=0-only gate is stuck at the base rate.

**How to compute.** miper already has a `LogListener` on the pump.fun program.
- On a new mint, instead of analyzing-then-buying immediately, start a per-token watcher: keep
  subscribed and collect `buy`/`sell` instructions on that bonding curve for the window.
- Maintain `Set<signer>` of distinct buyers; record `unique_buyers`, `trade_count`,
  `vSOL_in`, and the slope/acceleration of `unique_buyers` over the window.
- Decision metrics at window close:
  - `unique_buyers >= floor` AND still accelerating (2nd derivative > 0).
  - `trade_count / unique_buyers` low (high ratio = wash trading by few wallets).
  - `vSOL` gained above a floor (liquidity velocity).
  - exclude wallets flagged as launch-slot cluster members (signal #4) before counting.
- This *subsumes* "time-to-first-N-buyers" — don't build that separately.

**Difficulty.** Medium-High — not because the metrics are hard (they aren't) but because it
requires an **architectural change**: per-token stateful watchers, a decision deferred by
N seconds, and accepting a worse entry price. miper's pipeline is currently
analyze-once-then-buy. This is the biggest build on the list and the most worthwhile.

**Caveats / gameability.** Buyer *count* and *velocity* are gameable by a bundler spinning up
many wallets — which is exactly why the window metric must be **conditioned on wallet
diversity / non-clustering** (signals #4 and the bundle work). Fast inflow from many distinct,
*independently-funded* wallets is the runner profile; fast inflow from a same-mother-funded
cluster is the rug profile. The window also has a real cost: you miss the absolute-first-tick
entry and pay slot-2+ pricing (~20-60% worse than slot-0 per sniper-bot docs). That cost is
worth paying — buying at t=0 with no signal *is* the current losing strategy.

---

### 3. Creator wallet funding-source provenance

**What it is.** Walk back one hop from the creator wallet: which address sent it the SOL it
used to launch, how long ago, and what *kind* of address is it — a known CEX hot wallet, a
known bundler/disperser, another fresh wallet, or an aged personal wallet?

**Why it predicts.**
- **Fresh wallet funded minutes before launch from another fresh/disperser wallet** = the
  classic disposable rug-launcher setup. On-chain investigations of coordinated pump.fun abuse
  describe exactly this: SOL withdrawn from an exchange, "distributed evenly to 500 wallets,"
  each contributing identical amounts ([Blockworks](https://blockworks.co/news/pump-fun-ico-coordinated-wallet)).
  Identical-amount funding from one source is a bundler fingerprint.
- **Funded directly from a major CEX withdrawal** (Coinbase/Binance/Kraken hot wallet) is
  *mildly* reassuring — a KYC'd human funded this, not an automated disperser. Weak positive.
- **Funded from an aged wallet with its own long history** is neutral-to-positive.

This is information miper's `creatorHistory.ts` completely ignores — it looks at the creator
wallet's *own* activity but never at *where its money came from*.

**How to compute at launch time.**
- `getSignaturesForAddress(creator)` (miper already calls this) → find the earliest
  inbound SOL transfer, or the funding tx just before the launch.
- `getTransaction` on that funding tx → extract the funder address and amount.
- Classify the funder against a static allowlist of known CEX hot wallets (publicly
  maintained; Solscan/Arkham label them) and known bundler/disperser program addresses.
- Derived metrics: `funder_is_cex` (bool), `funder_is_fresh_wallet` (bool),
  `creator_funded_seconds_before_launch`, `funding_amount`, and — if reused across the same
  creator's batch — `same_funder_fanout` (one funder → many launch wallets = bundler).

**Difficulty.** Medium. One or two extra RPC calls (`getTransaction` is the heavier one).
The CEX-hot-wallet allowlist is a static JSON file to maintain. Fits the existing parallel
fan-out.

**Caveats / gameability.** Gameable: a sophisticated operator routes funding through several
hops or through a CEX to fake a "KYC'd human" provenance. So `funder_is_cex` is a *weak*
positive — do not over-weight it. The robust part is the **negative**: fresh-wallet →
fresh-wallet funding chains and identical-amount fan-outs are cheap to detect and the operator
pays real cost (more wallets, more hops) to obfuscate them. Use mainly as a veto, layered with
signal #1 to close the fresh-wallet escape hatch.

---

### 4. Dev-buy + co-buyer supply concentration at the launch slot

**What it is.** miper reads the dev's initial SOL *deposit* but not what fraction of *supply*
that buy plus any same-transaction / same-slot co-buys actually captured. The number that
predicts a dump is: **what % of total supply is held by the launch cluster (dev + bundle)
right after the launch slot.**

**Why it predicts.** Standard creator guidance is to keep the dev buy **under ~5% of supply**;
a visible larger holding is a known dump-risk flag, and "top 10 wallets all connected to the
dev" is a named rug signature ([flashift](https://flashift.app/blog/how-to-spot-the-next-viral-meme-coin-on-pump-fun-safely/),
sniper-bot configs cap `max_dev_buy` / max-allocation explicitly). The extreme cited case: 24
wallets buying within 0.4s holding 76% of supply → goes to zero in minutes (Trench Radar, in
the sister doc). If the launch cluster holds most of the float, every later buyer — including
miper — is exit liquidity.

**How to compute.** Right after launch, decode the bonding curve (miper has
`bondingCurve.ts`) for tokens-sold, and resolve the largest token accounts excluding the
curve PDA / pump.fun program accounts. Group the launch-slot buys; sum supply held by the
dev + same-slot buyers. Metric: `launch_cluster_supply_pct`. Hard veto above ~20-25%. This
overlaps the (unimplemented) bundle work — building #4 *is* building the core of bundle
detection.

**Difficulty.** Medium. `getTokenLargestAccounts` on Token-2022 currently throws for miper
(noted in `analyzer.ts`); use `getProgramAccounts` on the mint or an indexer (Bitquery's
holders API) instead. One slot of delay.

**Caveats.** Defeatable by splitting the cluster across many wallets to fake decentralization
— which is why this must pair with funding-cluster analysis (#3) and the bundle one-hop
funding check. Strong as a **veto**, useless as a buy signal: a clean cap table does not make
a runner, it just removes one way to lose.

---

### 5. Metadata image / social provenance

**What it is.** miper reads the metadata *strings* (name/symbol/URI present or missing) but
never **fetches the URI** or inspects the image and social links. Real signal candidates:
- Does the off-chain metadata JSON actually resolve, and does it contain a real image?
- Is the image a **reused/recycled image** from a prior token (especially a prior dead one by
  the same creator, or a copy of a current trending coin)?
- Do the Twitter/Telegram/website links exist, resolve, and look real vs. placeholder?

**Why it (weakly) predicts.** Effort is a faint proxy for intent — a creator who made a real
image and set up real socials has spent more than the 12-23s-per-token batch launcher. Reused
imagery is a known scam tactic: copying a trending coin's image to ride its searchability, or
recycling the same asset across a serial launcher's inventory ([webopedia](https://www.webopedia.com/crypto/learn/pump-fun-scam-tactics/),
[Bitget academy](https://www.bitget.com/academy/pump-fun-scam-guide)). An image hash that
matches one of the same creator's prior dead tokens is a near-certain dud.

**How to compute.** Fetch the metadata URI JSON (1 HTTP call), then the image (1 more).
Hash the image bytes (perceptual hash ideally, exact SHA as a cheap start). Compare against a
rolling store of recently-seen image hashes — especially this creator's prior launches (free
once signal #1 enumerates them). Check social URLs resolve (HEAD request); optionally check
the Twitter handle isn't brand-new (off-chain, expensive — defer).

**Difficulty.** Medium. HTTP fetches + a hash store. The latency (fetching IPFS-hosted JSON
and an image) is the real cost — must run with a tight timeout and not block the decision;
treat a slow/failed fetch as neutral, not as a veto.

**Caveats / gameability.** The weakest signal here. Effort is cheap to fake — a competent
rugger uses a unique AI-generated image and a freshly-made Twitter every time. **Reused-image
detection is the only part with real teeth**, and only against lazy/batch operators (who are,
admittedly, the bulk of the dud population). Treat as a minor score nudge and a
reused-image veto; never a primary gate. Heavy social verification is correctly deferred — it
is off-chain, laggy, gamed, and expensive (consistent with the sister doc's verdict on social
signals).

---

## What to explicitly NOT build

- **Comment / chat velocity on pump.fun.** Entirely botted. There are numerous open-source
  pump.fun comment bots ("thread mode," "shill mode") that manufacture exactly the
  conversation-looking activity a naive signal would reward
  ([example](https://github.com/cicere/pumpfun-comment-bot)). Negative or zero edge; skip.
- **KOL / Twitter-mention signals.** Off-chain, laggy, adversarial, and the most *manufactured*
  layer of the stack (paid calls are a service sold to ruggers). Sister doc's verdict stands.
- **A "better LLM prompt" with the same inputs.** The problem is input quality, not the model.
  Once signals #1-#5 exist, the LLM becomes a reasonable *aggregator* of real features — but
  hard numeric vetoes (batch-launcher count, cluster supply %, fresh-wallet funding) should be
  enforced in code *before* the LLM, not delegated to it. The model should never be able to
  override a mechanical rug fingerprint with optimism.
- **Mint vanity ("ends in pump").** Already in the prompt; near-worthless. Vanity grinding is
  cheap and now near-universal. No edge.

---

## Honest bottom line

Stacked perfectly, these signals **reduce adverse selection** — they filter out a large share
of the guaranteed losers. They do **not** manufacture edge. The arxiv study's own conclusion
is that even the genuine conditional probabilities sit close to the break-even line for naive
buy-and-hold. miper picking at the base rate today is consistent with that: the current gate
filters nothing real.

The realistic outcome of building #1-#4 is **not** "the bot now finds runners." It is "the bot
stops buying the ~80-90% of launches that are mechanically identifiable duds/rugs, and its
picks concentrate into the population where the post-launch observation window (#2) actually
has a chance to find the rare runner." Signal #2 is the only one that can say *yes*; the rest
say *no faster and more accurately*. That combination — aggressive mechanical vetoes plus a
deferred decision on real demand shape — is the only configuration with a structural reason to
beat the base rate.

Validate every threshold against miper's own `rejections` / `trades` tables (`src/db.ts`)
before trusting any number quoted from a vendor blog here.

---

## Sources

- [Predicting the success of new crypto-tokens: the Pump.fun case (arxiv 2602.14860)](https://arxiv.org/html/2602.14860v1)
- [Arkham deployer analysis — pump.fun deployers' $3.8M profit pattern (Medium)](https://medium.com/@porwalabhay830301/pump-fun-deployers-exposed-arkham-analytics-reveals-3-8m-profit-pattern-7540d37cc181)
- [CoinMarketCap — pump.fun controls 95% of token graduation market (0.52% prolific-wallet success rate)](https://coinmarketcap.com/academy/article/pumpfun-controls-95percent-of-token-graduation-market)
- [VoluTools / openPR — the pump.fun graduation gap: the 1% and their first 3 minutes](https://www.openpr.com/news/4455934/the-pump-fun-graduation-gap-what-the-1-of-solana-tokens-that)
- [Blockworks — pump.fun ICO flooded by coordinated wallet participation (identical-amount funding)](https://blockworks.co/news/pump-fun-ico-coordinated-wallet)
- [Bitquery — PumpFun API docs (creator/instruction/holder queries)](https://docs.bitquery.io/docs/blockchain/Solana/PumpFun/)
- [Bitquery — Pump.fun first 100 buyers / top traders examples](https://docs.bitquery.io/docs/examples/Solana/Pump-Fun-API/)
- [flashift — How to spot viral meme coins on pump.fun safely (dev-supply / cluster signatures)](https://flashift.app/blog/how-to-spot-the-next-viral-meme-coin-on-pump-fun-safely/)
- [Webopedia — 5 pump.fun scam tactics (reused metadata/imagery)](https://www.webopedia.com/crypto/learn/pump-fun-scam-tactics/)
- [Bitget Academy — pump.fun scam guide](https://www.bitget.com/academy/pump-fun-scam-guide)
- [cicere/pumpfun-comment-bot — open-source comment bot (why comment velocity is botted)](https://github.com/cicere/pumpfun-comment-bot)
</content>
</invoke>
