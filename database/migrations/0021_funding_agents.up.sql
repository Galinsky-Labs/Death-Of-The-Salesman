-- DOTS-121..134: Funding Agents (grants, investor relations, sponsorships/partnerships).
-- Investor relations, grants, sponsorships and product revenue remain distinct record families.
-- Nothing here submits, signs, certifies or solicits; those are owner-performed actions recorded with evidence.

CREATE TABLE app.funding_sources (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),organization_id app.entity_id NOT NULL REFERENCES app.organizations(id),
 kind text NOT NULL CHECK(kind IN ('grant_program','foundation','government_agency','sponsor','partner','investor_fund')),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 240),funder text NOT NULL CHECK(length(funder) BETWEEN 1 AND 240),
 source_url text NOT NULL CHECK(source_url ~ '^https://[^[:space:]]+$' AND length(source_url)<=2000),
 geography text[] NOT NULL DEFAULT '{}',entity_eligibility text[] NOT NULL DEFAULT '{}',program_type text NOT NULL DEFAULT 'unspecified' CHECK(length(program_type) BETWEEN 1 AND 80),
 min_award_cents bigint CHECK(min_award_cents>=0),max_award_cents bigint CHECK(max_award_cents>=0),
 deadline timestamptz,deadline_timezone text NOT NULL DEFAULT 'UTC' CHECK(length(deadline_timezone) BETWEEN 1 AND 64),
 connector text NOT NULL CHECK(connector IN ('manual','grants_gov')),external_id text NOT NULL CHECK(length(external_id) BETWEEN 1 AND 200),
 provenance jsonb NOT NULL CHECK(jsonb_typeof(provenance)='object' AND octet_length(provenance::text)<=8192),
 verified_at timestamptz NOT NULL,refresh_days int NOT NULL DEFAULT 14 CHECK(refresh_days BETWEEN 1 AND 365),
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','stale','archived')),
 version bigint NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT app.utc_now(),updated_at timestamptz NOT NULL DEFAULT app.utc_now(),
 CHECK(min_award_cents IS NULL OR max_award_cents IS NULL OR min_award_cents<=max_award_cents),
 UNIQUE(organization_id,id),UNIQUE(organization_id,connector,external_id)
);
CREATE TABLE app.funding_source_revisions (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),organization_id app.entity_id NOT NULL,source_id app.entity_id NOT NULL,
 revision bigint NOT NULL,snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),content_hash text NOT NULL CHECK(content_hash ~ '^[0-9a-f]{64}$'),
 recorded_at timestamptz NOT NULL DEFAULT app.utc_now(),UNIQUE(organization_id,source_id,revision),
 FOREIGN KEY(organization_id,source_id) REFERENCES app.funding_sources(organization_id,id)
);
CREATE TABLE app.funding_connector_runs (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),organization_id app.entity_id NOT NULL REFERENCES app.organizations(id),
 connector text NOT NULL CHECK(connector IN ('manual','grants_gov','candid')),
 state text NOT NULL CHECK(state IN ('ok','waiting','blocked_external_prerequisite')),reason_code text,
 query_hash text,result_count int NOT NULL DEFAULT 0 CHECK(result_count>=0),observed_at timestamptz NOT NULL DEFAULT app.utc_now()
);
CREATE INDEX funding_connector_runs_latest ON app.funding_connector_runs(organization_id,connector,observed_at DESC);
CREATE TABLE app.funding_eligibility_rules (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),organization_id app.entity_id NOT NULL,source_id app.entity_id NOT NULL,
 kind text NOT NULL CHECK(kind IN ('entity_type','jurisdiction','stage','restriction','required_document')),
 allowed text[] NOT NULL DEFAULT '{}',description text NOT NULL CHECK(length(description) BETWEEN 1 AND 1000),
 citation_url text NOT NULL CHECK(citation_url ~ '^https://'),status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','retired')),
 created_at timestamptz NOT NULL DEFAULT app.utc_now(),UNIQUE(organization_id,id),
 FOREIGN KEY(organization_id,source_id) REFERENCES app.funding_sources(organization_id,id)
);
CREATE TABLE app.funding_applicant_profiles (
 organization_id app.entity_id NOT NULL,project_id app.entity_id NOT NULL,
 entity_type text NOT NULL CHECK(length(entity_type) BETWEEN 1 AND 80),jurisdiction text NOT NULL CHECK(length(jurisdiction) BETWEEN 2 AND 40),
 stage text NOT NULL CHECK(length(stage) BETWEEN 1 AND 80),
 documents jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(documents)='object'),
 restrictions_confirmed text[] NOT NULL DEFAULT '{}',version bigint NOT NULL DEFAULT 1,updated_at timestamptz NOT NULL DEFAULT app.utc_now(),
 PRIMARY KEY(organization_id,project_id),FOREIGN KEY(organization_id,project_id) REFERENCES app.projects(organization_id,id)
);
CREATE TABLE app.funding_org_facts (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),organization_id app.entity_id NOT NULL,project_id app.entity_id NOT NULL,
 label text NOT NULL CHECK(length(label) BETWEEN 1 AND 160),statement text NOT NULL CHECK(length(statement) BETWEEN 1 AND 2000),
 evidence_ref text NOT NULL CHECK(length(evidence_ref) BETWEEN 1 AND 500),category text NOT NULL DEFAULT 'organization' CHECK(category IN ('organization','financial','traction','team','program')),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','retired')),approved_by_membership_id app.entity_id,approved_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT app.utc_now(),UNIQUE(organization_id,id),
 CHECK(status<>'approved' OR (approved_by_membership_id IS NOT NULL AND approved_at IS NOT NULL)),
 FOREIGN KEY(organization_id,project_id) REFERENCES app.projects(organization_id,id),
 FOREIGN KEY(organization_id,approved_by_membership_id) REFERENCES app.memberships(organization_id,id)
);
CREATE TABLE app.investor_organizations (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),organization_id app.entity_id NOT NULL REFERENCES app.organizations(id),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 200),kind text NOT NULL CHECK(kind IN ('angel','venture_fund','corporate','family_office','accelerator','other')),
 source_id app.entity_id,relationship text NOT NULL DEFAULT 'none' CHECK(relationship IN ('none','introduced','preexisting_substantive')),
 accreditation text NOT NULL DEFAULT 'unknown' CHECK(accreditation IN ('unknown','self_reported','verified_506c')),
 accreditation_evidence_ref text,accreditation_verified_at timestamptz,
 allowed_communication_classes text[] NOT NULL DEFAULT ARRAY['meeting_logistics']::text[],
 version bigint NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT app.utc_now(),UNIQUE(organization_id,id),
 CHECK(accreditation<>'verified_506c' OR (accreditation_evidence_ref IS NOT NULL AND accreditation_verified_at IS NOT NULL)),
 FOREIGN KEY(organization_id,source_id) REFERENCES app.funding_sources(organization_id,id)
);
ALTER TABLE app.funding_opportunities ADD COLUMN source_id app.entity_id,ADD COLUMN investor_id app.entity_id,ADD COLUMN owner_label text,
 ADD COLUMN range_min_cents bigint CHECK(range_min_cents>=0),ADD COLUMN range_max_cents bigint CHECK(range_max_cents>=0);
ALTER TABLE app.funding_opportunities ADD CONSTRAINT funding_opportunities_source_fk FOREIGN KEY(organization_id,source_id) REFERENCES app.funding_sources(organization_id,id);
ALTER TABLE app.funding_opportunities ADD CONSTRAINT funding_opportunities_investor_fk FOREIGN KEY(organization_id,investor_id) REFERENCES app.investor_organizations(organization_id,id);
CREATE TABLE app.funding_eligibility_results (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),organization_id app.entity_id NOT NULL,opportunity_id app.entity_id NOT NULL,source_id app.entity_id NOT NULL,
 result text NOT NULL CHECK(result IN ('eligible','ineligible','unknown')),explanation jsonb NOT NULL CHECK(jsonb_typeof(explanation)='array'),
 citation_url text NOT NULL,source_verified_at timestamptz NOT NULL,source_revision bigint NOT NULL,profile_hash text NOT NULL,
 evaluated_at timestamptz NOT NULL DEFAULT app.utc_now(),UNIQUE(organization_id,id),
 FOREIGN KEY(organization_id,opportunity_id) REFERENCES app.funding_opportunities(organization_id,id),
 FOREIGN KEY(organization_id,source_id) REFERENCES app.funding_sources(organization_id,id)
);
CREATE TABLE app.funding_applications (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),organization_id app.entity_id NOT NULL,opportunity_id app.entity_id NOT NULL,
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','in_review','ready','awaiting_owner_submission','submitted','withdrawn')),
 approval_id app.entity_id,submission_payload_hash text,submission_evidence_kind text CHECK(submission_evidence_kind IN ('provider_receipt','owner_verified')),
 submission_evidence_ref text,submitted_by_membership_id app.entity_id,submitted_at timestamptz,
 version bigint NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT app.utc_now(),updated_at timestamptz NOT NULL DEFAULT app.utc_now(),
 UNIQUE(organization_id,id),UNIQUE(organization_id,opportunity_id),
 CHECK(status<>'submitted' OR (submission_evidence_kind IS NOT NULL AND length(btrim(coalesce(submission_evidence_ref,'')))>0 AND submitted_by_membership_id IS NOT NULL AND submitted_at IS NOT NULL AND approval_id IS NOT NULL)),
 FOREIGN KEY(organization_id,opportunity_id) REFERENCES app.funding_opportunities(organization_id,id),
 FOREIGN KEY(organization_id,approval_id) REFERENCES app.action_approvals(organization_id,id),
 FOREIGN KEY(organization_id,submitted_by_membership_id) REFERENCES app.memberships(organization_id,id)
);
CREATE TABLE app.funding_application_answers (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),organization_id app.entity_id NOT NULL,application_id app.entity_id NOT NULL,
 question_key text NOT NULL CHECK(question_key ~ '^[a-z0-9_.-]{1,80}$'),prompt text NOT NULL CHECK(length(prompt) BETWEEN 1 AND 2000),
 answer text NOT NULL DEFAULT '' CHECK(length(answer)<=20000),citations jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(citations)='array'),
 status text NOT NULL DEFAULT 'empty' CHECK(status IN ('empty','draft','reviewed')),source text NOT NULL DEFAULT 'owner' CHECK(source IN ('owner','model','assembled')),
 version bigint NOT NULL DEFAULT 1,updated_at timestamptz NOT NULL DEFAULT app.utc_now(),
 UNIQUE(organization_id,id),UNIQUE(organization_id,application_id,question_key),
 FOREIGN KEY(organization_id,application_id) REFERENCES app.funding_applications(organization_id,id)
);
CREATE TABLE app.funding_application_documents (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),organization_id app.entity_id NOT NULL,application_id app.entity_id NOT NULL,
 label text NOT NULL CHECK(length(label) BETWEEN 1 AND 200),required boolean NOT NULL DEFAULT true,document_id app.entity_id,
 privacy_class text NOT NULL DEFAULT 'private' CHECK(privacy_class IN ('private','model_allowed')),
 UNIQUE(organization_id,id),UNIQUE(organization_id,application_id,label),
 FOREIGN KEY(organization_id,application_id) REFERENCES app.funding_applications(organization_id,id),
 FOREIGN KEY(organization_id,document_id) REFERENCES app.document_library(organization_id,id)
);
CREATE TABLE app.funding_application_reviews (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),organization_id app.entity_id NOT NULL,application_id app.entity_id NOT NULL,
 reviewer_membership_id app.entity_id NOT NULL,decision text NOT NULL CHECK(decision IN ('changes_requested','approved_for_submission_prep')),
 notes text NOT NULL DEFAULT '' CHECK(length(notes)<=4000),content_hash text NOT NULL,reviewed_at timestamptz NOT NULL DEFAULT app.utc_now(),
 FOREIGN KEY(organization_id,application_id) REFERENCES app.funding_applications(organization_id,id),
 FOREIGN KEY(organization_id,reviewer_membership_id) REFERENCES app.memberships(organization_id,id)
);
CREATE TABLE app.funding_certifications (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),organization_id app.entity_id NOT NULL,application_id app.entity_id NOT NULL,
 actor_kind text NOT NULL DEFAULT 'human' CHECK(actor_kind='human'),certified_by_membership_id app.entity_id NOT NULL,
 signer_name text NOT NULL CHECK(length(signer_name) BETWEEN 1 AND 160),statement text NOT NULL CHECK(length(statement) BETWEEN 1 AND 4000),
 eligibility_result_id app.entity_id NOT NULL,certified_at timestamptz NOT NULL DEFAULT app.utc_now(),UNIQUE(organization_id,id),
 FOREIGN KEY(organization_id,application_id) REFERENCES app.funding_applications(organization_id,id),
 FOREIGN KEY(organization_id,certified_by_membership_id) REFERENCES app.memberships(organization_id,id),
 FOREIGN KEY(organization_id,eligibility_result_id) REFERENCES app.funding_eligibility_results(organization_id,id)
);
CREATE TABLE app.funding_milestones (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),organization_id app.entity_id NOT NULL,opportunity_id app.entity_id,source_id app.entity_id,
 kind text NOT NULL CHECK(kind IN ('draft_complete','internal_review','owner_final_check','funder_deadline','source_recheck','report_due')),
 label text NOT NULL CHECK(length(label) BETWEEN 1 AND 200),due_at timestamptz NOT NULL,timezone text NOT NULL CHECK(length(timezone) BETWEEN 1 AND 64),
 provenance jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(provenance)='object'),completed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT app.utc_now(),UNIQUE(organization_id,id),
 CHECK(opportunity_id IS NOT NULL OR source_id IS NOT NULL),
 FOREIGN KEY(organization_id,opportunity_id) REFERENCES app.funding_opportunities(organization_id,id),
 FOREIGN KEY(organization_id,source_id) REFERENCES app.funding_sources(organization_id,id)
);
CREATE UNIQUE INDEX funding_milestones_once ON app.funding_milestones(organization_id,coalesce(opportunity_id,source_id),kind,due_at);
CREATE TABLE app.funding_owner_alerts (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),organization_id app.entity_id NOT NULL,milestone_id app.entity_id NOT NULL,
 alert_kind text NOT NULL CHECK(alert_kind IN ('upcoming','overdue')),message text NOT NULL CHECK(length(message) BETWEEN 1 AND 500),
 state text NOT NULL DEFAULT 'open' CHECK(state IN ('open','acknowledged')),created_at timestamptz NOT NULL DEFAULT app.utc_now(),acknowledged_at timestamptz,
 UNIQUE(organization_id,id),UNIQUE(organization_id,milestone_id,alert_kind),
 FOREIGN KEY(organization_id,milestone_id) REFERENCES app.funding_milestones(organization_id,id)
);
CREATE TABLE app.funding_awards (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),organization_id app.entity_id NOT NULL,opportunity_id app.entity_id NOT NULL,
 status text NOT NULL DEFAULT 'offered' CHECK(status IN ('offered','accepted','declined','rescinded')),
 amount_cents bigint NOT NULL CHECK(amount_cents>0),restricted_cents bigint NOT NULL DEFAULT 0 CHECK(restricted_cents>=0),
 offer_evidence_ref text NOT NULL CHECK(length(offer_evidence_ref) BETWEEN 1 AND 240),acceptance_authority_ref text,accepted_by_membership_id app.entity_id,accepted_at timestamptz,
 version bigint NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT app.utc_now(),UNIQUE(organization_id,id),
 CHECK(restricted_cents<=amount_cents),
 CHECK(status<>'accepted' OR (acceptance_authority_ref IS NOT NULL AND accepted_by_membership_id IS NOT NULL)),
 FOREIGN KEY(organization_id,opportunity_id) REFERENCES app.funding_opportunities(organization_id,id),
 FOREIGN KEY(organization_id,accepted_by_membership_id) REFERENCES app.memberships(organization_id,id)
);
CREATE TABLE app.funding_restrictions (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),organization_id app.entity_id NOT NULL,award_id app.entity_id NOT NULL,
 purpose text NOT NULL CHECK(length(purpose) BETWEEN 1 AND 500),amount_cents bigint NOT NULL CHECK(amount_cents>0),
 expires_at timestamptz,evidence_ref text NOT NULL CHECK(length(evidence_ref) BETWEEN 1 AND 240),created_at timestamptz NOT NULL DEFAULT app.utc_now(),
 UNIQUE(organization_id,id),FOREIGN KEY(organization_id,award_id) REFERENCES app.funding_awards(organization_id,id)
);
CREATE TABLE app.funding_receipts (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),organization_id app.entity_id NOT NULL,opportunity_id app.entity_id NOT NULL,
 family text NOT NULL CHECK(family IN ('grant','investment','sponsorship')),
 money_entry_key text NOT NULL,amount_cents bigint NOT NULL CHECK(amount_cents>0),
 award_id app.entity_id,restriction_id app.entity_id,restricted boolean NOT NULL DEFAULT false,
 recorded_at timestamptz NOT NULL DEFAULT app.utc_now(),UNIQUE(organization_id,money_entry_key),
 CHECK(restricted=(restriction_id IS NOT NULL)),CHECK(family<>'grant' OR award_id IS NOT NULL),
 FOREIGN KEY(organization_id,opportunity_id) REFERENCES app.funding_opportunities(organization_id,id),
 FOREIGN KEY(organization_id,money_entry_key) REFERENCES app.money_entries(organization_id,idempotency_key),
 FOREIGN KEY(organization_id,award_id) REFERENCES app.funding_awards(organization_id,id),
 FOREIGN KEY(organization_id,restriction_id) REFERENCES app.funding_restrictions(organization_id,id)
);
CREATE TABLE app.investor_meetings (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),organization_id app.entity_id NOT NULL,investor_id app.entity_id NOT NULL,opportunity_id app.entity_id,
 occurred_at timestamptz NOT NULL,qualified boolean NOT NULL DEFAULT false,interest_level text NOT NULL DEFAULT 'none' CHECK(interest_level IN ('none','low','medium','high')),
 summary text NOT NULL DEFAULT '' CHECK(length(summary)<=4000),evidence_ref text NOT NULL CHECK(length(evidence_ref) BETWEEN 1 AND 240),
 created_at timestamptz NOT NULL DEFAULT app.utc_now(),UNIQUE(organization_id,id),
 FOREIGN KEY(organization_id,investor_id) REFERENCES app.investor_organizations(organization_id,id),
 FOREIGN KEY(organization_id,opportunity_id) REFERENCES app.funding_opportunities(organization_id,id)
);
CREATE TABLE app.investor_communication_reviews (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),organization_id app.entity_id NOT NULL,investor_id app.entity_id NOT NULL,
 communication_class text NOT NULL CHECK(communication_class IN ('meeting_logistics','relationship_update','factual_company_update','offering_material')),
 content_hash text NOT NULL CHECK(content_hash ~ '^[0-9a-f]{64}$'),content text NOT NULL CHECK(length(content) BETWEEN 1 AND 20000),
 findings jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(findings)='array'),
 status text NOT NULL CHECK(status IN ('blocked','owner_legal_review_required','cleared_for_owner_send','approved_after_legal_review','rejected')),
 legal_review_ref text,approval_id app.entity_id,decided_by_membership_id app.entity_id,created_at timestamptz NOT NULL DEFAULT app.utc_now(),decided_at timestamptz,
 UNIQUE(organization_id,id),
 CHECK(status<>'approved_after_legal_review' OR (legal_review_ref IS NOT NULL AND approval_id IS NOT NULL AND decided_by_membership_id IS NOT NULL)),
 FOREIGN KEY(organization_id,investor_id) REFERENCES app.investor_organizations(organization_id,id),
 FOREIGN KEY(organization_id,approval_id) REFERENCES app.action_approvals(organization_id,id),
 FOREIGN KEY(organization_id,decided_by_membership_id) REFERENCES app.memberships(organization_id,id)
);
CREATE TABLE app.pitch_assets (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),organization_id app.entity_id NOT NULL,project_id app.entity_id NOT NULL,
 kind text NOT NULL CHECK(kind IN ('deck_narrative','investor_email','one_pager','sponsorship_proposal')),label text NOT NULL CHECK(length(label) BETWEEN 1 AND 160),
 current_version int NOT NULL DEFAULT 0 CHECK(current_version>=0),created_at timestamptz NOT NULL DEFAULT app.utc_now(),
 UNIQUE(organization_id,id),FOREIGN KEY(organization_id,project_id) REFERENCES app.projects(organization_id,id)
);
CREATE TABLE app.pitch_asset_versions (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),organization_id app.entity_id NOT NULL,asset_id app.entity_id NOT NULL,version int NOT NULL CHECK(version>0),
 content text NOT NULL CHECK(length(content) BETWEEN 1 AND 50000),fact_ids jsonb NOT NULL CHECK(jsonb_typeof(fact_ids)='array'),
 fact_snapshot_hash text NOT NULL,content_hash text NOT NULL CHECK(content_hash ~ '^[0-9a-f]{64}$'),
 created_by_membership_id app.entity_id NOT NULL,created_at timestamptz NOT NULL DEFAULT app.utc_now(),
 UNIQUE(organization_id,asset_id,version),FOREIGN KEY(organization_id,asset_id) REFERENCES app.pitch_assets(organization_id,id),
 FOREIGN KEY(organization_id,created_by_membership_id) REFERENCES app.memberships(organization_id,id)
);
CREATE TABLE app.funding_diligence_items (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),organization_id app.entity_id NOT NULL,opportunity_id app.entity_id NOT NULL,
 label text NOT NULL CHECK(length(label) BETWEEN 1 AND 200),document_id app.entity_id,completed boolean NOT NULL DEFAULT false,
 UNIQUE(organization_id,id),UNIQUE(organization_id,opportunity_id,label),CHECK(NOT completed OR document_id IS NOT NULL),
 FOREIGN KEY(organization_id,opportunity_id) REFERENCES app.funding_opportunities(organization_id,id),
 FOREIGN KEY(organization_id,document_id) REFERENCES app.document_library(organization_id,id)
);
CREATE TABLE app.investment_commitment_events (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),organization_id app.entity_id NOT NULL,opportunity_id app.entity_id NOT NULL,investor_id app.entity_id NOT NULL,
 stage text NOT NULL CHECK(stage IN ('meeting','interest','term_sheet','signed_commitment','cash_received')),
 amount_cents bigint NOT NULL DEFAULT 0 CHECK(amount_cents>=0),legal_status text NOT NULL CHECK(legal_status IN ('non_binding','under_legal_review','binding_signed','settled')),
 proof_ref text NOT NULL CHECK(length(proof_ref) BETWEEN 1 AND 240),document_id app.entity_id,meeting_id app.entity_id,
 legal_review_ref text,authority_ref text,money_entry_key text,recorded_by_membership_id app.entity_id NOT NULL,recorded_at timestamptz NOT NULL DEFAULT app.utc_now(),
 UNIQUE(organization_id,id),
 CHECK(stage<>'meeting' OR meeting_id IS NOT NULL),
 CHECK(stage<>'term_sheet' OR document_id IS NOT NULL),
 CHECK(stage<>'signed_commitment' OR (document_id IS NOT NULL AND legal_review_ref IS NOT NULL AND authority_ref IS NOT NULL AND amount_cents>0)),
 CHECK(stage<>'cash_received' OR (money_entry_key IS NOT NULL AND amount_cents>0)),
 FOREIGN KEY(organization_id,opportunity_id) REFERENCES app.funding_opportunities(organization_id,id),
 FOREIGN KEY(organization_id,investor_id) REFERENCES app.investor_organizations(organization_id,id),
 FOREIGN KEY(organization_id,document_id) REFERENCES app.document_library(organization_id,id),
 FOREIGN KEY(organization_id,meeting_id) REFERENCES app.investor_meetings(organization_id,id),
 FOREIGN KEY(organization_id,money_entry_key) REFERENCES app.money_entries(organization_id,idempotency_key),
 FOREIGN KEY(organization_id,recorded_by_membership_id) REFERENCES app.memberships(organization_id,id)
);
CREATE TABLE app.sponsorship_workflows (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),organization_id app.entity_id NOT NULL,opportunity_id app.entity_id NOT NULL,
 stage text NOT NULL DEFAULT 'research' CHECK(stage IN ('research','proposal','approved','contract_review','signed','exchanged','declined')),
 proposal_asset_id app.entity_id,approval_membership_id app.entity_id,contract_document_id app.entity_id,contract_review_ref text,
 signed_authority_ref text,signed_by_membership_id app.entity_id,signed_at timestamptz,
 version bigint NOT NULL DEFAULT 1,updated_at timestamptz NOT NULL DEFAULT app.utc_now(),UNIQUE(organization_id,id),UNIQUE(organization_id,opportunity_id),
 CHECK(stage NOT IN ('signed','exchanged') OR (signed_authority_ref IS NOT NULL AND signed_by_membership_id IS NOT NULL AND contract_document_id IS NOT NULL AND contract_review_ref IS NOT NULL)),
 FOREIGN KEY(organization_id,opportunity_id) REFERENCES app.funding_opportunities(organization_id,id),
 FOREIGN KEY(organization_id,proposal_asset_id) REFERENCES app.pitch_assets(organization_id,id),
 FOREIGN KEY(organization_id,approval_membership_id) REFERENCES app.memberships(organization_id,id),
 FOREIGN KEY(organization_id,contract_document_id) REFERENCES app.document_library(organization_id,id),
 FOREIGN KEY(organization_id,signed_by_membership_id) REFERENCES app.memberships(organization_id,id)
);
CREATE TABLE app.sponsorship_exchanges (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),organization_id app.entity_id NOT NULL,workflow_id app.entity_id NOT NULL,
 kind text NOT NULL CHECK(kind IN ('funds','in_kind')),description text NOT NULL CHECK(length(description) BETWEEN 1 AND 1000),
 value_cents bigint NOT NULL CHECK(value_cents>0),evidence_ref text NOT NULL CHECK(length(evidence_ref) BETWEEN 1 AND 240),money_entry_key text,
 recorded_at timestamptz NOT NULL DEFAULT app.utc_now(),CHECK((kind='funds')=(money_entry_key IS NOT NULL)),
 FOREIGN KEY(organization_id,workflow_id) REFERENCES app.sponsorship_workflows(organization_id,id),
 FOREIGN KEY(organization_id,money_entry_key) REFERENCES app.money_entries(organization_id,idempotency_key)
);
ALTER TABLE app.money_entries DROP CONSTRAINT money_entries_kind_check;
ALTER TABLE app.money_entries ADD CONSTRAINT money_entries_kind_check CHECK(kind IN ('expense','refund','sale_receipt','grant_disbursement','investment_receipt','sponsorship_receipt'));
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['funding_sources','funding_source_revisions','funding_connector_runs','funding_eligibility_rules','funding_applicant_profiles','funding_org_facts','investor_organizations','funding_eligibility_results','funding_applications','funding_application_answers','funding_application_documents','funding_application_reviews','funding_certifications','funding_milestones','funding_owner_alerts','funding_awards','funding_restrictions','funding_receipts','investor_meetings','investor_communication_reviews','pitch_assets','pitch_asset_versions','funding_diligence_items','investment_commitment_events','sponsorship_workflows','sponsorship_exchanges'] LOOP
  EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY',name);EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format('CREATE POLICY %I ON app.%I USING(organization_id=app.current_organization_id()) WITH CHECK(organization_id=app.current_organization_id())',name||'_tenant',name);
 END LOOP;
 FOREACH name IN ARRAY ARRAY['funding_source_revisions','funding_connector_runs','funding_eligibility_results','funding_application_reviews','funding_certifications','funding_receipts','pitch_asset_versions','investment_commitment_events','sponsorship_exchanges','funding_restrictions','investor_meetings'] LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON app.%I FOR EACH ROW EXECUTE FUNCTION app.deny_operation_evidence_mutation()',name||'_immutable',name);
 END LOOP;
END $$;
