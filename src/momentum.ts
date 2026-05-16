import { EventEmitter } from 'events';
import { Connection } from '@solana/web3.js';
import { logger } from './logger';
import { NewPool } from './listener';
import { readBondingCurve } from './bondingCurve';

export interface MomentumConfig {
  // How long to watch a token before giving up on it.
  windowMs: number;
  // How often to re-price every watched token.
  sampleMs: number;
  // Buy when price climbs into [entryMultMin, entryMultMax]x its baseline:
  // the lower bound is proof of real demand, the upper bound stops us
  // chasing a token that already went parabolic.
  entryMultMin: number;
  entryMultMax: number;
  // Cap on the concurrent watchlist — bounds the RPC cost of sampling.
  watchCap: number;
}

interface WatchEntry {
  pool: NewPool;
  baselinePriceSol: number;
  addedAt: number;
}

// Watches freshly-detected pump.fun launches and emits 'entry' for the ones
// that show real upward momentum in their first minutes. This replaces the
// launch snipe: buy demonstrated demand, not predicted potential.
//
// Emits: 'entry' (pool: NewPool, multiple: number) when a watched token's
// price enters the configured band. The caller runs safety checks and buys.
export class MomentumWatcher extends EventEmitter {
  private readonly watching = new Map<string, WatchEntry>();
  private timer: NodeJS.Timeout | null = null;
  private sweeping = false;

  constructor(
    private readonly connection: Connection,
    private readonly cfg: MomentumConfig
  ) {
    super();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.sweep();
    }, this.cfg.sampleMs);
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

  // Begin watching a freshly-detected token. Reads its bonding curve once to
  // fix the baseline price; skips tokens already watched, a full watchlist,
  // and tokens whose curve can't be priced.
  async add(pool: NewPool): Promise<void> {
    if (this.watching.has(pool.tokenMint)) return;
    if (this.watching.size >= this.cfg.watchCap) {
      logger.debug(
        `momentum: watchlist full (${this.cfg.watchCap}), skipping ${pool.tokenMint}`
      );
      return;
    }
    const reading = await readBondingCurve(this.connection, pool.poolAddress);
    if (reading.kind !== 'price') {
      logger.debug(`momentum: cannot baseline ${pool.tokenMint} (${reading.kind})`);
      return;
    }
    this.watching.set(pool.tokenMint, {
      pool,
      baselinePriceSol: reading.priceSol,
      addedAt: Date.now(),
    });
    logger.debug(
      `momentum: watching ${pool.tokenMint} (${this.watching.size}/${this.cfg.watchCap})`
    );
  }

  // Re-price every watched token: emit 'entry' for ones inside the band, drop
  // ones that expired the window or ran clean past it. Guarded so a slow
  // sweep can never overlap the next interval tick.
  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const now = Date.now();
      for (const [mint, entry] of [...this.watching]) {
        if (now - entry.addedAt >= this.cfg.windowMs) {
          this.watching.delete(mint);
          logger.debug(`momentum: ${mint} expired the watch window — dropped`);
          continue;
        }
        const reading = await readBondingCurve(this.connection, entry.pool.poolAddress);
        if (reading.kind === 'graduated') {
          // Ran hard enough to graduate — well past our band; let it go.
          this.watching.delete(mint);
          logger.debug(`momentum: ${mint} graduated mid-watch — dropped`);
          continue;
        }
        if (reading.kind !== 'price') continue; // transient — retry next sweep
        const mult = reading.priceSol / entry.baselinePriceSol;
        if (mult >= this.cfg.entryMultMin && mult <= this.cfg.entryMultMax) {
          this.watching.delete(mint);
          const ageSec = ((now - entry.addedAt) / 1000).toFixed(0);
          logger.info(
            `momentum entry: ${mint} +${((mult - 1) * 100).toFixed(0)}% in ${ageSec}s`
          );
          this.emit('entry', entry.pool, mult);
        } else if (mult > this.cfg.entryMultMax) {
          this.watching.delete(mint);
          logger.debug(
            `momentum: ${mint} ran past the band (${mult.toFixed(1)}x) — not chasing`
          );
        }
        // mult < entryMultMin — keep watching until the window expires.
      }
    } finally {
      this.sweeping = false;
    }
  }
}
