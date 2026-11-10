DROP TRIGGER approval_proposal_guard ON app.action_approvals;
DROP FUNCTION app.preserve_approval_proposal();
ALTER TABLE app.action_approvals DROP COLUMN proposed_payload;
