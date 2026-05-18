import { EventEmitter } from 'events';
import { Connection, PublicKey } from '@solana/web3.js';
import { logger } from './logger';
import { Config } from './config';
import { NewPool } from './listener';
import { decodeBondingCurve, bondingCurvePriceSol } from './bondingCurve';
import { runSafetyChecks, PUMP_INITIAL_PRICE_SOL } from './analyzer';

export interface TractionConfig {
  // How long to observe a launch before assessing it.
  windowMs: number;
  // How often the sweep checks for launches whose window has elapsed.
  sampleMs: number;
  // Minimum distinct token holders for the launch to count as having drawn
  // real organic traction.
  minBuyers: number;
  // Maximum price (as a multiple of the launch floor) at which we'll still
  // buy — the landability gate. A launch that has already run past this is a
  // miss, not a chase (chasing a moved price is the momentum 6002 trap).
  maxEntryMult: number;
  // Veto a launch whose single largest holder exceeds this percent of supply.
  maxClusterPct: number;
  // Cap on the concurrent observation watchlist.
  watchCap: number;
}

interface WatchEntry {
  pool: NewPool;
  addedAt: number;
}

// Launch-snipe v2 — early-traction entry. Buying at t=0 picks at the base
// rate: a runner and a dud are indistinguishable at launch. So we DON'T buy
// at t=0 — we watch each launch for an observation window, then buy only the
// ones that drew real traction (enough distinct holders) while the price is
// still near the floor (a buy that will land). Buy the calm with traction —
// not the t=0 lottery, not the momentum climb.
//
// Emits: 'entry' (pool: NewPool, holders: number) when a launch clears every
// gate after its observation window.
export class TractionWatcher extends EventEmitter {
  private readonly watching = new Map<string, WatchEntry>();
  private timer: NodeJS.Timeout | null = null;
  private sweeping = false;

  constructor(
    private readonly connection: Connection,
    private readonly cfg: TractionConfig,
    private readonly appConfig: Config
  ) {
    super();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.sweep(), this.cfg.sampleMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.watching.clear();
  }

  get watchlistSize(): number {
    return this.watching.size;
  }

  // Begin observing a freshly-detected launch. We do NOT buy now — the whole
  // point of v2 is to wait out the observation window first.
  add(pool: NewPool): void {
    if (this.watching.has(pool.tokenMint)) return;
    if (this.watching.size >= this.cfg.watchCap) {
      logger.debug(
        `traction: watchlist full (${this.cfg.watchCap}), skipping ${pool.tokenMint}`
      );
      return;
    }
    this.watching.set(pool.tokenMint, { pool, addedAt: Date.now() });
    logger.debug(
      `traction: watching ${pool.tokenMint} (${this.watching.size}/${this.cfg.watchCap})`
    );
  }

  // Each tick: assess every launch whose observation window has elapsed.
  // Guarded so a slow sweep can't overlap the next tick.
  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const now = Date.now();
      for (const [mint, entry] of [...this.watching]) {
        if (now - entry.addedAt < this.cfg.windowMs) continue; // still observing
        this.watching.delete(mint);
        await this.assess(entry.pool).catch((err) =>
          logger.debug(`traction: assess failed for ${mint}: ${(err as Error).message}`)
        );
      }
    } finally {
      this.sweeping = false;
    }
  }

  // The observation window elapsed — read the launch's price, mayhem flag,
  // traction (holder count) and safety; emit 'entry' only if every gate
  // passes. A launch that ran past the landable price, or never drew enough
  // holders, is logged as a clear miss.
  private async assess(pool: NewPool): Promise<void> {
    const mint = pool.tokenMint;

    const info = await this.connection.getAccountInfo(new PublicKey(pool.poolAddress));
    if (!info?.data) {
      logger.debug(`traction: ${mint} curve unreadable — dropped`);
      return;
    }
    const state = decodeBondingCurve(Buffer.from(info.data));
    if (state.complete) {
      logger.info(`entry missed: ${mint} graduated during the watch window`);
      return;
    }
    if (state.isMayhemMode) {
      logger.info(`skipping ${mint}: mayhem-mode coin (unsellable-trap risk)`);
      return;
    }
    const price = bondingCurvePriceSol(state);
    if (price === null) {
      logger.debug(`traction: ${mint} unpriceable — dropped`);
      return;
    }
    const mult = price / PUMP_INITIAL_PRICE_SOL;
    if (mult > this.cfg.maxEntryMult) {
      logger.info(
        `entry missed: ${mint} ran to ${mult.toFixed(1)}x the floor — past the landable cap`
      );
      return;
    }

    const safety = await runSafetyChecks(this.connection, mint, null, this.appConfig);
    if (!safety.passed) {
      logger.info(`skipping ${mint}: safety — ${safety.failures.join('; ')}`);
      return;
    }
    if (safety.holderCount < this.cfg.minBuyers) {
      logger.info(
        `entry missed: ${mint} — only ${safety.holderCount} holders, no traction (want >=${this.cfg.minBuyers})`
      );
      return;
    }
    if (safety.topHolderPct > this.cfg.maxClusterPct) {
      logger.info(
        `skipping ${mint}: top holder ${safety.topHolderPct.toFixed(0)}% > ${this.cfg.maxClusterPct}% — too concentrated`
      );
      return;
    }

    logger.info(
      `traction entry: ${mint} — ${safety.holderCount} holders, ${mult.toFixed(2)}x floor, top holder ${safety.topHolderPct.toFixed(0)}%`
    );
    this.emit('entry', pool, safety.holderCount);
  }
}
