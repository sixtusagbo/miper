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

const INIT_KEYWORDS = ['initialize2', 'Initialize2', 'init_pc_amount', 'ray_log'];
const SEEN_LIMIT = 5000;
const LAMPORTS_PER_SOL = 1_000_000_000;

function isInitLog(messages: readonly string[] | undefined): boolean {
  if (!messages) return false;
  for (const m of messages) {
    for (const kw of INIT_KEYWORDS) {
      if (m.includes(kw)) return true;
    }
  }
  return false;
}

function trimSeen(seen: Set<string>): void {
  if (seen.size < SEEN_LIMIT) return;
  const over = seen.size - Math.floor(SEEN_LIMIT / 2);
  const it = seen.values();
  for (let i = 0; i < over; i++) {
    const v = it.next().value;
    if (v === undefined) break;
    seen.delete(v);
  }
}

function estimateSolLiquidity(meta: { preBalances: number[]; postBalances: number[] } | null): number {
  if (!meta) return 0;
  let maxDelta = 0;
  const len = Math.min(meta.preBalances.length, meta.postBalances.length);
  for (let i = 0; i < len; i++) {
    const delta = meta.preBalances[i] - meta.postBalances[i];
    if (delta > maxDelta) maxDelta = delta;
  }
  return maxDelta / LAMPORTS_PER_SOL;
}

async function parsePoolFromSignature(
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

export class PoolListener extends EventEmitter {
  private connection: Connection;
  private subscriptionId: number | null = null;
  private seen = new Set<string>();
  private running = false;

  constructor(connection?: Connection) {
    super();
    this.connection = connection ?? makeConnection();
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    logger.info('Subscribing to Raydium AMM logs via WebSocket');
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
    if (this.subscriptionId !== null) {
      try {
        await this.connection.removeOnLogsListener(this.subscriptionId);
      } catch (err) {
        logger.debug(`removeOnLogsListener: ${(err as Error).message}`);
      }
      this.subscriptionId = null;
    }
  }

  private async handleLogs(
    signature: string,
    logs: string[] | null,
    err: unknown
  ): Promise<void> {
    if (err) return;
    if (this.seen.has(signature)) return;
    if (!isInitLog(logs ?? undefined)) return;

    this.seen.add(signature);
    trimSeen(this.seen);

    const pool = await parsePoolFromSignature(this.connection, signature);
    if (pool) {
      logger.info(
        `New pool detected: ${pool.tokenMint} (${pool.initialLiquiditySol.toFixed(3)} SOL)`
      );
      this.emit('newPool', pool);
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
