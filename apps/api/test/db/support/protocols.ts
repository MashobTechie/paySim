// Reference implementations of the database protocols in docs/transaction-design.md.
//
// They exist to verify that the schema, constraints and triggers support the protocols
// correctly under real PostgreSQL concurrency. They are NOT production services; Phase 4
// implements the services against the same protocols.
import pg from 'pg';
import { app, one, q, type Db } from './db.js';
import {
  API_VERSION,
  PROVIDER,
  canonicalJson,
  fingerprint,
  insertCommand,
  sha256,
} from './fixtures.js';

// ─── Keyed-command envelope (D28, C1, C2) ────────────────────────────────────

export type RejectionCode =
  | 'VALIDATION_FAILED'
  | 'INVALID_TRANSITION'
  | 'CLAIM_ALLOCATION_EXCEEDED'
  | 'SELF_APPROVAL_FORBIDDEN'
  | 'STALE_APPROVAL_TARGET'
  | 'FORBIDDEN'
  | 'VERSION_CONFLICT'
  | 'IDEMPOTENCY_KEY_REUSED';

const DETERMINISTIC = new Set<RejectionCode>([
  'VALIDATION_FAILED',
  'INVALID_TRANSITION',
  'CLAIM_ALLOCATION_EXCEEDED',
  'SELF_APPROVAL_FORBIDDEN',
  'STALE_APPROVAL_TARGET',
  'FORBIDDEN',
]);

const HTTP_STATUS: Record<RejectionCode, number> = {
  VALIDATION_FAILED: 400,
  INVALID_TRANSITION: 409,
  CLAIM_ALLOCATION_EXCEEDED: 422,
  SELF_APPROVAL_FORBIDDEN: 422,
  STALE_APPROVAL_TARGET: 409,
  FORBIDDEN: 403,
  VERSION_CONFLICT: 409,
  IDEMPOTENCY_KEY_REUSED: 422,
};

/** Database trigger codes (PAYSIM_<code>) that are business rejections. */
const TRIGGER_REJECTIONS: Record<string, RejectionCode> = {
  CLAIM_ALLOCATION_EXCEEDED: 'CLAIM_ALLOCATION_EXCEEDED',
  SELF_APPROVAL_FORBIDDEN: 'SELF_APPROVAL_FORBIDDEN',
  STALE_APPROVAL_TARGET: 'STALE_APPROVAL_TARGET',
  ILLEGAL_TRANSITION: 'INVALID_TRANSITION',
  INVALID_TRANSITION: 'INVALID_TRANSITION',
  VERSION_CONFLICT: 'VERSION_CONFLICT',
  FORBIDDEN: 'FORBIDDEN',
};

export class BusinessRejection extends Error {
  constructor(readonly code: RejectionCode) {
    super(code);
  }
}

function toRejection(error: unknown): RejectionCode | undefined {
  if (error instanceof BusinessRejection) return error.code;
  if (error instanceof pg.DatabaseError) {
    const m = /^PAYSIM_([A-Z_]+):/.exec(error.message);
    return m?.[1] ? TRIGGER_REJECTIONS[m[1]] : undefined;
  }
  return undefined;
}

export interface KeyedRequest {
  runId: string;
  actor: string;
  key: string;
  commandType: string;
  payload: unknown;
  apiVersion?: string;
  targetClaimId?: string;
  targetPaymentId?: string;
  successStatus?: number;
}

export interface KeyedResult {
  status: number;
  body: unknown;
  /** What this request durably recorded. */
  recorded: 'ACCEPTED' | 'REJECTED' | 'IDEMPOTENT_REPLAY' | 'NOTHING';
}

/**
 * The keyed-command envelope. `work` runs inside a savepoint after the ACCEPTED command row is
 * inserted (so effects can reference it). `hold`, if given, is awaited while the advisory lock
 * is held (used by concurrency tests).
 */
export async function executeKeyedCommand(
  req: KeyedRequest,
  work: (c: pg.PoolClient, commandId: string) => Promise<unknown>,
  hold?: () => Promise<void>,
): Promise<KeyedResult> {
  const apiVersion = req.apiVersion ?? API_VERSION;
  const fp = fingerprint(req.commandType, req.payload, apiVersion);
  const base = {
    runId: req.runId,
    type: req.commandType,
    actor: req.actor,
    key: req.key,
    payload: req.payload,
    apiVersion,
    targetClaimId: req.targetClaimId,
    targetPaymentId: req.targetPaymentId,
  };
  const c = await app.connect();
  let committing = false;
  try {
    await c.query('BEGIN');
    const lock = await one<{ ok: boolean }>(
      c,
      `SELECT pg_try_advisory_xact_lock(simconfig.idempotency_lock_key($1, $2, $3)) AS ok`,
      [req.runId, req.actor, req.key],
    );
    if (!lock.ok) {
      await c.query('ROLLBACK');
      return {
        status: 409,
        body: { code: 'IDEMPOTENCY_REQUEST_IN_PROGRESS' },
        recorded: 'NOTHING',
      };
    }
    if (hold) await hold();

    const existing = (
      await q<{
        requestFingerprint: string;
        commandId: string;
        responseStatus: number;
        responseBody: unknown;
      }>(
        c,
        `SELECT "requestFingerprint", "commandId", "responseStatus", "responseBody" FROM paysim."IdempotencyRecord"
          WHERE "simulationRunId" = $1 AND "actorId" = $2 AND "idempotencyKey" = $3`,
        [req.runId, req.actor, req.key],
      )
    )[0];
    if (existing) {
      if (existing.requestFingerprint === fp) {
        await insertCommand(c, {
          ...base,
          outcome: 'IDEMPOTENT_REPLAY',
          originalCommandId: existing.commandId,
        });
        committing = true;
        await c.query('COMMIT');
        return {
          status: existing.responseStatus,
          body: existing.responseBody,
          recorded: 'IDEMPOTENT_REPLAY',
        };
      }
      await insertCommand(c, {
        ...base,
        outcome: 'REJECTED',
        rejectionCode: 'IDEMPOTENCY_KEY_REUSED',
      });
      committing = true;
      await c.query('COMMIT');
      return { status: 422, body: { code: 'IDEMPOTENCY_KEY_REUSED' }, recorded: 'REJECTED' };
    }

    await c.query('SAVEPOINT work');
    try {
      const permitted = await one<{ ok: boolean }>(
        c,
        `SELECT simconfig.operator_has_permission($1, simconfig.command_permission($2::paysim."CommandType")) AS ok`,
        [req.actor, req.commandType],
      );
      if (!permitted.ok) throw new BusinessRejection('FORBIDDEN');
      const commandId = await insertCommand(c, { ...base, outcome: 'ACCEPTED' });
      const body = await work(c, commandId);
      const status = req.successStatus ?? 201;
      await insertIdempotency(c, req, fp, apiVersion, {
        outcome: 'ACCEPTED',
        status,
        body,
        commandId,
      });
      committing = true;
      await c.query('COMMIT'); // deferred constraints run here; a failure means nothing was recorded
      return { status, body, recorded: 'ACCEPTED' };
    } catch (error) {
      if (committing) throw error;
      const code = toRejection(error);
      if (!code) throw error;
      await c.query('ROLLBACK TO SAVEPOINT work');
      const commandId = await insertCommand(c, {
        ...base,
        outcome: 'REJECTED',
        rejectionCode: code,
      });
      const body = { code };
      if (DETERMINISTIC.has(code)) {
        await insertIdempotency(c, req, fp, apiVersion, {
          outcome: 'REJECTED',
          rejectionCode: code,
          status: HTTP_STATUS[code],
          body,
          commandId,
        });
      }
      committing = true;
      await c.query('COMMIT');
      return { status: HTTP_STATUS[code], body, recorded: 'REJECTED' };
    }
  } catch {
    // Unexpected error, or the final COMMIT failed: nothing is recorded; respond 5xx.
    await c.query('ROLLBACK').catch(() => undefined);
    return { status: 500, body: { code: 'INTERNAL_ERROR' }, recorded: 'NOTHING' };
  } finally {
    c.release();
  }
}

async function insertIdempotency(
  c: Db,
  req: KeyedRequest,
  fp: string,
  apiVersion: string,
  r: {
    outcome: 'ACCEPTED' | 'REJECTED';
    rejectionCode?: RejectionCode;
    status: number;
    body: unknown;
    commandId: string;
  },
): Promise<void> {
  await c.query(
    `INSERT INTO paysim."IdempotencyRecord"
       ("simulationRunId", "actorId", "idempotencyKey", "requestFingerprint", "commandType", "apiVersion", outcome, "rejectionCode", "responseStatus", "responseBody", "commandId")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      req.runId,
      req.actor,
      req.key,
      fp,
      req.commandType,
      apiVersion,
      r.outcome,
      r.rejectionCode ?? null,
      r.status,
      JSON.stringify(r.body),
      r.commandId,
    ],
  );
}

// ─── Webhook receipt (§8.2) ──────────────────────────────────────────────────

export async function receiveDelivery(
  db: Db,
  d: {
    runId: string;
    providerEventId: string;
    bankReference: string;
    payload: Record<string, unknown>;
    signatureValid?: boolean;
    rawBody?: Buffer;
  },
): Promise<{ outcome: string; eventRecordId: string | null }> {
  const raw = d.rawBody ?? Buffer.from(JSON.stringify(d.payload));
  const headers = JSON.stringify({
    'x-simbank-signature': 'sig',
    'content-type': 'application/json',
  });
  if (d.signatureValid === false) {
    await db.query(
      `INSERT INTO paysim."WebhookDelivery"("simulationRunId", "providerCode", "receivedAt", headers, "rawBody", "bodyHash", "signatureValid", "receiptOutcome", "httpStatus")
       VALUES ($1, $2, now(), $3, $4, $5, false, 'INVALID_SIGNATURE', 401)`,
      [d.runId, PROVIDER, headers, raw, sha256(raw)],
    );
    return { outcome: 'INVALID_SIGNATURE', eventRecordId: null };
  }
  const payloadHash = sha256(canonicalJson(d.payload));
  const inserted = await q<{ id: string }>(
    db,
    `INSERT INTO paysim."ProviderEvent"
       ("simulationRunId", "providerCode", "providerEventId", "eventType", "bankReference", "amountMinor", currency, "canonicalPayload", "payloadHash", "firstReceivedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
     ON CONFLICT ("simulationRunId", "providerCode", "providerEventId") DO NOTHING RETURNING id`,
    [
      d.runId,
      PROVIDER,
      d.providerEventId,
      typeof d.payload.type === 'string' ? d.payload.type : 'transfer.settled',
      d.bankReference,
      typeof d.payload.amountMinor === 'string' ? d.payload.amountMinor : null,
      typeof d.payload.currency === 'string' ? d.payload.currency : null,
      JSON.stringify(d.payload),
      payloadHash,
    ],
  );
  let eventRecordId: string;
  let outcome: string;
  if (inserted[0]) {
    eventRecordId = inserted[0].id;
    outcome = 'NEW_EVENT';
  } else {
    const existing = await one<{ id: string; payloadHash: string }>(
      db,
      `SELECT id, "payloadHash" FROM paysim."ProviderEvent" WHERE "simulationRunId" = $1 AND "providerCode" = $2 AND "providerEventId" = $3`,
      [d.runId, PROVIDER, d.providerEventId],
    );
    eventRecordId = existing.id;
    outcome = existing.payloadHash === payloadHash ? 'DUPLICATE_DELIVERY' : 'CONFLICTING_PAYLOAD';
  }
  await db.query(
    `INSERT INTO paysim."WebhookDelivery"
       ("simulationRunId", "providerCode", "receivedAt", headers, "rawBody", "bodyHash", "signatureValid", "receiptOutcome", "httpStatus", "providerEventRecordId")
     VALUES ($1, $2, now(), $3, $4, $5, true, $6, 200, $7)`,
    [d.runId, PROVIDER, headers, raw, sha256(raw), outcome, eventRecordId],
  );
  return { outcome, eventRecordId };
}

// ─── Event processing claims, fencing, exhaustion (§8.5) ─────────────────────

/** Atomic claim: returns the new claim token, or null if the event is not claimable. */
export async function claimEvent(
  db: Db,
  eventId: string,
  worker: string,
  leaseMs: number,
): Promise<string | null> {
  const rows = await q<{ claimToken: string }>(
    db,
    `UPDATE paysim."ProviderEvent" e
        SET "processingStatus" = 'PROCESSING', "claimToken" = simconfig.uuidv7(), "leaseOwner" = $2,
            "leaseExpiresAt" = now() + ($3 * interval '1 millisecond'), "attemptCount" = e."attemptCount" + 1
       FROM paysim."SimulationRun" r
      WHERE e.id = $1 AND r.id = e."simulationRunId" AND e."attemptCount" < r."eventRetryLimit"
        AND (e."processingStatus" = 'RECEIVED'
             OR (e."processingStatus" = 'PROCESSING_ERROR' AND (e."nextAttemptAt" IS NULL OR e."nextAttemptAt" <= now()))
             OR (e."processingStatus" = 'PROCESSING' AND e."leaseExpiresAt" <= now()))
      RETURNING e."claimToken"`,
    [eventId, worker, leaseMs],
  );
  return rows[0]?.claimToken ?? null;
}

export class FencedError extends Error {}

/** Fenced finalisation inside the caller's processing transaction. Throws FencedError if the claim was lost. */
export async function finalizeEvent(
  c: Db,
  f: {
    runId: string;
    eventId: string;
    token: string;
    worker: string;
    outcome: string;
    reason?: string;
  },
): Promise<void> {
  const rows = await q(
    c,
    `UPDATE paysim."ProviderEvent" SET "processingStatus" = 'PROCESSED', outcome = $3, "outcomeReason" = $4, "processedAt" = now()
      WHERE id = $1 AND "claimToken" = $2 AND "processingStatus" = 'PROCESSING' RETURNING id`,
    [f.eventId, f.token, f.outcome, f.reason ?? null],
  );
  if (rows.length === 0) throw new FencedError('claim lost');
  await logProcessingAttempt(c, { ...f, result: 'COMPLETED' });
}

export async function logProcessingAttempt(
  c: Db,
  a: {
    runId: string;
    eventId: string;
    token: string;
    worker: string;
    result: 'COMPLETED' | 'TECHNICAL_ERROR' | 'LEASE_EXPIRED';
    error?: string;
  },
): Promise<string> {
  const row = await one<{ id: string }>(
    c,
    `INSERT INTO paysim."EventProcessingAttempt"("simulationRunId", "providerEventRecordId", "claimToken", worker, "claimedAt", "endedAt", result, error)
     VALUES ($1, $2, $3, $4, now(), now(), $5, $6) RETURNING id`,
    [
      a.runId,
      a.eventId,
      a.token,
      a.worker,
      a.result,
      a.error ?? (a.result === 'COMPLETED' ? null : a.result),
    ],
  );
  return row.id;
}

/** Opens an anomaly with its evidence and OPENED action, atomically (I16, L4). */
export async function openAnomaly(
  c: Db,
  a: {
    runId: string;
    type: string;
    severity: 'CRITICAL' | 'ATTENTION';
    evidenceKey: string;
    paymentId?: string | null;
    attemptId?: string | null;
    eventId?: string | null;
    evidence: {
      type: 'PROCESSING_ATTEMPT' | 'PROVIDER_EVENT' | 'ATTEMPT_STATUS_CHANGE';
      id: string;
    }[];
    relatedAnomalyId?: string;
  },
): Promise<string> {
  const anomaly = await one<{ id: string }>(
    c,
    `INSERT INTO paysim."Anomaly"("simulationRunId", "anomalyType", severity, "evidenceKey", "paymentId", "attemptId", "providerEventRecordId", "relatedAnomalyId", detector, "detectedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'test-detector', now()) RETURNING id`,
    [
      a.runId,
      a.type,
      a.severity,
      a.evidenceKey,
      a.paymentId ?? null,
      a.attemptId ?? null,
      a.eventId ?? null,
      a.relatedAnomalyId ?? null,
    ],
  );
  for (const e of a.evidence) await addEvidence(c, { runId: a.runId, anomalyId: anomaly.id, ...e });
  await c.query(
    `INSERT INTO paysim."AnomalyAction"("simulationRunId", "anomalyId", "sequenceNo", "actionType", "actorType", "actorId", "causeType", "causeJob", reason)
     VALUES ($1, $2, 1, 'OPENED', 'SYSTEM', 'system:detector', 'SYSTEM_JOB', 'detector', 'detected')`,
    [a.runId, anomaly.id],
  );
  await c.query(`UPDATE paysim."Anomaly" SET "lastActionSequenceNo" = 1 WHERE id = $1`, [
    anomaly.id,
  ]);
  return anomaly.id;
}

export async function addEvidence(
  c: Db,
  e: { runId: string; anomalyId: string; type: string; id: string },
): Promise<void> {
  const col = {
    PROCESSING_ATTEMPT: 'evidenceProcessingAttemptId',
    PROVIDER_EVENT: 'evidenceProviderEventId',
    ATTEMPT_STATUS_CHANGE: 'evidenceAttemptStatusChangeId',
  }[e.type];
  if (!col) throw new Error(`unsupported evidence type ${e.type}`);
  await c.query(
    `INSERT INTO paysim."AnomalyEvidence"("simulationRunId", "anomalyId", "evidenceType", "${col}") VALUES ($1, $2, $3, $4)`,
    [e.runId, e.anomalyId, e.type, e.id],
  );
}

/** Appends an anomaly action and updates the recorded status in the same transaction (L4). */
export async function addAnomalyAction(
  c: Db,
  a: {
    runId: string;
    anomalyId: string;
    action: 'RESOLVED' | 'REOPENED' | 'NOTE_ADDED';
    actorType: 'USER' | 'SYSTEM';
    actorId: string;
    cause:
      | { type: 'INBOUND_COMMAND'; commandId: string }
      | { type: 'PROCESSING_ATTEMPT'; id: string }
      | { type: 'SYSTEM_JOB'; job: string };
    resolutionType?: string;
    updateStatus?: boolean;
  },
): Promise<void> {
  const seq = await one<{ n: number }>(
    c,
    `SELECT coalesce(max("sequenceNo"), 0) + 1 AS n FROM paysim."AnomalyAction" WHERE "anomalyId" = $1`,
    [a.anomalyId],
  );
  await c.query(
    `INSERT INTO paysim."AnomalyAction"
       ("simulationRunId", "anomalyId", "sequenceNo", "actionType", "actorType", "actorId", "causeType", "causeCommandId", "causeProcessingAttemptId", "causeJob", reason, "resolutionType")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'test reason', $11)`,
    [
      a.runId,
      a.anomalyId,
      seq.n,
      a.action,
      a.actorType,
      a.actorId,
      a.cause.type,
      a.cause.type === 'INBOUND_COMMAND' ? a.cause.commandId : null,
      a.cause.type === 'PROCESSING_ATTEMPT' ? a.cause.id : null,
      a.cause.type === 'SYSTEM_JOB' ? a.cause.job : null,
      a.resolutionType ?? null,
    ],
  );
  if (a.updateStatus !== false) {
    const status =
      a.action === 'RESOLVED' ? `'RESOLVED'` : a.action === 'REOPENED' ? `'OPEN'` : 'status';
    await c.query(
      `UPDATE paysim."Anomaly" SET status = ${status}, "lastActionSequenceNo" = $2 WHERE id = $1`,
      [a.anomalyId, seq.n],
    );
  }
}

/**
 * Technical failure of a claimed event: PROCESSING_ERROR, or PROCESSING_EXHAUSTED at the limit,
 * in which case an EVENT_PROCESSING_EXHAUSTED anomaly is opened (critical if the event resolves
 * to a known attempt).
 */
export async function failEvent(
  c: Db,
  f: { runId: string; eventId: string; token: string; worker: string; error: string },
): Promise<{ status: string; anomalyId?: string }> {
  const ev = await one<{
    attemptCount: number;
    limit: number;
    requeueGeneration: number;
    bankReference: string;
  }>(
    c,
    `SELECT e."attemptCount", r."eventRetryLimit" AS "limit", e."requeueGeneration", e."bankReference"
       FROM paysim."ProviderEvent" e JOIN paysim."SimulationRun" r ON r.id = e."simulationRunId" WHERE e.id = $1`,
    [f.eventId],
  );
  const exhausted = ev.attemptCount >= ev.limit;
  const rows = await q(
    c,
    exhausted
      ? `UPDATE paysim."ProviderEvent" SET "processingStatus" = 'PROCESSING_EXHAUSTED', "lastError" = $3 WHERE id = $1 AND "claimToken" = $2 AND "processingStatus" = 'PROCESSING' RETURNING id`
      : `UPDATE paysim."ProviderEvent" SET "processingStatus" = 'PROCESSING_ERROR', "lastError" = $3, "nextAttemptAt" = now() WHERE id = $1 AND "claimToken" = $2 AND "processingStatus" = 'PROCESSING' RETURNING id`,
    [f.eventId, f.token, f.error],
  );
  if (rows.length === 0) throw new FencedError('claim lost');
  const attemptLogId = await logProcessingAttempt(c, { ...f, result: 'TECHNICAL_ERROR' });
  if (!exhausted) return { status: 'PROCESSING_ERROR' };
  const anomalyId = await openExhaustionAnomaly(
    c,
    f.runId,
    f.eventId,
    ev.bankReference,
    ev.requeueGeneration,
    attemptLogId,
  );
  return { status: 'PROCESSING_EXHAUSTED', anomalyId };
}

export async function openExhaustionAnomaly(
  c: Db,
  runId: string,
  eventId: string,
  bankReference: string,
  generation: number,
  attemptLogId: string,
): Promise<string> {
  const attempt = (
    await q<{ id: string; paymentId: string }>(
      c,
      `SELECT id, "paymentId" FROM paysim."PaymentAttempt" WHERE "simulationRunId" = $1 AND "bankReference" = $2`,
      [runId, bankReference],
    )
  )[0];
  return openAnomaly(c, {
    runId,
    type: 'EVENT_PROCESSING_EXHAUSTED',
    severity: attempt ? 'CRITICAL' : 'ATTENTION',
    evidenceKey: `event:${eventId}:generation:${generation}`,
    paymentId: attempt?.paymentId ?? null,
    attemptId: attempt?.id ?? null,
    eventId,
    evidence: [{ type: 'PROCESSING_ATTEMPT', id: attemptLogId }],
  });
}

/** Sweeper for a PROCESSING event whose lease expired: logs LEASE_EXPIRED; exhausts at the limit. */
export async function sweepExpired(
  c: Db,
  runId: string,
  eventId: string,
): Promise<'RECLAIMABLE' | 'EXHAUSTED' | 'NOT_EXPIRED'> {
  const ev = await one<{
    status: string;
    token: string;
    expired: boolean;
    attemptCount: number;
    limit: number;
    requeueGeneration: number;
    bankReference: string;
  }>(
    c,
    `SELECT e."processingStatus" AS status, e."claimToken" AS token, e."leaseExpiresAt" <= now() AS expired, e."attemptCount",
            r."eventRetryLimit" AS "limit", e."requeueGeneration", e."bankReference"
       FROM paysim."ProviderEvent" e JOIN paysim."SimulationRun" r ON r.id = e."simulationRunId" WHERE e.id = $1 FOR NO KEY UPDATE OF e`,
    [eventId],
  );
  if (ev.status !== 'PROCESSING' || !ev.expired) return 'NOT_EXPIRED';
  const logId = await logProcessingAttempt(c, {
    runId,
    eventId,
    token: ev.token,
    worker: 'sweeper',
    result: 'LEASE_EXPIRED',
  });
  if (ev.attemptCount < ev.limit) return 'RECLAIMABLE';
  await c.query(
    `UPDATE paysim."ProviderEvent" SET "processingStatus" = 'PROCESSING_EXHAUSTED', "lastError" = 'LEASE_EXPIRED' WHERE id = $1`,
    [eventId],
  );
  await openExhaustionAnomaly(c, runId, eventId, ev.bankReference, ev.requeueGeneration, logId);
  return 'EXHAUSTED';
}

// ─── Status-polling claims (§5.8, C4) ────────────────────────────────────────

export async function claimPoll(
  db: Db,
  attemptId: string,
  leaseMs: number,
): Promise<{ token: string; generation: number } | null> {
  const rows = await q<{ token: string; generation: number }>(
    db,
    `UPDATE paysim."PaymentAttempt" SET "pollClaimToken" = simconfig.uuidv7(), "pollLeaseExpiresAt" = now() + ($2 * interval '1 millisecond'),
            "pollGeneration" = "pollGeneration" + 1, "updatedAt" = now()
      WHERE id IN (SELECT id FROM paysim."PaymentAttempt"
                    WHERE id = $1 AND status IN ('SUBMITTED', 'UNKNOWN') AND ("pollClaimToken" IS NULL OR "pollLeaseExpiresAt" <= now())
                    FOR UPDATE SKIP LOCKED)
      RETURNING "pollClaimToken" AS token, "pollGeneration" AS generation`,
    [attemptId, leaseMs],
  );
  return rows[0] ?? null;
}

// ─── Replay playback adapter (D26) ───────────────────────────────────────────

export interface PlaybackResult {
  served: 'RECORDED' | 'NO_RESPONSE';
  divergence?: 'REQUEST_MISMATCH' | 'PLAYBACK_MISS';
  classification: string;
}

/**
 * Answers a replay-run bank request from the source run's recordings: locate by
 * (type, readable key, occurrence), compare payload hashes, and record the replay response
 * (and any divergence) in the replay run.
 */
export async function playback(
  c: Db,
  p: { replayRunId: string; sourceRunId: string; replayRequestId: string },
): Promise<PlaybackResult> {
  const rq = await one<{
    interactionType: string;
    readableKey: string;
    occurrenceNo: number;
    payloadHash: string;
  }>(
    c,
    `SELECT "interactionType", "readableKey", "occurrenceNo", "payloadHash" FROM paysim."BankInteractionRequest" WHERE id = $1`,
    [p.replayRequestId],
  );
  const src = (
    await q<{
      id: string;
      payloadHash: string;
      responseId: string | null;
      kind: string | null;
      classification: string | null;
      httpStatus: number | null;
      body: unknown;
    }>(
      c,
      `SELECT q.id, q."payloadHash", r.id AS "responseId", r.kind, r.classification, r."httpStatus", r.body
         FROM paysim."BankInteractionRequest" q LEFT JOIN paysim."BankInteractionResponse" r ON r."requestId" = q.id
        WHERE q."simulationRunId" = $1 AND q."providerCode" = $2 AND q."interactionType" = $3 AND q."readableKey" = $4 AND q."occurrenceNo" = $5`,
      [p.sourceRunId, PROVIDER, rq.interactionType, rq.readableKey, rq.occurrenceNo],
    )
  )[0];

  let result: PlaybackResult;
  if (!src) {
    await divergence(c, {
      ...p,
      type: 'PLAYBACK_MISS',
      key: `replayRequest:${p.replayRequestId}`,
      replayBankRequestId: p.replayRequestId,
    });
    result = { served: 'NO_RESPONSE', divergence: 'PLAYBACK_MISS', classification: 'NO_RESPONSE' };
  } else if (src.payloadHash !== rq.payloadHash) {
    await divergence(c, {
      ...p,
      type: 'REQUEST_MISMATCH',
      key: `sourceRequest:${src.id}`,
      sourceBankRequestId: src.id,
      replayBankRequestId: p.replayRequestId,
      sourcePayloadHash: src.payloadHash,
      replayPayloadHash: rq.payloadHash,
    });
    result = {
      served: 'NO_RESPONSE',
      divergence: 'REQUEST_MISMATCH',
      classification: 'NO_RESPONSE',
    };
  } else if (!src.responseId) {
    result = { served: 'NO_RESPONSE', classification: 'NO_RESPONSE' };
  } else {
    result = { served: 'RECORDED', classification: src.classification ?? 'NO_RESPONSE' };
  }
  const recorded = result.served === 'RECORDED' && src;
  await c.query(
    `INSERT INTO paysim."BankInteractionResponse"("simulationRunId", "requestId", "receivedAt", kind, "httpStatus", body, classification, "elapsedMs")
     VALUES ($1, $2, now(), $3, $4, $5, $6, 0)`,
    [
      p.replayRunId,
      p.replayRequestId,
      recorded ? src.kind : 'NO_RESPONSE',
      recorded ? src.httpStatus : null,
      recorded ? JSON.stringify(src.body) : null,
      result.classification,
    ],
  );
  return result;
}

/** End of replay: every source request the replay never made is an UNUSED_RECORDING. */
export async function finishPlayback(
  c: Db,
  p: { replayRunId: string; sourceRunId: string },
): Promise<number> {
  const unused = await q<{ id: string }>(
    c,
    `SELECT s.id FROM paysim."BankInteractionRequest" s
      WHERE s."simulationRunId" = $1
        AND NOT EXISTS (SELECT 1 FROM paysim."BankInteractionRequest" r
                         WHERE r."simulationRunId" = $2 AND r."providerCode" = s."providerCode" AND r."interactionType" = s."interactionType"
                           AND r."readableKey" = s."readableKey" AND r."occurrenceNo" = s."occurrenceNo")`,
    [p.sourceRunId, p.replayRunId],
  );
  for (const u of unused) {
    await divergence(c, {
      ...p,
      type: 'UNUSED_RECORDING',
      key: `sourceRequest:${u.id}`,
      sourceBankRequestId: u.id,
    });
  }
  return unused.length;
}

export async function divergence(
  c: Db,
  d: {
    replayRunId: string;
    sourceRunId: string;
    type: string;
    key: string;
    sourceBankRequestId?: string;
    replayBankRequestId?: string;
    sourceCommandId?: string;
    sourcePayloadHash?: string;
    replayPayloadHash?: string;
  },
): Promise<void> {
  await c.query(
    `INSERT INTO paysim."ReplayDivergence"
       ("simulationRunId", "sourceRunId", "divergenceType", "divergenceKey", "sourceBankRequestId", "replayBankRequestId", "sourceCommandId",
        "sourcePayloadHash", "replayPayloadHash", "detectedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())`,
    [
      d.replayRunId,
      d.sourceRunId,
      d.type,
      d.key,
      d.sourceBankRequestId ?? null,
      d.replayBankRequestId ?? null,
      d.sourceCommandId ?? null,
      d.sourcePayloadHash ?? null,
      d.replayPayloadHash ?? null,
    ],
  );
}
