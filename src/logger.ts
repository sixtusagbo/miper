import chalk from 'chalk';
import { createWriteStream, WriteStream } from 'fs';
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

function consoleEnabled(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[currentLevel()];
}

let logStream: WriteStream | null = null;
let logStreamPath: string | undefined = undefined;

function resolveLogFilePath(): string | undefined {
  try {
    const fromConfig = loadConfig().logFile?.trim();
    if (fromConfig) return fromConfig;
  } catch {
    // loadConfig may throw before env is set up (e.g. during early CLI bootstrap);
    // fall through to reading process.env directly.
  }
  return process.env.LOG_FILE?.trim() || undefined;
}

function getLogStream(): WriteStream | null {
  const path = resolveLogFilePath();
  if (!path) {
    if (logStream) closeLogFile();
    return null;
  }
  if (path !== logStreamPath) {
    if (logStream) logStream.end();
    logStream = createWriteStream(path, { flags: 'a' });
    logStreamPath = path;
  }
  return logStream;
}

// When LOG_FILE is set, the file receives every log line (including debug)
// regardless of LOG_LEVEL, so the terminal stays calibrated while the file
// becomes a full audit trail.
export function closeLogFile(): void {
  if (logStream) {
    logStream.end();
    logStream = null;
    logStreamPath = undefined;
  }
}

function write(level: LogLevel, color: (s: string) => string, tag: string, msg: string, data?: unknown): void {
  const ts = timestamp();
  const inConsole = consoleEnabled(level);
  const stream = getLogStream();

  if (inConsole) {
    // eslint-disable-next-line no-console
    console.log(`${chalk.gray(ts)} ${color(`[${tag}]`)} ${msg}`);
    if (data !== undefined) {
      // eslint-disable-next-line no-console
      console.log(chalk.gray(typeof data === 'string' ? data : JSON.stringify(data, null, 2)));
    }
  }
  if (stream) {
    stream.write(`${ts} [${tag}] ${msg}\n`);
    if (data !== undefined) {
      stream.write((typeof data === 'string' ? data : JSON.stringify(data)) + '\n');
    }
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
    const stream = getLogStream();
    if (stream) {
      const plainBar = '='.repeat(Math.max(text.length + 4, 40));
      stream.write(`\n${plainBar}\n  ${text}\n${plainBar}\n\n`);
    }
  },
  position(
    action: 'BUY' | 'SELL' | 'STOPLOSS' | 'TIMEOUT' | 'TP1' | 'TP2' | 'TP3',
    token: string,
    details: string
  ): void {
    const painter =
      action === 'BUY'
        ? chalk.green.bold
        : action === 'STOPLOSS'
        ? chalk.red.bold
        : action === 'TIMEOUT'
        ? chalk.yellow.bold
        : chalk.blue.bold;
    write('trade', painter, action, `${chalk.white(token)} ${chalk.gray(details)}`);
  },
  sim(msg: string, data?: unknown): void {
    write('trade', chalk.yellow, 'SIM', msg, data);
  },
};
