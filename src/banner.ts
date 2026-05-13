import { Config } from './config';

// Pure formatters for the startup banner. Kept separate from index.ts so
// the conditional logic (tiered vs all-in exit, bounded vs unbounded
// session, simulate vs live) is unit-testable without spying on logger.

export function bannerHeadline(cfg: Config): string {
  return `MIPER ${cfg.simulate ? '(SIMULATION)' : '(LIVE)'} — source: ${cfg.source}`;
}

export function bannerLines(cfg: Config, now: Date = new Date()): string[] {
  const lines: string[] = [];

  if (cfg.maxRunHours > 0) {
    const stop = new Date(now.getTime() + cfg.maxRunHours * 3600 * 1000);
    lines.push(
      `session: running for ${formatHours(cfg.maxRunHours)}, started ${formatLocalTime(now)}, auto-stops ${formatLocalTime(stop)} | close-on-shutdown: ${cfg.closeOnShutdown ? 'on' : 'off'}`
    );
  } else {
    lines.push(
      `session: unbounded (Ctrl+C to stop), started ${formatLocalTime(now)} | close-on-shutdown: ${cfg.closeOnShutdown ? 'on' : 'off'}`
    );
  }

  const holdSuffix =
    cfg.maxHoldMinutes > 0 ? ` | time-exit after ${cfg.maxHoldMinutes}min` : '';
  if (cfg.exitMode === 'all-in') {
    lines.push(
      `exit strategy: ALL-IN at ${cfg.exitAtMult}x | stop-loss ${cfg.stopLoss}x${holdSuffix}`
    );
  } else {
    lines.push(
      `exit strategy: TIERED ${cfg.takeProfit1}x×${cfg.sellPctTp1}% / ${cfg.takeProfit2}x×${cfg.sellPctTp2}% / ${cfg.takeProfit3}x×${cfg.sellPctTp3}% | stop-loss ${cfg.stopLoss}x${holdSuffix}`
    );
  }

  lines.push(
    `buy ${cfg.buyAmountSol} SOL | max ${cfg.maxOpenPositions} open | min AI score ${cfg.minAiScore} (${cfg.aiModel})`
  );
  lines.push(
    `filters: min liq $${cfg.minLiquidityUsd} | max top holder ${cfg.maxTopHolderPct}% | slippage ${cfg.maxSlippageBps}bps`
  );

  if (cfg.simulate) {
    lines.push(`paper bag: starting ${cfg.simulatedStartingSol} SOL`);
  }

  lines.push(
    `db: ${cfg.dbPath}${cfg.logFile ? ` | log file: ${cfg.logFile}` : ''}`
  );

  return lines;
}

function formatHours(h: number): string {
  if (Number.isInteger(h)) return `${h}h`;
  return `${h.toFixed(1)}h`;
}

// Local-time MM-DD HH:MM. Avoids locale-dependent toLocaleString output
// so the banner reads the same on every machine.
function formatLocalTime(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
