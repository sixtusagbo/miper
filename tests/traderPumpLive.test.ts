import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { BN } from '@coral-xyz/anchor';
import bs58 from 'bs58';

// Spies for every external boundary the live pump paths touch: the pump SDK,
// the Solana Connection, spl-token, and node-fetch (the Jupiter fallback).
const mocks = vi.hoisted(() => ({
  mockGetBalance: vi.fn(),
  mockGetAccountInfo: vi.fn(),
  mockGetLatestBlockhash: vi.fn(),
  mockSendTransaction: vi.fn(),
  mockSendRawTransaction: vi.fn(),
  mockConfirmTransaction: vi.fn(),
  mockGetRecentPrioritizationFees: vi.fn(),
  mockGetTokenAccountBalance: vi.fn(),
  mockFetchGlobal: vi.fn(),
  mockFetchFeeConfig: vi.fn(),
  mockFetchBuyState: vi.fn(),
  mockFetchSellState: vi.fn(),
  mockBuyV2Instructions: vi.fn(),
  mockSellV2Instructions: vi.fn(),
  mockGetBuyTokenAmount: vi.fn(),
  mockGetSellSolAmount: vi.fn(),
  mockGetMint: vi.fn(),
  mockCreateCloseAccount: vi.fn(),
  mockFetch: vi.fn(),
}));

vi.mock('node-fetch', () => ({ default: mocks.mockFetch }));

vi.mock('@solana/web3.js', async () => {
  const actual = await vi.importActual<typeof import('@solana/web3.js')>('@solana/web3.js');
  class MockConnection {
    getBalance = mocks.mockGetBalance;
    getAccountInfo = mocks.mockGetAccountInfo;
    getLatestBlockhash = mocks.mockGetLatestBlockhash;
    sendTransaction = mocks.mockSendTransaction;
    sendRawTransaction = mocks.mockSendRawTransaction;
    confirmTransaction = mocks.mockConfirmTransaction;
    getRecentPrioritizationFees = mocks.mockGetRecentPrioritizationFees;
    getTokenAccountBalance = mocks.mockGetTokenAccountBalance;
    constructor(_url: string, _opts?: unknown) {}
  }
  return { ...actual, Connection: MockConnection };
});

vi.mock('@solana/spl-token', async () => {
  const actual = await vi.importActual<typeof import('@solana/spl-token')>('@solana/spl-token');
  return {
    ...actual,
    getMint: mocks.mockGetMint,
    createCloseAccountInstruction: mocks.mockCreateCloseAccount,
  };
});

// OnlinePumpSdk / PumpSdk are constructed per-trade; their methods are shared
// hoisted spies so a test configures behavior regardless of the instance.
vi.mock('@pump-fun/pump-sdk', () => ({
  OnlinePumpSdk: class {
    fetchGlobal = mocks.mockFetchGlobal;
    fetchFeeConfig = mocks.mockFetchFeeConfig;
    fetchBuyState = mocks.mockFetchBuyState;
    fetchSellState = mocks.mockFetchSellState;
    constructor(_connection: unknown) {}
  },
  PumpSdk: class {
    buyV2Instructions = mocks.mockBuyV2Instructions;
    sellV2Instructions = mocks.mockSellV2Instructions;
  },
  getBuyTokenAmountFromSolAmount: mocks.mockGetBuyTokenAmount,
  getSellSolAmountFromTokenAmount: mocks.mockGetSellSolAmount,
}));

import { resetConfigCache } from '../src/config';
import { buyToken, sellToken, __resetPumpConfigCache } from '../src/trader';

const TOKEN_2022_PROGRAM = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const BLOCKHASH = bs58.encode(Buffer.alloc(32, 1));

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  process.env.OPENAI_API_KEY = 'sk-openai-test';
  process.env.WALLET_PRIVATE_KEY = bs58.encode(Keypair.generate().secretKey);
  process.env.SIMULATE = 'false';
  process.env.SOURCE = 'pump';
  process.env.LOG_LEVEL = 'error';
  process.env.MAX_SLIPPAGE_BPS = '500';
  process.env.PUMP_PRIORITY_MICROLAMPORTS = '0';
  resetConfigCache();
  __resetPumpConfigCache();
  for (const m of Object.values(mocks)) m.mockReset();
  // Shared defaults: a Token-2022 mint, a live blockhash, confirmable txs.
  mocks.mockGetAccountInfo.mockResolvedValue({ owner: TOKEN_2022_PROGRAM });
  mocks.mockGetLatestBlockhash.mockResolvedValue({
    blockhash: BLOCKHASH,
    lastValidBlockHeight: 100,
  });
  mocks.mockConfirmTransaction.mockResolvedValue({ value: { err: null } });
  mocks.mockGetRecentPrioritizationFees.mockResolvedValue([]);
  mocks.mockFetchGlobal.mockResolvedValue({});
  mocks.mockFetchFeeConfig.mockResolvedValue({});
});

function mockBuyHappyPath() {
  mocks.mockGetBalance.mockResolvedValue(1_000_000_000); // 1 SOL
  mocks.mockFetchBuyState.mockResolvedValue({
    bondingCurveAccountInfo: { data: Buffer.alloc(0) },
    bondingCurve: { complete: false },
    associatedUserAccountInfo: null,
  });
  // The buy quote needs the real mint supply (mintSupply: null makes the SDK
  // quote against a fresh launch-floor curve).
  mocks.mockGetMint.mockResolvedValue({ supply: 1_000_000_000_000_000n, decimals: 6 });
  mocks.mockGetBuyTokenAmount.mockReturnValue(new BN('1785357000000'));
  mocks.mockBuyV2Instructions.mockResolvedValue([]);
  mocks.mockSendRawTransaction.mockResolvedValue('BUYSIG12345');
}

function mockSellHappyPath(remainingAtaBalance = '0') {
  mocks.mockFetchSellState.mockResolvedValue({
    bondingCurveAccountInfo: { data: Buffer.alloc(0) },
    bondingCurve: { complete: false },
  });
  mocks.mockGetMint.mockResolvedValue({ supply: 1_000_000_000_000_000n, decimals: 6 });
  mocks.mockGetSellSolAmount.mockReturnValue(new BN('49000000')); // ~0.049 SOL
  mocks.mockSellV2Instructions.mockResolvedValue([]);
  mocks.mockSendRawTransaction.mockResolvedValue('SELLSIG12345');
  mocks.mockGetTokenAccountBalance.mockResolvedValue({
    value: { amount: remainingAtaBalance },
  });
  mocks.mockCreateCloseAccount.mockReturnValue({
    keys: [],
    programId: new PublicKey('11111111111111111111111111111111'),
    data: Buffer.alloc(0),
  });
}

describe('pump live buy', () => {
  it('returns a successful live swap with the tx signature', async () => {
    mockBuyHappyPath();
    const result = await buyToken(MINT, 0.05);
    expect(result.success).toBe(true);
    expect(result.simulated).toBe(false);
    expect(result.txSignature).toBe('BUYSIG12345');
    expect(result.amountOut).toBeCloseTo(1_785_357);
    expect(result.pricePerToken).toBeGreaterThan(0);
  });

  it('builds the buy via the SDK and sends one transaction', async () => {
    mockBuyHappyPath();
    await buyToken(MINT, 0.05);
    expect(mocks.mockBuyV2Instructions).toHaveBeenCalledTimes(1);
    expect(mocks.mockSendRawTransaction).toHaveBeenCalledTimes(1);
    // slippage is passed to the SDK as a whole-percent number (500bps -> 5).
    expect(mocks.mockBuyV2Instructions.mock.calls[0][0].slippage).toBe(5);
  });

  it('refuses the trade when the bonding curve has already graduated', async () => {
    mocks.mockGetBalance.mockResolvedValue(1_000_000_000);
    mocks.mockFetchBuyState.mockResolvedValue({
      bondingCurveAccountInfo: { data: Buffer.alloc(0) },
      bondingCurve: { complete: true },
      associatedUserAccountInfo: null,
    });
    const result = await buyToken(MINT, 0.05);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/graduated/);
    expect(mocks.mockBuyV2Instructions).not.toHaveBeenCalled();
    expect(mocks.mockSendRawTransaction).not.toHaveBeenCalled();
  });

  it('refuses the trade when the wallet would dip below the SOL reserve', async () => {
    mocks.mockGetBalance.mockResolvedValue(10_000_000); // 0.01 SOL — the reserve
    const result = await buyToken(MINT, 0.05);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/insufficient balance/);
    expect(mocks.mockFetchBuyState).not.toHaveBeenCalled();
  });

  it('refuses the trade when the curve quote returns zero tokens', async () => {
    mockBuyHappyPath();
    mocks.mockGetBuyTokenAmount.mockReturnValue(new BN(0));
    const result = await buyToken(MINT, 0.05);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/zero tokens/);
    expect(mocks.mockSendRawTransaction).not.toHaveBeenCalled();
  });

  it('surfaces the program error when confirmation reports a runtime failure', async () => {
    mockBuyHappyPath();
    mocks.mockConfirmTransaction.mockResolvedValue({
      value: { err: { InstructionError: [3, 'Custom'] } },
    });
    const result = await buyToken(MINT, 0.05);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/pump tx failed/);
  });
});

describe('pump live sell — direct bonding-curve path', () => {
  it('returns a successful live swap booked at the quoted SOL out', async () => {
    mockSellHappyPath();
    const result = await sellToken(MINT, 1_780_000, undefined, null);
    expect(result.success).toBe(true);
    expect(result.simulated).toBe(false);
    expect(result.txSignature).toBe('SELLSIG12345');
    expect(result.amountOut).toBeCloseTo(0.049);
  });

  it('refuses when the trade amount is below one base unit', async () => {
    mockSellHappyPath();
    const result = await sellToken(MINT, 1e-9, undefined, null);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/too small/);
    expect(mocks.mockSellV2Instructions).not.toHaveBeenCalled();
  });

  it('surfaces a program-side failure on confirmation', async () => {
    mockSellHappyPath();
    mocks.mockConfirmTransaction.mockResolvedValue({
      value: { err: { InstructionError: [3, 'Custom'] } },
    });
    const result = await sellToken(MINT, 1_000_000, undefined, null);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/pump tx failed/);
  });

  it('closes the emptied ATA after a full-exit sell', async () => {
    mockSellHappyPath('0'); // ATA drained to zero by the sell
    await sellToken(MINT, 1_000_000, undefined, null);
    expect(mocks.mockSendRawTransaction).toHaveBeenCalledTimes(2); // sell + close
    expect(mocks.mockCreateCloseAccount).toHaveBeenCalledTimes(1);
  });

  it('leaves the ATA open when tokens remain after a partial sell', async () => {
    mockSellHappyPath('500000'); // 0.5 tokens still held
    await sellToken(MINT, 1_000_000, undefined, null);
    expect(mocks.mockSendRawTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.mockCreateCloseAccount).not.toHaveBeenCalled();
  });

  it('still books the sell when the rent-reclaim close fails', async () => {
    mockSellHappyPath('0');
    mocks.mockSendRawTransaction
      .mockReset()
      .mockResolvedValueOnce('SELLSIG12345')
      .mockRejectedValueOnce(new Error('close tx dropped'));
    const result = await sellToken(MINT, 1_000_000, undefined, null);
    expect(result.success).toBe(true);
    expect(result.txSignature).toBe('SELLSIG12345');
  });
});

describe('pump live sell — Jupiter fallback for graduated curves', () => {
  function mockJupiterReachable() {
    mocks.mockGetMint.mockResolvedValue({ supply: 1_000_000_000_000_000n, decimals: 6 });
    // A Jupiter quote response; executeSwap downstream fails on the
    // placeholder swap tx, but reaching fetch proves we routed to Jupiter.
    mocks.mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ outAmount: '50000000' }),
      text: async () => '',
    });
  }

  it('routes through Jupiter when the curve reports complete=true', async () => {
    mocks.mockFetchSellState.mockResolvedValue({
      bondingCurveAccountInfo: { data: Buffer.alloc(0) },
      bondingCurve: { complete: true },
    });
    mockJupiterReachable();
    await sellToken(MINT, 1_000_000, undefined, null);
    expect(mocks.mockFetch).toHaveBeenCalled();
    expect(mocks.mockSellV2Instructions).not.toHaveBeenCalled();
  });

  it('routes through Jupiter when fetchSellState throws (curve gone / RPC blip)', async () => {
    mocks.mockFetchSellState.mockRejectedValue(new Error('rpc 429'));
    mockJupiterReachable();
    await sellToken(MINT, 1_000_000, undefined, null);
    expect(mocks.mockFetch).toHaveBeenCalled();
    expect(mocks.mockSellV2Instructions).not.toHaveBeenCalled();
  });
});
