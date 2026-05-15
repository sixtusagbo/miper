import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import {
  bondingCurvePriceSol,
  clearBondingCurveCache,
  decodeBondingCurve,
  readBondingCurve,
} from '../src/bondingCurve';

beforeEach(() => {
  clearBondingCurveCache();
});

// Builds a bonding curve account buffer matching the Anchor layout we decode:
// 8 bytes discriminator, 5 little-endian u64 reserves, 1 byte complete flag.
function buildCurve(opts: {
  virtualTokens?: bigint;
  virtualSol?: bigint;
  realTokens?: bigint;
  realSol?: bigint;
  totalSupply?: bigint;
  complete?: boolean;
}): Buffer {
  const buf = Buffer.alloc(8 + 5 * 8 + 1);
  // Leave the discriminator zeroed; decoder doesn't validate it.
  let offset = 8;
  buf.writeBigUInt64LE(opts.virtualTokens ?? 0n, offset); offset += 8;
  buf.writeBigUInt64LE(opts.virtualSol ?? 0n, offset); offset += 8;
  buf.writeBigUInt64LE(opts.realTokens ?? 0n, offset); offset += 8;
  buf.writeBigUInt64LE(opts.realSol ?? 0n, offset); offset += 8;
  buf.writeBigUInt64LE(opts.totalSupply ?? 0n, offset); offset += 8;
  buf[offset] = opts.complete ? 1 : 0;
  return buf;
}

const INIT_VIRTUAL_SOL = 30n * 1_000_000_000n;          // 30 SOL in lamports
const INIT_VIRTUAL_TOKENS = 1_073_000_000n * 1_000_000n; // 1.073B tokens, 6 decimals

describe('decodeBondingCurve', () => {
  it('reads all six fields off the borsh-packed layout', () => {
    const buf = buildCurve({
      virtualTokens: INIT_VIRTUAL_TOKENS,
      virtualSol: INIT_VIRTUAL_SOL,
      realTokens: 1n,
      realSol: 2n,
      totalSupply: 1_000_000_000n * 1_000_000n,
      complete: false,
    });
    const state = decodeBondingCurve(buf);
    expect(state.virtualTokenReserves).toBe(INIT_VIRTUAL_TOKENS);
    expect(state.virtualSolReserves).toBe(INIT_VIRTUAL_SOL);
    expect(state.realTokenReserves).toBe(1n);
    expect(state.realSolReserves).toBe(2n);
    expect(state.tokenTotalSupply).toBe(1_000_000_000n * 1_000_000n);
    expect(state.complete).toBe(false);
  });

  it('leaves creator as null on the legacy 49-byte buffer (test fixtures)', () => {
    const state = decodeBondingCurve(buildCurve({}));
    expect(state.creator).toBeNull();
  });

  it('reads creator off a buffer that includes the post-creator-fees layout', () => {
    const creatorPk = new PublicKey('11111111111111111111111111111113');
    // 49-byte legacy buffer plus 32 bytes of creator pubkey.
    const full = Buffer.concat([buildCurve({}), creatorPk.toBuffer()]);
    const state = decodeBondingCurve(full);
    expect(state.creator).not.toBeNull();
    expect(state.creator!.toBase58()).toBe(creatorPk.toBase58());
  });

  it('throws on a buffer too short for the layout', () => {
    expect(() => decodeBondingCurve(Buffer.alloc(40))).toThrow(/too short/);
  });
});

describe('bondingCurvePriceSol', () => {
  it('matches the documented launch price (~2.796e-8 SOL/token)', () => {
    const state = decodeBondingCurve(
      buildCurve({
        virtualSol: INIT_VIRTUAL_SOL,
        virtualTokens: INIT_VIRTUAL_TOKENS,
      })
    );
    const price = bondingCurvePriceSol(state);
    expect(price).not.toBeNull();
    expect(price!).toBeCloseTo(30 / 1_073_000_000, 12);
  });

  it('rises as virtual SOL reserves grow under buy pressure', () => {
    // Doubling SOL reserves at fixed token reserves doubles price. The real
    // curve has paired changes via constant-product, but for the decoder
    // test we only need the pricing helper to read what's there.
    const state = decodeBondingCurve(
      buildCurve({
        virtualSol: INIT_VIRTUAL_SOL * 2n,
        virtualTokens: INIT_VIRTUAL_TOKENS,
      })
    );
    expect(bondingCurvePriceSol(state)!).toBeCloseTo(2 * (30 / 1_073_000_000), 12);
  });

  it('returns null once the curve has graduated (complete=true)', () => {
    const state = decodeBondingCurve(
      buildCurve({
        virtualSol: INIT_VIRTUAL_SOL,
        virtualTokens: INIT_VIRTUAL_TOKENS,
        complete: true,
      })
    );
    expect(bondingCurvePriceSol(state)).toBeNull();
  });

  it('returns null when virtual token reserves are zero (malformed/migrated)', () => {
    const state = decodeBondingCurve(buildCurve({ virtualSol: INIT_VIRTUAL_SOL }));
    expect(bondingCurvePriceSol(state)).toBeNull();
  });
});

describe('readBondingCurve', () => {
  function fakeConnection(info: { data: Buffer } | null) {
    return { getAccountInfo: vi.fn().mockResolvedValue(info) } as any;
  }
  const ADDR = 'So11111111111111111111111111111111111111112';

  it('returns kind=price with the curve price when the account is active', async () => {
    const buf = buildCurve({
      virtualSol: INIT_VIRTUAL_SOL,
      virtualTokens: INIT_VIRTUAL_TOKENS,
    });
    const reading = await readBondingCurve(fakeConnection({ data: buf }), ADDR);
    expect(reading.kind).toBe('price');
    if (reading.kind === 'price') {
      expect(reading.priceSol).toBeCloseTo(30 / 1_073_000_000, 12);
    }
  });

  it('returns kind=graduated when complete=true on the decoded state', async () => {
    const buf = buildCurve({
      virtualSol: INIT_VIRTUAL_SOL,
      virtualTokens: INIT_VIRTUAL_TOKENS,
      complete: true,
    });
    const reading = await readBondingCurve(fakeConnection({ data: buf }), ADDR);
    expect(reading).toEqual({ kind: 'graduated' });
  });

  it('returns kind=graduated when virtual reserves are drained to zero', async () => {
    const buf = buildCurve({ virtualSol: INIT_VIRTUAL_SOL, virtualTokens: 0n });
    const reading = await readBondingCurve(fakeConnection({ data: buf }), ADDR);
    expect(reading).toEqual({ kind: 'graduated' });
  });

  it('returns kind=unavailable when the account info is missing', async () => {
    const reading = await readBondingCurve(fakeConnection(null), ADDR);
    expect(reading).toEqual({ kind: 'unavailable' });
  });

  it('returns kind=unavailable on RPC errors (must NOT collapse to graduated)', async () => {
    const conn = {
      getAccountInfo: vi.fn().mockRejectedValue(new Error('rpc down')),
    } as any;
    const reading = await readBondingCurve(conn, ADDR);
    expect(reading).toEqual({ kind: 'unavailable' });
  });
});

describe('readBondingCurve cache', () => {
  // Default 5s TTL; addresses are unique per test thanks to the
  // top-level beforeEach() that calls clearBondingCurveCache().
  const ADDR = 'So11111111111111111111111111111111111111112';
  function priceBuf() {
    return buildCurve({
      virtualSol: INIT_VIRTUAL_SOL,
      virtualTokens: INIT_VIRTUAL_TOKENS,
    });
  }

  it('returns the cached price on a second call within TTL without re-reading the RPC', async () => {
    const getAccountInfo = vi.fn().mockResolvedValue({ data: priceBuf() });
    const conn = { getAccountInfo } as any;

    const first = await readBondingCurve(conn, ADDR);
    const second = await readBondingCurve(conn, ADDR);

    expect(first).toEqual(second);
    expect(getAccountInfo).toHaveBeenCalledTimes(1);
  });

  it('does NOT cache unavailable readings (transient failures must retry)', async () => {
    const getAccountInfo = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ data: priceBuf() });
    const conn = { getAccountInfo } as any;

    const first = await readBondingCurve(conn, ADDR);
    const second = await readBondingCurve(conn, ADDR);

    expect(first).toEqual({ kind: 'unavailable' });
    expect(second.kind).toBe('price');
    expect(getAccountInfo).toHaveBeenCalledTimes(2);
  });

  it('does NOT cache graduated readings (graduatedCurves Set is the terminal store)', async () => {
    const graduated = buildCurve({
      virtualSol: INIT_VIRTUAL_SOL,
      virtualTokens: INIT_VIRTUAL_TOKENS,
      complete: true,
    });
    const getAccountInfo = vi.fn().mockResolvedValue({ data: graduated });
    const conn = { getAccountInfo } as any;

    await readBondingCurve(conn, ADDR);
    await readBondingCurve(conn, ADDR);

    expect(getAccountInfo).toHaveBeenCalledTimes(2);
  });
});
