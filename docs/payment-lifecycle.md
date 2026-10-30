# Payment Lifecycle

> Status: **design not started, nothing implemented.** This document records the rules the
> lifecycle must satisfy and the questions to settle before implementation. The candidate
> states below are a starting point for discussion. They are not a decision.

## 1. Rules the lifecycle must satisfy

1. **Single gate for state changes.** A payment's status changes only through
   `@paysim/state-machine`. It validates `(currentState, event) → nextState` and rejects
   anything else. No code path may write a status column directly.
2. **Pure transition logic.** The state machine is a pure function with no I/O, clock or
   randomness, so it can be tested exhaustively and replayed deterministically.
3. **Event-sourced history.** Every accepted transition is recorded as an append-only event
   with its own ID, the payment ID, the causing request or delivery ID, and a timestamp.
   Current state must be derivable from the event history.
4. **Idempotent effects.** Each inbound command or webhook carries an idempotency key.
   Reprocessing the same key is a no-op that returns the original outcome. A database
   unique constraint enforces this; application checks alone are not enough.
5. **Exact money.** Amounts are integer minor units plus an ISO 4217 currency code. No
   floats anywhere in the pipeline, including JSON (amounts serialised as strings).
6. **Terminal states are final.** No transitions out of a terminal state. Corrections are
   new payments (e.g. a refund), never edits.
7. **Replay isolation.** A replay runs against copies or a separate namespace and never
   mutates the original payment or its events.

## 2. Candidate states (draft for discussion)

```text
created ──► pending ──► processing ──► succeeded ──► (refund flow, separate payment)
               │             │
               │             ├──► failed        (terminal)
               │             └──► requires_action ──► processing
               └──► cancelled                   (terminal)
```

| State             | Meaning (draft)                                                |
| ----------------- | -------------------------------------------------------------- |
| `created`         | Recorded and validated, not yet submitted.                     |
| `pending`         | Submitted to the simulated provider, awaiting acknowledgement. |
| `processing`      | Provider acknowledged, awaiting final outcome.                 |
| `requires_action` | Provider needs more input (simulated) before continuing.       |
| `succeeded`       | Final success. Financial effect applied exactly once.          |
| `failed`          | Final failure. No financial effect.                            |
| `cancelled`       | Withdrawn before processing.                                   |

## 3. Failure scenarios the design must handle

- The same webhook delivered twice, or concurrently.
- Webhooks arriving out of order (e.g. `succeeded` before `processing`).
- Provider timeout followed by a late success.
- A crash between "state persisted" and "event published" (outbox needed?).
- A replay of a scenario whose original payment has since moved on.

## 4. Open questions

- Are out-of-order events rejected, buffered, or applied when they are a valid "skip-ahead"?
- Do we use a transactional outbox for event publication from day one?
- Is the event log the source of truth (event sourcing), or an audit trail beside a
  status column?
- Are partial captures or partial refunds in scope for v1?
- How are claim payouts and premium collections modelled: one `Payment` with a direction,
  or separate aggregates?

## 5. Implementation status

| Item                                            | Status      |
| ----------------------------------------------- | ----------- |
| State/event definitions                         | Not started |
| Transition table in `@paysim/state-machine`     | Not started |
| Prisma models (payment, event, idempotency key) | Not started |
| API endpoints                                   | Not started |
| Property-based transition tests                 | Not started |
