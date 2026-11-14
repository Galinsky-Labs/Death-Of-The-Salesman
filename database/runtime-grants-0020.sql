-- DOTS-110..120 Strategy Lab least-privilege runtime grants. Apply with the migration administrator
-- after database/runtime-grants.sql and migration 0020. Evidence tables receive SELECT/INSERT only.
GRANT SELECT ON app.strategy_families,app.strategy_revisions,app.strategy_lineage,app.strategy_allocation_rules,app.strategy_allocation_history,app.strategy_experiments,app.strategy_experiment_arms,app.strategy_enrollments,app.strategy_outcome_events,app.strategy_metric_snapshots,app.strategy_promotions,app.strategy_variant_backlog,app.strategy_arm_metrics TO dots_runtime;
GRANT INSERT ON app.strategy_families,app.strategy_revisions,app.strategy_lineage,app.strategy_allocation_rules,app.strategy_allocation_history,app.strategy_experiments,app.strategy_experiment_arms,app.strategy_enrollments,app.strategy_outcome_events,app.strategy_metric_snapshots,app.strategy_promotions,app.strategy_variant_backlog TO dots_runtime;
GRANT UPDATE(status) ON app.strategy_families TO dots_runtime;
GRANT UPDATE(status,decided_by_membership_id,decided_at) ON app.strategy_revisions TO dots_runtime;
GRANT UPDATE(champion_revision_id,experimental_basis_points,min_exploration_basis_points,below_floor_acknowledgement,auto_promote_enabled,version,updated_by_membership_id,updated_at) ON app.strategy_allocation_rules TO dots_runtime;
GRANT UPDATE(state,stop_reason,updated_at) ON app.strategy_experiments TO dots_runtime;
GRANT UPDATE(status,proposed_revision_id,version,updated_at) ON app.strategy_variant_backlog TO dots_runtime;
