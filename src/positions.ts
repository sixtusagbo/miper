import fetch from 'node-fetch';
import { Connection } from '@solana/web3.js';
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
import { readBondingCurve } from './bondingCurve';
import { withTimeout, TimeoutError } from './concurrency';

const DEXSCREENER_BASE = 'https://api.dexscreener.com';
// 10s tick is ~70% of the credits a 7s tick burned: each open position
// reads its bonding curve via getAccountInfo, so the interval directly
// scales the dominant RPC cost. Pump price doesn't move fast enough that
// 3 extra seconds materially worsens TP/SL fills in paper-trade mode.
const DEFAULT_INTERVAL_MS = 10_000;
const MIN_FETCH_SPACING_MS = 1000;
const DUST_SOL_THRESHOLD = 1e-8;
const MAX_SELL_RETRIES = 3;
// Per-position cap on the close-on-shutdown price refresh and sell. Protects
// the sweep from hanging indefinitely when DNS or RPC stops responding mid-
// outage (R10b had 50 positions stuck for hours behind unbounded waits).
const SHUTDOWN_PER_POSITION_TIMEOUT_MS = 5000;

const sellFailureCount = new Map<number, number>();
const lastFetchAt = new Map<string, number>();
// Bonding curves that have graduated (complete=true or reserves drained).
// Once we observe a definitive 'graduated' reading from readBondingCurve,
// the curve will never come back, so further getAccountInfo polls every
// 10s for the rest of the position's life are pure waste. Cache only on
// `kind: 'graduated'` — never on `kind: 'unavailable'` (transient RPC
// failures), or one network blip poisons the cache for every open
// position simultaneously.
const graduatedCurves = new Set<string>();

export function clearGraduatedCurves(): void {
  graduatedCurves.clear();
}

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

// Picks the right price source for a position. pump.fun positions read the
// bonding curve directly — DexScreener doesn't index fresh pumps for the
// first 1-2 minutes, which is exactly the window we need to watch for
// TP/SL exits. Once a curve graduates we fall through to DexScreener
// since the token has moved to PumpSwap and lives on aggregators normally.
// Transient RPC failures fall through to DexScreener for THIS tick only
// without caching — the next tick re-tries the curve.
export async function fetchPositionPriceSol(
  position: Position,
  cfg: Config,
  connection: Connection | null
): Promise<number | null> {
  if (
    cfg.source === 'pump' &&
    connection &&
    position.pool_address &&
    !graduatedCurves.has(position.pool_address)
  ) {
    const reading = await readBondingCurve(connection, position.pool_address);
    if (reading.kind === 'price') return reading.priceSol;
    if (reading.kind === 'graduated') {
      graduatedCurves.add(position.pool_address);
      logger.debug(
        `bonding curve graduated for ${position.token_mint}, falling back to DexScreener`
      );
    } else {
      logger.debug(
        `bonding curve unavailable for ${position.token_mint} (transient), falling back to DexScreener for this tick`
      );
    }
  }
  return fetchPriceSol(position.token_mint);
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
  cfg: Config = loadConfig(),
  connection: Connection | null = null
): Promise<void> {
  if (position.amount_tokens <= 0) return;

  const currentPrice = await fetchPositionPriceSol(position, cfg, connection);
  if (currentPrice === null) {
    logger.debug(`No price for ${position.token_mint} this cycle`);
    return;
  }

  updatePosition(position.id, { currentPriceSol: currentPrice });
  // Keep the in-memory copy in sync so downstream sells (TP/SL) see the
  // freshly observed price, not the stale value the tick started with.
  // Without this, a TP triggered on the first successful price fetch would
  // pass the entry price into pumpSell and book the exit at zero PnL.
  position.current_price_sol = currentPrice;

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

  // All-in mode collapses the three-tier TP into a single full-bag exit at
  // EXIT_AT_MULT. The 'compound small profits' thesis from miper-spec.md §1
  // — frequent 2x exits beat rare 5x outliers — is what this mode tests.
  if (cfg.exitMode === 'all-in') {
    if (multiplier >= cfg.exitAtMult) {
      await executeAllInExit(position, cfg);
    }
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

// Sells the entire remaining bag at the all-in target. Distinct from
// executeStopLoss (which marks 'stopped' for review.ts to count as a loss)
// and executeTakeProfit (which handles the partial 40/30/30 ladder).
export async function executeAllInExit(
  position: Position,
  cfg: Config = loadConfig()
): Promise<void> {
  const sold = await executePartialSell(position, position.amount_tokens, cfg);
  if (!sold) return;

  logger.position(
    'TP3', // Re-using the TP3 label for parity with tiered logs; renaming
           // would force a log-format break. The DB tp_level=3 below makes
           // intent explicit.
    position.token_mint,
    `all-in exit: sold ${position.amount_tokens.toFixed(2)} at ${cfg.exitAtMult}x`
  );
  updatePosition(position.id, {
    amountTokens: 0,
    amountSolReceived: position.amount_sol_received + recentSolReceived(position.id),
    status: 'closed',
    tpLevel: 3,
  });
}

let monitorTimer: NodeJS.Timeout | null = null;
let monitorRunning = false;
let monitorConnection: Connection | null = null;

// Caller (the snipe command) hands in the Connection it already built so
// pump positions can read their bonding curves without us standing up a
// second RPC client just for this loop.
export function startMonitoring(
  intervalMs: number = DEFAULT_INTERVAL_MS,
  connection: Connection | null = null
): void {
  if (monitorTimer) return;
  monitorConnection = connection;
  logger.info(`Position monitor started (interval ${intervalMs}ms)`);

  const tick = async () => {
    if (monitorRunning) return;
    monitorRunning = true;
    try {
      const positions = getOpenPositions();
      for (const p of positions) {
        try {
          await checkPosition(p, undefined, monitorConnection);
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

// Sells every open/partial position at its last-known price. Called from
// the snipe-command shutdown handler when CLOSE_ON_SHUTDOWN=true so we
// don't leak open exposure across sessions. Best-effort: a single failed
// sell logs an error but doesn't block the rest. Each price refresh and
// sell is wrapped in a per-position timeout so a network outage can't
// stall the whole sweep — on timeout we fall back to the DB-stored
// last-known price and proceed with the close.
export async function closeAllOpenPositions(
  cfg: Config = loadConfig(),
  connection: Connection | null = null,
  perPositionTimeoutMs: number = SHUTDOWN_PER_POSITION_TIMEOUT_MS
): Promise<{ closed: number; failed: number }> {
  let closed = 0;
  let failed = 0;
  const positions = getOpenPositions();
  if (positions.length === 0) return { closed, failed };
  logger.info(`closing ${positions.length} open/partial positions for shutdown...`);
  for (const p of positions) {
    if (p.amount_tokens <= 0) continue;
    try {
      const livePrice = await tryRefreshPriceWithTimeout(
        p,
        cfg,
        connection,
        perPositionTimeoutMs
      );
      if (livePrice !== null) {
        updatePosition(p.id, { currentPriceSol: livePrice });
        p.current_price_sol = livePrice;
      }
      const sold = await tryPartialSellWithTimeout(
        p,
        p.amount_tokens,
        cfg,
        perPositionTimeoutMs
      );
      if (!sold) {
        failed++;
        continue;
      }
      const finalReceived = p.amount_sol_received + recentSolReceived(p.id);
      updatePosition(p.id, {
        amountTokens: 0,
        amountSolReceived: finalReceived,
        status: 'closed',
      });
      logger.position(
        'SELL',
        p.token_mint,
        `shutdown close: ${p.amount_tokens.toFixed(2)} tokens at last price`
      );
      closed++;
    } catch (err) {
      logger.error(`shutdown close failed for ${p.id}: ${(err as Error).message}`);
      failed++;
    }
  }
  return { closed, failed };
}

async function tryRefreshPriceWithTimeout(
  p: Position,
  cfg: Config,
  connection: Connection | null,
  timeoutMs: number
): Promise<number | null> {
  try {
    return await withTimeout(
      fetchPositionPriceSol(p, cfg, connection),
      timeoutMs,
      `shutdown price refresh ${p.token_mint}`
    );
  } catch (err) {
    if (err instanceof TimeoutError) {
      logger.debug(
        `shutdown price refresh timed out for ${p.token_mint}; using last-known ${p.current_price_sol}`
      );
      return null;
    }
    throw err;
  }
}

async function tryPartialSellWithTimeout(
  p: Position,
  tokensToSell: number,
  cfg: Config,
  timeoutMs: number
): Promise<boolean> {
  try {
    return await withTimeout(
      executePartialSell(p, tokensToSell, cfg),
      timeoutMs,
      `shutdown sell ${p.token_mint}`
    );
  } catch (err) {
    if (err instanceof TimeoutError) {
      logger.warn(
        `shutdown sell timed out for ${p.token_mint}; leaving position open for review`
      );
      return false;
    }
    throw err;
  }
}

export function stopMonitoring(): void {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
    monitorConnection = null;
    logger.info('Position monitor stopped');
  }
}
