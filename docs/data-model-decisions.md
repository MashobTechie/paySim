# PaySim Data Model — Decision Pass

> **Status: APPROVED (Phase 3). DM1–DM12 are approved, with four corrections (§3A) and two
> safeguards (§3B). Implemented in `prisma/` (see `database-design.md`).**
> This document records the resolutions for the blocking questions in
> [`data-model.md`](data-model.md) §15. It also covers the bank-side state and the
> failure-injection configuration that the inventory left open (A13).
>
> - The lifecycle amendments in §5 (L1–L11) were applied as `payment-lifecycle.md`
>   revision 5.
>
> References:
>
> - §, C, D, Q, R and I: `payment-lifecycle.md` (revision 4).
> - O, U and A: open items in `data-model.md`.
> - **DM**: decisions proposed here.
>
> Date: 2026-10-30.

## 1. How each decision is documented

Each decision states:

1. **Decision.**
2. **Why it is necessary.**
3. **Entities affected.**
4. **Relationships and ownership.**
5. **Uniqueness.**
6. **Transactions and concurrency.**
7. **Lifecycle impact:** whether an existing invariant or rule changes.

---

## 2. Decisions already approved (carried into the model unchanged)

| Source        | Decision as it applies to the data model                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| C1, I14       | Money is integer minor units plus an ISO 4217 code; strings in the API.                                                        |
| C2            | Current status plus append-only history. No event sourcing.                                                                    |
| C3, D5        | One `Payment` with a type. Refunds and retries after failure are new, linked payments.                                         |
| C8            | Internal IDs are UUIDv7; external references are readable.                                                                     |
| D3, I1, §5.4  | Six attempt statuses; at most one unresolved attempt per payment (partial unique rule).                                        |
| D7, §8        | Provider events are separate from webhook deliveries; `2xx` only after durable receipt.                                        |
| D9            | Optimistic `version` on `Payment`.                                                                                             |
| D10, I2       | Exactly one `Settlement` per payment; no ledger.                                                                               |
| D11, §7.2     | Claim-row lock for every allocation-affecting operation; allocation is computed, never stored.                                 |
| D12, I10      | Verification and approval are bound to exact snapshots and amounts.                                                            |
| D13, D17, D27 | All inbound commands, deliveries and bank interactions are persisted; requests and responses are separate insert-only records. |
| D14           | Non-null `simulationRunId` on every simulation-owned record.                                                                   |
| D18           | Replays reuse readable payment and attempt references.                                                                         |
| D19           | Recovery is query-only.                                                                                                        |
| D23, D24      | Payment-row lock for critical anomalies; event-processing claims with a lease and fencing token.                               |
| D25, D26      | Critical anomalies need a human; playback matches requests by hash.                                                            |
| §9.3          | Uniqueness on readable or external keys includes `simulationRunId`; keys on internal parents don't.                            |

---

## 3. Approved blocking decisions

> The text of each decision is kept as approved. Where a correction (§3A) changes a
> detail, the correction takes precedence and is cross-referenced inline.

### DM1 — Webhook ingress vs. durably accepted, run-scoped deliveries

_Resolves A1 and A2 (§15 item 1)._

1. **Decision.** Separate **ingress** (any HTTP request that reaches the webhook
   endpoint) from a **delivery** (a request durably recorded against a run).
   - **Routing.** Every run-scoped simulated bank gets an opaque, randomly generated
     **ingress key**. Webhooks are posted to `/webhooks/{ingressKey}`. The key identifies
     `(run, provider)` before any authentication.
   - **Ingress key handling (safeguard S2, §3B).** The key is stored hashed, never logged,
     rate-limited and size-limited.
   - **Unattributable requests** (unknown key, malformed path, or a run that isn't
     `ACTIVE`, per DM12): respond `404`, write a structured log line, and **persist
     nothing** in the database. Such a request belongs to no run, so it can't be a
     simulation-owned record (D14), and it can never be a replay input.
   - **Attributable requests** follow §8.2 unchanged and produce `WebhookDelivery` rows,
     including `INVALID_SIGNATURE` and `MALFORMED` ones.
   - **Write failures.** If the receipt transaction fails, respond `5xx` with nothing
     persisted (as §8.3 already says). If an `INVALID_SIGNATURE` or `MALFORMED`
     delivery fails to persist, the `401`/`400` is still returned and the failure is
     logged at error level. This is the same asymmetry §9.1 applies to rejected commands.
2. **Why.** D14 needs a run on every delivery, but nothing in §8 says how an
   unauthenticated request finds its run. I6's "every webhook delivery is persisted"
   can't literally hold for a request whose receipt rolled back, or one with no run.
3. **Entities.** `SimulatedBank` (gains the ingress key), `WebhookDelivery`.
4. **Relationships and ownership.** A delivery is owned by the run of the bank its
   ingress key resolves to. Replay deliveries are re-sent through the **replay** run's
   ingress key (DM2 gives each replay its own keys).
5. **Uniqueness.** The ingress key is globally unique (it routes before a run is known).
   Otherwise unchanged.
6. **Transactions.** Key resolution is a read-only lookup before the receipt
   transaction; no locks are needed.
7. **Lifecycle impact.** Wording amendment **L1**: I6 should read "every webhook delivery
   attributed to a run whose receipt was durably recorded". **L9**: ingress routing and
   log-only handling of unattributable requests. Semantics are otherwise unchanged.

### DM2 — Run configuration, simulated banks and versioned failure injection

_Resolves O1, O2 and A12, and the failure-injection part of A13 (§15 item 2)._

1. **Decision.**
   - **New global catalogue records** (not simulation-owned, so outside D14):
     - `ConfigurationProfile`: a named profile.
     - `ConfigurationProfileVersion`: insert-only and immutable. Each version holds a
       complete configuration:
       - simulated bank definitions: provider code, settlement window _W_, acceptance
         TTL, escalation threshold, retry limit and back-off, whether the queryability
         guarantee is declared;
       - run processing defaults: event-processing retry limit and back-off, lease;
       - **failure-injection rules**;
       - a content hash.
   - **Pinning.** A `SimulationRun` pins exactly one profile version when it is created.
   - **Materialisation at run creation.** Run creation copies the pinned version into
     run-owned records:
     - run processing settings, as immutable fields on `SimulationRun`;
     - one `SimulatedBank` row per bank, with frozen parameters, a freshly generated
       per-run **signing secret**, and an **ingress key** (DM1).
     - Failure-injection rules are read from the pinned, immutable version and are not
       copied.
   - **Frozen configuration.** Once a run is `ACTIVE` (DM12), its configuration never
     changes. A change means a new profile version and a new run.
   - **Replays.** A replay pins the **same** profile version as its source, for
     provenance. It copies the source run's `SimulatedBank` parameters and signing
     secrets (§8.6), but gets new ingress keys. Failure injection is **inert** in a
     replay: bank responses come from recordings (D17), and deliveries come from
     recorded deliveries (§9.2).
2. **Why.**
   - §5.7's guarantee (N1–N3) and the D4 retry limits are only meaningful if the values
     can't change under an in-flight attempt.
   - Failure-injection settings must be reproducible and auditable per run, so a test
     result can be traced to the exact rules that produced it.
   - Signing secrets must be per run (§8.6).
3. **Entities.** New: `ConfigurationProfile`, `ConfigurationProfileVersion`. Resolved:
   `SimulatedBank` (run-owned; was ❓). Changed: `SimulationRun` (pinned version, frozen
   settings).
4. **Relationships and ownership.**
   - `SimulationRun` → `ConfigurationProfileVersion`: many-to-one, from run-owned to
     global; the version is never modified.
   - `SimulationRun` → `SimulatedBank`: one-to-many, run-owned.
   - `PaymentAttempt.provider`, `ProviderEvent.provider` and
     `BankInteractionRequest.provider` reference `SimulatedBank` by
     `(simulationRunId, provider)`.
5. **Uniqueness.**
   - `ConfigurationProfileVersion (profileId, versionNo)`;
   - `SimulatedBank (simulationRunId, provider)`;
   - `SimulatedBank (ingressKey)`, globally unique.
6. **Transactions.** Run creation materialises everything in one transaction, before the
   run becomes `ACTIVE`. Nothing updates configuration afterwards, so no locking is
   needed for reads.
7. **Lifecycle impact.**
   - New invariant **L6**: run configuration is immutable once the run is `ACTIVE`.
   - New record category **L7**: global catalogue records are not simulation-owned, and
     D14 does not apply to them.
   - Both are additions, not changes to existing rules.

### DM3 — Simulated bank accepted-instruction state

_Resolves the bank-state part of A13._

1. **Decision.** The simulated bank keeps its own state in a **bank-side namespace**,
   separate from PaySim's payment records. PaySim-side logic never reads it: it learns
   about bank state **only** through recorded bank interactions and webhooks. Run-owned
   bank-side records:
   - `SimulatedBankAccount`: the accounts a bank knows about (account number, holder
     name, status open, closed or dormant). Seeded per run. Used to answer
     `VERIFY_ACCOUNT`, and to produce permanent failures such as "account closed".
   - `BankInstruction`: each instruction the bank **received**. Holds:
     - the bank reference and the acceptance deadline from the request;
     - received time, plus whether it was accepted, or refused as late (§5.7);
     - amount, currency and destination account;
     - the bank's status (received, processing, settled, failed with code);
     - `visibleAt`, the moment it becomes queryable;
     - the planned outcome from failure-injection rules.
   - `BankWebhookDispatch`: webhooks the bank plans to send. Holds the provider event
     ID, payload, scheduled time, planned duplicates or delays, and send attempts.
   - Bank-side records are written **only in `SCENARIO` runs**. In replays the bank runs
     in playback mode and keeps no state (D17, D26).
2. **Why.**
   - The lifecycle relies on the bank remembering instructions: answering status
     queries, refusing late instructions, honouring _W_, and sending at-least-once,
     duplicate or out-of-order webhooks.
   - If PaySim could read that state directly, it could "cheat" past the uncertainty
     that §5.5 and §5.7 are designed to handle.
3. **Entities.** New, bank-side: `SimulatedBankAccount`, `BankInstruction`,
   `BankWebhookDispatch`.
4. **Relationships and ownership.**
   - All are run-owned (D14) and belong to a `SimulatedBank`.
   - There are no foreign keys from PaySim-side records into bank-side records, or the
     other way round. The bank is treated as an external system that happens to share a
     database.
   - The two sides correlate only through the bank reference and provider event IDs.
5. **Uniqueness.**
   - `SimulatedBankAccount (simulationRunId, provider, accountNumber)`;
   - `BankInstruction (simulationRunId, provider, bankReference)`. A second instruction
     with the same reference is refused by the bank contract. D19 means PaySim never
     sends one, but failure tests may.
   - `BankWebhookDispatch (simulationRunId, provider, providerEventId, sendNo)`.
6. **Transactions.**
   - Bank-side writes happen in the bank's **own** transactions, never inside a PaySim
     transaction. Calls go through an interface that behaves like a network boundary.
     This keeps crash semantics (§5.5) realistic: a PaySim rollback doesn't undo the
     bank's receipt, and the reverse holds too.
   - The queryability guarantee requires `visibleAt − receivedAt ≤ W`. That spans two
     records, so it is enforced in the bank module and by tests rather than by a
     database check.
7. **Lifecycle impact.** New invariant **L10**: "PaySim learns bank state only through
   recorded bank interactions and webhooks." It formalises the external-system
   assumption behind §5 and §8; no existing rule changes.

### DM4 — Cross-run references for replays

_Resolves O3, and the replay-evidence part of §15 item 3._

1. **Decision.** Exactly **two** cross-run references are allowed, and both are explicit
   and checked:
   - `SimulationRun.sourceRunId`, for replay runs only.
   - `ReplayDivergence`, owned by the replay run, which may reference **source-run
     evidence**. It carries `simulationRunId` (the replay) and `sourceRunId`, and the
     pair must match a replay run and its source.
   - Source evidence references are typed (DM5) and composite with `sourceRunId`.
     Replay-side references are composite with `simulationRunId`.
   - **Replays may only start from a `COMPLETED` source run** (DM12), so the evidence
     they read never changes.
   - Source-run records referenced by divergences can't be deleted. Records are
     insert-only anyway; deletion is restricted.
2. **Why.** Divergences must point at the original command, delivery, event or request
   they disagree with (§9.2, §9.4). That contradicts §9.3's rule that "child records
   belong to their parent's run" unless an explicit exception is made.
3. **Entities.** `SimulationRun`, `ReplayDivergence`.
4. **Relationships and ownership.** A divergence belongs to the replay run, which writes
   it (I8 holds: replays write only their own run's records). It **reads** source
   records by reference and never writes to them.
5. **Uniqueness.**
   - `ReplayDivergence (simulationRunId, divergenceType, divergenceKey)`. The key is
     deterministic: the source record's ID, or for a playback miss, the replay request's
     ID. Re-running a comparison therefore never duplicates findings.
   - `SimulationRun (id, sourceRunId)` is exposed as a unique pair, so the divergence's
     composite reference can be enforced.
6. **Transactions.** Divergences are written by the replay engine during playback
   (`REQUEST_MISMATCH`, `PLAYBACK_MISS`) and during the end-of-replay comparison. Each
   write is in the replay's own transaction. The source run is read-only and needs no
   locks.
7. **Lifecycle impact.** Wording amendment **L3**: add the two exceptions to §9.3. I8 is
   unchanged.

### DM5 — Polymorphic references

_Resolves O5 (§15 item 4)._

1. **Decision.** Use **typed, nullable references with a discriminator**: one column per
   allowed target type, a type field, and a check that exactly the column matching the
   type is set. Causes that have no record (dispatcher, recovery job, sweeper) use type
   `SYSTEM_JOB` with a job name, and no reference.
   - **Applied to:** `PaymentTransition` cause; `AttemptStatusChange` cause;
     `Settlement` cause; `AnomalyAction` cause; `BankInteractionRequest` subject
     (snapshot or attempt); `AnomalyEvidence` target; `ReplayDivergence` source and
     replay references.
   - Every reference is composite with the run ID (or `sourceRunId`, per DM4), so it
     stays inside the right run.
2. **Why.** A generic type-plus-ID pair can't be enforced by foreign keys, so it can
   silently point at nothing. Financial audit trails need guaranteed integrity (I5, I13,
   I16).
3. **Entities.** Listed under "Applied to".
4. **Relationships and ownership.** Each typed column is an ordinary many-to-one
   reference to its target.
5. **Uniqueness.** None added.
6. **Transactions.** None beyond the writes that already exist.
7. **Lifecycle impact.** None.

### DM6 — Idempotency-key concurrency and rejected outcomes

_Resolves A4 and A5 (§15 item 5)._

> **Corrected by C1 and C2 (§3A):** the fingerprint covers command type, API version and
> canonical payload; a request that fails to take the lock writes nothing.

1. **Decision.**
   - **Concurrency.** Each keyed command takes a **transaction-scoped advisory lock** on
     a hash of `(run, actor, key)` as its first step, without waiting.
     - If the lock isn't available, respond `409 IDEMPOTENCY_REQUEST_IN_PROGRESS`
       straight away, preserving the `409` in §10.3.
     - The lock is released automatically on commit, rollback or crash, so a key can
       never get stuck.
     - A hash collision only causes a rare, harmless `409`.
     - Inside the lock, an existing record means: return the stored response (same body
       hash), or `422 IDEMPOTENCY_KEY_REUSED` (different hash).
   - **One transaction per keyed command, using a savepoint.** The business work runs
     after a savepoint.
     - **On acceptance:** commit the effect, the `ACCEPTED` command and the idempotency
       record together, as today.
     - **On a deterministic rejection:** roll back to the savepoint (discarding every
       business change, so I7 holds), then insert the `REJECTED` command and an
       idempotency record holding the rejection response. Commit both. Deterministic
       rejections are `VALIDATION_FAILED`, `INVALID_TRANSITION`,
       `CLAIM_ALLOCATION_EXCEEDED`, `SELF_APPROVAL_FORBIDDEN` and
       `STALE_APPROVAL_TARGET`.
     - **On a transient rejection** (`VERSION_CONFLICT`, `IDEMPOTENCY_KEY_REUSED`): record
       the `REJECTED` command but **no** idempotency record. The key stays usable for a
       retry. (An in-progress `409` writes nothing at all: C2.)
     - `FORBIDDEN` (C3) is a deterministic rejection.
   - **Rejections are idempotent.** A retry of a deterministically rejected request
     (same key, same body) gets the stored rejection as an `IDEMPOTENT_REPLAY`. Trying
     again needs a new key.
   - **If a keyed rejection can't be recorded**, respond `5xx`, not the rejection. The
     outcome isn't fixed until it's durable; the same principle as webhook receipt.
   - **Requests without a key** are rejected with `VALIDATION_FAILED`. Only an
     `InboundCommand` is recorded (best effort), since there's no key to bind.
   - **The idempotency record becomes insert-only.** It is written once with the final
     outcome. No in-progress state is needed, because the advisory lock provides that.
2. **Why.**
   - Without a defined in-flight mechanism, §10.3's `409` can't be implemented
     correctly (A4).
   - If rejections weren't recorded against the key, a retry could execute and succeed
     later (for example, after allocation is released). One key would then have two
     different outcomes (A5). That breaks "one request, one answer" for a financial API.
   - Writing the rejection in a **separate** transaction would release the lock between
     the two transactions, re-opening that race. The savepoint keeps everything under
     one lock.
3. **Entities.** `IdempotencyRecord` (now insert-only; stores outcome type and
   response), `InboundCommand`.
4. **Relationships and ownership.** An idempotency record references the
   `InboundCommand` whose outcome it stores: accepted, or deterministically rejected.
   Unchanged otherwise.
5. **Uniqueness.** `IdempotencyRecord (simulationRunId, actorId, idempotencyKey)`, as
   already approved.
6. **Transactions and concurrency.** Lock order is extended to:
   **idempotency advisory lock → claim → payment → attempt → anomaly**. The advisory
   lock comes first because it is taken before any business row is touched.
7. **Lifecycle impact.** Requires amendment **L2**, a behavioural refinement:
   - §9.1 and §4.3 currently say rejected commands are written "in a separate
     transaction", and that the client receives its rejection even if the write fails.
     For **keyed** commands, both statements change: same transaction via a savepoint,
     and `5xx` if the decision can't be recorded.
   - I3 is strengthened: each idempotency key yields exactly one recorded outcome.
   - I7 is unchanged.

### DM7 — Deterministic uniqueness for bank interaction playback

_Resolves A6 and A20 (§15 item 6)._

1. **Decision.**
   - **"Provider" and "simulated bank" are the same concept** (A20), identified by a
     provider code within a run.
   - **New constraint:** `BankInteractionRequest (simulationRunId, provider,
interactionType, readableKey, occurrenceNo)`.
   - **Canonical readable keys:**
     - `VERIFY_ACCOUNT`: `{paymentReference}#S{snapshotNo}`;
     - `DISPATCH` and `STATUS_QUERY`: the attempt's bank reference.
   - **Occurrence numbers are allocated deterministically.** In the transaction that
     inserts the request, take the **payment-row lock** for the subject's payment, then
     set `occurrenceNo` to one more than the current maximum for that key. All bank
     requests for one payment are therefore numbered gap-free and in a definite order,
     even when the poller and the reconciler run at the same time.
2. **Why.** Playback (D26) locates source requests by type, key and occurrence. If two
   concurrent requests could get the same number, or numbers depended on timing,
   matching would be ambiguous, and replay results would be non-deterministic.
3. **Entities.** `BankInteractionRequest`.
4. **Relationships and ownership.** Unchanged. The key embeds readable references, which
   line up across runs because of D18.
5. **Uniqueness.** As above. The approved `BankInteractionResponse (requestId)`
   constraint stays.
6. **Transactions and concurrency.** Taking the payment row for numbering fits the
   existing lock order (claim → **payment** → attempt). The bank call itself happens
   after commit (§5.4), so the lock is held only briefly.
7. **Lifecycle impact.** This completes §9.3's table with a constraint §9.4 already
   depends on. No invariant changes. It is recorded as amendment **L5**, alongside the
   lock-order note.

### DM8 — Anomaly status, evidence and deduplication keys

_Resolves O6, O7, U5 and U7 (§15 item 7)._

1. **Decision.**
   - **Current status is stored on `Anomaly`** (`OPEN` or `RESOLVED`). It is updated
     **only** in the same transaction as each `AnomalyAction` insert. Actions stay the
     authoritative history, and a consistency check (as for I5) verifies that the status
     matches the latest action.
   - The T10 guard uses an index of open critical anomalies per payment, and checks it
     under the payment lock (D15, D23).
   - No counter is added to `Payment`, to avoid two sources of truth.
   - `AnomalyAction` gets `(anomalyId, sequenceNo)`.
   - **Evidence is stored as separate insert-only `AnomalyEvidence` rows** with typed
     references (DM5), written in the same transaction as the anomaly.
   - **Evidence keys are deterministic per type:**

     | Anomaly type                                                             | Evidence key                                     |
     | ------------------------------------------------------------------------ | ------------------------------------------------ |
     | `CONFLICT`, `ATTEMPT_SUPERSEDED`, `AMOUNT_MISMATCH`, `UNKNOWN_REFERENCE` | `event:{eventId}`                                |
     | `CONFLICTING_PAYLOAD`                                                    | `event:{eventId}:payload:{payloadHash}`          |
     | `EVENT_PROCESSING_EXHAUSTED`                                             | `event:{eventId}:generation:{requeueGeneration}` |
     | `ATTEMPT_UNRESOLVED`                                                     | `attempt:{attemptId}`                            |

     This requires a new `requeueGeneration` counter on `ProviderEvent`, incremented by
     `REQUEUE_EVENT`. A fresh exhaustion after a requeue then opens a **new**, linked
     anomaly, because the system never reopens anomalies (§10.4).
2. **Why.**
   - Deriving status from the action history inside the T10 guard is complex and slow,
     and the check runs under a lock.
   - Evidence stored as rows keeps referential integrity, and makes questions like
     "which anomalies cite this delivery?" answerable.
   - Without defined keys, re-detecting the same problem could create duplicate
     anomalies, while genuinely new evidence might be wrongly merged.
3. **Entities.** `Anomaly` (now controlled status updates), `AnomalyEvidence`
   (resolved; was ❓), `AnomalyAction`, `ProviderEvent` (`requeueGeneration`).
4. **Relationships and ownership.** Unchanged; all run-owned.
5. **Uniqueness.**
   - `Anomaly (simulationRunId, anomalyType, evidenceKey)`, as approved;
   - `AnomalyEvidence (anomalyId, evidenceType, evidenceRecordId)`;
   - `AnomalyAction (anomalyId, sequenceNo)`.
6. **Transactions.** Opening or reopening a critical anomaly locks the payment row
   (D23), then the anomaly row. Resolving locks the anomaly row. Lock order ends with
   **anomaly**, as in DM6.
7. **Lifecycle impact.** Amendment **L4**: §10.4 should say the status is _recorded_ on
   the anomaly, alongside each action, rather than derived. I16 is unchanged: evidence
   is still immutable and actions append-only. In the inventory, `Anomaly` moves from
   "insert-only" to "controlled status updates".

### DM9 — Actor representation

_Resolves U1 (§15 item 8)._

> **Corrected by C3 (§3A):** the synthetic actor header is a development identity mechanism,
> **not** authentication. Authority comes from a server-side allowlist.

1. **Decision.**
   - No `Actor` entity in the MVP. Records store `actorType` (`USER`, `SYSTEM` or
     `PROVIDER`) plus an opaque `actorId`, for example `ops-01`,
     `system:dispatcher` or `provider:simbank`.
   - **"Authenticated" in §9.1 is defined for the MVP** as a synthetic actor header,
     validated for format only. PaySim has no real authentication yet (architecture
     §7), and all users are synthetic.
   - D8 compares `(actorType = USER, actorId)` on the payment's creator and on the
     approver.
2. **Why.** Roles are out of scope (§13), but D8, I13 and anomaly resolution all need a
   stable actor identity now.
3. **Entities.** Every record with an actor field.
4. **Relationships and ownership.** None. An `Actor` entity with foreign keys can be
   introduced later without changing these fields' meaning.
5. **Uniqueness.** None.
6. **Transactions.** None.
7. **Lifecycle impact.** Amendment **L11**: define "authenticated" for the MVP. No
   invariant changes.

### DM10 — Recipient input model

_Resolves A7, A8 and U3 (§15 item 9)._

1. **Decision.**
   - **Two ways to supply a recipient.** `CREATE_PAYOUT`, and the T5 correction command,
     accept **either** a `recipientId` (copy that recipient's current details into the
     snapshot) **or** inline details (snapshot from the request, with no recipient
     link).
   - Inline details never create a `Recipient` implicitly.
   - `RecipientSnapshot.recipientId` is an optional provenance reference.
   - **Recipients are created and edited by inbound commands** (`CREATE_RECIPIENT`,
     `UPDATE_RECIPIENT`). Recipient edits are therefore audited by §9.1 at no extra cost
     (resolves A8).
   - **Uniqueness:** a recipient is identified by bank account within a run.
2. **Why.** The lifecycle shows inline details (§12), but also describes reusable
   recipients (Q2). Supporting both explicitly avoids hidden record creation. Treating
   recipient changes as commands gives an audit trail without a new history entity.
3. **Entities.** `Recipient`, `RecipientSnapshot`, `InboundCommand` (new command types).
4. **Relationships and ownership.** Snapshot → recipient is optional and many-to-one;
   both are run-owned.
5. **Uniqueness.** `Recipient (simulationRunId, bankCode, accountNumber)`.
6. **Transactions.** The snapshot copy happens inside the T1 or T5 transaction, so the
   recipient's details are read at that instant. Later edits never touch the snapshot.
7. **Lifecycle impact.** None to invariants. The command vocabulary grows (see U6,
   §4 of this document).

### DM11 — Scheduling fields

_Resolves A14 (§15 item 10)._

> **Extended by C4 (§3A):** an explicit, fenced polling-work claim.

1. **Decision.** Store scheduling as explicit, controlled fields. Each is computed from
   the run's frozen configuration (DM2) at the moment of the triggering change:
   - `Payment.nextDispatchAt`: set at T7 (now) and at T13 (now + back-off); cleared on
     T10.
   - `PaymentAttempt.nextStatusQueryAt` and `statusQueryCount`: maintained by the poller
     while the attempt is `SUBMITTED` or `UNKNOWN`.
   - `PaymentAttempt.earliestQualifyingQueryAt` = _D_ + _W_ (N3).
   - `PaymentAttempt.escalateAt` and `escalatedAt`, for the `ATTEMPT_UNRESOLVED` anomaly.
   - `ProviderEvent.nextAttemptAt`: already defined.
2. **Why.**
   - Workers need indexed "what is due now?" queries.
   - Recomputing due times from history on every poll is slow and error-prone.
   - Fields driven by the simulated clock make replays reproduce timing exactly.
3. **Entities.** `Payment`, `PaymentAttempt`.
4. **Relationships and ownership.** None.
5. **Uniqueness.** None.
6. **Transactions.**
   - `nextDispatchAt` changes with the payment transition (same transaction and
     `version`).
   - Poller fields change under the attempt row lock, taken with `FOR UPDATE SKIP LOCKED`
     when picking due work.
   - The dispatcher picks payments that are `READY_FOR_PAYMENT` with
     `nextDispatchAt ≤ now`.
7. **Lifecycle impact.** Amendment **L8**: add "back-off elapsed (`nextDispatchAt ≤
now`)" to T10's guard. This makes D4's back-off explicit; no invariant changes.

### DM12 — Run states and run reference

_Supports DM1, DM2 and DM4 (A11, U2). Not blocking on its own, but those decisions
depend on it._

1. **Decision.**
   - `SimulationRun.status` follows **`CREATED → ACTIVE → COMPLETED`**, plus `ABORTED`
     from `CREATED` or `ACTIVE`.
   - `DIVERGED` is a separate **marker** on replay runs, not a state, matching §9.4's
     wording ("marked `DIVERGED`").
   - Webhooks are accepted only while the run is `ACTIVE` (DM1). Configuration is frozen
     from `ACTIVE` onwards (DM2). Replays start only from `COMPLETED` sources (DM4).
   - Runs get a readable reference, `RUN-NNNN`.
2. **Why.** DM1, DM2 and DM4 each need a defined point where the run starts accepting
   traffic, freezes, and becomes immutable source material.
3. **Entities.** `SimulationRun`.
4. **Relationships and ownership.** None.
5. **Uniqueness.** `SimulationRun (runReference)`, globally unique (the run is the
   owner).
6. **Transactions.** Moving a run to `COMPLETED` must ensure no work is still in flight
   (no events claimed, no attempts mid-dispatch). The procedure is defined at
   transaction-boundary design (Phase 3, step 3).
7. **Lifecycle impact.** None. The lifecycle names only `DIVERGED`, and this keeps it.

---

## 3A. Corrections applied at approval

| #   | Correction                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Affects |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| C1  | **Idempotency fingerprint** = SHA-256 over the canonical serialisation of `{commandType, apiVersion, payload}`. The same key with the same body but a different command type is a different request (`422 IDEMPOTENCY_KEY_REUSED`). Key scope stays `(simulationRunId, actorId, idempotencyKey)`.                                                                                                                                                                                         | DM6     |
| C2  | **In-progress requests write nothing.** A request that fails to take the advisory lock returns `409 IDEMPOTENCY_REQUEST_IN_PROGRESS` immediately, with no `InboundCommand` and no `IdempotencyRecord`. The lock owner records the accepted or deterministically rejected outcome. Savepoint-based atomic recording is preserved; if the final outcome can't be committed, the response is `5xx`.                                                                                          | DM6     |
| C3  | **Synthetic identity is not authentication.** A server-side allowlist (`simconfig.SyntheticOperator` and `SyntheticOperatorPermission`) of seeded synthetic operators and permitted actions decides authority. A client-supplied actor ID or type never grants authority by itself. Privileged actions are checked in the application **and** by database triggers. Unknown or unauthorised actors get `FORBIDDEN`. Suitable for a controlled simulator or demo only.                     | DM9     |
| C4  | **Polling-work claims.** Due attempts are claimed atomically (`FOR UPDATE SKIP LOCKED`, new poll token, lease, `pollGeneration + 1`), and the claim is committed before any external call. The request and the response are each recorded in their own short transaction; no transaction or lock is held during the call. Effects are fenced by the token. At most one status-query request exists per `(attempt, pollGeneration)`. Crash recovery is defined per stage (lifecycle §5.8). | DM11    |

## 3B. Additional safeguards

| #   | Safeguard                                                                                                                                                                                                                                                                                                                                                           | Enforcement                                                                                                                                                                                                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | **Simulated bank boundary.** There are separate PostgreSQL schemas (`paysim`, `simbank`, plus the shared read-only `simconfig`) and separate roles (`paysim_app`, `simbank_app`). `paysim_app` has no `USAGE` on `simbank`, so it can't query bank-side tables. Bank interactions pass through a defined interface.                                                 | **Database-enforced** for connections using the app roles; tested. **Limitation:** the existing API process still connects with `DATABASE_URL`, which is the superuser schema owner. Switching runtime services to the role-specific URLs is a Phase 4 task. Until then, the boundary is enforced only for code that uses the app roles. |
| S2  | **Webhook ingress keys** are 256-bit cryptographically random values. Only their SHA-256 hash is stored PaySim-side; the bank-side profile holds the plaintext (the bank's configured endpoint). Keys must never be logged. They are subject to rate limits and request-size limits. A key routes; it does not authenticate (signature validation stays mandatory). | Hash storage and the raw-body size check (≤ 64 KiB) are database-enforced. Log redaction, rate limiting and HTTP size limits belong to the webhook endpoint, which isn't implemented in Phase 3 and is a Phase 4 requirement.                                                                                                            |

## 3C. Rejected alternatives (kept for the record)

| Decision | Alternative rejected                                              | Reason                                                                                                       |
| -------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| DM1      | Persist unattributable requests in a run-less log table           | Breaks D14; such requests can never be replay inputs; structured logs are enough.                            |
| DM2      | Copy failure-injection rules into every run                       | Duplication; the pinned version is immutable, so a reference is equally reproducible.                        |
| DM5      | Generic `(targetType, targetId)` pairs                            | Can't be protected by foreign keys.                                                                          |
| DM6      | Committed `IN_PROGRESS` idempotency rows                          | Need leases and recovery for stuck keys; an advisory lock releases itself on crash.                          |
| DM6      | Rejection written in a separate transaction                       | Releases the lock between transactions, so a same-key retry could win the race and produce a second outcome. |
| DM8      | Status derived from actions at query time                         | Complex and slow inside the T10 guard, which runs under a lock.                                              |
| S1       | Single schema, with the boundary as a coding convention           | Not enforceable; a convention can't be tested.                                                               |
| N11      | Partial indexes through Prisma's `partialIndexes` preview feature | A preview flag shouldn't underpin a financial invariant; raw SQL in migrations is stable and explicit.       |

## 3D. Implementation deviations from non-blocking recommendations

| Item                    | Recommendation                                    | Implemented                                                                                                                                                       | Why                                                                                                                                             |
| ----------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| UUIDv7 generation (N11) | Application-side                                  | Database function `simconfig.uuidv7()` used as the column default                                                                                                 | Raw-SQL inserts (tests, triggers, migrations) get the same time-ordered IDs; one source of truth.                                               |
| Lock order (DM6)        | idempotency → claim → payment → attempt → anomaly | The **provider event** class sits between attempt and anomaly. Completion locks only the run row.                                                                 | Event processing must finalise the event row after locking the payment and attempt. This extends the order without reversing any existing pair. |
| Playback (D17, D26)     | "Simulated bank in playback mode"                 | Playback is a PaySim-side adapter that reads the **source run's recorded** bank interactions (PaySim-side records). The bank-side schema is untouched in replays. | The recordings are PaySim's own records; the bank boundary (S1) stays intact.                                                                   |

---

## 4. Non-blocking implementation details (recommendations; no approval gate)

| Item | Recommendation                                                                                                                                                                                                                                                                                                                                                                                     | Refs       |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| N1   | **Command vocabulary:** `CREATE_PAYOUT`, `CORRECT_PAYMENT_RECIPIENT` (T5), `APPROVE_PAYMENT`, `REJECT_PAYMENT`, `CANCEL_PAYMENT`, `CREATE_RECIPIENT`, `UPDATE_RECIPIENT`, `RESOLVE_ANOMALY`, `REOPEN_ANOMALY`, `ADD_ANOMALY_NOTE`, `RESOLVE_ATTEMPT`, `REQUEUE_EVENT`.                                                                                                                             | U6, A16    |
| N2   | **`NOTE_ADDED` is a command** (`ADD_ANOMALY_NOTE`), so every human anomaly action is audited and replayed.                                                                                                                                                                                                                                                                                         | A16        |
| N3   | **Bank response classification:** `ACKNOWLEDGED`, `SUCCEEDED`, `FAILED_RETRYABLE`, `FAILED_PERMANENT`, `FOUND_PROCESSING`, `NOT_FOUND`, `ACCOUNT_VERIFIED`, `ACCOUNT_NOT_FOUND`, `AMBIGUOUS`, `NO_RESPONSE`. **Signatures:** synchronous bank responses are signed with the same per-run secret, so N4's "unsigned" has a meaning.                                                                 | A15, N4    |
| N4   | **Divergence types:** `REQUEST_MISMATCH`, `PLAYBACK_MISS`, `UNUSED_RECORDING`, `COMMAND_OUTCOME_MISMATCH`, `REJECTION_CODE_MISMATCH`, `TRANSITIONS_MISMATCH`, `EVENT_OUTCOME_MISMATCH`, `RECEIPT_OUTCOME_MISMATCH`.                                                                                                                                                                                | A17        |
| N5   | **Links are stored one way.** The cause is stored on the effect (transitions, attempt status changes, settlements). Command → effects is found by query. Exception: `InboundCommand.resultingPaymentReference` is stored, because replay mapping needs it (D18).                                                                                                                                   | A18        |
| N6   | **`VerificationResult`** exists only for definitive outcomes. Transient verifier errors leave only bank interactions. Each result records a `disposition` (`APPLIED` or `STALE_SNAPSHOT`).                                                                                                                                                                                                         | A9         |
| N7   | **Claim:** a simple "approved for payout" flag in the MVP.                                                                                                                                                                                                                                                                                                                                         | A10        |
| N8   | **`relatedAnomalyId`** stays singular. Further links can be added later as a relation table.                                                                                                                                                                                                                                                                                                       | A19        |
| N9   | **Sequence numbers:** `AttemptStatusChange (attemptId, sequenceNo)`, like transitions.                                                                                                                                                                                                                                                                                                             | U5         |
| N10  | **Approval:** `UNIQUE (paymentId)`, confirmed from the state machine.                                                                                                                                                                                                                                                                                                                              | U4         |
| N11  | **Schema mechanics for step 4:** partial unique index and discriminator checks via raw SQL in migrations if Prisma can't express them; composite `(id, simulationRunId)` uniques on parents; UUIDv7 generated application-side; per-year reference sequences as raw SQL; ISO 4217 exponents as a code constant; raw-body size cap (64 KiB proposed); append-only enforcement by database triggers. | §15 checks |
| N12  | **Signing secrets** are stored on the run-scoped `SimulatedBank`. They are synthetic, never logged, and their encryption at rest is deferred.                                                                                                                                                                                                                                                      | DM2        |

---

## 5. Pending lifecycle amendments

Applied as lifecycle revision 5. None weakens a financial invariant.

| #   | Amendment                                                                                                                                                                  | From     |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| L1  | I6: "every webhook delivery attributed to a run whose receipt was durably recorded"; list all of the event's mutable processing fields (A3).                               | DM1, A3  |
| L2  | §9.1, §4.3, I3: keyed rejections are written in the same transaction via a savepoint; deterministic rejections are idempotent; `5xx` if a keyed outcome can't be recorded. | DM6      |
| L3  | §9.3: explicit cross-run exceptions (`sourceRunId`; divergence → source evidence).                                                                                         | DM4      |
| L4  | §10.4: anomaly status recorded alongside each action (actions remain authoritative).                                                                                       | DM8      |
| L5  | §9.3: add the bank-interaction occurrence constraint. §7.2: lock order idempotency → claim → payment → attempt → anomaly.                                                  | DM6, DM7 |
| L6  | New invariant: run configuration is immutable once the run is `ACTIVE`; the failure-injection profile version is pinned.                                                   | DM2      |
| L7  | Global catalogue records (configuration profiles) are not simulation-owned; D14 doesn't apply to them.                                                                     | DM2      |
| L8  | T10 guard: `nextDispatchAt ≤ now`.                                                                                                                                         | DM11     |
| L9  | §8.2: ingress keys; unattributable requests get `404` and a log line only.                                                                                                 | DM1      |
| L10 | New invariant: PaySim learns bank state only through recorded bank interactions and webhooks.                                                                              | DM3      |
| L11 | §9.1: "authenticated" means a synthetic actor header in the MVP.                                                                                                           | DM9      |

---

## 6. Decision register

| ID     | Question                                                                   | Recommendation                                                                                                                                     | Status                                                 |
| ------ | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| DM1    | Webhook run attribution; ingress vs. delivery (A1, A2)                     | Per-bank ingress key in the URL; unattributable requests get `404` and a log line; run-scoped deliveries otherwise                                 | **Approved**                                           |
| DM2    | Configuration shape; frozen settings; failure injection (O1, O2, A12, A13) | Global versioned profiles pinned per run; run-owned `SimulatedBank` copies; frozen once `ACTIVE`; inert in replays                                 | **Approved**                                           |
| DM3    | Simulated bank accepted-instruction state (A13)                            | Separate bank-side records (`SimulatedBankAccount`, `BankInstruction`, `BankWebhookDispatch`), scenario runs only, never read by PaySim-side logic | **Approved**                                           |
| DM4    | Cross-run references (O3)                                                  | Only `sourceRunId` and divergence → source evidence, composite-checked; replay only from `COMPLETED` sources                                       | **Approved**                                           |
| DM5    | Polymorphic references (O5)                                                | Typed nullable references with a discriminator and a check                                                                                         | **Approved**                                           |
| DM6    | Idempotency concurrency and rejected outcomes (A4, A5)                     | Advisory lock with immediate `409`; one transaction with a savepoint; deterministic rejections stored and replayed; `5xx` if unrecordable          | **Approved**, corrected by C1/C2 (amends §9.1)         |
| DM7    | Playback uniqueness (A6, A20)                                              | `(run, provider, type, readableKey, occurrenceNo)` unique; occurrence numbered under the payment lock                                              | **Approved**                                           |
| DM8    | Anomaly status, evidence, keys (O6, O7, U5, U7)                            | Stored status updated with each action; evidence rows; deterministic keys with a requeue generation                                                | **Approved** (amends §10.4)                            |
| DM9    | Actor representation (U1)                                                  | `actorType` and `actorId`; synthetic actor header as MVP authentication                                                                            | **Approved**                                           |
| DM10   | Recipient input model (A7, A8, U3)                                         | `recipientId` or inline details; recipient changes are commands; unique by bank account                                                            | **Approved**                                           |
| DM11   | Scheduling fields (A14)                                                    | Explicit due-time fields on payment and attempt; T10 checks `nextDispatchAt`                                                                       | **Approved**                                           |
| DM12   | Run states and reference (A11, U2)                                         | `CREATED → ACTIVE → COMPLETED` / `ABORTED`; `DIVERGED` as a marker; `RUN-NNNN`                                                                     | **Approved**                                           |
| N1–N12 | Vocabularies, links, sequences, schema mechanics                           | §4                                                                                                                                                 | Non-blocking (recommendation)                          |
| L1–L11 | Lifecycle wording and invariants                                           | §5                                                                                                                                                 | **Applied** (lifecycle revision 5)                     |
| C1–C4  | Corrections at approval                                                    | §3A                                                                                                                                                | **Approved**                                           |
| S1–S2  | Additional safeguards                                                      | §3B                                                                                                                                                | **Approved**; S1 runtime switch-over is a Phase 4 task |
