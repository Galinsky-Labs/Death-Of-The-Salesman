# Live release status — 2026-11-09

The owner planning workspace is running at:

https://death-of-the-salesman.onrender.com

This is a real Render web service connected to its dedicated Neon database. It is
not acceptance of the full autonomous-sales and fundraising product.

## Verified deployment

- Render workspace: Galinsky Labs.
- Service: `srv-dbp58hm1egvs73b3inug` (free web service, Ohio).
- Deploy: `dep-dbp5bd6c6qcc73adpplg`, observed `live`.
- Runtime source SHA: `423776e559a58840d06c1104240cbc9b32e9e35f` (merged PR #41).
- Render finished deployment at `2026-11-09T23:23:53.576491Z` (6:23 p.m. Eastern).
- Live HTTPS acceptance passed at `2026-11-09T23:24:05.455Z`.
- Neon project: `muddy-mountain-84355519`; production branch `br-orange-recipe-bdgmz9qg`.
- Independent staging acceptance: `staging-acceptance-20261109` / `br-blue-union-bdjoyszi`.
- Later documentation-only commits do not change this runtime revision; auto-deploy is disabled.

[Machine-readable HTTPS evidence](evidence/render-live-acceptance.json) records
actual statuses, database connectivity and matching runtime SHA. Root and dashboard
redirect signed-out users to login; protected reads and same-origin writes return
401 while signed out; foreign-origin writes return 403. Unexposed signup endpoints
and the removed synthetic review route return 404. Non-owner code requests are
rejected before email delivery. No sign-in email was sent during automated acceptance.

Startup logs show the server listening on `0.0.0.0:10000` and Render reporting the
service live. Next emits a standalone-output/start-command warning; the tested HTTP
routes work. A future packaging cleanup can align those settings without changing
application behavior.

## Working release scope

- Owner sign-in screen using Managed Neon Auth's email-code flow.
- Server-side verified-email owner restriction and active membership checks.
- Real project creation, category/brief persistence and versioned archive.
- Persistent drag-and-drop or keyboard/touch agent assignments and removal.
- Atomic 100% per-agent allocation cap with concurrent-operation serialization.
- Archive protection against outstanding or concurrently created assignments.
- Recent append-only, database-triggered audit activity.
- Real tenant-scoped Neon readiness, distinct from web liveness.
- No fabricated revenue, contacts, active model runs or green worker status.

## Validation

- PR #40: Foundation Shell verify + PostgreSQL migration job and Canonical Plan Checks passed at head `7837b6e503b306669a0e03024a8b65ca63797e93`.
- PR #41: the same checks passed at head `6b0c07cbb21b63a2dfd484e567615e2ccae9a30a`.
- [Foundation CI for #41](https://github.com/Galinsky-Labs/Death-Of-The-Salesman/actions/runs/42719624803).
- [Canonical Plan CI for #41](https://github.com/Galinsky-Labs/Death-Of-The-Salesman/actions/runs/42719625259).
- Local `pnpm check`: 102 tests, lint, strict types, secret scan and production build passed.
- Dependency audit: no known vulnerabilities.
- Chromium review on synthetic fixtures: desktop/mobile layout, search/empty state,
  mutation-error state, accessible assignment form and login rendering passed with no overflow.
- A live Chromium screenshot attempt was blocked by the cloud proxy CA not being
  trusted by Chromium (`ERR_CERT_AUTHORITY_INVALID`). TLS validation was not disabled.
  The live HTTPS checks use the environment's configured CA trust and passed.
- [Separate Neon staging evidence](evidence/neon-staging-acceptance.json): project
  and assignment persistence, allocation cap, concurrent serialization, stale writes,
  audit creation, tenant isolation and least-privilege checks passed.

## Owner acceptance and unfinished work

Sign in using the configured owner email (the Render workspace account email unless
the owner specifies another), request a code, then create a project and assign an
agent. Confirm sign-out, sign-in and session restoration after reload. That mailbox
round trip is **not yet verified**. Shared Neon authentication SMTP is an initial
acceptance dependency; custom SMTP remains required for production auth rollout.

The paid execution cap is $0. Models, outbound mail, real campaigns and cash handling
remain disabled. The runtime has no migration-admin credential. No new billable
resources or paid provider calls were created by this release.

The full roadmap remains incomplete: durable agent execution, provider adapters,
CRM, campaigns, conversations, funding workflows, payments and remaining hardening
are not claimed as delivered. Further release prerequisites include provider
credentials with explicit hard budgets, reviewed sender/consent policy for outreach,
and separately authorized account/merchant/legal gates where applicable. This work
is recorded as contributions to DOTS-026/027/151, not completion of DOTS-151–160.

See [the deployment runbook](RENDER_NEON_RUNBOOK.md) for configuration and rollback.
