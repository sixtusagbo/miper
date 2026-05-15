import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

const mocks = vi.hoisted(() => ({
  mockGetAccountInfo: vi.fn(),
  mockGetBalance: vi.fn(),
  mockSendTransaction: vi.fn(),
  mockConfirmTransaction: vi.fn(),
  mockGetLatestBlockhash: vi.fn(),
  mockCreateAtaIdempotent: vi.fn(),
}));

vi.mock('@solana/web3.js', async () => {
  const actual = await vi.importActual<typeof import('@solana/web3.js')>('@solana/web3.js');
  class MockConnection {
    getAccountInfo = mocks.mockGetAccountInfo;
    getBalance = mocks.mockGetBalance;
    sendTransaction = mocks.mockSendTransaction;
    confirmTransaction = mocks.mockConfirmTransaction;
    getLatestBlockhash = mocks.mockGetLatestBlockhash;
    constructor(_url: string, _opts?: unknown) {}
  }
  return { ...actual, Connection: MockConnection };
});

vi.mock('@solana/spl-token', async () => {
  const actual = await vi.importActual<typeof import('@solana/spl-token')>('@solana/spl-token');
  return {
    ...actual,
    createAssociatedTokenAccountIdempotentInstruction: mocks.mockCreateAtaIdempotent,
  };
});

import { resetConfigCache } from '../src/config';
import { buyToken } from '../src/trader';

const TOKEN_2022_PROGRAM = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const FEE_RECIPIENT = new PublicKey('CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM');
const CREATOR = new PublicKey('11111111111111111111111111111113');

let walletBs58: string;

// Builds the on-chain bonding-curve account layout the decoder expects:
// 8-byte discriminator + 5x u64 reserves + complete byte + 32-byte creator.
function buildBondingCurveData(opts: {
  virtualSol?: bigint;
  virtualTokens?: bigint;
  complete?: boolean;
  creator?: PublicKey;
} = {}): Buffer {
  const buf = Buffer.alloc(8 + 5 * 8 + 1 + 32);
  let offset = 8;
  buf.writeBigUInt64LE(opts.virtualTokens ?? 1_073_000_000n * 1_000_000n, offset); offset += 8;
  buf.writeBigUInt64LE(opts.virtualSol ?? 30n * 1_000_000_000n, offset); offset += 8;
  buf.writeBigUInt64LE(0n, offset); offset += 8; // real token reserves
  buf.writeBigUInt64LE(0n, offset); offset += 8; // real sol reserves
  buf.writeBigUInt64LE(1_000_000_000n * 1_000_000n, offset); offset += 8;
  buf[offset] = opts.complete ? 1 : 0; offset += 1;
  (opts.creator ?? CREATOR).toBuffer().copy(buf, offset);
  return buf;
}

// Builds the global account: discriminator + initialized + authority +
// fee_recipient (at offset 41) is all the live path inspects.
function buildGlobalData(feeRecipient: PublicKey): Buffer {
  const buf = Buffer.alloc(8 + 1 + 32 + 32);
  feeRecipient.toBuffer().copy(buf, 8 + 1 + 32);
  return buf;
}

// In call order the live path issues three getAccountInfo reads:
//   1. bonding curve
//   2. mint (for token program owner)
//   3. global (for fee recipient)
function mockHappyPath() {
  mocks.mockGetAccountInfo
    .mockResolvedValueOnce({ data: buildBondingCurveData(), owner: new PublicKey('11111111111111111111111111111111') })
    .mockResolvedValueOnce({ data: Buffer.alloc(0), owner: TOKEN_2022_PROGRAM })
    .mockResolvedValueOnce({ data: buildGlobalData(FEE_RECIPIENT) });
  mocks.mockGetBalance.mockResolvedValue(1_000_000_000); // 1 SOL
  mocks.mockGetLatestBlockhash.mockResolvedValue({
    // 32-byte all-ones encoded as base58; valid input to VersionedTransaction.
    blockhash: bs58.encode(Buffer.alloc(32, 1)),
    lastValidBlockHeight: 100,
  });
  mocks.mockSendTransaction.mockResolvedValue('SIG12345abc');
  mocks.mockConfirmTransaction.mockResolvedValue({ value: { err: null } });
  mocks.mockCreateAtaIdempotent.mockReturnValue({
    keys: [],
    programId: new PublicKey('11111111111111111111111111111111'),
    data: Buffer.alloc(0),
  });
}

beforeEach(() => {
  // Fresh keypair per test so the wallet cache from a previous test can't bleed in.
  walletBs58 = bs58.encode(Keypair.generate().secretKey);
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  process.env.OPENAI_API_KEY = 'sk-openai-test';
  process.env.WALLET_PRIVATE_KEY = walletBs58;
  process.env.SIMULATE = 'false';
  process.env.SOURCE = 'pump';
  process.env.LOG_LEVEL = 'error';
  process.env.MAX_SLIPPAGE_BPS = '300';
  process.env.PUMP_PRIORITY_MICROLAMPORTS = '0';
  resetConfigCache();
  for (const m of Object.values(mocks)) m.mockReset();
});

afterEach(() => {
  // The trader caches its wallet and Connection module-level; resetting
  // modules ensures the next test gets a fresh keypair-derived wallet.
  vi.resetModules();
  delete process.env.SIMULATE;
  delete process.env.SOURCE;
  delete process.env.WALLET_PRIVATE_KEY;
  delete process.env.PUMP_PRIORITY_MICROLAMPORTS;
});

describe('pump live buy', () => {
  it('returns a successful live swap with the tx signature when the program confirms', async () => {
    mockHappyPath();
    const result = await buyToken(MINT, 0.05);
    expect(result.success).toBe(true);
    expect(result.simulated).toBe(false);
    expect(result.txSignature).toBe('SIG12345abc');
    expect(result.amountIn).toBe(0.05);
    expect(result.amountOut).toBeGreaterThan(0);
    // Sanity: at launch reserves, ~0.05 SOL buys ~1.78M tokens.
    expect(result.amountOut).toBeGreaterThan(1_000_000);
    expect(result.pricePerToken).toBeGreaterThan(0);
  });

  it('sends the transaction with the program ix and ATA-create prepended', async () => {
    mockHappyPath();
    await buyToken(MINT, 0.05);
    expect(mocks.mockSendTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.mockCreateAtaIdempotent).toHaveBeenCalledTimes(1);
  });

  it('refuses the trade when the bonding curve has already graduated', async () => {
    mocks.mockGetAccountInfo.mockResolvedValueOnce({
      data: buildBondingCurveData({ complete: true }),
      owner: new PublicKey('11111111111111111111111111111111'),
    });
    const result = await buyToken(MINT, 0.05);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/graduated/);
    expect(mocks.mockSendTransaction).not.toHaveBeenCalled();
  });

  it('refuses the trade when the bonding curve account does not exist', async () => {
    mocks.mockGetAccountInfo.mockResolvedValueOnce(null);
    const result = await buyToken(MINT, 0.05);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/bonding curve account not found/);
    expect(mocks.mockSendTransaction).not.toHaveBeenCalled();
  });

  it('refuses the trade when the wallet would dip below the SOL reserve', async () => {
    mocks.mockGetAccountInfo
      .mockResolvedValueOnce({ data: buildBondingCurveData(), owner: new PublicKey('11111111111111111111111111111111') })
      .mockResolvedValueOnce({ data: Buffer.alloc(0), owner: TOKEN_2022_PROGRAM })
      .mockResolvedValueOnce({ data: buildGlobalData(FEE_RECIPIENT) });
    mocks.mockGetBalance.mockResolvedValue(10_000_000); // 0.01 SOL — exactly the reserve
    const result = await buyToken(MINT, 0.05);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/insufficient balance/);
    expect(mocks.mockSendTransaction).not.toHaveBeenCalled();
  });

  it('surfaces the program error when confirmTransaction reports a runtime failure', async () => {
    mockHappyPath();
    mocks.mockConfirmTransaction.mockResolvedValue({
      value: { err: { InstructionError: [3, 'Custom'] } },
    });
    const result = await buyToken(MINT, 0.05);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/InstructionError/);
  });
});
