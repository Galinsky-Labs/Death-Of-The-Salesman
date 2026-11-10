# Live release status — 2026-11-09 (Eastern)

The operations release is live at https://death-of-the-salesman.onrender.com in the
Galinsky Labs Render workspace, connected to the production Neon database.

- Runtime source: `f88c804fa430dab4e828c745aa251ea4423cec79` (merged PR #45).
- Current deploy: `dep-dbp7ep3rjlhs73f33r4g`, live at
  `2026-11-10T01:47:23.012208Z` (8:47 p.m. Eastern on November 9).
- Service: `srv-dbp58hm1egvs73b3inug`, free web service in Ohio. Auto-deploy is off.
- Neon project: `muddy-mountain-84355519`; branch: `br-orange-recipe-bdgmz9qg`.
- [Current live HTTPS acceptance](evidence/free-integrations-live-acceptance.json) verifies the
  exact runtime SHA, database readiness, durable-queue configuration, owner access
  boundaries, cross-origin protection and signed-webhook requirements.
- [Production database acceptance](evidence/operations-production-database-acceptance.json)
  verifies 17 operational domains using the restricted application credential and
  confirms no invoice primary-key updates, financial deletion or schema creation.

## Operations release scope

The new operations console implements persistent CRM, consent/suppression and erasure,
deals, campaign rehearsal and revision approvals, conversations and message approvals,
strategies and experiments, distinct grant/investment workflows, invoices, signed provider
receipts, encrypted documents, budgets, durable queued agent tasks and activity history.
There are distinct configured adapters for the six model candidates and an optional Neon
endpoint. Public grant discovery queries Grants.gov. Real provider execution requires
owner credentials and funded authority; deployment defaults remain zero spend and no
outbound messages or live payments. See [operations runbook](OPERATIONS_RUNBOOK.md).

Actual isolated Neon staging acceptance completed at `2026-11-10T00:41:47.095Z` using a
provider-signed session for a synthetic identity and the restricted application role.
It exercised project/agent setup, CRM imports and dedupe, pipeline, offers/facts, campaign
rehearsal/approvals, conversation drafts, invoice issue/print, encrypted documents, grant
checklists, the actual child worker and durable results, suppression/erasure and exports.
No production user was impersonated; no email, real payment or paid inference occurred.
The owner's real mailbox OTP round trip remains unverified.

- [Machine-readable workflow evidence](evidence/operations-staging-acceptance.json).
- [Desktop screenshot](evidence/operations-desktop.png).
- [Mobile screenshot](evidence/operations-mobile.png).
- [Browser acceptance](evidence/operations-browser-acceptance.json): all 14 views passed
  desktop/mobile rendering and overflow checks; form saves persisted after reload and
  keyboard dialog dismissal passed.
- [Historical production hold check](evidence/operations-production-hold.json) records
  the previous runtime before the owner approved the production permissions.
- Local `pnpm check`: 123 passing tests, typecheck, secret scan and production build.
- Dependency audit: no known vulnerabilities. Failure-contract test passed.
- New migrations 0011–0013 have been applied to staging and production; these are additive.

## Production activation

The owner explicitly approved the exact linked `database/runtime-grants.sql` permission
scope on November 9. That script was applied to production, and deployment secrets were
configured privately in Render. The application retains its restricted runtime role,
tenant RLS and column-specific update grants. It has no schema management, auth-schema
access, role management, RLS bypass, primary-key updates, financial/audit deletion or
receipt-evidence mutation. The administrative migration credential is absent from Render.

Durable queue execution is enabled. Paid model execution, email delivery/receiving and
payments remain disabled, with a zero-dollar spending cap. The document encryption key
and unsubscribe signing key are configured; key values are never included in evidence.

## Free integrations

PR #45 adds pinned Qwen3.8 27B on a confirmed Groq Free account, optional Gemma 4 31B
through OpenRouter with zero maximum prices and a pinned host, and Resend Free dispatch
with organization ceilings of 100/day and 3,000/month. Free paths preserve the $0 funded
cap. Paid fallback is disabled; exhaustion stops work instead of upgrading it. Free model
inputs require public/non-personal confirmation and exclude private workspace context.

Settings now includes connection checks without inference, honest key-required statuses,
account signup links and approved free-model discovery. Stripe sandbox accepts restricted
test keys and rejects invalid payment limits. No migrations or new runtime grants were
needed. All 123 tests and source CI passed. Authenticated staging browser acceptance and
current public catalog evidence are under `docs/evidence/free-integrations*` and
`docs/evidence/free-model-catalog-2026-11-09.json`.

Deployment enables the free connector paths, not external account credentials. Groq and
Resend require confirmation that the owner's account is actually on the Free plan. Provider
keys and authenticated inference/email/payment canaries remain external prerequisites.
See [exact signup/key/webhook instructions](FREE_AND_PAID_INTEGRATIONS.md).

## Remaining external prerequisites

The free Render service sleeps; work runs while it is awake. Continuous execution requires
an independently funded configuration. Paid model calls, real email and payment collection
require the owner's provider keys, caps, verified sender/merchant and applicable authority.
The full 160-unit roadmap retains its own acceptance gates; this release is not evidence
that all planned units or real provider acceptance have completed.
