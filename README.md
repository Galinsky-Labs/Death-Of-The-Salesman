# Death Of The Salesman

An API-native, multi-model, **visual-first sales and fundraising command center**. This repository
contains a persistent owner operations console deployed on Render with Neon: durable agent
work, CRM, campaigns, conversations, funding, invoices, encrypted documents and approvals.
Paid providers and real outreach require separately configured owner credentials and caps.

## Start here

- [Full technical architecture](docs/TECHNICAL_ARCHITECTURE.md) — product boundaries, runtime, model routing, security, campaign controls, privacy and scaling.
- [Responsive product interaction design](docs/PRODUCT_INTERACTION_DESIGN.md) — dark dashboard, avatars, drag-and-drop project buckets, Strategy Lab, CRM and Conversation Center. **No random corner salesman quote.**
- [Complete development plan](docs/DEVELOPMENT_PLAN.md) — all phases and acceptance gates. Generated from one canonical plan.
- [Canonical machine-readable PR registry](registry/prs.json) — real PR mapping and dependency DAG, compatible with Boardroom's v1 contract.
- [Development-agent instructions](AGENTS.md) — implementation and checkpoint discipline.
- [Zero-credential developer runbook](docs/DEVELOPER_RUNBOOK.md) — safe demo setup, daily commands, secret names and ownership boundaries.
- [Outage and rollback runbook](docs/OUTAGE_ROLLBACK_RUNBOOK.md) — fail-closed stabilization, rollback decisions and recovery verification.
- [Architecture decision records](docs/adr/) — accepted contract-evolution and endpoint-ownership decisions.
- [Approved salesman names](registry/approved-salesman-names.json) — 264 owner-approved character names, starting with **Fast Eddie Felson** and **Harry Wormwood**.
- [Six model candidates](registry/model-catalog.json) — OpenAI, Claude, Grok, MiMo, GLM, Kimi; disabled until credentials and funding are provided.

## Development validation

```sh
pnpm check
pnpm audit:dependencies
```

The source-quality and roadmap checks use synthetic data and do not call paid APIs, send messages,
or start inference servers. Database acceptance uses disposable PostgreSQL in CI. Deployment and
live-provider checks remain separate plan gates.

## Operating guardrails

**No paid model, GPU, data-service, or outbound campaign spending is enabled by default.** Live email and model calls require owner-provided credentials, explicit budgets, campaign policies and consent/anti-spam controls. Downloadable open-weight checkpoint files belong in separately approved inference storage, not Git history.

Vision Agents are outside this application's scope. This product is architecturally independent from Boardroom, although both can later exchange scoped portfolio and verified operational summaries.

## Render + Neon owner workspace

Open [the deployed workspace](https://death-of-the-salesman.onrender.com).

The operations release includes a project board, agent assignments and durable work queue,
CRM and pipeline, campaign rehearsals, conversations, strategy experiments, funding,
invoices, encrypted documents, budgets and exact-content approvals. See the
[operations runbook](docs/OPERATIONS_RUNBOOK.md), the
[deployment runbook](docs/RENDER_NEON_RUNBOOK.md) and [synthetic review evidence](docs/evidence/).
[Verified deployment evidence](docs/LIVE_RELEASE_STATUS.md) records the live revision and checks.
Live acceptance is recorded separately from the unfinished roadmap. Models, outbound
campaigns, payments and paid execution remain disabled.
