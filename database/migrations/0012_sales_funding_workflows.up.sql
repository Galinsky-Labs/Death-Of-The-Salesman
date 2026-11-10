CREATE TABLE app.agent_configuration (
 organization_id app.entity_id NOT NULL,agent_identity_id app.entity_id NOT NULL,
 role_label text NOT NULL DEFAULT 'Sales strategist',provider_id text, strategy_id app.entity_id,
 daily_task_limit int NOT NULL DEFAULT 10 CHECK(daily_task_limit BETWEEN 1 AND 100),
 version bigint NOT NULL DEFAULT 1,updated_at timestamptz NOT NULL DEFAULT app.utc_now(),
 PRIMARY KEY(organization_id,agent_identity_id),FOREIGN KEY(organization_id,agent_identity_id) REFERENCES app.agent_identities(organization_id,id)
);
CREATE TABLE app.crm_accounts (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(), organization_id app.entity_id NOT NULL REFERENCES app.organizations(id),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 160), website text, sector text,
 created_at timestamptz NOT NULL DEFAULT app.utc_now(), UNIQUE(organization_id,id)
);
CREATE TABLE app.crm_contacts (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(), organization_id app.entity_id NOT NULL REFERENCES app.organizations(id), account_id app.entity_id,
 display_name text NOT NULL CHECK(length(display_name) BETWEEN 1 AND 160), email text, email_hash text NOT NULL CHECK(email_hash ~ '^[0-9a-f]{64}$'),
 role_title text, status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','suppressed','archived','redacted')),
 consent text NOT NULL DEFAULT 'unknown' CHECK(consent IN ('unknown','opted_in','existing_customer','business_reviewed','opted_out')),
 lawful_source text NOT NULL CHECK(length(lawful_source) BETWEEN 1 AND 500), jurisdiction text NOT NULL DEFAULT 'unreviewed',
 consent_evidence text, owner_agent_id app.entity_id, version bigint NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT app.utc_now(), updated_at timestamptz NOT NULL DEFAULT app.utc_now(),
 UNIQUE(organization_id,email_hash), UNIQUE(organization_id,id),
 FOREIGN KEY(organization_id,account_id) REFERENCES app.crm_accounts(organization_id,id),
 FOREIGN KEY(organization_id,owner_agent_id) REFERENCES app.agent_identities(organization_id,id)
);
CREATE INDEX crm_contacts_search ON app.crm_contacts USING gin(to_tsvector('simple',display_name||' '||coalesce(email,'')||' '||coalesce(role_title,'')));
CREATE TABLE app.contact_suppressions (
 organization_id app.entity_id NOT NULL REFERENCES app.organizations(id), email_hash text NOT NULL, reason text NOT NULL,
 source text NOT NULL CHECK(source IN ('owner','unsubscribe','complaint','bounce','privacy')),
 created_at timestamptz NOT NULL DEFAULT app.utc_now(), PRIMARY KEY(organization_id,email_hash)
);
CREATE TABLE app.contact_events (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(), organization_id app.entity_id NOT NULL, contact_id app.entity_id NOT NULL,
 kind text NOT NULL CHECK(kind IN ('note','consent','stage_change','inbound','outbound','meeting','handover')),
 content text NOT NULL CHECK(length(content)<=10000), source text NOT NULL CHECK(source IN ('owner','provider','simulation')),
 created_at timestamptz NOT NULL DEFAULT app.utc_now(), FOREIGN KEY(organization_id,contact_id) REFERENCES app.crm_contacts(organization_id,id)
);
CREATE TABLE app.deals (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(), organization_id app.entity_id NOT NULL, project_id app.entity_id NOT NULL,contact_id app.entity_id,
 label text NOT NULL CHECK(length(label) BETWEEN 1 AND 160),stage text NOT NULL DEFAULT 'new' CHECK(stage IN ('new','qualified','proposal','negotiation','won','lost')),
 value_cents bigint NOT NULL DEFAULT 0 CHECK(value_cents>=0),version bigint NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT app.utc_now(),updated_at timestamptz NOT NULL DEFAULT app.utc_now(),
 UNIQUE(organization_id,id),FOREIGN KEY(organization_id,project_id) REFERENCES app.projects(organization_id,id),FOREIGN KEY(organization_id,contact_id) REFERENCES app.crm_contacts(organization_id,id)
);
CREATE TABLE app.strategies (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),organization_id app.entity_id NOT NULL REFERENCES app.organizations(id),
 label text NOT NULL CHECK(length(label) BETWEEN 1 AND 120),instructions text NOT NULL CHECK(length(instructions) BETWEEN 1 AND 6000),
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','champion','challenger','archived')),version bigint NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT app.utc_now(),UNIQUE(organization_id,id)
);
ALTER TABLE app.agent_configuration ADD CONSTRAINT agent_configuration_strategy_fk FOREIGN KEY(organization_id,strategy_id) REFERENCES app.strategies(organization_id,id);
CREATE TABLE app.campaigns (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),organization_id app.entity_id NOT NULL,project_id app.entity_id NOT NULL,
 label text NOT NULL CHECK(length(label) BETWEEN 1 AND 160),purpose text NOT NULL CHECK(purpose IN ('product','grant','investment')),
 goal text NOT NULL CHECK(length(goal) BETWEEN 1 AND 2000),strategy_id app.entity_id,
 state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','simulated','awaiting_approval','active','paused','completed','archived')),
 revision int NOT NULL DEFAULT 1 CHECK(revision>0),budget_cents bigint NOT NULL DEFAULT 0 CHECK(budget_cents>=0),
 daily_limit int NOT NULL DEFAULT 10 CHECK(daily_limit BETWEEN 1 AND 100),cadence_days int NOT NULL DEFAULT 7 CHECK(cadence_days BETWEEN 1 AND 90),
 approved_revision int,approved_hash text,version bigint NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT app.utc_now(),updated_at timestamptz NOT NULL DEFAULT app.utc_now(),UNIQUE(organization_id,id),
 FOREIGN KEY(organization_id,project_id) REFERENCES app.projects(organization_id,id),FOREIGN KEY(organization_id,strategy_id) REFERENCES app.strategies(organization_id,id)
);
CREATE TABLE app.campaign_revisions (
 organization_id app.entity_id NOT NULL,campaign_id app.entity_id NOT NULL,revision int NOT NULL,snapshot jsonb NOT NULL,content_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT app.utc_now(),PRIMARY KEY(organization_id,campaign_id,revision),FOREIGN KEY(organization_id,campaign_id) REFERENCES app.campaigns(organization_id,id)
);
CREATE TABLE app.campaign_audience (
 organization_id app.entity_id NOT NULL,campaign_id app.entity_id NOT NULL,contact_id app.entity_id NOT NULL,
 PRIMARY KEY(organization_id,campaign_id,contact_id),FOREIGN KEY(organization_id,campaign_id) REFERENCES app.campaigns(organization_id,id),FOREIGN KEY(organization_id,contact_id) REFERENCES app.crm_contacts(organization_id,id)
);
CREATE TABLE app.mailboxes (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),organization_id app.entity_id NOT NULL REFERENCES app.organizations(id),
 label text NOT NULL,sender_email text NOT NULL,sender_name text NOT NULL,business_address text NOT NULL,
 provider text NOT NULL CHECK(provider IN ('resend','generic')),verified boolean NOT NULL DEFAULT false,
 status text NOT NULL DEFAULT 'disabled' CHECK(status IN ('disabled','active','paused')),
 credential_env_ref text NOT NULL DEFAULT 'EMAIL_DELIVERY_TOKEN',created_at timestamptz NOT NULL DEFAULT app.utc_now(),UNIQUE(organization_id,id)
);
CREATE TABLE app.conversations (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),organization_id app.entity_id NOT NULL,contact_id app.entity_id NOT NULL,project_id app.entity_id,
 subject text NOT NULL CHECK(length(subject) BETWEEN 1 AND 240),state text NOT NULL DEFAULT 'open' CHECK(state IN ('open','waiting','closed')),
 human_takeover boolean NOT NULL DEFAULT false,provider_thread_id text,updated_at timestamptz NOT NULL DEFAULT app.utc_now(),
 UNIQUE(organization_id,id),FOREIGN KEY(organization_id,contact_id) REFERENCES app.crm_contacts(organization_id,id),FOREIGN KEY(organization_id,project_id) REFERENCES app.projects(organization_id,id)
);
CREATE TABLE app.messages (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),organization_id app.entity_id NOT NULL,conversation_id app.entity_id NOT NULL, campaign_id app.entity_id,
 direction text NOT NULL CHECK(direction IN ('inbound','outbound')),subject text NOT NULL CHECK(length(subject) BETWEEN 1 AND 240),body text NOT NULL CHECK(length(body) BETWEEN 1 AND 50000),
 state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','pending_approval','approved','sending','sent','delivered','received','failed','quarantined','redacted')),
 source text NOT NULL CHECK(source IN ('owner','provider','simulation','model')),provider_message_id text,approval_id app.entity_id,
 content_hash text NOT NULL,fact_snapshot_hash text,approved_campaign_revision int,version bigint NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT app.utc_now(),sent_at timestamptz,
 UNIQUE(organization_id,id),UNIQUE(organization_id,provider_message_id),
 FOREIGN KEY(organization_id,conversation_id) REFERENCES app.conversations(organization_id,id),FOREIGN KEY(organization_id,campaign_id) REFERENCES app.campaigns(organization_id,id),FOREIGN KEY(organization_id,approval_id) REFERENCES app.action_approvals(organization_id,id)
);
CREATE TABLE app.experiments (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),organization_id app.entity_id NOT NULL,project_id app.entity_id NOT NULL,
 label text NOT NULL,champion_strategy_id app.entity_id NOT NULL,challenger_strategy_id app.entity_id NOT NULL,
 challenger_basis_points int NOT NULL DEFAULT 5000 CHECK(challenger_basis_points BETWEEN 1000 AND 9000),
 state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','active','paused','completed')),created_at timestamptz NOT NULL DEFAULT app.utc_now(),
 UNIQUE(organization_id,id),FOREIGN KEY(organization_id,project_id) REFERENCES app.projects(organization_id,id),FOREIGN KEY(organization_id,champion_strategy_id) REFERENCES app.strategies(organization_id,id),FOREIGN KEY(organization_id,challenger_strategy_id) REFERENCES app.strategies(organization_id,id),CHECK(champion_strategy_id<>challenger_strategy_id)
);
CREATE TABLE app.experiment_enrollments (
 organization_id app.entity_id NOT NULL,experiment_id app.entity_id NOT NULL,contact_id app.entity_id NOT NULL,
 arm text NOT NULL CHECK(arm IN ('champion','challenger')),exposed_at timestamptz,converted_at timestamptz,
 source text CHECK(source IN ('provider','simulation')),PRIMARY KEY(organization_id,experiment_id,contact_id),
 FOREIGN KEY(organization_id,experiment_id) REFERENCES app.experiments(organization_id,id),FOREIGN KEY(organization_id,contact_id) REFERENCES app.crm_contacts(organization_id,id)
);
CREATE TABLE app.funding_opportunities (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),organization_id app.entity_id NOT NULL,project_id app.entity_id NOT NULL,
 kind text NOT NULL CHECK(kind IN ('grant','investment','sponsorship','partnership')),
 label text NOT NULL CHECK(length(label) BETWEEN 1 AND 200),funder text NOT NULL CHECK(length(funder) BETWEEN 1 AND 200),source_url text,
 stage text NOT NULL DEFAULT 'research' CHECK(stage IN ('research','eligible','drafting','review','submitted','diligence','committed','awarded','declined','closed')),
 eligibility text NOT NULL DEFAULT '',deadline timestamptz,requested_cents bigint NOT NULL DEFAULT 0 CHECK(requested_cents>=0),committed_cents bigint NOT NULL DEFAULT 0 CHECK(committed_cents>=0),
 restrictions text NOT NULL DEFAULT '',application_draft text NOT NULL DEFAULT '',owner_authority_ref text,
 version bigint NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT app.utc_now(),updated_at timestamptz NOT NULL DEFAULT app.utc_now(),
 UNIQUE(organization_id,id),FOREIGN KEY(organization_id,project_id) REFERENCES app.projects(organization_id,id)
);
CREATE TABLE app.funding_checklist (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),organization_id app.entity_id NOT NULL,opportunity_id app.entity_id NOT NULL,
 label text NOT NULL,completed boolean NOT NULL DEFAULT false,due_at timestamptz,
 FOREIGN KEY(organization_id,opportunity_id) REFERENCES app.funding_opportunities(organization_id,id)
);
CREATE TABLE app.invoices (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),organization_id app.entity_id NOT NULL,project_id app.entity_id NOT NULL,contact_id app.entity_id,
 label text NOT NULL CHECK(length(label) BETWEEN 1 AND 160),invoice_number text NOT NULL,
 state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','issued','paid','void','refunded','disputed')),
 amount_cents bigint NOT NULL CHECK(amount_cents>0),currency text NOT NULL DEFAULT 'USD' CHECK(currency='USD'),
 description text NOT NULL CHECK(length(description) BETWEEN 1 AND 2000),due_at timestamptz,provider_payment_id text,
 version bigint NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT app.utc_now(),
 UNIQUE(organization_id,id),UNIQUE(organization_id,invoice_number),UNIQUE(organization_id,provider_payment_id),
 FOREIGN KEY(organization_id,project_id) REFERENCES app.projects(organization_id,id),FOREIGN KEY(organization_id,contact_id) REFERENCES app.crm_contacts(organization_id,id)
);
ALTER TABLE app.money_entries ADD COLUMN invoice_id app.entity_id;
ALTER TABLE app.money_entries ADD CONSTRAINT money_entries_invoice_fk FOREIGN KEY(organization_id,invoice_id) REFERENCES app.invoices(organization_id,id);
ALTER TABLE app.invoices ADD COLUMN test_mode boolean NOT NULL DEFAULT true;
CREATE TABLE app.provider_receipts (
 organization_id app.entity_id NOT NULL REFERENCES app.organizations(id),provider text NOT NULL,event_id text NOT NULL,payload_hash text NOT NULL,
 processed_at timestamptz,normalized_event jsonb,received_at timestamptz NOT NULL DEFAULT app.utc_now(),PRIMARY KEY(organization_id,provider,event_id)
);
CREATE TABLE app.document_library (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),organization_id app.entity_id NOT NULL REFERENCES app.organizations(id),project_id app.entity_id,
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 200),content_type text NOT NULL CHECK(content_type IN ('text/plain','text/markdown','application/json')),
 encrypted_content text NOT NULL CHECK(octet_length(encrypted_content)<=1500000),content_hash text NOT NULL,
 rights_basis text NOT NULL CHECK(rights_basis IN ('owner_original','licensed','public_domain')),version int NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT app.utc_now(),UNIQUE(organization_id,id),FOREIGN KEY(organization_id,project_id) REFERENCES app.projects(organization_id,id)
);
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['agent_configuration','crm_accounts','crm_contacts','contact_suppressions','contact_events','deals','strategies','campaigns','campaign_revisions','campaign_audience','mailboxes','conversations','messages','experiments','experiment_enrollments','funding_opportunities','funding_checklist','invoices','provider_receipts','document_library'] LOOP
  EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY',name);EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format('CREATE POLICY %I ON app.%I USING(organization_id=app.current_organization_id()) WITH CHECK(organization_id=app.current_organization_id())',name||'_tenant',name);
 END LOOP;
END $$;
CREATE TRIGGER campaign_revisions_immutable BEFORE UPDATE OR DELETE ON app.campaign_revisions FOR EACH ROW EXECUTE FUNCTION app.deny_operation_evidence_mutation();
CREATE TRIGGER provider_receipts_immutable BEFORE DELETE ON app.provider_receipts FOR EACH ROW EXECUTE FUNCTION app.deny_operation_evidence_mutation();

CREATE FUNCTION app.preserve_receipt_evidence() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF (to_jsonb(NEW)-'processed_at') IS DISTINCT FROM (to_jsonb(OLD)-'processed_at') THEN RAISE EXCEPTION 'receipt evidence is immutable'; END IF; RETURN NEW; END $$;
CREATE TRIGGER receipt_evidence_guard BEFORE UPDATE ON app.provider_receipts FOR EACH ROW EXECUTE FUNCTION app.preserve_receipt_evidence();
