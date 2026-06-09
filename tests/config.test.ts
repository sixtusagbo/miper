import { beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, resetConfigCache, leaderLabel } from '../src/config';

const BASE_ENV: Record<string, string> = {
  ANTHROPIC_API_KEY: 'sk-test',
  OPENAI_API_KEY: 'sk-openai-test',
  WALLET_PRIVATE_KEY: 'ignored-in-simulate',
  SIMULATE: 'true',
  LOG_LEVEL: 'info',
};

function setEnv(overrides: Record<string, string | undefined> = {}): void {
  for (const key of Object.keys(process.env)) {
    if (
      key.startsWith('SOLANA_') ||
      key === 'WALLET_PRIVATE_KEY' ||
      key === 'ANTHROPIC_API_KEY' ||
      key === 'OPENAI_API_KEY'
    ) {
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
      key === 'SIMULATED_STARTING_SOL' ||
      key === 'LOG_LEVEL' ||
      key === 'MAX_OPEN_POSITIONS' ||
      key === 'DB_PATH' ||
      key === 'LOG_FILE' ||
      key === 'SOURCE' ||
      key === 'AI_PROVIDER' ||
      key === 'AI_MODEL' ||
      key === 'EXIT_MODE' ||
      key === 'EXIT_AT_MULT' ||
      key === 'MAX_RUN_HOURS' ||
      key === 'CLOSE_ON_SHUTDOWN' ||
      key === 'MAX_CONSECUTIVE_BUY_FAILURES'
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
    expect(cfg.simulatedStartingSol).toBe(1.0);
    expect(cfg.logLevel).toBe('info');
    expect(cfg.dbPath).toBe('./sniper.db');
  });

  it('throws if SIMULATED_STARTING_SOL is not positive', () => {
    setEnv({ SIMULATED_STARTING_SOL: '0' });
    expect(() => loadConfig()).toThrow(/SIMULATED_STARTING_SOL/);
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

  it("defaults AI_MODEL to gpt-5-nano (provider inferred as 'openai')", () => {
    const cfg = loadConfig();
    expect(cfg.aiModel).toBe('gpt-5-nano');
    expect(cfg.aiProvider).toBe('openai');
  });

  it('infers anthropic when AI_MODEL starts with claude-', () => {
    setEnv({ AI_MODEL: 'claude-haiku-4-5' });
    const cfg = loadConfig();
    expect(cfg.aiProvider).toBe('anthropic');
    expect(cfg.aiModel).toBe('claude-haiku-4-5');
  });

  it('infers openai for gpt-, o1, o3, and chatgpt- prefixes', () => {
    for (const id of ['gpt-4.1-nano', 'gpt-5-mini', 'o1-mini', 'o3-mini', 'chatgpt-4o-latest']) {
      setEnv({ AI_MODEL: id });
      expect(loadConfig().aiProvider).toBe('openai');
    }
  });

  it('throws on an AI_MODEL with no recognized provider prefix', () => {
    setEnv({ AI_MODEL: 'gemini-2.0-flash' });
    expect(() => loadConfig()).toThrow(/Cannot infer AI provider/);
  });

  it('throws if the inferred-provider key is missing (anthropic)', () => {
    setEnv({ AI_MODEL: 'claude-haiku-4-5', ANTHROPIC_API_KEY: '' });
    expect(() => loadConfig()).toThrow(/ANTHROPIC_API_KEY/);
  });

  it('throws if the inferred-provider key is missing (openai)', () => {
    setEnv({ AI_MODEL: 'gpt-5-nano', OPENAI_API_KEY: '' });
    expect(() => loadConfig()).toThrow(/OPENAI_API_KEY/);
  });

  it('does not require the unused provider key', () => {
    setEnv({ AI_MODEL: 'claude-haiku-4-5', OPENAI_API_KEY: '' });
    expect(() => loadConfig()).not.toThrow();
    setEnv({ AI_MODEL: 'gpt-5-nano', ANTHROPIC_API_KEY: '' });
    expect(() => loadConfig()).not.toThrow();
  });

  it('does not require any AI key for the copytrade source (no LLM scoring)', () => {
    // copytrade never scores with the LLM, so a missing key must not block boot
    // (it previously threw and sent the live unit into a restart loop). Live
    // mode + no AI keys at all should still load.
    setEnv({
      SOURCE: 'copytrade',
      SIMULATE: 'false',
      WALLET_PRIVATE_KEY: '5JZ...placeholder', // presence-only; not decoded here
      OPENAI_API_KEY: '',
      ANTHROPIC_API_KEY: '',
    });
    expect(() => loadConfig()).not.toThrow();
  });

  it("defaults EXIT_MODE to 'tiered'", () => {
    expect(loadConfig().exitMode).toBe('tiered');
  });

  it("accepts EXIT_MODE='all-in' and exposes exitAtMult", () => {
    setEnv({ EXIT_MODE: 'all-in', EXIT_AT_MULT: '3' });
    const cfg = loadConfig();
    expect(cfg.exitMode).toBe('all-in');
    expect(cfg.exitAtMult).toBe(3);
  });

  it('throws on unknown EXIT_MODE', () => {
    setEnv({ EXIT_MODE: 'rollover' });
    expect(() => loadConfig()).toThrow(/EXIT_MODE/);
  });

  it('rejects EXIT_AT_MULT <= 1 in all-in mode (would be a stop-loss, not a take-profit)', () => {
    setEnv({ EXIT_MODE: 'all-in', EXIT_AT_MULT: '1' });
    expect(() => loadConfig()).toThrow(/EXIT_AT_MULT/);
  });

  it('defaults MAX_RUN_HOURS to 0 (disabled) and CLOSE_ON_SHUTDOWN to false', () => {
    const cfg = loadConfig();
    expect(cfg.maxRunHours).toBe(0);
    expect(cfg.closeOnShutdown).toBe(false);
  });

  it('parses MAX_RUN_HOURS and CLOSE_ON_SHUTDOWN from env', () => {
    setEnv({ MAX_RUN_HOURS: '4', CLOSE_ON_SHUTDOWN: 'true' });
    const cfg = loadConfig();
    expect(cfg.maxRunHours).toBe(4);
    expect(cfg.closeOnShutdown).toBe(true);
  });

  it('rejects negative MAX_RUN_HOURS', () => {
    setEnv({ MAX_RUN_HOURS: '-1' });
    expect(() => loadConfig()).toThrow(/MAX_RUN_HOURS/);
  });

  it('defaults MAX_CONSECUTIVE_BUY_FAILURES to 5', () => {
    expect(loadConfig().maxConsecutiveBuyFailures).toBe(5);
  });

  it('parses MAX_CONSECUTIVE_BUY_FAILURES from env (0 disables)', () => {
    setEnv({ MAX_CONSECUTIVE_BUY_FAILURES: '3' });
    expect(loadConfig().maxConsecutiveBuyFailures).toBe(3);
    setEnv({ MAX_CONSECUTIVE_BUY_FAILURES: '0' });
    expect(loadConfig().maxConsecutiveBuyFailures).toBe(0);
  });

  it('rejects negative MAX_CONSECUTIVE_BUY_FAILURES', () => {
    setEnv({ MAX_CONSECUTIVE_BUY_FAILURES: '-1' });
    expect(() => loadConfig()).toThrow(/MAX_CONSECUTIVE_BUY_FAILURES/);
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

  it("defaults source to 'raydium' with ./sniper.db and no log file", () => {
    const cfg = loadConfig();
    expect(cfg.source).toBe('raydium');
    expect(cfg.dbPath).toBe('./sniper.db');
    expect(cfg.logFile).toBeNull();
  });

  it("when SOURCE=pump, defaults dbPath to ./pump.db and logFile to ./pump.log", () => {
    setEnv({ SOURCE: 'pump' });
    const cfg = loadConfig();
    expect(cfg.source).toBe('pump');
    expect(cfg.dbPath).toBe('./pump.db');
    expect(cfg.logFile).toBe('./pump.log');
  });

  it('respects explicit DB_PATH and LOG_FILE when SOURCE=pump', () => {
    setEnv({ SOURCE: 'pump', DB_PATH: '/tmp/custom.db', LOG_FILE: '/tmp/custom.log' });
    const cfg = loadConfig();
    expect(cfg.dbPath).toBe('/tmp/custom.db');
    expect(cfg.logFile).toBe('/tmp/custom.log');
  });

  it('throws on an unknown SOURCE value', () => {
    setEnv({ SOURCE: 'bogus' });
    expect(() => loadConfig()).toThrow(/SOURCE/);
  });
});

describe('leaderLabel', () => {
  const wallets = ['AAAABBBBCCCCDDDD', 'EEEEFFFFGGGGHHHH'];
  const labels = ['Joji', 'Nyhrox'];

  it('maps a wallet to its positionally-matched label', () => {
    expect(leaderLabel('EEEEFFFFGGGGHHHH', wallets, labels)).toBe('Nyhrox');
  });

  it('falls back to a short address when no label is configured', () => {
    expect(leaderLabel('AAAABBBBCCCCDDDD', wallets, [])).toBe('AAAA..DDDD');
  });

  it('falls back to a short address for a wallet not in the list', () => {
    expect(leaderLabel('ZZZZYYYYXXXXWWWW', wallets, labels)).toBe('ZZZZ..WWWW');
  });

  it('parses COPYTRADE_LABELS into copytradeLabels', () => {
    setEnv({ COPYTRADE_WALLETS: 'WAL_A,WAL_B', COPYTRADE_LABELS: 'Joji,Nyhrox' });
    expect(loadConfig().copytradeLabels).toEqual(['Joji', 'Nyhrox']);
  });
});

describe('closeWhenBelowMinBalance', () => {
  it('parses CLOSE_WHEN_BELOW_MIN_BALANCE and defaults to false', () => {
    setEnv({ CLOSE_WHEN_BELOW_MIN_BALANCE: 'true' });
    expect(loadConfig().closeWhenBelowMinBalance).toBe(true);
    setEnv({ CLOSE_WHEN_BELOW_MIN_BALANCE: 'false' });
    expect(loadConfig().closeWhenBelowMinBalance).toBe(false);
  });
});
