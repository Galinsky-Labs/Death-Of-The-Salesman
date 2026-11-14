# Agent runtime (phase F4): bounded, owner-gated, $0 synthetic autonomy

Units: DOTS-039, DOTS-040, DOTS-044 to DOTS-054. Code: `packages/operations/src/runtime.ts`
(plus the legacy-queue changes in `queue.ts` and the orchestration hook in `engine.ts`).
Schema: `database/migrations/0015_agent_runtime.{up,down}.sql`. Grants: `database/runtime-grants-0015.sql`.
API: `apps/web/app/api/v1/runtime/route.ts`. UI: `apps/web/app/views/runtime-view.tsx` (`RuntimeView`).
Tests: `tests/runtime.test.mjs`.

## What it does

The runtime turns a project-bucket assignment into bounded, auditable agent work without spending money or
contacting anyone:

1. **Enqueue** (`RuntimeQueue.enqueue`): a keyed work item is stored in `app.task_queue` (as before) and in its
   companion `app.work_items` row. The idempotency key deduplicates repeated requests, and a different payload
   under the same key is rejected. The agent must be active and assigned to an active project, and its capability
   record must allow the task kind, channel, skill and campaign. Work outside that scope is rejected here.
2. **Claim** (`RuntimeQueue.claim`): selection runs by explicit priority, then the agent and project with the
   fewest runs in the last 24 hours, then FIFO. Before reserving an item the claim checks scope again. It also
   checks the agent's paused flag, its legal UTC window, its daily run quota, the assignment's concurrency cap
   and the lead lock (one active work item per `lead_key`). The claim takes a lease (45 s) and a new fencing token.
   Idle or unassigned avatars never reach a model step: their items move to `BLOCKED/AGENT_IDLE_OR_UNASSIGNED`.
3. **Run** (`RunCoordinator`): the coordinator opens a run with a versioned context snapshot and checkpoint 1. It
   then executes bounded steps, with a per-call timeout and bounded call retries. Each step goes through the
   typed tool broker and gets a checkpoint. The run ends in exactly one terminal state, either `completed` or
   one of `cancelled`, `step_limit`, `timed_out` and `failed`, and that state gets a final checkpoint. A run
   whose worker died is marked `recovering` by orphan recovery.
4. **Owner review**: accepted proposals put the item in `DRAFTED` or `WAITING_FOR_APPROVAL`. The owner completes,
   re-queues or cancels it, and every owner action is a compare-and-swap transition.
5. **Dispatch** (`OwnerGatedDispatcher`): any external side effect needs four things: an approved, unexpired
   approval whose payload hash matches exactly and whose policy version is current; an unpaused policy with
   outbound enabled; an unsuppressed contact; and a budget reservation under a unique dedupe key. Retrying with
   the same key never sends twice. Nothing in the HTTP API dispatches. Only the reconciliation of an ambiguous
   effect is exposed.

### Work-item state machine (DOTS-044)

`CREATED → ELIGIBLE → RESERVED → RUNNING → (DRAFTED | WAITING_FOR_APPROVAL | WAITING_FOR_REPLY | WAITING_FOR_BUDGET |
BLOCKED | COMPLETED | FAILED_RETRYABLE | FAILED_FINAL | CANCELLED | RECOVERING)`. The full legal table is the
exported constant `LEGAL_TRANSITIONS`. `COMPLETED`, `FAILED_FINAL` and `CANCELLED` are terminal.
Every transition:
- checks the table (`ILLEGAL_TRANSITION`),
- updates `work_items` with `WHERE version=$expected AND state=$from` (`STALE_WORK_ITEM` on conflict),
- appends to the immutable `work_item_transitions` log, optionally under an idempotency key. Replaying that key
  returns the prior outcome without a second transition.
- mirrors the state onto `task_queue.state` (`queueStateFor`), so existing queue views keep working.
Owners cannot set worker-only states (`RESERVED`, `RUNNING`, `RECOVERING`, `FAILED_RETRYABLE`, `DRAFTED`).

### Retries, backoff and dead letters (DOTS-039)

`retryDelayMs(attempt)` is bounded exponential backoff with equal jitter: the delay lies in `[exp/2, exp]`, where
`exp = min(1 h, 30 s · 2^(attempt-1))`. A retryable failure (executor error, timeout or invalid executor output)
moves the item to `FAILED_RETRYABLE` with a deferred `available_at`. Once `max_attempts` is reached the item moves
to `FAILED_FINAL`, and a row is appended to `runtime_dead_letters`. Legacy `task_queue` jobs use the same
policy through `DurableQueue.retryLater` for `EXECUTION_FAILED`, `PROVIDER_RATE_LIMITED` and
`PROVIDER_UNAVAILABLE`, but only when no budget reservation is outstanding.
Legacy `DurableQueue.claim`, `recoverExpired` and `cancel` ignore runtime work items
(`task_queue.payload ? 'runtime'`).

### Leases and fencing (DOTS-040)

Each claim increments `fencing_token`. Every checkpoint, step persistence, completion and stop checks the
worker id, the fence and an unexpired lease (`LEASE_LOST`). Orphan recovery bumps the fence, so a stale worker
cannot commit any protected output.

### Capabilities (DOTS-046)

`app.agent_capabilities` stores the following per agent:
- role
- allowed task kinds, tools, channels and skills
- model policy (`simulation_only` by default)
- campaign scope
- paused flag (`true` by default)
- max steps and wall-clock seconds
- daily run quota
- optional UTC window

An agent with no capability row cannot receive any work. New tenants therefore start with no autonomous agents.

### Context assembly (DOTS-047)

`assembleContext` builds a bounded object with schema `dots.runtime.context.v1`:
- **Fixed policy:** the policy text and `allowedTools`, which come only from the capability record intersected
  with the broker allowlist.
- **Task, agent and assignment.**
- **Approved facts:** verified, unexpired facts, at most 20.
- **Offers:** at most 10.
- **Recent memories:** at most 5.
- **Untrusted items:** email thread excerpts (at most 6 messages of 1,500 characters each), website excerpts
  (2,000 characters) and the project brief (3,000 characters). Each untrusted item is wrapped with `trust:
  "untrusted"`, a fixed label and the hash of its source text.

The whole context is capped at 48 KB. Its hash is the context version, and it is stored immutably in
`context_snapshots`. Text inside an untrusted item can never change `allowedTools` (tested with an injection string).

### Tool broker (DOTS-048)

The allowlisted schemas are `propose_draft`, `propose_crm_note`, `propose_stage_change` (which cannot move a deal
to `won`) and `request_owner_review`. Each is checked by a strict hand-written validator. The validator rejects:
- free-form text and non-plain objects
- extra or missing fields and invalid identifiers
- control characters and oversized or cyclic input
- any tool that is not on the allowlist, such as a shell, URL fetch, SQL or email-send tool

A referential check then rejects proposals that cite facts outside the context, unknown contacts, or deals in
another project. Every proposal, accepted or rejected, is appended to `tool_proposals` with a trace id
(`trace:<run>:<step>:<ordinal>`) and a correlation id (the work item). Proposals are records for owner review
only. Nothing executes them.

### Memory and resume (DOTS-050)

When a run completes, `run_memories` gets a `run_summary`, and each accepted CRM note becomes a `contact_fact`.
Each memory carries provenance: run id, work item, checkpoint sequence, context version and, for contact facts,
the proposal id and trace id. `RunCoordinator.resume(runId, workerId)` can be called from a new process with the
same worker identity while that worker's lease is live. It reloads the immutable context snapshot, verifies its
hash, and continues from the last checkpoint without repeating steps. If the lease has expired, orphan recovery
handles the run instead.

### Orphan recovery (DOTS-052)

`recoverOrphans` finds runtime items whose lease has expired or whose heartbeat is stale, and bumps their fence.
A `RESERVED` item returns to `ELIGIBLE`. A `RUNNING` item moves to `RECOVERING`, its run is marked `recovering`
and its `agent_runs` row `quarantined`, and any `started` dispatch for it is marked `ambiguous`. An item with an
ambiguous dispatch moves to `BLOCKED/NEEDS_MANUAL_RECONCILIATION`. It cannot be re-queued, and the same dedupe
key cannot be dispatched again, until the owner records verified provider evidence through
`reconcileDispatch`. Other recovered items follow the retry and dead-letter policy.

### Evidence (DOTS-053)

`RuntimeEvidence.snapshot()` (GET `/api/v1/runtime`) returns the following.
- **Agent cards:** the green/yellow/red status with reason codes, evidence references and timestamps; the model;
  the strategy; run, draft, rejected-proposal and verified-sent counts; the runtime cost (always 0, enforced by a
  `CHECK`); and a 25-entry timeline.
- **Green:** only when a run holds a live lease with a heartbeat younger than 20 seconds.
- **Yellow:** names each waiting item and its reason: owner paused, agent paused, outside window, retry backoff,
  review required, blocked, and so on.
- **Red:** explains its cause: inactive identity, no assignment, no capability record, or no work.
- **Other sections:** work items, runs, the owner review queue, dead letters and dispatches.

## HTTP API

- `GET /api/v1/runtime` requires an owner session. It returns `{observedAt, policy, agents[], workItems[], runs[],
  reviewQueue[], deadLetters[], dispatches[]}`.
- `POST /api/v1/runtime` requires a trusted origin, an owner session, a JSON body of at most 64 KB and an `action`.
  It returns `{outcome, data}`. The actions are:
  - `configureCapability`
  - `setAgentPaused`
  - `enqueueWork`
  - `transitionWork`
  - `cancelWork`
  - `cancelRun`
  - `runSimulation`, which processes one item with the $0 deterministic executor
  - `recoverOrphans`
  - `reconcileDispatch`

## Operator steps

1. Apply migration 0015 (`pnpm db:migrate`). As the migration administrator, apply `database/runtime-grants.sql`
   and then `database/runtime-grants-0015.sql`.
2. Assign agents to project buckets, which existing assignments already do.
3. In the runtime view, open an agent's **Capabilities**. Choose its task kinds, tools and channels, and clear
   **Paused**.
4. Queue work, then let the worker run (`JOB_WORKER_ENABLED`) or press **Run one $0 simulation**.
5. Review proposals in the **Owner review queue**, then mark items reviewed, re-queue them or cancel them.
6. If a dispatch is ever ambiguous, verify it in the provider's dashboard and record the evidence. Do not resend.

Environment variables used by this track (names only): `JOB_WORKER_ENABLED`, `DATABASE_URL`, `OWNER_ORGANIZATION_ID`,
`OWNER_MEMBERSHIP_ID`. No new secrets are required.

## Spend, security and limits

- **Spend:** USD 0. Every runtime run uses an executor with `billing: 'none'`. `begin()` refuses anything else
  (`MODEL_POLICY_DENIED`), and `run_controls.cost_cents` has a `CHECK (cost_cents = 0)`. Live and paid provider
  inference stays on the separately gated engine path.
- **Outbound contact:** none. No HTTP action dispatches, and the dispatcher needs an explicitly injected sender.
  Tests use in-memory fakes, and `globalThis.fetch` throws for the whole runtime test file.
- **Privacy:** the event log stores only a 16-character hash of a lead key, never contact data.
- **Evidence tables:** transitions, snapshots, proposals, memories and dead letters are append-only (trigger)
  and get no DELETE grant.
- **Tenant isolation:** all tables have FORCE row-level security scoped by `organization_id`.

## Blocked on external prerequisite

- **Live model execution inside the runtime coordinator** (as opposed to the existing engine path) needs an
  owner-funded hard cap, an owner spend authorization and an approved provider. Until then
  `model_policy` values other than `simulation_only` are stored but no billable executor exists.
  To enable it later, the owner sets `MODEL_API_ENABLED`, `OWNER_SPEND_AUTHORIZATION_ID` and
  `PAID_SPEND_LIMIT_CENTS`. A follow-up unit must then add a metered executor that reserves budget before each
  call.
- **Real dispatch senders (email, CRM writes)** need a verified sender identity, a business address, an
  outreach policy authorization (`EMAIL_DELIVERY_ENABLED`, `OUTREACH_POLICY_AUTHORIZATION_ID`,
  `SENDER_VERIFICATION_REFERENCE`) and owner consent-policy decisions. The dispatcher abstraction is ready, but
  no production sender is wired to it.
- **Staging and production acceptance**, with live lease and heartbeat evidence from a deployed worker.

## Acceptance coverage (tests/runtime.test.mjs)

| Unit | Acceptance criterion | Status |
| --- | --- | --- |
| DOTS-039 | Restarts preserve pending tasks; repeated deliveries never duplicate effects | Implemented: keyed enqueue, restart claim, backoff, dead letter, legacy retry |
| DOTS-040 | Two workers cannot own one item; an expired worker cannot commit | Implemented: fence and lease checks on every write |
| DOTS-044 | Invalid transitions rejected; idempotent retry returns prior outcome | Implemented |
| DOTS-045 | Same lead not double-worked; no model runs for idle avatars; windows respected | Implemented: lead locks, idle block, UTC window, quota, deadlines, fairness |
| DOTS-046 | Agent cannot execute outside campaign or skill scope | Implemented: checked at enqueue and at claim |
| DOTS-047 | Retrieved email and website text is untrusted and cannot redefine tool privileges | Implemented: injection test |
| DOTS-048 | No arbitrary shell, URL, email or SQL execution through model text | Implemented: strict broker, proposals never execute |
| DOTS-049 | All runs exit and checkpoint; failures yield evidence without phantom activity | Implemented: step limit, timeout, cancel, retry |
| DOTS-050 | A new process resumes safely without chat memory | Implemented: resume from checkpoint; provenance memories |
| DOTS-051 | Unapproved, paused, suppressed or unfunded action cannot dispatch, including on retry | Implemented (abstraction; no live sender: see above) |
| DOTS-052 | A crash mid-send triggers reconciliation, not a duplicate send | Implemented |
| DOTS-053 | Agent card explains green, yellow and red from persisted evidence | Implemented (API and view; navigation wiring is left to the integrator) |
| DOTS-054 | No paid calls or outbound contact; a full trace passes repeatedly | Implemented: two-agent deterministic simulation run twice |
