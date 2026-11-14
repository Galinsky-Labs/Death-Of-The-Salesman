# Funding Agents (F10: DOTS-121 to DOTS-134)

This feature is the funding command center. It covers grant programs, investor relations and sponsorships/partnerships. These three stay apart from each other and from product revenue: they use separate boards, tables, money-entry kinds (`grant_disbursement`, `investment_receipt`, `sponsorship_receipt`) and dashboard counters.

The system **never** does any of these: submit a grant application, sign or certify a document, accept an award, execute a contract, send investor communication, or treat interest, requested amounts, term sheets or unpaid awards as cash. The owner does those things outside the system. The system records them with evidence, behind deterministic server-side gates.

## Components

| Layer | Location |
| --- | --- |
| Migration | `database/migrations/0021_funding_agents.up.sql` / `.down.sql` |
| Runtime privileges | `database/runtime-grants-0021.sql` (apply after `database/runtime-grants.sql`) |
| Domain module | `packages/operations/src/funding.ts` (`FundingWorkspace` plus pure gates: `evaluateEligibility`, `findUnsupportedClaims`, `regulatedOfferFindings`, `fundingStatusClass`, `deadlineIcs`) |
| HTTP | `apps/web/app/api/v1/funding/route.ts` (GET snapshot or `?format=ics`; POST `action`) |
| UI | `apps/web/app/views/funding-view.tsx` (`FundingView`, navigation label **Funding**) |
| Tests | `tests/funding.test.mjs` (PGlite, no network) |

## Unit coverage

| Unit | What is implemented | Acceptance evidence (tests) |
| --- | --- | --- |
| DOTS-121 Source directory | `funding_sources` holds kind, funder, https source URL, geography, entity eligibility, award range, deadline and timezone, connector, `verified_at` and refresh policy. Every import or re-verification appends an immutable `funding_source_revisions` snapshot. | Filtering by geography (including `GLOBAL`), entity type, deadline and type. Revisions are retained and append-only. Non-https, future-dated and evidence-less imports are rejected. |
| DOTS-122 Discovery connectors | Grants.gov `search2` (existing `discoverGrants`, fixed official URL) and manual import with evidence. `funding_connector_runs` is the connector status table. Candid is listed as blocked on an external prerequisite. | With an injected transport, an HTTP 503, a network error or a malformed response each produce `waiting` with a reason code and **zero** imported programs. Re-sync is idempotent. Invalid ids are dropped. |
| DOTS-123 Eligibility rules | Rules (`entity_type`, `jurisdiction`, `stage`, `restriction`, `required_document`) cite an https rule source. Results are appended to `funding_eligibility_results`, with an explanation line and citation per rule. | No rules, no profile, no source, a missing deadline, an unconfirmed restriction or a stale source each yield `unknown`, never `eligible`. Staleness is min(30 days, 2 × refresh days). |
| DOTS-124 Visual pipeline | `pipeline()` builds separate grant, investor and sponsorship boards. Lanes are **Lead → Pending award → Commitment → Received**. Cards show range, urgency, eligibility with citation, owner and source link. | Truth class is derived only from records: interest stays `lead`, a signed commitment is `commitment`, and only ledger receipts are `received`. Lanes differ by border style and text label as well as colour. |
| DOTS-125 Applications | Applications have answers (draft, reviewed), required documents linked to `document_library` ids, append-only reviews and status. | A DB CHECK makes `submitted` impossible without evidence kind/ref, submitter, timestamp and approval. |
| DOTS-126 Source-grounded drafting | `funding_org_facts` need owner approval. Answers are assembled only from approved organization facts plus active `vetted_product_facts`, with `[n]` citations. `modelDraftPayload` / `queueDraftTask` send questions and approved facts only. | Uncited claims, unapproved facts and numbers missing from cited facts are blocked and logged as `funding.claim_blocked`. Private document contents and ids never appear in the model payload. |
| DOTS-127 Calendar and reminders | Each opportunity gets timezone-aware review milestones (−21d, −14d, −3d and the deadline). Milestones carry provenance: source URL, verified time and the deadline as published. Also: owner alert records, stale-source recheck milestones and an ICS export. | Scheduling is idempotent, alerts are idempotent and invalid timezones are rejected. ICS text includes provenance and states that submission is manual. Reminders report `submitted: 0`. |
| DOTS-128 Human-reviewed submission | Owner eligibility certification (DB `actor_kind='human'`) requires a current `eligible` result. Attachments are validated. The exact payload is frozen into a `grant_submission` action approval, which is consumed against the recomputed hash at the moment the owner records a provider receipt or owner-verified evidence. | Agents cannot certify or submit. Tampering after approval returns `APPROVAL_INVALID`. Double submission is rejected. |
| DOTS-129 Awards and disbursements | Award flow: offered → accepted, which requires an owner authority reference. Restrictions cannot exceed the restricted amount. Disbursements are `money_entries` (`provider` or `owner_attested` only, never `simulation`) linked through `funding_receipts`. `reconciliation()` compares receipts with the ledger. | Offered and accepted awards are not cash. Restricted and unrestricted caps, over-award, idempotency and conflicts are tested. The ledger is append-only. |
| DOTS-130 Investor relations | Investor organizations carry relationship, a 506(c)-style `verified_506c` flag (evidence required), allowed communication classes and meetings. `reviewInvestorCommunication` classifies a message and never sends it. | Disallowed class → `blocked`. Regulated terms (invest, returns, guaranteed, SAFE, offering…) sent to someone without a pre-existing relationship or verified accreditation → `blocked` (general-solicitation risk). Otherwise → `owner_legal_review_required`, and approval needs a legal review reference plus an `investment_disclosure` approval. |
| DOTS-131 Pitch assets | `pitch_assets` with append-only `pitch_asset_versions` that must cite approved facts (fact snapshot hash stored). Diligence checklist items complete only with a document. | Fictitious revenue or traction (an uncited claim or an unsupported number) fails. Versions are immutable. |
| DOTS-132 Commitments | `investment_commitment_events`: meeting → interest → term sheet → signed commitment → cash received. Each stage has a proof requirement (CHECK constraints) and a legal status. | Order is enforced and agents cannot sign. Cash requires a signed commitment and cannot exceed it. The dashboard's `raisedCents` counts cash only. |
| DOTS-133 Sponsorships and partnerships | Workflow: research → proposal (requires a fact-linked `sponsorship_proposal` version) → owner-approved → contract review (contract document plus review reference) → signed (owner authority reference) → exchanged (funds as a `sponsorship_receipt` money entry, or in-kind with evidence). | Agents cannot approve or sign. A stale version is rejected. Exchanges require a signed agreement. |
| DOTS-134 Dashboard | Grant counts (eligible, applied, pending, won) and received cents (restricted vs unrestricted). Investor counts (qualified meetings, interest count, term sheets) and signed-vs-raised cents. Sponsorship cash and in-kind. Net funding reconciled to the ledger. | Requested amounts, ranges, interest, term sheets, unpaid commitments and awards, and in-kind value are all excluded from received and net funding. |

## Operator steps

1. Run the migrations (`pnpm db:migrate`). Then, as the migration administrator, apply `database/runtime-grants.sql` followed by `database/runtime-grants-0021.sql`.
2. Open **Funding → Directory**:
   - Import each funding source with its official https URL, what you reviewed and when.
   - Transcribe eligibility rules, each with its citation URL.
   - Set the applicant profile.
   - Optionally search Grants.gov, which is free and public.
3. Add opportunities linked to sources (grant), investors (investment) or sponsors/partners.
4. For a grant:
   - Evaluate eligibility.
   - Propose and approve organization facts.
   - Open the application.
   - Assemble or write answers with citations, then mark each one reviewed.
   - Attach the required documents.
   - Request a review and approve it.
5. Submission:
   - Certify eligibility as the owner.
   - Choose **Freeze payload and request approval**.
   - Approve the exact payload.
   - Submit through the funder's own portal **yourself**.
   - Record the receipt number or an owner-verified confirmation.
6. Use the **Calendar** tab and `GET /api/v1/funding?format=ics` for deadlines. Select **Refresh reminders** to create alerts and stale-source rechecks.
7. Record an award only when you have the award letter. Accept it with a signed acceptance reference, and record disbursements only from bank or funder receipts.

## HTTP contract

- `GET /api/v1/funding` returns `{observedAt, sources, rules, connectors, profiles, pipeline:{grants,investors,sponsorships}, applications, answers, documents, libraryDocuments, facts, milestones, alerts, awards, restrictions, investors, meetings, communications, pitchAssets, diligence, commitments, sponsorships, exchanges, projects, dashboard}`.
  - Optional filters: `geography`, `entityType`, `kind`, `deadlineAfter`, `deadlineBefore`.
  - `?format=ics` returns a `text/calendar` file.
- `POST /api/v1/funding` takes `{action, ...}` and returns `{data: snapshot, outcome}`. The actions are:
  - Directory, eligibility and pipeline: `importSource`, `addEligibilityRule`, `discover`, `setApplicantProfile`, `evaluateEligibility`, `createOpportunity`.
  - Applications and drafting: `openApplication`, `saveAnswer`, `assembleAnswer`, `markAnswerReviewed`, `attachDocument`, `requestReview`, `reviewApplication`, `addOrganizationFact`, `approveOrganizationFact`, `queueDraftTask`.
  - Calendar: `scheduleTimeline`, `refreshReminders`, `completeMilestone`, `acknowledgeAlert`.
  - Submission: `certifyEligibility`, `prepareSubmission`, `decideSubmissionApproval`, `recordSubmission`.
  - Awards: `recordAward`, `decideAward`, `addRestriction`, `recordDisbursement`, `reconciliation`.
  - Investors: `addInvestor`, `verifyAccreditation`, `recordMeeting`, `reviewInvestorCommunication`, `decideInvestorCommunication`.
  - Pitch assets and diligence: `createPitchAsset`, `savePitchVersion`, `addDiligenceItem`, `completeDiligenceItem`.
  - Commitments: `recordCommitmentStage`, `recordInvestmentReceipt`.
  - Sponsorships: `startSponsorship`, `advanceSponsorship`, `recordSponsorshipExchange`.
- Receipts entered over HTTP are always stored as `owner_attested`. `provider` receipts are reserved for verified integrations.

## Environment variables

There are no new environment variables. The feature uses the existing `DATABASE_URL`, `OWNER_ORGANIZATION_ID` and `OWNER_MEMBERSHIP_ID`. Draft tasks run on the existing worker in `simulation` mode unless the owner has funded and enabled a model provider.

## Spend, security and compliance

- Paid spend: **$0**. Grants.gov search is free and public. No model, email or payment calls are added.
- All tables are tenant-scoped with FORCE ROW LEVEL SECURITY. These tables are append-only:
  - revisions, connector runs and eligibility results;
  - reviews and certifications;
  - restrictions and receipts;
  - meetings, pitch versions and commitment events;
  - sponsorship exchanges.
- Runtime grants give no DELETE and never UPDATE `id` or `organization_id`.

## External prerequisites

- **Candid foundation directory connector:** blocked on external prerequisite. It needs an owner-purchased Candid API subscription. The connector stays `blocked_external_prerequisite` and imports nothing. Enabling it needs a separate adapter change and a `CANDID_API_KEY` secret (name only), and requires owner spend authorization.
- **Funder portal submission (Grants.gov Workspace, foundation portals):** this is intentionally manual. The owner needs their own portal credentials and organizational registrations (for example SAM.gov UEI and Grants.gov roles). The system records only the receipt reference.
- **Securities and legal review:** offering material needs qualified counsel. The legal review reference is supplied by the owner. This system does not verify accredited-investor status itself; it records the owner's third-party verification evidence.

## Rollback

`0021_funding_agents.down.sql` drops the funding tables and restores the original `money_entries.kind` CHECK. Money entries are append-only, so rollback fails while any `sponsorship_receipt` entries exist. Investigate before forcing anything.
