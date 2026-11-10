# Connect free services first

The app already runs on free Render and Neon infrastructure. The following integrations
are implemented, but external accounts must supply their own API credentials. Adding a
credential does not by itself authorize outbound solicitation or real charges. Never paste
keys in chat, GitHub issues, documents, screenshots or the public repository.

## 1. Recommended: Qwen3.8 27B through Groq Free

Create an account at https://console.groq.com/ and keep the organization on its Free plan.
Do not enable paid billing or upgrade to Developer. Open https://console.groq.com/keys,
create a dedicated app key, and put it in Render as `GROQ_API_KEY`.

The app pins `qwen/qwen3.8-27b`, listed in Groq's current Free-plan model limits, and
verifies model access through Groq's authenticated model catalog before inference.
The deployment has `GROQ_ENABLED=true`; after confirming the account is actually Free,
set `GROQ_FREE_PLAN_CONFIRMED=true`. This confirmation is necessary because the API key
check verifies authentication/model access, not the account's billing plan. Do not leave
that flag true if you later upgrade the organization. Free-plan exhaustion returns a
rate-limit error; there is no app fallback to a paid provider. The app starts with a
shared free-model limit of 20 requests/day (`FREE_MODEL_DAILY_REQUEST_LIMIT`).

Qwen3.8 27B is an Apache 2.0 open-weight model and the recommended starting choice for
this low-volume zero-dollar setup. No claim of universal best performance is made without
an application-specific benchmark. This is hosted inference, not running weights on the
free Render machine; serving a capable model locally requires suitable hardware.

After saving the key and Free-plan confirmation, use Settings → Groq → Check connection,
allow model calls, select Groq on a live task, and keep the funded spending cap at $0.
Free tasks require public, non-personal inputs and exclude private project context.

Sources: [Groq model documentation](https://console.groq.com/docs/model/qwen/qwen3.8-27b),
[Free-plan limits](https://console.groq.com/docs/rate-limits),
[published weights/license](https://huggingface.co/Qwen/Qwen3.8-27B).

## 2. Optional alternative: Gemma 4 31B through OpenRouter

Create an account at https://openrouter.ai/ and open https://openrouter.ai/settings/keys.
Create a dedicated key for Death Of The Salesman. Do not buy credits or enable automatic
credit purchases for the free setup. Set a zero credit limit for the key if offered;
free-model eligibility and quotas still depend on the account's current rules.

In [Render Environment](https://dashboard.render.com/web/srv-dbp58hm1egvs73b3inug/env),
add `OPENROUTER_API_KEY` with the secret key. The deployment is preconfigured with:

```text
OPENROUTER_ENABLED=true
FREE_MODEL_API_ENABLED=true
OPENROUTER_MODEL=google/gemma-4-31b-it:free
FREE_MODEL_DAILY_REQUEST_LIMIT=20
OPENROUTER_MAX_OUTPUT_TOKENS=1000
MODEL_API_ENABLED=false
PAID_SPEND_LIMIT_CENTS=0
```

The pinned Google Gemma 4 31B endpoint was verified in the live public catalog
on November 9, 2026. Its current published reasoning and agent capabilities make it a
strong zero-dollar starting point. This is a recommendation, not a claim that it is the
best model for every workload. We have not benchmarked it against this business's tasks
or performed an authenticated inference canary without an owner key.

The adapter checks the live catalog for zero input/output/request prices and a published
weights source before each inference call. It sends zero maximum prices and disables
fallbacks. It rejects paid model IDs, custom endpoints and billed responses. An unavailable
free endpoint stops the run; it never upgrades to a paid model. Free request quotas and
availability are not an unlimited production capacity promise.

After saving the Render secret, open the app's Settings. Confirm OpenRouter is connected,
allow model calls, activate/assign an agent, resume the queue, and select the connected
provider in a live task. The funded budget remains $0. Results are real provider output,
with live source, token usage and zero-cost evidence; deterministic rehearsals remain
separately labeled.

Google's free service can use prompts to improve products. Each free task requires
confirmation that the brief, project name and selected approved facts contain no
confidential or personal data. The free prompt excludes private project descriptions,
strategy instructions, CRM, conversations and vault documents. For private inference,
choose an appropriate paid provider/data agreement or separately funded private compute.

NVIDIA's otherwise capable free endpoints were excluded because their linked trial terms
restrict production use. The approved free model and Google AI Studio route are pinned;
a new free model/host requires review before it is added to the approved set. Gemma 4's
published weights use Apache 2.0. Free hosting capacity can still change or disappear.

Sources: [free endpoint](https://openrouter.ai/google/gemma-4-31b-it:free),
[published weights and license](https://huggingface.co/google/gemma-4-31B-it),
[Google free-service terms](https://ai.google.dev/gemini-api/terms),
[zero-price routing](https://openrouter.ai/docs/guides/routing/provider-selection),
[account limits](https://openrouter.ai/docs/api/reference/limits).

## 3. Free email with Resend

1. Create an account at https://resend.com/signup and keep it on the Free plan.
2. In Domains, add a domain you control. Copy Resend's DNS records into your domain's
   DNS provider and wait for verification. A domain registration itself is not provided
   by the app or by Resend's email quota.
3. In API Keys, create a key for this app and verified sending domain. Add it in Render
   as `EMAIL_DELIVERY_TOKEN`. Sender verification and inbound retrieval use Resend read
   endpoints, so the key must support those operations if you use those features.
4. Create a Resend webhook at
   `https://death-of-the-salesman.onrender.com/api/webhooks/resend` for delivery, bounce,
   complaint and, if enabled, received-email events. Store its signing secret in Render
   as `EMAIL_WEBHOOK_SECRET`.
5. Provide the sender display name/email, real mailing address, reviewed sending
   jurisdictions, time zone and initial daily volume. Record the confirmed free plan
   and sender verification references. Register and verify the sender in app Settings.

Free activation uses `EMAIL_BILLING_MODE=free`, `EMAIL_FREE_PLAN_CONFIRMED=true`,
`EMAIL_COST_CENTS=0`, `EMAIL_DELIVERY_ENABLED=true`, `EMAIL_ALLOWED_JURISDICTIONS`,
`OUTREACH_TIMEZONE`, `OUTREACH_POLICY_AUTHORIZATION_ID` and `SENDER_VERIFICATION_REFERENCE`.
The app's existing signing key remains private. Do not claim the free-plan confirmation
if the account is on a billable plan. `EMAIL_RECEIVING_ENABLED=true` is optional.

The app enforces organization-wide ceilings of 100 outbound messages/day and 3,000/month,
including uncertain dispatches, plus campaign-specific lower limits. Account usage by
other apps can exhaust the provider quota earlier. Free setup does not need a positive
spending cap; sender, consent/suppression, jurisdiction, business hours, cadence,
current facts and exact campaign/message approvals are still required before dispatch.

Sources: [current Free plan](https://resend.com/pricing),
[domain verification](https://resend.com/docs/dashboard/domains/introduction),
[API keys](https://resend.com/docs/dashboard/api-keys/introduction),
[webhooks](https://resend.com/docs/dashboard/webhooks/introduction).

## 4. Existing Stripe account: sandbox first

Open https://dashboard.stripe.com/test/apikeys in your existing account's sandbox/test
context. Create or retrieve a test secret key and add it to Render as `STRIPE_SECRET_KEY`.
For this backend-created Checkout integration, the public publishable key is not needed.
Do not provide a live key for the sandbox setup.

Create a sandbox webhook destination at
`https://death-of-the-salesman.onrender.com/api/webhooks/stripe` for
`payment_intent.succeeded` and `charge.refunded`; add the destination's signing secret as
`STRIPE_WEBHOOK_SECRET`. Sandbox and live destinations have different signing secrets.

Sandbox activation requires `PAYMENTS_ENABLED=true`, a recorded
`OWNER_MERCHANT_AUTHORIZATION_ID`, `MAX_PAYMENT_CENTS` (suggested initial test maximum
10000, or $100 USD), and the test key. Leave `PRODUCTION_PAYMENTS_AUTHORIZATION_ID` unset.
Create and issue an invoice before requesting its hosted Stripe Checkout link. Use test
payment methods only. Sandbox receipts are explicitly separate from real revenue.

Sources: [test environments](https://docs.stripe.com/testing),
[API keys](https://docs.stripe.com/keys), [webhook setup](https://docs.stripe.com/webhooks).

## Later: paid activation inputs

- Models: selected provider/model, its API key, billing enabled, approved USD spending
  cap and time period, and per-project allocations. The current app cap is cumulative
  until reviewed/reset; it is not a silently renewing monthly allowance. Confirm provider
  pricing and provider-side account limits; set `OWNER_SPEND_AUTHORIZATION_ID` and the
  matching app hard cap before enabling `MODEL_API_ENABLED`. Chat-app subscriptions are
  separate from API credentials/billing.
- Email: the same verified sender, domain/DNS, mailing address, audience consent rules
  and webhook key. For a billable account, supply the approved spending cap and unit cost
  in addition to outreach authority. Upgrading is unnecessary while the confirmed free
  account's quotas meet demand.
- Live Stripe: completed merchant/business verification and payout setup in your existing
  Stripe account, the live secret key, live webhook signing secret, approved USD prices,
  refund/fulfillment terms and maximum transaction amount. Record explicit live-payment
  authority before setting `PRODUCTION_PAYMENTS_AUTHORIZATION_ID`. This app currently
  creates one-time USD invoice payments. Live processing incurs Stripe's applicable fees;
  it is not a free payment service.

For account setup, tell the implementer only which provider is ready and which nonsecret
limits/identity settings you chose. Put secrets directly into Render Environment.
