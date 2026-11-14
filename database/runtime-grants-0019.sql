-- DOTS-094..DOTS-108 least-privilege runtime grants for migration 0019 (apply after database/runtime-grants.sql).
-- Evidence tables (auth checks, credential rotations, revisions, delivery events, opt-out records, triage) are
-- SELECT/INSERT only and additionally protected by append-only triggers. No DELETE is granted on any new table,
-- and no UPDATE is granted on id or organization_id columns.
GRANT SELECT,INSERT ON app.sender_profiles,app.mailbox_auth_checks,app.mailbox_credential_rotations,app.mailbox_sync_cursors,app.follow_up_sequences,app.sequence_enrollments,app.sequence_steps,app.message_revisions,app.dispatch_attempts,app.reconciliation_items,app.delivery_events,app.opt_out_records,app.reply_triage,app.message_attachments TO dots_runtime;
GRANT UPDATE(legal_name,postal_address,version,updated_by_membership_id,updated_at) ON app.sender_profiles TO dots_runtime;
GRANT UPDATE(cursor,last_polled_at,next_poll_after,imported_total,last_result,version) ON app.mailbox_sync_cursors TO dots_runtime;
GRANT UPDATE(state,version) ON app.follow_up_sequences TO dots_runtime;
GRANT UPDATE(state,state_reason,version,updated_at) ON app.sequence_enrollments TO dots_runtime;
GRANT UPDATE(due_at,state,message_id,state_reason,updated_at) ON app.sequence_steps TO dots_runtime;
GRANT UPDATE(state,provider_message_id,receipt_hash,reason_code,finished_at) ON app.dispatch_attempts TO dots_runtime;
GRANT UPDATE(state,resolution,evidence,resolved_by_membership_id,resolved_at) ON app.reconciliation_items TO dots_runtime;
GRANT UPDATE(sniffed_type,sha256,scan_state,scan_reason,content,size_bytes,scanned_at) ON app.message_attachments TO dots_runtime;
-- New columns on pre-existing tables.
GRANT UPDATE(business_address,token_ref,token_rotated_at,token_expires_at,owner_consent_at,owner_consent_by,owner_consent_ref,spf_status,dkim_status,dmarc_status,auth_checked_at,pause_reason,version) ON app.mailboxes TO dots_runtime;
GRANT UPDATE(campaign_id,normalized_subject,claimed_by_membership_id,claimed_at,agent_delegated,needs_owner,priority,sla_due_at,last_inbound_at) ON app.conversations TO dots_runtime;
GRANT UPDATE(mailbox_id,cc_addresses,attachment_ids,delivery_status,delivery_updated_at,current_revision,approved_revision,approved_revision_hash,draft_expires_at) ON app.messages TO dots_runtime;
