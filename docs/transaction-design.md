# PaySim Transaction and Concurrency Design

> **Status: approved design (Phase 3).** This document defines, for each operation, the
> transaction boundaries, locks, constraints relied on, external calls, crash points, recovery
> and idempotency behaviour.
>
> Phase 3 implements the **database side** of these protocols: constraints, triggers and
> grants. It also implements **reference versions** of the claim, idempotency, polling and
> playback protocols in the database test suite. The production services that run these
> operations are Phase 4 work.
>
> References: §, D, I = [`payment-lifecycle.md`](payment-lifecycle.md) rev. 5;
> DM, C = [`data-model-decisions.md`](data-model-decisions.md).

## 1. Global rules

1. **Isolation.** All transactions run at `READ COMMITTED`. Rows are locked explicitly
   before any read whose result decides a write.
2. **One lock order.** Each transaction acquires only the classes it needs, always in this
   order, and never in reverse:

   ```text
   [I] idempotency advisory lock  →  [C] claim row  →  [P] payment row
        →  [A] attempt row  →  [E] provider-event row  →  [N] anomaly row
   ```

   - **Row locks** are `SELECT … FOR NO KEY UPDATE`. This conflicts with itself, but not with
     the `KEY SHARE` locks that foreign-key checks take, so inserting child rows is never
     blocked needlessly.
   - **[R] run row.** Only _complete run_ and _abort run_ lock the run row in exclusive mode
     (`FOR UPDATE`), and they take no other row locks while holding it.
   - **Implicit run locks.** Every insert or update of a run-owned record takes `FOR KEY
SHARE` on its run row (in the run-writable trigger). That conflicts **only** with
     [R], which is what makes completion safe.

3. **No transaction is open during an external bank call.** Every bank call follows the
   same pattern: record the request (commit) → call → record the response (commit).
4. **Bank-side writes use the simulated bank's own connection and transactions** (D31). A
   PaySim rollback never undoes a bank-side receipt, and the reverse holds too.
5. **Run gate.** Inserts and updates of run-owned operational records require the run to be
   `ACTIVE`. Seeding tables (claims, recipients, bank accounts) also allow `CREATED`.
   Configuration tables allow **only** `CREATED`.
6. **Deferred integrity checks** run at commit:
   - payment status = latest transition, and a current snapshot exists;
   - attempt status = latest status change;
   - anomaly status = latest action, with an `OPENED` action and at least one evidence row.

## 2. Keyed-command envelope (operations 1–5, 11–14)

Every keyed command runs inside this envelope (D28, C1, C2). `{work}` is the operation's
business logic.

```text
BEGIN
  [I] pg_try_advisory_xact_lock(idempotency_lock_key(run, actor, key))
      └─ not acquired → ROLLBACK; respond 409 IDEMPOTENCY_REQUEST_IN_PROGRESS (nothing written)
  existing := IdempotencyRecord(run, actor, key)
      ├─ existing, same fingerprint → INSERT InboundCommand(IDEMPOTENT_REPLAY); COMMIT; replay stored response
      └─ existing, different fingerprint → INSERT InboundCommand(REJECTED, IDEMPOTENCY_KEY_REUSED); COMMIT; 422
  SAVEPOINT work
    check actor against the allowlist     -- not permitted → deterministic rejection FORBIDDEN
    INSERT InboundCommand(ACCEPTED)       -- first, so effects can reference it (foreign keys)
    {work}                                -- may raise a business rejection (or a PAYSIM_ trigger code)
  on success:   INSERT IdempotencyRecord(ACCEPTED); COMMIT → 2xx
  on deterministic rejection:
                ROLLBACK TO SAVEPOINT work   -- discards the ACCEPTED row and every effect
                INSERT InboundCommand(REJECTED, code) + IdempotencyRecord(REJECTED, code); COMMIT → 4xx
  on transient rejection (VERSION_CONFLICT):
                ROLLBACK TO SAVEPOINT work
                INSERT InboundCommand(REJECTED, code) only; COMMIT → 409
  if COMMIT fails → respond 5xx (no outcome recorded; the key stays free)
```

**Trigger codes as rejections.** Database triggers raise `PAYSIM_<CODE>` errors. The envelope
maps `CLAIM_ALLOCATION_EXCEEDED`, `SELF_APPROVAL_FORBIDDEN`, `STALE_APPROVAL_TARGET`,
`ILLEGAL_TRANSITION` (→ `INVALID_TRANSITION`), `FORBIDDEN` and `VERSION_CONFLICT` to
rejections. Any other error rolls back everything and returns `5xx`. The reference
implementation is `apps/api/test/db/support/protocols.ts`.

**Fingerprint.** `sha256(canonicalJson({commandType, apiVersion, payload}))`. Canonical JSON
has sorted keys, no insignificant whitespace, and amounts as digit strings.

**Crash at any point** before `COMMIT`: the advisory lock is released and nothing is
recorded, so a retry runs normally.

---

## 3. Operations

Each operation lists:

- **Tx:** transaction boundaries.
- **Locks:** rows locked, in order.
- **Relies on:** constraints and triggers.
- **External:** bank calls, before or after commit.
- **Crash:** crash points and recovery.
- **Idem.:** idempotency behaviour.

### 1. Create payout (T1)

- **Tx:** the keyed envelope, one transaction.
- **Locks:** [I] → [C] claim (the payment-insert trigger also takes it, so it can't be
  skipped).
- **Work:**
  - check the claim is approved and the currency matches;
  - allocation sum + amount ≤ approved;
  - insert `Payment` (reference from the per-year sequence);
  - insert `RecipientSnapshot` S₁ and set `Payment.currentSnapshotId`;
  - insert `PaymentTransition` #1.
- **Relies on:** the claim-allocation trigger (I9); deferred payment checks; reference
  uniqueness.
- **External:** none. Verification is requested afterwards (operation 6).
- **Crash:** before commit, nothing exists. After commit, verification picks the payment up.
- **Idem.:** a duplicate key replays the `201`. A different key for the same claim hits
  allocation: `CLAIM_ALLOCATION_EXCEEDED`, a deterministic rejection bound to that key.

### 2. Correct recipient (T5)

- **Tx:** the keyed envelope.
- **Locks:** [I] → [P].
- **Work:** check status `RECIPIENT_VERIFICATION_FAILED`; insert snapshot Sₙ₊₁; update the
  payment (current snapshot, status, version + 1); insert the transition.
- **Relies on:** the transition rule table; snapshot uniqueness; payment version.
- **External:** none.
- **Crash:** atomic.
- **Idem.:** as the envelope. A stale version is `VERSION_CONFLICT` (transient).

### 3. Approve payment (T7)

- **Tx:** the keyed envelope.
- **Locks:** [I] → [P].
- **Work:** check status `PENDING_APPROVAL` and that the command's snapshot and amount equal
  the current values; insert `Approval`; update the payment (`READY_FOR_PAYMENT`,
  `nextDispatchAt = now`); insert the transition.
- **Relies on:** the approval trigger (current snapshot, `MATCH`/`APPLIED` verification,
  amount and currency, approver ≠ creator, `APPROVE_PAYMENT` permission); `Approval.paymentId`
  unique.
- **External:** none.
- **Crash:** atomic.
- **Idem.:** as the envelope. Rejection codes `SELF_APPROVAL_FORBIDDEN` and
  `STALE_APPROVAL_TARGET` are deterministic.

### 4. Reject payment (T8) and 5. Cancel payment (T4, T6, T9, T11)

- **Tx:** the keyed envelope.
- **Locks:** [I] → [C] (releasing states, §7.2) → [P].
- **Work:** check the source state is legal; update the payment; insert the transition with a
  reason.
- **Relies on:** the transition rule table. For T11, the partial unique index guarantees no
  unresolved attempt can exist in `READY_FOR_PAYMENT`.
- **External:** none.
- **Crash:** atomic.
- **Idem.:** as the envelope. Cancelling from `PROCESSING` is `INVALID_TRANSITION`
  (deterministic).

### 6. Verify recipient

1. **Tx-1 (request).** Lock [P]. Check the payment is `PENDING_RECIPIENT_VERIFICATION` and the
   snapshot is current. Insert a `BankInteractionRequest` (`VERIFY_ACCOUNT`, key
   `{paymentRef}#S{n}`, next occurrence). Commit.
2. **External:** the bank's `VERIFY_ACCOUNT` (bank-side read of `SimulatedBankAccount`).
3. **Tx-2 (response).** Lock [P]. Insert the `BankInteractionResponse`.
   - **Definitive outcome:** insert `VerificationResult`, with disposition `APPLIED` if the
     snapshot is still current and the payment is still `PENDING_RECIPIENT_VERIFICATION`,
     otherwise `STALE_SNAPSHOT`. If applied, update the payment (T2 or T3) and insert the
     transition.
   - **Transient outcome:** response only.

   Commit.

- **Crash:**
  - after Tx-1, an unanswered request remains; the verifier retries with the next occurrence;
  - after the call, the same (verification has no bank side effect).
- **Idem.:** system-driven. The occurrence constraint and the payment lock serialise it.

### 7. Dispatch payment (T10)

1. **Tx-1 (intent).** Lock [P]. Check `READY_FOR_PAYMENT`, `nextDispatchAt ≤ now`, no open
   critical anomaly, and attempts < limit. Insert `PaymentAttempt` (`PENDING`, next attempt
   number, bank reference `PSIM-{ref}-{nn}`, acceptance deadline = now + TTL) and its
   `AttemptStatusChange` (∅ → `PENDING`). Update the payment (`PROCESSING`, version + 1,
   `nextDispatchAt = null`). Insert the transition. Insert the `DISPATCH` request (next
   occurrence). Commit.
2. **External:** the bank's `DISPATCH`.
3. **Tx-2.** Operation 8.

- **Relies on:**
  - the partial unique index (one unresolved attempt, I1);
  - the attempt-insert trigger (built from the approval; no open critical anomaly);
  - the occurrence constraint.
- **Crash:**
  - before Tx-1 commits, nothing exists;
  - after Tx-1, the attempt is `PENDING` with an unanswered request; recovery is operation 16.
- **Idem.:** a second dispatcher fails on the payment `version` or the partial unique index.

### 8. Receive bank response (dispatch or status query)

- **Tx:** lock [P] → [A].
  - **Always** insert the `BankInteractionResponse` (evidence).
  - If the attempt is still in the expected state, and (for polls) the poll token matches:
    insert an `AttemptStatusChange` and update the attempt (§5.2). Where §5.3 requires it,
    update the payment (T12, T13 or T14) and insert the transition; for T12, also insert the
    `Settlement`. T14 also locks [C] first; see below.
  - Commit.
- **Releasing transitions.** When the outcome is known to be T14 before locking, lock order is
  [C] → [P] → [A]. When it is only discovered after locking [P], roll back and retry with [C]
  first. This prevents a reverse acquisition path.
- **Relies on:** the attempt status matrix trigger; the settlement trigger and uniqueness;
  `BankInteractionResponse.requestId` unique; deferred status checks.
- **Crash:** before commit, the request stays unanswered and recovery queries again. The
  response is never half-applied.
- **Idem.:** a second response for the same request fails on `UNIQUE (requestId)`.

### 9. Process provider event (§8.5)

1. **Claim Tx.** Lock [E] via conditional update: set `PROCESSING`, a new token,
   `attemptCount + 1` and a lease. Commit.
2. **Process Tx.** Resolve the attempt from the bank reference (read). Lock [C] if a releasing
   outcome is possible → [P] → [A] → [E] (fenced finalise). Then:
   - apply the attempt and payment effects (as in operation 8) and the settlement;
   - open anomalies, locking [N] after [E];
   - write the outcome;
   - `UPDATE … SET status = PROCESSED WHERE claimToken = :token`;
   - insert the `EventProcessingAttempt` (`COMPLETED`).
   - If the fenced update affects 0 rows, roll back everything.
   - Commit.
3. **Technical failure Tx.** Lock [E] and update with the token match: `PROCESSING_ERROR`
   (with back-off), or `PROCESSING_EXHAUSTED` at the limit. Insert the processing attempt
   (`TECHNICAL_ERROR`). On exhaustion, insert the anomaly, its evidence and its `OPENED`
   action, locking [P] first if the event resolves to a payment, which gives
   [P] → [A] → [E] → [N]. Commit.

- **Relies on:** the event state-machine trigger (claim increments, token kept on finalise,
  limit); the settlement unique index; the deferred checks.
- **Crash:**
  - after claim, the lease expires and the sweeper reclaims it (operation 9 again), or
    exhausts it with a `LEASE_EXPIRED` processing attempt;
  - during processing, the rollback means no effect.
- **Idem.:** event identity is unique, and a stale worker can't commit (fencing).

### 10. Receive webhook delivery (§8.2)

- **Pre-tx:** hash the ingress key and look up `SimulatedBank` (run `ACTIVE`). If absent:
  `404`, a log line, no write. Verify the signature and parse.
- **Tx:**
  - insert the `WebhookDelivery`;
  - `INSERT … ON CONFLICT (run, provider, providerEventId) DO NOTHING` the `ProviderEvent`;
  - choose the receipt outcome by comparing payload hashes;
  - on `CONFLICTING_PAYLOAD`, open a critical anomaly ([P] first if resolvable → [N]);
  - commit → `2xx`.
- **No locks** on payments otherwise.
- **Crash:** before commit, `5xx` and the provider redelivers. After commit, processing is
  operation 9.
- **Idem.:** event identity is unique. A duplicate delivery adds a delivery row only.

### 11. Requeue provider event

- **Tx:** the keyed envelope. Lock [I] → [E]. Check `PROCESSING_EXHAUSTED`; set `RECEIVED`,
  `attemptCount = 0`, `requeueGeneration + 1`, and clear the token. The command needs
  `REQUEUE_EVENT`.
- **Relies on:** the event state-machine trigger (requeue rule).
- **Crash:** atomic.
- **Idem.:** as the envelope.
- **Note:** the open exhaustion anomaly is **not** resolved by a requeue or by its success
  (D25).

### 12. Resolve anomaly and 13. Reopen anomaly

- **Tx:** the keyed envelope. Lock [I] → ([P] if the anomaly is critical and linked; D23 for
  reopen) → [N]. Insert an `AnomalyAction` (next sequence) and update `Anomaly.status` and
  `lastActionSequenceNo`.
- **Relies on:** the action trigger (critical ⇒ user with `RESOLVE_CRITICAL_ANOMALY` and a
  command cause; legal state progression); the deferred status = latest action check.
- **Crash:** atomic.
- **Idem.:** as the envelope. Resolving an already-resolved anomaly is `INVALID_TRANSITION`.

### 14. Resolve attempt (manual reconciliation)

- **Tx:** the keyed envelope. Lock [I] → [C] (if the outcome is `FAILED_PERMANENT`) → [P] →
  [A] → [N]. Insert an `AttemptStatusChange` (command cause, target `SUCCEEDED` or
  `FAILED_PERMANENT` only) and update the attempt. Apply T12 or T14 with the transition (and
  the settlement for T12). Auto-resolve the linked `ATTEMPT_UNRESOLVED` anomaly if the
  attempt is now resolved (Attention, `CONDITION_CLEARED`).
- **Relies on:** the attempt status-change trigger (permission and allowed targets).
- **Idem.:** as the envelope.

### 15. Poll bank status (§5.8)

1. **Claim Tx.** Lock [A] rows via `FOR UPDATE SKIP LOCKED` (due, unresolved, no live lease).
   Set the poll token, the lease and `pollGeneration + 1`. Commit.
2. **Request Tx.** Lock [P] → [A]. Check the token. Insert the `STATUS_QUERY` request (next
   occurrence, `pollGeneration`). Commit.
3. **External:** the bank's `STATUS_QUERY`.
4. **Response Tx.** Operation 8 (fenced by the poll token). Clear the claim and set
   `nextStatusQueryAt`. Apply the N1–N6 rule before treating a not-found as definitive.

- **Lock-order note:** the claim transaction locks only attempt rows and commits before any
  payment lock is taken, so no reverse path exists.
- **Relies on:** the poll-claim trigger rules; the partial unique `(attempt, pollGeneration)`
  for status queries; the occurrence constraint.
- **Crash:** see lifecycle §5.8.

### 16. Recover unknown attempt

- **Tx:** lock [P] → [A]. For a `PENDING` attempt older than the grace period, move it to
  `UNKNOWN` (with an `AttemptStatusChange`, cause `SYSTEM_JOB`) and set `nextStatusQueryAt`.
  For attempts past `escalateAt`, set `escalatedAt` and open `ATTEMPT_UNRESOLVED` ([N]).
  Commit. Polling (operation 15) then resolves it.
- **External:** none. Recovery is query-only (D19).
- **Idem.:** conditional on the current status; the anomaly evidence key deduplicates.

### 17. Replay a completed run

1. **Create Tx.** Insert `SimulationRun` (`REPLAY`, `sourceRunId`; the trigger requires the
   source to be `COMPLETED` with the same configuration version and settings). Insert the
   `SimulatedBank` rows copied from the source (the trigger checks they are equal). Commit.
   Activate.
2. **Feed inputs** through the normal operations, on the simulated clock. Bank calls go to the
   **playback adapter**:
   - locate `(type, readableKey, occurrence)` in the source run's requests and compare hashes;
   - serve the recorded response, `NO_RESPONSE` (unanswered source), or `NO_RESPONSE` plus a
     divergence (`REQUEST_MISMATCH` or `PLAYBACK_MISS`).
3. **Compare Tx.** Insert `ReplayDivergence` rows for `UNUSED_RECORDING` and the outcome
   comparisons. Each insert sets `diverged = true`. Complete the replay (operation 18).

- **Relies on:** the cross-run composite reference (divergence → the replay's own
  `(id, sourceRunId)`); the source being `COMPLETED`, so the run gate makes it immutable;
  divergence key uniqueness.
- **Crash:** the replay can be aborted and re-run. The source is untouched.

### 18. Complete or abort a run

- **Tx:** lock [R] (`FOR UPDATE`; this waits for in-flight inserts holding `KEY SHARE`).
  - **To complete:** require **no in-flight work**: no events in `RECEIVED`, `PROCESSING` or
    `PROCESSING_ERROR`; no unresolved attempts; no live poll claims.
  - Update the status. Commit.
  - After commit, the run gate rejects every further insert or update for the run.
- **Abort** is allowed from `CREATED` or `ACTIVE` regardless of in-flight work. Abandoned work
  stays visible.
- **Relies on:** the run status trigger (legal progression and the completion check, which
  runs while the run row is held exclusively).

## 4. Deadlock and race review

| Risk                                          | Prevention                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------ |
| Two payouts over-allocate a claim             | [C] lock, taken by both the application and the payment-insert trigger.        |
| Cancel races dispatch                         | Both lock [P]; payment `version`.                                              |
| Two dispatchers                               | [P] lock; the partial unique index.                                            |
| Two event workers                             | Conditional claim update; fencing token on finalise.                           |
| Two pollers                                   | `SKIP LOCKED` claim; per-generation request uniqueness; token-fenced response. |
| A critical anomaly opened during dispatch     | Both hold [P] (D23); the attempt-insert trigger re-checks.                     |
| Run completes while work is inserted          | [R] `FOR UPDATE` vs the gate's `FOR KEY SHARE`.                                |
| Reverse lock path ([P] held, then [C] needed) | Roll back and retry with [C] first (operations 8 and 9).                       |
