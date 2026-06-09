# Discovery scanner (`--source discovery`)

Reverse-engineer a set of highly successful sniper wallets, then detect the
same opportunities ourselves in real time. **Not** copy-trading: the target
wallets buy in the launch block and exit within seconds — `vet-wallet.ts`
proved that class of wallet is structurally uncopyable at our poll+land
latency (we'd be buying their exit). Instead we learn *what they buy* and run
our own detector for it. The wallet is the teacher, not the trigger.

Three deliverables, in dependency order:

1. **Research harness** — `scripts/profile-wallets.ts`: given wallet
   addresses, reconstruct every entry's on-chain context and emit
   `research/wallet-profile.json` (full evidence) and a derived
   `research/discovery-profile.json` (scanner thresholds).
2. **Real-time scanner** — `src/discovery.ts`, wired as `--source discovery`:
   watches pump.fun launches, extracts the same features the research
   measured, scores 0–100 deterministically, pushes Telegram alerts, and
   (optionally, off by default) auto-buys through the existing trader/exit
   engine.
3. **Backtester** — `scripts/backtest-discovery.ts`: replays the *exact*
   scoring function over the research snapshots and reports, per threshold,
   how many of the target wallets' actual entries the scanner would have
   flagged (recall), weighted by the wallets' realized PnL.

The scoring function lives in `src/discoveryScore.ts` and is shared verbatim
by the scanner and the backtester, so a backtest result is a statement about
the production code path, not a reimplementation of it.

## Research phase — every question mapped to public chain data

Known behavior of the target wallets (stated up front, verified by the
harness): they buy the same tokens, often in the same block; they enter under
~$5–10k market cap; one-buy / one-sell; holds of seconds. All of the
following is reconstructable from any standard RPC (`getSignaturesForAddress`
+ `getParsedTransaction`), no indexer required:

| Question | Procedure |
|---|---|
| Trading history | Page the wallet's signatures, parse each tx with `extractLeaderTrade` (the same balance-diff parser the live listener uses), aggregate buys/sells per token into round-trips. |
| Entry timing / token age at entry | Anchor `getSignaturesForAddress(mint, {before: buySig})` at the buy. Early entries have few prior txs, so the page bottoms out at the mint's *creation* tx → exact `ageSec = buyTime − createTime` and `txsBeforeEntry`. |
| Market cap at entry | The buy tx itself: SOL delta / token delta = entry price/token; × 1B pump supply × SOL/USD at that date (CoinGecko daily history, cached; falls back to current price, flagged approximate). |
| Liquidity at entry | The bonding-curve PDA is derivable from the mint; its **post-balance inside the buy tx** is the curve's real SOL at the entry instant. |
| Holder count at entry / growth rate | Parse the pre-entry txs (they're few, by construction): distinct buyer fee-payers ≈ holders; divided by `ageSec` → buyers/min at entry. |
| Deployer history | Creation tx fee-payer (= pump `create` accounts[7]); `getSignaturesForAddress(creator, {before: createSig})` → prior tx count and wallet age **at launch time**, not today. |
| Funding wallet | Page the creator's history to its oldest tx; parse it for the incoming system transfer → funder address. Recurse one hop. Fresh disposable wallets (the interesting case) have tiny histories, so this is cheap exactly when it matters. |
| Launch platform | Program IDs present in the buy tx (pump.fun curve, PumpSwap, Raydium AMM/CPMM, Jupiter route) → where they actually trade. |
| Buy/sell behavior, sizing | Round-trip stats: one-buy-one-sell fraction, hold seconds (p25/50/75), buy size distribution, win rate, realized PnL. |
| What changed when performance improved | Each wallet's round-trips split into time halves + weekly buckets: PnL, win rate, median hold, median size, platform mix per bucket — regime changes show up as a step between buckets. |
| Recurring deployers / funders / patterns | Cross-token: creators and funders seen on ≥2 bought tokens; cross-wallet: tokens bought by ≥2 targets, same-slot co-buys, shared funder among the *targets themselves* (one-operator evidence). |

### The honesty clause — explainability

The harness computes, per entry, whether a *public, pre-entry* signal
existed: detectable holder surge, recurring deployer/funder, or another
target wallet already in. The aggregate "explainable fraction" is reported
prominently because it decides what the scanner can be:

- **Explainable entries** → the scanner can find these tokens *before/with*
  the wallets, from the same data.
- **Unexplainable entries** (same-block cluster buys on zero pre-entry
  activity) → the wallets act on private signal (shared operator, paid feed,
  or they *are* the bundler). No public-data scanner can front-run that; the
  honest detector is then the cluster's entry itself — which is exactly the
  `smartWalletBuys` feature. We detect them *acting*, at lower latency than
  copy-trading their fills, and ride the move they start.

## Scanner — features and scoring

`PumpListener` (existing) feeds every launch into a watchlist (cap
`DISCOVERY_WATCH_CAP`). Two feature classes:

**At t0 (one-shot):** dev buy SOL (create tx), creator history
(`fetchCreatorHistory`, cached), funder lookup (cheap for fresh wallets,
skipped for saturated ones), metadata quality, launch-slot bundle check
(existing `checkLaunchBundle`), mint/curve sanity (mayhem veto), and
deployer/funder reputation from two sources: the research profile's lists
and the scanner's own `wallet_intel` DB table, which compounds across runs.

**Sampled (every `DISCOVERY_SAMPLE_SEC` for `DISCOVERY_WINDOW_MIN`):** curve
state → price/mcap/liquidity trajectory; new signatures on the curve → tx
velocity (exact); a parsed sample of those txs → unique-buyer growth
(holder-growth proxy, lower bound), buyer diversity (distinct payers /
parsed txs — wash detector), sells seen, and **smart-wallet hits** (fee
payer ∈ the researched cluster).

Score = Σ weighted rules, clamped 0–100, with hard vetoes (mayhem, bundled
launch, mcap above band, dev dumped). Weights live in `src/discoveryScore.ts`;
thresholds come from `discovery-profile.json` so a re-run of the research
harness re-tunes the scanner without code changes. Every fired rule appends a
human-readable reason — the alert explains itself.

| Rule (illustrative defaults) | Points |
|---|---|
| Smart wallet bought (first / each additional) | +30 / +15 (cap +60) |
| Known-good deployer (profile list or intel wins) | +20 |
| Known-bad deployer (serial launcher, no winners) | −40 |
| Recurring funder match (good / bad) | +15 / −25 |
| Dev buy inside the profile band | +10 |
| Holder growth ≥ profile floor | +15 |
| Tx velocity ≥ profile floor | +10 |
| Buyer diversity below wash floor | −20 |
| Aged creator wallet / fresh disposable | +5 / −10 |
| Complete metadata (name+symbol+uri) | +5 |
| Bundled launch ≥ threshold buyers | veto |
| Mayhem mode / mcap above band | veto |

`score ≥ DISCOVERY_ALERT_SCORE` → one Telegram alert (mint, mcap, liquidity,
age, holders, score, reasons — tap-to-copy mint, chart link).
`score ≥ DISCOVERY_BUY_SCORE` *and* `DISCOVERY_AUTOBUY=true` → buy through
the existing `executeBuy` tail, inheriting the position monitor, stop-loss /
trailing / time exits, the consecutive-failure circuit breaker, Telegram
trade alerts, and `SIMULATE` paper mode. Auto-buy is **off by default**;
alert-only is the v1 operating mode.

After an alert the watcher keeps sampling to the window end and records the
post-alert peak multiple into `discovery_alerts` — live precision data with
zero extra cost, readable by the backtester's `--db` mode.

## Backtest

`scripts/backtest-discovery.ts` scores every research snapshot with the
production `scoreDiscovery` and sweeps thresholds (40/50/.../80):

- **Recall** — fraction of the wallets' entries that would have alerted.
- **Winner recall** — same, restricted to entries the wallet profited on
  (catching their losers is not a goal).
- **PnL-weighted recall** — recall weighted by the wallet's realized SOL on
  each token: did we catch the entries that paid?

Precision can't come from the wallets' picks (they're all positives); it
comes from running the scanner in alert-only mode and reading
`discovery_alerts` outcomes (`--db` mode prints alert→peak-multiple
distribution). Recall vs their history + precision from live paper running
together bound the strategy before any SOL moves.

## Risk controls (auto-buy phase)

All existing, inherited by wiring through `executeBuy`/`positions.ts`:
`BUY_AMOUNT_SOL` (position size), `MAX_SLIPPAGE_BPS`, dynamic priority fees
with floor/ceiling, `MAX_OPEN_POSITIONS`, stop-loss, trailing TP, time exit,
`MAX_CONSECUTIVE_BUY_FAILURES` breaker (exit code 2 = systemd stays down),
`MAX_RUN_HOURS`, `CLOSE_ON_SHUTDOWN`, Telegram alerts on every trade and
breaker trip. Kill switches: set `DISCOVERY_AUTOBUY=false` (scanner keeps
alerting, stops buying) or stop the unit; both are documented in RUNNING.md.

## Limitations, stated up front

- Holder counts during the watch are sampled lower bounds, not census counts
  (a census needs `getProgramAccounts` or an indexer — both out of budget).
- Historical USD market caps use daily SOL closes; intraday error ~±5%.
- The scanner watches pump.fun only in v1. The research harness *measures*
  platform mix; if the wallets trade elsewhere, that shows up in the report
  and the listener gets extended then — not speculatively.
- If research shows the wallets' edge is being the bundler (their buys ARE
  the launch-slot bundle), the scanner's smart-wallet feature still detects
  their entries, but expected value depends on how much of the move is left
  after them — that's exactly what alert-only precision measurement answers.
