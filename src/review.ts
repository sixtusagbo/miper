import chalk from 'chalk';
import { loadConfig } from './config';
import { logger } from './logger';
import {
  closeDb,
  getActivityWindow,
  getDb,
  getFinishedPositions,
  getPnlSummary,
  getRejectionCount,
  getTopRejectionReasons,
} from './db';

// Thresholds lifted from RUNNING.md "Going live" checklist. Tweaking them
// should be a deliberate decision, not a reflex — they exist to stop the user
// from flipping SIMULATE=false on a sample too small to mean anything.
const MIN_FINISHED_FOR_LIVE = 20;
const MIN_DAYS_FOR_LIVE = 3;

function fmt(n: number | null | undefined, digits = 4): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '-';
  return n.toFixed(digits);
}

function signed(n: number, digits = 4): string {
  const s = n.toFixed(digits);
  return n > 0 ? `+${s}` : s;
}

function daysBetween(first: string | null, last: string | null): number {
  if (!first || !last) return 0;
  const a = Date.parse(`${first}Z`);
  const b = Date.parse(`${last}Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 0;
  return (b - a) / (1000 * 60 * 60 * 24);
}

function shortMint(mint: string): string {
  return mint.length > 10 ? `${mint.slice(0, 6)}..${mint.slice(-4)}` : mint;
}

export async function reviewCommand(): Promise<void> {
  const cfg = loadConfig();
  getDb();

  const pnl = getPnlSummary();
  const finished = getFinishedPositions();
  const rejections = getTopRejectionReasons(10);
  const totalRejections = getRejectionCount();
  const window = getActivityWindow();
  const days = daysBetween(window.first, window.last);

  logger.banner(`PAPER TRADING REVIEW${cfg.simulate ? '' : ' (LIVE)'}`);

  if (!window.first) {
    logger.info('No activity in the DB yet. Run `npm run simulate` to generate samples.');
    closeDb();
    return;
  }

  logger.info(`Mode: ${cfg.simulate ? 'SIMULATION' : 'LIVE'}`);
  logger.info(`Data window: ${window.first} UTC -> ${window.last} UTC (${days.toFixed(1)} days)`);

  if (cfg.simulate) {
    const current = cfg.simulatedStartingSol + pnl.realizedPnlSol;
    const pct = (pnl.realizedPnlSol / cfg.simulatedStartingSol) * 100;
    const tint = pct >= 0 ? chalk.green : chalk.red;
    logger.info(
      `Paper bag: ${fmt(current)} SOL (started ${fmt(cfg.simulatedStartingSol)}, ${tint(`${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`)})`
    );
  }

  // eslint-disable-next-line no-console
  console.log();
  logger.banner('PNL SUMMARY');
  logger.info(
    `spent ${fmt(pnl.totalSpent)} SOL | received ${fmt(pnl.totalReceived)} SOL | realized ${chalk.bold(signed(pnl.realizedPnlSol))} SOL`
  );
  logger.info(
    `positions: ${pnl.openCount} open/partial | ${pnl.closedCount} closed | ${pnl.stoppedCount} stopped`
  );
  const finishedCount = pnl.closedCount + pnl.stoppedCount;
  logger.info(
    `win rate: ${(pnl.winRate * 100).toFixed(1)}% (${finishedCount} finished)`
  );

  if (finished.length > 0) {
    // eslint-disable-next-line no-console
    console.log();
    logger.banner('BEST & WORST FINISHED POSITIONS');
    const best = finished[0];
    const worst = finished[finished.length - 1];
    printFinishedRow(chalk.green('BEST '), best);
    if (finished.length > 1) printFinishedRow(chalk.red('WORST'), worst);
  }

  if (rejections.length > 0) {
    // eslint-disable-next-line no-console
    console.log();
    logger.banner(`TOP REJECTION REASONS (of ${totalRejections} total)`);
    for (const r of rejections) {
      // eslint-disable-next-line no-console
      console.log(`  ${String(r.count).padStart(5)}  ${r.reason}`);
    }
  }

  // eslint-disable-next-line no-console
  console.log();
  logger.banner('LIVE-READINESS CHECKLIST');
  const reasons: string[] = [];
  const finishedOk = finishedCount >= MIN_FINISHED_FOR_LIVE;
  const pnlOk = pnl.realizedPnlSol > 0;
  const daysOk = days >= MIN_DAYS_FOR_LIVE;

  checkLine(
    finishedOk,
    `Finished positions: ${finishedCount} / ${MIN_FINISHED_FOR_LIVE}`
  );
  if (!finishedOk) reasons.push(`need ${MIN_FINISHED_FOR_LIVE - finishedCount} more finished trades`);

  checkLine(pnlOk, `Realized PnL: ${signed(pnl.realizedPnlSol)} SOL`);
  if (!pnlOk) reasons.push('PnL is not positive');

  checkLine(
    daysOk,
    `Multi-day sample: ${days.toFixed(1)} days / ${MIN_DAYS_FOR_LIVE} days`
  );
  if (!daysOk) reasons.push(`need ${(MIN_DAYS_FOR_LIVE - days).toFixed(1)} more days of data`);

  logger.info(
    '[INFO] Also confirm the log has no recurring RPC/WS errors or crashes.'
  );
  logger.info(
    '[INFO] Going live: flip SIMULATE=false in .env and use a FRESH wallet with a small float (0.5-1 SOL), not your main wallet.'
  );

  // eslint-disable-next-line no-console
  console.log();
  if (reasons.length === 0) {
    logger.info(
      chalk.green.bold(
        'VERDICT: Data-driven checks PASSED. Review the log for stability, then consider going live.'
      )
    );
  } else {
    logger.info(
      chalk.yellow.bold(
        `VERDICT: NOT READY — ${reasons.join('; ')}. Keep paper trading.`
      )
    );
  }

  closeDb();
}

function printFinishedRow(
  tag: string,
  p: { id: number; token_symbol: string | null; token_mint: string; pnl_sol: number; multiplier: number; status: string }
): void {
  const symbol = (p.token_symbol ?? '-').padEnd(10).slice(0, 10);
  // eslint-disable-next-line no-console
  console.log(
    `  ${tag}  #${String(p.id).padStart(4)}  ${symbol}  ${signed(p.pnl_sol)} SOL  ${p.multiplier.toFixed(2)}x  ${p.status.padEnd(8)}  ${shortMint(p.token_mint)}`
  );
}

function checkLine(ok: boolean, text: string): void {
  const tag = ok ? chalk.green('[PASS]') : chalk.red('[FAIL]');
  logger.info(`${tag} ${text}`);
}
