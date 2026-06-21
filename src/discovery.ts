import { EventEmitter } from 'events';
import { Connection, PublicKey } from '@solana/web3.js';
import { logger } from './logger';
import { NewPool } from './listener';
import { decodeBondingCurve, PUMP_TOKEN_BASE_UNITS } from './bondingCurve';
import { getSolUsdPrice } from './analyzer';
import { fetchCreatorHistory } from './creatorHistory';
import { fetchTokenMetadata, TokenMetadata } from './metadata';
import { checkLaunchBundle } from './bundleCheck';
import { extractLeaderTrade } from './walletListener';
import { extractIncomingTransfer } from './walletResearch';
import {
  DiscoveryFeatures,
  DiscoveryProfile,
  DiscoveryScore,
  scoreDiscovery,
} from './discoveryScore';
import {
  bumpWalletIntel,
  getWalletIntel,
  recordDiscoveryAlert,
  recordRejection,
  setDiscoveryAlertOutcome,
  WalletIntelRow,
} from './db';

const SOL_LAMPORTS = 1_000_000_000;
const PUMP_SUPPLY = 1_000_000_000;
// A post-alert run to this multiple counts as a win in the intel table —
// matches the bot's own 2x first take-profit tier.
const WIN_MULT = 2;
// New curve signatures fetched per sample. More than this lands in one
// 20s window only on tokens already too hot for our entry anyway.
const SIG_FETCH_LIMIT = 100;
// Buyer-diversity needs a minimum parsed sample before it means anything.
const MIN_DIVERSITY_SAMPLE = 5;

export interface DiscoveryConfig {
  windowMs: number;
  sampleMs: number;
  watchCap: number;
  parsePerSample: number;
  // Txs parsed in the LAUNCH window (the first sample of a token), where the
  // research showed the cluster's same-slot entries land. These are the OLDEST
  // signatures after the create, not the newest — so this budget is spent
  // where the dominant smart-wallet signal actually is.
  launchParse: number;
  alertScore: number;
  buyScore: number;
  bundleThreshold: number;
  minDevBuySol: number;
}

// Everything an alert (Telegram + DB row) needs about a scored token.
export interface DiscoveryAlert {
  pool: NewPool;
  symbol: string | null;
  score: number;
  reasons: string[];
  mcapUsd: number | null;
  liquiditySol: number | null;
  ageSec: number;
  // Sampled lower bound (we parse a sample of curve txs, not a census).
  holderCount: number;
  smartWalletBuys: number;
  creator: string | null;
  funder: string | null;
  priceSol: number | null;
}

// Reputation rule over the compounding intel table: an address is 'good'
// after >=2 post-alert winners, 'bad' after >=3 launches with zero winners
// and zero alerts (a serial launcher whose tokens never even chart).
export function intelReputation(row: WalletIntelRow | null): 'good' | 'bad' | null {
  if (!row) return null;
  if (row.wins >= 2) return 'good';
  if (row.launches >= 3 && row.wins === 0 && row.alerted === 0) return 'bad';
  return null;
}

interface T0Intel {
  metadata: TokenMetadata | null;
  creatorPriorTxs: number | null;
  creatorAgeDays: number | null;
  creatorSaturated: boolean;
  funder: string | null;
  creatorIntel: 'good' | 'bad' | null;
  funderIntel: 'good' | 'bad' | null;
  bundled: boolean;
  launchSlotBuyers: number;
}

interface WatchEntry {
  pool: NewPool;
  addedAt: number;
  expiresAt: number;
  intel: T0Intel;
  intelReady: Promise<void>;
  // Signature cursor on the bonding curve; everything newer is "new flow".
  lastSig: string;
  // False until the launch-window sample has run. The first sample parses the
  // OLDEST signatures (launch-slot buyers, where same-slot smart money lands);
  // every sample after parses the newest (recent-flow velocity).
  launchSampled: boolean;
  totalSigsSeen: number;
  parsedTxs: number;
  uniquePayers: Set<string>;
  uniqueBuyers: Set<string>;
  smartHits: Set<string>;
  devSold: boolean;
  // Last curve reading.
  priceSol: number | null;
  liquiditySol: number | null;
  alerted: boolean;
  alertId: number | null;
  alertPriceSol: number | null;
  peakPriceSol: number;
  candidateEmitted: boolean;
  graduated: boolean;
}

// Watches fresh pump.fun launches, extracts the features the wallet research
// measured, scores them with the shared scorer, and emits:
//   'alert'     (alert: DiscoveryAlert)            score >= alertScore, once
//   'candidate' (pool: NewPool, alert: DiscoveryAlert)  score >= buyScore, once
// The caller decides whether 'candidate' becomes a buy (DISCOVERY_AUTOBUY).
export class DiscoveryScanner extends EventEmitter {
  private readonly watching = new Map<string, WatchEntry>();
  private readonly seen = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private sweeping = false;
  // Funder lookups are the most expensive t0 read; serial deployers repeat,
  // so cache per creator for the run.
  private readonly funderCache = new Map<string, string | null>();

  constructor(
    private readonly connection: Connection,
    private readonly cfg: DiscoveryConfig,
    private readonly profile: DiscoveryProfile,
    private readonly smartWallets: Set<string>
  ) {
    super();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.sweep();
    }, this.cfg.sampleMs);
    logger.info(
      `discovery: scoring launches against profile (alert>=${this.cfg.alertScore}, buy>=${this.cfg.buyScore}, ` +
        `${this.smartWallets.size} smart wallets tracked, watch cap ${this.cfg.watchCap})`
    );
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

  // Begin watching a fresh launch. The t0 intel (creator history, funder,
  // metadata, bundle check) is kicked off here and lands while sampling runs.
  add(pool: NewPool): void {
    if (this.watching.has(pool.tokenMint) || this.seen.has(pool.tokenMint)) return;
    if (this.watching.size >= this.cfg.watchCap) {
      logger.debug(`discovery: watchlist full (${this.cfg.watchCap}), skipping ${pool.tokenMint}`);
      return;
    }
    if (this.cfg.minDevBuySol > 0 && pool.initialLiquiditySol < this.cfg.minDevBuySol) {
      logger.debug(
        `discovery: ${pool.tokenMint} dev buy ${pool.initialLiquiditySol.toFixed(2)} SOL below intake floor — skipped`
      );
      return;
    }
    this.seen.add(pool.tokenMint);
    if (this.seen.size > 20_000) this.seen.clear(); // bounded; replays are rare

    const intel: T0Intel = {
      metadata: null,
      creatorPriorTxs: null,
      creatorAgeDays: null,
      creatorSaturated: false,
      funder: null,
      creatorIntel: null,
      funderIntel: null,
      bundled: false,
      launchSlotBuyers: 0,
    };
    const now = Date.now();
    const entry: WatchEntry = {
      pool,
      addedAt: now,
      expiresAt: now + this.cfg.windowMs,
      intel,
      intelReady: this.collectT0Intel(pool, intel),
      lastSig: pool.txSignature,
      launchSampled: false,
      totalSigsSeen: 0,
      parsedTxs: 0,
      uniquePayers: new Set(),
      uniqueBuyers: new Set(),
      smartHits: new Set(),
      devSold: false,
      priceSol: null,
      liquiditySol: null,
      alerted: false,
      alertId: null,
      alertPriceSol: null,
      peakPriceSol: 0,
      candidateEmitted: false,
      graduated: false,
    };
    this.watching.set(pool.tokenMint, entry);
    logger.debug(`discovery: watching ${pool.tokenMint} (${this.watching.size}/${this.cfg.watchCap})`);
  }

  // One-shot launch intel, all best-effort: any individual failure leaves
  // that field null/false and the token keeps being scored on what we have.
  private async collectT0Intel(pool: NewPool, intel: T0Intel): Promise<void> {
    const tasks: Promise<void>[] = [];
    tasks.push(
      fetchTokenMetadata(this.connection, pool.tokenMint)
        .then((md) => {
          intel.metadata = md;
        })
        .catch(() => undefined)
    );
    if (pool.creator) {
      const creator = pool.creator;
      tasks.push(
        fetchCreatorHistory(this.connection, creator)
          .then((h) => {
            intel.creatorPriorTxs = h.totalRecentTxs;
            intel.creatorAgeDays = h.oldestActivityDaysAgo;
            intel.creatorSaturated = h.txCountSaturated;
          })
          .catch(() => undefined)
      );
      tasks.push(
        this.lookupFunder(creator)
          .then((funder) => {
            intel.funder = funder;
            if (funder) intel.funderIntel = intelReputation(getWalletIntel(funder));
          })
          .catch(() => undefined)
      );
      intel.creatorIntel = intelReputation(getWalletIntel(creator));
    }
    if (this.cfg.bundleThreshold > 0) {
      tasks.push(
        checkLaunchBundle(
          this.connection,
          pool.txSignature,
          pool.poolAddress,
          this.cfg.bundleThreshold
        )
          .then((b) => {
            intel.bundled = b.bundled;
            intel.launchSlotBuyers = b.launchSlotBuyers;
          })
          .catch(() => undefined)
      );
    }
    await Promise.all(tasks);
  }

  // Funding source of a (fresh) creator wallet: page its history once; if it
  // fits in one page, the oldest txs are its first activity — parse them for
  // the incoming transfer. Saturated wallets return null (unknowable cheaply).
  private async lookupFunder(creator: string): Promise<string | null> {
    if (this.funderCache.has(creator)) return this.funderCache.get(creator) ?? null;
    let funder: string | null = null;
    try {
      const sigs = await this.connection.getSignaturesForAddress(new PublicKey(creator), {
        limit: 1000,
      });
      if (sigs.length > 0 && sigs.length < 1000) {
        for (const s of sigs.slice(-3).reverse()) {
          if (s.err) continue;
          const tx = await this.connection.getParsedTransaction(s.signature, {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed',
          });
          if (!tx) continue;
          const incoming = extractIncomingTransfer(tx, creator);
          if (incoming) {
            funder = incoming.from;
            break;
          }
        }
      }
    } catch (err) {
      logger.debug(`discovery: funder lookup ${creator.slice(0, 8)}: ${(err as Error).message}`);
    }
    this.funderCache.set(creator, funder);
    if (this.funderCache.size > 5_000) this.funderCache.clear();
    return funder;
  }

  // Re-sample every watched token: curve state, new tx flow, buyer sample —
  // then score. Sequential per token so a full watchlist spreads its RPC
  // calls across the interval instead of bursting. Guarded against overlap.
  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const now = Date.now();
      for (const [mint, entry] of [...this.watching]) {
        if (now >= entry.expiresAt) {
          this.finalize(mint, entry, entry.graduated ? 'graduated' : 'window expired');
          continue;
        }
        try {
          await this.sampleToken(mint, entry);
        } catch (err) {
          logger.debug(`discovery: sample failed for ${mint}: ${(err as Error).message}`);
        }
      }
    } finally {
      this.sweeping = false;
    }
  }

  private async sampleToken(mint: string, entry: WatchEntry): Promise<void> {
    // Curve state: price, real SOL liquidity, mayhem, graduation.
    let mayhem = false;
    const info = await this.connection.getAccountInfo(new PublicKey(entry.pool.poolAddress));
    if (info?.data) {
      try {
        const state = decodeBondingCurve(Buffer.from(info.data));
        mayhem = state.isMayhemMode;
        if (state.complete) {
          // Graduation inside the watch window is the strongest possible
          // outcome — record it and stop sampling.
          entry.graduated = true;
          if (entry.alertPriceSol && entry.priceSol) {
            entry.peakPriceSol = Math.max(entry.peakPriceSol, entry.priceSol);
          }
          this.finalize(mint, entry, 'graduated');
          return;
        }
        if (state.virtualTokenReserves > 0n) {
          entry.priceSol =
            Number(state.virtualSolReserves) /
            SOL_LAMPORTS /
            (Number(state.virtualTokenReserves) / PUMP_TOKEN_BASE_UNITS);
        }
        entry.liquiditySol = Number(state.realSolReserves) / SOL_LAMPORTS;
      } catch (err) {
        logger.debug(`discovery: curve decode ${mint}: ${(err as Error).message}`);
      }
    }
    if (entry.priceSol !== null) {
      entry.peakPriceSol = Math.max(entry.peakPriceSol, entry.priceSol);
    }

    // New transaction flow since the last sample. The signature count is an
    // exact velocity (reverts included — sniper spam is also heat); buyer
    // identity comes from parsing a bounded sample of them.
    const sigs = await this.connection.getSignaturesForAddress(
      new PublicKey(entry.pool.poolAddress),
      { until: entry.lastSig, limit: SIG_FETCH_LIMIT }
    );
    if (sigs.length > 0) {
      entry.lastSig = sigs[0].signature;
      entry.totalSigsSeen += sigs.length;
      // getSignaturesForAddress returns newest-first. The cluster's same-slot
      // entries are the OLDEST signatures after the create, so the launch
      // window (first sample) parses the tail (oldest) with the launch budget;
      // steady-state samples parse the head (newest) for recent-flow velocity.
      const ok = sigs.filter((s) => !s.err);
      const toParse = entry.launchSampled
        ? ok.slice(0, this.cfg.parsePerSample)
        : ok.slice(-this.cfg.launchParse).reverse();
      entry.launchSampled = true;
      for (const s of toParse) {
        const tx = await this.connection
          .getParsedTransaction(s.signature, {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed',
          })
          .catch(() => null);
        if (!tx) continue;
        entry.parsedTxs++;
        const payer = tx.transaction.message.accountKeys
          .find((k) => k.signer)
          ?.pubkey.toBase58();
        if (!payer) continue;
        entry.uniquePayers.add(payer);
        const trade = extractLeaderTrade(tx, payer, s.signature);
        if (!trade || trade.tokenMint !== mint) continue;
        if (trade.kind === 'buy') {
          entry.uniqueBuyers.add(payer);
          if (this.smartWallets.has(payer) && !entry.smartHits.has(payer)) {
            entry.smartHits.add(payer);
            logger.info(
              `discovery: smart wallet ${payer.slice(0, 4)}..${payer.slice(-4)} bought ${mint}`
            );
          }
        } else if (payer === entry.pool.creator) {
          entry.devSold = true;
        }
      }
    }

    const features = await this.buildFeatures(entry, mayhem);
    const result = scoreDiscovery(features, this.profile);

    if (result.vetoed) {
      logger.info(`discovery: ${mint} vetoed — ${result.reasons.join('; ')}`);
      recordRejection({
        tokenMint: mint,
        reason: `discovery veto: ${result.reasons.join('; ')}`,
        aiScore: null,
        poolAddress: entry.pool.poolAddress,
      });
      this.finalize(mint, entry, 'vetoed');
      return;
    }

    if (!entry.alerted && result.score >= this.cfg.alertScore) {
      entry.alerted = true;
      entry.alertPriceSol = entry.priceSol;
      // Give an alerted token a longer outcome window so peak_mult means
      // something — alerts are rare, so the extra sampling is cheap.
      entry.expiresAt = entry.addedAt + 2 * this.cfg.windowMs;
      const alert = this.toAlert(entry, features, result);
      entry.alertId = recordDiscoveryAlert({
        tokenMint: mint,
        symbol: alert.symbol,
        score: alert.score,
        reasons: alert.reasons,
        mcapUsd: alert.mcapUsd,
        liquiditySol: alert.liquiditySol,
        ageSec: alert.ageSec,
        holderCount: alert.holderCount,
        smartWalletBuys: alert.smartWalletBuys,
        creator: alert.creator,
        funder: alert.funder,
        alertPriceSol: alert.priceSol,
      });
      logger.trade(
        `DISCOVERY ALERT ${mint} score ${alert.score} — ${alert.reasons.join('; ')}`
      );
      this.emit('alert', alert);
    }

    if (entry.alerted && !entry.candidateEmitted && result.score >= this.cfg.buyScore) {
      entry.candidateEmitted = true;
      this.emit('candidate', entry.pool, this.toAlert(entry, features, result));
    }
  }

  private async buildFeatures(entry: WatchEntry, mayhem: boolean): Promise<DiscoveryFeatures> {
    const ageSec = Math.max(1, (Date.now() - entry.addedAt) / 1000);
    const ageMin = ageSec / 60;
    const solUsd = await getSolUsdPrice().catch(() => null);
    const mcapUsd =
      entry.priceSol !== null && solUsd !== null
        ? entry.priceSol * PUMP_SUPPLY * solUsd
        : null;
    const txPerMin = entry.totalSigsSeen / ageMin;
    const buyerDiversity =
      entry.parsedTxs >= MIN_DIVERSITY_SAMPLE
        ? entry.uniquePayers.size / entry.parsedTxs
        : null;
    // Estimated distinct-buyer arrival rate: exact tx velocity scaled by the
    // sampled uniqueness ratio. Honest about being an estimate — the raw
    // sampled buyer count goes in the alert as a ">=" figure.
    const buyersPerMin = buyerDiversity !== null ? buyerDiversity * txPerMin : null;
    const i = entry.intel;
    return {
      tokenMint: entry.pool.tokenMint,
      platform: 'pump',
      ageSec,
      mcapUsd,
      liquiditySol: entry.liquiditySol,
      devBuySol: entry.pool.initialLiquiditySol,
      uniqueBuyers: entry.uniqueBuyers.size,
      buyersPerMin,
      txPerMin,
      buyerDiversity,
      smartWalletBuys: entry.smartHits.size,
      bundledLaunch: i.bundled,
      launchSlotBuyers: i.launchSlotBuyers,
      mayhem,
      creator: entry.pool.creator,
      creatorPriorTxs: i.creatorPriorTxs,
      creatorAgeDays: i.creatorAgeDays,
      creatorSaturated: i.creatorSaturated,
      funder: i.funder,
      creatorIntel: i.creatorIntel,
      funderIntel: i.funderIntel,
      hasMetadata:
        !!i.metadata && i.metadata.name !== '' && i.metadata.symbol !== '' && i.metadata.uri !== '',
      devSold: entry.devSold,
    };
  }

  private toAlert(
    entry: WatchEntry,
    features: DiscoveryFeatures,
    result: DiscoveryScore
  ): DiscoveryAlert {
    return {
      pool: entry.pool,
      symbol: entry.intel.metadata?.symbol || null,
      score: result.score,
      reasons: result.reasons,
      mcapUsd: features.mcapUsd,
      liquiditySol: features.liquiditySol,
      ageSec: features.ageSec ?? 0,
      holderCount: entry.uniqueBuyers.size,
      smartWalletBuys: entry.smartHits.size,
      creator: entry.pool.creator,
      funder: entry.intel.funder,
      priceSol: entry.priceSol,
    };
  }

  // Retire a token from the watchlist: write the alert outcome and compound
  // the deployer/funder intel. Every launch teaches the intel table
  // something, alerted or not.
  private finalize(mint: string, entry: WatchEntry, why: string): void {
    this.watching.delete(mint);
    const peakMult =
      entry.alerted && entry.alertPriceSol && entry.alertPriceSol > 0
        ? entry.peakPriceSol / entry.alertPriceSol
        : null;
    const win = entry.graduated || (peakMult !== null && peakMult >= WIN_MULT);
    try {
      if (entry.alertId !== null && peakMult !== null) {
        setDiscoveryAlertOutcome(
          entry.alertId,
          peakMult,
          entry.graduated ? 'graduated' : peakMult >= WIN_MULT ? 'win' : 'flat'
        );
      }
      if (entry.pool.creator) {
        bumpWalletIntel(entry.pool.creator, 'deployer', {
          launch: true,
          alerted: entry.alerted,
          win: entry.alerted && win,
        });
      }
      if (entry.intel.funder) {
        bumpWalletIntel(entry.intel.funder, 'funder', {
          launch: true,
          alerted: entry.alerted,
          win: entry.alerted && win,
        });
      }
    } catch (err) {
      logger.debug(`discovery: finalize ${mint}: ${(err as Error).message}`);
    }
    if (entry.alerted) {
      logger.info(
        `discovery: ${mint} watch ended (${why})${peakMult !== null ? ` — peak ${peakMult.toFixed(2)}x after alert` : ''}`
      );
    } else {
      logger.debug(`discovery: ${mint} watch ended (${why})`);
    }
  }
}
