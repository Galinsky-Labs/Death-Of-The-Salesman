-- Foundations only. No automatic source-record erasure or export download is enabled.
CREATE TABLE app.privacy_cache (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),
 organization_id app.entity_id NOT NULL REFERENCES app.organizations(id),
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object' AND octet_length(payload::text)<=16384),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 updated_by_membership_id app.entity_id NOT NULL,
 UNIQUE(organization_id,id),
 FOREIGN KEY(organization_id,updated_by_membership_id) REFERENCES app.memberships(organization_id,id)
);
CREATE INDEX privacy_cache_expiry ON app.privacy_cache(organization_id,expires_at,id);
CREATE TABLE app.privacy_holds (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),
 organization_id app.entity_id NOT NULL,
 cache_id app.entity_id NOT NULL,
 reason_code text NOT NULL CHECK(reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
 expires_at timestamptz NOT NULL,
 released_at timestamptz,
 updated_by_membership_id app.entity_id NOT NULL,
 FOREIGN KEY(organization_id,cache_id) REFERENCES app.privacy_cache(organization_id,id) ON DELETE CASCADE,
 FOREIGN KEY(organization_id,updated_by_membership_id) REFERENCES app.memberships(organization_id,id)
);
CREATE TABLE app.privacy_requests (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),
 organization_id app.entity_id NOT NULL REFERENCES app.organizations(id),
 kind text NOT NULL CHECK(kind IN ('delete','correct','export')),
 resource_type text NOT NULL CHECK(resource_type IN ('project','offer','derived_cache')),
 resource_id app.entity_id NOT NULL,
 expected_version bigint,
 CHECK((resource_type='derived_cache' AND expected_version IS NULL) OR (resource_type<>'derived_cache' AND expected_version IS NOT NULL AND expected_version>0)),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','held','completed','rejected')),
 reason_code text NOT NULL CHECK(reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_by_membership_id app.entity_id NOT NULL,
 UNIQUE(organization_id,id),
 FOREIGN KEY(organization_id,updated_by_membership_id) REFERENCES app.memberships(organization_id,id)
);
CREATE TABLE app.privacy_export_jobs (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),
 organization_id app.entity_id NOT NULL,
 request_id app.entity_id NOT NULL,
 UNIQUE(organization_id,request_id),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','ready','failed','expired')),
 artifact_id app.entity_id,
 artifact_version integer CHECK(artifact_version>0),
 expires_at timestamptz NOT NULL,
 updated_by_membership_id app.entity_id NOT NULL,
 FOREIGN KEY(organization_id,request_id) REFERENCES app.privacy_requests(organization_id,id),
 FOREIGN KEY(organization_id,updated_by_membership_id) REFERENCES app.memberships(organization_id,id),
 CHECK((artifact_id IS NULL)=(artifact_version IS NULL)),
 CHECK(state<>'ready' OR artifact_id IS NOT NULL)
);
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['privacy_cache','privacy_holds','privacy_requests','privacy_export_jobs'] LOOP
  EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format('CREATE POLICY tenant_isolation ON app.%I USING(organization_id=app.current_organization_id()) WITH CHECK(organization_id=app.current_organization_id())',name);
  EXECUTE format('CREATE TRIGGER audit_high_risk BEFORE INSERT OR UPDATE OR DELETE ON app.%I FOR EACH ROW EXECUTE FUNCTION app.capture_high_risk_mutation()',name);
 END LOOP;
END $$;
CREATE FUNCTION app.guard_privacy_retention() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM app.privacy_holds WHERE organization_id=OLD.organization_id AND cache_id=OLD.id AND released_at IS NULL AND expires_at>clock_timestamp()) THEN
   RAISE EXCEPTION 'active evidence hold prevents cache deletion' USING ERRCODE='42501';
  END IF;
  RETURN OLD;
 END IF;
 IF TG_TABLE_NAME='privacy_cache' THEN
  IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'derived cache must be replaced, not extended' USING ERRCODE='42501'; END IF;
  NEW.created_at:=clock_timestamp();
  IF NEW.expires_at<=NEW.created_at OR NEW.expires_at>NEW.created_at+interval '30 days' OR NOT isfinite(NEW.expires_at) THEN
   RAISE EXCEPTION 'cache expiry must be finite and within thirty days' USING ERRCODE='22023';
  END IF;
 ELSIF TG_TABLE_NAME='privacy_holds' THEN
  -- Serialize against expiry cleanup on the same cache record.
  PERFORM id FROM app.privacy_cache WHERE organization_id=NEW.organization_id AND id=NEW.cache_id FOR UPDATE;
  IF NOT FOUND OR NOT isfinite(NEW.expires_at) OR NEW.expires_at<=clock_timestamp() OR NEW.expires_at>clock_timestamp()+interval '365 days' THEN
   RAISE EXCEPTION 'invalid finite evidence hold' USING ERRCODE='22023';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER privacy_cache_guard BEFORE INSERT OR UPDATE OR DELETE ON app.privacy_cache FOR EACH ROW EXECUTE FUNCTION app.guard_privacy_retention();
CREATE TRIGGER privacy_hold_guard BEFORE INSERT OR UPDATE ON app.privacy_holds FOR EACH ROW EXECUTE FUNCTION app.guard_privacy_retention();
CREATE TRIGGER privacy_cache_no_truncate BEFORE TRUNCATE ON app.privacy_cache FOR EACH STATEMENT EXECUTE FUNCTION app.deny_audit_mutation();
CREATE TRIGGER privacy_holds_no_truncate BEFORE TRUNCATE ON app.privacy_holds FOR EACH STATEMENT EXECUTE FUNCTION app.deny_audit_mutation();
ALTER TABLE app.privacy_export_jobs ADD COLUMN created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 ADD CONSTRAINT export_expiry_finite CHECK(isfinite(expires_at) AND expires_at>created_at AND expires_at<=created_at+interval '7 days');
