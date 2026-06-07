#!/usr/bin/env node
import { Command } from 'commander';
import { Connection } from '@solana/web3.js';
import chalk from 'chalk';
import { loadConfig, resetConfigCache } from './config';
import { logger } from './logger';
import {
  countOpenPositions,
  createPosition,
  getDb,
  getOpenPositions,
  getPnlSummary,
  getPosition,
  getTradesForPosition,
  hasStoppedPosition,
  isTokenKnown,
  recordRejection,
  recordTrade,
  updatePosition,
  closeDb,
} from './db';
import { PoolListener, PumpListener, LogListener, NewPool } from './listener';
import { analyzeToken, runSafetyChecks } from './analyzer';
import { buyToken, getTokenBalance, getWallet, getWalletBalance, sellToken, formatUsd } from './trader';
import {
  closeAllOpenPositions,
  executeAllInExit,
  positionAgeMinutes,
  shouldRideThroughLeaderExit,
  startMonitoring,
  stopMonitoring,
} from './positions';
import { InflightGate, withTimeout } from './concurrency';
import { reviewCommand } from './review';
import { formatRpcCounts, getRpcCounts, instrumentConnection } from './rpcCounter';
import { bannerHeadline, bannerLines } from './banner';
import { setBondingCurveCacheTtl, isMayhemToken, bondingCurvePda } from './bondingCurve';
import { MomentumWatcher } from './momentum';
import { checkLaunchBundle } from './bundleCheck';
import { TrendingListener, TrendingCandidate } from './trendingListener';
import { scoreTrendingCandidate } from './trendingAnalyzer';
import { WalletListener, LeaderTrade } from './walletListener';
import { initNotifier, notify } from './notifier';

// Cap concurrent analyses. Each pump analysis makes ~3 RPC calls (getMint +
// metadata + creator history) plus the AI call, so 6 concurrent ~= 6 req/s
// on RPC, comfortably under Helius free tier's 10 req/s ceiling. Bumped
// from 3 because pump.fun streams faster than 3-concurrent could drain
// (R7 dropped 528/615 detections at the busy gate).
const MAX_CONCURRENT_ANALYSES = 6;
// Hard cap on a single pool's analyze pipeline (DexScreener + RPC + Claude).
// If Claude is slow or DexScreener hangs, we give up rather than stall.
const ANALYSIS_TIMEOUT_MS = 20_000;
// How often the snipe command prints a rolling status summary during a run.
const STATUS_PRINT_INTERVAL_MS = 15 * 60 * 1000;
// Backstop for the graceful shutdown: if cleanup stalls (e.g. a dead RPC),
// force-exit so the process never hangs on Ctrl-C. Generous enough to let a
// legitimate close-on-shutdown sweep finish first.
const SHUTDOWN_HARD_TIMEOUT_MS = 3 * 60 * 1000;

function printBanner(): void {
  const cfg = loadConfig();
  logger.banner(bannerHeadline(cfg));
  for (const line of bannerLines(cfg)) {
    logger.info(line);
  }
}

function applyCliFlags(options: { simulate?: boolean; source?: string }): void {
  if (options.simulate) process.env.SIMULATE = 'true';
  if (options.source) {
    const normalized = options.source.trim().toLowerCase();
    if (
      normalized !== 'raydium' &&
      normalized !== 'pump' &&
      normalized !== 'trending' &&
      normalized !== 'copytrade'
    ) {
      throw new Error(
        `--source must be 'raydium', 'pump', 'trending' or 'copytrade', got '${options.source}'`
      );
    }
    process.env.SOURCE = normalized;
    // An explicit --source takes ownership of path defaults. Without this,
    // stale shell env (e.g. DB_PATH=./sniper.db exported from a previous
    // Raydium session) silently routes pump work into the wrong DB/log.
    delete process.env.DB_PATH;
    delete process.env.LOG_FILE;
  }
  // Config is cached; reset so the new env wins when loadConfig() is next called.
  resetConfigCache();
}

async function snipeCommand(options: {
  simulate?: boolean;
  source?: string;
}): Promise<void> {
  applyCliFlags(options);
  const cfg = loadConfig();
  setBondingCurveCacheTtl(cfg.bondingCurveCacheMs);
  printBanner();

  // Wallet
  try {
    const wallet = getWallet(cfg);
    logger.info(`wallet: ${wallet.publicKey.toBase58()}`);
    if (!cfg.simulate || cfg.walletPrivateKey) {
      const balance = await getWalletBalance(cfg);
      logger.info(`balance: ${balance.toFixed(4)} SOL`);
    }
  } catch (err) {
    logger.error(`wallet load failed: ${(err as Error).message}`);
    process.exit(1);
  }

  getDb(); // init schema

  const connection = instrumentConnection(
    new Connection(cfg.solanaRpcUrl, {
      commitment: 'confirmed',
      wsEndpoint: cfg.solanaWsUrl,
    })
  );
  // 'trending' and 'copytrade' discover tokens off-chain (GeckoTerminal poll /
  // leader-wallet poll), not from on-chain pool logs — no LogListener.
  const listener: LogListener | null =
    cfg.source === 'trending' || cfg.source === 'copytrade'
      ? null
      : cfg.source === 'pump'
        ? new PumpListener(connection)
        : new PoolListener(connection);
  const trendingListener: TrendingListener | null =
    cfg.source === 'trending'
      ? new TrendingListener(
          {
            minLiquidityUsd: cfg.trendingMinLiquidityUsd,
            maxLiquidityUsd: cfg.trendingMaxLiquidityUsd,
            minMcapUsd: cfg.trendingMinMcapUsd,
            minVolumeUsd: cfg.trendingMinVolumeUsd,
            minAgeMin: cfg.trendingMinAgeMin,
            maxAgeHours: cfg.trendingMaxAgeHours,
          },
          cfg.trendingPollSec * 1000
        )
      : null;
  const walletListener: WalletListener | null =
    cfg.source === 'copytrade'
      ? new WalletListener(
          connection,
          cfg.copytradeWallets,
          cfg.copytradePollSec * 1000,
          cfg.copytradeMinLeaderSol
        )
      : null;
  // The momentum pre-screen — bundle veto + safety checks. Run during the
  // watch window (kicked off when watching begins) so the entry path stays
  // fast. Returns false (and logs/records the rejection) for a token to skip.
  const momentumPrescreen = async (pool: NewPool): Promise<boolean> => {
    if (cfg.momentumBundleThreshold > 0) {
      const bundle = await checkLaunchBundle(
        connection,
        pool.txSignature,
        pool.poolAddress,
        cfg.momentumBundleThreshold
      );
      if (bundle.bundled) {
        logger.info(`skipping ${pool.tokenMint}: ${bundle.reason}`);
        recordRejection({
          tokenMint: pool.tokenMint,
          reason: bundle.reason,
          aiScore: null,
          poolAddress: pool.poolAddress,
        });
        return false;
      }
    }
    const safety = await runSafetyChecks(connection, pool.tokenMint, null, cfg);
    if (!safety.passed) {
      logger.info(`skipping ${pool.tokenMint}: safety — ${safety.failures.join('; ')}`);
      recordRejection({
        tokenMint: pool.tokenMint,
        reason: `safety: ${safety.failures.join('; ')}`,
        aiScore: null,
        poolAddress: pool.poolAddress,
      });
      return false;
    }
    return true;
  };

  // Pump uses momentum entry — watch a launch, buy only once it climbs into
  // the band and settles. Raydium keeps the analyze-at-launch flow (momentum
  // is null).
  const momentum =
    cfg.source === 'pump'
      ? new MomentumWatcher(
          connection,
          {
            windowMs: cfg.momentumWindowMin * 60_000,
            sampleMs: cfg.momentumSampleSec * 1_000,
            entryMultMin: cfg.momentumEntryMultMin,
            entryMultMax: cfg.momentumEntryMultMax,
            minAgeMs: cfg.momentumMinAgeSec * 1_000,
            settleSamples: cfg.momentumSettleSamples,
            settleTolerance: cfg.momentumSettleTolerance,
            watchCap: cfg.momentumWatchCap,
          },
          momentumPrescreen
        )
      : null;
  const gate = new InflightGate(MAX_CONCURRENT_ANALYSES);
  // Guards against the same mint being analyzed by concurrent events (multiple
  // init signatures for one pool, or replay after reconnect). Without this,
  // several analyses for one mint hit Claude in parallel and trigger 429s.
  const inflightMints = new Set<string>();
  // Optional Telegram push alerts (no-op unless configured). A live unattended
  // bot is invisible otherwise.
  const notifier = initNotifier(cfg);
  // Last time a leader trade was seen; drives the no-activity heartbeat alert.
  let lastLeaderActivityAt = Date.now();
  // Consecutive failed buys; an unbroken run trips the circuit breaker below.
  let consecutiveBuyFailures = 0;
  // Buys past the capacity gate but not yet recorded — counted so concurrent
  // momentum entries can't collectively overshoot maxOpenPositions.
  let buysInFlight = 0;

  // Shared buy tail: buy, update the circuit breaker, record the position
  // and trade. Used by both the Raydium analyze path and the pump momentum
  // entry.
  const executeBuy = async (
    pool: { tokenMint: string; poolAddress: string },
    meta: { aiScore: number | null; symbol: string | null }
  ): Promise<void> => {
    const buy = await buyToken(pool.tokenMint, cfg.buyAmountSol, cfg);
    if (!buy.success) {
      logger.error(`buy failed: ${buy.error}`);
      recordRejection({
        tokenMint: pool.tokenMint,
        reason: `buy failed: ${buy.error}`,
        aiScore: meta.aiScore,
        poolAddress: pool.poolAddress,
      });
      // A soft failure (no quote / no route / a venue-misroute on a transient
      // RPC blip) sent no transaction and is recoverable — don't let it trip
      // the do-not-restart circuit breaker, which is for systematic faults
      // that bleed fees (bad encoding, dead RPC, drained wallet).
      if (buy.softFailure) return;
      // A hard failure sent a transaction that reverted (e.g. Custom:6002
      // slippage). Push it so a live watcher sees the wall in real time.
      notify(`BUY FAILED ${meta.symbol || pool.tokenMint.slice(0, 8)}: ${buy.error}`);
      consecutiveBuyFailures++;
      if (
        cfg.maxConsecutiveBuyFailures > 0 &&
        consecutiveBuyFailures >= cfg.maxConsecutiveBuyFailures
      ) {
        logger.error(
          `circuit breaker tripped: ${consecutiveBuyFailures} buys failed in a row — shutting down`
        );
        // Exit 2 so the systemd unit's RestartPreventExitStatus=2 keeps the bot
        // DOWN. A systematic buy fault must not be undone by an auto-restart.
        void notifier.alert(
          `CIRCUIT BREAKER tripped: ${consecutiveBuyFailures} buys failed in a row. Bot shutting down and staying down.`
        );
        void shutdown('circuit breaker: consecutive buy failures', 2);
      }
      return;
    }
    // A landed buy clears the streak — only an unbroken run trips the breaker.
    consecutiveBuyFailures = 0;
    // When a copytrade buy lands on the pump bonding curve, the caller passed
    // no pool address (it doesn't know the venue ahead of time). Store the
    // curve PDA so the position monitor can price it directly — DexScreener
    // doesn't index on-curve pumps, which would otherwise leave it price-blind.
    const poolAddress =
      pool.poolAddress ||
      (buy.venue === 'pump' ? bondingCurvePda(pool.tokenMint).toBase58() : '');
    const position = createPosition({
      tokenMint: pool.tokenMint,
      tokenSymbol: meta.symbol,
      entryPriceSol: buy.pricePerToken,
      amountTokens: buy.amountOut,
      amountSolSpent: buy.amountIn,
      aiScore: meta.aiScore,
      poolAddress,
      entryTx: buy.txSignature,
    });
    recordTrade({
      positionId: position.id,
      type: 'buy',
      amountTokens: buy.amountOut,
      amountSol: buy.amountIn,
      priceSol: buy.pricePerToken,
      txSignature: buy.txSignature || null,
      simulated: buy.simulated,
    });
    const buyMc = buy.marketCapUsd !== undefined ? ` @ ${formatUsd(buy.marketCapUsd)}` : '';
    notify(
      `BUY ${meta.symbol || pool.tokenMint.slice(0, 8)} — ${buy.amountIn.toFixed(3)} SOL${buyMc}` +
        ` via ${buy.venue ?? 'jupiter'}${buy.simulated ? ' (sim)' : ''}`
    );
  };

  listener?.on('newPool', async (pool) => {
    if (momentum) {
      // Pump: hand the launch to the momentum watcher — it samples the
      // curve and emits 'entry' only once the token shows real momentum.
      if (!isTokenKnown(pool.tokenMint)) {
        await momentum
          .add(pool)
          .catch((err) => logger.error(`momentum add failed: ${(err as Error).message}`));
      }
      return;
    }
    // Cheapest checks first so a full bag short-circuits before we burn
    // an analyzer-gate slot or dirty the inflight dedup set.
    if (countOpenPositions() >= cfg.maxOpenPositions) {
      logger.debug(`max open positions (${cfg.maxOpenPositions}) reached, skipping`);
      return;
    }
    if (inflightMints.has(pool.tokenMint)) {
      logger.debug(`already analyzing ${pool.tokenMint}, skipping duplicate`);
      return;
    }
    if (isTokenKnown(pool.tokenMint)) {
      logger.debug(`already seen ${pool.tokenMint}, skipping`);
      return;
    }
    if (!gate.tryAcquire()) {
      logger.debug(
        `analyzer busy (${gate.inflight}/${gate.capacity} in-flight), skipping ${pool.tokenMint}`
      );
      return;
    }
    inflightMints.add(pool.tokenMint);
    try {
      logger.info(`analyzing ${pool.tokenMint}...`);
      const analysis = await withTimeout(
        analyzeToken(connection, pool, cfg),
        ANALYSIS_TIMEOUT_MS,
        `analyze ${pool.tokenMint}`
      );

      if (!analysis.shouldBuy) {
        logger.info(
          `skipping ${pool.tokenMint} (score ${analysis.ai.score}): ${analysis.rejectionReason}`
        );
        // Don't permanently blocklist mints where AI scoring had a transient
        // error (rate limit, timeout). Without this, a 429 storm poisons the
        // rejected_tokens table with mints we never actually evaluated.
        if (!analysis.ai.error) {
          recordRejection({
            tokenMint: pool.tokenMint,
            reason: analysis.rejectionReason ?? 'unknown',
            aiScore: analysis.ai.score,
            poolAddress: pool.poolAddress,
          });
        }
        return;
      }

      logger.info(
        `BUYING ${pool.tokenMint} (score ${analysis.ai.score}): ${analysis.ai.reasoning}`
      );
      await executeBuy(pool, {
        aiScore: analysis.ai.score,
        symbol: analysis.market.symbol,
      });
    } catch (err) {
      logger.error(`newPool handler failed: ${(err as Error).message}`);
    } finally {
      gate.release();
      inflightMints.delete(pool.tokenMint);
    }
  });

  if (momentum) {
    // The watcher only emits 'entry' for tokens that already cleared the
    // pre-screen during the watch, so the handler just buys.
    momentum.on('entry', (pool: NewPool, mult: number) => {
      void (async () => {
        if (countOpenPositions() + buysInFlight >= cfg.maxOpenPositions) {
          logger.debug(`max open positions reached, skipping ${pool.tokenMint}`);
          return;
        }
        if (isTokenKnown(pool.tokenMint)) return;
        buysInFlight++;
        try {
          logger.info(
            `BUYING ${pool.tokenMint} — momentum +${((mult - 1) * 100).toFixed(0)}%`
          );
          await executeBuy(pool, { aiScore: null, symbol: null });
        } catch (err) {
          logger.error(`momentum entry failed: ${(err as Error).message}`);
        } finally {
          buysInFlight--;
        }
      })();
    });
  }

  if (trendingListener) {
    // A trending candidate already cleared the liquidity/mcap/volume/age
    // filter in the listener; here we score its name + metrics and buy.
    trendingListener.on('candidate', (c: TrendingCandidate) => {
      void (async () => {
        if (countOpenPositions() + buysInFlight >= cfg.maxOpenPositions) {
          logger.debug(`max open positions reached, skipping ${c.symbol}`);
          return;
        }
        if (isTokenKnown(c.tokenMint) || inflightMints.has(c.tokenMint)) return;
        inflightMints.add(c.tokenMint);
        buysInFlight++;
        try {
          const ai = await scoreTrendingCandidate(c, cfg);
          if (ai.error) {
            // Transient (rate limit, timeout) — don't blocklist; retry later.
            logger.debug(`trending: scoring errored for ${c.symbol} — will retry`);
            return;
          }
          if (ai.score < cfg.minAiScore) {
            logger.info(
              `skipping ${c.symbol} (score ${ai.score}): below min AI score ${cfg.minAiScore}`
            );
            recordRejection({
              tokenMint: c.tokenMint,
              reason: `AI score ${ai.score} < ${cfg.minAiScore}`,
              aiScore: ai.score,
              poolAddress: c.poolAddress,
            });
            return;
          }
          logger.info(`BUYING ${c.symbol} (score ${ai.score}): ${ai.reasoning}`);
          await executeBuy(c, { aiScore: ai.score, symbol: c.symbol });
        } catch (err) {
          logger.error(`trending candidate handler failed: ${(err as Error).message}`);
        } finally {
          buysInFlight--;
          inflightMints.delete(c.tokenMint);
        }
      })();
    });
  }

  if (walletListener) {
    // Tokens the leader sold while our copy-buy was still in flight — sold the
    // instant the buy lands (orphaned-bag race fix).
    const pendingSells = new Set<string>();
    // Tokens with an exit already in progress — guards a leader who sells one
    // token in chunks from firing several concurrent full exits of one
    // position (the CT-paper-1 triple-sell bug).
    const exitingMints = new Set<string>();

    // Close every open position in a token, deduped per mint.
    const exitToken = async (tokenMint: string): Promise<void> => {
      if (exitingMints.has(tokenMint)) return;
      const open = getOpenPositions().filter((p) => p.token_mint === tokenMint);
      if (open.length === 0) return;
      exitingMints.add(tokenMint);
      try {
        for (const position of open) {
          if (shouldRideThroughLeaderExit(position, cfg)) {
            logger.info(
              `copytrade: leader exited ${tokenMint}, but position #${position.id} already banked a tranche — riding the trailing stop past the leader`
            );
            continue;
          }
          logger.info(
            `copytrade: leader exited ${tokenMint} — closing position #${position.id}`
          );
          await executeAllInExit(position, cfg, true);
        }
      } catch (err) {
        logger.error(`copytrade exit handler failed: ${(err as Error).message}`);
      } finally {
        exitingMints.delete(tokenMint);
      }
    };

    // Copy a leader's buy — no AI score; the leader's track record is the
    // signal. Buy our own fixed size (BUY_AMOUNT_SOL), not theirs.
    walletListener.on('leaderBuy', (t: LeaderTrade) => {
      lastLeaderActivityAt = Date.now();
      void (async () => {
        if (countOpenPositions() + buysInFlight >= cfg.maxOpenPositions) {
          logger.debug(`max open positions reached, skipping ${t.tokenMint}`);
          return;
        }
        // Gate on a currently-OPEN position (not any historical row): a leader
        // re-entering a token they previously exited should be copied again.
        // isTokenKnown would block re-buys forever and let a stale mayhem
        // rejection suppress a legitimate later entry. But do NOT re-buy a mint
        // our own stop-loss already cut at a loss — copying a leader who keeps
        // averaging down a token that stopped us out just bleeds via repeated
        // SL exits.
        const alreadyHeld = getOpenPositions().some((p) => p.token_mint === t.tokenMint);
        if (alreadyHeld || inflightMints.has(t.tokenMint)) return;
        if (hasStoppedPosition(t.tokenMint)) {
          logger.info(`copytrade: skipping ${t.tokenMint} — already stop-lossed this run`);
          return;
        }
        inflightMints.add(t.tokenMint);
        buysInFlight++;
        try {
          // Never copy a leader into a pump.fun Mayhem-mode coin — the sell
          // can revert (Custom:6024) and trap the capital.
          if (await isMayhemToken(connection, t.tokenMint)) {
            logger.info(
              `skipping ${t.tokenMint}: mayhem-mode coin (unsellable-trap risk)`
            );
            recordRejection({
              tokenMint: t.tokenMint,
              reason: 'mayhem-mode coin (unsellable-trap risk)',
              aiScore: null,
              poolAddress: '',
            });
            return;
          }
          logger.info(`BUYING ${t.tokenMint} — copying ${t.wallet.slice(0, 8)}...`);
          await executeBuy(
            { tokenMint: t.tokenMint, poolAddress: '' },
            { aiScore: null, symbol: null }
          );
          // The leader sold this token while our buy was in flight — exit the
          // freshly-opened position now.
          if (pendingSells.delete(t.tokenMint)) await exitToken(t.tokenMint);
        } catch (err) {
          logger.error(`copytrade buy handler failed: ${(err as Error).message}`);
        } finally {
          buysInFlight--;
          inflightMints.delete(t.tokenMint);
        }
      })();
    });
    // Mirror a leader's sell — full-exit our position when the leader sold a
    // meaningful fraction of their holding. A small trim (below
    // copytradeSellExitFraction) is treated as "leader still in" and ignored,
    // so a dust/test-sell can't dump our whole bag. The stop-loss and
    // time-exit (monitor loop) remain independent floors.
    walletListener.on('leaderSell', (t: LeaderTrade) => {
      lastLeaderActivityAt = Date.now();
      void (async () => {
        const fraction = t.sellFraction ?? 1;
        if (fraction < cfg.copytradeSellExitFraction) {
          logger.info(
            `copytrade: leader trimmed ${(fraction * 100).toFixed(0)}% of ${t.tokenMint} (< ${(cfg.copytradeSellExitFraction * 100).toFixed(0)}%) — holding`
          );
          return;
        }
        const held = getOpenPositions().some((p) => p.token_mint === t.tokenMint);
        if (!held && inflightMints.has(t.tokenMint)) {
          // Leader exited before our copy-buy landed — sell on buy completion.
          pendingSells.add(t.tokenMint);
          return;
        }
        await exitToken(t.tokenMint);
      })();
    });
  }

  await listener?.start();
  trendingListener?.start();
  walletListener?.start();
  if (momentum) {
    momentum.start();
    logger.info(
      `momentum entry: buy a +${((cfg.momentumEntryMultMin - 1) * 100).toFixed(0)}-${((cfg.momentumEntryMultMax - 1) * 100).toFixed(0)}% climb once it settles ` +
        `(${cfg.momentumSettleSamples} samples within ${(cfg.momentumSettleTolerance * 100).toFixed(0)}%), window ${cfg.momentumWindowMin}min`
    );
  }
  // Hand the connection to the monitor so pump positions can poll the
  // bonding curve directly instead of waiting for DexScreener to index.
  startMonitoring(undefined, connection);

  // Push a startup ping so a silent crash-loop is distinguishable from a
  // healthy boot (no-op unless Telegram is configured).
  void notifier.alert(
    `started: ${cfg.simulate ? 'SIMULATION' : 'LIVE'} ${cfg.source} | wallet ${getWallet(cfg).publicKey.toBase58().slice(0, 8)}... | buy ${cfg.buyAmountSol} SOL, max ${cfg.maxOpenPositions}`
  );

  // No-activity heartbeat: a copytrade run that boots fine but never sees a
  // leader trade (bad COPYTRADE_WALLETS, broken poll, dead RPC) looks identical
  // to a quiet market. Periodically alert if no leader activity for the window.
  let heartbeatTimer: NodeJS.Timeout | null = null;
  if (cfg.alertHeartbeatMinutes > 0 && notifier.enabled) {
    const everyMs = cfg.alertHeartbeatMinutes * 60 * 1000;
    heartbeatTimer = setInterval(() => {
      const quietMin = Math.round((Date.now() - lastLeaderActivityAt) / 60000);
      if (quietMin >= cfg.alertHeartbeatMinutes) {
        void notifier.alert(
          `still alive, but no leader trades seen in ${quietMin}min (${countOpenPositions()} open positions)`
        );
      }
    }, everyMs);
    heartbeatTimer.unref();
  }

  const statusTimer = setInterval(() => {
    try {
      printStatus();
    } catch (err) {
      logger.error(`status print failed: ${(err as Error).message}`);
    }
  }, STATUS_PRINT_INTERVAL_MS);

  // First interrupt runs the graceful shutdown; a second one (impatient user,
  // or SIGINT during the MAX_RUN_HOURS auto-stop) force-exits instead of
  // starting a second close-positions loop.
  let shuttingDown = false;
  // exitCode lets a deliberate, do-not-restart shutdown (the circuit breaker)
  // exit with a distinct code the systemd unit refuses to restart on
  // (RestartPreventExitStatus). A normal Ctrl-C / SIGTERM exits 0.
  const shutdown = async (reason: string, exitCode = 0) => {
    if (shuttingDown) {
      logger.warn('second interrupt — force-exiting');
      process.exit(130);
    }
    shuttingDown = true;
    logger.info(`shutting down (${reason})...`);
    // Backstop: if any cleanup step stalls on a dead RPC/WebSocket, force-exit
    // anyway so Ctrl-C is never a dead end.
    const forceExit = setTimeout(() => {
      logger.warn('shutdown cleanup stalled — force-exiting');
      process.exit(1);
    }, SHUTDOWN_HARD_TIMEOUT_MS);
    forceExit.unref();
    clearInterval(statusTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (autoStopTimer) clearTimeout(autoStopTimer);
    await listener?.stop();
    trendingListener?.stop();
    walletListener?.stop();
    if (momentum) momentum.stop();
    stopMonitoring();
    if (cfg.closeOnShutdown) {
      const result = await closeAllOpenPositions(cfg, connection);
      logger.info(
        `shutdown close: ${result.closed} closed, ${result.failed} failed`
      );
    }
    printStatus();
    closeDb();
    clearTimeout(forceExit);
    process.exit(exitCode);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // Auto-shutdown after MAX_RUN_HOURS (0 disables). For unattended runs so
  // the bot stops itself instead of churning indefinitely.
  let autoStopTimer: NodeJS.Timeout | null = null;
  if (cfg.maxRunHours > 0) {
    const ms = cfg.maxRunHours * 60 * 60 * 1000;
    autoStopTimer = setTimeout(() => {
      logger.info(`MAX_RUN_HOURS=${cfg.maxRunHours} reached`);
      void shutdown(`MAX_RUN_HOURS=${cfg.maxRunHours}`);
    }, ms);
  }

  logger.info(
    `sniper running. Rolling status every ${STATUS_PRINT_INTERVAL_MS / 60_000} min. Press Ctrl+C to stop.`
  );
}

async function monitorCommand(options: { source?: string } = {}): Promise<void> {
  applyCliFlags(options);
  const cfg = loadConfig();
  setBondingCurveCacheTtl(cfg.bondingCurveCacheMs);
  getDb();
  logger.banner(`MIPER monitor — source: ${cfg.source} (db: ${cfg.dbPath})`);
  const connection = instrumentConnection(
    new Connection(cfg.solanaRpcUrl, {
      commitment: 'confirmed',
      wsEndpoint: cfg.solanaWsUrl,
    })
  );
  startMonitoring(undefined, connection);

  const shutdown = () => {
    stopMonitoring();
    closeDb();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  logger.info('monitoring open positions. Press Ctrl+C to stop.');
}

function fmt(n: number | null, digits = 4): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '-';
  return n.toFixed(digits);
}

function printStatus(): void {
  const cfg = loadConfig();
  const positions = getOpenPositions();
  const pnl = getPnlSummary();

  logger.banner('STATUS');
  logger.info(
    `open ${pnl.openCount} | closed ${pnl.closedCount} | stopped ${pnl.stoppedCount} | win rate ${(pnl.winRate * 100).toFixed(1)}%`
  );
  logger.info(
    `spent ${fmt(pnl.totalSpent)} SOL | received ${fmt(pnl.totalReceived)} SOL | PnL ${chalk.bold(fmt(pnl.realizedPnlSol))} SOL`
  );
  if (cfg.simulate) {
    const current = cfg.simulatedStartingSol + pnl.realizedPnlSol;
    const pctReturn = (pnl.realizedPnlSol / cfg.simulatedStartingSol) * 100;
    const tinted = pctReturn >= 0 ? chalk.green : chalk.red;
    logger.info(
      `paper bag: ${fmt(current)} SOL (started ${fmt(cfg.simulatedStartingSol)}, ${tinted(`${pctReturn >= 0 ? '+' : ''}${pctReturn.toFixed(2)}%`)})`
    );
  }

  // Skip the rpc line when no calls have been counted: the counter is
  // process-local, so a standalone `npm run status:pump` from another
  // terminal would otherwise log "rpc: 0 calls" against the bot's log
  // file even though the live process has burnt through thousands of
  // calls. Only the owning process's status prints meaningful counts.
  const rpcSnapshot = getRpcCounts();
  if (Object.values(rpcSnapshot).reduce((a, b) => a + b, 0) > 0) {
    logger.info(formatRpcCounts(rpcSnapshot));
  }

  if (positions.length === 0) {
    logger.info('no open positions');
    return;
  }
  // Column spec — the header and every row are padded by the same widths so
  // the table actually lines up. The hold column shows time left before the
  // MAX_HOLD_MINUTES time-exit, or (when that's disabled) the position's age.
  const holdHead = cfg.maxHoldMinutes > 0 ? 'EXIT-IN' : 'AGE';
  const cols: ReadonlyArray<{ head: string; w: number; right: boolean }> = [
    { head: 'ID', w: 4, right: true },
    { head: 'SYMBOL', w: 12, right: false },
    { head: 'ENTRY', w: 13, right: true },
    { head: 'CURRENT', w: 13, right: true },
    { head: 'MULT', w: 7, right: true },
    { head: holdHead, w: 8, right: true },
    { head: 'TP', w: 3, right: true },
    { head: 'STATUS', w: 8, right: false },
    { head: 'MINT', w: 0, right: false },
  ];
  const renderRow = (cells: readonly string[]): string =>
    '  ' +
    cells
      .map((cell, i) => {
        const c = cols[i];
        if (c.w === 0) return cell;
        return c.right ? cell.padStart(c.w) : cell.padEnd(c.w).slice(0, c.w);
      })
      .join('  ');

  // eslint-disable-next-line no-console
  console.log(chalk.bold('\n' + renderRow(cols.map((c) => c.head))));
  for (const p of positions) {
    const mult =
      p.current_price_sol && p.entry_price_sol
        ? p.current_price_sol / p.entry_price_sol
        : null;
    const age = positionAgeMinutes(p);
    const hold =
      age === null
        ? '-'
        : cfg.maxHoldMinutes > 0
          ? cfg.maxHoldMinutes - age > 0
            ? `${(cfg.maxHoldMinutes - age).toFixed(1)}m`
            : 'due'
          : `${age.toFixed(1)}m`;
    // eslint-disable-next-line no-console
    console.log(
      renderRow([
        String(p.id),
        p.token_symbol ?? '-',
        fmt(p.entry_price_sol, 8),
        fmt(p.current_price_sol, 8),
        mult !== null ? `${mult.toFixed(2)}x` : '-',
        hold,
        String(p.tp_level),
        p.status,
        p.token_mint,
      ])
    );
  }
  // eslint-disable-next-line no-console
  console.log('');
}

async function statusCommand(options: { source?: string } = {}): Promise<void> {
  applyCliFlags(options);
  loadConfig();
  getDb();
  printStatus();
  closeDb();
}

async function balanceCommand(options: { source?: string } = {}): Promise<void> {
  applyCliFlags(options);
  const cfg = loadConfig();
  const wallet = getWallet(cfg);
  logger.info(`wallet: ${wallet.publicKey.toBase58()}`);
  try {
    const balance = await getWalletBalance(cfg);
    logger.info(`SOL: ${balance.toFixed(4)}`);
  } catch (err) {
    logger.error(`balance fetch failed: ${(err as Error).message}`);
  }
}

async function sellCommand(
  positionId: string,
  options: { pct?: string; source?: string }
): Promise<void> {
  applyCliFlags(options);
  const cfg = loadConfig();
  getDb();
  const id = Number(positionId);
  const position = getPosition(id);
  if (!position) {
    logger.error(`position ${id} not found`);
    process.exit(1);
  }
  if (!['open', 'partial'].includes(position.status)) {
    logger.error(`position ${id} is already ${position.status}`);
    process.exit(1);
  }
  const pct = Math.min(100, Math.max(1, Number(options.pct ?? '100')));
  const amount = (position.amount_tokens * pct) / 100;
  logger.info(`selling ${pct}% (${amount.toFixed(4)} tokens) of position ${id}`);

  // Sanity check the on-chain balance when live.
  if (!cfg.simulate) {
    const onchain = await getTokenBalance(position.token_mint, cfg);
    if (onchain < amount) {
      logger.warn(`on-chain balance ${onchain} < requested ${amount}, trimming`);
    }
  }

  const result = await sellToken(position.token_mint, amount, cfg);
  if (!result.success) {
    logger.error(`sell failed: ${result.error}`);
    process.exit(1);
  }

  recordTrade({
    positionId: id,
    type: 'sell',
    amountTokens: amount,
    amountSol: result.amountOut,
    priceSol: result.pricePerToken,
    txSignature: result.txSignature || null,
    simulated: result.simulated,
  });

  const remaining = position.amount_tokens - amount;
  const trades = getTradesForPosition(id);
  const received = trades
    .filter((t) => t.type === 'sell')
    .reduce((s, t) => s + t.amount_sol, 0);
  updatePosition(id, {
    amountTokens: remaining,
    amountSolReceived: received,
    status: remaining <= 0 ? 'closed' : 'partial',
  });
  logger.info(`received ${result.amountOut.toFixed(4)} SOL`);
  closeDb();
}

const program = new Command();
program
  .name('miper')
  .description('Autonomous Solana memecoin sniper with Claude AI scoring')
  .version('0.1.0');

program
  .command('snipe')
  .description('Listen for new Raydium or pump.fun launches and auto-buy/auto-manage')
  .option('--simulate', 'force simulation mode')
  .option('--source <source>', "token source: 'raydium' or 'pump' (falls back to SOURCE env, then 'raydium')")
  .action(snipeCommand);

program
  .command('monitor')
  .description('Monitor existing positions (no new buys)')
  .option('--source <source>', "which ledger to read: 'raydium' or 'pump' (falls back to SOURCE env, then 'raydium')")
  .action(monitorCommand);

program
  .command('status')
  .description('Show open positions and PnL summary')
  .option('--source <source>', "which ledger to read: 'raydium' or 'pump' (falls back to SOURCE env, then 'raydium')")
  .action(statusCommand);

program
  .command('balance')
  .description('Show wallet SOL balance')
  .option('--source <source>', "resolve config for: 'raydium' or 'pump' (falls back to SOURCE env, then 'raydium')")
  .action(balanceCommand);

program
  .command('review')
  .description('Summarize the DB: PnL, positions, rejections, live-readiness')
  .option('--source <source>', "which ledger to review: 'raydium' or 'pump' (falls back to SOURCE env, then 'raydium')")
  .action((options) => {
    applyCliFlags(options);
    return reviewCommand();
  });

program
  .command('sell <positionId>')
  .description('Manually sell a position')
  .option('--pct <pct>', 'percentage of position to sell (1-100)', '100')
  .option('--source <source>', "which ledger to sell from: 'raydium' or 'pump' (falls back to SOURCE env, then 'raydium')")
  .action(sellCommand);

program.parseAsync(process.argv).catch((err) => {
  logger.error((err as Error).message);
  process.exit(1);
});
