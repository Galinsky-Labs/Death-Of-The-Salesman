# Encrypted credential references (DOTS-041)

Server-only integration credentials are scoped to tenant, provider, credential kind,
UUID and current version. Public method results and lists contain only this reference
and revocation state. There is no plaintext GET method or public credential HTTP route.
This unit configures no live provider, KMS, production key, service or paid operation.

`CredentialReferenceRepository` requires current owner membership on every operation
and a fresh, server-verified MFA timestamp (at most 15 minutes old, never future).
Only the authenticated server adapter may construct this context from a verified
session. Browser/model-supplied actor, tenant or MFA fields are not authority.
Admin, sales-manager and agent access is not granted by this repository.

## Ciphertext and rotation

The maintained Node/OpenSSL AES-256-GCM implementation uses random 96-bit nonces,
128-bit tags and a 32-byte injected key. Authenticated additional data binds schema
version, tenant, reference UUID, provider, credential kind, credential version and
nonsecret key ID. Substituting ciphertext or any binding fails authentication.
Secret values are bounded to 16 KiB and never converted to strings by this code.
No digest of plaintext is persisted. Temporary plaintext and copied key buffers are
zeroed after use; JavaScript/process memory and a trusted consuming adapter remain
explicit trust boundaries, not a hardware memory-erasure guarantee.

The key-provider port must use an approved secret manager in production. It returns
an active nonsecret key ID/key pair and resolves retained key IDs. Keys must never
be stored in repository files, database rows, browser requests, logs or environment
examples. Tests generate synthetic random bytes locally. No insecure default key
or fallback exists. Key-provider and database errors become redacted generic errors.

Creation and rotation commit metadata, encrypted version and audit together. Rotation
uses an exact expected version and advances it atomically; concurrent/stale rotations
fail. The active key provider can change key IDs between rotations. Older immutable
versions remain retained as ciphertext; current-use queries reject old references.
Revocation is irreversible and prevents subsequent uses and rotations. The consuming
callback receives temporary bytes only after a fresh database check. A share lock
serializes rotation/revocation behind already authorized in-flight uses: it cannot
undo provider activity already in progress. Keep callbacks bounded, honor cancellation,
and never open nested transactions or return/serialize/log the borrowed bytes.
This port alone does not authorize paid calls, network destinations or outbound sends.
Those remain subject to their independent provider/policy/budget gates.

## Storage, audit and verification

Migration 0013 enforces tenant/provider identity, current-version
foreign keys, append-only ciphertext versions, owner-bound writes and irreversible
revocation. Forced RLS isolates metadata and ciphertext rows. Existing audit capture
records credential metadata changes, not ciphertext, key bytes or plaintext values.
The metadata references a current encrypted version through a deferred constraint,
so partial rotations roll back. Use a checked-out connection per transaction.

Eleven portable tests pass for authenticated encryption, tamper/binding failures,
key rotation, unauthorized key access, redacted failures, plaintext cleanup,
revocation/stale-version predicates, MFA freshness and transaction behavior.
They use native TypeScript erasure; no TypeScript or SQL pass is claimed from that.
The PGlite integration test covers actual migrations, encrypted-only storage, tenant/
provider isolation, owner/admin denial, rotation, revocation, audit redaction,
metadata/version rollback, owner deactivation and migration down/up. Actual CI must
verify it. Locked local dependency installation failed PGlite package metadata;
no lockfile or supply-chain policy was weakened.

The protected database workflow needs its migration count and rollback assertions
updated for this branch's new migration before audit rollback. Do not skip checks.
The down migration destroys credential ciphertext/history; export and retain required
evidence before an approved production rollback. Runtime roles must not own schema,
bypass RLS, disable triggers or execute DDL. Deployment key provisioning, refresh-token
provider flows, hosted infrastructure and live operational acceptance remain separate.
