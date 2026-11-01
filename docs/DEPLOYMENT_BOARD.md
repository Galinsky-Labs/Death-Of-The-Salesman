# Owner deployment board (DOTS-026)

The `/deployment` route persists owner assignments through the standalone API and PostgreSQL.
Drag an available identity into a checked project bucket, review allocation, priority, quota and
concurrency, then save. Drag an assignment to another bucket to move the existing assignment.
The settings dialog also provides an explicit target selector and cancel action.

Opening settings is labelled unsaved. During a save, the board shows the optimistic placement,
disables concurrent edits and warns before navigating away. Only a successful write followed by
an authoritative GET is labelled saved. A conflicting write rolls back and reloads the server.
An ambiguous response also reloads without automatically resubmitting a possibly committed write.
If reconciliation fails, edits stay disabled until a successful reload. Hidden buckets preserve
their assignments and those allocations still count toward the agent's 100% limit.

## Runtime configuration

Build with `pnpm build`. The API binds to loopback on `API_PORT` (default 3001).
Configure the following through the deployment's secret/configuration mechanism:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Secret connection for the migrated application database; use a runtime role subject to RLS. |
| `DEPLOYMENT_ORGANIZATION_ID` | Server-selected organization UUID; browser requests cannot select a tenant or owner. |
| `DOTS_API_ORIGIN` | Web server's private API origin; defaults to `http://127.0.0.1:3001`. |
| `DOTS_WEB_ORIGIN` | Exact public web origin, including HTTPS and any non-default port; required when TLS terminates before Next. |

Neither a database URL nor a session is bundled. Without configured storage the endpoint returns
503. Without a valid owner session it returns 401/403. Existing OIDC session issuance must supply
the HttpOnly, Secure, host-only `__Host-dots-session` cookie with path `/`, and the readable
`dots-csrf` cookie matching the session's CSRF value. Production must serve the owner console over
HTTPS. This unit consumes the session contract; it does not create a login bypass or seed a live owner.

The web proxy forwards the cookie and CSRF token only to the configured API origin, rejects redirects,
and caps mutation bodies at 4096 bytes while streaming. The API checks current owner membership,
session expiry/revocation, CSRF, origin, strict input fields and integer bounds. Repository writes
recheck ownership and bucket visibility inside transactions; agent locks serialize allocation changes.
Preference changes lock the same bucket used by assignment validation. Errors omit SQL and credentials.
No worker, provider, outbound contact or paid operation starts when an assignment is saved.

## Evidence and reproduction

`pnpm check` runs source lint, TypeScript, unit/integration tests, secret scanning and production build.
`tests/deployment-database.test.mjs` applies every migration to an isolated PGlite PostgreSQL engine,
switches to a non-superuser RLS role and exercises the actual API/store/repository path. It verifies
durable refresh equality, versioned moves, stale conflicts, over-allocation, hide/show preservation,
the second preference update regression, tenant isolation and membership revocation.

For browser acceptance, install Chromium (`pnpm exec playwright install chromium`) and OpenSSL,
then run `pnpm build && pnpm test:deployment:browser`. The harness starts local HTTPS and an API
backed by a disposable PostgreSQL engine, generates a temporary one-day certificate, seeds only
synthetic records and removes the certificate afterward. It never contacts a live application database.
`DEPLOYMENT_CHROMIUM_PATH` optionally selects an already installed Chromium executable. An existing
local HTTPS web server may be selected with `DEPLOYMENT_BROWSER_URL`; configure its public origin
and API origin for the harness before running it.

The browser checks native drag/drop, unsaved settings, in-flight placement, confirmed refresh,
conflict rollback, lost-confirmation reconciliation and hide/show preservation. It also rejects an
oversized request and an untrusted origin. Screenshots in `docs/evidence/DOTS-026/` use synthetic data
at 1440, 1024, 768, 390 and 320 pixels. These are local acceptance evidence, not a deployed service
or evidence of worker activity. Full touch, keyboard and unassignment acceptance remains DOTS-027.

No schema migration is introduced. Rollback consists of reverting this unit's source changes; existing
assignment and bucket-preference rows remain intact. The canonical mapping is PR #33.
