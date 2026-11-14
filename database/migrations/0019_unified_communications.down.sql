DROP TABLE app.message_attachments;
DROP TABLE app.reply_triage;
DROP TABLE app.opt_out_records;
DROP TABLE app.delivery_events;
DROP TABLE app.reconciliation_items;
DROP TABLE app.dispatch_attempts;
DROP TABLE app.message_revisions;
DROP INDEX app.messages_header_unique;
ALTER TABLE app.sequence_steps DROP CONSTRAINT sequence_steps_message_fk;
ALTER TABLE app.messages DROP CONSTRAINT messages_sequence_step_fk;
ALTER TABLE app.messages DROP CONSTRAINT messages_mailbox_fk;
ALTER TABLE app.messages
 DROP COLUMN mailbox_id, DROP COLUMN message_id_header, DROP COLUMN in_reply_to_header, DROP COLUMN references_headers,
 DROP COLUMN from_address, DROP COLUMN to_addresses, DROP COLUMN cc_addresses, DROP COLUMN reply_mode, DROP COLUMN ai_generated,
 DROP COLUMN authentication, DROP COLUMN delivery_status, DROP COLUMN delivery_updated_at, DROP COLUMN received_at,
 DROP COLUMN current_revision, DROP COLUMN approved_revision, DROP COLUMN approved_revision_hash, DROP COLUMN draft_expires_at,
 DROP COLUMN attachment_ids, DROP COLUMN sequence_step_id;
UPDATE app.messages SET state='failed' WHERE state='cancelled';
ALTER TABLE app.messages DROP CONSTRAINT messages_state_check;
ALTER TABLE app.messages ADD CONSTRAINT messages_state_check CHECK(state IN ('draft','pending_approval','approved','sending','sent','delivered','received','failed','quarantined','redacted'));
DROP TABLE app.sequence_steps;
DROP TABLE app.sequence_enrollments;
DROP TABLE app.follow_up_sequences;
DROP INDEX app.conversations_owner_queue;
ALTER TABLE app.conversations DROP CONSTRAINT conversations_mailbox_fk;
ALTER TABLE app.conversations DROP CONSTRAINT conversations_campaign_fk;
ALTER TABLE app.conversations
 DROP COLUMN campaign_id, DROP COLUMN mailbox_id, DROP COLUMN normalized_subject, DROP COLUMN claimed_by_membership_id,
 DROP COLUMN claimed_at, DROP COLUMN agent_delegated, DROP COLUMN needs_owner, DROP COLUMN priority, DROP COLUMN sla_due_at,
 DROP COLUMN last_inbound_at;
DROP TABLE app.mailbox_sync_cursors;
DROP TABLE app.mailbox_credential_rotations;
DROP TABLE app.mailbox_auth_checks;
DROP TABLE app.sender_profiles;
DROP INDEX app.mailboxes_consented_sender_unique;
ALTER TABLE app.mailboxes
 DROP COLUMN connection_kind, DROP COLUMN oauth_scopes, DROP COLUMN token_ref, DROP COLUMN token_rotated_at, DROP COLUMN token_expires_at,
 DROP COLUMN owner_consent_at, DROP COLUMN owner_consent_by, DROP COLUMN owner_consent_ref, DROP COLUMN spf_status, DROP COLUMN dkim_status,
 DROP COLUMN dmarc_status, DROP COLUMN auth_checked_at, DROP COLUMN pause_reason, DROP COLUMN version;
UPDATE app.mailboxes SET provider='generic',status='disabled' WHERE provider IN ('gmail','microsoft365');
ALTER TABLE app.mailboxes DROP CONSTRAINT mailboxes_provider_check;
ALTER TABLE app.mailboxes ADD CONSTRAINT mailboxes_provider_check CHECK(provider IN ('resend','generic'));
