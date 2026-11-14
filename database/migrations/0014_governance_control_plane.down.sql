DROP TABLE app.export_jobs;
DROP TABLE app.deletion_requests;
DROP TABLE app.evidence_holds;
DROP TABLE app.retention_policies;
DROP TABLE app.credential_references;
DROP TABLE app.task_dead_letters;
UPDATE app.task_queue SET state='failed', last_reason=COALESCE(last_reason,'DEAD_LETTER') WHERE state='dead_letter';
ALTER TABLE app.task_queue DROP CONSTRAINT task_queue_state_check;
ALTER TABLE app.task_queue ADD CONSTRAINT task_queue_state_check
  CHECK (state IN ('queued','running','waiting','completed','failed','cancelled','quarantined'));
DROP TABLE app.kill_switch_audit;
DROP TABLE app.kill_switches;
ALTER TABLE app.action_approvals DISABLE TRIGGER approval_proposal_guard;
UPDATE app.action_approvals SET status='expired' WHERE status='revoked';
ALTER TABLE app.action_approvals ENABLE TRIGGER approval_proposal_guard;
ALTER TABLE app.action_approvals DROP CONSTRAINT action_approvals_status_check;
ALTER TABLE app.action_approvals ADD CONSTRAINT action_approvals_status_check
  CHECK (status IN ('pending','approved','rejected','expired','consumed'));
ALTER TABLE app.action_approvals
  DROP COLUMN consequences,
  DROP COLUMN sender_identity,
  DROP COLUMN budget_cents,
  DROP COLUMN campaign_revision,
  DROP COLUMN audience_count,
  DROP COLUMN audience_hash,
  DROP COLUMN content_hash,
  DROP COLUMN title;
DROP TABLE app.policy_decisions;
DROP TABLE app.budget_alerts;
DROP TRIGGER budget_ledger_balanced ON app.budget_ledger_entries;
DROP FUNCTION app.assert_budget_journal_balanced();
DROP TABLE app.budget_ledger_entries;
DROP TABLE app.budget_journals;
DROP TABLE app.governed_reservations;
DROP TABLE app.budget_scopes;
