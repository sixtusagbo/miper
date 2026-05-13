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
export type Source = 'raydium' | 'pump';
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
  // Max wall-clock hours before snipe runs auto-shutdown. 0 disables (run
  // forever until SIGINT). Useful for unattended paper-trading sessions.
  maxRunHours: number;
  // When true, the graceful shutdown handler sells every open/partial
  // position at its current price before closing the DB and exiting. Off
  // by default to preserve current behavior; flip on for live trading and
  // bounded paper sessions where you want a clean PnL at session end.
  closeOnShutdown: boolean;
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

function parseLogLevel(value: string | undefined): LogLevel {
  const normalized = (value ?? 'info').trim().toLowerCase();
  if (['debug', 'info', 'warn', 'error', 'trade'].includes(normalized)) {
    return normalized as LogLevel;
  }
  throw new Error(`Invalid LOG_LEVEL: ${value}`);
}

function parseSource(value: string | undefined): Source {
  const normalized = (value ?? 'raydium').trim().toLowerCase();
  if (normalized === 'raydium' || normalized === 'pump') return normalized;
  throw new Error(`Invalid SOURCE: ${value} (expected 'raydium' or 'pump')`);
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
  // Only the active provider's key is required. Switching providers via
  // AI_PROVIDER shouldn't force the user to also have a key for the one
  // they're not using.
  if (aiProvider === 'anthropic' && !anthropicKey) {
    throw new Error('ANTHROPIC_API_KEY is required when AI_PROVIDER=anthropic');
  }
  if (aiProvider === 'openai' && !openaiKey) {
    throw new Error('OPENAI_API_KEY is required when AI_PROVIDER=openai');
  }

  const config: Config = {
    solanaRpcUrl: process.env.SOLANA_RPC_URL?.trim() || 'https://api.mainnet-beta.solana.com',
    solanaWsUrl: process.env.SOLANA_WS_URL?.trim() || 'wss://api.mainnet-beta.solana.com',
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
    dbPath: process.env.DB_PATH?.trim() || (source === 'pump' ? './pump.db' : './sniper.db'),
    logFile: process.env.LOG_FILE?.trim() || (source === 'pump' ? './pump.log' : null),
    source,
    exitMode: parseExitMode(process.env.EXIT_MODE),
    exitAtMult: numberFromEnv('EXIT_AT_MULT', 2),
    maxRunHours: numberFromEnv('MAX_RUN_HOURS', 0),
    closeOnShutdown: boolFromEnv('CLOSE_ON_SHUTDOWN', false),
    maxHoldMinutes: numberFromEnv('MAX_HOLD_MINUTES', 0),
    bondingCurveCacheMs: numberFromEnv('BONDING_CURVE_CACHE_MS', 5000),
    logMaxBytes: numberFromEnv('LOG_MAX_BYTES', 100 * 1024 * 1024),
    logMaxFiles: numberFromEnv('LOG_MAX_FILES', 5),
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
}

// Reserve for transaction fees. Never spend below this balance.
export const MIN_SOL_RESERVE = 0.01;
