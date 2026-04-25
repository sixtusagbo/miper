import fetch from 'node-fetch';
import { Config, loadConfig } from './config';
import {
  Position,
  getOpenPositions,
  getTradesForPosition,
  recordTrade,
  updatePosition,
} from './db';
import { logger } from './logger';
import { sellToken } from './trader';

const DEXSCREENER_BASE = 'https://api.dexscreener.com';
const DEFAULT_INTERVAL_MS = 7000;
const MIN_FETCH_SPACING_MS = 1000;
const DUST_SOL_THRESHOLD = 1e-8;
const MAX_SELL_RETRIES = 3;

const sellFailureCount = new Map<number, number>();
const lastFetchAt = new Map<string, number>();

interface DexScreenerPair {
  priceNative?: string;
  baseToken?: { address?: string };
}
interface DexScreenerResponse {
  pairs?: DexScreenerPair[] | null;
}

export async function fetchPriceSol(tokenMint: string): Promise<number | null> {
  const last = lastFetchAt.get(tokenMint) ?? 0;
  const wait = MIN_FETCH_SPACING_MS - (Date.now() - last);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastFetchAt.set(tokenMint, Date.now());

  try {
    const res = await fetch(`${DEXSCREENER_BASE}/latest/dex/tokens/${tokenMint}`);
    const json = (await res.json()) as DexScreenerResponse;
    const pair =
      (json.pairs ?? []).find((p) => p.baseToken?.address === tokenMint) ??
      json.pairs?.[0];
    const priceSol = pair?.priceNative ? Number(pair.priceNative) : null;
    return priceSol !== null && Number.isFinite(priceSol) ? priceSol : null;
  } catch (err) {
    logger.debug(`fetchPriceSol ${tokenMint}: ${(err as Error).message}`);
    return null;
  }
}

function sellPctForLevel(cfg: Config, level: 1 | 2 | 3): number {
  if (level === 1) return cfg.sellPctTp1;
  if (level === 2) return cfg.sellPctTp2;
  return cfg.sellPctTp3;
}

function tpMultiplier(cfg: Config, level: 1 | 2 | 3): number {
  if (level === 1) return cfg.takeProfit1;
  if (level === 2) return cfg.takeProfit2;
  return cfg.takeProfit3;
}

async function executePartialSell(
  position: Position,
  tokensToSell: number,
  cfg: Config
): Promise<boolean> {
  // Pass the most recent observed price as a hint. The Raydium path ignores
  // it (Jupiter's outAmount is authoritative), but pump's paper-mode sell
  // uses it instead of the bonding-curve init price so TP and SL exits
  // actually reflect realized PnL.
  const result = await sellToken(
    position.token_mint,
    tokensToSell,
    cfg,
    position.current_price_sol
  );
  if (!result.success) {
    const retries = (sellFailureCount.get(position.id) ?? 0) + 1;
    sellFailureCount.set(position.id, retries);
    logger.warn(
      `Sell failed for position ${position.id} (${position.token_mint}) attempt ${retries}: ${result.error ?? 'unknown'}`
    );
    if (retries >= MAX_SELL_RETRIES) {
      logger.error(
        `Position ${position.id} exceeded ${MAX_SELL_RETRIES} sell retries; manual review needed`
      );
    }
    return false;
  }

  sellFailureCount.delete(position.id);
  recordTrade({
    positionId: position.id,
    type: 'sell',
    amountTokens: tokensToSell,
    amountSol: result.amountOut,
    priceSol: result.pricePerToken,
    txSignature: result.txSignature || null,
    simulated: result.simulated,
  });
  return true;
}

export async function executeTakeProfit(
  position: Position,
  level: 1 | 2 | 3,
  cfg: Config = loadConfig()
): Promise<void> {
  const pct = sellPctForLevel(cfg, level);
  // Size partial sells against the original bag so TP1+TP2+TP3 split the
  // starting position by the configured percentages, not the remaining one.
  const trades = getTradesForPosition(position.id);
  const originalTokens = trades
    .filter((t) => t.type === 'buy')
    .reduce((sum, t) => sum + t.amount_tokens, 0);
  const baseline = originalTokens > 0 ? originalTokens : position.amount_tokens;
  let tokensToSell = level === 3 ? position.amount_tokens : (baseline * pct) / 100;
  tokensToSell = Math.min(tokensToSell, position.amount_tokens);
  if (tokensToSell <= 0) return;

  const sold = await executePartialSell(position, tokensToSell, cfg);
  if (!sold) return;

  const remaining = position.amount_tokens - tokensToSell;
  const tpLabel = level === 1 ? 'TP1' : level === 2 ? 'TP2' : 'TP3';
  logger.position(
    tpLabel,
    position.token_mint,
    `sold ${tokensToSell.toFixed(2)} (${pct}%) at ${tpMultiplier(cfg, level)}x`
  );

  const newTotalReceived = position.amount_sol_received + recentSolReceived(position.id);
  if (level === 3 || remaining <= 0) {
    updatePosition(position.id, {
      amountTokens: 0,
      amountSolReceived: newTotalReceived,
      status: 'closed',
      tpLevel: 3,
    });
    return;
  }

  updatePosition(position.id, {
    amountTokens: remaining,
    amountSolReceived: newTotalReceived,
    status: 'partial',
    tpLevel: level,
  });
}

export async function executeStopLoss(
  position: Position,
  cfg: Config = loadConfig()
): Promise<void> {
  const sold = await executePartialSell(position, position.amount_tokens, cfg);
  if (!sold) return;

  logger.position(
    'STOPLOSS',
    position.token_mint,
    `sold ${position.amount_tokens.toFixed(2)} at ${cfg.stopLoss}x entry`
  );
  updatePosition(position.id, {
    amountTokens: 0,
    amountSolReceived: position.amount_sol_received + recentSolReceived(position.id),
    status: 'stopped',
  });
}

function recentSolReceived(positionId: number): number {
  const trades = getTradesForPosition(positionId);
  for (let i = trades.length - 1; i >= 0; i--) {
    if (trades[i].type === 'sell') return trades[i].amount_sol;
  }
  return 0;
}

export async function checkPosition(
  position: Position,
  cfg: Config = loadConfig()
): Promise<void> {
  if (position.amount_tokens <= 0) return;

  const currentPrice = await fetchPriceSol(position.token_mint);
  if (currentPrice === null) {
    logger.debug(`No price for ${position.token_mint} this cycle`);
    return;
  }

  updatePosition(position.id, { currentPriceSol: currentPrice });

  // Position can go "dust" after partial sells — close it out so we don't keep polling.
  const positionValueSol = currentPrice * position.amount_tokens;
  if (positionValueSol < DUST_SOL_THRESHOLD) {
    logger.info(`Closing dust position ${position.id} (${position.token_mint})`);
    updatePosition(position.id, { status: 'closed', amountTokens: 0 });
    return;
  }

  const multiplier = currentPrice / position.entry_price_sol;

  if (multiplier <= cfg.stopLoss) {
    await executeStopLoss(position, cfg);
    return;
  }

  const currentLevel = position.tp_level;
  if (currentLevel < 3 && multiplier >= cfg.takeProfit3) {
    await executeTakeProfit(position, 3, cfg);
  } else if (currentLevel < 2 && multiplier >= cfg.takeProfit2) {
    await executeTakeProfit(position, 2, cfg);
  } else if (currentLevel < 1 && multiplier >= cfg.takeProfit1) {
    await executeTakeProfit(position, 1, cfg);
  }
}

let monitorTimer: NodeJS.Timeout | null = null;
let monitorRunning = false;

export function startMonitoring(intervalMs: number = DEFAULT_INTERVAL_MS): void {
  if (monitorTimer) return;
  logger.info(`Position monitor started (interval ${intervalMs}ms)`);

  const tick = async () => {
    if (monitorRunning) return;
    monitorRunning = true;
    try {
      const positions = getOpenPositions();
      for (const p of positions) {
        try {
          await checkPosition(p);
        } catch (err) {
          logger.error(`checkPosition ${p.id} failed: ${(err as Error).message}`);
        }
      }
    } finally {
      monitorRunning = false;
    }
  };

  monitorTimer = setInterval(() => {
    tick().catch((err) => logger.error(`monitor tick: ${(err as Error).message}`));
  }, intervalMs);
}

export function stopMonitoring(): void {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
    logger.info('Position monitor stopped');
  }
}
