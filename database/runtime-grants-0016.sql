-- DOTS-055..069 model execution tables. Apply with the migration administrator after
-- database/runtime-grants.sql. Revisions, pricing versions, usage records, invoices,
-- executions and generated-output classifications are never deleted; identity and
-- evidence columns are never updated by the runtime role.
GRANT SELECT ON app.model_revisions,app.model_pricing_versions,app.model_routing_weights,app.model_breakers,app.model_executions,app.model_usage_records,app.model_provider_invoices,app.generated_outputs TO dots_runtime;
GRANT INSERT ON app.model_revisions,app.model_pricing_versions,app.model_routing_weights,app.model_breakers,app.model_executions,app.model_usage_records,app.model_provider_invoices,app.generated_outputs TO dots_runtime;
GRANT UPDATE(weight,version,updated_by_membership_id,updated_at) ON app.model_routing_weights TO dots_runtime;
GRANT UPDATE(state,consecutive_failures,opened_count,retry_at,last_reason,version,updated_at) ON app.model_breakers TO dots_runtime;
GRANT UPDATE(state,provider_id,model_id,attempts,reason_code,result,updated_at) ON app.model_executions TO dots_runtime;
GRANT UPDATE(disposition,release_use,release_authorization_ref,security_check_ref,sandbox_ref,released_by_membership_id,decided_at) ON app.generated_outputs TO dots_runtime;
