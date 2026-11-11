-- Destructive migration-owner rollback; retain required request/hold audit evidence.
DROP TABLE app.privacy_export_jobs;
DROP TABLE app.privacy_requests;
DROP TABLE app.privacy_holds;
DROP TABLE app.privacy_cache;
DROP FUNCTION app.guard_privacy_retention();
