# Revenue operations (F11: DOTS-135 to DOTS-144)

This track adds owner-controlled pricing and quotes, payment-processor reconciliation, subscriptions and
retention evidence, delegated calendar scheduling, CRM import/export, a public lead form, a client portal
and cohort profitability reporting. Everything defaults to **$0 spend, no real outbound, no live charges**.

Code: `packages/operations/src/revenue.ts` (`RevenueOperations` plus pure helpers), the `PaymentGateway`
class in `packages/operations/src/integrations.ts`, migration `database/migrations/0022_revenue_operations`,
runtime grants `database/runtime-grants-0022.sql`, owner API `apps/web/app/api/v1/revenue/route.ts`, public
lead endpoint `apps/web/app/api/public/lead/route.ts`, client portal `apps/web/app/portal/[token]/page.tsx`,
owner UI `apps/web/app/views/revenue-view.tsx` (navigation label **Revenue**), tests `tests/revenue.test.mjs`
and the acceptance gate `scripts/payment-acceptance.mjs`.

## Units and acceptance criteria

| Unit | What exists | Acceptance evidence (tests/revenue.test.mjs) | Status |
| --- | --- | --- | --- |
| DOTS-135 pricing and quotes | Price books with immutable revisions (`price_book_revisions` append-only); each new revision must be approved with an owner pricing authorization reference before quoting. Quotes copy the current approved price, freeze pricing evidence (trigger) and expire. Any discount must be within the revision's policy and creates an `action_approvals` row of kind `quotation` scoped to that exact quote, revision, discount and total; it is consumed when the owner records delivery. Delivery and acceptance are owner-attested records; the app never emails quotes. Acceptance without an owner contract authorization reference is non-binding and cannot become an invoice. | "DOTS-135 …" | Implemented |
| DOTS-136 payment connector | Opt-in Stripe Checkout through `fetch` with an injectable transport (no SDK). Requires `PAYMENTS_ENABLED`, a key, `OWNER_MERCHANT_AUTHORIZATION_ID`, `APP_ORIGIN` and `MAX_PAYMENT_CENTS`. Test-mode keys work. Live requires `PRODUCTION_PAYMENTS_AUTHORIZATION_ID`, `PAYMENTS_LIVE_MODE=true`, a restricted `rk_live_` key and `STRIPE_WEBHOOK_SECRET`. A checkout response whose `livemode` disagrees with the key is rejected. Webhooks are HMAC-verified (`verifyWebhook`) before any processing. | "DOTS-136 …" plus existing product-workflows and free-integrations tests | Implemented; live use blocked on external prerequisite |
| DOTS-137 payments, refunds, disputes, subscriptions | `ingestStripe` reconciles `payment_intent.succeeded` (optional expanded `latest_charge.balance_transaction.fee`), `charge.refunded` (cumulative, exactly-once), `charge.dispute.created`/`closed` (hold, fee, reversal when won), `invoice.paid` (subscription receipts, renewals, trial conversion), `invoice.payment_failed` (past due) and `customer.subscription.deleted`. Ledger kinds `processor_fee`, `dispute_hold`, `dispute_reversal`, `subscription_receipt` were added to the append-only `money_entries`. Live events are `provider` source; test events are `simulation` and reported separately. | "DOTS-137 …" | Implemented |
| DOTS-138 renewals and retention | `revenue_subscriptions`, onboarding checklist, service escalations and append-only `retention_events`. Support ownership: only the assigned support-owner agent may act; the owner must be assigned to the project. Renewal queue flags suppressed contacts and never sends outreach. Trial conversion requires a recorded processor receipt. Metrics count only evidenced retention events and provider-verified receipts. | "DOTS-138 …" | Implemented |
| DOTS-139 calendar | `CalendarAdapter` interface, `LocalIcsCalendarAdapter` (RFC 5545 ICS with escaping and 75-octet folding; no provider calls) and fail-closed `UnavailableCalendarAdapter` for Google/Microsoft/CalDAV. Every read/create/update/cancel needs an unexpired, unrevoked delegation for that agent and calendar with the matching scope; agents can only change their own meetings; availability returns busy windows without subjects. | "DOTS-139 …" | Implemented (local ICS). External calendar providers: blocked on external prerequisite |
| DOTS-140 CRM sync | Scoped CSV/JSON export with stable IDs `dots-<kind>-<uuid>`, CSV formula-injection neutralisation and do-not-contact flags. Import links `(tenant, system, kind, external id)` so re-imports never duplicate, matches contacts by email hash, never imports consent/status/email changes, and keeps app-owned fields while logging conflicts unless the owner marks a field as externally owned. | "DOTS-140 …" (two tenants) | Implemented (file/API based). Live third-party CRM API sync: blocked on external prerequisite |
| DOTS-141 website lead form | Public `GET/POST /api/public/lead` (no owner session). Per-form key (only its hash stored), honeypot field `website`, HMAC-signed single-use nonce with 2 s minimum and 2 h maximum age, nonce replay table, per-IP-hash daily rate limit, optional allowed origin, required consent checkbox with text hash and version, provenance (form, origin, page path, hashed user agent) and retention date. New contacts are created with consent `unknown` and consent evidence pointing to the submission; no message, task, outbox event or campaign audience row is created. Responses are identical for new and existing contacts. | "DOTS-141 …" | Implemented |
| DOTS-142 client portal | Owner creates a link for one account (`pl_<id>.<secret>`, hash stored, at most 30 days, revocable, view count). `/portal/<token>` shows only that account's issued invoices, processor payment status (sandbox labelled), quotes/contract evidence hashes, subscriptions and meetings. It never loads messages, notes, authorization references, internal IDs or other accounts. | "DOTS-142 …" | Implemented |
| DOTS-143 cohort reporting | Cohort = project and month of a customer's first provider-verified receipt. Net revenue = receipts − refunds − dispute holds + reversals − fees. Provider-settled spend is allocated to the same project/month and split into channel (message reservations), model (other reservations) and other. Reports CAC, net margin, touchpoint coverage with low/medium/high uncertainty, unattributed revenue, unallocated spend and a reconciliation that must equal the ledger. | "DOTS-143 …" | Implemented |
| DOTS-144 acceptance gate | `scripts/payment-acceptance.mjs` prints the checklist, refuses to run without `PAYMENT_ACCEPTANCE_ENABLED=true`, runs eight synthetic offline checks, offers a test-mode-only sandbox probe, and refuses live mode unless every owner gate is present plus `--confirm=<PRODUCTION_PAYMENTS_AUTHORIZATION_ID>`. It never creates a charge or refund. | "DOTS-144 …" | Scripted gate implemented; live run **blocked on external prerequisite** |

## Environment variables (names only)

Payments: `PAYMENTS_ENABLED`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `OWNER_MERCHANT_AUTHORIZATION_ID`,
`MAX_PAYMENT_CENTS`, `APP_ORIGIN`, `PRODUCTION_PAYMENTS_AUTHORIZATION_ID`, `PAYMENTS_LIVE_MODE`,
`PAYMENT_ACCEPTANCE_ENABLED`, `PAYMENT_ACCEPTANCE_MAX_CENTS`.
Lead form: `LEAD_FORM_SIGNING_KEY` (at least 32 characters; signs nonces and keys IP hashes).
Calendars: `CALENDAR_PROVIDERS_ENABLED` plus the credential variable named on each external connection.
Single-tenant routing for public routes: `OWNER_ORGANIZATION_ID`, `OWNER_MEMBERSHIP_ID` (already required).

## Operator steps

1. Apply migrations through `0022`, then `database/runtime-grants.sql` and `database/runtime-grants-0022.sql`
   as the migration administrator.
2. Pricing: create a price book, add a revision, approve it with your pricing authorization reference. Approve
   any discounted quote in the quote table before recording delivery.
3. Deliver quotes yourself (PDF or a portal link) and record delivery; record acceptance evidence and, only for a
   contract you have authorized, the binding authorization reference. Then create the draft invoice and issue it.
4. Lead form: set `LEAD_FORM_SIGNING_KEY`, create a form, copy the one-time form key and embed a form that first
   `GET`s `/api/public/lead?form=<key>`, shows the returned consent text, then `POST`s `form`, `nonce`, `name`,
   `email`, `message`, `consent`, `consentVersion` and an empty hidden `website` field. Confirm each new contact's
   email before changing consent; submissions never start outreach. Run "Purge expired submission messages" periodically.
5. Portal: create a link for an account, send it yourself, revoke it when no longer needed.
6. Payments sandbox: run `PAYMENT_ACCEPTANCE_ENABLED=true node scripts/payment-acceptance.mjs --mode=offline`.

## Blocked on external prerequisite

- **Live payments (DOTS-136/137/144).** Requires the owner to open a separate Stripe account for this product,
  complete processor onboarding, create a restricted live key limited to Checkout Sessions (write), register the
  production webhook endpoint `https://<APP_ORIGIN host>/api/webhooks/stripe` for the events listed above, record
  `OWNER_MERCHANT_AUTHORIZATION_ID` and `PRODUCTION_PAYMENTS_AUTHORIZATION_ID`, choose `MAX_PAYMENT_CENTS` and
  `PAYMENT_ACCEPTANCE_MAX_CENTS` (50–500), and give explicit permission to run one real payment and refund. Then
  follow the ten-step checklist printed by `scripts/payment-acceptance.mjs`, recording evidence in `docs/evidence/`.
- **External calendars (DOTS-139).** Requires an owner-approved Google/Microsoft/CalDAV OAuth application, a
  reviewed provider adapter and per-user consent. Until then only local ICS files are produced.
- **Third-party CRM API sync (DOTS-140).** Requires the owner's CRM account and API credentials; the current
  import/export works with files and JSON payloads only.

## Migration and rollback

`0022_revenue_operations.down.sql` drops the new tables and restores the original `money_entries.kind` check. It
**refuses to run** while any processor fee, dispute or subscription ledger rows exist, so verified financial
evidence is never silently discarded; export the ledger and obtain owner sign-off first.

## Security and spend notes

- No new paid service, dependency or network call in CI. Tests inject transports and clocks.
- Secrets are referenced by environment variable name only; form keys and portal tokens are stored as SHA-256
  hashes; IP addresses are stored only as keyed HMACs.
- All new tables have forced row-level security and compound tenant foreign keys; evidence tables are append-only.
- The owner API requires an owner session (and a trusted origin for POST). The public lead endpoint and portal page
  use no owner session and return only generic codes.
