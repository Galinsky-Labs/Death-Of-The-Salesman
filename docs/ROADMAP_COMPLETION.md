# Roadmap completion record — 2026-11-14

This records the source-level completion of every remaining roadmap unit (DOTS-030 through DOTS-160)
and the exact external prerequisites that still gate live operation. **Source-complete is not
live-accepted:** live acceptance requires the deployment steps and owner-provided accounts listed below.

Validation on the integration branch: `pnpm check` equivalent (lint, typecheck, 278 node tests,
secret scan, production build); migration chain 0001–0023 applied, fully rolled back and re-applied
on PostgreSQL 16; every `database/runtime-grants*.sql` file applied cleanly to a restricted role.

## Phase status

| Phase | Units | Source status | Doc | Tests |
|---|---|---|---|---|
| F3 control plane | 030–043 | Implemented. 039 split with F4 (queue claiming lives in runtime). | [GOVERNANCE.md](GOVERNANCE.md) | `tests/governance.test.mjs` |
| F4 agent runtime | 039, 040, 044–054 | Implemented. $0 simulation executor only; billable executor needs funded cap. | [AGENT_RUNTIME.md](AGENT_RUNTIME.md) | `tests/runtime.test.mjs` |
| F5 models | 055–069 | Implemented against mocks. 069 live smoke **blocked on external prerequisite**. | [MODEL_PROVIDERS.md](MODEL_PROVIDERS.md) | `tests/models.test.mjs` |
| F6 CRM | 070–081 | Implemented. Region policies must be saved before anyone is contactable. | [CRM.md](CRM.md) | `tests/crm.test.mjs` |
| F7 Campaign Studio | 082–093 | Implemented. Domain-reputation feed optional (warning only). | [CAMPAIGN_STUDIO.md](CAMPAIGN_STUDIO.md) | `tests/campaigns.test.mjs` |
| F8 communications | 094–109 | Implemented. OAuth mailbox consent flow and 109 live canary **blocked on external prerequisite**. | [COMMUNICATIONS.md](COMMUNICATIONS.md) | `tests/communications.test.mjs` |
| F9 Strategy Lab | 110–120 | Implemented. Results show "no verified evidence" until real receipts exist. | [STRATEGY_LAB.md](STRATEGY_LAB.md) | `tests/strategy.test.mjs` |
| F10 funding | 121–134 | Implemented. Candid connector needs a paid key (optional). | [FUNDING.md](FUNDING.md) | `tests/funding.test.mjs` |
| F11 revenue | 135–144 | Implemented. Third-party calendar/CRM adapters and 144 live payment run **blocked on external prerequisite**. | [REVENUE_OPERATIONS.md](REVENUE_OPERATIONS.md) | `tests/revenue.test.mjs` |
| F12 production | 145–160 | Implemented: threat model, privacy, indexes, backup/restore drill, IaC, deploy workflow, incidents, admission, 1M-identity scale, gated tenant onboarding, portfolio API. 152–154/160 live gates pending deployment. | [PLATFORM_OPERATIONS.md](PLATFORM_OPERATIONS.md), [THREAT_MODEL.md](THREAT_MODEL.md), [PRIVACY.md](PRIVACY.md) | `tests/platform.test.mjs`, `tests/infrastructure.test.mjs`, `tests/integration-gates.test.mjs` |

## Cross-track integration

- Paid model runs pass `assertDispatchAllowed` (pause, scoped kill switches, governed ledger caps) before any
  reservation or provider request; an unfunded governed ledger blocks with zero provider calls.
- Every owner email send (operations console and Conversation Center) runs one composed gate inside the
  dispatch transaction: governance, CRM contactability (suppression, consent, region, frequency, ownership),
  Campaign Studio approval binding, and the communications checks (postal profile, mailbox consent, SPF/DKIM/DMARC,
  exact-revision approval, sequence state, daily caps).
- Legacy shortcuts were closed: deals cannot be dragged to *won* without verified evidence; funding
  submissions, commitments, awards and receipts must use the evidence-gated Funding workflow.

## Deployment steps (operator)

Done on 2026-11-15 (see [live release status](LIVE_RELEASE_STATUS.md)):

1. ~~Apply migrations 0014–0023 to staging, then the matching runtime grants; run acceptance; repeat on production.~~
   Done after creating the `pre-dots-0014-backup` Neon branch.
2. ~~Add `CREDENTIAL_ENCRYPTION_KEY` to Render.~~ Done (hex form, accepted by `credentialKey`).
3. ~~Deploy the merged `main` revision.~~ Done; `live` with the `/api/health` check. HTTPS smoke runs through the
   **Production smoke** workflow because the operator sandbox cannot reach `*.onrender.com`.

Still optional: configure the GitHub `production` environment (`RENDER_API_KEY`, `RENDER_SERVICE_ID`,
`PUBLIC_ORIGIN`) to use the owner-authorized deploy workflow.

## External prerequisites (unchanged $0 default until provided)

- Optional free model: `OPENROUTER_API_KEY` from a free OpenRouter account (Google Gemma, zero max price).
  Public/non-personal prompts only. Without it the free model route reports key-required.

- Model providers: funded OpenAI/Anthropic/xAI accounts, scoped keys, preapproved caps (DOTS-069).
- Email: owner sending domain with SPF/DKIM/DMARC, Resend account, postal address, 1–5 test inboxes,
  `EMAIL_WEBHOOK_SECRET`, written canary authorization (DOTS-109, DOTS-147, DOTS-154).
- Payments: Stripe merchant account, restricted live key, webhook secret, authorization IDs, explicit
  permission for one real payment and refund (DOTS-144).
- Legal: region policies / lawful basis for any non-US outreach, investor-communication review.
- Commercialization decision, terms and licensed avatars before multi-tenant signup (DOTS-158).
- Boardroom / Engine Room consumers of `/api/v1/portfolio` are tracked in their own repositories (DOTS-159).
