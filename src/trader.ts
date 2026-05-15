import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  getAssociatedTokenAddress,
  getAssociatedTokenAddressSync,
  getMint,
} from '@solana/spl-token';
import bs58 from 'bs58';
import fetch from 'node-fetch';
import { Config, loadConfig, MIN_SOL_RESERVE, SOL_MINT_ADDRESS } from './config';
import { logger } from './logger';
import { PUMP_INITIAL_PRICE_SOL } from './analyzer';
import { decodeBondingCurve } from './bondingCurve';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  PUMP_TOKEN_BASE_UNITS,
  applySlippageMaxSol,
  applySlippageMinSol,
  buildBuyInstruction,
  buildSellInstruction,
  computeBuyTokensOut,
  computeSellSolOut,
  getBondingCurvePda,
  readPumpFeeRecipient,
} from './pumpProgram';


const JUPITER_BASE = 'https://quote-api.jup.ag/v6';

// Compute-unit limit for pump buy/sell txs. A first-time buy bundles a
// Token-2022 ATA-create (~25k CU) ahead of the pump buy itself (~120-160k),
// which crowds a 200k ceiling; 250k clears it with headroom. The priority
// fee scales with this limit, but the absolute difference is a rounding
// error (~0.000005 SOL per tx).
const PUMP_COMPUTE_UNIT_LIMIT = 250_000;

export interface SwapResult {
  success: boolean;
  txSignature: string;
  amountIn: number; // human units (SOL for buys, tokens for sells)
  amountOut: number;
  pricePerToken: number; // SOL per token
  simulated: boolean;
  error?: string;
}

interface JupiterQuote {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  [key: string]: unknown;
}

interface JupiterSwapResponse {
  swapTransaction: string;
  [key: string]: unknown;
}

let walletCache: Keypair | null = null;
let connectionCache: Connection | null = null;
const mintDecimalsCache = new Map<string, number>();

function getConnection(cfg: Config = loadConfig()): Connection {
  if (!connectionCache) {
    connectionCache = new Connection(cfg.solanaRpcUrl, 'confirmed');
  }
  return connectionCache;
}

export function getWallet(cfg: Config = loadConfig()): Keypair {
  if (walletCache) return walletCache;
  if (!cfg.walletPrivateKey) {
    // In simulation we may not have a real wallet. Generate an ephemeral one
    // so address-dependent code paths work without risking funds.
    if (cfg.simulate) {
      walletCache = Keypair.generate();
      logger.warn('No WALLET_PRIVATE_KEY set; using ephemeral keypair for simulation');
      return walletCache;
    }
    throw new Error('WALLET_PRIVATE_KEY is required');
  }
  const secret = bs58.decode(cfg.walletPrivateKey);
  walletCache = Keypair.fromSecretKey(secret);
  return walletCache;
}

export async function getWalletBalance(cfg: Config = loadConfig()): Promise<number> {
  const wallet = getWallet(cfg);
  const lamports = await getConnection(cfg).getBalance(wallet.publicKey);
  return lamports / LAMPORTS_PER_SOL;
}

export async function getTokenBalance(
  mint: string,
  cfg: Config = loadConfig()
): Promise<number> {
  const wallet = getWallet(cfg);
  const mintPk = new PublicKey(mint);
  const ata = await getAssociatedTokenAddress(mintPk, wallet.publicKey);
  try {
    const info = await getConnection(cfg).getTokenAccountBalance(ata);
    return Number(info.value.uiAmount ?? 0);
  } catch {
    return 0;
  }
}

async function getMintDecimals(mint: string, cfg: Config): Promise<number> {
  const cached = mintDecimalsCache.get(mint);
  if (cached !== undefined) return cached;
  const info = await getMint(getConnection(cfg), new PublicKey(mint));
  mintDecimalsCache.set(mint, info.decimals);
  return info.decimals;
}

async function getQuote(params: {
  inputMint: string;
  outputMint: string;
  amount: string;
  slippageBps: number;
}): Promise<JupiterQuote> {
  const url = new URL(`${JUPITER_BASE}/quote`);
  url.searchParams.set('inputMint', params.inputMint);
  url.searchParams.set('outputMint', params.outputMint);
  url.searchParams.set('amount', params.amount);
  url.searchParams.set('slippageBps', String(params.slippageBps));
  url.searchParams.set('swapMode', 'ExactIn');

  logger.debug(`jupiter quote: ${params.inputMint.slice(0, 8)}... -> ${params.outputMint.slice(0, 8)}... amount=${params.amount}`);
  const res = await fetch(url.toString());
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Jupiter quote ${res.status}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as JupiterQuote;
}

async function getSwapTransaction(
  quote: JupiterQuote,
  userPublicKey: string
): Promise<JupiterSwapResponse> {
  const res = await fetch(`${JUPITER_BASE}/swap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto',
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Jupiter swap ${res.status}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as JupiterSwapResponse;
}

async function executeSwap(
  quote: JupiterQuote,
  cfg: Config
): Promise<string> {
  const wallet = getWallet(cfg);
  const connection = getConnection(cfg);
  const swapResp = await getSwapTransaction(quote, wallet.publicKey.toBase58());
  const txBytes = Buffer.from(swapResp.swapTransaction, 'base64');
  const tx = VersionedTransaction.deserialize(txBytes);
  tx.sign([wallet]);

  const signature = await connection.sendTransaction(tx, {
    skipPreflight: true,
    maxRetries: 2,
  });

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const confirmation = await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    'confirmed'
  );
  if (confirmation.value.err) {
    throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
  }
  return signature;
}

export async function buyToken(
  tokenMint: string,
  amountSol: number,
  cfg: Config = loadConfig()
): Promise<SwapResult> {
  if (cfg.source === 'pump') {
    return pumpBuy(tokenMint, amountSol, cfg);
  }

  const lamports = Math.floor(amountSol * LAMPORTS_PER_SOL);

  // Balance guard (skip in simulation — no real balance to check when using ephemeral key)
  if (!cfg.simulate) {
    const balance = await getWalletBalance(cfg);
    if (balance - amountSol < MIN_SOL_RESERVE) {
      return {
        success: false,
        txSignature: '',
        amountIn: amountSol,
        amountOut: 0,
        pricePerToken: 0,
        simulated: false,
        error: `insufficient balance: ${balance.toFixed(4)} SOL, need ${(amountSol + MIN_SOL_RESERVE).toFixed(4)}`,
      };
    }
  }

  try {
    const quote = await getQuote({
      inputMint: SOL_MINT_ADDRESS,
      outputMint: tokenMint,
      amount: String(lamports),
      slippageBps: cfg.maxSlippageBps,
    });
    const decimals = await getMintDecimals(tokenMint, cfg);
    const tokensOut = Number(quote.outAmount) / 10 ** decimals;
    const pricePerToken = tokensOut > 0 ? amountSol / tokensOut : 0;

    if (cfg.simulate) {
      logger.sim(`BUY ${tokenMint} ${amountSol} SOL -> ${tokensOut} tokens @ ${pricePerToken.toExponential(4)} SOL`);
      return {
        success: true,
        txSignature: `SIM-${Date.now()}`,
        amountIn: amountSol,
        amountOut: tokensOut,
        pricePerToken,
        simulated: true,
      };
    }

    const signature = await executeSwap(quote, cfg);
    logger.position('BUY', tokenMint, `${amountSol} SOL -> ${tokensOut.toFixed(4)} tokens (${signature.slice(0, 8)}...)`);
    return {
      success: true,
      txSignature: signature,
      amountIn: amountSol,
      amountOut: tokensOut,
      pricePerToken,
      simulated: false,
    };
  } catch (err) {
    const message = (err as Error).message;
    logger.error(`buyToken failed for ${tokenMint}: ${message}`);
    return {
      success: false,
      txSignature: '',
      amountIn: amountSol,
      amountOut: 0,
      pricePerToken: 0,
      simulated: cfg.simulate,
      error: message,
    };
  }
}

async function pumpBuy(
  tokenMint: string,
  amountSol: number,
  cfg: Config
): Promise<SwapResult> {
  return cfg.simulate
    ? pumpBuySim(tokenMint, amountSol)
    : pumpBuyLive(tokenMint, amountSol, cfg);
}

function pumpBuySim(tokenMint: string, amountSol: number): SwapResult {
  const pricePerToken = PUMP_INITIAL_PRICE_SOL;
  const tokensOut = amountSol / pricePerToken;
  logger.sim(
    `BUY ${tokenMint} ${amountSol} SOL -> ${tokensOut.toFixed(0)} tokens @ ${pricePerToken.toExponential(4)} SOL (pump bonding-curve init price)`
  );
  return {
    success: true,
    txSignature: `SIM-${Date.now()}`,
    amountIn: amountSol,
    amountOut: tokensOut,
    pricePerToken,
    simulated: true,
  };
}

function pumpFailure(amountIn: number, error: string): SwapResult {
  return {
    success: false,
    txSignature: '',
    amountIn,
    amountOut: 0,
    pricePerToken: 0,
    simulated: false,
    error,
  };
}

async function detectTokenProgram(
  connection: Connection,
  mint: PublicKey
): Promise<PublicKey> {
  const info = await connection.getAccountInfo(mint, 'confirmed');
  if (!info) throw new Error(`mint ${mint.toBase58()} not found`);
  return info.owner;
}

async function pumpBuyLive(
  tokenMint: string,
  amountSol: number,
  cfg: Config
): Promise<SwapResult> {
  try {
    const connection = getConnection(cfg);
    const wallet = getWallet(cfg);
    const mintPk = new PublicKey(tokenMint);

    const bondingCurvePda = getBondingCurvePda(mintPk);
    const bcInfo = await connection.getAccountInfo(bondingCurvePda, 'confirmed');
    if (!bcInfo?.data) {
      return pumpFailure(amountSol, 'bonding curve account not found');
    }
    const state = decodeBondingCurve(Buffer.from(bcInfo.data));
    if (state.complete) {
      return pumpFailure(amountSol, 'bonding curve already graduated');
    }
    if (!state.creator) {
      return pumpFailure(
        amountSol,
        'bonding curve missing creator (pre-creator-fees layout)'
      );
    }

    const tokenProgram = await detectTokenProgram(connection, mintPk);
    const feeRecipient = await readPumpFeeRecipient(connection);

    const balance = await getWalletBalance(cfg);
    if (balance - amountSol < MIN_SOL_RESERVE) {
      return pumpFailure(
        amountSol,
        `insufficient balance: ${balance.toFixed(4)} SOL, need ${(amountSol + MIN_SOL_RESERVE).toFixed(4)}`
      );
    }

    const lamportsIn = BigInt(Math.floor(amountSol * LAMPORTS_PER_SOL));
    const tokensOutBaseUnits = computeBuyTokensOut(
      state.virtualSolReserves,
      state.virtualTokenReserves,
      lamportsIn
    );
    if (tokensOutBaseUnits <= 0n) {
      return pumpFailure(amountSol, 'curve math returned zero tokens');
    }
    const maxSolCost = applySlippageMaxSol(lamportsIn, cfg.maxSlippageBps);

    const userAta = getAssociatedTokenAddressSync(
      mintPk,
      wallet.publicKey,
      false,
      tokenProgram,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    const ataIx = createAssociatedTokenAccountIdempotentInstruction(
      wallet.publicKey,
      userAta,
      wallet.publicKey,
      mintPk,
      tokenProgram,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const buyIx = buildBuyInstruction({
      user: wallet.publicKey,
      mint: mintPk,
      creator: state.creator,
      tokenProgram,
      userAta,
      feeRecipient,
      amount: tokensOutBaseUnits,
      maxSolCost,
      trackVolume: false,
    });

    const cuLimitIx = ComputeBudgetProgram.setComputeUnitLimit({
      units: PUMP_COMPUTE_UNIT_LIMIT,
    });
    const cuPriceIx = ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: cfg.pumpPriorityMicrolamports,
    });

    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash('confirmed');
    const message = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: blockhash,
      instructions: [cuLimitIx, cuPriceIx, ataIx, buyIx],
    }).compileToV0Message();
    const tx = new VersionedTransaction(message);
    tx.sign([wallet]);

    const signature = await connection.sendTransaction(tx, {
      skipPreflight: true,
      maxRetries: 2,
    });
    const confirmation = await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      'confirmed'
    );
    if (confirmation.value.err) {
      return pumpFailure(
        amountSol,
        `pump buy tx failed: ${JSON.stringify(confirmation.value.err)}`
      );
    }

    const tokensOut = Number(tokensOutBaseUnits) / PUMP_TOKEN_BASE_UNITS;
    const pricePerToken = tokensOut > 0 ? amountSol / tokensOut : 0;
    logger.position(
      'BUY',
      tokenMint,
      `${amountSol} SOL -> ${tokensOut.toFixed(4)} tokens (${signature.slice(0, 8)}..., pump direct)`
    );
    return {
      success: true,
      txSignature: signature,
      amountIn: amountSol,
      amountOut: tokensOut,
      pricePerToken,
      simulated: false,
    };
  } catch (err) {
    const message = (err as Error).message;
    logger.error(`pumpBuyLive ${tokenMint}: ${message}`);
    return pumpFailure(amountSol, message);
  }
}

async function pumpSell(
  tokenMint: string,
  amountTokens: number,
  cfg: Config,
  currentPriceSol: number | null
): Promise<SwapResult> {
  if (cfg.simulate) return pumpSellSim(tokenMint, amountTokens, currentPriceSol);
  return pumpSellLive(tokenMint, amountTokens, cfg);
}

function pumpSellSim(
  tokenMint: string,
  amountTokens: number,
  currentPriceSol: number | null
): SwapResult {
  // Paper sells must reflect the actual price the position monitor saw,
  // otherwise stop-loss and TP exits both book at entry and every paper
  // pump position closes at wash. Fall back to the bonding-curve init
  // price only when no current price is available (e.g. manual sell on a
  // token we never got a quote for) — that case still records a fake
  // breakeven, but it's the best we can do without a live price feed.
  const pricePerToken =
    currentPriceSol !== null && Number.isFinite(currentPriceSol) && currentPriceSol > 0
      ? currentPriceSol
      : PUMP_INITIAL_PRICE_SOL;
  const solOut = amountTokens * pricePerToken;
  const priceSource =
    pricePerToken === PUMP_INITIAL_PRICE_SOL ? 'pump bonding-curve init price' : 'last observed price';
  logger.sim(
    `SELL ${tokenMint} ${amountTokens.toFixed(0)} tokens -> ${solOut} SOL @ ${pricePerToken.toExponential(4)} SOL (${priceSource})`
  );
  return {
    success: true,
    txSignature: `SIM-${Date.now()}`,
    amountIn: amountTokens,
    amountOut: solOut,
    pricePerToken,
    simulated: true,
  };
}

function pumpSellFailure(amountTokens: number, error: string): SwapResult {
  return {
    success: false,
    txSignature: '',
    amountIn: amountTokens,
    amountOut: 0,
    pricePerToken: 0,
    simulated: false,
    error,
  };
}

async function pumpSellLive(
  tokenMint: string,
  amountTokens: number,
  cfg: Config
): Promise<SwapResult> {
  try {
    const connection = getConnection(cfg);
    const mintPk = new PublicKey(tokenMint);
    const bondingCurvePda = getBondingCurvePda(mintPk);

    let bcInfo: Awaited<ReturnType<Connection['getAccountInfo']>>;
    try {
      bcInfo = await connection.getAccountInfo(bondingCurvePda, 'confirmed');
    } catch (err) {
      // RPC failed reading the curve. We can't tell graduated from blip, so
      // try Jupiter — it'll succeed for graduated tokens and fail cleanly
      // for active curves (which it can't route anyway).
      logger.debug(`pumpSellLive curve read failed (${(err as Error).message}); trying Jupiter`);
      return jupiterSell(tokenMint, amountTokens, cfg);
    }

    // No account or complete=true means the curve graduated; the mint moved
    // to PumpSwap AMM and Jupiter routes it.
    if (!bcInfo?.data) {
      logger.info(`bonding curve closed for ${tokenMint}; selling via Jupiter (post-graduation)`);
      return jupiterSell(tokenMint, amountTokens, cfg);
    }
    const state = decodeBondingCurve(Buffer.from(bcInfo.data));
    if (state.complete) {
      logger.info(`bonding curve complete for ${tokenMint}; selling via Jupiter (post-graduation)`);
      return jupiterSell(tokenMint, amountTokens, cfg);
    }
    if (!state.creator) {
      return pumpSellFailure(
        amountTokens,
        'bonding curve missing creator (pre-creator-fees layout)'
      );
    }

    const wallet = getWallet(cfg);
    const tokenProgram = await detectTokenProgram(connection, mintPk);
    const feeRecipient = await readPumpFeeRecipient(connection);

    const amountBaseUnits = BigInt(Math.floor(amountTokens * PUMP_TOKEN_BASE_UNITS));
    if (amountBaseUnits <= 0n) {
      return pumpSellFailure(amountTokens, 'amount too small');
    }
    const expectedSolOut = computeSellSolOut(
      state.virtualSolReserves,
      state.virtualTokenReserves,
      amountBaseUnits
    );
    if (expectedSolOut <= 0n) {
      return pumpSellFailure(amountTokens, 'curve math returned zero SOL out');
    }
    const minSolOutput = applySlippageMinSol(expectedSolOut, cfg.maxSlippageBps);

    const userAta = getAssociatedTokenAddressSync(
      mintPk,
      wallet.publicKey,
      false,
      tokenProgram,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const sellIx = buildSellInstruction({
      user: wallet.publicKey,
      mint: mintPk,
      creator: state.creator,
      tokenProgram,
      userAta,
      feeRecipient,
      amount: amountBaseUnits,
      minSolOutput,
    });

    const cuLimitIx = ComputeBudgetProgram.setComputeUnitLimit({
      units: PUMP_COMPUTE_UNIT_LIMIT,
    });
    const cuPriceIx = ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: cfg.pumpPriorityMicrolamports,
    });

    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash('confirmed');
    const message = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: blockhash,
      instructions: [cuLimitIx, cuPriceIx, sellIx],
    }).compileToV0Message();
    const tx = new VersionedTransaction(message);
    tx.sign([wallet]);

    const signature = await connection.sendTransaction(tx, {
      skipPreflight: true,
      maxRetries: 2,
    });
    const confirmation = await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      'confirmed'
    );
    if (confirmation.value.err) {
      return pumpSellFailure(
        amountTokens,
        `pump sell tx failed: ${JSON.stringify(confirmation.value.err)}`
      );
    }

    // If that sell drained the position, the now-empty ATA still holds
    // ~0.002 SOL of rent — reclaim it. Best-effort and in its own tx so a
    // close failure can never undo the booked sell above.
    await maybeCloseEmptyAta(connection, mintPk, userAta, tokenProgram, cfg);

    // Book the trade at the curve-implied price — actual SOL delivered may
    // be a hair higher if the program rounded our minSolOutput up, but the
    // computed expected is the conservative figure for PnL accounting.
    const solOut = Number(expectedSolOut) / LAMPORTS_PER_SOL;
    const pricePerToken = amountTokens > 0 ? solOut / amountTokens : 0;
    logger.position(
      'SELL',
      tokenMint,
      `${amountTokens.toFixed(4)} tokens -> ${solOut.toFixed(6)} SOL (${signature.slice(0, 8)}..., pump direct)`
    );
    return {
      success: true,
      txSignature: signature,
      amountIn: amountTokens,
      amountOut: solOut,
      pricePerToken,
      simulated: false,
    };
  } catch (err) {
    const message = (err as Error).message;
    logger.error(`pumpSellLive ${tokenMint}: ${message}`);
    return pumpSellFailure(amountTokens, message);
  }
}

// Closes the user's token ATA once it is empty, returning its rent-exempt
// lamports (~0.002 SOL) to the wallet. Called after every live pump sell:
// a partial sell leaves a balance and is skipped; a full exit drains the
// account and triggers the close. Entirely best-effort — any failure (RPC
// hiccup, residual dust, Token-2022 withheld fees) is logged and swallowed
// so the already-confirmed sell is never affected.
async function maybeCloseEmptyAta(
  connection: Connection,
  mint: PublicKey,
  ata: PublicKey,
  tokenProgram: PublicKey,
  cfg: Config
): Promise<void> {
  try {
    const balance = await connection.getTokenAccountBalance(ata);
    if (BigInt(balance.value.amount) !== 0n) return; // partial sell — tokens remain

    const wallet = getWallet(cfg);
    const closeIx = createCloseAccountInstruction(
      ata,
      wallet.publicKey, // rent-exempt lamports go back to the wallet
      wallet.publicKey, // ATA owner / close authority
      [],
      tokenProgram
    );
    const instructions = [closeIx];
    if (cfg.pumpPriorityMicrolamports > 0) {
      instructions.unshift(
        ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: cfg.pumpPriorityMicrolamports,
        })
      );
    }

    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash('confirmed');
    const message = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message();
    const tx = new VersionedTransaction(message);
    tx.sign([wallet]);

    const signature = await connection.sendTransaction(tx, {
      skipPreflight: true,
      maxRetries: 2,
    });
    await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      'confirmed'
    );
    logger.info(
      `closed empty ATA for ${mint.toBase58()} — reclaimed rent (${signature.slice(0, 8)}...)`
    );
  } catch (err) {
    logger.debug(`ATA close skipped for ${mint.toBase58()}: ${(err as Error).message}`);
  }
}

// Token → SOL via Jupiter V6. Used by Raydium and pump-post-graduation; pump
// pre-graduation goes through pumpSellLive's direct curve instruction.
async function jupiterSell(
  tokenMint: string,
  amountTokens: number,
  cfg: Config
): Promise<SwapResult> {
  try {
    const decimals = await getMintDecimals(tokenMint, cfg);
    const rawAmount = BigInt(Math.floor(amountTokens * 10 ** decimals));
    if (rawAmount <= 0n) {
      return {
        success: false,
        txSignature: '',
        amountIn: amountTokens,
        amountOut: 0,
        pricePerToken: 0,
        simulated: cfg.simulate,
        error: 'amount too small',
      };
    }

    const quote = await getQuote({
      inputMint: tokenMint,
      outputMint: SOL_MINT_ADDRESS,
      amount: rawAmount.toString(),
      slippageBps: cfg.maxSlippageBps,
    });
    const solOut = Number(quote.outAmount) / LAMPORTS_PER_SOL;
    const pricePerToken = amountTokens > 0 ? solOut / amountTokens : 0;

    if (cfg.simulate) {
      logger.sim(`SELL ${tokenMint} ${amountTokens} tokens -> ${solOut} SOL @ ${pricePerToken.toExponential(4)} SOL`);
      return {
        success: true,
        txSignature: `SIM-${Date.now()}`,
        amountIn: amountTokens,
        amountOut: solOut,
        pricePerToken,
        simulated: true,
      };
    }

    const signature = await executeSwap(quote, cfg);
    logger.position('SELL', tokenMint, `${amountTokens.toFixed(4)} tokens -> ${solOut.toFixed(4)} SOL (${signature.slice(0, 8)}...)`);
    return {
      success: true,
      txSignature: signature,
      amountIn: amountTokens,
      amountOut: solOut,
      pricePerToken,
      simulated: false,
    };
  } catch (err) {
    const message = (err as Error).message;
    logger.error(`jupiterSell failed for ${tokenMint}: ${message}`);
    return {
      success: false,
      txSignature: '',
      amountIn: amountTokens,
      amountOut: 0,
      pricePerToken: 0,
      simulated: cfg.simulate,
      error: message,
    };
  }
}

export async function sellToken(
  tokenMint: string,
  amountTokens: number,
  cfg: Config = loadConfig(),
  // Hint of the current market price, supplied by the caller when known.
  // Required for accurate paper-mode pump bookkeeping; ignored on the
  // Jupiter path because the quote's outAmount is the source of truth.
  currentPriceSol: number | null = null
): Promise<SwapResult> {
  if (cfg.source === 'pump') {
    return pumpSell(tokenMint, amountTokens, cfg, currentPriceSol);
  }
  return jupiterSell(tokenMint, amountTokens, cfg);
}
