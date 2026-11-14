# Governance control plane (phase F3)

Units: DOTS-032, DOTS-033, DOTS-034, DOTS-035, DOTS-036, DOTS-037, DOTS-038, DOTS-039 (retry backoff and dead-letter parts), DOTS-041, DOTS-042, DOTS-043; extends the DOTS-031 outbox with a publisher.

| Piece | Location |
| --- | --- |
| Migration | `database/migrations/0014_governance_control_plane.{up,down}.sql` |
| Runtime grants | `database/runtime-grants-0014.sql` (apply after `database/runtime-grants.sql`) |
| Domain module | `packages/operations/src/governance.ts` |
| HTTP API | `apps/web/app/api/v1/governance/route.ts` |
| UI | `apps/web/app/views/governance-view.tsx` (`GovernanceView`, nav labels **Budget**, **Approvals**, **Safety** via `section` prop) |
| Tests | `tests/governance.test.mjs` |

## Budget ledger and spending policies (DOTS-032, 033, 034, 035)

- **Money is integer USD cents.** Every balance comes from `app.budget_ledger_entries`, which is append-only. Entries are grouped into `app.budget_journals`. A deferred constraint trigger rejects any journal whose entries do not sum to zero when the transaction commits.
- **Accounts:** `owner_funding` (the contra account), `scope` (one per tenant/project/campaign allocation), `reserved` (per reservation) and `spent` (per reservation).
  - Funding: `owner_funding −x / tenant +x`.
  - Transfer: `scope A −x / scope B +x`.
  - Reserve: `scope −est / reserved +est`.
  - Settle: `reserved −est / spent +actual / scope +(est−actual)`.
  - Release: `reserved −est / scope +est`.
- **Reconciliation invariant**, reported by `budgetSummary().reconciled`: funded = unreserved + reserved + spent. It also requires zero unbalanced journals, holds that match open reservations, and spent that matches settled actuals.
- **Scopes** (`app.budget_scopes`):
  - `tenant`, `project` and `campaign` are allocation scopes. Their total is the ledger allocation, which only ledger transfers can change.
  - `provider`, `model` and `channel` (`email|model|payment|webhook`) are cross-cutting scopes with an explicit `ceiling_cents`. A new scope defaults to $0.
  - Any scope may have a `daily_limit_cents` and a soft `alert_threshold_bps`.
- **Most-restrictive precedence:** `GovernedBudget.reserve()` runs one transaction under an organization advisory lock with `FOR UPDATE` on every applicable scope. In that transaction it checks:
  - the kill switches;
  - the deepest funded allocation scope (campaign, then project, then tenant), which must have enough unreserved balance;
  - every total and daily ceiling;
  - then it writes the hold.

  A refusal throws `GovernanceBlockedError` with code `BUDGET_EXCEEDED` and a stable `ruleId`, for example `spend.tenant.total`, `spend.campaign.total`, `spend.provider.total` or `spend.model.daily`.
- **Default $0:** the tenant pool starts unfunded, so every paid reservation (amount greater than 0) is refused, whatever the browser or agent asks. Zero-cost reservations still pass the kill-switch checks.
- **Funding** needs a non-empty owner authorization reference (`OWNER_SPEND_AUTHORIZATION_ID`). Total funding must stay at or below the deployment hard cap (`PAID_SPEND_LIMIT_CENTS`).
- **Transfers** are rejected when they exceed the source's unreserved balance, when they target a non-allocation scope, when source and target are the same scope, or when the amount is negative or fractional.
- **Settle, release and timeouts:**
  - `settle()` refuses an actual charge above the estimate. Replaying it with the same actual amount is idempotent. A settlement also writes an `expense` `money_entries` row when actual > 0.
  - `release()` is idempotent.
  - `reconcileExpired()` releases holds whose `expires_at` has passed (the default TTL is 900 s).
- **Concurrency is tested:** 30 concurrent $0.70 reservations against $10.00 yield exactly 14 holds and the ledger reconciles.

## Deterministic policy decisions (DOTS-036)

`decidePolicy(facts)` is a pure function that returns `{decision: 'ALLOW'|'REVIEW'|'DENY', rules:[{id,outcome,reason}], inputHash}`. DENY dominates REVIEW, and REVIEW dominates ALLOW.

The stable rule ids are:
- `permission.owner_role`, `permission.action_kind`, `permission.owner_authority`
- `claims.approved` (each claim must be an active `vetted_product_facts` row)
- `sender.verified` (email only)
- `suppression.clear`, `consent.basis`, `jurisdiction.permitted`
- `spend.capacity`, `runtime.paused`, `kill_switch.clear`, `approval.owner`

How the facts are gathered and stored:
- `PolicyService.evaluateDispatch()` reads every fact from the database and persists the decision to the append-only `app.policy_decisions` with ruleset `governance-2026-11-v1`.
- `agentAssertion` (agent, model or browser text) is never read by any rule. It is excluded from the input hash and is not persisted, so prompt text cannot change a decision.

## Owner Action inbox (DOTS-037)

`app.action_approvals` gains the columns `title`, `content_hash`, `audience_hash`, `audience_count`, `campaign_revision`, `budget_cents`, `sender_identity`, `consequences` and the status `revoked`. The existing immutability trigger freezes all of them once a row is inserted.

- **`OwnerActionInbox.request()`** stores the exact payload and its consequences. It also revokes pending or approved approvals for the same record whose content hash differs.
- **`consumeScopedApproval(tx, ctx, id, scope, dispatch)`** is the integrator hook. It fails closed with one of these codes:
  - `APPROVAL_CONTENT_CHANGED`
  - `APPROVAL_AUDIENCE_MISMATCH` (different or additional recipients)
  - `APPROVAL_REVISION_MISMATCH`
  - `APPROVAL_BUDGET_MISMATCH`
  - `APPROVAL_SENDER_MISMATCH`
  - `APPROVAL_EXPIRED`
  - `APPROVAL_REVOKED`
  - `APPROVAL_POLICY_CHANGED`
  - `APPROVAL_NOT_APPROVED` (also returned on a replay after consumption)

  It also fails on any blocked dispatch (see kill switches). An approval is consumed exactly once.

## Kill switches (DOTS-038)

`KillSwitches.engage/release(scopeKind, scopeKey, rationale)` covers the `organization`, `campaign`, `provider`, `model` and `channel` scopes. Each engage or release writes an append-only `app.kill_switch_audit` row with its rationale.

- **Organization engage** sets `policy_controls.paused`. Queued tasks are parked as `waiting/OWNER_PAUSED`; none are deleted. Releasing the switch is the explicit resume: it unpauses the runtime and requeues the parked tasks.
- **Pausing invalidates approvals:** an organization pause bumps the policy version, so approvals made before it must be re-approved.
- **Scoped switches** leave the queue untouched, and approvals survive them.
- **`assertDispatchAllowed(tx, ctx, {campaignId, projectId, providerId, modelId, channel, estimateCents})`** is the hook the queue, engine and integration owners call right before any external side effect. It takes a shared advisory lock that serializes against `engage()`. It throws `GovernanceBlockedError` with one of:
  - `RUNTIME_PAUSED` / `runtime.paused`
  - `KILL_SWITCH_ACTIVE` / `kill_switch.<scope>`
  - `BUDGET_EXCEEDED` / `spend.*`

## Retries, dead letters and outbox publisher (DOTS-039 partial, DOTS-031)

- `backoffDelayMs(attempt, {baseMs, maxMs, jitterRatio, random})` computes exponential backoff. It is deterministic when jitter is 0.
- `retryOrDeadLetter(tx, ctx, {taskId, reason, fence?})` is the integrator hook for queue failures:
  - It requeues the task with backoff.
  - Once `attempts >= max_attempts`, it moves the task to the new `dead_letter` state and appends a `app.task_dead_letters` row.
  - A fencing token that does not match fails with `LEASE_LOST`.
- `GovernanceService.requeueDeadLetter(taskId, rationale)` is the explicit owner action that requeues a dead-lettered task.
- `OutboxPublisher.publishPending(handler)` delivers events at least once, passing the outbox idempotency key so consumers can deduplicate:
  - Failed deliveries back off.
  - An event that keeps failing is quarantined after `maxAttempts`.
  - `markPublished()` is idempotent.

**Not in this track:** keyed per-tenant claiming, priority and restart persistence. Those stay with the queue owner (`queue.ts`).

## Encrypted credential references (DOTS-041)

- **Storage:** `CredentialStore` encrypts each secret with AES-256-GCM. The key comes from `CREDENTIAL_ENCRYPTION_KEY` (32 bytes, base64url or 64 hex characters). The associated data binds each ciphertext to its tenant, provider and record id, so ciphertext copied to another row fails to decrypt.
- **What is exposed:** the API, list, snapshot and events show metadata only: provider, label, kind, an HMAC fingerprint (16 hex characters), the last 4 characters, status and dates.
- **Rotation** creates a new active row (`replaces_id`) and sets the old ciphertext to NULL (crypto-shredding).
- **Revocation** also sets the ciphertext to NULL.
- **`resolveForUse()`** returns the secret and is for workers only. The HTTP route never calls it.
- **Access control:** another tenant, a non-owner membership or the wrong key all fail closed.

## Privacy-safe logs and metrics (DOTS-042)

- `redactForLog` / `redactText` are pure functions. They redact sensitive keys (token, secret, authorization, email, phone, body, content, …) and secret- or PII-shaped values: PEM blocks, bearer tokens, `sk-`/`sk_live_`-style keys, GitHub tokens, JWTs, emails, phone numbers and long opaque tokens. Entity UUIDs and ISO dates are kept.
- `structuredLogLine` and `createLogger({sink, service, correlationId})` emit JSON lines that carry a correlation id. The log message itself is also redacted.
- `governanceMetrics()` reports queue counts by state, the age of the oldest ready task, outbox status counts, runs and failure reasons, and the top mutations in the last 24 hours.

## Retention, holds, deletion and export (DOTS-043)

- **Retention annotations:** `app.retention_policies` holds one row per record kind. `ensureDefaultRetention()` seeds the documented defaults.
- **`applyRetention()`** redacts archived or suppressed contacts older than the window, unless an evidence hold applies. The suppression hash is kept so opt-outs are still honored.
- **Evidence holds:** `app.evidence_holds` holds contact, campaign or organization holds. Releasing a hold requires a rationale.
- **Deletion requests:** `app.deletion_requests` records each request. Processing parks it as `held` while a hold applies; otherwise it redacts the contact, its notes and its messages, and keeps the suppression.
- **Exports:** `runExport('audit'|'ledger'|'contacts')` is tenant-scoped (verified with a second tenant in the tests). The artifact is returned once; only its hash and row count are stored in `app.export_jobs`.
- **Audit summary:** `auditSummary()` counts approvals, decisions, kill-switch actions and events over the last 30 days.

## HTTP API

The route requires an owner session; POST also requires a trusted origin and a JSON body of at most 64 KB. Responses carry `Cache-Control: private, no-store`. A blocked operation returns `{error, ruleId}`.

**GET `/api/v1/governance`** returns:
```
{ budget:{currency,fundedCents,unallocatedCents,unreservedCents,reservedCents,spentCents,reconciled,unbalancedJournals,scopes[]},
  reservations[], journals[], alerts[], killSwitches[], killSwitchAudit[], runtime, approvals[], decisions[], credentials[] (metadata only),
  deadLetters[], retention[], holds[], deletionRequests[], exports[], projects[], campaigns[], metrics, audit,
  capabilities:{credentialEncryptionConfigured,spendAuthorizationConfigured,hardCapCents}, observedAt }
```

**POST** takes `{action, ...}` and returns `{data: <snapshot>, outcome}`. The actions are:
- `setScopePolicy`, `fund`, `defund`, `transfer`, `releaseReservation`, `reconcileExpired`
- `engageKillSwitch`, `releaseKillSwitch`, `decideApproval`
- `storeCredential`, `rotateCredential`, `revokeCredential`, `requeueDeadLetter`
- `ensureDefaultRetention`, `setRetention`, `applyRetention`
- `placeHold`, `releaseHold`, `requestDeletion`, `processDeletion`, `runExport`

## Environment variables (names only)

- `OWNER_SPEND_AUTHORIZATION_ID`: the owner's spend authorization reference, required before any funding.
- `PAID_SPEND_LIMIT_CENTS`: the deployment hard cap on total funding. The default is 0.
- `CREDENTIAL_ENCRYPTION_KEY`: 32 random bytes, base64url-encoded.

## External prerequisites

- **Blocked on external prerequisite: paid funding.** The owner must approve a funded hard cap. Then set `OWNER_SPEND_AUTHORIZATION_ID` and a positive `PAID_SPEND_LIMIT_CENTS` on the web service. Until then every paid operation stays at $0, which is the intended default.
- **Blocked on external prerequisite: credential storage.** Generate 32 random bytes (for example `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`) and set the result as the secret `CREDENTIAL_ENCRYPTION_KEY` on the web service and worker. Never commit it. Rotating this key requires re-storing every credential.
- **Grants:** apply `database/runtime-grants-0014.sql` with the migration administrator after the migrations run.

## Integration notes for other tracks

- **Separate from the 0011 budget:** the 0011 `spending_policies`/`budget_reservations` path (`ControlPlane.reserve/settle`) still exists and is unchanged. The engine should migrate to `GovernedBudget.reserve/settle/release`. Until it does, the two budgets are independent.
- **Before external dispatch:** call `assertDispatchAllowed`, then `consumeScopedApproval` for owner-gated actions, then `recordDecision`/`gatherDispatchFacts` for per-recipient policy, all in the same transaction as the dispatch record.
- **On a worker failure:** call `retryOrDeadLetter`.
