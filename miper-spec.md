# MIPER - Project Specification

> **Purpose**: Hand this document to Claude Code to build the entire project.
> **Author**: Sixtus (full-stack developer, 5+ years experience)
> **Date**: April 22, 2026

---

## 1. What This Is

An autonomous Solana memecoin sniping bot that:

1. Monitors Raydium DEX for new liquidity pool creations in real-time
2. Runs on-chain safety checks on each new token (mint/freeze authority, holder distribution, liquidity depth)
3. Sends token data to Claude AI (Anthropic API) for scoring and autonomous buy/no-buy decisions
4. Executes buys via Jupiter V6 aggregator when AI gives the green light
5. Monitors open positions and auto-sells at configurable take-profit levels (2x, 3x, 5x) or stop-loss
6. Tracks all trades, PnL, and win rate in a local SQLite database
7. Runs in **simulation mode by default** (paper trading, no real transactions) until the user flips SIMULATE=false

The strategy is **compound small profits** -- snipe early, take profits at 2-5x, don't get greedy, accumulate SOL over time.

---

## 2. Original User Prompts (Verbatim Context)

These are the exact prompts/thoughts Sixtus shared that led to this spec:

> "AI that autonomously trades crypto, stocks AND places bets for you, pulling in $1k+ daily on autopilot... I'm interested in building this but for betting, analyzes games and places safe bets for you. Or a mobile/web app that uses ai model like claude or chatgpt to get sol coins data, snip sol tokens degen style like the pumpfun shii, snip and leave at 2-5x, focus on taking small profits and accumulating"

> "Trading bot app web/mobile with Claude that automatically snips sol memecoin/degen tokens and takes profit at 2-5x, can leave bull expectations but initially I wanna focus on compounding small profits"

> "I've been tinkering with those ideas in my head for about 3 months now. Now, I wanna build sth real with it that can make me money. I wanna start with the memecoin/degen trading app. It could be a web app or mobile app or even a terminal app. I just want it to be working. It's only for my own private use for now. I don't plan on releasing it to the public yet. Might make it open source later or release it as an app of mine. but that'd be if it gets matured."

### User Decisions Made During Planning

| Question | Answer |
|----------|--------|
| Platform | **Terminal CLI** (fastest to build) |
| Sniping strategy | **Raydium new pools** (recommended -- tokens graduating from pump.fun have survived initial phase, more liquidity for cleaner exits, less instant-rug risk. Pump.fun bonding curve sniping is Phase 2.) |
| AI role | **Full autonomous decision-making** -- AI analyzes token data and makes buy/sell decisions without manual approval |

---

## 3. Tech Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| Language | **TypeScript** (Node.js) | Best Solana ecosystem support, Sixtus knows it well |
| Blockchain | **@solana/web3.js**, **@solana/spl-token** | Standard Solana libraries |
| Swaps | **Jupiter V6 REST API** (`https://quote-api.jup.ag/v6`) | Best swap routing on Solana |
| AI | **@anthropic-ai/sdk** (Claude API, model: `claude-sonnet-4-20250514`) | Autonomous token scoring |
| Database | **better-sqlite3** | Local, zero-config, fast for a CLI tool |
| CLI framework | **commander** | Arg parsing, subcommands |
| Market data | **DexScreener API** (no key needed) | Token price, liquidity, volume |
| Logging | **chalk** + custom logger | Colorized terminal output |
| Config | **dotenv** | `.env` file for secrets and params |
| Key encoding | **bs58** | Solana private key decoding |

### NPM Dependencies

```json
{
  "dependencies": {
    "@anthropic-ai/sdk": "^0.39.0",
    "@solana/web3.js": "^1.95.0",
    "@solana/spl-token": "^0.4.0",
    "bs58": "^6.0.0",
    "chalk": "^4.1.2",
    "better-sqlite3": "^11.0.0",
    "dotenv": "^16.4.0",
    "ora": "^5.4.1",
    "commander": "^12.0.0",
    "node-fetch": "^2.7.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "@types/node": "^20.0.0",
    "@types/node-fetch": "^2.6.0",
    "ts-node": "^10.9.0",
    "typescript": "^5.4.0"
  }
}
```

---

## 4. Architecture

### High-Level Flow

```
[Raydium Pool Listener] -- new pool detected -->
[Token Safety Checker] -- on-chain checks -->
[AI Scorer (Claude API)] -- score + reasoning -->
[Decision Engine] -- buy/skip -->
[Jupiter Swap Executor] -- if buy, execute trade -->
[Position Manager] -- monitor price, auto-sell at TP/SL -->
[SQLite DB] -- log everything
```

### Project Structure

```
miper/
├── package.json
├── tsconfig.json
├── .env.example
├── .gitignore
├── README.md
├── src/
│   ├── index.ts            # CLI entry point (commander setup)
│   ├── config.ts            # Loads .env, validates, exports typed config object
│   ├── listener.ts          # WebSocket listener for new Raydium AMM pools
│   ├── analyzer.ts          # On-chain safety checks + DexScreener market data + Claude AI scoring
│   ├── trader.ts            # Jupiter V6 swap execution (buy & sell)
│   ├── positions.ts         # Position tracking, price monitoring loop, auto-sell logic
│   ├── db.ts                # SQLite schema, queries for positions/trades/rejections
│   └── logger.ts            # Colorized logger with levels (debug/info/warn/error/trade)
```

---

## 5. Module Specifications

### 5.1 `config.ts` - Configuration

Loads from `.env` file. All trading parameters should be configurable.

**Environment Variables:**

```env
# Solana RPC (recommend Helius or QuickNode for speed)
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
SOLANA_WS_URL=wss://api.mainnet-beta.solana.com

# Wallet private key (base58 encoded)
WALLET_PRIVATE_KEY=

# Anthropic
ANTHROPIC_API_KEY=

# Trading
BUY_AMOUNT_SOL=0.05              # SOL per snipe
TAKE_PROFIT_1=2.0                 # First TP target (multiplier)
TAKE_PROFIT_2=3.0                 # Second TP target
TAKE_PROFIT_3=5.0                 # Third TP target
SELL_PCT_TP1=40                   # % of position to sell at TP1
SELL_PCT_TP2=30                   # % at TP2
SELL_PCT_TP3=30                   # % at TP3 (remaining)
STOP_LOSS=0.4                     # Sell if price drops to 40% of entry
MAX_SLIPPAGE_BPS=300              # 3% slippage tolerance

# Safety filters
MIN_LIQUIDITY_USD=5000
MAX_TOP_HOLDER_PCT=30
REQUIRE_MINT_REVOKED=true
REQUIRE_FREEZE_REVOKED=true

# AI
MIN_AI_SCORE=70                   # Minimum Claude score to auto-buy (0-100)

# Mode
SIMULATE=true                     # Paper trading by default
LOG_LEVEL=info
```

**Known Solana Program IDs to store as constants:**

```
Raydium AMM:   675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8
Raydium CPMM:  CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C
Token Program: TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA
Jupiter V6:    JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4
SOL Mint:      So11111111111111111111111111111111111111112
System:        11111111111111111111111111111111
```

---

### 5.2 `listener.ts` - Pool Discovery

**Primary method: WebSocket subscription.**

- Subscribe to logs from the Raydium AMM program ID using `connection.onLogs()`
- Filter for pool initialization events (look for `initialize2`, `Initialize2`, `init_pc_amount`, or `ray_log` with `init` in the log messages)
- When detected, fetch the full parsed transaction via `getParsedTransaction()`
- Parse the Raydium AMM instruction accounts to extract:
  - Pool address
  - Token mint (whichever of the two mints is NOT SOL)
  - Initial liquidity (estimate from SOL balance changes in the transaction)
- Skip non-SOL pairs (token-token pools) for now
- Deduplicate by signature (keep a Set of processed sigs, trim when it exceeds 5000)
- Emit a `newPool` event with the parsed data

**Raydium AMM `initialize2` account layout (approximate):**
- Index 8 = coin mint (usually SOL)
- Index 9 = pc mint (the new token)
- One of these will be the SOL mint address; the other is the token we care about

**Backup method: Polling.**

Build a `PollingPoolListener` class as a fallback that polls `getSignaturesForAddress()` on the Raydium AMM program every 2 seconds. Less reliable but works when WebSocket connections are unstable.

**Event interface:**

```typescript
interface NewPool {
  poolAddress: string;
  tokenMint: string;
  baseMint: string;        // SOL
  quoteMint: string;       // the new token
  initialLiquiditySol: number;
  txSignature: string;
  timestamp: number;        // unix seconds
}
```

---

### 5.3 `analyzer.ts` - Token Analysis & AI Scoring

This module has three stages that run sequentially for each new pool.

#### Stage 1: On-Chain Safety Checks

Using `@solana/web3.js` and `@solana/spl-token`:

- **Mint authority**: Call `getMint()` -- check if `mintAuthority` is `null` (revoked)
- **Freeze authority**: Same call -- check if `freezeAuthority` is `null`
- **Top holder concentration**: Call `getTokenLargestAccounts()` -- calculate what % the top holder owns relative to total supply
- **Holder count**: Length of the largest accounts response (capped at 20 by Solana RPC, but gives a signal)

Fail conditions (configurable):
- Mint authority not revoked (if REQUIRE_MINT_REVOKED=true)
- Freeze authority not revoked (if REQUIRE_FREEZE_REVOKED=true)
- Top holder owns > MAX_TOP_HOLDER_PCT%
- Liquidity < MIN_LIQUIDITY_USD

#### Stage 2: Market Data (DexScreener)

Fetch from `https://api.dexscreener.com/latest/dex/tokens/{mint}` (no API key needed):

- Token symbol and name
- Price in USD and SOL
- Liquidity (USD and SOL)
- Market cap
- 24h volume
- Total supply

Note: Very new tokens might not be indexed yet. Fall back to pool data (initial liquidity from the transaction) if DexScreener returns no results.

Also maintain a cached SOL/USD price (refresh every 60 seconds) by fetching the SOL/USDC pair from DexScreener.

#### Stage 3: AI Scoring (Claude API)

Call Claude via the Anthropic SDK with all collected data. This is the core autonomous decision-making component.

**System prompt for Claude:**

```
You are a Solana memecoin trading analyst. You evaluate new tokens for quick 2-5x trades.
You are cautious, data-driven, and focused on avoiding rugs. Your job is to score tokens 0-100
based on how likely they are to pump profitably while being safe enough to trade.

SCORING GUIDE:
- 80-100: Strong signals, high confidence. Buy.
- 60-79: Decent signals, moderate risk. Marginal buy.
- 40-59: Mixed signals. Skip unless other factors are compelling.
- 0-39: Red flags. Definite skip.

Respond in exactly this JSON format, no markdown:
{"score": <number 0-100>, "reasoning": "<1-2 sentence explanation>"}
```

**User prompt template:**

```
Analyze this new Solana memecoin for a quick snipe trade (target 2-5x, small position).

TOKEN DATA:
- Mint: {mint}
- Symbol: {symbol}
- Name: {name}
- Price: ${priceUsd} ({priceSol} SOL)
- Market Cap: ${marketCapUsd}
- Liquidity: {liquiditySol} SOL (${liquidityUsd})
- 24h Volume: ${volume24h}
- Supply: {supply}

SAFETY:
- Mint Authority Revoked: {mintRevoked}
- Freeze Authority Revoked: {freezeRevoked}
- Top Holder %: {topHolderPct}%
- Holder Count: {holderCount}
- LP Burned: {lpBurned}

POOL:
- Pool Address: {poolAddress}
- Initial Liquidity: {initialLiquiditySol} SOL
- Pool Age: {ageMinutes} minutes

Score this token 0-100 for a quick 2-5x snipe trade. Consider rug risk, liquidity depth, holder distribution, and potential for a pump.
```

**Model**: `claude-sonnet-4-20250514` (fast, cheap, good enough for scoring)
**Max tokens**: 600

Parse the JSON response, clamp score to 0-100. If AI call fails, return score 0 with error message.

#### Final Verdict

Token passes if:
1. All safety checks pass AND
2. AI score >= MIN_AI_SCORE (default 70)

Return a `TokenAnalysis` object with all data, scores, and the `shouldBuy` boolean.

---

### 5.4 `trader.ts` - Swap Execution

Handles buying and selling tokens via Jupiter V6 REST API.

**Jupiter V6 API flow:**

1. **Get quote**: `GET https://quote-api.jup.ag/v6/quote`
   - `inputMint` = SOL mint (for buys) or token mint (for sells)
   - `outputMint` = token mint (for buys) or SOL mint (for sells)
   - `amount` = amount in smallest unit (lamports for SOL, raw for token)
   - `slippageBps` = from config
   - `swapMode` = `ExactIn`

2. **Get swap transaction**: `POST https://quote-api.jup.ag/v6/swap`
   - Send the quote response + `userPublicKey`
   - Set `wrapAndUnwrapSol: true`
   - Set `dynamicComputeUnitLimit: true`
   - Set `prioritizationFeeLamports: "auto"` or a fixed value

3. **Deserialize, sign, and send**:
   - Decode the base64 `swapTransaction` from the response
   - Deserialize as `VersionedTransaction`
   - Sign with the wallet keypair
   - Send via `connection.sendTransaction()` with `skipPreflight: true` for speed
   - Confirm via `connection.confirmTransaction()`

**Functions to implement:**

```typescript
buyToken(tokenMint: string, amountSol: number): Promise<SwapResult>
sellToken(tokenMint: string, amountTokens: number): Promise<SwapResult>
getWallet(): Keypair               // load from base58 private key
getWalletBalance(): Promise<number> // SOL balance
getTokenBalance(mint: string): Promise<number> // token balance
```

**SwapResult interface:**

```typescript
interface SwapResult {
  success: boolean;
  txSignature: string;
  amountIn: number;
  amountOut: number;
  pricePerToken: number;
  error?: string;
}
```

**Simulation mode**: When `SIMULATE=true`, skip the actual transaction send. Instead, use the quote data to simulate what would have happened. Log the simulated trade. Still record it in the database with a `simulated: true` flag.

**Important**: Always check wallet SOL balance before buying. Need to keep enough for transaction fees (reserve ~0.01 SOL minimum).

---

### 5.5 `positions.ts` - Position Management

This is the sell-side brain. It runs a continuous monitoring loop.

**Position lifecycle:**

```
OPEN (just bought)
  -> price hits TP1 (2x) -> sell 40% -> status: PARTIAL, tp_level: 1
  -> price hits TP2 (3x) -> sell 30% -> status: PARTIAL, tp_level: 2
  -> price hits TP3 (5x) -> sell remaining 30% -> status: CLOSED, tp_level: 3
  -> price drops to SL (0.4x entry) -> sell 100% remaining -> status: STOPPED
```

**Monitoring loop:**

- Runs on an interval (every 5-10 seconds)
- For each open/partial position:
  1. Fetch current token price from DexScreener (`https://api.dexscreener.com/latest/dex/tokens/{mint}`)
  2. Calculate current multiplier: `currentPrice / entryPrice`
  3. Check against take-profit levels and stop-loss
  4. Execute sells as needed
  5. Update position in database

**Price fetching**: Use DexScreener token endpoint. Batch requests if possible, but DexScreener doesn't have a multi-token endpoint, so loop through positions. Add rate limiting (max 1 request per second per token).

**Functions:**

```typescript
startMonitoring(intervalMs?: number): void   // start the loop
stopMonitoring(): void                        // stop the loop
checkPosition(position: Position): Promise<void>  // check one position
executeTakeProfit(position: Position, level: number): Promise<void>
executeStopLoss(position: Position): Promise<void>
```

**Edge cases to handle:**
- Token becomes illiquid (sell fails) -- retry 3 times then flag for manual review
- Price data unavailable -- skip this cycle, try next
- Partial sell at TP1 fails -- don't advance tp_level, retry next cycle
- Position is very small (dust) after partial sells -- close it

---

### 5.6 `db.ts` - Database

SQLite via `better-sqlite3`. Three tables:

**positions:**

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | auto-increment |
| token_mint | TEXT | token address |
| token_symbol | TEXT | e.g. "DOGE" |
| entry_price_sol | REAL | price per token in SOL at buy |
| current_price_sol | REAL | last known price |
| amount_tokens | REAL | remaining token balance |
| amount_sol_spent | REAL | total SOL spent to buy |
| amount_sol_received | REAL | total SOL received from sells |
| status | TEXT | open / partial / closed / stopped |
| tp_level | INTEGER | 0-3 (which TP levels have been hit) |
| ai_score | REAL | Claude's score for this token |
| pool_address | TEXT | Raydium pool |
| entry_tx | TEXT | buy transaction signature |
| created_at | TEXT | datetime |
| updated_at | TEXT | datetime |

**trades:**

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | auto-increment |
| position_id | INTEGER FK | references positions.id |
| type | TEXT | buy / sell |
| amount_tokens | REAL | tokens moved |
| amount_sol | REAL | SOL moved |
| price_sol | REAL | price per token at time of trade |
| tx_signature | TEXT | on-chain tx |
| simulated | INTEGER | 0 or 1 |
| created_at | TEXT | datetime |

**rejected_tokens:**

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | auto-increment |
| token_mint | TEXT | |
| reason | TEXT | why it was rejected |
| ai_score | REAL | |
| pool_address | TEXT | |
| created_at | TEXT | datetime |

**Key queries:**
- `isTokenKnown(mint)` -- check if we've already seen this token (in positions or rejections)
- `getOpenPositions()` -- all positions with status open or partial
- `createPosition(...)` / `updatePosition(...)` / `recordTrade(...)`
- `getPnlSummary()` -- total spent, total received, realized PnL, win rate

---

### 5.7 `logger.ts` - Logging

Colorized terminal logger using `chalk`.

Log levels: `debug`, `info`, `warn`, `error`, `trade`

Each log line format: `HH:MM:SS.mmm [LVL] message`

Special methods:
- `logger.banner(text)` -- big header for startup
- `logger.position(action, token, details)` -- formatted trade output (BUY in green, SELL in blue, STOPLOSS in red)
- `logger.trade(msg, data)` -- trade-specific log

---

### 5.8 `index.ts` - CLI Entry Point

Use `commander` for subcommands:

```bash
# Main sniping mode -- listen for pools, analyze, buy, monitor
miper snipe [--simulate]

# Monitor existing positions only (no new buys)
miper monitor

# Show current status -- open positions, PnL summary
miper status

# Show wallet balance
miper balance

# Manually sell a position
miper sell <position-id> [--pct 100]
```

**`snipe` command flow:**

1. Print startup banner with config summary
2. Init database
3. Load wallet, print address and balance
4. Start pool listener
5. On each `newPool` event:
   a. Check if token already known (skip if yes)
   b. Run `analyzeToken(pool)`
   c. If `shouldBuy`: execute buy via `trader.buyToken()`, create position in DB, record trade
   d. If not: record rejection in DB, log reason
6. Start position monitoring loop in parallel
7. Handle SIGINT gracefully (stop listener, stop monitor, print final status)

---

## 6. Simulation Mode

**This is critical. The bot must start in simulation mode by default.**

When `SIMULATE=true`:
- All analysis runs normally (real on-chain data, real AI scoring)
- Buys are NOT executed on-chain. Instead, use Jupiter quote data to record what *would* have happened
- Sells are similarly simulated using current market price
- All simulated trades are recorded in the database with `simulated: true`
- The position monitor tracks real prices for simulated positions
- Logs clearly indicate `[SIM]` prefix on all trade actions

This lets Sixtus validate the strategy with real market data before risking any SOL.

---

## 7. Risk & Safety Notes

Build these safeguards into the code:

1. **Balance guard**: Never buy if wallet SOL balance would drop below 0.01 SOL (need fees)
2. **Concurrent position limit**: Cap open positions at 10 (configurable). Don't over-expose.
3. **Cooldown**: Don't buy the same token twice. Check `isTokenKnown()` before every analysis.
4. **Rate limiting**: DexScreener and Jupiter have rate limits. Add delays between API calls.
5. **Error handling**: Every external call (RPC, DexScreener, Jupiter, Claude) must be try-caught. Never crash the bot on a single token failure.
6. **Graceful shutdown**: Handle SIGINT/SIGTERM -- stop listener, finish pending operations, print PnL summary.
7. **Transaction confirmation**: After sending a swap tx, confirm it landed. If it fails, don't create a phantom position.

---

## 7A. Tests

This is a money-moving bot. Silent bugs cost real SOL. The codebase must have a focused test suite that exercises the pure logic and the stages that wrap external services, with all network and on-chain calls mocked.

**Framework**: `vitest`. Fast, zero-config TypeScript support, built-in mocking. Coverage via `@vitest/coverage-v8`.

**Scripts:**

```
npm test              # run once
npm run test:watch    # watch mode
npm run test:coverage # with coverage report
```

**Test layout**: mirror `src/` under `tests/`. One test file per module.

**Coverage targets by module:**

| Module | What to cover |
|--------|---------------|
| `config.ts` | env parsing, numeric/boolean coercion, TP-percent-sum validation, stop-loss range, monotonic TP ordering, simulate-vs-live requirements |
| `db.ts` | create/update positions, record trades, rejections, `isTokenKnown`, `getOpenPositions`, `getPnlSummary` (spent/received/win rate). Use an in-memory or temp-file sqlite DB and reset between tests. |
| `listener.ts` | `isInitLog` keyword matching, `trimSeen` eviction behavior, `estimateSolLiquidity` balance-delta math, `parsePoolFromSignature` with a mocked `Connection.getParsedTransaction` (SOL/non-SOL pair, malformed tx, non-Raydium ix). |
| `analyzer.ts` | `runSafetyChecks` pass/fail by config flags and top-holder %, `fetchMarketData` happy path and `pool-fallback` path (mocked fetch), `scoreWithAi` JSON parsing, out-of-range clamping, parse-error fallback, API-error fallback (mocked `Anthropic`). |
| `trader.ts` | simulation path (no tx send), balance guard in live mode, quote/swap error propagation, sell with `amount too small` (mocked fetch). |
| `positions.ts` | `fetchPriceSol` rate limiting and no-price cycle, TP sizing math against original bag, dust cleanup threshold, stop-loss trigger, sell retry counter cap. |

**Excluded from coverage**: `src/index.ts` (CLI wiring — integration-ish, not worth the mock burden), `logger.ts` (trivial wrapping). Everything else should be comfortably above 80% line coverage.

**Mocking conventions:**
- Use `vi.mock('node-fetch')` for DexScreener and Jupiter.
- Use `vi.mock('@anthropic-ai/sdk')` for Claude calls.
- Use `vi.mock('@solana/web3.js')` / `@solana/spl-token` for on-chain reads. For `Connection`, provide a stub with just the methods the code actually calls.
- DB tests point `DB_PATH` at a temp file via `beforeEach`, deleted in `afterEach`. No mocking of sqlite itself — the real driver is fast enough.

No tests are expected to hit a live network, RPC, or pay any API cost. If a test does, it's broken.

---

## 8. Phase 2 Features (Not for initial build)

These are planned for later, do NOT build them now:

- **Pump.fun bonding curve sniping** -- buy on the bonding curve before Raydium graduation
- **Social signal scoring** -- Twitter/X mentions, Telegram group activity
- **Web dashboard** (Next.js) -- visual UI for monitoring positions and PnL
- **Multi-wallet support** -- spread risk across wallets
- **Trailing stop-loss** -- instead of fixed SL, trail it upward as price increases
- **Token blacklist/whitelist** -- manual overrides
- **Webhook/Telegram notifications** -- alerts on buys, sells, PnL milestones
- **Backtesting engine** -- replay historical pool creations against the AI scorer
- **Public release / open source**

---

## 9. Developer Context

Sixtus's tech background for Claude Code's reference:
- Full-stack developer, 5+ years experience
- Core stack: Python/FastAPI, React/Next.js, TypeScript, Flutter, PostgreSQL, Docker
- Based in Nigeria
- Familiar with crypto/DeFi concepts (DEXScreener, token analysis, pump.fun mechanics)
- Prefers clean, modular code
- Formatting preference: no em dashes in responses or comments
- This is a personal-use tool, not a production SaaS (keep it pragmatic, not over-engineered)

### Git Workflow: Atomic Commits

**This is important.** Sixtus prefers atomic commits. Commit early, commit often, as you build.

- Initialize a git repo at the very start (`git init`)
- Commit after every meaningful, self-contained unit of work
- Each commit should represent one logical change (one module, one feature, one fix)
- Use clear, conventional commit messages

**Example commit sequence for this project:**

```
chore: initialize project with package.json and tsconfig
feat: add config module with env loading and validation
feat: add logger with colorized output and log levels
feat: add SQLite database schema and query helpers
feat: add Raydium pool listener (WebSocket + polling fallback)
feat: add token safety checker (mint/freeze authority, holder distribution)
feat: add DexScreener market data fetcher
feat: add Claude AI token scorer
feat: combine analyzer pipeline (safety + market + AI)
feat: add Jupiter V6 swap executor (buy/sell)
feat: add simulation mode for swap executor
feat: add position manager with TP/SL monitoring loop
feat: add CLI entry point with commander subcommands
feat: add graceful shutdown handling
docs: add README and .env.example
chore: add .gitignore
```

Do NOT batch the entire project into one big commit at the end. Commit as you go.

---

## 10. Getting Started Commands for Claude Code

```bash
# Initialize the project
mkdir miper && cd miper
npm init -y
# Install all deps from the dependency list above
# Set up tsconfig.json
# Create src/ directory with all modules
# Create .env.example
# Create .gitignore (node_modules, dist, .env, sniper.db)
# Create README.md

# Build and run
npm run build
npm run simulate   # paper trading mode
```

---

## 11. Key External API References

| API | Base URL | Auth | Docs |
|-----|----------|------|------|
| Solana RPC | Configurable (default mainnet-beta) | None (or API key for premium) | https://solana.com/docs/rpc |
| Jupiter V6 | `https://quote-api.jup.ag/v6` | None | https://station.jup.ag/docs/apis/swap-api |
| DexScreener | `https://api.dexscreener.com` | None | https://docs.dexscreener.com |
| Anthropic | `https://api.anthropic.com/v1/messages` | API key (header) | https://docs.anthropic.com |

---

## 12. Success Criteria

The bot is working when:
1. It starts up, connects to Solana RPC, and prints wallet balance
2. It detects new Raydium pools within seconds of creation
3. It runs safety checks and AI scoring on each new token
4. In simulation mode, it records simulated buys for tokens that pass
5. The position monitor tracks prices and records simulated sells at TP/SL levels
6. `miper status` shows a table of positions and PnL summary
7. Switching to live mode (`SIMULATE=false`) executes real swaps via Jupiter


