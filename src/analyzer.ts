import { Connection, PublicKey } from '@solana/web3.js';
import {
  getMint,
  TOKEN_2022_PROGRAM_ID,
  TokenInvalidAccountOwnerError,
} from '@solana/spl-token';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import fetch from 'node-fetch';
import { Config, loadConfig, SOL_MINT_ADDRESS } from './config';
import { NewPool } from './listener';
import { logger } from './logger';
import { retry } from './concurrency';
import { fetchTokenMetadata } from './metadata';
import { fetchCreatorHistory } from './creatorHistory';

// Fresh mints often aren't visible to every RPC node for a second or two
// after creation. We sleep before the first getMint call so the common path
// uses one RPC round-trip instead of burning attempts on the propagation
// race, and fall back to retry for the stragglers. 400ms proved too short
// on real pump.fun traffic (~74% of tokens still hit TokenAccountNotFound),
// so the default is now 1500ms with a 500/1000/1500ms retry ramp on top.
// The env var is read per-call so tests can zero it out without monkey-
// patching module state.
const SAFETY_PRE_READ_DELAY_DEFAULT_MS = 1500;
const SAFETY_RETRY_ATTEMPTS = 3;
const SAFETY_RETRY_BASE_MS = 500;

function getSafetyPreReadDelayMs(): number {
  const raw = process.env.MIPER_SAFETY_PRE_READ_DELAY_MS;
  if (raw !== undefined && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return SAFETY_PRE_READ_DELAY_DEFAULT_MS;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Pump.fun mints are Token-2022, not the classic SPL Token program, so
// getMint's default programId bounces with TokenInvalidAccountOwnerError.
// Try the default first (cheap happy path for Raydium / legacy mints) and
// fall back to Token-2022 only on that specific error.
async function getMintAcrossPrograms(connection: Connection, mintPk: PublicKey) {
  try {
    return await getMint(connection, mintPk);
  } catch (err) {
    if (err instanceof TokenInvalidAccountOwnerError) {
      return await getMint(connection, mintPk, undefined, TOKEN_2022_PROGRAM_ID);
    }
    throw err;
  }
}

export interface SafetyCheck {
  mintRevoked: boolean;
  freezeRevoked: boolean;
  topHolderPct: number;
  holderCount: number;
  passed: boolean;
  failures: string[];
}

export interface MarketData {
  symbol: string | null;
  name: string | null;
  priceUsd: number | null;
  priceSol: number | null;
  liquidityUsd: number | null;
  liquiditySol: number | null;
  marketCapUsd: number | null;
  volume24hUsd: number | null;
  supply: number | null;
  source: 'dexscreener' | 'pool-fallback' | 'pump-curve';
}

// Pump.fun bonding curve initial virtual reserves (from the program's `global`
// account): ~30 virtual SOL against ~1.073B virtual tokens at launch.
// Price = virtual_sol / virtual_tokens ≈ 2.8e-8 SOL per token at t=0.
const PUMP_VIRTUAL_SOL_RESERVES = 30;
const PUMP_VIRTUAL_TOKEN_RESERVES = 1_073_000_000;
export const PUMP_INITIAL_PRICE_SOL =
  PUMP_VIRTUAL_SOL_RESERVES / PUMP_VIRTUAL_TOKEN_RESERVES;
const PUMP_TOTAL_SUPPLY = 1_000_000_000;

export interface AiScore {
  score: number;
  reasoning: string;
  error?: string;
}

export interface TokenAnalysis {
  pool: NewPool;
  safety: SafetyCheck;
  market: MarketData;
  ai: AiScore;
  shouldBuy: boolean;
  rejectionReason: string | null;
}

// Compact USD formatter: $52, $5k, $1.2M. Keeps safety-failure messages
// readable when thresholds are configured as raw dollar amounts.
function fmtUsd(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (abs >= 1_000) return `$${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  return `$${n.toFixed(0)}`;
}

// ---------------------------------------------------------------------------
// Stage 1: on-chain safety checks
// ---------------------------------------------------------------------------

export async function runSafetyChecks(
  connection: Connection,
  tokenMint: string,
  marketLiquidityUsd: number | null,
  cfg: Config
): Promise<SafetyCheck> {
  const failures: string[] = [];
  let mintRevoked = false;
  let freezeRevoked = false;
  let topHolderPct = 100;
  let holderCount = 0;

  try {
    await sleep(getSafetyPreReadDelayMs());
    const mintPk = new PublicKey(tokenMint);
    const mintInfo = await retry(() => getMintAcrossPrograms(connection, mintPk), {
      attempts: SAFETY_RETRY_ATTEMPTS,
      baseDelayMs: SAFETY_RETRY_BASE_MS,
      label: `getMint ${tokenMint.slice(0, 8)}`,
    });
    mintRevoked = mintInfo.mintAuthority === null;
    freezeRevoked = mintInfo.freezeAuthority === null;

    const decimals = mintInfo.decimals;
    const supply = Number(mintInfo.supply) / 10 ** decimals;

    // Skip holder distribution for pump.fun. The RPC's getTokenLargestAccounts
    // throws "Invalid param: not a Token mint" on Token-2022 accounts, and we
    // already don't gate pump tokens on top-holder percentage (the bonding
    // curve PDA holds ~100% at launch by design).
    if (cfg.source !== 'pump') {
      const largest = await retry(() => connection.getTokenLargestAccounts(mintPk), {
        attempts: SAFETY_RETRY_ATTEMPTS,
        baseDelayMs: SAFETY_RETRY_BASE_MS,
        label: `getTokenLargestAccounts ${tokenMint.slice(0, 8)}`,
      });
      holderCount = largest.value.length;
      if (largest.value.length > 0 && supply > 0) {
        const topAmount = Number(largest.value[0].amount) / 10 ** decimals;
        topHolderPct = (topAmount / supply) * 100;
      }
    }
  } catch (err) {
    const e = err as Error;
    // SPL's TokenAccountNotFoundError ships with an empty message and all the
    // signal in `.name` — log both so the rejection reason is actually useful.
    const detail = e.message || e.name || 'empty error';
    failures.push(`on-chain check error: ${detail}`);
  }

  if (cfg.requireMintRevoked && !mintRevoked) failures.push('mint authority not revoked');
  if (cfg.requireFreezeRevoked && !freezeRevoked) failures.push('freeze authority not revoked');
  // Pump.fun tokens always start with ~100% of supply in the bonding-curve PDA
  // and near-zero external liquidity — the Raydium-era thresholds would reject
  // every single launch. For pump sources we lean on AI scoring + mint/freeze
  // revocation instead.
  const isPump = cfg.source === 'pump';
  if (!isPump && topHolderPct > cfg.maxTopHolderPct) {
    failures.push(`top holder owns ${topHolderPct.toFixed(1)}% (max ${cfg.maxTopHolderPct}%)`);
  }
  if (!isPump && marketLiquidityUsd !== null && marketLiquidityUsd < cfg.minLiquidityUsd) {
    failures.push(
      `liquidity ${fmtUsd(marketLiquidityUsd)} (below min ${fmtUsd(cfg.minLiquidityUsd)})`
    );
  }

  return {
    mintRevoked,
    freezeRevoked,
    topHolderPct,
    holderCount,
    passed: failures.length === 0,
    failures,
  };
}

// ---------------------------------------------------------------------------
// Stage 2: DexScreener market data
// ---------------------------------------------------------------------------

interface DexScreenerPair {
  chainId?: string;
  dexId?: string;
  baseToken?: { address?: string; symbol?: string; name?: string };
  quoteToken?: { address?: string; symbol?: string };
  priceUsd?: string;
  priceNative?: string;
  liquidity?: { usd?: number; base?: number; quote?: number };
  fdv?: number;
  marketCap?: number;
  volume?: { h24?: number };
}

interface DexScreenerResponse {
  pairs?: DexScreenerPair[] | null;
}

const DEXSCREENER_BASE = 'https://api.dexscreener.com';
const SOL_USD_CACHE_MS = 60_000;
let solUsdCache: { price: number; at: number } | null = null;

export async function getSolUsdPrice(): Promise<number | null> {
  if (solUsdCache && Date.now() - solUsdCache.at < SOL_USD_CACHE_MS) {
    return solUsdCache.price;
  }
  try {
    const res = await fetch(`${DEXSCREENER_BASE}/latest/dex/tokens/${SOL_MINT_ADDRESS}`);
    const json = (await res.json()) as DexScreenerResponse;
    const pair = (json.pairs ?? []).find((p) => p.quoteToken?.symbol === 'USDC') ?? json.pairs?.[0];
    const price = pair?.priceUsd ? Number(pair.priceUsd) : null;
    if (price && Number.isFinite(price)) {
      solUsdCache = { price, at: Date.now() };
      return price;
    }
  } catch (err) {
    logger.debug(`getSolUsdPrice failed: ${(err as Error).message}`);
  }
  return solUsdCache?.price ?? null;
}

// Fresh pump.fun tokens rarely show up on DexScreener in the first few minutes,
// so we synthesize market data from the program's known initial bonding-curve
// state and any SOL the creator co-deposited in the create tx.
export function pumpMarketData(pool: NewPool): MarketData {
  return {
    symbol: null,
    name: null,
    priceUsd: null,
    priceSol: PUMP_INITIAL_PRICE_SOL,
    liquidityUsd: null,
    liquiditySol: pool.initialLiquiditySol,
    marketCapUsd: null,
    volume24hUsd: null,
    supply: PUMP_TOTAL_SUPPLY,
    source: 'pump-curve',
  };
}

export async function fetchMarketData(pool: NewPool): Promise<MarketData> {
  try {
    logger.debug(`dexscreener: fetching ${pool.tokenMint}`);
    const res = await fetch(`${DEXSCREENER_BASE}/latest/dex/tokens/${pool.tokenMint}`);
    const json = (await res.json()) as DexScreenerResponse;
    const pairs = json.pairs ?? [];
    const pair =
      pairs.find((p) => p.baseToken?.address === pool.tokenMint) ??
      pairs[0];

    if (pair) {
      return {
        symbol: pair.baseToken?.symbol ?? null,
        name: pair.baseToken?.name ?? null,
        priceUsd: pair.priceUsd ? Number(pair.priceUsd) : null,
        priceSol: pair.priceNative ? Number(pair.priceNative) : null,
        liquidityUsd: pair.liquidity?.usd ?? null,
        liquiditySol: pair.liquidity?.quote ?? null,
        marketCapUsd: pair.marketCap ?? pair.fdv ?? null,
        volume24hUsd: pair.volume?.h24 ?? null,
        supply: null,
        source: 'dexscreener',
      };
    }
  } catch (err) {
    logger.debug(`fetchMarketData failed: ${(err as Error).message}`);
  }

  // Fallback: estimate from the pool's initial liquidity
  const solUsd = await getSolUsdPrice();
  const liquidityUsd = solUsd ? pool.initialLiquiditySol * solUsd * 2 : null;
  return {
    symbol: null,
    name: null,
    priceUsd: null,
    priceSol: null,
    liquidityUsd,
    liquiditySol: pool.initialLiquiditySol,
    marketCapUsd: null,
    volume24hUsd: null,
    supply: null,
    source: 'pool-fallback',
  };
}

// ---------------------------------------------------------------------------
// Stage 3: Claude AI scoring
// ---------------------------------------------------------------------------

const RAYDIUM_AI_SYSTEM_PROMPT = `You are a Solana memecoin trading analyst. You evaluate new tokens for quick 2-5x trades.
You are cautious, data-driven, and focused on avoiding rugs. Your job is to score tokens 0-100
based on how likely they are to pump profitably while being safe enough to trade.

SCORING GUIDE:
- 80-100: Strong signals, high confidence. Buy.
- 60-79: Decent signals, moderate risk. Marginal buy.
- 40-59: Mixed signals. Skip unless other factors are compelling.
- 0-39: Red flags. Definite skip.

Respond in exactly this JSON format, no markdown:
{"score": <number 0-100>, "reasoning": "<1-2 sentence explanation>"}`;

// Pump.fun scoring is RELATIVE to typical pump launches, not to some ideal
// safe token. Every fresh pump.fun mint has 100% concentration in the
// bonding-curve PDA, seconds of age, and sub-10-SOL liquidity by design —
// those are structural invariants, not per-token red flags. Claude's job here
// is to identify launches that are ABOVE AVERAGE for pump.fun based on
// dev commitment, creator track record, and metadata effort.
const PUMP_AI_SYSTEM_PROMPT = `You are a Solana memecoin trading analyst specializing in pump.fun launches.

IMPORTANT CONTEXT: every pump.fun token launches with these baseline conditions:
- 100% of supply held by the bonding-curve PDA at t=0 (this is how pump.fun works)
- Pool age < 1 minute (you only see them seconds after launch)
- Liquidity < 10 SOL at launch (the bonding curve starts with ~30 SOL virtual reserves)

DO NOT penalize these baseline facts — they are the same for every launch and carry zero differentiating signal. Your job is to score RELATIVE to typical pump.fun launches, looking for the ~1% of launches that differentiate themselves on real signals.

SIGNALS THAT MATTER (in descending order of importance):
1. Dev commitment — how much SOL did the creator co-deposit in the create tx? Minimum launch is ~0.03 SOL. A 2+ SOL initial buy signals skin in the game.
2. Creator track record — is this a fresh disposable wallet (<1 day old, <5 prior txs) or an aged active wallet? Brand-new wallets are the overwhelming signature of rug-launchers. Aged wallets are marginally reassuring.
3. Metadata effort — does the token have a real name/symbol, or placeholder trash? Does the URI look like a real hosted JSON vs garbage?
4. Mint address vanity — addresses ending in "pump" are vanity-ground (takes some compute); raw random addresses suggest less effort.

SCORING GUIDE (relative to typical pump launches):
- 80-100: Standout launch — aged creator with history + large dev buy + quality metadata. Rare. Buy.
- 60-79: Above-average on 1-2 signals. Marginal buy depending on threshold.
- 40-59: Typical pump launch. Nothing differentiates it either way. Skip.
- 0-39: Worse than typical (e.g. metadata is literally empty, or creator has visible recent rug pattern). Skip.

Respond in exactly this JSON format, no markdown:
{"score": <number 0-100>, "reasoning": "<1-2 sentence explanation citing the specific signals you weighted>"}`;

export interface PumpSignalContext {
  metadata: { name: string; symbol: string; uri: string } | null;
  creator: {
    address: string | null;
    totalRecentTxs: number;
    oldestActivityDaysAgo: number | null;
  };
}

function buildRaydiumUserPrompt(pool: NewPool, market: MarketData, safety: SafetyCheck): string {
  const ageMinutes = Math.max(0, (Date.now() / 1000 - pool.timestamp) / 60);
  return `Analyze this new Solana memecoin for a quick snipe trade (target 2-5x, small position).

TOKEN DATA:
- Mint: ${pool.tokenMint}
- Symbol: ${market.symbol ?? 'unknown'}
- Name: ${market.name ?? 'unknown'}
- Price: ${market.priceUsd !== null ? `$${market.priceUsd}` : 'unknown'} (${market.priceSol ?? 'unknown'} SOL)
- Market Cap: ${market.marketCapUsd !== null ? `$${market.marketCapUsd.toFixed(0)}` : 'unknown'}
- Liquidity: ${market.liquiditySol ?? 'unknown'} SOL (${market.liquidityUsd !== null ? `$${market.liquidityUsd.toFixed(0)}` : 'unknown'})
- 24h Volume: ${market.volume24hUsd !== null ? `$${market.volume24hUsd.toFixed(0)}` : 'unknown'}
- Supply: ${market.supply ?? 'unknown'}

SAFETY:
- Mint Authority Revoked: ${safety.mintRevoked}
- Freeze Authority Revoked: ${safety.freezeRevoked}
- Top Holder %: ${safety.topHolderPct.toFixed(1)}%
- Holder Count: ${safety.holderCount}
- LP Burned: unknown

POOL:
- Pool Address: ${pool.poolAddress}
- Initial Liquidity: ${pool.initialLiquiditySol.toFixed(3)} SOL
- Pool Age: ${ageMinutes.toFixed(1)} minutes

Score this token 0-100 for a quick 2-5x snipe trade. Consider rug risk, liquidity depth, holder distribution, and potential for a pump.`;
}

function buildPumpUserPrompt(pool: NewPool, ctx: PumpSignalContext): string {
  const md = ctx.metadata;
  const creatorLine = ctx.creator.address
    ? `${ctx.creator.address} (${ctx.creator.totalRecentTxs} recent txs, ${ctx.creator.oldestActivityDaysAgo !== null ? `oldest activity ${ctx.creator.oldestActivityDaysAgo.toFixed(1)} days ago` : 'no visible history'})`
    : 'unknown';
  const mintVanity = pool.tokenMint.toLowerCase().endsWith('pump')
    ? "yes (ends in 'pump')"
    : 'no (raw random address)';
  return `Score this pump.fun launch relative to typical pump.fun launches.

CREATOR:
- Address: ${creatorLine}

DEV COMMITMENT:
- Initial SOL deposit in create tx: ${pool.initialLiquiditySol.toFixed(3)} SOL

METADATA:
- Name: ${md?.name ? `"${md.name}"` : 'MISSING'}
- Symbol: ${md?.symbol ? `"${md.symbol}"` : 'MISSING'}
- URI: ${md?.uri ? md.uri : 'MISSING'}

MINT:
- Address: ${pool.tokenMint}
- Vanity-ground: ${mintVanity}

Apply the relative scoring rubric. Cite the specific signals you weighted in your reasoning.`;
}

function clampScore(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

let anthropicClient: Anthropic | null = null;
let openaiClient: OpenAI | null = null;

function getAnthropic(cfg: Config): Anthropic {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey: cfg.anthropicApiKey });
  }
  return anthropicClient;
}

function getOpenAI(cfg: Config): OpenAI {
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey: cfg.openaiApiKey });
  }
  return openaiClient;
}

// Test seam: vitest's vi.mock loads our mock for the OpenAI module before
// this module imports it, but the cached client survives across tests because
// it's module-level state. Reset it explicitly when the mock is reset so each
// test gets a fresh constructor call.
export function resetAiClientCache(): void {
  anthropicClient = null;
  openaiClient = null;
}

// GPT-5 family models default to higher reasoning effort which silently
// inflates output tokens (a 150-token JSON response can balloon to 1500+).
// For structured scoring we want minimal reasoning — this saves both cost
// and latency. Older models (4o, 4.1) ignore the parameter cleanly.
function isReasoningModel(model: string): boolean {
  return /^(gpt-5|o1|o3)/i.test(model);
}

interface ParsedScore {
  score: number;
  reasoning: string;
}

function parseScoreJson(raw: string): ParsedScore | null {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    const parsed = JSON.parse(jsonMatch[0]) as { score?: number; reasoning?: string };
    return {
      score: clampScore(Number(parsed.score ?? 0)),
      reasoning: String(parsed.reasoning ?? '').slice(0, 400),
    };
  } catch {
    return null;
  }
}

async function scoreWithAnthropic(
  cfg: Config,
  systemPrompt: string,
  userPrompt: string,
  tokenMint: string
): Promise<AiScore> {
  const client = getAnthropic(cfg);
  // cache_control is set on the system prompt so identical-prefix requests
  // within the 5-min TTL pay 0.1x for the cached portion. Note: Haiku 4.5's
  // minimum cacheable prefix is 4096 tokens; our prompts are ~450-700, so
  // the marker silently no-ops today. Kept here so caching activates if/when
  // the system prompt is later expanded with examples.
  const response = await client.messages.create({
    model: cfg.aiModel,
    max_tokens: 600,
    system: [
      {
        type: 'text',
        text: systemPrompt,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content: userPrompt }],
  });
  const usage = (response.usage ?? {}) as {
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    input_tokens?: number;
  };
  logger.debug(
    `anthropic usage ${tokenMint}: input=${usage.input_tokens ?? 0} cache_write=${usage.cache_creation_input_tokens ?? 0} cache_read=${usage.cache_read_input_tokens ?? 0}`
  );

  const textBlock = response.content.find((b) => b.type === 'text');
  const raw = textBlock && textBlock.type === 'text' ? textBlock.text.trim() : '';
  const parsed = parseScoreJson(raw);
  if (!parsed) return { score: 0, reasoning: 'no JSON in response', error: 'parse error' };
  return parsed;
}

async function scoreWithOpenAI(
  cfg: Config,
  systemPrompt: string,
  userPrompt: string,
  tokenMint: string
): Promise<AiScore> {
  const client = getOpenAI(cfg);
  // response_format json_object guarantees the output parses as JSON.
  // For reasoning models (gpt-5*), pin reasoning_effort=minimal so we don't
  // silently pay 5-10x in output tokens for hidden chain-of-thought we
  // don't read.
  const params: Parameters<typeof client.chat.completions.create>[0] = {
    model: cfg.aiModel,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    response_format: { type: 'json_object' },
    max_completion_tokens: 600,
  };
  if (isReasoningModel(cfg.aiModel)) {
    (params as unknown as Record<string, unknown>).reasoning_effort = 'minimal';
  }
  const response = await client.chat.completions.create(params);

  // Stream events would land in delta.content; we use non-streaming so
  // the full text is on choices[0].message.content.
  const completion = response as OpenAI.Chat.ChatCompletion;
  const usage = completion.usage as
    | { prompt_tokens?: number; completion_tokens?: number }
    | undefined;
  logger.debug(
    `openai usage ${tokenMint}: input=${usage?.prompt_tokens ?? 0} output=${usage?.completion_tokens ?? 0}`
  );

  const raw = completion.choices?.[0]?.message?.content?.trim() ?? '';
  const parsed = parseScoreJson(raw);
  if (!parsed) return { score: 0, reasoning: 'no JSON in response', error: 'parse error' };
  return parsed;
}

export async function scoreWithAi(
  pool: NewPool,
  market: MarketData,
  safety: SafetyCheck,
  cfg: Config = loadConfig(),
  pumpCtx: PumpSignalContext | null = null
): Promise<AiScore> {
  try {
    logger.debug(`${cfg.aiProvider}/${cfg.aiModel}: scoring ${pool.tokenMint}`);
    const isPump = cfg.source === 'pump' && pumpCtx !== null;
    const systemPrompt = isPump ? PUMP_AI_SYSTEM_PROMPT : RAYDIUM_AI_SYSTEM_PROMPT;
    const userPrompt = isPump
      ? buildPumpUserPrompt(pool, pumpCtx)
      : buildRaydiumUserPrompt(pool, market, safety);
    const result =
      cfg.aiProvider === 'anthropic'
        ? await scoreWithAnthropic(cfg, systemPrompt, userPrompt, pool.tokenMint)
        : await scoreWithOpenAI(cfg, systemPrompt, userPrompt, pool.tokenMint);
    if (result.error) return result;
    logger.info(`AI scored ${pool.tokenMint}: ${result.score}/100 — ${result.reasoning}`);
    return result;
  } catch (err) {
    const message = (err as Error).message;
    logger.warn(`AI scoring failed for ${pool.tokenMint}: ${message}`);
    return { score: 0, reasoning: '', error: message };
  }
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

async function buildPumpContext(
  connection: Connection,
  pool: NewPool
): Promise<PumpSignalContext> {
  // Metadata and creator history are independent reads — fetch in parallel
  // so we don't stack two round-trips onto the already-painful pump analysis
  // latency. Each settles independently; a failure turns into "unknown" in
  // the prompt rather than blocking the analysis.
  const [metadata, creatorHistory] = await Promise.all([
    fetchTokenMetadata(connection, pool.tokenMint),
    pool.creator
      ? fetchCreatorHistory(connection, pool.creator)
      : Promise.resolve({
          totalRecentTxs: 0,
          oldestActivityDaysAgo: null,
          fetchedAt: Date.now(),
        }),
  ]);
  return {
    metadata,
    creator: {
      address: pool.creator,
      totalRecentTxs: creatorHistory.totalRecentTxs,
      oldestActivityDaysAgo: creatorHistory.oldestActivityDaysAgo,
    },
  };
}

export async function analyzeToken(
  connection: Connection,
  pool: NewPool,
  cfg: Config = loadConfig()
): Promise<TokenAnalysis> {
  const market = cfg.source === 'pump' ? pumpMarketData(pool) : await fetchMarketData(pool);
  const safety = await runSafetyChecks(connection, pool.tokenMint, market.liquidityUsd, cfg);

  if (!safety.passed) {
    return {
      pool,
      safety,
      market,
      ai: { score: 0, reasoning: 'safety checks failed' },
      shouldBuy: false,
      rejectionReason: `safety: ${safety.failures.join('; ')}`,
    };
  }

  const pumpCtx = cfg.source === 'pump' ? await buildPumpContext(connection, pool) : null;
  const ai = await scoreWithAi(pool, market, safety, cfg, pumpCtx);
  const passesAi = ai.score >= cfg.minAiScore;

  return {
    pool,
    safety,
    market,
    ai,
    shouldBuy: passesAi,
    rejectionReason: passesAi
      ? null
      : `below threshold ${cfg.minAiScore}${ai.reasoning ? ` — ${ai.reasoning}` : ''}`,
  };
}
