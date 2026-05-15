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
  mockFetch: vi.fn(),
  mockGetMint: vi.fn(),
}));

vi.mock('node-fetch', () => ({ default: mocks.mockFetch }));

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
    getMint: mocks.mockGetMint,
  };
});

import { resetConfigCache } from '../src/config';
import { buyToken, sellToken } from '../src/trader';

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

// Sell live's getAccountInfo sequence reads bonding curve, mint, and global
// in that order (same as buy minus the balance check, which doesn't apply
// when we're receiving SOL).
function mockSellHappyPath() {
  mocks.mockGetAccountInfo
    .mockResolvedValueOnce({ data: buildBondingCurveData(), owner: new PublicKey('11111111111111111111111111111111') })
    .mockResolvedValueOnce({ data: Buffer.alloc(0), owner: TOKEN_2022_PROGRAM })
    .mockResolvedValueOnce({ data: buildGlobalData(FEE_RECIPIENT) });
  mocks.mockGetLatestBlockhash.mockResolvedValue({
    blockhash: bs58.encode(Buffer.alloc(32, 1)),
    lastValidBlockHeight: 100,
  });
  mocks.mockSendTransaction.mockResolvedValue('SELLSIG12345abc');
  mocks.mockConfirmTransaction.mockResolvedValue({ value: { err: null } });
}

describe('pump live sell — direct bonding-curve path', () => {
  it('returns a successful live swap and books expected SOL out from the curve', async () => {
    mockSellHappyPath();
    // 1.78M tokens (a typical 0.05-SOL launch buy) sold back at launch state
    // returns slightly less than 0.05 SOL — constant-product slippage.
    const result = await sellToken(MINT, 1_780_000, undefined, null);
    expect(result.success).toBe(true);
    expect(result.simulated).toBe(false);
    expect(result.txSignature).toBe('SELLSIG12345abc');
    expect(result.amountOut).toBeGreaterThan(0);
    expect(result.amountOut).toBeLessThan(0.06);
  });

  it('sends a single transaction (no ATA-create prefix needed for sells)', async () => {
    mockSellHappyPath();
    await sellToken(MINT, 1_000_000, undefined, null);
    expect(mocks.mockSendTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.mockCreateAtaIdempotent).not.toHaveBeenCalled();
  });

  it('refuses when the trade amount is below one base unit', async () => {
    mocks.mockGetAccountInfo
      .mockResolvedValueOnce({ data: buildBondingCurveData(), owner: new PublicKey('11111111111111111111111111111111') })
      .mockResolvedValueOnce({ data: Buffer.alloc(0), owner: TOKEN_2022_PROGRAM })
      .mockResolvedValueOnce({ data: buildGlobalData(FEE_RECIPIENT) });
    // 1e-9 tokens × 1_000_000 base units < 1 → floors to 0.
    const result = await sellToken(MINT, 1e-9, undefined, null);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/too small/);
    expect(mocks.mockSendTransaction).not.toHaveBeenCalled();
  });

  it('surfaces a program-side failure on confirmation', async () => {
    mockSellHappyPath();
    mocks.mockConfirmTransaction.mockResolvedValue({
      value: { err: { InstructionError: [3, 'Custom'] } },
    });
    const result = await sellToken(MINT, 1_000_000, undefined, null);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/InstructionError/);
  });
});

describe('pump live sell — Jupiter fallback for graduated curves', () => {
  function mockJupiterSellSuccess(tokensIn: bigint, solOutLamports: bigint) {
    mocks.mockGetMint.mockResolvedValue({ decimals: 6 });
    // Jupiter quote response
    mocks.mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        inputMint: MINT,
        inAmount: tokensIn.toString(),
        outputMint: 'So11111111111111111111111111111111111111112',
        outAmount: solOutLamports.toString(),
        otherAmountThreshold: '0',
        swapMode: 'ExactIn',
        slippageBps: 300,
        priceImpactPct: '0',
      }),
      text: async () => '',
    });
    // Jupiter swap-builder response (a base64-encoded VersionedTransaction).
    // We intercept executeSwap upstream of the network call, so the bytes
    // here are placeholder — the test asserts on success path before send.
    mocks.mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ swapTransaction: Buffer.alloc(64).toString('base64') }),
      text: async () => '',
    });
  }

  it('routes through Jupiter when the bonding curve account is gone (closed post-migration)', async () => {
    mocks.mockGetAccountInfo.mockResolvedValueOnce(null);
    mockJupiterSellSuccess(1_000_000n * 1_000_000n, 50_000_000n);
    const result = await sellToken(MINT, 1_000_000, undefined, null);
    // The buy ix builder isn't called on this path.
    expect(mocks.mockGetMint).toHaveBeenCalled();
    expect(mocks.mockFetch).toHaveBeenCalledTimes(2); // quote + swap
    // We intentionally don't assert on success — the test mocks the Jupiter
    // quote but the swap deserialize on placeholder bytes will fail. What
    // matters is that we reached Jupiter at all (no direct-curve attempt).
    expect(result).toBeDefined();
    expect(mocks.mockSendTransaction).not.toHaveBeenCalled();
  });

  it('routes through Jupiter when the curve reports complete=true', async () => {
    mocks.mockGetAccountInfo.mockResolvedValueOnce({
      data: buildBondingCurveData({ complete: true }),
      owner: new PublicKey('11111111111111111111111111111111'),
    });
    mockJupiterSellSuccess(500_000n * 1_000_000n, 25_000_000n);
    await sellToken(MINT, 500_000, undefined, null);
    expect(mocks.mockFetch).toHaveBeenCalled();
  });

  it('routes through Jupiter when the RPC errors on the curve read', async () => {
    mocks.mockGetAccountInfo.mockRejectedValueOnce(new Error('rpc 429'));
    mockJupiterSellSuccess(100_000n * 1_000_000n, 5_000_000n);
    await sellToken(MINT, 100_000, undefined, null);
    expect(mocks.mockFetch).toHaveBeenCalled();
  });
});
