# sol-sniper

Autonomous Solana memecoin sniping bot. Full spec: `sol-sniper-spec.md`.

## What it does

Listens for new Raydium AMM pools, runs on-chain safety checks, sends data to Claude for a 0-100 score, and auto-buys via Jupiter V6 when the score clears the threshold. Manages positions with tiered take-profit (2x/3x/5x) and a stop-loss. Starts in paper-trading mode (`SIMULATE=true`) by default.

## Layout

- `src/index.ts` — Commander CLI entry
- `src/config.ts` — typed env config + Solana program ID constants
- `src/logger.ts` — chalk-colorized logger
- `src/db.ts` — better-sqlite3 schema + queries
- `src/listener.ts` — Raydium pool discovery (WebSocket + polling fallback)
- `src/analyzer.ts` — safety checks, DexScreener market data, Claude scoring
- `src/trader.ts` — Jupiter V6 swap execution
- `src/positions.ts` — TP/SL monitoring loop

## Running

```
npm install
cp .env.example .env   # fill in WALLET_PRIVATE_KEY + ANTHROPIC_API_KEY
npm run simulate       # paper trading
```

Keep `SIMULATE=true` until the strategy is validated.

## Conventions

- Atomic commits. One logical change per commit. Subject starts with a capital, no `feat:` / `fix:` prefix, no trailers.
- Never commit `.env` or `sniper.db`.
- Every external call (RPC, Jupiter, DexScreener, Claude) must be try-caught. A single token failure must never crash the bot.
- Simulated trades still write to the DB with `simulated = 1` so PnL is observable in paper mode.
