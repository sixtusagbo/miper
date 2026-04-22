import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { closeLogFile, logger } from '../src/logger';
import { resetConfigCache } from '../src/config';

let tempDir: string;
let logPath: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'miper-log-'));
  logPath = path.join(tempDir, 'miper.log');
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  process.env.WALLET_PRIVATE_KEY = '';
  process.env.SIMULATE = 'true';
  process.env.LOG_LEVEL = 'info';
  process.env.LOG_FILE = logPath;
  resetConfigCache();
});

afterEach(() => {
  closeLogFile();
  delete process.env.LOG_FILE;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function flushFile(): Promise<void> {
  closeLogFile();
  await new Promise((r) => setTimeout(r, 20));
}

describe('file logging', () => {
  it('writes each level to the file when LOG_FILE is set', async () => {
    logger.info('info-line');
    logger.warn('warn-line');
    logger.error('err-line');
    await flushFile();
    const contents = fs.readFileSync(logPath, 'utf8');
    expect(contents).toMatch(/\[INF\] info-line/);
    expect(contents).toMatch(/\[WRN\] warn-line/);
    expect(contents).toMatch(/\[ERR\] err-line/);
  });

  it('includes debug-level lines in the file even when LOG_LEVEL=info', async () => {
    logger.debug('detailed-debug');
    await flushFile();
    const contents = fs.readFileSync(logPath, 'utf8');
    expect(contents).toMatch(/\[DBG\] detailed-debug/);
  });

  it('serializes the data argument as JSON', async () => {
    logger.info('with-data', { a: 1, b: 'x' });
    await flushFile();
    const contents = fs.readFileSync(logPath, 'utf8');
    expect(contents).toMatch(/with-data/);
    expect(contents).toMatch(/"a":1/);
    expect(contents).toMatch(/"b":"x"/);
  });

  it('does not create a file when LOG_FILE is unset', async () => {
    delete process.env.LOG_FILE;
    closeLogFile();
    logger.info('no-file');
    await new Promise((r) => setTimeout(r, 20));
    expect(fs.existsSync(logPath)).toBe(false);
  });
});
