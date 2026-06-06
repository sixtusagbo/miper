import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, resetConfigCache, Config } from '../src/config';
import { usePumpVenue } from '../src/trader';
import { clearBondingCurveCache } from '../src/bondingCurve';

// Minimal active bonding-curve account buffer: 8-byte discriminator, 5 u64
// reserves (virtual sol/tokens non-zero so a price is computable), complete=0.
function activeCurveBuffer(): Buffer {
  const buf = Buffer.alloc(8 + 5 * 8 + 1);
  let off = 8;
  buf.writeBigUInt64LE(1_073_000_000n * 1_000_000n, off); off += 8; // virtualTokens
  buf.writeBigUInt64LE(30n * 1_000_000_000n, off); off += 8;        // virtualSol
  buf.writeBigUInt64LE(1n, off); off += 8;                          // realTokens
  buf.writeBigUInt64LE(0n, off); off += 8;                          // realSol
  buf.writeBigUInt64LE(1_000_000_000n, off); off += 8;             // totalSupply
  buf[off] = 0; // not complete
  return buf;
}

function fakeConn(accountInfo: { data: Buffer } | null) {
  return { getAccountInfo: vi.fn().mockResolvedValue(accountInfo) } as never;
}

// Distinct valid base58 mints so bondingCurvePda() differs and the per-address
// curve cache doesn't bleed between cases.
const MINT_A = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const MINT_B = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function cfg(source: Config['source']): Config {
  resetConfigCache();
  process.env.SOURCE = source;
  process.env.SIMULATE = 'true';
  process.env.WALLET_PRIVATE_KEY = '';
  process.env.OPENAI_API_KEY = 'sk-test';
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  process.env.LOG_LEVEL = 'error';
  return loadConfig();
}

beforeEach(() => clearBondingCurveCache());

describe('usePumpVenue', () => {
  it('routes copytrade to the pump venue when the token is on an active curve', async () => {
    const conn = fakeConn({ data: activeCurveBuffer() });
    expect(await usePumpVenue(MINT_A, cfg('copytrade'), conn)).toBe(true);
  });

  it('routes copytrade to Jupiter when there is no bonding curve (graduated/non-pump)', async () => {
    const conn = fakeConn(null); // no curve account -> unavailable -> Jupiter
    expect(await usePumpVenue(MINT_B, cfg('copytrade'), conn)).toBe(false);
  });

  it('always uses the pump venue for the pump source, without an RPC read', async () => {
    const conn = fakeConn(null);
    expect(await usePumpVenue(MINT_A, cfg('pump'), conn)).toBe(true);
    expect((conn as unknown as { getAccountInfo: ReturnType<typeof vi.fn> }).getAccountInfo)
      .not.toHaveBeenCalled();
  });

  it('never uses the pump venue for non-pump, non-copytrade sources', async () => {
    const conn = fakeConn({ data: activeCurveBuffer() });
    expect(await usePumpVenue(MINT_A, cfg('raydium'), conn)).toBe(false);
  });
});
