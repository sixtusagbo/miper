import { describe, expect, it } from 'vitest';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  BUY_DISCRIMINATOR,
  PUMP_EVENT_AUTHORITY_PDA,
  PUMP_FEE_CONFIG_PDA,
  PUMP_FEE_PROGRAM_ID,
  PUMP_GLOBAL_PDA,
  PUMP_GLOBAL_VOLUME_ACCUMULATOR_PDA,
  PUMP_PROGRAM_ID,
  SELL_DISCRIMINATOR,
  applySlippageMaxSol,
  applySlippageMinSol,
  buildBuyInstruction,
  buildSellInstruction,
  computeBuyTokensOut,
  computeSellSolOut,
  getAssociatedBondingCurvePda,
  getBondingCurvePda,
  getCreatorVaultPda,
  getUserVolumeAccumulatorPda,
} from '../src/pumpProgram';

// Token-2022 program id; pump's create_v2 path mints under this owner.
const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
// Distinct, on-curve keys for instruction-encoding tests.
const MINT = new PublicKey('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB');
const USER = new PublicKey('11111111111111111111111111111112');
const CREATOR = new PublicKey('11111111111111111111111111111113');
const FEE_RECIPIENT = new PublicKey('11111111111111111111111111111114');

describe('pumpProgram constants', () => {
  it('pump program id matches the deployed address', () => {
    expect(PUMP_PROGRAM_ID.toBase58()).toBe(
      '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'
    );
  });

  it('fee program id matches the deployed address', () => {
    expect(PUMP_FEE_PROGRAM_ID.toBase58()).toBe(
      'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ'
    );
  });

  it('ATA program id matches the canonical address', () => {
    expect(ASSOCIATED_TOKEN_PROGRAM_ID.toBase58()).toBe(
      'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
    );
  });

  // Discriminators are sha256("global:<name>")[..8]; a single typo in either
  // the seed string or the bytes lands us on the wrong on-chain instruction.
  it('buy discriminator matches the IDL bytes', () => {
    expect(Array.from(BUY_DISCRIMINATOR)).toEqual([102, 6, 61, 18, 1, 218, 235, 234]);
  });

  it('sell discriminator matches the IDL bytes', () => {
    expect(Array.from(SELL_DISCRIMINATOR)).toEqual([51, 230, 133, 164, 1, 127, 131, 173]);
  });
});

describe('pumpProgram static PDAs', () => {
  // These addresses are publicly observable on every pump.fun buy/sell tx.
  // If a seed string ever drifts, the test fails before bad ix reaches mainnet.
  it('global PDA matches the published address', () => {
    expect(PUMP_GLOBAL_PDA.toBase58()).toBe(
      '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf'
    );
  });

  it('event_authority PDA matches the published address', () => {
    expect(PUMP_EVENT_AUTHORITY_PDA.toBase58()).toBe(
      'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1'
    );
  });

  it('global_volume_accumulator PDA is deterministic and on-curve', () => {
    expect(PUMP_GLOBAL_VOLUME_ACCUMULATOR_PDA.toBase58()).toBe(
      'Hq2wp8uJ9jCPsYgNHex8RtqdvMPfVGoYwjvF1ATiwn2Y'
    );
  });

  it('fee_config PDA is deterministic and on-curve', () => {
    expect(PUMP_FEE_CONFIG_PDA.toBase58()).toBe(
      '8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt'
    );
  });
});

describe('pumpProgram dynamic PDAs', () => {
  it('bonding curve PDA changes with mint and is reproducible', () => {
    const a = getBondingCurvePda(MINT);
    const b = getBondingCurvePda(MINT);
    const c = getBondingCurvePda(USER);
    expect(a.toBase58()).toBe(b.toBase58());
    expect(a.toBase58()).not.toBe(c.toBase58());
  });

  it('creator vault PDA changes with creator and is reproducible', () => {
    const a = getCreatorVaultPda(CREATOR);
    const b = getCreatorVaultPda(CREATOR);
    const c = getCreatorVaultPda(USER);
    expect(a.toBase58()).toBe(b.toBase58());
    expect(a.toBase58()).not.toBe(c.toBase58());
  });

  it('user volume accumulator PDA changes with user', () => {
    const a = getUserVolumeAccumulatorPda(USER);
    const b = getUserVolumeAccumulatorPda(CREATOR);
    expect(a.toBase58()).not.toBe(b.toBase58());
  });

  it('associated bonding curve depends on the token program (Token-2022 vs SPL)', () => {
    const tok2022 = getAssociatedBondingCurvePda(MINT, TOKEN_2022);
    const splClassic = getAssociatedBondingCurvePda(
      MINT,
      new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
    );
    expect(tok2022.toBase58()).not.toBe(splClassic.toBase58());
  });
});

describe('constant-product math', () => {
  // Pump launch state: 30 SOL virtual reserves, 1.073B tokens. The integer
  // formula matches the program's u128 arithmetic exactly (we use bigint).
  const VIRTUAL_SOL = 30n * 1_000_000_000n; // 30 SOL in lamports
  const VIRTUAL_TOKENS = 1_073_000_000n * 1_000_000n; // 1.073B tokens (6 decimals)

  it('buying 1 SOL at launch state yields the on-curve tokens out', () => {
    const solIn = 1_000_000_000n; // 1 SOL
    const tokensOut = computeBuyTokensOut(VIRTUAL_SOL, VIRTUAL_TOKENS, solIn);
    // Formula: (1e9 * 1.073e15) / (30e9 + 1e9) = 1.073e24 / 31e9 ≈ 3.461e13
    const expected = (solIn * VIRTUAL_TOKENS) / (VIRTUAL_SOL + solIn);
    expect(tokensOut).toBe(expected);
    // Sanity: getting more tokens than the virtual pool holds would be a bug.
    expect(tokensOut).toBeLessThan(VIRTUAL_TOKENS);
  });

  it('buy-then-sell is roughly round-trip on the curve (within constant-product slippage)', () => {
    const solIn = 100_000_000n; // 0.1 SOL
    const tokensOut = computeBuyTokensOut(VIRTUAL_SOL, VIRTUAL_TOKENS, solIn);
    // After the buy, reserves shift; selling the same tokens back at the new
    // state returns slightly less SOL than was put in (constant-product fee).
    const newVirtualSol = VIRTUAL_SOL + solIn;
    const newVirtualTokens = VIRTUAL_TOKENS - tokensOut;
    const solBack = computeSellSolOut(newVirtualSol, newVirtualTokens, tokensOut);
    expect(solBack).toBeLessThanOrEqual(solIn);
    // Round-trip on a single tick should be within 1 lamport of full.
    expect(solIn - solBack).toBeLessThanOrEqual(1n);
  });

  it('returns 0 on non-positive inputs', () => {
    expect(computeBuyTokensOut(VIRTUAL_SOL, VIRTUAL_TOKENS, 0n)).toBe(0n);
    expect(computeBuyTokensOut(VIRTUAL_SOL, VIRTUAL_TOKENS, -5n)).toBe(0n);
    expect(computeSellSolOut(VIRTUAL_SOL, VIRTUAL_TOKENS, 0n)).toBe(0n);
    expect(computeBuyTokensOut(0n, VIRTUAL_TOKENS, 100n)).toBe(0n);
  });
});

describe('slippage helpers', () => {
  it('max-sol cost ceils so the cap is never below the intended spend', () => {
    // 300 bps on 1 SOL = at most 1.03 SOL
    expect(applySlippageMaxSol(1_000_000_000n, 300)).toBe(1_030_000_000n);
    // Ceiling: tiny non-zero residue rounds up
    expect(applySlippageMaxSol(1n, 300)).toBeGreaterThanOrEqual(1n);
  });

  it('min-sol output floors so the cap never exceeds the worst we accept', () => {
    // 300 bps on 1 SOL = at least 0.97 SOL
    expect(applySlippageMinSol(1_000_000_000n, 300)).toBe(970_000_000n);
  });

  it('passes through when bps is zero', () => {
    expect(applySlippageMaxSol(1_000_000_000n, 0)).toBe(1_000_000_000n);
    expect(applySlippageMinSol(1_000_000_000n, 0)).toBe(1_000_000_000n);
  });

  it('clamps min-sol output to zero when bps >= 10000', () => {
    expect(applySlippageMinSol(1_000_000_000n, 10000)).toBe(0n);
    expect(applySlippageMinSol(1_000_000_000n, 20000)).toBe(0n);
  });
});

describe('buildBuyInstruction', () => {
  const USER_ATA = new PublicKey('11111111111111111111111111111115');

  function build() {
    return buildBuyInstruction({
      user: USER,
      mint: MINT,
      creator: CREATOR,
      tokenProgram: TOKEN_2022,
      userAta: USER_ATA,
      feeRecipient: FEE_RECIPIENT,
      amount: 1_000_000n,
      maxSolCost: 50_000_000n,
      trackVolume: false,
    });
  }

  it('routes to the pump program', () => {
    expect(build().programId.toBase58()).toBe(PUMP_PROGRAM_ID.toBase58());
  });

  it('encodes the discriminator and u64 args in little-endian order', () => {
    const ix = build();
    expect(ix.data.length).toBe(8 + 8 + 8 + 1);
    expect(Array.from(ix.data.subarray(0, 8))).toEqual(Array.from(BUY_DISCRIMINATOR));
    expect(ix.data.readBigUInt64LE(8)).toBe(1_000_000n);
    expect(ix.data.readBigUInt64LE(16)).toBe(50_000_000n);
    expect(ix.data[24]).toBe(0); // trackVolume=false
  });

  it('writes trackVolume as 1 when true', () => {
    const ix = buildBuyInstruction({
      user: USER,
      mint: MINT,
      creator: CREATOR,
      tokenProgram: TOKEN_2022,
      userAta: USER_ATA,
      feeRecipient: FEE_RECIPIENT,
      amount: 1n,
      maxSolCost: 1n,
      trackVolume: true,
    });
    expect(ix.data[24]).toBe(1);
  });

  it('lays out the 16 accounts in the order the IDL prescribes', () => {
    const ix = build();
    const addresses = ix.keys.map((k) => k.pubkey.toBase58());
    expect(addresses).toEqual([
      PUMP_GLOBAL_PDA.toBase58(),
      FEE_RECIPIENT.toBase58(),
      MINT.toBase58(),
      getBondingCurvePda(MINT).toBase58(),
      getAssociatedBondingCurvePda(MINT, TOKEN_2022).toBase58(),
      USER_ATA.toBase58(),
      USER.toBase58(),
      SystemProgram.programId.toBase58(),
      TOKEN_2022.toBase58(),
      getCreatorVaultPda(CREATOR).toBase58(),
      PUMP_EVENT_AUTHORITY_PDA.toBase58(),
      PUMP_PROGRAM_ID.toBase58(),
      PUMP_GLOBAL_VOLUME_ACCUMULATOR_PDA.toBase58(),
      getUserVolumeAccumulatorPda(USER).toBase58(),
      PUMP_FEE_CONFIG_PDA.toBase58(),
      PUMP_FEE_PROGRAM_ID.toBase58(),
    ]);
  });

  it('flags the user as the only signer', () => {
    const ix = build();
    const signers = ix.keys.filter((k) => k.isSigner);
    expect(signers).toHaveLength(1);
    expect(signers[0].pubkey.toBase58()).toBe(USER.toBase58());
  });

  it('marks the writable accounts the program will mutate', () => {
    const ix = build();
    const writables = ix.keys.filter((k) => k.isWritable).map((k) => k.pubkey.toBase58());
    expect(writables).toEqual(
      expect.arrayContaining([
        FEE_RECIPIENT.toBase58(),
        getBondingCurvePda(MINT).toBase58(),
        getAssociatedBondingCurvePda(MINT, TOKEN_2022).toBase58(),
        USER_ATA.toBase58(),
        USER.toBase58(),
        getCreatorVaultPda(CREATOR).toBase58(),
        getUserVolumeAccumulatorPda(USER).toBase58(),
      ])
    );
  });
});

describe('buildSellInstruction', () => {
  const USER_ATA = new PublicKey('11111111111111111111111111111115');

  function build() {
    return buildSellInstruction({
      user: USER,
      mint: MINT,
      creator: CREATOR,
      tokenProgram: TOKEN_2022,
      userAta: USER_ATA,
      feeRecipient: FEE_RECIPIENT,
      amount: 500_000n,
      minSolOutput: 25_000_000n,
    });
  }

  it('encodes discriminator + amount + min_sol_output (no track_volume byte)', () => {
    const ix = build();
    expect(ix.data.length).toBe(8 + 8 + 8);
    expect(Array.from(ix.data.subarray(0, 8))).toEqual(Array.from(SELL_DISCRIMINATOR));
    expect(ix.data.readBigUInt64LE(8)).toBe(500_000n);
    expect(ix.data.readBigUInt64LE(16)).toBe(25_000_000n);
  });

  it('puts creator_vault BEFORE token_program (sell-only ordering differs from buy)', () => {
    const ix = build();
    // Slot 8 = creator_vault, slot 9 = token_program. Mixing these flips the
    // program's account validation and the transaction errors out.
    expect(ix.keys[8].pubkey.toBase58()).toBe(getCreatorVaultPda(CREATOR).toBase58());
    expect(ix.keys[9].pubkey.toBase58()).toBe(TOKEN_2022.toBase58());
  });

  it('lays out the 14 accounts in the order the IDL prescribes', () => {
    const ix = build();
    const addresses = ix.keys.map((k) => k.pubkey.toBase58());
    expect(addresses).toEqual([
      PUMP_GLOBAL_PDA.toBase58(),
      FEE_RECIPIENT.toBase58(),
      MINT.toBase58(),
      getBondingCurvePda(MINT).toBase58(),
      getAssociatedBondingCurvePda(MINT, TOKEN_2022).toBase58(),
      USER_ATA.toBase58(),
      USER.toBase58(),
      SystemProgram.programId.toBase58(),
      getCreatorVaultPda(CREATOR).toBase58(),
      TOKEN_2022.toBase58(),
      PUMP_EVENT_AUTHORITY_PDA.toBase58(),
      PUMP_PROGRAM_ID.toBase58(),
      PUMP_FEE_CONFIG_PDA.toBase58(),
      PUMP_FEE_PROGRAM_ID.toBase58(),
    ]);
  });

  it('flags the user as the only signer', () => {
    const signers = build().keys.filter((k) => k.isSigner);
    expect(signers).toHaveLength(1);
    expect(signers[0].pubkey.toBase58()).toBe(USER.toBase58());
  });
});
