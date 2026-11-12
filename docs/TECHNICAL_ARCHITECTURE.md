# Death Of The Salesman — Complete Technical Architecture
Version: 1.0 (architecture baseline) | Date: 2026-10-18 | Status: design specification, NOT an implemented application

## 0. Purpose and binding decisions

Build an API-native, multi-model, visual command center for two initial professions:
1. **Revenue Sales Agents** — sell the owner's software, services, and products.
2. **Funding Agents** — identify and pursue eligible grants, sponsorships, partnerships, and lawful investor opportunities.

Vision/Mission agents are explicitly out of scope for this product phase. The repository and product may have different names; the public brand is configurable. The application is a separate product from Boardroom, with independently owned operational data and integrations, and later may exchange scoped project references and aggregate reporting with Boardroom or Engine Room. No Boardroom scheduled-ChatGPT-agent compatibility is required. Every model run originates through a documented API/inference endpoint; models do not run continuously merely because an avatar is registered.

Critical owner requirements:
- Preserve the dark, richly visual reference layout: left navigation, summary metrics, agent roster with character avatars, checkbox-visible project buckets, drag-and-drop assignments, expandable agent hover cards, Strategy Lab, opportunity funnels, campaign finance controls, and unified conversation management. **No decorative/random salesman quote anywhere.**
- Responsive and usable on desktop, tablet, touch phones, keyboard and screen readers.
- Each avatar and expanded card has a server-derived green/yellow/red status indicator; tooltips include current assignment, exact activity, last timestamps, results and costs.
- Strategy population ratios are configurable in the UI, initially proposed 50% champion / 50% experimental; never hardcoded.
- First two seeded personalities: Fast Eddie Felson and Harry Wormwood. All supplied future names live in the version-controlled approved roster; a fresh commercial tenant has no pre-assigned operating agents.
- Start with OpenAI, Anthropic/Claude, xAI/Grok, and three independently hosted or self-hosted open-weight checkpoints; allow later winner-take-most or winner-take-all routing based on independent evaluation.
- Real outbound sends and paid API runs are **off** by default; project, channel, model and organization spending limits start at USD 0.
- Record verified evidence, not fabricated sales progress; respect legal channel restrictions and suppression requests.

## 1. Product domain and boundaries

Workspaces have Organizations/Tenants; each tenant can have Projects, Offers, Personas, Campaigns, Audiences, Leads, Accounts, Contacts, Pipelines, Stages, Conversations, Deals, Funding Opportunities, Applications, Agent Identities, Assignments, Strategies, Experiments, Model Configurations, Credentials, Budgets, Analytics and Compliance Policies.

**Project**: durable product/business being sold or funded. A project can appear as one or many visible task buckets. **Campaign**: bounded go-to-market effort with audience, offer, channels, budget, policy, and schedule. **Bucket**: presentational/assignment surface linked to a project or campaign; not a separate source of truth. **Assignment**: which agent can work on which campaign/priority, with quotas and a lease. **Work item**: unit such as research a funder, review an inbound reply, draft a proposal, or send an authorized follow-up. Funding and sales pipelines have different stages and outcome accounting.

Funding modes must not be silently conflated:
- Investor relationship building: research, introductions, factual pitch materials, meetings, diligence; no autonomous securities transaction, individualized investment recommendation, unlicensed brokerage, or unapproved offering solicitation.
- Grant development: opportunity discovery, eligibility validation, deadlines, draft applications, document checklists, owner-reviewed submission, award tracking and restricted-use tracking.
- Sponsorship/strategic partnership: identify partners, negotiate draft terms, review and signature handoff.
- Product revenue: lead qualification, consultations, trials, demos, quotations within approved prices, purchases and renewals. Actual payments are processed by authorized payment providers, not model-written scripts.

Explicit exclusions for baseline: vision agents; mass political persuasion/automated political campaigning; autonomous telephone dialing/SMS; unauthorized scraping; unapproved payments, discount exceptions, binding contracts, public securities offers; and creation of fictitious testimonials, customer metrics, grant qualifications, or investor commitments. Regulatory-specific workflows may be added only with a reviewed policy module.

## 2. Architecture: modular monolith control plane, isolated execution plane

Start as a modular TypeScript monorepo with one deployable web/API application and separate workers. The boundaries must be extractable into independent services without redesigning core business schemas.

~~~text
[Owner web/mobile browser]
        |
 HTTPS / authenticated session / organization policy
        v
[Next.js UI + BFF/typed API]
   |      |         |             |
   |      |         |             +--> Live projections (SSE/WebSocket)
   |      |         +--> Campaign / Strategy / CRM / Funding services
   |      +--> Authorization, approval, budget, audit & compliance gate
   +--> Commands (transaction + outbox)
                   |
            [Postgres / Neon]
              |     |    \
              |     |     +--> transactional outbox and append-only audit
              |     +--> CRM, threads, allocations, strategy experiments
              +--> event-driven job queue
                          |
                 [Worker pool / leases]
                   |       |       |
       [Model router] [Channel gateway] [Research connectors]
        /  |  |  \          |                |
   OpenAI Claude Grok Open-weight       permitted APIs
                     |       |
                 [Infer]  Email/inbox/calendar/payment adapters
                     \       /
                 [Verified event ingest]
                          |
             [Metrics / funnel / dashboard]
~~~

Ownership: a campaign is configured by the owner; agents receive typed, minimum-privilege delegated tasks. Model outputs cannot directly mutate data or invoke external services. Every proposed action passes a deterministic server gate and is rechecked at dispatch against the current policy, authorization, consent, active status and remaining budget.

Recommended implementation technology:
- TypeScript/Node 22+; Next.js App Router + React for UI/BFF; a shared packages/domain module with Zod/JSON-schema contracts.
- PostgreSQL 16+ or supported managed Neon PostgreSQL, explicit migrations, transactional outbox, JSONB for non-authoritative provider metadata only. Use relational columns and constraints for money, identity, assignments, suppression and state.
- Database-backed queue and workers for inexpensive initial volume (e.g. pg-boss / a hand-rolled carefully tested SKIP LOCKED queue). Separate queue service or managed broker only when measurements justify it; do not run long jobs in Next.js requests or spend on idle workers. Use outbox publication and durable idempotency keys.
- Object store for encrypted attachments, raw webhook evidence, reports, decks and generated assets; version and hash objects; retention policies. Postgres stores metadata and signed references. Do not put files/weights in application Git.
- SSE for status/funnel progress with REST fallback and manual refresh; optional WebSockets for interactive work. UI projections must never themselves trigger model calls.
- Postgres full-text first; vector search/pgvector optional only when evidence shows retrieval benefit. Analytical materialized views first; warehouse later at scale.
- CSS variables/design tokens; Tailwind or equivalent utility styling, Radix-compatible accessible primitives; React Query for stale-while-revalidate and optimistic UI with server ack; dnd-kit for keyboard/touch drag/drop if still maintained and accessible.
- OpenTelemetry instrumentation, structured JSON logs with PII redaction, error monitoring; metrics and tracing governed by cost controls.
- Deploy web/API, on-demand/small worker, database and object storage separately using least-privilege credentials. Render + Neon are candidates consistent with existing projects, not prerequisites; dedicated project resources, never cross-share another project's database/secrets.

Application subsystems (separate modules with explicit interfaces): identity/access; project & campaigns; allocation; CRM; unified communications; funding; content/asset library; agent runtime; model router; compliance/approvals; finance/budget; strategy/experiments; evidence and analytics; notifications; administration; integration adapters.

## 3. UI design contract and responsive layouts

See docs/PRODUCT_INTERACTION_DESIGN.md for exact surfaces. Global shell:
- 64–80 px desktop left navigation with logo and icons; expanded mode can show labels. No inspirational/salesman quote in sidebar, corners, dashboard or cards.
- Top bar: workspace and project filters, global search, alert center, pause-all control, user/account; persistent paid-spend/offline signal.
- Overview: KPI cards (agents active/waiting/inactive, contacted, qualified, won, revenue net of costs, committed vs received funding); data source and time window visible.
- Deployment: searchable avatar roster panel; center checkable project buckets; optional right campaign inspector. Drag avatar to one or multiple campaign buckets, optionally primary/secondary share and quotas; show conflict/lead-ownership policies. Moving agent modifies assignments transactionally and is reversible.
- Agent card: avatar, label, role and online status dot at top-right. Hover peek: last heartbeat/task state, campaign, model, strategy, next action, last verified contact, lifetime and period metrics, UTC timestamps rendered in user timezone, spend, errors. Click opens drawer with timeline, activity payload, consent evidence, conversation references, exact send history and controls.
- Pipeline: draggable stage board/cards; separate sales, grant and investor funnels. Each stage card contains truth labels like 'qualified', 'draft proposal', 'awaiting response', 'committed', 'paid/received', never implying deposits from mere interest.
- Conversation Center: split layout with threads, chat-like message timeline, draft composer, evidence/attachments, participant identity, source connector, delivery state, next-best-action draft, and one-click owner take-over; send action always gated.
- Campaign Studio: editable offer, copy, email templates, segments, channels, contact cadence, exclusions, experiments, timeline, send schedule, budget controls and simulation before activation.
- Strategy Lab: champion/challenger allocation sliders, editable strategies, constraint cards, randomized arm allocations, performance estimates with CIs/uncertainty and sample sizes, promotion/rollback controls.
- Funding command center: grants search, eligibility and award size, application calendar, restricted spending, funder relations, due diligence, pitch assets and progress timeline.
- Budget Center: per-campaign and tenant funds, API spend, channel spend, cost by agent/provider/model, cash paid vs authorized budget, immutable ledger, hard stop.
- Owner Action Review: secure queue for approval-required messages, grant submissions, investor disclosures, unusual deal terms, account/credential provisioning, policy and spend modifications.
- Audit: timeline of server-verified actions with references, replays, incidents, suppressions, decisions and export.

Desktop >=1280: three-panel Deployment, 12-column dashboard; tablet 768–1279: roster drawer + buckets two-column + details drawer; mobile <768: single-column bucket cards, bottom tab navigation, tap-to-assign instead of drag-only, click-to-open status cards, modal thread composer. Support reduced motion, WCAG 2.2 AA color contrast, focus order, keyboard actions, accessible aria status labels, non-color-only status and scalable text.

Color palette design tokens (tunable): dark navy background #091322; raised #122338; surfaces #15283F; separator #294057; primary blue #3D87F5; teal #31CCA0; purple #AE85F7; amber #F7C64B; red #F16F75; typography #F0F5FD / #AFC1D6. Responsive density toggle. Charts accessible with textual equivalents.

Status semantics derive from backend state:
- **Green/working** only while a currently valid run lease and recent heartbeat/worker progress are present, not for an agent simply assigned to a bucket.
- **Yellow/waiting** for intentionally queued, rate-limited, paused pending reply, scheduled next execution or blocked for review; card shows exact reason.
- **Red/inactive** when disabled, not assigned, run terminated, lost heartbeat beyond recovery threshold, or credential unavailable; degraded/error reason shown separately, not silently 'idle'.
Statuses always include human-readable labels and exact last-event timestamp. No model usage incurred for UI refresh.

Avatar policy: database identity has display name + user-provided/licensed avatar asset reference + generated original placeholder. For private prototype use stylized ORIGINAL portraits or initials; do not scrape actor/film stills into the public repository, package identifiable likenesses, or presume commercial publicity/copyright licenses. Character names are identity labels, not claims of affiliation. New tenant seed behavior is opt-in demo roster, no preexisting operational people/agents.

## 4. Agent architecture, authority and runtime

Agent is a persistent identity, not a permanently running LLM process. Fields include tenant, approved roster reference, avatar, type (sales, investor-relations, grant, partnership), skills, project assignments, strategy variants, model policy, owner, policy scope, business-hour windows, approved channels, objectives, concurrency and quota limits, state and deployment history.

Execution contract:
1. Ingest authorized trigger (queued research, review inbound, followup due, campaign launch, manually requested work); dedupe.
2. Transactionally reserve a task and agent slot/lead owner; verify precedence, suppression, budget and lock.
3. Build bounded context from campaign instructions, approved current offer, contact thread, factual sources, organization policies, prior task checkpoint. Defend against retrieval prompt injection by separating untrusted text and tools.
4. Router reserves worst-case estimated model cost atomically and selects the registered provider/model snapshot. If no funded provider available, mark WAITING_FOR_BUDGET without calling anything.
5. Model returns structured draft recommendation, tool-action proposal, risk classification and references. Adapt tool/function response into canonical typed output. Validate schema server-side, independently confirm cited facts and authority, redact unsafe/unsupported claims. Refusal and generation failure are first-class outcomes.
6. The deterministic policy engine decides ALLOW, REQUIRE_OWNER_APPROVAL or DENY; for send, re-evaluate current consent/suppression/caps right before provider dispatch. External writes occur through idempotent gateway; never give raw provider/email keys to prompts.
7. Persist output, provider request identifiers (not raw secrets), model snapshot, hashed prompt-template version, response quality metadata, decision, cost usage, resulting transport evidence, work checkpoint, audit event and next state.
8. Reconcile stale in-flight tasks and provider receipts; notify owner for exceptions; release lease and reservations.

Task states: CREATED -> ELIGIBLE -> RESERVED -> RUNNING -> (DRAFTED | WAITING_FOR_APPROVAL | WAITING_FOR_REPLY | WAITING_FOR_BUDGET | BLOCKED | COMPLETED | FAILED_RETRYABLE | FAILED_FINAL | CANCELLED). Transitions use compare-and-swap version + fencing token, never just timestamp. A retry must not send a duplicate message: stable outbound idempotency key is tenant/campaign/contact/sequence-step/template revision; provider operation reconciles by message-id before retry. Inbox, CRM, and transcript ingestion are at-least-once; reducers are exactly-once-effect through unique constraints and transactions.

Lead/account exclusivity differs from Boardroom repository exclusivity: many agents may sell same project, but a contact/campaign sequence has at most one active owner, and cross-campaign global contact suppression and frequency caps apply. One agent can hold several assignments subject to quotas; no competition for a single prospect inbox.

Agent context and memory: durable, provenance-linked facts, user-approved preferences and thread summaries stored per tenant, source and retention. Maintain a factual contact timeline; do not persist unverified self-asserted 'I closed deal' as proof. Explicitly allow deletion/correction, tenant export and replay from event ledger. Summaries are derived caches, not authoritative originals.

## 5. Approved model sources and inference isolation

Model availability is a security decision, not simply a pricing or capability decision. The application supports only approved provider/model routes. The candidate catalog lists direct OpenAI, Anthropic and xAI APIs, each disabled until provisioned. A separate zero-cost path is pinned to Google's Gemma via OpenRouter with Google AI Studio as the only permitted host and fallback disabled.

| Candidate | Trust boundary | Initial handling |
|---|---|---|
| OpenAI | Fixed official OpenAI API endpoint; explicitly approved model identity | disabled until key and funded cap |
| Anthropic | Fixed official Anthropic API endpoint; explicitly approved model identity | disabled until key and funded cap |
| xAI | Fixed official xAI API endpoint; explicitly approved model identity | disabled until key and funded cap |
| Google Gemma via OpenRouter | Exact free Gemma model, zero-price rules, no provider fallbacks | optional; public non-personal input only |

Do not integrate Chinese-developed code-capable models, including Qwen, DeepSeek, MiMo, GLM and Kimi, into any customer-facing inference route. This restriction applies to model lineage even when inference is hosted by a US company or broker. Unknown or substitute models, arbitrary inference endpoints, and newly added providers must fail closed until reviewed; no fallback may silently change the approved model.

Generated text or files are untrusted data. In particular, never execute generated code, shell commands, documents with active content, or downloaded model artifacts without isolated validation and explicit authority. Customer tools, secrets and output publication must be independently authorized. Media-only generation providers such as Mureka are a different category and are not removed by this restriction; audio still requires standard decoder, metadata, privacy and credential safeguards.

The versioned model registry and evidence should capture approved provider, model lineage, immutable revision, region, terms, data-handling properties and security review. Preserve original selection, provider receipts and provenance. A ChatGPT subscription is not the same as developer API credit. Free endpoints have limited capacity and can have different data-retention terms; do not send private client data to a free API by default.

Provider adapter interface: discoverCapabilities; validateConfig; quoteWorstCaseCost; runStructured; continueToolCalls; summarizeUsage; rateLimits; health; normalizeError; cancel (when supported). Canonical input includes snapshot ID, normalized system/developer instructions, messages, tool definitions, max output, timeout, structured schema, modality, privacy class, cache policy, idempotency trace. Canonical output includes selected model/version, text, schema-validated proposal, tool calls, token counts (input/output/reasoning/cache when available), finish/refusal reason, provider request ID, wall time, costs, safety metadata and provenance.

Use native provider protocols rather than assuming identical tool semantics from 'OpenAI compatibility'. Validate tool outputs with schemas and gate actions independently. Pin SDK versions. Implement retry/backoff for 429/5xx with jitter and per-model circuit breakers. On unknown final state, reconcile before reissue. Fallback to another model must respect data-residency, campaign routing, approval and budget constraints; may not transmit sensitive contact details to a newly selected processor automatically.

Current API basis and release review links:
- OpenAI Responses and strict function/structured-output guidance: https://developers.openai.com/api/reference/responses/overview ; https://developers.openai.com/api/docs/guides/structured-outputs
- Anthropic Messages and tool use: https://platform.claude.com/docs/en/api/typescript/messages/create
- xAI API and function calling: https://docs.x.ai/overview ; https://docs.x.ai/developers/tools/function-calling
- Z.ai checkpoint: https://huggingface.co/zai-org/GLM-5.3
- Muse alternative: https://huggingface.co/meta-models/Muse-Spark-Open-816B-A42B

## 6. Multi-model evaluation, strategies and routing

**Models and sales strategies are independent treatment dimensions.** Do not conclude 'Claude is better' if Claude happened to receive higher-value prospects or the best strategy. Keep factorial randomized allocations, stratify by campaign, source/segment, prospect value, timezone and assignment window, and use fixed random seeds and immutable assignment records. Offline draft quality tests run without sending; live tests follow approved campaign policy.

Version every strategy: objective, audience eligibility, approved prompt template, value proposition, email copy, CTA, allowed customization fields, follow-up cadence, claim evidence, negative/forbidden claims, tone, required disclosures, status and owner. Initial strategies can include consultative/problem-first, factual ROI/evidence-first, product-demo-first, relationship/partnership-first, grant-eligibility-first, with customizable mixture and future hybrids. Do not encode misleading testimonials or pressure/impersonation tactics.

Strategy Lab supports user-set champion/exploration percentages, initial illustrative 50/50, per campaign, segment and channel. Maintain a configurable minimum exploration floor, but owner can adjust after explicit warning. When pilot volume is low, prefer parallel offline evaluations or owner-controlled A/B tests; do not automatically assign 50% live traffic with no safeguards.

Primary metrics:
- Product: net **contribution margin** attributed to campaign, per 100 legitimate qualified contacts and per dollar of all-in execution; monitor revenue realized, CAC, unsubscribe/spam rate, refunds, churn/retention and time-to-close.
- Investor relations: qualified substantive responses, verified introductions/meetings, signed conditional commitments versus actual cash received (strict separation), plus compliance review cost.
- Grants: eligible applications correctly submitted, award value, true success rate, net restricted/unrestricted funds received, labor/model costs, and deadline adherence.
- Strategy quality: matched conversion lift with confidence or Bayesian credible intervals, sample sizes, exposure and observation windows; guardrails against high complaint rate or excessive outreach.

No automatic winner promotion until threshold met in declared metric with minimum trials and absolute safety/complaint limits; manual override and rollback always available. Attribute outcomes conservatively by explicit thread/deal evidence, support first/last/multi-touch reports, preserve uncertainty, and prohibit double-counted wins. Bandit routing may later optimize models/strategies subject to stratification, safety and minimum test exposure; initially deterministic arm assignment is easier to audit.

Comparison matrix must show both model and strategy, token/compute cost, qualified replies, wins, net-margin result, reviewer corrections, compliance incidents, low-sample warnings and segment breakdown. Best model can receive 100% within a project only after explicit configured deployment change, never by hidden cross-project promotion.

## 7. Campaign lifecycle, authoring and operation

Campaign fields: tenant/project/offer, objective, target outcome/currency, approved segments and lawful-source definitions, target account list, evidence baseline, contact channels, copy/templates, strategy set/ratios, selected providers/models, spend caps, concurrency/daily rate caps, email identity, geographies/jurisdictions, legal basis, quiet hours, start/end, exclusions/suppression snapshot, experiment plan, owner and escalation rules.

States: DRAFT -> VALIDATED -> READY_FOR_APPROVAL -> APPROVED -> SCHEDULED -> ACTIVE -> PAUSED -> COMPLETED / ARCHIVED; explicit ABORTED. Editing approved copies materially creates a revision requiring policy checks/reapproval; old scheduled sends cannot silently inherit unapproved copy. Draft review view displays exact rendered variants for example prospects, policy check results and projected maximum budget; run a dry-run of 10–100 fake/synthetic contacts without network before activation.

Tasks: discover leads with source/provenance; enrich verified business data; qualify; dedupe; draft personalized but truthful outreach; review; send through connected account; monitor replies/bounces; classify intent with confidence; draft appropriate reply; schedule meeting; assemble proposal; move deal with proof; nurture within caps; close/reconcile; request owner action on complex questions. A no-response is not an invitation to spam indefinitely.

Campaign financial allocation: budget in minor units and currency, approved spend by model/channel, reserved outstanding obligations, incurred charges, paid charges, refunds/credits, soft threshold and hard cutoff; show available funds by campaign and organization. Campaign owner may reallocate up to available unencumbered funds within their permissions; transfer is a ledger event, not overwrite. Never infer payment from email text alone.

## 8. Unified conversation and relationship management

Implement two-way email first, using per-tenant OAuth mailboxes/provider APIs or scoped SMTP/IMAP if provider permits; never send from a purported third party or simulate message delivery. Inbound provider push webhook plus periodic bounded reconciliation; enforce verified webhook signatures, account tokens, folder cursors and deduplication. Provider email Message-ID, In-Reply-To, References, conversation/thread IDs, sender/recipient and provider UID are stored and normalized to a single Conversation entity. Support CC, attachments, HTML plain-text rendering, timezone and unsubscribe handling.

Message record has: direction, channel, external IDs, message metadata, tenant/contact/account/campaign, source connector, normalized body, raw content object reference with retention, attachments with safe scan, generated versus owner-written authorship, draft revision, transport status, timestamps (created, approved, sent, accepted, delivered when evidence available, bounced, opened only if tracked ethically), suppression flags, responding agent/human, event correlation and audit trail.

Inbox UI: three-pane on desktop (thread list, message transcript + compose, contact/campaign context); two-pane tablet and stack/drilldown mobile. Human takeover, manual edits, send-now after preview, reschedule, pause sequence, mark do-not-contact, link duplicates, label/assign, internal notes, export, and redact/deletion workflows. Every model-generated draft is tagged as such internally; represent machine identity truthfully and comply with disclosure laws. Agents only act under owner-approved identities and sender domains. Set SPF, DKIM, DMARC and bounce management before live mass campaign.

Other channels are interfaces, not implied features: calendar, CRM import/export, payments/subscriptions, company research and grant databases, customer support chat, SMS/voice (disabled pending permissions/consent/regulatory review). Provider TOS, consent and rate limits checked independently. No scraping of private contact details from prohibited sources. Avoid tracking pixels by default and do not treat uncertain open rates as outcomes.

## 9. Database design (authoritative tables and integrity)

Every tenant-owned record has tenant_id, immutable ULID/UUID identifier, created_at, updated_at, optimistic version and soft deletion/retention as appropriate. Use Postgres RLS in addition to application RBAC; sensitive admin operations require elevated authenticated role and explicit audit. Core tables grouped:

- tenancy: organizations, memberships, users, roles, auth_identities, integration_connections, key_references, policy_versions, preferences, approvals, audit_events.
- portfolio: projects, offers, product_versions, product_facts_and_sources, campaigns, campaign_revisions, campaign_buckets, target_segments, assignments, allocation_rules, schedules.
- agents: approved_persona_names, agent_instances, agent_capabilities, agent_model_policies, agent_status_events, agent_runs, agent_run_steps, checkpoints, work_items, work_item_leases, tool_proposals, tool_results.
- leads: accounts, contacts, lead_source_provenance, contact_methods, consents, suppression_entries, frequency_caps, relationship_owners, contact_tags, qualification_evidence, dedupe_matches.
- communications: mailbox_connections, provider_sync_cursors, conversations, participants, messages, drafts, delivery_attempts, external_receipts, attachments, inbound_webhook_inbox, followup_sequences, sequence_steps, scheduled_messages.
- commerce: pipelines, pipeline_stages, deals, proposals, quotes, subscriptions, transactions, payment_receipts, attribution_links, refunds, cancellations.
- funding: funding_sources, investor_organizations, grant_programs, eligibility_rules, funding_opportunities, funding_applications, deadlines, requested_documents, diligence_checklists, commitments, awards, disbursements, funding_restrictions.
- models: providers, model_revisions, endpoint_configs, model_capabilities, provider_health, inference_requests, inference_usage, prompt_versions, model_eval_cases, model_eval_results.
- optimization: strategy_revisions, experiments, experiment_arms, experiment_enrollments, exposure_events, outcome_events, conversion_windows, experiment_decisions.
- finances: budget_accounts, campaign_allocations, monetary_reservations, ledger_entries, invoices, provider_usage_reconciliation, budgets, rate_caps, budget_policy_revisions.
- operations: jobs, job_attempts, outbox, event_inbox, evidence_documents, notifications, incidents, approvals, audit_exports, retention_tasks.

Critical unique indexes/invariants:
- unique tenant+provider+external event ID for incoming webhooks; unique tenant+mailbox+provider message ID; only one running lease per work item/fencing generation; only one active campaign/contact ownership when configured; one campaign/contact/sequence-step outbound idempotency key; unique immutable experiment enrollment per contact and experiment revision; no monetary ledger update/delete; unique per-tenant roster identity when instantiated.
- Suppression lookup enforced across *all* campaigns of the tenant plus legally mandatory shared suppression where permitted. A replied opt-out must suppress before another scheduled step dispatches.
- Referential integrity and per-tenant foreign keys (or RLS plus compound FK) prevent cross-tenant links; provider/model IDs are immutable snapshots for audited decisions.
- PII minimization and encrypted selected sensitive fields; separate secrets store never in tables except key refs and scoped encrypted OAuth tokens.
- All money uses integer minor units + ISO currency; explicit FX source/time on conversions. Server UTC timestamps, client localized. Analytics never compare currencies without normalization.

## 10. Public and private API contracts

Versioned REST /api/v1 with generated OpenAPI and Zod schemas. Minimum resource groups:
- GET projects, POST campaigns, PATCH campaigns/:id/revision, POST campaigns/:id/validate, POST campaigns/:id/approve, POST campaigns/:id/activate, POST campaigns/:id/pause
- GET agents, POST agents, PATCH agents/:id, POST assignments, DELETE assignments/:id, GET agents/:id/events, GET agents/:id/runs
- GET contacts, POST leads/import (staging + dedup + approval), GET conversations/:id, POST conversations/:id/drafts, POST drafts/:id/approve-and-send, POST conversations/:id/takeover, POST contacts/:id/suppress
- GET strategies, POST strategy-revisions, PATCH campaigns/:id/allocation, GET experiments/:id/outcomes, POST experiments/:id/promote
- GET opportunities, POST grant-applications/:id/submit-for-review, POST owner-actions/:id/resolve
- GET budgets, POST budget-transfers, GET provider-usage, GET audit-events, GET jobs/:id/evidence
- POST connectors/:provider/oauth/callback, POST webhooks/:channel (signed), GET exports/:id
- GET /events scoped SSE. All list APIs cursor-page, filter, full-text search, server sorting and bounded size; raw tables hidden behind graph/card visualizations until drilldown.

Use org-bound short sessions, CSRF validation, RBAC/ABAC (role + campaign scope + contact jurisdiction + channel grants). Optimistic concurrency required for campaign edits, assignment drag/drop and human/agent takeover. Mutations accept idempotency keys, correlation IDs and require audit. Model requests are not exposed as generic browser-proxy endpoints. Integration tools allowlisted and typed, with no arbitrary URL fetch or direct DB query by agents.

## 11. Security, privacy and compliance gates

Threat model: malicious inbound email or website instructions; data exfiltration from LLM/tool calls; forged webhooks; duplicate outbound sends; unauthorized access to contact PII; model prompt injection and hallucinated claims; abuse of OAuth scopes; SMS/email spam; misleading investment/medical/product promises; over-spending; cross-tenant data access; supply-chain compromise of open-weight custom code; insider credential misuse.

Controls:
- Deny-by-default execution capabilities; no outbound actions until channel configured, lawfulness verified, sender validated, owner-approved campaign active and spend >0. Model prompt NEVER overrules owner/tenant policy.
- Encrypt TLS across transport; encrypt DB/object backups and PII at rest; rotate scoped tokens/keys in secret manager. True end-to-end encryption cannot be promised for normal third-party email or plaintext provider inference; document explicit trust boundaries and restrict processors.
- Distinct workload identities per worker, endpoint and provider, just-in-time scoped credentials; prevent SSRF with egress allowlists, URL validation, IP restrictions and sandbox. No arbitrary shell/HTTP/email provider access by model.
- Verify OAuth state/PKCE, webhook HMAC and replay windows, SPF/DKIM/DMARC sending identities, host/path restrictions; sanitize HTML and attachments and run AV scanning.
- RBAC/ABAC + Postgres RLS + tenant isolation tests; MFA for owner; require reauth for increasing spending/credential permissions.
- PII controls: data purpose, minimization, consent/lawful basis evidence, retention/deletion/export, region policy, processor configuration, breach procedure and provider data-training/retention review.
- Outbound compliance: CAN-SPAM truthfulness, accurate header/subjects, postal address when required, functioning opt-out processed promptly, monitor complaints/bounces, per-recipient and domain limits, suppression across every agent. Other countries' ePrivacy/GDPR/CASL rules must be configured or those jurisdictions blocked. TCPA/telemarketing rules gate voice/SMS. Sources: https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business
- Investor communications: offerings, general solicitation, accreditation verification and broker-dealer concerns are policy-controlled and require qualified legal review and owner authorization; no autonomous orders, monetary promises or closing investment. Source: https://www.sec.gov/resources-small-businesses/exempt-offerings/general-solicitation-rule-506c
- Grant ethics: source-authoritative eligibility, verify tax/entity/document facts, track representations and evidence, prevent false statements, owner approves submission.
- Product claims: every measurable claim carries source_id, effective date and reviewed status; otherwise label draft/unsupported and block outbound.
- Crisis controls: pause all campaigns, revoke connector tokens, suspend one model/provider, quarantine queue and stop recurring followups; incident state immediately visible in UI.
- Compliance engine returns deterministic ALLOW, OWNER_REVIEW or DENY with rule IDs; approvals scoped to exact content hash, campaign revision, sender, recipient class, channel, budget and expiry. No generic 'approve anything' blanket.
- Immutable/append-only audit events with signatures/hashes and externally retained backups; audit correctness verified rather than asserted.

## 12. Costs, budgeting and economics

Default hard cap = USD 0 for paid APIs, GPU rentals, paid data providers and outbound billable channels, on organization/campaign/provider/model levels until the owner explicitly funds and authorizes them. $0 permits offline design, fake-data QA, dry-run and deterministic tests only.

Reservation protocol: before a metered operation, calculate approved worst-case input/output/context/tool estimate and reserve from budget in a serializable transaction (or wallet locking with monotone version), decrement available funds; if insufficient, do NOT call provider. After metered use, reconcile actual provider-reported usage, release unused reserve, record FX and price snapshot. Provider free-tier may be used only if its documented limit is truly free and owner explicitly enables it; no assumption that a paid ChatGPT seat credits API use.

Budgets have organization daily/monthly cap, campaign overall/daily cap, provider cap, model cap and contact cost cap with most restrictive precedence. Threshold alerts and hard stops, outstanding commitments, concurrency control, emergency kill switch. Disabling a model cannot discard invoices for already incurred requests. Charts distinguish estimated, reserved, incurred, invoiced and paid costs.

Promote efficient models using net contribution margin (including compute, enrichment, outreach provider costs and human review) not raw revenue or token price in isolation. Provide scenario planner estimating number of qualified outreaches/agent-hours per budget, but simulations clearly marked estimates.

## 13. Eventing, retries, observability and recovery

System event envelope: id, tenant_id, aggregate_type/id/version, event_type, occurred_at UTC, producer, correlation/causation IDs, actor_type/id, policy_version, payload schema version, relevant provenance hash. Transactional outbox and durable inbound event inbox, asynchronous projection worker; unique keys make consumers idempotent.

Agent heartbeat every short bounded interval while working, hard execution timeout, lease fencing generation, safe stop when owner pauses or budget hits zero. On worker death, watchdog marks run RECOVERING, inspects external provider/outbound outcome, then requeues if safe. Without authoritative send acknowledgment, move to manual-reconciliation rather than blindly re-sending.

Dashboards include alerts for stuck webhooks, stale mail sync, budget overruns, external 429s, API routing failures, unsigned webhook attempts, reply classification failures, compliance exceptions, queue age and sender reputation. Human-friendly incident page with remediation and evidence links. Activity timestamps come from persisted events, with source and freshness indicated.

SLO goals (to validate under load, not promised current performance): 99.5% app availability initial target; p95 UI action <500ms when no external API; campaign pause reflected in dispatcher within 5s; inbound sync within 60s when provider push is healthy; no knowingly duplicate outbound sends; zero cross-tenant data disclosure in tests; spending never initiated above hard cap. Latency and throughput reviewed before graduation.

## 14. Deployment, separation and disaster recovery

Separate environments: dev/local with synthetic data and stub providers, staging with restricted test sender and zero-dollar budgets, production with distinct secrets, domains, DB and object store. No production leads in test logs. Infrastructure as code, explicit resource creation plan requiring spending approval. CI builds and tests without network credentials or paid API invocation.

Initial footprint: one web container (Render or equivalent), Neon Postgres in this project's own DB/project, one worker process disabled/scale-to-zero when unfunded, secure object store, mail OAuth connectors only after owner authorizes, dedicated domain with TLS, error telemetry with redaction. Because true cold scale-to-zero may differ by hosting provider, use scheduler/queue-drain compatible with selected service rather than inventing an always-free feature.

Secrets inventory: DATABASE_URL, AUTH_SECRET/session signing, ENCRYPTION_KEY/KMS references, OBJECT_STORE credentials, OPENAI_API_KEY, ANTHROPIC_API_KEY, XAI_API_KEY, MODEL_INFERENCE_ENDPOINT_URL+TOKEN per open weight model, EMAIL_PROVIDER OAuth IDs and secrets, WEBHOOK_SIGNING keys, payment provider credentials (only if commerce activated), telemetry tokens; all optional disabled integration paths fail closed.

Backup: automatic encrypted point-in-time database recovery where available, routine encrypted backup to independent storage, immutable audit copies, verified object-store versioning and periodic restoration drill. Define RPO <=24h initially for business data backup and target RTO <=24h, improve before paid customers. Email external provider is source evidence but not complete replacement for app event history. Avoid developer accounts/shared databases from other products.

Horizontal scale: stateless API with tenant-aware read caching; queue sharding by tenant/campaign and deterministic contact ownership; worker concurrency set by provider rate limits and budget; partition large event/message tables by time/tenant as volumes justify; archival hot/cold separation; analytics read replicas/warehouse only when measured. Support millions of registered *identity records* without pretending to run millions of simultaneously paid model sessions. No pre-allocation of provider/GPU resources to idle agents.

## 15. Test strategy and acceptance gates

Architecture acceptance before dev PR roadmap:
- Canonical typed entities, state machines, budget ledger invariants, privacy boundaries, event definitions and six adapters all specified.
- Usable owner journeys: create product+campaign, enable bucket, drag Fast Eddie/ Harry, set strategy ratio, edit outreach, allocate zero-dollar budget, preview, inspect blocked launch; reply management; grant application review; pause-all.
- Dedicated UI design/responsive and first-party movie name roster preserved as registry files.
- Concrete deployment controls, threat model, recovery and cost policies; external citations and version review recorded.
- No model weights, actor likenesses or contact PII committed.

Implementation acceptance (for later roadmap, **not** PR sequence here):
- Unit and property tests for state transitions, budgeting, suppression, assignment exclusivity, randomized treatment, attribution and duplicate events.
- API integration tests across all six provider adapters using deterministic mocks; opt-in live smoke tests only when keys/budgets approved. Format/finish/refusal/error modes covered.
- E2E responsive UI keyboard/touch/mouse, screen readers, avatar hover/tap, cross-project drag/drop and ledger/draft/review workflows.
- Chaos tests for worker crash mid-send, bounced email, rate-limit storms, stale OAuth tokens, provider outage, delayed webhook, double spend race; cancellation should always win before dispatch.
- Security tests: tenant isolation/RLS, CSRF/SSRF, XSS from inbound HTML, webhook forgery, prompt injection, audit tamper, supply chain, secrets scanning.
- Communications deliverability smoke tests with safe test accounts, unsubscribe processing, complaint handling; no real prospect outreach in CI.
- Load tests with synthetic agents and tenant partitions at 100, 10k and 1M *registered identities* separately from bounded active jobs. Baseline SLO and genuine deployment verified before 'working' claims.

## 16. Decisions, risks and unresolved prerequisites

Decisions:
1. Standalone API-native product, not a Boardroom UX tab.
2. Modular monolith + durable workers first; defined extractable service boundaries for eventual scale.
3. All agents are stateless executions with durable identities/checkpoints.
4. True single-thread ownership at contact-sequence scope; many agents per product.
5. Approved provider/model catalog with per-campaign routing, fail-closed origin verification and structured adapter contract; no GPU weights in Git.
6. Model choice and strategy choice evaluated separately, champion/exploration configured in interface.
7. Approved message/campaign owner authority; hard-stop budgets default $0.
8. Visual and responsive dark UI, no sales quotes; avatar and activity evidence visible on hover/click.
9. Scoped lawful channels only; opt-out and suppression enforced before send.
10. Separate tenant data/credentials from all other applications, with optional bounded API integrations.

Risks: open-weight inference can cost far more than hosted APIs at low utilization; top public model rankings do not predict outbound-sales outcomes; outbound deliverability constraints affect scale; insufficient training data for causal inference; licensing/publicity risk of movie character photos; grant/investor regulations are jurisdiction- and offering-specific; telemetry/training processors may access lead data; model/provider prices can change rapidly; scalable costs are demand-sensitive, not intrinsically free.

Prerequisites for real operation (not for writing architecture): owner supplies per-provider API/inference access and funds, email domain/mailbox and sender verification, business postal address and lawful contact source/opt-out policy, project descriptions/approved claims/pricing, preferred jurisdictions, production deployment/DB/store resources, and review of regulated investor solicitation. None are silently presumed available.

## 17. Next document

The **implementation/development PR plan must be written only after this architecture baseline and the companion interaction specification are complete and reconciled.** This document intentionally does NOT prescribe PR counts, numbering, or order. All implementation, CI, deployment and live traffic status remain unverified until corresponding work is actually built and tested.
