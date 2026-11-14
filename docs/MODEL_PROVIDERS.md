# Model providers, routing and evaluation (phase F5)

Covers roadmap units DOTS-055 through DOTS-069. Implementation:
`packages/operations/src/models.ts` (manifest, adapters, provenance, router, resilience, usage,
output isolation, checkpoint dry-run, benchmark, smoke gate), shared provenance helpers in
`packages/operations/src/providers.ts`, migration `database/migrations/0016_model_execution.*.sql`,
runtime grants `database/runtime-grants-0016.sql`, route `apps/web/app/api/v1/models/route.ts`,
view `apps/web/app/views/models-view.tsx` (navigation label **Models**), tests `tests/models.test.mjs`,
live smoke gate `scripts/model-smoke.mjs`.

Everything is deny-by-default and USD 0 by default. No test, CI job or page load calls a provider.

## Approved providers (manifest version 1)

| Provider id | Protocol | Trusted endpoint | Billing | Privacy ceiling |
| --- | --- | --- | --- | --- |
| `openai` | Responses API (`store:false`) | `https://api.openai.com/v1/responses` | paid | internal; private only with `OPENAI_PRIVATE_DATA_APPROVED=true` |
| `claude` | Messages API | `https://api.anthropic.com/v1/messages` | paid | internal; private only with `CLAUDE_PRIVATE_DATA_APPROVED=true` |
| `grok` | xAI chat completions + account model list | `https://api.x.ai/v1/chat/completions` | paid | internal; private only with `GROK_PRIVATE_DATA_APPROVED=true` |
| `openrouter` | pinned `google/gemma-4-31b-it:free`, Google AI Studio route only | `https://openrouter.ai/api/v1/chat/completions` | free | public only |

`registry/model-catalog.json` keeps the three paid candidates with `enabled:false`. A consumer
ChatGPT subscription is not API credit; an API account with billing is required.

Chinese-developed code-capable model lineages (Qwen/QwQ, DeepSeek, MiMo, GLM/Zhipu/Z.ai, Kimi/Moonshot,
MiniMax, Doubao/Seed, Hunyuan, InternLM, StepFun, Yi/01.AI, ERNIE, Baichuan and others listed in
`disallowedModelLineage`) are rejected anywhere in a model id, including when offered by an approved
host or broker. Arbitrary endpoints, look-alike hosts, ports, credentials in URLs and non-HTTPS URLs are
rejected before any request.

## What each unit provides

- **DOTS-055 manifest and revisions.** `MODEL_MANIFEST` is the reviewed code manifest. `app.model_revisions`
  stores immutable per-tenant revisions (status `approved|retired|denied`, endpoint, protocol, approved origin,
  privacy class, capability snapshot, manifest version, review reference, snapshot hash). Upgrades and
  retirements append a new revision; UPDATE/DELETE are blocked by trigger. `modelCatalogStatus()` lists every
  provider and reports it disabled with the exact missing variable name (for example `MISSING_OPENAI_API_KEY`).
- **DOTS-056 canonical contract.** `ModelRequest` (system, messages incl. assistant tool calls and tool results,
  tool definitions, max output, timeout, structured schema, privacy class, idempotency key, trace id, stream) and
  `ModelResult` (text, normalized tool calls, structured value, finish reason incl. `refusal`/`length`, usage with
  cached and reasoning tokens, provider request id, wall time, cost and cost basis). `ProviderCallError` says
  whether the provider may have executed (`no|unknown|yes`) and whether the error is retryable.
- **DOTS-057/058/059 native adapters.** `buildProviderRequest` / `invokeModel` implement OpenAI Responses
  (function tools with `strict:true`, `text.format` JSON schema), Claude Messages (`tool_use`/`tool_result` blocks,
  merged user turns, `stop_reason` refusal/max_tokens, cache read/write accounting) and xAI chat completions
  (function tools, `response_format` JSON schema, account model list via `detectGrokModels`; an unlisted model
  fails closed before the request). Streamed (SSE) and non-streamed payloads normalize identically. The legacy
  `complete()` used by the worker still works and now also rejects host/model mismatches.
- **DOTS-060/061 provenance and endpoint policy.** `assertTrustedBinding` binds provider + exact endpoint + model
  family + (when supplied) the latest approved revision. Responses whose `model` differs from the requested
  model (other than a dated snapshot of it) fail as `PROVIDER_MODEL_SUBSTITUTED`. `assertFailoverAllowed` forbids
  free→paid fallback always and paid fallback unless the caller explicitly passes `allowPaidFailover`.
- **DOTS-062 output isolation.** `classifyGeneratedOutput` assigns a content type and quarantines HTML, scripts,
  shell commands, fenced executable code, event handlers, `javascript:` URLs and binaries. `app.generated_outputs`
  stores only the hash and findings. `releaseOutput` requires an owner authorization reference and a security check
  reference (plus a sandbox reference for execution); `assertOutputUsable` is the gate publish/execute paths call.
- **DOTS-063 checkpoint installer specification.** `planCheckpointInstall` is a dry run: it verifies a pinned
  40-hex revision, approved licence (`apache-2.0`, `mit`, `gemma`), reviewed lineage (Google Gemma), per-file SHA-256,
  safe serialization (no pickle `.bin/.pt/.ckpt`), and reports total bytes, GiB, monthly storage and egress cost.
  The application has no download code path. `downloadPermitted` is true only with all of
  `CHECKPOINT_INSTALL_ENABLED=true`, `CHECKPOINT_FUNDING_AUTHORIZATION_ID`, `CHECKPOINT_STORAGE_APPROVAL_ID`,
  `CHECKPOINT_SPEND_CAP_CENTS`, `CHECKPOINT_STORAGE_CENTS_PER_GB_MONTH`, `CHECKPOINT_EGRESS_CENTS_PER_GB` and a cost
  under the cap; even then an operator performs the download outside the app, verifies every hash, and serves it in
  an isolated environment with no customer data until a separate review approves it.
- **DOTS-064 router.** `routeModel` considers only approved, configured, execution-authorized providers with
  weight > 0, permitted privacy class, required capabilities (tools/streaming), a closed breaker and sufficient
  budget (worst-case estimate). Zero-budget paid providers are skipped (`BUDGET_ZERO`) without network. Selection is
  a deterministic weighted choice seeded by the idempotency key. `app.model_routing_weights` holds per-agent weights.
- **DOTS-065 resilience.** `ModelOperations.execute` claims the idempotency key in `app.model_executions` (a key
  executes at most once; duplicates replay or are refused), reserves the worst-case cost through the existing budget
  reservation, retries only `429`/`5xx` with `backoffDelayMs` (equal jitter, capped at 8 s, honours bounded
  `Retry-After`), persists per-model breaker state in `app.model_breakers` (opens after 3 consecutive failures,
  cooldown doubles up to 15 min, half-open probe), and audits every route, retry, breaker transition and failover in
  `app.operation_events`. Timeouts and dropped connections are ambiguous: never retried or failed over; the
  reservation is held and the execution is marked `reconciliation_required`.
- **DOTS-066 usage reconciliation.** `app.model_pricing_versions` (immutable, appended when rates change),
  `app.model_usage_records` (immutable; input/output/cached/reasoning tokens, wall time, cost, `provider_reported |
  estimated | missing`, ledger key) and `app.model_provider_invoices`. `reconcile()` compares usage to
  `app.money_entries`, lists overruns, orphan ledger entries and invoice differences, and reports estimated and
  missing usage separately. The ledger never exceeds a reservation.
- **DOTS-067 UI.** The Models view shows each provider with credential presence (name only), state, privacy
  ceiling, cost status and capabilities; reviewed revisions; a per-agent routing weight editor; breaker health;
  reconciliation; quarantined outputs with release/reject forms; benchmark and smoke-gate status. Keys are never
  entered in the browser — the owner adds them as deployment secrets.
- **DOTS-068 benchmark.** `runAdapterBenchmark` replays `BENCHMARK_CASES` (quality, safety/refusal, tool,
  compliance/quarantine, compliance/substitution, latency) through the real adapters with stub provider payloads
  and a virtual clock. Output is labelled `evidenceKind:"stub-fixture"`, `liveEvidence:false`, `realChargesCents:0`.
- **DOTS-069 live smoke gate.** `planModelSmoke` / `runModelSmoke` and `scripts/model-smoke.mjs`.

## HTTP API (`/api/v1/models`)

`GET` (owner session) returns `{manifest, providers, revisions, pricing, agents, weights, breakers, executions,
outputs, invoices, controls, reconciliation, smoke, observedAt}`. `POST` (trusted origin + owner session, JSON) accepts
`action` = `registerRevision`, `setRoutingWeight`, `addPricingVersion`, `resetBreaker`, `recordInvoice`,
`releaseOutput`, `rejectOutput`, `runBenchmark`, `planCheckpoint`, `planSmoke`, `reconcile`.

## Environment variable names (values are secrets or owner decisions; never commit them)

`OPENAI_ENABLED`, `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_INPUT_CENTS_PER_MILLION`, `OPENAI_OUTPUT_CENTS_PER_MILLION`,
`OPENAI_CACHED_INPUT_CENTS_PER_MILLION`, `OPENAI_MAX_OUTPUT_TOKENS`, `OPENAI_PRIVATE_DATA_APPROVED` (and the same with
`CLAUDE_` and `GROK_` prefixes); `OPENROUTER_ENABLED`, `OPENROUTER_API_KEY`, `FREE_MODEL_API_ENABLED`;
`MODEL_API_ENABLED`, `OWNER_SPEND_AUTHORIZATION_ID`, `PAID_SPEND_LIMIT_CENTS`; `MODEL_SMOKE_ENABLED`,
`MODEL_SMOKE_PROVIDERS`, `MODEL_SMOKE_CAP_CENTS`; `CHECKPOINT_*` listed above.

## Operator steps

1. Apply migration 0016, then `database/runtime-grants.sql` followed by `database/runtime-grants-0016.sql`
   as the migration administrator.
2. In the Models view, record a review for the exact model id (`Record revision`). Without it the model is never routed.
3. Set routing weights per agent (0 disables).
4. Add the provider key and prices as deployment secrets and set the funded cap (see below). The catalog shows the
   provider as `ready` only when every prerequisite is present.

## Blocked on external prerequisite

**DOTS-069 live smoke (and any paid execution) is blocked on external prerequisite**: an owner-funded provider API
account, a scoped API key and a preapproved dollar cap. Exact non-secret steps for the owner:

1. Create or choose the provider API account (OpenAI platform, Anthropic Console or xAI console) with billing enabled
   and a provider-side monthly limit at or below the approved cap.
2. Create a project-scoped API key and store it only as the deployment secret `<PROVIDER>_API_KEY` in the Galinsky
   Laboratories hosting account. Set `<PROVIDER>_ENABLED=true`, `<PROVIDER>_MODEL=<exact reviewed model id>` and
   the current per-million prices from the provider's pricing page.
3. Record the spending approval: `MODEL_API_ENABLED=true`, `OWNER_SPEND_AUTHORIZATION_ID=<approval reference>`,
   `PAID_SPEND_LIMIT_CENTS=<cap>`.
4. For the smoke only: `MODEL_SMOKE_ENABLED=true`, `MODEL_SMOKE_PROVIDERS=<ids>`, `MODEL_SMOKE_CAP_CENTS=<= cap>`.
   Run `node scripts/model-smoke.mjs --plan`, then `node scripts/model-smoke.mjs`. Exit 0 = all passed with receipts,
   1 = a live failure (blocker code printed), 2 = blocked before any network call.

Until then the mocks and fixtures cover the adapters, and no live result is claimed.

## Acceptance status

| Unit | Status | Evidence |
| --- | --- | --- |
| DOTS-055 | Implemented | providers shown disabled without credentials; append-only revisions (tests) |
| DOTS-056 | Implemented | conformance fixtures: schema failure, empty, invalid JSON, cancellation, timeout, streamed vs non-streamed |
| DOTS-057 | Implemented (mocked) | OpenAI request/response mapping, tools, schema, usage, refusal, truncation |
| DOTS-058 | Implemented (mocked) | tool_use/tool_result turns, refusal, max_tokens, cache-aware token accounting |
| DOTS-059 | Implemented (mocked) | mapping, account model detection, unavailable model fails closed |
| DOTS-060 | Implemented | disallowed models fail closed even via approved hosts/brokers |
| DOTS-061 | Implemented | endpoint override, unknown model, paid fallback, host/model mismatch, substitution cannot dispatch |
| DOTS-062 | Implemented | quarantine + explicit authorization and security check before publish/execute |
| DOTS-063 | Implemented (dry run) | weight volume and cost report; download impossible in app |
| DOTS-064 | Implemented | private data never routed to free route; zero budget skipped without network |
| DOTS-065 | Implemented | 429/5xx/timeout chaos tests; no double execution; reservation never exceeded |
| DOTS-066 | Implemented | usage vs ledger, estimated/missing flagged, immutable pricing, invoice comparison |
| DOTS-067 | Implemented | catalog UI with truthful key/cost/privacy/disabled disclosure; integrator adds nav entry |
| DOTS-068 | Implemented | deterministic fixture benchmark, no live claims or charges |
| DOTS-069 | Gate implemented; live run blocked on external prerequisite | refuses without flags/caps; reports blockers |
