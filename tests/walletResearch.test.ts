import { describe, expect, it } from 'vitest';
import { Keypair, ParsedTransactionWithMeta } from '@solana/web3.js';
import { bondingCurvePda } from '../src/bondingCurve';
import {
  buildRoundTrips,
  classifyPlatform,
  deriveDiscoveryProfile,
  distribution,
  EntrySnapshot,
  extractEntryFromBuyTx,
  extractIncomingTransfer,
  findCoBuys,
  percentile,
  recurringAddresses,
  snapshotToFeatures,
  summarizeWalletBehavior,
  TimedTrade,
  tokenDeltaForWallet,
} from '../src/walletResearch';
import { DEFAULT_DISCOVERY_PROFILE } from '../src/discoveryScore';

const WALLET = 'Wallet111111111111111111111111111111111111';
const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const RAYDIUM = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const JUPITER = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';

// Minimal parsed-tx fixture. Account keys / balances / instructions are only
// as deep as the extractors read.
function tx(o: {
  programIds?: string[];
  innerProgramIds?: string[];
  keys?: Array<{ address: string; pre: number; post: number; signer?: boolean }>;
  preToken?: Array<{ mint: string; owner: string; ui: number }>;
  postToken?: Array<{ mint: string; owner: string; ui: number }>;
  parsedInstructions?: unknown[];
}): ParsedTransactionWithMeta {
  const keys = o.keys ?? [{ address: WALLET, pre: 0, post: 0, signer: true }];
  return {
    meta: {
      err: null,
      preBalances: keys.map((k) => k.pre),
      postBalances: keys.map((k) => k.post),
      preTokenBalances: (o.preToken ?? []).map((t) => ({
        mint: t.mint,
        owner: t.owner,
        uiTokenAmount: { uiAmount: t.ui },
      })),
      postTokenBalances: (o.postToken ?? []).map((t) => ({
        mint: t.mint,
        owner: t.owner,
        uiTokenAmount: { uiAmount: t.ui },
      })),
      innerInstructions: o.innerProgramIds
        ? [
            {
              index: 0,
              instructions: o.innerProgramIds.map((id) => ({
                programId: { toBase58: () => id },
              })),
            },
          ]
        : [],
    },
    transaction: {
      message: {
        accountKeys: keys.map((k) => ({
          pubkey: { toBase58: () => k.address },
          signer: k.signer ?? false,
        })),
        instructions: [
          ...(o.programIds ?? []).map((id) => ({ programId: { toBase58: () => id } })),
          ...(o.parsedInstructions ?? []),
        ],
      },
    },
  } as unknown as ParsedTransactionWithMeta;
}

describe('classifyPlatform', () => {
  it('identifies a pump.fun curve trade', () => {
    expect(classifyPlatform(tx({ programIds: [PUMP] }))).toBe('pump');
  });

  it('prefers the venue over the router on a Jupiter route through Raydium', () => {
    expect(classifyPlatform(tx({ programIds: [JUPITER], innerProgramIds: [RAYDIUM] }))).toBe(
      'raydium'
    );
  });

  it('falls back to jupiter when no known venue is present', () => {
    expect(classifyPlatform(tx({ programIds: [JUPITER] }))).toBe('jupiter');
  });

  it('returns other for unknown programs', () => {
    expect(classifyPlatform(tx({ programIds: ['SomeRandomProgram'] }))).toBe('other');
  });
});

describe('tokenDeltaForWallet', () => {
  it('nets pre and post balances for the wallet and mint only', () => {
    const t = tx({
      preToken: [
        { mint: 'M', owner: WALLET, ui: 100 },
        { mint: 'M', owner: 'other', ui: 50 },
      ],
      postToken: [
        { mint: 'M', owner: WALLET, ui: 350 },
        { mint: 'X', owner: WALLET, ui: 999 },
      ],
    });
    expect(tokenDeltaForWallet(t, WALLET, 'M')).toBe(250);
  });
});

describe('extractEntryFromBuyTx', () => {
  const mint = Keypair.generate().publicKey.toBase58();
  const curve = bondingCurvePda(mint).toBase58();

  it('prices the entry from the curve SOL delta and reports at-entry liquidity', () => {
    const t = tx({
      programIds: [PUMP],
      keys: [
        { address: WALLET, pre: 5_000_000_000, post: 3_950_000_000, signer: true },
        { address: curve, pre: 10_000_000_000, post: 11_000_000_000 },
      ],
      postToken: [{ mint, owner: WALLET, ui: 1_000_000 }],
    });
    const e = extractEntryFromBuyTx(t, WALLET, mint);
    // 1 SOL entered the curve for 1M tokens -> 1e-6 SOL/token.
    expect(e.entryPriceSol).toBeCloseTo(1e-6);
    expect(e.curveSolAtEntry).toBeCloseTo(11);
    expect(e.buySolIn).toBeCloseTo(1.05); // wallet delta includes fees
    expect(e.tokensOut).toBe(1_000_000);
    expect(e.platform).toBe('pump');
  });

  it('falls back to the wallet SOL delta when the curve is not in the tx', () => {
    const t = tx({
      programIds: [RAYDIUM],
      keys: [{ address: WALLET, pre: 2_000_000_000, post: 1_000_000_000, signer: true }],
      postToken: [{ mint, owner: WALLET, ui: 500 }],
    });
    const e = extractEntryFromBuyTx(t, WALLET, mint);
    expect(e.entryPriceSol).toBeCloseTo(1 / 500);
    expect(e.curveSolAtEntry).toBeNull();
  });

  it('returns null price when no tokens were received', () => {
    const t = tx({ keys: [{ address: WALLET, pre: 1, post: 0, signer: true }] });
    expect(extractEntryFromBuyTx(t, WALLET, mint).entryPriceSol).toBeNull();
  });
});

describe('extractIncomingTransfer', () => {
  it('finds the system transfer that funded the wallet', () => {
    const t = tx({
      parsedInstructions: [
        {
          programId: { toBase58: () => '11111111111111111111111111111111' },
          parsed: {
            type: 'transfer',
            info: { source: 'FunderXYZ', destination: WALLET, lamports: 2_500_000_000 },
          },
        },
      ],
    });
    const got = extractIncomingTransfer(t, WALLET);
    expect(got).toEqual({ from: 'FunderXYZ', sol: 2.5 });
  });

  it('ignores outgoing transfers and other instruction types', () => {
    const t = tx({
      parsedInstructions: [
        {
          programId: { toBase58: () => '11111111111111111111111111111111' },
          parsed: {
            type: 'transfer',
            info: { source: WALLET, destination: 'Elsewhere', lamports: 1 },
          },
        },
        { programId: { toBase58: () => '11111111111111111111111111111111' }, parsed: { type: 'createAccount', info: {} } },
      ],
    });
    expect(extractIncomingTransfer(t, WALLET)).toBeNull();
  });
});

// --- round trips & behavior --------------------------------------------------

function trade(o: {
  mint: string;
  kind: 'buy' | 'sell';
  sol: number;
  slot: number;
  time: number;
  sig?: string;
}): TimedTrade {
  return {
    wallet: WALLET,
    tokenMint: o.mint,
    solAmount: o.sol,
    kind: o.kind,
    signature: o.sig ?? `${o.kind}-${o.mint}-${o.slot}`,
    slot: o.slot,
    blockTime: o.time,
  };
}

describe('buildRoundTrips', () => {
  it('aggregates buys/sells per token with hold and pnl', () => {
    const trips = buildRoundTrips([
      trade({ mint: 'A', kind: 'buy', sol: 1, slot: 10, time: 1000 }),
      trade({ mint: 'A', kind: 'sell', sol: 3, slot: 20, time: 1004 }),
      trade({ mint: 'B', kind: 'buy', sol: 2, slot: 15, time: 1002 }),
    ]);
    expect(trips).toHaveLength(2);
    const a = trips.find((t) => t.tokenMint === 'A')!;
    expect(a.pnlSol).toBeCloseTo(2);
    expect(a.holdSec).toBe(4);
    expect(a.buys).toBe(1);
    expect(a.sells).toBe(1);
    const b = trips.find((t) => t.tokenMint === 'B')!;
    expect(b.pnlSol).toBeNull(); // still open
    expect(b.holdSec).toBeNull();
  });

  it('drops sells with no sampled buy (truncated window)', () => {
    const trips = buildRoundTrips([trade({ mint: 'C', kind: 'sell', sol: 1, slot: 5, time: 1 })]);
    expect(trips).toHaveLength(0);
  });

  it('sorts chronologically by first-buy slot', () => {
    const trips = buildRoundTrips([
      trade({ mint: 'L', kind: 'buy', sol: 1, slot: 100, time: 200 }),
      trade({ mint: 'E', kind: 'buy', sol: 1, slot: 10, time: 100 }),
    ]);
    expect(trips.map((t) => t.tokenMint)).toEqual(['E', 'L']);
  });
});

describe('summarizeWalletBehavior', () => {
  it('computes win rate, one-buy-one-sell fraction and fast flips', () => {
    const b = summarizeWalletBehavior(WALLET, [
      trade({ mint: 'A', kind: 'buy', sol: 1, slot: 1, time: 1000 }),
      trade({ mint: 'A', kind: 'sell', sol: 2, slot: 2, time: 1002 }), // win, 2s flip
      trade({ mint: 'B', kind: 'buy', sol: 1, slot: 3, time: 2000 }),
      trade({ mint: 'B', kind: 'buy', sol: 1, slot: 4, time: 2010 }),
      trade({ mint: 'B', kind: 'sell', sol: 1, slot: 5, time: 2060 }), // loss, 2 buys
    ]);
    expect(b.roundTrips).toBe(2);
    expect(b.winRate).toBeCloseTo(0.5);
    expect(b.oneBuyOneSellFraction).toBeCloseTo(0.5);
    expect(b.fastFlipFraction).toBeCloseTo(0.5);
    expect(b.realizedPnlSol).toBeCloseTo(0); // +1 then -1
  });

  it('splits performance into halves for regime detection', () => {
    const trades: TimedTrade[] = [];
    // First half: 2 losers. Second half: 2 winners (later slots/times).
    for (let i = 0; i < 2; i++) {
      trades.push(trade({ mint: `L${i}`, kind: 'buy', sol: 1, slot: 10 + i * 2, time: 1000 + i * 100 }));
      trades.push(trade({ mint: `L${i}`, kind: 'sell', sol: 0.5, slot: 11 + i * 2, time: 1050 + i * 100 }));
    }
    for (let i = 0; i < 2; i++) {
      trades.push(trade({ mint: `W${i}`, kind: 'buy', sol: 1, slot: 100 + i * 2, time: 5000 + i * 100 }));
      trades.push(trade({ mint: `W${i}`, kind: 'sell', sol: 4, slot: 101 + i * 2, time: 5050 + i * 100 }));
    }
    const b = summarizeWalletBehavior(WALLET, trades);
    expect(b.halves[0].winRate).toBe(0);
    expect(b.halves[1].winRate).toBe(1);
    expect(b.halves[1].pnlSol).toBeCloseTo(6);
  });

  it('buckets round trips by week', () => {
    const week = 7 * 86_400;
    const b = summarizeWalletBehavior(WALLET, [
      trade({ mint: 'A', kind: 'buy', sol: 1, slot: 1, time: 0 }),
      trade({ mint: 'A', kind: 'sell', sol: 2, slot: 2, time: 10 }),
      trade({ mint: 'B', kind: 'buy', sol: 1, slot: 3, time: week + 5 }),
      trade({ mint: 'B', kind: 'sell', sol: 0.2, slot: 4, time: week + 20 }),
    ]);
    expect(b.weekly).toHaveLength(2);
    expect(b.weekly[0].winRate).toBe(1);
    expect(b.weekly[1].winRate).toBe(0);
  });
});

describe('percentile & distribution', () => {
  it('computes nearest-rank percentiles', () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(xs, 50)).toBe(5);
    expect(percentile(xs, 90)).toBe(9);
    expect(percentile([], 50)).toBe(0);
  });

  it('summarizes a distribution', () => {
    const d = distribution([5, 1, 3]);
    expect(d.n).toBe(3);
    expect(d.p50).toBe(3);
  });
});

describe('findCoBuys', () => {
  const trip = (mint: string, slot: number, time: number) => ({
    tokenMint: mint,
    firstBuySignature: `sig-${mint}-${slot}`,
    firstBuySlot: slot,
    firstBuyTime: time,
    buys: 1,
    sells: 1,
    buySol: 1,
    sellSol: 2,
    holdSec: 5,
    pnlSol: 1,
  });

  it('finds tokens bought by multiple wallets and same-slot groups', () => {
    const groups = findCoBuys(
      new Map([
        ['W1', [trip('SHARED', 100, 1000), trip('SOLO', 50, 900)]],
        ['W2', [trip('SHARED', 100, 1000)]],
        ['W3', [trip('SHARED', 130, 1015)]],
      ])
    );
    expect(groups).toHaveLength(1);
    const g = groups[0];
    expect(g.tokenMint).toBe('SHARED');
    expect(g.wallets).toHaveLength(3);
    expect(g.sameSlotWallets).toEqual([['W1', 'W2']]);
    expect(g.entrySpreadSec).toBe(15);
  });
});

describe('recurringAddresses', () => {
  it('counts distinct tokens per address and applies the floor', () => {
    const got = recurringAddresses(
      new Map<string, string | string[] | null>([
        ['T1', 'dev1'],
        ['T2', 'dev1'],
        ['T3', ['dev2', 'dev1']],
        ['T4', null],
      ]),
      2
    );
    expect(got).toEqual([{ address: 'dev1', tokens: 3 }]);
  });
});

// --- snapshot mapping & profile derivation -----------------------------------

function snapshot(overrides: Partial<EntrySnapshot> = {}): EntrySnapshot {
  return {
    wallet: WALLET,
    tokenMint: 'M',
    buySignature: 'sig',
    buySlot: 1,
    buyTime: 1000,
    platform: 'pump',
    launchPlatform: 'pump',
    entryPriceSol: 5e-9,
    entryMcapUsd: 5_000,
    solUsdUsed: 200,
    curveSolAtEntry: 32,
    buySolIn: 1,
    ageSecAtEntry: 45,
    txsBeforeEntry: 30,
    holdersBeforeEntry: 12,
    buyersPerMinAtEntry: 16,
    creator: 'Dev',
    createSignature: 'createSig',
    devBuySol: 1.5,
    creatorPriorTxs: 10,
    creatorAgeDaysAtLaunch: 0.5,
    creatorSaturated: false,
    funder: 'Hub',
    targetCoBuyersSameSlot: [],
    targetBuyersEarlier: [],
    pnlSol: 2,
    holdSec: 8,
    explainable: true,
    explainableReasons: [],
    ...overrides,
  };
}

describe('snapshotToFeatures', () => {
  it('maps a snapshot onto the live feature shape', () => {
    const f = snapshotToFeatures(
      snapshot({ targetBuyersEarlier: ['W2'], targetCoBuyersSameSlot: ['W3', 'W2'] })
    );
    expect(f.smartWalletBuys).toBe(2); // W2 deduped across both lists
    expect(f.mcapUsd).toBe(5_000);
    expect(f.txPerMin).toBeCloseTo(40); // 30 txs over 45s
    expect(f.bundledLaunch).toBe(false);
    expect(f.ageSec).toBe(45);
  });
});

describe('deriveDiscoveryProfile', () => {
  it('keeps defaults when the sample is too thin', () => {
    const p = deriveDiscoveryProfile([snapshot()], ['W1']);
    expect(p.maxEntryMcapUsd).toBe(DEFAULT_DISCOVERY_PROFILE.maxEntryMcapUsd);
    expect(p.smartWallets).toEqual(['W1']);
  });

  it('derives thresholds from the measured distributions', () => {
    const snaps = Array.from({ length: 10 }, (_, i) =>
      snapshot({
        tokenMint: `M${i}`,
        entryMcapUsd: 4_000 + i * 500, // p90 = 8500
        ageSecAtEntry: 30 + i * 10,
        devBuySol: 0.8 + i * 0.1,
        buyersPerMinAtEntry: 10 + i,
      })
    );
    const p = deriveDiscoveryProfile(snaps, ['W1', 'W2']);
    expect(p.maxEntryMcapUsd).toBeGreaterThan(8_000);
    expect(p.maxEntryMcapUsd).toBeLessThanOrEqual(60_000);
    expect(p.maxTokenAgeSec).toBeGreaterThanOrEqual(300);
    expect(p.minBuyersPerMin).toBeGreaterThan(1);
    expect(p.devBuyMinSol).toBeGreaterThan(0);
  });

  it('promotes recurring creators and funders to the known-good lists', () => {
    const snaps = [
      snapshot({ tokenMint: 'A', creator: 'SerialDev', funder: 'Hub' }),
      snapshot({ tokenMint: 'B', creator: 'SerialDev', funder: 'Hub' }),
      snapshot({ tokenMint: 'C', creator: 'OneOff', funder: null }),
    ];
    const p = deriveDiscoveryProfile(snaps, ['W1']);
    expect(p.knownGoodDeployers).toEqual(['SerialDev']);
    expect(p.knownGoodFunders).toEqual(['Hub']);
  });
});
