#!/usr/bin/env node
import { Command } from 'commander';
import { Connection } from '@solana/web3.js';
import chalk from 'chalk';
import { loadConfig } from './config';
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
import { PoolListener } from './listener';
import { analyzeToken } from './analyzer';
import { buyToken, getTokenBalance, getWallet, getWalletBalance, sellToken } from './trader';
import { startMonitoring, stopMonitoring } from './positions';

function printBanner(): void {
  const cfg = loadConfig();
  logger.banner(`MIPER ${cfg.simulate ? '(SIMULATION)' : '(LIVE)'}`);
  logger.info(
    `buy ${cfg.buyAmountSol} SOL | TPs ${cfg.takeProfit1}x/${cfg.takeProfit2}x/${cfg.takeProfit3}x | SL ${cfg.stopLoss}x | min AI score ${cfg.minAiScore}`
  );
  logger.info(
    `min liq $${cfg.minLiquidityUsd} | max top holder ${cfg.maxTopHolderPct}% | slippage ${cfg.maxSlippageBps}bps`
  );
}

async function snipeCommand(options: { simulate?: boolean }): Promise<void> {
  if (options.simulate) process.env.SIMULATE = 'true';
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
  const listener = new PoolListener(connection);

  listener.on('newPool', async (pool) => {
    try {
      if (isTokenKnown(pool.tokenMint)) {
        logger.debug(`already seen ${pool.tokenMint}, skipping`);
        return;
      }
      if (countOpenPositions() >= cfg.maxOpenPositions) {
        logger.debug(`max open positions (${cfg.maxOpenPositions}) reached, skipping`);
        return;
      }

      logger.info(`analyzing ${pool.tokenMint}...`);
      const analysis = await analyzeToken(connection, pool, cfg);

      if (!analysis.shouldBuy) {
        logger.info(
          `skipping ${pool.tokenMint} (score ${analysis.ai.score}): ${analysis.rejectionReason}`
        );
        recordRejection({
          tokenMint: pool.tokenMint,
          reason: analysis.rejectionReason ?? 'unknown',
          aiScore: analysis.ai.score,
          poolAddress: pool.poolAddress,
        });
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
    }
  });

  await listener.start();
  startMonitoring();

  const shutdown = async () => {
    logger.info('shutting down...');
    await listener.stop();
    stopMonitoring();
    printStatus();
    closeDb();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  logger.info('sniper running. Press Ctrl+C to stop.');
}

async function monitorCommand(): Promise<void> {
  loadConfig();
  getDb();
  logger.banner('MIPER monitor');
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
  const positions = getOpenPositions();
  const pnl = getPnlSummary();

  logger.banner('STATUS');
  logger.info(
    `open ${pnl.openCount} | closed ${pnl.closedCount} | stopped ${pnl.stoppedCount} | win rate ${(pnl.winRate * 100).toFixed(1)}%`
  );
  logger.info(
    `spent ${fmt(pnl.totalSpent)} SOL | received ${fmt(pnl.totalReceived)} SOL | PnL ${chalk.bold(fmt(pnl.realizedPnlSol))} SOL`
  );

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

async function statusCommand(): Promise<void> {
  loadConfig();
  getDb();
  printStatus();
  closeDb();
}

async function balanceCommand(): Promise<void> {
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

async function sellCommand(positionId: string, options: { pct?: string }): Promise<void> {
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
  .description('Listen for new Raydium pools and auto-buy/auto-manage')
  .option('--simulate', 'force simulation mode')
  .action(snipeCommand);

program
  .command('monitor')
  .description('Monitor existing positions (no new buys)')
  .action(monitorCommand);

program
  .command('status')
  .description('Show open positions and PnL summary')
  .action(statusCommand);

program
  .command('balance')
  .description('Show wallet SOL balance')
  .action(balanceCommand);

program
  .command('sell <positionId>')
  .description('Manually sell a position')
  .option('--pct <pct>', 'percentage of position to sell (1-100)', '100')
  .action(sellCommand);

program.parseAsync(process.argv).catch((err) => {
  logger.error((err as Error).message);
  process.exit(1);
});
