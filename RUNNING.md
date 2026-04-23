# Running miper

Operator's playbook. Read this before each run.

## Before you start

1. `.env` is filled in with:
   - `ANTHROPIC_API_KEY` (sk-ant-...)
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
- Analyze each new pool (safety checks + Claude scoring)
- Simulate buys for passing tokens
- Monitor simulated positions and simulate sells at TP1 (2x) / TP2 (3x) / TP3 (5x) or stop-loss (-60%)
- Print a rolling status every 15 minutes

## Seeing your stats

Three ways:

1. **Rolling summary** — automatic every 15 minutes during the run
2. **On demand** — open a second terminal and run `npm run status`
3. **On shutdown** — Ctrl+C prints a final status before exiting

Status shows open positions, win rate, total spent/received, realized PnL, and (in paper mode) your paper bag balance as a percentage return against `SIMULATED_STARTING_SOL` (default 1 SOL).

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

## Common issues

| Symptom | Fix |
|---------|-----|
| Flood of `429 Too Many Requests` | You're on the public RPC. Switch to Helius (see `.env.example`). |
| `ANTHROPIC_API_KEY is required` | Set it in `.env`, save, retry. |
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
