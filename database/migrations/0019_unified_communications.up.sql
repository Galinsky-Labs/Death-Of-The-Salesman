-- DOTS-094..DOTS-108: tenant-scoped mailboxes, canonical threading, versioned drafts,
-- dispatch attempts, reconciliation, opt-out evidence, sender health, reply triage,
-- follow-up sequences, human takeover and attachment scanning.

-- DOTS-094: tenant-scoped mailbox onboarding. Mailboxes stay disabled until the owner consents.
ALTER TABLE app.mailboxes DROP CONSTRAINT mailboxes_provider_check;
ALTER TABLE app.mailboxes ADD CONSTRAINT mailboxes_provider_check CHECK(provider IN ('resend','generic','gmail','microsoft365'));
ALTER TABLE app.mailboxes
 ADD COLUMN connection_kind text NOT NULL DEFAULT 'api_key' CHECK(connection_kind IN ('api_key','oauth')),
 ADD COLUMN oauth_scopes text[] NOT NULL DEFAULT '{}',
 ADD COLUMN token_ref text CHECK(token_ref IS NULL OR token_ref ~ '^(env|vault):[A-Za-z0-9_./-]{3,120}$'),
 ADD COLUMN token_rotated_at timestamptz,
 ADD COLUMN token_expires_at timestamptz,
 ADD COLUMN owner_consent_at timestamptz,
 ADD COLUMN owner_consent_by app.entity_id,
 ADD COLUMN owner_consent_ref text CHECK(owner_consent_ref IS NULL OR length(owner_consent_ref) BETWEEN 1 AND 200),
 ADD COLUMN spf_status text NOT NULL DEFAULT 'unknown' CHECK(spf_status IN ('unknown','pending','pass','fail')),
 ADD COLUMN dkim_status text NOT NULL DEFAULT 'unknown' CHECK(dkim_status IN ('unknown','pending','pass','fail')),
 ADD COLUMN dmarc_status text NOT NULL DEFAULT 'unknown' CHECK(dmarc_status IN ('unknown','pending','pass','fail')),
 ADD COLUMN auth_checked_at timestamptz,
 ADD COLUMN pause_reason text CHECK(pause_reason IS NULL OR length(pause_reason)<=200),
 ADD COLUMN version bigint NOT NULL DEFAULT 1;
-- No global shared sender: a consented sender address belongs to exactly one tenant.
CREATE UNIQUE INDEX mailboxes_consented_sender_unique ON app.mailboxes(lower(sender_email)) WHERE owner_consent_at IS NOT NULL;

CREATE TABLE app.sender_profiles (
 organization_id app.entity_id PRIMARY KEY REFERENCES app.organizations(id),
 legal_name text NOT NULL CHECK(length(legal_name) BETWEEN 1 AND 200),
 postal_address text NOT NULL CHECK(length(postal_address) BETWEEN 10 AND 500),
 version bigint NOT NULL DEFAULT 1,
 updated_by_membership_id app.entity_id NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT app.utc_now()
);
CREATE TABLE app.mailbox_auth_checks (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(), organization_id app.entity_id NOT NULL, mailbox_id app.entity_id NOT NULL,
 spf_status text NOT NULL CHECK(spf_status IN ('unknown','pending','pass','fail')),
 dkim_status text NOT NULL CHECK(dkim_status IN ('unknown','pending','pass','fail')),
 dmarc_status text NOT NULL CHECK(dmarc_status IN ('unknown','pending','pass','fail')),
 source text NOT NULL CHECK(source IN ('provider','simulation')), evidence_hash text NOT NULL CHECK(evidence_hash ~ '^[0-9a-f]{64}$'),
 checked_at timestamptz NOT NULL DEFAULT app.utc_now(), UNIQUE(organization_id,id),
 FOREIGN KEY(organization_id,mailbox_id) REFERENCES app.mailboxes(organization_id,id)
);
CREATE TABLE app.mailbox_credential_rotations (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(), organization_id app.entity_id NOT NULL, mailbox_id app.entity_id NOT NULL,
 token_ref text NOT NULL CHECK(token_ref ~ '^(env|vault):[A-Za-z0-9_./-]{3,120}$'), expires_at timestamptz,
 rotated_by_membership_id app.entity_id NOT NULL, rotated_at timestamptz NOT NULL DEFAULT app.utc_now(), UNIQUE(organization_id,id),
 FOREIGN KEY(organization_id,mailbox_id) REFERENCES app.mailboxes(organization_id,id)
);
-- DOTS-095: bounded polling cursors.
CREATE TABLE app.mailbox_sync_cursors (
 organization_id app.entity_id NOT NULL, mailbox_id app.entity_id NOT NULL,
 cursor text CHECK(cursor IS NULL OR length(cursor) BETWEEN 1 AND 500),
 last_polled_at timestamptz, next_poll_after timestamptz NOT NULL DEFAULT app.utc_now(),
 imported_total bigint NOT NULL DEFAULT 0 CHECK(imported_total>=0), last_result text,
 version bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(organization_id,mailbox_id), FOREIGN KEY(organization_id,mailbox_id) REFERENCES app.mailboxes(organization_id,id)
);

-- DOTS-096/105/106: canonical conversation metadata, takeover and SLA.
ALTER TABLE app.conversations
 ADD COLUMN campaign_id app.entity_id,
 ADD COLUMN mailbox_id app.entity_id,
 ADD COLUMN normalized_subject text,
 ADD COLUMN claimed_by_membership_id app.entity_id,
 ADD COLUMN claimed_at timestamptz,
 ADD COLUMN agent_delegated boolean NOT NULL DEFAULT false,
 ADD COLUMN needs_owner boolean NOT NULL DEFAULT false,
 ADD COLUMN priority int NOT NULL DEFAULT 0 CHECK(priority BETWEEN 0 AND 3),
 ADD COLUMN sla_due_at timestamptz,
 ADD COLUMN last_inbound_at timestamptz;
ALTER TABLE app.conversations ADD CONSTRAINT conversations_campaign_fk FOREIGN KEY(organization_id,campaign_id) REFERENCES app.campaigns(organization_id,id);
ALTER TABLE app.conversations ADD CONSTRAINT conversations_mailbox_fk FOREIGN KEY(organization_id,mailbox_id) REFERENCES app.mailboxes(organization_id,id);
CREATE INDEX conversations_owner_queue ON app.conversations(organization_id,needs_owner DESC,priority DESC,sla_due_at);

-- DOTS-105: follow-up sequences.
CREATE TABLE app.follow_up_sequences (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(), organization_id app.entity_id NOT NULL, campaign_id app.entity_id NOT NULL,
 label text NOT NULL CHECK(length(label) BETWEEN 1 AND 160),
 subject_template text NOT NULL CHECK(length(subject_template) BETWEEN 1 AND 240),
 body_template text NOT NULL CHECK(length(body_template) BETWEEN 1 AND 20000),
 max_touches int NOT NULL CHECK(max_touches BETWEEN 1 AND 10), interval_days int NOT NULL CHECK(interval_days BETWEEN 1 AND 90),
 quiet_start_hour int NOT NULL DEFAULT 18 CHECK(quiet_start_hour BETWEEN 0 AND 23), quiet_end_hour int NOT NULL DEFAULT 9 CHECK(quiet_end_hour BETWEEN 0 AND 23),
 timezone text NOT NULL DEFAULT 'America/New_York' CHECK(length(timezone) BETWEEN 1 AND 64),
 state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','paused','archived')), version bigint NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT app.utc_now(), UNIQUE(organization_id,id),
 FOREIGN KEY(organization_id,campaign_id) REFERENCES app.campaigns(organization_id,id)
);
CREATE TABLE app.sequence_enrollments (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(), organization_id app.entity_id NOT NULL, sequence_id app.entity_id NOT NULL,
 contact_id app.entity_id NOT NULL, conversation_id app.entity_id NOT NULL,
 state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','paused','completed','cancelled')),
 state_reason text CHECK(state_reason IS NULL OR length(state_reason)<=80), version bigint NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT app.utc_now(), updated_at timestamptz NOT NULL DEFAULT app.utc_now(),
 UNIQUE(organization_id,id), UNIQUE(organization_id,sequence_id,contact_id),
 FOREIGN KEY(organization_id,sequence_id) REFERENCES app.follow_up_sequences(organization_id,id),
 FOREIGN KEY(organization_id,contact_id) REFERENCES app.crm_contacts(organization_id,id),
 FOREIGN KEY(organization_id,conversation_id) REFERENCES app.conversations(organization_id,id)
);
CREATE TABLE app.sequence_steps (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(), organization_id app.entity_id NOT NULL, enrollment_id app.entity_id NOT NULL,
 touch_number int NOT NULL CHECK(touch_number BETWEEN 1 AND 10), due_at timestamptz NOT NULL,
 state text NOT NULL DEFAULT 'scheduled' CHECK(state IN ('scheduled','dispatching','sent','cancelled','skipped')),
 message_id app.entity_id, state_reason text CHECK(state_reason IS NULL OR length(state_reason)<=80),
 updated_at timestamptz NOT NULL DEFAULT app.utc_now(), UNIQUE(organization_id,id), UNIQUE(organization_id,enrollment_id,touch_number),
 FOREIGN KEY(organization_id,enrollment_id) REFERENCES app.sequence_enrollments(organization_id,id)
);
CREATE INDEX sequence_steps_due ON app.sequence_steps(organization_id,state,due_at);

-- DOTS-096/098/099/101: canonical message headers, revisions, delivery and approval state.
ALTER TABLE app.messages DROP CONSTRAINT messages_state_check;
ALTER TABLE app.messages ADD CONSTRAINT messages_state_check CHECK(state IN ('draft','pending_approval','approved','sending','sent','delivered','received','failed','quarantined','redacted','cancelled'));
ALTER TABLE app.messages
 ADD COLUMN mailbox_id app.entity_id,
 ADD COLUMN message_id_header text CHECK(message_id_header IS NULL OR length(message_id_header) BETWEEN 3 AND 500),
 ADD COLUMN in_reply_to_header text CHECK(in_reply_to_header IS NULL OR length(in_reply_to_header) BETWEEN 3 AND 500),
 ADD COLUMN references_headers text[] NOT NULL DEFAULT '{}',
 ADD COLUMN from_address text CHECK(from_address IS NULL OR length(from_address)<=320),
 ADD COLUMN to_addresses text[] NOT NULL DEFAULT '{}',
 ADD COLUMN cc_addresses text[] NOT NULL DEFAULT '{}',
 ADD COLUMN reply_mode text NOT NULL DEFAULT 'new' CHECK(reply_mode IN ('new','reply','forward')),
 ADD COLUMN ai_generated boolean NOT NULL DEFAULT false,
 ADD COLUMN authentication text NOT NULL DEFAULT 'unknown' CHECK(authentication IN ('unknown','pass','fail')),
 ADD COLUMN delivery_status text CHECK(delivery_status IS NULL OR delivery_status IN ('accepted','deferred','delivered','bounced','complained','failed')),
 ADD COLUMN delivery_updated_at timestamptz,
 ADD COLUMN received_at timestamptz,
 ADD COLUMN current_revision int CHECK(current_revision IS NULL OR current_revision>0),
 ADD COLUMN approved_revision int,
 ADD COLUMN approved_revision_hash text,
 ADD COLUMN draft_expires_at timestamptz,
 ADD COLUMN attachment_ids uuid[] NOT NULL DEFAULT '{}',
 ADD COLUMN sequence_step_id app.entity_id;
ALTER TABLE app.messages ADD CONSTRAINT messages_mailbox_fk FOREIGN KEY(organization_id,mailbox_id) REFERENCES app.mailboxes(organization_id,id);
ALTER TABLE app.messages ADD CONSTRAINT messages_sequence_step_fk FOREIGN KEY(organization_id,sequence_step_id) REFERENCES app.sequence_steps(organization_id,id);
ALTER TABLE app.sequence_steps ADD CONSTRAINT sequence_steps_message_fk FOREIGN KEY(organization_id,message_id) REFERENCES app.messages(organization_id,id);
CREATE UNIQUE INDEX messages_header_unique ON app.messages(organization_id,message_id_header) WHERE message_id_header IS NOT NULL;

CREATE TABLE app.message_revisions (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(), organization_id app.entity_id NOT NULL, message_id app.entity_id NOT NULL,
 revision int NOT NULL CHECK(revision>0),
 subject text NOT NULL CHECK(length(subject) BETWEEN 1 AND 240), body text NOT NULL CHECK(length(body) BETWEEN 1 AND 50000),
 to_addresses text[] NOT NULL, cc_addresses text[] NOT NULL DEFAULT '{}', headers jsonb NOT NULL DEFAULT '{}',
 variables jsonb NOT NULL DEFAULT '{}', source_evidence jsonb NOT NULL DEFAULT '[]', attachment_ids uuid[] NOT NULL DEFAULT '{}',
 reply_mode text NOT NULL CHECK(reply_mode IN ('new','reply','forward')),
 author_kind text NOT NULL CHECK(author_kind IN ('owner','model')), ai_generated boolean NOT NULL,
 expires_at timestamptz NOT NULL, content_hash text NOT NULL CHECK(content_hash ~ '^[0-9a-f]{64}$'),
 created_by_membership_id app.entity_id NOT NULL, created_at timestamptz NOT NULL DEFAULT app.utc_now(),
 UNIQUE(organization_id,id), UNIQUE(organization_id,message_id,revision),
 CHECK(author_kind<>'model' OR ai_generated),
 FOREIGN KEY(organization_id,message_id) REFERENCES app.messages(organization_id,id)
);

-- DOTS-100/101: dispatch attempts and owner reconciliation.
CREATE TABLE app.dispatch_attempts (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(), organization_id app.entity_id NOT NULL, message_id app.entity_id NOT NULL,
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 200), reservation_id app.entity_id,
 cost_cents bigint NOT NULL DEFAULT 0 CHECK(cost_cents>=0),
 state text NOT NULL DEFAULT 'dispatching' CHECK(state IN ('dispatching','accepted','rejected','uncertain','resolved_sent','resolved_not_sent')),
 provider_message_id text CHECK(provider_message_id IS NULL OR provider_message_id ~ '^[A-Za-z0-9_.:@-]{1,200}$'),
 receipt_hash text CHECK(receipt_hash IS NULL OR receipt_hash ~ '^[0-9a-f]{64}$'), reason_code text CHECK(reason_code IS NULL OR length(reason_code)<=80),
 started_at timestamptz NOT NULL DEFAULT app.utc_now(), finished_at timestamptz, UNIQUE(organization_id,id),
 FOREIGN KEY(organization_id,message_id) REFERENCES app.messages(organization_id,id)
);
CREATE UNIQUE INDEX dispatch_attempts_one_open ON app.dispatch_attempts(organization_id,message_id) WHERE state IN ('dispatching','uncertain');
CREATE TABLE app.reconciliation_items (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(), organization_id app.entity_id NOT NULL,
 kind text NOT NULL CHECK(kind IN ('uncertain_send','unmatched_receipt','unverified_inbound','thread_mismatch')),
 message_id app.entity_id, provider_ref text CHECK(provider_ref IS NULL OR length(provider_ref)<=200), details jsonb NOT NULL DEFAULT '{}',
 state text NOT NULL DEFAULT 'open' CHECK(state IN ('open','resolved')),
 resolution text CHECK(resolution IS NULL OR resolution IN ('sent','not_sent','accepted','dismissed')),
 evidence text CHECK(evidence IS NULL OR length(evidence) BETWEEN 1 AND 500), resolved_by_membership_id app.entity_id, resolved_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT app.utc_now(), UNIQUE(organization_id,id),
 CHECK(state='open' OR (resolution IS NOT NULL AND evidence IS NOT NULL AND resolved_at IS NOT NULL)),
 FOREIGN KEY(organization_id,message_id) REFERENCES app.messages(organization_id,id)
);
CREATE INDEX reconciliation_items_open ON app.reconciliation_items(organization_id,state,created_at);

-- DOTS-101/103: delivery evidence.
CREATE TABLE app.delivery_events (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(), organization_id app.entity_id NOT NULL, message_id app.entity_id,
 mailbox_id app.entity_id, campaign_id app.entity_id, provider_event_id text NOT NULL CHECK(length(provider_event_id) BETWEEN 1 AND 240),
 provider_message_id text CHECK(provider_message_id IS NULL OR length(provider_message_id)<=200),
 kind text NOT NULL CHECK(kind IN ('accepted','deferred','delivered','bounced','complained','failed')),
 bounce_type text CHECK(bounce_type IS NULL OR bounce_type IN ('hard','soft')),
 source text NOT NULL CHECK(source IN ('provider','simulation')),
 occurred_at timestamptz NOT NULL, received_at timestamptz NOT NULL DEFAULT app.utc_now(),
 UNIQUE(organization_id,id), UNIQUE(organization_id,provider_event_id),
 FOREIGN KEY(organization_id,message_id) REFERENCES app.messages(organization_id,id),
 FOREIGN KEY(organization_id,mailbox_id) REFERENCES app.mailboxes(organization_id,id),
 FOREIGN KEY(organization_id,campaign_id) REFERENCES app.campaigns(organization_id,id)
);

-- DOTS-102: opt-out evidence.
CREATE TABLE app.opt_out_records (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(), organization_id app.entity_id NOT NULL, contact_id app.entity_id NOT NULL,
 email_hash text NOT NULL CHECK(email_hash ~ '^[0-9a-f]{64}$'),
 channel text NOT NULL CHECK(channel IN ('one_click','link','reply_keyword','owner','complaint','bounce')),
 evidence_hash text NOT NULL CHECK(evidence_hash ~ '^[0-9a-f]{64}$'),
 cancelled_steps int NOT NULL DEFAULT 0, cancelled_messages int NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT app.utc_now(), UNIQUE(organization_id,id),
 FOREIGN KEY(organization_id,contact_id) REFERENCES app.crm_contacts(organization_id,id)
);

-- DOTS-104: deterministic reply triage.
CREATE TABLE app.reply_triage (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(), organization_id app.entity_id NOT NULL, message_id app.entity_id NOT NULL,
 label text NOT NULL CHECK(label IN ('interested','not_interested','question','opt_out','ambiguous')),
 confidence_basis_points int NOT NULL CHECK(confidence_basis_points BETWEEN 0 AND 10000),
 method text NOT NULL CHECK(method IN ('deterministic_rules','model_suggestion')),
 rules jsonb NOT NULL DEFAULT '[]', citations jsonb NOT NULL DEFAULT '[]', escalated boolean NOT NULL,
 created_at timestamptz NOT NULL DEFAULT app.utc_now(), UNIQUE(organization_id,id),
 FOREIGN KEY(organization_id,message_id) REFERENCES app.messages(organization_id,id)
);

-- DOTS-107: attachment scanning. Only clean content is retained.
CREATE TABLE app.message_attachments (
 id app.entity_id PRIMARY KEY DEFAULT app.new_id(), organization_id app.entity_id NOT NULL, message_id app.entity_id, conversation_id app.entity_id,
 direction text NOT NULL CHECK(direction IN ('inbound','outbound')),
 filename text NOT NULL CHECK(length(filename) BETWEEN 1 AND 200), declared_type text NOT NULL CHECK(length(declared_type) BETWEEN 1 AND 120),
 sniffed_type text, size_bytes bigint NOT NULL CHECK(size_bytes>=0), sha256 text CHECK(sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
 provider_ref text CHECK(provider_ref IS NULL OR length(provider_ref)<=200),
 scan_state text NOT NULL DEFAULT 'staged' CHECK(scan_state IN ('staged','clean','quarantined','rejected')),
 scan_reason text CHECK(scan_reason IS NULL OR length(scan_reason)<=80), content bytea CHECK(content IS NULL OR octet_length(content)<=5242880),
 created_at timestamptz NOT NULL DEFAULT app.utc_now(), scanned_at timestamptz, UNIQUE(organization_id,id),
 CHECK(content IS NULL OR scan_state='clean'),
 FOREIGN KEY(organization_id,message_id) REFERENCES app.messages(organization_id,id),
 FOREIGN KEY(organization_id,conversation_id) REFERENCES app.conversations(organization_id,id)
);

DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['sender_profiles','mailbox_auth_checks','mailbox_credential_rotations','mailbox_sync_cursors','follow_up_sequences','sequence_enrollments','sequence_steps','message_revisions','dispatch_attempts','reconciliation_items','delivery_events','opt_out_records','reply_triage','message_attachments'] LOOP
  EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY',name);EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY',name);
  EXECUTE format('CREATE POLICY %I ON app.%I USING(organization_id=app.current_organization_id()) WITH CHECK(organization_id=app.current_organization_id())',name||'_tenant',name);
 END LOOP;
 FOREACH name IN ARRAY ARRAY['mailbox_auth_checks','mailbox_credential_rotations','message_revisions','delivery_events','opt_out_records','reply_triage'] LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON app.%I FOR EACH ROW EXECUTE FUNCTION app.deny_operation_evidence_mutation()',name||'_immutable',name);
 END LOOP;
END $$;
