# CRM, lead integrity and revenue pipeline (F6: DOTS-070 to DOTS-081)

This document describes the CRM track: accounts and people, lawful import staging, identity
resolution, the universal do-not-contact gate, prospect ownership, segments, the relationship
timeline, configurable pipelines, deals, conservative attribution, the owner UI and the
50,000-contact scale and privacy regression.

Nothing in this track sends, queues or schedules outreach, calls a model or calls a paid service.
Spend impact: USD 0.

## Components

| Part | Location |
| --- | --- |
| Migration | `database/migrations/0017_crm_lead_integrity.up.sql` / `.down.sql` |
| Runtime grants | `database/runtime-grants-0017.sql` (apply after `database/runtime-grants.sql`) |
| Domain module | `packages/operations/src/crm.ts` (`CrmWorkspace`, `assertContactable`, `contactability`) |
| HTTP API | `apps/web/app/api/v1/crm/route.ts` |
| Owner UI | `apps/web/app/views/crm-view.tsx` (`CrmView`), navigation labels **Contacts** and **Pipeline** |
| Tests | `tests/crm.test.mjs` |

Edits to shared code: `SalesWorkspace.moveDeal` now refuses `won` (`WON_REQUIRES_VERIFIED_EVIDENCE`)
and refuses deals that belong to a configurable pipeline (`USE_PIPELINE_TRANSITION`). Nothing else
in `sales.ts` changed.

## Data model (migration 0017)

All new tables carry `organization_id`, compound tenant foreign keys and the forced row-level
security policy `organization_id = app.current_organization_id()`.

- `crm_accounts` gains `domain`, `normalized_name` (trigger-maintained, legal suffixes removed),
  `owner_membership_id`, `metadata`, `version`, `updated_at`.
- `crm_contacts` gains `normalized_name`, `email_domain` (trigger-maintained), `owner_membership_id`,
  `metadata`, `merged_into_id` and the status `merged`.
- `crm_aliases`, `crm_contact_methods` (email/phone/url, hashed and unique per tenant).
- `crm_import_batches`, `crm_import_rows`, `crm_contact_sources` (append-only provenance).
- `crm_merge_candidates`, `crm_merges` (append-only, snapshot without raw address).
- `crm_consent_evidence` (append-only), `crm_region_policies`, `crm_contact_policies`,
  `crm_suppression_history` (append-only) and the function `app.crm_lift_suppression`.
- `crm_prospect_claims` with a partial unique index: one active claim per contact per tenant.
- `crm_segments`, `crm_segment_members`.
- `crm_relationship_events` (append-only except privacy redaction; model statements can never be
  stored as verified).
- `crm_pipelines`, `crm_pipeline_stages`, `crm_pipeline_transitions`.
- `deals` gains `pipeline_id`, `campaign_id`, `expected_close_at`, `probability_label`, `won_at`; its
  stage check is widened to configurable stage keys.
- `crm_deal_contacts`, `crm_deal_invoices` (an invoice belongs to at most one deal),
  `crm_deal_transitions` (append-only).
- `crm_touchpoints` (append-only), `crm_attributions` (append-only, unique per deal and model).

Privacy erasure through the existing `redactContact` workflow fires the `SECURITY DEFINER` trigger
`app.crm_redact_contact_records`, which blanks contact-method values, deletes aliases, clears staged
import copies and redacts relationship-event summaries.

Rollback: `0017_crm_lead_integrity.down.sql` drops the CRM tables, returns deals on custom stages to
`new` and merged contacts to `archived`, and restores the 0012 constraints. CRM evidence rows are lost
on rollback; export first if they must be kept.

## The send/queue gate: `assertContactable`

```ts
assertContactable(tx, ctx, {contactId, campaignId, agentId?, channel: 'email' | 'phone'})
```

Call it inside the dispatch transaction immediately before dispatch (send path and queue). It takes
an advisory lock on the contact's survivor record and throws `OperationError(<code>, 403)` with the
first failing reason. `contactability(...)` returns every reason without throwing. Stable codes:

`CONTACT_NOT_FOUND`, `CONTACT_MERGED`, `CONTACT_REDACTED`, `CONTACT_INACTIVE`, `CONTACT_SUPPRESSED`,
`CONSENT_MISSING`, `REGION_UNREVIEWED`, `REGION_NOT_ALLOWED`, `REGION_REQUIRES_OPT_IN`,
`CAMPAIGN_NOT_FOUND`, `CAMPAIGN_CLOSED`, `SOURCE_PURPOSE_MISMATCH`, `CHANNEL_UNAVAILABLE`,
`FREQUENCY_LIMIT_REACHED`, `PROSPECT_IN_OTHER_CAMPAIGN`, `PROSPECT_OWNED_BY_OTHER_AGENT`,
`PROSPECT_IN_EXCLUSION_WINDOW`, `PROSPECT_NOT_CLAIMED` (only when `agentId` is given).

Rules:

- Suppression is checked across every address in the contact's merge cluster (survivor, merged
  duplicates, secondary email methods). It applies to all campaigns and agents.
- No region policy means not allowed. `unreviewed` jurisdictions are never contactable.
- Frequency counts outbound messages in `sending`/`sent`/`delivered` across the merge cluster, plus
  owner-recorded outbound touchpoints without a message, within the tenant policy window
  (default 1 per 7 days).
- Contacts with recorded sources must have a source whose purpose matches the campaign purpose, so
  product, grant and investment audiences stay distinct. Contacts created before this track have no
  source rows and are not blocked by this rule.

Integration note for the send track: `DeliveryGateway.send` and the queue are not changed by this
track. The integrator should call `assertContactable` from both.

## Owner workflows

- **Accounts and people (DOTS-070).** Creating an account whose normalized name, domain or alias matches
  an existing account returns `{created:false, similar:[...]}`; it is only created when the owner sets
  `allowSimilar`. Nothing is merged silently. Re-adding a known address appends a source record instead
  of creating a second contact.
- **Import staging (DOTS-071).** `stageImport` validates up to 1,000 rows and quarantines invalid
  addresses, missing names, consent without evidence, consent-basis rows without opt-in, blocked regions
  and every row from `purchased_list`, `scraped` or `unknown` sources (or with lawful basis `none`).
  Suppressed and duplicate rows are reported. `previewImport` shows masked rows. `commitImport` creates
  only valid rows, appends provenance to existing contacts and clears raw addresses from staging. It
  never creates conversations, messages, tasks or audiences.
- **Dedupe (DOTS-072).** Candidates are proposed on creation, import and on demand: same normalized name
  plus the same corporate email domain (score 90), the same account (80) or similarly named accounts
  (70). Free-mail domains never count. Merges are owner decisions. A cross-account merge needs explicit
  confirmation. The duplicate keeps its row, sources and conversations and links to the survivor. The
  more restrictive suppression state wins.
- **Do-not-contact (DOTS-073).** `suppress` works by contact or by raw address before a contact exists.
  `recordConsent` writes consent history and cannot reactivate a suppressed contact. `overrideSuppression`
  is the only way to lift a suppression. It needs a lawful basis (`documented_new_opt_in` with consent
  evidence, or `owner_entry_error`) and an audit reference. Unsubscribes and complaints require a new
  opt-in. Privacy erasures can never be lifted. The runtime role has no DELETE on `contact_suppressions`.
- **Ownership (DOTS-074).** `claimProspect` gives one active claim per contact. The agent must be
  assigned to the campaign's project. Conflicts are returned as `{claimed:false, conflict:{code,...}}`
  and recorded as `crm.prospect_claim_conflict` events. Releasing a claim starts a tenant-wide exclusion
  window (default 30 days) for other agents.
- **Segments (DOTS-075).** Filters accept only `accountIds`, `sectors`, `jurisdictions`, `consents`,
  `sourceKinds`, `purposes`, `domains`, `hasOwner`, `namePrefix`, and metadata keys `industry`,
  `employee_band`, `revenue_band`, `country`, `tier` and `customer_status`. Any other field fails with
  `SEGMENT_FIELD_NOT_ALLOWED`. A preview returns the matched and eligible counts, the excluded count with
  a reason for each exclusion, and a masked sample of at most 10. It reports `inference:'none'` and
  `paidCalls:0`.
- **Timeline (DOTS-076).** Shows sources, consent, segment membership, outbound and inbound messages,
  legacy contact events, relationship events, stage transitions, merges, suppressions and ownership,
  across the merge cluster. Each item has a timestamp, an actor kind and id, and a source. Model output
  can only be stored as `model_statement` and is labelled "Unverified model statement". An agent
  statement is verified only when it carries an evidence reference.
- **Pipelines (DOTS-077).** The default product pipeline is
  new → qualified → proposal/trial → negotiation → won/lost. Every stage after `new` needs an owner note.
  `won` needs one of the following, and it is terminal:
  - a linked, paid, non-test invoice with a provider `sale_receipt`
  - a provider receipt for a linked invoice
  - a stored signed agreement in the document library

  Custom pipelines are validated: the first stage must be open, a `won` stage must use the verified
  evidence rule, and `won` cannot have outgoing transitions.
- **Deals (DOTS-078).** Deals hold multiple contacts, a product campaign (grant and investment campaigns
  are refused), a probability label (`unknown`/`low`/`medium`/`high`/`closed`, not a fabricated
  percentage) and an expected close date. `dealFinancials` reports three separate figures:
  - **forecast:** open deal value
  - **invoiced:** linked invoices in issued, paid, refunded or disputed state
  - **received:** provider receipts net of provider refunds

  Sandbox money is shown separately and is never counted as received.
- **Attribution (DOTS-079).** `recordVerifiedTouchpoints` builds touchpoints only from messages that
  have a provider message id and are in `sent`/`delivered`/`received`. Owner-entered touchpoints are
  stored as unverified and ignored. `attributeDeal` requires a won deal with positive provider-received
  cash. It looks back 90 days and collapses same-campaign touches within 24 hours. It writes exactly one
  `first_touch` row and one `last_touch` row per deal, enforced by a unique constraint, and repeat runs
  are idempotent.

## HTTP API (`/api/v1/crm`)

`GET` (owner session) returns the view snapshot. Query parameters: `q`, `cursor`, `contact`.

```text
{contacts:{items,nextCursor,limit}, accountMap:{accounts,unassignedContacts}, candidates, imports,
 segments, pipelines, financials:{deals,totals:{forecastCents,invoicedCents,receivedCents}}, claims,
 conflicts, contactPolicy, regions, campaigns, agents, projects, counts, attribution, inspector, observedAt}
```

Raw email addresses are never returned. Addresses appear only as `email_masked` (`j***@domain`).

`POST` requires a trusted origin, an owner session and JSON of at most 1.1 MB, and returns `{outcome}`.
Actions: `createAccount`, `addAlias`, `createPerson`, `updateContact`, `stageImport`, `previewImport`,
`commitImport`, `discardImport`, `detectDuplicates`, `mergeContacts`, `dismissCandidate`,
`setRegionPolicy`, `setContactPolicy`, `recordConsent`, `suppress`, `overrideSuppression`,
`checkContactable`, `claimProspect`, `releaseClaim`, `saveSegment`, `previewSegment`,
`materializeSegment`, `addNote`, `createPipeline`, `createDeal`, `transitionDeal`, `linkInvoice`,
`recordVerifiedTouchpoints`, `attributeDeal`, `bulkReview` (with `bulkAction`: `assign_to_me`,
`archive`, `suppress` or `detect_duplicates`) and `inspectContact`.

## UI (DOTS-080)

`CrmView` (`section="contacts"` or `"pipeline"`) shows:

- lead cards with search, keyset "load more" and checkbox selection for bulk review
- an account map of accounts with contact chips
- a contact inspector with methods, sources, a contactability check, a lawful override form, owner
  notes and the evidence timeline
- import staging with a validation report and commit or discard
- merge review cards
- do-not-contact, region and frequency forms
- a segment builder with preview
- the pipeline board

Board cards can be dragged between lanes. A drop only pre-fills the card's "Move to stage" form; the
move is confirmed with evidence. The same form (select, evidence type and reference, Move) is the
keyboard and touch alternative to dragging. The view has no tables, its controls are at least 44 px,
lanes stack on narrow screens, notices use `aria-live` and errors use `role="alert"`.

## Scale and privacy (DOTS-081)

`tests/crm.test.mjs` seeds 50,050 contacts with `generate_series` in PGlite, plus a second 1,000-contact
tenant, and checks:

- keyset search pages never repeat
- page size is capped at 50
- search p95 stays under 1.5 s
- `EXPLAIN` shows an index scan and no sequential scan on `crm_contacts`
- duplicate detection finds exactly the 50 designed pairs
- the segment preview reports exactly 500 suppressed contacts
- suppressed contacts fail `assertContactable`
- the other tenant sees only its own rows
- the snapshot, `operation_events.details` and console output contain no raw addresses

The suite takes about 10 s locally.

## Environment variables

None. The CRM track reads no secrets and no configuration variables.

## External prerequisites

- **Blocked on external prerequisite: legal region review.** Owner or counsel must decide which
  jurisdictions may be contacted, and whether each needs explicit opt-in, before any contact can pass
  the gate. Record each decision with **Do-not-contact and policy → Region policy**, giving a legal
  review reference. Until a region is allowed, every contact is blocked with `REGION_NOT_ALLOWED` or
  `REGION_UNREVIEWED`.
- **Blocked on external prerequisite: production grants.** A migration administrator must apply
  `database/runtime-grants-0017.sql` after the migration, alongside the existing runtime grants.
- **Real receipts for wins and attribution** depend on the payments track's verified provider webhooks
  (invoice `paid`, `money_entries` with `source='provider'`). Without them, deals cannot be won except
  through a stored signed agreement, and no attribution is recorded.

## Acceptance criteria status

| Unit | Status |
| --- | --- |
| DOTS-070 | Implemented: tenant-isolated accounts and people, aliases, methods, owners and metadata; similar organizations never merge silently (tested). |
| DOTS-071 | Implemented: staging, provenance, purpose and consent fields, quarantine and preview-before-commit; commit creates no outreach (tested). |
| DOTS-072 | Implemented: normalized scoring, owner merge review, sources and conversations preserved; merged duplicates are blocked and share frequency limits (tested). |
| DOTS-073 | Implemented in the gate: suppression, consent history, region policy, frequency limits and audited overrides (tested). Wiring the gate into the existing send path and queue is left to the integrator. |
| DOTS-074 | Implemented: one active claim per prospect, exclusion windows, reported conflicts and serialized concurrent claims backed by a unique index (tested). |
| DOTS-075 | Implemented: allow-listed filters; preview gives counts and exclusion reasons, no inference (tested). |
| DOTS-076 | Implemented: unified timeline with timestamp, actor and source; model statements unverified (tested). |
| DOTS-077 | Implemented: configurable pipelines and evidence-guarded transitions; the legacy path cannot mark deals won (tested). |
| DOTS-078 | Implemented: multi-contact deals with campaign, probability label and close date; forecast, invoiced and received kept separate (tested). |
| DOTS-079 | Implemented: verified-receipt first/last-touch attribution with dedup windows, one row per deal and model (tested). |
| DOTS-080 | Implemented as a component. It is not yet in navigation (the integrator adds it under Contacts and Pipeline), and it has no screenshots or manual touch-device QA yet. |
| DOTS-081 | Implemented as an automated PGlite regression. It has not been measured on a hosted Postgres. |
