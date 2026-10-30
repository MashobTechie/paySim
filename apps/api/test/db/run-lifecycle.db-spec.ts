// Run lifecycle: frozen configuration (I20), replay sources, safe completion, the run gate, DIVERGED.
import { randomBytes } from 'node:crypto';
import {
  app,
  bank,
  expectDbError,
  openTx,
  owner,
  stillPending,
  tx,
  useDatabase,
} from './support/db.js';
import {
  bankResponse,
  changeAttempt,
  completeRun,
  createClaim,
  createProfile,
  createRun,
  dispatchAttempt,
  PROVIDER,
  readyPayment,
  settle,
  sha256,
} from './support/fixtures.js';
import { claimEvent, receiveDelivery } from './support/protocols.js';

useDatabase();

describe('run lifecycle', () => {
  it('configuration cannot change after activation', async () => {
    const versionId = await createProfile();
    const { runId } = await createRun(versionId);
    await expectDbError(
      app.query(`UPDATE paysim."SimulationRun" SET "eventRetryLimit" = 99 WHERE id = $1`, [runId]),
      '42501',
    );
    await expectDbError(
      owner.query(`UPDATE paysim."SimulationRun" SET "eventRetryLimit" = 99 WHERE id = $1`, [
        runId,
      ]),
      'IMMUTABLE_COLUMN',
    );
    await expectDbError(
      owner.query(`UPDATE paysim."SimulatedBank" SET "settlementWindowMs" = 1`),
      'INSERT_ONLY',
    );
    await expectDbError(
      app.query(
        `INSERT INTO paysim."SimulatedBank"("simulationRunId", "providerCode", "settlementWindowMs", "acceptanceTtlMs", "escalationThresholdMs", "attemptRetryLimit", "attemptBackoffMs", "queryabilityGuaranteed", "signingSecret", "ingressKeyHash")
         VALUES ($1, 'OTHER', 1, 1, 1, 1, '{1}', true, $2, $3)`,
        [runId, 'x'.repeat(32), sha256('k')],
      ),
      'RUN_NOT_WRITABLE',
    );
    await expectDbError(
      bank.query(
        `INSERT INTO simbank."BankRunProfile"("simulationRunId", "providerCode", "settlementWindowMs", "acceptanceTtlMs", "signingSecret", "webhookIngressKey") VALUES ($1, 'OTHER', 1, 1, 'x', 'k')`,
        [runId],
      ),
      'RUN_NOT_WRITABLE',
    );
    await expectDbError(
      owner.query(
        `UPDATE simconfig."ConfigurationProfileVersion" SET "eventRetryLimit" = 1 WHERE id = $1`,
        [versionId],
      ),
      'INSERT_ONLY',
    );
  });

  it('bank configuration must be copied from the pinned version; ingress keys are stored hashed', async () => {
    const versionId = await createProfile();
    const { runId } = await createRun(versionId, { activate: false });
    await expectDbError(
      app.query(
        `INSERT INTO paysim."SimulatedBank"("simulationRunId", "providerCode", "settlementWindowMs", "acceptanceTtlMs", "escalationThresholdMs", "attemptRetryLimit", "attemptBackoffMs", "queryabilityGuaranteed", "signingSecret", "ingressKeyHash")
         VALUES ($1, 'NOT-DEFINED', 1, 1, 1, 1, '{1}', true, $2, $3)`,
        [runId, 'x'.repeat(32), sha256(randomBytes(32))],
      ),
      'CONFIG_MISMATCH',
    );
    const plaintextKey = randomBytes(32).toString('base64url');
    await expectDbError(
      owner.query(
        `UPDATE paysim."SimulatedBank" SET "ingressKeyHash" = $2 WHERE "simulationRunId" = $1`,
        [runId, plaintextKey],
      ),
      'INSERT_ONLY',
    );
    const hash = (
      await app.query<{ ingressKeyHash: string }>(
        `SELECT "ingressKeyHash" FROM paysim."SimulatedBank" WHERE "simulationRunId" = $1`,
        [runId],
      )
    ).rows[0];
    expect(hash?.ingressKeyHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a replay cannot start from an incomplete source', async () => {
    const versionId = await createProfile();
    const source = await createRun(versionId);
    await expectDbError(
      createRun(versionId, { type: 'REPLAY', sourceRunId: source.runId, secret: source.secret }),
      'REPLAY_SOURCE_NOT_COMPLETED',
    );
    await completeRun(app, source.runId);
    await expectDbError(
      createRun(versionId, { type: 'REPLAY', sourceRunId: source.runId }),
      'CONFIG_MISMATCH',
    ); // must copy the source secret
    await createRun(versionId, {
      type: 'REPLAY',
      sourceRunId: source.runId,
      secret: source.secret,
    });
  });

  it('a run cannot complete with claimed events or unresolved dispatch work', async () => {
    const flow = await readyPayment(await createProfile());
    const d = await tx(app, (c) =>
      dispatchAttempt(c, { runId: flow.runId, paymentId: flow.payout.paymentId }),
    );
    await expectDbError(completeRun(app, flow.runId), 'RUN_HAS_INFLIGHT_WORK'); // PENDING attempt
    await tx(app, async (c) => {
      const ok = await bankResponse(c, {
        runId: flow.runId,
        requestId: d.requestId,
        classification: 'SUCCEEDED',
      });
      await settle(c, {
        runId: flow.runId,
        paymentId: flow.payout.paymentId,
        attemptId: d.attemptId,
        cause: { type: 'BANK_RESPONSE', responseId: ok },
      });
    });
    const ev = await receiveDelivery(app, {
      runId: flow.runId,
      providerEventId: 'evt_1',
      bankReference: d.bankReference,
      payload: { type: 'transfer.settled' },
    });
    await claimEvent(app, ev.eventRecordId ?? '', 'w', 60_000);
    await expectDbError(completeRun(app, flow.runId), 'RUN_HAS_INFLIGHT_WORK'); // claimed event
    await app.query(
      `UPDATE paysim."ProviderEvent" SET "processingStatus" = 'PROCESSED', outcome = 'NO_OP', "processedAt" = now() WHERE id = $1`,
      [ev.eventRecordId],
    );
    await completeRun(app, flow.runId);
  });

  it('completion waits for in-flight writers, then the run gate rejects all further writes', async () => {
    const { runId } = await createRun(await createProfile());
    const writer = await openTx(app);
    try {
      await createClaim(writer.c, runId); // holds FOR KEY SHARE on the run
      const completing = completeRun(app, runId);
      expect(await stillPending(completing)).toBe(true);
      await writer.commit();
      await completing;
    } finally {
      await writer.rollback();
    }
    await expectDbError(createClaim(app, runId), 'RUN_NOT_WRITABLE');
    await expectDbError(
      app.query(`UPDATE paysim."SimulationRun" SET status = 'ACTIVE' WHERE id = $1`, [runId]),
      'RUN_NOT_WRITABLE',
    );
  });

  it('enforces legal run transitions and keeps DIVERGED separate from status', async () => {
    const versionId = await createProfile();
    const created = await createRun(versionId, { activate: false });
    await expectDbError(completeRun(app, created.runId), 'ILLEGAL_RUN_TRANSITION');
    const { runId } = await createRun(versionId);
    await expectDbError(
      app.query(`UPDATE paysim."SimulationRun" SET diverged = true WHERE id = $1`, [runId]),
      '23514',
    ); // scenario runs never diverge
    await completeRun(app, runId);
    const replay = await createRun(versionId, {
      type: 'REPLAY',
      sourceRunId: runId,
      secret: (
        await app.query<{ signingSecret: string }>(
          `SELECT "signingSecret" FROM paysim."SimulatedBank" WHERE "simulationRunId" = $1`,
          [runId],
        )
      ).rows[0]?.signingSecret,
    });
    await app.query(`UPDATE paysim."SimulationRun" SET diverged = true WHERE id = $1`, [
      replay.runId,
    ]);
    await expectDbError(
      app.query(`UPDATE paysim."SimulationRun" SET diverged = false WHERE id = $1`, [replay.runId]),
      'ILLEGAL_RUN_TRANSITION',
    );
    const run = (
      await app.query<{ status: string; diverged: boolean }>(
        `SELECT status, diverged FROM paysim."SimulationRun" WHERE id = $1`,
        [replay.runId],
      )
    ).rows[0];
    expect(run).toEqual({ status: 'ACTIVE', diverged: true });
    expect(PROVIDER).toBe('SIMBANK');
    expect(changeAttempt).toBeTypeOf('function');
  });
});
