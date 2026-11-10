# Operations workspace

The owner console persists work in Neon and runs bounded queue batches inside the
Render web service. It includes CRM, campaigns and audience rehearsals, pipeline,
conversations and exact-content approvals, strategy experiments, distinct investment
and grant workflows, invoices, encrypted documents, catalog facts, budgets and an
append-only activity history. Public grant discovery queries the official Grants.gov
API; the owner must review eligibility and deadlines at the linked notice.

## Start work

1. Sign in with the configured verified owner email.
2. Create a project, activate an approved agent identity and assign it to the project.
3. Add an offer and sourced, expiring facts in Catalog. Configure the agent's role,
   strategy and optional provider in Settings.
4. Resume the queue and create a simulation task. Its result is explicitly labeled
   SIMULATION; it proves queue/checkpoint persistence and incurs no inference spend.
5. Add contacts with source and consent evidence. Campaign rehearsal reports eligibility
   without sending. Prepare individual messages and review their exact approval snapshots.

Agents show working only with a live server lease and heartbeat. Lost leases quarantine
work; uncertain paid requests or deliveries require reconciliation rather than automatic
resubmission. Normal failed/waiting tasks can be retried from the queue. Cancellation
invalidates the lease; a request already accepted by an external provider cannot be unsent.

## Deployment and data

Apply migrations 0011–0013 after 0010 with the administrative migration credential.
Apply `database/runtime-grants.sql` to the existing restricted `dots_runtime` role.
The web/worker receive only the restricted `DATABASE_URL`; never give them the
administrative migration URL. All operational tables enforce tenant RLS. Runtime grants
exclude primary-key changes, evidence mutation, schema management and financial deletion.
Migration rollback drops the added features and their data; export and retention review
are required before considering rollback on a real workspace. Prefer rolling back code
while retaining the additive schema.

Environment updates can initiate a Render deployment even when Git auto-deploy is off.
Check the deploy list after updating variables before triggering another deployment.

Set `JOB_WORKER_ENABLED=true`. The process starts a bounded child worker at startup,
on queue wakeups, and once per minute while the service is running. Render's free web
service can sleep: scheduled work is delayed while asleep. An always-on worker requires
a separately funded deployment. This release does not promise continuous unattended work
on the free plan.

Documents require a stable, private `DOCUMENT_ENCRYPTION_KEY` containing 32 random bytes
as base64. Back up this key securely; replacing it makes existing documents unreadable.
The vault supports text, Markdown and JSON up to 1 MB, not arbitrary binary attachments.
Set a separate private `UNSUBSCRIBE_SIGNING_KEY` before enabling email. Private workspace
exports contain owner data; preserve them outside the public repository.

## Connect providers

Start with [free integrations and account setup](FREE_AND_PAID_INTEGRATIONS.md).
The free-only OpenRouter path and a confirmed Resend free account can operate within
the zero-dollar cap; paid paths retain the funded-authorization requirement.

All paid and outbound execution remains disabled at deployment, with a zero hard cap.
The owner must supply credentials, explicit funded caps and applicable business authority
before activation. Configure secrets through Render, never through a public document.

- Models: `MODEL_API_ENABLED`, `OWNER_SPEND_AUTHORIZATION_ID`, `PAID_SPEND_LIMIT_CENTS`,
  plus the selected adapter's token/model/input/output pricing configuration. See
  `packages/operations/src/providers.ts` for exact names. OpenAI, Claude and Grok have
  fixed HTTPS adapters; MiMo, GLM and Kimi require an explicit HTTPS endpoint and model.
  Confirm current provider pricing and enforce account-side limits before activation.
  Set both the workspace model toggle and its global/project budgets within the hard cap.
- Email: `EMAIL_DELIVERY_ENABLED`, `EMAIL_DELIVERY_TOKEN` (Resend),
  `OUTREACH_POLICY_AUTHORIZATION_ID`, `SENDER_VERIFICATION_REFERENCE`,
  `EMAIL_COST_CENTS`, `EMAIL_ALLOWED_JURISDICTIONS`, `OUTREACH_TIMEZONE`, and signing key.
  Register a sender and verify its domain against Resend from Settings. Provide a real
  business address. Enable the workspace policy, approve the campaign revision, approve
  exact message content and verified facts, then explicitly dispatch each message.
  Suppression, consent, cadence, business hours, sender, limits and budgets are rechecked.
  `EMAIL_WEBHOOK_SECRET` verifies delivery/bounce/complaint receipts at
  `/api/webhooks/resend`. `EMAIL_RECEIVING_ENABLED=true` enables verified inbound retrieval
  using that same provider account; receiving a message never grants marketing consent.
- Payments: `PAYMENTS_ENABLED`, `STRIPE_SECRET_KEY`, `OWNER_MERCHANT_AUTHORIZATION_ID`,
  `MAX_PAYMENT_CENTS`, `STRIPE_WEBHOOK_SECRET`, and `PRODUCTION_PAYMENTS_AUTHORIZATION_ID`
  for live mode. Issue an invoice before checkout. Signed Stripe receipts reconcile
  exact invoice amounts and refunds idempotently. Initiate refunds in Stripe; this
  console reconciles their signed receipts. Test-mode receipts are clearly sandbox
  entries and never count as verified production revenue.

Investor submissions and grant applications are owner-managed, distinct records with
checklists and explicit authority gates. The product does not submit an application or
investment solicitation automatically. Manually entered funding receipts remain owner
attestations, separate from provider-verified sales. No funding success is fabricated.

## Evidence and limits

The automated suite uses disposable databases and mocked paid providers. Separate staging
acceptance uses a genuine provider-signed session for a synthetic staging identity and the
restricted application database role. It does not prove access to the owner's real mailbox.
The full roadmap remains tracked independently in `registry/prs.json`; release coverage
must not be represented as completion of every roadmap acceptance gate.
