import pg from 'pg';
import { testDatabaseConfig } from '../../../scripts/test-db.mjs';

export const cfg = testDatabaseConfig();

/** Schema owner: catalogue writes and test resets only. */
// lock_timeout makes a test that leaks a lock fail fast instead of hanging the suite.
const options = '-c lock_timeout=10000 -c statement_timeout=20000';
export const owner = new pg.Pool({ connectionString: cfg.ownerUrl, max: 6, options });
/** PaySim application role (paysim_app): every PaySim-side test write goes through this. */
export const app = new pg.Pool({ connectionString: cfg.paysimAppUrl, max: 10, options });
/** Simulated bank role (simbank_app). */
export const bank = new pg.Pool({ connectionString: cfg.simbankAppUrl, max: 6, options });

export type Db = pg.Pool | pg.PoolClient;
export type Row = Record<string, unknown>;

export async function q<T extends Row = Row>(
  db: Db,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await db.query<T>(sql, params);
  return res.rows;
}

export async function one<T extends Row = Row>(
  db: Db,
  sql: string,
  params: unknown[] = [],
): Promise<T> {
  const rows = await q<T>(db, sql, params);
  const first = rows[0];
  if (rows.length !== 1 || first === undefined)
    throw new Error(`expected exactly one row, got ${rows.length}: ${sql}`);
  return first;
}

/** Runs fn in a transaction on a dedicated connection; commits on success, rolls back on error. */
export async function tx<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const result = await fn(c);
    await c.query('COMMIT');
    return result;
  } catch (error) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    c.release();
  }
}

/** An open transaction the test controls explicitly (for concurrency tests). */
export async function openTx(
  pool: pg.Pool,
): Promise<{ c: pg.PoolClient; commit: () => Promise<void>; rollback: () => Promise<void> }> {
  const c = await pool.connect();
  await c.query('BEGIN');
  let done = false;
  const finish = async (sql: string): Promise<void> => {
    if (done) return;
    done = true;
    try {
      await c.query(sql);
    } finally {
      c.release();
    }
  };
  return { c, commit: () => finish('COMMIT'), rollback: () => finish('ROLLBACK') };
}

const RESET_TABLES = [
  'simbank."BankWebhookDispatch"',
  'simbank."BankInstruction"',
  'simbank."SimulatedBankAccount"',
  'simbank."BankRunProfile"',
  'paysim."ReplayDivergence"',
  'paysim."AnomalyAction"',
  'paysim."AnomalyEvidence"',
  'paysim."Anomaly"',
  'paysim."EventProcessingAttempt"',
  'paysim."WebhookDelivery"',
  'paysim."ProviderEvent"',
  'paysim."Settlement"',
  'paysim."PaymentTransition"',
  'paysim."AttemptStatusChange"',
  'paysim."VerificationResult"',
  'paysim."BankInteractionResponse"',
  'paysim."BankInteractionRequest"',
  'paysim."PaymentAttempt"',
  'paysim."Approval"',
  'paysim."IdempotencyRecord"',
  'paysim."RecipientSnapshot"',
  'paysim."Payment"',
  'paysim."Recipient"',
  'paysim."InboundCommand"',
  'paysim."Claim"',
  'paysim."SimulatedBank"',
  'paysim."SimulationRun"',
  'simconfig."ConfigurationBankDefinition"',
  'simconfig."ConfigurationProfileVersion"',
  'simconfig."ConfigurationProfile"',
];

/** Empties every run-owned table and the configuration catalogue. Seeded operators are kept. */
export async function resetData(): Promise<void> {
  await owner.query(`TRUNCATE ${RESET_TABLES.join(', ')} CASCADE`);
}

/** Registers per-test reset and pool shutdown for a spec file. */
export function useDatabase(): void {
  beforeEach(resetData);
  afterAll(async () => {
    await Promise.all([owner.end(), app.end(), bank.end()]);
  });
}

/** Asserts a promise rejects with a PaySim trigger code (PAYSIM_<code>) or a PostgreSQL SQLSTATE. */
export async function expectDbError(
  promise: Promise<unknown>,
  codeOrState: string,
): Promise<pg.DatabaseError> {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof pg.DatabaseError)) throw error;
    const matches = /^\d{2}[0-9A-Z]{3}$/.test(codeOrState)
      ? error.code === codeOrState
      : error.message.startsWith(`PAYSIM_${codeOrState}:`);
    if (!matches)
      throw new Error(`expected ${codeOrState}, got ${error.code ?? ''} ${error.message}`, {
        cause: error,
      });
    return error;
  }
  throw new Error(`expected database error ${codeOrState}, but the operation succeeded`);
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves true if the promise is still pending after ms (used to prove a statement is blocked). */
export async function stillPending(p: Promise<unknown>, ms = 300): Promise<boolean> {
  const marker = Symbol('pending');
  const winner = await Promise.race([
    p.then(
      () => 'settled',
      () => 'settled',
    ),
    sleep(ms).then(() => marker),
  ]);
  return winner === marker;
}
