-- 0011 is reserved by the independent money-ledger unit. No dispatch is enabled.
CREATE TABLE app.event_outbox (
  id app.entity_id PRIMARY KEY,
  organization_id app.entity_id NOT NULL,
  audit_event_id app.entity_id NOT NULL,
  event_type text NOT NULL,
  correlation_id app.entity_id NOT NULL,
  evidence_hash text NOT NULL CHECK(evidence_hash ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz NOT NULL,
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
  claim_token uuid,
  claim_until timestamptz,
  delivered_at timestamptz,
  UNIQUE(organization_id,id), UNIQUE(organization_id,audit_event_id),
  FOREIGN KEY(organization_id,audit_event_id) REFERENCES app.audit_events(organization_id,id),
  CHECK((claim_token IS NULL)=(claim_until IS NULL)),
  CHECK(delivered_at IS NULL OR claim_token IS NULL)
);
CREATE INDEX event_outbox_pending ON app.event_outbox(organization_id,available_at,occurred_at,id) WHERE delivered_at IS NULL;
ALTER TABLE app.event_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.event_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.event_outbox
 USING(organization_id=app.current_organization_id()) WITH CHECK(organization_id=app.current_organization_id());
CREATE FUNCTION app.validate_outbox_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original app.audit_events;
BEGIN
 IF pg_trigger_depth()<2 THEN RAISE EXCEPTION 'outbox inserts require audit capture' USING ERRCODE='42501'; END IF;
 SELECT * INTO STRICT original FROM app.audit_events WHERE organization_id=NEW.organization_id AND id=NEW.audit_event_id;
 IF NEW.id<>original.id OR NEW.event_type<>original.event_type OR NEW.correlation_id<>original.correlation_id OR
    NEW.evidence_hash<>original.entry_hash OR NEW.occurred_at<>original.occurred_at OR NEW.attempts<>0 OR
    NEW.claim_token IS NOT NULL OR NEW.claim_until IS NOT NULL OR NEW.delivered_at IS NOT NULL THEN
   RAISE EXCEPTION 'outbox envelope must match captured audit' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER outbox_insert_validation BEFORE INSERT ON app.event_outbox FOR EACH ROW EXECUTE FUNCTION app.validate_outbox_insert();
CREATE FUNCTION app.enqueue_audit_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO app.event_outbox(id,organization_id,audit_event_id,event_type,correlation_id,evidence_hash,occurred_at)
 VALUES(NEW.id,NEW.organization_id,NEW.id,NEW.event_type,NEW.correlation_id,NEW.entry_hash,NEW.occurred_at);
 RETURN NEW;
END $$;
CREATE TRIGGER audit_event_outbox AFTER INSERT ON app.audit_events FOR EACH ROW EXECUTE FUNCTION app.enqueue_audit_event();
CREATE FUNCTION app.guard_event_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'outbox history cannot be deleted or truncated' USING ERRCODE='42501'; END IF;
 IF (to_jsonb(NEW)-ARRAY['available_at','attempts','claim_token','claim_until','delivered_at']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['available_at','attempts','claim_token','claim_until','delivered_at']) OR OLD.delivered_at IS NOT NULL THEN
  RAISE EXCEPTION 'outbox envelope and confirmed delivery are immutable' USING ERRCODE='42501';
 END IF;
 IF NEW.claim_token IS NOT NULL THEN
  IF OLD.claim_until>clock_timestamp() OR NEW.attempts<>OLD.attempts+1 OR NEW.delivered_at IS NOT NULL OR
     NEW.claim_until<=clock_timestamp() OR NEW.claim_until>clock_timestamp()+interval '5 minutes' OR
     NEW.available_at IS DISTINCT FROM OLD.available_at THEN
   RAISE EXCEPTION 'invalid outbox claim' USING ERRCODE='42501';
  END IF;
 ELSE
  IF OLD.claim_token IS NULL OR OLD.claim_until<=clock_timestamp() OR NEW.attempts<>OLD.attempts OR
     NEW.available_at>clock_timestamp()+interval '1 hour' THEN
   RAISE EXCEPTION 'outbox claim expired or unavailable' USING ERRCODE='42501';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER outbox_guard BEFORE UPDATE OR DELETE ON app.event_outbox FOR EACH ROW EXECUTE FUNCTION app.guard_event_outbox();
CREATE TRIGGER outbox_truncate_guard BEFORE TRUNCATE ON app.event_outbox FOR EACH STATEMENT EXECUTE FUNCTION app.guard_event_outbox();
CREATE TABLE app.event_receipts (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),
 organization_id app.entity_id NOT NULL REFERENCES app.organizations(id),
 consumer text NOT NULL CHECK(consumer ~ '^[a-z][a-z0-9_.:-]{0,63}$'),
 source text NOT NULL CHECK(source ~ '^[a-z][a-z0-9_.:-]{0,63}$'),
 external_event_id text NOT NULL CHECK(external_event_id ~ '^[A-Za-z0-9_.:/-]{1,200}$'),
 request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
 applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(organization_id,consumer,source,external_event_id)
);
ALTER TABLE app.event_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.event_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.event_receipts
 USING(organization_id=app.current_organization_id()) WITH CHECK(organization_id=app.current_organization_id());
CREATE TRIGGER receipts_immutable BEFORE UPDATE OR DELETE ON app.event_receipts FOR EACH ROW EXECUTE FUNCTION app.deny_audit_mutation();
CREATE TRIGGER receipts_truncate_guard BEFORE TRUNCATE ON app.event_receipts FOR EACH STATEMENT EXECUTE FUNCTION app.deny_audit_mutation();
