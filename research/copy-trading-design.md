# Copy-trading strategy (`--source copytrade`)

Mirror the trades of a curated set of proven Solana wallets. The edge is
*borrowed* from the wallet, not manufactured by us — which is the point:
R-live-8 proved our own token-picking has no edge, so stop picking. A wallet
with a verified win record does the picking; we follow.

Not origin-scoped — copy-trading trades whatever the followed wallet trades,
any Solana token. The wallet is the signal.

## Pipeline

1. **Seed wallets** — a curated list of wallet addresses to follow (v1: a
   manual list in config; automated discovery is a later, separate project).
2. **Monitor** — watch each seed wallet's on-chain activity in near-real-time
   (Helius `logsSubscribe` per wallet, or `getSignaturesForAddress` polling).
3. **Detect a buy** — parse a wallet's transaction for a swap that *acquired*
   a token (SOL/USDC → token). Extract the token mint and the leader's size.
4. **Filter** — skip tokens we already hold, skip SOL/USDC/stables, skip buys
   below `COPYTRADE_MIN_LEADER_SOL` (a leader's dust isn't a conviction buy).
5. **Buy** — our fixed `BUY_AMOUNT_SOL` via the existing trader (Jupiter for
   AMM tokens, the pump bonding curve if the token is still bonding).
6. **Exit** — see open decision below.
7. **Manage** — the existing position/exit engine.

## New components

- `src/walletListener.ts` — monitors the seed wallets, emits buy events.
- `src/config.ts` — `Source` += `copytrade`; seed-wallet list; thresholds.
- `src/index.ts` — wire the `copytrade` source.
- buy / exit / persistence reused as-is.

## Resolved decisions

- **Wallet sourcing** — user pulls candidate addresses from Axiom Vision;
  `scripts/vet-wallet.ts` verifies each on-chain. CT-paper-1 seed wallets:
  clukz, Sebastian, Frost, Limfork.
- **Exit handling** — hybrid: mirror the leader's sell, with the stop-loss
  and `MAX_HOLD_MINUTES` time-exit as independent floors.

## v1.1 fixes (surfaced by CT-paper-1, now fixed)

- **Double-sell on a chunked leader exit.** A leader selling one token in
  chunks fired several concurrent `leaderSell` handlers, each running a full
  exit of the one position before any committed the close — so the position
  sold N times (CT-paper-1: D2fXH sold 3×, inflating paper PnL; live it would
  fire phantom sell txs). Fixed: exits route through `exitToken()`, deduped
  per mint with an `exitingMints` guard.
- **Orphaned-bag race.** A leader selling a token while our copy-buy was still
  in flight left us holding a bag with no exit signal. Fixed: such a sell is
  recorded in `pendingSells`; the position is exited the instant the copy-buy
  lands.
- **Misleading exit log label.** Leader-sell exits logged the `TP3` /
  "all-in exit … at 50x" text. Fixed: `executeAllInExit(.., leaderExit=true)`
  logs a `COPY-EXIT` label instead.

## Reused as-is

`trader.ts` (buy/sell), `positions.ts` (exit engine), `db.ts`, the listener
subscription plumbing. The new code is the wallet monitor plus wiring.

## Status

Worktree `miper-copytrading`, branch `copy-trading` off `dexscreener` (so it
inherits the live-run hardening, the Jupiter API fix and the Token-2022 fix).
