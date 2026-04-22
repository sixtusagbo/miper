import { Connection, PublicKey } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';
import Anthropic from '@anthropic-ai/sdk';
import fetch from 'node-fetch';
import { Config, loadConfig, SOL_MINT_ADDRESS } from './config';
import { NewPool } from './listener';
import { logger } from './logger';

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
  source: 'dexscreener' | 'pool-fallback';
}

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
    const mintPk = new PublicKey(tokenMint);
    const mintInfo = await getMint(connection, mintPk);
    mintRevoked = mintInfo.mintAuthority === null;
    freezeRevoked = mintInfo.freezeAuthority === null;

    const decimals = mintInfo.decimals;
    const supply = Number(mintInfo.supply) / 10 ** decimals;

    const largest = await connection.getTokenLargestAccounts(mintPk);
    holderCount = largest.value.length;
    if (largest.value.length > 0 && supply > 0) {
      const topAmount = Number(largest.value[0].amount) / 10 ** decimals;
      topHolderPct = (topAmount / supply) * 100;
    }
  } catch (err) {
    failures.push(`on-chain check error: ${(err as Error).message}`);
  }

  if (cfg.requireMintRevoked && !mintRevoked) failures.push('mint authority not revoked');
  if (cfg.requireFreezeRevoked && !freezeRevoked) failures.push('freeze authority not revoked');
  if (topHolderPct > cfg.maxTopHolderPct) {
    failures.push(`top holder owns ${topHolderPct.toFixed(1)}% (max ${cfg.maxTopHolderPct}%)`);
  }
  if (marketLiquidityUsd !== null && marketLiquidityUsd < cfg.minLiquidityUsd) {
    failures.push(`liquidity $${marketLiquidityUsd.toFixed(0)} below min $${cfg.minLiquidityUsd}`);
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

const AI_SYSTEM_PROMPT = `You are a Solana memecoin trading analyst. You evaluate new tokens for quick 2-5x trades.
You are cautious, data-driven, and focused on avoiding rugs. Your job is to score tokens 0-100
based on how likely they are to pump profitably while being safe enough to trade.

SCORING GUIDE:
- 80-100: Strong signals, high confidence. Buy.
- 60-79: Decent signals, moderate risk. Marginal buy.
- 40-59: Mixed signals. Skip unless other factors are compelling.
- 0-39: Red flags. Definite skip.

Respond in exactly this JSON format, no markdown:
{"score": <number 0-100>, "reasoning": "<1-2 sentence explanation>"}`;

function buildUserPrompt(pool: NewPool, market: MarketData, safety: SafetyCheck): string {
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

function clampScore(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

let anthropicClient: Anthropic | null = null;

function getAnthropic(cfg: Config): Anthropic {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey: cfg.anthropicApiKey });
  }
  return anthropicClient;
}

export async function scoreWithAi(
  pool: NewPool,
  market: MarketData,
  safety: SafetyCheck,
  cfg: Config = loadConfig()
): Promise<AiScore> {
  try {
    const client = getAnthropic(cfg);
    logger.debug(`claude: scoring ${pool.tokenMint}`);
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 600,
      system: AI_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserPrompt(pool, market, safety) }],
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    const raw = textBlock && textBlock.type === 'text' ? textBlock.text.trim() : '';
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { score: 0, reasoning: 'no JSON in response', error: 'parse error' };
    }
    const parsed = JSON.parse(jsonMatch[0]) as { score?: number; reasoning?: string };
    return {
      score: clampScore(Number(parsed.score ?? 0)),
      reasoning: String(parsed.reasoning ?? '').slice(0, 400),
    };
  } catch (err) {
    const message = (err as Error).message;
    logger.warn(`AI scoring failed: ${message}`);
    return { score: 0, reasoning: '', error: message };
  }
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export async function analyzeToken(
  connection: Connection,
  pool: NewPool,
  cfg: Config = loadConfig()
): Promise<TokenAnalysis> {
  const market = await fetchMarketData(pool);
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

  const ai = await scoreWithAi(pool, market, safety, cfg);
  const passesAi = ai.score >= cfg.minAiScore;

  return {
    pool,
    safety,
    market,
    ai,
    shouldBuy: passesAi,
    rejectionReason: passesAi
      ? null
      : `ai score ${ai.score} below threshold ${cfg.minAiScore}${ai.reasoning ? `: ${ai.reasoning}` : ''}`,
  };
}
