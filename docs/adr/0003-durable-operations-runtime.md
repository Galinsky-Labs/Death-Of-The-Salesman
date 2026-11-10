# 0003 — Durable owner operations runtime

Status: accepted for this release.

The owner console now uses dedicated RLS-protected Postgres domains for work, CRM,
campaigns, conversations, approvals, budgets, funding, invoices and encrypted documents.
A small typed operations package owns deterministic server-side policy checks; the UI
calls explicit authenticated operations rather than allowing arbitrary database writes.

A child worker executes bounded batches beside the existing free Render web service.
Claims use row locks, a per-agent advisory lock, fencing tokens and expiring leases.
Checkpoints and final results survive process loss. Lost leases and uncertain paid calls
are quarantined. This avoids provisioning another paid service but inherits free-service
sleep. Continuous execution is a separately funded operational prerequisite.

Provider adapters have distinct request and response handling. Simulations are explicitly
labeled and never represented as inference, real delivery or verified cash. Live activation
requires environment authority, configured prices and funded budgets. Signed Stripe test
receipts remain simulation ledger entries. Owner funding attestations remain separate.

Exact-content approvals persist immutable proposals and bind policy versions; message
approvals also bind campaign revisions and the verified-fact snapshot. The runtime has
column-level update permissions and no deletion privileges for financial/audit evidence.
Document contents use AES-256-GCM with an external deployment key. Credentials and key
material are never included in owner exports or public release evidence.
