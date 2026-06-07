import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
  getMint,
} from '@solana/spl-token';
// BN is bn.js re-exported by Anchor; the pump SDK speaks it for every amount.
import { BN } from '@coral-xyz/anchor';
import {
  OnlinePumpSdk,
  PumpSdk,
  getBuyTokenAmountFromSolAmount,
  getSellSolAmountFromTokenAmount,
} from '@pump-fun/pump-sdk';
import {
  OnlinePumpAmmSdk,
  PumpAmmSdk,
  canonicalPumpPoolPda,
} from '@pump-fun/pump-swap-sdk';
import bs58 from 'bs58';
import fetch from 'node-fetch';
import { Config, loadConfig, MIN_SOL_RESERVE, SOL_MINT_ADDRESS } from './config';
import { logger } from './logger';
import { PUMP_INITIAL_PRICE_SOL } from './analyzer';
import { PUMP_TOKEN_BASE_UNITS, bondingCurvePda, readBondingCurve } from './bondingCurve';


// Jupiter retired the legacy quote-api.jup.ag/v6 host (now ECONNREFUSED).
// lite-api.jup.ag/swap/v1 is the current free Swap API — same /quote and
// /swap paths, same request params and response shape.
const JUPITER_BASE = 'https://lite-api.jup.ag/swap/v1';

// Compute-unit limit for pump buy/sell txs. buy_v2 carries 27 accounts and the
// SDK prepends several init_if_needed ATA creates; pump's own docs budget
// 400k CU for it. The priority fee scales with this limit but the absolute
// difference from a lower cap is a rounding error (~0.00001 SOL per tx).
const PUMP_COMPUTE_UNIT_LIMIT = 400_000;

// Buy/sell txs get dropped by validators under load; a single send often
// just vanishes, then confirmTransaction waits out the full blockhash window
// before reporting "block height exceeded". We rebroadcast the same signed
// tx on this interval until it confirms or its blockhash truly expires.
const PUMP_TX_REBROADCAST_INTERVAL_MS = 2000;
// Dynamic priority fee: target this percentile of recent non-zero network
// fees, with this much headroom on top, then clamp to the configured range.
const PUMP_PRIORITY_PERCENTILE = 0.75;
const PUMP_PRIORITY_HEADROOM = 1.3;

// pump SDK's slippage arg is a whole-percent number (5 = 5%).
function slippagePercent(cfg: Config): number {
  return cfg.maxSlippageBps / 100;
}

// pump.fun's Global and FeeConfig accounts are network-wide, not per-token,
// and change very rarely. Re-fetching both on every buy/sell adds two
// sequential RPC round-trips to the critical path — on a fast-climbing
// momentum token that latency alone can blow the slippage cap (6002). Cache
// them with a short TTL so a genuine config change still propagates within
// minutes, and parallelize the cold fetch.
const PUMP_CONFIG_TTL_MS = 5 * 60_000;
type PumpConfig = {
  global: Awaited<ReturnType<OnlinePumpSdk['fetchGlobal']>>;
  feeConfig: Awaited<ReturnType<OnlinePumpSdk['fetchFeeConfig']>>;
};
let pumpConfigCache: { value: PumpConfig; at: number } | null = null;

async function fetchPumpConfig(onlineSdk: OnlinePumpSdk): Promise<PumpConfig> {
  if (pumpConfigCache && Date.now() - pumpConfigCache.at < PUMP_CONFIG_TTL_MS) {
    return pumpConfigCache.value;
  }
  const [global, feeConfig] = await Promise.all([
    onlineSdk.fetchGlobal(),
    onlineSdk.fetchFeeConfig(),
  ]);
  pumpConfigCache = { value: { global, feeConfig }, at: Date.now() };
  return pumpConfigCache.value;
}

// Tests drive different mock config per case — drop the cache between them.
export function __resetPumpConfigCache(): void {
  pumpConfigCache = null;
}

export interface SwapResult {
  success: boolean;
  txSignature: string;
  amountIn: number; // human units (SOL for buys, tokens for sells)
  amountOut: number;
  pricePerToken: number; // SOL per token
  simulated: boolean;
  error?: string;
  // Which venue executed the trade. Lets the caller store the bonding-curve
  // PDA as a position's price source when the buy went through the pump curve
  // (copytrade only learns the venue per-token at trade time).
  venue?: 'pump' | 'jupiter';
  // True for a per-token / transient failure that must NOT trip the circuit
  // breaker (no quote/route, block-height-exceeded, init race 6001, incompatible
  // token 6010). A fee may or may not have been paid; the point is it is not the
  // systematic fault (dead RPC / drained wallet / bad encoding) the breaker
  // exists to catch. See isNonSystematicBuyError.
  softFailure?: boolean;
  // Token market cap in USD at trade time (supply x price x SOL/USD), for the
  // buy/sell log + alert. Best-effort; undefined when supply or the SOL price
  // wasn't available (e.g. a Jupiter-routed non-pump token).
  marketCapUsd?: number;
}

// Cached SOL/USD for USD market-cap display on trade lines. Best-effort: a free
// price endpoint refreshed at most every 5 min (not Helius RPC, no key). On any
// failure we keep the last value or return null, and MC display is just omitted.
let solUsdCache: { value: number; at: number } | null = null;
const SOL_USD_TTL_MS = 5 * 60 * 1000;
async function getSolUsd(): Promise<number | null> {
  const now = Date.now();
  if (solUsdCache && now - solUsdCache.at < SOL_USD_TTL_MS) return solUsdCache.value;
  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd'
    );
    if (!res.ok) return solUsdCache?.value ?? null;
    const body = (await res.json()) as { solana?: { usd?: number } };
    const usd = body.solana?.usd;
    if (typeof usd === 'number' && usd > 0) {
      solUsdCache = { value: usd, at: now };
      return usd;
    }
  } catch {
    // fall through to the last cached value (or null)
  }
  return solUsdCache?.value ?? null;
}

// MC in USD = circulating supply (human units) x price-per-token (SOL) x SOL/USD.
async function marketCapUsd(
  supplyTokens: number,
  pricePerTokenSol: number
): Promise<number | undefined> {
  if (!(supplyTokens > 0) || !(pricePerTokenSol > 0)) return undefined;
  const solUsd = await getSolUsd();
  if (!solUsd) return undefined;
  return supplyTokens * pricePerTokenSol * solUsd;
}

// Compact USD: $24K, $1.8M, $950.
export function formatUsd(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return '?';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
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
  try {
    const connection = getConnection(cfg);
    // Derive the ATA under the mint's actual token program — a Token-2022
    // mint's associated account differs from the classic SPL one.
    const tokenProgram = await detectTokenProgram(connection, mintPk);
    const ata = getAssociatedTokenAddressSync(mintPk, wallet.publicKey, false, tokenProgram);
    const info = await connection.getTokenAccountBalance(ata);
    return Number(info.value.uiAmount ?? 0);
  } catch {
    return 0;
  }
}

async function getMintDecimals(mint: string, cfg: Config): Promise<number> {
  const cached = mintDecimalsCache.get(mint);
  if (cached !== undefined) return cached;
  const connection = getConnection(cfg);
  const mintPk = new PublicKey(mint);
  // The mint may be classic SPL Token or Token-2022 — pump-graduated tokens
  // (which the trending source surfaces heavily) are usually Token-2022.
  // getMint must be told which program owns the mint, or it throws an
  // empty-message TokenInvalidAccountOwnerError.
  const tokenProgram = await detectTokenProgram(connection, mintPk);
  const info = await getMint(connection, mintPk, undefined, tokenProgram);
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

// Pick the execution venue for a token. The pump source is always the direct
// bonding-curve path. Copytrade mirrors a leader into whatever they bought,
// which may be a token still on its pump.fun bonding curve (Jupiter cannot
// price or route an active curve) or an already-graduated AMM token (Jupiter
// routes it). So for copytrade we detect per token: an active, un-graduated
// curve -> direct pump path; anything else (graduated, non-pump, unreadable)
// -> Jupiter. Other sources never use the pump path here.
// Classify a token's pump.fun bonding-curve state for venue routing:
//   'price'     -> active, un-graduated curve (direct pump buy/sell ix)
//   'graduated' -> curve complete, now a PumpSwap AMM pool (PumpSwap SDK)
//   'none'      -> not a pump token, or persistently unreadable
// readBondingCurve returns 'unavailable' on a transient RPC blip (uncached),
// the same value as for a genuinely non-pump token, so retry a few times before
// concluding 'none' — a misclassification routes an on-curve token to Jupiter,
// which cannot route an active curve.
async function classifyPumpCurve(
  tokenMint: string,
  connection: Connection
): Promise<'price' | 'graduated' | 'none'> {
  const addr = bondingCurvePda(tokenMint).toBase58();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const reading = await readBondingCurve(connection, addr);
      if (reading.kind === 'price') return 'price';
      if (reading.kind === 'graduated') return 'graduated';
    } catch {
      // fall through to retry
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 250));
  }
  return 'none';
}

// Execution venue for a token: 'curve' (active pump bonding curve, direct ix),
// 'pumpswap' (graduated pump token, now an AMM pool — sell via the pump AMM
// SDK), or 'jupiter' (non-pump AMM, or an unreadable curve). The pump source is
// always the curve; copytrade detects per token; other sources are Jupiter.
export async function resolveVenue(
  tokenMint: string,
  cfg: Config,
  connection: Connection = getConnection(cfg)
): Promise<'curve' | 'pumpswap' | 'jupiter'> {
  if (cfg.source === 'pump') return 'curve';
  if (cfg.source !== 'copytrade') return 'jupiter';
  const kind = await classifyPumpCurve(tokenMint, connection);
  if (kind === 'price') return 'curve';
  if (kind === 'graduated') return 'pumpswap';
  return 'jupiter';
}

export async function usePumpVenue(
  tokenMint: string,
  cfg: Config,
  connection: Connection = getConnection(cfg)
): Promise<boolean> {
  return (await resolveVenue(tokenMint, cfg, connection)) === 'curve';
}

export async function buyToken(
  tokenMint: string,
  amountSol: number,
  cfg: Config = loadConfig()
): Promise<SwapResult> {
  if (await usePumpVenue(tokenMint, cfg)) {
    const r = await pumpBuy(tokenMint, amountSol, cfg);
    return { ...r, venue: 'pump' };
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
        venue: 'jupiter',
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
      venue: 'jupiter',
    };
  } catch (err) {
    const message = (err as Error).message;
    logger.error(`buyToken failed for ${tokenMint}: ${message}`);
    // Per-token / transient failures must not trip the do-not-restart breaker
    // (see isNonSystematicBuyError): no quote/route, block-height-exceeded,
    // init race (6001), incompatible token (6010).
    const softFailure = isNonSystematicBuyError(message);
    return {
      success: false,
      txSignature: '',
      amountIn: amountSol,
      amountOut: 0,
      pricePerToken: 0,
      simulated: cfg.simulate,
      error: message,
      softFailure,
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

// A buy failure that is per-token or transient, NOT a systematic fault, so it
// must not count toward the do-not-restart circuit breaker (which exists to
// halt on dead-RPC / drained-wallet / bad-encoding bleed). Covers: no quote /
// route (no fee), block-height-exceeded (tx expired, congestion), Custom:6001
// (AlreadyInitialized — a rapid double-buy init race), and Custom:6010
// (AccountTypeNotSupported — an incompatible token type, e.g. a Token-2022 with
// extensions pump's buy can't handle). Slippage (6002) stays HARD: a run of it
// is the canary for a quoting regression we DO want the breaker to catch.
function isNonSystematicBuyError(message: string): boolean {
  return /quote|route|could not find|block height exceeded|"Custom":\s*(6001|6010)\b/i.test(
    message
  );
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
    softFailure: isNonSystematicBuyError(error),
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

// Picks a competitive priority fee for the next pump tx. Reads recent
// network prioritization fees and targets a high percentile with headroom,
// clamped to [floor, max] from config. Falls back to the floor on any RPC
// error so a fee-lookup hiccup never blocks a snipe.
export async function computePriorityMicrolamports(
  connection: Connection,
  cfg: Config
): Promise<number> {
  const floor = cfg.pumpPriorityMicrolamports;
  try {
    const recent = await connection.getRecentPrioritizationFees();
    const fees = recent
      .map((r) => r.prioritizationFee)
      .filter((f) => f > 0)
      .sort((a, b) => a - b);
    if (fees.length === 0) return floor;
    const idx = Math.min(
      fees.length - 1,
      Math.floor(fees.length * PUMP_PRIORITY_PERCENTILE)
    );
    const target = Math.ceil(fees[idx] * PUMP_PRIORITY_HEADROOM);
    return Math.min(Math.max(target, floor), cfg.pumpPriorityMaxMicrolamports);
  } catch (err) {
    logger.debug(`priority fee estimate failed: ${(err as Error).message}`);
    return floor;
  }
}

// Sends a signed raw tx and keeps rebroadcasting it on an interval until it
// confirms or its blockhash expires. confirmTransaction owns the outcome;
// the rebroadcast loop just keeps the tx in front of validators so it isn't
// silently dropped under load. Returns the signature on success; throws on a
// program error or block-height expiry so the caller books a failed swap.
export async function confirmWithRebroadcast(
  connection: Connection,
  rawTx: Uint8Array,
  blockhash: { blockhash: string; lastValidBlockHeight: number },
  rebroadcastIntervalMs: number = PUMP_TX_REBROADCAST_INTERVAL_MS
): Promise<string> {
  const send = () =>
    connection.sendRawTransaction(rawTx, { skipPreflight: true, maxRetries: 0 });
  const signature = await send();

  let settled = false;
  // wake() cancels the in-flight interval so the loop exits the instant the
  // tx settles, instead of waiting out a full rebroadcast interval.
  let wake: () => void = () => {};
  const rebroadcast = (async () => {
    while (!settled) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, rebroadcastIntervalMs);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      if (settled) break;
      try {
        await send();
      } catch {
        // Already-processed or a transient RPC error — confirmTransaction
        // remains the source of truth, so a failed resend is harmless.
      }
    }
  })();

  try {
    const confirmation = await connection.confirmTransaction(
      { signature, ...blockhash },
      'confirmed'
    );
    if (confirmation.value.err) {
      throw new Error(`pump tx failed: ${JSON.stringify(confirmation.value.err)}`);
    }
    return signature;
  } finally {
    settled = true;
    wake();
    await rebroadcast;
  }
}

// Wraps the pump SDK instructions in a versioned transaction: prepends the
// compute-budget ixs (dynamic priority fee), signs, then sends with active
// rebroadcast. Throws on a program-level failure so the caller's try/catch
// books it as a failed swap.
async function sendPumpTransaction(
  connection: Connection,
  wallet: Keypair,
  instructions: TransactionInstruction[],
  cfg: Config
): Promise<string> {
  const priorityFee = await computePriorityMicrolamports(connection, cfg);
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash('confirmed');
  const message = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: PUMP_COMPUTE_UNIT_LIMIT }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }),
      ...instructions,
    ],
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign([wallet]);
  logger.debug(`pump tx priority fee: ${priorityFee} µLamports/CU`);

  return confirmWithRebroadcast(connection, tx.serialize(), {
    blockhash,
    lastValidBlockHeight,
  });
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

    const balance = await getWalletBalance(cfg);
    if (balance - amountSol < MIN_SOL_RESERVE) {
      return pumpFailure(
        amountSol,
        `insufficient balance: ${balance.toFixed(4)} SOL, need ${(amountSol + MIN_SOL_RESERVE).toFixed(4)}`
      );
    }

    const tokenProgram = await detectTokenProgram(connection, mintPk);
    const onlineSdk = new OnlinePumpSdk(connection);
    const sdk = new PumpSdk();

    const { global, feeConfig } = await fetchPumpConfig(onlineSdk);
    const { bondingCurveAccountInfo, bondingCurve, associatedUserAccountInfo } =
      await onlineSdk.fetchBuyState(mintPk, wallet.publicKey, tokenProgram);
    if (bondingCurve.complete) {
      return pumpFailure(amountSol, 'bonding curve already graduated');
    }

    // SOL budget -> the fee-aware token amount the buy should request.
    // mintSupply must be the real supply: getBuyTokenAmountFromSolAmount
    // silently discards the live bondingCurve and quotes against a fresh
    // launch-floor curve when mintSupply is null — so every buy would request
    // the same floor-priced token amount no matter how far the curve has run,
    // and the exact-out buy then overspends the SOL budget on a moved curve
    // (driving the Custom:6002 slippage reverts copy-buys keep hitting).
    const mintInfo = await getMint(connection, mintPk, undefined, tokenProgram);
    const quoteAmount = new BN(Math.floor(amountSol * LAMPORTS_PER_SOL));
    const amount = getBuyTokenAmountFromSolAmount({
      global,
      feeConfig,
      mintSupply: new BN(mintInfo.supply.toString()),
      bondingCurve,
      amount: quoteAmount,
    });
    if (amount.lten(0)) {
      return pumpFailure(amountSol, 'curve quote returned zero tokens');
    }

    // buyV2Instructions assembles the 27-account buy_v2 plus any
    // init_if_needed ATA-creates; slippage is a whole-percent number.
    const buyIxs = await sdk.buyV2Instructions({
      global,
      bondingCurveAccountInfo,
      bondingCurve,
      associatedUserAccountInfo,
      mint: mintPk,
      user: wallet.publicKey,
      amount,
      quoteAmount,
      slippage: slippagePercent(cfg),
      tokenProgram,
    });

    const signature = await sendPumpTransaction(connection, wallet, buyIxs, cfg);

    const tokensOut = Number(amount.toString()) / PUMP_TOKEN_BASE_UNITS;
    const pricePerToken = tokensOut > 0 ? amountSol / tokensOut : 0;
    const mc = await marketCapUsd(
      Number(mintInfo.supply) / 10 ** mintInfo.decimals,
      pricePerToken
    );
    logger.position(
      'BUY',
      tokenMint,
      `${amountSol} SOL -> ${tokensOut.toFixed(4)} tokens @ MC ${formatUsd(mc)} (${signature.slice(0, 8)}..., pump v2)`
    );
    return {
      success: true,
      txSignature: signature,
      amountIn: amountSol,
      amountOut: tokensOut,
      pricePerToken,
      simulated: false,
      marketCapUsd: mc,
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
    const wallet = getWallet(cfg);
    const mintPk = new PublicKey(tokenMint);
    const tokenProgram = await detectTokenProgram(connection, mintPk);
    const onlineSdk = new OnlinePumpSdk(connection);
    const sdk = new PumpSdk();

    let sellState: Awaited<ReturnType<OnlinePumpSdk['fetchSellState']>>;
    try {
      sellState = await onlineSdk.fetchSellState(mintPk, wallet.publicKey, tokenProgram);
    } catch (err) {
      // Curve account gone or an RPC blip — can't tell graduated from
      // transient, so try Jupiter: it routes graduated tokens and fails
      // cleanly for an active curve it can't price anyway.
      logger.debug(
        `pumpSellLive fetchSellState failed (${(err as Error).message}); trying Jupiter`
      );
      return jupiterSell(tokenMint, amountTokens, cfg);
    }
    const { bondingCurveAccountInfo, bondingCurve } = sellState;
    if (bondingCurve.complete) {
      logger.info(
        `bonding curve complete for ${tokenMint}; selling via PumpSwap (post-graduation)`
      );
      return pumpSwapSell(tokenMint, amountTokens, cfg);
    }

    const amount = new BN(Math.floor(amountTokens * PUMP_TOKEN_BASE_UNITS));
    if (amount.lten(0)) {
      return pumpSellFailure(amountTokens, 'amount too small');
    }

    const { global, feeConfig } = await fetchPumpConfig(onlineSdk);
    // Quote the expected SOL out so the SDK's slippage yields a real
    // min-output floor rather than zero.
    const mintInfo = await getMint(connection, mintPk, undefined, tokenProgram);
    const quoteAmount = getSellSolAmountFromTokenAmount({
      global,
      feeConfig,
      mintSupply: new BN(mintInfo.supply.toString()),
      bondingCurve,
      amount,
    });

    const sellIxs = await sdk.sellV2Instructions({
      global,
      bondingCurveAccountInfo,
      bondingCurve,
      mint: mintPk,
      user: wallet.publicKey,
      amount,
      quoteAmount,
      slippage: slippagePercent(cfg),
      tokenProgram,
    });

    const signature = await sendPumpTransaction(connection, wallet, sellIxs, cfg);

    // If that sell drained the position, the now-empty ATA still holds
    // ~0.002 SOL of rent — reclaim it. Best-effort and in its own tx so a
    // close failure can never undo the booked sell above.
    const userAta = getAssociatedTokenAddressSync(
      mintPk,
      wallet.publicKey,
      false,
      tokenProgram
    );
    await maybeCloseEmptyAta(connection, mintPk, userAta, tokenProgram, cfg);

    // Book the trade at the quoted SOL out — actual delivered may be a hair
    // higher than this conservative figure; good enough for PnL accounting.
    const solOut = Number(quoteAmount.toString()) / LAMPORTS_PER_SOL;
    const pricePerToken = amountTokens > 0 ? solOut / amountTokens : 0;
    const mc = await marketCapUsd(
      Number(mintInfo.supply) / 10 ** mintInfo.decimals,
      pricePerToken
    );
    logger.position(
      'SELL',
      tokenMint,
      `${amountTokens.toFixed(4)} tokens -> ${solOut.toFixed(6)} SOL @ MC ${formatUsd(mc)} (${signature.slice(0, 8)}..., pump v2)`
    );
    return {
      success: true,
      txSignature: signature,
      amountIn: amountTokens,
      amountOut: solOut,
      pricePerToken,
      simulated: false,
      marketCapUsd: mc,
    };
  } catch (err) {
    const message = (err as Error).message;
    logger.error(`pumpSellLive ${tokenMint}: ${message}`);
    return pumpSellFailure(amountTokens, message);
  }
}

// Sells a GRADUATED pump token on its PumpSwap AMM pool, the venue bonkbot
// uses. Jupiter's route for a freshly-graduated pump pool reverts with
// Custom:6024 (Overflow), trapping the sell; the pump AMM SDK sells cleanly.
async function pumpSwapSell(
  tokenMint: string,
  amountTokens: number,
  cfg: Config,
  currentPriceSol: number | null = null
): Promise<SwapResult> {
  if (cfg.simulate) return pumpSellSim(tokenMint, amountTokens, currentPriceSol);
  try {
    const connection = getConnection(cfg);
    const wallet = getWallet(cfg);
    const mintPk = new PublicKey(tokenMint);

    const online = new OnlinePumpAmmSdk(connection);
    const amm = new PumpAmmSdk();
    const poolKey = canonicalPumpPoolPda(mintPk);
    const state = await online.swapSolanaState(poolKey, wallet.publicKey);

    const base = new BN(Math.floor(amountTokens * 10 ** state.baseMintAccount.decimals));
    if (base.lten(0)) return pumpSellFailure(amountTokens, 'amount too small');

    // sellBaseInput: sell `base` tokens for SOL (quote), with slippage applied
    // to the min-output floor. slippage is a whole-percent number.
    const sellIxs = await amm.sellBaseInput(state, base, slippagePercent(cfg));
    const signature = await sendPumpTransaction(connection, wallet, sellIxs, cfg);

    // Reclaim rent from the now-empty token ATA (best-effort, own tx).
    const userAta = getAssociatedTokenAddressSync(
      mintPk,
      wallet.publicKey,
      false,
      state.baseTokenProgram
    );
    await maybeCloseEmptyAta(connection, mintPk, userAta, state.baseTokenProgram, cfg);

    // Estimate SOL out from pool reserves (constant product, minus a 1% buffer
    // for the pool/protocol fee) for PnL booking. The actual delivered SOL is
    // in the wallet regardless; this is only the recorded figure.
    const baseRes = Number(state.poolBaseAmount.toString());
    const quoteRes = Number(state.poolQuoteAmount.toString());
    const baseIn = Number(base.toString());
    const quoteOut =
      baseRes + baseIn > 0 ? quoteRes - (baseRes * quoteRes) / (baseRes + baseIn) : 0;
    const solOut = (Math.max(quoteOut, 0) / LAMPORTS_PER_SOL) * 0.99;
    const pricePerToken = amountTokens > 0 ? solOut / amountTokens : 0;
    const mc = await marketCapUsd(
      Number(state.baseMintAccount.supply) / 10 ** state.baseMintAccount.decimals,
      pricePerToken
    );

    logger.position(
      'SELL',
      tokenMint,
      `${amountTokens.toFixed(4)} tokens -> ${solOut.toFixed(6)} SOL @ MC ${formatUsd(mc)} (${signature.slice(0, 8)}..., pumpswap)`
    );
    return {
      success: true,
      txSignature: signature,
      amountIn: amountTokens,
      amountOut: solOut,
      pricePerToken,
      simulated: false,
      marketCapUsd: mc,
    };
  } catch (err) {
    const message = (err as Error).message;
    logger.error(`pumpSwapSell ${tokenMint}: ${message}`);
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

    const signature = await confirmWithRebroadcast(connection, tx.serialize(), {
      blockhash,
      lastValidBlockHeight,
    });
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
  // A graduated pump token MUST sell on PumpSwap: Jupiter's route for a freshly
  // graduated pump pool reverts with Custom:6024 (Overflow), which is what
  // trapped sells before this fix. pumpSellLive also falls back to PumpSwap if
  // the curve graduated between this read and the actual sell.
  const venue = await resolveVenue(tokenMint, cfg, getConnection(cfg));
  if (venue === 'curve') return pumpSell(tokenMint, amountTokens, cfg, currentPriceSol);
  if (venue === 'pumpswap') return pumpSwapSell(tokenMint, amountTokens, cfg, currentPriceSol);
  return jupiterSell(tokenMint, amountTokens, cfg);
}
