#!/usr/bin/env node
import { Command } from 'commander';
import { Connection } from '@solana/web3.js';
import chalk from 'chalk';
import { loadConfig, resetConfigCache } from './config';
import { logger } from './logger';
import {
  countOpenPositions,
  createPosition,
  getDb,
  getOpenPositions,
  getPnlSummary,
  getPosition,
  getTradesForPosition,
  isTokenKnown,
  recordRejection,
  recordTrade,
  updatePosition,
  closeDb,
} from './db';
import { PoolListener, PumpListener, LogListener } from './listener';
import { analyzeToken } from './analyzer';
import { buyToken, getTokenBalance, getWallet, getWalletBalance, sellToken } from './trader';
import { startMonitoring, stopMonitoring } from './positions';
import { InflightGate, withTimeout } from './concurrency';
import { reviewCommand } from './review';

// Cap concurrent analyses. Free-tier RPCs (Helius: 10 req/s) survive easily
// with this limit since each analysis makes ~3 RPC calls.
const MAX_CONCURRENT_ANALYSES = 3;
// Hard cap on a single pool's analyze pipeline (DexScreener + RPC + Claude).
// If Claude is slow or DexScreener hangs, we give up rather than stall.
const ANALYSIS_TIMEOUT_MS = 20_000;
// How often the snipe command prints a rolling status summary during a run.
const STATUS_PRINT_INTERVAL_MS = 15 * 60 * 1000;

function printBanner(): void {
  const cfg = loadConfig();
  logger.banner(`MIPER ${cfg.simulate ? '(SIMULATION)' : '(LIVE)'} — source: ${cfg.source}`);
  logger.info(
    `buy ${cfg.buyAmountSol} SOL | TPs ${cfg.takeProfit1}x/${cfg.takeProfit2}x/${cfg.takeProfit3}x | SL ${cfg.stopLoss}x | min AI score ${cfg.minAiScore}`
  );
  logger.info(
    `min liq $${cfg.minLiquidityUsd} | max top holder ${cfg.maxTopHolderPct}% | slippage ${cfg.maxSlippageBps}bps`
  );
  logger.info(`db: ${cfg.dbPath}${cfg.logFile ? ` | log file: ${cfg.logFile}` : ''}`);
}

function applyCliFlags(options: { simulate?: boolean; source?: string }): void {
  if (options.simulate) process.env.SIMULATE = 'true';
  if (options.source) {
    const normalized = options.source.trim().toLowerCase();
    if (normalized !== 'raydium' && normalized !== 'pump') {
      throw new Error(`--source must be 'raydium' or 'pump', got '${options.source}'`);
    }
    process.env.SOURCE = normalized;
    // An explicit --source takes ownership of path defaults. Without this,
    // stale shell env (e.g. DB_PATH=./sniper.db exported from a previous
    // Raydium session) silently routes pump work into the wrong DB/log.
    delete process.env.DB_PATH;
    delete process.env.LOG_FILE;
  }
  // Config is cached; reset so the new env wins when loadConfig() is next called.
  resetConfigCache();
}

async function snipeCommand(options: {
  simulate?: boolean;
  source?: string;
}): Promise<void> {
  applyCliFlags(options);
  const cfg = loadConfig();
  printBanner();

  // Wallet
  try {
    const wallet = getWallet(cfg);
    logger.info(`wallet: ${wallet.publicKey.toBase58()}`);
    if (!cfg.simulate || cfg.walletPrivateKey) {
      const balance = await getWalletBalance(cfg);
      logger.info(`balance: ${balance.toFixed(4)} SOL`);
    }
  } catch (err) {
    logger.error(`wallet load failed: ${(err as Error).message}`);
    process.exit(1);
  }

  getDb(); // init schema

  const connection = new Connection(cfg.solanaRpcUrl, {
    commitment: 'confirmed',
    wsEndpoint: cfg.solanaWsUrl,
  });
  const listener: LogListener =
    cfg.source === 'pump' ? new PumpListener(connection) : new PoolListener(connection);
  const gate = new InflightGate(MAX_CONCURRENT_ANALYSES);
  // Guards against the same mint being analyzed by concurrent events (multiple
  // init signatures for one pool, or replay after reconnect). Without this,
  // several analyses for one mint hit Claude in parallel and trigger 429s.
  const inflightMints = new Set<string>();

  listener.on('newPool', async (pool) => {
    if (inflightMints.has(pool.tokenMint)) {
      logger.debug(`already analyzing ${pool.tokenMint}, skipping duplicate`);
      return;
    }
    if (isTokenKnown(pool.tokenMint)) {
      logger.debug(`already seen ${pool.tokenMint}, skipping`);
      return;
    }
    if (!gate.tryAcquire()) {
      logger.debug(
        `analyzer busy (${gate.inflight}/${gate.capacity} in-flight), skipping ${pool.tokenMint}`
      );
      return;
    }
    inflightMints.add(pool.tokenMint);
    try {
      if (countOpenPositions() >= cfg.maxOpenPositions) {
        logger.debug(`max open positions (${cfg.maxOpenPositions}) reached, skipping`);
        return;
      }

      logger.info(`analyzing ${pool.tokenMint}...`);
      const analysis = await withTimeout(
        analyzeToken(connection, pool, cfg),
        ANALYSIS_TIMEOUT_MS,
        `analyze ${pool.tokenMint}`
      );

      if (!analysis.shouldBuy) {
        logger.info(
          `skipping ${pool.tokenMint} (score ${analysis.ai.score}): ${analysis.rejectionReason}`
        );
        // Don't permanently blocklist mints where AI scoring had a transient
        // error (rate limit, timeout). Without this, a 429 storm poisons the
        // rejected_tokens table with mints we never actually evaluated.
        if (!analysis.ai.error) {
          recordRejection({
            tokenMint: pool.tokenMint,
            reason: analysis.rejectionReason ?? 'unknown',
            aiScore: analysis.ai.score,
            poolAddress: pool.poolAddress,
          });
        }
        return;
      }

      logger.info(
        `BUYING ${pool.tokenMint} (score ${analysis.ai.score}): ${analysis.ai.reasoning}`
      );

      const buy = await buyToken(pool.tokenMint, cfg.buyAmountSol, cfg);
      if (!buy.success) {
        logger.error(`buy failed: ${buy.error}`);
        recordRejection({
          tokenMint: pool.tokenMint,
          reason: `buy failed: ${buy.error}`,
          aiScore: analysis.ai.score,
          poolAddress: pool.poolAddress,
        });
        return;
      }

      const position = createPosition({
        tokenMint: pool.tokenMint,
        tokenSymbol: analysis.market.symbol,
        entryPriceSol: buy.pricePerToken,
        amountTokens: buy.amountOut,
        amountSolSpent: buy.amountIn,
        aiScore: analysis.ai.score,
        poolAddress: pool.poolAddress,
        entryTx: buy.txSignature,
      });
      recordTrade({
        positionId: position.id,
        type: 'buy',
        amountTokens: buy.amountOut,
        amountSol: buy.amountIn,
        priceSol: buy.pricePerToken,
        txSignature: buy.txSignature || null,
        simulated: buy.simulated,
      });
    } catch (err) {
      logger.error(`newPool handler failed: ${(err as Error).message}`);
    } finally {
      gate.release();
      inflightMints.delete(pool.tokenMint);
    }
  });

  await listener.start();
  startMonitoring();

  const statusTimer = setInterval(() => {
    try {
      printStatus();
    } catch (err) {
      logger.error(`status print failed: ${(err as Error).message}`);
    }
  }, STATUS_PRINT_INTERVAL_MS);

  const shutdown = async () => {
    logger.info('shutting down...');
    clearInterval(statusTimer);
    await listener.stop();
    stopMonitoring();
    printStatus();
    closeDb();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  logger.info(
    `sniper running. Rolling status every ${STATUS_PRINT_INTERVAL_MS / 60_000} min. Press Ctrl+C to stop.`
  );
}

async function monitorCommand(options: { source?: string } = {}): Promise<void> {
  applyCliFlags(options);
  const cfg = loadConfig();
  getDb();
  logger.banner(`MIPER monitor — source: ${cfg.source} (db: ${cfg.dbPath})`);
  startMonitoring();

  const shutdown = () => {
    stopMonitoring();
    closeDb();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  logger.info('monitoring open positions. Press Ctrl+C to stop.');
}

function fmt(n: number | null, digits = 4): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '-';
  return n.toFixed(digits);
}

function printStatus(): void {
  const cfg = loadConfig();
  const positions = getOpenPositions();
  const pnl = getPnlSummary();

  logger.banner('STATUS');
  logger.info(
    `open ${pnl.openCount} | closed ${pnl.closedCount} | stopped ${pnl.stoppedCount} | win rate ${(pnl.winRate * 100).toFixed(1)}%`
  );
  logger.info(
    `spent ${fmt(pnl.totalSpent)} SOL | received ${fmt(pnl.totalReceived)} SOL | PnL ${chalk.bold(fmt(pnl.realizedPnlSol))} SOL`
  );
  if (cfg.simulate) {
    const current = cfg.simulatedStartingSol + pnl.realizedPnlSol;
    const pctReturn = (pnl.realizedPnlSol / cfg.simulatedStartingSol) * 100;
    const tinted = pctReturn >= 0 ? chalk.green : chalk.red;
    logger.info(
      `paper bag: ${fmt(current)} SOL (started ${fmt(cfg.simulatedStartingSol)}, ${tinted(`${pctReturn >= 0 ? '+' : ''}${pctReturn.toFixed(2)}%`)})`
    );
  }

  if (positions.length === 0) {
    logger.info('no open positions');
    return;
  }
  // eslint-disable-next-line no-console
  console.log(
    chalk.bold(
      `\n  ID  SYMBOL        ENTRY          CURRENT        MULT   TP  STATUS   MINT`
    )
  );
  for (const p of positions) {
    const mult = p.current_price_sol && p.entry_price_sol
      ? p.current_price_sol / p.entry_price_sol
      : null;
    const row = [
      String(p.id).padStart(4),
      (p.token_symbol ?? '-').padEnd(12).slice(0, 12),
      fmt(p.entry_price_sol, 8).padStart(14),
      fmt(p.current_price_sol, 8).padStart(14),
      mult !== null ? `${mult.toFixed(2)}x`.padStart(6) : '   -  ',
      String(p.tp_level).padStart(3),
      p.status.padEnd(8),
      p.token_mint,
    ].join(' ');
    // eslint-disable-next-line no-console
    console.log(`  ${row}`);
  }
  // eslint-disable-next-line no-console
  console.log('');
}

async function statusCommand(options: { source?: string } = {}): Promise<void> {
  applyCliFlags(options);
  loadConfig();
  getDb();
  printStatus();
  closeDb();
}

async function balanceCommand(options: { source?: string } = {}): Promise<void> {
  applyCliFlags(options);
  const cfg = loadConfig();
  const wallet = getWallet(cfg);
  logger.info(`wallet: ${wallet.publicKey.toBase58()}`);
  try {
    const balance = await getWalletBalance(cfg);
    logger.info(`SOL: ${balance.toFixed(4)}`);
  } catch (err) {
    logger.error(`balance fetch failed: ${(err as Error).message}`);
  }
}

async function sellCommand(
  positionId: string,
  options: { pct?: string; source?: string }
): Promise<void> {
  applyCliFlags(options);
  const cfg = loadConfig();
  getDb();
  const id = Number(positionId);
  const position = getPosition(id);
  if (!position) {
    logger.error(`position ${id} not found`);
    process.exit(1);
  }
  if (!['open', 'partial'].includes(position.status)) {
    logger.error(`position ${id} is already ${position.status}`);
    process.exit(1);
  }
  const pct = Math.min(100, Math.max(1, Number(options.pct ?? '100')));
  const amount = (position.amount_tokens * pct) / 100;
  logger.info(`selling ${pct}% (${amount.toFixed(4)} tokens) of position ${id}`);

  // Sanity check the on-chain balance when live.
  if (!cfg.simulate) {
    const onchain = await getTokenBalance(position.token_mint, cfg);
    if (onchain < amount) {
      logger.warn(`on-chain balance ${onchain} < requested ${amount}, trimming`);
    }
  }

  const result = await sellToken(position.token_mint, amount, cfg);
  if (!result.success) {
    logger.error(`sell failed: ${result.error}`);
    process.exit(1);
  }

  recordTrade({
    positionId: id,
    type: 'sell',
    amountTokens: amount,
    amountSol: result.amountOut,
    priceSol: result.pricePerToken,
    txSignature: result.txSignature || null,
    simulated: result.simulated,
  });

  const remaining = position.amount_tokens - amount;
  const trades = getTradesForPosition(id);
  const received = trades
    .filter((t) => t.type === 'sell')
    .reduce((s, t) => s + t.amount_sol, 0);
  updatePosition(id, {
    amountTokens: remaining,
    amountSolReceived: received,
    status: remaining <= 0 ? 'closed' : 'partial',
  });
  logger.info(`received ${result.amountOut.toFixed(4)} SOL`);
  closeDb();
}

const program = new Command();
program
  .name('miper')
  .description('Autonomous Solana memecoin sniper with Claude AI scoring')
  .version('0.1.0');

program
  .command('snipe')
  .description('Listen for new Raydium or pump.fun launches and auto-buy/auto-manage')
  .option('--simulate', 'force simulation mode')
  .option('--source <source>', "token source: 'raydium' or 'pump' (falls back to SOURCE env, then 'raydium')")
  .action(snipeCommand);

program
  .command('monitor')
  .description('Monitor existing positions (no new buys)')
  .option('--source <source>', "which ledger to read: 'raydium' or 'pump' (falls back to SOURCE env, then 'raydium')")
  .action(monitorCommand);

program
  .command('status')
  .description('Show open positions and PnL summary')
  .option('--source <source>', "which ledger to read: 'raydium' or 'pump' (falls back to SOURCE env, then 'raydium')")
  .action(statusCommand);

program
  .command('balance')
  .description('Show wallet SOL balance')
  .option('--source <source>', "resolve config for: 'raydium' or 'pump' (falls back to SOURCE env, then 'raydium')")
  .action(balanceCommand);

program
  .command('review')
  .description('Summarize the DB: PnL, positions, rejections, live-readiness')
  .option('--source <source>', "which ledger to review: 'raydium' or 'pump' (falls back to SOURCE env, then 'raydium')")
  .action((options) => {
    applyCliFlags(options);
    return reviewCommand();
  });

program
  .command('sell <positionId>')
  .description('Manually sell a position')
  .option('--pct <pct>', 'percentage of position to sell (1-100)', '100')
  .option('--source <source>', "which ledger to sell from: 'raydium' or 'pump' (falls back to SOURCE env, then 'raydium')")
  .action(sellCommand);

program.parseAsync(process.argv).catch((err) => {
  logger.error((err as Error).message);
  process.exit(1);
});
