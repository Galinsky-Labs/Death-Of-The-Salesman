-- DOTS-070..081 least-privilege runtime grants for migration 0017. Apply after database/runtime-grants.sql.
-- No DELETE on evidence, provenance, consent, suppression-history, transition, touchpoint or attribution tables.
-- contact_suppressions rows can only be lifted through app.crm_lift_suppression, which requires a same-transaction
-- lawful audit row; the runtime role still has no DELETE on contact_suppressions. Privacy-erasure cleanup of CRM copies
-- runs in the SECURITY DEFINER trigger app.crm_redact_contact_records, so no DELETE/UPDATE grant is needed for it.
GRANT SELECT ON app.crm_aliases,app.crm_contact_methods,app.crm_import_batches,app.crm_import_rows,app.crm_contact_sources,app.crm_merge_candidates,app.crm_merges,app.crm_consent_evidence,app.crm_region_policies,app.crm_contact_policies,app.crm_suppression_history,app.crm_prospect_claims,app.crm_segments,app.crm_segment_members,app.crm_relationship_events,app.crm_pipelines,app.crm_pipeline_stages,app.crm_pipeline_transitions,app.crm_deal_contacts,app.crm_deal_invoices,app.crm_deal_transitions,app.crm_touchpoints,app.crm_attributions TO dots_runtime;
GRANT INSERT ON app.crm_aliases,app.crm_contact_methods,app.crm_import_batches,app.crm_import_rows,app.crm_contact_sources,app.crm_merge_candidates,app.crm_merges,app.crm_consent_evidence,app.crm_region_policies,app.crm_contact_policies,app.crm_suppression_history,app.crm_prospect_claims,app.crm_segments,app.crm_segment_members,app.crm_relationship_events,app.crm_pipelines,app.crm_pipeline_stages,app.crm_pipeline_transitions,app.crm_deal_contacts,app.crm_deal_invoices,app.crm_deal_transitions,app.crm_touchpoints,app.crm_attributions TO dots_runtime;
GRANT UPDATE(domain,owner_membership_id,metadata,version,updated_at) ON app.crm_accounts TO dots_runtime;
GRANT UPDATE(account_id,owner_membership_id,metadata,merged_into_id) ON app.crm_contacts TO dots_runtime;
GRANT UPDATE(state,total_rows,valid_rows,quarantined_rows,duplicate_rows,committed_at,version) ON app.crm_import_batches TO dots_runtime;
GRANT UPDATE(status,reasons,display_name,email,consent_evidence,created_contact_id) ON app.crm_import_rows TO dots_runtime;
GRANT UPDATE(state,decided_by_membership_id,decided_at) ON app.crm_merge_candidates TO dots_runtime;
GRANT UPDATE(allowed,requires_opt_in,legal_review_ref,version,updated_by_membership_id,updated_at) ON app.crm_region_policies TO dots_runtime;
GRANT UPDATE(max_touches,window_days,exclusion_days,version,updated_by_membership_id,updated_at) ON app.crm_contact_policies TO dots_runtime;
GRANT UPDATE(state,released_at,exclusive_until,release_reason) ON app.crm_prospect_claims TO dots_runtime;
GRANT UPDATE(label,filter,filter_hash,version,updated_at) ON app.crm_segments TO dots_runtime;
GRANT UPDATE(pipeline_id,campaign_id,expected_close_at,probability_label,won_at) ON app.deals TO dots_runtime;
GRANT EXECUTE ON FUNCTION app.crm_lift_suppression(text,app.entity_id) TO dots_runtime;
