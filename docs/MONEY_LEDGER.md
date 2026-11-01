# Money and invoice ledger foundation (DOTS-032, draft)

This unit is unfinished. The current implementation provides exact integer money, budget accounts,
balanced journals, initial reservation/invoice facts, a tenant-authorized repository and SQL tests.
Invoice/reservation links to their supporting journals and full reconciliation of those facts still
need implementation and tests. Do not mark the unit accepted or enable spending from these records.

## Exact amounts and currencies

All monetary interfaces use canonical decimal **strings of minor units**, converted to `bigint` for
arithmetic. Numbers, floating point, exponent notation, leading zeroes, negative zero and out-of-range
values are rejected. Stored amounts are signed 64-bit integers; aggregate reconciliation uses arbitrary
precision to avoid overflow. Decimal display/input conversion requires an explicit supported currency
and rejects excess fractional digits rather than silently rounding.

The initial allowlist is USD/EUR/GBP (2 minor digits), JPY (0), and KWD (3). Unsupported codes fail
closed. This is an explicit initial product allowlist, not a claim to support every currency or exchange
rates. A journal uses one currency; its account references enforce both currency and tenant identity.

## Journals and access

`LedgerRepository` checks an active same-tenant owner for writes and owner/admin for balance reads.
Account creation, posting, invoice creation and initial reservation creation run inside transactions
on the supplied checked-out connection. Authentication/MFA remain server-adapter responsibilities;
never derive membership or organization authority from model/browser claims.

Each journal has 2–200 nonzero, distinct-account postings whose signed minor units sum exactly to
zero. Deferred database constraints validate the whole journal at commit, including direct SQL. A
posting can only join a journal created in that same database transaction. Later balanced additions
to an already posted journal are denied. Journal/posting/account rewrites and truncation are denied;
corrections require a separate reversing journal. Tenant-scoped idempotency keys return the original
journal only when the canonical request digest matches; changed requests are rejected.

Initial invoice facts enforce nonnegative allocated/incurred/paid values and paid <= incurred.
Reservations start open with a positive amount and a same-tenant/currency account. These facts do
not reserve a spending cap or authorize a charge. Spending policies and atomic reserve/settle/refund
behavior belong to DOTS-033/034. This implementation makes no external calls, starts no worker and
adds no credential or paid resource.

## Verification, migration and remaining work

`tests/ledger.test.mjs` exercises exact conversion above the JavaScript safe-integer boundary,
reconciliation, idempotency conflicts, tenant isolation, database balance-at-commit denial, immutable
accounts/postings, closed-journal append denial and initial invoice/reservation constraints. SQL tests
apply the actual migrations in isolated PGlite, then use a non-superuser RLS role with broad table
grants. They do not establish production concurrency behavior or a deployed financial service.

Migration `0011_money_ledger` leaves version 0010 for the independently developed audit unit. The
migration runner supports gaps. On this branch there are ten migrations; after both units merge
there will be eleven. The protected database workflow currently hard-codes nine, and must be updated
through its approved authorization path, with explicit rollback checks for each new migration.
Do not skip the migration or weaken the workflow to obtain a green check.

The down migration deletes financial history. Retain/export evidence before any approved production
rollback. Runtime roles must not own the schema, bypass RLS, disable triggers or run DDL.

Resume this same branch/PR to implement invoice/reservation journal linkage, prevent reuse or
double-counting of supporting evidence, expose the resulting tenant-scoped read/reconciliation
methods, expand negative and database tests, resolve protected CI integration, and inspect actual
current-head checks. Keep the PR draft until these requirements are implemented.
