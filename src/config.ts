import * as dotenv from 'dotenv';
import { PublicKey } from '@solana/web3.js';

dotenv.config();

export const PROGRAM_IDS = {
  RAYDIUM_AMM: new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'),
  RAYDIUM_CPMM: new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C'),
  PUMP_FUN: new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'),
  TOKEN_PROGRAM: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
  JUPITER_V6: new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'),
  SOL_MINT: new PublicKey('So11111111111111111111111111111111111111112'),
  SYSTEM: new PublicKey('11111111111111111111111111111111'),
};

export const SOL_MINT_ADDRESS = PROGRAM_IDS.SOL_MINT.toBase58();

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'trade';
export type Source = 'raydium' | 'pump' | 'trending' | 'copytrade' | 'discovery';
export type AiProvider = 'anthropic' | 'openai';
export type ExitMode = 'tiered' | 'all-in';

// Default AI model. gpt-5-nano is the cheapest OpenAI model with structured
// JSON support ($0.05 / $0.40 per 1M tokens — ~50x cheaper than Claude
// Sonnet 4 at our prompt sizes). Override via AI_MODEL in .env.
export const DEFAULT_AI_MODEL = 'gpt-5-nano';

export interface Config {
  solanaRpcUrl: string;
  solanaWsUrl: string;
  walletPrivateKey: string;
  anthropicApiKey: string;
  openaiApiKey: string;
  aiProvider: AiProvider;
  aiModel: string;
  buyAmountSol: number;
  takeProfit1: number;
  takeProfit2: number;
  takeProfit3: number;
  sellPctTp1: number;
  sellPctTp2: number;
  sellPctTp3: number;
  stopLoss: number;
  maxSlippageBps: number;
  minLiquidityUsd: number;
  maxTopHolderPct: number;
  requireMintRevoked: boolean;
  requireFreezeRevoked: boolean;
  minAiScore: number;
  simulate: boolean;
  simulatedStartingSol: number;
  logLevel: LogLevel;
  maxOpenPositions: number;
  dbPath: string;
  logFile: string | null;
  source: Source;
  exitMode: ExitMode;
  // Multiplier at which all-in mode fully exits. Ignored under tiered mode.
  exitAtMult: number;
  // Trailing take-profit. Once a position has run up to TRAILING_TP_ARM_MULT x
  // entry (armed), the monitor tracks its peak price and sells the whole bag
  // when price falls TRAILING_TP_DROP_PCT below that peak. This rides a real
  // runner to its top and banks it on the turn, instead of riding the fade
  // back to entry while waiting on a leader's lagged sell or a 10x that never
  // comes. drop=0 disables (default), preserving plain all-in/tiered behavior.
  trailingTpArmMult: number;
  trailingTpDropPct: number;
  // Max wall-clock hours before snipe runs auto-shutdown. 0 disables (run
  // forever until SIGINT). Useful for unattended paper-trading sessions.
  maxRunHours: number;
  // When true, the graceful shutdown handler sells every open/partial
  // position at its current price before closing the DB and exiting. Off
  // by default to preserve current behavior; flip on for live trading and
  // bounded paper sessions where you want a clean PnL at session end.
  closeOnShutdown: boolean;
  // When true, the bot gracefully shuts itself down once the wallet balance is
  // below buyAmountSol (can't open a new position) AND no positions are open to
  // manage. Winds a tapped-out run down instead of idling. Off by default.
  closeWhenBelowMinBalance: boolean;
  // Maximum minutes a position may stay open without hitting TP/SL before
  // the monitor force-exits at last-known price. 0 disables (the historical
  // behavior — positions hold forever). Surfaced after R11b showed that
  // most pump tokens spike in the first 5-10 min then flatline; without a
  // time exit the bag fills with non-movers and capital is locked.
  maxHoldMinutes: number;
  // TTL for the pump.fun bonding-curve account-info cache, in milliseconds.
  // 0 disables. Added after R12 burned 185k getAccountInfo calls in 22h
  // (~18% of Helius free-tier credits/day) reading the same curves from
  // every 10s monitor tick. Within a few seconds the marginal curve price
  // barely shifts, so a small cache cuts reads by ~5-10x with no material
  // signal loss.
  bondingCurveCacheMs: number;
  // Rotate the log file when it exceeds this many bytes. The previous file
  // becomes pump.log.1, pump.log.1 becomes pump.log.2, etc., up to
  // logMaxFiles. 0 disables rotation (the historical behavior — log grows
  // unbounded). R12's 24h log hit 54 MB; sustained operation needs a cap.
  logMaxBytes: number;
  // How many rotated archive files to keep alongside the active log.
  // Older archives are dropped when this cap is hit. Ignored when
  // logMaxBytes=0.
  logMaxFiles: number;
  // Compute-unit priority fee on pump.fun buy/sell txs (micro-lamports per
  // CU). pumpPriorityMicrolamports is the FLOOR: the fee is set per-tx from
  // recent network fees (see computePriorityMicrolamports) and clamped
  // between this floor and pumpPriorityMaxMicrolamports. Raise the floor for
  // a faster baseline; raise the max to stay competitive in congestion.
  pumpPriorityMicrolamports: number;
  pumpPriorityMaxMicrolamports: number;
  // Consecutive failed buys that trip a graceful shutdown — a circuit
  // breaker for live runs where a systematic fault (bad instruction
  // encoding, dead RPC, drained wallet) fails every snipe and bleeds fees
  // until noticed. The counter resets on any successful buy. 0 disables.
  maxConsecutiveBuyFailures: number;
  // Momentum entry (pump source): instead of sniping at launch, watch a
  // freshly-detected token's bonding-curve price for momentumWindowMin
  // minutes, sampling every momentumSampleSec. A token must first climb into
  // the [momentumEntryMultMin, momentumEntryMultMax] band (proof of demand) —
  // then, rather than buying the spike (a moving price won't fill inside the
  // slippage cap), we wait for it to *settle*: momentumSettleSamples
  // consecutive samples within ±momentumSettleTolerance. We buy the flat
  // price. momentumWatchCap bounds the concurrent watchlist (and RPC load).
  momentumWindowMin: number;
  momentumSampleSec: number;
  momentumEntryMultMin: number;
  momentumEntryMultMax: number;
  // The settle gate: a token in the band is bought only once this many
  // consecutive price samples sit within this fractional spread (0.10 = the
  // window's high is within 10% of its low) — i.e. the climb has plateaued
  // and the price is calm enough for a buy to land.
  momentumSettleSamples: number;
  momentumSettleTolerance: number;
  momentumWatchCap: number;
  // Veto a momentum-triggered token if >= this many distinct wallets bought
  // in the launch slot — the signature of a bundled (manufactured) pump that
  // a naive momentum entry would buy straight into. 0 disables the check.
  momentumBundleThreshold: number;
  // Ignore a band-crossing that happened within this many seconds of first
  // seeing the token — a move that fast is an un-catchable spike (entry
  // latency would blow past slippage) and usually a manufactured pump.
  // 0 disables the filter.
  momentumMinAgeSec: number;
  // Trending entry (trending source): poll GeckoTerminal's trending pools and
  // buy graduated AMM tokens that clear a liquidity / market-cap / volume /
  // age filter — the user's hand-proven DexScreener routine, automated.
  trendingPollSec: number;
  trendingMinLiquidityUsd: number;
  trendingMaxLiquidityUsd: number;
  trendingMinMcapUsd: number;
  trendingMinVolumeUsd: number; // 24h volume floor — "VOL looks good"
  trendingMinAgeMin: number;
  trendingMaxAgeHours: number;
  // Copy-trading (copytrade source): mirror a curated set of proven Solana
  // wallets. Poll each wallet's on-chain activity; copy a buy when the leader
  // spent at least copytradeMinLeaderSol; exit when the leader sells (with
  // the stop-loss / time-exit as independent floors).
  copytradeWallets: string[];
  // Optional human-readable names for the followed wallets, positionally
  // matched to copytradeWallets (COPYTRADE_LABELS). Used only in logs and DB
  // attribution; a missing label falls back to a short address.
  copytradeLabels: string[];
  copytradePollSec: number;
  copytradeMinLeaderSol: number;
  // A leader sell only mirrors as our full exit when they sold at least this
  // fraction of their holding. Smaller trims are treated as "leader still in"
  // and ignored, so a dust/test-sell can't dump our whole bag. 1 = only a full
  // leader exit triggers ours.
  copytradeSellExitFraction: number;
  // Discovery scanner (discovery source): watch every pump.fun launch for a
  // few minutes, extract the features the wallet research measured (deployer
  // history, funding wallet, holder growth, tx flow, smart-wallet cluster
  // buys, mcap/liquidity), score 0-100 deterministically against the research
  // profile, alert on Telegram at discoveryAlertScore, and (only when
  // discoveryAutobuy) buy at discoveryBuyScore through the normal trade path.
  discoveryWindowMin: number;
  discoverySampleSec: number;
  discoveryWatchCap: number;
  // Tx parses per token per STEADY-STATE sample — the buyer-diversity /
  // smart-wallet sampling budget. The sig-count velocity is exact regardless.
  discoveryParsePerSample: number;
  // Tx parses in the LAUNCH window (first sample), spent on the OLDEST
  // signatures where the research showed the cluster's same-slot entries land.
  // This is where the dominant smart-wallet signal is, so it gets a bigger,
  // one-time budget than steady-state re-sampling.
  discoveryLaunchParse: number;
  discoveryAlertScore: number;
  discoveryBuyScore: number;
  // Auto-buy phase. Off = alert-only (the v1 operating mode and the kill
  // switch for buying: flipping this off stops buys without stopping alerts).
  discoveryAutobuy: boolean;
  // Veto a launch when >= this many distinct wallets bought in its create
  // slot (reuses the bundle check). 0 disables.
  discoveryBundleThreshold: number;
  // Skip launches whose creator co-deposited less than this at add time —
  // an intake throttle so the watch cap goes to profile-shaped launches.
  // 0 disables.
  discoveryMinDevBuySol: number;
  // Path to the research-derived profile JSON (thresholds + wallet lists).
  // Missing/invalid file falls back to built-in defaults.
  discoveryProfilePath: string;
  // Extra smart wallets to track, merged with the profile's list.
  discoverySmartWallets: string[];
  // Optional Telegram alerting. When both are set, the bot pushes startup,
  // circuit-breaker, and no-activity alerts to the chat. Empty = no-op.
  telegramBotToken: string;
  telegramChatId: string;
  // Minutes of zero leader activity after which the copytrade run sends a
  // "still alive but quiet" heartbeat alert (a silent bot is invisible
  // otherwise). 0 disables.
  alertHeartbeatMinutes: number;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric value for ${name}: ${raw}`);
  }
  return parsed;
}

function boolFromEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n'].includes(normalized)) return false;
  throw new Error(`Invalid boolean value for ${name}: ${raw}`);
}

// Human-readable name for a followed leader wallet, positionally matched to
// COPYTRADE_WALLETS via COPYTRADE_LABELS. Falls back to a short address when no
// label is configured, so logs and DB attribution always identify the leader.
export function leaderLabel(wallet: string, wallets: string[], labels: string[]): string {
  const i = wallets.indexOf(wallet);
  const name = i >= 0 ? (labels[i] ?? '').trim() : '';
  return name || `${wallet.slice(0, 4)}..${wallet.slice(-4)}`;
}

// Parse a comma-separated env var into a trimmed, de-blanked list.
function listFromEnv(name: string): string[] {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseLogLevel(value: string | undefined): LogLevel {
  const normalized = (value ?? 'info').trim().toLowerCase();
  if (['debug', 'info', 'warn', 'error', 'trade'].includes(normalized)) {
    return normalized as LogLevel;
  }
  throw new Error(`Invalid LOG_LEVEL: ${value}`);
}

function parseSource(value: string | undefined): Source {
  const normalized = (value ?? 'raydium').trim().toLowerCase();
  if (
    normalized === 'raydium' ||
    normalized === 'pump' ||
    normalized === 'trending' ||
    normalized === 'copytrade' ||
    normalized === 'discovery'
  ) {
    return normalized;
  }
  throw new Error(
    `Invalid SOURCE: ${value} (expected 'raydium', 'pump', 'trending', 'copytrade' or 'discovery')`
  );
}

function parseExitMode(value: string | undefined): ExitMode {
  const normalized = (value ?? 'tiered').trim().toLowerCase();
  if (normalized === 'tiered' || normalized === 'all-in') return normalized;
  throw new Error(`Invalid EXIT_MODE: ${value} (expected 'tiered' or 'all-in')`);
}

// Derive the provider from the model ID. Every Claude model starts with
// 'claude-'; every current OpenAI text model starts with 'gpt-', 'o1', 'o3',
// or 'chatgpt-'. Unknown prefixes throw rather than silently routing wrong.
export function inferAiProvider(model: string): AiProvider {
  const m = model.trim().toLowerCase();
  if (m.startsWith('claude-')) return 'anthropic';
  if (m.startsWith('gpt-') || m.startsWith('o1') || m.startsWith('o3') || m.startsWith('chatgpt-')) {
    return 'openai';
  }
  throw new Error(
    `Cannot infer AI provider from AI_MODEL='${model}'. ` +
      `Expected an ID starting with 'claude-' (Anthropic) or 'gpt-' / 'o1' / 'o3' / 'chatgpt-' (OpenAI).`
  );
}

// Resolve the RPC endpoints. Precedence: explicit SOLANA_RPC_URL / SOLANA_WS_URL
// win; otherwise a bare HELIUS_API_KEY derives the Helius URLs (a plain key
// survives copy-paste through chat/UI fields that mangle full URLs); otherwise
// the public mainnet endpoints (which rate-limit hard — fine for smoke tests
// only). Exported standalone so the research scripts can share the resolution
// without pulling in full trading-config validation.
export function resolveRpcUrls(): { rpcUrl: string; wsUrl: string } {
  const key = process.env.HELIUS_API_KEY?.trim();
  return {
    rpcUrl:
      process.env.SOLANA_RPC_URL?.trim() ||
      (key
        ? `https://mainnet.helius-rpc.com/?api-key=${key}`
        : 'https://api.mainnet-beta.solana.com'),
    wsUrl:
      process.env.SOLANA_WS_URL?.trim() ||
      (key
        ? `wss://mainnet.helius-rpc.com/?api-key=${key}`
        : 'wss://api.mainnet-beta.solana.com'),
  };
}

let cached: Config | null = null;

// Clears the cached Config so the next loadConfig() re-reads process.env.
// Intended for tests; production callers should not need it.
export function resetConfigCache(): void {
  cached = null;
}

export function loadConfig(): Config {
  if (cached) return cached;

  const simulate = boolFromEnv('SIMULATE', true);
  const source = parseSource(process.env.SOURCE);
  const aiModel = process.env.AI_MODEL?.trim() || DEFAULT_AI_MODEL;
  const aiProvider = inferAiProvider(aiModel);
  const walletKey = process.env.WALLET_PRIVATE_KEY?.trim() ?? '';
  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim() ?? '';
  const openaiKey = process.env.OPENAI_API_KEY?.trim() ?? '';

  // In simulation mode we can tolerate a missing wallet key since swaps are mocked,
  // but we still need one to derive an address. Fail fast in live mode.
  if (!simulate && !walletKey) {
    throw new Error('WALLET_PRIVATE_KEY is required when SIMULATE=false');
  }
  // copytrade (the leader's action is the signal) and discovery (deterministic
  // feature scoring against the research profile) never call the LLM, so they
  // must not require an AI key. Requiring one sent the live unit into a silent
  // restart loop when the key was reasonably omitted. Only the AI-scoring
  // sources (raydium, pump, trending) need the active provider's key, and only
  // the active provider's, not both.
  const usesAi = source !== 'copytrade' && source !== 'discovery';
  if (usesAi && aiProvider === 'anthropic' && !anthropicKey) {
    throw new Error('ANTHROPIC_API_KEY is required when AI_PROVIDER=anthropic');
  }
  if (usesAi && aiProvider === 'openai' && !openaiKey) {
    throw new Error('OPENAI_API_KEY is required when AI_PROVIDER=openai');
  }

  const { rpcUrl, wsUrl } = resolveRpcUrls();
  const config: Config = {
    solanaRpcUrl: rpcUrl,
    solanaWsUrl: wsUrl,
    walletPrivateKey: walletKey,
    anthropicApiKey: anthropicKey,
    openaiApiKey: openaiKey,
    aiProvider,
    aiModel,
    buyAmountSol: numberFromEnv('BUY_AMOUNT_SOL', 0.05),
    takeProfit1: numberFromEnv('TAKE_PROFIT_1', 2.0),
    takeProfit2: numberFromEnv('TAKE_PROFIT_2', 3.0),
    takeProfit3: numberFromEnv('TAKE_PROFIT_3', 5.0),
    sellPctTp1: numberFromEnv('SELL_PCT_TP1', 40),
    sellPctTp2: numberFromEnv('SELL_PCT_TP2', 30),
    sellPctTp3: numberFromEnv('SELL_PCT_TP3', 30),
    stopLoss: numberFromEnv('STOP_LOSS', 0.4),
    maxSlippageBps: numberFromEnv('MAX_SLIPPAGE_BPS', 300),
    minLiquidityUsd: numberFromEnv('MIN_LIQUIDITY_USD', 5000),
    maxTopHolderPct: numberFromEnv('MAX_TOP_HOLDER_PCT', 30),
    requireMintRevoked: boolFromEnv('REQUIRE_MINT_REVOKED', true),
    requireFreezeRevoked: boolFromEnv('REQUIRE_FREEZE_REVOKED', true),
    minAiScore: numberFromEnv('MIN_AI_SCORE', 70),
    simulate,
    simulatedStartingSol: numberFromEnv('SIMULATED_STARTING_SOL', 1.0),
    logLevel: parseLogLevel(process.env.LOG_LEVEL),
    maxOpenPositions: numberFromEnv('MAX_OPEN_POSITIONS', 10),
    // Per-source defaults so Raydium and pump.fun runs write to separate files
    // and never cross-contaminate each other's trade history.
    dbPath:
      process.env.DB_PATH?.trim() ||
      ({
        raydium: './sniper.db',
        pump: './pump.db',
        trending: './trending.db',
        copytrade: './copytrade.db',
        discovery: './discovery.db',
      }[source]),
    logFile:
      process.env.LOG_FILE?.trim() ||
      ({
        raydium: null,
        pump: './pump.log',
        trending: './trending.log',
        copytrade: './copytrade.log',
        discovery: './discovery.log',
      }[source]),
    source,
    exitMode: parseExitMode(process.env.EXIT_MODE),
    exitAtMult: numberFromEnv('EXIT_AT_MULT', 2),
    trailingTpArmMult: numberFromEnv('TRAILING_TP_ARM_MULT', 1.5),
    trailingTpDropPct: numberFromEnv('TRAILING_TP_DROP_PCT', 0),
    maxRunHours: numberFromEnv('MAX_RUN_HOURS', 0),
    closeOnShutdown: boolFromEnv('CLOSE_ON_SHUTDOWN', false),
    closeWhenBelowMinBalance: boolFromEnv('CLOSE_WHEN_BELOW_MIN_BALANCE', false),
    maxHoldMinutes: numberFromEnv('MAX_HOLD_MINUTES', 0),
    bondingCurveCacheMs: numberFromEnv('BONDING_CURVE_CACHE_MS', 5000),
    logMaxBytes: numberFromEnv('LOG_MAX_BYTES', 100 * 1024 * 1024),
    logMaxFiles: numberFromEnv('LOG_MAX_FILES', 5),
    pumpPriorityMicrolamports: numberFromEnv('PUMP_PRIORITY_MICROLAMPORTS', 100_000),
    pumpPriorityMaxMicrolamports: numberFromEnv('PUMP_PRIORITY_MAX_MICROLAMPORTS', 5_000_000),
    maxConsecutiveBuyFailures: numberFromEnv('MAX_CONSECUTIVE_BUY_FAILURES', 5),
    momentumWindowMin: numberFromEnv('MOMENTUM_WINDOW_MIN', 5),
    momentumSampleSec: numberFromEnv('MOMENTUM_SAMPLE_SEC', 25),
    momentumEntryMultMin: numberFromEnv('MOMENTUM_ENTRY_MULT_MIN', 1.4),
    momentumEntryMultMax: numberFromEnv('MOMENTUM_ENTRY_MULT_MAX', 2.5),
    momentumSettleSamples: numberFromEnv('MOMENTUM_SETTLE_SAMPLES', 3),
    momentumSettleTolerance: numberFromEnv('MOMENTUM_SETTLE_TOLERANCE', 0.1),
    momentumWatchCap: numberFromEnv('MOMENTUM_WATCH_CAP', 40),
    momentumBundleThreshold: numberFromEnv('MOMENTUM_BUNDLE_THRESHOLD', 3),
    momentumMinAgeSec: numberFromEnv('MOMENTUM_MIN_AGE_SEC', 60),
    trendingPollSec: numberFromEnv('TRENDING_POLL_SEC', 45),
    trendingMinLiquidityUsd: numberFromEnv('TRENDING_MIN_LIQUIDITY_USD', 10_000),
    trendingMaxLiquidityUsd: numberFromEnv('TRENDING_MAX_LIQUIDITY_USD', 250_000),
    trendingMinMcapUsd: numberFromEnv('TRENDING_MIN_MCAP_USD', 22_000),
    trendingMinVolumeUsd: numberFromEnv('TRENDING_MIN_VOLUME_USD', 50_000),
    trendingMinAgeMin: numberFromEnv('TRENDING_MIN_AGE_MIN', 30),
    trendingMaxAgeHours: numberFromEnv('TRENDING_MAX_AGE_HOURS', 24),
    copytradeWallets: listFromEnv('COPYTRADE_WALLETS'),
    copytradeLabels: listFromEnv('COPYTRADE_LABELS'),
    copytradePollSec: numberFromEnv('COPYTRADE_POLL_SEC', 12),
    copytradeMinLeaderSol: numberFromEnv('COPYTRADE_MIN_LEADER_SOL', 0.5),
    copytradeSellExitFraction: numberFromEnv('COPYTRADE_SELL_EXIT_FRACTION', 0.34),
    discoveryWindowMin: numberFromEnv('DISCOVERY_WINDOW_MIN', 5),
    // Keep sample cadence and per-sample parses modest: a full watchlist does
    // watchCap * (2 + parsePerSample) RPC calls per sample interval, and the
    // default budget must sit well under a free Helius tier's 10 req/s.
    discoverySampleSec: numberFromEnv('DISCOVERY_SAMPLE_SEC', 25),
    discoveryWatchCap: numberFromEnv('DISCOVERY_WATCH_CAP', 12),
    discoveryParsePerSample: numberFromEnv('DISCOVERY_PARSE_PER_SAMPLE', 2),
    discoveryLaunchParse: numberFromEnv('DISCOVERY_LAUNCH_PARSE', 8),
    discoveryAlertScore: numberFromEnv('DISCOVERY_ALERT_SCORE', 55),
    discoveryBuyScore: numberFromEnv('DISCOVERY_BUY_SCORE', 75),
    discoveryAutobuy: boolFromEnv('DISCOVERY_AUTOBUY', false),
    discoveryBundleThreshold: numberFromEnv('DISCOVERY_BUNDLE_THRESHOLD', 3),
    discoveryMinDevBuySol: numberFromEnv('DISCOVERY_MIN_DEV_BUY_SOL', 0),
    discoveryProfilePath:
      process.env.DISCOVERY_PROFILE?.trim() || './research/discovery-profile.json',
    discoverySmartWallets: listFromEnv('DISCOVERY_SMART_WALLETS'),
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN?.trim() ?? '',
    telegramChatId: process.env.TELEGRAM_CHAT_ID?.trim() ?? '',
    alertHeartbeatMinutes: numberFromEnv('ALERT_HEARTBEAT_MINUTES', 60),
  };

  validateConfig(config);
  cached = config;
  return config;
}

function validateConfig(c: Config): void {
  const sellPctSum = c.sellPctTp1 + c.sellPctTp2 + c.sellPctTp3;
  if (Math.abs(sellPctSum - 100) > 0.01) {
    throw new Error(`SELL_PCT_TP1+TP2+TP3 must sum to 100, got ${sellPctSum}`);
  }
  if (!(c.takeProfit1 < c.takeProfit2 && c.takeProfit2 < c.takeProfit3)) {
    throw new Error('TAKE_PROFIT_1 < TAKE_PROFIT_2 < TAKE_PROFIT_3 must hold');
  }
  if (c.stopLoss <= 0 || c.stopLoss >= 1) {
    throw new Error(`STOP_LOSS must be between 0 and 1 (fraction of entry), got ${c.stopLoss}`);
  }
  if (c.minAiScore < 0 || c.minAiScore > 100) {
    throw new Error(`MIN_AI_SCORE must be 0-100, got ${c.minAiScore}`);
  }
  if (c.buyAmountSol <= 0) {
    throw new Error(`BUY_AMOUNT_SOL must be > 0, got ${c.buyAmountSol}`);
  }
  if (c.simulatedStartingSol <= 0) {
    throw new Error(`SIMULATED_STARTING_SOL must be > 0, got ${c.simulatedStartingSol}`);
  }
  if (c.exitMode === 'all-in' && c.exitAtMult <= 1) {
    throw new Error(
      `EXIT_AT_MULT must be > 1 when EXIT_MODE=all-in (an exit at <=1x is just a stop-loss); got ${c.exitAtMult}`
    );
  }
  if (c.maxRunHours < 0) {
    throw new Error(`MAX_RUN_HOURS must be >= 0 (0 disables auto-shutdown), got ${c.maxRunHours}`);
  }
  if (c.trailingTpDropPct < 0 || c.trailingTpDropPct >= 1) {
    throw new Error(
      `TRAILING_TP_DROP_PCT must be in [0,1) (fraction below peak; 0 disables), got ${c.trailingTpDropPct}`
    );
  }
  if (c.trailingTpDropPct > 0 && c.trailingTpArmMult <= 1) {
    throw new Error(
      `TRAILING_TP_ARM_MULT must be > 1 when trailing TP is enabled, got ${c.trailingTpArmMult}`
    );
  }
  if (c.maxHoldMinutes < 0) {
    throw new Error(`MAX_HOLD_MINUTES must be >= 0 (0 disables time-exit), got ${c.maxHoldMinutes}`);
  }
  if (c.bondingCurveCacheMs < 0) {
    throw new Error(
      `BONDING_CURVE_CACHE_MS must be >= 0 (0 disables cache), got ${c.bondingCurveCacheMs}`
    );
  }
  if (c.logMaxBytes < 0) {
    throw new Error(`LOG_MAX_BYTES must be >= 0 (0 disables rotation), got ${c.logMaxBytes}`);
  }
  if (c.logMaxFiles < 1) {
    throw new Error(`LOG_MAX_FILES must be >= 1, got ${c.logMaxFiles}`);
  }
  if (c.pumpPriorityMicrolamports < 0) {
    throw new Error(
      `PUMP_PRIORITY_MICROLAMPORTS must be >= 0, got ${c.pumpPriorityMicrolamports}`
    );
  }
  if (c.pumpPriorityMaxMicrolamports < c.pumpPriorityMicrolamports) {
    throw new Error(
      `PUMP_PRIORITY_MAX_MICROLAMPORTS (${c.pumpPriorityMaxMicrolamports}) must be >= PUMP_PRIORITY_MICROLAMPORTS (${c.pumpPriorityMicrolamports})`
    );
  }
  if (c.momentumWindowMin <= 0) {
    throw new Error(`MOMENTUM_WINDOW_MIN must be > 0, got ${c.momentumWindowMin}`);
  }
  if (c.momentumSampleSec <= 0) {
    throw new Error(`MOMENTUM_SAMPLE_SEC must be > 0, got ${c.momentumSampleSec}`);
  }
  if (c.momentumEntryMultMin <= 1) {
    throw new Error(
      `MOMENTUM_ENTRY_MULT_MIN must be > 1 (entry requires upward momentum), got ${c.momentumEntryMultMin}`
    );
  }
  if (c.momentumEntryMultMax < c.momentumEntryMultMin) {
    throw new Error(
      `MOMENTUM_ENTRY_MULT_MAX (${c.momentumEntryMultMax}) must be >= MOMENTUM_ENTRY_MULT_MIN (${c.momentumEntryMultMin})`
    );
  }
  if (c.momentumWatchCap < 1) {
    throw new Error(`MOMENTUM_WATCH_CAP must be >= 1, got ${c.momentumWatchCap}`);
  }
  if (c.momentumSettleSamples < 2) {
    throw new Error(
      `MOMENTUM_SETTLE_SAMPLES must be >= 2 (a settle needs at least two samples to compare), got ${c.momentumSettleSamples}`
    );
  }
  if (c.momentumSettleTolerance <= 0) {
    throw new Error(
      `MOMENTUM_SETTLE_TOLERANCE must be > 0, got ${c.momentumSettleTolerance}`
    );
  }
  if (c.momentumBundleThreshold < 0) {
    throw new Error(
      `MOMENTUM_BUNDLE_THRESHOLD must be >= 0 (0 disables the bundle check), got ${c.momentumBundleThreshold}`
    );
  }
  if (c.momentumMinAgeSec < 0) {
    throw new Error(
      `MOMENTUM_MIN_AGE_SEC must be >= 0 (0 disables the filter), got ${c.momentumMinAgeSec}`
    );
  }
  if (c.maxConsecutiveBuyFailures < 0) {
    throw new Error(
      `MAX_CONSECUTIVE_BUY_FAILURES must be >= 0 (0 disables), got ${c.maxConsecutiveBuyFailures}`
    );
  }
  if (c.trendingPollSec <= 0) {
    throw new Error(`TRENDING_POLL_SEC must be > 0, got ${c.trendingPollSec}`);
  }
  if (c.trendingMaxLiquidityUsd < c.trendingMinLiquidityUsd) {
    throw new Error(
      `TRENDING_MAX_LIQUIDITY_USD (${c.trendingMaxLiquidityUsd}) must be >= TRENDING_MIN_LIQUIDITY_USD (${c.trendingMinLiquidityUsd})`
    );
  }
  if (c.trendingMinAgeMin < 0) {
    throw new Error(`TRENDING_MIN_AGE_MIN must be >= 0, got ${c.trendingMinAgeMin}`);
  }
  if (c.trendingMaxAgeHours * 60 <= c.trendingMinAgeMin) {
    throw new Error(
      `TRENDING_MAX_AGE_HOURS (${c.trendingMaxAgeHours}h) must exceed TRENDING_MIN_AGE_MIN (${c.trendingMinAgeMin}min)`
    );
  }
  if (c.copytradePollSec <= 0) {
    throw new Error(`COPYTRADE_POLL_SEC must be > 0, got ${c.copytradePollSec}`);
  }
  if (c.copytradeMinLeaderSol < 0) {
    throw new Error(
      `COPYTRADE_MIN_LEADER_SOL must be >= 0, got ${c.copytradeMinLeaderSol}`
    );
  }
  if (c.copytradeSellExitFraction <= 0 || c.copytradeSellExitFraction > 1) {
    throw new Error(
      `COPYTRADE_SELL_EXIT_FRACTION must be in (0, 1], got ${c.copytradeSellExitFraction}`
    );
  }
  if (c.discoveryWindowMin <= 0) {
    throw new Error(`DISCOVERY_WINDOW_MIN must be > 0, got ${c.discoveryWindowMin}`);
  }
  if (c.discoverySampleSec < 5) {
    throw new Error(
      `DISCOVERY_SAMPLE_SEC must be >= 5 (a tighter cadence multiplied across the watchlist blows the RPC budget), got ${c.discoverySampleSec}`
    );
  }
  if (c.discoveryWatchCap < 1) {
    throw new Error(`DISCOVERY_WATCH_CAP must be >= 1, got ${c.discoveryWatchCap}`);
  }
  if (c.discoveryParsePerSample < 0) {
    throw new Error(
      `DISCOVERY_PARSE_PER_SAMPLE must be >= 0 (0 disables buyer sampling), got ${c.discoveryParsePerSample}`
    );
  }
  if (c.discoveryLaunchParse < 0) {
    throw new Error(
      `DISCOVERY_LAUNCH_PARSE must be >= 0 (0 disables launch-window sampling), got ${c.discoveryLaunchParse}`
    );
  }
  if (c.discoveryAlertScore < 0 || c.discoveryAlertScore > 100) {
    throw new Error(`DISCOVERY_ALERT_SCORE must be 0-100, got ${c.discoveryAlertScore}`);
  }
  if (c.discoveryBuyScore < 0 || c.discoveryBuyScore > 100) {
    throw new Error(`DISCOVERY_BUY_SCORE must be 0-100, got ${c.discoveryBuyScore}`);
  }
  if (c.discoveryBundleThreshold < 0) {
    throw new Error(
      `DISCOVERY_BUNDLE_THRESHOLD must be >= 0 (0 disables the bundle check), got ${c.discoveryBundleThreshold}`
    );
  }
  if (c.discoveryMinDevBuySol < 0) {
    throw new Error(
      `DISCOVERY_MIN_DEV_BUY_SOL must be >= 0 (0 disables the intake filter), got ${c.discoveryMinDevBuySol}`
    );
  }
}

// Reserve for transaction fees. Never spend below this balance.
export const MIN_SOL_RESERVE = 0.01;
