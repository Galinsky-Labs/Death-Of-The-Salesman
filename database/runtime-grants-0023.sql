-- DOTS-155/159 platform operations. Incident events are append-only; tokens store only hashes.
GRANT SELECT,INSERT ON app.incidents,app.incident_events,app.portfolio_access_tokens TO dots_runtime;
GRANT UPDATE(state,resolved_at,version) ON app.incidents TO dots_runtime;
GRANT UPDATE(revoked_at,last_used_at) ON app.portfolio_access_tokens TO dots_runtime;
