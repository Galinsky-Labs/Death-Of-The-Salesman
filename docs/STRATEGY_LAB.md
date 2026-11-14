# Strategy Lab (DOTS-110 – DOTS-120)

The Strategy Lab is where the owner defines outreach strategies, decides how much traffic goes to the current champion versus experiments, and reviews results built only from verified evidence. It never sends anything: enrollment chooses an arm, and real dispatch still passes the deterministic campaign, consent, suppression, policy and budget gates.

- Domain module: `packages/operations/src/strategy.ts` (`StrategyLab` class and pure statistics helpers).
- Migration: `database/migrations/0020_strategy_lab.up.sql` / `.down.sql`.
- Runtime grants: `database/runtime-grants-0020.sql`. Apply it after `database/runtime-grants.sql`.
- API: `GET/POST /api/v1/strategy` (owner session; POST also needs a trusted origin and a JSON body).
- View: `apps/web/app/views/strategy-lab-view.tsx` (`StrategyLabView`), navigation label **Strategy Lab**.
- Tests: `tests/strategy.test.mjs`.

## Data model

| Table | Purpose | Mutability |
| --- | --- | --- |
| `strategy_families` | Named strategy family with an owner membership | `status` only |
| `strategy_revisions` | Objective, audience rules, allowed personalization, forbidden claims, tone, disclosures, instructions and a SHA-256 fingerprint | Content immutable (trigger); `status`/decision columns only |
| `strategy_lineage` | Hybrid parents and the elements inherited from each | Append-only |
| `strategy_allocation_rules` | Per project or campaign: champion revision, experimental share, exploration floor, below-floor acknowledgement, auto-promotion switch | Versioned updates |
| `strategy_allocation_history` | Every saved allocation, including acknowledgements | Append-only |
| `strategy_experiments` | Experiment revision: design, seed, sample floor, lag window, alpha, complaint/unsubscribe limits, budget, fingerprint | Design immutable (trigger); `state`/`stop_reason` only |
| `strategy_experiment_arms` | Arms with role (champion/experimental), revision and optional model id | Append-only |
| `strategy_enrollments` | One row per contact per experiment revision with stratum, hash bucket and the allocation version used | Append-only |
| `strategy_outcome_events` | sent, reply, qualified_response, meeting, deal, funds_received, spam_complaint, unsubscribe and cost events with evidence | Append-only |
| `strategy_metric_snapshots` | Fingerprinted metrics and evaluation snapshots | Append-only |
| `strategy_promotions` | Manual, automatic and rollback records with fingerprints, safety data and rationale | Append-only |
| `strategy_variant_backlog` | Hypotheses and proposed variants (idea → drafted → evaluating → adopted/rejected) | Versioned updates |
| `strategy_arm_metrics` (view, `security_invoker`) | Per-arm verified counts, actual vs estimated money, and excluded simulation and model-claim counts | Read-only |

Every table has `organization_id`, compound tenant foreign keys, and enabled, forced row-level security.

## Behaviour by unit

- **DOTS-110 Strategy definitions and versioning.** `createFamily` creates revision 1 as `proposed`. Editing calls `proposeRevision`, which adds the next revision; existing revisions and experiments are never changed, and database triggers reject content updates. Only approved revisions can be used in experiments. Personalization fields must come from an allowlist; at least one disclosure is required. `strategyConstraintViolations()` checks a draft against forbidden claims, allowed personalization and required disclosures.
- **DOTS-111 Allocation rules.** `saveAllocation` stores the experimental share and the minimum exploration floor in basis points. A new rule stores the suggested 50/50 split, which can then be changed. Enrollment always reads the saved rule and records the share and rule version on each enrollment, so nothing is hidden or hardcoded. Saving below the floor requires an acknowledgement, which is stored on the rule and in the history; a database CHECK enforces it. The champion can be set once at creation; after that it changes only through promotion or rollback.
- **DOTS-112 Enrollment.** Each experiment revision gets a random 128-bit seed. A contact's arm comes from `sha256(seed, contact)` mapped onto the saved weights, using restricted randomization inside the stratum (`campaign|segment`). If the hashed arm would exceed its stratum target by more than `stratum_tolerance`, the arm with the largest deficit is used instead. Advisory locks and the primary key ensure one enrollment per contact per experiment revision, and repeat calls return the stored arm. A contact enrolled in another active or paused experiment in the same project (Strategy Lab or legacy `experiments`) is refused with `EXPERIMENT_OVERLAP`. Suppressed, opted-out, inactive and out-of-audience contacts are refused.
- **DOTS-113 Outcome accounting.** Evidence sources are `provider` (needs an existing `provider_receipts` row, enforced by a foreign key), `owner_attested` (needs an evidence reference), `simulation` and `model_claim`. Only the first two count. A verified non-send outcome needs a prior verified send. Deal values are always estimates; received funds are always actual. Non-USD amounts keep the original amount and an FX source. Events are idempotent by key, and a reused key with a different payload is refused.
- **DOTS-114 Metrics.** `metrics()` returns, per arm: the funnel, conversion rates with numerator and denominator, complaint and unsubscribe rates, actual funds, converted funds, actual and estimated cost, margin per qualified response, estimated pipeline, excluded event counts, weekly cohorts and the period. `snapshotMetrics()` saves an immutable, fingerprinted snapshot.
- **DOTS-115 Statistics and guardrails.** The primary metric is qualified responses per matured verified exposure; exposures still inside the lag window are excluded. The evaluation combines Wilson intervals, a two-proportion z-test with an unpooled CI, Bayesian beta-binomial probability of superiority (seeded Monte Carlo, reproducible) and Benjamini–Hochberg across all simultaneous comparisons. It raises these warnings: `SAMPLE_BELOW_FLOOR`, `LAG_WINDOW_OPEN`, `FEW_OUTCOME_EVENTS`, `IMBALANCED_ALLOCATION` (sample-ratio mismatch), `EXPOSURE_RATE_DIFFERS_BY_ARM`, `UNSTABLE_UPLIFT` and the safety limits. Automatic promotion needs all of the following: BH significance, a positive CI, P(superior) ≥ 0.95, no blocking or small-sample warnings.
- **DOTS-116 Factorial reports.** Factorial experiments need a model id on every arm. `factorialReport()` pools marginal strategy and model effects and reports cost per exposure. It warns about incomplete factorials (confounding), segment imbalance across cells, exposure-rate differences (selection bias), single-level factors and small cells.
- **DOTS-117 Promotion and rollback.** `promote()` saves a metrics snapshot, checks safety limits and evidence floors, and records the from/to revision fingerprints. It then updates the champion, closes the experiment and writes an audit event. Manual promotion of an unstable uplift needs a recorded uncertainty acknowledgement. Automatic promotion needs `auto_promote_enabled` and a stable winner. `rollback()` restores the previous champion once per promotion, only if the champion has not changed since.
- **DOTS-118 Hybrids and backlog.** `createHybrid()` proposes a revision whose lineage rows record each parent and the elements it inherited. A hybrid must be approved and then win its own experiment as the experimental arm before it can become champion; evidence from its parents is never reused. Backlog items move to `evaluating` when their revision enters an experiment and to `adopted` when it is promoted.
- **DOTS-119 Visualization.** The view shows strategy cards with revision history and approval, allocation sliders with exact numeric input and a floor warning with acknowledgement, and experiment cards with arm-share bars. It also shows SVG Wilson-interval charts with equivalent text tables, the funnel, actual vs estimated money, factorial effects, provenance drilldown, promotions with rollback, and the hybrid/backlog form. Empty and small samples come with plain-language explanations.
- **DOTS-120 Fairness and safety tests.** A test assigns 20,000 synthetic enrollments in memory across 12 strata and three experimental arms, checking stratum balance and overall allocation. It then runs 1,200 seeded A/A comparisons with varied base rates, deal sizes and timing: the raw false-positive rate must stay near alpha, BH families must rarely produce a discovery, and the evaluator must not auto-promote under the null. In the database, a complaint over the limit and a $0 budget each stop an experiment, after which enrollment, sends, resuming and promotion are refused.

## Operator steps

1. Open **Strategy Lab** and create a strategy family. Approve its revision.
2. Add an allocation rule for a project or campaign. Adjust the slider or exact input and save. Going below the exploration floor requires a written acknowledgement.
3. Create an experiment with an approved experimental revision. Its budget starts at $0, so any verified cost stops it until the owner creates a funded revision.
4. Enroll contacts through the API (`enroll`). Record outcomes only from provider receipts (`provider`) or written owner evidence (`owner_attested`).
5. Review warnings, intervals and provenance. Promote manually, or enable guarded automatic promotion on the rule. Roll back from **Promotions** if needed.

## API actions (POST `/api/v1/strategy`)

`createFamily`, `proposeRevision`, `decideRevision`, `retireRevision`, `saveAllocation`, `createExperiment`, `setExperimentState`, `enroll`, `recordOutcome`, `metrics`, `snapshotMetrics`, `provenance`, `promote`, `rollback`, `createHybrid`, `addBacklogItem`, `updateBacklogItem`. Each response is `{data: <snapshot>, outcome}`. Errors are `{error: CODE}`.

GET returns `{families[{...,revisions[{...,parents}]}], rules[{...,history}], experiments[{...,arms}], reports[{experiment, rule, arms, cohorts, evaluation, factorial, period, sources, provenance}], promotions, backlog, projects, campaigns, defaults, observedAt}`.

## Environment variables

None are new. The module uses the existing database connection (`DATABASE_URL`) and the owner session configuration.

## External prerequisites

- **Blocked on external prerequisite: real verified outcomes.** Live results need provider receipts from a configured delivery provider (see `docs/FREE_AND_PAID_INTEGRATIONS.md`), or written owner evidence. Until outbound delivery is authorized by the owner (`EMAIL_DELIVERY_ENABLED`, `OUTREACH_POLICY_AUTHORIZATION_ID`), experiments will show "No verified evidence". This is intended behaviour.
- **Blocked on external prerequisite: production grants.** A database administrator must apply `database/runtime-grants-0020.sql` after migration 0020 in staging and production.
- Model × strategy comparisons only become meaningful once the owner has provisioned approved model providers. Until then, model ids are labels only.

## Spend and safety

Default spend is $0: experiments default to `budget_cents = 0`, and the first verified cost stops them. Statistics never count simulations or model claims. Nothing is promoted automatically unless the owner enabled it on the rule and the uplift is stable.
