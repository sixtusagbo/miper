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
  process.env.OPENAI_API_KEY = 'sk-openai-test';  process.env.WALLET_PRIVATE_KEY = '';
  process.env.SIMULATE = 'true';
  process.env.LOG_LEVEL = 'info';
  process.env.LOG_FILE = logPath;
  delete process.env.LOG_MAX_BYTES;
  delete process.env.LOG_MAX_FILES;
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

describe('log rotation', () => {
  it('rotates the file when LOG_MAX_BYTES is exceeded', async () => {
    process.env.LOG_MAX_BYTES = '200';
    process.env.LOG_MAX_FILES = '3';
    resetConfigCache();

    // Each line is ~30+ bytes once timestamp and tag are added, so a few
    // lines blow past 200 bytes and trigger rotation.
    for (let i = 0; i < 20; i++) {
      logger.info(`line-${i}-padding-padding-padding`);
    }
    await flushFile();

    expect(fs.existsSync(logPath)).toBe(true);
    expect(fs.existsSync(`${logPath}.1`)).toBe(true);
  });

  it('drops archives past LOG_MAX_FILES', async () => {
    process.env.LOG_MAX_BYTES = '200';
    process.env.LOG_MAX_FILES = '2';
    resetConfigCache();

    // Force enough rotations to require evicting the oldest archive.
    for (let i = 0; i < 100; i++) {
      logger.info(`line-${i}-padding-padding-padding-padding`);
    }
    await flushFile();

    expect(fs.existsSync(`${logPath}.1`)).toBe(true);
    expect(fs.existsSync(`${logPath}.2`)).toBe(true);
    expect(fs.existsSync(`${logPath}.3`)).toBe(false);
  });

  it('does not rotate when LOG_MAX_BYTES is 0 (rotation disabled)', async () => {
    process.env.LOG_MAX_BYTES = '0';
    resetConfigCache();

    for (let i = 0; i < 50; i++) {
      logger.info(`line-${i}-padding-padding-padding`);
    }
    await flushFile();

    expect(fs.existsSync(`${logPath}.1`)).toBe(false);
  });
});
