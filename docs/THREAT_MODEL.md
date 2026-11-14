# End-to-end threat model and authorization audit (DOTS-145)

This is the reviewed threat model for the deployed owner workspace. Each threat lists its control and the
automated test that proves the control fails closed. Controls are code and database constraints, not prompts.

| # | Threat | Primary controls | Automated evidence |
|---|---|---|---|
| T1 | Cross-tenant data access | Forced Postgres RLS on every tenant table, transaction-local `app.organization_id`, restricted `dots_runtime` role without `BYPASSRLS`, compound tenant foreign keys | `tests/runtime-privileges.test.mjs`, `tests/platform.test.mjs` (new tenant isolation), CI `database` job |
| T2 | Forged browser mutation (CSRF) | Exact `Origin` match against `APP_ORIGIN`, JSON-only bodies, owner session on every mutation | `tests/request-origin.test.mjs`, `scripts/smoke.mjs` cross-origin probe |
| T3 | Unauthorized owner access | Neon Auth email OTP restricted to `OWNER_EMAIL`, verified email, live active owner membership on every transaction | `tests/auth.test.mjs`, smoke anonymous probes |
| T4 | Forged or replayed webhooks | HMAC (Stripe) and Svix signatures, 300-second replay window, unique `(organization, provider, event_id)` receipts, payload-hash conflict detection | `tests/product-workflows.test.mjs`, `tests/free-integrations.test.mjs`, communications tests |
| T5 | SSRF / data exfiltration through integrations | Fixed provider endpoints only, `redirect:'error'`, `assertAllowedOutbound` allowlist, source scan that rejects caller-controlled transport URLs | `tests/platform.test.mjs` (SSRF guard and source scan) |
| T6 | Prompt injection via inbound email, websites or briefs | Untrusted text is passed as data; models cannot call tools, approve, send, change budgets or read credentials; typed tool broker allowlist | runtime/tool-broker tests, `tests/control-plane.test.mjs` |
| T7 | Model output executed or published | Generated output is untrusted, quarantined by content type; no execution path exists | models track output-isolation tests |
| T8 | Duplicate or unauthorized outbound send | Exact-hash single-use approvals bound to policy version, pause-all, provider idempotency keys, ambiguity quarantine instead of resend | `tests/control-plane.test.mjs`, communications tests, pause-all drill |
| T9 | Overspending | $0 default hard cap, atomic reservations under advisory locks, settlement cannot exceed reservation | `tests/control-plane.test.mjs`, governance tests |
| T10 | XSS from inbound HTML or stored content | React escaping, plain-text bodies, sanitizer allowlist for templates, documents downloaded as attachments with `nosniff` | campaign template sanitizer tests |
| T11 | CSV/spreadsheet formula injection in exports | Export cells prefixed when starting with `= + - @` or control characters | `apps/web/app/api/export/route.ts` |
| T12 | Credential leakage | Secrets only in Render/Neon secret stores; encrypted credential references; portfolio tokens stored as SHA-256 hashes; secret scan in CI; redacting logger | `tests/security-tools.test.mjs`, governance tests, `tests/platform.test.mjs` |
| T13 | Audit tampering | Append-only triggers on audit, operation, money, checkpoint, receipt and incident evidence; hash-chained audit entries verified on restore | `tests/audit-events.test.mjs`, `docs/evidence/backup-restore-drill.json` |
| T14 | Supply chain | Frozen lockfile, `pnpm audit --audit-level high` in CI, no provider SDKs, no model weights in Git | CI `verify` job, `tests/workspace.test.mjs` |
| T15 | Abuse of public endpoints | Public lead form uses form keys, honeypot, signed nonce, rate limits and never triggers outreach; portfolio API is read-only, bearer-token, aggregate-only | revenue track tests, `tests/platform.test.mjs` |
| T16 | Disallowed model lineage or arbitrary inference host | Provider/model allowlist, blocked lineage patterns, no endpoint overrides, no silent fallback | `tests/control-plane.test.mjs`, models tests |

## Trust boundaries

1. Browser → Next.js route handlers (session + origin + JSON validation).
2. Route handlers → Postgres as `dots_runtime` with tenant context (RLS).
3. Worker → providers through fixed HTTPS endpoints, after budget reservation and policy checks.
4. Providers → webhooks (signature + replay window + idempotent receipts).
5. Boardroom/Engine Room → `/api/v1/portfolio` (read-only bearer token, aggregates only).

True end-to-end encryption is not offered for third-party email or hosted inference. Free inference
providers may retain prompts; only public, non-personal material may be sent to them.

## Review cadence

Re-run this review when adding an integration, a public endpoint, a new table, or a new model provider.
Record findings as incidents of kind `security` in the Operations health view.
