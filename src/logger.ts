import chalk from 'chalk';
import { LogLevel, loadConfig } from './config';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  trade: 25,
  warn: 30,
  error: 40,
};

function timestamp(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

function currentLevel(): LogLevel {
  try {
    return loadConfig().logLevel;
  } catch {
    return 'info';
  }
}

function enabled(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[currentLevel()];
}

function write(level: LogLevel, color: (s: string) => string, tag: string, msg: string, data?: unknown): void {
  if (!enabled(level)) return;
  const line = `${chalk.gray(timestamp())} ${color(`[${tag}]`)} ${msg}`;
  // eslint-disable-next-line no-console
  console.log(line);
  if (data !== undefined) {
    // eslint-disable-next-line no-console
    console.log(chalk.gray(typeof data === 'string' ? data : JSON.stringify(data, null, 2)));
  }
}

export const logger = {
  debug(msg: string, data?: unknown): void {
    write('debug', chalk.gray, 'DBG', msg, data);
  },
  info(msg: string, data?: unknown): void {
    write('info', chalk.cyan, 'INF', msg, data);
  },
  warn(msg: string, data?: unknown): void {
    write('warn', chalk.yellow, 'WRN', msg, data);
  },
  error(msg: string, data?: unknown): void {
    write('error', chalk.red, 'ERR', msg, data);
  },
  trade(msg: string, data?: unknown): void {
    write('trade', chalk.magenta, 'TRD', msg, data);
  },
  banner(text: string): void {
    const bar = chalk.magenta('='.repeat(Math.max(text.length + 4, 40)));
    // eslint-disable-next-line no-console
    console.log(`\n${bar}\n${chalk.magenta.bold('  ' + text)}\n${bar}\n`);
  },
  position(action: 'BUY' | 'SELL' | 'STOPLOSS' | 'TP1' | 'TP2' | 'TP3', token: string, details: string): void {
    const painter =
      action === 'BUY'
        ? chalk.green.bold
        : action === 'STOPLOSS'
        ? chalk.red.bold
        : chalk.blue.bold;
    write('trade', painter, action, `${chalk.white(token)} ${chalk.gray(details)}`);
  },
  sim(msg: string, data?: unknown): void {
    write('trade', chalk.yellow, 'SIM', msg, data);
  },
};
