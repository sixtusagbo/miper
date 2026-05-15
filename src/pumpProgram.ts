import {
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js';
import { PROGRAM_IDS } from './config';

// Verified against pump.fun's published Anchor IDL v0.1.0
// (github.com/pump-fun/pump-public-docs/idl/pump.json). The on-chain program
// is at 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P.

export const PUMP_PROGRAM_ID = PROGRAM_IDS.PUMP_FUN;
// Pump.fun mints decimals are fixed by the program's global config; both
// the curve price math and trader's human-unit conversion lean on this.
export const PUMP_TOKEN_DECIMALS = 6;
export const PUMP_TOKEN_BASE_UNITS = 10 ** PUMP_TOKEN_DECIMALS;
// Separate program that owns the fee_config PDA; routed to from buy/sell
// for fee accounting. Address is hardcoded in the IDL.
export const PUMP_FEE_PROGRAM_ID = new PublicKey(
  'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ'
);
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
);

// Anchor 8-byte instruction discriminators (sha256("global:<name>")[0..8]).
export const BUY_DISCRIMINATOR = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
export const SELL_DISCRIMINATOR = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]);

// fee_config PDA's second seed: a 32-byte constant from the IDL that
// identifies the pump program inside the fee program's account namespace.
const FEE_CONFIG_PROGRAM_SEED = Buffer.from([
  1, 86, 224, 246, 147, 102, 90, 207, 68, 219, 21, 104, 191, 23, 91, 170,
  81, 137, 203, 151, 245, 210, 255, 59, 101, 93, 43, 182, 253, 109, 24, 176,
]);

function findPda(seeds: Buffer[], programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

// Static PDAs — computed once at module load. These never change for a given
// program address, so paying the crypto cost up front keeps the buy/sell hot
// path free of redundant derivation work.
export const PUMP_GLOBAL_PDA = findPda([Buffer.from('global')], PUMP_PROGRAM_ID);
export const PUMP_EVENT_AUTHORITY_PDA = findPda(
  [Buffer.from('__event_authority')],
  PUMP_PROGRAM_ID
);
export const PUMP_GLOBAL_VOLUME_ACCUMULATOR_PDA = findPda(
  [Buffer.from('global_volume_accumulator')],
  PUMP_PROGRAM_ID
);
export const PUMP_FEE_CONFIG_PDA = findPda(
  [Buffer.from('fee_config'), FEE_CONFIG_PROGRAM_SEED],
  PUMP_FEE_PROGRAM_ID
);

export function getBondingCurvePda(mint: PublicKey): PublicKey {
  return findPda([Buffer.from('bonding-curve'), mint.toBuffer()], PUMP_PROGRAM_ID);
}

export function getCreatorVaultPda(creator: PublicKey): PublicKey {
  return findPda([Buffer.from('creator-vault'), creator.toBuffer()], PUMP_PROGRAM_ID);
}

export function getUserVolumeAccumulatorPda(user: PublicKey): PublicKey {
  return findPda(
    [Buffer.from('user_volume_accumulator'), user.toBuffer()],
    PUMP_PROGRAM_ID
  );
}

// The bonding curve's ATA for the mint, derived via the standard SPL
// Associated Token Account program. The token program is part of the seed,
// so a Token-2022 mint and a classic SPL mint hash to different ATAs.
export function getAssociatedBondingCurvePda(
  mint: PublicKey,
  tokenProgram: PublicKey
): PublicKey {
  const bondingCurve = getBondingCurvePda(mint);
  return findPda(
    [bondingCurve.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
}

// Global account: [8 discriminator][1 initialized][32 authority][32 fee_recipient]...
// We only need fee_recipient for buy/sell, so the rest of the (~600-byte)
// struct is intentionally unparsed.
const GLOBAL_FEE_RECIPIENT_OFFSET = 8 + 1 + 32;
const GLOBAL_FEE_RECIPIENT_END = GLOBAL_FEE_RECIPIENT_OFFSET + 32;

export async function readPumpFeeRecipient(connection: Connection): Promise<PublicKey> {
  const info = await connection.getAccountInfo(PUMP_GLOBAL_PDA);
  if (!info?.data) throw new Error('pump global account not found');
  if (info.data.length < GLOBAL_FEE_RECIPIENT_END) {
    throw new Error(
      `pump global account too short: ${info.data.length} bytes (need >= ${GLOBAL_FEE_RECIPIENT_END})`
    );
  }
  return new PublicKey(
    info.data.subarray(GLOBAL_FEE_RECIPIENT_OFFSET, GLOBAL_FEE_RECIPIENT_END)
  );
}

// Bonding curve uses constant product on virtual reserves:
//   k = virtual_sol * virtual_tokens
//   after spending solIn: tokens_out = virtual_tokens - k / (virtual_sol + solIn)
//                                   = (solIn * virtual_tokens) / (virtual_sol + solIn)
export function computeBuyTokensOut(
  virtualSolReserves: bigint,
  virtualTokenReserves: bigint,
  solIn: bigint
): bigint {
  if (solIn <= 0n) return 0n;
  if (virtualSolReserves <= 0n || virtualTokenReserves <= 0n) return 0n;
  return (solIn * virtualTokenReserves) / (virtualSolReserves + solIn);
}

// Inverse: selling tokenIn base units yields this many lamports of SOL.
export function computeSellSolOut(
  virtualSolReserves: bigint,
  virtualTokenReserves: bigint,
  tokenIn: bigint
): bigint {
  if (tokenIn <= 0n) return 0n;
  if (virtualSolReserves <= 0n || virtualTokenReserves <= 0n) return 0n;
  return (tokenIn * virtualSolReserves) / (virtualTokenReserves + tokenIn);
}

// Slippage caps. Buy: ceil(solIn * (1 + bps/10000)) — willing to pay at most
// this much SOL for the requested token amount. Sell: floor(solOut * (1 - bps/10000))
// — accept at least this much SOL for the requested token amount.
export function applySlippageMaxSol(solIn: bigint, slippageBps: number): bigint {
  if (slippageBps <= 0) return solIn;
  const bps = BigInt(Math.floor(slippageBps));
  const num = solIn * (10000n + bps);
  return (num + 9999n) / 10000n;
}

export function applySlippageMinSol(solOut: bigint, slippageBps: number): bigint {
  if (slippageBps <= 0) return solOut;
  const bps = BigInt(Math.floor(slippageBps));
  if (bps >= 10000n) return 0n;
  return (solOut * (10000n - bps)) / 10000n;
}

export interface BuildBuyParams {
  user: PublicKey;
  mint: PublicKey;
  creator: PublicKey;
  tokenProgram: PublicKey;
  userAta: PublicKey;
  feeRecipient: PublicKey;
  amount: bigint;
  maxSolCost: bigint;
  trackVolume: boolean;
}

export function buildBuyInstruction(p: BuildBuyParams): TransactionInstruction {
  const bondingCurve = getBondingCurvePda(p.mint);
  const associatedBondingCurve = getAssociatedBondingCurvePda(p.mint, p.tokenProgram);
  const creatorVault = getCreatorVaultPda(p.creator);
  const userVolumeAccumulator = getUserVolumeAccumulatorPda(p.user);

  // Args: discriminator(8) + amount u64 LE(8) + max_sol_cost u64 LE(8) +
  // track_volume OptionBool(1; the IDL types it as a struct wrapping a bool,
  // which Borsh encodes as the single bool byte — there is no Some/None tag).
  const data = Buffer.alloc(8 + 8 + 8 + 1);
  BUY_DISCRIMINATOR.copy(data, 0);
  data.writeBigUInt64LE(p.amount, 8);
  data.writeBigUInt64LE(p.maxSolCost, 16);
  data[24] = p.trackVolume ? 1 : 0;

  const keys = [
    { pubkey: PUMP_GLOBAL_PDA, isSigner: false, isWritable: false },
    { pubkey: p.feeRecipient, isSigner: false, isWritable: true },
    { pubkey: p.mint, isSigner: false, isWritable: false },
    { pubkey: bondingCurve, isSigner: false, isWritable: true },
    { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
    { pubkey: p.userAta, isSigner: false, isWritable: true },
    { pubkey: p.user, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: p.tokenProgram, isSigner: false, isWritable: false },
    { pubkey: creatorVault, isSigner: false, isWritable: true },
    { pubkey: PUMP_EVENT_AUTHORITY_PDA, isSigner: false, isWritable: false },
    { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: PUMP_GLOBAL_VOLUME_ACCUMULATOR_PDA, isSigner: false, isWritable: false },
    { pubkey: userVolumeAccumulator, isSigner: false, isWritable: true },
    { pubkey: PUMP_FEE_CONFIG_PDA, isSigner: false, isWritable: false },
    { pubkey: PUMP_FEE_PROGRAM_ID, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({ programId: PUMP_PROGRAM_ID, keys, data });
}

export interface BuildSellParams {
  user: PublicKey;
  mint: PublicKey;
  creator: PublicKey;
  tokenProgram: PublicKey;
  userAta: PublicKey;
  feeRecipient: PublicKey;
  amount: bigint;
  minSolOutput: bigint;
}

// Note: sell's account ordering differs from buy at slots 8-9:
//   buy:  ...system_program, token_program, creator_vault, event_authority...
//   sell: ...system_program, creator_vault, token_program, event_authority...
// Sell also has no volume accumulators (those track buy-side activity).
export function buildSellInstruction(p: BuildSellParams): TransactionInstruction {
  const bondingCurve = getBondingCurvePda(p.mint);
  const associatedBondingCurve = getAssociatedBondingCurvePda(p.mint, p.tokenProgram);
  const creatorVault = getCreatorVaultPda(p.creator);

  const data = Buffer.alloc(8 + 8 + 8);
  SELL_DISCRIMINATOR.copy(data, 0);
  data.writeBigUInt64LE(p.amount, 8);
  data.writeBigUInt64LE(p.minSolOutput, 16);

  const keys = [
    { pubkey: PUMP_GLOBAL_PDA, isSigner: false, isWritable: false },
    { pubkey: p.feeRecipient, isSigner: false, isWritable: true },
    { pubkey: p.mint, isSigner: false, isWritable: false },
    { pubkey: bondingCurve, isSigner: false, isWritable: true },
    { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
    { pubkey: p.userAta, isSigner: false, isWritable: true },
    { pubkey: p.user, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: creatorVault, isSigner: false, isWritable: true },
    { pubkey: p.tokenProgram, isSigner: false, isWritable: false },
    { pubkey: PUMP_EVENT_AUTHORITY_PDA, isSigner: false, isWritable: false },
    { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: PUMP_FEE_CONFIG_PDA, isSigner: false, isWritable: false },
    { pubkey: PUMP_FEE_PROGRAM_ID, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({ programId: PUMP_PROGRAM_ID, keys, data });
}
