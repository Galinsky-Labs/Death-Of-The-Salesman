# AGENTS.md — Death Of The Salesman development agent instructions

> Applies to all software-development agents and maintainers of this repository. These are instructions for **building** the application, not the behavioral prompt for customer-facing salesperson identities.

## Purpose, product and sources of truth

- Build a standalone API-native, visual-first agent sales and fundraising command center. No ChatGPT scheduled-task integration; model execution comes from provider/inference APIs with durable checkpoints.
- Architecture: [docs/TECHNICAL_ARCHITECTURE.md](docs/TECHNICAL_ARCHITECTURE.md). Interaction contract: [docs/PRODUCT_INTERACTION_DESIGN.md](docs/PRODUCT_INTERACTION_DESIGN.md).
- **Canonical, machine-readable PR plan:** [registry/prs.json](registry/prs.json). Human-friendly rendering: [docs/DEVELOPMENT_PLAN.md](docs/DEVELOPMENT_PLAN.md). Do not invent planned tasks, assign guessed GitHub PR numbers, or treat planned work as implemented.
- Only GitHub's verified actual PR/CI metadata proves PR merge status, and only deployed/live integration evidence proves operational readiness. Use the roadmap's explicit local dependencies and external prerequisites. Roadmap ID prefix is `DOTS-`; previously assigned IDs remain immutable.
- Movie-character name roster: [registry/approved-salesman-names.json](registry/approved-salesman-names.json). First agent identities: **Fast Eddie Felson** and **Harry Wormwood**; roster data is NOT actor-image or likeness licensing. Original/cleared avatars only. New commercial tenants start without assigned agent instances.

## Work sequencing and checks

1. Select the next eligible approved work unit from the registry, honoring dependencies and priority. Write a narrow, reviewable PR, with its `DOTS-###` work unit ID at the start of its title.
2. Implement production code, tests, migrations, docs, and UX together; test changed workflows, avoid half-functional deceptive UI. Use synthetic data in development and screenshots.
3. Run repository-required checks; fix lint/typecheck/test/security/accessibility/migration issues. Check GitHub's actual current commit, required CI, conflicts and branch restrictions before merging. Chain the next eligible unit when safe; do not request routine technical approvals.
4. If an external credential, account, infrastructure payment, business address, consent-policy decision or other human-only permission is needed, mark **blocked on external prerequisite** with exact nonsecret instructions, and work on another eligible zero-dollar unit. Never create a paid service or spend without owner authorization.
5. Persist technical decisions/ADRs, operational runbooks and durable project progress in this repository, not in a transient chat. Cross-repository integrations require their own separately tracked changes.

## Always-on security and cost constraints

- **Default paid spend USD 0** across model/provider/inference, email, hosting resources and data sources. CI and local development never incur paid calls. Explicit owner-funded hard caps are required to enable billable operations.
- **No real outbound solicitation by default.** Model suggestions cannot send messages directly. Campaign, consent/suppression, verified facts, sender identity, policy and budget are all checked by deterministic server-side gates immediately before dispatch.
- No credentials, PII, tokens, investor contacts, customer messages, actor stills, large model weights or private operational data in the public repo, logs or test fixtures.
- Do not claim genuine 'green working' state without live lease/heartbeat evidence. Yellow indicates waiting and why; red is inactive. Prefer visible, auditable truth to simulated productivity.
- Never put the random decorative salesman quote on any page. Reference UI is dark, visual, responsive and keyboard/touch accessible.
- Approved model candidate configs remain optional/disabled until provisioned; no checkpoints in Git. Chinese-developed code-capable models and arbitrary provider endpoints are prohibited for application inference. Mureka audio generation in other applications is unaffected. Provider-specific adapters must not assume equivalent tool semantics or guaranteed prices.
- Investor, grant and product revenue processes must remain distinct; investment solicitation and grant submission have reviewed owner/legal authority gates.
- Vision Agents are explicitly **not** part of this roadmap.

## Acceptance evidence

Every work-unit PR description should include: scope and linked unit; tests run and results; screenshots for visual changes; migration/rollback impact; secrets required (names only); spend impact; security/compliance effects; links to real artifacts and current GitHub CI. Keep `registry/prs.json` accurate via real PR mapping; do not pre-link PRs that do not exist. A unit may need follow-up PRs and cannot be marked complete solely because a proposed initial PR exists.

**Owner-first go-live:** The project becomes operational only after a separately verified staging and production acceptance with real accounts and only within configured permitted budget/campaign limits.
