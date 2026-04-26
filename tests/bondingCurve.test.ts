import { describe, expect, it, vi } from 'vitest';
import {
  bondingCurvePriceSol,
  decodeBondingCurve,
  fetchBondingCurvePrice,
} from '../src/bondingCurve';

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

describe('fetchBondingCurvePrice', () => {
  function fakeConnection(info: { data: Buffer } | null) {
    return { getAccountInfo: vi.fn().mockResolvedValue(info) } as any;
  }

  it('returns the curve price when the account exists and is active', async () => {
    const buf = buildCurve({
      virtualSol: INIT_VIRTUAL_SOL,
      virtualTokens: INIT_VIRTUAL_TOKENS,
    });
    const price = await fetchBondingCurvePrice(
      fakeConnection({ data: buf }),
      'So11111111111111111111111111111111111111112'
    );
    expect(price).toBeCloseTo(30 / 1_073_000_000, 12);
  });

  it('returns null when the bonding curve account is missing', async () => {
    const price = await fetchBondingCurvePrice(
      fakeConnection(null),
      'So11111111111111111111111111111111111111112'
    );
    expect(price).toBeNull();
  });

  it('swallows RPC errors and returns null', async () => {
    const conn = {
      getAccountInfo: vi.fn().mockRejectedValue(new Error('rpc down')),
    } as any;
    const price = await fetchBondingCurvePrice(
      conn,
      'So11111111111111111111111111111111111111112'
    );
    expect(price).toBeNull();
  });
});
