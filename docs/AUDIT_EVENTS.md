# Append-only audit and actor provenance (DOTS-030)

Migration `0010_append_only_audit` records tenant, database-resolved human actor, role at the time of
the event, event type, authorization policy version, correlation UUID and bounded evidence. It adds
transactional capture to project/offer/fact/pricing changes, bucket preferences, identities,
assignments, organization settings/auth policies, session creation/security changes, delegation
grants and membership changes. Session last-seen/idle-expiry touches do not generate audit noise.

The audit insert runs in the business transaction. If actor validation or evidence insertion fails,
the business mutation fails too. A later transaction rollback removes both. Membership changes
require a current owner actor; other captured writes retain the existing authenticated human actor and domain authorization. Explicit server appends and read access
through `AuditEventRepository.list` are limited to active same-tenant owners/admins. Existing
authentication and MFA checks remain the responsibility of the authenticated server adapter.

## Actor and transaction context

For normal repository writes, the stored `updated_by_membership_id`, `created_by_membership_id`,
or `owner_membership_id` supplies provenance. Session creation uses its verified membership link.
For membership operations, authentication-policy changes, deletes, or a request that groups several
mutations, call `setAuditContext` **inside the checked-out connection's transaction**, after server
authentication. It sets tenant, actor membership, correlation ID and policy version as transaction-local
settings. Never populate this context directly from browser/model claims. The database resolves the
actor's user and role; the caller cannot override their recorded values.

Bootstrap of the first owner must explicitly set the new owner's tenant/membership context in the
trusted onboarding transaction. The membership insert is audited after the new owner row exists.
Subsequent membership grants require an existing active owner. Missing context fails closed.
Do not use session-level actor settings on a shared connection pool. Where no request-level policy
or correlation is supplied, the trigger uses `dots-authorization-v1` and a transaction-local generated
UUID. These defaults describe the current authorization implementation, not a new authorization grant.

`AuditEventRepository.append` supports explicit structured server events. Evidence permits only
record identifiers/types, operation, version, status, changed field names, machine reason codes and
SHA-256 evidence references. Capture stores changed field names, never their raw values, full content,
session token hashes, credentials or message bodies. Keep reason/status codes free of personal data.
Agents have no audit write/read authority in the current implementation.

## Integrity and isolation

Forced RLS scopes reads/inserts to the active tenant. There are no UPDATE/DELETE policies, and
database triggers additionally reject UPDATE, DELETE and TRUNCATE even under broad table grants.
Foreign keys prevent cross-tenant actor references and cascading deletion of retained audit history.
Rows include a SHA-256 digest of canonical JSONB with an explicitly UTC timestamp; reads verify it.
Keyset cursors retain all six PostgreSQL fractional timestamp digits to avoid skipping same-millisecond
events. Limits are bounded to 200 rows.

The digest detects inconsistency; it is not an external signature, hash chain or independent backup.
A database owner able to drop triggers/schema remains an administrative trust boundary. External
immutable backups and operational restoration evidence require separately approved deployment work.

## Validation and CI prerequisite

`tests/audit-events.test.mjs` applies the actual migrations to an isolated PGlite PostgreSQL engine,
then switches to a non-superuser RLS role with deliberately broad table grants. It verifies automatic
capture through the real project repository, atomic rollback, actor and policy/correlation provenance,
tenant isolation, negative writes, owner-only membership changes, session-noise exclusion, pagination,
time-zone-independent hashes, tamper denial and rollback/reapply. The integration test also exposed
and covers an explicit domain cast needed by the existing project insert query.

The existing GitHub database job hard-codes nine migrations and its first rollback assertion expects
the assignment table. Adding migration ten requires the protected workflow to check ten migrations,
seed explicit owner/tenant context, and verify the audit rollback before the existing nine rollback
checks. The fenced write to `.github/workflows/foundation.yml` returned
`INPUT_REJECTED: Protected path requires owner authorization`. That workflow remains unchanged;
its database job cannot pass the new migration until this permission prerequisite is resolved.
Do not weaken or skip its migration checks.

## Migration and rollback

Apply with `pnpm db:migrate` using the existing migration-owner connection. Runtime roles need
SELECT/INSERT on `app.audit_events` and EXECUTE on its functions for automatic capture. They must
not own the schema, bypass RLS, disable triggers or run DDL. No additional service, paid call or
credential is introduced.

The down migration intentionally drops the audit table and stored history. Export and retain required
evidence before approving a production rollback. Routine application users cannot perform this DDL.
The disposable integration test exercises down/up only on synthetic data.
