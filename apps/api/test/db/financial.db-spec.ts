// Financial invariants: minor units, I1, I2, I4, I9, I10, D8, §4.1, §5.2.
import { app, expectDbError, one, openTx, stillPending, tx, useDatabase } from './support/db.js';
import {
  approvePayment,
  changeAttempt,
  count,
  createClaim,
  createPayout,
  createProfile,
  createRun,
  dispatchAttempt,
  insertCommand,
  readyPayment,
  settle,
  settleViaBank,
  transition,
  verifyRecipient,
} from './support/fixtures.js';
import { receiveDelivery } from './support/protocols.js';

useDatabase();

describe('financial integrity', () => {
  it('stores money as exact integer minor units beyond float precision', async () => {
    const { runId } = await createRun(await createProfile());
    const big = '9007199254740993'; // 2^53 + 1: not representable as a JS number
    const claimId = await createClaim(app, runId, big);
    const row = await one<{ amount: string }>(
      app,
      `SELECT "approvedPayableAmountMinor"::text AS amount FROM paysim."Claim" WHERE id = $1`,
      [claimId],
    );
    expect(row.amount).toBe(big);
    const types = await one<{ n: string }>(
      app,
      `SELECT count(*) AS n FROM information_schema.columns
        WHERE table_schema IN ('paysim', 'simbank') AND column_name ILIKE '%amount%' AND data_type <> 'bigint'`,
    );
    expect(Number(types.n)).toBe(0);
  });

  it('rejects non-positive amounts and malformed currency codes', async () => {
    const { runId } = await createRun(await createProfile());
    await expectDbError(createClaim(app, runId, '0'), '23514');
    await expectDbError(createClaim(app, runId, '-5'), '23514');
    await expectDbError(createClaim(app, runId, '100', 'ngn'), '23514');
  });

  it('allows at most one unresolved attempt per payment (I1)', async () => {
    const flow = await readyPayment(await createProfile());
    const first = await tx(app, (c) =>
      dispatchAttempt(c, { runId: flow.runId, paymentId: flow.payout.paymentId }),
    );
    // Bypass the state machine: insert a second PENDING attempt directly.
    await expectDbError(
      tx(app, async (c) => {
        const a = await one<{ id: string; snapshotId: string }>(
          c,
          `SELECT id, "snapshotId" FROM paysim."Approval" WHERE "paymentId" = $1`,
          [flow.payout.paymentId],
        );
        await c.query(
          `INSERT INTO paysim."PaymentAttempt"("simulationRunId", "paymentId", "attemptNumber", "providerCode", "bankReference", status, "approvalId", "snapshotId", "amountMinor", currency, "acceptanceDeadline")
           VALUES ($1, $2, 2, 'SIMBANK', $3, 'PENDING', $4, $5, '250000000', 'NGN', now() + interval '5 minutes')`,
          [flow.runId, flow.payout.paymentId, `${first.bankReference}-X`, a.id, a.snapshotId],
        );
      }),
      '23505',
    );
  });

  it('allows exactly one settlement per payment (I2)', async () => {
    const flow = await readyPayment(await createProfile());
    const d = await tx(app, (c) =>
      dispatchAttempt(c, { runId: flow.runId, paymentId: flow.payout.paymentId }),
    );
    await tx(app, (c) =>
      settleViaBank(c, {
        runId: flow.runId,
        paymentId: flow.payout.paymentId,
        attemptId: d.attemptId,
        requestId: d.requestId,
      }),
    );
    await expectDbError(
      app.query(
        `INSERT INTO paysim."Settlement"("simulationRunId", "paymentId", "attemptId", "amountMinor", currency, "causeType", "causeCommandId", "settledAt")
         SELECT "simulationRunId", "paymentId", id, "amountMinor", currency, 'INBOUND_COMMAND', NULL, now() FROM paysim."PaymentAttempt" WHERE id = $1`,
        [d.attemptId],
      ),
      '23514', // typed-cause check fires before uniqueness; the next insert proves uniqueness
    );
    const cmd = await insertCommand(app, {
      runId: flow.runId,
      type: 'RESOLVE_ATTEMPT',
      actor: 'recon-01',
    });
    await expectDbError(
      app.query(
        `INSERT INTO paysim."Settlement"("simulationRunId", "paymentId", "attemptId", "amountMinor", currency, "causeType", "causeCommandId", "settledAt")
         SELECT "simulationRunId", "paymentId", id, "amountMinor", currency, 'INBOUND_COMMAND', $2, now() FROM paysim."PaymentAttempt" WHERE id = $1`,
        [d.attemptId, cmd],
      ),
      '23505',
    );
    expect(
      await count(app, 'paysim."Settlement"', '"paymentId" = $1', [flow.payout.paymentId]),
    ).toBe(1);
  });

  it('serialises concurrent payouts on one claim so it cannot be over-allocated (I9)', async () => {
    const { runId } = await createRun(await createProfile());
    const claimId = await createClaim(app, runId, '250000000');
    const a = await openTx(app);
    try {
      await createPayout(a.c, { runId, claimId, amountMinor: '250000000' }); // holds the claim lock (payment-insert trigger)
      const b = tx(app, (c) =>
        createPayout(c, { runId, claimId, amountMinor: '250000000', actor: 'ops-07' }),
      );
      expect(await stillPending(b)).toBe(true); // B is blocked on the claim row
      await a.commit();
      await expectDbError(b, 'CLAIM_ALLOCATION_EXCEEDED');
    } finally {
      await a.rollback();
    }
    expect(await count(app, 'paysim."Payment"', '"claimId" = $1', [claimId])).toBe(1);
  });

  it('releases allocation when a payment is cancelled', async () => {
    const { runId } = await createRun(await createProfile());
    const claimId = await createClaim(app, runId, '250000000');
    const p = await tx(app, (c) => createPayout(c, { runId, claimId }));
    const cancel = await insertCommand(app, {
      runId,
      type: 'CANCEL_PAYMENT',
      targetPaymentId: p.paymentId,
    });
    await tx(app, (c) =>
      transition(c, {
        runId,
        paymentId: p.paymentId,
        to: 'CANCELLED',
        trigger: 'CANCEL',
        reason: 'duplicate',
        cause: { type: 'INBOUND_COMMAND', commandId: cancel, actor: 'ops-01' },
      }),
    );
    await tx(app, (c) => createPayout(c, { runId, claimId }));
    expect(await count(app, 'paysim."Payment"', '"claimId" = $1', [claimId])).toBe(2);
  });

  it('cannot create a second settlement from a duplicate provider event', async () => {
    const flow = await readyPayment(await createProfile());
    const d = await tx(app, (c) =>
      dispatchAttempt(c, { runId: flow.runId, paymentId: flow.payout.paymentId }),
    );
    const payload = { type: 'transfer.settled', amountMinor: '250000000', currency: 'NGN' };
    const first = await receiveDelivery(app, {
      runId: flow.runId,
      providerEventId: 'evt_9001',
      bankReference: d.bankReference,
      payload,
    });
    await tx(app, (c) =>
      settle(c, {
        runId: flow.runId,
        paymentId: flow.payout.paymentId,
        attemptId: d.attemptId,
        cause: { type: 'PROVIDER_EVENT', eventId: first.eventRecordId ?? '' },
      }),
    );
    // A semantic duplicate (new event identity, same outcome) cannot settle again:
    // the attempt is final, the payment terminal, the settlement unique.
    const second = await receiveDelivery(app, {
      runId: flow.runId,
      providerEventId: 'evt_9007',
      bankReference: d.bankReference,
      payload,
    });
    expect(second.outcome).toBe('NEW_EVENT');
    await expectDbError(
      tx(app, (c) =>
        settle(c, {
          runId: flow.runId,
          paymentId: flow.payout.paymentId,
          attemptId: d.attemptId,
          cause: { type: 'PROVIDER_EVENT', eventId: second.eventRecordId ?? '' },
        }),
      ),
      'ILLEGAL_TRANSITION',
    );
    expect(await count(app, 'paysim."Settlement"')).toBe(1);
  });

  it('binds approval to the exact snapshot, verification and amount (D12, I10)', async () => {
    const { runId } = await createRun(await createProfile());
    const claimId = await createClaim(app, runId);
    const p = await tx(app, async (c) => {
      const created = await createPayout(c, { runId, claimId });
      await verifyRecipient(c, { runId, paymentId: created.paymentId });
      return created;
    });
    await expectDbError(
      tx(app, (c) =>
        approvePayment(c, { runId, paymentId: p.paymentId, amountMinor: '249999999' }),
      ),
      'STALE_APPROVAL_TARGET',
    );
    await tx(app, (c) => approvePayment(c, { runId, paymentId: p.paymentId }));
    // A second approval is impossible: UNIQUE (paymentId) fires before the transition check.
    await expectDbError(
      tx(app, (c) => approvePayment(c, { runId, paymentId: p.paymentId })),
      '23505',
    );
  });

  it('rejects approval based on a non-matching verification', async () => {
    const { runId } = await createRun(await createProfile());
    const claimId = await createClaim(app, runId);
    const p = await tx(app, (c) => createPayout(c, { runId, claimId }));
    const failed = await tx(app, (c) =>
      verifyRecipient(c, { runId, paymentId: p.paymentId, outcome: 'TOKEN_MISMATCH' }),
    );
    await expectDbError(
      tx(app, async (c) => {
        // Force the status forward to isolate the approval trigger's verification check.
        await approvePayment(c, { runId, paymentId: p.paymentId, verificationId: failed });
      }),
      'STALE_APPROVAL_TARGET',
    );
  });

  it('forbids self-approval even for an operator who may both create and approve (D8)', async () => {
    const { owner } = await import('./support/db.js');
    await owner.query(
      `INSERT INTO simconfig."SyntheticOperator"(id, "displayName") VALUES ('dual-99', 'Synthetic dual-role') ON CONFLICT DO NOTHING`,
    );
    await owner.query(
      `INSERT INTO simconfig."SyntheticOperatorPermission"("operatorId", action) VALUES ('dual-99', 'CREATE_PAYOUT'), ('dual-99', 'APPROVE_PAYMENT') ON CONFLICT DO NOTHING`,
    );
    const { runId } = await createRun(await createProfile());
    const claimId = await createClaim(app, runId);
    const p = await tx(app, async (c) => {
      const created = await createPayout(c, { runId, claimId, actor: 'dual-99' });
      await verifyRecipient(c, { runId, paymentId: created.paymentId });
      return created;
    });
    await expectDbError(
      tx(app, (c) => approvePayment(c, { runId, paymentId: p.paymentId, approver: 'dual-99' })),
      'SELF_APPROVAL_FORBIDDEN',
    );
  });

  it('enforces the §4.1 transition table and I5 (status = latest transition at commit)', async () => {
    const { runId } = await createRun(await createProfile());
    const claimId = await createClaim(app, runId);
    const p = await tx(app, (c) => createPayout(c, { runId, claimId }));
    await expectDbError(
      tx(app, (c) =>
        transition(c, {
          runId,
          paymentId: p.paymentId,
          to: 'PROCESSING',
          trigger: 'DISPATCH',
          cause: { type: 'SYSTEM_JOB', job: 'dispatcher' },
        }),
      ),
      'ILLEGAL_TRANSITION',
    );
    // A status change with no transition row fails at COMMIT (deferred check).
    await expectDbError(
      tx(app, (c) =>
        c.query(
          `UPDATE paysim."Payment" SET status = 'PENDING_APPROVAL', version = version + 1 WHERE id = $1`,
          [p.paymentId],
        ),
      ),
      'PAYMENT_INCONSISTENT',
    );
    // Amounts are immutable for every role, including through the owner.
    await expectDbError(
      app.query(
        `UPDATE paysim."Payment" SET "amountMinor" = 1, version = version + 1 WHERE id = $1`,
        [p.paymentId],
      ),
      '42501',
    );
  });

  it('enforces the §5.2 attempt matrix: resolved attempts are final', async () => {
    const flow = await readyPayment(await createProfile());
    const d = await tx(app, (c) =>
      dispatchAttempt(c, { runId: flow.runId, paymentId: flow.payout.paymentId }),
    );
    await tx(app, (c) =>
      settleViaBank(c, {
        runId: flow.runId,
        paymentId: flow.payout.paymentId,
        attemptId: d.attemptId,
        requestId: d.requestId,
      }),
    );
    await expectDbError(
      tx(app, (c) =>
        changeAttempt(c, {
          runId: flow.runId,
          attemptId: d.attemptId,
          to: 'UNKNOWN',
          cause: { type: 'SYSTEM_JOB', job: 'recovery' },
        }),
      ),
      'ILLEGAL_TRANSITION',
    );
  });
});
