# Render and Neon release

This release adds DOTS-026's persistent project/assignment board and DOTS-027's
keyboard and touch alternative, with supporting Render/Neon deployment work.
The owner explicitly requested a running Render deployment using Neon on 2026-11-09.
That request authorizes this deployment; it does not enable paid execution or outbound campaigns.
The full 160-unit roadmap is not complete and this release is not full production acceptance.

## Runtime

One Next.js web service serves the UI and authenticated application Route Handlers.
The existing independent API health stub and disabled worker are not deployed as
extra services. No idle workers or paid resources are needed for this release.

- Render: free web compute, Ohio; build `npx --yes pnpm@11.25.0 install --frozen-lockfile --prod=false && npx --yes pnpm@11.25.0 build`.
- Start: `node apps/web/node_modules/next/dist/bin/next start apps/web --hostname 0.0.0.0 --port $PORT`.
- Neon: Galinsky Labs free plan, AWS Ohio, Postgres 17, 0.25 CU, normal idle suspension.
- Neon project: `muddy-mountain-84355519`; branch: `br-orange-recipe-bdgmz9qg`.
- Liveness: `/api/health`. Readiness: `/api/readiness`, including an actual tenant-scoped database query.
- Immutable source revision is returned by readiness when Render supplies `RENDER_GIT_COMMIT`.
- Free Render services sleep after 15 minutes of inactivity. The next request can take about a minute.

## Required runtime variables

Names only; configure values through Render's secret environment settings:

- `DATABASE_URL`: pooled connection for the restricted `dots_service` login.
- `NEON_AUTH_BASE_URL`: the production branch Managed Auth URL.
- `NEON_AUTH_COOKIE_SECRET`: random value of at least 32 characters.
- `OWNER_EMAIL`: the owner's confirmed, verified login email; no default is permitted.
- `APP_ORIGIN`: the exact public HTTPS origin; required for production mutation checks behind Render's TLS proxy.
- `OWNER_ORGANIZATION_ID`, `OWNER_MEMBERSHIP_ID`: provisioned owner tenant and membership.
- `APP_ENV=production`, `PAID_SPEND_LIMIT_CENTS=0`, `MODEL_API_ENABLED=false`, `EMAIL_DELIVERY_ENABLED=false`.
- `NODE_VERSION=24.19.0`.

Keep `DATABASE_URL_UNPOOLED` with migration administrators only. It must not be
installed in the web service. Never place populated env files in this repository.

## Provisioning and migrations

Apply migrations 0001–0010 once using the existing migration runner and an unpooled
administrator connection (`DATABASE_URL` for that command only). The release adds no
new schema migration. Initialize one owner organization, owner user, active owner
membership, and the approved Fast Eddie Felson and Harry Wormwood identities.
No synthetic project, customer, campaign, message, or revenue is seeded into production.

Create `dots_runtime` as NOLOGIN, NOSUPERUSER, NOBYPASSRLS and a separate
`dots_service` LOGIN that inherits it. Grant runtime USAGE on schema `app`, EXECUTE
on its functions, SELECT on memberships/projects/agent identities/assignments/audit,
INSERT and UPDATE on projects/assignments, INSERT on audit, DELETE on assignments.
The runtime login cannot create roles, alter tables or bypass tenant row security.
Every transaction switches to `dots_runtime` and sets transaction-local tenant and
audit actor context. Existing database triggers append audit records atomically.

Provision Managed Neon Auth on `dots`. Add the actual Render HTTPS origin to its
trusted origins before using login. The app uses the managed SDK's same-origin
proxy, owner-only email OTP, verified email authorization, live membership checks,
and same-origin checks for unsafe requests. Arbitrary password/signup/social/admin
proxy endpoints are not exposed. Neon sends sign-in codes only when the owner requests
one. Provider limits remain active. Shared SMTP is suitable for initial acceptance;
Neon's production checklist requires custom SMTP before a production authentication rollout.

## Acceptance and evidence

Run `pnpm check`, `pnpm audit:dependencies`, and `node scripts/validate-pr-registry.mjs`.
Browser acceptance checks desktop/mobile layout, project search, error states,
keyboard/touch assignment controls, unauthenticated API rejection, cross-origin
mutation rejection, login rendering and Neon readiness. Screenshots under
`docs/evidence/` use only synthetic review fixtures. The review fixture route is
removed before commit/build; it is not a deployed auth bypass or production data.

Database acceptance must run on the separate staging branch, recording project
creation, assignment persistence, allocation rejection and immutable audit evidence.
Check real GitHub CI and mergeability before merging. A queued deploy is not success:
wait for Render status `live`, then verify HTTPS, `/api/readiness`, source revision,
protected access, and logs. Record deploy ID, source SHA and checks in release evidence.
Owner OTP delivery/session restoration remains a human acceptance gate until exercised.

## Boundaries and rollback

Project writes, assignment removal, archive and audit are real database operations.
Assignments do not start model execution. Archive requires no remaining assignments,
and locks the project against concurrent assignment creation. Allocation is limited
atomically to 100% per agent using a tenant/agent transaction advisory lock; project
row locking serializes archive against assignment creation. No UPDATE grant on
agent identity IDs is needed. Errors preserve existing data and can be retried.

Model APIs, CRM, campaign dispatch, mailbox delivery, payments, grants submission,
funding analytics and durable agent execution are still roadmap work, not live features.
Do not represent this deployment as the completion of DOTS-151–160 or enable any
provider/channel merely because it has a credential. Keep the $0 cap and outbound off.

Rollback the Render app to a known compatible source revision. Do not roll back
production audit migrations or delete owner data to roll back this release. No schema
changes need reverting. A first-release failure can be addressed by reverting the PR
and leaving the Neon database intact. Staging and production must remain separate.
