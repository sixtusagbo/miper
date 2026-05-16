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
  // Ignore a band-crossing sooner than this after the token was first seen —
  // a move that fast is an un-catchable spike, not a climb we can ride.
  minAgeMs: number;
  // Cap on the concurrent watchlist — bounds the RPC cost of sampling.
  watchCap: number;
}

// Runs the buy/no-buy gates (bundle + safety) for a token. Supplied by the
// caller and kicked off when watching begins, so the result is ready by the
// time the token triggers and the entry path is just a buy. Resolves true
// when cleared to buy, false when rejected (the prescreen logs/records why).
export type Prescreen = (pool: NewPool) => Promise<boolean>;

interface WatchEntry {
  pool: NewPool;
  baselinePriceSol: number;
  addedAt: number;
  // Pre-screen result, computed during the watch. Undefined when no
  // prescreen was supplied.
  screen?: Promise<boolean>;
}

// Watches freshly-detected pump.fun launches and emits 'entry' for the ones
// that show real upward momentum in their first minutes. This replaces the
// launch snipe: buy demonstrated demand, not predicted potential.
//
// Emits: 'entry' (pool: NewPool, multiple: number) when a watched token's
// price enters the band after minAgeMs and clears its pre-screen.
export class MomentumWatcher extends EventEmitter {
  private readonly watching = new Map<string, WatchEntry>();
  private timer: NodeJS.Timeout | null = null;
  private sweeping = false;

  constructor(
    private readonly connection: Connection,
    private readonly cfg: MomentumConfig,
    private readonly prescreen?: Prescreen
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
  // fix the baseline price and kicks off the pre-screen; skips tokens already
  // watched, a full watchlist, and tokens whose curve can't be priced.
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
    let screen: Promise<boolean> | undefined;
    if (this.prescreen) {
      screen = this.prescreen(pool);
      // Drop a token as soon as its pre-screen fails — no point sampling a
      // bundled or unsafe token, and it frees a watchlist slot.
      screen
        .then((cleared) => {
          if (!cleared) this.watching.delete(pool.tokenMint);
        })
        .catch(() => this.watching.delete(pool.tokenMint));
    }
    this.watching.set(pool.tokenMint, {
      pool,
      baselinePriceSol: reading.priceSol,
      addedAt: Date.now(),
      screen,
    });
    logger.debug(
      `momentum: watching ${pool.tokenMint} (${this.watching.size}/${this.cfg.watchCap})`
    );
  }

  // Re-price every watched token: emit 'entry' for ones inside the band that
  // are old enough and cleared their pre-screen; drop ones that expired the
  // window, ran clean past the band, or hit the band too fast to catch.
  // Guarded so a slow sweep can never overlap the next interval tick.
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
          this.watching.delete(mint);
          logger.debug(`momentum: ${mint} graduated mid-watch — dropped`);
          continue;
        }
        if (reading.kind !== 'price') continue; // transient — retry next sweep
        const mult = reading.priceSol / entry.baselinePriceSol;
        if (mult > this.cfg.entryMultMax) {
          this.watching.delete(mint);
          logger.debug(
            `momentum: ${mint} ran past the band (${mult.toFixed(1)}x) — not chasing`
          );
          continue;
        }
        if (mult < this.cfg.entryMultMin) continue; // still below — keep watching

        // In the band. Skip it if the move was too fast to catch.
        const age = now - entry.addedAt;
        if (age < this.cfg.minAgeMs) {
          this.watching.delete(mint);
          logger.debug(
            `momentum: ${mint} hit the band in ${(age / 1000).toFixed(0)}s — too fast, dropped`
          );
          continue;
        }
        this.watching.delete(mint);
        // The pre-screen (bundle + safety) ran during the watch; honour it.
        // A screen error fails closed — don't buy what we couldn't verify.
        if (entry.screen) {
          let cleared = false;
          try {
            cleared = await entry.screen;
          } catch (err) {
            logger.debug(
              `momentum: pre-screen errored for ${mint}: ${(err as Error).message}`
            );
          }
          if (!cleared) {
            logger.debug(`momentum: ${mint} failed pre-screen — not buying`);
            continue;
          }
        }
        logger.info(
          `momentum entry: ${mint} +${((mult - 1) * 100).toFixed(0)}% in ${(age / 1000).toFixed(0)}s`
        );
        this.emit('entry', entry.pool, mult);
      }
    } finally {
      this.sweeping = false;
    }
  }
}
