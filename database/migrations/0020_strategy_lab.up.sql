-- DOTS-110..120 Strategy Lab: immutable strategy revisions, stored allocation rules,
-- deterministic stratified enrollment, verified outcome accounting, metrics, promotions and hybrids.
CREATE TABLE app.strategy_families (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),organization_id app.entity_id NOT NULL REFERENCES app.organizations(id),
 project_id app.entity_id,label text NOT NULL CHECK(length(label) BETWEEN 1 AND 120),
 owner_membership_id app.entity_id NOT NULL,status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
 created_at timestamptz NOT NULL DEFAULT app.utc_now(),UNIQUE(organization_id,id),
 FOREIGN KEY(organization_id,project_id) REFERENCES app.projects(organization_id,id),
 FOREIGN KEY(organization_id,owner_membership_id) REFERENCES app.memberships(organization_id,id)
);
CREATE TABLE app.strategy_revisions (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),organization_id app.entity_id NOT NULL,family_id app.entity_id NOT NULL,
 revision int NOT NULL CHECK(revision>0),objective text NOT NULL CHECK(length(objective) BETWEEN 1 AND 2000),
 audience_rules jsonb NOT NULL CHECK(jsonb_typeof(audience_rules)='array'),
 allowed_personalization jsonb NOT NULL CHECK(jsonb_typeof(allowed_personalization)='array'),
 forbidden_claims jsonb NOT NULL CHECK(jsonb_typeof(forbidden_claims)='array'),
 tone text NOT NULL CHECK(length(tone) BETWEEN 1 AND 200),disclosures jsonb NOT NULL CHECK(jsonb_typeof(disclosures)='array'),
 instructions text NOT NULL CHECK(length(instructions) BETWEEN 1 AND 6000),
 status text NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed','approved','rejected','retired')),
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[0-9a-f]{64}$'),created_by_membership_id app.entity_id NOT NULL,
 decided_by_membership_id app.entity_id,decided_at timestamptz,created_at timestamptz NOT NULL DEFAULT app.utc_now(),
 UNIQUE(organization_id,id),UNIQUE(organization_id,family_id,revision),
 FOREIGN KEY(organization_id,family_id) REFERENCES app.strategy_families(organization_id,id),
 FOREIGN KEY(organization_id,created_by_membership_id) REFERENCES app.memberships(organization_id,id),
 FOREIGN KEY(organization_id,decided_by_membership_id) REFERENCES app.memberships(organization_id,id)
);
CREATE TABLE app.strategy_lineage (
 organization_id app.entity_id NOT NULL,child_revision_id app.entity_id NOT NULL,parent_revision_id app.entity_id NOT NULL,
 inherited_elements jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(inherited_elements)='array'),
 created_at timestamptz NOT NULL DEFAULT app.utc_now(),PRIMARY KEY(organization_id,child_revision_id,parent_revision_id),
 CHECK(child_revision_id<>parent_revision_id),
 FOREIGN KEY(organization_id,child_revision_id) REFERENCES app.strategy_revisions(organization_id,id),
 FOREIGN KEY(organization_id,parent_revision_id) REFERENCES app.strategy_revisions(organization_id,id)
);
CREATE TABLE app.strategy_allocation_rules (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),organization_id app.entity_id NOT NULL,project_id app.entity_id NOT NULL,campaign_id app.entity_id,
 champion_revision_id app.entity_id,experimental_basis_points int NOT NULL CHECK(experimental_basis_points BETWEEN 0 AND 10000),
 min_exploration_basis_points int NOT NULL CHECK(min_exploration_basis_points BETWEEN 0 AND 5000),
 below_floor_acknowledgement text,auto_promote_enabled boolean NOT NULL DEFAULT false,
 version bigint NOT NULL DEFAULT 1 CHECK(version>0),updated_by_membership_id app.entity_id NOT NULL,
 created_at timestamptz NOT NULL DEFAULT app.utc_now(),updated_at timestamptz NOT NULL DEFAULT app.utc_now(),
 UNIQUE(organization_id,id),UNIQUE NULLS NOT DISTINCT(organization_id,project_id,campaign_id),
 CHECK(experimental_basis_points>=min_exploration_basis_points OR length(coalesce(below_floor_acknowledgement,''))>0),
 FOREIGN KEY(organization_id,project_id) REFERENCES app.projects(organization_id,id),
 FOREIGN KEY(organization_id,campaign_id) REFERENCES app.campaigns(organization_id,id),
 FOREIGN KEY(organization_id,champion_revision_id) REFERENCES app.strategy_revisions(organization_id,id),
 FOREIGN KEY(organization_id,updated_by_membership_id) REFERENCES app.memberships(organization_id,id)
);
CREATE TABLE app.strategy_allocation_history (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),organization_id app.entity_id NOT NULL,rule_id app.entity_id NOT NULL,version bigint NOT NULL,
 experimental_basis_points int NOT NULL,min_exploration_basis_points int NOT NULL,below_floor boolean NOT NULL,
 below_floor_acknowledgement text,auto_promote_enabled boolean NOT NULL,champion_revision_id app.entity_id,
 changed_by_membership_id app.entity_id NOT NULL,created_at timestamptz NOT NULL DEFAULT app.utc_now(),
 UNIQUE(organization_id,rule_id,version),CHECK(NOT below_floor OR length(coalesce(below_floor_acknowledgement,''))>0),
 FOREIGN KEY(organization_id,rule_id) REFERENCES app.strategy_allocation_rules(organization_id,id)
);
CREATE TABLE app.strategy_experiments (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),organization_id app.entity_id NOT NULL,project_id app.entity_id NOT NULL,campaign_id app.entity_id,
 allocation_rule_id app.entity_id NOT NULL,label text NOT NULL CHECK(length(label) BETWEEN 1 AND 160),
 design text NOT NULL CHECK(design IN ('ab','factorial')),revision int NOT NULL DEFAULT 1 CHECK(revision>0),previous_experiment_id app.entity_id,
 seed text NOT NULL CHECK(seed ~ '^[0-9a-f]{32}$'),min_sample_per_arm int NOT NULL CHECK(min_sample_per_arm BETWEEN 30 AND 1000000),
 lag_days int NOT NULL CHECK(lag_days BETWEEN 0 AND 365),alpha_basis_points int NOT NULL CHECK(alpha_basis_points BETWEEN 1 AND 2000),
 max_complaint_basis_points int NOT NULL CHECK(max_complaint_basis_points BETWEEN 0 AND 10000),
 max_unsubscribe_basis_points int NOT NULL CHECK(max_unsubscribe_basis_points BETWEEN 0 AND 10000),
 budget_cents bigint NOT NULL CHECK(budget_cents>=0),stratum_tolerance int NOT NULL CHECK(stratum_tolerance BETWEEN 1 AND 20),
 state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','paused','stopped','completed','superseded')),stop_reason text,
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[0-9a-f]{64}$'),created_by_membership_id app.entity_id NOT NULL,
 created_at timestamptz NOT NULL DEFAULT app.utc_now(),updated_at timestamptz NOT NULL DEFAULT app.utc_now(),
 UNIQUE(organization_id,id),
 FOREIGN KEY(organization_id,project_id) REFERENCES app.projects(organization_id,id),
 FOREIGN KEY(organization_id,campaign_id) REFERENCES app.campaigns(organization_id,id),
 FOREIGN KEY(organization_id,allocation_rule_id) REFERENCES app.strategy_allocation_rules(organization_id,id),
 FOREIGN KEY(organization_id,previous_experiment_id) REFERENCES app.strategy_experiments(organization_id,id),
 FOREIGN KEY(organization_id,created_by_membership_id) REFERENCES app.memberships(organization_id,id)
);
CREATE TABLE app.strategy_experiment_arms (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),organization_id app.entity_id NOT NULL,experiment_id app.entity_id NOT NULL,
 arm_key text NOT NULL CHECK(arm_key ~ '^[a-z0-9_-]{1,40}$'),role text NOT NULL CHECK(role IN ('champion','experimental')),
 strategy_revision_id app.entity_id NOT NULL,model_id text CHECK(model_id IS NULL OR length(model_id) BETWEEN 1 AND 120),
 created_at timestamptz NOT NULL DEFAULT app.utc_now(),
 UNIQUE(organization_id,id),UNIQUE(organization_id,experiment_id,id),UNIQUE(organization_id,experiment_id,arm_key),
 FOREIGN KEY(organization_id,experiment_id) REFERENCES app.strategy_experiments(organization_id,id),
 FOREIGN KEY(organization_id,strategy_revision_id) REFERENCES app.strategy_revisions(organization_id,id)
);
CREATE TABLE app.strategy_enrollments (
 organization_id app.entity_id NOT NULL,experiment_id app.entity_id NOT NULL,contact_id app.entity_id NOT NULL,arm_id app.entity_id NOT NULL,
 segment text NOT NULL CHECK(length(segment) BETWEEN 1 AND 80),stratum text NOT NULL CHECK(length(stratum) BETWEEN 1 AND 200),
 hash_bucket int NOT NULL CHECK(hash_bucket BETWEEN 0 AND 9999),assignment text NOT NULL CHECK(assignment IN ('randomized','balanced')),
 allocation_basis_points int NOT NULL CHECK(allocation_basis_points BETWEEN 0 AND 10000),allocation_version bigint NOT NULL,
 enrolled_at timestamptz NOT NULL DEFAULT app.utc_now(),PRIMARY KEY(organization_id,experiment_id,contact_id),
 FOREIGN KEY(organization_id,experiment_id,arm_id) REFERENCES app.strategy_experiment_arms(organization_id,experiment_id,id),
 FOREIGN KEY(organization_id,contact_id) REFERENCES app.crm_contacts(organization_id,id)
);
CREATE INDEX strategy_enrollments_contact ON app.strategy_enrollments(organization_id,contact_id);
CREATE INDEX strategy_enrollments_stratum ON app.strategy_enrollments(organization_id,experiment_id,stratum);
CREATE TABLE app.strategy_outcome_events (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),organization_id app.entity_id NOT NULL,experiment_id app.entity_id NOT NULL,
 contact_id app.entity_id NOT NULL,arm_id app.entity_id NOT NULL,
 kind text NOT NULL CHECK(kind IN ('sent','reply','qualified_response','meeting','deal','funds_received','spam_complaint','unsubscribe','cost')),
 amount_cents bigint NOT NULL DEFAULT 0 CHECK(amount_cents>=0),original_currency text NOT NULL DEFAULT 'USD' CHECK(original_currency ~ '^[A-Z]{3}$'),
 original_amount_minor bigint CHECK(original_amount_minor IS NULL OR original_amount_minor>=0),fx_source text,
 is_estimate boolean NOT NULL DEFAULT false,
 evidence_source text NOT NULL CHECK(evidence_source IN ('provider','owner_attested','simulation','model_claim')),
 receipt_provider text,receipt_event_id text,evidence_ref text CHECK(evidence_ref IS NULL OR length(evidence_ref) BETWEEN 1 AND 500),
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 200),
 occurred_at timestamptz NOT NULL,recorded_at timestamptz NOT NULL DEFAULT app.utc_now(),
 UNIQUE(organization_id,id),UNIQUE(organization_id,idempotency_key),
 CHECK(evidence_source<>'provider' OR (receipt_provider IS NOT NULL AND receipt_event_id IS NOT NULL)),
 CHECK(evidence_source<>'owner_attested' OR evidence_ref IS NOT NULL),
 CHECK(original_currency='USD' OR (original_amount_minor IS NOT NULL AND fx_source IS NOT NULL)),
 CHECK(kind<>'funds_received' OR (NOT is_estimate AND amount_cents>0)),
 CHECK(kind<>'cost' OR amount_cents>0),
 FOREIGN KEY(organization_id,experiment_id,contact_id) REFERENCES app.strategy_enrollments(organization_id,experiment_id,contact_id),
 FOREIGN KEY(organization_id,experiment_id,arm_id) REFERENCES app.strategy_experiment_arms(organization_id,experiment_id,id),
 FOREIGN KEY(organization_id,receipt_provider,receipt_event_id) REFERENCES app.provider_receipts(organization_id,provider,event_id)
);
CREATE INDEX strategy_outcome_events_arm ON app.strategy_outcome_events(organization_id,arm_id,kind);
CREATE TABLE app.strategy_metric_snapshots (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),organization_id app.entity_id NOT NULL,experiment_id app.entity_id NOT NULL,
 metrics jsonb NOT NULL,evaluation jsonb NOT NULL,fingerprint text NOT NULL CHECK(fingerprint ~ '^[0-9a-f]{64}$'),
 computed_at timestamptz NOT NULL DEFAULT app.utc_now(),UNIQUE(organization_id,id),
 FOREIGN KEY(organization_id,experiment_id) REFERENCES app.strategy_experiments(organization_id,id)
);
CREATE TABLE app.strategy_promotions (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),organization_id app.entity_id NOT NULL,allocation_rule_id app.entity_id NOT NULL,
 experiment_id app.entity_id,mode text NOT NULL CHECK(mode IN ('manual','automatic','rollback')),
 from_revision_id app.entity_id,to_revision_id app.entity_id,from_fingerprint text,to_fingerprint text,
 snapshot_id app.entity_id,safety jsonb NOT NULL DEFAULT '{}'::jsonb,rationale text NOT NULL CHECK(length(rationale) BETWEEN 1 AND 2000),
 uncertainty_acknowledged boolean NOT NULL DEFAULT false,reverts_promotion_id app.entity_id,
 created_by_membership_id app.entity_id NOT NULL,created_at timestamptz NOT NULL DEFAULT app.utc_now(),
 UNIQUE(organization_id,id),UNIQUE(organization_id,reverts_promotion_id),
 CHECK(mode='rollback' OR (experiment_id IS NOT NULL AND snapshot_id IS NOT NULL AND to_revision_id IS NOT NULL)),
 CHECK(mode<>'rollback' OR reverts_promotion_id IS NOT NULL),
 FOREIGN KEY(organization_id,allocation_rule_id) REFERENCES app.strategy_allocation_rules(organization_id,id),
 FOREIGN KEY(organization_id,experiment_id) REFERENCES app.strategy_experiments(organization_id,id),
 FOREIGN KEY(organization_id,from_revision_id) REFERENCES app.strategy_revisions(organization_id,id),
 FOREIGN KEY(organization_id,to_revision_id) REFERENCES app.strategy_revisions(organization_id,id),
 FOREIGN KEY(organization_id,snapshot_id) REFERENCES app.strategy_metric_snapshots(organization_id,id),
 FOREIGN KEY(organization_id,reverts_promotion_id) REFERENCES app.strategy_promotions(organization_id,id),
 FOREIGN KEY(organization_id,created_by_membership_id) REFERENCES app.memberships(organization_id,id)
);
CREATE TABLE app.strategy_variant_backlog (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(),organization_id app.entity_id NOT NULL,family_id app.entity_id NOT NULL,
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 160),hypothesis text NOT NULL CHECK(length(hypothesis) BETWEEN 1 AND 2000),
 parent_revision_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(parent_revision_ids)='array'),
 status text NOT NULL DEFAULT 'idea' CHECK(status IN ('idea','drafted','evaluating','adopted','rejected')),
 proposed_revision_id app.entity_id,created_by_membership_id app.entity_id NOT NULL,
 version bigint NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT app.utc_now(),updated_at timestamptz NOT NULL DEFAULT app.utc_now(),
 UNIQUE(organization_id,id),
 FOREIGN KEY(organization_id,family_id) REFERENCES app.strategy_families(organization_id,id),
 FOREIGN KEY(organization_id,proposed_revision_id) REFERENCES app.strategy_revisions(organization_id,id),
 FOREIGN KEY(organization_id,created_by_membership_id) REFERENCES app.memberships(organization_id,id)
);
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['strategy_families','strategy_revisions','strategy_lineage','strategy_allocation_rules','strategy_allocation_history','strategy_experiments','strategy_experiment_arms','strategy_enrollments','strategy_outcome_events','strategy_metric_snapshots','strategy_promotions','strategy_variant_backlog'] LOOP
  EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY',name);EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format('CREATE POLICY %I ON app.%I USING(organization_id=app.current_organization_id()) WITH CHECK(organization_id=app.current_organization_id())',name||'_tenant',name);
 END LOOP;
END $$;
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['strategy_lineage','strategy_allocation_history','strategy_experiment_arms','strategy_enrollments','strategy_outcome_events','strategy_metric_snapshots','strategy_promotions'] LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON app.%I FOR EACH ROW EXECUTE FUNCTION app.deny_operation_evidence_mutation()',name||'_immutable',name);
 END LOOP;
END $$;
CREATE FUNCTION app.preserve_strategy_revision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'strategy revisions are immutable' USING ERRCODE='42501'; END IF;
 IF (to_jsonb(NEW)-ARRAY['status','decided_by_membership_id','decided_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','decided_by_membership_id','decided_at']) THEN
  RAISE EXCEPTION 'strategy revision content is immutable; propose a new revision' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER strategy_revisions_guard BEFORE UPDATE OR DELETE ON app.strategy_revisions FOR EACH ROW EXECUTE FUNCTION app.preserve_strategy_revision();
CREATE FUNCTION app.preserve_strategy_experiment() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'strategy experiments are historical evidence' USING ERRCODE='42501'; END IF;
 IF (to_jsonb(NEW)-ARRAY['state','stop_reason','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','stop_reason','updated_at']) THEN
  RAISE EXCEPTION 'experiment design is immutable; create a new experiment revision' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER strategy_experiments_guard BEFORE UPDATE OR DELETE ON app.strategy_experiments FOR EACH ROW EXECUTE FUNCTION app.preserve_strategy_experiment();
-- Per-arm materialized accounting. Only provider receipts and owner attestations count; simulation and
-- model claims are reported separately as excluded so the UI can show what was ignored and why.
CREATE VIEW app.strategy_arm_metrics WITH (security_invoker=true) AS
SELECT a.organization_id,a.experiment_id,a.id AS arm_id,a.arm_key,a.role,a.strategy_revision_id,a.model_id,
 (SELECT count(*)::int FROM app.strategy_enrollments en WHERE en.organization_id=a.organization_id AND en.arm_id=a.id) AS enrolled,
 count(DISTINCT o.contact_id) FILTER(WHERE o.kind='sent' AND o.verified)::int AS exposed,
 count(DISTINCT o.contact_id) FILTER(WHERE o.kind='sent' AND o.verified AND o.occurred_at<=app.utc_now()-make_interval(days=>ex.lag_days))::int AS matured_exposed,
 count(DISTINCT o.contact_id) FILTER(WHERE o.kind='reply' AND o.verified)::int AS replies,
 count(DISTINCT o.contact_id) FILTER(WHERE o.kind='qualified_response' AND o.verified)::int AS qualified,
 count(DISTINCT o.contact_id) FILTER(WHERE o.kind='meeting' AND o.verified)::int AS meetings,
 count(DISTINCT o.contact_id) FILTER(WHERE o.kind='deal' AND o.verified)::int AS deals,
 count(DISTINCT o.contact_id) FILTER(WHERE o.kind='funds_received' AND o.verified)::int AS funded,
 count(DISTINCT o.contact_id) FILTER(WHERE o.kind='spam_complaint' AND o.verified)::int AS complaints,
 count(DISTINCT o.contact_id) FILTER(WHERE o.kind='unsubscribe' AND o.verified)::int AS unsubscribes,
 COALESCE(sum(o.amount_cents) FILTER(WHERE o.kind='funds_received' AND o.verified),0)::bigint AS funds_actual_cents,
 COALESCE(sum(o.amount_cents) FILTER(WHERE o.kind='funds_received' AND o.verified AND o.original_currency<>'USD'),0)::bigint AS funds_converted_cents,
 COALESCE(sum(o.amount_cents) FILTER(WHERE o.kind='deal' AND o.verified),0)::bigint AS deal_estimated_cents,
 COALESCE(sum(o.amount_cents) FILTER(WHERE o.kind='cost' AND o.verified AND NOT o.is_estimate),0)::bigint AS cost_actual_cents,
 COALESCE(sum(o.amount_cents) FILTER(WHERE o.kind='cost' AND o.verified AND o.is_estimate),0)::bigint AS cost_estimated_cents,
 count(o.id) FILTER(WHERE o.evidence_source='simulation')::int AS excluded_simulation_events,
 count(o.id) FILTER(WHERE o.evidence_source='model_claim')::int AS excluded_model_claim_events
FROM app.strategy_experiment_arms a
JOIN app.strategy_experiments ex ON ex.organization_id=a.organization_id AND ex.id=a.experiment_id
LEFT JOIN LATERAL (SELECT e.*,e.evidence_source IN ('provider','owner_attested') AS verified FROM app.strategy_outcome_events e WHERE e.organization_id=a.organization_id AND e.arm_id=a.id) o ON true
GROUP BY a.organization_id,a.experiment_id,a.id,a.arm_key,a.role,a.strategy_revision_id,a.model_id,ex.lag_days;
