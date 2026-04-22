import { beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, resetConfigCache } from '../src/config';

const BASE_ENV: Record<string, string> = {
  ANTHROPIC_API_KEY: 'sk-test',
  WALLET_PRIVATE_KEY: 'ignored-in-simulate',
  SIMULATE: 'true',
  LOG_LEVEL: 'info',
};

function setEnv(overrides: Record<string, string | undefined> = {}): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('SOLANA_') || key === 'WALLET_PRIVATE_KEY' || key === 'ANTHROPIC_API_KEY') {
      delete process.env[key];
    }
    if (
      key.startsWith('BUY_') ||
      key.startsWith('TAKE_PROFIT_') ||
      key.startsWith('SELL_PCT_') ||
      key === 'STOP_LOSS' ||
      key === 'MAX_SLIPPAGE_BPS' ||
      key === 'MIN_LIQUIDITY_USD' ||
      key === 'MAX_TOP_HOLDER_PCT' ||
      key === 'REQUIRE_MINT_REVOKED' ||
      key === 'REQUIRE_FREEZE_REVOKED' ||
      key === 'MIN_AI_SCORE' ||
      key === 'SIMULATE' ||
      key === 'LOG_LEVEL' ||
      key === 'MAX_OPEN_POSITIONS' ||
      key === 'DB_PATH'
    ) {
      delete process.env[key];
    }
  }
  const merged = { ...BASE_ENV, ...overrides };
  for (const [k, v] of Object.entries(merged)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetConfigCache();
}

describe('loadConfig', () => {
  beforeEach(() => setEnv());

  it('returns sensible defaults when only required keys are set', () => {
    const cfg = loadConfig();
    expect(cfg.buyAmountSol).toBe(0.05);
    expect(cfg.takeProfit1).toBe(2.0);
    expect(cfg.takeProfit2).toBe(3.0);
    expect(cfg.takeProfit3).toBe(5.0);
    expect(cfg.sellPctTp1 + cfg.sellPctTp2 + cfg.sellPctTp3).toBe(100);
    expect(cfg.stopLoss).toBe(0.4);
    expect(cfg.minAiScore).toBe(70);
    expect(cfg.simulate).toBe(true);
    expect(cfg.logLevel).toBe('info');
    expect(cfg.dbPath).toBe('./sniper.db');
  });

  it('caches after first call', () => {
    const a = loadConfig();
    process.env.BUY_AMOUNT_SOL = '99'; // mutate after cache
    const b = loadConfig();
    expect(b).toBe(a); // same reference, cached
    expect(b.buyAmountSol).toBe(0.05);
  });

  it('re-reads env after resetConfigCache', () => {
    loadConfig();
    process.env.BUY_AMOUNT_SOL = '0.1';
    resetConfigCache();
    expect(loadConfig().buyAmountSol).toBe(0.1);
  });

  it('throws if ANTHROPIC_API_KEY is missing', () => {
    setEnv({ ANTHROPIC_API_KEY: '' });
    expect(() => loadConfig()).toThrow(/ANTHROPIC_API_KEY/);
  });

  it('requires WALLET_PRIVATE_KEY in live mode', () => {
    setEnv({ SIMULATE: 'false', WALLET_PRIVATE_KEY: '' });
    expect(() => loadConfig()).toThrow(/WALLET_PRIVATE_KEY/);
  });

  it('allows empty WALLET_PRIVATE_KEY in simulate mode', () => {
    setEnv({ WALLET_PRIVATE_KEY: '' });
    expect(() => loadConfig()).not.toThrow();
  });

  it('throws if TP percentages do not sum to 100', () => {
    setEnv({ SELL_PCT_TP1: '50', SELL_PCT_TP2: '30', SELL_PCT_TP3: '30' });
    expect(() => loadConfig()).toThrow(/sum to 100/);
  });

  it('throws if TPs are not strictly increasing', () => {
    setEnv({ TAKE_PROFIT_1: '3', TAKE_PROFIT_2: '2', TAKE_PROFIT_3: '5' });
    expect(() => loadConfig()).toThrow(/TAKE_PROFIT/);
  });

  it('throws if stop-loss is out of (0,1)', () => {
    setEnv({ STOP_LOSS: '1.2' });
    expect(() => loadConfig()).toThrow(/STOP_LOSS/);
  });

  it('throws if min AI score is out of 0-100', () => {
    setEnv({ MIN_AI_SCORE: '150' });
    expect(() => loadConfig()).toThrow(/MIN_AI_SCORE/);
  });

  it('throws if buy amount is not positive', () => {
    setEnv({ BUY_AMOUNT_SOL: '0' });
    expect(() => loadConfig()).toThrow(/BUY_AMOUNT_SOL/);
  });

  it('coerces various boolean spellings', () => {
    for (const truthy of ['true', '1', 'yes', 'Y', 'TRUE']) {
      setEnv({ REQUIRE_MINT_REVOKED: truthy });
      expect(loadConfig().requireMintRevoked).toBe(true);
    }
    for (const falsy of ['false', '0', 'no', 'N']) {
      setEnv({ REQUIRE_MINT_REVOKED: falsy });
      expect(loadConfig().requireMintRevoked).toBe(false);
    }
  });

  it('throws on invalid boolean', () => {
    setEnv({ SIMULATE: 'maybe' });
    expect(() => loadConfig()).toThrow(/SIMULATE/);
  });

  it('throws on invalid numeric value', () => {
    setEnv({ BUY_AMOUNT_SOL: 'not-a-number' });
    expect(() => loadConfig()).toThrow(/BUY_AMOUNT_SOL/);
  });

  it('throws on invalid log level', () => {
    setEnv({ LOG_LEVEL: 'chatty' });
    expect(() => loadConfig()).toThrow(/LOG_LEVEL/);
  });

  it('falls back to default RPC urls when not set', () => {
    setEnv({ SOLANA_RPC_URL: undefined, SOLANA_WS_URL: undefined });
    const cfg = loadConfig();
    expect(cfg.solanaRpcUrl).toBe('https://api.mainnet-beta.solana.com');
    expect(cfg.solanaWsUrl).toBe('wss://api.mainnet-beta.solana.com');
  });
});
