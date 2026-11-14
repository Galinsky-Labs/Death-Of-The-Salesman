# Campaign Studio (DOTS-082 – DOTS-093)

Campaign Studio is the owner's workspace for planning, checking, simulating, approving and running campaigns. It
is built so that nothing reaches a real person, and nothing costs money, unless the owner has approved the exact
revision and every server-side gate passes again just before dispatch.

| Piece | Location |
| --- | --- |
| Domain module | `packages/operations/src/campaigns.ts` (`CampaignStudio`, pure rule functions, `assertCampaignDispatchable`) |
| Migration | `database/migrations/0018_campaign_studio.{up,down}.sql` |
| Runtime grants | `database/runtime-grants-0018.sql` (apply after `database/runtime-grants.sql`) |
| HTTP API | `apps/web/app/api/v1/campaigns/route.ts` |
| UI | `apps/web/app/views/campaign-studio-view.tsx` (`CampaignStudioView`, navigation label **Campaign Studio**) |
| Tests | `tests/campaigns.test.mjs` (PGlite, no network) |

## Lifecycle (DOTS-082)

States: `draft → validated → ready_for_approval → approved → scheduled → active → paused → completed/archived`,
plus `aborted`. The transition table is exported as `campaignTransitions`. Every lifecycle `UPDATE` carries
`state = ANY(<states allowed to move into the target>)` and the expected row `version`, so the database applies only
permitted transitions and concurrent writers get `VERSION_CONFLICT`.

Migration 0018 maps legacy states: `simulated → validated`, `awaiting_approval → ready_for_approval`. The down
migration maps back (`approved → awaiting_approval`, `scheduled → paused`, `aborted → archived`) before restoring
the 0012 constraint. The legacy `SalesWorkspace` rehearsal (`simulateCampaign`, `campaignApproval`) now uses the
`validated` state; `pauseCampaign` only pauses `active`/`scheduled` campaigns and holds their queued work.

**Material edits** (anything except the campaign name) to a campaign in `draft`, `validated`,
`ready_for_approval`, `approved`, `scheduled` or `paused`:

1. bump `revision` and append an immutable `campaign_revisions` snapshot (reason, changed fields, approval binding);
2. move the campaign back to `draft` and clear `approved_revision`, `approved_hash` and `approval_id`;
3. mark every pending/approved campaign approval `expired`;
4. cancel queued or waiting work generated from the earlier revision.

Active campaigns must be paused before editing. Completed, archived and aborted campaigns cannot be edited.
Audiences (`campaign_audience_revisions`), budgets (`campaign_budget_revisions`) and copy
(`message_template_revisions`) are versioned, append-only tables; the campaign points at the current revision.

## Builder (DOTS-083)

The view is a split pane: the campaign list and a "New draft" form on the left, and on the right the goal/offer,
sender/channel/rules, schedule, budget, audience, copy, pricing, variants, review and control-room sections.
Drafts are saved on the server (`saveDraft`, optimistic `version`); unsaved field edits are also remembered in this
browser and offered back with **Restore unsaved edits** when the server version has not moved. Empty states explain
which evidence is missing (projects, contacts, senders, facts, decisions).

## Copy editor and safe HTML (DOTS-084)

* Templates are versioned (`message_templates` + immutable `message_template_revisions`). `editCopy` writes a new
  revision and points the campaign at it, which revokes approval.
* Placeholders: `{{contact.first_name}}`, `{{contact.last_name}}`, `{{contact.full_name}}`, `{{contact.company}}`,
  `{{contact.role}}`, `{{contact.country}}`, `{{sender.name}}`, `{{offer.name}}`, `{{project.name}}` and
  `{{fact:<vetted fact id>}}`. Unknown or unbalanced placeholders block validation.
* `sanitizeHtml` is a hand-written strict allowlist (`p br strong b em i u ul ol li a h2 h3 blockquote hr span`).
  Script/style/iframe/svg/math/object and similar containers are dropped with their content, every attribute is
  removed except a link `href` that decodes (entities and whitespace removed) to `http(s)://` or `mailto:`.
  Variable values are HTML-escaped and the rendered HTML is sanitized again. Previews render in a
  `sandbox=""` iframe; the view never uses `dangerouslySetInnerHTML`.
* Previews use fixed synthetic prospects (`syntheticProspects`), never CRM contacts.

## Claim registry checks (DOTS-085)

Every sentence containing a number (outside prices/discounts, which DOTS-086 governs) or a measurable superlative
must cite a `{{fact:<id>}}` whose fact is active, belongs to the campaign project, has a source URL, a verification
date, is effective and unexpired, **and** whose text contains each cited number. Outcome promises ("guaranteed",
"risk-free", …) always block. Approval binds the versions of cited facts; editing a fact after approval makes work
generation and dispatch fail with `APPROVAL_STALE`, and an expired fact fails dispatch.

## Price and discount guardrails (DOTS-086)

`offer_price_rules` holds authorized prices, a maximum discount (basis points) and restricted phrases per offer.
Copy and quotes (`validateQuote`) may only use an authorized price or a discount from one within the maximum.
Anything else needs an owner-approved exception: `requestPriceException` creates an `action_approvals` row of kind
`quotation`; `decidePriceException` approves it and appends an immutable `campaign_price_exceptions` record.
Pending exceptions do not count.

## Jurisdiction, quiet hours and cadence (DOTS-087)

`checkSendRules` and `contactExclusion` enforce, with plain-language reasons:

* channel scope — email to the reviewed country list; **SMS is disabled** until an owner-reviewed SMS consent policy
  exists (blocked on external prerequisite: written TCPA/PECR consent policy);
* consent per channel/country (`opted_in`/`existing_customer`; `business_reviewed` only for US email);
* investment outreach requires an authority reference and is US-only; grant outreach warns without one;
* quiet hours 20:00–08:00 in the campaign time zone, optional weekdays-only window;
* daily cap ≤ 100 for email, at most 2 messages per contact per week, per-contact frequency cap across campaigns;
* suppression list and contact status are rechecked at validation, generation and dispatch.

Sender **domain reputation** is not monitored: validation shows a warning. *Blocked on external prerequisite:* a
deliverability/reputation data source (for example the email provider's domain reputation feed) must be chosen and
funded by the owner before it can become a blocking gate.

## Variants (DOTS-088)

`campaign_variants` attach a strategy and an exact template revision with a weight and eligibility (countries,
consents, role keyword). Choice is deterministic per campaign+contact. Variants can only be retired (a trigger keeps
their lineage immutable). Each work item records `variant_id`, `strategy_id` and `template_revision_id`, and the
queue payload carries the same ids.

## Simulation (DOTS-089)

`simulate` renders up to five synthetic prospects, evaluates the real audience for exclusions (reasons by contact
id only, no PII), predicts the maximum cost, proposes a send plan and lists the tool actions that *would* run. It
writes one append-only `campaign_simulations` row whose `network_requests`, `billable_requests` and `messages_sent`
columns are constrained to 0, and creates no queue, reservation or money rows. Approval requires a simulation with
no blocking issues for the exact current binding hash.

## Owner approval (DOTS-090)

`requestApproval` (from `validated`, with no blocking issues and a matching simulation) stores the binding as the
approval proposal and its hash: sender mailbox, channel, countries, audience revision + hash, total and per-message
budget, exact message revision id, active variants, schedule/window/time zone, caps, offer, strategy, price-rule
version and cited fact versions. `decideApproval` re-computes the binding and refuses a stale one. Scheduling,
activation, resume, work generation and dispatch all re-check that the approval is still `approved` and the binding
hash unchanged.

## Work generation (DOTS-091)

`generateWork` runs only for `active` campaigns whose start time has arrived, when the workspace is not paused and
the approval is fresh. It inserts `follow_up` tasks in **simulation** mode (no provider calls) plus a
`campaign_work_items` ledger row, deduplicated by `campaign:<id>:contact:<id>` on both tables. Capacity is the
minimum of the request size, the campaign daily cap, the agent assignment quota, the agent daily limit and the
remaining budget at the per-message maximum. `available_at` is the next allowed sending window. Pausing holds queued
work (`waiting`/`CAMPAIGN_PAUSED`, not released by a workspace resume); completing, aborting or revising cancels it.
`activateDue()` is a worker hook for scheduled campaigns whose start time has arrived.

### Integration hook

`assertCampaignDispatchable(tx, ctx, campaignId, messageRevision, now?)` must be called inside the dispatch
transaction before any send or paid request. It fails closed unless the campaign is active, started and not ended,
the message revision equals the approved revision, the workspace is unpaused with outbound enabled, the time is
inside the sending window, the approval binding is fresh, cited facts are valid and the committed budget is within
the total. Wiring it into `DeliveryGateway`/the engine is left to the integrator (this track does not edit those
files).

## Control room (DOTS-092)

`detail(id)` returns the timeline (`operation_events`), owner decisions, price exceptions, revisions, latest
simulations, work by queue state, linked project buckets, expenses and a funnel where each stage names its source:
drafted (not sent), scheduled work (queue), work generated (ledger), actually sent (outbound messages with a provider
message id), replies (provider-received inbound in threads with a sent campaign message) and revenue received
(provider-verified sale receipts on invoices for audience contacts; sandbox receipts excluded).

## HTTP API

`GET /api/v1/campaigns[?campaign=<id>]` → `{snapshot, detail}` where `snapshot` has `campaigns, projects, offers,
facts, mailboxes, strategies, templates, contacts, agents, policy, channelPolicies, quietHours,
maxMessagesPerContactPerWeek, templateVariables, lifecycle, observedAt`.

`POST /api/v1/campaigns` (trusted origin, owner session, JSON ≤ 300 KB) with `action` one of: `createDraft`,
`saveDraft`, `setAudience`, `setBudget`, `editCopy`, `createTemplate`, `reviseTemplate`, `previewTemplate`,
`addVariant`, `retireVariant`, `setPriceRule`, `requestPriceException`, `decidePriceException`, `validate`,
`simulate`, `requestApproval`, `decideApproval`, `schedule`, `activate`, `pause`, `resume`, `complete`, `abort`,
`archive`, `generateWork`. Response: `{outcome, snapshot, detail}`; errors `{error: CODE}` with the operation status.

## Operator steps

1. Apply migration 0018, then `database/runtime-grants.sql` and `database/runtime-grants-0018.sql` as the migration
   administrator.
2. In the catalog add the offer and vetted facts (with HTTPS source and expiry); set the offer's price rule.
3. Add and verify a sender mailbox (existing flow). Create a campaign draft, fill every section, save.
4. Validate → run the dry-run simulation → request approval → approve → schedule → activate (once the start time
   arrives) → queue approved work. Pause, resume, complete or abort at any time from the Review section.

Environment variables: none new. Delivery still depends on the existing names `EMAIL_DELIVERY_ENABLED`,
`OUTREACH_POLICY_AUTHORIZATION_ID`, `SENDER_VERIFICATION_REFERENCE`, `EMAIL_ALLOWED_JURISDICTIONS`,
`OWNER_SPEND_AUTHORIZATION_ID` and `PAID_SPEND_LIMIT_CENTS`.

Spend impact: USD 0. Campaign budgets above zero require an owner authorization reference and an owner-funded
spending policy; simulations and work generation never reserve or spend money.

## Acceptance status

| Unit | Status |
| --- | --- |
| DOTS-082 lifecycle + immutable revisions | Implemented and tested |
| DOTS-083 split-pane builder, save/restore drafts, empty states | Implemented (build-verified; no browser screenshot evidence yet) |
| DOTS-084 versioned templates, slots, previews, safe HTML | Implemented and tested (XSS payload suite) |
| DOTS-085 claim registry checks | Implemented and tested |
| DOTS-086 price/discount guardrails + exceptions | Implemented and tested |
| DOTS-087 jurisdiction/quiet-hour/cadence rules | Implemented and tested; domain reputation blocked on external prerequisite |
| DOTS-088 variants with lineage | Implemented and tested |
| DOTS-089 simulation/send plan | Implemented and tested |
| DOTS-090 approval binding + invalidation | Implemented and tested |
| DOTS-091 safe work generation | Implemented and tested; dispatch hook exported, wiring pending integration |
| DOTS-092 control room | Implemented; sent/replies/revenue show 0 until real provider evidence exists |
| DOTS-093 policy E2E incl. races | Implemented (`tests/campaigns.test.mjs`) |
