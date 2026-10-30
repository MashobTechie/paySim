// Webhook receipt, processing claims, leases, fencing, exhaustion (§8, D24, D25, I18).
import { app, expectDbError, one, sleep, tx, useDatabase } from './support/db.js';
import {
  count,
  createProfile,
  createRun,
  dispatchAttempt,
  readyPayment,
} from './support/fixtures.js';
import {
  addAnomalyAction,
  claimEvent,
  failEvent,
  finalizeEvent,
  FencedError,
  logProcessingAttempt,
  receiveDelivery,
  sweepExpired,
} from './support/protocols.js';

useDatabase();

const payload = { type: 'transfer.settled', amountMinor: '250000000', currency: 'NGN' };

async function eventFixture(opts: { eventRetryLimit?: number; withAttempt?: boolean } = {}) {
  const versionId = await createProfile({ eventRetryLimit: opts.eventRetryLimit ?? 3 });
  let runId: string;
  let bankReference = 'PSIM-UNKNOWN-01';
  if (opts.withAttempt) {
    const flow = await readyPayment(versionId);
    runId = flow.runId;
    bankReference = (
      await tx(app, (c) =>
        dispatchAttempt(c, { runId: flow.runId, paymentId: flow.payout.paymentId }),
      )
    ).bankReference;
  } else {
    runId = (await createRun(versionId)).runId;
  }
  const r = await receiveDelivery(app, { runId, providerEventId: 'evt_1', bankReference, payload });
  return { runId, eventId: r.eventRecordId ?? '', bankReference };
}

describe('webhook receipt and processing', () => {
  it('records duplicate and conflicting deliveries without duplicating the event', async () => {
    const { runId, bankReference } = await eventFixture();
    expect(
      (await receiveDelivery(app, { runId, providerEventId: 'evt_1', bankReference, payload }))
        .outcome,
    ).toBe('DUPLICATE_DELIVERY');
    expect(
      (
        await receiveDelivery(app, {
          runId,
          providerEventId: 'evt_1',
          bankReference,
          payload: { ...payload, amountMinor: '1' },
        })
      ).outcome,
    ).toBe('CONFLICTING_PAYLOAD');
    expect(
      (
        await receiveDelivery(app, {
          runId,
          providerEventId: 'evt_x',
          bankReference,
          payload,
          signatureValid: false,
        })
      ).outcome,
    ).toBe('INVALID_SIGNATURE');
    expect(await count(app, 'paysim."ProviderEvent"')).toBe(1);
    expect(await count(app, 'paysim."WebhookDelivery"')).toBe(4);
    await expectDbError(
      receiveDelivery(app, {
        runId,
        providerEventId: 'evt_big',
        bankReference,
        payload,
        rawBody: Buffer.alloc(65_537),
      }),
      '23514',
    );
  });

  it('two workers cannot own the same active claim', async () => {
    const { eventId } = await eventFixture();
    const tokens = await Promise.all([
      claimEvent(app, eventId, 'w1', 60_000),
      claimEvent(app, eventId, 'w2', 60_000),
    ]);
    expect(tokens.filter(Boolean)).toHaveLength(1);
    expect(await claimEvent(app, eventId, 'w3', 60_000)).toBeNull();
  });

  it('an expired lease can be reclaimed, and the crashed attempt is counted', async () => {
    const { eventId } = await eventFixture();
    const t1 = await claimEvent(app, eventId, 'w1', 150);
    expect(t1).not.toBeNull();
    expect(await claimEvent(app, eventId, 'w2', 60_000)).toBeNull();
    await sleep(250); // w1 "crashed"; its lease expires
    const t2 = await claimEvent(app, eventId, 'w2', 60_000);
    expect(t2).not.toBeNull();
    expect(t2).not.toBe(t1);
    const ev = await one<{ attemptCount: number }>(
      app,
      `SELECT "attemptCount" FROM paysim."ProviderEvent" WHERE id = $1`,
      [eventId],
    );
    expect(ev.attemptCount).toBe(2);
  });

  it('a stale claim token cannot commit (fencing)', async () => {
    const { runId, eventId } = await eventFixture();
    const stale = await claimEvent(app, eventId, 'w1', 150);
    await sleep(250);
    const fresh = await claimEvent(app, eventId, 'w2', 60_000);
    await expect(
      tx(app, (c) =>
        finalizeEvent(c, { runId, eventId, token: stale ?? '', worker: 'w1', outcome: 'NO_OP' }),
      ),
    ).rejects.toBeInstanceOf(FencedError);
    await expectDbError(
      app.query(
        `UPDATE paysim."ProviderEvent" SET "processingStatus" = 'PROCESSED', outcome = 'NO_OP', "processedAt" = now(), "claimToken" = $2 WHERE id = $1`,
        [eventId, stale],
      ),
      'FENCED',
    );
    await expectDbError(
      logProcessingAttempt(app, {
        runId,
        eventId,
        token: stale ?? '',
        worker: 'w1',
        result: 'COMPLETED',
      }),
      'FENCED',
    );
    await tx(app, (c) =>
      finalizeEvent(c, { runId, eventId, token: fresh ?? '', worker: 'w2', outcome: 'NO_OP' }),
    );
    await expectDbError(
      app.query(`UPDATE paysim."ProviderEvent" SET "lastError" = 'x' WHERE id = $1`, [eventId]),
      'EVENT_FINAL',
    );
  });

  it('repeated crashes exhaust the event and raise the anomaly (LEASE_EXPIRED)', async () => {
    const { runId, eventId } = await eventFixture({ eventRetryLimit: 2, withAttempt: true });
    for (let i = 0; i < 2; i += 1) {
      expect(await claimEvent(app, eventId, `w${i}`, 100)).not.toBeNull();
      await sleep(180);
      expect(await tx(app, (c) => sweepExpired(c, runId, eventId))).toBe(
        i < 1 ? 'RECLAIMABLE' : 'EXHAUSTED',
      );
    }
    expect(await claimEvent(app, eventId, 'w9', 60_000)).toBeNull();
    const a = await one<{ severity: string; evidenceKey: string; status: string }>(
      app,
      `SELECT severity, "evidenceKey", status FROM paysim."Anomaly"`,
    );
    expect(a).toEqual({
      severity: 'CRITICAL',
      evidenceKey: `event:${eventId}:generation:0`,
      status: 'OPEN',
    });
    expect(await count(app, 'paysim."EventProcessingAttempt"', `result = 'LEASE_EXPIRED'`)).toBe(2);
  });

  it('technical errors retry until the limit, then exhaust with a critical anomaly', async () => {
    const { runId, eventId } = await eventFixture({ eventRetryLimit: 2, withAttempt: true });
    const t1 = await claimEvent(app, eventId, 'w1', 60_000);
    expect(
      (
        await tx(app, (c) =>
          failEvent(c, { runId, eventId, token: t1 ?? '', worker: 'w1', error: 'boom' }),
        )
      ).status,
    ).toBe('PROCESSING_ERROR');
    const t2 = await claimEvent(app, eventId, 'w1', 60_000);
    const res = await tx(app, (c) =>
      failEvent(c, { runId, eventId, token: t2 ?? '', worker: 'w1', error: 'boom' }),
    );
    expect(res.status).toBe('PROCESSING_EXHAUSTED');
    const a = await one<{ severity: string }>(
      app,
      `SELECT severity FROM paysim."Anomaly" WHERE id = $1`,
      [res.anomalyId],
    );
    expect(a.severity).toBe('CRITICAL');
  });

  it('a critical exhaustion anomaly is never resolved by the system, even after successful reprocessing (D25)', async () => {
    const { runId, eventId } = await eventFixture({ eventRetryLimit: 1, withAttempt: true });
    const t1 = await claimEvent(app, eventId, 'w1', 60_000);
    const { anomalyId } = await tx(app, (c) =>
      failEvent(c, { runId, eventId, token: t1 ?? '', worker: 'w1', error: 'boom' }),
    );
    // Requeue and reprocess successfully.
    await app.query(
      `UPDATE paysim."ProviderEvent" SET "processingStatus" = 'RECEIVED', "attemptCount" = 0, "requeueGeneration" = "requeueGeneration" + 1, "claimToken" = NULL, "leaseExpiresAt" = NULL WHERE id = $1`,
      [eventId],
    );
    const t2 = await claimEvent(app, eventId, 'w2', 60_000);
    await tx(app, (c) =>
      finalizeEvent(c, { runId, eventId, token: t2 ?? '', worker: 'w2', outcome: 'NO_OP' }),
    );
    const evidence = await one<{ id: string }>(
      app,
      `SELECT id FROM paysim."EventProcessingAttempt" WHERE result = 'COMPLETED'`,
    );
    await expectDbError(
      tx(app, (c) =>
        addAnomalyAction(c, {
          runId,
          anomalyId: anomalyId ?? '',
          action: 'RESOLVED',
          actorType: 'SYSTEM',
          actorId: 'system:sweeper',
          cause: { type: 'PROCESSING_ATTEMPT', id: evidence.id },
          resolutionType: 'CONDITION_CLEARED',
        }),
      ),
      'HUMAN_RESOLUTION_REQUIRED',
    );
  });
});
