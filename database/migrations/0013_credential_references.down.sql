-- Destructive, migration-owner only. Retain/export required evidence before production rollback.
ALTER TABLE app.integration_credentials DROP CONSTRAINT current_credential_version;
DROP TABLE app.credential_versions;
DROP TABLE app.integration_credentials;
DROP FUNCTION app.guard_credential_metadata();
DROP FUNCTION app.guard_credential_version();
DROP FUNCTION app.audit_credential_version();
