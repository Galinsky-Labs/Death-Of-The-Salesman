-- DOTS-055..069: approved model execution, provenance, routing, resilience, usage reconciliation and output isolation.
CREATE TABLE app.model_revisions (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(), organization_id app.entity_id NOT NULL REFERENCES app.organizations(id),
 provider_id text NOT NULL CHECK(provider_id IN ('openai','claude','grok','openrouter')),
 model_id text NOT NULL CHECK(length(model_id) BETWEEN 1 AND 200), revision int NOT NULL CHECK(revision>0),
 status text NOT NULL CHECK(status IN ('approved','retired','denied')),
 endpoint text NOT NULL CHECK(endpoint ~ '^https://'), protocol text NOT NULL, approved_origin text NOT NULL,
 privacy_class text NOT NULL CHECK(privacy_class IN ('public','internal','private')),
 capabilities jsonb NOT NULL CHECK(jsonb_typeof(capabilities)='object'), manifest_version int NOT NULL CHECK(manifest_version>0),
 review_ref text NOT NULL CHECK(length(review_ref) BETWEEN 1 AND 240), snapshot_hash text NOT NULL CHECK(snapshot_hash ~ '^[0-9a-f]{64}$'),
 created_by_membership_id app.entity_id NOT NULL, created_at timestamptz NOT NULL DEFAULT app.utc_now(),
 UNIQUE(organization_id,id), UNIQUE(organization_id,provider_id,model_id,revision),
 FOREIGN KEY(organization_id,created_by_membership_id) REFERENCES app.memberships(organization_id,id)
);
CREATE TABLE app.model_pricing_versions (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(), organization_id app.entity_id NOT NULL REFERENCES app.organizations(id),
 provider_id text NOT NULL CHECK(provider_id IN ('openai','claude','grok','openrouter')), model_id text NOT NULL CHECK(length(model_id) BETWEEN 1 AND 200),
 version int NOT NULL CHECK(version>0),
 input_cents_per_million numeric(14,4) NOT NULL CHECK(input_cents_per_million>=0),
 output_cents_per_million numeric(14,4) NOT NULL CHECK(output_cents_per_million>=0),
 cached_input_cents_per_million numeric(14,4) CHECK(cached_input_cents_per_million>=0),
 source_ref text NOT NULL CHECK(length(source_ref) BETWEEN 1 AND 240), created_at timestamptz NOT NULL DEFAULT app.utc_now(),
 UNIQUE(organization_id,id), UNIQUE(organization_id,provider_id,model_id,version)
);
CREATE TABLE app.model_routing_weights (
 organization_id app.entity_id NOT NULL, agent_identity_id app.entity_id NOT NULL,
 provider_id text NOT NULL CHECK(provider_id IN ('openai','claude','grok','openrouter')), weight int NOT NULL CHECK(weight BETWEEN 0 AND 100),
 version bigint NOT NULL DEFAULT 1 CHECK(version>0), updated_by_membership_id app.entity_id NOT NULL, updated_at timestamptz NOT NULL DEFAULT app.utc_now(),
 PRIMARY KEY(organization_id,agent_identity_id,provider_id),
 FOREIGN KEY(organization_id,agent_identity_id) REFERENCES app.agent_identities(organization_id,id),
 FOREIGN KEY(organization_id,updated_by_membership_id) REFERENCES app.memberships(organization_id,id)
);
CREATE TABLE app.model_breakers (
 organization_id app.entity_id NOT NULL REFERENCES app.organizations(id),
 provider_id text NOT NULL CHECK(provider_id IN ('openai','claude','grok','openrouter')), model_id text NOT NULL CHECK(length(model_id) BETWEEN 1 AND 200),
 state text NOT NULL DEFAULT 'closed' CHECK(state IN ('closed','open','half_open')),
 consecutive_failures int NOT NULL DEFAULT 0 CHECK(consecutive_failures>=0), opened_count int NOT NULL DEFAULT 0 CHECK(opened_count>=0),
 retry_at timestamptz, last_reason text CHECK(length(last_reason)<=120), version bigint NOT NULL DEFAULT 1 CHECK(version>0),
 updated_at timestamptz NOT NULL DEFAULT app.utc_now(),
 CHECK(state<>'open' OR retry_at IS NOT NULL), PRIMARY KEY(organization_id,provider_id,model_id)
);
CREATE TABLE app.model_executions (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(), organization_id app.entity_id NOT NULL REFERENCES app.organizations(id),
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 200), request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
 agent_identity_id app.entity_id NOT NULL,
 task_class text NOT NULL CHECK(task_class IN ('research','draft','classification','tool_use','structured_extraction')),
 privacy_class text NOT NULL CHECK(privacy_class IN ('public','internal','private')),
 state text NOT NULL DEFAULT 'claimed' CHECK(state IN ('claimed','succeeded','failed','reconciliation_required')),
 provider_id text CHECK(provider_id IN ('openai','claude','grok','openrouter')), model_id text, attempts int NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 50),
 reason_code text CHECK(length(reason_code)<=120), result jsonb CHECK(result IS NULL OR (jsonb_typeof(result)='object' AND octet_length(result::text)<=65536)),
 created_at timestamptz NOT NULL DEFAULT app.utc_now(), updated_at timestamptz NOT NULL DEFAULT app.utc_now(),
 UNIQUE(organization_id,id), UNIQUE(organization_id,idempotency_key),
 FOREIGN KEY(organization_id,agent_identity_id) REFERENCES app.agent_identities(organization_id,id)
);
CREATE TABLE app.model_usage_records (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(), organization_id app.entity_id NOT NULL REFERENCES app.organizations(id),
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 200), execution_id app.entity_id, run_id app.entity_id,
 provider_id text NOT NULL CHECK(provider_id IN ('openai','claude','grok','openrouter')), model_id text NOT NULL, pricing_version_id app.entity_id NOT NULL,
 input_tokens bigint NOT NULL DEFAULT 0 CHECK(input_tokens>=0), output_tokens bigint NOT NULL DEFAULT 0 CHECK(output_tokens>=0),
 cached_input_tokens bigint NOT NULL DEFAULT 0 CHECK(cached_input_tokens>=0), reasoning_tokens bigint NOT NULL DEFAULT 0 CHECK(reasoning_tokens>=0),
 wall_time_ms bigint NOT NULL DEFAULT 0 CHECK(wall_time_ms>=0), cost_cents bigint NOT NULL CHECK(cost_cents>=0 AND cost_cents<=9007199254740991),
 usage_source text NOT NULL CHECK(usage_source IN ('provider_reported','estimated','missing')),
 ledger_idempotency_key text, provider_request_id text CHECK(length(provider_request_id)<=240), recorded_at timestamptz NOT NULL DEFAULT app.utc_now(),
 UNIQUE(organization_id,id), UNIQUE(organization_id,idempotency_key),
 FOREIGN KEY(organization_id,execution_id) REFERENCES app.model_executions(organization_id,id),
 FOREIGN KEY(organization_id,run_id) REFERENCES app.agent_runs(organization_id,id),
 FOREIGN KEY(organization_id,pricing_version_id) REFERENCES app.model_pricing_versions(organization_id,id)
);
CREATE TABLE app.model_provider_invoices (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(), organization_id app.entity_id NOT NULL REFERENCES app.organizations(id),
 provider_id text NOT NULL CHECK(provider_id IN ('openai','claude','grok','openrouter')), period_start date NOT NULL, period_end date NOT NULL CHECK(period_end>=period_start),
 amount_cents bigint NOT NULL CHECK(amount_cents>=0 AND amount_cents<=9007199254740991), evidence_ref text NOT NULL CHECK(length(evidence_ref) BETWEEN 1 AND 240),
 recorded_at timestamptz NOT NULL DEFAULT app.utc_now(), UNIQUE(organization_id,id), UNIQUE(organization_id,provider_id,evidence_ref)
);
CREATE TABLE app.generated_outputs (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(), organization_id app.entity_id NOT NULL REFERENCES app.organizations(id), run_id app.entity_id,
 content_hash text NOT NULL CHECK(content_hash ~ '^[0-9a-f]{64}$'),
 content_type text NOT NULL CHECK(content_type IN ('text/plain','text/markdown','application/json','text/html','application/x-executable-script','application/octet-stream')),
 executable boolean NOT NULL, disposition text NOT NULL CHECK(disposition IN ('publishable','quarantined','released','rejected')),
 findings jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(findings)='array'),
 release_use text CHECK(release_use IN ('publish','execute')), release_authorization_ref text CHECK(length(release_authorization_ref)<=240),
 security_check_ref text CHECK(length(security_check_ref)<=240), sandbox_ref text CHECK(length(sandbox_ref)<=240),
 released_by_membership_id app.entity_id, decided_at timestamptz, created_at timestamptz NOT NULL DEFAULT app.utc_now(),
 CHECK(disposition<>'publishable' OR NOT executable),
 CHECK(disposition<>'released' OR (release_authorization_ref IS NOT NULL AND security_check_ref IS NOT NULL AND released_by_membership_id IS NOT NULL)),
 CHECK(release_use IS DISTINCT FROM 'execute' OR sandbox_ref IS NOT NULL),
 UNIQUE(organization_id,id),
 FOREIGN KEY(organization_id,run_id) REFERENCES app.agent_runs(organization_id,id),
 FOREIGN KEY(organization_id,released_by_membership_id) REFERENCES app.memberships(organization_id,id)
);
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['model_revisions','model_pricing_versions','model_routing_weights','model_breakers','model_executions','model_usage_records','model_provider_invoices','generated_outputs'] LOOP
  EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY',name);EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format('CREATE POLICY %I ON app.%I USING(organization_id=app.current_organization_id()) WITH CHECK(organization_id=app.current_organization_id())',name||'_tenant',name);
 END LOOP;
END $$;
CREATE TRIGGER model_revisions_immutable BEFORE UPDATE OR DELETE ON app.model_revisions FOR EACH ROW EXECUTE FUNCTION app.deny_operation_evidence_mutation();
CREATE TRIGGER model_pricing_versions_immutable BEFORE UPDATE OR DELETE ON app.model_pricing_versions FOR EACH ROW EXECUTE FUNCTION app.deny_operation_evidence_mutation();
CREATE TRIGGER model_usage_records_immutable BEFORE UPDATE OR DELETE ON app.model_usage_records FOR EACH ROW EXECUTE FUNCTION app.deny_operation_evidence_mutation();
CREATE TRIGGER model_provider_invoices_immutable BEFORE UPDATE OR DELETE ON app.model_provider_invoices FOR EACH ROW EXECUTE FUNCTION app.deny_operation_evidence_mutation();
CREATE TRIGGER generated_outputs_no_delete BEFORE DELETE ON app.generated_outputs FOR EACH ROW EXECUTE FUNCTION app.deny_operation_evidence_mutation();
CREATE TRIGGER model_executions_no_delete BEFORE DELETE ON app.model_executions FOR EACH ROW EXECUTE FUNCTION app.deny_operation_evidence_mutation();
CREATE FUNCTION app.guard_generated_output() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (to_jsonb(NEW)-ARRAY['disposition','release_use','release_authorization_ref','security_check_ref','sandbox_ref','released_by_membership_id','decided_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['disposition','release_use','release_authorization_ref','security_check_ref','sandbox_ref','released_by_membership_id','decided_at']) THEN RAISE EXCEPTION 'generated output classification is immutable' USING ERRCODE='42501'; END IF;
 IF OLD.disposition<>'quarantined' OR NEW.disposition NOT IN ('released','rejected') THEN RAISE EXCEPTION 'only quarantined output can be released or rejected' USING ERRCODE='42501'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER generated_outputs_guard BEFORE UPDATE ON app.generated_outputs FOR EACH ROW EXECUTE FUNCTION app.guard_generated_output();
CREATE FUNCTION app.guard_model_execution() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.idempotency_key<>OLD.idempotency_key OR NEW.request_hash<>OLD.request_hash OR NEW.agent_identity_id<>OLD.agent_identity_id OR NEW.created_at<>OLD.created_at THEN RAISE EXCEPTION 'model execution identity is immutable' USING ERRCODE='42501'; END IF;
 IF OLD.state<>'claimed' THEN RAISE EXCEPTION 'model execution outcome is final' USING ERRCODE='42501'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER model_executions_guard BEFORE UPDATE ON app.model_executions FOR EACH ROW EXECUTE FUNCTION app.guard_model_execution();
