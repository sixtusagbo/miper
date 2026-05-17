import { EventEmitter } from 'events';
import {
  Connection,
  LAMPORTS_PER_SOL,
  ParsedTransactionWithMeta,
  PublicKey,
} from '@solana/web3.js';
import { logger } from './logger';
import { trimSeen } from './listener';

const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
// Quote assets — the side of a swap that is *not* the token of interest.
const QUOTE_MINTS = new Set([WSOL_MINT, USDC_MINT, USDT_MINT]);

// A buy or sell detected on a followed (leader) wallet.
export interface LeaderTrade {
  wallet: string;
  tokenMint: string;
  // Native SOL the wallet's balance moved by, absolute value. For a buy this
  // is roughly what the leader spent; a conviction-size proxy.
  solAmount: number;
  kind: 'buy' | 'sell';
  signature: string;
}

function short(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 4)}..${addr.slice(-4)}` : addr;
}

// Diff a wallet's balances within one parsed transaction to classify it as a
// token buy (token balance up, SOL down) or sell (token down, SOL up). DEX-
// agnostic — it reads balance deltas, not program instructions. Returns null
// for anything that isn't a clean single-token swap by this wallet.
export function extractLeaderTrade(
  tx: ParsedTransactionWithMeta | null,
  wallet: string,
  signature: string
): LeaderTrade | null {
  const meta = tx?.meta;
  if (!meta || meta.err) return null;
  const keys = tx.transaction.message.accountKeys;
  const idx = keys.findIndex((k) => k.pubkey.toBase58() === wallet);
  if (idx < 0) return null;
  // Native SOL delta of the wallet, in lamports. Negative = SOL spent.
  const solDeltaLamports = meta.postBalances[idx] - meta.preBalances[idx];

  // Net token-balance change for this wallet, per mint, excluding quote
  // assets (SOL/USDC/USDT) so only the memecoin side is considered.
  const amountByMint = new Map<string, number>();
  const fold = (bal: typeof meta.preTokenBalances, sign: number) => {
    for (const b of bal ?? []) {
      if (b.owner !== wallet || QUOTE_MINTS.has(b.mint)) continue;
      const ui = b.uiTokenAmount.uiAmount ?? 0;
      amountByMint.set(b.mint, (amountByMint.get(b.mint) ?? 0) + sign * ui);
    }
  };
  fold(meta.preTokenBalances, -1);
  fold(meta.postTokenBalances, +1);

  // The traded token is the non-quote mint with the largest absolute delta.
  let tokenMint = '';
  let bestDelta = 0;
  for (const [mint, delta] of amountByMint) {
    if (Math.abs(delta) > Math.abs(bestDelta)) {
      bestDelta = delta;
      tokenMint = mint;
    }
  }
  if (tokenMint === '' || bestDelta === 0) return null;

  const solAmount = Math.abs(solDeltaLamports) / LAMPORTS_PER_SOL;
  if (bestDelta > 0 && solDeltaLamports < 0) {
    return { wallet, tokenMint, solAmount, kind: 'buy', signature };
  }
  if (bestDelta < 0 && solDeltaLamports > 0) {
    return { wallet, tokenMint, solAmount, kind: 'sell', signature };
  }
  return null; // token and SOL moved the same way — not a clean swap
}

// Polls a curated set of leader wallets and emits their token buys and sells.
// The first poll of each wallet only establishes a baseline signature — we
// never copy trades that happened before the bot started.
//
// Emits: 'leaderBuy' / 'leaderSell' (trade: LeaderTrade)
export class WalletListener extends EventEmitter {
  private readonly state = new Map<string, { lastSignature: string | null; primed: boolean }>();
  private readonly seen = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private polling = false;

  constructor(
    private readonly connection: Connection,
    private readonly wallets: string[],
    private readonly pollMs: number,
    private readonly minLeaderSol: number
  ) {
    super();
    for (const w of wallets) this.state.set(w, { lastSignature: null, primed: false });
  }

  start(): void {
    if (this.timer) return;
    if (this.wallets.length === 0) {
      logger.warn('copytrade: no wallets configured (COPYTRADE_WALLETS) — nothing to follow');
      return;
    }
    logger.info(
      `copytrade: following ${this.wallets.length} wallet(s), polling every ${(this.pollMs / 1000).toFixed(0)}s`
    );
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.pollMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // One poll cycle across every followed wallet. A per-wallet failure is
  // swallowed so one bad wallet never stalls the rest. Guarded so a slow
  // cycle can't overlap the next interval tick.
  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const wallet of this.wallets) {
        await this.pollWallet(wallet).catch((err) =>
          logger.debug(`copytrade: poll failed for ${short(wallet)}: ${(err as Error).message}`)
        );
      }
    } finally {
      this.polling = false;
    }
  }

  private async pollWallet(wallet: string): Promise<void> {
    const st = this.state.get(wallet);
    if (!st) return;
    const sigs = await this.connection.getSignaturesForAddress(new PublicKey(wallet), {
      limit: 25,
      until: st.lastSignature ?? undefined,
    });
    if (sigs.length === 0) return;
    st.lastSignature = sigs[0].signature;
    // First poll just fixes the baseline — don't copy pre-startup history.
    if (!st.primed) {
      st.primed = true;
      return;
    }

    // Oldest-first so trades surface in the order the leader made them.
    for (const s of [...sigs].reverse()) {
      if (s.err || this.seen.has(s.signature)) continue;
      this.seen.add(s.signature);
      trimSeen(this.seen);
      const tx = await this.connection.getParsedTransaction(s.signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });
      const trade = extractLeaderTrade(tx, wallet, s.signature);
      if (!trade) continue;
      if (trade.kind === 'buy') {
        if (trade.solAmount < this.minLeaderSol) {
          logger.debug(
            `copytrade: ${short(wallet)} bought ${short(trade.tokenMint)} for ` +
              `${trade.solAmount.toFixed(2)} SOL — below ${this.minLeaderSol}, skipped`
          );
          continue;
        }
        logger.info(
          `copytrade: leader ${short(wallet)} BOUGHT ${trade.tokenMint} (~${trade.solAmount.toFixed(2)} SOL)`
        );
        this.emit('leaderBuy', trade);
      } else {
        logger.info(`copytrade: leader ${short(wallet)} SOLD ${trade.tokenMint}`);
        this.emit('leaderSell', trade);
      }
    }
  }
}
