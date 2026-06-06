import { describe, expect, it } from 'vitest';
import { ParsedTransactionWithMeta } from '@solana/web3.js';
import { extractLeaderTrade } from '../src/walletListener';

const WALLET = 'Leader1111111111111111111111111111111111111';
const TOKEN = 'Token2222222222222222222222222222222222222';
const WSOL = 'So11111111111111111111111111111111111111112';

interface TokenBal {
  mint: string;
  owner: string;
  ui: number;
}

// Build a minimal ParsedTransactionWithMeta with the leader at account index
// 0, a native SOL delta, and pre/post token balances.
function parsedTx(o: {
  solDelta: number; // lamports applied to the wallet's balance
  preToken?: TokenBal[];
  postToken?: TokenBal[];
  err?: unknown;
  walletInKeys?: boolean;
}): ParsedTransactionWithMeta {
  const toBal = (t: TokenBal) => ({
    owner: t.owner,
    mint: t.mint,
    uiTokenAmount: { uiAmount: t.ui },
  });
  return {
    meta: {
      err: o.err ?? null,
      preBalances: [1_000_000_000],
      postBalances: [1_000_000_000 + o.solDelta],
      preTokenBalances: (o.preToken ?? []).map(toBal),
      postTokenBalances: (o.postToken ?? []).map(toBal),
    },
    transaction: {
      message: {
        accountKeys: [
          { pubkey: { toBase58: () => (o.walletInKeys === false ? 'someone-else' : WALLET) } },
        ],
      },
    },
  } as unknown as ParsedTransactionWithMeta;
}

describe('extractLeaderTrade', () => {
  it('detects a buy — token balance up, SOL down', () => {
    const trade = extractLeaderTrade(
      parsedTx({ solDelta: -2_000_000_000, postToken: [{ mint: TOKEN, owner: WALLET, ui: 1000 }] }),
      WALLET,
      'sig1'
    );
    expect(trade).not.toBeNull();
    expect(trade!.kind).toBe('buy');
    expect(trade!.tokenMint).toBe(TOKEN);
    expect(trade!.solAmount).toBeCloseTo(2);
  });

  it('detects a sell — token balance down, SOL up — and reports a full-exit fraction', () => {
    const trade = extractLeaderTrade(
      parsedTx({
        solDelta: 1_500_000_000,
        preToken: [{ mint: TOKEN, owner: WALLET, ui: 1000 }],
        postToken: [{ mint: TOKEN, owner: WALLET, ui: 0 }],
      }),
      WALLET,
      'sig2'
    );
    expect(trade!.kind).toBe('sell');
    expect(trade!.tokenMint).toBe(TOKEN);
    expect(trade!.sellFraction).toBeCloseTo(1); // sold 1000 of 1000
  });

  it('reports the fraction sold for a partial trim', () => {
    const trade = extractLeaderTrade(
      parsedTx({
        solDelta: 400_000_000,
        preToken: [{ mint: TOKEN, owner: WALLET, ui: 1000 }],
        postToken: [{ mint: TOKEN, owner: WALLET, ui: 750 }],
      }),
      WALLET,
      'sig2b'
    );
    expect(trade!.kind).toBe('sell');
    expect(trade!.sellFraction).toBeCloseTo(0.25); // sold 250 of 1000
  });

  it('ignores quote-asset (WSOL) balance changes and picks the real token', () => {
    const trade = extractLeaderTrade(
      parsedTx({
        solDelta: -1_000_000_000,
        preToken: [{ mint: WSOL, owner: WALLET, ui: 5 }],
        postToken: [
          { mint: WSOL, owner: WALLET, ui: 0 },
          { mint: TOKEN, owner: WALLET, ui: 800 },
        ],
      }),
      WALLET,
      'sig3'
    );
    expect(trade!.kind).toBe('buy');
    expect(trade!.tokenMint).toBe(TOKEN);
  });

  it('picks the token with the largest absolute delta when several change', () => {
    const big = 'Big3333333333333333333333333333333333333333';
    const trade = extractLeaderTrade(
      parsedTx({
        solDelta: -3_000_000_000,
        postToken: [
          { mint: TOKEN, owner: WALLET, ui: 50 },
          { mint: big, owner: WALLET, ui: 9000 },
        ],
      }),
      WALLET,
      'sig4'
    );
    expect(trade!.tokenMint).toBe(big);
  });

  it('returns null for a failed transaction', () => {
    expect(
      extractLeaderTrade(
        parsedTx({ solDelta: -1e9, postToken: [{ mint: TOKEN, owner: WALLET, ui: 1 }], err: { x: 1 } }),
        WALLET,
        'sig5'
      )
    ).toBeNull();
  });

  it('returns null when the wallet is not in the transaction', () => {
    expect(
      extractLeaderTrade(
        parsedTx({ solDelta: -1e9, postToken: [{ mint: TOKEN, owner: WALLET, ui: 1 }], walletInKeys: false }),
        WALLET,
        'sig6'
      )
    ).toBeNull();
  });

  it('returns null when SOL and the token move the same direction (not a swap)', () => {
    expect(
      extractLeaderTrade(
        parsedTx({ solDelta: 1e9, postToken: [{ mint: TOKEN, owner: WALLET, ui: 1000 }] }),
        WALLET,
        'sig7'
      )
    ).toBeNull();
  });

  it('returns null for a transaction with no non-quote token movement', () => {
    expect(extractLeaderTrade(parsedTx({ solDelta: -50_000 }), WALLET, 'sig8')).toBeNull();
  });

  it('returns null for a null transaction', () => {
    expect(extractLeaderTrade(null, WALLET, 'sig9')).toBeNull();
  });
});
