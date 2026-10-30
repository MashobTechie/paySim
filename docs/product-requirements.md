# PaySim Product Requirements

> Status: **draft**. Captures intent and scope. Nothing in sections 4–5 is implemented yet.

## 1. Problem

Insurance payment systems handle premium collections, claim payouts and refunds.
They fail in ways that are hard to reproduce in development: duplicate webhooks,
out-of-order events, provider timeouts, partial failures mid-transition, and replays that
quietly corrupt state. Teams usually find these failures in production.

## 2. Product

PaySim is an **Insurance Payment Reliability Simulator**: a developer-facing environment
for creating synthetic insurance payment workflows, injecting failures, inspecting event
processing, replaying scenarios, and asserting that the system behaves correctly.

It is an engineering demonstration and a test harness. It is not a payment processor.

## 3. Users

- **Backend / payments engineers** who want to check how a payment flow behaves under failure.
- **QA / reliability engineers** who build regression suites around payment edge cases.
- **Reviewers** (interviewers, architects) who evaluate the correctness guarantees.

## 4. Capabilities (planned)

| #   | Capability                   | Summary                                                                           |
| --- | ---------------------------- | --------------------------------------------------------------------------------- |
| 1   | Payment lifecycle simulation | Create synthetic claims and payments and drive them through validated states.     |
| 2   | Event processing & webhooks  | Append-only event log and simulated provider webhooks with delivery tracking.     |
| 3   | Failure injection            | Rules for timeouts, errors, duplicate delivery, reordering and delays.            |
| 4   | Idempotency testing          | Prove that repeated deliveries and requests produce exactly one financial effect. |
| 5   | Payment replay               | Re-run a recorded scenario in isolation without mutating the original records.    |
| 6   | Automated regression testing | Saved scenarios with assertions, run on demand, with history.                     |
| 7   | Reconciliation & anomalies   | Compare expected vs. actual ledger effects and flag discrepancies.                |

## 5. Non-functional requirements

- **Correctness first.** Money is never represented as a JS float. Every state change is
  validated. Every financial effect is idempotent.
- **Traceability.** Any payment's full history (events, transitions, deliveries, request IDs)
  can be reconstructed.
- **Determinism.** Scenarios and failure injection should be reproducible (seeded where random).
- **Isolation.** Replays and test runs never alter source records.
- **Synthetic data only.** No real personal or financial data, no real providers or banks.
- **Local-first.** Runs on a laptop with Docker. No cloud dependency.

## 6. Out of scope

- Real money movement, real bank or provider integrations, PCI-scoped data.
- Any connection to SnapRefund systems or use of its branding.
- Multi-tenant SaaS concerns (billing, organisations, SSO).
- Microservice decomposition.

## 7. Current phase

**Phase 0: Foundation (done).** Monorepo, API and web shells, database connectivity,
health check, logging, error handling and docs.

**Next:** design the payment, claim and event data models and the payment lifecycle
(see `payment-lifecycle.md`) before writing any payment code.

## 8. Open questions

- Which payment types are first-class in v1 (premium collection, claim payout, refund)?
- What is the currency model: a single currency, or multi-currency with explicit minor-unit
  exponents?
- Which queue backend fits event processing: Postgres-backed (pg-boss) or Redis-backed (BullMQ)?
- How are scenarios defined: code (TypeScript DSL), declarative JSON/YAML, or both?
