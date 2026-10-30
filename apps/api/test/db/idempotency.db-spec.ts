// Idempotency protocol: D28, corrections C1 (fingerprint) and C2 (in-progress writes nothing).
import { app, expectDbError, one, sleep, tx, useDatabase } from './support/db.js';
import {
  count,
  createClaim,
  createPayout,
  createProfile,
  createRun,
  insertCommand,
  transition,
} from './support/fixtures.js';
import { BusinessRejection, executeKeyedCommand, type KeyedRequest } from './support/protocols.js';

useDatabase();

async function setup() {
  const { runId } = await createRun(await createProfile());
  const claimId = await createClaim(app, runId, '250000000');
  const request = (
    key: string,
    amountMinor = '250000000',
    commandType = 'CREATE_PAYOUT',
  ): KeyedRequest => ({
    runId,
    actor: 'ops-01',
    key,
    commandType,
    payload: { claimId, amountMinor },
    targetClaimId: claimId,
  });
  const createWork =
    (amountMinor = '250000000') =>
    async (c: Parameters<Parameters<typeof executeKeyedCommand>[1]>[0], commandId: string) => {
      const p = await createPayout(c, { runId, claimId, amountMinor, commandId });
      return { paymentId: p.paymentId, reference: p.reference };
    };
  return { runId, claimId, request, createWork };
}

describe('idempotency', () => {
  it('same key and same request returns the original result without re-executing', async () => {
    const s = await setup();
    const first = await executeKeyedCommand(s.request('k-1'), s.createWork());
    const second = await executeKeyedCommand(s.request('k-1'), s.createWork());
    expect(first).toMatchObject({ status: 201, recorded: 'ACCEPTED' });
    expect(second).toMatchObject({ status: 201, recorded: 'IDEMPOTENT_REPLAY' });
    expect(second.body).toEqual(first.body);
    expect(await count(app, 'paysim."Payment"')).toBe(1);
    expect(await count(app, 'paysim."InboundCommand"', `outcome = 'IDEMPOTENT_REPLAY'`)).toBe(1);
    expect(await count(app, 'paysim."IdempotencyRecord"')).toBe(1);
  });

  it('same key with a different payload is rejected and the binding is unchanged', async () => {
    const s = await setup();
    await executeKeyedCommand(s.request('k-1', '100000000'), s.createWork('100000000'));
    const reuse = await executeKeyedCommand(
      s.request('k-1', '200000000'),
      s.createWork('200000000'),
    );
    expect(reuse).toMatchObject({
      status: 422,
      recorded: 'REJECTED',
      body: { code: 'IDEMPOTENCY_KEY_REUSED' },
    });
    expect(await count(app, 'paysim."Payment"')).toBe(1);
    expect(await count(app, 'paysim."IdempotencyRecord"')).toBe(1);
  });

  it('same body under a different command type is a different request (C1)', async () => {
    const s = await setup();
    await executeKeyedCommand(s.request('k-1'), s.createWork());
    const other = await executeKeyedCommand(s.request('k-1', '250000000', 'CANCEL_PAYMENT'), () =>
      Promise.resolve({}),
    );
    expect(other).toMatchObject({ status: 422, body: { code: 'IDEMPOTENCY_KEY_REUSED' } });
    expect(await count(app, 'paysim."Payment"')).toBe(1);
  });

  it('concurrent same-key requests: one owner, one immediate 409 that writes nothing (C2)', async () => {
    const s = await setup();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let lockTaken!: () => void;
    const ownerHasLock = new Promise<void>((resolve) => (lockTaken = resolve));
    const ownerRun = executeKeyedCommand(s.request('k-1'), s.createWork(), async () => {
      lockTaken();
      await held;
    });
    await ownerHasLock;
    const contender = await executeKeyedCommand(s.request('k-1'), s.createWork());
    expect(contender).toEqual({
      status: 409,
      body: { code: 'IDEMPOTENCY_REQUEST_IN_PROGRESS' },
      recorded: 'NOTHING',
    });
    expect(await count(app, 'paysim."InboundCommand"', `"idempotencyKey" = 'k-1'`)).toBe(0); // the 409 wrote nothing
    release();
    expect(await ownerRun).toMatchObject({ status: 201, recorded: 'ACCEPTED' });
    expect(await count(app, 'paysim."InboundCommand"', `"idempotencyKey" = 'k-1'`)).toBe(1);
    expect(await count(app, 'paysim."Payment"')).toBe(1);
  });

  it('a deterministic rejection is persisted and replayed, even after conditions change', async () => {
    const s = await setup();
    const first = await executeKeyedCommand(s.request('k-1'), s.createWork());
    const rejected = await executeKeyedCommand(s.request('k-2'), s.createWork());
    expect(rejected).toMatchObject({
      status: 422,
      recorded: 'REJECTED',
      body: { code: 'CLAIM_ALLOCATION_EXCEEDED' },
    });
    const rec = await one<{ outcome: string; rejectionCode: string }>(
      app,
      `SELECT outcome, "rejectionCode" FROM paysim."IdempotencyRecord" WHERE "idempotencyKey" = 'k-2'`,
    );
    expect(rec).toEqual({ outcome: 'REJECTED', rejectionCode: 'CLAIM_ALLOCATION_EXCEEDED' });
    // Free the allocation by cancelling the first payment; the k-2 answer must not change.
    const paymentId = (first.body as { paymentId: string }).paymentId;
    const cancel = await insertCommand(app, {
      runId: s.runId,
      type: 'CANCEL_PAYMENT',
      targetPaymentId: paymentId,
    });
    await tx(app, (c) =>
      transition(c, {
        runId: s.runId,
        paymentId,
        to: 'CANCELLED',
        trigger: 'CANCEL',
        reason: 'test',
        cause: { type: 'INBOUND_COMMAND', commandId: cancel, actor: 'ops-01' },
      }),
    );
    const retried = await executeKeyedCommand(s.request('k-2'), s.createWork());
    expect(retried).toMatchObject({
      status: 422,
      recorded: 'IDEMPOTENT_REPLAY',
      body: { code: 'CLAIM_ALLOCATION_EXCEEDED' },
    });
    expect(await count(app, 'paysim."Payment"', `status <> 'CANCELLED'`)).toBe(0);
  });

  it('an unauthorised actor gets a recorded, deterministic FORBIDDEN', async () => {
    const s = await setup();
    const res = await executeKeyedCommand({ ...s.request('k-1'), actor: 'fin-02' }, s.createWork());
    expect(res).toMatchObject({ status: 403, recorded: 'REJECTED', body: { code: 'FORBIDDEN' } });
    expect(await count(app, 'paysim."IdempotencyRecord"', `"rejectionCode" = 'FORBIDDEN'`)).toBe(1);
    expect(await count(app, 'paysim."Payment"')).toBe(0);
  });

  it('returns 5xx and records nothing when the final outcome cannot be committed', async () => {
    const s = await setup();
    const failing = await executeKeyedCommand(s.request('k-1'), async (c, commandId) => {
      const p = await createPayout(c, { runId: s.runId, claimId: s.claimId, commandId });
      // Leave the payment inconsistent with its history: the deferred check fails at COMMIT.
      await c.query(
        `UPDATE paysim."Payment" SET status = 'PENDING_APPROVAL', version = version + 1 WHERE id = $1`,
        [p.paymentId],
      );
      return { paymentId: p.paymentId };
    });
    expect(failing).toEqual({ status: 500, body: { code: 'INTERNAL_ERROR' }, recorded: 'NOTHING' });
    expect(await count(app, 'paysim."InboundCommand"')).toBe(0);
    expect(await count(app, 'paysim."IdempotencyRecord"')).toBe(0);
    // The key was never bound, so a correct retry executes.
    expect(await executeKeyedCommand(s.request('k-1'), s.createWork())).toMatchObject({
      status: 201,
      recorded: 'ACCEPTED',
    });
  });

  it('a transient rejection does not bind the key, so a retry executes', async () => {
    const s = await setup();
    const transient = await executeKeyedCommand(s.request('k-1'), () =>
      Promise.reject(new BusinessRejection('VERSION_CONFLICT')),
    );
    expect(transient).toMatchObject({
      status: 409,
      recorded: 'REJECTED',
      body: { code: 'VERSION_CONFLICT' },
    });
    expect(await count(app, 'paysim."IdempotencyRecord"')).toBe(0);
    expect(
      await count(app, 'paysim."InboundCommand"', `"rejectionCode" = 'VERSION_CONFLICT'`),
    ).toBe(1);
    await sleep(5);
    expect(await executeKeyedCommand(s.request('k-1'), s.createWork())).toMatchObject({
      status: 201,
      recorded: 'ACCEPTED',
    });
  });

  it('the database refuses to bind a transient rejection or a mismatched record', async () => {
    const s = await setup();
    const cmd = await insertCommand(app, {
      runId: s.runId,
      type: 'CREATE_PAYOUT',
      key: 'k-9',
      outcome: 'REJECTED',
      rejectionCode: 'VERSION_CONFLICT',
    });
    await expectDbError(
      app.query(
        `INSERT INTO paysim."IdempotencyRecord"("simulationRunId", "actorId", "idempotencyKey", "requestFingerprint", "commandType", "apiVersion", outcome, "rejectionCode", "responseStatus", "responseBody", "commandId")
         SELECT "simulationRunId", "actorId", "idempotencyKey", "requestFingerprint", "commandType", "apiVersion", 'REJECTED', 'VERSION_CONFLICT', 409, '{}', id FROM paysim."InboundCommand" WHERE id = $1`,
        [cmd],
      ),
      '23514',
    );
  });
});
