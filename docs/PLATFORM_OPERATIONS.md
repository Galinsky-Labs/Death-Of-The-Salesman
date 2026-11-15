# Platform operations, recovery and deployment (DOTS-146–160)

## Operations health (DOTS-155, DOTS-156)

The **Operations health** view (`/api/v1/platform`) derives every alert from persisted rows: stale or
quarantined queue work, expired leases, held budget reservations, budget thresholds, complaints and
bounces from signed receipts, paused mailboxes, unprocessed provider receipts, expiring approvals,
quarantined messages and open incidents. When nothing qualifies, it shows no alert; it never infers health.

Incidents (`app.incidents`) carry append-only evidence steps (`app.incident_events`). The **pause-all drill**
pauses the workspace, proves a worker cannot claim queued work and that an already approved action cannot
be consumed while paused, records each step, restores the owner's previous pause state and resolves the
incident. Queued work is preserved. Credential-revocation drills are recorded manually with evidence notes
after rotating the key in Render.

Tenant admission applies backpressure from persisted queue depth and live leases (`admissionDecision`).

## Read-only portfolio interoperability (DOTS-159)

Boardroom or Engine Room may read `GET /api/v1/portfolio` with `Authorization: Bearer <token>`.
Owners issue and revoke tokens in Operations health; only a SHA-256 hash is stored and the raw token is shown
once. Tokens expire within 366 days. The response contract `dots-portfolio-summary-v1` contains only:
projects (id, label, category), campaign counts by state, open pipeline estimates (labelled *estimate, not
cash*), provider-verified cash totals, active/total agent counts, open incident count and recent event types.
It contains no contacts, messages, documents, credentials or owner identity. `POST` returns 405.
Missing or malformed bearer tokens are rejected with 401 before a database connection is opened, so scanners
cannot wake the free Neon compute; a database outage returns 503 `PORTFOLIO_UNAVAILABLE`.

Counterpart changes (consuming this contract) must be tracked separately in the Boardroom and Engine Room
repositories; nothing here mutates their data and they cannot mutate sales data.

## Backup, restore and continuity (DOTS-150)

- Primary recovery: Neon point-in-time restore of the production branch (history window per plan).
- Independent copy: `scripts/backup.mjs` streams `pg_dump` through AES-256-GCM with a manifest of
  plaintext and ciphertext SHA-256 digests. Store the encrypted file outside Render and outside this repository.
- Drill: `scripts/restore-drill.mjs` restores into an **empty, separate** database, verifies both digests,
  the migration ledger, row counts and the audit hash chain, and refuses to overwrite the source.
- Targets: RPO ≤ 24 hours, RTO ≤ 24 hours. After restore, run a worker pass: expired leases are quarantined
  for reconciliation instead of re-sent.
- Evidence: [`docs/evidence/backup-restore-drill.json`](evidence/backup-restore-drill.json) (synthetic data;
  tampered backups are rejected). Production backups need `pg_dump` 17 for Neon's Postgres 17.
- Keys: `BACKUP_ENCRYPTION_KEY` (32 random bytes, base64), `DOCUMENT_ENCRYPTION_KEY`,
  `CREDENTIAL_ENCRYPTION_KEY`. Keep them in a password manager; losing them makes encrypted data unreadable.

## Infrastructure as code (DOTS-151)

`render.yaml` declares the single free web service with zero-spend defaults; every secret is `sync: false`.
`infra/environments.json` inventories staging and production resources and the $0 cost policy.
`tests/infrastructure.test.mjs` validates both in CI without provisioning anything. Creating any billable
resource requires explicit owner cost approval first.

## Staging and promotion (DOTS-152, DOTS-153)

Staging uses the isolated Neon branch `staging-acceptance-20261109` with synthetic tenants and the restricted
runtime role. Promotion uses the manual **Owner-authorized deploy** workflow, which:

1. accepts only a full SHA already on `main` whose `verify`, `database` and `validate-roadmap` checks passed;
2. runs inside a GitHub environment (configure required reviewers for `production`);
3. deploys that exact commit through the Render API and waits for `live`;
4. runs `scripts/smoke.mjs`: liveness, database readiness, exact revision, anonymous and cross-origin
   rejection, unsigned-webhook rejection and portfolio token requirement.

`scripts/smoke.mjs` covers every owner route (anonymous `GET` and both forged-origin and anonymous same-origin
`POST` must be rejected), Stripe and Resend unsigned webhooks, and portfolio token rejection. CI runs the same
script on every PR against the production build over real HTTP (`SMOKE_EXPECT_DATABASE=false`, loopback only),
where readiness must fail closed with 503. Against a public origin the database must always be ready.

Required GitHub configuration (names only): environment `production`; secret `RENDER_API_KEY`;
variables `RENDER_SERVICE_ID` and `PUBLIC_ORIGIN`. Until those exist, deploy with the documented Render
runbook and run `scripts/smoke.mjs` manually. Rollback: redeploy the previous live SHA with the same workflow;
schema migrations are additive and are not rolled back on production.

## Scale (DOTS-149, DOTS-157)

Migration `0023` adds read-path indexes for roster, CRM, timelines, campaign windows, metrics and approvals.
`scripts/scale-identities.mjs` loads one million agent identity records across synthetic tenants into a local
disposable database and measures keyset-paginated roster pages and name search.
[`docs/evidence/million-identity-scale.json`](evidence/million-identity-scale.json): 1,000,000 identities,
12.4 s bulk load, roster page p95 0.21 ms and name search p95 0.33 ms with index scans, 378 MB, zero running
workers. Registered identities are records; active execution remains bounded by queue leases.

## Commercial tenants (DOTS-158)

`scripts/provision-tenant.mjs` creates an empty tenant (paused, $0, models and outbound off, no agents, no
contacts, no keys) with an administrative connection. It refuses to run unless
`COMMERCIAL_SIGNUP_ENABLED=true`. **Blocked on external prerequisite:** the owner's decision to commercialize,
published product terms and privacy notice, licensed original avatars and billing obligations.

## Privacy (DOTS-146)

See [PRIVACY.md](PRIVACY.md) for the processor inventory, retention, export, correction and deletion flows.
