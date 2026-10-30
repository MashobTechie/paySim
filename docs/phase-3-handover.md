# PaySim Phase 3 Handover — Data Model and Database Design

> **Date:** 2026-10-30.
> **Status:** Phase 3 complete. Database design, schema, migrations and the verification
> suite are implemented and passing. Nothing is committed.
>
> | Document                                             | Content                |
> | ---------------------------------------------------- | ---------------------- |
> | [`payment-lifecycle.md`](payment-lifecycle.md)       | Behaviour (revision 5) |
> | [`data-model.md`](data-model.md)                     | Entities               |
> | [`data-model-decisions.md`](data-model-decisions.md) | Decision register      |
> | [`erd.md`](erd.md)                                   | Diagrams               |
> | [`database-design.md`](database-design.md)           | Enforcement map        |
> | [`transaction-design.md`](transaction-design.md)     | Transactions and locks |
> | [`testing-database.md`](testing-database.md)         | How to run the suite   |

## 1. What was designed

- **Lifecycle revision 5:**
  - amendments L1–L11;
  - four corrections: the idempotency fingerprint, in-progress requests that write nothing,
    synthetic identity as an allowlist rather than authentication, and fenced status-polling
    claims (a new §5.8);
  - two safeguards: separate schemas and roles for the simulated bank, and hashed,
    routing-only ingress keys;
  - new invariants I20–I23.
- **The final entity inventory:** 32 entities in three PostgreSQL schemas. Both open entity
  questions are resolved.
- **The decision register:** DM1–DM12 approved, with corrections C1–C4, safeguards S1–S2,
  rejected alternatives, and implementation deviations.
- **The ERD:** four Mermaid diagrams plus plain-language cardinalities.
- **The database design:** each invariant mapped to its enforcement layer, plus an honest list
  of what the database does **not** enforce.
- **The transaction design:** 18 operations, one lock order, crash points and recovery.

## 2. What was implemented

| Artefact                                              | Content                                                                                                                                                                                        |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prisma/schema.prisma`                                | 32 models, 34 enums, three schemas, named relations, composite run-consistent foreign keys, worker indexes                                                                                     |
| `prisma/migrations/…_phase3_schema`                   | Schemas, `simconfig.uuidv7()`, run reference generator, generated tables/indexes/FKs                                                                                                           |
| `prisma/migrations/…_phase3_integrity`                | 85 CHECK constraints, 6 partial or expression indexes, 92 triggers (insert-only, controlled-update, run gate, state machines, fencing, permissions, allocation), 6 deferred commit-time checks |
| `prisma/migrations/…_phase3_roles_and_grants`         | `paysim_app`, `simbank_app`; schema isolation; column-level `UPDATE` grants; no `DELETE` or `TRUNCATE`                                                                                         |
| `prisma/migrations/…_phase3_seed_synthetic_operators` | Five synthetic operators and their permissions                                                                                                                                                 |
| `apps/api/scripts/test-db.mjs`                        | Guarded creation, reset and migration of the isolated test database                                                                                                                            |
| `apps/api/test/db/**`                                 | 8 spec files (53 tests), plus support code (pools, fixtures, protocol reference implementations)                                                                                               |
| Scripts                                               | `pnpm test:db`, `pnpm db:test:reset`, `pnpm db:migrate:deploy`; `pnpm db:migrate` is now `--create-only`                                                                                       |

**Not implemented, by scope:** payment services, API endpoints, the webhook endpoint,
workers, frontend workflows, real authentication, and real bank integrations.

## 3. Final entity list

| Schema      | Entities                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `simconfig` | `ConfigurationProfile`, `ConfigurationProfileVersion`, `ConfigurationBankDefinition`, `SyntheticOperator`, `SyntheticOperatorPermission`                                                                                                                                                                                                                                                                                          |
| `paysim`    | `SimulationRun`, `SimulatedBank`, `Claim`, `Recipient`, `Payment`, `RecipientSnapshot`, `VerificationResult`, `Approval`, `PaymentAttempt`, `AttemptStatusChange`, `PaymentTransition`, `Settlement`, `InboundCommand`, `IdempotencyRecord`, `ProviderEvent`, `WebhookDelivery`, `EventProcessingAttempt`, `BankInteractionRequest`, `BankInteractionResponse`, `Anomaly`, `AnomalyEvidence`, `AnomalyAction`, `ReplayDivergence` |
| `simbank`   | `BankRunProfile`, `SimulatedBankAccount`, `BankInstruction`, `BankWebhookDispatch`                                                                                                                                                                                                                                                                                                                                                |

## 4. Important relationships

- **Run ownership.** A run owns every simulation record. Run-owned references are composite
  `(fk, simulationRunId)`, so they can't cross runs.
- **Cross-run exceptions.** Exactly two exist: `SimulationRun.sourceRunId`, and
  `ReplayDivergence` → its **own** source run's evidence.
- **Claims and payments.** Claim → payments, with live payments never exceeding the approved
  amount. A payment has snapshots, one approval, attempts (at most one unresolved),
  transitions, and at most one settlement.
- **Events and bank interactions.** A provider event has many deliveries and processing
  attempts. A bank request has at most one response.
- **Anomalies.** An anomaly has fixed evidence plus append-only actions, and its recorded
  status mirrors the latest action.
- **The bank side.** It references only the run. PaySim's role can't read it.

## 5. Database invariants and enforcement

Legend: **DB** = constraint, trigger or grant; **Tx** = transaction protocol; **App** =
Phase 4 service rule, not yet enforced.

| Invariant                                                                                                     | Enforcement                                                                          |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Integer minor units, positive, ISO currency (C1, I14)                                                         | DB (`BIGINT`, CHECKs)                                                                |
| Amount and currency immutable; approval, attempt and settlement match (I4)                                    | DB (grants, immutable-column trigger, comparison triggers)                           |
| No claim over-allocation (I9)                                                                                 | DB (payment-insert trigger takes the claim lock and checks the sum) + Tx             |
| One unresolved attempt (I1); one `DISPATCH` per attempt (D19)                                                 | DB (partial unique indexes)                                                          |
| One settlement; only from a `SUCCEEDED` attempt (I2)                                                          | DB (unique + trigger)                                                                |
| Legal payment transitions; status = latest transition (§4.1, I5)                                              | DB (transition trigger + deferred check)                                             |
| Legal attempt transitions; resolved is final (§5.2, I11)                                                      | DB (matrix trigger + deferred check)                                                 |
| Approval binding; approver ≠ creator; permission (D12, D8, I22)                                               | DB (approval trigger)                                                                |
| No dispatch with an open critical anomaly (D15); serialised with dispatch (D23)                               | DB (attempt-insert trigger; anomaly trigger locks the payment row)                   |
| Idempotency: one outcome per key; deterministic rejections only (D28, C1, C2)                                 | DB (unique key, CHECK, mirror trigger) + Tx (advisory lock, savepoint)               |
| Event identity; claims, leases, fencing; honest counts (I3, I18)                                              | DB (unique identity, event state-machine trigger) + worker protocol                  |
| Requests and responses separate, insert-only; gap-free occurrences (D27, DM7)                                 | DB                                                                                   |
| Poll claims; one request per generation (I23)                                                                 | DB (attempt trigger, partial unique) + worker protocol                               |
| Acceptance deadline; queryability `visibleAt ≤ receivedAt + W` (§5.7)                                         | DB (CHECKs + window copy trigger)                                                    |
| Bank boundary (I21, S1)                                                                                       | DB (schemas + roles): applies to connections using the app roles; see limitation L-1 |
| Anomaly evidence immutable; actions append-only; status atomic; human-only critical resolution (I16, L4, D25) | DB                                                                                   |
| Run lifecycle; frozen configuration; safe completion; writes only while `ACTIVE` (I20, D34)                   | DB (run triggers, run gate)                                                          |
| Replay only from completed sources; source immutable; divergences scoped (C6, I8, L3)                         | DB                                                                                   |
| Insert-only tables, for every role                                                                            | DB (triggers; grants for the app roles)                                              |
| N1–N6, back-off, poll and escalation timing, signature verification, ingress rate and size limits             | **App** (Phase 4)                                                                    |

## 6. Transaction and lock-order summary

```text
[I] idempotency advisory lock → [C] claim → [P] payment → [A] attempt → [E] provider event → [N] anomaly
[R] run row: FOR UPDATE only by complete/abort; every run-owned write takes FOR KEY SHARE via the run gate
```

- No transaction stays open during a bank call: record the request, commit, call, then record
  the response.
- A releasing outcome discovered while holding [P] is retried with [C] first, so there is no
  reverse path.
- Keyed commands use one transaction with a savepoint. Deterministic rejections are bound to
  the key; an in-progress request writes nothing; a commit failure returns `5xx`.

## 7. Migration summary

- **Four migrations.** All apply cleanly to a fresh database; every `pnpm test:db` run does
  this. There are no `DROP`, `TRUNCATE` or `DELETE` statements.
- **No drift.** `prisma migrate diff` (database → schema) reports an empty migration. The
  run-reference default was moved into `simconfig`, so it renders schema-qualified regardless
  of `search_path`.
- **No preview features.** Partial indexes use raw SQL, not Prisma's `partialIndexes`
  preview.
- **The development database was not migrated** (it still has 0 tables). Apply with
  `pnpm db:migrate:deploy` when you're ready.

## 8. Test coverage and actual results

| Command                                            | Result                                                                         |
| -------------------------------------------------- | ------------------------------------------------------------------------------ |
| `prisma validate`                                  | Valid                                                                          |
| `prisma generate`                                  | Generated Prisma Client 7.10.1                                                 |
| `pnpm test:db` (fresh database each run)           | **53/53 passed**, 8 files, about 27 s. Run **4 times** with identical results. |
| `pnpm turbo run lint typecheck test build --force` | **17/17 tasks successful** (existing unit/e2e tests: 2 files passed)           |
| `pnpm format:check`                                | Clean                                                                          |
| Migration SQL scan                                 | No destructive statements                                                      |
| Dev environment                                    | Dev database untouched (0 tables); the running API's `/health` returned 200    |

Per-file coverage is in [`testing-database.md`](testing-database.md) §7.

## 9. Known limitations

- **L-1 Runtime role switch-over.** The API's `PrismaService` still connects with
  `DATABASE_URL`, which is the superuser schema owner. Triggers protect every role, but the
  **grant-based** protections, including the bank boundary, apply only once services connect
  as `paysim_app` (and the bank as `simbank_app`). This is a Phase 4 task. Until then, the
  boundary is enforced for code that uses those roles, which includes all database tests.
- **L-2 The webhook endpoint doesn't exist yet.** Ingress-key log redaction, rate limiting,
  HTTP size limits and signature verification are endpoint responsibilities. Only hash
  storage and the 64 KiB body cap are database-enforced.
- **L-3 Protocols are reference implementations.** The keyed-command envelope, event worker,
  poller, sweeper and playback adapter exist only in `test/db/support/protocols.ts`.
- **L-4 Timing rules are not database-enforced:** N1–N6, back-off, the poll schedule and
  escalation thresholds.
- **L-5 Roles are cluster-wide.** Test setup sets login passwords on `paysim_app` and
  `simbank_app` for the whole local cluster.
- **L-6 The catalogue is insert-only, even for the owner.** Corrections mean new profile
  versions or operators. Test-only operators persist within the (recreated) test database.
- **L-7 Prisma doesn't model the raw SQL.** Use `pnpm db:migrate` (`--create-only`) and review
  every generated migration, especially for unintended index changes.
- **L-8 Failure-injection rule structure is undefined.** It is stored as a versioned,
  hash-covered document until the failure-injection phase defines it.

## 10. Deviations from the approved design

Each is recorded in [`data-model-decisions.md`](data-model-decisions.md) §3D or noted here.
None weakens an invariant.

1. **UUIDv7 is generated by a database function**, not application-side (N11 recommendation):
   one source of truth for raw SQL and Prisma.
2. **The lock order gains a provider-event class** between attempt and anomaly, plus the run
   row for completion. This is an extension, with no reversed pairs.
3. **Playback is a PaySim-side adapter** reading the source run's recordings; the bank-side
   schema isn't used in replays.
4. **The keyed-command envelope inserts the `ACCEPTED` command first**, inside the savepoint,
   because effects reference it. The specification was updated.
5. **Strengthenings that go beyond the specification:**
   - D19 enforced as "one `DISPATCH` request per attempt";
   - I22 checked in triggers, not only in the application;
   - a run needs at least one simulated bank before activation;
   - a settlement must cite a bank response, provider event or command (never a system job).
6. **D9 refinement.** Wiring the first snapshot inside the creating transaction doesn't bump
   `version`; every other update increments it by exactly 1.
7. **Root `pnpm db:migrate` now uses `--create-only`**, so migrations are always reviewed
   before they are applied.

## 11. Decisions deferred to later phases

- The failure-injection rule language (failure-injection phase).
- A real authentication and actor model, to replace the synthetic allowlist.
- Claim lifecycle beyond the `approvedForPayout` flag.
- Encryption at rest for synthetic signing secrets (N12).
- Retention policy for raw webhook bodies and payloads.
- Whether replay should offer halt-on-first-divergence as an option (R10 noted it).

## 12. Recommended Phase 4 work

1. **Switch runtime connections to the app roles** (L-1): a `PAYSIM_APP_DATABASE_URL` for
   the API and a separate connection for the simulated bank module. Add a startup check that
   refuses to run services as a superuser.
2. **Implement the state machine in `@paysim/state-machine`.** Add a test asserting that its
   transition table equals the database's `paysim.payment_transition_allowed` and
   `attempt_transition_allowed`.
3. **Build the keyed-command service layer** from the reference envelope, using the
   error-code mapping in `transaction-design.md` §2.
4. **Build the workers:** dispatcher, event processor and sweeper, poller, and recovery and
   escalation, from the reference protocols. Add N1–N6 and the timing rules, with tests.
5. **Build the webhook endpoint:** ingress-key hashing and lookup, log redaction, rate and
   size limits, HMAC verification, and receipt then processing.
6. **Build the simulated bank module:** a role-separated connection, instruction handling,
   status queries honouring `visibleAt`, and webhook dispatch with failure injection.
7. **Build the replay engine:** input tape ordering, simulated clock, playback adapter, and
   outcome comparisons (the remaining divergence types).
8. Run `pnpm test:db` in CI with a PostgreSQL service container.
