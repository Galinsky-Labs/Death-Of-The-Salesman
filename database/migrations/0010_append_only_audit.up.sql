CREATE TABLE app.audit_events (
  id app.entity_id PRIMARY KEY DEFAULT app.new_id(),
  organization_id app.entity_id NOT NULL REFERENCES app.organizations(id),
  actor_type text NOT NULL CHECK (actor_type = 'human'),
  actor_membership_id app.entity_id NOT NULL,
  actor_user_id app.entity_id NOT NULL,
  actor_role text NOT NULL CHECK (actor_role IN ('owner','admin','sales_manager')),
  event_type text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_.]{2,119}$'),
  policy_version text NOT NULL CHECK (policy_version ~ '^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,119}$'),
  correlation_id app.entity_id NOT NULL,
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object' AND octet_length(evidence::text) <= 16384),
  occurred_at timestamptz NOT NULL DEFAULT app.utc_now(),
  entry_hash text NOT NULL,
  UNIQUE (organization_id,id),
  FOREIGN KEY (organization_id,actor_membership_id,actor_user_id)
    REFERENCES app.memberships(organization_id,id,user_id)
);
CREATE INDEX audit_events_tenant_time ON app.audit_events(organization_id,occurred_at,id);
ALTER TABLE app.audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_events_read ON app.audit_events FOR SELECT
  USING (organization_id = app.current_organization_id());
CREATE POLICY audit_events_append ON app.audit_events FOR INSERT
  WITH CHECK (organization_id = app.current_organization_id());

CREATE FUNCTION app.audit_entry_hash(event app.audit_events) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT encode(sha256(convert_to(((to_jsonb(event)-'entry_hash'-'occurred_at') ||
    jsonb_build_object('occurred_at',to_char(event.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')))::text,'UTF8')),'hex')
$$;

CREATE FUNCTION app.validate_audit_append() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE member app.memberships%ROWTYPE;
BEGIN
  IF NEW.organization_id IS DISTINCT FROM app.current_organization_id() THEN
    RAISE EXCEPTION 'audit tenant context required' USING ERRCODE='42501';
  END IF;
  SELECT * INTO member FROM app.memberships WHERE organization_id=NEW.organization_id
    AND id=NEW.actor_membership_id AND status='active';
  IF NOT FOUND THEN RAISE EXCEPTION 'audit actor is not authorized' USING ERRCODE='42501'; END IF;
  NEW.actor_type := 'human'; NEW.actor_user_id := member.user_id; NEW.actor_role := member.role;
  NEW.occurred_at := app.utc_now();
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(NEW.evidence) AS keys(key)
    WHERE key NOT IN ('recordId','recordType','operation','version','status','changedFields','reasonCode','evidenceHashes')) THEN
    RAISE EXCEPTION 'audit evidence field is not allowed' USING ERRCODE='22023';
  END IF;
  IF NEW.evidence ? 'recordId' AND (jsonb_typeof(NEW.evidence->'recordId') <> 'string' OR
    (NEW.evidence->>'recordId') !~ '^[0-9a-fA-F-]{36}$') THEN
    RAISE EXCEPTION 'invalid audit record id' USING ERRCODE='22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_each(NEW.evidence) AS fields(key,value)
    WHERE key IN ('recordType','operation','status','reasonCode') AND
      (jsonb_typeof(value) <> 'string' OR value #>> '{}' !~ '^[a-zA-Z0-9_.:-]{1,120}$')) THEN
    RAISE EXCEPTION 'invalid audit metadata' USING ERRCODE='22023';
  END IF;
  IF NEW.evidence ? 'version' AND (jsonb_typeof(NEW.evidence->'version') <> 'number' OR
      NEW.evidence->>'version' !~ '^[1-9][0-9]{0,18}$') THEN
    RAISE EXCEPTION 'invalid audit version' USING ERRCODE='22023';
  END IF;
  IF NEW.evidence ? 'changedFields' THEN
    IF jsonb_typeof(NEW.evidence->'changedFields') <> 'array' OR jsonb_array_length(NEW.evidence->'changedFields') > 80 THEN
      RAISE EXCEPTION 'invalid audit changed fields' USING ERRCODE='22023';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements_text(NEW.evidence->'changedFields') AS fields(field)
      WHERE field !~ '^[a-z][a-z0-9_]{0,79}$') THEN
      RAISE EXCEPTION 'invalid audit field name' USING ERRCODE='22023';
    END IF;
  END IF;
  IF NEW.evidence ? 'evidenceHashes' THEN
    IF jsonb_typeof(NEW.evidence->'evidenceHashes') <> 'array' OR jsonb_array_length(NEW.evidence->'evidenceHashes') > 20 THEN
      RAISE EXCEPTION 'invalid audit evidence hashes' USING ERRCODE='22023';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements_text(NEW.evidence->'evidenceHashes') AS hashes(hash)
      WHERE hash !~ '^[0-9a-f]{64}$') THEN
      RAISE EXCEPTION 'invalid audit evidence hash' USING ERRCODE='22023';
    END IF;
  END IF;
  NEW.entry_hash := app.audit_entry_hash(NEW);
  RETURN NEW;
END $$;
CREATE TRIGGER audit_append_validation BEFORE INSERT ON app.audit_events
  FOR EACH ROW EXECUTE FUNCTION app.validate_audit_append();

CREATE FUNCTION app.deny_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit events are append-only' USING ERRCODE='42501'; END $$;
CREATE TRIGGER audit_no_update_delete BEFORE UPDATE OR DELETE ON app.audit_events
  FOR EACH ROW EXECUTE FUNCTION app.deny_audit_mutation();
CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON app.audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION app.deny_audit_mutation();

CREATE FUNCTION app.capture_high_risk_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE data jsonb; actor app.entity_id; correlation app.entity_id; metadata jsonb; fields jsonb;
BEGIN
  data := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  IF TG_TABLE_NAME='owner_sessions' THEN
    IF TG_OP='UPDATE' AND (to_jsonb(NEW)-'last_seen_at'-'idle_expires_at') = (to_jsonb(OLD)-'last_seen_at'-'idle_expires_at') THEN RETURN NEW; END IF;
  END IF;
  actor := NULLIF(current_setting('app.audit_actor_membership_id',true),'')::app.entity_id;
  IF TG_OP<>'DELETE' THEN
    actor := COALESCE(actor, (data->>'updated_by_membership_id')::app.entity_id,
      (data->>'created_by_membership_id')::app.entity_id, (data->>'owner_membership_id')::app.entity_id, (data->>'membership_id')::app.entity_id);
  END IF;
  IF TG_TABLE_NAME='memberships' AND NOT EXISTS (SELECT 1 FROM app.memberships WHERE organization_id=(data->>'organization_id')::app.entity_id AND id=actor AND role='owner' AND status='active') THEN
    RAISE EXCEPTION 'membership audit requires owner actor' USING ERRCODE='42501';
  END IF;
  IF actor IS NULL THEN RAISE EXCEPTION 'explicit audit actor context required' USING ERRCODE='42501'; END IF;
  correlation := NULLIF(current_setting('app.audit_correlation_id',true),'')::app.entity_id;
  IF correlation IS NULL THEN
    correlation := app.new_id();
    PERFORM set_config('app.audit_correlation_id',correlation::text,true);
  END IF;
  metadata := jsonb_build_object('recordId',COALESCE(data->>'id',data->>'bucket_id',data->>'organization_id'),
    'recordType',TG_TABLE_NAME,'operation',lower(TG_OP));
  IF data ? 'version' THEN metadata := metadata || jsonb_build_object('version',data->'version'); END IF;
  IF data ? 'status' THEN metadata := metadata || jsonb_build_object('status',data->'status'); END IF;
  IF TG_OP='UPDATE' THEN
    SELECT COALESCE(jsonb_agg(key ORDER BY key),'[]'::jsonb) INTO fields
    FROM jsonb_each(to_jsonb(NEW)) WHERE value IS DISTINCT FROM to_jsonb(OLD)->key;
    metadata := metadata || jsonb_build_object('changedFields',fields);
  END IF;
  INSERT INTO app.audit_events(organization_id,actor_type,actor_membership_id,actor_user_id,actor_role,
    event_type,policy_version,correlation_id,evidence,entry_hash)
  VALUES ((data->>'organization_id')::app.entity_id,'human',actor,actor,'owner',
    TG_TABLE_NAME||'.'||lower(TG_OP),COALESCE(NULLIF(current_setting('app.audit_policy_version',true),''),'dots-authorization-v1'),
    correlation,metadata,'');
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

DO $$ DECLARE name text; BEGIN
  FOREACH name IN ARRAY ARRAY['organization_settings','organization_auth_policies','owner_sessions','delegation_grants',
    'projects','offers','pricing_summaries','vetted_product_facts','project_buckets','project_bucket_preferences',
    'agent_identities','agent_project_assignments'] LOOP
    EXECUTE format('CREATE TRIGGER audit_high_risk BEFORE INSERT OR UPDATE OR DELETE ON app.%I FOR EACH ROW EXECUTE FUNCTION app.capture_high_risk_mutation()',name);
  END LOOP;
END $$;
CREATE TRIGGER audit_membership_change BEFORE UPDATE OR DELETE ON app.memberships
  FOR EACH ROW EXECUTE FUNCTION app.capture_high_risk_mutation();
CREATE TRIGGER audit_membership_create AFTER INSERT ON app.memberships
  FOR EACH ROW EXECUTE FUNCTION app.capture_high_risk_mutation();
