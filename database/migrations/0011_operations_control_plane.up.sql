CREATE TABLE app.operation_events (
  id app.entity_id PRIMARY KEY DEFAULT app.new_id(),
  organization_id app.entity_id NOT NULL REFERENCES app.organizations(id),
  actor_kind text NOT NULL CHECK (actor_kind IN ('human','worker','provider')),
  actor_id text NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 200),
  event_type text NOT NULL CHECK(event_type ~ '^[a-z][a-z0-9_.]{2,119}$'),
  record_id app.entity_id,
  correlation_id app.entity_id NOT NULL DEFAULT app.new_id(),
  details jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(details)='object' AND octet_length(details::text)<=16384),
  occurred_at timestamptz NOT NULL DEFAULT app.utc_now()
);
CREATE INDEX operation_events_timeline ON app.operation_events(organization_id,occurred_at DESC,id);
CREATE TABLE app.event_outbox (
  id app.entity_id PRIMARY KEY DEFAULT app.new_id(),
  organization_id app.entity_id NOT NULL REFERENCES app.organizations(id),
  idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 200),
  event_type text NOT NULL,
  payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object' AND octet_length(payload::text)<=32768),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','published','quarantined')),
  attempts int NOT NULL DEFAULT 0 CHECK(attempts>=0),
  available_at timestamptz NOT NULL DEFAULT app.utc_now(),
  created_at timestamptz NOT NULL DEFAULT app.utc_now(),
  published_at timestamptz,
  UNIQUE(organization_id,idempotency_key)
);
CREATE TABLE app.policy_controls (
  organization_id app.entity_id PRIMARY KEY REFERENCES app.organizations(id),
  paused boolean NOT NULL DEFAULT true,
  model_enabled boolean NOT NULL DEFAULT false,
  outbound_enabled boolean NOT NULL DEFAULT false,
  version bigint NOT NULL DEFAULT 1 CHECK(version>0),
  updated_by_membership_id app.entity_id NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT app.utc_now(),
  FOREIGN KEY(organization_id,updated_by_membership_id) REFERENCES app.memberships(organization_id,id)
);
CREATE TABLE app.spending_policies (
  id app.entity_id PRIMARY KEY DEFAULT app.new_id(),
  organization_id app.entity_id NOT NULL REFERENCES app.organizations(id),
  project_id app.entity_id,
  currency text NOT NULL DEFAULT 'USD' CHECK(currency='USD'),
  limit_cents bigint NOT NULL DEFAULT 0 CHECK(limit_cents>=0 AND limit_cents<=9007199254740991),
  reserved_cents bigint NOT NULL DEFAULT 0 CHECK(reserved_cents>=0),
  spent_cents bigint NOT NULL DEFAULT 0 CHECK(spent_cents>=0),
  authorization_ref text,
  version bigint NOT NULL DEFAULT 1 CHECK(version>0),
  updated_by_membership_id app.entity_id NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT app.utc_now(),
  CHECK(reserved_cents+spent_cents<=limit_cents),
  CHECK(limit_cents=0 OR (authorization_ref IS NOT NULL AND length(btrim(authorization_ref))>0)),
  UNIQUE NULLS NOT DISTINCT(organization_id,project_id),
  UNIQUE(organization_id,id),
  FOREIGN KEY(organization_id,project_id) REFERENCES app.projects(organization_id,id),
  FOREIGN KEY(organization_id,updated_by_membership_id) REFERENCES app.memberships(organization_id,id)
);
CREATE TABLE app.budget_reservations (
  id app.entity_id PRIMARY KEY DEFAULT app.new_id(),
  organization_id app.entity_id NOT NULL,
  policy_id app.entity_id NOT NULL,
  idempotency_key text NOT NULL,
  estimate_cents bigint NOT NULL CHECK(estimate_cents>=0 AND estimate_cents<=9007199254740991),
  actual_cents bigint CHECK(actual_cents>=0),
  status text NOT NULL DEFAULT 'reserved' CHECK(status IN ('reserved','settled','released','disputed')),
  created_at timestamptz NOT NULL DEFAULT app.utc_now(),
  settled_at timestamptz,
  UNIQUE(organization_id,idempotency_key),
  UNIQUE(organization_id,id),
  FOREIGN KEY(organization_id,policy_id) REFERENCES app.spending_policies(organization_id,id)
);
CREATE TABLE app.reservation_policy_links (
  organization_id app.entity_id NOT NULL, reservation_id app.entity_id NOT NULL, policy_id app.entity_id NOT NULL,
  PRIMARY KEY(organization_id,reservation_id,policy_id),
  FOREIGN KEY(organization_id,reservation_id) REFERENCES app.budget_reservations(organization_id,id),
  FOREIGN KEY(organization_id,policy_id) REFERENCES app.spending_policies(organization_id,id)
);
CREATE TABLE app.money_entries (
  id app.entity_id PRIMARY KEY DEFAULT app.new_id(),
  organization_id app.entity_id NOT NULL REFERENCES app.organizations(id),
  reservation_id app.entity_id,
  project_id app.entity_id,
  idempotency_key text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('expense','refund','sale_receipt','grant_disbursement','investment_receipt')),
  amount_cents bigint NOT NULL CHECK(amount_cents>=0 AND amount_cents<=9007199254740991),
  currency text NOT NULL DEFAULT 'USD' CHECK(currency='USD'),
  source text NOT NULL CHECK(source IN ('simulation','provider','owner_attested')),
  evidence_ref text NOT NULL CHECK(length(evidence_ref) BETWEEN 1 AND 240),
  occurred_at timestamptz NOT NULL DEFAULT app.utc_now(),
  UNIQUE(organization_id,idempotency_key),
  FOREIGN KEY(organization_id,reservation_id) REFERENCES app.budget_reservations(organization_id,id),
  FOREIGN KEY(organization_id,project_id) REFERENCES app.projects(organization_id,id)
);
CREATE TABLE app.action_approvals (
  id app.entity_id PRIMARY KEY DEFAULT app.new_id(),
  organization_id app.entity_id NOT NULL REFERENCES app.organizations(id),
  action_kind text NOT NULL CHECK(action_kind IN ('message','campaign','grant_submission','investment_disclosure','quotation','payment','provider_activation')),
  record_id app.entity_id NOT NULL,
  payload_hash text NOT NULL CHECK(payload_hash ~ '^[0-9a-f]{64}$'),
  policy_version bigint NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','expired','consumed')),
  requested_by_membership_id app.entity_id NOT NULL,
  decided_by_membership_id app.entity_id,
  created_at timestamptz NOT NULL DEFAULT app.utc_now(),
  expires_at timestamptz NOT NULL DEFAULT app.utc_now()+interval '24 hours',
  decided_at timestamptz,
  UNIQUE(organization_id,id),
  FOREIGN KEY(organization_id,requested_by_membership_id) REFERENCES app.memberships(organization_id,id),
  FOREIGN KEY(organization_id,decided_by_membership_id) REFERENCES app.memberships(organization_id,id)
);
CREATE TABLE app.task_queue (
  id app.entity_id PRIMARY KEY DEFAULT app.new_id(),
  organization_id app.entity_id NOT NULL REFERENCES app.organizations(id),
  project_id app.entity_id NOT NULL,
  agent_identity_id app.entity_id NOT NULL,
  idempotency_key text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('research','draft','simulate_campaign','follow_up','grant_draft')),
  payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object' AND octet_length(payload::text)<=32768),
  state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','waiting','completed','failed','cancelled','quarantined')),
  priority int NOT NULL DEFAULT 50 CHECK(priority BETWEEN 0 AND 100),
  attempts int NOT NULL DEFAULT 0 CHECK(attempts>=0),
  max_attempts int NOT NULL DEFAULT 3 CHECK(max_attempts BETWEEN 1 AND 10),
  fencing_token bigint NOT NULL DEFAULT 0,
  lease_owner text,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  available_at timestamptz NOT NULL DEFAULT app.utc_now(),
  last_reason text,
  created_at timestamptz NOT NULL DEFAULT app.utc_now(),
  updated_at timestamptz NOT NULL DEFAULT app.utc_now(),
  UNIQUE(organization_id,id),
  UNIQUE(organization_id,idempotency_key),
  FOREIGN KEY(organization_id,project_id) REFERENCES app.projects(organization_id,id),
  FOREIGN KEY(organization_id,agent_identity_id) REFERENCES app.agent_identities(organization_id,id)
);
CREATE INDEX task_queue_ready ON app.task_queue(organization_id,priority DESC,available_at) WHERE state='queued';
CREATE TABLE app.agent_runs (
  id app.entity_id PRIMARY KEY DEFAULT app.new_id(),
  organization_id app.entity_id NOT NULL,
  task_id app.entity_id NOT NULL,
  fencing_token bigint NOT NULL,
  mode text NOT NULL CHECK(mode IN ('simulation','live')),
  state text NOT NULL CHECK(state IN ('running','completed','failed','quarantined')),
  model_id text,
  result jsonb,
  reason_code text,
  started_at timestamptz NOT NULL DEFAULT app.utc_now(),
  ended_at timestamptz,
  UNIQUE(organization_id,id),
  UNIQUE(organization_id,task_id,fencing_token),
  FOREIGN KEY(organization_id,task_id) REFERENCES app.task_queue(organization_id,id)
);
CREATE TABLE app.run_checkpoints (
  id app.entity_id PRIMARY KEY DEFAULT app.new_id(),
  organization_id app.entity_id NOT NULL,
  run_id app.entity_id NOT NULL,
  sequence int NOT NULL CHECK(sequence>0),
  state jsonb NOT NULL CHECK(jsonb_typeof(state)='object' AND octet_length(state::text)<=65536),
  content_hash text NOT NULL CHECK(content_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT app.utc_now(),
  UNIQUE(organization_id,run_id,sequence),
  FOREIGN KEY(organization_id,run_id) REFERENCES app.agent_runs(organization_id,id)
);
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['operation_events','event_outbox','policy_controls','spending_policies','budget_reservations','reservation_policy_links','money_entries','action_approvals','task_queue','agent_runs','run_checkpoints'] LOOP
  EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format('CREATE POLICY %I ON app.%I USING (organization_id=app.current_organization_id()) WITH CHECK (organization_id=app.current_organization_id())',name||'_tenant',name);
 END LOOP;
END $$;
CREATE FUNCTION app.deny_operation_evidence_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'operation evidence is append-only' USING ERRCODE='42501'; END $$;
CREATE TRIGGER operation_events_immutable BEFORE UPDATE OR DELETE ON app.operation_events FOR EACH ROW EXECUTE FUNCTION app.deny_operation_evidence_mutation();
CREATE TRIGGER money_entries_immutable BEFORE UPDATE OR DELETE ON app.money_entries FOR EACH ROW EXECUTE FUNCTION app.deny_operation_evidence_mutation();
CREATE TRIGGER run_checkpoints_immutable BEFORE UPDATE OR DELETE ON app.run_checkpoints FOR EACH ROW EXECUTE FUNCTION app.deny_operation_evidence_mutation();
