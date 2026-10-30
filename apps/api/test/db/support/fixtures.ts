import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { app, bank, one, owner, q, tx, type Db } from './db.js';

// ─── Canonical hashing (fingerprints, payload hashes) ────────────────────────

export const sha256 = (input: string | Buffer): string =>
  createHash('sha256').update(input).digest('hex');

/** Canonical JSON: recursively sorted keys, no whitespace. Money must already be digit strings. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export const API_VERSION = 'v1';

/** Correction C1: fingerprint = sha256(canonical {commandType, apiVersion, payload}). */
export function fingerprint(
  commandType: string,
  payload: unknown,
  apiVersion = API_VERSION,
): string {
  return sha256(canonicalJson({ commandType, apiVersion, payload }));
}

export const PROVIDER = 'SIMBANK';

// ─── Configuration catalogue and runs ────────────────────────────────────────

export interface ProfileOptions {
  eventRetryLimit?: number;
  processingLeaseMs?: number;
  pollLeaseMs?: number;
  settlementWindowMs?: number;
  acceptanceTtlMs?: number;
  attemptRetryLimit?: number;
}

/** Publishes a configuration profile version (catalogue writes are owner-only). */
export async function createProfile(opts: ProfileOptions = {}): Promise<string> {
  const profile = await one<{ id: string }>(
    owner,
    `INSERT INTO simconfig."ConfigurationProfile"(name) VALUES ($1) RETURNING id`,
    [`profile-${randomUUID()}`],
  );
  const rules = { rules: [] as unknown[] };
  const version = await one<{ id: string }>(
    owner,
    `INSERT INTO simconfig."ConfigurationProfileVersion"
       ("profileId", "versionNo", "contentHash", "eventRetryLimit", "eventBackoffBaseMs", "processingLeaseMs", "pollLeaseMs", "failureInjectionRules")
     VALUES ($1, 1, $2, $3, 30000, $4, $5, $6) RETURNING id`,
    [
      profile.id,
      sha256(canonicalJson(rules)),
      opts.eventRetryLimit ?? 5,
      opts.processingLeaseMs ?? 60_000,
      opts.pollLeaseMs ?? 60_000,
      JSON.stringify(rules),
    ],
  );
  await owner.query(
    `INSERT INTO simconfig."ConfigurationBankDefinition"
       ("profileVersionId", "providerCode", "settlementWindowMs", "acceptanceTtlMs", "escalationThresholdMs", "attemptRetryLimit", "attemptBackoffMs", "queryabilityGuaranteed")
     VALUES ($1, $2, $3, $4, 600000, $5, $6, true)`,
    [
      version.id,
      PROVIDER,
      opts.settlementWindowMs ?? 120_000,
      opts.acceptanceTtlMs ?? 300_000,
      opts.attemptRetryLimit ?? 3,
      [60_000, 300_000, 1_800_000],
    ],
  );
  return version.id;
}

export interface Run {
  runId: string;
  versionId: string;
  ingressKey: string;
  secret: string;
}

/** Creates a run, materialises its bank on both sides (paysim_app and simbank_app) and activates it. */
export async function createRun(
  versionId: string,
  opts: {
    type?: 'SCENARIO' | 'REPLAY';
    sourceRunId?: string | undefined;
    secret?: string | undefined;
    activate?: boolean;
  } = {},
): Promise<Run> {
  const run = await one<{ id: string }>(
    app,
    `INSERT INTO paysim."SimulationRun"
       (type, "sourceRunId", "configurationProfileVersionId", "eventRetryLimit", "eventBackoffBaseMs", "processingLeaseMs", "pollLeaseMs")
     SELECT $1, $2, id, "eventRetryLimit", "eventBackoffBaseMs", "processingLeaseMs", "pollLeaseMs"
       FROM simconfig."ConfigurationProfileVersion" WHERE id = $3
     RETURNING id`,
    [opts.type ?? 'SCENARIO', opts.sourceRunId ?? null, versionId],
  );
  const secret = opts.secret ?? randomBytes(32).toString('hex');
  const ingressKey = randomBytes(32).toString('base64url'); // 256-bit, cryptographically random (S2)
  await app.query(
    `INSERT INTO paysim."SimulatedBank"
       ("simulationRunId", "providerCode", "settlementWindowMs", "acceptanceTtlMs", "escalationThresholdMs",
        "attemptRetryLimit", "attemptBackoffMs", "queryabilityGuaranteed", "signingSecret", "ingressKeyHash")
     SELECT $1, "providerCode", "settlementWindowMs", "acceptanceTtlMs", "escalationThresholdMs",
            "attemptRetryLimit", "attemptBackoffMs", "queryabilityGuaranteed", $2, $3
       FROM simconfig."ConfigurationBankDefinition" WHERE "profileVersionId" = $4`,
    [run.id, secret, sha256(ingressKey), versionId],
  );
  await bank.query(
    `INSERT INTO simbank."BankRunProfile"
       ("simulationRunId", "providerCode", "settlementWindowMs", "acceptanceTtlMs", "signingSecret", "webhookIngressKey")
     SELECT $1, "providerCode", "settlementWindowMs", "acceptanceTtlMs", $2, $3
       FROM simconfig."ConfigurationBankDefinition" WHERE "profileVersionId" = $4`,
    [run.id, secret, ingressKey, versionId],
  );
  if (opts.activate !== false) await activateRun(run.id);
  return { runId: run.id, versionId, ingressKey, secret };
}

export async function activateRun(runId: string): Promise<void> {
  await app.query(
    `UPDATE paysim."SimulationRun" SET status = 'ACTIVE', "activatedAt" = now() WHERE id = $1`,
    [runId],
  );
}

export async function completeRun(db: Db, runId: string): Promise<void> {
  await db.query(
    `UPDATE paysim."SimulationRun" SET status = 'COMPLETED', "completedAt" = now() WHERE id = $1`,
    [runId],
  );
}

export async function createClaim(
  db: Db,
  runId: string,
  amountMinor = '250000000',
  currency = 'NGN',
): Promise<string> {
  const claim = await one<{ id: string }>(
    db,
    `INSERT INTO paysim."Claim"("simulationRunId", "claimRef", "approvedPayableAmountMinor", currency, "approvedForPayout")
     VALUES ($1, $2, $3, $4, true) RETURNING id`,
    [runId, `CLM-${randomUUID().slice(0, 8)}`, amountMinor, currency],
  );
  return claim.id;
}

// ─── Commands ────────────────────────────────────────────────────────────────

export interface CommandInput {
  runId: string;
  type: string;
  actor?: string | undefined;
  key?: string | null | undefined;
  payload?: unknown;
  apiVersion?: string | undefined;
  outcome?: 'ACCEPTED' | 'REJECTED' | 'IDEMPOTENT_REPLAY' | undefined;
  rejectionCode?: string | undefined;
  targetPaymentId?: string | undefined;
  targetClaimId?: string | undefined;
  originalCommandId?: string | undefined;
  resultingPaymentReference?: string | undefined;
}

export async function insertCommand(db: Db, c: CommandInput): Promise<string> {
  const payload = c.payload ?? {};
  const row = await one<{ id: string }>(
    db,
    `INSERT INTO paysim."InboundCommand"
       ("simulationRunId", "commandType", "apiVersion", "actorType", "actorId", "requestId", "idempotencyKey",
        "requestFingerprint", payload, "targetPaymentId", "targetClaimId", outcome, "rejectionCode",
        "originalCommandId", "resultingPaymentReference", "receivedAt")
     VALUES ($1, $2, $3, 'USER', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, now()) RETURNING id`,
    [
      c.runId,
      c.type,
      c.apiVersion ?? API_VERSION,
      c.actor ?? 'ops-01',
      randomUUID(),
      c.key === undefined ? randomUUID() : c.key,
      fingerprint(c.type, payload, c.apiVersion ?? API_VERSION),
      JSON.stringify(payload),
      c.targetPaymentId ?? null,
      c.targetClaimId ?? null,
      c.outcome ?? 'ACCEPTED',
      c.rejectionCode ?? null,
      c.originalCommandId ?? null,
      c.resultingPaymentReference ?? null,
    ],
  );
  return row.id;
}

// ─── Causes (typed references, DM5) ─────────────────────────────────────────

export type Cause =
  | { type: 'INBOUND_COMMAND'; commandId: string; actor: string }
  | { type: 'PROVIDER_EVENT'; eventId: string }
  | { type: 'BANK_RESPONSE'; responseId: string }
  | { type: 'SYSTEM_JOB'; job: string };

function causeColumns(cause: Cause) {
  return {
    causeType: cause.type,
    commandId: cause.type === 'INBOUND_COMMAND' ? cause.commandId : null,
    eventId: cause.type === 'PROVIDER_EVENT' ? cause.eventId : null,
    responseId: cause.type === 'BANK_RESPONSE' ? cause.responseId : null,
    job: cause.type === 'SYSTEM_JOB' ? cause.job : null,
    actorType:
      cause.type === 'INBOUND_COMMAND'
        ? 'USER'
        : cause.type === 'PROVIDER_EVENT'
          ? 'PROVIDER'
          : 'SYSTEM',
    actorId:
      cause.type === 'INBOUND_COMMAND'
        ? cause.actor
        : cause.type === 'PROVIDER_EVENT'
          ? `provider:${PROVIDER}`
          : cause.type === 'SYSTEM_JOB'
            ? `system:${cause.job}`
            : 'system:poller',
  };
}

// ─── Payment flow building blocks (each runs inside the caller's transaction) ─

/** Updates the payment status (version + 1) and appends the matching transition (I5). */
export async function transition(
  c: Db,
  t: {
    runId: string;
    paymentId: string;
    to: string;
    trigger: string;
    cause: Cause;
    reason?: string;
    relatedAttemptId?: string;
  },
): Promise<void> {
  const current = await one<{ status: string }>(
    c,
    `SELECT status FROM paysim."Payment" WHERE id = $1 FOR NO KEY UPDATE`,
    [t.paymentId],
  );
  const nextDispatch =
    t.to === 'READY_FOR_PAYMENT' ? 'now()' : t.to === 'PROCESSING' ? 'NULL' : '"nextDispatchAt"';
  await c.query(
    `UPDATE paysim."Payment" SET status = $2, version = version + 1, "updatedAt" = now(), "nextDispatchAt" = ${nextDispatch} WHERE id = $1`,
    [t.paymentId, t.to],
  );
  const seq = await one<{ n: number }>(
    c,
    `SELECT coalesce(max("sequenceNo"), 0) + 1 AS n FROM paysim."PaymentTransition" WHERE "paymentId" = $1`,
    [t.paymentId],
  );
  const k = causeColumns(t.cause);
  await c.query(
    `INSERT INTO paysim."PaymentTransition"
       ("simulationRunId", "paymentId", "sequenceNo", "fromStatus", "toStatus", trigger, "causeType", "causeCommandId",
        "causeProviderEventId", "causeBankResponseId", "causeJob", "relatedAttemptId", "actorType", "actorId", reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [
      t.runId,
      t.paymentId,
      seq.n,
      current.status,
      t.to,
      t.trigger,
      k.causeType,
      k.commandId,
      k.eventId,
      k.responseId,
      k.job,
      t.relatedAttemptId ?? null,
      k.actorType,
      k.actorId,
      t.reason ?? null,
    ],
  );
}

export interface Payout {
  paymentId: string;
  snapshotId: string;
  reference: string;
  commandId: string;
}

/** T1: payment + snapshot S1 + transition #1, caused by an accepted CREATE_PAYOUT command. */
export async function createPayout(
  c: Db,
  p: {
    runId: string;
    claimId: string;
    amountMinor?: string | undefined;
    currency?: string;
    actor?: string;
    reference?: string | undefined;
    commandId?: string;
  },
): Promise<Payout> {
  const actor = p.actor ?? 'ops-01';
  const amountMinor = p.amountMinor ?? '250000000';
  const commandId =
    p.commandId ??
    (await insertCommand(c, {
      runId: p.runId,
      type: 'CREATE_PAYOUT',
      actor,
      payload: { claimId: p.claimId, amountMinor },
      targetClaimId: p.claimId,
    }));
  const reference =
    p.reference ??
    (await one<{ r: string }>(c, `SELECT paysim.next_payment_reference(2026) AS r`)).r;
  const payment = await one<{ id: string }>(
    c,
    `INSERT INTO paysim."Payment"("simulationRunId", reference, "paymentType", "claimId", "amountMinor", currency, status, "createdByActorId", "createdByCommandId")
     VALUES ($1, $2, 'CLAIM_PAYOUT', $3, $4, $5, 'PENDING_RECIPIENT_VERIFICATION', $6, $7) RETURNING id`,
    [p.runId, reference, p.claimId, amountMinor, p.currency ?? 'NGN', actor, commandId],
  );
  const snapshot = await one<{ id: string }>(
    c,
    `INSERT INTO paysim."RecipientSnapshot"("simulationRunId", "paymentId", "snapshotNo", "bankCode", "accountNumber", "accountName", "createdByCommandId")
     VALUES ($1, $2, 1, 'SIM', '0000123456', 'Ngozi Testperson', $3) RETURNING id`,
    [p.runId, payment.id, commandId],
  );
  await c.query(`UPDATE paysim."Payment" SET "currentSnapshotId" = $1 WHERE id = $2`, [
    snapshot.id,
    payment.id,
  ]);
  await c.query(
    `INSERT INTO paysim."PaymentTransition"("simulationRunId", "paymentId", "sequenceNo", "fromStatus", "toStatus", trigger, "causeType", "causeCommandId", "actorType", "actorId")
     VALUES ($1, $2, 1, NULL, 'PENDING_RECIPIENT_VERIFICATION', 'PAYMENT_CREATED', 'INBOUND_COMMAND', $3, 'USER', $4)`,
    [p.runId, payment.id, commandId, actor],
  );
  return { paymentId: payment.id, snapshotId: snapshot.id, reference, commandId };
}

export interface BankRequest {
  id: string;
  payloadHash: string;
  occurrenceNo: number;
}

/** Records a bank interaction request (insert-only, next gap-free occurrence for its key). */
export async function bankRequest(
  c: Db,
  r: {
    runId: string;
    type: 'VERIFY_ACCOUNT' | 'DISPATCH' | 'STATUS_QUERY';
    snapshotId?: string;
    attemptId?: string;
    key: string;
    payload?: unknown;
    pollGeneration?: number | undefined;
  },
): Promise<BankRequest> {
  const occ = await one<{ n: number }>(
    c,
    `SELECT coalesce(max("occurrenceNo"), 0) + 1 AS n FROM paysim."BankInteractionRequest"
      WHERE "simulationRunId" = $1 AND "providerCode" = $2 AND "interactionType" = $3 AND "readableKey" = $4`,
    [r.runId, PROVIDER, r.type, r.key],
  );
  const payload = r.payload ?? { type: r.type, key: r.key };
  const payloadHash = sha256(canonicalJson(payload));
  const row = await one<{ id: string }>(
    c,
    `INSERT INTO paysim."BankInteractionRequest"
       ("simulationRunId", "providerCode", "interactionType", "subjectType", "subjectSnapshotId", "subjectAttemptId",
        "readableKey", "occurrenceNo", "pollGeneration", "canonicalPayload", "payloadHash", "sentAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now()) RETURNING id`,
    [
      r.runId,
      PROVIDER,
      r.type,
      r.snapshotId ? 'SNAPSHOT' : 'ATTEMPT',
      r.snapshotId ?? null,
      r.attemptId ?? null,
      r.key,
      occ.n,
      r.pollGeneration ?? null,
      JSON.stringify(payload),
      payloadHash,
    ],
  );
  return { id: row.id, payloadHash, occurrenceNo: occ.n };
}

export async function bankResponse(
  c: Db,
  r: {
    runId: string;
    requestId: string;
    classification: string;
    kind?: 'RESPONSE' | 'NO_RESPONSE';
    httpStatus?: number | null;
    body?: unknown;
  },
): Promise<string> {
  const kind = r.kind ?? (r.classification === 'NO_RESPONSE' ? 'NO_RESPONSE' : 'RESPONSE');
  const row = await one<{ id: string }>(
    c,
    `INSERT INTO paysim."BankInteractionResponse"("simulationRunId", "requestId", "receivedAt", kind, "httpStatus", body, classification, "elapsedMs")
     VALUES ($1, $2, now(), $3, $4, $5, $6, 12) RETURNING id`,
    [
      r.runId,
      r.requestId,
      kind,
      kind === 'NO_RESPONSE' ? null : (r.httpStatus ?? 200),
      kind === 'NO_RESPONSE' ? null : JSON.stringify(r.body ?? {}),
      r.classification,
    ],
  );
  return row.id;
}

/** Verifies the current snapshot; a MATCH applies T2, anything else T3. */
export async function verifyRecipient(
  c: Db,
  v: { runId: string; paymentId: string; outcome?: 'MATCH' | 'TOKEN_MISMATCH' },
): Promise<string> {
  const p = await one<{ reference: string; snapshotId: string; snapshotNo: number }>(
    c,
    `SELECT p.reference, s.id AS "snapshotId", s."snapshotNo" FROM paysim."Payment" p
       JOIN paysim."RecipientSnapshot" s ON s.id = p."currentSnapshotId" WHERE p.id = $1`,
    [v.paymentId],
  );
  const outcome = v.outcome ?? 'MATCH';
  const req = await bankRequest(c, {
    runId: v.runId,
    type: 'VERIFY_ACCOUNT',
    snapshotId: p.snapshotId,
    key: `${p.reference}#S${p.snapshotNo}`,
  });
  const responseId = await bankResponse(c, {
    runId: v.runId,
    requestId: req.id,
    classification: 'ACCOUNT_VERIFIED',
  });
  const ver = await one<{ id: string }>(
    c,
    `INSERT INTO paysim."VerificationResult"
       ("simulationRunId", "snapshotId", "bankRequestId", "bankResponseId", outcome, "suppliedName", "returnedName",
        "suppliedTokens", "returnedTokens", disposition, "verifiedAt")
     VALUES ($1, $2, $3, $4, $5, 'Ngozi Testperson', 'TESTPERSON NGOZI', '{NGOZI,TESTPERSON}', $6, 'APPLIED', now()) RETURNING id`,
    [
      v.runId,
      p.snapshotId,
      req.id,
      responseId,
      outcome,
      outcome === 'MATCH' ? ['NGOZI', 'TESTPERSON'] : ['NGOZI', 'OTHER'],
    ],
  );
  await transition(c, {
    runId: v.runId,
    paymentId: v.paymentId,
    to: outcome === 'MATCH' ? 'PENDING_APPROVAL' : 'RECIPIENT_VERIFICATION_FAILED',
    trigger: outcome === 'MATCH' ? 'RECIPIENT_VERIFIED' : 'RECIPIENT_VERIFICATION_FAILED',
    cause: { type: 'BANK_RESPONSE', responseId },
  });
  return ver.id;
}

/** T7: approval bound to the current snapshot, its applied verification and the amount. */
export async function approvePayment(
  c: Db,
  a: {
    runId: string;
    paymentId: string;
    approver?: string;
    amountMinor?: string;
    verificationId?: string;
  },
): Promise<string> {
  const approver = a.approver ?? 'fin-02';
  const p = await one<{ amountMinor: string; currency: string; snapshotId: string }>(
    c,
    `SELECT "amountMinor", currency, "currentSnapshotId" AS "snapshotId" FROM paysim."Payment" WHERE id = $1`,
    [a.paymentId],
  );
  const verificationId =
    a.verificationId ??
    (
      await one<{ id: string }>(
        c,
        `SELECT id FROM paysim."VerificationResult" WHERE "snapshotId" = $1 ORDER BY "verifiedAt" DESC LIMIT 1`,
        [p.snapshotId],
      )
    ).id;
  const commandId = await insertCommand(c, {
    runId: a.runId,
    type: 'APPROVE_PAYMENT',
    actor: approver,
    payload: { paymentId: a.paymentId },
    targetPaymentId: a.paymentId,
  });
  const approval = await one<{ id: string }>(
    c,
    `INSERT INTO paysim."Approval"("simulationRunId", "paymentId", "snapshotId", "verificationResultId", "amountMinor", currency, "approverActorId", "commandId", "approvedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now()) RETURNING id`,
    [
      a.runId,
      a.paymentId,
      p.snapshotId,
      verificationId,
      a.amountMinor ?? p.amountMinor,
      p.currency,
      approver,
      commandId,
    ],
  );
  await transition(c, {
    runId: a.runId,
    paymentId: a.paymentId,
    to: 'READY_FOR_PAYMENT',
    trigger: 'APPROVE',
    cause: { type: 'INBOUND_COMMAND', commandId, actor: approver },
  });
  return approval.id;
}

export interface Dispatched {
  attemptId: string;
  bankReference: string;
  requestId: string;
  payloadHash: string;
}

/** T10 intent transaction: PENDING attempt + status change + transition + DISPATCH request. */
export async function dispatchAttempt(
  c: Db,
  d: { runId: string; paymentId: string; ttlMs?: number; payload?: unknown },
): Promise<Dispatched> {
  const p = await one<{ reference: string }>(
    c,
    `SELECT reference FROM paysim."Payment" WHERE id = $1 FOR NO KEY UPDATE`,
    [d.paymentId],
  );
  const a = await one<{ id: string; snapshotId: string; amountMinor: string; currency: string }>(
    c,
    `SELECT id, "snapshotId", "amountMinor", currency FROM paysim."Approval" WHERE "paymentId" = $1`,
    [d.paymentId],
  );
  const n = (
    await one<{ n: number }>(
      c,
      `SELECT coalesce(max("attemptNumber"), 0) + 1 AS n FROM paysim."PaymentAttempt" WHERE "paymentId" = $1`,
      [d.paymentId],
    )
  ).n;
  const bankReference = `PSIM-${p.reference.replaceAll('-', '')}-${String(n).padStart(2, '0')}`;
  const attempt = await one<{ id: string }>(
    c,
    `INSERT INTO paysim."PaymentAttempt"
       ("simulationRunId", "paymentId", "attemptNumber", "providerCode", "bankReference", status, "approvalId", "snapshotId", "amountMinor", currency, "acceptanceDeadline")
     VALUES ($1, $2, $3, $4, $5, 'PENDING', $6, $7, $8, $9, now() + ($10 * interval '1 millisecond')) RETURNING id`,
    [
      d.runId,
      d.paymentId,
      n,
      PROVIDER,
      bankReference,
      a.id,
      a.snapshotId,
      a.amountMinor,
      a.currency,
      d.ttlMs ?? 300_000,
    ],
  );
  await c.query(
    `INSERT INTO paysim."AttemptStatusChange"("simulationRunId", "attemptId", "sequenceNo", "fromStatus", "toStatus", "causeType", "causeJob", "actorType", "actorId")
     VALUES ($1, $2, 1, NULL, 'PENDING', 'SYSTEM_JOB', 'dispatcher', 'SYSTEM', 'system:dispatcher')`,
    [d.runId, attempt.id],
  );
  await transition(c, {
    runId: d.runId,
    paymentId: d.paymentId,
    to: 'PROCESSING',
    trigger: 'DISPATCH',
    cause: { type: 'SYSTEM_JOB', job: 'dispatcher' },
    relatedAttemptId: attempt.id,
  });
  const req = await bankRequest(c, {
    runId: d.runId,
    type: 'DISPATCH',
    attemptId: attempt.id,
    key: bankReference,
    payload: d.payload ?? { bankReference, amountMinor: a.amountMinor, currency: a.currency },
  });
  return { attemptId: attempt.id, bankReference, requestId: req.id, payloadHash: req.payloadHash };
}

/** Appends an attempt status change and applies it to the attempt (§5.2). */
export async function changeAttempt(
  c: Db,
  x: { runId: string; attemptId: string; to: string; cause: Cause },
): Promise<string> {
  const att = await one<{ status: string }>(
    c,
    `SELECT status FROM paysim."PaymentAttempt" WHERE id = $1 FOR NO KEY UPDATE`,
    [x.attemptId],
  );
  const seq = await one<{ n: number }>(
    c,
    `SELECT coalesce(max("sequenceNo"), 0) + 1 AS n FROM paysim."AttemptStatusChange" WHERE "attemptId" = $1`,
    [x.attemptId],
  );
  const k = causeColumns(x.cause);
  const row = await one<{ id: string }>(
    c,
    `INSERT INTO paysim."AttemptStatusChange"
       ("simulationRunId", "attemptId", "sequenceNo", "fromStatus", "toStatus", "causeType", "causeBankResponseId",
        "causeProviderEventId", "causeCommandId", "causeJob", "actorType", "actorId")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
    [
      x.runId,
      x.attemptId,
      seq.n,
      att.status,
      x.to,
      k.causeType,
      k.responseId,
      k.eventId,
      k.commandId,
      k.job,
      k.actorType,
      k.actorId,
    ],
  );
  const clearPoll = ['SUCCEEDED', 'FAILED_RETRYABLE', 'FAILED_PERMANENT'].includes(x.to)
    ? ', "pollClaimToken" = NULL, "pollLeaseExpiresAt" = NULL'
    : '';
  await c.query(
    `UPDATE paysim."PaymentAttempt" SET status = $2, "updatedAt" = now()${clearPoll} WHERE id = $1`,
    [x.attemptId, x.to],
  );
  return row.id;
}

/** T12: attempt → SUCCEEDED, payment → SETTLED, single settlement record. */
export async function settle(
  c: Db,
  s: { runId: string; paymentId: string; attemptId: string; cause: Cause },
): Promise<string> {
  await changeAttempt(c, {
    runId: s.runId,
    attemptId: s.attemptId,
    to: 'SUCCEEDED',
    cause: s.cause,
  });
  await transition(c, {
    runId: s.runId,
    paymentId: s.paymentId,
    to: 'SETTLED',
    trigger: 'SETTLEMENT_CONFIRMED',
    cause: s.cause,
    relatedAttemptId: s.attemptId,
  });
  const att = await one<{ amountMinor: string; currency: string }>(
    c,
    `SELECT "amountMinor", currency FROM paysim."PaymentAttempt" WHERE id = $1`,
    [s.attemptId],
  );
  const k = causeColumns(s.cause);
  const row = await one<{ id: string }>(
    c,
    `INSERT INTO paysim."Settlement"("simulationRunId", "paymentId", "attemptId", "amountMinor", currency, "causeType", "causeProviderEventId", "causeBankResponseId", "causeCommandId", "settledAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now()) RETURNING id`,
    [
      s.runId,
      s.paymentId,
      s.attemptId,
      att.amountMinor,
      att.currency,
      k.causeType,
      k.eventId,
      k.responseId,
      k.commandId,
    ],
  );
  return row.id;
}

export interface Flow extends Run {
  claimId: string;
  payout: Payout;
}

/** A run with one payout taken to READY_FOR_PAYMENT. */
export async function readyPayment(
  versionId: string,
  opts: { amountMinor?: string; reference?: string } = {},
): Promise<Flow> {
  const run = await createRun(versionId);
  const claimId = await createClaim(app, run.runId, opts.amountMinor ?? '250000000');
  const payout = await tx(app, async (c) => {
    const created = await createPayout(c, {
      runId: run.runId,
      claimId,
      amountMinor: opts.amountMinor,
      reference: opts.reference,
    });
    await verifyRecipient(c, { runId: run.runId, paymentId: created.paymentId });
    await approvePayment(c, { runId: run.runId, paymentId: created.paymentId });
    return created;
  });
  return { ...run, claimId, payout };
}

export async function count(
  db: Db,
  table: string,
  where = 'true',
  params: unknown[] = [],
): Promise<number> {
  const row = await one<{ n: string }>(
    db,
    `SELECT count(*) AS n FROM ${table} WHERE ${where}`,
    params,
  );
  return Number(row.n);
}

export async function rows<T extends Record<string, unknown>>(
  db: Db,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return q<T>(db, sql, params);
}

/** Settles via the bank's synchronous SUCCEEDED answer to the DISPATCH request. */
export async function settleViaBank(
  c: Db,
  s: { runId: string; paymentId: string; attemptId: string; requestId: string },
): Promise<string> {
  const responseId = await bankResponse(c, {
    runId: s.runId,
    requestId: s.requestId,
    classification: 'SUCCEEDED',
  });
  return settle(c, {
    runId: s.runId,
    paymentId: s.paymentId,
    attemptId: s.attemptId,
    cause: { type: 'BANK_RESPONSE', responseId },
  });
}
