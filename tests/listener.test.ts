import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import {
  SEEN_LIMIT,
  estimateSolLiquidity,
  isInitLog,
  parsePoolFromSignature,
  trimSeen,
} from '../src/listener';
import { PROGRAM_IDS, SOL_MINT_ADDRESS } from '../src/config';

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  process.env.WALLET_PRIVATE_KEY = '';
  process.env.SIMULATE = 'true';
  process.env.LOG_LEVEL = 'error';
});

describe('isInitLog', () => {
  it('matches any of the expected init keywords', () => {
    expect(isInitLog(['Program log: initialize2 success'])).toBe(true);
    expect(isInitLog(['Program log: Initialize2'])).toBe(true);
    expect(isInitLog(['Program log: init_pc_amount: 1000'])).toBe(true);
    expect(isInitLog(['Program log: ray_log: init'])).toBe(true);
  });

  it('returns false when no message contains a keyword', () => {
    expect(isInitLog(['Program log: swap'])).toBe(false);
    expect(isInitLog([])).toBe(false);
    expect(isInitLog(undefined)).toBe(false);
  });
});

describe('trimSeen', () => {
  it('is a no-op below the limit', () => {
    const s = new Set<string>(['a', 'b', 'c']);
    trimSeen(s);
    expect(s.size).toBe(3);
  });

  it('evicts oldest entries when the limit is exceeded', () => {
    const s = new Set<string>();
    for (let i = 0; i < SEEN_LIMIT + 100; i++) s.add(`sig-${i}`);
    trimSeen(s);
    // Should have pruned down to around half the limit
    expect(s.size).toBeLessThan(SEEN_LIMIT);
    // Oldest entries are gone, newest are retained
    expect(s.has('sig-0')).toBe(false);
    expect(s.has(`sig-${SEEN_LIMIT + 99}`)).toBe(true);
  });
});

describe('estimateSolLiquidity', () => {
  it('returns 0 for null meta', () => {
    expect(estimateSolLiquidity(null)).toBe(0);
  });

  it('returns the largest SOL outflow in the tx', () => {
    const sol = 1_000_000_000;
    const meta = {
      preBalances: [10 * sol, 5 * sol, 1 * sol],
      postBalances: [10 * sol, 1 * sol, 1 * sol], // account 1 lost 4 SOL
    };
    expect(estimateSolLiquidity(meta)).toBeCloseTo(4);
  });

  it('ignores balance increases (treats as non-liquidity)', () => {
    const sol = 1_000_000_000;
    const meta = {
      preBalances: [1 * sol],
      postBalances: [10 * sol], // received, not spent
    };
    expect(estimateSolLiquidity(meta)).toBe(0);
  });
});

describe('parsePoolFromSignature', () => {
  function makeConnection(tx: unknown) {
    return {
      getParsedTransaction: vi.fn().mockResolvedValue(tx),
    } as any;
  }

  function mintPk(s: string): PublicKey {
    return new PublicKey(s);
  }

  const tokenMint = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'; // USDC, just a valid PK

  function poolTx(accounts: PublicKey[]) {
    return {
      blockTime: 1_700_000_000,
      transaction: {
        message: {
          instructions: [
            {
              programId: PROGRAM_IDS.RAYDIUM_AMM,
              accounts,
            },
          ],
        },
      },
      meta: {
        preBalances: [5_000_000_000, 1_000_000_000],
        postBalances: [5_000_000_000, 500_000_000],
      },
    };
  }

  it('returns null when transaction is missing', async () => {
    const conn = makeConnection(null);
    expect(await parsePoolFromSignature(conn, 'sig')).toBeNull();
  });

  it('parses a SOL/token pool and identifies the token mint', async () => {
    const accounts = [
      mintPk('11111111111111111111111111111111'), // 0
      mintPk('11111111111111111111111111111111'), // 1
      mintPk('11111111111111111111111111111111'), // 2
      mintPk('11111111111111111111111111111111'), // 3
      mintPk('11111111111111111111111111111111'), // 4 poolAddress (placeholder)
      mintPk('11111111111111111111111111111111'), // 5
      mintPk('11111111111111111111111111111111'), // 6
      mintPk('11111111111111111111111111111111'), // 7
      mintPk(SOL_MINT_ADDRESS), // 8 coin mint (SOL)
      mintPk(tokenMint), // 9 pc mint (the new token)
    ];
    const conn = makeConnection(poolTx(accounts));

    const pool = await parsePoolFromSignature(conn, 'sig');
    expect(pool).not.toBeNull();
    expect(pool!.tokenMint).toBe(tokenMint);
    expect(pool!.baseMint).toBe(SOL_MINT_ADDRESS);
    expect(pool!.initialLiquiditySol).toBeCloseTo(0.5);
    expect(pool!.timestamp).toBe(1_700_000_000);
    expect(pool!.txSignature).toBe('sig');
  });

  it('returns null for a token-token pool (no SOL side)', async () => {
    const accounts = [
      mintPk('11111111111111111111111111111111'),
      mintPk('11111111111111111111111111111111'),
      mintPk('11111111111111111111111111111111'),
      mintPk('11111111111111111111111111111111'),
      mintPk('11111111111111111111111111111111'),
      mintPk('11111111111111111111111111111111'),
      mintPk('11111111111111111111111111111111'),
      mintPk('11111111111111111111111111111111'),
      mintPk(tokenMint),
      mintPk('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'),
    ];
    const conn = makeConnection(poolTx(accounts));
    expect(await parsePoolFromSignature(conn, 'sig')).toBeNull();
  });

  it('swallows RPC errors and returns null', async () => {
    const conn = {
      getParsedTransaction: vi.fn().mockRejectedValue(new Error('rpc down')),
    } as any;
    expect(await parsePoolFromSignature(conn, 'sig')).toBeNull();
  });

  it('skips non-Raydium instructions', async () => {
    const tx = {
      blockTime: 1,
      transaction: {
        message: {
          instructions: [
            {
              programId: PROGRAM_IDS.TOKEN_PROGRAM,
              accounts: new Array(12).fill(mintPk(SOL_MINT_ADDRESS)),
            },
          ],
        },
      },
      meta: { preBalances: [], postBalances: [] },
    };
    const conn = makeConnection(tx);
    expect(await parsePoolFromSignature(conn, 'sig')).toBeNull();
  });
});
