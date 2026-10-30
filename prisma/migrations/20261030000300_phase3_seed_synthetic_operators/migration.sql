-- PaySim Phase 3 — seeded synthetic operator allowlist (D32, correction C3).
--
-- These are SYNTHETIC development identities for a controlled simulator/demo. They are not
-- user accounts and the actor header that names them is not authentication. Authority comes
-- only from the permissions below, checked server-side and by database triggers.

INSERT INTO simconfig."SyntheticOperator" (id, "displayName") VALUES
  ('ops-01',     'Synthetic claims officer 1'),
  ('ops-07',     'Synthetic claims officer 7'),
  ('fin-02',     'Synthetic finance approver 2'),
  ('recon-01',   'Synthetic reconciliation officer 1'),
  ('support-01', 'Synthetic support analyst 1');

INSERT INTO simconfig."SyntheticOperatorPermission" ("operatorId", action) VALUES
  ('ops-01', 'CREATE_PAYOUT'), ('ops-01', 'CORRECT_PAYMENT_RECIPIENT'), ('ops-01', 'CANCEL_PAYMENT'), ('ops-01', 'MANAGE_RECIPIENTS'),
  ('ops-07', 'CREATE_PAYOUT'), ('ops-07', 'CORRECT_PAYMENT_RECIPIENT'), ('ops-07', 'CANCEL_PAYMENT'), ('ops-07', 'MANAGE_RECIPIENTS'),
  ('fin-02', 'APPROVE_PAYMENT'), ('fin-02', 'REJECT_PAYMENT'), ('fin-02', 'CANCEL_PAYMENT'),
  ('recon-01', 'RESOLVE_ANOMALY'), ('recon-01', 'RESOLVE_CRITICAL_ANOMALY'), ('recon-01', 'REOPEN_ANOMALY'),
  ('recon-01', 'ADD_ANOMALY_NOTE'), ('recon-01', 'RESOLVE_ATTEMPT'), ('recon-01', 'REQUEUE_EVENT'),
  ('support-01', 'RESOLVE_ANOMALY'), ('support-01', 'ADD_ANOMALY_NOTE');
