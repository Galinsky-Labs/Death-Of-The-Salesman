-- Least-privilege runtime grants for migration 0022 (revenue operations, DOTS-135..144).
-- Apply with the migration administrator after migrations and after database/runtime-grants.sql.
-- No DELETE on evidence or financial tables; no UPDATE on id/organization_id or pricing evidence.
GRANT SELECT,INSERT ON app.price_books,app.price_book_revisions,app.quotes,app.revenue_subscriptions,app.retention_events,app.onboarding_tasks,app.service_escalations,app.calendar_connections,app.calendar_delegations,app.meetings,app.crm_external_links,app.crm_field_ownership,app.crm_sync_runs,app.crm_sync_conflicts,app.lead_forms,app.lead_form_nonces,app.lead_rate_limits,app.lead_submissions,app.portal_links TO dots_runtime;
GRANT UPDATE(status,current_revision,approved_revision,approval_authorization_ref,approved_by_membership_id,approved_at,version,updated_at) ON app.price_books TO dots_runtime;
GRANT UPDATE(state,discount_approval_id,binding,binding_authorization_ref,sent_at,sent_channel,sent_evidence,accepted_at,acceptance_evidence,declined_at,invoice_id,version,updated_at) ON app.quotes TO dots_runtime;
GRANT UPDATE(state,current_period_end,ended_at,version,updated_at) ON app.revenue_subscriptions TO dots_runtime;
GRANT UPDATE(completed_at,completed_by_agent_id,evidence_ref) ON app.onboarding_tasks TO dots_runtime;
GRANT UPDATE(state,resolution,resolved_at,version) ON app.service_escalations TO dots_runtime;
GRANT UPDATE(status,version) ON app.calendar_connections TO dots_runtime;
GRANT UPDATE(revoked_at) ON app.calendar_delegations TO dots_runtime;
GRANT UPDATE(starts_at,ends_at,state,sequence,version,updated_at) ON app.meetings TO dots_runtime;
GRANT UPDATE(owner,version,updated_at) ON app.crm_field_ownership TO dots_runtime;
GRANT UPDATE(status,version,updated_at) ON app.lead_forms TO dots_runtime;
GRANT UPDATE(attempts) ON app.lead_rate_limits TO dots_runtime;
GRANT DELETE ON app.lead_rate_limits TO dots_runtime;
GRANT UPDATE(message,purged_at) ON app.lead_submissions TO dots_runtime;
GRANT UPDATE(revoked_at,last_viewed_at,view_count) ON app.portal_links TO dots_runtime;
-- CRM import may update externally owned deal fields (DOTS-140).
GRANT UPDATE(label,value_cents) ON app.deals TO dots_runtime;
