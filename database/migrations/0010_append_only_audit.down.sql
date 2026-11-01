-- Explicit migration-owner rollback removes the audit feature and its stored history.
-- Export and retain required audit evidence before approving this destructive rollback.
DROP TRIGGER audit_membership_create ON app.memberships;
DROP TRIGGER audit_membership_change ON app.memberships;
DO $$ DECLARE name text; BEGIN
  FOREACH name IN ARRAY ARRAY['organization_settings','organization_auth_policies','owner_sessions','delegation_grants',
    'projects','offers','pricing_summaries','vetted_product_facts','project_buckets','project_bucket_preferences',
    'agent_identities','agent_project_assignments'] LOOP
    EXECUTE format('DROP TRIGGER audit_high_risk ON app.%I',name);
  END LOOP;
END $$;
DROP FUNCTION app.capture_high_risk_mutation();
DROP FUNCTION app.audit_entry_hash(app.audit_events);
DROP TABLE app.audit_events;
DROP FUNCTION app.deny_audit_mutation();
DROP FUNCTION app.validate_audit_append();
