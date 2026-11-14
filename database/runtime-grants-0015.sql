-- DOTS-039..054 agent runtime (migration 0015). Apply with the migration administrator after
-- database/runtime-grants.sql. Evidence tables are insert-only; the only DELETE is on transient lead locks.
GRANT SELECT ON app.agent_capabilities,app.work_items,app.work_item_transitions,app.lead_locks,app.runtime_dead_letters,app.run_controls,app.context_snapshots,app.tool_proposals,app.run_memories,app.runtime_dispatch_log TO dots_runtime;
GRANT INSERT ON app.agent_capabilities,app.work_items,app.work_item_transitions,app.lead_locks,app.runtime_dead_letters,app.run_controls,app.context_snapshots,app.tool_proposals,app.run_memories,app.runtime_dispatch_log TO dots_runtime;
GRANT UPDATE(role,allowed_task_kinds,allowed_tools,allowed_channels,skills,model_policy,campaign_scope,paused,max_steps,wall_clock_seconds,daily_run_quota,window_start_minute,window_end_minute,version,updated_by_membership_id,updated_at) ON app.agent_capabilities TO dots_runtime;
GRANT UPDATE(state,reason,version,outcome,updated_at) ON app.work_items TO dots_runtime;
GRANT UPDATE(status,steps_used,cancel_requested,last_checkpoint_sequence,summary,reason_code,ended_at) ON app.run_controls TO dots_runtime;
GRANT UPDATE(status,attempts,reservation_id,approval_id,provider_ref,reconciliation_evidence,updated_at) ON app.runtime_dispatch_log TO dots_runtime;
GRANT DELETE ON app.lead_locks TO dots_runtime;
