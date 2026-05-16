# Memecoin Entry Signals: What Predicts a Runner vs. a Rug in the First Few Minutes

Research target: sharpening an automated pump.fun entry filter that currently buys on raw
price momentum alone (+40-150% in the first 3 minutes). The momentum trigger is *necessary
but not sufficient* — bundled rugs and pump-and-dump traps produce exactly that price shape
on purpose. The goal here is to find **observable, mechanically-grounded signals** that
separate organic demand from manufactured demand.

## Read this first: the honesty section

Most public "pump.fun strategy" content is worthless for a bot builder:

- **Survivorship bias is the dominant failure mode.** Medium "200x gem" guides reverse-engineer
  one winner and present its features as a recipe. The base rate kills this. Only ~0.9-1.4% of
  pump.fun tokens ever graduate the bonding curve, and roughly 98-99% of launches extract money
  from buyers ([CryptoSlate](https://cryptoslate.com/how-traders-make-over-60k-per-week-rugging-98-of-memecoins-on-pumpfun/),
  [AInvest](https://www.ainvest.com/news/solana-meme-coin-surge-high-velocity-opportunity-2026-2601/)).
  Any signal that "the 200x had" is also present in thousands of zeros. A signal is only
  useful if you can show it shifts the *conditional* probability, not that it appeared once.
- **Grift content sells tools, not edge.** Bundler repos, "sniper bot" landing pages, and
  KOL-call channels are selling you the product, or selling you *as* the product (you are the
  exit liquidity for the bundle). Treat anything from a vendor blog as a hypothesis, not a fact.
- **The one piece of genuine evidence** is the arxiv study below — and even it concludes the
  conditional probabilities, while real, sit close to or below the break-even line for naive
  buy-and-hold. That is the correct prior: these signals *filter out losers*, they do not
  *manufacture winners*. Use them to reduce adverse selection, not to expect alpha for free.
- **pump.fun's structural quirk that helps you:** the protocol holds the liquidity on the
  bonding curve. A creator cannot pull an LP the way they can on a raw Raydium pool. So a
  pre-graduation "rug" is really a *coordinated dump* — bundled wallets selling into your buy.
  That makes it detectable through trade timing and wallet concentration rather than an LP
  drain. (Post-graduation on PumpSwap/Raydium the classic LP risks return.)

Primary evidence base, in descending order of credibility:

1. **"Predicting the success of new crypto-tokens: the Pump.fun case"** — academic, empirical,
   655,770 tokens, conditional-probability methodology, no ML hand-waving.
   <https://arxiv.org/html/2602.14860v1>
2. **Sniper-cluster on-chain analysis** (Blocksec/Bitget reporting) — measured 15,000+ sniped
   tokens, 4,600+ sniper wallets, with a concrete heuristic for same-block funded snipers.
   <https://www.bitget.com/news/detail/12560604803448>
3. **Bundle-scanner tooling docs** (Trench Radar) — describes a real, reproducible slot-based
   detection method. <https://docs.trench.bot/bundle-tools/bundle-scanner-guide>
4. Everything else (vendor blogs, Medium) — directional hints only, flagged inline.

---

## The signals

For each: what it is, what it indicates, how a bot measures it on Solana, and a credibility note.

### 1. Buyer-velocity / trade-velocity to a liquidity threshold

**What it is.** How fast SOL flows into the bonding curve, measured as the *number of trades*
(or wallets, or wall-clock seconds) needed to reach a given vSOL / market-cap level. Not the
total raised — the *speed*.

**What it indicates.** This is the **single strongest evidence-based predictor** in the
literature. The arxiv study found that tokens reaching a given bonding-curve SOL threshold via
*fewer* trades had "substantially higher graduation probabilities," and that "rapid
accumulation of liquidity within the first few tens of transactions produces graduation
probabilities well above the baseline." Conversely, "prolonged accumulation through many small
transactions typically signals weak collective engagement and frequently precedes stagnation"
([arxiv](https://arxiv.org/html/2602.14860v1)). Liquidity velocity was named the most
informative single variable they tested.

Caveat on direction: velocity is necessary but a bundle *also* produces extreme velocity. Use
velocity as a positive gate **only in combination with the concentration checks below** —
fast inflow from many distinct, organic wallets is the runner profile; fast inflow from a
tight wallet cluster is the rug profile.

**How a bot measures it on Solana.**
- Subscribe to the pump.fun program via `logsSubscribe` / Yellowstone gRPC (the bot already
  has a `LogListener`). Parse each `buy`/`sell` instruction against the bonding-curve account.
- Decode the bonding-curve account (already done in `src/bondingCurve.ts`) to read
  `virtualSolReserves` / `realSolReserves` per slot.
- Metric: `trades_to_reach_X_SOL` and `seconds_to_reach_X_SOL`. Cheaper proxy that needs no
  threshold tuning: count buy instructions in the first 60-120s and the slope of vSOL over
  time.
- APIs that pre-compute this: Bitquery's Pump.fun bonding-curve / market-cap API and trade
  streams (GraphQL, WebSocket, Kafka, gRPC)
  ([Bitquery](https://docs.bitquery.io/docs/blockchain/Solana/Pumpfun/Pump-Fun-Marketcap-Bonding-Curve-API/)).

**Credibility: HIGH.** Backed by the only large-N empirical study; mechanically grounded
(it directly measures collective demand intensity).

---

### 2. Unique buyer count and buyer velocity (buyers/minute)

**What it is.** The count of *distinct* transaction-signer wallets that have bought, and the
rate at which that count grows. Distinct from trade count: 200 trades from 5 wallets is wash
volume; 200 trades from 180 wallets is a crowd.

**What it indicates.** Runner: unique-buyer count climbs steeply and *keeps climbing* — new
independent participants are arriving. Rug/DOA: unique buyers plateau fast (the only buyers
were the launch cluster) while trade count keeps moving (wash trading). The arxiv study's
"first-mover wallet diversity in the opening thirty seconds" finding maps directly onto this:
wallet *diversity*, not raw volume, was the early signal that tracked graduation. Vendor data
points the same way — graduating tokens are described as going "10 holders to 300+ in the
first hour" ([smithii](https://smithii.io/en/graduate-token-pump-fun/)).

**How a bot measures it on Solana.**
- From the same trade stream, maintain a `Set<signer>` of buyer wallets. Record
  `unique_buyers_at_T` snapshots at 30s / 60s / 120s / 180s.
- Buyer velocity = `d(unique_buyers)/dt`. The acceleration (second derivative) matters more
  than the level: a decelerating buyer count after a momentum spike is the classic
  pump-and-dump rollover.
- Divergence check: `trade_count / unique_buyers`. A high and rising ratio = wash trading by a
  few wallets. Bitquery exposes a buyers count by counting distinct `Transaction_Signers` on
  buy trades within a window ([Bitquery Pump.fun API](https://docs.bitquery.io/docs/blockchain/Solana/Pumpfun/Pump-Fun-API/)).

**Credibility: HIGH (count and velocity), MEDIUM on exact thresholds.** Wallet diversity is
in the academic study; the "300 holders/hour" numbers are vendor lore and survivorship-tinged
— use the *shape* (steep, sustained, accelerating) not the absolute number.

---

### 3. Holder concentration / top-holder %

**What it is.** Share of supply held by the top 1 / 5 / 10 wallets, and total holder count.

**What it indicates.** Rug: top holders control a huge fraction (creator + cluster can dump on
you). A widely used hard filter is **top 5 holders > 90% of supply → reject**
([Flintr](https://www.flintr.io/articles/anatomy-of-a-rug-pull-identify-scams-on-pumpfun)).
Note pump.fun's bonding curve itself holds the unsold supply, so you must exclude the curve
account and the pump.fun fee/program accounts before computing concentration — otherwise every
fresh token looks 100% concentrated. The real signal is concentration *among actual holder
wallets*. Sophisticated rugs split supply across many wallets to fake decentralization
(RugCheck flags large holders that share funding/behavior characteristics), so concentration
is necessary but defeatable — pair it with funding-cluster analysis (signal 5).

**How a bot measures it on Solana.**
- `getProgramAccounts` / `getTokenLargestAccounts` on the mint for the top token accounts,
  then resolve owners. Exclude the bonding-curve PDA, the associated pump.fun accounts, and
  known program addresses.
- Or use Bitquery's Solana Token Holders API (V2), which gives holder snapshots for newly
  launched tokens within the first 8 hours
  ([Bitquery Token Holders](https://docs.bitquery.io/docs/blockchain/Solana/solana-token-holders/)).
- Metrics: `top1_pct`, `top5_pct`, `top10_pct`, `holder_count`. Reject on `top5_pct > ~80-90%`
  after excluding curve/program accounts.

**Credibility: MEDIUM-HIGH as a rejection filter, LOW as a positive signal.** A clean
distribution does not predict a runner (it is cheap to fake by splitting wallets). But an ugly
distribution reliably predicts a dump. Use it asymmetrically: only to *veto*, never to *buy*.

---

### 4. Dev/creator wallet behaviour: supply held, dev sells

**What it is.** Fraction of supply the *creator* wallet holds, and whether the creator wallet
has sold.

**What it indicates.** Creators are explicitly advised to keep their dev buy "never above 5%
of total supply" because a visible larger holding signals dump risk
([PandaTool](https://help.pandatool.org/english/sol/createpump)). So **creator wallet
> ~5% of supply is a yellow-to-red flag**. A creator *sell* in the first minutes is close to a
hard red flag — the person with the most information is exiting. The arxiv study found prolific
creators had *slightly* better graduation odds at advanced curve stages, but "statistical
support remained limited" — so creator identity is weak signal at best.

**How a bot measures it on Solana.**
- The pump.fun `create` instruction identifies the creator. The bot already detects mint
  creates (`src/listener.ts`); capture the creator wallet there.
- Track the creator's token account: balance / total supply = `dev_supply_pct`. Watch for any
  `sell` instruction signed by the creator → set a `dev_sold` flag and veto.
- Creator history (the bot has `src/creatorHistory.ts`): count prior mints by this wallet and
  how many rugged. A wallet with dozens of prior launches that all died is the
  serial-rugger profile — between Jan-Apr 2025, twelve wallet clusters averaged ~320 launches
  each and drained ~82% of liquidity
  ([Adeolalasisi/Medium](https://medium.com/@adeolalasisi6/from-coffeecoin-to-mass-rug-pulls-exposing-pump-funs-dark-side-2fc685fb59d5)).

**Credibility: MEDIUM-HIGH for dev-sell veto and dev-supply cap, LOW for "good creator"
prediction.** Dev sell is mechanically unambiguous. The 5% cap is vendor convention but a
reasonable, cheap filter. "Prolific creator = good" is not supported — ignore it as a buy
signal; serial-rugger = bad *is* supported and worth a veto.

---

### 5. Bundled buys (multiple buys in launch tx / same block) + sniper clustering

**What it is.** Coordinated wallets buying in the launch transaction itself or within the same
slot (~400ms), usually funded from one "mother" wallet. Sniper clustering is the same shape
from same-block externally-funded wallets rather than the creator.

**What it indicates.** This is the **highest-value rug filter** because it directly measures
manufactured demand — and manufactured demand is precisely what produces the +40-150%/3min
price shape your momentum trigger keys on. Patterns:
- Bundles: "3+ wallets in the same slot holding larger amounts" is the warning threshold;
  the extreme cited case is "24 wallets bought within the same 0.4 seconds holding 76% of
  supply ... will go to 0 within minutes"
  ([Trench Radar](https://docs.trench.bot/bundle-tools/bundle-scanner-guide)).
- "60% of initial buys from a tight cluster of brand-new wallets funded with the exact same
  SOL amount from one mother wallet" and "top 10 wallets all connected to the dev wallet" are
  named rug signatures ([flashift](https://flashift.app/blog/how-to-spot-the-next-viral-meme-coin-on-pump-fun-safely/)).
- Snipers: in one measured month, 15,000+ tokens were sniped by directly-funded same-block
  wallets — 4,600+ sniper wallets, 10,400+ deployers, ~1.75% of total pump.fun supply
  ([Bitget](https://www.bitget.com/news/detail/12560604803448)). The arxiv study found markets
  "dominated by bot-like activity exhibited systematically lower graduation probabilities" —
  algorithmic flow correlates with fast exits, not commitment.

Important nuance: a *small* sniper presence is normal background noise on every launch. The
signal is **the fraction of supply held by the launch-block cluster and whether that cluster is
still holding**. Trench's own guidance: a "current held %" near zero is safe even if total
bundled % looked high (the bundle already exited — bad, but not your problem if you haven't
bought); a cluster *still holding* a large % is a loaded gun pointed at your buy.

**How a bot measures it on Solana.**
- Group the first N buy instructions by `slot`. Count distinct wallets per slot. Flag any slot
  (especially the launch slot) with ≥3 buyer wallets.
- For each clustered wallet, walk back one hop: `getSignaturesForAddress` → find the SOL
  transfer that funded it. If many cluster wallets were funded by the *same* source with
  *near-identical* amounts → bundle confirmed. (Trench's scanner deliberately skips funding-
  source analysis; doing the one-hop check yourself is strictly better.)
- Compute `bundle_supply_pct` = supply held by the clustered set, and track
  `bundle_current_held_pct` over the next slots. Veto while it stays high.
- Sniper-specific heuristic from the Bitget/Blocksec analysis: wallets that (a) received a SOL
  transfer shortly before launch and (b) bought in the launch block — these are the
  least-obfuscated, most-actionable malicious subset.

**Credibility: HIGH.** Mechanically grounded, reproducible from raw transaction data, and
backed by both the bundle-tooling docs and the measured sniper-cluster study. This is the
single best defense against the failure mode your current momentum-only filter is most
exposed to. The thresholds (3+ wallets/slot, ">~20-25% cluster supply") are conventions, so
tune against your own labelled data, but the *method* is sound.

---

### 6. Buy/sell ratio and transaction-volume shape

**What it is.** Ratio of buy to sell instructions / volume, and the *texture* of trades —
trade sizes, regularity, distinct sizes.

**What it indicates.** Runner: healthy buy pressure with *organic-looking* heterogeneous trade
sizes from many wallets, sells present but absorbed. DOA/wash: either near-zero sells then a
single cliff (bundle dumps all at once), or a metronome of identical tiny trades. Volume bots
"make very small trades of the same amount — buying and selling 0.01 SOL repeatedly"; fake
volume + high wallet concentration is described as the strongest combined rug indicator
([Flintr](https://www.flintr.io/articles/anatomy-of-a-rug-pull-identify-scams-on-pumpfun),
[Bitrue](https://www.bitrue.com/blog/avoid-rug-pulls-on-pumpfun)).

**How a bot measures it on Solana.**
- From the trade stream: rolling `buy_count / sell_count`, `buy_volume / sell_volume`.
- Volume-shape features: distinct trade-size count, coefficient of variation of trade sizes,
  fraction of trades within 1% of the modal size (high → wash bot). Pair with signal 2's
  `trade_count / unique_buyers`.
- Detect the "cliff": a single slot where sell volume spikes to a large multiple of trailing
  average → bundle exit in progress, abort/avoid.

**Credibility: MEDIUM.** The wash-trading texture (identical small trades) is a concrete,
reproducible heuristic. Raw buy/sell ratio alone is weak and easily gamed — a bundle keeps the
ratio buy-heavy right up until the dump. Useful mainly as a *texture* check and a real-time
abort trigger, less so as an entry gate.

---

### 7. Time-to-first-N-buyers

**What it is.** Wall-clock time from launch to the Nth distinct buyer (e.g. first 10, 25, 50).

**What it indicates.** A reframing of buyer velocity (signal 2) as a latency rather than a
rate — convenient because it is a single scalar available very early. Fast time-to-N organic
buyers = real attention. But fast time-to-N is *also* the bundle signature, so this metric is
**only meaningful conditioned on the buyers being distinct, non-clustered wallets**. Time-to-N
*organic* buyers is a decent runner signal; time-to-N total is nearly useless on its own.

**How a bot measures it on Solana.** Trivial once signals 2 and 5 exist: timestamp the buy that
crosses each N threshold, after excluding wallets flagged as bundle/sniper cluster members.

**Credibility: MEDIUM, and entirely derivative.** Don't implement it as a separate signal —
it falls out of signals 2 + 5 for free. Listed for completeness because traders talk about it.

---

### 8. Social signals — KOL mentions, Twitter/Telegram velocity

**What it is.** Influencer ("KOL") mentions and the rate of social-post / member growth.

**What it indicates.** Genuinely powerful for *price* — $WIF's run to a $1B cap was driven by
repeated mentions from the KOL Ansem; tokens trending on X often see 50-100% jumps within
hours ([AInvest](https://www.ainvest.com/news/solana-meme-coin-surge-high-velocity-opportunity-2026-2601/)).
But for a bot this is the worst signal on the list operationally.

**Why it's hard for a bot.** Not on-chain. Requires Twitter/X API (expensive, rate-limited,
adversarial), Telegram scraping (ToS-hostile, easy to spoof), and entity resolution to know
*which* account is a real KOL vs. a paid shill or a botted follower count. Latency is also
wrong — by the time a mention is measurable and parsed, on-chain buyer velocity has already
moved, so the on-chain signals front-run the social ones anyway. Worst of all it is the most
*manufactured* layer of the stack: paid KOL "calls" are a service sold to ruggers.

**How a bot could measure it (if it must).** Twitter/X API filtered stream on the token
ticker/contract address; weight by a curated allowlist of KOL account IDs with follower-quality
checks; track mention rate and unique-author count. Telegram member-growth velocity via Bot
API on known channels. All of this is high-effort, low-reliability.

**Credibility: LOW for an automated bot.** Real causal force on price, but unmeasurable
cleanly, laggy relative to on-chain data, and heavily gamed. Defer it. If anything, treat a
*sudden* social spike with no matching organic on-chain buyer diversity as a manufactured-hype
red flag rather than a green light.

---

## Ranked: highest-value additions to the momentum entry filter

The current filter buys on +40-150%/3min. That price shape is produced by **both** organic
runners and bundled rugs — the filter has an adverse-selection problem, not a sensitivity
problem. The best additions therefore *reject the manufactured version of the same shape*.

### #1 — Bundle / sniper-cluster detection (signal 5). Implement first.

This is the direct antidote to the current filter's biggest weakness. A bundled launch
manufactures exactly the +40-150% spike, then dumps on the momentum buyers. Detection is
mechanically grounded (group launch buys by slot, one-hop funding-source check), reproducible
from raw transaction data the bot already streams, and backed by both the Trench bundle-scanner
methodology and the measured 15,000-token sniper study. Concretely: veto if ≥3 buyer wallets
share the launch slot, or if a same-mother-wallet funded cluster *currently holds* more than
~20-25% of supply. Highest expected reduction in losing trades per unit of engineering effort.

### #2 — Buyer-velocity with wallet-diversity (signals 1 + 2 combined). Implement second.

This is the only signal pair with real academic backing: liquidity velocity was the single
most informative graduation predictor, and first-30s wallet *diversity* was the early signal
that tracked it ([arxiv](https://arxiv.org/html/2602.14860v1)). Combined they convert the
momentum trigger from "price went up" to "price went up *because many distinct wallets are
independently arriving and accelerating*." Implementation: require `unique_buyers` above a
floor and *still accelerating* at the entry moment, and require `trade_count / unique_buyers`
to stay low (no wash-trading divergence). This upgrades the momentum signal from a coincident
indicator to a demand-quality indicator and is the best *positive* gate available.

### #3 — Holder-concentration + dev-wallet veto (signals 3 + 4). Implement third, as a veto.

Cheap, asymmetric safety net. One `getTokenLargestAccounts` call plus owner resolution
(excluding the bonding-curve PDA) gives `top5_pct`; the creator wallet is already captured at
mint detection. Veto on `top5_pct` above ~80%, on creator holding >~5% of supply, on any dev
sell, and on a creator wallet with a history of dead launches. None of these predict a
*winner*, but each reliably flags a *loser*, and they cost almost nothing to compute. Use them
strictly as vetoes layered on top of #1 and #2.

**Deliberately deprioritised:** buy/sell ratio (signal 6) — keep only the wash-texture check
and a real-time dump-cliff abort, not as an entry gate. Time-to-first-N-buyers (signal 7) —
do not build separately; it falls out of #2 for free. Social signals (signal 8) — defer
indefinitely for an automated bot: real price force, but off-chain, laggy, gamed, and
expensive to measure honestly.

**Final caveat.** Even stacked perfectly, these signals shift a conditional probability that
the arxiv study found sits near break-even. They reduce adverse selection; they do not create
edge from nothing. Validate every threshold against the bot's own labelled outcomes (the
existing `rejections` and `trades` tables in `src/db.ts` are the right place to start) before
trusting any number quoted from a vendor blog above.

---

## Sources

- [Predicting the success of new crypto-tokens: the Pump.fun case (arxiv)](https://arxiv.org/html/2602.14860v1)
- [Bitget / Blocksec — Liquidity Sniping Bot: the Inside Job behind Pump.fun launches](https://www.bitget.com/news/detail/12560604803448)
- [Trench Radar — Bundle Scanner Guide](https://docs.trench.bot/bundle-tools/bundle-scanner-guide)
- [Flintr — Anatomy of a rug pull: identify scams on Pump.fun](https://www.flintr.io/articles/anatomy-of-a-rug-pull-identify-scams-on-pumpfun)
- [CryptoSlate — How traders make $60k/week rugging 98% of pump.fun memecoins](https://cryptoslate.com/how-traders-make-over-60k-per-week-rugging-98-of-memecoins-on-pumpfun/)
- [Bitquery — Pump.fun API (new tokens, trades, buyers)](https://docs.bitquery.io/docs/blockchain/Solana/Pumpfun/Pump-Fun-API/)
- [Bitquery — Pump.fun Market Cap & Bonding Curve API](https://docs.bitquery.io/docs/blockchain/Solana/Pumpfun/Pump-Fun-Marketcap-Bonding-Curve-API/)
- [Bitquery — Solana Token Holders API](https://docs.bitquery.io/docs/blockchain/Solana/solana-token-holders/)
- [Flashift — How to spot viral meme coins on Pump.fun safely](https://flashift.app/blog/how-to-spot-the-next-viral-meme-coin-on-pump-fun-safely/)
- [PandaTool — Launch tokens on Pump.fun and bundle buys guide](https://help.pandatool.org/english/sol/createpump)
- [Adeolalasisi / Medium — Exposing Pump.fun's mass rug pulls](https://medium.com/@adeolalasisi6/from-coffeecoin-to-mass-rug-pulls-exposing-pump-funs-dark-side-2fc685fb59d5)
- [Smithii — Graduate token on Pump.fun](https://smithii.io/en/graduate-token-pump-fun/)
- [Bitrue — How to avoid rug pulls on Pump.fun in 2026](https://www.bitrue.com/blog/avoid-rug-pulls-on-pumpfun)
- [AInvest — The Solana meme coin surge: a high-velocity opportunity](https://www.ainvest.com/news/solana-meme-coin-surge-high-velocity-opportunity-2026-2601/)
