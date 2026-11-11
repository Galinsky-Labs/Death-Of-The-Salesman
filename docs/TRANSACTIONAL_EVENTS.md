# Transactional outbox and idempotent intake (DOTS-031)

This is a server-only foundation. No delivery daemon, public webhook, provider call,
paid operation or outbound solicitation is enabled. The existing audit mutation
capture now inserts an immutable outbox envelope in the same PostgreSQL transaction.
A failed business transaction therefore retains neither its audit nor its event;
a committed event survives an application restart. Existing pre-migration audit
history is not silently backfilled into a dispatch queue.

Envelopes contain version, event/audit UUID, tenant, event type, correlation ID,
audit digest and exact UTC timestamp. They contain no raw content, contacts,
credentials, session hashes or message bodies. Database checks bind inserts to
actual audit capture; envelope rewrites and deletion/truncation are denied.

## Delivery and recovery

`TransactionalEventRepository.claim` rechecks current same-tenant owner/admin
membership, locks a bounded batch with `FOR UPDATE SKIP LOCKED`, and issues a
random claim token with a database-clock lease. The token is required to acknowledge
or defer delivery. Expired claims can be recovered; stale tokens cannot acknowledge
a newer attempt. Confirmed deliveries are immutable. Retry delay is bounded to one
hour, batches to 100 and leases to five minutes. Use one checked-out connection per
repository transaction, never concurrent transactions on a shared connection.

`relayOutboxBatch` calls an explicitly supplied trusted transport outside the database
transaction, and records an acknowledgement only after transport confirmation.
It never retries an ambiguous send inline. A crash after remote commit but before
acknowledgement causes **at-least-once delivery**, with the same stable event ID.
The receiver must deduplicate before applying effects. Exactly-once arbitrary
external side effects are not promised. No transport is configured in this unit.
Later worker/scheduler units own process lifecycle, monitoring and authorization.

## Intake and exactly-once database effects

After a provider-specific adapter verifies signature, audience, age and source,
it may call `apply` with trusted tenant/actor context, a consumer/source/external
ID and bounded reference metadata. Browser or model claims cannot create this
capability. There is no public route or signature-verification bypass here.

The receipt key is `(tenant, consumer, source, external event ID)`. A canonical
request hash binds normalized type/reference metadata, independent of property
ordering. The receipt insert and the handler's database effects commit together.
A duplicate identical receipt returns replay without running the handler; changed
content on the same key fails. PostgreSQL's unique conflict handling serializes
concurrent duplicate inserts. Handler failure rolls back the receipt, effects,
audit and new outbox rows, allowing a later safe retry. An unknown commit is not
automatically retried by this repository.

Handlers must use the provided transaction for database work and enqueue external
intent through audited mutations. They must not perform network I/O or open nested
transactions: external effects cannot be rolled back. The reference schema admits
only record UUID/type, exact version string, machine status and an evidence digest;
raw webhook bodies are neither persisted nor logged.

## Tests and limitations

Ten portable Node tests currently pass for normalization, hash stability, atomic
transaction protocol, duplicate/conflicting IDs, authorization, unknown commits,
claim bounds, stale acknowledgements and unconfirmed relay results. They use native
TypeScript erasure, not a full typecheck. The committed PGlite integration test
exercises actual migrations, business/audit/outbox rollback, lease expiration and
recovery, receipt replay after lost confirmation, failed-handler retry, tenant
isolation, tamper denial and destructive down/up on synthetic data. It still needs
execution in an environment with the locked dependencies; no SQL pass is claimed.

Both locked offline and ordinary installs failed on PGlite package metadata. No
lockfile or supply-chain check was weakened. Actual current-head CI is required.
The database workflow must count the new migration and roll back this unit before
its audit rollback; protected workflow edits require the fenced gateway's approval.

Migration 0012 reserves 0011 for the independent money ledger. Runtime roles require
SELECT/INSERT/UPDATE on the outbox, SELECT/INSERT on receipts, and existing audit
permissions; they must not own schema, bypass RLS, disable triggers or execute DDL.
The down migration destroys pending/history records: export and retain required
evidence before any production rollback. No live accounts or resources were used.
