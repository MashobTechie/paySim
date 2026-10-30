// Simulated bank boundary (D31, S1), acceptance deadline and queryability (§5.7),
// request/response records (D27), status-polling claims (§5.8, C4).
import { randomUUID } from 'node:crypto';
import { app, bank, expectDbError, one, openTx, q, sleep, tx, useDatabase } from './support/db.js';
import {
  bankRequest,
  bankResponse,
  changeAttempt,
  count,
  createProfile,
  dispatchAttempt,
  PROVIDER,
  readyPayment,
} from './support/fixtures.js';
import { claimPoll } from './support/protocols.js';

useDatabase();

async function instruction(
  runId: string,
  o: {
    ref?: string;
    receivedOffsetMs: number;
    deadlineOffsetMs: number;
    visibleOffsetMs: number;
    status?: string;
    windowMs?: number;
  },
) {
  return bank.query(
    `INSERT INTO simbank."BankInstruction"("simulationRunId", "providerCode", "bankReference", "acceptanceDeadline", "receivedAt", "settlementWindowMs", "visibleAt", "amountMinor", currency, "destinationAccountNumber", status)
     VALUES ($1, $2, $3, now() + ($4 * interval '1 ms'), now() + ($5 * interval '1 ms'), $6, now() + ($7 * interval '1 ms'), '250000000', 'NGN', '0000123456', $8)`,
    [
      runId,
      PROVIDER,
      o.ref ?? randomUUID(),
      o.deadlineOffsetMs,
      o.receivedOffsetMs,
      o.windowMs ?? 120_000,
      o.visibleOffsetMs,
      o.status ?? 'RECEIVED',
    ],
  );
}

/** The bank's status-query answer (reference implementation): FOUND only once visible. */
async function bankQuery(
  runId: string,
  ref: string,
  atOffsetMs: number,
): Promise<'FOUND' | 'NOT_FOUND'> {
  const rows = await q<{ visible: boolean }>(
    bank,
    `SELECT "visibleAt" <= now() + ($3 * interval '1 ms') AS visible FROM simbank."BankInstruction" WHERE "simulationRunId" = $1 AND "bankReference" = $2`,
    [runId, ref, atOffsetMs],
  );
  return rows[0]?.visible ? 'FOUND' : 'NOT_FOUND';
}

describe('simulated bank boundary', () => {
  it('the PaySim role cannot read bank-side tables, and the bank role cannot read PaySim payments', async () => {
    await expectDbError(app.query(`SELECT * FROM simbank."BankInstruction"`), '42501');
    await expectDbError(app.query(`SELECT * FROM simbank."BankRunProfile"`), '42501');
    await expectDbError(bank.query(`SELECT * FROM paysim."Payment"`), '42501');
    await expectDbError(bank.query(`SELECT * FROM paysim."SimulatedBank"`), '42501');
    // Neither role can delete or truncate anything.
    await expectDbError(app.query(`DELETE FROM paysim."InboundCommand"`), '42501');
    await expectDbError(bank.query(`TRUNCATE simbank."BankInstruction"`), '42501');
  });

  it('a bank-side acceptance survives a PaySim rollback', async () => {
    const flow = await readyPayment(await createProfile());
    const paysimTx = await openTx(app);
    try {
      const d = await dispatchAttempt(paysimTx.c, {
        runId: flow.runId,
        paymentId: flow.payout.paymentId,
      });
      await instruction(flow.runId, {
        ref: d.bankReference,
        receivedOffsetMs: 0,
        deadlineOffsetMs: 300_000,
        visibleOffsetMs: 1_000,
      });
    } finally {
      await paysimTx.rollback();
    }
    expect(await count(app, 'paysim."PaymentAttempt"')).toBe(0);
    expect(await count(bank, 'simbank."BankInstruction"')).toBe(1);
  });

  it('late instructions are refused, and the refusal must match the deadline', async () => {
    const flow = await readyPayment(await createProfile());
    await expectDbError(
      instruction(flow.runId, {
        receivedOffsetMs: 10_000,
        deadlineOffsetMs: 0,
        visibleOffsetMs: 10_000,
      }),
      '23514',
    );
    await instruction(flow.runId, {
      receivedOffsetMs: 10_000,
      deadlineOffsetMs: 0,
      visibleOffsetMs: 10_000,
      status: 'REFUSED_LATE',
    });
    await expectDbError(
      instruction(flow.runId, {
        receivedOffsetMs: 0,
        deadlineOffsetMs: 10_000,
        visibleOffsetMs: 0,
        status: 'REFUSED_LATE',
      }),
      '23514',
    );
  });

  it('the queryability guarantee holds: a received instruction is visible by receipt + W', async () => {
    const flow = await readyPayment(await createProfile({ settlementWindowMs: 120_000 }));
    await expectDbError(
      instruction(flow.runId, {
        receivedOffsetMs: 0,
        deadlineOffsetMs: 300_000,
        visibleOffsetMs: 120_001,
      }),
      '23514',
    );
    await expectDbError(
      instruction(flow.runId, {
        receivedOffsetMs: 0,
        deadlineOffsetMs: 300_000,
        visibleOffsetMs: 1_000,
        windowMs: 999_999,
      }),
      'CONFIG_MISMATCH',
    );
    for (const visible of [0, 60_000, 120_000]) {
      const ref = randomUUID();
      await instruction(flow.runId, {
        ref,
        receivedOffsetMs: 0,
        deadlineOffsetMs: 300_000,
        visibleOffsetMs: visible,
      });
      expect(await bankQuery(flow.runId, ref, 120_000)).toBe('FOUND');
    }
  });

  it('distinguishes an observed timeout (NO_RESPONSE) from an unanswered request', async () => {
    const flow = await readyPayment(await createProfile());
    const d = await tx(app, (c) =>
      dispatchAttempt(c, { runId: flow.runId, paymentId: flow.payout.paymentId }),
    );
    await tx(app, async (c) => {
      const responseId = await bankResponse(c, {
        runId: flow.runId,
        requestId: d.requestId,
        classification: 'NO_RESPONSE',
      });
      await changeAttempt(c, {
        runId: flow.runId,
        attemptId: d.attemptId,
        to: 'UNKNOWN',
        cause: { type: 'BANK_RESPONSE', responseId },
      });
    });
    const claim = await claimPoll(app, d.attemptId, 60_000);
    const unanswered = await tx(app, (c) =>
      bankRequest(c, {
        runId: flow.runId,
        type: 'STATUS_QUERY',
        attemptId: d.attemptId,
        key: d.bankReference,
        pollGeneration: claim?.generation,
      }),
    );
    const kinds = await q<{ id: string; kind: string | null }>(
      app,
      `SELECT q.id, r.kind FROM paysim."BankInteractionRequest" q LEFT JOIN paysim."BankInteractionResponse" r ON r."requestId" = q.id
        WHERE q."subjectAttemptId" = $1 ORDER BY q."occurrenceNo", q."interactionType"`,
      [d.attemptId],
    );
    expect(kinds).toEqual([
      { id: d.requestId, kind: 'NO_RESPONSE' },
      { id: unanswered.id, kind: null },
    ]);
    await expectDbError(
      bankResponse(app, { runId: flow.runId, requestId: d.requestId, classification: 'SUCCEEDED' }),
      '23505',
    );
    await expectDbError(
      app.query(`UPDATE paysim."BankInteractionResponse" SET "elapsedMs" = 1`),
      '42501',
    );
    await expectDbError(
      app.query(
        `INSERT INTO paysim."BankInteractionResponse"("simulationRunId", "requestId", "receivedAt", kind, "httpStatus", classification, "elapsedMs") VALUES ($1, $2, now(), 'NO_RESPONSE', 504, 'NO_RESPONSE', 1)`,
        [flow.runId, unanswered.id],
      ),
      '23514',
    );
  });

  it('polling claims are exclusive, one request per generation, and fenced (C4)', async () => {
    const flow = await readyPayment(await createProfile());
    const d = await tx(app, (c) =>
      dispatchAttempt(c, { runId: flow.runId, paymentId: flow.payout.paymentId }),
    );
    await tx(app, async (c) => {
      const responseId = await bankResponse(c, {
        runId: flow.runId,
        requestId: d.requestId,
        classification: 'ACKNOWLEDGED',
      });
      await changeAttempt(c, {
        runId: flow.runId,
        attemptId: d.attemptId,
        to: 'SUBMITTED',
        cause: { type: 'BANK_RESPONSE', responseId },
      });
    });
    const claims = await Promise.all([
      claimPoll(app, d.attemptId, 150),
      claimPoll(app, d.attemptId, 150),
    ]);
    const claim = claims.find(Boolean);
    expect(claims.filter(Boolean)).toHaveLength(1);
    await tx(app, (c) =>
      bankRequest(c, {
        runId: flow.runId,
        type: 'STATUS_QUERY',
        attemptId: d.attemptId,
        key: d.bankReference,
        pollGeneration: claim?.generation,
      }),
    );
    await expectDbError(
      tx(app, (c) =>
        bankRequest(c, {
          runId: flow.runId,
          type: 'STATUS_QUERY',
          attemptId: d.attemptId,
          key: d.bankReference,
          pollGeneration: claim?.generation,
        }),
      ),
      '23505',
    );
    await sleep(250); // lease expires; a new claim takes a new generation
    const next = await claimPoll(app, d.attemptId, 60_000);
    expect(next?.generation).toBe((claim?.generation ?? 0) + 1);
    // A request tagged with the superseded generation is refused.
    await expectDbError(
      tx(app, (c) =>
        bankRequest(c, {
          runId: flow.runId,
          type: 'STATUS_QUERY',
          attemptId: d.attemptId,
          key: d.bankReference,
          pollGeneration: claim?.generation,
        }),
      ),
      'FENCED',
    );
    // Recovery is query-only: a second DISPATCH for the attempt is impossible (D19).
    await expectDbError(
      app.query(
        `INSERT INTO paysim."BankInteractionRequest"("simulationRunId", "providerCode", "interactionType", "subjectType", "subjectAttemptId", "readableKey", "occurrenceNo", "canonicalPayload", "payloadHash", "sentAt")
         VALUES ($1, $2, 'DISPATCH', 'ATTEMPT', $3, $4, 2, '{}', $5, now())`,
        [flow.runId, PROVIDER, d.attemptId, d.bankReference, 'a'.repeat(64)],
      ),
      'ILLEGAL_TRANSITION',
    );
    const gen = await one<{ pollGeneration: number }>(
      app,
      `SELECT "pollGeneration" FROM paysim."PaymentAttempt" WHERE id = $1`,
      [d.attemptId],
    );
    expect(gen.pollGeneration).toBe(next?.generation);
  });
});
