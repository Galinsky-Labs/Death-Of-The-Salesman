# Death Of The Salesman — Complete Development PR Plan

**Version 1 · 2026-10-18T16:53:39Z · 160 verified-for-planning work units across 13 phases.** Planned ≠ implemented. GitHub remains the authority for PR merges, CI and deployed release evidence. Roadmap IDs are immutable. The PR count is calculated from `registry/prs.json`, not guessed from GitHub ordinal PR numbers.

**Canonical plan:** [`registry/prs.json`](../registry/prs.json) using Boardroom's shared PR registry schema v1. This Markdown renders that same canonical unit set and must remain synchronized by validator. Read [`AGENTS.md`](../AGENTS.md), [`TECHNICAL_ARCHITECTURE.md`](TECHNICAL_ARCHITECTURE.md), and [`PRODUCT_INTERACTION_DESIGN.md`](PRODUCT_INTERACTION_DESIGN.md) before implementing a unit.

## Product rules that every PR must preserve

- Standalone **API-native** commercial sales and lawful fundraising suite; no hybrid ChatGPT scheduled-task integration. Models run as bounded API/inference jobs, not permanent minds.
- The owner's first two names are **Fast Eddie Felson** and **Harry Wormwood**; all 264 provided names remain reserved in `registry/approved-salesman-names.json`. Commercial tenants start empty. Original/rights-cleared avatars only.
- Desktop should match the approved dark, avatar-rich bucket board closely, but adapt to tablets and phones. **No random salesman quote in any screen.**
- Configurable champion vs experimental strategy ratio (proposed 50/50) and independent six-model routing, with real evidence and separate tests of model and strategy effects.
- **All paid model, GPU, data, email and infrastructure spending is disabled at $0 by default.** Real sends, grants, regulated investor representations, contractual commitments and cash movements require explicit owner authorization and policy gates.
- Security/privacy by default; deterministic checks after model output, per-lead ownership, universal opt-out, evidence-based statistics, no claims of verified outcomes from unverified model narratives.
- Treat the architecture as a specification. It is not proof the application is working. Unit acceptance is not the same as production operational acceptance.

## Recommended implementation order and release gates

**Gate G0 — architecture ready (merged #1):** design, agent roster and provider candidates merged. **Gate G1 — zero-cost clickable console (F1–F2):** owner can create projects, view agents, assign Fast Eddie and Harry to buckets, observe truthful demo/idle status and inspect cards, all offline. **Gate G2 — $0 agent simulation (F3–F4):** budget control, durable workers, approvals, audited proposals and fake tools demonstrated without keys. **Gate G3 — model-enabled drafting (F5 + selected F6/F7):** six provider implementations pass mocks, actual calls only with owner-provisioned keys and caps, and drafts grounded in approved product facts. **Gate G4 — consent- and approval-controlled sales pilot (F6–F8 + F12 live gate):** mail domain and opt-out verified, one bounded live test; don't infer go-live from merged code. **Gate G5 — optimization and funding (F9–F10):** strategy results, grant workflow, investor relations and funding receipts validated. **Gate G6 — full revenue operations and commercial readiness (F11–F12):** payment acceptance, privacy, recovery, scale and tenants tested where relevant.

**Scheduling:** Phase order establishes a preferred delivery sequence, not a global serial lock. An eligible unit can execute as soon as its explicit `dependsOn` dependencies are completed and all external prerequisites are met. Parallel work should use non-overlapping files/resources. Prioritize G1 and G2 under the current $0 constraint. Never block all work solely because a live-provider or infrastructure prerequisite is missing.

**PR discipline:** Each work unit is a proposed reviewable PR or independently verifiable PR-sized increment. Begin future PR titles with its `DOTS-NNN` ID. A unit may have multiple real follow-up PRs; update explicit `prs` only after GitHub creates each PR. Do not invent PR numbers, merge checks or status. A merged PR is source-accepted, but a feature can remain unverified until functional/live acceptance. Tests must run locally/CI against synthetic data and mocked APIs with no paid calls; opt-in real integrations are marked as external prerequisites.

**Milestone blocks and external requirements:**  `liveadapter`, `liveemail`, `infra`, `prod`, `realcanary`, `merchantcanary`, `commercial`, and `integrations` are conditional on specific credentials, spending, regulation, or cross-repository approvals as shown in their units. These dependencies do NOT authorize a spend or real outreach.

## Phase index

| Phase | Area | Units | Priority |
|---|---|---:|---|
| F0 | Architecture and canonical planning | 2 | P0 |
| F1 | Zero-cost technical foundation | 12 | P0 |
| F2 | Visual-first workspace and agent assignment | 15 | P0 |
| F3 | Budget, audit, eventing and safety control plane | 14 | P0 |
| F4 | Bounded agent runtime and synthetic autonomy | 11 | P0 |
| F5 | Six-provider model execution and evaluation | 15 | P1 |
| F6 | CRM, lead integrity and revenue pipeline | 12 | P1 |
| F7 | Campaign Studio, content and authorization | 12 | P1 |
| F8 | Unified communications and owner-managed outreach | 16 | P1 |
| F9 | Strategy Lab, rigorous experimentation and outcomes | 11 | P1 |
| F10 | Funding Agents, grants and investor relations | 14 | P1 |
| F11 | Revenue operations, integrations and product growth | 10 | P2 |
| F12 | Production hardening, deployment and extensibility | 16 | P1 |

---

## F0: Architecture and canonical planning (2 PR-sized work units; P0)

### DOTS-001 — Architecture and interaction baseline

**Scope:** Preserve approved system boundaries, visual specification, character roster and six-model catalog already merged in PR #1.

**Acceptance & verification:** The baseline files exist on main and PR #1 is verifiably merged.

**Dependencies:** None  
**External prerequisites:** None  
**Priority:** P0 · **GitHub PRs:** #1

### DOTS-002 — Canonical plan, contributor protocol and validation

**Scope:** Publish a single parseable PR registry, readable plan, AGENTS.md, graph validator and no-cost CI gate.

**Acceptance & verification:** Counts equal actual units; PR mappings are real; unresolved prerequisites block only gated units; DAG/schema tests pass.

**Dependencies:** DOTS-001  
**External prerequisites:** None  
**Priority:** P0 · **GitHub PRs:** #2


## F1: Zero-cost technical foundation (12 PR-sized work units; P0)

### DOTS-003 — TypeScript monorepo and application shell

**Scope:** Initialize Next.js/React app, separate API and worker packages, strict TypeScript, package lock and run scripts.

**Acceptance & verification:** Fresh clean checkout builds and starts with no external accounts or model keys.

**Dependencies:** DOTS-002  
**External prerequisites:** None  
**Priority:** P0 · **GitHub PRs:** #4

### DOTS-004 — CI quality, secret and dependency checks

**Scope:** Run static lint, typechecks, unit tests, build, secret scan and package vulnerability reporting in GitHub Actions.

**Acceptance & verification:** Deliberately failing test blocks merge; tests incur no paid calls and leak no credentials.

**Dependencies:** DOTS-003  
**External prerequisites:** None  
**Priority:** P0 · **GitHub PRs:** #5

### DOTS-005 — Validated environment and disabled-by-default integrations

**Scope:** Typed runtime configuration with example .env templates, distinct test/dev/stage/prod and zero-paid-spend defaults.

**Acceptance & verification:** Missing optional API keys disables adapters; malformed or unsafe production config fails closed.

**Dependencies:** DOTS-003  
**External prerequisites:** None  
**Priority:** P0 · **GitHub PRs:** #7

### DOTS-006 — Canonical domain contracts and OpenAPI

**Scope:** Create versioned shared schemas for projects, agents, campaigns, contacts, work items, events, approvals, usage and errors.

**Acceptance & verification:** Contract fixtures round-trip and strict validation rejects inconsistent schema versions.

**Dependencies:** DOTS-003  
**External prerequisites:** None  
**Priority:** P0 · **GitHub PRs:** #8

### DOTS-007 — Database migrations and transaction framework

**Scope:** Implement migrations, reversible local dev setup, unique IDs, UTC timestamps, transaction and schema helpers.

**Acceptance & verification:** Clean install and roll-forward migration work on disposable local Postgres without prod secrets.

**Dependencies:** DOTS-005, DOTS-006  
**External prerequisites:** None  
**Priority:** P0 · **GitHub PRs:** #9

### DOTS-008 — Tenant and membership domain

**Scope:** Persist organizations, owner users, memberships and organization-level settings with stable ownership keys.

**Acceptance & verification:** Cross-tenant IDs cannot reference foreign organization's data at database boundaries.

**Dependencies:** DOTS-007  
**External prerequisites:** None  
**Priority:** P0 · **GitHub PRs:** #10

### DOTS-009 — Owner authentication and sessions

**Scope:** Secure passwordless/OIDC-capable owner login, session expiry, CSRF controls, MFA-ready admin policy.

**Acceptance & verification:** Anonymous and expired sessions cannot access owner dashboards or APIs.

**Dependencies:** DOTS-008  
**External prerequisites:** None  
**Priority:** P0 · **GitHub PRs:** #11

### DOTS-010 — Scoped authorization and human approval roles

**Scope:** Implement owner/admin/sales-manager/agent delegation scopes with endpoint and data filters.

**Acceptance & verification:** Agents never inherit owner-only authority; negative authorization tests cover every role.

**Dependencies:** DOTS-009, DOTS-006  
**External prerequisites:** None  
**Priority:** P0 · **GitHub PRs:** #12

### DOTS-011 — Postgres tenant row security and isolation tests

**Scope:** Enforce database tenant isolation with RLS, org-bound foreign keys and test connection roles.

**Acceptance & verification:** Attempted cross-tenant reads and writes fail, including ID guessing and joins.

**Dependencies:** DOTS-007, DOTS-010  
**External prerequisites:** None  
**Priority:** P0 · **GitHub PRs:** #13

### DOTS-012 — Synthetic fixture engine and safe preview mode

**Scope:** Seed deterministic synthetic accounts, agents, campaigns, threads and metrics for screenshots and demos.

**Acceptance & verification:** Demo clearly says 'Synthetic'; never sends outbound messages or calls metered inference.

**Dependencies:** DOTS-007, DOTS-006  
**External prerequisites:** None  
**Priority:** P0 · **GitHub PRs:** #15

### DOTS-013 — Encrypted artifact storage abstraction

**Scope:** Create object metadata schemas and adapter for local/test storage plus pluggable secure cloud object store.

**Acceptance & verification:** Artifacts are versioned, size-bounded, scanned where applicable, and tenant-isolated.

**Dependencies:** DOTS-007, DOTS-008  
**External prerequisites:** None  
**Priority:** P0 · **GitHub PRs:** #16

### DOTS-014 — Developer runbooks and architecture decision records

**Scope:** Document local dev, migrations, contract evolution, endpoint ownership, secret names and outage rollback.

**Acceptance & verification:** A new developer can set up demo mode without owner credentials or paid services.

**Dependencies:** DOTS-004, DOTS-012  
**External prerequisites:** None  
**Priority:** P0 · **GitHub PRs:** #17


## F2: Visual-first workspace and agent assignment (15 PR-sized work units; P0)

### DOTS-015 — Dark theme tokens and design system

**Scope:** Implement faithful navy/teal/purple styling, spacing, typography and responsive density from interaction spec.

**Acceptance & verification:** Desktop resembles reference; no random quote appears anywhere; tokens also support accessible light mode.

**Dependencies:** DOTS-003  
**External prerequisites:** None  
**Priority:** P0 · **GitHub PRs:** #18

### DOTS-016 — Accessible cards, overlays, charts and status chips

**Scope:** Build reusable focusable controls, popovers, avatar cards, chart primitives, skeletons and aria labels.

**Acceptance & verification:** Keyboard/screen-reader tests work; colored lights always have readable status labels.

**Dependencies:** DOTS-015, DOTS-006  
**External prerequisites:** None  
**Priority:** P0 · **GitHub PRs:** #20

### DOTS-017 — Responsive navigation and command bar

**Scope:** Implement collapsible side nav, project search, user controls, notification badge and mobile tabs.

**Acceptance & verification:** 1440/1024/768/390/320 px layouts do not clip content or require hover.

**Dependencies:** DOTS-016, DOTS-009  
**External prerequisites:** None  
**Priority:** P0 · **GitHub PRs:** #21

### DOTS-018 — Project/offer CRUD and fact versioning

**Scope:** Create project, offer, pricing-summary and vetted-product-fact CRUD endpoints with tenant/version safety.

**Acceptance & verification:** A project and offer can be created, edited, archived and reloaded independently by authorized owner.

**Dependencies:** DOTS-007, DOTS-010  
**External prerequisites:** None  
**Priority:** P0 · **GitHub PRs:** #22

### DOTS-019 — Project bucket selection and persistence

**Scope:** Persist bucket visibility, order, campaign linkage and owner project-filter preferences.

**Acceptance & verification:** Checkboxes hide/show only presentation buckets, without deleting assignments or tasks.

**Dependencies:** DOTS-018  
**External prerequisites:** None  
**Priority:** P0 · **GitHub PRs:** #23

### DOTS-020 — Agent identity CRUD and approved names

**Scope:** Add agent identity records referencing 264 approved names, with the first two identities available for opt-in seeding.

**Acceptance & verification:** Fast Eddie Felson and Harry Wormwood appear in private demo; commercial tenant has no prepopulated workers.

**Dependencies:** DOTS-007, DOTS-008, DOTS-012  
**External prerequisites:** None  
**Priority:** P0 · **GitHub PRs:** #24

### DOTS-021 — Original avatar pipeline and rights-safe placeholders

**Scope:** Support monograms/original portraits or user licensed images, image sizing and inaccessible-image fallback.

**Acceptance & verification:** No copyrighted actor/film stills are downloaded or committed by default.

**Dependencies:** DOTS-020, DOTS-013  
**External prerequisites:** None  
**Priority:** P0 · **GitHub PRs:** #25

### DOTS-022 — Server-derived three-state agent presence

**Scope:** Define green running lease, yellow waiting/review/queue, red inactive/error from authoritative run state.

**Acceptance & verification:** Simulated availability cannot masquerade as a live worker; exact last activity and reason visible.

**Dependencies:** DOTS-020, DOTS-006  
**External prerequisites:** None  
**Priority:** P0 · **GitHub PRs:** #27

### DOTS-023 — Searchable avatar roster component

**Scope:** Render agent tiles with top-right status light, role, assigned model, availability and search/filter.

**Acceptance & verification:** Works with 2 and 2,000 synthetic identities using virtualization/pagination and keyboard controls.

**Dependencies:** DOTS-016, DOTS-022, DOTS-021  
**External prerequisites:** None  
**Priority:** P0 · **GitHub PRs:** #28

### DOTS-024 — Hover/focus/tap agent detail preview

**Scope:** Implement accessible quick peek and expanded profile drawer with task, strategy, timestamps, events, results and spend.

**Acceptance & verification:** Preview shows only verified events, remains viewport-safe, and is usable without hover.

**Dependencies:** DOTS-023, DOTS-022  
**External prerequisites:** None  
**Priority:** P0 · **GitHub PRs:** none created (planned only)

### DOTS-025 — Multi-project agent assignment APIs

**Scope:** Add transactional campaign/project assignment, priorities, percentages, quotas, concurrency caps and version checks.

**Acceptance & verification:** Same agent can serve multiple buckets; stale conflicting updates return explicit retryable conflict.

**Dependencies:** DOTS-020, DOTS-018, DOTS-010  
**External prerequisites:** None  
**Priority:** P0 · **GitHub PRs:** #29

### DOTS-026 — Desktop visual drag-and-drop deployment board

**Scope:** Allow agents to be dragged into checked buckets and reallocated with optimistic updates and rollback.

**Acceptance & verification:** Persisted assignments match server after refresh; conflicting drop and unsaved state are surfaced.

**Dependencies:** DOTS-019, DOTS-025, DOTS-023  
**External prerequisites:** None  
**Priority:** P0 · **GitHub PRs:** none created (planned only)

### DOTS-027 — Touch and keyboard assignment alternatives

**Scope:** Add accessible action menus and keyboard move controls for touch and non-pointer users.

**Acceptance & verification:** Full assign/reassign/unassign flows work on mobile, screen reader and keyboard.

**Dependencies:** DOTS-026, DOTS-016  
**External prerequisites:** None  
**Priority:** P0 · **GitHub PRs:** none created (planned only)

### DOTS-028 — Visual overview and truthful KPI placeholders

**Scope:** Build summary dashboard with agents, campaign outcomes, state distribution, budget indicators and date filters.

**Acceptance & verification:** Production displays real/safely empty values; demo metrics are clearly marked synthetic.

**Dependencies:** DOTS-017, DOTS-022, DOTS-012  
**External prerequisites:** None  
**Priority:** P0 · **GitHub PRs:** #32 (read-only preview groundwork; live dashboard, date filters and production observation remain acceptance gates)

### DOTS-029 — Responsive screenshot and interaction regression suite

**Scope:** Add deterministic visual snapshots and interaction tests for core shell, roster, hover and buckets.

**Acceptance & verification:** Tests cover desktop/tablet/mobile breakpoints and no corner quote; failures produce artifacts.

**Dependencies:** DOTS-027, DOTS-028, DOTS-024  
**External prerequisites:** None  
**Priority:** P0 · **GitHub PRs:** none created (planned only)


## F3: Budget, audit, eventing and safety control plane (14 PR-sized work units; P0)

### DOTS-030 — Append-only audit and actor provenance

**Scope:** Record organization actor, event type, policy version, correlation ID and evidence for high-risk mutations.

**Acceptance & verification:** Writes are auditable and tenant-isolated; modifying an audit entry is denied.

**Dependencies:** DOTS-007, DOTS-010  
**External prerequisites:** None  
**Priority:** P0 · **GitHub PRs:** none created (planned only)

### DOTS-031 — Transactional outbox and idempotent event intake

**Scope:** Persist business mutation plus outbox atomically and dedupe external webhook/event IDs.

**Acceptance & verification:** Crash between commit and delivery does not lose state or create duplicate applied effects.

**Dependencies:** DOTS-030, DOTS-007  
**External prerequisites:** None  
**Priority:** P0 · **GitHub PRs:** none created (planned only)

### DOTS-032 — Money and invoice ledger domain

**Scope:** Create integer-minor-unit budget accounts, reservations, allocated/incurred/paid records and currency rules.

**Acceptance & verification:** No floating-point monetary amounts; double-entry invariants and reconciliation tests pass.

**Dependencies:** DOTS-007, DOTS-008  
**External prerequisites:** None  
**Priority:** P0 · **GitHub PRs:** none created (planned only)

### DOTS-033 — Hierarchical $0 spending policies

**Scope:** Enforce tenant/campaign/provider/model/channel caps, hard stops, soft alerts and daily/total ceilings.

**Acceptance & verification:** Every paid operation is blocked at default $0 even if the browser and agent ask to proceed.

**Dependencies:** DOTS-032, DOTS-010  
**External prerequisites:** None  
**Priority:** P0 · **GitHub PRs:** none created (planned only)

### DOTS-034 — Atomic estimate/reserve/settle/refund protocol

**Scope:** Reserve worst-case metered costs before execution; settle actual charges and release excess on completion.

**Acceptance & verification:** Concurrent requests never overrun shared hard cap; failures and timeouts release/reconcile correctly.

**Dependencies:** DOTS-032, DOTS-033  
**External prerequisites:** None  
**Priority:** P0 · **GitHub PRs:** none created (planned only)

### DOTS-035 — Visual campaign funding allocation console

**Scope:** Build spend gauges, funding allocation editor, model cost breakdown and no-money alerts.

**Acceptance & verification:** Unallocated balance and reservations reconcile to ledger; invalid/overbudget transfer rejected.

**Dependencies:** DOTS-033, DOTS-034, DOTS-016  
**External prerequisites:** None  
**Priority:** P0 · **GitHub PRs:** none created (planned only)

### DOTS-036 — Deterministic policy decision service

**Scope:** Build ALLOW/REVIEW/DENY rules for permissions, approved claims, sender, jurisdiction, suppression and spend.

**Acceptance & verification:** Agent prompt cannot bypass rule; each decision persists stable rule identifiers and reasons.

**Dependencies:** DOTS-030, DOTS-010, DOTS-033  
**External prerequisites:** None  
**Priority:** P0 · **GitHub PRs:** none created (planned only)

### DOTS-037 — Owner Action inbox and exact-hash approvals

**Scope:** Create owner review requests scoped to draft hash, audience, campaign revision, budget, identity and expiry.

**Acceptance & verification:** Changed content revokes approval; stale approvals cannot be replayed for different recipients.

**Dependencies:** DOTS-036, DOTS-016  
**External prerequisites:** None  
**Priority:** P0 · **GitHub PRs:** none created (planned only)

### DOTS-038 — Emergency pause-all and scoped kill switches

**Scope:** Stop agent dispatch by organization/campaign/provider/model; preserve queued tasks and audit rationale.

**Acceptance & verification:** Pause blocks external dispatch immediately even if prior approval exists; owner can resume safely.

**Dependencies:** DOTS-036, DOTS-031  
**External prerequisites:** None  
**Priority:** P0 · **GitHub PRs:** none created (planned only)

### DOTS-039 — Durable database task queue

**Scope:** Implement per-tenant keyed queue, retries, backoff, priority, dedupe and dead-letter handling.

**Acceptance & verification:** Worker restarts preserve pending tasks; repeated deliveries never duplicate business effects.

**Dependencies:** DOTS-007, DOTS-031  
**External prerequisites:** None  
**Priority:** P0 · **GitHub PRs:** none created (planned only)

### DOTS-040 — Worker lease, fencing and heartbeat

**Scope:** Implement atomic assignment slots, lease generations, heartbeat and stale-run fencing.

**Acceptance & verification:** Two workers cannot concurrently own the same work item; expired worker cannot commit protected output.

**Dependencies:** DOTS-039, DOTS-022  
**External prerequisites:** None  
**Priority:** P0 · **GitHub PRs:** none created (planned only)

### DOTS-041 — Encrypted integration credential reference store

**Scope:** Scope provider credentials, OAuth refresh tokens and encrypted secrets to tenant/provider, with rotation.

**Acceptance & verification:** API/logs never expose raw keys; unauthorized access and revocation tests pass.

**Dependencies:** DOTS-008, DOTS-010, DOTS-030  
**External prerequisites:** None  
**Priority:** P0 · **GitHub PRs:** none created (planned only)

### DOTS-042 — Traces, metrics and privacy-safe operational events

**Scope:** Add structured logs, queue and API metrics, error tracing, PII redaction and correlation IDs.

**Acceptance & verification:** Owner can diagnose failures without seeing secret tokens or raw unnecessary contact data.

**Dependencies:** DOTS-039, DOTS-030, DOTS-041  
**External prerequisites:** None  
**Priority:** P0 · **GitHub PRs:** none created (planned only)

### DOTS-043 — Data retention, export and correction foundations

**Scope:** Implement retention annotations, deletion request schema, export jobs, evidence holds and audit summaries.

**Acceptance & verification:** Deletion/retention policy prevents unnecessary long-term storage; test export remains tenant-scoped.

**Dependencies:** DOTS-030, DOTS-013, DOTS-011  
**External prerequisites:** None  
**Priority:** P0 · **GitHub PRs:** none created (planned only)


## F4: Bounded agent runtime and synthetic autonomy (11 PR-sized work units; P0)

### DOTS-044 — Work-item state machine and legal transitions

**Scope:** Implement CREATED/ELIGIBLE/RUNNING/WAITING/COMPLETED/FAILED/CANCELLED with compare-and-swap.

**Acceptance & verification:** Invalid transitions are rejected; idempotent retry returns prior outcome.

**Dependencies:** DOTS-039, DOTS-006  
**External prerequisites:** None  
**Priority:** P0 · **GitHub PRs:** none created (planned only)

### DOTS-045 — Safe agent schedule and project priority engine

**Scope:** Allocate work by explicit campaign priorities, agent quotas, legal windows and fair queue selection.

**Acceptance & verification:** Same lead is not double-worked; no model runs for idle avatars; timeout windows respected.

**Dependencies:** DOTS-044, DOTS-025, DOTS-040  
**External prerequisites:** None  
**Priority:** P0 · **GitHub PRs:** none created (planned only)

### DOTS-046 — Agent capability and role configuration

**Scope:** Manage agent role, allowed tools/channels, model policy, skills, campaign shares and pause state.

**Acceptance & verification:** Agent cannot execute a task outside its approved campaign or skill scope.

**Dependencies:** DOTS-020, DOTS-010, DOTS-045  
**External prerequisites:** None  
**Priority:** P0 · **GitHub PRs:** none created (planned only)

### DOTS-047 — Versioned agent context assembly

**Scope:** Build bounded task context from approved facts, thread history, assignment and source provenance.

**Acceptance & verification:** Retrieved email/website text treated as untrusted and cannot redefine tool privileges.

**Dependencies:** DOTS-044, DOTS-018, DOTS-046  
**External prerequisites:** None  
**Priority:** P0 · **GitHub PRs:** none created (planned only)

### DOTS-048 — Typed action-proposal and tool broker

**Scope:** Create allowlisted structured tool schemas with input/output validation and trace correlation.

**Acceptance & verification:** No arbitrary shell/URL/email/SQL execution is possible through free-form model text.

**Dependencies:** DOTS-036, DOTS-047  
**External prerequisites:** None  
**Priority:** P0 · **GitHub PRs:** none created (planned only)

### DOTS-049 — Short-lived execution run coordinator

**Scope:** Implement model request orchestration, steps, cancellations, deterministic limits and bounded retries.

**Acceptance & verification:** All runs exit and checkpoint; failures yield evidence without phantom activity.

**Dependencies:** DOTS-045, DOTS-048, DOTS-034  
**External prerequisites:** None  
**Priority:** P0 · **GitHub PRs:** none created (planned only)

### DOTS-050 — Durable memory and per-run checkpoints

**Scope:** Save run summaries, provenance-linked contact facts and replayable decision snapshots.

**Acceptance & verification:** New process resumes safely without relying on ChatGPT conversation memory.

**Dependencies:** DOTS-049, DOTS-030  
**External prerequisites:** None  
**Priority:** P0 · **GitHub PRs:** none created (planned only)

### DOTS-051 — Owner-gated external action dispatcher

**Scope:** Require exact policy review, current authorization, budget and deduplication before any outbound side effect.

**Acceptance & verification:** Unapproved, paused, suppressed or unfunded action cannot be dispatched, including on retry.

**Dependencies:** DOTS-048, DOTS-037, DOTS-038, DOTS-044  
**External prerequisites:** None  
**Priority:** P0 · **GitHub PRs:** none created (planned only)

### DOTS-052 — Orphan-run recovery and disputed action quarantine

**Scope:** Detect stale heartbeats, fence old runs and reconcile ambiguous external effects before retry.

**Acceptance & verification:** A crash mid-send triggers reconciliation instead of blind duplicate sending.

**Dependencies:** DOTS-040, DOTS-050, DOTS-051  
**External prerequisites:** None  
**Priority:** P0 · **GitHub PRs:** none created (planned only)

### DOTS-053 — Run history, evidence and error timeline UI

**Scope:** Show agents' model, strategy, messages drafted/sent, costs, waiting reasons and event timestamps.

**Acceptance & verification:** Agent card can explain every green/yellow/red state using persisted evidence links.

**Dependencies:** DOTS-024, DOTS-030, DOTS-049  
**External prerequisites:** None  
**Priority:** P0 · **GitHub PRs:** none created (planned only)

### DOTS-054 — $0 two-agent simulation end-to-end gate

**Scope:** Run Fast Eddie and Harry through project bucket assignment, fake CRM tasks and mocked tool proposals.

**Acceptance & verification:** No paid calls or outbound contact; complete UI-to-worker-to-checkpoint trace passes repeatedly.

**Dependencies:** DOTS-053, DOTS-052, DOTS-026, DOTS-012  
**External prerequisites:** None  
**Priority:** P0 · **GitHub PRs:** none created (planned only)


## F5: Six-provider model execution and evaluation (15 PR-sized work units; P1)

### DOTS-055 — Versioned model provider manifest and capability discovery

**Scope:** Extend six-model catalog into validated snapshots, revisions, limits, privacy and routing configuration.

**Acceptance & verification:** Each provider/model is displayed but disabled when missing credentials; upgrades do not rewrite history.

**Dependencies:** DOTS-006, DOTS-041  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-056 — Unified typed provider adapter contract

**Scope:** Define structured input/output, tool call normalization, refusal and usage/error metadata.

**Acceptance & verification:** Conformance fixtures cover schema failures, empty responses, streamed/nonstreamed output and cancellations.

**Dependencies:** DOTS-055, DOTS-048  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-057 — OpenAI Responses API adapter

**Scope:** Implement authenticated OpenAI API client with tool schema translation, usage capture and timeouts.

**Acceptance & verification:** Mocked traces match canonical model results; no consumer ChatGPT subscription assumed to be API credit.

**Dependencies:** DOTS-056, DOTS-034  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-058 — Claude Messages API adapter

**Scope:** Implement Anthropic adapter, provider-specific tool use and usage reconciliation.

**Acceptance & verification:** Mocked tool-use turns, refusal and token accounting pass without external calls.

**Dependencies:** DOTS-056, DOTS-034  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-059 — Grok API adapter

**Scope:** Implement xAI adapter with verified supported endpoint, tool/function calling and model capability detection.

**Acceptance & verification:** Mocks verify request/response mapping; unavailable account model fails closed.

**Dependencies:** DOTS-056, DOTS-034  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-060 — MiMo open-weight serving adapter

**Scope:** Support pinned MiMo-V2.6-Pro-RL endpoint and immutable deployment metadata with self/hosted serving configs.

**Acceptance & verification:** Manifest and mock health tests pass; repository contains no checkpoint weights.

**Dependencies:** DOTS-056, DOTS-055  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-061 — GLM open-weight serving adapter

**Scope:** Support pinned GLM-5.3 endpoint, provider-qualified schema and serving profiles.

**Acceptance & verification:** Manifest, license gate and mock inference pass; no GPU provisioned by test.

**Dependencies:** DOTS-056, DOTS-055  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-062 — Kimi open-weight serving adapter

**Scope:** Support pinned Kimi-K3 endpoint, context and reasoning parser config.

**Acceptance & verification:** Manifest, license gate and mock inference pass; no GPU download or rental by default.

**Dependencies:** DOTS-056, DOTS-055  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-063 — Opt-in external checkpoint installer specification and verification

**Scope:** Provide revision-pin/hash check, license confirmation, storage path, isolated inference setup and supply-chain controls.

**Acceptance & verification:** Dry-run reports weight volume and costs; real download is impossible without approved funding/storage.

**Dependencies:** DOTS-060, DOTS-061, DOTS-062  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-064 — Budget/privacy-aware model router

**Scope:** Select from six configurations by enabled capabilities, task class, owner weights and funded budget.

**Acceptance & verification:** Private-data rules prevent unauthorized fallback; zero-budget provider skipped without network.

**Dependencies:** DOTS-057, DOTS-058, DOTS-059, DOTS-060, DOTS-061, DOTS-062, DOTS-033  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-065 — Rate-limit, outage and circuit-breaker behavior

**Scope:** Retry transient failures with bounded exponential backoff and audit failover decisions.

**Acceptance & verification:** Timeout/429/5xx chaos tests never double-execute an outbound action or exceed budget.

**Dependencies:** DOTS-064, DOTS-052  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-066 — Canonical metered usage reconciliation

**Scope:** Track tokens, cache, reasoning, compute hours, provider invoices and immutable pricing versions.

**Acceptance & verification:** Dashboard spend reconciles with ledger and flags missing/estimated usage separately.

**Dependencies:** DOTS-064, DOTS-034  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-067 — Model catalog and per-agent/provider UI

**Scope:** Owner configures keys via secure flow, model selection, routing weights and health panels.

**Acceptance & verification:** UI discloses absent keys, cost status, privacy category and disabled models truthfully.

**Dependencies:** DOTS-064, DOTS-035, DOTS-017  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-068 — Deterministic six-model adapter benchmark harness

**Scope:** Run fixture-based draft, tool, compliance, quality and latency tests with stub provider responses.

**Acceptance & verification:** Six candidates compared without fabricated live performance or API charges.

**Dependencies:** DOTS-057, DOTS-058, DOTS-059, DOTS-060, DOTS-061, DOTS-062, DOTS-054  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-069 — Opt-in credential-backed live model smoke gate

**Scope:** Test real configured providers in bounded sandbox with cost receipt and reproducible result.

**Acceptance & verification:** Only explicitly funded models are exercised; failures report account/credential blockers, no assumed success.

**Dependencies:** DOTS-068, DOTS-066, DOTS-041  
**External prerequisites:** Explicit owner-funded provider API account(s), scoped API/inference keys and preapproved dollar caps; if unavailable record blocked live smoke, keep mocks passing.  
**Priority:** P1 · **GitHub PRs:** none created (planned only)


## F6: CRM, lead integrity and revenue pipeline (12 PR-sized work units; P1)

### DOTS-070 — CRM accounts and contacts domain

**Scope:** Implement organizations/people, aliases, contact methods, responsible owners and searchable metadata.

**Acceptance & verification:** Contact data remains tenant-isolated and cannot silently merge unrelated organizations.

**Dependencies:** DOTS-007, DOTS-011  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-071 — Lawful lead source and import staging

**Scope:** Build import validation, source provenance, purpose/consent fields and preview-before-commit.

**Acceptance & verification:** Invalid or unlawfully sourced records are quarantined; no automatic contact is sent.

**Dependencies:** DOTS-070, DOTS-013  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-072 — Entity dedupe and contact identity resolution

**Scope:** Normalize and compare email/domain/organization, present merge review and preserve original sources.

**Acceptance & verification:** Duplicates do not trigger double outreach or lose historical conversation identity.

**Dependencies:** DOTS-071  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-073 — Universal do-not-contact and consent status

**Scope:** Implement suppression lists, consent evidence, legal region policies and contact frequency limits.

**Acceptance & verification:** Suppressed contact cannot be queued or sent from any agent/campaign; overrides require lawful audit.

**Dependencies:** DOTS-070, DOTS-036  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-074 — Prospect ownership and overlap conflict controls

**Scope:** Allocate each campaign/contact sequence to one active agent and enforce tenant-wide exclusions.

**Acceptance & verification:** Parallel agents may sell same product but cannot contact the same prospect twice inadvertently.

**Dependencies:** DOTS-072, DOTS-073, DOTS-045  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-075 — Audience segmentation and saved lead filters

**Scope:** Provide segments by allowed firmographics, customer signals, source and eligibility.

**Acceptance & verification:** Segment preview shows count and exclusions, without creating paid inference.

**Dependencies:** DOTS-070, DOTS-071  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-076 — Evidence-backed relationship event timeline

**Scope:** Link contact source, segmentation, outreach, inbound message, notes and stage transitions.

**Acceptance & verification:** Every visible contact event has timestamp, actor and source; unverified model statements aren't facts.

**Dependencies:** DOTS-070, DOTS-030  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-077 — Configurable product sales pipeline state machine

**Scope:** Persist qualified/proposal/trial/negotiation/won/lost stages with guarded transitions.

**Acceptance & verification:** Stage movement requires evidence rules and never makes up a conversion.

**Dependencies:** DOTS-070, DOTS-006  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-078 — Deal, quote and opportunity objects

**Scope:** Create multi-contact deals linked to product and campaign, values, probability labels and expected-close dates.

**Acceptance & verification:** Forecasted value differs from invoiced and cash received, with verified references.

**Dependencies:** DOTS-077, DOTS-018, DOTS-032  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-079 — Conservative touchpoint attribution

**Scope:** Connect outcomes to leads/campaigns with verifiable receipts and deduped first/last-touch windows.

**Acceptance & verification:** Attribution never double-counts one closed deal as two paid wins.

**Dependencies:** DOTS-076, DOTS-078  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-080 — Visual lead cards, account maps and pipeline boards

**Scope:** Implement drag stage cards and rich contact inspector with search and bulk review.

**Acceptance & verification:** Owner operates CRM without dense mandatory tables, on desktop and touch screen.

**Dependencies:** DOTS-077, DOTS-075, DOTS-017  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-081 — Synthetic CRM scale and privacy regression

**Scope:** Run 50k synthetic contacts, multi-tenant isolation and duplicate/suppression tests.

**Acceptance & verification:** P95 interactions and query pagination stay bounded; no PII escapes into logs.

**Dependencies:** DOTS-080, DOTS-072, DOTS-073, DOTS-011  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)


## F7: Campaign Studio, content and authorization (12 PR-sized work units; P1)

### DOTS-082 — Campaign lifecycle and immutable revisions

**Scope:** Implement DRAFT/VALIDATED/APPROVED/SCHEDULED/ACTIVE/PAUSED/COMPLETED transitions with versioned audiences and budgets.

**Acceptance & verification:** Only permitted state transitions apply; edits to approved copy create new reviewable version.

**Dependencies:** DOTS-018, DOTS-030, DOTS-033  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-083 — Visual campaign builder and offer selection

**Scope:** Create split-pane campaign studio: goal, product, segment, sender, channels, copy, task buckets and progress.

**Acceptance & verification:** Owner can save and restore campaign drafts with clean empty-state visuals.

**Dependencies:** DOTS-082, DOTS-017, DOTS-075  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-084 — Rich email, pitch and landing-copy editor

**Scope:** Support versioned templates, factual claim slots, variables, previews and safe HTML/plain text.

**Acceptance & verification:** Owner can edit and approve exact rendered copy; XSS attempts sanitized.

**Dependencies:** DOTS-083, DOTS-013  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-085 — Claim registry, citations and freshness checks

**Scope:** Attach verified sources and effective dates to product, grant and investment representations.

**Acceptance & verification:** Unsupported numerical claims are flagged and cannot pass automated outbound approval.

**Dependencies:** DOTS-018, DOTS-036, DOTS-084  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-086 — Offer price and discount guardrails

**Scope:** Add offer conditions, authorized quoted prices, restricted claims and approval exceptions.

**Acceptance & verification:** Agent cannot invent prices or promise unapproved outcomes in draft or quote.

**Dependencies:** DOTS-018, DOTS-036  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-087 — Jurisdiction, business-hours and cadence rules

**Scope:** Enforce country/channel scope, quiet hours, frequency, suppression, domain reputation and sending caps.

**Acceptance & verification:** Forbidden campaign combinations fail validation with plain-language reasons.

**Dependencies:** DOTS-075, DOTS-073, DOTS-036  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-088 — Editable campaign strategy and copy variants

**Scope:** Attach multiple strategy/copy revisions with eligibility constraints and source version.

**Acceptance & verification:** Every generated message traces to exact approved strategy and content revision.

**Dependencies:** DOTS-084, DOTS-082  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-089 — Campaign simulation and send-plan preview

**Scope:** Dry-run sampled synthetic contacts with render, predicted max costs, exclusions and tool actions.

**Acceptance & verification:** No real people contacted and no billable inference; owner sees each blocking reason.

**Dependencies:** DOTS-083, DOTS-085, DOTS-087, DOTS-033  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-090 — Owner campaign approval and revision invalidation

**Scope:** Securely review sender, audience, channel, total budget, exact message revision and schedule.

**Acceptance & verification:** Any material audience/copy/budget change revokes stale approvals and requires re-review.

**Dependencies:** DOTS-089, DOTS-037  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-091 — Campaign work generation and safe scheduling

**Scope:** Enqueue contact/campaign work within active approved limits, priority and quotas.

**Acceptance & verification:** Paused, future-start or denied campaigns never dispatch; duplicate queue insertion dedupes.

**Dependencies:** DOTS-090, DOTS-045, DOTS-051  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-092 — Visual campaign timeline, goals and control room

**Scope:** Show project bucket progress, funnel, expenses, proposed outreach and owner decisions.

**Acceptance & verification:** Metrics source visibly distinguishes draft, scheduled, actually sent and revenue received.

**Dependencies:** DOTS-091, DOTS-028  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-093 — Policy-oriented campaign E2E tests

**Scope:** Test draft->review->approved->queued->paused scenarios, concurrent edits and budget exhaustion.

**Acceptance & verification:** No send or paid request occurs in prohibited states, including race condition tests.

**Dependencies:** DOTS-092, DOTS-089  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)


## F8: Unified communications and owner-managed outreach (16 PR-sized work units; P1)

### DOTS-094 — Tenant-scoped mailbox onboarding

**Scope:** Implement supported OAuth mail provider connection, sender authentication checks and token rotation.

**Acceptance & verification:** Mail integration remains disabled until the owner grants account consent; no global shared sender.

**Dependencies:** DOTS-041, DOTS-009  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-095 — Authenticated inbound webhooks and bounded polling

**Scope:** Verify push signatures, replay windows, mailbox sync cursors and attachment safety staging.

**Acceptance & verification:** Out-of-order, duplicate and forged events are handled without adding fake replies.

**Dependencies:** DOTS-094, DOTS-031  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-096 — Canonical conversations and provider threading

**Scope:** Normalize mail IDs, references, CC, bodies, participants and provider delivery states into threads.

**Acceptance & verification:** Replies attach to correct contact/campaign; duplicate imports idempotent.

**Dependencies:** DOTS-095, DOTS-070, DOTS-072  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-097 — Visual Conversation Center with full timelines

**Scope:** Build three-pane inbox, transcript, contact context, follow-up status and mobile drilldown.

**Acceptance & verification:** Agent/owner can find and inspect a thread with accurate sender/time/delivery labels.

**Dependencies:** DOTS-096, DOTS-017  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-098 — Versioned outbound draft pipeline

**Scope:** Create model/human-authored drafts with source evidence, headers, recipients, variables and expiry.

**Acceptance & verification:** Owner can edit content; AI-generated text not mislabeled as verified fact.

**Dependencies:** DOTS-097, DOTS-084, DOTS-047  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-099 — Owner message composer and approvals

**Scope:** Implement rich/plain-text preview, reply/forward, attachment selection and exact-message owner approval.

**Acceptance & verification:** Content edits invalidate previously approved sends; focus and paste are safe on mobile.

**Dependencies:** DOTS-098, DOTS-037  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-100 — Least-privilege outbound email transport gateway

**Scope:** Implement authorized email send with provider idempotency key, sender validation, policy recheck and secure receipt.

**Acceptance & verification:** No send unless all current approval, suppression, domain, budget and identity conditions hold.

**Dependencies:** DOTS-094, DOTS-051, DOTS-099, DOTS-073, DOTS-091  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-101 — Outbound status, retries and ambiguity quarantine

**Scope:** Capture provider accepted/bounced/failed receipts and uncertain-send reconciliation.

**Acceptance & verification:** Transport timeout does not create a second email; unmatched responses need owner reconciliation.

**Dependencies:** DOTS-100, DOTS-052  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-102 — Unsubscribe headers and cross-campaign opt-out ingestion

**Scope:** Add required unsubscribe mechanisms, tenant postal-address config and high-priority suppression processing.

**Acceptance & verification:** Opt-out immediately blocks pending sequences and is auditable; no sender launch if required profile missing.

**Dependencies:** DOTS-100, DOTS-073  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-103 — Bounce, spam complaint and sender health controls

**Scope:** Record delivery failures, complaint rate, domain caps and automatic risk pauses.

**Acceptance & verification:** High-complaint campaigns pause; known invalid addresses are suppressed.

**Dependencies:** DOTS-101, DOTS-102  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-104 — Reply triage and safe suggested response

**Scope:** Classify interested/not-interested/question/opt-out/ambiguous with uncertainty, owner escalation and citations.

**Acceptance & verification:** Opt-outs processed deterministically, not dependent solely on model classification; uncertain replies escalate.

**Dependencies:** DOTS-096, DOTS-048, DOTS-051  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-105 — Cadenced follow-up sequence scheduler

**Scope:** Schedule authorized follow-ups with max touch count, quiet hours, cancellation on reply and opt-out.

**Acceptance & verification:** Reply, pause, or suppression before dispatch cancels queued followup without race.

**Dependencies:** DOTS-104, DOTS-091, DOTS-087  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-106 — Human takeover, conversation ownership and SLA

**Scope:** Owner can claim a thread, edit/respond, pause agent, release ownership and prioritize replies.

**Acceptance & verification:** Agent cannot send while owner owns the conversation unless explicitly delegated.

**Dependencies:** DOTS-097, DOTS-051, DOTS-105  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-107 — Attachment handling, scanning and safe downloads

**Scope:** Scan, store, authorize, render or quarantine inbound and proposal attachments.

**Acceptance & verification:** Malware, oversized files and forbidden types do not reach model/tool execution.

**Dependencies:** DOTS-095, DOTS-013  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-108 — Simulated end-to-end inbox and send reconciliation

**Scope:** Test full mock response loop, signed events, opt-out, bounce, human takeover and crash mid-send.

**Acceptance & verification:** All interaction/UI tests pass without a real mailbox, money or customer outreach.

**Dependencies:** DOTS-100, DOTS-101, DOTS-102, DOTS-103, DOTS-106, DOTS-107  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-109 — Owner-authorized real mailbox canary

**Scope:** With connected test mailbox, verify domain settings, legitimate test recipients, provider receipts and opt-outs.

**Acceptance & verification:** Live canary evidence recorded; only explicitly enabled sender/test contacts receive messages.

**Dependencies:** DOTS-108, DOTS-094, DOTS-090  
**External prerequisites:** Owner-authorized mailbox and sender domain, required physical postal address, configured unsubscribe and lawful test recipient(s).  
**Priority:** P1 · **GitHub PRs:** none created (planned only)


## F9: Strategy Lab, rigorous experimentation and outcomes (11 PR-sized work units; P1)

### DOTS-110 — Strategy definitions, versioning and constraints

**Scope:** Create strategy families, audience rules, allowed personalization, forbidden claims and immutable revisions.

**Acceptance & verification:** Owner can modify a proposed new revision without mutating historical experiments.

**Dependencies:** DOTS-088, DOTS-085  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-111 — Strategy Lab cards, sliders and allocation rules

**Scope:** Expose per-campaign champion/experimental percentages (suggested default 50/50) plus configurable min exploration.

**Acceptance & verification:** Saved sliders change actual allocation rules; no hidden hardcoded split.

**Dependencies:** DOTS-110, DOTS-016  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-112 — Deterministic randomized experiment enrollment

**Scope:** Enroll eligible lead exactly once per experiment revision, balanced/stratified by segment and campaign.

**Acceptance & verification:** Repeated workers/runs use same arm and seed; no cross-experiment duplicate exposures.

**Dependencies:** DOTS-111, DOTS-074  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-113 — Verified exposure and outcome event accounting

**Scope:** Capture sent, reply, qualified response, meeting, deal, funds received, spam and costs with evidence.

**Acceptance & verification:** Stats cannot count imagined 'closed' or model claims as receipts.

**Dependencies:** DOTS-112, DOTS-079, DOTS-101  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-114 — Materialized performance metrics and source visibility

**Scope:** Compute per-qualified-outreach margin, cost, conversion, complaint rate and cohort outcomes.

**Acceptance & verification:** Dashboard separates actual vs estimated, currency conversions, periods and denominator sizes.

**Dependencies:** DOTS-113, DOTS-066, DOTS-032  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-115 — Confidence intervals, sample floors and false discovery rules

**Scope:** Compute interval/credible comparison, time lag, sample size and guardrails before declaring winner.

**Acceptance & verification:** Small or imbalanced samples warn; unstable uplift never auto-promotes.

**Dependencies:** DOTS-114  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-116 — Model x strategy factorial comparison

**Scope:** Report model and strategy effects independently, cohort controls, cost and quality metrics.

**Acceptance & verification:** Model/strategy winner decisions include confounder and selection-bias warnings.

**Dependencies:** DOTS-114, DOTS-064, DOTS-112  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-117 — Auditable champion promotion and rollback

**Scope:** Create manual and optionally guarded automatic promotion with version/fingerprint and safety criteria.

**Acceptance & verification:** Clear evidence required; every promotion can be rolled back and audited.

**Dependencies:** DOTS-115, DOTS-116, DOTS-036  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-118 — Experiment strategy hybrids and new-variant backlog

**Scope:** Support strategy variation lineage, mixing proven elements and reserved exploration.

**Acceptance & verification:** A hybrid is independently evaluated before replacing champion; variants keep identity history.

**Dependencies:** DOTS-117, DOTS-110  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-119 — Analytics visualization, funnel and experiment reports

**Scope:** Build conversion funnel, side-by-side strategy cards, cost/outcome charts and provenance drilldown.

**Acceptance & verification:** Visual reports match ledger and underlying immutable events; empty/small samples explained.

**Dependencies:** DOTS-111, DOTS-114, DOTS-115, DOTS-117  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-120 — Controlled experiment fairness and safety tests

**Scope:** Use large synthetic cohorts, varying deal sizes and timing to test stratification, false positives and stop rules.

**Acceptance & verification:** A/B testing neither overstates certainty nor violates unsubscribe/budget policies.

**Dependencies:** DOTS-119, DOTS-118, DOTS-093  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)


## F10: Funding Agents, grants and investor relations (14 PR-sized work units; P1)

### DOTS-121 — Funding source and grant program directory

**Scope:** Model grants, foundations, sponsors, partnerships, investor funds, source URLs and verified update timestamps.

**Acceptance & verification:** Owner can filter by geography, eligibility, deadline and type; provenance retained.

**Dependencies:** DOTS-070, DOTS-018  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-122 — Funding opportunity discovery connectors

**Scope:** Use permitted public APIs/feeds and manual import with source evidence and refresh policy.

**Acceptance & verification:** Unavailable APIs yield explicit waiting state; no fabricated program/call for proposals.

**Dependencies:** DOTS-121, DOTS-071  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-123 — Grant eligibility rules and fit explanation

**Scope:** Evaluate applicant/entity type, jurisdiction, stage, restrictions, required documents and program deadlines.

**Acceptance & verification:** Eligibility unknown is not shown as eligible; every fit result cites a current source.

**Dependencies:** DOTS-122, DOTS-085  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-124 — Visual funding pipeline and opportunity cards

**Scope:** Build grant/partner/investor boards with funding range, urgency, eligibility, ownership and source links.

**Acceptance & verification:** A funding lead, pending award, commitment and received payment are visually distinct.

**Dependencies:** DOTS-123, DOTS-080  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-125 — Grant application and task checklist domain

**Scope:** Track draft answers, required documents, milestones, reviews, submission status and evidence.

**Acceptance & verification:** No application becomes 'submitted' without provider receipt or owner-verified evidence.

**Dependencies:** DOTS-123, DOTS-013  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-126 — Grant document repository and source-grounded drafting

**Scope:** Attach organization eligibility proofs and generate reviewable narrative drafts only from verified project facts.

**Acceptance & verification:** Unsupported organizational claims are blocked; required documents remain private.

**Dependencies:** DOTS-125, DOTS-098, DOTS-085  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-127 — Deadline calendar and application reminders

**Scope:** Schedule internal review timelines and owner alerts by deadline/timezone, including stale-program recheck.

**Acceptance & verification:** Upcoming deadline cards use exact provenance and never silently submit.

**Dependencies:** DOTS-125, DOTS-045  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-128 — Human-reviewed grant submission workflow

**Scope:** Create eligibility certification, attachments validation, exact submission payload and authorized action gate.

**Acceptance & verification:** Autonomous agent cannot sign/certify or submit regulated representations without owner approval.

**Dependencies:** DOTS-126, DOTS-127, DOTS-037  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-129 — Award, restriction and disbursement reconciliation

**Scope:** Record offered/accepted award, restriction, payments received and allocations with immutable evidence.

**Acceptance & verification:** Grant award is not recorded as cash received until verified receipt; restricted funds separated.

**Dependencies:** DOTS-128, DOTS-032  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-130 — Investor relations policy and opportunity pipeline

**Scope:** Add investor organization/meeting/interest records, allowable communications classes and solicitation safeguards.

**Acceptance & verification:** General solicitation/regulated offer requests are blocked or owner/legal reviewed as required.

**Dependencies:** DOTS-121, DOTS-036, DOTS-076  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-131 — Investor pitch asset workspace and review

**Scope:** Version source-grounded deck narratives, financial facts, approved investor email copy and diligence checklist.

**Acceptance & verification:** Fictitious traction/revenue claims fail; all outbound pitch revisions link to approved facts.

**Dependencies:** DOTS-130, DOTS-084, DOTS-085  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-132 — Commitment, diligence and investment funds bookkeeping

**Scope:** Distinguish meeting/interest/term sheet/signed commitment/cash received and legal status.

**Acceptance & verification:** Dashboard never labels verbal interest as raised money; proof/source requirements enforced.

**Dependencies:** DOTS-130, DOTS-032, DOTS-131  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-133 — Sponsorship and partnership opportunity workflows

**Scope:** Track partner research, proposals, approval, contract review, signed outcomes and funds or service exchanged.

**Acceptance & verification:** Binding terms require authorized human review; agent cannot autonomously execute contracts.

**Dependencies:** DOTS-121, DOTS-037, DOTS-078  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-134 — Funding performance and portfolio allocation dashboard

**Scope:** Show applied/eligible/pending/won/received grant outcomes, investor qualified meetings and true net funding.

**Acceptance & verification:** Pipeline and funding amounts reconcile to awards/receipts and exclude forecasts.

**Dependencies:** DOTS-124, DOTS-129, DOTS-132, DOTS-133, DOTS-114  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)


## F11: Revenue operations, integrations and product growth (10 PR-sized work units; P2)

### DOTS-135 — Configurable pricing and owner-approved quotation flow

**Scope:** Offer terms, price book revisions, discounts with scoped approvals and sent-quote tracking.

**Acceptance & verification:** Quotes use current approved price and do not create binding terms without authorization.

**Dependencies:** DOTS-086, DOTS-078, DOTS-037  
**External prerequisites:** None  
**Priority:** P2 · **GitHub PRs:** none created (planned only)

### DOTS-136 — Optional payment processor connector foundation

**Scope:** Implement opt-in isolated checkout/payment webhook connector, scoped secrets and signature checks.

**Acceptance & verification:** No live charges until owner connects separate account and approves plan; sandbox receipts work.

**Dependencies:** DOTS-135, DOTS-041  
**External prerequisites:** None  
**Priority:** P2 · **GitHub PRs:** none created (planned only)

### DOTS-137 — Payments, refunds, disputes and subscription receipts

**Scope:** Reconcile transactions, chargebacks, taxes/fees if applicable, cancellations and immutable ledger entries.

**Acceptance & verification:** Actual net realized revenue is computed from verified processor events, not claimed in an email.

**Dependencies:** DOTS-136, DOTS-032, DOTS-079  
**External prerequisites:** None  
**Priority:** P2 · **GitHub PRs:** none created (planned only)

### DOTS-138 — Renewals and post-sale retention workflows

**Scope:** Track lawful customer onboarding, renewals, trial completion, service escalations and churn outcomes.

**Acceptance & verification:** Customer support ownership and suppression are respected; churn/revenue metrics use recorded evidence.

**Dependencies:** DOTS-137, DOTS-105  
**External prerequisites:** None  
**Priority:** P2 · **GitHub PRs:** none created (planned only)

### DOTS-139 — Calendar and meeting scheduling adapters

**Scope:** Add provider-neutral calendar availability and authorized meeting creation, edits and cancellations.

**Acceptance & verification:** A sales agent cannot access unrelated calendars or create a meeting without delegated permission.

**Dependencies:** DOTS-106, DOTS-041  
**External prerequisites:** None  
**Priority:** P2 · **GitHub PRs:** none created (planned only)

### DOTS-140 — CRM import/export and external sync connectors

**Scope:** Provide scoped CSV/API exports plus optional third-party CRM mapping and reconcile loops.

**Acceptance & verification:** Stable external IDs and conflict ownership prevent duplication and cross-tenant leakage.

**Dependencies:** DOTS-076, DOTS-031, DOTS-010  
**External prerequisites:** None  
**Priority:** P2 · **GitHub PRs:** none created (planned only)

### DOTS-141 — Opt-in website lead form and inbound widget

**Scope:** Capture permissioned inbound contact intents via authenticated/anti-abuse form endpoints.

**Acceptance & verification:** Spam and replay filtered; lead consent and provenance recorded with retention.

**Dependencies:** DOTS-070, DOTS-073, DOTS-010  
**External prerequisites:** None  
**Priority:** P2 · **GitHub PRs:** none created (planned only)

### DOTS-142 — Client/account dashboard and invoices view

**Scope:** Display invoice/payment status, contract evidence and contact history in owner-approved views.

**Acceptance & verification:** Customer-facing routes expose only intended tenant/account data; no internal model transcripts.

**Dependencies:** DOTS-137, DOTS-140, DOTS-011  
**External prerequisites:** None  
**Priority:** P2 · **GitHub PRs:** none created (planned only)

### DOTS-143 — Cohort profitability, CAC and revenue reporting

**Scope:** Combine payments, refunds, retained revenue, model/channel spend and touchpoint attribution.

**Acceptance & verification:** Reported net margin matches auditable ledger entries and shows attribution uncertainty.

**Dependencies:** DOTS-137, DOTS-138, DOTS-114  
**External prerequisites:** None  
**Priority:** P2 · **GitHub PRs:** none created (planned only)

### DOTS-144 — Opt-in sandbox and live payment acceptance gate

**Scope:** Verify sandbox to production switch, authorized low-risk transaction, reconciliation and rollback.

**Acceptance & verification:** No unapproved charge or spending; proof of settlement and refund flow captured before full rollout.

**Dependencies:** DOTS-142, DOTS-143, DOTS-136  
**External prerequisites:** Explicit owner merchant account, required processor onboarding and permission to run any actual payment/refund.  
**Priority:** P2 · **GitHub PRs:** none created (planned only)


## F12: Production hardening, deployment and extensibility (16 PR-sized work units; P1)

### DOTS-145 — End-to-end threat model and authorization audit

**Scope:** Review SSRF, prompt injection, tool/data exfiltration, CSRF, XSS, webhook replay and credentials.

**Acceptance & verification:** Automated negative tests prove model/tool prompts cannot bypass policy and tenant ACLs.

**Dependencies:** DOTS-048, DOTS-036, DOTS-108, DOTS-011  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-146 — Consent, privacy, correction and deletion end-to-end

**Scope:** Complete data subject exports, retention expiration, redaction, privacy disclosures and processor inventory.

**Acceptance & verification:** GDPR/CASL or other enabled jurisdictions have reviewed policies; unsupported regions disabled.

**Dependencies:** DOTS-043, DOTS-073, DOTS-096  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-147 — Sender reputation, compliance and abuse readiness

**Scope:** Harden DKIM/SPF/DMARC validation, sender domain limits, unsubscribe tests and complaint threshold pauses.

**Acceptance & verification:** Real outbound cannot enable until business profile and deliverability test evidence pass.

**Dependencies:** DOTS-103, DOTS-087, DOTS-145  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-148 — WCAG mobile/accessibility audit and repairs

**Scope:** Run keyboard, screen reader, zoom, reduced-motion, touch drag alternative and color contrast reviews.

**Acceptance & verification:** Key flows meet WCAG 2.2 AA target with test evidence across supported screen sizes.

**Dependencies:** DOTS-029, DOTS-097, DOTS-119, DOTS-124  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-149 — Queries, caches, load and database indexes

**Scope:** Optimize large roster, timeline, CRM search, campaign progress and model metrics read patterns.

**Acceptance & verification:** Synthetic 100k-contact workload meets explicit baseline latency, with no N+1/O(n) UI rendering.

**Dependencies:** DOTS-081, DOTS-119, DOTS-053  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-150 — Encrypted backup/restore, object recovery and continuity drill

**Scope:** Define RPO/RTO targets, periodic encrypted backup, object versioning, restore scripts and lease reconciliation.

**Acceptance & verification:** Staging restore of real schema and synthetic records succeeds; evidence/retention preserved.

**Dependencies:** DOTS-031, DOTS-013, DOTS-145  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-151 — Infrastructure as code and isolated resources

**Scope:** Create staging/prod infra manifests for web/API, worker, dedicated DB, object storage, secrets and TLS.

**Acceptance & verification:** CI validates config with no paid provisioning; resource deployment requires explicit cost approval.

**Dependencies:** DOTS-005, DOTS-150  
**External prerequisites:** Explicit owner approval before provisioning any new billable Render/Neon/object-store resource.  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-152 — Isolated staging environment and rehearsal

**Scope:** Deploy with synthetic data, fake mail and paid APIs disabled; test migrations, auth, worker and owner controls.

**Acceptance & verification:** One-click scripted smoke proof and rollback succeeds; source SHA and live revision recorded.

**Dependencies:** DOTS-151, DOTS-145, DOTS-148, DOTS-108, DOTS-068  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-153 — Owner-authorized production deployment workflow

**Scope:** Define promotion pipeline, immutable artifacts, rollback, release audit, manual cost/secret gates.

**Acceptance & verification:** Only approved infrastructure/credentials permit deployment; no spend from unapproved CI.

**Dependencies:** DOTS-152, DOTS-151  
**External prerequisites:** Owner-provisioned production domain, isolation resources, secrets and infrastructure spending authorization.  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-154 — Scoped real-world first outreach acceptance

**Scope:** Exercise owner-approved low-volume permitted campaign via live mailbox/model with full receipts and suppression.

**Acceptance & verification:** Live send, reply, opt-out, budget and agent status proven; block if sender, credentials or spending unavailable.

**Dependencies:** DOTS-153, DOTS-109, DOTS-069, DOTS-147, DOTS-090  
**External prerequisites:** Explicit owner approval for real outreach, funded hard caps if needed, validated sender/opt-outs and lawful source of test leads.  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-155 — Operational dashboard, incident response and kill-switch drills

**Scope:** Expose worker, mailbox, queue, spend and compliance alerts with triage checklist and event evidence.

**Acceptance & verification:** Pause-all/credential revoke drills stop dispatcher and produce incident records; alerts aren't fabricated.

**Dependencies:** DOTS-042, DOTS-038, DOTS-152  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-156 — Horizontal workers, fair-share quotas and tenant backpressure

**Scope:** Partition job scheduling, admission controls and rate limits for many agents/campaigns with bounded inference.

**Acceptance & verification:** Synthetic tens-of-thousands concurrent scheduled identities queue fairly without breaking lease/suppression.

**Dependencies:** DOTS-149, DOTS-040, DOTS-064  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-157 — Million registered identity scale and cold-start test

**Scope:** Stress test one million saved avatars/agent identities as database records, with only bounded active workers.

**Acceptance & verification:** Paging, searches, storage and costs measured; never claim million always-running agents.

**Dependencies:** DOTS-156, DOTS-023, DOTS-032  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-158 — Optional commercial multi-tenant onboarding and isolation

**Scope:** Package organization signup/billing-ready roles, trials with zero paid calls, data export and ownership transfers.

**Acceptance & verification:** New tenant starts empty, never sees the owner's film-character agents, contacts or API keys.

**Dependencies:** DOTS-008, DOTS-146, DOTS-157, DOTS-142  
**External prerequisites:** Owner decision to commercialize, license original avatars, publish product terms and comply with applicable privacy and billing obligations.  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-159 — Read-only Boardroom/Engine Room portfolio interoperability

**Scope:** Publish scoped project/event summary contracts and document counterpart repo changes required.

**Acceptance & verification:** Salesroom stays independently operable; external app cannot mutate sales data without separate authorization.

**Dependencies:** DOTS-153, DOTS-006  
**External prerequisites:** External Boardroom/Engine Room consumer modifications require independently approved and tracked changes in their respective repositories.  
**Priority:** P1 · **GitHub PRs:** none created (planned only)

### DOTS-160 — Production acceptance, runbooks and definition of done

**Scope:** Record demonstrable end-to-end product, funding and analytics journeys and exact blockers in durable release status.

**Acceptance & verification:** Evidence differentiates deployed from demo, planned from merged, interest from cash; no false completion.

**Dependencies:** DOTS-154, DOTS-134, DOTS-143, DOTS-150, DOTS-155, DOTS-158, DOTS-159  
**External prerequisites:** None  
**Priority:** P1 · **GitHub PRs:** none created (planned only)


## Project acceptance / required evidence

1. **Engineering:** per-unit lint, strict typecheck, unit/property tests, migration tests, API contract tests, system CI and reproducible build. Dependency changes audited and pinned. No flaky test suppression as proof.
2. **End-to-end:** screenshot and keyboard/touch testing at 1440, 1024, 768, 390 and 320 pixels; agent drag/drop and alternative input; project/agent/strategy/campaign/budget/conversation/funding flows.
3. **Security:** zero-budget hard stops, actual send-side checks, tenant RLS, OAuth/webhook verification, consent/opt-out before dispatch, prompt-injection and SSRF protection, encrypted backups, secret scanning, owner action scope.
4. **Observability:** real heartbeat and lease for green; yellow reason visible; red inactive; exact timestamp and evidence for each activity, contact event, invoice, spend and funding receipt.
5. **Provider evaluation:** all six adapter conformance suites with stubs at $0; live smoke requires real credential and owner-approved positive budget, and verified receipts. Open-weight weights are external artifacts, not Git content.
6. **Go-live:** documented resource costs, staged migration and backup/restore, test mailbox and safe sender, unsubscribe processing, actual deployed SHA, verified real transaction only when owner approves, manual pause/kill drill.
7. **Non-goals:** Vision Agents; covert/deceptive high-volume outreach; unauthorized political persuasion, paid spend or investment offers; self-reproducing agents with unrestricted tool access; assuming a model callback is itself evidence of revenue or funding.

## Roadmap maintenance and GitHub truth

Only `registry/prs.json` is the machine-readable authority; `docs/DEVELOPMENT_PLAN.md` is a derived readable projection. An empty `prs` array means **planned but no exact PR yet**, not failed work. `pullRequests` records are only dated observations; current GitHub PR metadata determines merged/open/closed state. `plannedPrCount` must equal the number of `units`. IDs and historical PR associations must be preserved when new work is added. External dependencies can never be used to assert that another repo has shipped code without authoritative confirmation.

Validation command: `node scripts/validate-pr-registry.mjs` (and the roadmap CI job). If scope changes, update the registry, regenerate the readable document and increment `roadmapVersion`. New units require an explicit source and dependencies. Work completed outside this repository must be tracked in the owning repo.

The release dashboard must distinguish: **planned work**, **PR submitted**, **PR merged**, **integration verified**, **deployed**, and **live campaign operating**. No single count substitutes for those statuses.
