import { EventEmitter } from 'events';
import { Connection, PublicKey } from '@solana/web3.js';
import { loadConfig, PROGRAM_IDS, SOL_MINT_ADDRESS } from './config';
import { logger } from './logger';

export interface NewPool {
  poolAddress: string;
  tokenMint: string;
  baseMint: string;
  quoteMint: string;
  initialLiquiditySol: number;
  txSignature: string;
  timestamp: number;
}

// `ray_log` is intentionally excluded: it appears in every Raydium log (swaps,
// deposits, everything) and matching it turns every Raydium transaction into
// an expensive getParsedTransaction call. The three keywords below are
// specific to pool initialization.
const INIT_KEYWORDS = ['initialize2', 'Initialize2', 'init_pc_amount'];
export const SEEN_LIMIT = 5000;
const LAMPORTS_PER_SOL = 1_000_000_000;

export function isInitLog(messages: readonly string[] | undefined): boolean {
  if (!messages) return false;
  for (const m of messages) {
    for (const kw of INIT_KEYWORDS) {
      if (m.includes(kw)) return true;
    }
  }
  return false;
}

export function trimSeen(seen: Set<string>): void {
  if (seen.size < SEEN_LIMIT) return;
  const over = seen.size - Math.floor(SEEN_LIMIT / 2);
  const it = seen.values();
  for (let i = 0; i < over; i++) {
    const v = it.next().value;
    if (v === undefined) break;
    seen.delete(v);
  }
}

export function estimateSolLiquidity(meta: { preBalances: number[]; postBalances: number[] } | null): number {
  if (!meta) return 0;
  let maxDelta = 0;
  const len = Math.min(meta.preBalances.length, meta.postBalances.length);
  for (let i = 0; i < len; i++) {
    const delta = meta.preBalances[i] - meta.postBalances[i];
    if (delta > maxDelta) maxDelta = delta;
  }
  return maxDelta / LAMPORTS_PER_SOL;
}

export async function parsePoolFromSignature(
  connection: Connection,
  signature: string
): Promise<NewPool | null> {
  try {
    const tx = await connection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    });
    if (!tx?.transaction) return null;

    for (const ix of tx.transaction.message.instructions) {
      const programId = (ix as { programId: PublicKey }).programId?.toBase58?.();
      if (programId !== PROGRAM_IDS.RAYDIUM_AMM.toBase58()) continue;

      const accounts = (ix as { accounts?: PublicKey[] }).accounts;
      if (!accounts || accounts.length < 10) continue;

      const poolAddress = accounts[4]?.toBase58();
      const coinMint = accounts[8]?.toBase58();
      const pcMint = accounts[9]?.toBase58();
      if (!poolAddress || !coinMint || !pcMint) continue;

      const baseMint =
        coinMint === SOL_MINT_ADDRESS
          ? coinMint
          : pcMint === SOL_MINT_ADDRESS
          ? pcMint
          : null;
      const tokenMint =
        coinMint === SOL_MINT_ADDRESS
          ? pcMint
          : pcMint === SOL_MINT_ADDRESS
          ? coinMint
          : null;
      if (!baseMint || !tokenMint) return null;

      return {
        poolAddress,
        tokenMint,
        baseMint,
        quoteMint: tokenMint,
        initialLiquiditySol: estimateSolLiquidity(tx.meta ?? null),
        txSignature: signature,
        timestamp: tx.blockTime ?? Math.floor(Date.now() / 1000),
      };
    }
    return null;
  } catch (err) {
    logger.debug(`parsePoolFromSignature ${signature}: ${(err as Error).message}`);
    return null;
  }
}

function makeConnection(): Connection {
  const cfg = loadConfig();
  return new Connection(cfg.solanaRpcUrl, {
    commitment: 'confirmed',
    wsEndpoint: cfg.solanaWsUrl,
  });
}

const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
// Two back-to-back empty heartbeat windows (~10 min) is a strong signal the
// WebSocket has silently died. Raydium sees hundreds of events per minute in
// normal operation, so genuine stretches of zero activity don't last this long.
const DEFAULT_RECONNECT_AFTER_EMPTY_WINDOWS = 2;

interface ListenerCounters {
  events: number;
  initMatches: number;
  poolsEmitted: number;
  parseFailures: number;
}

export interface PoolListenerOptions {
  reconnectAfterEmptyWindows?: number;
  connectionFactory?: () => Connection;
}

export class PoolListener extends EventEmitter {
  private connection: Connection;
  private subscriptionId: number | null = null;
  private seen = new Set<string>();
  private running = false;
  private counters: ListenerCounters = {
    events: 0,
    initMatches: 0,
    poolsEmitted: 0,
    parseFailures: 0,
  };
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private readonly heartbeatMs: number;
  private readonly reconnectAfter: number;
  private readonly connectionFactory: () => Connection;
  private consecutiveEmptyWindows = 0;
  private reconnecting = false;

  constructor(
    connection?: Connection,
    heartbeatMs: number = HEARTBEAT_INTERVAL_MS,
    options: PoolListenerOptions = {}
  ) {
    super();
    this.connection = connection ?? makeConnection();
    this.heartbeatMs = heartbeatMs;
    this.reconnectAfter = options.reconnectAfterEmptyWindows ?? DEFAULT_RECONNECT_AFTER_EMPTY_WINDOWS;
    this.connectionFactory = options.connectionFactory ?? makeConnection;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    logger.info('Subscribing to Raydium AMM logs via WebSocket');
    this.subscribe();
    if (this.heartbeatMs > 0) {
      this.heartbeatTimer = setInterval(() => this.logHeartbeat(), this.heartbeatMs);
    }
  }

  private subscribe(): void {
    this.subscriptionId = this.connection.onLogs(
      PROGRAM_IDS.RAYDIUM_AMM,
      (logsResult) => {
        this.handleLogs(logsResult.signature, logsResult.logs, logsResult.err).catch((err) =>
          logger.error(`handleLogs failed: ${(err as Error).message}`)
        );
      },
      'confirmed'
    );
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.subscriptionId !== null) {
      try {
        await this.connection.removeOnLogsListener(this.subscriptionId);
      } catch (err) {
        logger.debug(`removeOnLogsListener: ${(err as Error).message}`);
      }
      this.subscriptionId = null;
    }
  }

  getCounters(): Readonly<ListenerCounters> {
    return { ...this.counters };
  }

  private logHeartbeat(): void {
    const { events, initMatches, poolsEmitted, parseFailures } = this.counters;
    const minutes = this.heartbeatMs / 60_000;
    logger.info(
      `listener heartbeat (${minutes}min): ${events} Raydium events | ${initMatches} init matches | ${poolsEmitted} pools emitted | ${parseFailures} parse failures`
    );
    if (events === 0) {
      this.consecutiveEmptyWindows++;
      logger.warn(
        `No Raydium events in the last window (${this.consecutiveEmptyWindows} in a row). RPC WebSocket may be dead.`
      );
      if (
        this.reconnectAfter > 0 &&
        this.consecutiveEmptyWindows >= this.reconnectAfter &&
        this.running &&
        !this.reconnecting
      ) {
        this.reconnect().catch((err) =>
          logger.error(`reconnect failed: ${(err as Error).message}`)
        );
      }
    } else {
      this.consecutiveEmptyWindows = 0;
    }
    this.counters = { events: 0, initMatches: 0, poolsEmitted: 0, parseFailures: 0 };
  }

  private async reconnect(): Promise<void> {
    this.reconnecting = true;
    try {
      logger.warn('Tearing down dead WebSocket subscription and rebuilding...');
      if (this.subscriptionId !== null) {
        try {
          await this.connection.removeOnLogsListener(this.subscriptionId);
        } catch (err) {
          logger.debug(`removeOnLogsListener on reconnect: ${(err as Error).message}`);
        }
        this.subscriptionId = null;
      }
      try {
        this.connection = this.connectionFactory();
      } catch (err) {
        logger.error(`failed to build fresh Connection: ${(err as Error).message}`);
        return;
      }
      this.subscribe();
      this.consecutiveEmptyWindows = 0;
      logger.info('Listener re-subscribed to Raydium AMM logs on a fresh WebSocket');
    } finally {
      this.reconnecting = false;
    }
  }

  private async handleLogs(
    signature: string,
    logs: string[] | null,
    err: unknown
  ): Promise<void> {
    this.counters.events++;
    if (err) return;
    if (this.seen.has(signature)) return;
    if (!isInitLog(logs ?? undefined)) return;

    this.counters.initMatches++;
    this.seen.add(signature);
    trimSeen(this.seen);

    logger.debug(`init match: ${signature} (${logs?.length ?? 0} log lines)`);

    const pool = await parsePoolFromSignature(this.connection, signature);
    if (pool) {
      this.counters.poolsEmitted++;
      logger.info(
        `New pool detected: ${pool.tokenMint} (${pool.initialLiquiditySol.toFixed(3)} SOL)`
      );
      this.emit('newPool', pool);
    } else {
      this.counters.parseFailures++;
      logger.debug(`parse returned null for ${signature}`);
    }
  }
}

// Fallback listener that polls signatures when WebSocket subscriptions are flaky.
export class PollingPoolListener extends EventEmitter {
  private connection: Connection;
  private seen = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private readonly intervalMs: number;
  private lastSignature: string | null = null;

  constructor(connection?: Connection, intervalMs = 2000) {
    super();
    this.connection = connection ?? makeConnection();
    this.intervalMs = intervalMs;
  }

  async start(): Promise<void> {
    if (this.timer) return;
    logger.info(`Starting polling listener (interval ${this.intervalMs}ms)`);
    this.timer = setInterval(() => {
      this.poll().catch((err) => logger.error(`polling failed: ${(err as Error).message}`));
    }, this.intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async poll(): Promise<void> {
    const sigs = await this.connection.getSignaturesForAddress(PROGRAM_IDS.RAYDIUM_AMM, {
      limit: 25,
      until: this.lastSignature ?? undefined,
    });
    if (sigs.length === 0) return;
    this.lastSignature = sigs[0].signature;

    for (const s of sigs.reverse()) {
      if (this.seen.has(s.signature)) continue;
      this.seen.add(s.signature);
      trimSeen(this.seen);

      const tx = await this.connection.getParsedTransaction(s.signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });
      if (!tx?.meta?.logMessages || !isInitLog(tx.meta.logMessages)) continue;

      const parsed = await parsePoolFromSignature(this.connection, s.signature);
      if (parsed) {
        logger.info(
          `New pool (poll): ${parsed.tokenMint} (${parsed.initialLiquiditySol.toFixed(3)} SOL)`
        );
        this.emit('newPool', parsed);
      }
    }
  }
}
