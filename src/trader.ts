import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { getAssociatedTokenAddress, getMint } from '@solana/spl-token';
import bs58 from 'bs58';
import fetch from 'node-fetch';
import { Config, loadConfig, MIN_SOL_RESERVE, SOL_MINT_ADDRESS } from './config';
import { logger } from './logger';
import { PUMP_INITIAL_PRICE_SOL } from './analyzer';


const JUPITER_BASE = 'https://quote-api.jup.ag/v6';

// Phase 1 pump.fun support is paper-only. Live buys on pump-mode would need a
// direct bonding-curve instruction path; Jupiter won't route fresh launches.
const PUMP_LIVE_NOT_SUPPORTED =
  'live pump.fun trading is not supported yet (phase 1 is paper-only)';

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
  if (!cfg.simulate) {
    return {
      success: false,
      txSignature: '',
      amountIn: amountSol,
      amountOut: 0,
      pricePerToken: 0,
      simulated: false,
      error: PUMP_LIVE_NOT_SUPPORTED,
    };
  }
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

async function pumpSell(
  tokenMint: string,
  amountTokens: number,
  cfg: Config
): Promise<SwapResult> {
  if (!cfg.simulate) {
    return {
      success: false,
      txSignature: '',
      amountIn: amountTokens,
      amountOut: 0,
      pricePerToken: 0,
      simulated: false,
      error: PUMP_LIVE_NOT_SUPPORTED,
    };
  }
  // No real price feed for fresh pump tokens in paper mode. Treat the sell as
  // a no-op at the entry price so bookkeeping stays consistent if the position
  // monitor or a manual sell fires.
  const pricePerToken = PUMP_INITIAL_PRICE_SOL;
  const solOut = amountTokens * pricePerToken;
  logger.sim(
    `SELL ${tokenMint} ${amountTokens.toFixed(0)} tokens -> ${solOut} SOL @ ${pricePerToken.toExponential(4)} SOL (pump bonding-curve init price)`
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

export async function sellToken(
  tokenMint: string,
  amountTokens: number,
  cfg: Config = loadConfig()
): Promise<SwapResult> {
  if (cfg.source === 'pump') {
    return pumpSell(tokenMint, amountTokens, cfg);
  }

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
    logger.error(`sellToken failed for ${tokenMint}: ${message}`);
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
