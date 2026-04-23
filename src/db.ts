import Database from 'better-sqlite3';
import { loadConfig } from './config';

export type PositionStatus = 'open' | 'partial' | 'closed' | 'stopped';
export type TradeType = 'buy' | 'sell';

export interface Position {
  id: number;
  token_mint: string;
  token_symbol: string | null;
  entry_price_sol: number;
  current_price_sol: number | null;
  amount_tokens: number;
  amount_sol_spent: number;
  amount_sol_received: number;
  status: PositionStatus;
  tp_level: number;
  ai_score: number | null;
  pool_address: string | null;
  entry_tx: string | null;
  created_at: string;
  updated_at: string;
}

export interface Trade {
  id: number;
  position_id: number;
  type: TradeType;
  amount_tokens: number;
  amount_sol: number;
  price_sol: number;
  tx_signature: string | null;
  simulated: number;
  created_at: string;
}

export interface RejectedToken {
  id: number;
  token_mint: string;
  reason: string;
  ai_score: number | null;
  pool_address: string | null;
  created_at: string;
}

export interface PnlSummary {
  totalSpent: number;
  totalReceived: number;
  realizedPnlSol: number;
  openCount: number;
  closedCount: number;
  stoppedCount: number;
  winRate: number;
}

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  const { dbPath } = loadConfig();
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  return db;
}

function initSchema(conn: Database.Database): void {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_mint TEXT NOT NULL,
      token_symbol TEXT,
      entry_price_sol REAL NOT NULL,
      current_price_sol REAL,
      amount_tokens REAL NOT NULL,
      amount_sol_spent REAL NOT NULL,
      amount_sol_received REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL CHECK (status IN ('open','partial','closed','stopped')),
      tp_level INTEGER NOT NULL DEFAULT 0,
      ai_score REAL,
      pool_address TEXT,
      entry_tx TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
    CREATE INDEX IF NOT EXISTS idx_positions_mint ON positions(token_mint);

    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      position_id INTEGER NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('buy','sell')),
      amount_tokens REAL NOT NULL,
      amount_sol REAL NOT NULL,
      price_sol REAL NOT NULL,
      tx_signature TEXT,
      simulated INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (position_id) REFERENCES positions(id)
    );

    CREATE INDEX IF NOT EXISTS idx_trades_position ON trades(position_id);

    CREATE TABLE IF NOT EXISTS rejected_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_mint TEXT NOT NULL,
      reason TEXT NOT NULL,
      ai_score REAL,
      pool_address TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_rejected_mint ON rejected_tokens(token_mint);
  `);
}

export function isTokenKnown(mint: string): boolean {
  const conn = getDb();
  const pos = conn
    .prepare('SELECT 1 FROM positions WHERE token_mint = ? LIMIT 1')
    .get(mint);
  if (pos) return true;
  const rej = conn
    .prepare('SELECT 1 FROM rejected_tokens WHERE token_mint = ? LIMIT 1')
    .get(mint);
  return !!rej;
}

export interface CreatePositionInput {
  tokenMint: string;
  tokenSymbol: string | null;
  entryPriceSol: number;
  amountTokens: number;
  amountSolSpent: number;
  aiScore: number | null;
  poolAddress: string | null;
  entryTx: string | null;
}

export function createPosition(input: CreatePositionInput): Position {
  const conn = getDb();
  const result = conn
    .prepare(
      `INSERT INTO positions
       (token_mint, token_symbol, entry_price_sol, current_price_sol, amount_tokens,
        amount_sol_spent, amount_sol_received, status, tp_level, ai_score, pool_address, entry_tx)
       VALUES (?, ?, ?, ?, ?, ?, 0, 'open', 0, ?, ?, ?)`
    )
    .run(
      input.tokenMint,
      input.tokenSymbol,
      input.entryPriceSol,
      input.entryPriceSol,
      input.amountTokens,
      input.amountSolSpent,
      input.aiScore,
      input.poolAddress,
      input.entryTx
    );
  const id = Number(result.lastInsertRowid);
  return getPosition(id)!;
}

export function getPosition(id: number): Position | null {
  const row = getDb().prepare('SELECT * FROM positions WHERE id = ?').get(id) as
    | Position
    | undefined;
  return row ?? null;
}

export function getOpenPositions(): Position[] {
  return getDb()
    .prepare("SELECT * FROM positions WHERE status IN ('open','partial') ORDER BY id")
    .all() as Position[];
}

export function countOpenPositions(): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) as c FROM positions WHERE status IN ('open','partial')")
    .get() as { c: number };
  return row.c;
}

export interface UpdatePositionInput {
  currentPriceSol?: number;
  amountTokens?: number;
  amountSolReceived?: number;
  status?: PositionStatus;
  tpLevel?: number;
}

export function updatePosition(id: number, input: UpdatePositionInput): void {
  const fields: string[] = [];
  const params: unknown[] = [];
  if (input.currentPriceSol !== undefined) {
    fields.push('current_price_sol = ?');
    params.push(input.currentPriceSol);
  }
  if (input.amountTokens !== undefined) {
    fields.push('amount_tokens = ?');
    params.push(input.amountTokens);
  }
  if (input.amountSolReceived !== undefined) {
    fields.push('amount_sol_received = ?');
    params.push(input.amountSolReceived);
  }
  if (input.status !== undefined) {
    fields.push('status = ?');
    params.push(input.status);
  }
  if (input.tpLevel !== undefined) {
    fields.push('tp_level = ?');
    params.push(input.tpLevel);
  }
  if (fields.length === 0) return;
  fields.push("updated_at = datetime('now')");
  params.push(id);
  getDb()
    .prepare(`UPDATE positions SET ${fields.join(', ')} WHERE id = ?`)
    .run(...params);
}

export interface RecordTradeInput {
  positionId: number;
  type: TradeType;
  amountTokens: number;
  amountSol: number;
  priceSol: number;
  txSignature: string | null;
  simulated: boolean;
}

export function recordTrade(input: RecordTradeInput): Trade {
  const result = getDb()
    .prepare(
      `INSERT INTO trades
       (position_id, type, amount_tokens, amount_sol, price_sol, tx_signature, simulated)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.positionId,
      input.type,
      input.amountTokens,
      input.amountSol,
      input.priceSol,
      input.txSignature,
      input.simulated ? 1 : 0
    );
  const id = Number(result.lastInsertRowid);
  return getDb().prepare('SELECT * FROM trades WHERE id = ?').get(id) as Trade;
}

export function getTradesForPosition(positionId: number): Trade[] {
  return getDb()
    .prepare('SELECT * FROM trades WHERE position_id = ? ORDER BY id')
    .all(positionId) as Trade[];
}

export interface RecordRejectionInput {
  tokenMint: string;
  reason: string;
  aiScore: number | null;
  poolAddress: string | null;
}

export function recordRejection(input: RecordRejectionInput): void {
  getDb()
    .prepare(
      `INSERT INTO rejected_tokens (token_mint, reason, ai_score, pool_address)
       VALUES (?, ?, ?, ?)`
    )
    .run(input.tokenMint, input.reason, input.aiScore, input.poolAddress);
}

export function getPnlSummary(): PnlSummary {
  const conn = getDb();
  const totals = conn
    .prepare(
      `SELECT
         COALESCE(SUM(amount_sol_spent),0) as spent,
         COALESCE(SUM(amount_sol_received),0) as received
       FROM positions`
    )
    .get() as { spent: number; received: number };
  const counts = conn
    .prepare(
      `SELECT
         SUM(CASE WHEN status IN ('open','partial') THEN 1 ELSE 0 END) as open_count,
         SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) as closed_count,
         SUM(CASE WHEN status = 'stopped' THEN 1 ELSE 0 END) as stopped_count
       FROM positions`
    )
    .get() as {
    open_count: number | null;
    closed_count: number | null;
    stopped_count: number | null;
  };
  const winRow = conn
    .prepare(
      `SELECT
         SUM(CASE WHEN amount_sol_received > amount_sol_spent THEN 1 ELSE 0 END) as wins,
         SUM(CASE WHEN status IN ('closed','stopped') THEN 1 ELSE 0 END) as finished
       FROM positions`
    )
    .get() as { wins: number | null; finished: number | null };
  const finished = winRow.finished ?? 0;
  const wins = winRow.wins ?? 0;
  return {
    totalSpent: totals.spent,
    totalReceived: totals.received,
    realizedPnlSol: totals.received - totals.spent,
    openCount: counts.open_count ?? 0,
    closedCount: counts.closed_count ?? 0,
    stoppedCount: counts.stopped_count ?? 0,
    winRate: finished > 0 ? wins / finished : 0,
  };
}

export interface FinishedPosition extends Position {
  pnl_sol: number;
  multiplier: number;
}

export function getFinishedPositions(): FinishedPosition[] {
  const rows = getDb()
    .prepare(
      `SELECT *,
              (amount_sol_received - amount_sol_spent) AS pnl_sol,
              CASE WHEN amount_sol_spent > 0
                   THEN amount_sol_received / amount_sol_spent
                   ELSE 0 END AS multiplier
       FROM positions
       WHERE status IN ('closed','stopped')
       ORDER BY pnl_sol DESC`
    )
    .all() as FinishedPosition[];
  return rows;
}

export function getTopRejectionReasons(
  limit = 10
): Array<{ reason: string; count: number }> {
  return getDb()
    .prepare(
      `SELECT reason, COUNT(*) AS count
       FROM rejected_tokens
       GROUP BY reason
       ORDER BY count DESC
       LIMIT ?`
    )
    .all(limit) as Array<{ reason: string; count: number }>;
}

export function getRejectionCount(): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS c FROM rejected_tokens')
    .get() as { c: number };
  return row.c;
}

export function getActivityWindow(): { first: string | null; last: string | null } {
  const conn = getDb();
  const pos = conn
    .prepare('SELECT MIN(created_at) AS first, MAX(updated_at) AS last FROM positions')
    .get() as { first: string | null; last: string | null };
  const rej = conn
    .prepare('SELECT MIN(created_at) AS first, MAX(created_at) AS last FROM rejected_tokens')
    .get() as { first: string | null; last: string | null };
  const first =
    [pos.first, rej.first].filter((s): s is string => !!s).sort()[0] ?? null;
  const last =
    [pos.last, rej.last].filter((s): s is string => !!s).sort().slice(-1)[0] ?? null;
  return { first, last };
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
