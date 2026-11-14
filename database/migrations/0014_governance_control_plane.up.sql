-- DOTS-032..043 governance control plane: hierarchical budgets with a double-entry
-- allocation ledger, deterministic policy decisions, exact-hash owner approvals,
-- scoped kill switches, dead-letter evidence, encrypted credential references,
-- retention annotations, evidence holds, deletion requests and export jobs.

CREATE TABLE app.budget_scopes (
  id app.entity_id PRIMARY KEY DEFAULT app.new_id(),
  organization_id app.entity_id NOT NULL REFERENCES app.organizations(id),
  scope_kind text NOT NULL CHECK (scope_kind IN ('tenant','project','campaign','provider','model','channel')),
  scope_key text NOT NULL CHECK (scope_key ~ '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,119}$'),
  project_id app.entity_id,
  campaign_id app.entity_id,
  ceiling_cents bigint CHECK (ceiling_cents IS NULL OR (ceiling_cents >= 0 AND ceiling_cents <= 9007199254740991)),
  daily_limit_cents bigint CHECK (daily_limit_cents IS NULL OR (daily_limit_cents >= 0 AND daily_limit_cents <= 9007199254740991)),
  alert_threshold_bps int NOT NULL DEFAULT 8000 CHECK (alert_threshold_bps BETWEEN 1 AND 10000),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by_membership_id app.entity_id NOT NULL,
  created_at timestamptz NOT NULL DEFAULT app.utc_now(),
  updated_at timestamptz NOT NULL DEFAULT app.utc_now(),
  -- Allocation (tree) scopes take their total from the ledger; cross-cutting scopes carry an explicit ceiling.
  CHECK ((scope_kind IN ('tenant','project','campaign')) = (ceiling_cents IS NULL)),
  CHECK (scope_kind <> 'tenant' OR scope_key = 'organization'),
  CHECK (CASE scope_kind
    WHEN 'project' THEN project_id IS NOT NULL AND campaign_id IS NULL
    WHEN 'campaign' THEN project_id IS NOT NULL AND campaign_id IS NOT NULL
    ELSE project_id IS NULL AND campaign_id IS NULL END),
  UNIQUE (organization_id, scope_kind, scope_key),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, project_id) REFERENCES app.projects(organization_id, id),
  FOREIGN KEY (organization_id, campaign_id) REFERENCES app.campaigns(organization_id, id),
  FOREIGN KEY (organization_id, updated_by_membership_id) REFERENCES app.memberships(organization_id, id)
);

CREATE TABLE app.governed_reservations (
  id app.entity_id PRIMARY KEY DEFAULT app.new_id(),
  organization_id app.entity_id NOT NULL REFERENCES app.organizations(id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  funding_scope_id app.entity_id NOT NULL,
  project_id app.entity_id,
  campaign_id app.entity_id,
  provider_id text,
  model_id text,
  channel text,
  purpose text NOT NULL CHECK (length(purpose) BETWEEN 1 AND 200),
  estimate_cents bigint NOT NULL CHECK (estimate_cents >= 0 AND estimate_cents <= 9007199254740991),
  actual_cents bigint CHECK (actual_cents >= 0 AND actual_cents <= estimate_cents),
  status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','settled','released')),
  final_reason text,
  evidence_ref text CHECK (evidence_ref IS NULL OR length(evidence_ref) BETWEEN 1 AND 240),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT app.utc_now(),
  finalized_at timestamptz,
  CHECK ((status = 'reserved') = (finalized_at IS NULL)),
  UNIQUE (organization_id, idempotency_key),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, funding_scope_id) REFERENCES app.budget_scopes(organization_id, id),
  FOREIGN KEY (organization_id, project_id) REFERENCES app.projects(organization_id, id),
  FOREIGN KEY (organization_id, campaign_id) REFERENCES app.campaigns(organization_id, id)
);
CREATE INDEX governed_reservations_usage ON app.governed_reservations(organization_id, created_at DESC);

CREATE TABLE app.budget_journals (
  id app.entity_id PRIMARY KEY DEFAULT app.new_id(),
  organization_id app.entity_id NOT NULL REFERENCES app.organizations(id),
  kind text NOT NULL CHECK (kind IN ('funding','defunding','transfer','reservation','settlement','release')),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  authorization_ref text,
  reservation_id app.entity_id,
  created_by_actor text NOT NULL CHECK (length(created_by_actor) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT app.utc_now(),
  CHECK (kind <> 'funding' OR (authorization_ref IS NOT NULL AND length(btrim(authorization_ref)) > 0)),
  UNIQUE (organization_id, idempotency_key),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, reservation_id) REFERENCES app.governed_reservations(organization_id, id)
);

CREATE TABLE app.budget_ledger_entries (
  id app.entity_id PRIMARY KEY DEFAULT app.new_id(),
  organization_id app.entity_id NOT NULL,
  journal_id app.entity_id NOT NULL,
  account text NOT NULL CHECK (account IN ('owner_funding','scope','reserved','spent')),
  scope_id app.entity_id,
  reservation_id app.entity_id,
  amount_cents bigint NOT NULL CHECK (amount_cents <> 0 AND amount_cents BETWEEN -9007199254740991 AND 9007199254740991),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  created_at timestamptz NOT NULL DEFAULT app.utc_now(),
  CHECK ((account = 'scope') = (scope_id IS NOT NULL)),
  CHECK ((account IN ('reserved','spent')) = (reservation_id IS NOT NULL)),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, journal_id) REFERENCES app.budget_journals(organization_id, id),
  FOREIGN KEY (organization_id, scope_id) REFERENCES app.budget_scopes(organization_id, id),
  FOREIGN KEY (organization_id, reservation_id) REFERENCES app.governed_reservations(organization_id, id)
);
CREATE INDEX budget_ledger_entries_scope ON app.budget_ledger_entries(organization_id, scope_id);

-- Double-entry invariant: every journal must balance to zero when its transaction commits.
CREATE FUNCTION app.assert_budget_journal_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE total numeric;
BEGIN
  SELECT COALESCE(sum(amount_cents), 0) INTO total FROM app.budget_ledger_entries
    WHERE organization_id = NEW.organization_id AND journal_id = NEW.journal_id;
  IF total <> 0 THEN RAISE EXCEPTION 'budget journal % is unbalanced', NEW.journal_id USING ERRCODE = '23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER budget_ledger_balanced AFTER INSERT ON app.budget_ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.assert_budget_journal_balanced();

CREATE TABLE app.budget_alerts (
  id app.entity_id PRIMARY KEY DEFAULT app.new_id(),
  organization_id app.entity_id NOT NULL,
  scope_id app.entity_id NOT NULL,
  period text NOT NULL CHECK (period IN ('total','daily')),
  period_key text NOT NULL CHECK (length(period_key) BETWEEN 1 AND 20),
  threshold_bps int NOT NULL,
  usage_cents bigint NOT NULL,
  limit_cents bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT app.utc_now(),
  UNIQUE (organization_id, scope_id, period, period_key),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, scope_id) REFERENCES app.budget_scopes(organization_id, id)
);

CREATE TABLE app.policy_decisions (
  id app.entity_id PRIMARY KEY DEFAULT app.new_id(),
  organization_id app.entity_id NOT NULL REFERENCES app.organizations(id),
  subject_kind text NOT NULL CHECK (subject_kind ~ '^[a-z][a-z_]{1,39}$'),
  subject_id app.entity_id,
  input_hash text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  decision text NOT NULL CHECK (decision IN ('ALLOW','REVIEW','DENY')),
  rules jsonb NOT NULL CHECK (jsonb_typeof(rules) = 'array' AND octet_length(rules::text) <= 16384),
  ruleset_version text NOT NULL,
  decided_by_membership_id app.entity_id NOT NULL,
  created_at timestamptz NOT NULL DEFAULT app.utc_now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, decided_by_membership_id) REFERENCES app.memberships(organization_id, id)
);
CREATE INDEX policy_decisions_timeline ON app.policy_decisions(organization_id, created_at DESC);

ALTER TABLE app.action_approvals
  ADD COLUMN title text CHECK (title IS NULL OR length(title) BETWEEN 1 AND 200),
  ADD COLUMN content_hash text CHECK (content_hash IS NULL OR content_hash ~ '^[0-9a-f]{64}$'),
  ADD COLUMN audience_hash text CHECK (audience_hash IS NULL OR audience_hash ~ '^[0-9a-f]{64}$'),
  ADD COLUMN audience_count int CHECK (audience_count IS NULL OR audience_count >= 0),
  ADD COLUMN campaign_revision int CHECK (campaign_revision IS NULL OR campaign_revision > 0),
  ADD COLUMN budget_cents bigint CHECK (budget_cents IS NULL OR budget_cents >= 0),
  ADD COLUMN sender_identity text CHECK (sender_identity IS NULL OR length(sender_identity) BETWEEN 1 AND 200),
  ADD COLUMN consequences jsonb CHECK (consequences IS NULL OR jsonb_typeof(consequences) = 'array');
ALTER TABLE app.action_approvals DROP CONSTRAINT action_approvals_status_check;
ALTER TABLE app.action_approvals ADD CONSTRAINT action_approvals_status_check
  CHECK (status IN ('pending','approved','rejected','expired','consumed','revoked'));

CREATE TABLE app.kill_switches (
  id app.entity_id PRIMARY KEY DEFAULT app.new_id(),
  organization_id app.entity_id NOT NULL REFERENCES app.organizations(id),
  scope_kind text NOT NULL CHECK (scope_kind IN ('organization','campaign','provider','model','channel')),
  scope_key text NOT NULL CHECK (scope_key ~ '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,119}$'),
  active boolean NOT NULL DEFAULT true,
  rationale text NOT NULL CHECK (length(rationale) BETWEEN 1 AND 1000),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by_membership_id app.entity_id NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT app.utc_now(),
  CHECK (scope_kind <> 'organization' OR scope_key = 'organization'),
  UNIQUE (organization_id, scope_kind, scope_key),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, updated_by_membership_id) REFERENCES app.memberships(organization_id, id)
);

CREATE TABLE app.kill_switch_audit (
  id app.entity_id PRIMARY KEY DEFAULT app.new_id(),
  organization_id app.entity_id NOT NULL,
  kill_switch_id app.entity_id NOT NULL,
  action text NOT NULL CHECK (action IN ('engaged','released')),
  rationale text NOT NULL CHECK (length(rationale) BETWEEN 1 AND 1000),
  actor_membership_id app.entity_id NOT NULL,
  preserved_task_count int NOT NULL DEFAULT 0 CHECK (preserved_task_count >= 0),
  created_at timestamptz NOT NULL DEFAULT app.utc_now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, kill_switch_id) REFERENCES app.kill_switches(organization_id, id),
  FOREIGN KEY (organization_id, actor_membership_id) REFERENCES app.memberships(organization_id, id)
);

ALTER TABLE app.task_queue DROP CONSTRAINT task_queue_state_check;
ALTER TABLE app.task_queue ADD CONSTRAINT task_queue_state_check
  CHECK (state IN ('queued','running','waiting','completed','failed','cancelled','quarantined','dead_letter'));

CREATE TABLE app.task_dead_letters (
  id app.entity_id PRIMARY KEY DEFAULT app.new_id(),
  organization_id app.entity_id NOT NULL,
  task_id app.entity_id NOT NULL,
  attempts int NOT NULL CHECK (attempts >= 0),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 200),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT app.utc_now(),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, task_id) REFERENCES app.task_queue(organization_id, id)
);

CREATE TABLE app.credential_references (
  id app.entity_id PRIMARY KEY,
  organization_id app.entity_id NOT NULL REFERENCES app.organizations(id),
  provider_id text NOT NULL CHECK (provider_id ~ '^[a-z][a-z0-9_-]{1,39}$'),
  label text NOT NULL CHECK (label ~ '^[A-Za-z0-9][A-Za-z0-9 _.-]{0,79}$'),
  kind text NOT NULL CHECK (kind IN ('api_key','oauth_refresh_token','webhook_secret')),
  ciphertext text CHECK (ciphertext IS NULL OR octet_length(ciphertext) <= 16384),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{16}$'),
  last4 text NOT NULL CHECK (length(last4) BETWEEN 1 AND 4),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','rotated','revoked')),
  replaces_id app.entity_id,
  revocation_reason text CHECK (revocation_reason IS NULL OR length(revocation_reason) BETWEEN 1 AND 500),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by_membership_id app.entity_id NOT NULL,
  created_at timestamptz NOT NULL DEFAULT app.utc_now(),
  rotated_at timestamptz,
  revoked_at timestamptz,
  -- Only active references keep ciphertext; rotation and revocation crypto-shred the secret.
  CHECK ((status = 'active') = (ciphertext IS NOT NULL)),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, replaces_id) REFERENCES app.credential_references(organization_id, id),
  FOREIGN KEY (organization_id, created_by_membership_id) REFERENCES app.memberships(organization_id, id)
);
CREATE UNIQUE INDEX credential_references_one_active ON app.credential_references(organization_id, provider_id, label) WHERE status = 'active';

CREATE TABLE app.retention_policies (
  id app.entity_id PRIMARY KEY DEFAULT app.new_id(),
  organization_id app.entity_id NOT NULL REFERENCES app.organizations(id),
  record_kind text NOT NULL CHECK (record_kind IN ('crm_contacts','messages','contact_events','operation_events','policy_decisions','credential_references','export_jobs','money_entries')),
  retention_days int NOT NULL CHECK (retention_days BETWEEN 1 AND 3650),
  action text NOT NULL CHECK (action IN ('redact','retain_as_evidence','crypto_shred')),
  basis text NOT NULL CHECK (length(basis) BETWEEN 1 AND 500),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by_membership_id app.entity_id NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT app.utc_now(),
  UNIQUE (organization_id, record_kind),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, updated_by_membership_id) REFERENCES app.memberships(organization_id, id)
);

CREATE TABLE app.evidence_holds (
  id app.entity_id PRIMARY KEY DEFAULT app.new_id(),
  organization_id app.entity_id NOT NULL REFERENCES app.organizations(id),
  subject_kind text NOT NULL CHECK (subject_kind IN ('contact','campaign','organization')),
  subject_id app.entity_id NOT NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
  active boolean NOT NULL DEFAULT true,
  created_by_membership_id app.entity_id NOT NULL,
  created_at timestamptz NOT NULL DEFAULT app.utc_now(),
  released_by_membership_id app.entity_id,
  released_at timestamptz,
  release_rationale text,
  CHECK (active = (released_at IS NULL)),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, created_by_membership_id) REFERENCES app.memberships(organization_id, id),
  FOREIGN KEY (organization_id, released_by_membership_id) REFERENCES app.memberships(organization_id, id)
);

CREATE TABLE app.deletion_requests (
  id app.entity_id PRIMARY KEY DEFAULT app.new_id(),
  organization_id app.entity_id NOT NULL REFERENCES app.organizations(id),
  subject_kind text NOT NULL CHECK (subject_kind IN ('contact')),
  subject_id app.entity_id NOT NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received','held','completed','rejected')),
  outcome jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(outcome) = 'object'),
  requested_by_membership_id app.entity_id NOT NULL,
  created_at timestamptz NOT NULL DEFAULT app.utc_now(),
  decided_at timestamptz,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, requested_by_membership_id) REFERENCES app.memberships(organization_id, id)
);

CREATE TABLE app.export_jobs (
  id app.entity_id PRIMARY KEY DEFAULT app.new_id(),
  organization_id app.entity_id NOT NULL REFERENCES app.organizations(id),
  scope text NOT NULL CHECK (scope IN ('audit','ledger','contacts')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','completed','failed')),
  row_count int CHECK (row_count IS NULL OR row_count >= 0),
  artifact_hash text CHECK (artifact_hash IS NULL OR artifact_hash ~ '^[0-9a-f]{64}$'),
  requested_by_membership_id app.entity_id NOT NULL,
  created_at timestamptz NOT NULL DEFAULT app.utc_now(),
  completed_at timestamptz,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, requested_by_membership_id) REFERENCES app.memberships(organization_id, id)
);

DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['budget_scopes','governed_reservations','budget_journals','budget_ledger_entries','budget_alerts','policy_decisions','kill_switches','kill_switch_audit','task_dead_letters','credential_references','retention_policies','evidence_holds','deletion_requests','export_jobs'] LOOP
  EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format('CREATE POLICY %I ON app.%I USING (organization_id=app.current_organization_id()) WITH CHECK (organization_id=app.current_organization_id())',name||'_tenant',name);
 END LOOP;
END $$;

CREATE TRIGGER budget_journals_immutable BEFORE UPDATE OR DELETE ON app.budget_journals FOR EACH ROW EXECUTE FUNCTION app.deny_operation_evidence_mutation();
CREATE TRIGGER budget_ledger_entries_immutable BEFORE UPDATE OR DELETE ON app.budget_ledger_entries FOR EACH ROW EXECUTE FUNCTION app.deny_operation_evidence_mutation();
CREATE TRIGGER budget_alerts_immutable BEFORE UPDATE OR DELETE ON app.budget_alerts FOR EACH ROW EXECUTE FUNCTION app.deny_operation_evidence_mutation();
CREATE TRIGGER policy_decisions_immutable BEFORE UPDATE OR DELETE ON app.policy_decisions FOR EACH ROW EXECUTE FUNCTION app.deny_operation_evidence_mutation();
CREATE TRIGGER kill_switch_audit_immutable BEFORE UPDATE OR DELETE ON app.kill_switch_audit FOR EACH ROW EXECUTE FUNCTION app.deny_operation_evidence_mutation();
CREATE TRIGGER task_dead_letters_immutable BEFORE UPDATE OR DELETE ON app.task_dead_letters FOR EACH ROW EXECUTE FUNCTION app.deny_operation_evidence_mutation();
