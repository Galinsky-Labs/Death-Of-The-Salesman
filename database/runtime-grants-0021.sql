-- Runtime privileges for migration 0021 (DOTS-121..134 Funding Agents).
-- Apply with the migration administrator after database/runtime-grants.sql. Evidence and money tables
-- receive SELECT/INSERT only (no UPDATE, no DELETE); identity and tenant columns are never updatable.
GRANT SELECT,INSERT ON app.funding_sources,app.funding_source_revisions,app.funding_connector_runs,app.funding_eligibility_rules,app.funding_applicant_profiles,app.funding_org_facts,app.investor_organizations,app.funding_eligibility_results,app.funding_applications,app.funding_application_answers,app.funding_application_documents,app.funding_application_reviews,app.funding_certifications,app.funding_milestones,app.funding_owner_alerts,app.funding_awards,app.funding_restrictions,app.funding_receipts,app.investor_meetings,app.investor_communication_reviews,app.pitch_assets,app.pitch_asset_versions,app.funding_diligence_items,app.investment_commitment_events,app.sponsorship_workflows,app.sponsorship_exchanges TO dots_runtime;
GRANT UPDATE(kind,name,funder,source_url,geography,entity_eligibility,program_type,min_award_cents,max_award_cents,deadline,deadline_timezone,provenance,verified_at,refresh_days,status,version,updated_at) ON app.funding_sources TO dots_runtime;
GRANT UPDATE(status) ON app.funding_eligibility_rules TO dots_runtime;
GRANT UPDATE(entity_type,jurisdiction,stage,documents,restrictions_confirmed,version,updated_at) ON app.funding_applicant_profiles TO dots_runtime;
GRANT UPDATE(status,approved_by_membership_id,approved_at) ON app.funding_org_facts TO dots_runtime;
GRANT UPDATE(relationship,accreditation,accreditation_evidence_ref,accreditation_verified_at,allowed_communication_classes,version) ON app.investor_organizations TO dots_runtime;
GRANT UPDATE(status,approval_id,submission_payload_hash,submission_evidence_kind,submission_evidence_ref,submitted_by_membership_id,submitted_at,version,updated_at) ON app.funding_applications TO dots_runtime;
GRANT UPDATE(answer,citations,status,source,version,updated_at) ON app.funding_application_answers TO dots_runtime;
GRANT UPDATE(document_id,privacy_class) ON app.funding_application_documents TO dots_runtime;
GRANT UPDATE(completed_at) ON app.funding_milestones TO dots_runtime;
GRANT UPDATE(state,acknowledged_at) ON app.funding_owner_alerts TO dots_runtime;
GRANT UPDATE(status,acceptance_authority_ref,accepted_by_membership_id,accepted_at,version) ON app.funding_awards TO dots_runtime;
GRANT UPDATE(status,legal_review_ref,approval_id,decided_by_membership_id,decided_at) ON app.investor_communication_reviews TO dots_runtime;
GRANT UPDATE(current_version) ON app.pitch_assets TO dots_runtime;
GRANT UPDATE(completed,document_id) ON app.funding_diligence_items TO dots_runtime;
GRANT UPDATE(stage,proposal_asset_id,approval_membership_id,contract_document_id,contract_review_ref,signed_authority_ref,signed_by_membership_id,signed_at,version,updated_at) ON app.sponsorship_workflows TO dots_runtime;
