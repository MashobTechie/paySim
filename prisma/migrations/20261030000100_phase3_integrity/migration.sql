-- PaySim Phase 3 — database integrity enforcement.
--
-- Everything Prisma cannot express: CHECK constraints, partial unique indexes, insert-only
-- and controlled-update enforcement, the run gate, state-machine and fencing rules,
-- permission checks and deferred (commit-time) consistency checks.
-- See docs/database-design.md for the invariant → mechanism map.
--
-- Error convention: RAISE EXCEPTION 'PAYSIM_<CODE>: <detail>' (SQLSTATE P0001), so callers
-- and tests can match on a stable code.

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. CHECK constraints
-- ═════════════════════════════════════════════════════════════════════════════

-- Catalogue sanity
ALTER TABLE simconfig."ConfigurationProfileVersion"
  ADD CONSTRAINT cpv_version_positive CHECK ("versionNo" >= 1),
  ADD CONSTRAINT cpv_settings_positive CHECK ("eventRetryLimit" >= 1 AND "eventBackoffBaseMs" > 0
                                              AND "processingLeaseMs" > 0 AND "pollLeaseMs" > 0),
  ADD CONSTRAINT cpv_hash_format CHECK ("contentHash" ~ '^[0-9a-f]{64}$');
ALTER TABLE simconfig."ConfigurationBankDefinition"
  ADD CONSTRAINT cbd_params_positive CHECK ("settlementWindowMs" > 0 AND "acceptanceTtlMs" > 0
                                            AND "escalationThresholdMs" > 0 AND "attemptRetryLimit" >= 1),
  ADD CONSTRAINT cbd_backoff_present CHECK (cardinality("attemptBackoffMs") >= 1);

-- Runs
ALTER TABLE paysim."SimulationRun"
  ADD CONSTRAINT run_replay_has_source CHECK ((type = 'REPLAY') = ("sourceRunId" IS NOT NULL)),
  ADD CONSTRAINT run_not_own_source CHECK ("sourceRunId" IS NULL OR "sourceRunId" <> id),
  ADD CONSTRAINT run_diverged_only_replay CHECK (NOT diverged OR type = 'REPLAY'),
  ADD CONSTRAINT run_settings_positive CHECK ("eventRetryLimit" >= 1 AND "eventBackoffBaseMs" > 0
                                              AND "processingLeaseMs" > 0 AND "pollLeaseMs" > 0);
ALTER TABLE paysim."SimulatedBank"
  ADD CONSTRAINT bank_params_positive CHECK ("settlementWindowMs" > 0 AND "acceptanceTtlMs" > 0
                                             AND "escalationThresholdMs" > 0 AND "attemptRetryLimit" >= 1),
  ADD CONSTRAINT bank_ingress_hash_format CHECK ("ingressKeyHash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT bank_secret_present CHECK (length("signingSecret") >= 32);

-- Money: positive integer minor units and ISO 4217 format (C1, I14)
ALTER TABLE paysim."Claim"
  ADD CONSTRAINT claim_amount_positive CHECK ("approvedPayableAmountMinor" > 0),
  ADD CONSTRAINT claim_currency_format CHECK (currency ~ '^[A-Z]{3}$');
ALTER TABLE paysim."Payment"
  ADD CONSTRAINT payment_amount_positive CHECK ("amountMinor" > 0),
  ADD CONSTRAINT payment_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT payment_version_positive CHECK (version >= 1),
  ADD CONSTRAINT payment_reference_format CHECK (reference ~ '^PAY-[0-9]{4}-[0-9]{6,}$');
ALTER TABLE paysim."Approval"
  ADD CONSTRAINT approval_amount_positive CHECK ("amountMinor" > 0),
  ADD CONSTRAINT approval_currency_format CHECK (currency ~ '^[A-Z]{3}$');
ALTER TABLE paysim."PaymentAttempt"
  ADD CONSTRAINT attempt_amount_positive CHECK ("amountMinor" > 0),
  ADD CONSTRAINT attempt_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT attempt_number_positive CHECK ("attemptNumber" >= 1),
  ADD CONSTRAINT attempt_counters CHECK ("statusQueryCount" >= 0 AND "pollGeneration" >= 0),
  ADD CONSTRAINT attempt_poll_claim_pair CHECK (("pollClaimToken" IS NULL) = ("pollLeaseExpiresAt" IS NULL));
ALTER TABLE paysim."Settlement"
  ADD CONSTRAINT settlement_amount_positive CHECK ("amountMinor" > 0),
  ADD CONSTRAINT settlement_currency_format CHECK (currency ~ '^[A-Z]{3}$');
ALTER TABLE paysim."ProviderEvent"
  ADD CONSTRAINT event_amount_positive CHECK ("amountMinor" IS NULL OR "amountMinor" > 0),
  ADD CONSTRAINT event_currency_format CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT event_amount_currency_pair CHECK (("amountMinor" IS NULL) = (currency IS NULL));
ALTER TABLE simbank."BankInstruction"
  ADD CONSTRAINT instruction_amount_positive CHECK ("amountMinor" > 0),
  ADD CONSTRAINT instruction_currency_format CHECK (currency ~ '^[A-Z]{3}$');

-- Snapshots and verification
ALTER TABLE paysim."RecipientSnapshot"
  ADD CONSTRAINT snapshot_number_positive CHECK ("snapshotNo" >= 1);
ALTER TABLE paysim."VerificationResult"
  ADD CONSTRAINT verification_match_has_returned_name CHECK (outcome <> 'MATCH' OR "returnedName" IS NOT NULL);

-- Typed references with discriminators (DM5): exactly the column matching the type is set.
ALTER TABLE paysim."AttemptStatusChange"
  ADD CONSTRAINT asc_sequence_positive CHECK ("sequenceNo" >= 1),
  ADD CONSTRAINT asc_typed_cause CHECK (
        ("causeType" = 'BANK_RESPONSE')   = ("causeBankResponseId"  IS NOT NULL)
    AND ("causeType" = 'PROVIDER_EVENT')  = ("causeProviderEventId" IS NOT NULL)
    AND ("causeType" = 'INBOUND_COMMAND') = ("causeCommandId"       IS NOT NULL)
    AND ("causeType" = 'SYSTEM_JOB')      = ("causeJob"             IS NOT NULL)),
  ADD CONSTRAINT asc_actor_matches_cause CHECK (
        ("causeType" = 'INBOUND_COMMAND' AND "actorType" = 'USER')
     OR ("causeType" = 'PROVIDER_EVENT'  AND "actorType" = 'PROVIDER')
     OR ("causeType" IN ('BANK_RESPONSE', 'SYSTEM_JOB') AND "actorType" = 'SYSTEM'));
ALTER TABLE paysim."PaymentTransition"
  ADD CONSTRAINT transition_sequence_positive CHECK ("sequenceNo" >= 1),
  ADD CONSTRAINT transition_typed_cause CHECK (
        ("causeType" = 'BANK_RESPONSE')   = ("causeBankResponseId"  IS NOT NULL)
    AND ("causeType" = 'PROVIDER_EVENT')  = ("causeProviderEventId" IS NOT NULL)
    AND ("causeType" = 'INBOUND_COMMAND') = ("causeCommandId"       IS NOT NULL)
    AND ("causeType" = 'SYSTEM_JOB')      = ("causeJob"             IS NOT NULL)),
  ADD CONSTRAINT transition_actor_matches_cause CHECK (
        ("causeType" = 'INBOUND_COMMAND' AND "actorType" = 'USER')
     OR ("causeType" = 'PROVIDER_EVENT'  AND "actorType" = 'PROVIDER')
     OR ("causeType" IN ('BANK_RESPONSE', 'SYSTEM_JOB') AND "actorType" = 'SYSTEM')),
  ADD CONSTRAINT transition_reason_required CHECK (
        trigger NOT IN ('REJECT', 'CANCEL') OR (reason IS NOT NULL AND length(btrim(reason)) > 0));
ALTER TABLE paysim."Settlement"
  ADD CONSTRAINT settlement_typed_cause CHECK (
        "causeType" <> 'SYSTEM_JOB'
    AND ("causeType" = 'BANK_RESPONSE')   = ("causeBankResponseId"  IS NOT NULL)
    AND ("causeType" = 'PROVIDER_EVENT')  = ("causeProviderEventId" IS NOT NULL)
    AND ("causeType" = 'INBOUND_COMMAND') = ("causeCommandId"       IS NOT NULL));

-- Commands and idempotency
ALTER TABLE paysim."InboundCommand"
  ADD CONSTRAINT command_actor_is_user CHECK ("actorType" = 'USER'),
  ADD CONSTRAINT command_rejection_pair CHECK ((outcome = 'REJECTED') = ("rejectionCode" IS NOT NULL)),
  ADD CONSTRAINT command_replay_pair CHECK ((outcome = 'IDEMPOTENT_REPLAY') = ("originalCommandId" IS NOT NULL)),
  ADD CONSTRAINT command_fingerprint_format CHECK ("requestFingerprint" ~ '^[0-9a-f]{64}$');
ALTER TABLE paysim."IdempotencyRecord"
  ADD CONSTRAINT idem_rejection_pair CHECK ((outcome = 'REJECTED') = ("rejectionCode" IS NOT NULL)),
  -- Only deterministic rejections may bind a key (D28). Transient ones never do.
  ADD CONSTRAINT idem_rejection_deterministic CHECK ("rejectionCode" IS NULL OR "rejectionCode" IN (
        'VALIDATION_FAILED', 'INVALID_TRANSITION', 'CLAIM_ALLOCATION_EXCEEDED',
        'SELF_APPROVAL_FORBIDDEN', 'STALE_APPROVAL_TARGET', 'FORBIDDEN')),
  ADD CONSTRAINT idem_fingerprint_format CHECK ("requestFingerprint" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT idem_response_status CHECK ("responseStatus" BETWEEN 200 AND 599);

-- Provider events and webhooks
ALTER TABLE paysim."ProviderEvent"
  ADD CONSTRAINT event_counters CHECK ("attemptCount" >= 0 AND "requeueGeneration" >= 0),
  ADD CONSTRAINT event_processing_has_claim CHECK (
        "processingStatus" <> 'PROCESSING' OR ("claimToken" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL)),
  ADD CONSTRAINT event_processed_has_outcome CHECK (
        ("processingStatus" = 'PROCESSED') = (outcome IS NOT NULL)
    AND ("processingStatus" <> 'PROCESSED' OR "processedAt" IS NOT NULL)),
  ADD CONSTRAINT event_rejected_has_reason CHECK ((outcome = 'REJECTED') IS NOT DISTINCT FROM ("outcomeReason" IS NOT NULL)
                                                  OR (outcome IS NULL AND "outcomeReason" IS NULL)),
  ADD CONSTRAINT event_payload_hash_format CHECK ("payloadHash" ~ '^[0-9a-f]{64}$');
ALTER TABLE paysim."WebhookDelivery"
  ADD CONSTRAINT delivery_body_cap CHECK (octet_length("rawBody") <= 65536),
  ADD CONSTRAINT delivery_body_hash_format CHECK ("bodyHash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT delivery_event_iff_accepted CHECK (
        ("receiptOutcome" IN ('NEW_EVENT', 'DUPLICATE_DELIVERY', 'CONFLICTING_PAYLOAD'))
        = ("providerEventRecordId" IS NOT NULL)),
  ADD CONSTRAINT delivery_signature_outcome CHECK (("receiptOutcome" = 'INVALID_SIGNATURE') = (NOT "signatureValid")),
  ADD CONSTRAINT delivery_http_status CHECK (
        ("receiptOutcome" IN ('NEW_EVENT', 'DUPLICATE_DELIVERY', 'CONFLICTING_PAYLOAD') AND "httpStatus" BETWEEN 200 AND 299)
     OR ("receiptOutcome" = 'MALFORMED' AND "httpStatus" = 400)
     OR ("receiptOutcome" = 'INVALID_SIGNATURE' AND "httpStatus" = 401));
ALTER TABLE paysim."EventProcessingAttempt"
  ADD CONSTRAINT epa_time_order CHECK ("endedAt" >= "claimedAt"),
  ADD CONSTRAINT epa_error_present CHECK (result = 'COMPLETED' OR error IS NOT NULL);

-- Bank interactions
ALTER TABLE paysim."BankInteractionRequest"
  ADD CONSTRAINT request_typed_subject CHECK (
        ("subjectType" = 'SNAPSHOT') = ("subjectSnapshotId" IS NOT NULL)
    AND ("subjectType" = 'ATTEMPT')  = ("subjectAttemptId"  IS NOT NULL)),
  ADD CONSTRAINT request_type_subject CHECK (("interactionType" = 'VERIFY_ACCOUNT') = ("subjectType" = 'SNAPSHOT')),
  ADD CONSTRAINT request_poll_generation CHECK (("interactionType" = 'STATUS_QUERY') = ("pollGeneration" IS NOT NULL)),
  ADD CONSTRAINT request_occurrence_positive CHECK ("occurrenceNo" >= 1),
  ADD CONSTRAINT request_payload_hash_format CHECK ("payloadHash" ~ '^[0-9a-f]{64}$');
ALTER TABLE paysim."BankInteractionResponse"
  ADD CONSTRAINT response_no_response_pair CHECK ((kind = 'NO_RESPONSE') = (classification = 'NO_RESPONSE')),
  ADD CONSTRAINT response_no_response_empty CHECK (kind = 'RESPONSE' OR ("httpStatus" IS NULL AND body IS NULL)),
  ADD CONSTRAINT response_elapsed_nonnegative CHECK ("elapsedMs" >= 0);

-- Anomalies
ALTER TABLE paysim."Anomaly"
  ADD CONSTRAINT anomaly_sequence_nonnegative CHECK ("lastActionSequenceNo" >= 0);
ALTER TABLE paysim."AnomalyEvidence"
  ADD CONSTRAINT evidence_typed_reference CHECK (
        ("evidenceType" = 'PROVIDER_EVENT')        = ("evidenceProviderEventId"       IS NOT NULL)
    AND ("evidenceType" = 'WEBHOOK_DELIVERY')      = ("evidenceDeliveryId"            IS NOT NULL)
    AND ("evidenceType" = 'BANK_REQUEST')          = ("evidenceBankRequestId"         IS NOT NULL)
    AND ("evidenceType" = 'BANK_RESPONSE')         = ("evidenceBankResponseId"        IS NOT NULL)
    AND ("evidenceType" = 'ATTEMPT_STATUS_CHANGE') = ("evidenceAttemptStatusChangeId" IS NOT NULL)
    AND ("evidenceType" = 'PROCESSING_ATTEMPT')    = ("evidenceProcessingAttemptId"   IS NOT NULL));
ALTER TABLE paysim."AnomalyAction"
  ADD CONSTRAINT action_sequence_positive CHECK ("sequenceNo" >= 1),
  ADD CONSTRAINT action_typed_cause CHECK (
        ("causeType" = 'INBOUND_COMMAND')       = ("causeCommandId"             IS NOT NULL)
    AND ("causeType" = 'ATTEMPT_STATUS_CHANGE') = ("causeAttemptStatusChangeId" IS NOT NULL)
    AND ("causeType" = 'PROCESSING_ATTEMPT')    = ("causeProcessingAttemptId"   IS NOT NULL)
    AND ("causeType" = 'SYSTEM_JOB')            = ("causeJob"                   IS NOT NULL)),
  ADD CONSTRAINT action_command_by_user CHECK (("causeType" = 'INBOUND_COMMAND') = ("actorType" = 'USER')),
  ADD CONSTRAINT action_reason_present CHECK (length(btrim(reason)) > 0),
  ADD CONSTRAINT action_resolution_pair CHECK (("actionType" = 'RESOLVED') = ("resolutionType" IS NOT NULL)),
  ADD CONSTRAINT action_follow_up_pair CHECK (
        ("resolutionType" IS DISTINCT FROM 'FINANCIAL_IMPACT_CONFIRMED' OR "followUpReference" IS NOT NULL)
    AND ("followUpReference" IS NULL OR "resolutionType" = 'FINANCIAL_IMPACT_CONFIRMED'));

-- Replay divergences
ALTER TABLE paysim."ReplayDivergence"
  ADD CONSTRAINT divergence_mismatch_hashes CHECK (
        "divergenceType" <> 'REQUEST_MISMATCH' OR ("sourcePayloadHash" IS NOT NULL AND "replayPayloadHash" IS NOT NULL));

-- Simulated bank: late refusal and the queryability guarantee (§5.7)
ALTER TABLE simbank."BankRunProfile"
  ADD CONSTRAINT profile_params_positive CHECK ("settlementWindowMs" > 0 AND "acceptanceTtlMs" > 0);
ALTER TABLE simbank."BankInstruction"
  ADD CONSTRAINT instruction_late_refusal CHECK ((status = 'REFUSED_LATE') = ("receivedAt" > "acceptanceDeadline")),
  ADD CONSTRAINT instruction_queryability CHECK (
        "visibleAt" >= "receivedAt"
    AND "visibleAt" <= "receivedAt" + ("settlementWindowMs" * interval '1 millisecond')),
  ADD CONSTRAINT instruction_failure_code CHECK (status <> 'FAILED' OR "failureCode" IS NOT NULL);
ALTER TABLE simbank."BankWebhookDispatch"
  ADD CONSTRAINT dispatch_send_positive CHECK ("sendNo" >= 1),
  ADD CONSTRAINT dispatch_status_after_send CHECK ("httpStatus" IS NULL OR "sentAt" IS NOT NULL);

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. Partial and expression indexes (Prisma cannot express these)
-- ═════════════════════════════════════════════════════════════════════════════

-- I1: at most one unresolved attempt per payment.
CREATE UNIQUE INDEX payment_attempt_one_unresolved
  ON paysim."PaymentAttempt" ("paymentId")
  WHERE status IN ('PENDING', 'SUBMITTED', 'UNKNOWN');

-- D19: recovery is query-only, so each attempt is dispatched at most once.
CREATE UNIQUE INDEX bank_request_one_dispatch_per_attempt
  ON paysim."BankInteractionRequest" ("subjectAttemptId")
  WHERE "interactionType" = 'DISPATCH';

-- I23: at most one status-query request per attempt and poll generation.
CREATE UNIQUE INDEX bank_request_one_per_poll_generation
  ON paysim."BankInteractionRequest" ("subjectAttemptId", "pollGeneration")
  WHERE "interactionType" = 'STATUS_QUERY';

-- D15: fast open-critical-anomaly lookup for the dispatch guard.
CREATE INDEX anomaly_open_critical_by_payment
  ON paysim."Anomaly" ("paymentId")
  WHERE severity = 'CRITICAL' AND status = 'OPEN';

-- One evidence row per anomaly and evidence record.
CREATE UNIQUE INDEX anomaly_evidence_unique
  ON paysim."AnomalyEvidence" ("anomalyId", "evidenceType",
     COALESCE("evidenceProviderEventId", "evidenceDeliveryId", "evidenceBankRequestId",
              "evidenceBankResponseId", "evidenceAttemptStatusChangeId", "evidenceProcessingAttemptId"));

-- Poller work queue.
CREATE INDEX payment_attempt_poll_due
  ON paysim."PaymentAttempt" ("nextStatusQueryAt")
  WHERE status IN ('SUBMITTED', 'UNKNOWN');

-- ═════════════════════════════════════════════════════════════════════════════
-- 3. Shared functions (simconfig: callable from both PaySim and bank-side triggers)
-- ═════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION simconfig.raise_error(code text, detail text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'PAYSIM_%: %', code, detail USING ERRCODE = 'P0001';
END $$;

-- Advisory-lock key for keyed commands (D28). 64-bit hash of a namespaced string.
CREATE OR REPLACE FUNCTION simconfig.idempotency_lock_key(run uuid, actor text, idem_key text) RETURNS bigint
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT hashtextextended('paysim-idem:' || run::text || ':' || actor || ':' || idem_key, 0)
$$;

-- Insert-only tables: no UPDATE or DELETE for any role (the owner included).
CREATE OR REPLACE FUNCTION simconfig.trg_insert_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM simconfig.raise_error('INSERT_ONLY', format('%s.%s is insert-only (%s rejected)',
                                TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP));
  RETURN NULL;
END $$;

-- Controlled-update tables: only the columns named in TG_ARGV may change; DELETE is rejected.
CREATE OR REPLACE FUNCTION simconfig.trg_controlled_update() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  o jsonb; n jsonb; c text; k text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM simconfig.raise_error('INSERT_ONLY', format('%s.%s rows cannot be deleted', TG_TABLE_SCHEMA, TG_TABLE_NAME));
  END IF;
  o := to_jsonb(OLD); n := to_jsonb(NEW);
  FOREACH c IN ARRAY TG_ARGV LOOP
    o := o - c; n := n - c;
  END LOOP;
  IF o IS DISTINCT FROM n THEN
    SELECT key INTO k FROM jsonb_each(o) e WHERE e.value IS DISTINCT FROM n -> e.key LIMIT 1;
    PERFORM simconfig.raise_error('IMMUTABLE_COLUMN', format('%s.%s.%s cannot be changed',
                                  TG_TABLE_SCHEMA, TG_TABLE_NAME, k));
  END IF;
  RETURN NEW;
END $$;

-- Run gate. Locks the run row FOR KEY SHARE (conflicts only with run completion/abort,
-- which lock it FOR UPDATE) and checks the run accepts writes.
--   mode 'active' : run must be ACTIVE
--   mode 'seed'   : run must be CREATED or ACTIVE
--   mode 'config' : run must be CREATED (configuration is frozen afterwards; I20)
CREATE OR REPLACE FUNCTION simconfig.assert_run_writable(run uuid, mode text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE st paysim."RunStatus";
BEGIN
  SELECT status INTO st FROM paysim."SimulationRun" WHERE id = run FOR KEY SHARE;
  IF st IS NULL THEN
    PERFORM simconfig.raise_error('RUN_NOT_FOUND', run::text);
  END IF;
  IF (mode = 'active' AND st <> 'ACTIVE')
     OR (mode = 'seed' AND st NOT IN ('CREATED', 'ACTIVE'))
     OR (mode = 'config' AND st <> 'CREATED') THEN
    PERFORM simconfig.raise_error('RUN_NOT_WRITABLE', format('run %s is %s; %s writes not allowed', run, st, mode));
  END IF;
END $$;

-- Attached as "a00_run_gate" so it fires first: PostgreSQL runs same-event triggers in name order.
CREATE OR REPLACE FUNCTION simconfig.trg_run_gate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM simconfig.assert_run_writable(NEW."simulationRunId", TG_ARGV[0]);
  RETURN NEW;
END $$;

-- Server-side authority (D32, I22): is this synthetic operator active and permitted?
CREATE OR REPLACE FUNCTION simconfig.operator_has_permission(actor text, action simconfig."OperatorAction")
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM simconfig."SyntheticOperator" o
    JOIN simconfig."SyntheticOperatorPermission" p ON p."operatorId" = o.id
    WHERE o.id = actor AND o.active AND p.action = $2)
$$;

CREATE OR REPLACE FUNCTION simconfig.command_permission(ct paysim."CommandType") RETURNS simconfig."OperatorAction"
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE ct
    WHEN 'CREATE_RECIPIENT' THEN 'MANAGE_RECIPIENTS'
    WHEN 'UPDATE_RECIPIENT' THEN 'MANAGE_RECIPIENTS'
    ELSE ct::text
  END::simconfig."OperatorAction"
$$;

-- ═════════════════════════════════════════════════════════════════════════════
-- 4. State-machine tables (mirrors of payment-lifecycle §4.1 and §5.2)
-- ═════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION paysim.payment_transition_allowed(
  f paysim."PaymentStatus", t paysim."PaymentTrigger", s paysim."PaymentStatus") RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT EXISTS (SELECT 1 FROM (VALUES
    (NULL::text,                       'PAYMENT_CREATED',               'PENDING_RECIPIENT_VERIFICATION'), -- T1
    ('PENDING_RECIPIENT_VERIFICATION', 'RECIPIENT_VERIFIED',            'PENDING_APPROVAL'),               -- T2
    ('PENDING_RECIPIENT_VERIFICATION', 'RECIPIENT_VERIFICATION_FAILED', 'RECIPIENT_VERIFICATION_FAILED'),  -- T3
    ('PENDING_RECIPIENT_VERIFICATION', 'CANCEL',                        'CANCELLED'),                      -- T4
    ('RECIPIENT_VERIFICATION_FAILED',  'RECIPIENT_UPDATED',             'PENDING_RECIPIENT_VERIFICATION'), -- T5
    ('RECIPIENT_VERIFICATION_FAILED',  'CANCEL',                        'CANCELLED'),                      -- T6
    ('PENDING_APPROVAL',               'APPROVE',                       'READY_FOR_PAYMENT'),              -- T7
    ('PENDING_APPROVAL',               'REJECT',                        'REJECTED'),                       -- T8
    ('PENDING_APPROVAL',               'CANCEL',                        'CANCELLED'),                      -- T9
    ('READY_FOR_PAYMENT',              'DISPATCH',                      'PROCESSING'),                     -- T10
    ('READY_FOR_PAYMENT',              'CANCEL',                        'CANCELLED'),                      -- T11
    ('PROCESSING',                     'SETTLEMENT_CONFIRMED',          'SETTLED'),                        -- T12
    ('PROCESSING',                     'ATTEMPT_FAILED_RETRYABLE',      'READY_FOR_PAYMENT'),              -- T13
    ('PROCESSING',                     'PAYMENT_FAILED',                'FAILED')                          -- T14
  ) r(f, t, s)
  WHERE r.f IS NOT DISTINCT FROM $1::text AND r.t = $2::text AND r.s = $3::text)
$$;

CREATE OR REPLACE FUNCTION paysim.attempt_transition_allowed(f paysim."AttemptStatus", s paysim."AttemptStatus")
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN $1 IS NULL       THEN $2 = 'PENDING'
    WHEN $1 = 'PENDING'   THEN $2 IN ('SUBMITTED', 'UNKNOWN', 'SUCCEEDED', 'FAILED_RETRYABLE', 'FAILED_PERMANENT')
    WHEN $1 = 'SUBMITTED' THEN $2 IN ('SUCCEEDED', 'FAILED_RETRYABLE', 'FAILED_PERMANENT')
    WHEN $1 = 'UNKNOWN'   THEN $2 IN ('SUBMITTED', 'SUCCEEDED', 'FAILED_RETRYABLE', 'FAILED_PERMANENT')
    ELSE false  -- resolved statuses are final (I11)
  END
$$;

-- Readable payment references: PAY-YYYY-NNNNNN from a per-year sequence (Q12).
CREATE OR REPLACE FUNCTION paysim.next_payment_reference(yr integer) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE seq text := format('paysim.payment_reference_%s', yr);
BEGIN
  IF yr < 2000 OR yr > 9999 THEN
    PERFORM simconfig.raise_error('VALIDATION', 'year out of range');
  END IF;
  IF to_regclass(seq) IS NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('paysim-payment-reference-seq'));
    EXECUTE format('CREATE SEQUENCE IF NOT EXISTS %s START 1', seq);
  END IF;
  RETURN format('PAY-%s-%s', yr, lpad(nextval(seq)::text, 6, '0'));
END $$;

-- ═════════════════════════════════════════════════════════════════════════════
-- 5. Table triggers
-- ═════════════════════════════════════════════════════════════════════════════

-- 5.1 Catalogue: insert-only for everyone.
CREATE TRIGGER insert_only BEFORE UPDATE OR DELETE ON simconfig."ConfigurationProfile"        FOR EACH ROW EXECUTE FUNCTION simconfig.trg_insert_only();
CREATE TRIGGER insert_only BEFORE UPDATE OR DELETE ON simconfig."ConfigurationProfileVersion" FOR EACH ROW EXECUTE FUNCTION simconfig.trg_insert_only();
CREATE TRIGGER insert_only BEFORE UPDATE OR DELETE ON simconfig."ConfigurationBankDefinition" FOR EACH ROW EXECUTE FUNCTION simconfig.trg_insert_only();
CREATE TRIGGER insert_only BEFORE UPDATE OR DELETE ON simconfig."SyntheticOperator"           FOR EACH ROW EXECUTE FUNCTION simconfig.trg_insert_only();
CREATE TRIGGER insert_only BEFORE UPDATE OR DELETE ON simconfig."SyntheticOperatorPermission" FOR EACH ROW EXECUTE FUNCTION simconfig.trg_insert_only();

-- 5.2 SimulationRun
CREATE OR REPLACE FUNCTION paysim.trg_run_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v simconfig."ConfigurationProfileVersion"; src paysim."SimulationRun";
BEGIN
  IF NEW.status <> 'CREATED' OR NEW.diverged OR NEW."activatedAt" IS NOT NULL
     OR NEW."completedAt" IS NOT NULL OR NEW."abortedAt" IS NOT NULL THEN
    PERFORM simconfig.raise_error('RUN_INVALID', 'a run starts in CREATED with no lifecycle timestamps');
  END IF;
  SELECT * INTO v FROM simconfig."ConfigurationProfileVersion" WHERE id = NEW."configurationProfileVersionId";
  IF NEW."eventRetryLimit" <> v."eventRetryLimit" OR NEW."eventBackoffBaseMs" <> v."eventBackoffBaseMs"
     OR NEW."processingLeaseMs" <> v."processingLeaseMs" OR NEW."pollLeaseMs" <> v."pollLeaseMs" THEN
    PERFORM simconfig.raise_error('CONFIG_MISMATCH', 'run settings must be copied from the pinned configuration version');
  END IF;
  IF NEW.type = 'REPLAY' THEN
    SELECT * INTO src FROM paysim."SimulationRun" WHERE id = NEW."sourceRunId" FOR KEY SHARE;
    IF src.status IS DISTINCT FROM 'COMPLETED' THEN
      PERFORM simconfig.raise_error('REPLAY_SOURCE_NOT_COMPLETED', format('source run is %s', coalesce(src.status::text, 'missing')));
    END IF;
    IF src."configurationProfileVersionId" <> NEW."configurationProfileVersionId" THEN
      PERFORM simconfig.raise_error('CONFIG_MISMATCH', 'a replay must pin the same configuration version as its source');
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION paysim.trg_run_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('COMPLETED', 'ABORTED') THEN
    PERFORM simconfig.raise_error('RUN_NOT_WRITABLE', format('run %s is %s and immutable', OLD.id, OLD.status));
  END IF;
  IF NEW.status <> OLD.status THEN
    IF NOT ((OLD.status = 'CREATED' AND NEW.status IN ('ACTIVE', 'ABORTED'))
         OR (OLD.status = 'ACTIVE'  AND NEW.status IN ('COMPLETED', 'ABORTED'))) THEN
      PERFORM simconfig.raise_error('ILLEGAL_RUN_TRANSITION', format('%s -> %s', OLD.status, NEW.status));
    END IF;
    IF (NEW.status = 'ACTIVE' AND NEW."activatedAt" IS NULL)
       OR (NEW.status = 'COMPLETED' AND NEW."completedAt" IS NULL)
       OR (NEW.status = 'ABORTED' AND NEW."abortedAt" IS NULL) THEN
      PERFORM simconfig.raise_error('RUN_INVALID', 'lifecycle timestamp required');
    END IF;
    IF NEW.status = 'ACTIVE' AND NOT EXISTS (SELECT 1 FROM paysim."SimulatedBank" b WHERE b."simulationRunId" = NEW.id) THEN
      PERFORM simconfig.raise_error('RUN_INVALID', 'a run needs at least one simulated bank before activation');
    END IF;
    IF NEW.status IN ('COMPLETED', 'ABORTED') THEN
      -- Exclusive run lock: waits for in-flight writers (which hold FOR KEY SHARE via the run
      -- gate), then blocks new ones until this transaction ends.
      PERFORM 1 FROM paysim."SimulationRun" WHERE id = NEW.id FOR UPDATE;
    END IF;
    IF NEW.status = 'COMPLETED' THEN
      IF EXISTS (SELECT 1 FROM paysim."ProviderEvent" e WHERE e."simulationRunId" = NEW.id
                 AND e."processingStatus" IN ('RECEIVED', 'PROCESSING', 'PROCESSING_ERROR')) THEN
        PERFORM simconfig.raise_error('RUN_HAS_INFLIGHT_WORK', 'provider events are still pending or claimed');
      END IF;
      IF EXISTS (SELECT 1 FROM paysim."PaymentAttempt" a WHERE a."simulationRunId" = NEW.id
                 AND (a.status IN ('PENDING', 'SUBMITTED', 'UNKNOWN') OR a."pollClaimToken" IS NOT NULL)) THEN
        PERFORM simconfig.raise_error('RUN_HAS_INFLIGHT_WORK', 'payment attempts are unresolved or claimed for polling');
      END IF;
    END IF;
  END IF;
  IF NEW.diverged <> OLD.diverged AND (OLD.diverged OR NEW.status <> 'ACTIVE') THEN
    PERFORM simconfig.raise_error('ILLEGAL_RUN_TRANSITION', 'diverged can only be set false -> true on an ACTIVE replay');
  END IF;
  IF NEW."simulatedClockAt" IS DISTINCT FROM OLD."simulatedClockAt"
     AND (NEW."simulatedClockAt" IS NULL OR NEW."simulatedClockAt" < OLD."simulatedClockAt") THEN
    PERFORM simconfig.raise_error('ILLEGAL_RUN_TRANSITION', 'the simulated clock never moves backwards');
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER run_insert BEFORE INSERT ON paysim."SimulationRun" FOR EACH ROW EXECUTE FUNCTION paysim.trg_run_insert();
CREATE TRIGGER run_controlled BEFORE UPDATE OR DELETE ON paysim."SimulationRun" FOR EACH ROW
  EXECUTE FUNCTION simconfig.trg_controlled_update('status', 'diverged', 'simulatedClockAt', 'activatedAt', 'completedAt', 'abortedAt');
CREATE TRIGGER run_update BEFORE UPDATE ON paysim."SimulationRun" FOR EACH ROW EXECUTE FUNCTION paysim.trg_run_update();

-- 5.3 SimulatedBank: frozen configuration copy (I20)
CREATE OR REPLACE FUNCTION paysim.trg_bank_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE r paysim."SimulationRun"; d simconfig."ConfigurationBankDefinition"; s paysim."SimulatedBank";
BEGIN
  SELECT * INTO r FROM paysim."SimulationRun" WHERE id = NEW."simulationRunId";
  SELECT * INTO d FROM simconfig."ConfigurationBankDefinition"
   WHERE "profileVersionId" = r."configurationProfileVersionId" AND "providerCode" = NEW."providerCode";
  IF d.id IS NULL THEN
    PERFORM simconfig.raise_error('CONFIG_MISMATCH', format('bank %s is not defined in the pinned configuration', NEW."providerCode"));
  END IF;
  IF NEW."settlementWindowMs" <> d."settlementWindowMs" OR NEW."acceptanceTtlMs" <> d."acceptanceTtlMs"
     OR NEW."escalationThresholdMs" <> d."escalationThresholdMs" OR NEW."attemptRetryLimit" <> d."attemptRetryLimit"
     OR NEW."attemptBackoffMs" <> d."attemptBackoffMs" OR NEW."queryabilityGuaranteed" <> d."queryabilityGuaranteed" THEN
    PERFORM simconfig.raise_error('CONFIG_MISMATCH', 'bank parameters must be copied from the pinned configuration');
  END IF;
  IF r.type = 'REPLAY' THEN
    SELECT * INTO s FROM paysim."SimulatedBank" WHERE "simulationRunId" = r."sourceRunId" AND "providerCode" = NEW."providerCode";
    IF s.id IS NULL OR s."signingSecret" <> NEW."signingSecret" THEN
      PERFORM simconfig.raise_error('CONFIG_MISMATCH', 'a replay bank must copy the source run bank and signing secret');
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a00_run_gate BEFORE INSERT ON paysim."SimulatedBank" FOR EACH ROW EXECUTE FUNCTION simconfig.trg_run_gate('config');
CREATE TRIGGER bank_insert BEFORE INSERT ON paysim."SimulatedBank" FOR EACH ROW EXECUTE FUNCTION paysim.trg_bank_insert();
CREATE TRIGGER insert_only BEFORE UPDATE OR DELETE ON paysim."SimulatedBank" FOR EACH ROW EXECUTE FUNCTION simconfig.trg_insert_only();

-- 5.4 Claim and Recipient (seeding tables)
CREATE TRIGGER a00_run_gate BEFORE INSERT OR UPDATE ON paysim."Claim" FOR EACH ROW EXECUTE FUNCTION simconfig.trg_run_gate('seed');
CREATE TRIGGER controlled BEFORE UPDATE OR DELETE ON paysim."Claim" FOR EACH ROW
  EXECUTE FUNCTION simconfig.trg_controlled_update('approvedForPayout');
CREATE TRIGGER a00_run_gate BEFORE INSERT OR UPDATE ON paysim."Recipient" FOR EACH ROW EXECUTE FUNCTION simconfig.trg_run_gate('seed');
CREATE TRIGGER controlled BEFORE UPDATE OR DELETE ON paysim."Recipient" FOR EACH ROW
  EXECUTE FUNCTION simconfig.trg_controlled_update('accountName', 'updatedAt');

-- 5.5 Payment: claim allocation (I9), immutability, version, transition legality
CREATE OR REPLACE FUNCTION paysim.trg_payment_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE c paysim."Claim"; allocated bigint; cmd paysim."InboundCommand"; prev paysim."Payment";
BEGIN
  IF NEW.status <> 'PENDING_RECIPIENT_VERIFICATION' OR NEW.version <> 1 THEN
    PERFORM simconfig.raise_error('ILLEGAL_TRANSITION', 'a payment is created in PENDING_RECIPIENT_VERIFICATION with version 1');
  END IF;
  -- [C] claim lock: serialises every allocation-affecting insert for this claim (§7.2).
  SELECT * INTO c FROM paysim."Claim"
   WHERE id = NEW."claimId" AND "simulationRunId" = NEW."simulationRunId" FOR NO KEY UPDATE;
  IF NOT c."approvedForPayout" THEN
    PERFORM simconfig.raise_error('CLAIM_NOT_APPROVED', c."claimRef");
  END IF;
  IF c.currency <> NEW.currency THEN
    PERFORM simconfig.raise_error('CURRENCY_MISMATCH', format('claim %s is %s', c."claimRef", c.currency));
  END IF;
  SELECT coalesce(sum("amountMinor"), 0) INTO allocated FROM paysim."Payment"
   WHERE "claimId" = NEW."claimId" AND status NOT IN ('FAILED', 'CANCELLED', 'REJECTED');
  IF allocated + NEW."amountMinor" > c."approvedPayableAmountMinor" THEN
    PERFORM simconfig.raise_error('CLAIM_ALLOCATION_EXCEEDED',
      format('claim %s: allocated %s + %s > %s', c."claimRef", allocated, NEW."amountMinor", c."approvedPayableAmountMinor"));
  END IF;
  SELECT * INTO cmd FROM paysim."InboundCommand" WHERE id = NEW."createdByCommandId";
  IF cmd."commandType" <> 'CREATE_PAYOUT' OR cmd.outcome <> 'ACCEPTED' OR cmd."actorId" <> NEW."createdByActorId" THEN
    PERFORM simconfig.raise_error('CAUSE_MISMATCH', 'a payment must be created by an accepted CREATE_PAYOUT command of its creator');
  END IF;
  IF NEW."retryOfPaymentId" IS NOT NULL THEN
    SELECT * INTO prev FROM paysim."Payment" WHERE id = NEW."retryOfPaymentId";
    IF prev.status <> 'FAILED' OR prev."claimId" <> NEW."claimId" THEN
      PERFORM simconfig.raise_error('INVALID_RETRY', 'retryOf must reference a FAILED payment of the same claim');
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION paysim.trg_payment_update() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE snap_payment uuid;
BEGIN
  -- Every update advances the version by exactly 1 (D9), except the initial wiring of the
  -- first snapshot inside the creating transaction (currentSnapshotId NULL -> S1, nothing else).
  IF NOT (OLD."currentSnapshotId" IS NULL AND NEW."currentSnapshotId" IS NOT NULL
          AND NEW.version = OLD.version AND NEW.status = OLD.status
          AND NEW."nextDispatchAt" IS NOT DISTINCT FROM OLD."nextDispatchAt")
     AND NEW.version <> OLD.version + 1 THEN
    PERFORM simconfig.raise_error('VERSION_CONFLICT', format('version must advance by exactly 1 (%s -> %s)', OLD.version, NEW.version));
  END IF;
  IF NEW.status <> OLD.status AND NOT EXISTS (
       SELECT 1 FROM unnest(enum_range(NULL::paysim."PaymentTrigger")) t
       WHERE paysim.payment_transition_allowed(OLD.status, t, NEW.status)) THEN
    PERFORM simconfig.raise_error('ILLEGAL_TRANSITION', format('%s -> %s', OLD.status, NEW.status));
  END IF;
  IF NEW."currentSnapshotId" IS DISTINCT FROM OLD."currentSnapshotId" THEN
    SELECT "paymentId" INTO snap_payment FROM paysim."RecipientSnapshot" WHERE id = NEW."currentSnapshotId";
    IF snap_payment IS DISTINCT FROM NEW.id THEN
      PERFORM simconfig.raise_error('SNAPSHOT_MISMATCH', 'current snapshot must belong to the payment');
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER a00_run_gate BEFORE INSERT OR UPDATE ON paysim."Payment" FOR EACH ROW EXECUTE FUNCTION simconfig.trg_run_gate('active');
CREATE TRIGGER payment_insert BEFORE INSERT ON paysim."Payment" FOR EACH ROW EXECUTE FUNCTION paysim.trg_payment_insert();
CREATE TRIGGER controlled BEFORE UPDATE OR DELETE ON paysim."Payment" FOR EACH ROW
  EXECUTE FUNCTION simconfig.trg_controlled_update('status', 'version', 'currentSnapshotId', 'nextDispatchAt', 'updatedAt');
CREATE TRIGGER payment_update BEFORE UPDATE ON paysim."Payment" FOR EACH ROW EXECUTE FUNCTION paysim.trg_payment_update();

-- 5.6 RecipientSnapshot
CREATE OR REPLACE FUNCTION paysim.trg_snapshot_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE expected int; r paysim."Recipient"; cmd paysim."InboundCommand";
BEGIN
  SELECT coalesce(max("snapshotNo"), 0) + 1 INTO expected FROM paysim."RecipientSnapshot" WHERE "paymentId" = NEW."paymentId";
  IF NEW."snapshotNo" <> expected THEN
    PERFORM simconfig.raise_error('SEQUENCE_GAP', format('snapshot number must be %s', expected));
  END IF;
  IF NEW."recipientId" IS NOT NULL THEN
    SELECT * INTO r FROM paysim."Recipient" WHERE id = NEW."recipientId";
    IF (r."bankCode", r."accountNumber", r."accountName") IS DISTINCT FROM (NEW."bankCode", NEW."accountNumber", NEW."accountName") THEN
      PERFORM simconfig.raise_error('SNAPSHOT_MISMATCH', 'a snapshot of a recipient must copy its current details');
    END IF;
  END IF;
  SELECT * INTO cmd FROM paysim."InboundCommand" WHERE id = NEW."createdByCommandId";
  IF cmd."commandType" NOT IN ('CREATE_PAYOUT', 'CORRECT_PAYMENT_RECIPIENT') OR cmd.outcome <> 'ACCEPTED' THEN
    PERFORM simconfig.raise_error('CAUSE_MISMATCH', 'snapshots come from accepted CREATE_PAYOUT or CORRECT_PAYMENT_RECIPIENT commands');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a00_run_gate BEFORE INSERT ON paysim."RecipientSnapshot" FOR EACH ROW EXECUTE FUNCTION simconfig.trg_run_gate('active');
CREATE TRIGGER snapshot_insert BEFORE INSERT ON paysim."RecipientSnapshot" FOR EACH ROW EXECUTE FUNCTION paysim.trg_snapshot_insert();
CREATE TRIGGER insert_only BEFORE UPDATE OR DELETE ON paysim."RecipientSnapshot" FOR EACH ROW EXECUTE FUNCTION simconfig.trg_insert_only();

-- 5.7 VerificationResult
CREATE OR REPLACE FUNCTION paysim.trg_verification_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE req paysim."BankInteractionRequest"; resp paysim."BankInteractionResponse"; cur uuid;
BEGIN
  SELECT * INTO req FROM paysim."BankInteractionRequest" WHERE id = NEW."bankRequestId";
  SELECT * INTO resp FROM paysim."BankInteractionResponse" WHERE id = NEW."bankResponseId";
  IF req."interactionType" <> 'VERIFY_ACCOUNT' OR req."subjectSnapshotId" <> NEW."snapshotId" OR resp."requestId" <> req.id THEN
    PERFORM simconfig.raise_error('CAUSE_MISMATCH', 'verification must cite the VERIFY_ACCOUNT request and response for its snapshot');
  END IF;
  IF NEW.disposition = 'APPLIED' THEN
    SELECT p."currentSnapshotId" INTO cur FROM paysim."RecipientSnapshot" s JOIN paysim."Payment" p ON p.id = s."paymentId"
     WHERE s.id = NEW."snapshotId";
    IF cur IS DISTINCT FROM NEW."snapshotId" THEN
      PERFORM simconfig.raise_error('STALE_SNAPSHOT', 'only a result for the current snapshot can be APPLIED');
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a00_run_gate BEFORE INSERT ON paysim."VerificationResult" FOR EACH ROW EXECUTE FUNCTION simconfig.trg_run_gate('active');
CREATE TRIGGER verification_insert BEFORE INSERT ON paysim."VerificationResult" FOR EACH ROW EXECUTE FUNCTION paysim.trg_verification_insert();
CREATE TRIGGER insert_only BEFORE UPDATE OR DELETE ON paysim."VerificationResult" FOR EACH ROW EXECUTE FUNCTION simconfig.trg_insert_only();

-- 5.8 Approval: bound to exact snapshot, verification and amount (D12, D8, I10, I22)
CREATE OR REPLACE FUNCTION paysim.trg_approval_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE p paysim."Payment"; v paysim."VerificationResult"; cmd paysim."InboundCommand";
BEGIN
  SELECT * INTO p FROM paysim."Payment" WHERE id = NEW."paymentId";
  IF p."currentSnapshotId" IS DISTINCT FROM NEW."snapshotId" THEN
    PERFORM simconfig.raise_error('STALE_APPROVAL_TARGET', 'approval must name the payment''s current snapshot');
  END IF;
  SELECT * INTO v FROM paysim."VerificationResult" WHERE id = NEW."verificationResultId";
  IF v."snapshotId" <> NEW."snapshotId" OR v.outcome <> 'MATCH' OR v.disposition <> 'APPLIED' THEN
    PERFORM simconfig.raise_error('STALE_APPROVAL_TARGET', 'approval needs an applied MATCH verification of that snapshot');
  END IF;
  IF NEW."amountMinor" <> p."amountMinor" OR NEW.currency <> p.currency THEN
    PERFORM simconfig.raise_error('STALE_APPROVAL_TARGET', 'approved amount and currency must equal the payment''s');
  END IF;
  IF NEW."approverActorId" = p."createdByActorId" THEN
    PERFORM simconfig.raise_error('SELF_APPROVAL_FORBIDDEN', NEW."approverActorId");
  END IF;
  IF NOT simconfig.operator_has_permission(NEW."approverActorId", 'APPROVE_PAYMENT') THEN
    PERFORM simconfig.raise_error('FORBIDDEN', format('%s may not approve payments', NEW."approverActorId"));
  END IF;
  SELECT * INTO cmd FROM paysim."InboundCommand" WHERE id = NEW."commandId";
  IF cmd."commandType" <> 'APPROVE_PAYMENT' OR cmd.outcome <> 'ACCEPTED' OR cmd."actorId" <> NEW."approverActorId" THEN
    PERFORM simconfig.raise_error('CAUSE_MISMATCH', 'approval must come from the approver''s accepted APPROVE_PAYMENT command');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a00_run_gate BEFORE INSERT ON paysim."Approval" FOR EACH ROW EXECUTE FUNCTION simconfig.trg_run_gate('active');
CREATE TRIGGER approval_insert BEFORE INSERT ON paysim."Approval" FOR EACH ROW EXECUTE FUNCTION paysim.trg_approval_insert();
CREATE TRIGGER insert_only BEFORE UPDATE OR DELETE ON paysim."Approval" FOR EACH ROW EXECUTE FUNCTION simconfig.trg_insert_only();

-- 5.9 PaymentAttempt: built from the approval; D15 guard; §5.2 matrix; poll claims (§5.8)
CREATE OR REPLACE FUNCTION paysim.trg_attempt_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE a paysim."Approval"; expected int; lim int;
BEGIN
  IF NEW.status <> 'PENDING' OR NEW."pollGeneration" <> 0 OR NEW."pollClaimToken" IS NOT NULL THEN
    PERFORM simconfig.raise_error('ILLEGAL_TRANSITION', 'an attempt starts PENDING with no poll claim');
  END IF;
  SELECT * INTO a FROM paysim."Approval" WHERE id = NEW."approvalId";
  IF a."paymentId" <> NEW."paymentId" OR a."snapshotId" <> NEW."snapshotId"
     OR a."amountMinor" <> NEW."amountMinor" OR a.currency <> NEW.currency THEN
    PERFORM simconfig.raise_error('APPROVAL_MISMATCH', 'an attempt must be built from its payment''s approval (snapshot, amount, currency)');
  END IF;
  SELECT coalesce(max("attemptNumber"), 0) + 1 INTO expected FROM paysim."PaymentAttempt" WHERE "paymentId" = NEW."paymentId";
  IF NEW."attemptNumber" <> expected THEN
    PERFORM simconfig.raise_error('SEQUENCE_GAP', format('attempt number must be %s', expected));
  END IF;
  SELECT "attemptRetryLimit" INTO lim FROM paysim."SimulatedBank"
   WHERE "simulationRunId" = NEW."simulationRunId" AND "providerCode" = NEW."providerCode";
  IF NEW."attemptNumber" > lim THEN
    PERFORM simconfig.raise_error('RETRY_LIMIT', format('attempt %s exceeds the limit %s', NEW."attemptNumber", lim));
  END IF;
  IF EXISTS (SELECT 1 FROM paysim."Anomaly" WHERE "paymentId" = NEW."paymentId" AND severity = 'CRITICAL' AND status = 'OPEN') THEN
    PERFORM simconfig.raise_error('OPEN_CRITICAL_ANOMALY', 'dispatch is blocked while a critical anomaly is open (D15)');
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION paysim.trg_attempt_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('SUCCEEDED', 'FAILED_RETRYABLE', 'FAILED_PERMANENT') THEN
    PERFORM simconfig.raise_error('ILLEGAL_TRANSITION', format('attempt %s is resolved (%s) and final', OLD.id, OLD.status));
  END IF;
  IF NEW.status <> OLD.status AND NOT paysim.attempt_transition_allowed(OLD.status, NEW.status) THEN
    PERFORM simconfig.raise_error('ILLEGAL_TRANSITION', format('attempt %s -> %s', OLD.status, NEW.status));
  END IF;
  -- Poll claims (§5.8, I23)
  IF NEW."pollClaimToken" IS NOT NULL AND NEW."pollClaimToken" IS DISTINCT FROM OLD."pollClaimToken" THEN
    IF OLD."pollClaimToken" IS NOT NULL AND OLD."pollLeaseExpiresAt" > now() THEN
      PERFORM simconfig.raise_error('CLAIM_HELD', 'a live poll claim exists');
    END IF;
    IF NEW."pollGeneration" <> OLD."pollGeneration" + 1 OR OLD.status NOT IN ('SUBMITTED', 'UNKNOWN') THEN
      PERFORM simconfig.raise_error('CLAIM_INVALID', 'a poll claim increments pollGeneration on a SUBMITTED or UNKNOWN attempt');
    END IF;
  ELSIF NEW."pollGeneration" <> OLD."pollGeneration" THEN
    PERFORM simconfig.raise_error('CLAIM_INVALID', 'pollGeneration changes only when a new poll claim is taken');
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER a00_run_gate BEFORE INSERT OR UPDATE ON paysim."PaymentAttempt" FOR EACH ROW EXECUTE FUNCTION simconfig.trg_run_gate('active');
CREATE TRIGGER attempt_insert BEFORE INSERT ON paysim."PaymentAttempt" FOR EACH ROW EXECUTE FUNCTION paysim.trg_attempt_insert();
CREATE TRIGGER controlled BEFORE UPDATE OR DELETE ON paysim."PaymentAttempt" FOR EACH ROW
  EXECUTE FUNCTION simconfig.trg_controlled_update('status', 'nextStatusQueryAt', 'statusQueryCount', 'earliestQualifyingQueryAt',
                                                   'escalateAt', 'escalatedAt', 'pollClaimToken', 'pollLeaseExpiresAt',
                                                   'pollGeneration', 'updatedAt');
CREATE TRIGGER attempt_update BEFORE UPDATE ON paysim."PaymentAttempt" FOR EACH ROW EXECUTE FUNCTION paysim.trg_attempt_update();

-- 5.10 AttemptStatusChange
CREATE OR REPLACE FUNCTION paysim.trg_attempt_change_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE prev paysim."AttemptStatusChange"; att paysim."PaymentAttempt"; cmd paysim."InboundCommand";
        req_attempt uuid; ev paysim."ProviderEvent";
BEGIN
  SELECT * INTO prev FROM paysim."AttemptStatusChange" WHERE "attemptId" = NEW."attemptId" ORDER BY "sequenceNo" DESC LIMIT 1;
  IF NEW."sequenceNo" <> coalesce(prev."sequenceNo", 0) + 1 THEN
    PERFORM simconfig.raise_error('SEQUENCE_GAP', 'attempt status changes are gap-free');
  END IF;
  IF NEW."fromStatus" IS DISTINCT FROM prev."toStatus" THEN
    PERFORM simconfig.raise_error('ILLEGAL_TRANSITION', 'fromStatus must equal the previous change''s toStatus');
  END IF;
  IF NOT paysim.attempt_transition_allowed(NEW."fromStatus", NEW."toStatus") THEN
    PERFORM simconfig.raise_error('ILLEGAL_TRANSITION', format('attempt %s -> %s', coalesce(NEW."fromStatus"::text, '∅'), NEW."toStatus"));
  END IF;
  SELECT * INTO att FROM paysim."PaymentAttempt" WHERE id = NEW."attemptId";
  IF NEW."causeType" = 'INBOUND_COMMAND' THEN
    SELECT * INTO cmd FROM paysim."InboundCommand" WHERE id = NEW."causeCommandId";
    IF cmd."commandType" <> 'RESOLVE_ATTEMPT' OR cmd.outcome <> 'ACCEPTED' OR cmd."actorId" <> NEW."actorId" THEN
      PERFORM simconfig.raise_error('CAUSE_MISMATCH', 'manual attempt changes need an accepted RESOLVE_ATTEMPT command by the actor');
    END IF;
    IF NOT simconfig.operator_has_permission(NEW."actorId", 'RESOLVE_ATTEMPT') THEN
      PERFORM simconfig.raise_error('FORBIDDEN', format('%s may not resolve attempts', NEW."actorId"));
    END IF;
    IF NEW."toStatus" NOT IN ('SUCCEEDED', 'FAILED_PERMANENT') THEN
      PERFORM simconfig.raise_error('ILLEGAL_TRANSITION', 'manual resolution may only set SUCCEEDED or FAILED_PERMANENT (R8)');
    END IF;
  ELSIF NEW."causeType" = 'BANK_RESPONSE' THEN
    SELECT q."subjectAttemptId" INTO req_attempt FROM paysim."BankInteractionResponse" r
      JOIN paysim."BankInteractionRequest" q ON q.id = r."requestId" WHERE r.id = NEW."causeBankResponseId";
    IF req_attempt IS DISTINCT FROM NEW."attemptId" THEN
      PERFORM simconfig.raise_error('CAUSE_MISMATCH', 'the cited bank response is not about this attempt');
    END IF;
  ELSIF NEW."causeType" = 'PROVIDER_EVENT' THEN
    SELECT * INTO ev FROM paysim."ProviderEvent" WHERE id = NEW."causeProviderEventId";
    IF ev."bankReference" <> att."bankReference" OR ev."providerCode" <> att."providerCode" THEN
      PERFORM simconfig.raise_error('CAUSE_MISMATCH', 'the cited provider event is not about this attempt');
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a00_run_gate BEFORE INSERT ON paysim."AttemptStatusChange" FOR EACH ROW EXECUTE FUNCTION simconfig.trg_run_gate('active');
CREATE TRIGGER attempt_change_insert BEFORE INSERT ON paysim."AttemptStatusChange" FOR EACH ROW EXECUTE FUNCTION paysim.trg_attempt_change_insert();
CREATE TRIGGER insert_only BEFORE UPDATE OR DELETE ON paysim."AttemptStatusChange" FOR EACH ROW EXECUTE FUNCTION simconfig.trg_insert_only();

-- 5.11 PaymentTransition: the 14 legal transitions, gap-free, from = previous to (I5)
CREATE OR REPLACE FUNCTION paysim.trg_transition_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE prev paysim."PaymentTransition"; cmd paysim."InboundCommand"; expected paysim."CommandType";
BEGIN
  SELECT * INTO prev FROM paysim."PaymentTransition" WHERE "paymentId" = NEW."paymentId" ORDER BY "sequenceNo" DESC LIMIT 1;
  IF NEW."sequenceNo" <> coalesce(prev."sequenceNo", 0) + 1 THEN
    PERFORM simconfig.raise_error('SEQUENCE_GAP', 'payment transitions are gap-free');
  END IF;
  IF NEW."fromStatus" IS DISTINCT FROM prev."toStatus" THEN
    PERFORM simconfig.raise_error('ILLEGAL_TRANSITION', 'fromStatus must equal the previous transition''s toStatus');
  END IF;
  IF NOT paysim.payment_transition_allowed(NEW."fromStatus", NEW.trigger, NEW."toStatus") THEN
    PERFORM simconfig.raise_error('ILLEGAL_TRANSITION',
      format('%s --%s--> %s is not a §4.1 transition', coalesce(NEW."fromStatus"::text, '∅'), NEW.trigger, NEW."toStatus"));
  END IF;
  IF NEW."causeType" = 'INBOUND_COMMAND' THEN
    SELECT * INTO cmd FROM paysim."InboundCommand" WHERE id = NEW."causeCommandId";
    expected := CASE NEW.trigger
      WHEN 'PAYMENT_CREATED'      THEN 'CREATE_PAYOUT'
      WHEN 'RECIPIENT_UPDATED'    THEN 'CORRECT_PAYMENT_RECIPIENT'
      WHEN 'APPROVE'              THEN 'APPROVE_PAYMENT'
      WHEN 'REJECT'               THEN 'REJECT_PAYMENT'
      WHEN 'CANCEL'               THEN 'CANCEL_PAYMENT'
      WHEN 'SETTLEMENT_CONFIRMED' THEN 'RESOLVE_ATTEMPT'
      WHEN 'PAYMENT_FAILED'       THEN 'RESOLVE_ATTEMPT'
      ELSE NULL END;
    IF expected IS NULL OR cmd."commandType" <> expected OR cmd.outcome <> 'ACCEPTED' OR cmd."actorId" <> NEW."actorId" THEN
      PERFORM simconfig.raise_error('CAUSE_MISMATCH', format('trigger %s cannot be caused by this command', NEW.trigger));
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a00_run_gate BEFORE INSERT ON paysim."PaymentTransition" FOR EACH ROW EXECUTE FUNCTION simconfig.trg_run_gate('active');
CREATE TRIGGER transition_insert BEFORE INSERT ON paysim."PaymentTransition" FOR EACH ROW EXECUTE FUNCTION paysim.trg_transition_insert();
CREATE TRIGGER insert_only BEFORE UPDATE OR DELETE ON paysim."PaymentTransition" FOR EACH ROW EXECUTE FUNCTION simconfig.trg_insert_only();

-- 5.12 Settlement: one per payment, from a SUCCEEDED attempt, exact amount (I2, I4)
CREATE OR REPLACE FUNCTION paysim.trg_settlement_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE att paysim."PaymentAttempt";
BEGIN
  SELECT * INTO att FROM paysim."PaymentAttempt" WHERE id = NEW."attemptId";
  IF att."paymentId" <> NEW."paymentId" OR att.status <> 'SUCCEEDED' THEN
    PERFORM simconfig.raise_error('SETTLEMENT_INVALID', 'a settlement needs a SUCCEEDED attempt of the same payment');
  END IF;
  IF att."amountMinor" <> NEW."amountMinor" OR att.currency <> NEW.currency THEN
    PERFORM simconfig.raise_error('AMOUNT_MISMATCH', 'settlement amount and currency must equal the attempt''s');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a00_run_gate BEFORE INSERT ON paysim."Settlement" FOR EACH ROW EXECUTE FUNCTION simconfig.trg_run_gate('active');
CREATE TRIGGER settlement_insert BEFORE INSERT ON paysim."Settlement" FOR EACH ROW EXECUTE FUNCTION paysim.trg_settlement_insert();
CREATE TRIGGER insert_only BEFORE UPDATE OR DELETE ON paysim."Settlement" FOR EACH ROW EXECUTE FUNCTION simconfig.trg_insert_only();

-- 5.13 InboundCommand: server-side authority for accepted commands (I22)
CREATE OR REPLACE FUNCTION paysim.trg_command_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE orig paysim."InboundCommand";
BEGIN
  IF NEW.outcome = 'ACCEPTED' AND NOT simconfig.operator_has_permission(NEW."actorId", simconfig.command_permission(NEW."commandType")) THEN
    PERFORM simconfig.raise_error('FORBIDDEN', format('%s is not permitted to %s', NEW."actorId", NEW."commandType"));
  END IF;
  IF NEW.outcome = 'IDEMPOTENT_REPLAY' THEN
    SELECT * INTO orig FROM paysim."InboundCommand" WHERE id = NEW."originalCommandId";
    IF orig."actorId" <> NEW."actorId" OR orig."idempotencyKey" IS DISTINCT FROM NEW."idempotencyKey"
       OR orig."requestFingerprint" <> NEW."requestFingerprint" OR orig.outcome = 'IDEMPOTENT_REPLAY' THEN
      PERFORM simconfig.raise_error('IDEMPOTENCY_MISMATCH', 'a replay must match the original actor, key and fingerprint');
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a00_run_gate BEFORE INSERT ON paysim."InboundCommand" FOR EACH ROW EXECUTE FUNCTION simconfig.trg_run_gate('active');
CREATE TRIGGER command_insert BEFORE INSERT ON paysim."InboundCommand" FOR EACH ROW EXECUTE FUNCTION paysim.trg_command_insert();
CREATE TRIGGER insert_only BEFORE UPDATE OR DELETE ON paysim."InboundCommand" FOR EACH ROW EXECUTE FUNCTION simconfig.trg_insert_only();

-- 5.14 IdempotencyRecord: must mirror its command (D28)
CREATE OR REPLACE FUNCTION paysim.trg_idempotency_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE cmd paysim."InboundCommand";
BEGIN
  SELECT * INTO cmd FROM paysim."InboundCommand" WHERE id = NEW."commandId";
  IF cmd."idempotencyKey" IS DISTINCT FROM NEW."idempotencyKey" OR cmd."actorId" <> NEW."actorId"
     OR cmd."requestFingerprint" <> NEW."requestFingerprint" OR cmd."commandType" <> NEW."commandType"
     OR cmd."apiVersion" <> NEW."apiVersion" OR cmd.outcome::text <> NEW.outcome::text
     OR cmd."rejectionCode" IS DISTINCT FROM NEW."rejectionCode" THEN
    PERFORM simconfig.raise_error('IDEMPOTENCY_MISMATCH', 'an idempotency record must mirror its command''s key, fingerprint and outcome');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a00_run_gate BEFORE INSERT ON paysim."IdempotencyRecord" FOR EACH ROW EXECUTE FUNCTION simconfig.trg_run_gate('active');
CREATE TRIGGER idempotency_insert BEFORE INSERT ON paysim."IdempotencyRecord" FOR EACH ROW EXECUTE FUNCTION paysim.trg_idempotency_insert();
CREATE TRIGGER insert_only BEFORE UPDATE OR DELETE ON paysim."IdempotencyRecord" FOR EACH ROW EXECUTE FUNCTION simconfig.trg_insert_only();

-- 5.15 ProviderEvent: processing claims, leases, fencing, exhaustion, requeue (§8.5, I18)
CREATE OR REPLACE FUNCTION paysim.trg_event_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."processingStatus" <> 'RECEIVED' OR NEW."attemptCount" <> 0 OR NEW."claimToken" IS NOT NULL
     OR NEW."requeueGeneration" <> 0 OR NEW.outcome IS NOT NULL THEN
    PERFORM simconfig.raise_error('EVENT_INVALID', 'a provider event is created RECEIVED, unclaimed, with no outcome');
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION paysim.trg_event_update() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE lim int; o text := OLD."processingStatus"::text; n text := NEW."processingStatus"::text;
BEGIN
  SELECT "eventRetryLimit" INTO lim FROM paysim."SimulationRun" WHERE id = NEW."simulationRunId";
  IF o = 'PROCESSED' THEN
    PERFORM simconfig.raise_error('EVENT_FINAL', 'a PROCESSED event is final');
  END IF;
  IF NEW.outcome IS NOT NULL AND n <> 'PROCESSED' THEN
    PERFORM simconfig.raise_error('EVENT_INVALID', 'an outcome is written only when finalising to PROCESSED');
  END IF;

  IF n = 'PROCESSING' AND (o <> 'PROCESSING' OR NEW."claimToken" IS DISTINCT FROM OLD."claimToken") THEN
    -- A claim (or a reclaim after lease expiry).
    IF NOT (o = 'RECEIVED'
         OR (o = 'PROCESSING_ERROR' AND (OLD."nextAttemptAt" IS NULL OR OLD."nextAttemptAt" <= now()))
         OR (o = 'PROCESSING' AND OLD."leaseExpiresAt" <= now())) THEN
      PERFORM simconfig.raise_error('CLAIM_HELD', format('event is %s and not claimable', o));
    END IF;
    IF NEW."attemptCount" <> OLD."attemptCount" + 1 OR NEW."attemptCount" > lim THEN
      PERFORM simconfig.raise_error('CLAIM_INVALID', format('a claim increments attemptCount by 1 up to %s', lim));
    END IF;
    IF NEW."claimToken" IS NULL OR NEW."claimToken" IS NOT DISTINCT FROM OLD."claimToken" OR NEW."leaseExpiresAt" <= now() THEN
      PERFORM simconfig.raise_error('CLAIM_INVALID', 'a claim needs a fresh token and a future lease');
    END IF;
    RETURN NEW;
  END IF;

  IF o = 'PROCESSING' AND n IN ('PROCESSED', 'PROCESSING_ERROR') THEN
    IF NEW."claimToken" IS DISTINCT FROM OLD."claimToken" OR NEW."attemptCount" <> OLD."attemptCount" THEN
      PERFORM simconfig.raise_error('FENCED', 'finalisation must keep the claim token and attempt count');
    END IF;
    IF n = 'PROCESSING_ERROR' AND (OLD."attemptCount" >= lim OR NEW."nextAttemptAt" IS NULL) THEN
      PERFORM simconfig.raise_error('CLAIM_INVALID', 'PROCESSING_ERROR needs remaining attempts and a nextAttemptAt');
    END IF;
    RETURN NEW;
  END IF;

  IF o = 'PROCESSING' AND n = 'PROCESSING_EXHAUSTED' THEN
    IF NEW."attemptCount" <> OLD."attemptCount" OR OLD."attemptCount" < lim THEN
      PERFORM simconfig.raise_error('CLAIM_INVALID', 'exhaustion requires the attempt limit to be reached');
    END IF;
    IF NEW."claimToken" IS DISTINCT FROM OLD."claimToken" AND OLD."leaseExpiresAt" > now() THEN
      PERFORM simconfig.raise_error('FENCED', 'only the claim holder, or the sweeper after lease expiry, may exhaust');
    END IF;
    RETURN NEW;
  END IF;

  IF o = 'PROCESSING_EXHAUSTED' AND n = 'RECEIVED' THEN
    IF NEW."attemptCount" <> 0 OR NEW."requeueGeneration" <> OLD."requeueGeneration" + 1
       OR NEW."claimToken" IS NOT NULL OR NEW."leaseExpiresAt" IS NOT NULL THEN
      PERFORM simconfig.raise_error('CLAIM_INVALID', 'a requeue resets attemptCount, clears the claim and increments requeueGeneration');
    END IF;
    RETURN NEW;
  END IF;

  IF n = o THEN
    -- Same-status updates (e.g. recording the resolved attempt while PROCESSING) must not touch the claim.
    IF NEW."claimToken" IS DISTINCT FROM OLD."claimToken" OR NEW."attemptCount" <> OLD."attemptCount"
       OR NEW."requeueGeneration" <> OLD."requeueGeneration" THEN
      PERFORM simconfig.raise_error('FENCED', 'claim fields change only through claim, finalise or requeue');
    END IF;
    RETURN NEW;
  END IF;

  PERFORM simconfig.raise_error('ILLEGAL_TRANSITION', format('event %s -> %s', o, n));
  RETURN NULL;
END $$;

CREATE TRIGGER a00_run_gate BEFORE INSERT OR UPDATE ON paysim."ProviderEvent" FOR EACH ROW EXECUTE FUNCTION simconfig.trg_run_gate('active');
CREATE TRIGGER event_insert BEFORE INSERT ON paysim."ProviderEvent" FOR EACH ROW EXECUTE FUNCTION paysim.trg_event_insert();
CREATE TRIGGER controlled BEFORE UPDATE OR DELETE ON paysim."ProviderEvent" FOR EACH ROW
  EXECUTE FUNCTION simconfig.trg_controlled_update('processingStatus', 'attemptCount', 'claimToken', 'leaseOwner', 'leaseExpiresAt',
                                                   'nextAttemptAt', 'lastError', 'requeueGeneration', 'outcome', 'outcomeReason',
                                                   'processedAt', 'resolvedAttemptId', 'resolvedPaymentId');
CREATE TRIGGER event_update BEFORE UPDATE ON paysim."ProviderEvent" FOR EACH ROW EXECUTE FUNCTION paysim.trg_event_update();

-- 5.16 WebhookDelivery and EventProcessingAttempt
CREATE OR REPLACE FUNCTION paysim.trg_delivery_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE ev_provider text;
BEGIN
  IF NEW."providerEventRecordId" IS NOT NULL THEN
    SELECT "providerCode" INTO ev_provider FROM paysim."ProviderEvent" WHERE id = NEW."providerEventRecordId";
    IF ev_provider <> NEW."providerCode" THEN
      PERFORM simconfig.raise_error('CAUSE_MISMATCH', 'a delivery links only to an event of the same provider');
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a00_run_gate BEFORE INSERT ON paysim."WebhookDelivery" FOR EACH ROW EXECUTE FUNCTION simconfig.trg_run_gate('active');
CREATE TRIGGER delivery_insert BEFORE INSERT ON paysim."WebhookDelivery" FOR EACH ROW EXECUTE FUNCTION paysim.trg_delivery_insert();
CREATE TRIGGER insert_only BEFORE UPDATE OR DELETE ON paysim."WebhookDelivery" FOR EACH ROW EXECUTE FUNCTION simconfig.trg_insert_only();

CREATE OR REPLACE FUNCTION paysim.trg_processing_attempt_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE cur uuid;
BEGIN
  IF NEW.result IN ('COMPLETED', 'TECHNICAL_ERROR') THEN
    SELECT "claimToken" INTO cur FROM paysim."ProviderEvent" WHERE id = NEW."providerEventRecordId";
    IF cur IS DISTINCT FROM NEW."claimToken" THEN
      PERFORM simconfig.raise_error('FENCED', 'only the current claim holder can log a completed or failed attempt');
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a00_run_gate BEFORE INSERT ON paysim."EventProcessingAttempt" FOR EACH ROW EXECUTE FUNCTION simconfig.trg_run_gate('active');
CREATE TRIGGER processing_attempt_insert BEFORE INSERT ON paysim."EventProcessingAttempt" FOR EACH ROW EXECUTE FUNCTION paysim.trg_processing_attempt_insert();
CREATE TRIGGER insert_only BEFORE UPDATE OR DELETE ON paysim."EventProcessingAttempt" FOR EACH ROW EXECUTE FUNCTION simconfig.trg_insert_only();

-- 5.17 Bank interactions: gap-free occurrences, subject keys, poll fencing (DM7, I23)
CREATE OR REPLACE FUNCTION paysim.trg_bank_request_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE expected int; att paysim."PaymentAttempt"; key text;
BEGIN
  SELECT coalesce(max("occurrenceNo"), 0) + 1 INTO expected FROM paysim."BankInteractionRequest"
   WHERE "simulationRunId" = NEW."simulationRunId" AND "providerCode" = NEW."providerCode"
     AND "interactionType" = NEW."interactionType" AND "readableKey" = NEW."readableKey";
  IF NEW."occurrenceNo" <> expected THEN
    PERFORM simconfig.raise_error('SEQUENCE_GAP', format('occurrence number must be %s', expected));
  END IF;
  IF NEW."subjectType" = 'SNAPSHOT' THEN
    SELECT p.reference || '#S' || s."snapshotNo" INTO key FROM paysim."RecipientSnapshot" s
      JOIN paysim."Payment" p ON p.id = s."paymentId" WHERE s.id = NEW."subjectSnapshotId";
    IF key IS DISTINCT FROM NEW."readableKey" THEN
      PERFORM simconfig.raise_error('KEY_MISMATCH', format('VERIFY_ACCOUNT key must be %s', key));
    END IF;
  ELSE
    SELECT * INTO att FROM paysim."PaymentAttempt" WHERE id = NEW."subjectAttemptId";
    IF att."bankReference" <> NEW."readableKey" OR att."providerCode" <> NEW."providerCode" THEN
      PERFORM simconfig.raise_error('KEY_MISMATCH', 'attempt requests are keyed by the attempt''s bank reference and provider');
    END IF;
    IF NEW."interactionType" = 'DISPATCH' AND att.status <> 'PENDING' THEN
      PERFORM simconfig.raise_error('ILLEGAL_TRANSITION', 'DISPATCH is recorded only for a PENDING attempt');
    END IF;
    IF NEW."interactionType" = 'STATUS_QUERY'
       AND (att."pollClaimToken" IS NULL OR att."pollGeneration" <> NEW."pollGeneration") THEN
      PERFORM simconfig.raise_error('FENCED', 'a status query needs the current poll claim and generation');
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a00_run_gate BEFORE INSERT ON paysim."BankInteractionRequest" FOR EACH ROW EXECUTE FUNCTION simconfig.trg_run_gate('active');
CREATE TRIGGER bank_request_insert BEFORE INSERT ON paysim."BankInteractionRequest" FOR EACH ROW EXECUTE FUNCTION paysim.trg_bank_request_insert();
CREATE TRIGGER insert_only BEFORE UPDATE OR DELETE ON paysim."BankInteractionRequest" FOR EACH ROW EXECUTE FUNCTION simconfig.trg_insert_only();

CREATE TRIGGER a00_run_gate BEFORE INSERT ON paysim."BankInteractionResponse" FOR EACH ROW EXECUTE FUNCTION simconfig.trg_run_gate('active');
CREATE TRIGGER insert_only BEFORE UPDATE OR DELETE ON paysim."BankInteractionResponse" FOR EACH ROW EXECUTE FUNCTION simconfig.trg_insert_only();

-- 5.18 Anomaly, AnomalyEvidence, AnomalyAction (I16, D15, D23, D25)
CREATE OR REPLACE FUNCTION paysim.trg_anomaly_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'OPEN' OR NEW."lastActionSequenceNo" <> 0 THEN
    PERFORM simconfig.raise_error('ANOMALY_INVALID', 'an anomaly is created OPEN with no actions yet');
  END IF;
  IF NEW."createdTxId" <> (pg_current_xact_id())::text::bigint THEN
    PERFORM simconfig.raise_error('ANOMALY_INVALID', 'createdTxId must be the creating transaction');
  END IF;
  IF NEW.severity = 'CRITICAL' AND NEW."paymentId" IS NOT NULL THEN
    -- D23: serialise with dispatch on the payment row.
    PERFORM 1 FROM paysim."Payment" WHERE id = NEW."paymentId" FOR NO KEY UPDATE;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a00_run_gate BEFORE INSERT OR UPDATE ON paysim."Anomaly" FOR EACH ROW EXECUTE FUNCTION simconfig.trg_run_gate('active');
CREATE TRIGGER anomaly_insert BEFORE INSERT ON paysim."Anomaly" FOR EACH ROW EXECUTE FUNCTION paysim.trg_anomaly_insert();
CREATE TRIGGER controlled BEFORE UPDATE OR DELETE ON paysim."Anomaly" FOR EACH ROW
  EXECUTE FUNCTION simconfig.trg_controlled_update('status', 'lastActionSequenceNo');

CREATE OR REPLACE FUNCTION paysim.trg_evidence_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE tx bigint;
BEGIN
  SELECT "createdTxId" INTO tx FROM paysim."Anomaly" WHERE id = NEW."anomalyId";
  IF tx IS DISTINCT FROM (pg_current_xact_id())::text::bigint THEN
    PERFORM simconfig.raise_error('EVIDENCE_FROZEN', 'evidence can only be added in the transaction that opened the anomaly');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a00_run_gate BEFORE INSERT ON paysim."AnomalyEvidence" FOR EACH ROW EXECUTE FUNCTION simconfig.trg_run_gate('active');
CREATE TRIGGER evidence_insert BEFORE INSERT ON paysim."AnomalyEvidence" FOR EACH ROW EXECUTE FUNCTION paysim.trg_evidence_insert();
CREATE TRIGGER insert_only BEFORE UPDATE OR DELETE ON paysim."AnomalyEvidence" FOR EACH ROW EXECUTE FUNCTION simconfig.trg_insert_only();

CREATE OR REPLACE FUNCTION paysim.trg_action_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE an paysim."Anomaly"; prev_seq int; cur_state text; cmd paysim."InboundCommand"; needed simconfig."OperatorAction";
BEGIN
  SELECT * INTO an FROM paysim."Anomaly" WHERE id = NEW."anomalyId";
  SELECT coalesce(max("sequenceNo"), 0) INTO prev_seq FROM paysim."AnomalyAction" WHERE "anomalyId" = NEW."anomalyId";
  IF NEW."sequenceNo" <> prev_seq + 1 THEN
    PERFORM simconfig.raise_error('SEQUENCE_GAP', 'anomaly actions are gap-free');
  END IF;
  SELECT CASE "actionType" WHEN 'RESOLVED' THEN 'RESOLVED' ELSE 'OPEN' END INTO cur_state
    FROM paysim."AnomalyAction" WHERE "anomalyId" = NEW."anomalyId" AND "actionType" <> 'NOTE_ADDED'
    ORDER BY "sequenceNo" DESC LIMIT 1;

  IF (NEW."sequenceNo" = 1) <> (NEW."actionType" = 'OPENED') THEN
    PERFORM simconfig.raise_error('ILLEGAL_TRANSITION', 'OPENED is always, and only, the first action');
  END IF;
  IF NEW."actionType" = 'OPENED' AND NEW."actorType" = 'USER' THEN
    PERFORM simconfig.raise_error('ILLEGAL_TRANSITION', 'anomalies are opened by detectors, not users');
  END IF;
  IF NEW."actionType" = 'RESOLVED' AND cur_state IS DISTINCT FROM 'OPEN' THEN
    PERFORM simconfig.raise_error('INVALID_TRANSITION', 'only an open anomaly can be resolved');
  END IF;
  IF NEW."actionType" = 'REOPENED' AND cur_state IS DISTINCT FROM 'RESOLVED' THEN
    PERFORM simconfig.raise_error('INVALID_TRANSITION', 'only a resolved anomaly can be reopened');
  END IF;

  -- D25: critical anomalies are only ever resolved by an authorised person.
  IF NEW."actionType" = 'RESOLVED' AND NEW."actorType" <> 'USER' THEN
    IF an.severity = 'CRITICAL' THEN
      PERFORM simconfig.raise_error('HUMAN_RESOLUTION_REQUIRED', 'critical anomalies cannot be resolved by the system');
    END IF;
    IF NEW."resolutionType" <> 'CONDITION_CLEARED' OR NEW."causeType" NOT IN ('ATTEMPT_STATUS_CHANGE', 'PROCESSING_ATTEMPT') THEN
      PERFORM simconfig.raise_error('ILLEGAL_TRANSITION', 'system resolution must be CONDITION_CLEARED with cited evidence');
    END IF;
  END IF;
  IF NEW."resolutionType" = 'CONDITION_CLEARED' AND NEW."actorType" = 'USER' THEN
    PERFORM simconfig.raise_error('ILLEGAL_TRANSITION', 'CONDITION_CLEARED is a system-only resolution');
  END IF;
  IF NEW."actionType" = 'REOPENED' AND NEW."actorType" <> 'USER' THEN
    PERFORM simconfig.raise_error('ILLEGAL_TRANSITION', 'the system never reopens anomalies');
  END IF;

  IF NEW."actorType" = 'USER' THEN
    needed := CASE NEW."actionType"
      WHEN 'RESOLVED'   THEN CASE an.severity WHEN 'CRITICAL' THEN 'RESOLVE_CRITICAL_ANOMALY' ELSE 'RESOLVE_ANOMALY' END
      WHEN 'REOPENED'   THEN 'REOPEN_ANOMALY'
      WHEN 'NOTE_ADDED' THEN 'ADD_ANOMALY_NOTE'
    END::simconfig."OperatorAction";
    IF NOT simconfig.operator_has_permission(NEW."actorId", needed) THEN
      PERFORM simconfig.raise_error('FORBIDDEN', format('%s lacks %s', NEW."actorId", needed));
    END IF;
    SELECT * INTO cmd FROM paysim."InboundCommand" WHERE id = NEW."causeCommandId";
    IF cmd.outcome <> 'ACCEPTED' OR cmd."actorId" <> NEW."actorId" OR cmd."commandType" <> (CASE NEW."actionType"
         WHEN 'RESOLVED' THEN 'RESOLVE_ANOMALY' WHEN 'REOPENED' THEN 'REOPEN_ANOMALY' ELSE 'ADD_ANOMALY_NOTE' END)::paysim."CommandType" THEN
      PERFORM simconfig.raise_error('CAUSE_MISMATCH', 'a human anomaly action must cite the actor''s matching accepted command');
    END IF;
  END IF;

  IF NEW."actionType" = 'REOPENED' AND an.severity = 'CRITICAL' AND an."paymentId" IS NOT NULL THEN
    PERFORM 1 FROM paysim."Payment" WHERE id = an."paymentId" FOR NO KEY UPDATE;  -- D23
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a00_run_gate BEFORE INSERT ON paysim."AnomalyAction" FOR EACH ROW EXECUTE FUNCTION simconfig.trg_run_gate('active');
CREATE TRIGGER action_insert BEFORE INSERT ON paysim."AnomalyAction" FOR EACH ROW EXECUTE FUNCTION paysim.trg_action_insert();
CREATE TRIGGER insert_only BEFORE UPDATE OR DELETE ON paysim."AnomalyAction" FOR EACH ROW EXECUTE FUNCTION simconfig.trg_insert_only();

-- 5.19 ReplayDivergence: marks the replay run DIVERGED
CREATE OR REPLACE FUNCTION paysim.trg_divergence_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE paysim."SimulationRun" SET diverged = true WHERE id = NEW."simulationRunId" AND NOT diverged;
  RETURN NEW;
END $$;
CREATE TRIGGER a00_run_gate BEFORE INSERT ON paysim."ReplayDivergence" FOR EACH ROW EXECUTE FUNCTION simconfig.trg_run_gate('active');
CREATE TRIGGER divergence_insert AFTER INSERT ON paysim."ReplayDivergence" FOR EACH ROW EXECUTE FUNCTION paysim.trg_divergence_insert();
CREATE TRIGGER insert_only BEFORE UPDATE OR DELETE ON paysim."ReplayDivergence" FOR EACH ROW EXECUTE FUNCTION simconfig.trg_insert_only();

-- 5.20 Simulated bank (simbank)
CREATE OR REPLACE FUNCTION simconfig.assert_bank_profile_matches(run uuid, provider text, window_ms int, ttl_ms int,
                                                               secret text, ingress_key text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE b paysim."SimulatedBank";
BEGIN
  SELECT * INTO b FROM paysim."SimulatedBank" WHERE "simulationRunId" = run AND "providerCode" = provider;
  IF b.id IS NULL OR b."settlementWindowMs" <> window_ms OR b."acceptanceTtlMs" <> ttl_ms
     OR b."signingSecret" <> secret OR b."ingressKeyHash" <> encode(sha256(convert_to(ingress_key, 'UTF8')), 'hex') THEN
    PERFORM simconfig.raise_error('CONFIG_MISMATCH', 'the bank profile must match the run''s simulated bank configuration');
  END IF;
END $$;

CREATE OR REPLACE FUNCTION simbank.trg_profile_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM simconfig.assert_bank_profile_matches(NEW."simulationRunId", NEW."providerCode", NEW."settlementWindowMs",
                                                NEW."acceptanceTtlMs", NEW."signingSecret", NEW."webhookIngressKey");
  RETURN NEW;
END $$;
CREATE TRIGGER a00_run_gate BEFORE INSERT ON simbank."BankRunProfile" FOR EACH ROW EXECUTE FUNCTION simconfig.trg_run_gate('config');
CREATE TRIGGER profile_insert BEFORE INSERT ON simbank."BankRunProfile" FOR EACH ROW EXECUTE FUNCTION simbank.trg_profile_insert();
CREATE TRIGGER insert_only BEFORE UPDATE OR DELETE ON simbank."BankRunProfile" FOR EACH ROW EXECUTE FUNCTION simconfig.trg_insert_only();

CREATE TRIGGER a00_run_gate BEFORE INSERT ON simbank."SimulatedBankAccount" FOR EACH ROW EXECUTE FUNCTION simconfig.trg_run_gate('seed');
CREATE TRIGGER insert_only BEFORE UPDATE OR DELETE ON simbank."SimulatedBankAccount" FOR EACH ROW EXECUTE FUNCTION simconfig.trg_insert_only();

CREATE OR REPLACE FUNCTION simbank.trg_instruction_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE w int;
BEGIN
  SELECT "settlementWindowMs" INTO w FROM simbank."BankRunProfile"
   WHERE "simulationRunId" = NEW."simulationRunId" AND "providerCode" = NEW."providerCode";
  IF NEW."settlementWindowMs" <> w THEN
    PERFORM simconfig.raise_error('CONFIG_MISMATCH', 'the instruction must carry the bank''s settlement window');
  END IF;
  IF NEW.status NOT IN ('RECEIVED', 'REFUSED_LATE') THEN
    PERFORM simconfig.raise_error('ILLEGAL_TRANSITION', 'an instruction is recorded as RECEIVED or REFUSED_LATE');
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION simbank.trg_instruction_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'RECEIVED'   AND NEW.status IN ('PROCESSING', 'SETTLED', 'FAILED'))
    OR (OLD.status = 'PROCESSING' AND NEW.status IN ('SETTLED', 'FAILED'))) THEN
    PERFORM simconfig.raise_error('ILLEGAL_TRANSITION', format('instruction %s -> %s', OLD.status, NEW.status));
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a00_run_gate BEFORE INSERT OR UPDATE ON simbank."BankInstruction" FOR EACH ROW EXECUTE FUNCTION simconfig.trg_run_gate('active');
CREATE TRIGGER instruction_insert BEFORE INSERT ON simbank."BankInstruction" FOR EACH ROW EXECUTE FUNCTION simbank.trg_instruction_insert();
CREATE TRIGGER controlled BEFORE UPDATE OR DELETE ON simbank."BankInstruction" FOR EACH ROW
  EXECUTE FUNCTION simconfig.trg_controlled_update('status', 'failureCode', 'updatedAt');
CREATE TRIGGER instruction_update BEFORE UPDATE ON simbank."BankInstruction" FOR EACH ROW EXECUTE FUNCTION simbank.trg_instruction_update();

CREATE OR REPLACE FUNCTION simbank.trg_dispatch_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD."sentAt" IS NOT NULL AND NEW."sentAt" IS DISTINCT FROM OLD."sentAt")
     OR (OLD."httpStatus" IS NOT NULL AND NEW."httpStatus" IS DISTINCT FROM OLD."httpStatus") THEN
    PERFORM simconfig.raise_error('IMMUTABLE_COLUMN', 'sentAt and httpStatus are set once');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a00_run_gate BEFORE INSERT OR UPDATE ON simbank."BankWebhookDispatch" FOR EACH ROW EXECUTE FUNCTION simconfig.trg_run_gate('active');
CREATE TRIGGER controlled BEFORE UPDATE OR DELETE ON simbank."BankWebhookDispatch" FOR EACH ROW
  EXECUTE FUNCTION simconfig.trg_controlled_update('sentAt', 'httpStatus');
CREATE TRIGGER dispatch_update BEFORE UPDATE ON simbank."BankWebhookDispatch" FOR EACH ROW EXECUTE FUNCTION simbank.trg_dispatch_update();

-- ═════════════════════════════════════════════════════════════════════════════
-- 6. Deferred (commit-time) consistency checks
-- ═════════════════════════════════════════════════════════════════════════════

-- I5: payment status equals its latest transition; a current snapshot exists.
CREATE OR REPLACE FUNCTION paysim.check_payment_consistent(pid uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE p paysim."Payment"; latest paysim."PaymentStatus";
BEGIN
  SELECT * INTO p FROM paysim."Payment" WHERE id = pid;
  IF p.id IS NULL THEN RETURN; END IF;
  IF p."currentSnapshotId" IS NULL THEN
    PERFORM simconfig.raise_error('PAYMENT_INCONSISTENT', format('payment %s has no current snapshot at commit', pid));
  END IF;
  SELECT "toStatus" INTO latest FROM paysim."PaymentTransition" WHERE "paymentId" = pid ORDER BY "sequenceNo" DESC LIMIT 1;
  IF latest IS DISTINCT FROM p.status THEN
    PERFORM simconfig.raise_error('PAYMENT_INCONSISTENT',
      format('payment %s status %s does not match its latest transition (%s)', pid, p.status, coalesce(latest::text, 'none')));
  END IF;
END $$;
CREATE OR REPLACE FUNCTION paysim.trg_check_payment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- IF/ELSE, not CASE: PL/pgSQL resolves every record field referenced in an expression.
  IF TG_TABLE_NAME = 'Payment' THEN
    PERFORM paysim.check_payment_consistent(NEW.id);
  ELSE
    PERFORM paysim.check_payment_consistent(NEW."paymentId");
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER payment_consistent AFTER INSERT OR UPDATE ON paysim."Payment"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION paysim.trg_check_payment();
CREATE CONSTRAINT TRIGGER payment_consistent AFTER INSERT ON paysim."PaymentTransition"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION paysim.trg_check_payment();

-- Attempt status equals its latest status change.
CREATE OR REPLACE FUNCTION paysim.check_attempt_consistent(aid uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE st paysim."AttemptStatus"; latest paysim."AttemptStatus";
BEGIN
  SELECT status INTO st FROM paysim."PaymentAttempt" WHERE id = aid;
  IF st IS NULL THEN RETURN; END IF;
  SELECT "toStatus" INTO latest FROM paysim."AttemptStatusChange" WHERE "attemptId" = aid ORDER BY "sequenceNo" DESC LIMIT 1;
  IF latest IS DISTINCT FROM st THEN
    PERFORM simconfig.raise_error('ATTEMPT_INCONSISTENT',
      format('attempt %s status %s does not match its latest status change (%s)', aid, st, coalesce(latest::text, 'none')));
  END IF;
END $$;
CREATE OR REPLACE FUNCTION paysim.trg_check_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- IF/ELSE, not CASE: PL/pgSQL resolves every record field referenced in an expression.
  IF TG_TABLE_NAME = 'PaymentAttempt' THEN
    PERFORM paysim.check_attempt_consistent(NEW.id);
  ELSE
    PERFORM paysim.check_attempt_consistent(NEW."attemptId");
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER attempt_consistent AFTER INSERT OR UPDATE ON paysim."PaymentAttempt"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION paysim.trg_check_attempt();
CREATE CONSTRAINT TRIGGER attempt_consistent AFTER INSERT ON paysim."AttemptStatusChange"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION paysim.trg_check_attempt();

-- L4: anomaly status and lastActionSequenceNo match the latest action; OPENED and evidence exist.
CREATE OR REPLACE FUNCTION paysim.check_anomaly_consistent(nid uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE an paysim."Anomaly"; max_seq int; derived text;
BEGIN
  SELECT * INTO an FROM paysim."Anomaly" WHERE id = nid;
  IF an.id IS NULL THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM paysim."AnomalyEvidence" WHERE "anomalyId" = nid) THEN
    PERFORM simconfig.raise_error('ANOMALY_INCONSISTENT', format('anomaly %s has no evidence', nid));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM paysim."AnomalyAction" WHERE "anomalyId" = nid AND "sequenceNo" = 1 AND "actionType" = 'OPENED') THEN
    PERFORM simconfig.raise_error('ANOMALY_INCONSISTENT', format('anomaly %s has no OPENED action', nid));
  END IF;
  SELECT max("sequenceNo") INTO max_seq FROM paysim."AnomalyAction" WHERE "anomalyId" = nid;
  SELECT CASE "actionType" WHEN 'RESOLVED' THEN 'RESOLVED' ELSE 'OPEN' END INTO derived
    FROM paysim."AnomalyAction" WHERE "anomalyId" = nid AND "actionType" <> 'NOTE_ADDED'
    ORDER BY "sequenceNo" DESC LIMIT 1;
  IF an."lastActionSequenceNo" <> max_seq OR an.status::text <> derived THEN
    PERFORM simconfig.raise_error('ANOMALY_INCONSISTENT',
      format('anomaly %s status/sequence (%s/%s) does not match its actions (%s/%s)', nid, an.status, an."lastActionSequenceNo", derived, max_seq));
  END IF;
END $$;
CREATE OR REPLACE FUNCTION paysim.trg_check_anomaly() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- IF/ELSE, not CASE: PL/pgSQL resolves every record field referenced in an expression.
  IF TG_TABLE_NAME = 'Anomaly' THEN
    PERFORM paysim.check_anomaly_consistent(NEW.id);
  ELSE
    PERFORM paysim.check_anomaly_consistent(NEW."anomalyId");
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER anomaly_consistent AFTER INSERT OR UPDATE ON paysim."Anomaly"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION paysim.trg_check_anomaly();
CREATE CONSTRAINT TRIGGER anomaly_consistent AFTER INSERT ON paysim."AnomalyAction"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION paysim.trg_check_anomaly();
