# PaySim Database Design

> **Status: implemented (Phase 3).** This document maps each invariant to the layer that
> enforces it:
>
> | Layer      | Meaning                                                                                 |
> | ---------- | --------------------------------------------------------------------------------------- |
> | **DB**     | A constraint, index, trigger or grant. It holds even if application code is wrong.      |
> | **Tx**     | The transaction protocol in [`transaction-design.md`](transaction-design.md).           |
> | **App**    | A Phase 4 service rule. It is **not** yet implemented, and **not** claimed as enforced. |
> | **Worker** | A worker protocol: claims, leases, sweepers.                                            |
> | **Test**   | The database integration test proving it (`apps/api/test/db/*.db-spec.ts`).             |
>
> Schema: `prisma/schema.prisma`. Migrations: `prisma/migrations/`.

## 1. Physical layout

| Schema      | Purpose                                               | Roles                                                                                            |
| ----------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `simconfig` | Global catalogue, plus the shared `uuidv7()` function | Owner writes. `paysim_app` and `simbank_app`: `SELECT`, `EXECUTE`.                               |
| `paysim`    | PaySim-side records                                   | `paysim_app`: `SELECT` and `INSERT`; `UPDATE` only on listed columns. No `DELETE` or `TRUNCATE`. |
| `simbank`   | Simulated bank state                                  | `simbank_app` likewise. `paysim_app` has **no `USAGE`**.                                         |

- **Roles.** `paysim_app` and `simbank_app` are created by the migration as `NOLOGIN` group
  roles. Environment setup grants them `LOGIN` and a password.
- **The schema owner** (the Docker superuser) runs migrations and owns every object. A
  superuser bypasses grants but **not** triggers.

## 2. Financial integrity

| Invariant                                       | Mechanism                                                                                                                                                                                                                | Layer         | Test                                                    |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- | ------------------------------------------------------- |
| Integer minor units; no floats (C1, I14)        | `BIGINT` amount columns; `CHECK (amount > 0)`; no numeric or float money columns                                                                                                                                         | DB            | `financial` › minor-unit precision                      |
| ISO currency code                               | `CHAR(3)` plus `CHECK (currency ~ '^[A-Z]{3}$')`                                                                                                                                                                         | DB            | `financial` › currency format                           |
| Amount and currency fixed (I4)                  | No `UPDATE` grant on amount and currency columns; immutable-column triggers; approval, attempt and settlement triggers compare against their parent                                                                      | DB            | `financial` › approval bound                            |
| No over-allocation of a claim (I9)              | The payment-insert trigger takes `FOR NO KEY UPDATE` on the claim, then checks Σ(live payments) + amount ≤ approved. The lock makes concurrent inserts serialise.                                                        | DB + Tx       | `financial` › concurrent allocation                     |
| One unresolved attempt (I1)                     | Partial unique index `PaymentAttempt(paymentId) WHERE status IN (PENDING, SUBMITTED, UNKNOWN)`                                                                                                                           | DB            | `financial` › one unresolved attempt                    |
| One settlement per payment (I2)                 | `UNIQUE (paymentId)` on `Settlement`; the settlement trigger requires a `SUCCEEDED` attempt of the same payment, with equal amount and currency                                                                          | DB            | `financial` › one settlement; duplicate webhook         |
| Immutable approval and snapshots (D12, I10)     | Insert-only triggers; the approval trigger checks current snapshot, verification, amount, approver ≠ creator and permission; `Approval.paymentId` unique                                                                 | DB            | `financial` › approval bound                            |
| Duplicate provider events have no effect (I3)   | `UNIQUE (run, provider, providerEventId)`; fenced processing; the settlement unique index as a backstop                                                                                                                  | DB + Worker   | `webhook` › duplicates; `financial` › duplicate webhook |
| Legal payment transitions (§4.1)                | The `PaymentTransition` trigger checks `(from, trigger, to)` against the 14 rules, and `from` = the previous `to`. A deferred trigger checks payment status = latest transition (I5) and that a current snapshot exists. | DB            | `financial` › illegal transition                        |
| Legal attempt transitions (§5.2)                | The `PaymentAttempt` update trigger matrix; deferred status = latest `AttemptStatusChange`                                                                                                                               | DB            | `financial` › attempt matrix                            |
| No dispatch with an open critical anomaly (D15) | The attempt-insert trigger checks for open critical anomalies on the payment                                                                                                                                             | DB            | `anomalies` › critical blocks dispatch                  |
| Back-off before dispatch (L8)                   | `nextDispatchAt` check in the dispatcher                                                                                                                                                                                 | App (Phase 4) | —                                                       |

## 3. Idempotency (D28, C1, C2)

| Rule                                    | Mechanism                                                                                                                                                 | Layer      | Test                                             |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------ |
| Advisory lock scope                     | `simconfig.idempotency_lock_key(run, actor, key)` = `hashtextextended('idem:' ‖ run ‖ ':' ‖ actor ‖ ':' ‖ key, 0)`, used with `pg_try_advisory_xact_lock` | DB fn + Tx | `idempotency` › concurrent                       |
| Fingerprint                             | `sha256(canonicalJson({commandType, apiVersion, payload}))`, stored on the command and the record; the record trigger checks they match                   | Tx + DB    | `idempotency` › different command type           |
| Same key, same request                  | The stored response is replayed and an `IDEMPOTENT_REPLAY` command recorded                                                                               | Tx         | `idempotency` › same payload                     |
| Same key, different request             | `422 IDEMPOTENCY_KEY_REUSED`, recorded as a `REJECTED` command; no second record (unique key)                                                             | DB + Tx    | `idempotency` › different payload                |
| Deterministic rejection bound           | The savepoint protocol; `IdempotencyRecord` CHECK: a `REJECTED` outcome needs a deterministic code                                                        | DB + Tx    | `idempotency` › deterministic rejection replayed |
| Transient rejection not bound           | CHECK excludes `VERSION_CONFLICT` and `IDEMPOTENCY_KEY_REUSED` from records                                                                               | DB         | `idempotency` › transient retry                  |
| In-progress `409` writes nothing        | The lock is not acquired, so the protocol returns before any insert                                                                                       | Tx         | `idempotency` › concurrent                       |
| `5xx` if the outcome can't be committed | Commit failure → `5xx`; nothing persists                                                                                                                  | Tx         | `idempotency` › persistence failure              |
| Exactly one outcome per key (I3)        | `UNIQUE (run, actor, key)`                                                                                                                                | DB         | all of the above                                 |

## 4. Webhooks

| Rule                                 | Mechanism                                                                                                                                                                                                                                                                                                       | Layer       | Test                                    |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | --------------------------------------- |
| Ingress routing (D29)                | `SimulatedBank.ingressKeyHash` is unique and holds SHA-256 only. Rate limits, size limits and log redaction are endpoint rules.                                                                                                                                                                                 | DB + App    | `run-lifecycle` › ingress hash          |
| Raw body cap                         | `CHECK (octet_length(rawBody) <= 65536)`                                                                                                                                                                                                                                                                        | DB          | `webhook` › duplicates                  |
| Signature validation                 | CHECKs tie `INVALID_SIGNATURE` ⇔ invalid signature, and accepted outcomes ⇒ valid signature and a linked event. Verification itself happens at the endpoint.                                                                                                                                                    | DB + App    | `webhook` › duplicates                  |
| Durable receipt; event deduplication | `UNIQUE (run, provider, providerEventId)`; `ON CONFLICT DO NOTHING`; the delivery trigger checks payload hashes against the outcome                                                                                                                                                                             | DB + Tx     | `webhook` › duplicates                  |
| Claims, leases, fencing (D24, I18)   | The `ProviderEvent` trigger: a claim requires an eligible status (or an expired lease), increments the count by exactly 1 with a new token, and respects the run's retry limit. Finalise and error updates must keep the token. `PROCESSED` is final. A requeue resets the count and increments the generation. | DB + Worker | `webhook` › claims, lease, token, crash |
| Exhaustion → anomaly (D21)           | The worker opens `EVENT_PROCESSING_EXHAUSTED` with evidence key `event:{id}:generation:{n}`                                                                                                                                                                                                                     | Worker + DB | `webhook` › exhaustion                  |
| Critical not auto-resolved (D25)     | The `AnomalyAction` trigger                                                                                                                                                                                                                                                                                     | DB          | `webhook` › critical not auto-resolved  |

## 5. Bank interactions

| Rule                                            | Mechanism                                                                                                                                                     | Layer       | Test                                                |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | --------------------------------------------------- |
| Separate insert-only request and response (D27) | Two tables; insert-only triggers; `UNIQUE (requestId)`                                                                                                        | DB          | `bank-boundary` › timeout vs no response            |
| Playback locator (DM7)                          | `UNIQUE (run, provider, type, readableKey, occurrenceNo)`; the trigger requires gap-free occurrences                                                          | DB          | `replay` › …                                        |
| One request per poll generation (C4)            | Partial unique `(subjectAttemptId, pollGeneration) WHERE interactionType = 'STATUS_QUERY'`; the trigger requires the current generation and a held poll claim | DB          | `bank-boundary` › poll fencing                      |
| Acceptance deadline                             | `BankInstruction` CHECK: `REFUSED_LATE` ⇔ `receivedAt > acceptanceDeadline`                                                                                   | DB          | `bank-boundary` › late refused                      |
| Queryability guarantee                          | `BankInstruction` CHECK: `receivedAt ≤ visibleAt ≤ receivedAt + settlementWindowMs`; a trigger copies the window from the bank profile                        | DB          | `bank-boundary` › queryability                      |
| Unknown-outcome recovery (§5.5, §5.7)           | The attempt matrix allows `PENDING → UNKNOWN`. N1–N6 are applied by the poller.                                                                               | DB + Worker | `financial` › attempt matrix                        |
| Bank isolation (D31, S1)                        | Separate schema; `paysim_app` has no `USAGE` on `simbank`; `simbank_app` has no access to `paysim` payment tables. Bank writes use the bank connection.       | DB          | `bank-boundary` › role isolation; rollback survival |

## 6. Replay

| Rule                                    | Mechanism                                                                                                                         | Layer       | Test                                  |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------- |
| Replays only from completed sources     | The `SimulationRun` insert trigger                                                                                                | DB          | `run-lifecycle` › incomplete source   |
| Same configuration as the source        | The run insert trigger (same version and settings); the `SimulatedBank` trigger (equal parameters and secret)                     | DB          | `replay` › …                          |
| New internal IDs; reused references     | UUIDv7 defaults; references are run-scoped unique                                                                                 | DB          | `replay` › new ids                    |
| Source evidence references (L3)         | `ReplayDivergence` composite FKs `(sourceXId, sourceRunId)` and `(simulationRunId, sourceRunId) → SimulationRun(id, sourceRunId)` | DB          | `replay` › unrelated run rejected     |
| Hash comparison, miss, mismatch, unused | The playback adapter (reference implementation in the test support); divergence rows                                              | Worker + DB | `replay` › …                          |
| Divergence marks the run                | The divergence-insert trigger sets `diverged = true`                                                                              | DB          | `replay` › continues after divergence |
| No mutation of source records           | The source is `COMPLETED`: the run gate rejects every insert or update; insert-only triggers                                      | DB          | `replay` › source unchanged           |

## 7. Anomalies

| Rule                                        | Mechanism                                                                                                                  | Layer | Test                               |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----- | ---------------------------------- |
| Immutable evidence (I16)                    | Insert-only; evidence inserts allowed only in the anomaly's creating transaction (`createdTxId = pg_current_xact_id()`)    | DB    | `anomalies` › evidence insert-only |
| Append-only actions                         | Insert-only; gap-free sequence; legal progression                                                                          | DB    | `anomalies` › actions append-only  |
| Controlled status, atomic with actions (L4) | Column grants (status, `lastActionSequenceNo`); deferred check that status = latest action                                 | DB    | `anomalies` › atomic               |
| Critical: human only (D25)                  | Action trigger: `RESOLVED` on critical ⇒ `USER`, command cause, `RESOLVE_CRITICAL_ANOMALY` permission                      | DB    | `anomalies` › authorised operator  |
| Reopen and linking                          | Action trigger: `REOPENED` only from resolved, by a user with `REOPEN_ANOMALY`; `relatedAnomalyId` is composite run-scoped | DB    | `anomalies` › …                    |
| Deterministic keys; requeue generation      | `UNIQUE (run, type, evidenceKey)`; `requeueGeneration` on the event                                                        | DB    | `anomalies` › requeue generation   |

## 8. Run lifecycle

| Rule                                   | Mechanism                                                                                                                                                         | Layer   | Test                                |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ----------------------------------- |
| Legal states; `DIVERGED` is separate   | Run update trigger: legal status progression; `diverged` only `false → true` on replays                                                                           | DB      | `run-lifecycle` › diverged separate |
| Configuration frozen (I20)             | Immutable-column triggers on run settings; `SimulatedBank` and `BankRunProfile` inserts only while `CREATED`                                                      | DB      | `run-lifecycle` › config frozen     |
| Safe completion                        | Run trigger on `→ COMPLETED`: no `RECEIVED`/`PROCESSING`/`PROCESSING_ERROR` events, no unresolved attempts, no live poll claims; protocol locks the run row first | DB + Tx | `run-lifecycle` › in-flight work    |
| Run ownership; writes only in `ACTIVE` | Run-gate trigger on every run-owned table (`FOR KEY SHARE` on the run)                                                                                            | DB      | `run-lifecycle` › completed rejects |
| Run-consistent references              | Composite FKs `(fk, simulationRunId) → parent(id, simulationRunId)`                                                                                               | DB      | `replay` › unrelated run rejected   |

## 9. Tables that allow controlled updates

Every other table is **insert-only**: an `UPDATE` or `DELETE` raises an error, for every role.

| Table                         | Updatable columns (granted to the app role)                                                                                                                                                                              | Why                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| `SimulationRun`               | `status`, `diverged`, `simulatedClockAt`, `activatedAt`, `completedAt`, `abortedAt`                                                                                                                                      | Run lifecycle                                |
| `Claim`                       | `approvedForPayout`                                                                                                                                                                                                      | Claim readiness; enables the row lock        |
| `Recipient`                   | `accountName`, `updatedAt`                                                                                                                                                                                               | Reusable profile edits (audited by commands) |
| `Payment`                     | `status`, `version`, `currentSnapshotId`, `nextDispatchAt`, `updatedAt`                                                                                                                                                  | State machine (C2)                           |
| `PaymentAttempt`              | `status`, `nextStatusQueryAt`, `statusQueryCount`, `earliestQualifyingQueryAt`, `escalateAt`, `escalatedAt`, `pollClaimToken`, `pollLeaseExpiresAt`, `pollGeneration`, `updatedAt`                                       | Attempt state machine; polling claims        |
| `ProviderEvent`               | `processingStatus`, `attemptCount`, `claimToken`, `leaseOwner`, `leaseExpiresAt`, `nextAttemptAt`, `lastError`, `requeueGeneration`, `outcome`, `outcomeReason`, `processedAt`, `resolvedAttemptId`, `resolvedPaymentId` | Processing protocol (I6, L1)                 |
| `Anomaly`                     | `status`, `lastActionSequenceNo`                                                                                                                                                                                         | Recorded status (L4)                         |
| `simbank.BankInstruction`     | `status`, `failureCode`, `updatedAt`                                                                                                                                                                                     | Bank-side processing                         |
| `simbank.BankWebhookDispatch` | `sentAt`, `httpStatus`                                                                                                                                                                                                   | Send bookkeeping                             |

## 10. What is not enforced by the database

These remain **application or worker responsibilities** (Phase 4). They are listed so that no
one mistakes them for database guarantees:

- N1–N6 evaluation before `UNKNOWN → FAILED_RETRYABLE` on a not-found result.
- Back-off timing (`nextDispatchAt`, `nextAttemptAt`), escalation timing, and the poll
  schedule.
- Signature verification itself, ingress rate limits, HTTP size limits, and key log
  redaction.
- Playback matching logic. This document's tests use a reference implementation.
- Retry-after-releasing-lock ordering ([C] before [P]).
- **The API currently connects as the schema owner** (`DATABASE_URL`). The grant-based
  protections apply only once services use `paysim_app` and `simbank_app` (Phase 4). The
  trigger-based protections apply to every role, including the owner.
