import chalk from 'chalk';
import { appendFileSync, renameSync, statSync, unlinkSync } from 'fs';
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

// Cached path for the active log file so rotation can rename it without
// re-resolving from config on every write. `null` means logging is
// disabled (no LOG_FILE configured).
let activeLogPath: string | null = null;
// In-memory mirror of the file's byte size, kept in sync with appendFileSync
// calls. We track it instead of statting on every write because rotation
// fires off this counter; seeded from disk size on first use after open.
let bytesWritten = 0;
let pathSeeded = false;

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

interface RotationConfig {
  maxBytes: number;
  maxFiles: number;
}

function resolveRotationConfig(): RotationConfig {
  try {
    const cfg = loadConfig();
    return { maxBytes: cfg.logMaxBytes, maxFiles: cfg.logMaxFiles };
  } catch {
    return { maxBytes: 100 * 1024 * 1024, maxFiles: 5 };
  }
}

function ensureLogPath(): string | null {
  const path = resolveLogFilePath();
  if (!path) {
    activeLogPath = null;
    pathSeeded = false;
    return null;
  }
  if (path !== activeLogPath) {
    activeLogPath = path;
    pathSeeded = false;
  }
  if (!pathSeeded) {
    // Seed the byte counter from existing on-disk size so rotation
    // triggers correctly when a process restarts against a part-full log.
    try {
      bytesWritten = statSync(path).size;
    } catch {
      bytesWritten = 0;
    }
    pathSeeded = true;
  }
  return path;
}

// Roll pump.log -> pump.log.1, pump.log.1 -> pump.log.2, ... up to
// maxFiles archives. Older archives are dropped. Best-effort: each rename
// is wrapped in try/catch so a missing intermediate doesn't abort the
// chain (e.g. on the first ever rotation only pump.log exists).
function rotateLog(path: string, maxFiles: number): void {
  try { unlinkSync(`${path}.${maxFiles}`); } catch { /* missing is fine */ }
  for (let i = maxFiles - 1; i >= 1; i--) {
    try { renameSync(`${path}.${i}`, `${path}.${i + 1}`); } catch { /* missing is fine */ }
  }
  try { renameSync(path, `${path}.1`); } catch { /* nothing to rotate */ }
  bytesWritten = 0;
}

// closeLogFile is now a no-op for the synchronous append path — there's
// no stream handle to close. Kept as an exported function so callers
// (notably the test harness) can still reset module state between runs.
export function closeLogFile(): void {
  activeLogPath = null;
  pathSeeded = false;
  bytesWritten = 0;
}

function writeToFile(path: string, content: string): void {
  // Rotate BEFORE the write that would exceed the limit, so the just-
  // written line lands in the new active log instead of being the final
  // entry of the rotated archive. Keeps the current log file present at
  // all times instead of disappearing after the last rotation.
  const len = Buffer.byteLength(content);
  const { maxBytes, maxFiles } = resolveRotationConfig();
  if (maxBytes > 0 && bytesWritten + len > maxBytes) {
    rotateLog(path, maxFiles);
  }
  appendFileSync(path, content);
  bytesWritten += len;
}

function write(level: LogLevel, color: (s: string) => string, tag: string, msg: string, data?: unknown): void {
  const ts = timestamp();
  const inConsole = consoleEnabled(level);
  const path = ensureLogPath();

  if (inConsole) {
    // eslint-disable-next-line no-console
    console.log(`${chalk.gray(ts)} ${color(`[${tag}]`)} ${msg}`);
    if (data !== undefined) {
      // eslint-disable-next-line no-console
      console.log(chalk.gray(typeof data === 'string' ? data : JSON.stringify(data, null, 2)));
    }
  }
  if (path) {
    writeToFile(path, `${ts} [${tag}] ${msg}\n`);
    if (data !== undefined) {
      writeToFile(path, (typeof data === 'string' ? data : JSON.stringify(data)) + '\n');
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
    const path = ensureLogPath();
    if (path) {
      const plainBar = '='.repeat(Math.max(text.length + 4, 40));
      writeToFile(path, `\n${plainBar}\n  ${text}\n${plainBar}\n\n`);
    }
  },
  position(
    action: 'BUY' | 'SELL' | 'STOPLOSS' | 'TIMEOUT' | 'TP1' | 'TP2' | 'TP3' | 'COPY-EXIT',
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
