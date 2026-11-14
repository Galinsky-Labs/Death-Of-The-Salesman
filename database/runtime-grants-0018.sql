-- Least-privilege runtime grants for migration 0018 (Campaign Studio, DOTS-082..093).
-- Apply with the migration administrator after database/runtime-grants.sql.
-- No DELETE on any campaign evidence table and no UPDATE on id/organization_id columns.
GRANT SELECT, INSERT ON app.message_templates,app.message_template_revisions,app.campaign_audience_revisions,app.campaign_budget_revisions,app.campaign_variants,app.offer_price_rules,app.campaign_price_exceptions,app.campaign_simulations,app.campaign_work_items TO dots_runtime;
GRANT SELECT ON app.project_buckets TO dots_runtime;
GRANT UPDATE(label,status,latest_revision,version,updated_at) ON app.message_templates TO dots_runtime;
GRANT UPDATE(status,retired_at) ON app.campaign_variants TO dots_runtime;
GRANT UPDATE(authorized_prices_cents,max_discount_bp,restricted_phrases,version,updated_by_membership_id,updated_at) ON app.offer_price_rules TO dots_runtime;
GRANT UPDATE(offer_id,mailbox_id,channel,allowed_countries,timezone,send_window_start_hour,send_window_end_hour,weekdays_only,frequency_cap,schedule_start_at,schedule_end_at,template_revision_id,audience_revision_id,budget_revision_id,priority,agent_identity_id,approval_id,authority_ref) ON app.campaigns TO dots_runtime;
