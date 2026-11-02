# Retention, export and correction foundation (DOTS-043, incomplete)

This draft implements expiring derived-cache records, finite evidence holds,
tenant-bound privacy request/job schemas and a bounded owner-only project export
snapshot. It enables no public download, background source-record erasure,
correction execution, provider call or paid operation.

Derived caches default to seven days and cannot exceed thirty days; updates cannot
extend their life. The database requires finite expiry and rejects indefinite values.
Owner-invoked cleanup locks bounded batches, excludes active evidence holds and
rechecks holds before deletion. New holds lock the same cache row, are finite and
bounded to one year, and carry a machine reason rather than personal free text.
Truncation cannot bypass cache/hold checks. Cache deletion, holds and requests use
existing transaction-local audit context; audit history stores metadata, not payload.
These are operational defaults for disposable derived data, not legal retention rules.

Privacy deletion/correction/export requests store only same-tenant resource references,
state and bounded reason codes. Request creation verifies target ownership from a
fixed allowlist; arbitrary table names, foreign targets and non-owners are rejected.
Export-job schema stores encrypted artifact references rather than plaintext and
requires finite expiry within seven days. No executor or download route is enabled.

The internal `exportProject` method reads one statement snapshot, explicit tenant
predicates, a maximum of 100 offers and a bounded content budget. It selects only
project/offer document fields; it never queries credentials, sessions or tokens.
The caller must persist the snapshot through the encrypted artifact layer before
any download. The pure builder independently rejects cross-tenant/parent rows,
excess children and oversize documents. This is not yet an end-to-end export job.

Six portable tests pass for finite TTL, tenant export, field selection, authorization,
cleanup query bounds/holds and request validation. Source lint and secret scan pass.
These use native TypeScript erasure, not full typecheck or PostgreSQL execution.
An actual PGlite integration test is committed for migration, hold/expiry cleanup,
tenant export, correction requests, indefinite-retention denial, RLS and rollback;
no SQL pass is claimed. The local environment lacks installed locked PGlite/TypeScript
dependencies; earlier locked installs in this run failed package metadata retrieval.

Remaining implementation: durable encrypted export execution and authorized expiring
downloads; delete/correct request transitions and execution with expected versions;
source/artifact retention annotations and hold integration; atomic export recovery;
full SQL/typecheck/CI verification; scoped protected workflow migration/rollback
integration. Keep this PR draft and resume this same unit. Migration0014 is a
foundation, not completion of DOTS-043. Its destructive down migration is migration-
owner only; retain required audit/evidence before production rollback.
