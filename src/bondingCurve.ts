import { Connection, PublicKey } from '@solana/web3.js';
import { logger } from './logger';

// pump.fun bonding-curve account layout (Anchor-encoded):
//   [0..8)   discriminator (sha256("account:BondingCurve")[..8])
//   [8..16)  virtualTokenReserves: u64 LE
//   [16..24) virtualSolReserves:   u64 LE
//   [24..32) realTokenReserves:    u64 LE
//   [32..40) realSolReserves:      u64 LE
//   [40..48) tokenTotalSupply:     u64 LE
//   [48..49) complete:             bool
const BONDING_CURVE_MIN_SIZE = 8 + 5 * 8 + 1;

const SOL_LAMPORTS = 1_000_000_000;
// pump.fun mints are Token-2022 with 6 decimals fixed by the program global
// config. If pump ever changes this, the price math here breaks.
const PUMP_TOKEN_BASE_UNITS = 1_000_000;

export interface BondingCurveState {
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
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
  return {
    virtualTokenReserves,
    virtualSolReserves,
    realTokenReserves,
    realSolReserves,
    tokenTotalSupply,
    complete,
  };
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

export async function fetchBondingCurvePrice(
  connection: Connection,
  bondingCurveAddress: string
): Promise<number | null> {
  try {
    const info = await connection.getAccountInfo(new PublicKey(bondingCurveAddress));
    if (!info?.data) return null;
    const state = decodeBondingCurve(Buffer.from(info.data));
    return bondingCurvePriceSol(state);
  } catch (err) {
    logger.debug(
      `fetchBondingCurvePrice ${bondingCurveAddress}: ${(err as Error).message}`
    );
    return null;
  }
}
