DROP TRIGGER campaign_variants_lineage ON app.campaign_variants;
DROP FUNCTION app.preserve_campaign_variant();
ALTER TABLE app.campaigns
 DROP CONSTRAINT campaigns_offer_fk,
 DROP CONSTRAINT campaigns_mailbox_fk,
 DROP CONSTRAINT campaigns_template_revision_fk,
 DROP CONSTRAINT campaigns_audience_revision_fk,
 DROP CONSTRAINT campaigns_budget_revision_fk,
 DROP CONSTRAINT campaigns_agent_fk,
 DROP CONSTRAINT campaigns_approval_fk;
DROP TABLE app.campaign_work_items;
DROP TABLE app.campaign_simulations;
DROP TABLE app.campaign_price_exceptions;
DROP TABLE app.offer_price_rules;
DROP TABLE app.campaign_variants;
ALTER TABLE app.campaigns
 DROP COLUMN offer_id, DROP COLUMN mailbox_id, DROP COLUMN channel, DROP COLUMN allowed_countries, DROP COLUMN timezone,
 DROP COLUMN send_window_start_hour, DROP COLUMN send_window_end_hour, DROP COLUMN weekdays_only, DROP COLUMN frequency_cap,
 DROP COLUMN schedule_start_at, DROP COLUMN schedule_end_at, DROP COLUMN template_revision_id, DROP COLUMN audience_revision_id,
 DROP COLUMN budget_revision_id, DROP COLUMN priority, DROP COLUMN agent_identity_id, DROP COLUMN approval_id, DROP COLUMN authority_ref;
DROP TABLE app.campaign_budget_revisions;
DROP TABLE app.campaign_audience_revisions;
DROP TABLE app.message_template_revisions;
DROP TABLE app.message_templates;
-- Map lifecycle states back onto the 0012 vocabulary before restoring its constraint.
ALTER TABLE app.campaigns DROP CONSTRAINT campaigns_state_check;
ALTER TABLE app.campaigns NO FORCE ROW LEVEL SECURITY;
UPDATE app.campaigns SET state = CASE state
 WHEN 'validated' THEN 'simulated'
 WHEN 'ready_for_approval' THEN 'awaiting_approval'
 WHEN 'approved' THEN 'awaiting_approval'
 WHEN 'scheduled' THEN 'paused'
 WHEN 'aborted' THEN 'archived'
 ELSE state END
 WHERE state IN ('validated','ready_for_approval','approved','scheduled','aborted');
ALTER TABLE app.campaigns FORCE ROW LEVEL SECURITY;
ALTER TABLE app.campaigns ADD CONSTRAINT campaigns_state_check
 CHECK (state IN ('draft','simulated','awaiting_approval','active','paused','completed','archived'));
