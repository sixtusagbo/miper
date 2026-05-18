import { Connection, PublicKey } from '@solana/web3.js';
import { logger } from './logger';
import { PROGRAM_IDS } from './config';

// pump.fun bonding-curve account layout (Anchor-encoded):
//   [0..8)    discriminator (sha256("account:BondingCurve")[..8])
//   [8..16)   virtualTokenReserves: u64 LE
//   [16..24)  virtualSolReserves:   u64 LE   (named virtual_quote_reserves in
//             IDL after the multi-quote refactor — same field, same offset)
//   [24..32)  realTokenReserves:    u64 LE
//   [32..40)  realSolReserves:      u64 LE
//   [40..48)  tokenTotalSupply:     u64 LE
//   [48..49)  complete:             bool
//   [49..81)  creator:              pubkey  (added with creator-fee rollout;
//             required for the buy/sell ix to derive creator_vault PDA)
//   [81..82)  isMayhemMode:         bool
//   [82..83)  isCashbackCoin:       bool
//   [83..115) quoteMint:            pubkey
const BONDING_CURVE_MIN_SIZE = 8 + 5 * 8 + 1;
const BONDING_CURVE_CREATOR_OFFSET = BONDING_CURVE_MIN_SIZE;
const BONDING_CURVE_CREATOR_END = BONDING_CURVE_CREATOR_OFFSET + 32;
// is_mayhem_mode: the bool byte immediately after the creator pubkey.
const BONDING_CURVE_MAYHEM_OFFSET = BONDING_CURVE_CREATOR_END;

const SOL_LAMPORTS = 1_000_000_000;
// pump.fun mints have 6 decimals fixed by the program's global config.
export const PUMP_TOKEN_BASE_UNITS = 1_000_000;

export interface BondingCurveState {
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
  // Null on legacy 49-byte buffers (test fixtures pre-creator-fees). Live
  // on-chain accounts always carry it; live trades need it to derive the
  // creator_vault PDA.
  creator: PublicKey | null;
  // pump.fun "Mayhem Mode" flag (byte 81). Mayhem coins can enter a Paused
  // state where the bonding-curve sell reverts with Custom:6024 — unsellable
  // trapped capital. False on buffers too short to carry the byte (legacy
  // 49-byte test fixtures).
  isMayhemMode: boolean;
}

export function decodeBondingCurve(data: Buffer): BondingCurveState {
  if (data.length < BONDING_CURVE_MIN_SIZE) {
    throw new Error(
      `bonding curve account too short: ${data.length} bytes (need >= ${BONDING_CURVE_MIN_SIZE})`
    );
  }
  let offset = 8; // skip discriminator
  const virtualTokenReserves = data.readBigUInt64LE(offset); offset += 8;
  const virtualSolReserves = data.readBigUInt64LE(offset); offset += 8;
  const realTokenReserves = data.readBigUInt64LE(offset); offset += 8;
  const realSolReserves = data.readBigUInt64LE(offset); offset += 8;
  const tokenTotalSupply = data.readBigUInt64LE(offset); offset += 8;
  const complete = data[offset] === 1;
  const creator =
    data.length >= BONDING_CURVE_CREATOR_END
      ? new PublicKey(data.subarray(BONDING_CURVE_CREATOR_OFFSET, BONDING_CURVE_CREATOR_END))
      : null;
  const isMayhemMode =
    data.length > BONDING_CURVE_MAYHEM_OFFSET &&
    data[BONDING_CURVE_MAYHEM_OFFSET] === 1;
  return {
    virtualTokenReserves,
    virtualSolReserves,
    realTokenReserves,
    realSolReserves,
    tokenTotalSupply,
    complete,
    creator,
    isMayhemMode,
  };
}

// Derive a pump.fun token's bonding-curve PDA — seeds ["bonding-curve", mint].
export function bondingCurvePda(mint: string): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), new PublicKey(mint).toBuffer()],
    PROGRAM_IDS.PUMP_FUN
  )[0];
}

// SOL per token (human units) implied by the curve's current virtual
// reserves: (sol_lamports / 1e9) / (token_base_units / 1e6). Returns null if
// the curve has graduated (caller should fall back to a DEX price source) or
// reserves are zero/malformed.
export function bondingCurvePriceSol(state: BondingCurveState): number | null {
  if (state.complete) return null;
  if (state.virtualTokenReserves === 0n) return null;
  const sol = Number(state.virtualSolReserves) / SOL_LAMPORTS;
  const tokens = Number(state.virtualTokenReserves) / PUMP_TOKEN_BASE_UNITS;
  if (!Number.isFinite(sol) || !Number.isFinite(tokens) || tokens === 0) return null;
  return sol / tokens;
}

// Three exclusive outcomes for a single curve read. Callers that cache on
// "graduated" MUST distinguish this from "unavailable" — collapsing both
// into null poisons the cache on every transient RPC failure (R11 bug:
// one ~600ms RPC blip flipped 48/50 positions to "graduated" forever and
// the bot never exited any of them).
export type CurveReading =
  | { kind: 'price'; priceSol: number }
  | { kind: 'graduated' }
  | { kind: 'unavailable' };

// Per-curve last-read cache. R12 burned 185k getAccountInfo calls in 22h
// (~18% of Helius free-tier per day) reading the same curves on every
// 10s monitor tick. A few seconds of staleness on a bonding-curve price
// is fine — buys/sells move it but not violently within ~5s.
//
// Only 'price' readings are cached. 'unavailable' is treated as transient
// so the next tick retries cleanly; 'graduated' is terminal and handled
// by positions.ts's graduatedCurves Set rather than this cache (that set
// is permanent for the run; a TTL cache would expire and re-fetch).
let cacheTtlMs = 5000;
const priceCache = new Map<string, { reading: CurveReading; fetchedAt: number }>();

export function setBondingCurveCacheTtl(ms: number): void {
  cacheTtlMs = Math.max(0, ms);
}

export function clearBondingCurveCache(): void {
  priceCache.clear();
}

export async function readBondingCurve(
  connection: Connection,
  bondingCurveAddress: string
): Promise<CurveReading> {
  if (cacheTtlMs > 0) {
    const entry = priceCache.get(bondingCurveAddress);
    if (entry && Date.now() - entry.fetchedAt < cacheTtlMs) {
      return entry.reading;
    }
  }
  try {
    const info = await connection.getAccountInfo(new PublicKey(bondingCurveAddress));
    if (!info?.data) return { kind: 'unavailable' };
    const state = decodeBondingCurve(Buffer.from(info.data));
    if (state.complete) return { kind: 'graduated' };
    const priceSol = bondingCurvePriceSol(state);
    // virtualTokenReserves==0 means the curve is drained / migrated; not
    // transient, treat as graduated.
    if (priceSol === null) return { kind: 'graduated' };
    const reading: CurveReading = { kind: 'price', priceSol };
    if (cacheTtlMs > 0) {
      priceCache.set(bondingCurveAddress, { reading, fetchedAt: Date.now() });
    }
    return reading;
  } catch (err) {
    logger.debug(
      `readBondingCurve ${bondingCurveAddress}: ${(err as Error).message}`
    );
    return { kind: 'unavailable' };
  }
}

// True only if `tokenMint` is a pump.fun bonding-curve token currently in
// Mayhem Mode. Mayhem coins can enter a Paused state where the sell reverts
// (Custom:6024) and capital is trapped — never buy one. A non-pump token, a
// graduated curve, or an unreadable account all return false: nothing to veto.
export async function isMayhemToken(
  connection: Connection,
  tokenMint: string
): Promise<boolean> {
  try {
    const info = await connection.getAccountInfo(bondingCurvePda(tokenMint));
    if (!info?.data) return false;
    return decodeBondingCurve(Buffer.from(info.data)).isMayhemMode;
  } catch (err) {
    logger.debug(`isMayhemToken ${tokenMint}: ${(err as Error).message}`);
    return false;
  }
}
