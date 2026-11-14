-- DOTS-149/155/159: read-path indexes, incident records and read-only portfolio tokens.
CREATE INDEX IF NOT EXISTS crm_contacts_recent ON app.crm_contacts(organization_id,created_at DESC,id);
CREATE INDEX IF NOT EXISTS crm_contacts_status ON app.crm_contacts(organization_id,status,consent);
CREATE INDEX IF NOT EXISTS contact_events_timeline ON app.contact_events(organization_id,contact_id,created_at DESC);
CREATE INDEX IF NOT EXISTS conversations_recent ON app.conversations(organization_id,updated_at DESC,id);
CREATE INDEX IF NOT EXISTS messages_thread ON app.messages(organization_id,conversation_id,created_at);
CREATE INDEX IF NOT EXISTS messages_outbound_window ON app.messages(organization_id,campaign_id,state,sent_at) WHERE direction='outbound';
CREATE INDEX IF NOT EXISTS task_queue_agent_state ON app.task_queue(organization_id,agent_identity_id,state);
CREATE INDEX IF NOT EXISTS agent_runs_task ON app.agent_runs(organization_id,task_id,started_at DESC);
CREATE INDEX IF NOT EXISTS money_entries_kind ON app.money_entries(organization_id,kind,source,occurred_at DESC);
CREATE INDEX IF NOT EXISTS deals_stage ON app.deals(organization_id,stage);
CREATE INDEX IF NOT EXISTS funding_stage_deadline ON app.funding_opportunities(organization_id,stage,deadline);
CREATE INDEX IF NOT EXISTS approvals_pending ON app.action_approvals(organization_id,status,expires_at);
CREATE INDEX IF NOT EXISTS agent_identities_name ON app.agent_identities(organization_id,lower(display_name),id);
CREATE INDEX IF NOT EXISTS provider_receipts_pending ON app.provider_receipts(organization_id,provider,received_at DESC) WHERE processed_at IS NULL;

CREATE TABLE app.incidents (
  id app.entity_id PRIMARY KEY DEFAULT app.new_id(),
  organization_id app.entity_id NOT NULL REFERENCES app.organizations(id),
  kind text NOT NULL CHECK (kind IN ('kill_switch_drill','credential_revocation_drill','queue','budget','delivery','security','privacy','availability','other')),
  severity text NOT NULL CHECK (severity IN ('low','medium','high','critical')),
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','mitigated','resolved')),
  summary text NOT NULL CHECK (length(summary) BETWEEN 1 AND 500),
  opened_by_membership_id app.entity_id NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT app.utc_now(),
  resolved_at timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (organization_id,id),
  FOREIGN KEY (organization_id,opened_by_membership_id) REFERENCES app.memberships(organization_id,id),
  CHECK ((state='resolved') = (resolved_at IS NOT NULL))
);
CREATE INDEX incidents_open ON app.incidents(organization_id,state,opened_at DESC);
CREATE TABLE app.incident_events (
  id app.entity_id PRIMARY KEY DEFAULT app.new_id(),
  organization_id app.entity_id NOT NULL,
  incident_id app.entity_id NOT NULL,
  step text NOT NULL CHECK (step ~ '^[a-z][a-z0-9_.]{2,79}$'),
  outcome text NOT NULL CHECK (outcome IN ('passed','failed','info')),
  evidence jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(evidence)='object' AND octet_length(evidence::text)<=16384),
  recorded_at timestamptz NOT NULL DEFAULT app.utc_now(),
  FOREIGN KEY (organization_id,incident_id) REFERENCES app.incidents(organization_id,id)
);
CREATE INDEX incident_events_timeline ON app.incident_events(organization_id,incident_id,recorded_at);
CREATE TABLE app.portfolio_access_tokens (
  id app.entity_id PRIMARY KEY DEFAULT app.new_id(),
  organization_id app.entity_id NOT NULL REFERENCES app.organizations(id),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  scopes text[] NOT NULL DEFAULT ARRAY['portfolio:read'] CHECK (scopes <@ ARRAY['portfolio:read']::text[] AND cardinality(scopes) > 0),
  created_by_membership_id app.entity_id NOT NULL,
  created_at timestamptz NOT NULL DEFAULT app.utc_now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_used_at timestamptz,
  UNIQUE (organization_id,id),
  FOREIGN KEY (organization_id,created_by_membership_id) REFERENCES app.memberships(organization_id,id),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '366 days')
);
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['incidents','incident_events','portfolio_access_tokens'] LOOP
  EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY',name);
  EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format('CREATE POLICY %I ON app.%I USING (organization_id=app.current_organization_id()) WITH CHECK (organization_id=app.current_organization_id())',name||'_tenant',name);
 END LOOP;
END $$;
CREATE TRIGGER incident_events_immutable BEFORE UPDATE OR DELETE ON app.incident_events FOR EACH ROW EXECUTE FUNCTION app.deny_operation_evidence_mutation();
