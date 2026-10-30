# PaySim Entity Relationship Diagram

> **Status: matches `prisma/schema.prisma` (Phase 3).** The schema is too large for one
> readable picture, so it is split into four diagrams that share entities.
>
> **Notation:**
>
> - `PK` = primary key, `FK` = foreign key, `UK` = part of a unique constraint.
> - Every run-owned entity also has `simulationRunId`. Its references to other run-owned
>   entities are **composite** `(fk, simulationRunId)`, so a reference can never cross runs,
>   except for the two exceptions in §5.
> - Full field lists are in [`data-model.md`](data-model.md). Enforcement is described in
>   [`database-design.md`](database-design.md).

## 1. Namespaces and ownership

```text
simconfig (global catalogue, read-only to apps)        paysim (PaySim side)                      simbank (bank side)
──────────────────────────────────────────────         ─────────────────────────────────         ───────────────────────────
ConfigurationProfile                                    SimulationRun ◄── owns everything ──────► BankRunProfile
  └─ ConfigurationProfileVersion ◄── pinned by ───────    ├─ SimulatedBank                          ├─ SimulatedBankAccount
       └─ ConfigurationBankDefinition                     ├─ Claim, Recipient, Payment …            ├─ BankInstruction
SyntheticOperator                                         ├─ commands, events, bank interactions    └─ BankWebhookDispatch
  └─ SyntheticOperatorPermission                          └─ anomalies, replay divergences
```

- **Global records** (`simconfig`) belong to no run and are never modified once published.
- **Run-owned records** (`paysim`, `simbank`) all carry a non-null `simulationRunId`.
- **The bank side** (`simbank`) references only the run itself. It has no foreign keys into
  PaySim's payment records, and PaySim's database role cannot read it.

## 2. Runs, configuration and the bank side

```mermaid
erDiagram
    ConfigurationProfile ||--o{ ConfigurationProfileVersion : "has versions"
    ConfigurationProfileVersion ||--|{ ConfigurationBankDefinition : "defines banks"
    ConfigurationProfileVersion ||--o{ SimulationRun : "pinned by"
    SyntheticOperator ||--o{ SyntheticOperatorPermission : "may perform"
    SimulationRun |o--o{ SimulationRun : "replay of (sourceRunId)"
    SimulationRun ||--|{ SimulatedBank : "materialises"
    SimulationRun ||--o{ BankRunProfile : "bank-side copy"
    BankRunProfile ||--o{ SimulatedBankAccount : "knows"
    BankRunProfile ||--o{ BankInstruction : "received"
    BankRunProfile ||--o{ BankWebhookDispatch : "plans"

    ConfigurationProfileVersion {
        uuid id PK
        uuid profileId FK "UK(profileId, versionNo)"
        int versionNo
        int eventRetryLimit
        json failureInjectionRules
    }
    SimulationRun {
        uuid id PK "UK(id, sourceRunId)"
        text runReference UK
        enum type "SCENARIO | REPLAY"
        enum status "CREATED ACTIVE COMPLETED ABORTED"
        bool diverged "replay marker"
        uuid sourceRunId FK "cross-run exception 1"
        uuid configurationProfileVersionId FK
    }
    SimulatedBank {
        uuid id PK
        uuid simulationRunId FK "UK(run, providerCode)"
        text providerCode
        int settlementWindowMs
        text ingressKeyHash UK "SHA-256 only"
    }
    BankRunProfile {
        uuid id PK
        uuid simulationRunId FK "UK(run, providerCode)"
        text webhookIngressKey "bank-side only"
    }
    BankInstruction {
        uuid id PK
        text bankReference "UK(run, provider, ref)"
        timestamptz acceptanceDeadline
        timestamptz visibleAt "<= receivedAt + W"
        enum status
    }
```

## 3. Claims, recipients and payments

```mermaid
erDiagram
    SimulationRun ||--o{ Claim : owns
    SimulationRun ||--o{ Recipient : owns
    Claim ||--o{ Payment : "allocates to"
    Payment ||--|{ RecipientSnapshot : "has snapshots"
    Payment |o--|| RecipientSnapshot : "current snapshot"
    Recipient |o--o{ RecipientSnapshot : "copied into"
    RecipientSnapshot ||--o{ VerificationResult : "verified by"
    Payment ||--o| Approval : "approved once"
    Approval }o--|| RecipientSnapshot : "binds snapshot"
    Approval }o--|| VerificationResult : "binds verification"
    Payment ||--o{ PaymentAttempt : "attempts"
    Approval ||--o{ PaymentAttempt : "built from"
    PaymentAttempt ||--|{ AttemptStatusChange : "history"
    Payment ||--|{ PaymentTransition : "history"
    Payment ||--o| Settlement : "settled once"
    PaymentAttempt ||--o| Settlement : "succeeded attempt"
    Payment |o--o{ Payment : "retryOf"

    Claim {
        uuid id PK "UK(id, run)"
        text claimRef "UK(run, claimRef)"
        bigint approvedPayableAmountMinor
        char3 currency
    }
    Payment {
        uuid id PK "UK(id, run)"
        text reference "UK(run, reference)"
        bigint amountMinor
        enum status "9 states"
        int version
        uuid currentSnapshotId FK
    }
    RecipientSnapshot {
        uuid id PK
        uuid paymentId FK "UK(paymentId, snapshotNo)"
        int snapshotNo
    }
    Approval {
        uuid id PK
        uuid paymentId FK "UK"
        bigint amountMinor
        text approverActorId
    }
    PaymentAttempt {
        uuid id PK
        uuid paymentId FK "UK(paymentId, attemptNumber)"
        text bankReference "UK(run, provider, ref)"
        enum status "partial UK: one unresolved per payment"
        int pollGeneration
    }
    Settlement {
        uuid id PK
        uuid paymentId FK "UK"
        uuid attemptId FK
        bigint amountMinor
    }
    PaymentTransition {
        uuid id PK
        uuid paymentId FK "UK(paymentId, sequenceNo)"
        enum trigger
    }
```

## 4. Commands, events, bank interactions and anomalies

```mermaid
erDiagram
    SimulationRun ||--o{ InboundCommand : "input tape"
    InboundCommand ||--o| IdempotencyRecord : "binds outcome"
    InboundCommand |o--o{ InboundCommand : "IDEMPOTENT_REPLAY of"
    SimulationRun ||--o{ ProviderEvent : owns
    ProviderEvent ||--o{ WebhookDelivery : "delivered by"
    ProviderEvent ||--o{ EventProcessingAttempt : "processing log"
    SimulationRun ||--o{ BankInteractionRequest : owns
    BankInteractionRequest ||--o| BankInteractionResponse : "answered by"
    RecipientSnapshot |o--o{ BankInteractionRequest : "VERIFY_ACCOUNT subject"
    PaymentAttempt |o--o{ BankInteractionRequest : "DISPATCH / STATUS_QUERY subject"
    Anomaly ||--|{ AnomalyEvidence : "fixed evidence"
    Anomaly ||--|{ AnomalyAction : "append-only history"
    Anomaly |o--o{ Anomaly : "relatedAnomaly"

    InboundCommand {
        uuid id PK
        enum commandType
        text actorId
        text idempotencyKey
        text requestFingerprint "sha256(type, version, payload)"
        enum outcome "ACCEPTED REJECTED IDEMPOTENT_REPLAY"
    }
    IdempotencyRecord {
        uuid id PK
        text idempotencyKey "UK(run, actor, key)"
        enum outcome
        enum rejectionCode "deterministic only"
    }
    ProviderEvent {
        uuid id PK
        text providerEventId "UK(run, provider, eventId)"
        enum processingStatus
        uuid claimToken "fencing token"
        int attemptCount
        int requeueGeneration
    }
    WebhookDelivery {
        uuid id PK
        enum receiptOutcome
        bytea rawBody "<= 64 KiB"
    }
    BankInteractionRequest {
        uuid id PK
        text readableKey "UK(run, provider, type, key, occurrence)"
        int occurrenceNo
        int pollGeneration "partial UK per attempt"
        text payloadHash
    }
    BankInteractionResponse {
        uuid id PK
        uuid requestId FK "UK"
        enum kind "RESPONSE | NO_RESPONSE"
    }
    Anomaly {
        uuid id PK
        text evidenceKey "UK(run, type, key)"
        enum severity "fixed at detection"
        enum status "recorded with each action"
    }
```

## 5. Replay divergences: the two cross-run exceptions

```mermaid
erDiagram
    SimulationRun ||--o{ ReplayDivergence : "replay run owns"
    InboundCommand |o--o{ ReplayDivergence : "source / replay command"
    WebhookDelivery |o--o{ ReplayDivergence : "source / replay delivery"
    ProviderEvent |o--o{ ReplayDivergence : "source / replay event"
    BankInteractionRequest |o--o{ ReplayDivergence : "source / replay request"

    ReplayDivergence {
        uuid id PK
        uuid simulationRunId FK "the replay run"
        uuid sourceRunId FK "(simulationRunId, sourceRunId) -> SimulationRun(id, sourceRunId)"
        enum divergenceType
        text divergenceKey "UK(run, type, key)"
        uuid sourceBankRequestId FK "(id, sourceRunId)"
        uuid replayBankRequestId FK "(id, simulationRunId)"
    }
```

Only two references may cross runs:

1. **`SimulationRun.sourceRunId`.** A replay points at its completed source run.
2. **`ReplayDivergence` source references.** Each source reference is composite with
   `sourceRunId`, and the pair `(simulationRunId, sourceRunId)` must match the replay run's
   own `(id, sourceRunId)`. So a divergence can only cite evidence from **its own** source
   run, never from an unrelated run. The test suite proves this (`replay.db-spec.ts`).

## 6. Cardinalities in plain language

- **Runs and banks.** A configuration version can be pinned by many runs; each run pins
  exactly one. A run has at least one simulated bank before it can become active. Its bank
  settings are copies of the pinned version and never change afterwards.
- **Claims and payments.** A claim can fund many payments. The payments that are still live
  can never add up to more than the claim's approved amount.
- **Snapshots.** A payment has one or more recipient snapshots (one per correction) and
  points at exactly one current snapshot. A snapshot belongs to one payment.
- **Approval.** A payment has at most one approval. It names the exact snapshot,
  verification and amount.
- **Attempts.** A payment has zero or more attempts, at most one of them unresolved. Every
  attempt has a status history that starts with `PENDING`.
- **Transitions and settlement.** A payment has one transition per status change, starting
  with its creation, and at most one settlement, tied to the attempt that succeeded.
- **Commands.** A command may bind at most one idempotency record. A replayed request points
  at the command whose answer it repeats.
- **Provider events.** A provider event has one or more deliveries (receipt) and zero or more
  processing attempts. Its row holds only the current claim.
- **Bank interactions.** A bank request has zero or one response. Zero means "unanswered",
  which is distinct from a `NO_RESPONSE` timeout. Each attempt has at most one `DISPATCH`
  request, and at most one status query per poll generation.
- **Anomalies.** An anomaly has at least one evidence row (fixed at creation) and at least one
  action (`OPENED` first). Its stored status always matches its latest action.
