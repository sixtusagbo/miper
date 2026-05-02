import { describe, expect, it } from 'vitest';
import { bannerHeadline, bannerLines } from '../src/banner';
import type { Config } from '../src/config';

function mkCfg(overrides: Partial<Config> = {}): Config {
  return {
    solanaRpcUrl: 'https://rpc.example/?api-key=x',
    solanaWsUrl: '',
    walletPrivateKey: '',
    anthropicApiKey: '',
    openaiApiKey: 'sk-x',
    aiProvider: 'openai',
    aiModel: 'gpt-5-nano',
    buyAmountSol: 0.05,
    takeProfit1: 2,
    takeProfit2: 3,
    takeProfit3: 5,
    sellPctTp1: 40,
    sellPctTp2: 30,
    sellPctTp3: 30,
    stopLoss: 0.4,
    maxSlippageBps: 500,
    minLiquidityUsd: 5000,
    maxTopHolderPct: 25,
    requireMintRevoked: false,
    requireFreezeRevoked: false,
    minAiScore: 70,
    simulate: true,
    simulatedStartingSol: 1,
    logLevel: 'info',
    maxOpenPositions: 50,
    dbPath: './pump.db',
    logFile: './pump.log',
    source: 'pump',
    exitMode: 'all-in',
    exitAtMult: 3,
    maxRunHours: 24,
    closeOnShutdown: true,
    maxHoldMinutes: 0,
    ...overrides,
  } as Config;
}

const FIXED_NOW = new Date('2026-04-30T13:30:00');

describe('bannerHeadline', () => {
  it('marks SIMULATION when simulate=true', () => {
    expect(bannerHeadline(mkCfg({ simulate: true, source: 'pump' }))).toBe(
      'MIPER (SIMULATION) — source: pump'
    );
  });

  it('marks LIVE when simulate=false', () => {
    expect(bannerHeadline(mkCfg({ simulate: false, source: 'raydium' }))).toBe(
      'MIPER (LIVE) — source: raydium'
    );
  });
});

describe('bannerLines', () => {
  it('shows session duration with computed auto-stop time and close-on-shutdown', () => {
    const lines = bannerLines(mkCfg(), FIXED_NOW);
    const session = lines.find((l) => l.startsWith('session:'));
    expect(session).toContain('running for 24h');
    expect(session).toContain('auto-stops');
    expect(session).toContain('close-on-shutdown: on');
  });

  it('reports unbounded session when maxRunHours=0', () => {
    const lines = bannerLines(mkCfg({ maxRunHours: 0, closeOnShutdown: false }), FIXED_NOW);
    const session = lines.find((l) => l.startsWith('session:'));
    expect(session).toContain('unbounded (Ctrl+C to stop)');
    expect(session).toContain('close-on-shutdown: off');
    expect(session).not.toContain('auto-stops');
  });

  it('shows ALL-IN exit with exitAtMult, hides TP1/2/3 (which are ignored in this mode)', () => {
    const lines = bannerLines(mkCfg({ exitMode: 'all-in', exitAtMult: 3 }), FIXED_NOW);
    const exit = lines.find((l) => l.startsWith('exit strategy:'));
    expect(exit).toContain('ALL-IN at 3x');
    expect(exit).toContain('stop-loss 0.4x');
    expect(exit).not.toContain('TIERED');
  });

  it('shows TIERED exit with all three TPs and their sell %', () => {
    const lines = bannerLines(mkCfg({ exitMode: 'tiered' }), FIXED_NOW);
    const exit = lines.find((l) => l.startsWith('exit strategy:'));
    expect(exit).toContain('TIERED');
    expect(exit).toContain('2x×40%');
    expect(exit).toContain('3x×30%');
    expect(exit).toContain('5x×30%');
    expect(exit).not.toContain('ALL-IN');
  });

  it('appends time-exit segment when MAX_HOLD_MINUTES > 0', () => {
    const lines = bannerLines(mkCfg({ maxHoldMinutes: 30 }), FIXED_NOW);
    const exit = lines.find((l) => l.startsWith('exit strategy:'));
    expect(exit).toContain('time-exit after 30min');
  });

  it('omits the time-exit segment when MAX_HOLD_MINUTES=0 (disabled)', () => {
    const lines = bannerLines(mkCfg({ maxHoldMinutes: 0 }), FIXED_NOW);
    const exit = lines.find((l) => l.startsWith('exit strategy:'));
    expect(exit).not.toContain('time-exit');
  });

  it('includes the AI model name and min score on the strategy line', () => {
    const lines = bannerLines(mkCfg({ aiModel: 'claude-haiku-4-5', minAiScore: 75 }), FIXED_NOW);
    const strat = lines.find((l) => l.startsWith('buy '));
    expect(strat).toContain('min AI score 75 (claude-haiku-4-5)');
  });

  it('includes the paper-bag line in simulate mode and omits it in live', () => {
    const sim = bannerLines(mkCfg({ simulate: true, simulatedStartingSol: 2.5 }), FIXED_NOW);
    expect(sim.some((l) => l.startsWith('paper bag:'))).toBe(true);

    const live = bannerLines(mkCfg({ simulate: false }), FIXED_NOW);
    expect(live.some((l) => l.startsWith('paper bag:'))).toBe(false);
  });

  it('omits the log-file segment when logFile is null', () => {
    const lines = bannerLines(mkCfg({ logFile: null }), FIXED_NOW);
    const dbLine = lines.find((l) => l.startsWith('db:'));
    expect(dbLine).toBeDefined();
    expect(dbLine).not.toContain('log file');
  });
});
