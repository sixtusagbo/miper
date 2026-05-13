# miper

Autonomous Solana memecoin sniping bot. Full spec: `miper-spec.md`. Operational playbook: `RUNNING.md`. Phase 2 plan (live pump trading): `PHASE-2.md`.

## What it does

Listens for new Raydium AMM pools or pump.fun launches, runs on-chain safety checks, sends data to an LLM (OpenAI or Anthropic) for a 0-100 relative score, and auto-buys when the score clears `MIN_AI_SCORE`. Manages positions with tiered take-profit (2x/3x/5x) and a stop-loss. Starts in paper-trading mode (`SIMULATE=true`) by default.

## Layout

- `src/index.ts` — Commander CLI entry; `--source raydium|pump` on every command
- `src/config.ts` — typed env config, Solana program IDs, AI model→provider inference
- `src/logger.ts` — chalk-colorized logger with optional file sink
- `src/db.ts` — better-sqlite3 schema + queries (positions, trades, rejections, PnL summary)
- `src/listener.ts` — generic LogListener + Raydium and pump.fun bindings
- `src/analyzer.ts` — on-chain safety, market data, LLM scoring (per-provider dispatch)
- `src/metadata.ts` — Metaplex token metadata PDA + decoder
- `src/creatorHistory.ts` — creator wallet activity lookup with TTL cache
- `src/bondingCurve.ts` — pump.fun bonding-curve account decoder + price helper
- `src/trader.ts` — Jupiter V6 swaps (Raydium) + synthetic pump paper trades
- `src/positions.ts` — TP/SL monitoring loop; per-source price oracle dispatch
- `src/review.ts` — PnL summary + live-readiness checklist
- `src/concurrency.ts` — InflightGate, withTimeout, retry helpers
- `tests/` — vitest mirror of `src/`; mocks all RPC/HTTP/SDK calls

## Token sources

| Source | Stream | Default DB | Default log | Live trading |
|---|---|---|---|---|
| `raydium` *(default)* | Raydium AMM pool inits | `./sniper.db` | none | Jupiter V6 |
| `pump` | pump.fun mint creates (Token-2022) | `./pump.db` | `./pump.log` | **paper-only (Phase 1)** |

Source selection: `--source` flag wins over `SOURCE` env, env wins over the `'raydium'` default. Explicit `--source` clears any stale `DB_PATH` / `LOG_FILE` shell exports so pump runs never silently land in the Raydium DB.

## AI provider

The model ID is the only knob: `AI_MODEL=gpt-5-nano` (default) → OpenAI; `AI_MODEL=claude-haiku-4-5` → Anthropic. Provider is inferred from the prefix (`gpt-` / `o1` / `o3` / `chatgpt-` → OpenAI; `claude-` → Anthropic). Only the inferred provider's API key needs to be present.

Defaults: `gpt-5-nano` is the cheapest model with structured-JSON output (~$0.0001/call at our prompt sizes — roughly 50× cheaper than Sonnet 4).

## Exit strategy

Two modes, controlled by `EXIT_MODE`:

- **`tiered`** *(default)* — sells the bag in three tranches at `TAKE_PROFIT_1/2/3` (default 2× / 3× / 5×) using the `SELL_PCT_TP1/2/3` weights (default 40 / 30 / 30). Captures long-tail outliers (a 27× run keeps the last 30% riding); pays the tax of holding the bag through drawdowns when most positions don't reach 5×.
- **`all-in`** — sells 100% at `EXIT_AT_MULT` (must be > 1, default 2). Tests the "compound small profits" thesis from `miper-spec.md` §1: frequent fast exits over rare large outliers. TP1/TP2/TP3 are ignored under this mode.

`STOP_LOSS` (default 0.4× entry) applies in both modes.

## Run-control knobs

- `MAX_RUN_HOURS=N` triggers a graceful shutdown after N wall-clock hours. `0` (default) disables — the bot runs until SIGINT.
- `CLOSE_ON_SHUTDOWN=true` makes the shutdown handler sell every open/partial position at last-known price before exiting. Default `false`. Flip on for live trading and bounded paper sessions.

Both compose: `MAX_RUN_HOURS=4 CLOSE_ON_SHUTDOWN=true` runs for 4h and ends with no open exposure.

## Running

```
npm install
cp .env.example .env   # fill in WALLET_PRIVATE_KEY + OPENAI_API_KEY (or ANTHROPIC_API_KEY)
npm run simulate       # Raydium paper trading
npm run simulate:pump  # pump.fun paper trading
npm run review:pump    # PnL summary against pump.db
npm test               # vitest run
```

Keep `SIMULATE=true` until the strategy is validated against the live-readiness gates in `npm run review`.

## Conventions

- **Atomic commits.** One logical change per commit. Subject starts with a capital, no `feat:` / `fix:` prefix, no Co-Authored-By trailers.
- Never commit `.env`, `*.db`, or `*.log` (all gitignored).
- Every external call (Solana RPC, Jupiter, DexScreener, Anthropic, OpenAI, Metaplex) must be try-caught. A single token failure must never crash the bot.
- Simulated trades still write to the DB with `simulated = 1` so PnL is observable in paper mode.
- Tests use vitest, mock every network/SDK call, and run against an in-memory or temp-file SQLite DB. `npm test` must stay green; `npx tsc --noEmit` must stay clean. No test should hit a real network.
- Per-source isolation: pump and Raydium runs use separate DBs and log files by default; they should never share state without an explicit override.
