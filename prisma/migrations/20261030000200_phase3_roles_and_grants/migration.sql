-- PaySim Phase 3 — runtime roles and grants (safeguard S1, database-design.md §1, §9).
--
-- paysim_app  : PaySim services. simconfig (read) + paysim. NO access to simbank.
-- simbank_app : the simulated bank. simconfig (read) + simbank. NO access to paysim tables.
--
-- Roles are created NOLOGIN here; environment setup grants LOGIN and a password
-- (see docs/testing-database.md). Passwords never appear in migrations.
-- Column-level UPDATE grants list exactly the controlled columns; insert-only tables get no
-- UPDATE at all. No role gets DELETE or TRUNCATE.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paysim_app') THEN
    CREATE ROLE paysim_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'simbank_app') THEN
    CREATE ROLE simbank_app NOLOGIN;
  END IF;
END $$;

REVOKE ALL ON SCHEMA simconfig, paysim, simbank FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA simconfig, paysim, simbank FROM PUBLIC;

-- simconfig: shared, read-only catalogue and helper functions
GRANT USAGE ON SCHEMA simconfig TO paysim_app, simbank_app;
GRANT SELECT ON ALL TABLES IN SCHEMA simconfig TO paysim_app, simbank_app;

-- paysim
GRANT USAGE ON SCHEMA paysim TO paysim_app;
GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA paysim TO paysim_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA paysim TO paysim_app;

GRANT UPDATE ("status", "diverged", "simulatedClockAt", "activatedAt", "completedAt", "abortedAt")
  ON paysim."SimulationRun" TO paysim_app;
GRANT UPDATE ("approvedForPayout") ON paysim."Claim" TO paysim_app;
GRANT UPDATE ("accountName", "updatedAt") ON paysim."Recipient" TO paysim_app;
GRANT UPDATE ("status", "version", "currentSnapshotId", "nextDispatchAt", "updatedAt") ON paysim."Payment" TO paysim_app;
GRANT UPDATE ("status", "nextStatusQueryAt", "statusQueryCount", "earliestQualifyingQueryAt", "escalateAt", "escalatedAt",
              "pollClaimToken", "pollLeaseExpiresAt", "pollGeneration", "updatedAt")
  ON paysim."PaymentAttempt" TO paysim_app;
GRANT UPDATE ("processingStatus", "attemptCount", "claimToken", "leaseOwner", "leaseExpiresAt", "nextAttemptAt", "lastError",
              "requeueGeneration", "outcome", "outcomeReason", "processedAt", "resolvedAttemptId", "resolvedPaymentId")
  ON paysim."ProviderEvent" TO paysim_app;
GRANT UPDATE ("status", "lastActionSequenceNo") ON paysim."Anomaly" TO paysim_app;

-- simbank
GRANT USAGE ON SCHEMA simbank TO simbank_app;
GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA simbank TO simbank_app;
GRANT UPDATE ("status", "failureCode", "updatedAt") ON simbank."BankInstruction" TO simbank_app;
GRANT UPDATE ("sentAt", "httpStatus") ON simbank."BankWebhookDispatch" TO simbank_app;

-- Per-year payment reference sequences are created on demand by a SECURITY DEFINER function.
REVOKE ALL ON FUNCTION paysim.next_payment_reference(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION paysim.next_payment_reference(integer) TO paysim_app;
