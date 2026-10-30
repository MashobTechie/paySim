# Testing the PaySim Database

> How to run and interpret the database verification suite: real PostgreSQL, no mocks.
> Every command below was run against this repository during Phase 3.

## 1. Two kinds of tests

| Suite                              | Command        | What it uses                                                                                                  |
| ---------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------- |
| Unit and e2e (existing)            | `pnpm test`    | Vitest. The API e2e test reads the **dev** database with `SELECT 1` only.                                     |
| **Database integration** (Phase 3) | `pnpm test:db` | Vitest against an isolated **`paysim_test`** database, through the real `paysim_app` and `simbank_app` roles. |

The database suite is **not** part of `pnpm test` or Turbo's `test` task, because it needs a
running PostgreSQL and recreates a database. Run it explicitly.

## 2. Prerequisites

```bash
cp .env.example .env    # if you haven't already; set POSTGRES_PASSWORD and DATABASE_URL together
pnpm install
pnpm db:up              # PostgreSQL 17 on localhost:5433 (docker compose)
```

- **Owner role.** The Docker database user (`POSTGRES_USER`) must be able to create
  databases and roles. The Docker image's default user is a superuser.
- **App roles.** The migrations create `paysim_app` and `simbank_app` as `NOLOGIN` roles.
  Test setup gives them `LOGIN` and a test password.
- **Roles are cluster-wide.** This changes the roles' passwords for the whole local cluster.
  The development database doesn't use these roles yet.

## 3. Environment variables

| Variable                    | Default                                         | Purpose                                                                            |
| --------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------- |
| `DATABASE_URL`              | from `.env`                                     | Dev database. Used only to derive the test URL; it is **never** modified.          |
| `TEST_DATABASE_URL`         | `DATABASE_URL` with the database name + `_test` | Owner connection to the test database.                                             |
| `TEST_PAYSIM_APP_PASSWORD`  | `paysim_app_test_only`                          | Test login password set on `paysim_app`.                                           |
| `TEST_SIMBANK_APP_PASSWORD` | `simbank_app_test_only`                         | Test login password set on `simbank_app`.                                          |
| `TEST_DB_REUSE`             | unset                                           | `1` = keep the existing test database instead of recreating it (faster iteration). |
| `TEST_DB_VERBOSE`           | unset                                           | `1` = show Prisma migration output.                                                |

**Safety guard** (`apps/api/scripts/test-db.mjs`). The script refuses to touch any database
whose name doesn't end in `_test`, or that equals the database in `DATABASE_URL`.

## 4. Commands

```bash
pnpm test:db                     # generate client, RECREATE paysim_test, apply all migrations, run the suite
pnpm db:test:reset               # just drop + recreate + migrate the test database
pnpm --filter @paysim/api test:db:watch   # watch mode, reusing the test database

# a single file, reusing the database
cd apps/api && TEST_DB_REUSE=1 npx vitest run --config vitest.db.config.ts test/db/replay.db-spec.ts
```

**Migration and reset model:**

- Every `pnpm test:db` run **drops and recreates** `paysim_test` and applies every migration
  with `prisma migrate deploy`. Each run therefore also proves the migrations against a fresh
  database.
- Between tests, `resetData()` truncates every run-owned table and the configuration
  catalogue, as the owner. The seeded synthetic operators are kept.
- Insert-only triggers don't fire on `TRUNCATE`; the app roles have no `TRUNCATE` privilege.

**Applying the migrations to the development database** is a deliberate step that Phase 3 did
**not** perform:

```bash
pnpm db:migrate:deploy           # prisma migrate deploy against DATABASE_URL
```

**New migrations** must be generated without applying them, then reviewed. Prisma doesn't
model the CHECK constraints, partial indexes, triggers or grants in the integrity migration.

```bash
pnpm db:migrate --name <change>  # prisma migrate dev --create-only
```

## 5. Concurrency tests

Several tests prove behaviour **between** transactions. They open two connections and control
the timing explicitly:

- **Proving a statement is blocked.** `openTx()` holds a transaction open, and
  `stillPending(promise)` checks that the second statement is still waiting on a lock. For
  example, a second payout waits on the claim row, and run completion waits for an in-flight
  writer.
- **Racing claims.** `Promise.all` starts competing claims. Exactly one may win.
- **Lease expiry.** Short leases (100–150 ms) plus a sleep simulate a crashed worker.
- **Stuck locks fail fast.** Each pool sets `lock_timeout = 10s` and
  `statement_timeout = 20s`, so a test that leaks a lock fails quickly instead of hanging.

The suite was run three times in a row on fresh databases with identical results.

## 6. Interpreting failures

| Failure text                                   | Meaning                                                                                           |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `expected PAYSIM_<CODE>, got …`                | A trigger raised a different rule, or none. Codes are listed in the integrity migration.          |
| `expected 23505` / `23514` / `23503` / `42501` | Unique, check, foreign-key and permission violations respectively.                                |
| `…operation succeeded`                         | An invariant that should have rejected the write didn't. **Treat it as a correctness bug.**       |
| `lock timeout` / `canceling statement`         | A test leaked an open transaction, or a protocol deadlocks. Check that `openTx` is always closed. |
| `Refusing: test database …`                    | The safety guard stopped a run against a non-test database.                                       |

## 7. Coverage: which test proves which invariant

| File                            | Invariants proven                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `financial.db-spec.ts`          | Exact minor units (2⁵³+1 round trip; no non-bigint amount columns); positive amounts and ISO format; I1 one unresolved attempt; I2 one settlement; I9 concurrent allocation (blocked, then rejected); allocation release; duplicate provider event can't settle twice; D12 and I10 approval binding; D8 self-approval; §4.1 and I5; §5.2 attempt finality; immutable amounts.                                          |
| `idempotency.db-spec.ts`        | Same key and request replays; same key with a different payload → 422; same body with a different command type → 422 (C1); concurrent same key → one owner plus an immediate 409 that writes nothing (C2); deterministic rejection persisted and replayed after conditions change; `FORBIDDEN`; commit failure → 5xx with nothing recorded; transient rejection → retry; the database refuses to bind transient codes. |
| `webhook-processing.db-spec.ts` | Duplicate, conflicting, invalid-signature and oversized deliveries; exclusive claims; lease reclaim; crash consumes an attempt; stale token can't commit or log; `PROCESSED` final; repeated crashes → `LEASE_EXPIRED` exhaustion and a critical anomaly; technical retries → exhaustion; D25 (no system resolution even after successful reprocessing).                                                               |
| `bank-boundary.db-spec.ts`      | Role isolation in both directions, with no `DELETE` or `TRUNCATE`; bank acceptance survives a PaySim rollback; late refusal consistency; queryability (`visibleAt ≤ receivedAt + W`, window copied from the profile); `NO_RESPONSE` vs. unanswered; one response per request; poll claims exclusive, one request per generation, superseded generation fenced; one `DISPATCH` per attempt (D19).                       |
| `replay.db-spec.ts`             | Recorded response replayed; reused references with new IDs; source immutable (run gate, fingerprint unchanged); payload mismatch → divergence and `NO_RESPONSE`; replay continues and completes with `diverged = true`; playback miss; unused recordings; deterministic divergence keys; cross-run references can't target an unrelated run.                                                                           |
| `anomalies.db-spec.ts`          | Evidence insert-only and frozen after creation; actions append-only and gap-free; status and action atomic at commit; critical resolution requires an authorised operator (`support-01` refused, `recon-01` allowed); the system can't resolve or reopen critical anomalies; D15 blocks dispatch until resolved; Attention auto-resolution; requeue generation creates a distinct, deduplicated anomaly.               |
| `run-lifecycle.db-spec.ts`      | Frozen configuration (columns, banks, bank profiles, catalogue); bank parameters must match the pinned version; ingress key stored hashed; replay only from completed sources and with the source's secret; completion blocked by a pending attempt or a claimed event; completion waits for in-flight writers, then the run gate rejects writes; legal run transitions; `DIVERGED` separate from status.              |
| `prisma-client.db-spec.ts`      | The repository's generated Prisma client and `@prisma/adapter-pg` read the new schema as `paysim_app`, with exact `BigInt` money.                                                                                                                                                                                                                                                                                      |

**What these tests do not prove:** the production services themselves (Phase 4). The tests
use **reference implementations** of the protocols, in `test/db/support/protocols.ts`, to
show that the database supports them correctly.
