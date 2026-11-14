-- DOTS-082..093 Campaign Studio: lifecycle, immutable revisions, versioned audiences/budgets,
-- templates, variants, price guardrails, simulations and idempotent work generation.

-- Lifecycle states. Legacy states are mapped: simulated -> validated, awaiting_approval -> ready_for_approval.
-- FORCE RLS would hide every tenant row from the migration owner, so it is lifted only for the mapping update.
ALTER TABLE app.campaigns DROP CONSTRAINT campaigns_state_check;
ALTER TABLE app.campaigns NO FORCE ROW LEVEL SECURITY;
UPDATE app.campaigns SET state = CASE state WHEN 'simulated' THEN 'validated' WHEN 'awaiting_approval' THEN 'ready_for_approval' ELSE state END
 WHERE state IN ('simulated','awaiting_approval');
ALTER TABLE app.campaigns FORCE ROW LEVEL SECURITY;
ALTER TABLE app.campaigns ADD CONSTRAINT campaigns_state_check
 CHECK (state IN ('draft','validated','ready_for_approval','approved','scheduled','active','paused','completed','archived','aborted'));

CREATE TABLE app.message_templates (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),
 organization_id app.entity_id NOT NULL REFERENCES app.organizations(id),
 project_id app.entity_id,
 label text NOT NULL CHECK (length(label) BETWEEN 1 AND 160),
 channel text NOT NULL DEFAULT 'email' CHECK (channel IN ('email','sms')),
 status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
 latest_revision int NOT NULL DEFAULT 0 CHECK (latest_revision >= 0),
 version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
 created_at timestamptz NOT NULL DEFAULT app.utc_now(),
 updated_at timestamptz NOT NULL DEFAULT app.utc_now(),
 UNIQUE (organization_id, id),
 FOREIGN KEY (organization_id, project_id) REFERENCES app.projects(organization_id, id)
);

CREATE TABLE app.message_template_revisions (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),
 organization_id app.entity_id NOT NULL,
 template_id app.entity_id NOT NULL,
 revision int NOT NULL CHECK (revision > 0),
 subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 240),
 body_text text NOT NULL CHECK (length(body_text) BETWEEN 1 AND 20000),
 body_html text CHECK (body_html IS NULL OR length(body_html) <= 100000),
 fact_ids jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(fact_ids) = 'array'),
 variables jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(variables) = 'array'),
 content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
 created_by_membership_id app.entity_id NOT NULL,
 created_at timestamptz NOT NULL DEFAULT app.utc_now(),
 UNIQUE (organization_id, id),
 UNIQUE (organization_id, template_id, revision),
 FOREIGN KEY (organization_id, template_id) REFERENCES app.message_templates(organization_id, id),
 FOREIGN KEY (organization_id, created_by_membership_id) REFERENCES app.memberships(organization_id, id)
);

CREATE TABLE app.campaign_audience_revisions (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),
 organization_id app.entity_id NOT NULL,
 campaign_id app.entity_id NOT NULL,
 revision int NOT NULL CHECK (revision > 0),
 segment jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(segment) = 'object' AND octet_length(segment::text) <= 8192),
 contact_ids jsonb NOT NULL CHECK (jsonb_typeof(contact_ids) = 'array' AND jsonb_array_length(contact_ids) <= 5000),
 contact_count int NOT NULL CHECK (contact_count >= 0),
 audience_hash text NOT NULL CHECK (audience_hash ~ '^[0-9a-f]{64}$'),
 created_by_membership_id app.entity_id NOT NULL,
 created_at timestamptz NOT NULL DEFAULT app.utc_now(),
 UNIQUE (organization_id, id),
 UNIQUE (organization_id, campaign_id, revision),
 FOREIGN KEY (organization_id, campaign_id) REFERENCES app.campaigns(organization_id, id),
 FOREIGN KEY (organization_id, created_by_membership_id) REFERENCES app.memberships(organization_id, id)
);

CREATE TABLE app.campaign_budget_revisions (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),
 organization_id app.entity_id NOT NULL,
 campaign_id app.entity_id NOT NULL,
 revision int NOT NULL CHECK (revision > 0),
 total_cents bigint NOT NULL CHECK (total_cents >= 0 AND total_cents <= 9007199254740991),
 per_message_max_cents bigint NOT NULL CHECK (per_message_max_cents >= 0 AND per_message_max_cents <= 9007199254740991),
 currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
 authorization_ref text CHECK (authorization_ref IS NULL OR length(btrim(authorization_ref)) BETWEEN 1 AND 200),
 created_by_membership_id app.entity_id NOT NULL,
 created_at timestamptz NOT NULL DEFAULT app.utc_now(),
 CHECK (total_cents = 0 OR authorization_ref IS NOT NULL),
 CHECK (per_message_max_cents <= total_cents),
 UNIQUE (organization_id, id),
 UNIQUE (organization_id, campaign_id, revision),
 FOREIGN KEY (organization_id, campaign_id) REFERENCES app.campaigns(organization_id, id),
 FOREIGN KEY (organization_id, created_by_membership_id) REFERENCES app.memberships(organization_id, id)
);

ALTER TABLE app.campaigns
 ADD COLUMN offer_id app.entity_id,
 ADD COLUMN mailbox_id app.entity_id,
 ADD COLUMN channel text NOT NULL DEFAULT 'email' CHECK (channel IN ('email','sms')),
 ADD COLUMN allowed_countries text[] NOT NULL DEFAULT '{}' CHECK (cardinality(allowed_countries) <= 60),
 ADD COLUMN timezone text NOT NULL DEFAULT 'UTC' CHECK (length(timezone) BETWEEN 1 AND 64),
 ADD COLUMN send_window_start_hour int NOT NULL DEFAULT 9 CHECK (send_window_start_hour BETWEEN 0 AND 23),
 ADD COLUMN send_window_end_hour int NOT NULL DEFAULT 17 CHECK (send_window_end_hour BETWEEN 1 AND 24),
 ADD COLUMN weekdays_only boolean NOT NULL DEFAULT true,
 ADD COLUMN frequency_cap int NOT NULL DEFAULT 1 CHECK (frequency_cap BETWEEN 1 AND 10),
 ADD COLUMN schedule_start_at timestamptz,
 ADD COLUMN schedule_end_at timestamptz,
 ADD COLUMN template_revision_id app.entity_id,
 ADD COLUMN audience_revision_id app.entity_id,
 ADD COLUMN budget_revision_id app.entity_id,
 ADD COLUMN priority int NOT NULL DEFAULT 50 CHECK (priority BETWEEN 0 AND 100),
 ADD COLUMN agent_identity_id app.entity_id,
 ADD COLUMN approval_id app.entity_id,
 ADD COLUMN authority_ref text CHECK (authority_ref IS NULL OR length(btrim(authority_ref)) BETWEEN 1 AND 200),
 ADD CONSTRAINT campaigns_send_window_check CHECK (send_window_end_hour > send_window_start_hour),
 ADD CONSTRAINT campaigns_schedule_check CHECK (schedule_end_at IS NULL OR schedule_start_at IS NULL OR schedule_end_at > schedule_start_at),
 ADD CONSTRAINT campaigns_offer_fk FOREIGN KEY (organization_id, project_id, offer_id) REFERENCES app.offers(organization_id, project_id, id),
 ADD CONSTRAINT campaigns_mailbox_fk FOREIGN KEY (organization_id, mailbox_id) REFERENCES app.mailboxes(organization_id, id),
 ADD CONSTRAINT campaigns_template_revision_fk FOREIGN KEY (organization_id, template_revision_id) REFERENCES app.message_template_revisions(organization_id, id),
 ADD CONSTRAINT campaigns_audience_revision_fk FOREIGN KEY (organization_id, audience_revision_id) REFERENCES app.campaign_audience_revisions(organization_id, id),
 ADD CONSTRAINT campaigns_budget_revision_fk FOREIGN KEY (organization_id, budget_revision_id) REFERENCES app.campaign_budget_revisions(organization_id, id),
 ADD CONSTRAINT campaigns_agent_fk FOREIGN KEY (organization_id, agent_identity_id) REFERENCES app.agent_identities(organization_id, id),
 ADD CONSTRAINT campaigns_approval_fk FOREIGN KEY (organization_id, approval_id) REFERENCES app.action_approvals(organization_id, id);

CREATE TABLE app.campaign_variants (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),
 organization_id app.entity_id NOT NULL,
 campaign_id app.entity_id NOT NULL,
 label text NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
 strategy_id app.entity_id NOT NULL,
 template_revision_id app.entity_id NOT NULL,
 weight int NOT NULL DEFAULT 1 CHECK (weight BETWEEN 1 AND 10000),
 eligibility jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(eligibility) = 'object' AND octet_length(eligibility::text) <= 4096),
 status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
 created_at timestamptz NOT NULL DEFAULT app.utc_now(),
 retired_at timestamptz,
 UNIQUE (organization_id, id),
 FOREIGN KEY (organization_id, campaign_id) REFERENCES app.campaigns(organization_id, id),
 FOREIGN KEY (organization_id, strategy_id) REFERENCES app.strategies(organization_id, id),
 FOREIGN KEY (organization_id, template_revision_id) REFERENCES app.message_template_revisions(organization_id, id)
);

CREATE TABLE app.offer_price_rules (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),
 organization_id app.entity_id NOT NULL,
 project_id app.entity_id NOT NULL,
 offer_id app.entity_id NOT NULL,
 authorized_prices_cents bigint[] NOT NULL CHECK (cardinality(authorized_prices_cents) BETWEEN 1 AND 50),
 max_discount_bp int NOT NULL DEFAULT 0 CHECK (max_discount_bp BETWEEN 0 AND 10000),
 restricted_phrases text[] NOT NULL DEFAULT '{}' CHECK (cardinality(restricted_phrases) <= 100),
 version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
 updated_by_membership_id app.entity_id NOT NULL,
 created_at timestamptz NOT NULL DEFAULT app.utc_now(),
 updated_at timestamptz NOT NULL DEFAULT app.utc_now(),
 UNIQUE (organization_id, id),
 UNIQUE (organization_id, offer_id),
 FOREIGN KEY (organization_id, project_id, offer_id) REFERENCES app.offers(organization_id, project_id, id),
 FOREIGN KEY (organization_id, updated_by_membership_id) REFERENCES app.memberships(organization_id, id)
);

CREATE TABLE app.campaign_price_exceptions (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),
 organization_id app.entity_id NOT NULL,
 campaign_id app.entity_id NOT NULL,
 amount_cents bigint CHECK (amount_cents IS NULL OR (amount_cents > 0 AND amount_cents <= 9007199254740991)),
 discount_bp int CHECK (discount_bp IS NULL OR discount_bp BETWEEN 1 AND 10000),
 reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
 approval_id app.entity_id NOT NULL,
 created_by_membership_id app.entity_id NOT NULL,
 created_at timestamptz NOT NULL DEFAULT app.utc_now(),
 CHECK (amount_cents IS NOT NULL OR discount_bp IS NOT NULL),
 UNIQUE (organization_id, id),
 UNIQUE (organization_id, approval_id),
 FOREIGN KEY (organization_id, campaign_id) REFERENCES app.campaigns(organization_id, id),
 FOREIGN KEY (organization_id, approval_id) REFERENCES app.action_approvals(organization_id, id),
 FOREIGN KEY (organization_id, created_by_membership_id) REFERENCES app.memberships(organization_id, id)
);

CREATE TABLE app.campaign_simulations (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),
 organization_id app.entity_id NOT NULL,
 campaign_id app.entity_id NOT NULL,
 campaign_revision int NOT NULL CHECK (campaign_revision > 0),
 binding_hash text NOT NULL CHECK (binding_hash ~ '^[0-9a-f]{64}$'),
 blocking_count int NOT NULL CHECK (blocking_count >= 0),
 network_requests int NOT NULL DEFAULT 0 CHECK (network_requests = 0),
 billable_requests int NOT NULL DEFAULT 0 CHECK (billable_requests = 0),
 messages_sent int NOT NULL DEFAULT 0 CHECK (messages_sent = 0),
 report jsonb NOT NULL CHECK (jsonb_typeof(report) = 'object' AND octet_length(report::text) <= 262144),
 created_by_membership_id app.entity_id NOT NULL,
 created_at timestamptz NOT NULL DEFAULT app.utc_now(),
 UNIQUE (organization_id, id),
 FOREIGN KEY (organization_id, campaign_id) REFERENCES app.campaigns(organization_id, id),
 FOREIGN KEY (organization_id, created_by_membership_id) REFERENCES app.memberships(organization_id, id)
);
CREATE INDEX campaign_simulations_latest ON app.campaign_simulations(organization_id, campaign_id, created_at DESC);

CREATE TABLE app.campaign_work_items (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),
 organization_id app.entity_id NOT NULL,
 campaign_id app.entity_id NOT NULL,
 contact_id app.entity_id NOT NULL,
 campaign_revision int NOT NULL CHECK (campaign_revision > 0),
 approval_id app.entity_id NOT NULL,
 variant_id app.entity_id,
 strategy_id app.entity_id,
 template_revision_id app.entity_id NOT NULL,
 task_id app.entity_id NOT NULL,
 dedupe_key text NOT NULL CHECK (length(dedupe_key) BETWEEN 1 AND 200),
 max_cost_cents bigint NOT NULL DEFAULT 0 CHECK (max_cost_cents >= 0),
 created_at timestamptz NOT NULL DEFAULT app.utc_now(),
 UNIQUE (organization_id, id),
 UNIQUE (organization_id, dedupe_key),
 FOREIGN KEY (organization_id, campaign_id) REFERENCES app.campaigns(organization_id, id),
 FOREIGN KEY (organization_id, contact_id) REFERENCES app.crm_contacts(organization_id, id),
 FOREIGN KEY (organization_id, approval_id) REFERENCES app.action_approvals(organization_id, id),
 FOREIGN KEY (organization_id, variant_id) REFERENCES app.campaign_variants(organization_id, id),
 FOREIGN KEY (organization_id, strategy_id) REFERENCES app.strategies(organization_id, id),
 FOREIGN KEY (organization_id, template_revision_id) REFERENCES app.message_template_revisions(organization_id, id),
 FOREIGN KEY (organization_id, task_id) REFERENCES app.task_queue(organization_id, id)
);
CREATE INDEX campaign_work_items_campaign ON app.campaign_work_items(organization_id, campaign_id, created_at);
CREATE INDEX campaign_work_items_contact ON app.campaign_work_items(organization_id, contact_id, created_at);

DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['message_templates','message_template_revisions','campaign_audience_revisions','campaign_budget_revisions','campaign_variants','offer_price_rules','campaign_price_exceptions','campaign_simulations','campaign_work_items'] LOOP
  EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', name);
  EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', name);
  EXECUTE format('CREATE POLICY %I ON app.%I USING (organization_id=app.current_organization_id()) WITH CHECK (organization_id=app.current_organization_id())', name||'_tenant', name);
 END LOOP;
END $$;

-- Immutable evidence: revisions, exceptions, simulations and work-item lineage are append-only.
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['message_template_revisions','campaign_audience_revisions','campaign_budget_revisions','campaign_price_exceptions','campaign_simulations','campaign_work_items'] LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON app.%I FOR EACH ROW EXECUTE FUNCTION app.deny_operation_evidence_mutation()', name||'_immutable', name);
 END LOOP;
END $$;

-- Variants may only be retired; their strategy/content lineage cannot be rewritten.
CREATE FUNCTION app.preserve_campaign_variant() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'campaign variants are append-only' USING ERRCODE='42501'; END IF;
 IF (to_jsonb(NEW)-ARRAY['status','retired_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','retired_at']) OR OLD.status='retired' THEN
  RAISE EXCEPTION 'campaign variant lineage is immutable' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER campaign_variants_lineage BEFORE UPDATE OR DELETE ON app.campaign_variants FOR EACH ROW EXECUTE FUNCTION app.preserve_campaign_variant();
