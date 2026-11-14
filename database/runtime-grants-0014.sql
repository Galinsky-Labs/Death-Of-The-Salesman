-- DOTS-032..043 governance control plane runtime privileges (migration 0014).
-- Apply with the migration administrator after database/runtime-grants.sql.
-- Ledger, journal, alert, decision, kill-switch audit and dead-letter evidence are
-- append-only: SELECT/INSERT only, never UPDATE or DELETE. No grant touches id or organization_id.
GRANT SELECT, INSERT ON app.budget_scopes, app.governed_reservations, app.budget_journals, app.budget_ledger_entries,
  app.budget_alerts, app.policy_decisions, app.kill_switches, app.kill_switch_audit, app.task_dead_letters,
  app.credential_references, app.retention_policies, app.evidence_holds, app.deletion_requests, app.export_jobs TO dots_runtime;
GRANT UPDATE(ceiling_cents, daily_limit_cents, alert_threshold_bps, version, updated_by_membership_id, updated_at) ON app.budget_scopes TO dots_runtime;
GRANT UPDATE(actual_cents, status, final_reason, evidence_ref, finalized_at) ON app.governed_reservations TO dots_runtime;
GRANT UPDATE(active, rationale, version, updated_by_membership_id, updated_at) ON app.kill_switches TO dots_runtime;
-- Rotation/revocation may only shred ciphertext and record lifecycle metadata; fingerprints and scope are immutable.
GRANT UPDATE(ciphertext, status, revocation_reason, version, rotated_at, revoked_at) ON app.credential_references TO dots_runtime;
GRANT UPDATE(retention_days, action, basis, version, updated_by_membership_id, updated_at) ON app.retention_policies TO dots_runtime;
GRANT UPDATE(active, released_by_membership_id, released_at, release_rationale) ON app.evidence_holds TO dots_runtime;
GRANT UPDATE(status, outcome, decided_at) ON app.deletion_requests TO dots_runtime;
GRANT UPDATE(status, row_count, artifact_hash, completed_at) ON app.export_jobs TO dots_runtime;
