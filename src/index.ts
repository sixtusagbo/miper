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
import { PoolListener, PumpListener, LogListener, NewPool } from './listener';
import { analyzeToken } from './analyzer';
import { buyToken, getTokenBalance, getWallet, getWalletBalance, sellToken } from './trader';
import {
  closeAllOpenPositions,
  positionAgeMinutes,
  startMonitoring,
  stopMonitoring,
} from './positions';
import { InflightGate, withTimeout } from './concurrency';
import { reviewCommand } from './review';
import { formatRpcCounts, getRpcCounts, instrumentConnection } from './rpcCounter';
import { bannerHeadline, bannerLines } from './banner';
import { setBondingCurveCacheTtl } from './bondingCurve';
import { TractionWatcher } from './tractionWatcher';

// Cap concurrent analyses. Each pump analysis makes ~3 RPC calls (getMint +
// metadata + creator history) plus the AI call, so 6 concurrent ~= 6 req/s
// on RPC, comfortably under Helius free tier's 10 req/s ceiling. Bumped
// from 3 because pump.fun streams faster than 3-concurrent could drain
// (R7 dropped 528/615 detections at the busy gate).
const MAX_CONCURRENT_ANALYSES = 6;
// Hard cap on a single pool's analyze pipeline (DexScreener + RPC + Claude).
// If Claude is slow or DexScreener hangs, we give up rather than stall.
const ANALYSIS_TIMEOUT_MS = 20_000;
// How often the snipe command prints a rolling status summary during a run.
const STATUS_PRINT_INTERVAL_MS = 15 * 60 * 1000;
// Backstop for the graceful shutdown: if cleanup stalls (e.g. a dead RPC),
// force-exit so the process never hangs on Ctrl-C. Generous enough to let a
// legitimate close-on-shutdown sweep finish first.
const SHUTDOWN_HARD_TIMEOUT_MS = 3 * 60 * 1000;

function printBanner(): void {
  const cfg = loadConfig();
  logger.banner(bannerHeadline(cfg));
  for (const line of bannerLines(cfg)) {
    logger.info(line);
  }
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
  setBondingCurveCacheTtl(cfg.bondingCurveCacheMs);
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

  const connection = instrumentConnection(
    new Connection(cfg.solanaRpcUrl, {
      commitment: 'confirmed',
      wsEndpoint: cfg.solanaWsUrl,
    })
  );
  const listener: LogListener =
    cfg.source === 'pump' ? new PumpListener(connection) : new PoolListener(connection);
  // Launch-snipe v2: the pump source no longer buys at t=0 — new launches go
  // to the TractionWatcher, which observes each then emits 'entry' only for
  // ones that drew real traction while still landable-cheap.
  const tractionWatcher: TractionWatcher | null =
    cfg.source === 'pump'
      ? new TractionWatcher(
          connection,
          {
            windowMs: cfg.tractionWindowSec * 1000,
            sampleMs: cfg.tractionSampleSec * 1000,
            minTrades: cfg.tractionMinTrades,
            maxEntryMult: cfg.tractionMaxEntryMult,
            watchCap: cfg.tractionWatchCap,
          },
          cfg
        )
      : null;
  const gate = new InflightGate(MAX_CONCURRENT_ANALYSES);
  // Guards against the same mint being analyzed by concurrent events (multiple
  // init signatures for one pool, or replay after reconnect). Without this,
  // several analyses for one mint hit Claude in parallel and trigger 429s.
  const inflightMints = new Set<string>();
  // Consecutive failed buys; an unbroken run trips the circuit breaker below.
  let consecutiveBuyFailures = 0;
  // Buys past the capacity gate but not yet recorded — counted so concurrent
  // traction entries can't collectively overshoot maxOpenPositions.
  let buysInFlight = 0;

  // Shared buy tail: buy, update the circuit breaker, record the position
  // and trade. Used by the Raydium analyze path and the pump traction entry.
  const executeBuy = async (
    pool: NewPool,
    meta: { aiScore: number | null; symbol: string | null }
  ): Promise<void> => {
    const buy = await buyToken(pool.tokenMint, cfg.buyAmountSol, cfg);
    if (!buy.success) {
      logger.error(`entry missed: ${pool.tokenMint} — buy reverted (${buy.error})`);
      recordRejection({
        tokenMint: pool.tokenMint,
        reason: `buy failed: ${buy.error}`,
        aiScore: meta.aiScore,
        poolAddress: pool.poolAddress,
      });
      consecutiveBuyFailures++;
      if (
        cfg.maxConsecutiveBuyFailures > 0 &&
        consecutiveBuyFailures >= cfg.maxConsecutiveBuyFailures
      ) {
        logger.error(
          `circuit breaker tripped: ${consecutiveBuyFailures} buys failed in a row — shutting down`
        );
        void shutdown('circuit breaker: consecutive buy failures');
      }
      return;
    }
    // A landed buy clears the streak — only an unbroken run trips the breaker.
    consecutiveBuyFailures = 0;
    const position = createPosition({
      tokenMint: pool.tokenMint,
      tokenSymbol: meta.symbol,
      entryPriceSol: buy.pricePerToken,
      amountTokens: buy.amountOut,
      amountSolSpent: buy.amountIn,
      aiScore: meta.aiScore,
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
  };

  listener.on('newPool', async (pool) => {
    if (tractionWatcher) {
      // Launch-snipe v2: don't buy at t=0 — hand the launch to the watcher.
      if (!isTokenKnown(pool.tokenMint)) tractionWatcher.add(pool);
      return;
    }
    // Cheapest checks first so a full bag short-circuits before we burn
    // an analyzer-gate slot or dirty the inflight dedup set.
    if (countOpenPositions() >= cfg.maxOpenPositions) {
      logger.debug(`max open positions (${cfg.maxOpenPositions}) reached, skipping`);
      return;
    }
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

      await executeBuy(pool, {
        aiScore: analysis.ai.score,
        symbol: analysis.market.symbol,
      });
    } catch (err) {
      logger.error(`newPool handler failed: ${(err as Error).message}`);
    } finally {
      gate.release();
      inflightMints.delete(pool.tokenMint);
    }
  });

  if (tractionWatcher) {
    // A launch that cleared the watcher's observation window with real
    // traction — buy it. No AI score; the on-chain traction is the signal.
    tractionWatcher.on('entry', (pool: NewPool, trades: number) => {
      void (async () => {
        if (countOpenPositions() + buysInFlight >= cfg.maxOpenPositions) {
          logger.debug(`max open positions reached, skipping ${pool.tokenMint}`);
          return;
        }
        if (isTokenKnown(pool.tokenMint)) return;
        buysInFlight++;
        try {
          logger.info(
            `BUYING ${pool.tokenMint} — ${trades} curve trades, traction confirmed`
          );
          await executeBuy(pool, { aiScore: null, symbol: null });
        } catch (err) {
          logger.error(`traction entry failed: ${(err as Error).message}`);
        } finally {
          buysInFlight--;
        }
      })();
    });
  }

  await listener.start();
  tractionWatcher?.start();
  // Hand the connection to the monitor so pump positions can poll the
  // bonding curve directly instead of waiting for DexScreener to index.
  startMonitoring(undefined, connection);

  const statusTimer = setInterval(() => {
    try {
      printStatus();
    } catch (err) {
      logger.error(`status print failed: ${(err as Error).message}`);
    }
  }, STATUS_PRINT_INTERVAL_MS);

  // First interrupt runs the graceful shutdown; a second one (impatient user,
  // or SIGINT during the MAX_RUN_HOURS auto-stop) force-exits instead of
  // starting a second close-positions loop.
  let shuttingDown = false;
  const shutdown = async (reason: string) => {
    if (shuttingDown) {
      logger.warn('second interrupt — force-exiting');
      process.exit(130);
    }
    shuttingDown = true;
    logger.info(`shutting down (${reason})...`);
    // Backstop: if any cleanup step stalls on a dead RPC/WebSocket, force-exit
    // anyway so Ctrl-C is never a dead end.
    const forceExit = setTimeout(() => {
      logger.warn('shutdown cleanup stalled — force-exiting');
      process.exit(1);
    }, SHUTDOWN_HARD_TIMEOUT_MS);
    forceExit.unref();
    clearInterval(statusTimer);
    if (autoStopTimer) clearTimeout(autoStopTimer);
    await listener.stop();
    tractionWatcher?.stop();
    stopMonitoring();
    if (cfg.closeOnShutdown) {
      const result = await closeAllOpenPositions(cfg, connection);
      logger.info(
        `shutdown close: ${result.closed} closed, ${result.failed} failed`
      );
    }
    printStatus();
    closeDb();
    clearTimeout(forceExit);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // Auto-shutdown after MAX_RUN_HOURS (0 disables). For unattended runs so
  // the bot stops itself instead of churning indefinitely.
  let autoStopTimer: NodeJS.Timeout | null = null;
  if (cfg.maxRunHours > 0) {
    const ms = cfg.maxRunHours * 60 * 60 * 1000;
    autoStopTimer = setTimeout(() => {
      logger.info(`MAX_RUN_HOURS=${cfg.maxRunHours} reached`);
      void shutdown(`MAX_RUN_HOURS=${cfg.maxRunHours}`);
    }, ms);
  }

  logger.info(
    `sniper running. Rolling status every ${STATUS_PRINT_INTERVAL_MS / 60_000} min. Press Ctrl+C to stop.`
  );
}

async function monitorCommand(options: { source?: string } = {}): Promise<void> {
  applyCliFlags(options);
  const cfg = loadConfig();
  setBondingCurveCacheTtl(cfg.bondingCurveCacheMs);
  getDb();
  logger.banner(`MIPER monitor — source: ${cfg.source} (db: ${cfg.dbPath})`);
  const connection = instrumentConnection(
    new Connection(cfg.solanaRpcUrl, {
      commitment: 'confirmed',
      wsEndpoint: cfg.solanaWsUrl,
    })
  );
  startMonitoring(undefined, connection);

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

  // Skip the rpc line when no calls have been counted: the counter is
  // process-local, so a standalone `npm run status:pump` from another
  // terminal would otherwise log "rpc: 0 calls" against the bot's log
  // file even though the live process has burnt through thousands of
  // calls. Only the owning process's status prints meaningful counts.
  const rpcSnapshot = getRpcCounts();
  if (Object.values(rpcSnapshot).reduce((a, b) => a + b, 0) > 0) {
    logger.info(formatRpcCounts(rpcSnapshot));
  }

  if (positions.length === 0) {
    logger.info('no open positions');
    return;
  }
  // Column spec — the header and every row are padded by the same widths so
  // the table actually lines up. The hold column shows time left before the
  // MAX_HOLD_MINUTES time-exit, or (when that's disabled) the position's age.
  const holdHead = cfg.maxHoldMinutes > 0 ? 'EXIT-IN' : 'AGE';
  const cols: ReadonlyArray<{ head: string; w: number; right: boolean }> = [
    { head: 'ID', w: 4, right: true },
    { head: 'SYMBOL', w: 12, right: false },
    { head: 'ENTRY', w: 13, right: true },
    { head: 'CURRENT', w: 13, right: true },
    { head: 'MULT', w: 7, right: true },
    { head: holdHead, w: 8, right: true },
    { head: 'TP', w: 3, right: true },
    { head: 'STATUS', w: 8, right: false },
    { head: 'MINT', w: 0, right: false },
  ];
  const renderRow = (cells: readonly string[]): string =>
    '  ' +
    cells
      .map((cell, i) => {
        const c = cols[i];
        if (c.w === 0) return cell;
        return c.right ? cell.padStart(c.w) : cell.padEnd(c.w).slice(0, c.w);
      })
      .join('  ');

  // eslint-disable-next-line no-console
  console.log(chalk.bold('\n' + renderRow(cols.map((c) => c.head))));
  for (const p of positions) {
    const mult =
      p.current_price_sol && p.entry_price_sol
        ? p.current_price_sol / p.entry_price_sol
        : null;
    const age = positionAgeMinutes(p);
    const hold =
      age === null
        ? '-'
        : cfg.maxHoldMinutes > 0
          ? cfg.maxHoldMinutes - age > 0
            ? `${(cfg.maxHoldMinutes - age).toFixed(1)}m`
            : 'due'
          : `${age.toFixed(1)}m`;
    // eslint-disable-next-line no-console
    console.log(
      renderRow([
        String(p.id),
        p.token_symbol ?? '-',
        fmt(p.entry_price_sol, 8),
        fmt(p.current_price_sol, 8),
        mult !== null ? `${mult.toFixed(2)}x` : '-',
        hold,
        String(p.tp_level),
        p.status,
        p.token_mint,
      ])
    );
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
