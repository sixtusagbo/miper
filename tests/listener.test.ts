import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import {
  SEEN_LIMIT,
  estimateSolLiquidity,
  isInitLog,
  isPumpCreateLog,
  parsePoolFromSignature,
  parsePumpMintFromSignature,
  trimSeen,
} from '../src/listener';
import { PROGRAM_IDS, SOL_MINT_ADDRESS } from '../src/config';

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  process.env.OPENAI_API_KEY = 'sk-openai-test';
  process.env.AI_PROVIDER = 'anthropic';
  process.env.WALLET_PRIVATE_KEY = '';
  process.env.SIMULATE = 'true';
  process.env.LOG_LEVEL = 'error';
});

describe('isInitLog', () => {
  it('matches init-specific keywords', () => {
    expect(isInitLog(['Program log: initialize2 success'])).toBe(true);
    expect(isInitLog(['Program log: Initialize2'])).toBe(true);
    expect(isInitLog(['Program log: init_pc_amount: 1000'])).toBe(true);
  });

  it('does NOT match ray_log alone (appears in every Raydium tx)', () => {
    expect(isInitLog(['Program log: ray_log: A1B2C3'])).toBe(false);
    expect(isInitLog(['Program log: Instruction: Swap', 'Program log: ray_log: xyz'])).toBe(false);
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

describe('PoolListener', () => {
  function setupListenerConnection(tx: unknown) {
    let capturedCallback: ((r: any) => void) | null = null;
    const conn = {
      onLogs: vi.fn((_: unknown, cb: (r: any) => void) => {
        capturedCallback = cb;
        return 42;
      }),
      removeOnLogsListener: vi.fn().mockResolvedValue(undefined),
      getParsedTransaction: vi.fn().mockResolvedValue(tx),
    } as any;
    return { conn, invoke: () => capturedCallback };
  }

  it('emits newPool when a matching log comes through', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
  process.env.OPENAI_API_KEY = 'sk-openai-test';
  process.env.AI_PROVIDER = 'anthropic';
    process.env.WALLET_PRIVATE_KEY = '';
    process.env.SIMULATE = 'true';
    process.env.LOG_LEVEL = 'error';
    const { resetConfigCache } = await import('../src/config');
    resetConfigCache();

    const tokenMint = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
    const accounts = new Array(10)
      .fill(null)
      .map(() => new PublicKey('11111111111111111111111111111111'));
    accounts[8] = new PublicKey(SOL_MINT_ADDRESS);
    accounts[9] = new PublicKey(tokenMint);
    const tx = {
      blockTime: 1,
      transaction: {
        message: { instructions: [{ programId: PROGRAM_IDS.RAYDIUM_AMM, accounts }] },
      },
      meta: { preBalances: [1_000_000_000], postBalances: [500_000_000] },
    };
    const { conn, invoke } = setupListenerConnection(tx);

    const { PoolListener } = await import('../src/listener');
    const listener = new PoolListener(conn);
    const spy = vi.fn();
    listener.on('newPool', spy);
    await listener.start();

    const cb = invoke()!;
    await cb({
      signature: 'SIG1',
      logs: ['Program log: initialize2 success'],
      err: null,
    });
    // Let the async handleLogs settle
    await new Promise((r) => setImmediate(r));

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0].tokenMint).toBe(tokenMint);
    await listener.stop();
  });

  it('ignores logs that do not contain init keywords', async () => {
    const { conn, invoke } = setupListenerConnection(null);
    const { PoolListener } = await import('../src/listener');
    const listener = new PoolListener(conn);
    const spy = vi.fn();
    listener.on('newPool', spy);
    await listener.start();

    await invoke()!({ signature: 'S', logs: ['swap'], err: null });
    await new Promise((r) => setImmediate(r));
    expect(spy).not.toHaveBeenCalled();
    expect(conn.getParsedTransaction).not.toHaveBeenCalled();
    await listener.stop();
  });

  it('increments heartbeat counters for events and emissions', async () => {
    const tokenMint = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
    const accounts = new Array(10)
      .fill(null)
      .map(() => new PublicKey('11111111111111111111111111111111'));
    accounts[8] = new PublicKey(SOL_MINT_ADDRESS);
    accounts[9] = new PublicKey(tokenMint);
    const tx = {
      blockTime: 1,
      transaction: {
        message: { instructions: [{ programId: PROGRAM_IDS.RAYDIUM_AMM, accounts }] },
      },
      meta: { preBalances: [0], postBalances: [0] },
    };
    const { conn, invoke } = setupListenerConnection(tx);
    const { PoolListener } = await import('../src/listener');
    // heartbeatMs=0 disables the interval, so counters don't reset mid-test
    const listener = new PoolListener(conn, 0);
    await listener.start();

    const cb = invoke()!;
    await cb({ signature: 'SWAP', logs: ['Program log: ray_log: xx'], err: null });
    await cb({ signature: 'INIT', logs: ['Program log: Initialize2'], err: null });
    await new Promise((r) => setImmediate(r));

    const c = listener.getCounters();
    expect(c.events).toBe(2);
    expect(c.initMatches).toBe(1);
    expect(c.poolsEmitted).toBe(1);
    await listener.stop();
  });

  it('reconnects after N consecutive empty heartbeat windows', async () => {
    const { conn: connA } = setupListenerConnection(null);
    const { conn: connB } = setupListenerConnection(null);
    let factoryCalls = 0;
    const factory = () => {
      factoryCalls++;
      return connB;
    };

    const { PoolListener } = await import('../src/listener');
    const listener = new PoolListener(connA, 100, {
      reconnectAfterEmptyWindows: 2,
      connectionFactory: factory,
    });
    await listener.start();
    expect(connA.onLogs).toHaveBeenCalledTimes(1);

    // First empty window — just a warning, no reconnect.
    (listener as any).logHeartbeat();
    expect(factoryCalls).toBe(0);

    // Second empty window — reconnect fires.
    (listener as any).logHeartbeat();
    await new Promise((r) => setImmediate(r));

    expect(factoryCalls).toBe(1);
    expect(connA.removeOnLogsListener).toHaveBeenCalledTimes(1);
    expect(connB.onLogs).toHaveBeenCalledTimes(1);
    await listener.stop();
  });

  it('resets the empty-window counter when events arrive', async () => {
    const { conn, invoke } = setupListenerConnection(null);
    let factoryCalls = 0;
    const factory = () => {
      factoryCalls++;
      return conn;
    };

    const { PoolListener } = await import('../src/listener');
    const listener = new PoolListener(conn, 100, {
      reconnectAfterEmptyWindows: 2,
      connectionFactory: factory,
    });
    await listener.start();

    (listener as any).logHeartbeat(); // empty window 1
    // Inject an event so the next heartbeat sees events > 0.
    const cb = invoke()!;
    await cb({ signature: 'X', logs: ['swap'], err: null });

    (listener as any).logHeartbeat(); // non-empty -> resets counter
    (listener as any).logHeartbeat(); // empty again — only 1 in a row
    await new Promise((r) => setImmediate(r));

    expect(factoryCalls).toBe(0);
    await listener.stop();
  });

  it('deduplicates repeat signatures', async () => {
    const tokenMint = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
    const accounts = new Array(10)
      .fill(null)
      .map(() => new PublicKey('11111111111111111111111111111111'));
    accounts[8] = new PublicKey(SOL_MINT_ADDRESS);
    accounts[9] = new PublicKey(tokenMint);
    const tx = {
      blockTime: 1,
      transaction: {
        message: { instructions: [{ programId: PROGRAM_IDS.RAYDIUM_AMM, accounts }] },
      },
      meta: { preBalances: [0], postBalances: [0] },
    };
    const { conn, invoke } = setupListenerConnection(tx);
    const { PoolListener } = await import('../src/listener');
    const listener = new PoolListener(conn);
    const spy = vi.fn();
    listener.on('newPool', spy);
    await listener.start();

    const cb = invoke()!;
    const logs = ['initialize2'];
    await cb({ signature: 'DUP', logs, err: null });
    await new Promise((r) => setImmediate(r));
    await cb({ signature: 'DUP', logs, err: null });
    await new Promise((r) => setImmediate(r));

    expect(spy).toHaveBeenCalledTimes(1);
    await listener.stop();
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

describe('isPumpCreateLog', () => {
  it('matches the pump.fun Create instruction log line', () => {
    expect(isPumpCreateLog(['Program log: Instruction: Create'])).toBe(true);
    expect(isPumpCreateLog(['noise', 'Program log: Instruction: Create', 'more'])).toBe(true);
  });

  it('ignores non-Create pump logs', () => {
    expect(isPumpCreateLog(['Program log: Instruction: Buy'])).toBe(false);
    expect(isPumpCreateLog(['Program log: Instruction: Sell'])).toBe(false);
    expect(isPumpCreateLog([])).toBe(false);
    expect(isPumpCreateLog(undefined)).toBe(false);
  });
});

describe('parsePumpMintFromSignature', () => {
  const newMint = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
  const bondingCurve = 'So11111111111111111111111111111111111111112';

  function makeConnection(tx: unknown) {
    return { getParsedTransaction: vi.fn().mockResolvedValue(tx) } as any;
  }

  it('extracts the mint from accounts[0] of the pump.fun instruction', async () => {
    const accounts = [
      new PublicKey(newMint),              // 0 mint
      new PublicKey('11111111111111111111111111111111'), // 1 mint_authority
      new PublicKey(bondingCurve),         // 2 bonding_curve
    ];
    const tx = {
      blockTime: 1_700_000_000,
      transaction: {
        message: {
          instructions: [{ programId: PROGRAM_IDS.PUMP_FUN, accounts }],
        },
      },
      meta: { preBalances: [2_000_000_000], postBalances: [1_500_000_000] }, // 0.5 SOL creator deposit
    };
    const pool = await parsePumpMintFromSignature(makeConnection(tx), 'sig');
    expect(pool).not.toBeNull();
    expect(pool!.tokenMint).toBe(newMint);
    expect(pool!.poolAddress).toBe(bondingCurve);
    expect(pool!.baseMint).toBe(SOL_MINT_ADDRESS);
    expect(pool!.initialLiquiditySol).toBeCloseTo(0.5);
    expect(pool!.timestamp).toBe(1_700_000_000);
  });

  it('returns null when no pump instruction is present', async () => {
    const tx = {
      blockTime: 1,
      transaction: {
        message: {
          instructions: [{ programId: PROGRAM_IDS.TOKEN_PROGRAM, accounts: [] }],
        },
      },
      meta: { preBalances: [], postBalances: [] },
    };
    expect(await parsePumpMintFromSignature(makeConnection(tx), 'sig')).toBeNull();
  });

  it('swallows RPC errors and returns null', async () => {
    const conn = {
      getParsedTransaction: vi.fn().mockRejectedValue(new Error('rpc down')),
    } as any;
    expect(await parsePumpMintFromSignature(conn, 'sig')).toBeNull();
  });
});

describe('PumpListener', () => {
  function setupListenerConnection(tx: unknown) {
    let capturedCallback: ((r: any) => void) | null = null;
    const conn = {
      onLogs: vi.fn((_: unknown, cb: (r: any) => void) => {
        capturedCallback = cb;
        return 99;
      }),
      removeOnLogsListener: vi.fn().mockResolvedValue(undefined),
      getParsedTransaction: vi.fn().mockResolvedValue(tx),
    } as any;
    return { conn, invoke: () => capturedCallback };
  }

  it('emits newPool when a pump.fun Create log comes through', async () => {
    const newMint = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
    const accounts = [
      new PublicKey(newMint),
      new PublicKey('11111111111111111111111111111111'),
      new PublicKey(SOL_MINT_ADDRESS),
    ];
    const tx = {
      blockTime: 10,
      transaction: {
        message: {
          instructions: [{ programId: PROGRAM_IDS.PUMP_FUN, accounts }],
        },
      },
      meta: { preBalances: [1_000_000_000], postBalances: [900_000_000] },
    };
    const { conn, invoke } = setupListenerConnection(tx);

    const { PumpListener } = await import('../src/listener');
    const listener = new PumpListener(conn, 0);
    const spy = vi.fn();
    listener.on('newPool', spy);
    await listener.start();

    const cb = invoke()!;
    await cb({
      signature: 'SIG_PUMP',
      logs: ['Program log: Instruction: Create'],
      err: null,
    });
    await new Promise((r) => setImmediate(r));

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0].tokenMint).toBe(newMint);
    // Pump subscribes to the pump.fun program, not Raydium.
    expect(conn.onLogs).toHaveBeenCalledWith(
      PROGRAM_IDS.PUMP_FUN,
      expect.any(Function),
      'confirmed'
    );
    await listener.stop();
  });

  it('ignores non-Create pump logs', async () => {
    const { conn, invoke } = setupListenerConnection(null);
    const { PumpListener } = await import('../src/listener');
    const listener = new PumpListener(conn, 0);
    const spy = vi.fn();
    listener.on('newPool', spy);
    await listener.start();

    await invoke()!({ signature: 'S', logs: ['Program log: Instruction: Buy'], err: null });
    await new Promise((r) => setImmediate(r));
    expect(spy).not.toHaveBeenCalled();
    expect(conn.getParsedTransaction).not.toHaveBeenCalled();
    await listener.stop();
  });
});
