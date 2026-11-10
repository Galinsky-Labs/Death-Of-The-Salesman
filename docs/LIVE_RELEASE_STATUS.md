# Live release status — 2026-11-09 (Eastern)

The operations release is live at https://death-of-the-salesman.onrender.com in the
Galinsky Labs Render workspace, connected to the production Neon database.

- Runtime source: `4f6aa485b8d932fe854445e5fb5011b80648e46e` (merged PR #43).
- Current deploy: `dep-dbp6tm7ctcqc73al85rg`, live at
  `2026-11-10T01:11:47.068447Z` (8:11 p.m. Eastern on November 9).
- Service: `srv-dbp58hm1egvs73b3inug`, free web service in Ohio. Auto-deploy is off.
- Neon project: `muddy-mountain-84355519`; branch: `br-orange-recipe-bdgmz9qg`.
- [Live HTTPS acceptance](evidence/operations-render-live-acceptance.json) verifies the
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
- Local `pnpm check`: 117 passing tests, typecheck, secret scan and production build.
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

## Remaining external prerequisites

The free Render service sleeps; work runs while it is awake. Continuous execution requires
an independently funded configuration. Paid model calls, real email and payment collection
require the owner's provider keys, caps, verified sender/merchant and applicable authority.
The full 160-unit roadmap retains its own acceptance gates; this release is not evidence
that all planned units or real provider acceptance have completed.
