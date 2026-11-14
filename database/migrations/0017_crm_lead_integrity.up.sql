-- DOTS-070..081: CRM accounts/people, lawful import staging, identity resolution, universal do-not-contact,
-- prospect ownership, segments, relationship timeline, configurable pipelines, deals and conservative attribution.
-- Builds only on tables from migrations 0001-0013.

-- DOTS-070: accounts and people gain normalized identity keys, a responsible owner and bounded searchable metadata.
ALTER TABLE app.crm_accounts
 ADD COLUMN domain text CHECK(domain IS NULL OR domain ~ '^[a-z0-9.-]{1,253}$'),
 ADD COLUMN normalized_name text,
 ADD COLUMN owner_membership_id app.entity_id,
 ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(metadata)='object' AND octet_length(metadata::text)<=4096),
 ADD COLUMN version bigint NOT NULL DEFAULT 1,
 ADD COLUMN updated_at timestamptz NOT NULL DEFAULT app.utc_now(),
 ADD CONSTRAINT crm_accounts_owner_fk FOREIGN KEY(organization_id,owner_membership_id) REFERENCES app.memberships(organization_id,id);
CREATE FUNCTION app.crm_normalize_organization(value text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
 SELECT regexp_replace(regexp_replace(lower(value),'\m(incorporated|inc|llc|ltd|limited|corp|corporation|co|company|gmbh|plc|ag|bv)\M','','g'),'[^a-z0-9]+','','g') $$;
CREATE FUNCTION app.crm_normalize_person(value text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT regexp_replace(lower(value),'[^a-z0-9]+','','g') $$;
CREATE FUNCTION app.crm_account_identity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.normalized_name:=app.crm_normalize_organization(NEW.name); RETURN NEW; END $$;
CREATE TRIGGER crm_accounts_identity BEFORE INSERT OR UPDATE OF name ON app.crm_accounts FOR EACH ROW EXECUTE FUNCTION app.crm_account_identity();
UPDATE app.crm_accounts SET normalized_name=app.crm_normalize_organization(name);
CREATE INDEX crm_accounts_normalized ON app.crm_accounts(organization_id,normalized_name);
CREATE INDEX crm_accounts_domain ON app.crm_accounts(organization_id,domain);

ALTER TABLE app.crm_contacts DROP CONSTRAINT IF EXISTS crm_contacts_status_check;
ALTER TABLE app.crm_contacts ADD CONSTRAINT crm_contacts_status_check CHECK(status IN ('active','suppressed','archived','redacted','merged'));
ALTER TABLE app.crm_contacts
 ADD COLUMN normalized_name text,
 ADD COLUMN email_domain text,
 ADD COLUMN owner_membership_id app.entity_id,
 ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(metadata)='object' AND octet_length(metadata::text)<=4096),
 ADD COLUMN merged_into_id app.entity_id,
 ADD CONSTRAINT crm_contacts_owner_fk FOREIGN KEY(organization_id,owner_membership_id) REFERENCES app.memberships(organization_id,id),
 ADD CONSTRAINT crm_contacts_merged_fk FOREIGN KEY(organization_id,merged_into_id) REFERENCES app.crm_contacts(organization_id,id),
 ADD CONSTRAINT crm_contacts_merge_state CHECK((status='merged')=(merged_into_id IS NOT NULL) AND merged_into_id IS DISTINCT FROM id);
CREATE FUNCTION app.crm_contact_identity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 NEW.normalized_name:=app.crm_normalize_person(NEW.display_name); NEW.email_domain:=CASE WHEN NEW.email IS NULL THEN NULL ELSE lower(split_part(NEW.email,'@',2)) END; RETURN NEW; END $$;
CREATE TRIGGER crm_contacts_identity BEFORE INSERT OR UPDATE OF display_name,email ON app.crm_contacts FOR EACH ROW EXECUTE FUNCTION app.crm_contact_identity();
UPDATE app.crm_contacts SET normalized_name=app.crm_normalize_person(display_name),email_domain=lower(split_part(email,'@',2));
CREATE INDEX crm_contacts_name_page ON app.crm_contacts(organization_id,(normalized_name COLLATE "C"),id);
CREATE INDEX crm_contacts_domain ON app.crm_contacts(organization_id,email_domain);
CREATE INDEX crm_contacts_account ON app.crm_contacts(organization_id,account_id);
CREATE INDEX crm_contacts_metadata ON app.crm_contacts USING gin(metadata jsonb_path_ops);

CREATE TABLE app.crm_aliases (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(), organization_id app.entity_id NOT NULL REFERENCES app.organizations(id),
 account_id app.entity_id, contact_id app.entity_id,
 alias text NOT NULL CHECK(length(alias) BETWEEN 1 AND 160), normalized text NOT NULL CHECK(length(normalized) BETWEEN 1 AND 160),
 created_at timestamptz NOT NULL DEFAULT app.utc_now(), UNIQUE(organization_id,id),
 CHECK((account_id IS NULL)<>(contact_id IS NULL)),
 FOREIGN KEY(organization_id,account_id) REFERENCES app.crm_accounts(organization_id,id),
 FOREIGN KEY(organization_id,contact_id) REFERENCES app.crm_contacts(organization_id,id)
);
CREATE UNIQUE INDEX crm_aliases_account_unique ON app.crm_aliases(organization_id,account_id,normalized) WHERE account_id IS NOT NULL;
CREATE UNIQUE INDEX crm_aliases_contact_unique ON app.crm_aliases(organization_id,contact_id,normalized) WHERE contact_id IS NOT NULL;
CREATE INDEX crm_aliases_lookup ON app.crm_aliases(organization_id,normalized);

CREATE TABLE app.crm_contact_methods (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(), organization_id app.entity_id NOT NULL REFERENCES app.organizations(id), contact_id app.entity_id NOT NULL,
 kind text NOT NULL CHECK(kind IN ('email','phone','url')), value text CHECK(value IS NULL OR length(value) BETWEEN 1 AND 320),
 value_hash text NOT NULL CHECK(value_hash ~ '^[0-9a-f]{64}$'), is_primary boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT app.utc_now(), UNIQUE(organization_id,id), UNIQUE(organization_id,kind,value_hash),
 FOREIGN KEY(organization_id,contact_id) REFERENCES app.crm_contacts(organization_id,id)
);
CREATE INDEX crm_contact_methods_contact ON app.crm_contact_methods(organization_id,contact_id);

-- DOTS-071: lawful source provenance and staging.
CREATE TABLE app.crm_import_batches (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(), organization_id app.entity_id NOT NULL REFERENCES app.organizations(id),
 source_label text NOT NULL CHECK(length(source_label) BETWEEN 1 AND 500),
 source_kind text NOT NULL CHECK(source_kind IN ('owner_collected','opt_in_form','existing_customer','event_registration','referral','public_business_directory','purchased_list','scraped','unknown')),
 purpose text NOT NULL CHECK(purpose IN ('product','grant','investment')),
 lawful_basis text NOT NULL CHECK(lawful_basis IN ('consent','legitimate_interest','contract','none')),
 state text NOT NULL DEFAULT 'staged' CHECK(state IN ('staged','committed','discarded')),
 total_rows int NOT NULL DEFAULT 0, valid_rows int NOT NULL DEFAULT 0, quarantined_rows int NOT NULL DEFAULT 0, duplicate_rows int NOT NULL DEFAULT 0,
 created_by_membership_id app.entity_id NOT NULL, committed_at timestamptz, version bigint NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT app.utc_now(), UNIQUE(organization_id,id),
 FOREIGN KEY(organization_id,created_by_membership_id) REFERENCES app.memberships(organization_id,id)
);
CREATE TABLE app.crm_import_rows (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(), organization_id app.entity_id NOT NULL, batch_id app.entity_id NOT NULL,
 row_number int NOT NULL CHECK(row_number>0), display_name text, email text, email_hash text, account_name text, domain text,
 jurisdiction text, consent text, consent_evidence text,
 status text NOT NULL CHECK(status IN ('valid','quarantined','duplicate','suppressed','committed','merged_source')),
 reasons text[] NOT NULL DEFAULT '{}', match_contact_id app.entity_id, created_contact_id app.entity_id,
 created_at timestamptz NOT NULL DEFAULT app.utc_now(), UNIQUE(organization_id,id), UNIQUE(organization_id,batch_id,row_number),
 FOREIGN KEY(organization_id,batch_id) REFERENCES app.crm_import_batches(organization_id,id),
 FOREIGN KEY(organization_id,match_contact_id) REFERENCES app.crm_contacts(organization_id,id),
 FOREIGN KEY(organization_id,created_contact_id) REFERENCES app.crm_contacts(organization_id,id)
);
CREATE TABLE app.crm_contact_sources (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(), organization_id app.entity_id NOT NULL, contact_id app.entity_id NOT NULL, batch_id app.entity_id,
 source_label text NOT NULL CHECK(length(source_label) BETWEEN 1 AND 500), source_kind text NOT NULL, purpose text NOT NULL, lawful_basis text NOT NULL,
 recorded_by_membership_id app.entity_id NOT NULL, created_at timestamptz NOT NULL DEFAULT app.utc_now(), UNIQUE(organization_id,id),
 FOREIGN KEY(organization_id,contact_id) REFERENCES app.crm_contacts(organization_id,id),
 FOREIGN KEY(organization_id,batch_id) REFERENCES app.crm_import_batches(organization_id,id)
);
CREATE INDEX crm_contact_sources_contact ON app.crm_contact_sources(organization_id,contact_id);

-- DOTS-072: dedupe candidates and append-only merge records.
CREATE TABLE app.crm_merge_candidates (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(), organization_id app.entity_id NOT NULL,
 primary_contact_id app.entity_id NOT NULL, duplicate_contact_id app.entity_id NOT NULL,
 score int NOT NULL CHECK(score BETWEEN 0 AND 100), reasons text[] NOT NULL,
 state text NOT NULL DEFAULT 'open' CHECK(state IN ('open','merged','dismissed')),
 decided_by_membership_id app.entity_id, decided_at timestamptz, created_at timestamptz NOT NULL DEFAULT app.utc_now(),
 UNIQUE(organization_id,id), CHECK(primary_contact_id<>duplicate_contact_id),
 FOREIGN KEY(organization_id,primary_contact_id) REFERENCES app.crm_contacts(organization_id,id),
 FOREIGN KEY(organization_id,duplicate_contact_id) REFERENCES app.crm_contacts(organization_id,id)
);
CREATE UNIQUE INDEX crm_merge_candidates_pair ON app.crm_merge_candidates(organization_id,LEAST(primary_contact_id::uuid,duplicate_contact_id::uuid),GREATEST(primary_contact_id::uuid,duplicate_contact_id::uuid));
CREATE TABLE app.crm_merges (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(), organization_id app.entity_id NOT NULL,
 survivor_contact_id app.entity_id NOT NULL, merged_contact_id app.entity_id NOT NULL, candidate_id app.entity_id,
 merged_snapshot jsonb NOT NULL, cross_account boolean NOT NULL DEFAULT false, decided_by_membership_id app.entity_id NOT NULL,
 created_at timestamptz NOT NULL DEFAULT app.utc_now(), UNIQUE(organization_id,id), UNIQUE(organization_id,merged_contact_id),
 FOREIGN KEY(organization_id,survivor_contact_id) REFERENCES app.crm_contacts(organization_id,id),
 FOREIGN KEY(organization_id,merged_contact_id) REFERENCES app.crm_contacts(organization_id,id),
 FOREIGN KEY(organization_id,candidate_id) REFERENCES app.crm_merge_candidates(organization_id,id)
);

-- DOTS-073: consent evidence history, region policies, frequency/exclusion policy, suppression history and audited overrides.
CREATE TABLE app.crm_consent_evidence (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(), organization_id app.entity_id NOT NULL, contact_id app.entity_id NOT NULL,
 consent text NOT NULL CHECK(consent IN ('unknown','opted_in','existing_customer','business_reviewed','opted_out')),
 evidence_ref text NOT NULL CHECK(length(evidence_ref) BETWEEN 1 AND 1000), jurisdiction text NOT NULL CHECK(length(jurisdiction) BETWEEN 1 AND 40),
 source text NOT NULL CHECK(source IN ('owner','import','provider','override')), recorded_by_membership_id app.entity_id,
 created_at timestamptz NOT NULL DEFAULT app.utc_now(), UNIQUE(organization_id,id),
 FOREIGN KEY(organization_id,contact_id) REFERENCES app.crm_contacts(organization_id,id)
);
CREATE INDEX crm_consent_evidence_contact ON app.crm_consent_evidence(organization_id,contact_id,created_at);
CREATE TABLE app.crm_region_policies (
 organization_id app.entity_id NOT NULL REFERENCES app.organizations(id), jurisdiction text NOT NULL CHECK(jurisdiction ~ '^[A-Z]{2}(-[A-Z0-9]{1,3})?$'),
 allowed boolean NOT NULL DEFAULT false, requires_opt_in boolean NOT NULL DEFAULT true,
 legal_review_ref text NOT NULL CHECK(length(legal_review_ref) BETWEEN 1 AND 240), version bigint NOT NULL DEFAULT 1,
 updated_by_membership_id app.entity_id NOT NULL, updated_at timestamptz NOT NULL DEFAULT app.utc_now(),
 PRIMARY KEY(organization_id,jurisdiction), FOREIGN KEY(organization_id,updated_by_membership_id) REFERENCES app.memberships(organization_id,id)
);
CREATE TABLE app.crm_contact_policies (
 organization_id app.entity_id PRIMARY KEY REFERENCES app.organizations(id),
 max_touches int NOT NULL DEFAULT 1 CHECK(max_touches BETWEEN 1 AND 20), window_days int NOT NULL DEFAULT 7 CHECK(window_days BETWEEN 1 AND 365),
 exclusion_days int NOT NULL DEFAULT 30 CHECK(exclusion_days BETWEEN 0 AND 365), version bigint NOT NULL DEFAULT 1,
 updated_by_membership_id app.entity_id NOT NULL, updated_at timestamptz NOT NULL DEFAULT app.utc_now(),
 FOREIGN KEY(organization_id,updated_by_membership_id) REFERENCES app.memberships(organization_id,id)
);
CREATE TABLE app.crm_suppression_history (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(), organization_id app.entity_id NOT NULL REFERENCES app.organizations(id), email_hash text NOT NULL,
 action text NOT NULL CHECK(action IN ('suppressed','overridden')), reason text NOT NULL, source text NOT NULL,
 lawful_basis text, audit_ref text, actor_membership_id app.entity_id, created_at timestamptz NOT NULL DEFAULT app.utc_now(), UNIQUE(organization_id,id),
 CHECK(action<>'overridden' OR (lawful_basis IN ('documented_new_opt_in','owner_entry_error') AND audit_ref IS NOT NULL AND length(audit_ref) BETWEEN 3 AND 240 AND actor_membership_id IS NOT NULL))
);
CREATE INDEX crm_suppression_history_hash ON app.crm_suppression_history(organization_id,email_hash,created_at);
-- The runtime role has no DELETE on contact_suppressions. Lifting a suppression is only possible through this function,
-- which requires an override audit row written in the same transaction and never lifts privacy erasures or complaints
-- without a documented new opt-in.
CREATE FUNCTION app.crm_lift_suppression(p_email_hash text, p_history_id app.entity_id) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE audit app.crm_suppression_history%ROWTYPE; current_source text;
BEGIN
 SELECT * INTO audit FROM app.crm_suppression_history WHERE id=p_history_id AND organization_id=app.current_organization_id()
  AND email_hash=p_email_hash AND action='overridden' AND created_at=now();
 IF NOT FOUND THEN RAISE EXCEPTION 'suppression override requires a lawful audit record'; END IF;
 SELECT source INTO current_source FROM app.contact_suppressions WHERE organization_id=app.current_organization_id() AND email_hash=p_email_hash;
 IF NOT FOUND THEN RETURN false; END IF;
 IF current_source='privacy' THEN RAISE EXCEPTION 'privacy erasure suppressions cannot be overridden'; END IF;
 IF current_source IN ('complaint','unsubscribe') AND audit.lawful_basis<>'documented_new_opt_in' THEN RAISE EXCEPTION 'opt-out suppressions require a documented new opt-in'; END IF;
 DELETE FROM app.contact_suppressions WHERE organization_id=app.current_organization_id() AND email_hash=p_email_hash;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION app.crm_lift_suppression(text,app.entity_id) FROM PUBLIC;

-- DOTS-074: prospect ownership claims.
CREATE TABLE app.crm_prospect_claims (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(), organization_id app.entity_id NOT NULL, contact_id app.entity_id NOT NULL,
 campaign_id app.entity_id NOT NULL, agent_identity_id app.entity_id NOT NULL,
 state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','released')), claimed_at timestamptz NOT NULL DEFAULT app.utc_now(),
 released_at timestamptz, exclusive_until timestamptz, release_reason text, UNIQUE(organization_id,id),
 CHECK((state='released')=(released_at IS NOT NULL)),
 FOREIGN KEY(organization_id,contact_id) REFERENCES app.crm_contacts(organization_id,id),
 FOREIGN KEY(organization_id,campaign_id) REFERENCES app.campaigns(organization_id,id),
 FOREIGN KEY(organization_id,agent_identity_id) REFERENCES app.agent_identities(organization_id,id)
);
CREATE UNIQUE INDEX crm_prospect_claims_one_active ON app.crm_prospect_claims(organization_id,contact_id) WHERE state='active';
CREATE INDEX crm_prospect_claims_recent ON app.crm_prospect_claims(organization_id,contact_id,exclusive_until);

-- DOTS-075: saved segments and evaluated membership snapshots.
CREATE TABLE app.crm_segments (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(), organization_id app.entity_id NOT NULL REFERENCES app.organizations(id),
 label text NOT NULL CHECK(length(label) BETWEEN 1 AND 160), filter jsonb NOT NULL CHECK(jsonb_typeof(filter)='object' AND octet_length(filter::text)<=4096),
 filter_hash text NOT NULL, version bigint NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT app.utc_now(), updated_at timestamptz NOT NULL DEFAULT app.utc_now(),
 UNIQUE(organization_id,id)
);
CREATE TABLE app.crm_segment_members (
 organization_id app.entity_id NOT NULL, segment_id app.entity_id NOT NULL, contact_id app.entity_id NOT NULL, segment_version bigint NOT NULL,
 evaluated_at timestamptz NOT NULL DEFAULT app.utc_now(), PRIMARY KEY(organization_id,segment_id,segment_version,contact_id),
 FOREIGN KEY(organization_id,segment_id) REFERENCES app.crm_segments(organization_id,id),
 FOREIGN KEY(organization_id,contact_id) REFERENCES app.crm_contacts(organization_id,id)
);
CREATE INDEX crm_segment_members_contact ON app.crm_segment_members(organization_id,contact_id);

-- DOTS-076: relationship events. Model-authored statements can never be stored as verified facts.
CREATE TABLE app.crm_relationship_events (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(), organization_id app.entity_id NOT NULL, contact_id app.entity_id NOT NULL,
 kind text NOT NULL CHECK(kind IN ('note','inbound','outreach','meeting','model_statement','handover')),
 summary text NOT NULL CHECK(length(summary) BETWEEN 1 AND 4000),
 actor_kind text NOT NULL CHECK(actor_kind IN ('owner','agent','model','provider')), actor_id text NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 200),
 source text NOT NULL CHECK(length(source) BETWEEN 1 AND 240), verified boolean NOT NULL DEFAULT false, evidence_ref text,
 occurred_at timestamptz NOT NULL DEFAULT app.utc_now(), UNIQUE(organization_id,id),
 CHECK(NOT (actor_kind='model' AND verified)), CHECK(NOT verified OR evidence_ref IS NOT NULL OR actor_kind='owner'),
 FOREIGN KEY(organization_id,contact_id) REFERENCES app.crm_contacts(organization_id,id)
);
CREATE INDEX crm_relationship_events_contact ON app.crm_relationship_events(organization_id,contact_id,occurred_at);

-- DOTS-077: configurable pipelines with evidence-guarded transitions.
CREATE TABLE app.crm_pipelines (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(), organization_id app.entity_id NOT NULL REFERENCES app.organizations(id),
 label text NOT NULL CHECK(length(label) BETWEEN 1 AND 120), is_default boolean NOT NULL DEFAULT false, version bigint NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT app.utc_now(), UNIQUE(organization_id,id)
);
CREATE UNIQUE INDEX crm_pipelines_default ON app.crm_pipelines(organization_id) WHERE is_default;
CREATE TABLE app.crm_pipeline_stages (
 organization_id app.entity_id NOT NULL, pipeline_id app.entity_id NOT NULL, stage_key text NOT NULL CHECK(stage_key ~ '^[a-z][a-z0-9_]{1,39}$'),
 label text NOT NULL CHECK(length(label) BETWEEN 1 AND 80), position int NOT NULL CHECK(position BETWEEN 0 AND 100),
 outcome text NOT NULL CHECK(outcome IN ('open','won','lost')),
 evidence_rule text NOT NULL CHECK(evidence_rule IN ('none','owner_note','document','verified_payment_or_signature')),
 probability_label text NOT NULL CHECK(probability_label IN ('unknown','low','medium','high','closed')),
 PRIMARY KEY(organization_id,pipeline_id,stage_key), UNIQUE(organization_id,pipeline_id,position),
 CHECK(outcome<>'won' OR evidence_rule='verified_payment_or_signature'),
 FOREIGN KEY(organization_id,pipeline_id) REFERENCES app.crm_pipelines(organization_id,id)
);
CREATE TABLE app.crm_pipeline_transitions (
 organization_id app.entity_id NOT NULL, pipeline_id app.entity_id NOT NULL, from_stage text NOT NULL, to_stage text NOT NULL,
 PRIMARY KEY(organization_id,pipeline_id,from_stage,to_stage), CHECK(from_stage<>to_stage),
 FOREIGN KEY(organization_id,pipeline_id,from_stage) REFERENCES app.crm_pipeline_stages(organization_id,pipeline_id,stage_key),
 FOREIGN KEY(organization_id,pipeline_id,to_stage) REFERENCES app.crm_pipeline_stages(organization_id,pipeline_id,stage_key)
);

-- DOTS-078: deals become multi-contact opportunities on a configurable pipeline.
ALTER TABLE app.deals DROP CONSTRAINT IF EXISTS deals_stage_check;
ALTER TABLE app.deals ADD CONSTRAINT deals_stage_check CHECK(stage ~ '^[a-z][a-z0-9_]{1,39}$');
ALTER TABLE app.deals
 ADD COLUMN pipeline_id app.entity_id, ADD COLUMN campaign_id app.entity_id, ADD COLUMN expected_close_at timestamptz,
 ADD COLUMN probability_label text NOT NULL DEFAULT 'unknown' CHECK(probability_label IN ('unknown','low','medium','high','closed')),
 ADD COLUMN won_at timestamptz,
 ADD CONSTRAINT deals_pipeline_fk FOREIGN KEY(organization_id,pipeline_id) REFERENCES app.crm_pipelines(organization_id,id),
 ADD CONSTRAINT deals_campaign_fk FOREIGN KEY(organization_id,campaign_id) REFERENCES app.campaigns(organization_id,id);
CREATE TABLE app.crm_deal_contacts (
 organization_id app.entity_id NOT NULL, deal_id app.entity_id NOT NULL, contact_id app.entity_id NOT NULL,
 role text NOT NULL DEFAULT 'participant' CHECK(role IN ('decision_maker','champion','participant','billing')),
 created_at timestamptz NOT NULL DEFAULT app.utc_now(), PRIMARY KEY(organization_id,deal_id,contact_id),
 FOREIGN KEY(organization_id,deal_id) REFERENCES app.deals(organization_id,id), FOREIGN KEY(organization_id,contact_id) REFERENCES app.crm_contacts(organization_id,id)
);
CREATE TABLE app.crm_deal_invoices (
 organization_id app.entity_id NOT NULL, deal_id app.entity_id NOT NULL, invoice_id app.entity_id NOT NULL,
 created_at timestamptz NOT NULL DEFAULT app.utc_now(), PRIMARY KEY(organization_id,invoice_id),
 FOREIGN KEY(organization_id,deal_id) REFERENCES app.deals(organization_id,id), FOREIGN KEY(organization_id,invoice_id) REFERENCES app.invoices(organization_id,id)
);
CREATE TABLE app.crm_deal_transitions (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(), organization_id app.entity_id NOT NULL, deal_id app.entity_id NOT NULL,
 from_stage text NOT NULL, to_stage text NOT NULL, evidence_kind text NOT NULL CHECK(evidence_kind IN ('none','owner_note','document','paid_invoice','provider_receipt')),
 evidence_ref text, actor_membership_id app.entity_id NOT NULL, created_at timestamptz NOT NULL DEFAULT app.utc_now(), UNIQUE(organization_id,id),
 CHECK(evidence_kind='none' OR evidence_ref IS NOT NULL),
 FOREIGN KEY(organization_id,deal_id) REFERENCES app.deals(organization_id,id)
);
CREATE INDEX crm_deal_transitions_deal ON app.crm_deal_transitions(organization_id,deal_id,created_at);

-- DOTS-079: verified touchpoints and one attribution row per won deal and model.
CREATE TABLE app.crm_touchpoints (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(), organization_id app.entity_id NOT NULL, contact_id app.entity_id NOT NULL,
 campaign_id app.entity_id, agent_identity_id app.entity_id, channel text NOT NULL CHECK(channel IN ('email','phone','meeting','web')),
 direction text NOT NULL CHECK(direction IN ('outbound','inbound')), message_id app.entity_id, receipt_ref text NOT NULL CHECK(length(receipt_ref) BETWEEN 1 AND 240),
 verified boolean NOT NULL, occurred_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT app.utc_now(),
 UNIQUE(organization_id,id), UNIQUE(organization_id,receipt_ref),
 FOREIGN KEY(organization_id,contact_id) REFERENCES app.crm_contacts(organization_id,id),
 FOREIGN KEY(organization_id,campaign_id) REFERENCES app.campaigns(organization_id,id),
 FOREIGN KEY(organization_id,agent_identity_id) REFERENCES app.agent_identities(organization_id,id),
 FOREIGN KEY(organization_id,message_id) REFERENCES app.messages(organization_id,id)
);
CREATE INDEX crm_touchpoints_contact ON app.crm_touchpoints(organization_id,contact_id,occurred_at);
CREATE TABLE app.crm_attributions (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(), organization_id app.entity_id NOT NULL, deal_id app.entity_id NOT NULL,
 model text NOT NULL CHECK(model IN ('first_touch','last_touch')), touchpoint_id app.entity_id NOT NULL, campaign_id app.entity_id,
 received_cents bigint NOT NULL CHECK(received_cents>0), receipt_evidence text NOT NULL, window_days int NOT NULL, dedup_hours int NOT NULL,
 created_at timestamptz NOT NULL DEFAULT app.utc_now(), UNIQUE(organization_id,id), UNIQUE(organization_id,deal_id,model),
 FOREIGN KEY(organization_id,deal_id) REFERENCES app.deals(organization_id,id),
 FOREIGN KEY(organization_id,touchpoint_id) REFERENCES app.crm_touchpoints(organization_id,id),
 FOREIGN KEY(organization_id,campaign_id) REFERENCES app.campaigns(organization_id,id)
);

DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['crm_aliases','crm_contact_methods','crm_import_batches','crm_import_rows','crm_contact_sources','crm_merge_candidates','crm_merges','crm_consent_evidence','crm_region_policies','crm_contact_policies','crm_suppression_history','crm_prospect_claims','crm_segments','crm_segment_members','crm_relationship_events','crm_pipelines','crm_pipeline_stages','crm_pipeline_transitions','crm_deal_contacts','crm_deal_invoices','crm_deal_transitions','crm_touchpoints','crm_attributions'] LOOP
  EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY',name);EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format('CREATE POLICY %I ON app.%I USING(organization_id=app.current_organization_id()) WITH CHECK(organization_id=app.current_organization_id())',name||'_tenant',name);
 END LOOP;
 FOREACH name IN ARRAY ARRAY['crm_contact_sources','crm_merges','crm_consent_evidence','crm_suppression_history','crm_deal_transitions','crm_attributions','crm_touchpoints'] LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON app.%I FOR EACH ROW EXECUTE FUNCTION app.deny_operation_evidence_mutation()',name||'_immutable',name);
 END LOOP;
END $$;
-- Relationship events are append-only except for privacy erasure, which may only blank the summary and evidence reference.
CREATE FUNCTION app.crm_relationship_event_redaction_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'operation evidence is append-only' USING ERRCODE='42501'; END IF;
 IF NEW.summary<>'[Redacted]' OR NEW.evidence_ref IS NOT NULL OR (to_jsonb(NEW)-ARRAY['summary','evidence_ref']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['summary','evidence_ref']) THEN
  RAISE EXCEPTION 'relationship events may only be redacted' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER crm_relationship_events_redaction_only BEFORE UPDATE OR DELETE ON app.crm_relationship_events FOR EACH ROW EXECUTE FUNCTION app.crm_relationship_event_redaction_only();
-- Privacy erasure (status -> 'redacted' by the existing redaction workflow) also erases CRM copies of personal data.
-- SECURITY DEFINER so the runtime role needs no DELETE/UPDATE grants on these tables; scoped to the row's tenant.
CREATE FUNCTION app.crm_redact_contact_records() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$ BEGIN
 UPDATE app.crm_contact_methods SET value=NULL WHERE organization_id=NEW.organization_id AND contact_id=NEW.id AND value IS NOT NULL;
 DELETE FROM app.crm_aliases WHERE organization_id=NEW.organization_id AND contact_id=NEW.id;
 UPDATE app.crm_import_rows SET display_name=NULL,email=NULL,consent_evidence=NULL WHERE organization_id=NEW.organization_id AND email_hash=NEW.email_hash;
 UPDATE app.crm_relationship_events SET summary='[Redacted]',evidence_ref=NULL WHERE organization_id=NEW.organization_id AND contact_id=NEW.id AND summary<>'[Redacted]';
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.crm_redact_contact_records() FROM PUBLIC;
CREATE TRIGGER crm_contacts_redaction AFTER UPDATE OF status ON app.crm_contacts FOR EACH ROW WHEN (NEW.status='redacted' AND OLD.status IS DISTINCT FROM 'redacted') EXECUTE FUNCTION app.crm_redact_contact_records();
