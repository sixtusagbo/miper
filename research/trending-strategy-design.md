# Trending-token strategy (`--source trending`)

Automates the user's hand-proven DexScreener routine: trade graduated AMM
tokens that are trending with healthy liquidity, volume and market cap.

## Why this dodges the bonding-curve walls

- Graduated tokens sit in real AMM pools → deep liquidity → buys land at a
  sane slippage cap. No `6002` (the R-live-9/10/11 killer).
- They have already survived hours with real volume → none of the $2.4k
  dead-on-arrival duds that sank launch-snipe (R-live-8).
- There is a real chart, real volume and a real name to judge — and an LLM
  is genuinely good at the "do I like this token" call, unlike the
  launch-time stats it had no edge on.

## Data source: GeckoTerminal, not DexScreener

DexScreener's public API has no trending endpoint. GeckoTerminal's does:
`GET /api/v2/networks/solana/trending_pools?include=base_token` returns, per
pool: `reserve_in_usd` (liquidity), `volume_usd` {h1,h6,h24},
`market_cap_usd` / `fdv_usd`, `pool_created_at` (age),
`price_change_percentage`, and `transactions` {buys,sells,buyers,sellers}.
Free, no key, ~30 req/min — a 30–60s poll is well within budget.

## The filter (the user's manual criteria, all configurable)

- Liquidity ≥ `TRENDING_MIN_LIQUIDITY_USD` (~$10k), ≤ `TRENDING_MAX_LIQUIDITY_USD`
- Market cap ≥ `TRENDING_MIN_MCAP_USD` (~$22k)
- 24h volume ≥ `TRENDING_MIN_VOLUME_USD` (~$50k) — "VOL looks good"
- Pool age in [`TRENDING_MIN_AGE_MIN`, `TRENDING_MAX_AGE_HOURS`] — new but established
- Skip tokens already seen / already held

## Pipeline

1. `TrendingListener` polls GeckoTerminal every `TRENDING_POLL_SEC`, parses
   pools into `TrendingCandidate`s, applies the filter, emits the survivors.
2. The LLM scores the candidate on name/ticker appeal + the trading metrics
   (a new prompt — not the launch-stats gate that had no edge). Buy if the
   score clears `MIN_AI_SCORE`.
3. Buy via Jupiter (`trader.ts` already routes graduated tokens).
4. Manage with the existing position/exit engine; price oracle = Jupiter.

## Build steps

- [x] Worktree `miper-dexscreener` on branch `dexscreener`
- [ ] `src/trendingListener.ts` — GeckoTerminal poller + filter
- [ ] `src/config.ts` — `Source` += `trending`; config block; db/log defaults
- [ ] trending analyze path — LLM name/metrics score
- [ ] `src/index.ts` — wire the `trending` source
- [ ] tests — mock the GeckoTerminal HTTP call

## Reused as-is

`trader.ts` (Jupiter swaps), `positions.ts` (exit engine), `db.ts`, the
analyzer's per-provider LLM dispatch. The new code is the discovery layer
plus a new scoring prompt; buy/exit/persistence are untouched.
