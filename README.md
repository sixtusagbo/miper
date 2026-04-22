# sol-sniper

Autonomous Solana memecoin sniping bot. Listens for new Raydium AMM pools, runs on-chain safety checks, asks Claude for a score, and auto-buys via Jupiter V6 when the score clears the threshold. Manages positions with tiered take-profit (2x/3x/5x by default) and a stop-loss.

**Starts in simulation mode by default.** No real transactions are sent until you flip `SIMULATE=false`.

## Setup

```bash
npm install
cp .env.example .env
# fill in ANTHROPIC_API_KEY and WALLET_PRIVATE_KEY
npm run build
```

Required env:

- `ANTHROPIC_API_KEY` - from https://console.anthropic.com
- `WALLET_PRIVATE_KEY` - base58-encoded Solana private key (Phantom / Solflare export)
- `SOLANA_RPC_URL` / `SOLANA_WS_URL` - public endpoints work for testing, but use Helius or QuickNode for production latency

See `.env.example` for the full list.

## Usage

```bash
# Paper trading (default). Listens, analyzes, records simulated buys and sells.
npm run simulate

# Live mode. Sends real transactions.
SIMULATE=false npm run snipe

# Monitor existing positions without opening new ones
npm run monitor

# Show open positions and PnL summary
npm run status

# Wallet balance
npm run balance

# Manually sell a position (ID from `status`)
node dist/index.js sell 3 --pct 50
```

## How it works

```
[Raydium pool detected]
    -> on-chain safety checks (mint/freeze authority, top holder, liquidity)
    -> DexScreener market data
    -> Claude AI scoring (0-100)
    -> buy via Jupiter V6 if score >= MIN_AI_SCORE
    -> monitor price every ~7s
    -> sell at TP1/TP2/TP3 (partial) or stop-loss (full)
```

All trades, rejections, and positions are stored in a local SQLite file (`sniper.db`).

## Strategy tuning

Everything in `.env`:

- `BUY_AMOUNT_SOL` - SOL per snipe
- `TAKE_PROFIT_1/2/3` + `SELL_PCT_TP1/2/3` - TP multipliers and what fraction of the bag to sell at each (must sum to 100)
- `STOP_LOSS` - fraction of entry price to trigger a full exit (e.g. `0.4` = -60%)
- `MIN_AI_SCORE` - Claude's score threshold
- `MAX_SLIPPAGE_BPS` - slippage tolerance (300 = 3%)
- `MAX_OPEN_POSITIONS` - cap on concurrent positions

## Simulation mode details

When `SIMULATE=true`:

- Pool detection and safety checks use real on-chain data
- Claude scoring runs for real (API calls still cost)
- Jupiter *quotes* are fetched, but swap transactions are not sent
- All simulated trades are written to the DB with `simulated = 1`, so `sol-sniper status` shows paper PnL

## Caveats

- This is a personal tool. No warranty, use at your own risk with small amounts.
- On-chain sniping is inherently racy and competitive. Faster RPCs help.
- Claude can be wrong. Keep position sizes small.
- The bot intentionally skips non-SOL pairs and tokens it has already seen.

## Files

- `src/index.ts` - CLI entry
- `src/config.ts` - env loading and typed config
- `src/logger.ts` - colorized logger
- `src/db.ts` - SQLite schema and queries
- `src/listener.ts` - Raydium pool discovery (WebSocket + polling fallback)
- `src/analyzer.ts` - safety checks, DexScreener, Claude scoring
- `src/trader.ts` - Jupiter V6 swap execution
- `src/positions.ts` - TP/SL monitoring loop
