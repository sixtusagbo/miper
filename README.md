# miper

Autonomous Solana memecoin sniping bot. Listens for new launches, runs on-chain safety checks, asks Claude for a 0-100 score, and auto-buys via Jupiter V6 when the score clears the threshold. Manages positions with tiered take-profit (2x/3x/5x by default) and a stop-loss.

**Starts in simulation mode by default.** No real transactions are sent until you flip `SIMULATE=false`. For the operational playbook (how long to run, peak hours, going-live checklist), see [RUNNING.md](./RUNNING.md).

---

## Token sources

miper supports two launch streams, selected at the command line or via env. Each source uses its own DB and log file so their histories never mix.

| Source | Program | Default DB | Default log | Live trading |
|---|---|---|---|---|
| `raydium` *(default)* | Raydium AMM | `./sniper.db` | none | Jupiter V6 |
| `pump` | pump.fun (Token-2022 / SPL) | `./pump.db` | `./pump.log` | Direct bonding-curve instruction; falls back to Jupiter once a curve graduates |

**Why two sources?** Raydium AMM inits are rare (often only a handful per hour during off-peak). Pump.fun creates hundreds of mints per hour, which is great for signal density but comes with different mechanics: Token-2022 (or legacy SPL) mints, bonding-curve pricing, and tokens not yet on DexScreener. Live pump trades go through the pump.fun program directly while the bonding curve is active, then fall back to Jupiter once a curve graduates and the token moves to PumpSwap.

### Source precedence

```
  --source raydium|pump       (wins if passed)
  SOURCE=raydium|pump          (falls back from env)
  raydium                      (final default)
```

Explicit `--source` also clears any stale `DB_PATH` / `LOG_FILE` from your shell so pump sessions never silently land in the Raydium DB.

---

## Setup

```bash
npm install
cp .env.example .env            # fill in ANTHROPIC_API_KEY, WALLET_PRIVATE_KEY, SOLANA_RPC_URL
npm run build                   # optional; ts-node is used by all npm scripts
```

### Required env

| Var | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | From https://console.anthropic.com |
| `WALLET_PRIVATE_KEY` | Base58-encoded Solana private key (required for live mode; optional in simulation — an ephemeral key is generated if missing) |
| `SOLANA_RPC_URL` / `SOLANA_WS_URL` | Dedicated RPC. The public `api.mainnet-beta.solana.com` endpoint will 429 on almost every call. Helius free tier (1M credits/month, 10 req/s) is enough for paper trading. |

miper caps concurrent analyses at 6 and each makes ~3 RPC calls, so it stays comfortably under the 10 req/s ceiling.

### Optional env

Strategy knobs (all have defaults — see `.env.example`):

| Var | What it does |
|---|---|
| `BUY_AMOUNT_SOL` | SOL spent per snipe. Default `0.05`. |
| `EXIT_MODE` | `tiered` (default) sells in three tranches at TP1/TP2/TP3 — the original "compound profits" ladder. `all-in` sells the entire bag at `EXIT_AT_MULT` and ignores TP1/TP2/TP3. |
| `EXIT_AT_MULT` | Multiplier at which `all-in` mode fully exits. Must be > 1. Ignored in tiered mode. Default `2`. |
| `TAKE_PROFIT_1/2/3` | Tiered-mode only. Multipliers for the three sells. Must be strictly increasing. Default `2 / 3 / 5`. |
| `SELL_PCT_TP1/2/3` | Tiered-mode only. Fraction of the original bag sold at each TP. Must sum to 100. Default `40 / 30 / 30`. |
| `STOP_LOSS` | Fraction of entry price that triggers a full exit. Applies in both exit modes. Default `0.4` (exit at -60%). |
| `MIN_AI_SCORE` | Score threshold the LLM must clear to trigger a buy (0-100). Default `70`. |
| `MAX_SLIPPAGE_BPS` | Slippage tolerance in basis points. Default `300` (3%). |
| `MIN_LIQUIDITY_USD` | Reject if pool liquidity below this. Raydium only. Default `5000`. |
| `MAX_TOP_HOLDER_PCT` | Reject if the largest holder owns more than this. Raydium only. Default `30`. |
| `REQUIRE_MINT_REVOKED` / `REQUIRE_FREEZE_REVOKED` | Treat tokens with live mint/freeze authority as unsafe. Default `true`. |
| `MAX_OPEN_POSITIONS` | Cap on concurrent positions. Default `10`. |
| `MAX_RUN_HOURS` | Auto-shutdown the snipe loop after N hours. `0` (default) disables — runs until SIGINT. Useful for unattended paper sessions. |
| `CLOSE_ON_SHUTDOWN` | When `true`, the graceful shutdown handler sells every open/partial position at last-known price before exiting. Default `false`. Recommended `true` for live trading and bounded paper sessions. |
| `SIMULATED_STARTING_SOL` | Virtual starting balance for paper-mode PnL display. Default `1.0`. |
| `DB_PATH` / `LOG_FILE` | Override per-source defaults if you need custom paths. Leave unset to let source drive them. |
| `MIPER_SAFETY_PRE_READ_DELAY_MS` | How long to sleep before the first on-chain read (ms). Default `1500`. |
| `PUMP_PRIORITY_MICROLAMPORTS` | Compute-unit priority fee (µLamports per CU) on pump.fun direct buy/sell txs. Default `100000` (~$0.005 priority for a 200k-CU tx). Bump higher when transactions consistently fail to land. |

---

## Commands

Every command accepts `--source raydium|pump`. The `:pump` npm scripts are thin aliases.

```bash
# Run the sniper end-to-end (listener + analyzer + trader + position monitor)
npm run simulate                    # paper, Raydium
npm run simulate:pump               # paper, pump.fun
SIMULATE=false npm run snipe        # live, Raydium
SIMULATE=false npx ts-node src/index.ts snipe --source pump   # live, pump.fun

# Read-only inspection
npm run status                      # open positions + PnL (Raydium DB)
npm run status:pump                 # same, against pump DB
npm run review                      # full summary: PnL, rejections, live-readiness
npm run review:pump                 # same, against pump DB

# Monitor existing positions without opening new ones
npm run monitor
npm run monitor:pump

# Wallet balance
npm run balance
npm run balance:pump

# Manually sell a position (ID from `status`)
npx ts-node src/index.ts sell 3 --pct 50 --source raydium
```

---

## How the pipeline works

```
[listener: new mint detected via WebSocket log subscription]
    -> analyzer gate (max 3 concurrent, skip duplicates)
    -> on-chain safety checks (mint/freeze authority, top holder, liquidity)
         * 1500ms pre-read sleep + 3 retries for mint propagation lag
         * auto-fallback to Token-2022 program for pump.fun mints
         * pump: skip top-holder and liquidity checks (bonding curve holds ~100% by design)
    -> market data
         * Raydium: DexScreener, falls back to pool liquidity
         * pump:    synthetic — priced from the known bonding-curve virtual reserves
    -> enrich signal (pump only, in parallel):
         * Metaplex metadata (name, symbol, URI)
         * creator wallet history (recent tx count, oldest activity age)
    -> Claude scoring (0-100)
         * Raydium: absolute rubric (safety + liquidity + holder distribution)
         * pump:    relative rubric, baselined to "typical pump.fun launch",
                    grading on dev commitment, creator track record, metadata quality
    -> buy if score >= MIN_AI_SCORE
         * Raydium: Jupiter V6 swap
         * pump:    direct bonding-curve `buy` instruction (constant-product
                    math with slippage-capped max_sol_cost). In paper mode the
                    same flow records a synthetic fill at the curve init price.
    -> position monitor polls price every ~7s
         * Raydium: DexScreener priceNative
         * pump:    bonding-curve account read (real-time, always available
                    pre-graduation), falls back to DexScreener once the
                    curve completes and the token moves to PumpSwap
    -> partial sell at TP1 / TP2 / TP3, full exit at stop-loss
```

All trades, rejections, and positions land in the source-specific SQLite file (`sniper.db` or `pump.db`). Simulated trades are marked `simulated = 1` so paper PnL is observable via `status` / `review`.

---

## Simulation vs live mode

`SIMULATE=true` (default):

- Pool detection and safety checks hit real on-chain state
- Claude scoring runs for real (API calls still cost)
- Raydium: Jupiter *quotes* are fetched but swap transactions are not sent
- Pump: buy is synthesized from the bonding-curve initial price (Jupiter is bypassed since it won't route fresh launches)
- Every decision is written to the DB so PnL is observable

`SIMULATE=false`:

- Raydium: signs and sends real Jupiter swaps from `WALLET_PRIVATE_KEY`
- Pump (active curve): signs and sends a direct `buy`/`sell` instruction to the pump.fun program with slippage protection. ATA is created idempotently on first buy.
- Pump (graduated curve): falls back to Jupiter — the token has moved to PumpSwap AMM and aggregators route it normally.

---

## Propagation and retry tuning

Fresh mints often aren't visible to every RPC node for a second or two after creation. The safety-check path:

1. Sleeps `MIPER_SAFETY_PRE_READ_DELAY_MS` (default 1500 ms) before the first `getMint` call
2. Retries up to 3 times with 500/1000/1500 ms backoff on failure
3. For pump.fun mints, automatically falls back to the Token-2022 program ID when the classic SPL Token program rejects the owner

If you're on a slow RPC and still see `TokenAccountNotFoundError` on every token, bump `MIPER_SAFETY_PRE_READ_DELAY_MS` higher or move to a faster RPC.

---

## File layout

```
src/
  index.ts            CLI entry + command wiring
  config.ts           env loading, typed config, program IDs, source resolution
  logger.ts           colorized logger with optional file sink
  db.ts               SQLite schema and queries (positions, trades, rejections)
  listener.ts         generic LogListener + Raydium and pump.fun bindings
  analyzer.ts         on-chain safety, market data, Claude scoring (per-source prompts)
  metadata.ts         Metaplex token metadata PDA + decoder
  creatorHistory.ts   creator wallet activity lookup + in-memory cache
  bondingCurve.ts     pump.fun bonding-curve account decoder + price helper
  trader.ts           Jupiter V6 swaps + synthetic pump paper trades
  positions.ts        TP/SL monitoring loop
  review.ts           PnL + live-readiness summary
  concurrency.ts      InflightGate, withTimeout, retry helpers
tests/                vitest unit tests per module
```

---

## Caveats

- Personal tool. No warranty. Use at your own risk with small amounts.
- On-chain sniping is racy and competitive — faster RPCs matter.
- Claude can be wrong. Keep position sizes small.
- Non-SOL pairs and previously-seen mints are skipped.
- Never commit `.env` or the `*.db` files (both are gitignored).
