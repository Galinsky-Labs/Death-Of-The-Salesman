-- Migration owner only; retain/export pending events and receipts before production rollback.
DROP TRIGGER audit_event_outbox ON app.audit_events;
DROP TABLE app.event_receipts;
DROP TABLE app.event_outbox;
DROP FUNCTION app.enqueue_audit_event();
DROP FUNCTION app.guard_event_outbox();
DROP FUNCTION app.validate_outbox_insert();
