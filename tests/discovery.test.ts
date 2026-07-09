import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Keypair, ParsedTransactionWithMeta } from '@solana/web3.js';
import type { NewPool } from '../src/listener';

const mocks = vi.hoisted(() => ({
  recordDiscoveryAlert: vi.fn(() => 1),
  setDiscoveryAlertOutcome: vi.fn(),
  bumpWalletIntel: vi.fn(),
  getWalletIntel: vi.fn(() => null),
  recordRejection: vi.fn(),
  getSolUsdPrice: vi.fn(async () => 200),
  fetchCreatorHistory: vi.fn(async () => ({
    totalRecentTxs: 200,
    oldestActivityDaysAgo: 30,
    txCountSaturated: false,
    fetchedAt: Date.now(),
  })),
  fetchTokenMetadata: vi.fn(async () => ({ name: 'Token', symbol: 'TOK', uri: 'https://x/y' })),
  checkLaunchBundle: vi.fn(async () => ({
    bundled: false,
    launchSlotBuyers: 0,
    reason: 'clean',
  })),
}));

vi.mock('../src/db', () => ({
  recordDiscoveryAlert: mocks.recordDiscoveryAlert,
  setDiscoveryAlertOutcome: mocks.setDiscoveryAlertOutcome,
  bumpWalletIntel: mocks.bumpWalletIntel,
  getWalletIntel: mocks.getWalletIntel,
  recordRejection: mocks.recordRejection,
}));
vi.mock('../src/analyzer', () => ({ getSolUsdPrice: mocks.getSolUsdPrice }));
vi.mock('../src/creatorHistory', () => ({ fetchCreatorHistory: mocks.fetchCreatorHistory }));
vi.mock('../src/metadata', () => ({ fetchTokenMetadata: mocks.fetchTokenMetadata }));
vi.mock('../src/bundleCheck', () => ({ checkLaunchBundle: mocks.checkLaunchBundle }));

import { DiscoveryScanner, DiscoveryConfig, intelReputation, DiscoveryAlert } from '../src/discovery';
import { DEFAULT_DISCOVERY_PROFILE } from '../src/discoveryScore';
import type { WalletIntelRow } from '../src/db';

const CURVE = Keypair.generate().publicKey.toBase58();
const CREATOR = Keypair.generate().publicKey.toBase58();
const MINT = Keypair.generate().publicKey.toBase58();
const SMART = 'SmartWallet11111111111111111111111111111111';

const CFG: DiscoveryConfig = {
  windowMs: 60_000,
  sampleMs: 1_000,
  watchCap: 10,
  parsePerSample: 5,
  launchParse: 8,
  alertScore: 55,
  buyScore: 75,
  bundleThreshold: 3,
  minDevBuySol: 0,
};

// Launch-state bonding curve: ~30 virtual SOL / 1.073B tokens. At $200/SOL
// that prices the token at a ~$5.6k mcap — inside the default entry band.
function curveBuffer(opts: { complete?: boolean; mayhem?: boolean } = {}): Buffer {
  const buf = Buffer.alloc(8 + 5 * 8 + 1 + 32 + 1 + 1 + 32);
  let offset = 8;
  buf.writeBigUInt64LE(1_073_000_000n * 1_000_000n, offset); offset += 8; // virtual tokens
  buf.writeBigUInt64LE(30n * 1_000_000_000n, offset); offset += 8; // virtual sol
  buf.writeBigUInt64LE(0n, offset); offset += 8;
  buf.writeBigUInt64LE(14n * 1_000_000_000n, offset); offset += 8; // real sol = 14
  buf.writeBigUInt64LE(1_000_000_000n * 1_000_000n, offset); offset += 8;
  buf[offset] = opts.complete ? 1 : 0;
  buf[8 + 5 * 8 + 1 + 32] = opts.mayhem ? 1 : 0;
  return buf;
}

// A parsed curve tx whose fee payer bought (SOL down, MINT up) or sold.
function flowTx(payer: string, kind: 'buy' | 'sell'): ParsedTransactionWithMeta {
  const solDelta = kind === 'buy' ? -1_000_000_000 : 1_000_000_000;
  const tokens = kind === 'buy' ? { pre: 0, post: 1000 } : { pre: 1000, post: 0 };
  return {
    meta: {
      err: null,
      preBalances: [5_000_000_000],
      postBalances: [5_000_000_000 + solDelta],
      preTokenBalances: [
        { mint: MINT, owner: payer, uiTokenAmount: { uiAmount: tokens.pre } },
      ],
      postTokenBalances: [
        { mint: MINT, owner: payer, uiTokenAmount: { uiAmount: tokens.post } },
      ],
    },
    transaction: {
      message: { accountKeys: [{ pubkey: { toBase58: () => payer }, signer: true }] },
    },
  } as unknown as ParsedTransactionWithMeta;
}

interface FakeConnection {
  getAccountInfo: ReturnType<typeof vi.fn>;
  getSignaturesForAddress: ReturnType<typeof vi.fn>;
  getParsedTransaction: ReturnType<typeof vi.fn>;
}

// Connection whose signature pages are routed per address and consumed in
// order, and whose parsed txs are keyed by signature.
function fakeConnection(o: {
  curve?: Buffer | null;
  sigBatches?: Array<Array<{ signature: string; err?: unknown }>>;
  txs?: Record<string, ParsedTransactionWithMeta>;
  creatorSigs?: Array<{ signature: string; err?: unknown }>;
}): FakeConnection {
  const batches = [...(o.sigBatches ?? [])];
  return {
    getAccountInfo: vi.fn(async () => (o.curve === null ? null : { data: o.curve ?? curveBuffer() })),
    getSignaturesForAddress: vi.fn(async (pk: { toBase58(): string }) => {
      if (pk.toBase58() === CREATOR) return o.creatorSigs ?? [];
      return batches.shift() ?? [];
    }),
    getParsedTransaction: vi.fn(async (sig: string) => o.txs?.[sig] ?? null),
  };
}

function pool(overrides: Partial<NewPool> = {}): NewPool {
  return {
    poolAddress: CURVE,
    tokenMint: MINT,
    baseMint: 'So11111111111111111111111111111111111111112',
    quoteMint: MINT,
    initialLiquiditySol: 1.5,
    txSignature: 'create-sig',
    timestamp: Math.floor(Date.now() / 1000),
    creator: CREATOR,
    ...overrides,
  };
}

function scanner(conn: FakeConnection, cfg: Partial<DiscoveryConfig> = {}): DiscoveryScanner {
  return new DiscoveryScanner(
    conn as never,
    { ...CFG, ...cfg },
    { ...DEFAULT_DISCOVERY_PROFILE },
    new Set([SMART])
  );
}

const tick = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.recordDiscoveryAlert.mockReturnValue(1);
  mocks.getWalletIntel.mockReturnValue(null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('DiscoveryScanner', () => {
  it('alerts and emits a candidate when stacked signals clear both bars', async () => {
    const sigs = ['s1', 's2', 's3', 's4', 's5', 's6'].map((signature) => ({ signature }));
    const txs: Record<string, ParsedTransactionWithMeta> = {
      s1: flowTx(SMART, 'buy'),
      s2: flowTx('BuyerB', 'buy'),
      s3: flowTx('BuyerC', 'buy'),
      s4: flowTx('BuyerD', 'buy'),
      s5: flowTx('BuyerE', 'buy'),
      s6: flowTx('BuyerF', 'buy'),
    };
    const conn = fakeConnection({ sigBatches: [sigs], txs });
    const s = scanner(conn);
    const alerts: DiscoveryAlert[] = [];
    const candidates: DiscoveryAlert[] = [];
    s.on('alert', (a: DiscoveryAlert) => alerts.push(a));
    s.on('candidate', (_p: NewPool, a: DiscoveryAlert) => candidates.push(a));

    s.add(pool());
    await tick(); // let the t0 intel land
    await s.sweep();

    // smart wallet +30, mcap in band +10, metadata +5, dev buy +10,
    // aged creator +5, tx/min +10, buyers/min +15, strong liquidity +10 = 95.
    expect(alerts).toHaveLength(1);
    expect(alerts[0].score).toBe(95);
    expect(alerts[0].smartWalletBuys).toBe(1);
    expect(alerts[0].holderCount).toBe(6); // all 6 launch-window buyers parsed
    expect(alerts[0].mcapUsd).toBeGreaterThan(5_000);
    expect(alerts[0].mcapUsd).toBeLessThan(6_500);
    expect(alerts[0].liquiditySol).toBeCloseTo(14);
    expect(mocks.recordDiscoveryAlert).toHaveBeenCalledTimes(1);
    expect(candidates).toHaveLength(1); // 85 >= buyScore 75
  });

  it('catches a same-slot smart wallet in the launch window (oldest sigs), not just the newest', async () => {
    // Newest-first batch: 6 unrelated newer buyers, then the smart wallet's
    // launch-slot buy as the OLDEST. parsePerSample=1 would only see the newest
    // and miss it; the launch-window parse reaches the tail.
    const sigs = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'smartOldest'].map((signature) => ({
      signature,
    }));
    const txs: Record<string, ParsedTransactionWithMeta> = {
      n1: flowTx('B1', 'buy'),
      n2: flowTx('B2', 'buy'),
      n3: flowTx('B3', 'buy'),
      n4: flowTx('B4', 'buy'),
      n5: flowTx('B5', 'buy'),
      n6: flowTx('B6', 'buy'),
      smartOldest: flowTx(SMART, 'buy'),
    };
    const conn = fakeConnection({ sigBatches: [sigs], txs });
    const s = scanner(conn, { parsePerSample: 1, launchParse: 8 });
    const alerts: DiscoveryAlert[] = [];
    s.on('alert', (a: DiscoveryAlert) => alerts.push(a));
    s.add(pool());
    await tick();
    await s.sweep();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].smartWalletBuys).toBe(1);
  });

  it('parses the newest sigs in steady state (recent flow), not the launch tail', async () => {
    // First sample establishes the launch window; second sample is steady
    // state and should read the head. SMART buys in the newer (steady) batch.
    const conn = fakeConnection({
      sigBatches: [
        [{ signature: 'old1' }],
        [{ signature: 'fresh-smart' }],
      ],
      txs: { old1: flowTx('B0', 'buy'), 'fresh-smart': flowTx(SMART, 'buy') },
    });
    const s = scanner(conn, { parsePerSample: 1, launchParse: 1 });
    const alerts: DiscoveryAlert[] = [];
    s.on('alert', (a: DiscoveryAlert) => alerts.push(a));
    s.add(pool());
    await tick();
    await s.sweep(); // launch window — parses old1
    await s.sweep(); // steady state — parses fresh-smart (newest)
    expect(alerts.some((a) => a.smartWalletBuys === 1)).toBe(true);
  });

  it('alerts only once even when the score stays above the bar', async () => {
    const sigs = ['s1', 's2', 's3', 's4', 's5'].map((signature) => ({ signature }));
    const txs = Object.fromEntries(
      sigs.map((s, i) => [s.signature, flowTx(i === 0 ? SMART : `B${i}`, 'buy')])
    );
    const conn = fakeConnection({ sigBatches: [sigs, []], txs });
    const s = scanner(conn);
    const alertSpy = vi.fn();
    s.on('alert', alertSpy);
    s.add(pool());
    await tick();
    await s.sweep();
    await s.sweep();
    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(mocks.recordDiscoveryAlert).toHaveBeenCalledTimes(1);
  });

  it('vetoes a mayhem-mode coin and records the rejection', async () => {
    const conn = fakeConnection({ curve: curveBuffer({ mayhem: true }) });
    const s = scanner(conn);
    const alertSpy = vi.fn();
    s.on('alert', alertSpy);
    s.add(pool());
    await tick();
    await s.sweep();
    expect(alertSpy).not.toHaveBeenCalled();
    expect(s.watchlistSize).toBe(0);
    expect(mocks.recordRejection).toHaveBeenCalledWith(
      expect.objectContaining({ reason: expect.stringContaining('mayhem') })
    );
  });

  it('vetoes a bundled launch', async () => {
    mocks.checkLaunchBundle.mockResolvedValueOnce({
      bundled: true,
      launchSlotBuyers: 6,
      reason: 'bundled',
    });
    const conn = fakeConnection({});
    const s = scanner(conn);
    s.add(pool());
    await tick();
    await s.sweep();
    expect(s.watchlistSize).toBe(0);
    expect(mocks.recordRejection).toHaveBeenCalledWith(
      expect.objectContaining({ reason: expect.stringContaining('bundled') })
    );
  });

  it('vetoes when the creator sells during the watch', async () => {
    const sigs = [{ signature: 'dev-dump' }];
    const conn = fakeConnection({
      sigBatches: [sigs],
      txs: { 'dev-dump': flowTx(CREATOR, 'sell') },
    });
    const s = scanner(conn);
    s.add(pool());
    await tick();
    await s.sweep();
    expect(s.watchlistSize).toBe(0);
    expect(mocks.recordRejection).toHaveBeenCalledWith(
      expect.objectContaining({ reason: expect.stringContaining('creator sold') })
    );
  });

  it('respects the watch cap and the dev-buy intake floor', async () => {
    const conn = fakeConnection({});
    const s = scanner(conn, { watchCap: 1, minDevBuySol: 1 });
    s.add(pool());
    expect(s.watchlistSize).toBe(1);
    const otherMint = Keypair.generate().publicKey.toBase58();
    s.add(pool({ tokenMint: otherMint, poolAddress: Keypair.generate().publicKey.toBase58() }));
    expect(s.watchlistSize).toBe(1); // cap
    const s2 = scanner(conn, { minDevBuySol: 1 });
    s2.add(pool({ initialLiquiditySol: 0.03 }));
    expect(s2.watchlistSize).toBe(0); // intake floor
  });

  it('finalizes an expired watch into the intel table', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T00:00:00Z'));
    const conn = fakeConnection({});
    const s = scanner(conn);
    s.add(pool());
    vi.setSystemTime(new Date('2026-06-01T00:02:00Z')); // past the 60s window
    await s.sweep();
    expect(s.watchlistSize).toBe(0);
    expect(mocks.bumpWalletIntel).toHaveBeenCalledWith(CREATOR, 'deployer', {
      launch: true,
      alerted: false,
      win: false,
    });
  });

  it('records the post-alert outcome on graduation as a win', async () => {
    const sigs = ['s1', 's2', 's3', 's4', 's5'].map((signature) => ({ signature }));
    const txs = Object.fromEntries(
      sigs.map((s, i) => [s.signature, flowTx(i === 0 ? SMART : `B${i}`, 'buy')])
    );
    const conn = fakeConnection({ sigBatches: [sigs, []], txs });
    const s = scanner(conn);
    s.add(pool());
    await tick();
    await s.sweep(); // alerts
    expect(mocks.recordDiscoveryAlert).toHaveBeenCalledTimes(1);
    conn.getAccountInfo.mockResolvedValue({ data: curveBuffer({ complete: true }) });
    await s.sweep(); // graduates
    expect(s.watchlistSize).toBe(0);
    expect(mocks.setDiscoveryAlertOutcome).toHaveBeenCalledWith(1, expect.any(Number), 'graduated');
    expect(mocks.bumpWalletIntel).toHaveBeenCalledWith(
      CREATOR,
      'deployer',
      expect.objectContaining({ win: true })
    );
  });

  it('feeds wallet_intel reputation into the score', async () => {
    const badIntel: WalletIntelRow = {
      address: CREATOR,
      role: 'deployer',
      launches: 5,
      alerted: 0,
      wins: 0,
      last_seen: 'now',
    };
    mocks.getWalletIntel.mockImplementation((addr: unknown) =>
      addr === CREATOR ? badIntel : null
    );
    const sigs = ['s1', 's2', 's3', 's4', 's5'].map((signature) => ({ signature }));
    const txs = Object.fromEntries(
      sigs.map((s, i) => [s.signature, flowTx(i === 0 ? SMART : `B${i}`, 'buy')])
    );
    const conn = fakeConnection({ sigBatches: [sigs], txs });
    const s = scanner(conn);
    const alerts: DiscoveryAlert[] = [];
    s.on('alert', (a: DiscoveryAlert) => alerts.push(a));
    s.add(pool());
    await tick();
    await s.sweep();
    // Same stack as the 95 case minus 40 for the bad deployer = 55, which
    // still clears the alert threshold. The point of the test is that the
    // reputation is applied — not that a single -40 vetoes on its own.
    expect(alerts).toHaveLength(1);
    expect(alerts[0].score).toBe(55);
    expect(alerts[0].reasons.some((r) => /-40 deployer has a bad track record/.test(r))).toBe(true);
  });
});

describe('intelReputation', () => {
  const row = (launches: number, alerted: number, wins: number): WalletIntelRow => ({
    address: 'X',
    role: 'deployer',
    launches,
    alerted,
    wins,
    last_seen: 'now',
  });

  it('is null with no record or thin evidence', () => {
    expect(intelReputation(null)).toBeNull();
    expect(intelReputation(row(1, 0, 0))).toBeNull();
    expect(intelReputation(row(3, 2, 1))).toBeNull();
  });

  it('marks two post-alert winners as good', () => {
    expect(intelReputation(row(4, 3, 2))).toBe('good');
  });

  it('marks a serial launcher with zero alerts as bad', () => {
    expect(intelReputation(row(3, 0, 0))).toBe('bad');
  });
});
