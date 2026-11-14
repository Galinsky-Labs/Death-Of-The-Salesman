-- DOTS-135..144 revenue operations: price books, quotes, processor reconciliation,
-- subscriptions/retention, delegated calendars, CRM sync, public lead forms,
-- client portal links. All tables are tenant-scoped with forced row security.

-- Ledger kinds for verified processor fees, disputes and subscription receipts.
ALTER TABLE app.money_entries DROP CONSTRAINT money_entries_kind_check;
ALTER TABLE app.money_entries ADD CONSTRAINT money_entries_kind_check CHECK(kind IN ('expense','refund','sale_receipt','grant_disbursement','investment_receipt','processor_fee','dispute_hold','dispute_reversal','subscription_receipt'));

CREATE TABLE app.price_books (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),organization_id app.entity_id NOT NULL REFERENCES app.organizations(id),
 project_id app.entity_id NOT NULL,offer_id app.entity_id,
 label text NOT NULL CHECK(length(label) BETWEEN 1 AND 160),
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
 current_revision int NOT NULL DEFAULT 0 CHECK(current_revision>=0),
 approved_revision int CHECK(approved_revision IS NULL OR approved_revision<=current_revision),
 approval_authorization_ref text CHECK(approval_authorization_ref IS NULL OR length(btrim(approval_authorization_ref)) BETWEEN 1 AND 200),
 approved_by_membership_id app.entity_id,approved_at timestamptz,
 version bigint NOT NULL DEFAULT 1 CHECK(version>0),created_at timestamptz NOT NULL DEFAULT app.utc_now(),updated_at timestamptz NOT NULL DEFAULT app.utc_now(),
 CHECK(approved_revision IS NULL OR approval_authorization_ref IS NOT NULL),
 UNIQUE(organization_id,id),
 FOREIGN KEY(organization_id,project_id) REFERENCES app.projects(organization_id,id),
 FOREIGN KEY(organization_id,offer_id) REFERENCES app.offers(organization_id,id),
 FOREIGN KEY(organization_id,approved_by_membership_id) REFERENCES app.memberships(organization_id,id)
);
CREATE TABLE app.price_book_revisions (
 organization_id app.entity_id NOT NULL,price_book_id app.entity_id NOT NULL,revision int NOT NULL CHECK(revision>0),
 unit_price_cents bigint NOT NULL CHECK(unit_price_cents>0 AND unit_price_cents<=9007199254740991),
 currency text NOT NULL DEFAULT 'USD' CHECK(currency='USD'),
 billing_interval text NOT NULL CHECK(billing_interval IN ('one_time','month','year')),
 max_discount_basis_points int NOT NULL DEFAULT 0 CHECK(max_discount_basis_points BETWEEN 0 AND 5000),
 offer_terms text NOT NULL CHECK(length(offer_terms) BETWEEN 1 AND 4000),
 trial_days int NOT NULL DEFAULT 0 CHECK(trial_days BETWEEN 0 AND 90),
 quote_valid_days int NOT NULL DEFAULT 14 CHECK(quote_valid_days BETWEEN 1 AND 90),
 content_hash text NOT NULL CHECK(content_hash ~ '^[0-9a-f]{64}$'),
 created_by_membership_id app.entity_id NOT NULL,created_at timestamptz NOT NULL DEFAULT app.utc_now(),
 PRIMARY KEY(organization_id,price_book_id,revision),
 FOREIGN KEY(organization_id,price_book_id) REFERENCES app.price_books(organization_id,id),
 FOREIGN KEY(organization_id,created_by_membership_id) REFERENCES app.memberships(organization_id,id)
);
CREATE TABLE app.quotes (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),organization_id app.entity_id NOT NULL REFERENCES app.organizations(id),
 project_id app.entity_id NOT NULL,price_book_id app.entity_id NOT NULL,price_revision int NOT NULL,
 account_id app.entity_id,contact_id app.entity_id,deal_id app.entity_id,
 quote_number text NOT NULL CHECK(quote_number ~ '^Q-[0-9A-F]{10}$'),
 quantity int NOT NULL CHECK(quantity BETWEEN 1 AND 10000),
 unit_price_cents bigint NOT NULL CHECK(unit_price_cents>0),
 discount_basis_points int NOT NULL DEFAULT 0 CHECK(discount_basis_points BETWEEN 0 AND 5000),
 subtotal_cents bigint NOT NULL CHECK(subtotal_cents>0),discount_cents bigint NOT NULL CHECK(discount_cents>=0),total_cents bigint NOT NULL CHECK(total_cents>0),
 billing_interval text NOT NULL CHECK(billing_interval IN ('one_time','month','year')),
 offer_terms text NOT NULL,content_hash text NOT NULL CHECK(content_hash ~ '^[0-9a-f]{64}$'),
 state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','awaiting_discount_approval','ready','sent','accepted','declined','expired','void')),
 discount_approval_id app.entity_id,
 binding boolean NOT NULL DEFAULT false,
 binding_authorization_ref text CHECK(binding_authorization_ref IS NULL OR length(btrim(binding_authorization_ref)) BETWEEN 1 AND 200),
 sent_at timestamptz,sent_channel text CHECK(sent_channel IS NULL OR sent_channel IN ('owner_manual','portal_link')),sent_evidence text CHECK(sent_evidence IS NULL OR length(sent_evidence) BETWEEN 1 AND 500),
 accepted_at timestamptz,acceptance_evidence text CHECK(acceptance_evidence IS NULL OR length(acceptance_evidence) BETWEEN 1 AND 500),
 declined_at timestamptz,expires_at timestamptz NOT NULL,invoice_id app.entity_id,
 version bigint NOT NULL DEFAULT 1 CHECK(version>0),created_at timestamptz NOT NULL DEFAULT app.utc_now(),updated_at timestamptz NOT NULL DEFAULT app.utc_now(),
 CHECK(total_cents=subtotal_cents-discount_cents),
 CHECK(NOT binding OR (binding_authorization_ref IS NOT NULL AND state='accepted')),
 UNIQUE(organization_id,id),UNIQUE(organization_id,quote_number),
 FOREIGN KEY(organization_id,project_id) REFERENCES app.projects(organization_id,id),
 FOREIGN KEY(organization_id,price_book_id,price_revision) REFERENCES app.price_book_revisions(organization_id,price_book_id,revision),
 FOREIGN KEY(organization_id,account_id) REFERENCES app.crm_accounts(organization_id,id),
 FOREIGN KEY(organization_id,contact_id) REFERENCES app.crm_contacts(organization_id,id),
 FOREIGN KEY(organization_id,deal_id) REFERENCES app.deals(organization_id,id),
 FOREIGN KEY(organization_id,discount_approval_id) REFERENCES app.action_approvals(organization_id,id),
 FOREIGN KEY(organization_id,invoice_id) REFERENCES app.invoices(organization_id,id)
);

CREATE TABLE app.revenue_subscriptions (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),organization_id app.entity_id NOT NULL REFERENCES app.organizations(id),
 project_id app.entity_id NOT NULL,account_id app.entity_id,contact_id app.entity_id,quote_id app.entity_id,
 label text NOT NULL CHECK(length(label) BETWEEN 1 AND 160),
 amount_cents bigint NOT NULL CHECK(amount_cents>0),billing_interval text NOT NULL CHECK(billing_interval IN ('month','year')),
 state text NOT NULL DEFAULT 'trialing' CHECK(state IN ('trialing','active','past_due','cancelled','churned')),
 provider_subscription_id text CHECK(provider_subscription_id IS NULL OR provider_subscription_id ~ '^sub_[A-Za-z0-9_]{1,120}$'),
 test_mode boolean NOT NULL DEFAULT true,
 support_owner_membership_id app.entity_id NOT NULL,support_owner_agent_id app.entity_id,
 trial_ends_at timestamptz,current_period_end timestamptz,started_at timestamptz NOT NULL DEFAULT app.utc_now(),ended_at timestamptz,
 version bigint NOT NULL DEFAULT 1 CHECK(version>0),created_at timestamptz NOT NULL DEFAULT app.utc_now(),updated_at timestamptz NOT NULL DEFAULT app.utc_now(),
 UNIQUE(organization_id,id),UNIQUE(organization_id,provider_subscription_id),
 FOREIGN KEY(organization_id,project_id) REFERENCES app.projects(organization_id,id),
 FOREIGN KEY(organization_id,account_id) REFERENCES app.crm_accounts(organization_id,id),
 FOREIGN KEY(organization_id,contact_id) REFERENCES app.crm_contacts(organization_id,id),
 FOREIGN KEY(organization_id,quote_id) REFERENCES app.quotes(organization_id,id),
 FOREIGN KEY(organization_id,support_owner_membership_id) REFERENCES app.memberships(organization_id,id),
 FOREIGN KEY(organization_id,support_owner_agent_id) REFERENCES app.agent_identities(organization_id,id)
);
ALTER TABLE app.money_entries ADD COLUMN subscription_id app.entity_id;
ALTER TABLE app.money_entries ADD CONSTRAINT money_entries_subscription_fk FOREIGN KEY(organization_id,subscription_id) REFERENCES app.revenue_subscriptions(organization_id,id);
CREATE TABLE app.retention_events (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),organization_id app.entity_id NOT NULL REFERENCES app.organizations(id),subscription_id app.entity_id NOT NULL,
 kind text NOT NULL CHECK(kind IN ('trial_started','trial_completed','trial_converted','onboarding_completed','payment_received','renewed','escalation_opened','escalation_resolved','cancelled','churned','retained')),
 source text NOT NULL CHECK(source IN ('owner_attested','provider','simulation')),
 evidence_ref text NOT NULL CHECK(length(evidence_ref) BETWEEN 1 AND 240),
 details jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(details)='object' AND octet_length(details::text)<=4096),
 occurred_at timestamptz NOT NULL DEFAULT app.utc_now(),UNIQUE(organization_id,id),
 FOREIGN KEY(organization_id,subscription_id) REFERENCES app.revenue_subscriptions(organization_id,id)
);
CREATE TABLE app.onboarding_tasks (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),organization_id app.entity_id NOT NULL REFERENCES app.organizations(id),subscription_id app.entity_id NOT NULL,
 label text NOT NULL CHECK(length(label) BETWEEN 1 AND 200),position int NOT NULL CHECK(position BETWEEN 1 AND 50),
 completed_at timestamptz,completed_by_agent_id app.entity_id,evidence_ref text CHECK(evidence_ref IS NULL OR length(evidence_ref) BETWEEN 1 AND 240),
 UNIQUE(organization_id,id),UNIQUE(organization_id,subscription_id,position),
 FOREIGN KEY(organization_id,subscription_id) REFERENCES app.revenue_subscriptions(organization_id,id),
 FOREIGN KEY(organization_id,completed_by_agent_id) REFERENCES app.agent_identities(organization_id,id)
);
CREATE TABLE app.service_escalations (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),organization_id app.entity_id NOT NULL REFERENCES app.organizations(id),subscription_id app.entity_id NOT NULL,
 severity text NOT NULL CHECK(severity IN ('low','normal','high','urgent')),summary text NOT NULL CHECK(length(summary) BETWEEN 1 AND 2000),
 state text NOT NULL DEFAULT 'open' CHECK(state IN ('open','resolved')),
 owner_membership_id app.entity_id NOT NULL,owner_agent_id app.entity_id,resolution text CHECK(resolution IS NULL OR length(resolution) BETWEEN 1 AND 2000),
 opened_at timestamptz NOT NULL DEFAULT app.utc_now(),resolved_at timestamptz,version bigint NOT NULL DEFAULT 1,
 UNIQUE(organization_id,id),
 FOREIGN KEY(organization_id,subscription_id) REFERENCES app.revenue_subscriptions(organization_id,id),
 FOREIGN KEY(organization_id,owner_membership_id) REFERENCES app.memberships(organization_id,id),
 FOREIGN KEY(organization_id,owner_agent_id) REFERENCES app.agent_identities(organization_id,id)
);

CREATE TABLE app.calendar_connections (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),organization_id app.entity_id NOT NULL REFERENCES app.organizations(id),
 label text NOT NULL CHECK(length(label) BETWEEN 1 AND 120),
 provider text NOT NULL CHECK(provider IN ('local_ics','google','microsoft','caldav')),
 calendar_ref text NOT NULL CHECK(length(calendar_ref) BETWEEN 1 AND 200),
 credential_env_ref text CHECK(credential_env_ref IS NULL OR credential_env_ref ~ '^[A-Z][A-Z0-9_]{2,63}$'),
 timezone text NOT NULL DEFAULT 'UTC' CHECK(length(timezone) BETWEEN 1 AND 64),
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled','revoked')),
 created_by_membership_id app.entity_id NOT NULL,version bigint NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT app.utc_now(),
 UNIQUE(organization_id,id),UNIQUE(organization_id,provider,calendar_ref),
 FOREIGN KEY(organization_id,created_by_membership_id) REFERENCES app.memberships(organization_id,id)
);
CREATE TABLE app.calendar_delegations (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),organization_id app.entity_id NOT NULL REFERENCES app.organizations(id),
 connection_id app.entity_id NOT NULL,agent_identity_id app.entity_id NOT NULL,
 scopes text[] NOT NULL CHECK(cardinality(scopes) BETWEEN 1 AND 4 AND scopes <@ ARRAY['availability','create','update','cancel']::text[]),
 authorization_ref text NOT NULL CHECK(length(btrim(authorization_ref)) BETWEEN 1 AND 200),
 granted_by_membership_id app.entity_id NOT NULL,expires_at timestamptz NOT NULL,revoked_at timestamptz,created_at timestamptz NOT NULL DEFAULT app.utc_now(),
 UNIQUE(organization_id,id),
 FOREIGN KEY(organization_id,connection_id) REFERENCES app.calendar_connections(organization_id,id),
 FOREIGN KEY(organization_id,agent_identity_id) REFERENCES app.agent_identities(organization_id,id),
 FOREIGN KEY(organization_id,granted_by_membership_id) REFERENCES app.memberships(organization_id,id)
);
CREATE TABLE app.meetings (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),organization_id app.entity_id NOT NULL REFERENCES app.organizations(id),
 connection_id app.entity_id NOT NULL,agent_identity_id app.entity_id NOT NULL,delegation_id app.entity_id NOT NULL,
 contact_id app.entity_id,account_id app.entity_id,
 subject text NOT NULL CHECK(length(subject) BETWEEN 1 AND 200),location text CHECK(location IS NULL OR length(location)<=300),
 starts_at timestamptz NOT NULL,ends_at timestamptz NOT NULL,timezone text NOT NULL,
 state text NOT NULL DEFAULT 'scheduled' CHECK(state IN ('scheduled','cancelled')),
 ics_uid text NOT NULL,sequence int NOT NULL DEFAULT 0 CHECK(sequence>=0),
 version bigint NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT app.utc_now(),updated_at timestamptz NOT NULL DEFAULT app.utc_now(),
 CHECK(ends_at>starts_at AND ends_at<=starts_at+interval '8 hours'),
 UNIQUE(organization_id,id),UNIQUE(organization_id,ics_uid),
 FOREIGN KEY(organization_id,connection_id) REFERENCES app.calendar_connections(organization_id,id),
 FOREIGN KEY(organization_id,agent_identity_id) REFERENCES app.agent_identities(organization_id,id),
 FOREIGN KEY(organization_id,delegation_id) REFERENCES app.calendar_delegations(organization_id,id),
 FOREIGN KEY(organization_id,contact_id) REFERENCES app.crm_contacts(organization_id,id),
 FOREIGN KEY(organization_id,account_id) REFERENCES app.crm_accounts(organization_id,id)
);

CREATE TABLE app.crm_external_links (
 organization_id app.entity_id NOT NULL REFERENCES app.organizations(id),
 system text NOT NULL CHECK(system ~ '^[a-z][a-z0-9_]{1,39}$'),
 entity_kind text NOT NULL CHECK(entity_kind IN ('account','contact','deal')),entity_id app.entity_id NOT NULL,
 external_id text NOT NULL CHECK(length(external_id) BETWEEN 1 AND 200),created_at timestamptz NOT NULL DEFAULT app.utc_now(),
 PRIMARY KEY(organization_id,system,entity_kind,external_id),UNIQUE(organization_id,system,entity_kind,entity_id)
);
CREATE TABLE app.crm_field_ownership (
 organization_id app.entity_id NOT NULL REFERENCES app.organizations(id),system text NOT NULL CHECK(system ~ '^[a-z][a-z0-9_]{1,39}$'),
 entity_kind text NOT NULL CHECK(entity_kind IN ('account','contact','deal')),field text NOT NULL CHECK(field ~ '^[a-z_]{1,40}$'),
 owner text NOT NULL CHECK(owner IN ('dots','external')),version bigint NOT NULL DEFAULT 1,updated_at timestamptz NOT NULL DEFAULT app.utc_now(),
 PRIMARY KEY(organization_id,system,entity_kind,field)
);
CREATE TABLE app.crm_sync_runs (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),organization_id app.entity_id NOT NULL REFERENCES app.organizations(id),
 system text NOT NULL,direction text NOT NULL CHECK(direction IN ('import','export')),format text NOT NULL CHECK(format IN ('csv','json')),
 record_count int NOT NULL CHECK(record_count>=0),created_count int NOT NULL DEFAULT 0,updated_count int NOT NULL DEFAULT 0,
 conflict_count int NOT NULL DEFAULT 0,skipped_count int NOT NULL DEFAULT 0,content_hash text NOT NULL CHECK(content_hash ~ '^[0-9a-f]{64}$'),
 created_at timestamptz NOT NULL DEFAULT app.utc_now(),UNIQUE(organization_id,id)
);
CREATE TABLE app.crm_sync_conflicts (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),organization_id app.entity_id NOT NULL REFERENCES app.organizations(id),run_id app.entity_id NOT NULL,
 system text NOT NULL,entity_kind text NOT NULL,entity_id app.entity_id NOT NULL,field text NOT NULL,
 dots_value_hash text NOT NULL,external_value_hash text NOT NULL,resolution text NOT NULL CHECK(resolution IN ('kept_dots_value','refused_protected_field')),
 created_at timestamptz NOT NULL DEFAULT app.utc_now(),
 FOREIGN KEY(organization_id,run_id) REFERENCES app.crm_sync_runs(organization_id,id)
);

CREATE TABLE app.lead_forms (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),organization_id app.entity_id NOT NULL REFERENCES app.organizations(id),project_id app.entity_id NOT NULL,
 label text NOT NULL CHECK(length(label) BETWEEN 1 AND 120),
 form_key_hash text NOT NULL UNIQUE CHECK(form_key_hash ~ '^[0-9a-f]{64}$'),
 consent_text text NOT NULL CHECK(length(consent_text) BETWEEN 20 AND 2000),consent_version text NOT NULL CHECK(consent_version ~ '^[A-Za-z0-9._-]{1,40}$'),
 retention_days int NOT NULL CHECK(retention_days BETWEEN 1 AND 1095),daily_limit_per_ip int NOT NULL DEFAULT 5 CHECK(daily_limit_per_ip BETWEEN 1 AND 50),
 allowed_origin text CHECK(allowed_origin IS NULL OR allowed_origin ~ '^https://[a-z0-9.-]+(:[0-9]+)?$'),
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
 version bigint NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT app.utc_now(),updated_at timestamptz NOT NULL DEFAULT app.utc_now(),
 UNIQUE(organization_id,id),FOREIGN KEY(organization_id,project_id) REFERENCES app.projects(organization_id,id)
);
CREATE TABLE app.lead_form_nonces (
 organization_id app.entity_id NOT NULL REFERENCES app.organizations(id),form_id app.entity_id NOT NULL,nonce_hash text NOT NULL CHECK(nonce_hash ~ '^[0-9a-f]{64}$'),
 used_at timestamptz NOT NULL DEFAULT app.utc_now(),PRIMARY KEY(organization_id,form_id,nonce_hash),
 FOREIGN KEY(organization_id,form_id) REFERENCES app.lead_forms(organization_id,id)
);
CREATE TABLE app.lead_rate_limits (
 organization_id app.entity_id NOT NULL REFERENCES app.organizations(id),form_id app.entity_id NOT NULL,ip_hash text NOT NULL CHECK(ip_hash ~ '^[0-9a-f]{64}$'),
 day date NOT NULL,attempts int NOT NULL DEFAULT 0 CHECK(attempts>=0),PRIMARY KEY(organization_id,form_id,ip_hash,day),
 FOREIGN KEY(organization_id,form_id) REFERENCES app.lead_forms(organization_id,id)
);
CREATE TABLE app.lead_submissions (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),organization_id app.entity_id NOT NULL REFERENCES app.organizations(id),form_id app.entity_id NOT NULL,contact_id app.entity_id,
 outcome text NOT NULL CHECK(outcome IN ('accepted','existing_contact','suppressed')),
 consent_given boolean NOT NULL,consent_version text NOT NULL,consent_text_hash text NOT NULL CHECK(consent_text_hash ~ '^[0-9a-f]{64}$'),
 provenance jsonb NOT NULL CHECK(jsonb_typeof(provenance)='object' AND octet_length(provenance::text)<=4096),
 ip_hash text NOT NULL CHECK(ip_hash ~ '^[0-9a-f]{64}$'),message text CHECK(message IS NULL OR length(message)<=2000),
 retention_until timestamptz NOT NULL,purged_at timestamptz,created_at timestamptz NOT NULL DEFAULT app.utc_now(),
 UNIQUE(organization_id,id),
 FOREIGN KEY(organization_id,form_id) REFERENCES app.lead_forms(organization_id,id),
 FOREIGN KEY(organization_id,contact_id) REFERENCES app.crm_contacts(organization_id,id)
);

CREATE TABLE app.portal_links (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),organization_id app.entity_id NOT NULL REFERENCES app.organizations(id),account_id app.entity_id NOT NULL,
 token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[0-9a-f]{64}$'),
 expires_at timestamptz NOT NULL,revoked_at timestamptz,created_by_membership_id app.entity_id NOT NULL,
 last_viewed_at timestamptz,view_count int NOT NULL DEFAULT 0 CHECK(view_count>=0),created_at timestamptz NOT NULL DEFAULT app.utc_now(),
 CHECK(expires_at<=created_at+interval '30 days'),
 UNIQUE(organization_id,id),
 FOREIGN KEY(organization_id,account_id) REFERENCES app.crm_accounts(organization_id,id),
 FOREIGN KEY(organization_id,created_by_membership_id) REFERENCES app.memberships(organization_id,id)
);

DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['price_books','price_book_revisions','quotes','revenue_subscriptions','retention_events','onboarding_tasks','service_escalations','calendar_connections','calendar_delegations','meetings','crm_external_links','crm_field_ownership','crm_sync_runs','crm_sync_conflicts','lead_forms','lead_form_nonces','lead_rate_limits','lead_submissions','portal_links'] LOOP
  EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY',name);EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format('CREATE POLICY %I ON app.%I USING(organization_id=app.current_organization_id()) WITH CHECK(organization_id=app.current_organization_id())',name||'_tenant',name);
 END LOOP;
END $$;
CREATE TRIGGER price_book_revisions_immutable BEFORE UPDATE OR DELETE ON app.price_book_revisions FOR EACH ROW EXECUTE FUNCTION app.deny_operation_evidence_mutation();
CREATE TRIGGER retention_events_immutable BEFORE UPDATE OR DELETE ON app.retention_events FOR EACH ROW EXECUTE FUNCTION app.deny_operation_evidence_mutation();
CREATE TRIGGER crm_sync_runs_immutable BEFORE UPDATE OR DELETE ON app.crm_sync_runs FOR EACH ROW EXECUTE FUNCTION app.deny_operation_evidence_mutation();
CREATE TRIGGER crm_sync_conflicts_immutable BEFORE UPDATE OR DELETE ON app.crm_sync_conflicts FOR EACH ROW EXECUTE FUNCTION app.deny_operation_evidence_mutation();
CREATE TRIGGER lead_form_nonces_immutable BEFORE UPDATE OR DELETE ON app.lead_form_nonces FOR EACH ROW EXECUTE FUNCTION app.deny_operation_evidence_mutation();
-- Quote pricing evidence is frozen once created; only lifecycle columns may change.
CREATE FUNCTION app.preserve_quote_pricing() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (to_jsonb(NEW)-ARRAY['state','discount_approval_id','binding','binding_authorization_ref','sent_at','sent_channel','sent_evidence','accepted_at','acceptance_evidence','declined_at','invoice_id','version','updated_at'])
  IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','discount_approval_id','binding','binding_authorization_ref','sent_at','sent_channel','sent_evidence','accepted_at','acceptance_evidence','declined_at','invoice_id','version','updated_at']) THEN
  RAISE EXCEPTION 'quote pricing evidence is immutable' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER quote_pricing_guard BEFORE UPDATE ON app.quotes FOR EACH ROW EXECUTE FUNCTION app.preserve_quote_pricing();
-- Lead consent evidence is immutable; only retention purge columns may change.
CREATE FUNCTION app.preserve_lead_evidence() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (to_jsonb(NEW)-ARRAY['message','purged_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['message','purged_at']) THEN
  RAISE EXCEPTION 'lead consent evidence is immutable' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER lead_evidence_guard BEFORE UPDATE ON app.lead_submissions FOR EACH ROW EXECUTE FUNCTION app.preserve_lead_evidence();
