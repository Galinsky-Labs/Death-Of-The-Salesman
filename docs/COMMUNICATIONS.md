# Unified communications and owner-managed outreach (DOTS-094 – DOTS-109)

Phase F8 adds tenant-scoped mailboxes, canonical email threading, a three-pane Conversation Center,
versioned drafts with exact-message approval, a hardened transport gateway, reconciliation of uncertain
sends, opt-out and sender-health controls, deterministic reply triage, follow-up sequences, human takeover
and attachment scanning. Everything defaults to **off and $0**: no mailbox sends until the owner has saved a
postal profile, connected a mailbox, verified SPF/DKIM/DMARC, granted consent, enabled delivery and approved the
exact message.

## Code map

| Piece | Location |
| --- | --- |
| Domain module | `packages/operations/src/communications.ts` (`CommunicationsWorkspace`, `communicationDispatchChecks`, `communicationsGateway`, pure helpers) |
| Transport gateway | `DeliveryGateway` in `packages/operations/src/integrations.ts` (`beforeDispatch` hook array, `send(id,{actor})`) |
| Schema | `database/migrations/0019_unified_communications.{up,down}.sql` |
| Runtime grants | `database/runtime-grants-0019.sql` (apply after `database/runtime-grants.sql`) |
| API | `apps/web/app/api/v1/communications/route.ts`, `apps/web/app/api/webhooks/[provider]/route.ts`, `apps/web/app/api/unsubscribe/route.ts` |
| UI | `apps/web/app/views/conversation-center-view.tsx` (`ConversationCenterView`, navigation label **Conversations**) |
| Tests | `tests/communications.test.mjs` |
| Canary | `scripts/mailbox-canary.mjs` |

## How it works

### Mailbox onboarding (DOTS-094)
* `connectMailbox` creates a tenant-owned mailbox in status `disabled`. OAuth providers (`gmail`, `microsoft365`)
  require an allow-listed scope set and a **secret reference** (`env:NAME` or `vault:path`) — raw tokens are rejected.
* `DeliveryGateway.verifyMailbox` records SPF/DKIM from the provider's domain verification response;
  `checkDmarc` reads the published `_dmarc` TXT record (free DNS lookup); `recordSenderAuthentication` accepts a
  provider verification response (`{records:[{record,status}]}`). Every check is appended to `mailbox_auth_checks`.
* `grantMailboxConsent` requires the tenant postal profile (`setSenderProfile`) and records who consented and when.
  The mailbox becomes `active` only when consent exists **and** SPF, DKIM and DMARC all pass; a later failing check
  pauses it. A partial unique index makes a consented sender address belong to exactly one tenant (no shared sender).
* `rotateMailboxToken` stores the new reference and rotation time in `mailbox_credential_rotations`; sends are
  blocked when a referenced token is expired or older than `MAILBOX_TOKEN_MAX_AGE_DAYS` (default 90).

### Inbound events, polling and threading (DOTS-095, DOTS-096)
* Webhooks verify signatures before parsing, with a 300-second replay window: Resend uses Svix
  (`EMAIL_WEBHOOK_SECRET`), the generic `mail` provider uses `X-Mail-Signature: t=<unix>,v1=<hex hmac>`
  (`MAIL_WEBHOOK_SECRET`). Event ids land in `provider_receipts`; redelivery returns `duplicate`, a changed payload
  under a known id is rejected (`RECEIPT_CONFLICT`).
* `pollMailbox` takes an injected provider adapter and is bounded by pages, messages and a minimum interval; the
  cursor advances only after a page is imported, with an optimistic version check against concurrent pollers.
* `importInboundMessage` normalizes Message-ID / In-Reply-To / References, CC and provider thread ids. A reply joins
  the referenced conversation only if the sender participated in it (contact, from, to or cc); otherwise a new
  thread plus a `thread_mismatch` reconciliation item is created. Fallbacks: provider thread id, then normalized
  subject within the contact's open threads. Imports are idempotent on provider id and Message-ID. Mail whose
  Authentication-Results fail is stored as `quarantined` and escalated, never shown as a genuine reply.
* Delivery receipts for unknown provider ids are never guessed: they become `unmatched_receipt` items and are applied
  automatically once the owner reconciles the matching send. Statuses never move backwards (a late "accepted" does
  not overwrite "delivered").

### Drafts, approval and dispatch (DOTS-098 – DOTS-101)
* `composeDraft` writes revision 1 to `message_revisions` (append-only) with recipients, CC, headers
  (Message-ID / In-Reply-To / References), variables, source evidence (must exist in the tenant), attachment
  references (must be scanned clean) and expiry (≤30 days). Model-authored text (`saveModelSuggestion`) is labelled
  AI-drafted forever, including after owner edits; it is never auto-approved or sent.
* `preview` returns the exact plain text (including the postal footer), headers, recipients and revision hash.
  `approveExact(id, revisionHash)` approves only that revision. `reviseDraft` creates a new revision, expires the
  previous approval and resets the message to `draft`.
* `DeliveryGateway.send` keeps every pre-existing gate (enablement, policy authorization, $0/free plan or owner spend
  cap, business hours, campaign approval, consent, jurisdiction, suppression, cadence, quotas, vetted facts) and adds:
  human-takeover enforcement (`actor` defaults to `agent`), draft expiry, CC suppression, per-message mailbox
  selection, sender header-injection validation, a fail-closed refusal for attachments (no attachment transport
  yet), and the pluggable `beforeDispatch` hooks, which run inside the dispatch transaction immediately before the
  approval is consumed. `communicationDispatchChecks` adds: postal profile, mailbox consent + SPF/DKIM/DMARC + token
  freshness, exact-revision approval, sequence still active (row lock), and per-mailbox / per-recipient-domain daily
  caps (`MAILBOX_DAILY_SEND_CAP` default 50, `RECIPIENT_DOMAIN_DAILY_CAP` default 20). The integrator can append
  CRM/campaign/governance checks to the same array.
* The provider idempotency key is `<messageId>:<contentHash>`; every attempt is recorded in `dispatch_attempts` with a
  receipt hash. A timeout, network error, 5xx or malformed response marks the message `quarantined`, the attempt
  `uncertain`, and opens an `uncertain_send` reconciliation item; it is never retried automatically. A definite 4xx
  rejection marks it `failed` and releases the budget reservation. `resolveReconciliation` requires written evidence
  (and the provider message id for "sent") and settles or releases the reservation.
* Cadence limits apply to unsolicited touches; an owner reply to a contact who wrote back after our last message is
  exempt.

### Opt-out, sender health and triage (DOTS-102 – DOTS-104)
* Every message carries `List-Unsubscribe: <APP_ORIGIN/api/unsubscribe?token=…>` and
  `List-Unsubscribe-Post: List-Unsubscribe=One-Click`; the route accepts RFC 8058 one-click POSTs and the confirmation
  form. `processOptOut` suppresses the address, cancels pending outbound drafts and sequence steps in the same
  transaction, and appends an `opt_out_records` row.
* Hard bounces and complaints suppress the address. Soft bounces are recorded as delays only. After each bounce or
  complaint the 30-day rates are recomputed per mailbox and campaign; the campaign and mailbox auto-pause at
  `SENDER_BOUNCE_PAUSE_BASIS_POINTS` (default 500 = 5 %) hard bounces or `SENDER_COMPLAINT_PAUSE_BASIS_POINTS`
  (default 30 = 0.3 %) complaints.
* `classifyReply` is deterministic (keyword/regex rules with citations; English, Spanish, French, German, Portuguese,
  Italian, Dutch opt-out phrases). Quoted history and our own footer are stripped first so quoting the unsubscribe
  link is not an opt-out. Labels: interested / not_interested / question / opt_out / ambiguous with a rule
  confidence; ambiguous or low-confidence replies escalate (`needs_owner`, priority, SLA due time). Opt-outs are
  processed immediately without any model.

### Sequences, takeover and attachments (DOTS-105 – DOTS-107)
* Sequences have max touches (≤10), interval days and quiet hours in a time zone. `claimDueSteps` turns due steps into
  drafts that still need exact owner approval; it re-checks suppression, replies, campaign state, takeover, pause and
  quiet hours under row locks. Lock order is messages → enrollment → steps in cancellation, claiming and dispatch,
  so cancel and dispatch serialize: either the touch is cancelled and never sent, or it was already dispatched and the
  cancellation reports it (`alreadyDispatched`).
* `claimThread` gives the owner control, pauses the thread's sequences and blocks agent sends; `delegateThread`
  explicitly allows the agent; `releaseThread` resumes. Threads sort by needs-owner, priority, then SLA due time.
* Attachments: allow-list (PDF, PNG, JPEG, GIF, WebP, plain text, CSV), dangerous extensions rejected, size cap
  (`ATTACHMENT_MAX_BYTES`, max 5 MiB), magic-byte sniffing, declared/sniffed mismatch quarantine, EICAR test string as
  the malware stand-in. Only clean bytes are stored. Downloads require `clean` and use
  `Content-Disposition: attachment`, `nosniff`, a sandbox CSP and `no-store`. `modelContext` is the only view meant for
  model/tool input and excludes quarantined, cancelled and redacted messages and every non-clean attachment.

## API

`GET /api/v1/communications[?conversation=<id>]` (owner session) returns
`{threads, conversation, mailboxes, senderProfile, reconciliation, sequences, optOuts, campaigns, health, capabilities, observedAt}`;
`?attachment=<id>` streams a clean attachment with safe headers.

`POST /api/v1/communications` (trusted origin + owner session, JSON) actions: `setSenderProfile`, `connectMailbox`,
`verifyMailbox`, `checkDmarc`, `grantMailboxConsent`, `revokeMailboxConsent`, `rotateMailboxToken`, `composeDraft`,
`reviseDraft`, `previewDraft`, `approveExact`, `sendMessage`, `claimThread`, `releaseThread`, `delegateThread`,
`setPriority`, `markHandled`, `createSequence`, `setSequenceState`, `enrollSequence`, `claimDueSteps`,
`cancelEnrollment`, `processOptOut`, `uploadAttachment`, `resolveReconciliation`.

## Environment variable names (values never in the repository)

`EMAIL_DELIVERY_ENABLED`, `EMAIL_DELIVERY_TOKEN`, `EMAIL_RECEIVING_ENABLED`, `EMAIL_WEBHOOK_SECRET`,
`MAIL_WEBHOOK_SECRET`, `EMAIL_BILLING_MODE`, `EMAIL_FREE_PLAN_CONFIRMED`, `EMAIL_COST_CENTS`,
`OWNER_SPEND_AUTHORIZATION_ID`, `PAID_SPEND_LIMIT_CENTS`, `OUTREACH_POLICY_AUTHORIZATION_ID`,
`SENDER_VERIFICATION_REFERENCE`, `UNSUBSCRIBE_SIGNING_KEY`, `APP_ORIGIN`, `OWNER_ORGANIZATION_ID`,
`EMAIL_ALLOWED_JURISDICTIONS`, `OUTREACH_TIMEZONE`, `MAILBOX_TOKEN_MAX_AGE_DAYS`, `MAILBOX_DAILY_SEND_CAP`,
`RECIPIENT_DOMAIN_DAILY_CAP`, `SENDER_BOUNCE_PAUSE_BASIS_POINTS`, `SENDER_COMPLAINT_PAUSE_BASIS_POINTS`,
`ATTACHMENT_MAX_BYTES`, and for the canary `MAILBOX_CANARY_ENABLED`, `MAILBOX_CANARY_AUTHORIZATION_ID`,
`MAILBOX_CANARY_SENDER`, `MAILBOX_CANARY_RECIPIENTS`, `MAILBOX_CANARY_ALLOWED_RECIPIENTS`.

## Operator steps

1. Apply migration 0019 (`pnpm db:migrate`) and then `database/runtime-grants-0019.sql` as the migration administrator.
2. Integrator: wire `ConversationCenterView` under the **Conversations** navigation label, and construct the shared
   `repositories().delivery` with `communicationsGateway(...)` (or pass `{beforeDispatch: communicationDispatchChecks}`)
   so the legacy `/api/operations` `sendMessage` path gets the same consent/authentication/profile checks.
3. In Conversations → Sender setup: save the postal profile, connect the mailbox, run "Verify domain" and "Check DMARC",
   then "Grant consent". Configure webhooks: Resend → `/api/webhooks/resend`; other signed sources → `/api/webhooks/mail`.

## External prerequisites — blocked on external prerequisite

* **Real mailbox canary (DOTS-109):** needs an owner-controlled sending domain with SPF, DKIM and DMARC published, a
  Resend (or OAuth mail) account on a $0 plan or with an owner spend cap, a real tenant postal address, 1–5
  owner-controlled test inboxes, `EMAIL_WEBHOOK_SECRET` configured in the provider dashboard, and a written owner
  canary authorization id. Then run `node scripts/mailbox-canary.mjs` (refuses and exits 2 until all of the above are
  set), follow its checklist through the product UI, save the evidence JSON and run
  `node scripts/mailbox-canary.mjs --verify evidence.json`. The script never sends mail itself.
* **OAuth mailbox connection (Gmail / Microsoft 365):** the data model, scopes, token references, rotation and consent
  are implemented; the interactive OAuth consent flow and provider polling adapters need owner-registered OAuth client
  credentials (Google Cloud / Microsoft Entra app registration) and are not built. Until then only the Resend API-key
  path can send.
* **Attachment transport and production malware scanning:** outbound attachments fail closed
  (`ATTACHMENT_TRANSPORT_NOT_CONFIGURED`); the scanner is a deterministic allow-list + magic-byte + EICAR stand-in, not a
  commercial antivirus engine.

## Units and acceptance criteria

| Unit | Status | Evidence |
| --- | --- | --- |
| DOTS-094 | Implemented (OAuth flow blocked on external prerequisite) | disabled-until-consent, auth checks, rotation, no shared sender — test "DOTS-094" |
| DOTS-095 | Implemented | forged/stale signatures, duplicates, conflicts, out-of-order receipts, bounded polling — test "DOTS-095" |
| DOTS-096 | Implemented | header normalization, CC participants, campaign attachment, idempotent imports — test "DOTS-096" |
| DOTS-097 | Implemented | evidence-backed labels, priority sort, three-pane/drilldown view — test "DOTS-097" + build |
| DOTS-098 | Implemented | revisions with evidence/headers/variables/expiry, AI provenance — test "DOTS-098" |
| DOTS-099 | Implemented | exact-revision approval, edit invalidation, stale preview refusal — test "DOTS-099" |
| DOTS-100 | Implemented | idempotency key, sender validation, hooks, policy recheck — test "DOTS-100" |
| DOTS-101 | Implemented | timeout never resends, reconciliation with evidence — test "DOTS-101" |
| DOTS-102 | Implemented | one-click unsubscribe, immediate cancellation, audit, profile required — test "DOTS-102" |
| DOTS-103 | Implemented | suppression, soft vs hard bounce, auto-pause — test "DOTS-103" |
| DOTS-104 | Implemented | deterministic multilingual triage, escalation, model suggestion stays a draft — test "DOTS-104" |
| DOTS-105 | Implemented | max touches, quiet hours, reply/pause/suppression cancellation, cancel-vs-dispatch race — test "DOTS-105" |
| DOTS-106 | Implemented | takeover blocks agent, delegation, release, SLA sort — test "DOTS-106" |
| DOTS-107 | Implemented (production AV engine is a prerequisite) | allow-list, magic bytes, EICAR, safe downloads, model context — test "DOTS-107" |
| DOTS-108 | Implemented | simulated end-to-end loop — test "DOTS-108" |
| DOTS-109 | Script implemented; live run **blocked on external prerequisite** | test "DOTS-109" covers refusal and evidence verification |
