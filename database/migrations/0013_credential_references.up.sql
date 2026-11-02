-- 0011/0012 belong to separately approved ledger/outbox units; migration gaps are supported.
CREATE TABLE app.integration_credentials (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),
 organization_id app.entity_id NOT NULL REFERENCES app.organizations(id),
 provider text NOT NULL CHECK(provider ~ '^[a-z][a-z0-9_.-]{0,63}$'),
 kind text NOT NULL CHECK(kind IN ('api_key','oauth_refresh')),
 current_version integer NOT NULL CHECK(current_version>0),
 revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_by_membership_id app.entity_id NOT NULL,
 UNIQUE(organization_id,id,provider,kind),
 FOREIGN KEY(organization_id,updated_by_membership_id) REFERENCES app.memberships(organization_id,id)
);
CREATE TABLE app.credential_versions (
 organization_id app.entity_id NOT NULL,
 credential_id app.entity_id NOT NULL,
 provider text NOT NULL,
 kind text NOT NULL,
 version integer NOT NULL CHECK(version>0),
 key_id text NOT NULL CHECK(key_id ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$'),
 nonce bytea NOT NULL CHECK(octet_length(nonce)=12),
 auth_tag bytea NOT NULL CHECK(octet_length(auth_tag)=16),
 ciphertext bytea NOT NULL CHECK(octet_length(ciphertext) BETWEEN 1 AND 16384),
 PRIMARY KEY(organization_id,credential_id,version),
 FOREIGN KEY(organization_id,credential_id,provider,kind) REFERENCES app.integration_credentials(organization_id,id,provider,kind)
);
ALTER TABLE app.integration_credentials ADD CONSTRAINT current_credential_version
 FOREIGN KEY(organization_id,id,current_version) REFERENCES app.credential_versions(organization_id,credential_id,version) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE app.integration_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.integration_credentials FORCE ROW LEVEL SECURITY;
ALTER TABLE app.credential_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.credential_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.integration_credentials
 USING(organization_id=app.current_organization_id()) WITH CHECK(organization_id=app.current_organization_id());
CREATE POLICY tenant_isolation ON app.credential_versions
 USING(organization_id=app.current_organization_id()) WITH CHECK(organization_id=app.current_organization_id());
CREATE FUNCTION app.guard_credential_metadata() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM app.memberships WHERE organization_id=NEW.organization_id AND id=NEW.updated_by_membership_id AND role='owner' AND status='active') OR
    NEW.updated_by_membership_id::text IS DISTINCT FROM current_setting('app.audit_actor_membership_id',true) THEN
  RAISE EXCEPTION 'credential owner context required' USING ERRCODE='42501';
 END IF;
 IF TG_OP='INSERT' AND (NEW.current_version<>1 OR NEW.revoked_at IS NOT NULL) THEN
  RAISE EXCEPTION 'new credential must start active at version one' USING ERRCODE='42501';
 END IF;
 IF TG_OP='UPDATE' THEN
  IF (to_jsonb(NEW)-ARRAY['current_version','revoked_at','updated_by_membership_id']) IS DISTINCT FROM
     (to_jsonb(OLD)-ARRAY['current_version','revoked_at','updated_by_membership_id']) OR OLD.revoked_at IS NOT NULL OR
     NOT ((NEW.current_version=OLD.current_version+1 AND NEW.revoked_at IS NULL) OR
          (NEW.current_version=OLD.current_version AND NEW.revoked_at IS NOT NULL)) THEN
   RAISE EXCEPTION 'invalid credential rotation or revocation' USING ERRCODE='42501';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER credential_metadata_guard BEFORE INSERT OR UPDATE ON app.integration_credentials FOR EACH ROW EXECUTE FUNCTION app.guard_credential_metadata();
CREATE TRIGGER audit_high_risk BEFORE INSERT OR UPDATE ON app.integration_credentials FOR EACH ROW EXECUTE FUNCTION app.capture_high_risk_mutation();
CREATE TRIGGER credentials_no_delete BEFORE DELETE ON app.integration_credentials FOR EACH ROW EXECUTE FUNCTION app.deny_audit_mutation();
CREATE TRIGGER credentials_no_truncate BEFORE TRUNCATE ON app.integration_credentials FOR EACH STATEMENT EXECUTE FUNCTION app.deny_audit_mutation();
CREATE FUNCTION app.guard_credential_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM app.integration_credentials c JOIN app.memberships m ON m.organization_id=c.organization_id AND m.id=c.updated_by_membership_id
  WHERE c.organization_id=NEW.organization_id AND c.id=NEW.credential_id AND c.provider=NEW.provider AND c.kind=NEW.kind AND c.current_version=NEW.version
   AND c.revoked_at IS NULL AND m.role='owner' AND m.status='active' AND m.id::text=current_setting('app.audit_actor_membership_id',true)) THEN
   RAISE EXCEPTION 'credential version is not current or authorized' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER credential_version_guard BEFORE INSERT ON app.credential_versions FOR EACH ROW EXECUTE FUNCTION app.guard_credential_version();
CREATE TRIGGER credential_versions_immutable BEFORE UPDATE OR DELETE ON app.credential_versions FOR EACH ROW EXECUTE FUNCTION app.deny_audit_mutation();
CREATE TRIGGER credential_versions_no_truncate BEFORE TRUNCATE ON app.credential_versions FOR EACH STATEMENT EXECUTE FUNCTION app.deny_audit_mutation();
