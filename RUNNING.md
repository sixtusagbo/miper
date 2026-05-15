# Running miper

Operator's playbook. Read this before each run.

## Before you start

1. `.env` is filled in with:
   - `OPENAI_API_KEY` (default, for `gpt-5-nano`) or `ANTHROPIC_API_KEY` (for a `claude-*` model)
   - `WALLET_PRIVATE_KEY` (base58 from Phantom)
   - `SOLANA_RPC_URL` and `SOLANA_WS_URL` (Helius free tier — don't use the public endpoint, you'll get 429'd)
   - `SIMULATE=true`
2. `npm install` has been run
3. `npm test` passes
4. `npm run build` succeeds

## Starting a paper-trading run

```
npm run simulate
```

That's it. The bot will:
- Subscribe to Raydium pool creation events
- Analyze each new pool (safety checks + AI scoring)
- Simulate buys for passing tokens
- Monitor simulated positions and simulate sells at TP1 (2x) / TP2 (3x) / TP3 (5x) or stop-loss (-60%)
- Print a rolling status every 15 minutes

## Seeing your stats

Three quick views:

1. **Rolling summary** — automatic every 15 minutes during the run
2. **On demand** — open a second terminal and run `npm run status`
3. **On shutdown** — Ctrl+C prints a final status before exiting

Status shows open positions, win rate, total spent/received, realized PnL, and (in paper mode) your paper bag balance as a percentage return against `SIMULATED_STARTING_SOL` (default 1 SOL).

## Full review: is it time to go live?

```
npm run review
```

Deeper than `status`. Surfaces everything the DB has accumulated across all runs (the DB persists forever — `rm sniper.db` to reset):

- Data window (first → last activity, in days)
- PnL summary + paper bag return
- Best & worst finished positions
- Top 10 rejection reasons with counts (tells you why most pools are being filtered out)
- **Live-readiness checklist** with PASS/FAIL on the RUNNING.md criteria: ≥20 finished positions, positive realized PnL, ≥3 days of data
- Verdict line: "NOT READY — $reasons" or "Data-driven checks PASSED. Review the log for stability, then consider going live."

Run it before each decision about flipping `SIMULATE=false`. The verdict is advisory — still sanity-check the log for RPC drops and crashes.

## Knowing the bot is alive (listener heartbeat)

Every 5 minutes the listener prints:

```
listener heartbeat (5min): 142 Raydium events | 3 init matches | 2 pools emitted | 1 parse failures
```

How to read it:

| Pattern | What it means |
|---------|---------------|
| `events > 0` | WebSocket is alive, RPC is delivering. |
| `events = 0` once | Warning is logged. Could be a transient blip. |
| `events = 0` twice in a row | Listener auto-reconnects on a fresh WebSocket (`Tearing down dead WebSocket subscription and rebuilding...`). If you see this keep repeating, `SOLANA_WS_URL` is probably broken. |
| `events > 0` but `initMatches = 0` | No pools are being created right now. Normal during quiet hours; try again during 18:00-04:00 UTC. |
| `initMatches > 0`, `poolsEmitted = 0` | Parser is rejecting every candidate. Investigate with debug logging. |
| `parseFailures > 0` | RPC timing out on `getParsedTransaction`. Usually transient. |

## Full audit log

Set `LOG_FILE=./miper.log` in `.env` and every log line — including debug-level detail that doesn't appear in the terminal — goes to that file. Good for post-hoc debugging:

```
tail -f miper.log              # stream the file in another terminal
grep 'analyzing' miper.log     # every pool the bot considered
grep 'BUYING\|skip' miper.log  # every decision it made
```

The file uses plain text (no color codes), one event per line, timestamps first. Append mode, so you can tail across restarts.

## How long to run

**Minimum 3-7 days** before you even think about live mode. You need a sample of at least **20 completed positions** (closed + stopped) to have any read on the strategy.

### When Solana memecoins are most active

Roughly **13:00 - 04:00 UTC** (afternoon through late night for Nigeria). That's when US degens are trading. Weekends are usually busy too.

If you can't run 24/7 locally, prioritize those hours.

## Keeping the bot alive locally

If the laptop sleeps or the terminal closes, miper stops. Options:

### Prevent sleep (macOS)
```
caffeinate -i npm run simulate
```
`caffeinate -i` keeps the system awake while that command runs. Close the terminal and it dies — so combine with tmux.

Or in System Settings > Battery: enable "Prevent automatic sleeping on power adapter when the display is off".

### Survive terminal close with tmux
```
brew install tmux           # if not installed
tmux new -s miper
caffeinate -i npm run simulate
# Detach: Ctrl+B, then D
# Reattach later: tmux attach -t miper
# Kill: tmux kill-session -t miper
```

## Going live

Only flip `SIMULATE=false` when **all** of these are true:

- At least 20 closed + stopped positions in the DB
- Realized PnL (paper bag) is **positive** over a multi-day sample
- No recurring crashes or RPC timeouts in the logs
- Wallet has real SOL (I recommend fresh wallet + small float like 0.5-1 SOL — NOT your main wallet)

Then:

```
# in .env, set SIMULATE=false
npm run snipe
```

## Live pump trading

Pump.fun live trading is wired: direct bonding-curve `buy`/`sell` instructions while the curve is active, Jupiter fallback once a curve graduates. The procedure below is the **first validation run** — small size, short duration. The goal is proving execution lands, not profit.

### Pre-flight

1. **Fresh wallet.** Create a brand-new wallet in Solflare or Phantom — never your main wallet, never a multi-coin wallet. Export its base58 private key into `WALLET_PRIVATE_KEY` in `.env`.
2. **Fund it** with ~0.25-0.3 SOL. Covers position exposure (`BUY_AMOUNT_SOL` x `MAX_OPEN_POSITIONS`), per-token ATA rent, fees, and the 0.01 SOL reserve.
3. `npm test` (must be green) and `npm run build`.
4. `npm run balance:pump` — confirms the key decodes and the RPC answers. It prints the wallet's SOL balance.

### Validation-run config

`.env` ships set for this run; `.env.paper` holds the paper-mode snapshot.

| Var | Value | Why |
|---|---|---|
| `SIMULATE` | `false` | Real transactions |
| `SOURCE` | `pump` | Direct bonding-curve trading |
| `BUY_AMOUNT_SOL` | `0.02` | Small per-snipe stake |
| `MAX_OPEN_POSITIONS` | `3` | Peak exposure 0.06 SOL |
| `MAX_RUN_HOURS` | `2` | Auto-stop; review before a longer run |
| `MAX_SLIPPAGE_BPS` | `500` | A 3% cap reverts too easily on a fast curve |
| `PUMP_PRIORITY_MICROLAMPORTS` | `100000` | Leader-slot priority fee per tx |
| `MAX_CONSECUTIVE_BUY_FAILURES` | `3` | Circuit breaker — auto-stop if 3 buys fail in a row |

### Start and stop

```
npm run snipe
```

Runs 2 hours, then auto-stops. `CLOSE_ON_SHUTDOWN=true` sells every open position at last-known price before exit, so the session ends with no exposure.

### What to watch in `pump.log`

| Line | Meaning |
|------|---------|
| `BUY ... pump direct` | A live buy landed on the bonding curve. |
| `SELL ... pump direct` | A live sell landed on the curve. |
| `selling via Jupiter (post-graduation)` | Sell routed to Jupiter — the curve graduated. |
| `closed empty ATA ... reclaimed rent` | ATA rent reclaimed after a full exit. |
| `pump buy tx failed` / `pump sell tx failed` | The program rejected the tx — read the error. |

### After the run

```
npm run review:pump
```

Then scan `pump.log` for any `tx failed` lines.

### Known caveats

- **The first live buy is the real proof** of the instruction encoding (account layout, creator-vault PDA, fee recipient). If it reverts, the circuit breaker stops the bot after `MAX_CONSECUTIVE_BUY_FAILURES` failures — read the error in `pump.log` before re-running.
- **PnL reads ~1-2% optimistic.** The curve math does not model pump's ~1% protocol/creator fee, so booked buy cost is slightly low and booked sell proceeds slightly high. Real PnL is a touch worse than `review:pump` shows.
- **Keep `MAX_SLIPPAGE_BPS` at 200 or above.** Pump's fee is absorbed by slippage headroom; too tight a cap and buys/sells revert.
- **If transactions consistently fail to land**, raise `PUMP_PRIORITY_MICROLAMPORTS`.

## Common issues

| Symptom | Fix |
|---------|-----|
| Flood of `429 Too Many Requests` | You're on the public RPC. Switch to Helius (see `.env.example`). |
| `... API key is required` | Set the key for your `AI_MODEL`'s provider (`OPENAI_API_KEY` or `ANTHROPIC_API_KEY`) in `.env`, save, retry. |
| Bot runs but no pools ever detected | Check your Solana WS URL starts with `wss://`, not `https://`. |
| `npm run simulate` exits immediately | Check `npm test` first — a config validation error means a bad value in `.env`. |
| Want to reset paper PnL | Delete `sniper.db` (miper will recreate on next run). |

## VPS setup (later)

A $5/month DigitalOcean / Hetzner / Vultr droplet is more than enough. Rough plan:
1. Create a Ubuntu 22.04 droplet
2. `apt install nodejs npm tmux git` (or use nvm for a recent Node)
3. Clone the private repo (set up a deploy key or use a PAT)
4. Copy your `.env` over via `scp` (never commit it)
5. `npm install && npm run build`
6. `tmux new -s miper` then `npm run simulate`
7. Detach and disconnect — bot keeps running

## Reminder

This is paper mode. No real money moves until `SIMULATE=false`. Keep it that way until the numbers say otherwise.
