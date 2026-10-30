// Replay: completed sources only, isolation, reused references, playback matching (D18, D26, L3).
import { app, expectDbError, one, sleep, tx, useDatabase } from './support/db.js';
import {
  approvePayment,
  bankRequest,
  bankResponse,
  changeAttempt,
  completeRun,
  count,
  createClaim,
  createPayout,
  createProfile,
  createRun,
  dispatchAttempt,
  insertCommand,
  readyPayment,
  settle,
  verifyRecipient,
} from './support/fixtures.js';
import { claimPoll, divergence, finishPlayback, playback } from './support/protocols.js';

useDatabase();

/** Source run: dispatch → ACKNOWLEDGED → one status query → SUCCEEDED → settled; then COMPLETED. */
async function buildSource() {
  const versionId = await createProfile({ pollLeaseMs: 150 });
  const flow = await readyPayment(versionId);
  const d = await tx(app, (c) =>
    dispatchAttempt(c, { runId: flow.runId, paymentId: flow.payout.paymentId }),
  );
  await tx(app, async (c) => {
    const ack = await bankResponse(c, {
      runId: flow.runId,
      requestId: d.requestId,
      classification: 'ACKNOWLEDGED',
    });
    await changeAttempt(c, {
      runId: flow.runId,
      attemptId: d.attemptId,
      to: 'SUBMITTED',
      cause: { type: 'BANK_RESPONSE', responseId: ack },
    });
  });
  const claim = await claimPoll(app, d.attemptId, 60_000);
  const sq = await tx(app, (c) =>
    bankRequest(c, {
      runId: flow.runId,
      type: 'STATUS_QUERY',
      attemptId: d.attemptId,
      key: d.bankReference,
      pollGeneration: claim?.generation,
    }),
  );
  await tx(app, async (c) => {
    const ok = await bankResponse(c, {
      runId: flow.runId,
      requestId: sq.id,
      classification: 'SUCCEEDED',
    });
    await settle(c, {
      runId: flow.runId,
      paymentId: flow.payout.paymentId,
      attemptId: d.attemptId,
      cause: { type: 'BANK_RESPONSE', responseId: ok },
    });
  });
  await completeRun(app, flow.runId);
  return { versionId, flow, d };
}

/** Replay run re-feeding the source's commands up to READY_FOR_PAYMENT, reusing the reference. */
async function startReplay(src: Awaited<ReturnType<typeof buildSource>>) {
  const replay = await createRun(src.versionId, {
    type: 'REPLAY',
    sourceRunId: src.flow.runId,
    secret: src.flow.secret,
  });
  const claimId = await createClaim(app, replay.runId);
  const payout = await tx(app, async (c) => {
    const p = await createPayout(c, {
      runId: replay.runId,
      claimId,
      reference: src.flow.payout.reference,
    });
    await verifyRecipient(c, { runId: replay.runId, paymentId: p.paymentId });
    await approvePayment(c, { runId: replay.runId, paymentId: p.paymentId });
    return p;
  });
  const ids = { replayRunId: replay.runId, sourceRunId: src.flow.runId };
  return { replay, payout, ids };
}

async function responseIdFor(requestId: string): Promise<string> {
  return (
    await one<{ id: string }>(
      app,
      `SELECT id FROM paysim."BankInteractionResponse" WHERE "requestId" = $1`,
      [requestId],
    )
  ).id;
}

const SOURCE_TABLES = [
  'Payment',
  'PaymentAttempt',
  'PaymentTransition',
  'AttemptStatusChange',
  'Settlement',
  'BankInteractionRequest',
  'BankInteractionResponse',
  'InboundCommand',
];

async function sourceFingerprint(runId: string): Promise<string> {
  const parts: string[] = [];
  for (const t of SOURCE_TABLES) {
    const r = await one<{ h: string | null }>(
      app,
      `SELECT md5(string_agg(t::text, '|' ORDER BY t.id)) AS h FROM paysim."${t}" t WHERE t."simulationRunId" = $1`,
      [runId],
    );
    parts.push(`${t}:${r.h ?? ''}`);
  }
  return parts.join(';');
}

describe('replay', () => {
  it('reproduces recorded responses, reuses references with new IDs, and never mutates the source', async () => {
    const src = await buildSource();
    const before = await sourceFingerprint(src.flow.runId);
    const { replay, payout, ids } = await startReplay(src);
    expect(payout.reference).toBe(src.flow.payout.reference);
    expect(payout.paymentId).not.toBe(src.flow.payout.paymentId);

    const d = await tx(app, (c) =>
      dispatchAttempt(c, { runId: replay.runId, paymentId: payout.paymentId }),
    );
    expect(d.bankReference).toBe(src.d.bankReference);
    expect(d.attemptId).not.toBe(src.d.attemptId);
    expect(await tx(app, (c) => playback(c, { ...ids, replayRequestId: d.requestId }))).toEqual({
      served: 'RECORDED',
      classification: 'ACKNOWLEDGED',
    });

    await expectDbError(
      app.query(
        `UPDATE paysim."Payment" SET "nextDispatchAt" = now(), version = version + 1 WHERE id = $1`,
        [src.flow.payout.paymentId],
      ),
      'RUN_NOT_WRITABLE',
    );
    await expectDbError(
      insertCommand(app, { runId: src.flow.runId, type: 'CREATE_PAYOUT' }),
      'RUN_NOT_WRITABLE',
    );
    expect(await sourceFingerprint(src.flow.runId)).toBe(before);
    expect(await count(app, 'paysim."ReplayDivergence"')).toBe(0);
  });

  it('a payload mismatch creates a divergence, answers NO_RESPONSE, and the replay continues', async () => {
    const src = await buildSource();
    const { replay, payout, ids } = await startReplay(src);
    const d = await tx(app, (c) =>
      dispatchAttempt(c, {
        runId: replay.runId,
        paymentId: payout.paymentId,
        payload: { tampered: true },
      }),
    );
    const res = await tx(app, (c) => playback(c, { ...ids, replayRequestId: d.requestId }));
    expect(res).toEqual({
      served: 'NO_RESPONSE',
      divergence: 'REQUEST_MISMATCH',
      classification: 'NO_RESPONSE',
    });
    const div = await one<{
      divergenceType: string;
      sourcePayloadHash: string;
      replayPayloadHash: string;
    }>(
      app,
      `SELECT "divergenceType", "sourcePayloadHash", "replayPayloadHash" FROM paysim."ReplayDivergence"`,
    );
    expect(div.divergenceType).toBe('REQUEST_MISMATCH');
    expect(div.sourcePayloadHash).toBe(src.d.payloadHash);
    expect(div.replayPayloadHash).toBe(d.payloadHash);

    // Continue: the timeout leaves the attempt UNKNOWN; the next poll matches the recording.
    await tx(app, async (c) =>
      changeAttempt(c, {
        runId: replay.runId,
        attemptId: d.attemptId,
        to: 'UNKNOWN',
        cause: { type: 'BANK_RESPONSE', responseId: await responseIdFor(d.requestId) },
      }),
    );
    const claim = await claimPoll(app, d.attemptId, 60_000);
    const sq = await tx(app, (c) =>
      bankRequest(c, {
        runId: replay.runId,
        type: 'STATUS_QUERY',
        attemptId: d.attemptId,
        key: d.bankReference,
        pollGeneration: claim?.generation,
      }),
    );
    expect(await tx(app, (c) => playback(c, { ...ids, replayRequestId: sq.id }))).toEqual({
      served: 'RECORDED',
      classification: 'SUCCEEDED',
    });
    await tx(app, async (c) =>
      settle(c, {
        runId: replay.runId,
        paymentId: payout.paymentId,
        attemptId: d.attemptId,
        cause: { type: 'BANK_RESPONSE', responseId: await responseIdFor(sq.id) },
      }),
    );
    await completeRun(app, replay.runId);
    const run = await one<{ status: string; diverged: boolean }>(
      app,
      `SELECT status, diverged FROM paysim."SimulationRun" WHERE id = $1`,
      [replay.runId],
    );
    expect(run).toEqual({ status: 'COMPLETED', diverged: true }); // DIVERGED is a marker, not a status
  });

  it('a request the source never made is a playback miss', async () => {
    const src = await buildSource();
    const { replay, payout, ids } = await startReplay(src);
    const d = await tx(app, (c) =>
      dispatchAttempt(c, { runId: replay.runId, paymentId: payout.paymentId }),
    );
    await tx(app, (c) => playback(c, { ...ids, replayRequestId: d.requestId }));
    await tx(app, async (c) =>
      changeAttempt(c, {
        runId: replay.runId,
        attemptId: d.attemptId,
        to: 'SUBMITTED',
        cause: { type: 'BANK_RESPONSE', responseId: await responseIdFor(d.requestId) },
      }),
    );
    const c1 = await claimPoll(app, d.attemptId, 150);
    const sq1 = await tx(app, (c) =>
      bankRequest(c, {
        runId: replay.runId,
        type: 'STATUS_QUERY',
        attemptId: d.attemptId,
        key: d.bankReference,
        pollGeneration: c1?.generation,
      }),
    );
    await tx(app, (c) => playback(c, { ...ids, replayRequestId: sq1.id }));
    await sleep(250); // a changed build polls again: occurrence 2 was never recorded
    const c2 = await claimPoll(app, d.attemptId, 60_000);
    const sq2 = await tx(app, (c) =>
      bankRequest(c, {
        runId: replay.runId,
        type: 'STATUS_QUERY',
        attemptId: d.attemptId,
        key: d.bankReference,
        pollGeneration: c2?.generation,
      }),
    );
    expect(sq2.occurrenceNo).toBe(2);
    expect(await tx(app, (c) => playback(c, { ...ids, replayRequestId: sq2.id }))).toEqual({
      served: 'NO_RESPONSE',
      divergence: 'PLAYBACK_MISS',
      classification: 'NO_RESPONSE',
    });
  });

  it('detects recordings the replay never used', async () => {
    const src = await buildSource();
    const { replay, payout, ids } = await startReplay(src);
    const d = await tx(app, (c) =>
      dispatchAttempt(c, { runId: replay.runId, paymentId: payout.paymentId }),
    );
    await tx(app, (c) => playback(c, { ...ids, replayRequestId: d.requestId }));
    expect(await tx(app, (c) => finishPlayback(c, ids))).toBe(1); // the source's status query
    expect(
      await count(app, 'paysim."ReplayDivergence"', `"divergenceType" = 'UNUSED_RECORDING'`),
    ).toBe(1);
    await expectDbError(
      tx(app, (c) => finishPlayback(c, ids)),
      '23505',
    ); // deterministic keys: no duplicate findings
  });

  it('cross-run references cannot point at an unrelated run', async () => {
    const src = await buildSource();
    const { ids } = await startReplay(src);
    const other = await createRun(src.versionId);
    const otherCmd = await insertCommand(app, { runId: other.runId, type: 'CREATE_PAYOUT' });
    await completeRun(app, other.runId);
    // The replay's source must be its real source run.
    await expectDbError(
      tx(app, (c) =>
        divergence(c, {
          replayRunId: ids.replayRunId,
          sourceRunId: other.runId,
          type: 'COMMAND_OUTCOME_MISMATCH',
          key: 'x',
        }),
      ),
      '23503',
    );
    // Source evidence must belong to the source run.
    await expectDbError(
      tx(app, (c) =>
        divergence(c, {
          ...ids,
          type: 'COMMAND_OUTCOME_MISMATCH',
          key: 'y',
          sourceCommandId: otherCmd,
        }),
      ),
      '23503',
    );
    // A scenario run cannot own divergences at all.
    await expectDbError(
      tx(app, (c) =>
        divergence(c, {
          replayRunId: src.flow.runId,
          sourceRunId: other.runId,
          type: 'PLAYBACK_MISS',
          key: 'z',
        }),
      ),
      'RUN_NOT_WRITABLE',
    );
  });
});
