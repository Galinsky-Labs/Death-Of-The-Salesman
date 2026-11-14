-- DOTS-039..054: bounded agent runtime, synthetic autonomy and owner-gated dispatch evidence.
CREATE TABLE app.agent_capabilities (
 organization_id app.entity_id NOT NULL,
 agent_identity_id app.entity_id NOT NULL,
 role text NOT NULL DEFAULT 'sales_strategist' CHECK(role ~ '^[a-z][a-z0-9_]{1,59}$'),
 allowed_task_kinds text[] NOT NULL DEFAULT '{}' CHECK(allowed_task_kinds <@ ARRAY['research','draft','simulate_campaign','follow_up','grant_draft']::text[]),
 allowed_tools text[] NOT NULL DEFAULT '{}' CHECK(allowed_tools <@ ARRAY['propose_draft','propose_crm_note','propose_stage_change','request_owner_review']::text[]),
 allowed_channels text[] NOT NULL DEFAULT ARRAY['none']::text[] CHECK(allowed_channels <@ ARRAY['none','crm','email']::text[]),
 skills text[] NOT NULL DEFAULT '{}' CHECK(cardinality(skills)<=32),
 model_policy text NOT NULL DEFAULT 'simulation_only' CHECK(model_policy IN ('simulation_only','free_public_only','paid_capped')),
 campaign_scope uuid[] NOT NULL DEFAULT '{}' CHECK(cardinality(campaign_scope)<=100),
 paused boolean NOT NULL DEFAULT true,
 max_steps int NOT NULL DEFAULT 4 CHECK(max_steps BETWEEN 1 AND 20),
 wall_clock_seconds int NOT NULL DEFAULT 60 CHECK(wall_clock_seconds BETWEEN 5 AND 900),
 daily_run_quota int NOT NULL DEFAULT 20 CHECK(daily_run_quota BETWEEN 1 AND 500),
 window_start_minute int CHECK(window_start_minute BETWEEN 0 AND 1439),
 window_end_minute int CHECK(window_end_minute BETWEEN 0 AND 1439),
 version bigint NOT NULL DEFAULT 1 CHECK(version>0),
 updated_by_membership_id app.entity_id NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT app.utc_now(),
 PRIMARY KEY(organization_id,agent_identity_id),
 CHECK((window_start_minute IS NULL)=(window_end_minute IS NULL)),
 FOREIGN KEY(organization_id,agent_identity_id) REFERENCES app.agent_identities(organization_id,id),
 FOREIGN KEY(organization_id,updated_by_membership_id) REFERENCES app.memberships(organization_id,id)
);
CREATE TABLE app.work_items (
 id app.entity_id PRIMARY KEY,
 organization_id app.entity_id NOT NULL,
 project_id app.entity_id NOT NULL,
 agent_identity_id app.entity_id NOT NULL,
 campaign_id app.entity_id,
 lead_key text CHECK(lead_key ~ '^[a-z][a-z0-9_]{0,30}:[A-Za-z0-9_.:-]{1,120}$'),
 channel text NOT NULL DEFAULT 'none' CHECK(channel IN ('none','crm','email')),
 required_skill text CHECK(required_skill ~ '^[a-z][a-z0-9_]{1,40}$'),
 state text NOT NULL DEFAULT 'CREATED' CHECK(state IN ('CREATED','ELIGIBLE','RESERVED','RUNNING','DRAFTED','WAITING_FOR_APPROVAL','WAITING_FOR_REPLY','WAITING_FOR_BUDGET','BLOCKED','COMPLETED','FAILED_RETRYABLE','FAILED_FINAL','CANCELLED','RECOVERING')),
 reason text CHECK(length(reason)<=200),
 version bigint NOT NULL DEFAULT 1 CHECK(version>0),
 deadline_at timestamptz,
 outcome jsonb CHECK(outcome IS NULL OR (jsonb_typeof(outcome)='object' AND octet_length(outcome::text)<=16384)),
 created_at timestamptz NOT NULL DEFAULT app.utc_now(),
 updated_at timestamptz NOT NULL DEFAULT app.utc_now(),
 UNIQUE(organization_id,id),
 FOREIGN KEY(organization_id,id) REFERENCES app.task_queue(organization_id,id),
 FOREIGN KEY(organization_id,project_id) REFERENCES app.projects(organization_id,id),
 FOREIGN KEY(organization_id,agent_identity_id) REFERENCES app.agent_identities(organization_id,id),
 FOREIGN KEY(organization_id,campaign_id) REFERENCES app.campaigns(organization_id,id)
);
CREATE INDEX work_items_state ON app.work_items(organization_id,state,updated_at DESC);
CREATE TABLE app.work_item_transitions (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),
 organization_id app.entity_id NOT NULL,
 work_item_id app.entity_id NOT NULL,
 from_state text,
 to_state text NOT NULL,
 from_version bigint,
 to_version bigint NOT NULL,
 reason text CHECK(length(reason)<=200),
 idempotency_key text CHECK(length(idempotency_key) BETWEEN 1 AND 200),
 actor_kind text NOT NULL CHECK(actor_kind IN ('human','worker')),
 outcome jsonb,
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(organization_id,id),
 UNIQUE(organization_id,idempotency_key),
 FOREIGN KEY(organization_id,work_item_id) REFERENCES app.work_items(organization_id,id)
);
CREATE INDEX work_item_transitions_timeline ON app.work_item_transitions(organization_id,occurred_at DESC);
CREATE TABLE app.lead_locks (
 organization_id app.entity_id NOT NULL,
 lead_key text NOT NULL,
 work_item_id app.entity_id NOT NULL,
 acquired_at timestamptz NOT NULL DEFAULT app.utc_now(),
 PRIMARY KEY(organization_id,lead_key),
 FOREIGN KEY(organization_id,work_item_id) REFERENCES app.work_items(organization_id,id)
);
CREATE TABLE app.runtime_dead_letters (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),
 organization_id app.entity_id NOT NULL,
 task_id app.entity_id NOT NULL,
 reason_code text NOT NULL CHECK(length(reason_code) BETWEEN 1 AND 120),
 attempts int NOT NULL CHECK(attempts>=0),
 payload_hash text NOT NULL CHECK(payload_hash ~ '^[0-9a-f]{64}$'),
 created_at timestamptz NOT NULL DEFAULT app.utc_now(),
 UNIQUE(organization_id,id),
 UNIQUE(organization_id,task_id),
 FOREIGN KEY(organization_id,task_id) REFERENCES app.task_queue(organization_id,id)
);
CREATE TABLE app.run_controls (
 organization_id app.entity_id NOT NULL,
 run_id app.entity_id NOT NULL,
 work_item_id app.entity_id NOT NULL,
 agent_identity_id app.entity_id NOT NULL,
 project_id app.entity_id NOT NULL,
 worker_id text NOT NULL CHECK(length(worker_id) BETWEEN 1 AND 200),
 fencing_token bigint NOT NULL,
 model_id text NOT NULL CHECK(length(model_id) BETWEEN 1 AND 120),
 billing text NOT NULL DEFAULT 'none' CHECK(billing='none'),
 strategy_label text,
 context_version text NOT NULL CHECK(context_version ~ '^[0-9a-f]{64}$'),
 status text NOT NULL DEFAULT 'running' CHECK(status IN ('running','completed','failed','cancelled','timed_out','step_limit','recovering')),
 max_steps int NOT NULL CHECK(max_steps BETWEEN 1 AND 20),
 steps_used int NOT NULL DEFAULT 0 CHECK(steps_used>=0 AND steps_used<=max_steps),
 deadline_at timestamptz NOT NULL,
 cancel_requested boolean NOT NULL DEFAULT false,
 last_checkpoint_sequence int NOT NULL DEFAULT 0,
 cost_cents bigint NOT NULL DEFAULT 0 CHECK(cost_cents=0),
 summary text CHECK(length(summary)<=2000),
 reason_code text,
 started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 ended_at timestamptz,
 PRIMARY KEY(organization_id,run_id),
 FOREIGN KEY(organization_id,run_id) REFERENCES app.agent_runs(organization_id,id),
 FOREIGN KEY(organization_id,work_item_id) REFERENCES app.work_items(organization_id,id),
 FOREIGN KEY(organization_id,agent_identity_id) REFERENCES app.agent_identities(organization_id,id),
 FOREIGN KEY(organization_id,project_id) REFERENCES app.projects(organization_id,id)
);
CREATE INDEX run_controls_agent ON app.run_controls(organization_id,agent_identity_id,started_at DESC);
CREATE TABLE app.context_snapshots (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),
 organization_id app.entity_id NOT NULL,
 run_id app.entity_id NOT NULL,
 work_item_id app.entity_id NOT NULL,
 context_version text NOT NULL CHECK(context_version ~ '^[0-9a-f]{64}$'),
 context jsonb NOT NULL CHECK(jsonb_typeof(context)='object' AND octet_length(context::text)<=65536),
 created_at timestamptz NOT NULL DEFAULT app.utc_now(),
 UNIQUE(organization_id,id),
 UNIQUE(organization_id,run_id),
 FOREIGN KEY(organization_id,run_id) REFERENCES app.agent_runs(organization_id,id),
 FOREIGN KEY(organization_id,work_item_id) REFERENCES app.work_items(organization_id,id)
);
CREATE TABLE app.tool_proposals (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),
 organization_id app.entity_id NOT NULL,
 run_id app.entity_id NOT NULL,
 work_item_id app.entity_id NOT NULL,
 agent_identity_id app.entity_id NOT NULL,
 step int NOT NULL CHECK(step>0),
 ordinal int NOT NULL CHECK(ordinal>=0),
 tool_name text NOT NULL CHECK(length(tool_name) BETWEEN 1 AND 120),
 input jsonb CHECK(input IS NULL OR octet_length(input::text)<=32768),
 input_hash text NOT NULL CHECK(input_hash ~ '^[0-9a-f]{64}$'),
 status text NOT NULL CHECK(status IN ('accepted','rejected')),
 rejection_code text,
 trace_id text NOT NULL CHECK(length(trace_id) BETWEEN 1 AND 200),
 correlation_id app.entity_id NOT NULL,
 created_at timestamptz NOT NULL DEFAULT app.utc_now(),
 UNIQUE(organization_id,id),
 UNIQUE(organization_id,run_id,step,ordinal),
 CHECK((status='accepted')=(rejection_code IS NULL)),
 FOREIGN KEY(organization_id,run_id) REFERENCES app.agent_runs(organization_id,id),
 FOREIGN KEY(organization_id,work_item_id) REFERENCES app.work_items(organization_id,id),
 FOREIGN KEY(organization_id,agent_identity_id) REFERENCES app.agent_identities(organization_id,id)
);
CREATE TABLE app.run_memories (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),
 organization_id app.entity_id NOT NULL,
 agent_identity_id app.entity_id NOT NULL,
 project_id app.entity_id NOT NULL,
 run_id app.entity_id NOT NULL,
 kind text NOT NULL CHECK(kind IN ('run_summary','contact_fact','decision')),
 subject_ref text CHECK(length(subject_ref)<=200),
 content jsonb NOT NULL CHECK(jsonb_typeof(content)='object' AND octet_length(content::text)<=16384),
 provenance jsonb NOT NULL CHECK(jsonb_typeof(provenance)='object' AND provenance ? 'runId'),
 content_hash text NOT NULL CHECK(content_hash ~ '^[0-9a-f]{64}$'),
 created_at timestamptz NOT NULL DEFAULT app.utc_now(),
 UNIQUE(organization_id,id),
 UNIQUE(organization_id,run_id,kind,content_hash),
 FOREIGN KEY(organization_id,agent_identity_id) REFERENCES app.agent_identities(organization_id,id),
 FOREIGN KEY(organization_id,project_id) REFERENCES app.projects(organization_id,id),
 FOREIGN KEY(organization_id,run_id) REFERENCES app.agent_runs(organization_id,id)
);
CREATE TABLE app.runtime_dispatch_log (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),
 organization_id app.entity_id NOT NULL,
 dedupe_key text NOT NULL CHECK(length(dedupe_key) BETWEEN 1 AND 200),
 work_item_id app.entity_id,
 action_kind text NOT NULL,
 record_id app.entity_id NOT NULL,
 payload_hash text NOT NULL CHECK(payload_hash ~ '^[0-9a-f]{64}$'),
 approval_id app.entity_id NOT NULL,
 reservation_id app.entity_id,
 status text NOT NULL DEFAULT 'started' CHECK(status IN ('started','confirmed','failed_before_send','ambiguous','reconciled_sent','reconciled_not_sent')),
 attempts int NOT NULL DEFAULT 1 CHECK(attempts BETWEEN 1 AND 10),
 provider_ref text CHECK(length(provider_ref)<=240),
 reconciliation_evidence text CHECK(length(reconciliation_evidence)<=500),
 created_at timestamptz NOT NULL DEFAULT app.utc_now(),
 updated_at timestamptz NOT NULL DEFAULT app.utc_now(),
 UNIQUE(organization_id,id),
 UNIQUE(organization_id,dedupe_key),
 FOREIGN KEY(organization_id,work_item_id) REFERENCES app.work_items(organization_id,id),
 FOREIGN KEY(organization_id,approval_id) REFERENCES app.action_approvals(organization_id,id),
 FOREIGN KEY(organization_id,reservation_id) REFERENCES app.budget_reservations(organization_id,id)
);
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['agent_capabilities','work_items','work_item_transitions','lead_locks','runtime_dead_letters','run_controls','context_snapshots','tool_proposals','run_memories','runtime_dispatch_log'] LOOP
  EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format('CREATE POLICY %I ON app.%I USING (organization_id=app.current_organization_id()) WITH CHECK (organization_id=app.current_organization_id())',name||'_tenant',name);
 END LOOP;
END $$;
CREATE TRIGGER work_item_transitions_immutable BEFORE UPDATE OR DELETE ON app.work_item_transitions FOR EACH ROW EXECUTE FUNCTION app.deny_operation_evidence_mutation();
CREATE TRIGGER dead_letters_immutable BEFORE UPDATE OR DELETE ON app.runtime_dead_letters FOR EACH ROW EXECUTE FUNCTION app.deny_operation_evidence_mutation();
CREATE TRIGGER context_snapshots_immutable BEFORE UPDATE OR DELETE ON app.context_snapshots FOR EACH ROW EXECUTE FUNCTION app.deny_operation_evidence_mutation();
CREATE TRIGGER tool_proposals_immutable BEFORE UPDATE OR DELETE ON app.tool_proposals FOR EACH ROW EXECUTE FUNCTION app.deny_operation_evidence_mutation();
CREATE TRIGGER run_memories_immutable BEFORE UPDATE OR DELETE ON app.run_memories FOR EACH ROW EXECUTE FUNCTION app.deny_operation_evidence_mutation();
