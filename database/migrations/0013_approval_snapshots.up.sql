ALTER TABLE app.action_approvals ADD COLUMN proposed_payload jsonb;
CREATE FUNCTION app.preserve_approval_proposal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (to_jsonb(NEW)-ARRAY['status','decided_by_membership_id','decided_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','decided_by_membership_id','decided_at']) THEN RAISE EXCEPTION 'approval proposal is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER approval_proposal_guard BEFORE UPDATE ON app.action_approvals FOR EACH ROW EXECUTE FUNCTION app.preserve_approval_proposal();
