// Anomalies: immutable evidence, append-only actions, recorded status (L4), D15, D23, D25.
import { app, expectDbError, one, owner, tx, useDatabase } from './support/db.js';
import {
  count,
  createProfile,
  dispatchAttempt,
  insertCommand,
  readyPayment,
} from './support/fixtures.js';
import {
  addAnomalyAction,
  addEvidence,
  claimEvent,
  failEvent,
  openAnomaly,
  receiveDelivery,
} from './support/protocols.js';

useDatabase();

async function criticalOnReadyPayment() {
  const flow = await readyPayment(await createProfile({ eventRetryLimit: 1 }));
  const ev = await receiveDelivery(app, {
    runId: flow.runId,
    providerEventId: 'evt_c',
    bankReference: 'PSIM-X-01',
    payload: { type: 'transfer.failed' },
  });
  const anomalyId = await tx(app, (c) =>
    openAnomaly(c, {
      runId: flow.runId,
      type: 'CONFLICT',
      severity: 'CRITICAL',
      evidenceKey: `event:${ev.eventRecordId ?? ''}`,
      paymentId: flow.payout.paymentId,
      eventId: ev.eventRecordId,
      evidence: [{ type: 'PROVIDER_EVENT', id: ev.eventRecordId ?? '' }],
    }),
  );
  return { flow, anomalyId, eventId: ev.eventRecordId ?? '' };
}

async function resolveAs(runId: string, anomalyId: string, actor: string) {
  const commandId = await insertCommand(app, {
    runId,
    type: 'RESOLVE_ANOMALY',
    actor,
    payload: { anomalyId },
  });
  return tx(app, (c) =>
    addAnomalyAction(c, {
      runId,
      anomalyId,
      action: 'RESOLVED',
      actorType: 'USER',
      actorId: actor,
      cause: { type: 'INBOUND_COMMAND', commandId },
      resolutionType: 'NO_FINANCIAL_IMPACT',
    }),
  );
}

describe('anomalies', () => {
  it('evidence is insert-only and frozen after the creating transaction', async () => {
    const { flow, anomalyId, eventId } = await criticalOnReadyPayment();
    await expectDbError(
      app.query(`UPDATE paysim."AnomalyEvidence" SET "createdAt" = now()`),
      '42501',
    );
    await expectDbError(
      owner.query(`UPDATE paysim."AnomalyEvidence" SET "createdAt" = now()`),
      'INSERT_ONLY',
    );
    await expectDbError(owner.query(`DELETE FROM paysim."AnomalyEvidence"`), 'INSERT_ONLY');
    await expectDbError(
      tx(app, (c) =>
        addEvidence(c, { runId: flow.runId, anomalyId, type: 'PROVIDER_EVENT', id: eventId }),
      ),
      'EVIDENCE_FROZEN',
    );
  });

  it('actions are append-only and gap-free', async () => {
    const { flow, anomalyId } = await criticalOnReadyPayment();
    await expectDbError(
      owner.query(`UPDATE paysim."AnomalyAction" SET reason = 'edited'`),
      'INSERT_ONLY',
    );
    await expectDbError(owner.query(`DELETE FROM paysim."AnomalyAction"`), 'INSERT_ONLY');
    await expectDbError(
      app.query(
        `INSERT INTO paysim."AnomalyAction"("simulationRunId", "anomalyId", "sequenceNo", "actionType", "actorType", "actorId", "causeType", "causeJob", reason)
         VALUES ($1, $2, 5, 'NOTE_ADDED', 'SYSTEM', 'system:x', 'SYSTEM_JOB', 'x', 'gap')`,
        [flow.runId, anomalyId],
      ),
      'SEQUENCE_GAP',
    );
  });

  it('status and action change atomically (checked at commit)', async () => {
    const { flow, anomalyId } = await criticalOnReadyPayment();
    const commandId = await insertCommand(app, {
      runId: flow.runId,
      type: 'RESOLVE_ANOMALY',
      actor: 'recon-01',
    });
    await expectDbError(
      tx(app, (c) =>
        addAnomalyAction(c, {
          runId: flow.runId,
          anomalyId,
          action: 'RESOLVED',
          actorType: 'USER',
          actorId: 'recon-01',
          cause: { type: 'INBOUND_COMMAND', commandId },
          resolutionType: 'NO_FINANCIAL_IMPACT',
          updateStatus: false,
        }),
      ),
      'ANOMALY_INCONSISTENT',
    );
    await expectDbError(
      tx(app, (c) =>
        c.query(`UPDATE paysim."Anomaly" SET status = 'RESOLVED' WHERE id = $1`, [anomalyId]),
      ),
      'ANOMALY_INCONSISTENT',
    );
  });

  it('critical resolution requires an authorised synthetic operator; the system never resolves or reopens it', async () => {
    const { flow, anomalyId } = await criticalOnReadyPayment();
    await expectDbError(resolveAs(flow.runId, anomalyId, 'support-01'), 'FORBIDDEN'); // has RESOLVE_ANOMALY, not the critical permission
    await expectDbError(
      insertCommand(app, { runId: flow.runId, type: 'RESOLVE_ANOMALY', actor: 'ops-01' }),
      'FORBIDDEN',
    );
    await expectDbError(
      insertCommand(app, { runId: flow.runId, type: 'RESOLVE_ANOMALY', actor: 'not-an-operator' }),
      'FORBIDDEN',
    );
    await expectDbError(
      tx(app, (c) =>
        addAnomalyAction(c, {
          runId: flow.runId,
          anomalyId,
          action: 'RESOLVED',
          actorType: 'SYSTEM',
          actorId: 'system:x',
          cause: { type: 'SYSTEM_JOB', job: 'x' },
          resolutionType: 'CONDITION_CLEARED',
        }),
      ),
      'HUMAN_RESOLUTION_REQUIRED',
    );
    await resolveAs(flow.runId, anomalyId, 'recon-01');
    await expectDbError(
      tx(app, (c) =>
        addAnomalyAction(c, {
          runId: flow.runId,
          anomalyId,
          action: 'REOPENED',
          actorType: 'SYSTEM',
          actorId: 'system:x',
          cause: { type: 'SYSTEM_JOB', job: 'x' },
        }),
      ),
      'ILLEGAL_TRANSITION',
    );
    const reopen = await insertCommand(app, {
      runId: flow.runId,
      type: 'REOPEN_ANOMALY',
      actor: 'recon-01',
    });
    await tx(app, (c) =>
      addAnomalyAction(c, {
        runId: flow.runId,
        anomalyId,
        action: 'REOPENED',
        actorType: 'USER',
        actorId: 'recon-01',
        cause: { type: 'INBOUND_COMMAND', commandId: reopen },
      }),
    );
    const a = await one<{ status: string; lastActionSequenceNo: number }>(
      app,
      `SELECT status, "lastActionSequenceNo" FROM paysim."Anomaly" WHERE id = $1`,
      [anomalyId],
    );
    expect(a).toEqual({ status: 'OPEN', lastActionSequenceNo: 3 });
  });

  it('an open critical anomaly blocks dispatch until a person resolves it (D15)', async () => {
    const { flow, anomalyId } = await criticalOnReadyPayment();
    await expectDbError(
      tx(app, (c) => dispatchAttempt(c, { runId: flow.runId, paymentId: flow.payout.paymentId })),
      'OPEN_CRITICAL_ANOMALY',
    );
    await resolveAs(flow.runId, anomalyId, 'recon-01');
    await tx(app, (c) =>
      dispatchAttempt(c, { runId: flow.runId, paymentId: flow.payout.paymentId }),
    );
    expect(await count(app, 'paysim."PaymentAttempt"')).toBe(1);
  });

  it('an attention anomaly may be auto-resolved with CONDITION_CLEARED and cited evidence', async () => {
    const flow = await readyPayment(await createProfile());
    const d = await tx(app, (c) =>
      dispatchAttempt(c, { runId: flow.runId, paymentId: flow.payout.paymentId }),
    );
    const change = await one<{ id: string }>(
      app,
      `SELECT id FROM paysim."AttemptStatusChange" WHERE "attemptId" = $1`,
      [d.attemptId],
    );
    const anomalyId = await tx(app, (c) =>
      openAnomaly(c, {
        runId: flow.runId,
        type: 'ATTEMPT_UNRESOLVED',
        severity: 'ATTENTION',
        evidenceKey: `attempt:${d.attemptId}`,
        paymentId: flow.payout.paymentId,
        attemptId: d.attemptId,
        evidence: [{ type: 'ATTEMPT_STATUS_CHANGE', id: change.id }],
      }),
    );
    await tx(app, async (c) => {
      await c.query(
        `INSERT INTO paysim."AnomalyAction"("simulationRunId", "anomalyId", "sequenceNo", "actionType", "actorType", "actorId", "causeType", "causeAttemptStatusChangeId", reason, "resolutionType")
         VALUES ($1, $2, 2, 'RESOLVED', 'SYSTEM', 'system:reconciler', 'ATTEMPT_STATUS_CHANGE', $3, 'attempt resolved on bank evidence', 'CONDITION_CLEARED')`,
        [flow.runId, anomalyId, change.id],
      );
      await c.query(
        `UPDATE paysim."Anomaly" SET status = 'RESOLVED', "lastActionSequenceNo" = 2 WHERE id = $1`,
        [anomalyId],
      );
    });
    expect(
      (
        await one<{ status: string }>(app, `SELECT status FROM paysim."Anomaly" WHERE id = $1`, [
          anomalyId,
        ])
      ).status,
    ).toBe('RESOLVED');
  });

  it('a requeue starts a new exhaustion generation with a distinct, deduplicated anomaly', async () => {
    const flow = await readyPayment(await createProfile({ eventRetryLimit: 1 }));
    const d = await tx(app, (c) =>
      dispatchAttempt(c, { runId: flow.runId, paymentId: flow.payout.paymentId }),
    );
    const ev = await receiveDelivery(app, {
      runId: flow.runId,
      providerEventId: 'evt_r',
      bankReference: d.bankReference,
      payload: { type: 'transfer.settled' },
    });
    const eventId = ev.eventRecordId ?? '';
    const exhaust = async () => {
      const token = await claimEvent(app, eventId, 'w', 60_000);
      return tx(app, (c) =>
        failEvent(c, {
          runId: flow.runId,
          eventId,
          token: token ?? '',
          worker: 'w',
          error: 'boom',
        }),
      );
    };
    await exhaust();
    await app.query(
      `UPDATE paysim."ProviderEvent" SET "processingStatus" = 'RECEIVED', "attemptCount" = 0, "requeueGeneration" = "requeueGeneration" + 1, "claimToken" = NULL, "leaseExpiresAt" = NULL WHERE id = $1`,
      [eventId],
    );
    await exhaust();
    const keys = (
      await app.query<{ evidenceKey: string }>(
        `SELECT "evidenceKey" FROM paysim."Anomaly" ORDER BY "evidenceKey"`,
      )
    ).rows.map((r) => r.evidenceKey);
    expect(keys).toEqual([`event:${eventId}:generation:0`, `event:${eventId}:generation:1`]);
    await expectDbError(
      app.query(
        `INSERT INTO paysim."Anomaly"("simulationRunId", "anomalyType", severity, "evidenceKey", detector, "detectedAt") VALUES ($1, 'EVENT_PROCESSING_EXHAUSTED', 'CRITICAL', $2, 'x', now())`,
        [flow.runId, `event:${eventId}:generation:1`],
      ),
      '23505',
    );
  });
});
