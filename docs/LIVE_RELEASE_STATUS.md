# Live release status — 2026-11-10

The existing Render service is available at
https://death-of-the-salesman.onrender.com in Galinsky Labs. Its previously verified
runtime is the owner planning release, commit `423776e559a58840d06c1104240cbc9b32e9e35f`,
deploy `dep-dbp5bd6c6qcc73adpplg`. Auto-deploy is disabled. Do not describe the
operations release as live until its actual deployment and HTTPS checks are recorded.

## Operations release prepared

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
- All 14 console views passed authenticated desktop/mobile browser rendering and overflow checks.
- Local `pnpm check`: 117 passing tests, typecheck, secret scan and production build.
- Dependency audit: no known vulnerabilities. Failure-contract test passed.
- New migrations 0011–0013 have been applied to staging and production; these are additive.

## Production activation blocked

Automatic approval review rejected applying the new production runtime grants because
it considers the persistent permission expansion across operational and financial tables
to require explicit owner approval of that scope. Removing the broad function-execution
grant and supplying exact restricted-role tests and successful staging workflow evidence
did not satisfy that requirement. No workaround was used. Existing production runtime
credentials and permissions are unchanged, and the old compatible service stays live.

The concrete permission request is [database/runtime-grants.sql](../database/runtime-grants.sql):
SELECT and INSERT on the named operations tables, column-specific UPDATE for workflow
state, catalog and agent settings, and DELETE only for campaign audience selection rows.
It grants no schema management, auth access, role management, RLS bypass, primary-key
updates, financial/audit deletion or receipt-evidence mutation. Financial writes are ledger
records, not authority to charge, send, call paid models or spend. Tests prove these
restrictions in a disposable database. Explicit approval is needed before applying that
script to the production `dots_runtime` role and deploying the operations release.

## Remaining external prerequisites

The free Render service sleeps; work runs while it is awake. Continuous execution requires
an independently funded configuration. Paid model calls, real email and payment collection
require the owner's provider keys, caps, verified sender/merchant and applicable authority.
The full 160-unit roadmap retains its own acceptance gates; this release is not evidence
that all planned units or real provider acceptance have completed.
