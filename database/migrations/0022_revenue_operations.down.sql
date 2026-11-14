-- Rollback refuses to discard verified revenue ledger evidence. Export the ledger
-- and obtain owner sign-off before removing processor fee/dispute/subscription rows manually.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM app.money_entries WHERE kind IN ('processor_fee','dispute_hold','dispute_reversal','subscription_receipt') OR subscription_id IS NOT NULL) THEN
  RAISE EXCEPTION 'rollback would discard revenue ledger evidence; export and archive it first';
 END IF;
END $$;
DROP TRIGGER lead_evidence_guard ON app.lead_submissions;
DROP FUNCTION app.preserve_lead_evidence();
DROP TRIGGER quote_pricing_guard ON app.quotes;
DROP FUNCTION app.preserve_quote_pricing();
DROP TABLE app.portal_links;
DROP TABLE app.lead_submissions;
DROP TABLE app.lead_rate_limits;
DROP TABLE app.lead_form_nonces;
DROP TABLE app.lead_forms;
DROP TABLE app.crm_sync_conflicts;
DROP TABLE app.crm_sync_runs;
DROP TABLE app.crm_field_ownership;
DROP TABLE app.crm_external_links;
DROP TABLE app.meetings;
DROP TABLE app.calendar_delegations;
DROP TABLE app.calendar_connections;
DROP TABLE app.service_escalations;
DROP TABLE app.onboarding_tasks;
DROP TABLE app.retention_events;
ALTER TABLE app.money_entries DROP CONSTRAINT money_entries_subscription_fk;
ALTER TABLE app.money_entries DROP COLUMN subscription_id;
DROP TABLE app.revenue_subscriptions;
DROP TABLE app.quotes;
DROP TABLE app.price_book_revisions;
DROP TABLE app.price_books;
ALTER TABLE app.money_entries DROP CONSTRAINT money_entries_kind_check;
ALTER TABLE app.money_entries ADD CONSTRAINT money_entries_kind_check CHECK(kind IN ('expense','refund','sale_receipt','grant_disbursement','investment_receipt','sponsorship_receipt'));
