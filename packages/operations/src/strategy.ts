// DOTS-110..120 Strategy Lab: immutable strategy revisions, stored allocation rules, deterministic stratified
// enrollment, verified outcome accounting, metrics, statistics, factorial reports, promotion/rollback and hybrids.
import { randomBytes } from "node:crypto";
import { type Client, type Context, type Row, rows, tenant, event, digest, fail, text, cents } from "./common.js";
import { identifier, selection } from "./sales.js";
import { wilson, falseDiscoveryDiscoveries } from "./growth.js";

// ---------------------------------------------------------------- constants
/** Suggested split shown in the UI and stored on first save. Enrollment never reads this constant. */
export const SUGGESTED_EXPERIMENTAL_BASIS_POINTS = 5000;
export const SUGGESTED_MIN_EXPLORATION_BASIS_POINTS = 1000;
export const PERSONALIZATION_FIELDS = ["first_name", "company", "role_title", "sector", "region", "product_interest", "recent_public_news"] as const;
export const OUTCOME_KINDS = ["sent", "reply", "qualified_response", "meeting", "deal", "funds_received", "spam_complaint", "unsubscribe", "cost"] as const;
export const EVIDENCE_SOURCES = ["provider", "owner_attested", "simulation", "model_claim"] as const;
export const VERIFIED_SOURCES = ["provider", "owner_attested"] as const;
const CLOCK_SKEW_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------- deterministic randomness and statistics
/** Seeded 32-bit PRNG (mulberry32). Same seed → same sequence; used for Monte Carlo and simulations. */
export function seededRandom(seed: number | string): () => number {
  let state = typeof seed === "number" ? seed >>> 0 : parseInt(digest(seed).slice(0, 8), 16) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Standard normal CDF (Abramowitz & Stegun 7.1.26, |error| < 1.5e-7). */
export function normalCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2, t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}
/** Upper-tail chi-square probability via the Wilson–Hilferty approximation. */
export function chiSquareUpperTail(statistic: number, degrees: number): number {
  if (!(degrees > 0) || !Number.isFinite(statistic)) return 1;
  if (statistic <= 0) return 1;
  const k = degrees, z = (Math.cbrt(statistic / k) - (1 - 2 / (9 * k))) / Math.sqrt(2 / (9 * k));
  return 1 - normalCdf(z);
}
function sample(successes: number, total: number) {
  if (!Number.isSafeInteger(successes) || !Number.isSafeInteger(total) || successes < 0 || total < successes) return fail("INVALID_SAMPLE", 400);
}
/** Two-proportion comparison of B against A: pooled z test (two-sided) and unpooled 95% CI for pB−pA. */
export function twoProportion(successesA: number, totalA: number, successesB: number, totalB: number) {
  sample(successesA, totalA); sample(successesB, totalB);
  if (!totalA || !totalB) return { difference: null, lower: null, upper: null, z: null, pValue: null };
  const pA = successesA / totalA, pB = successesB / totalB, pooled = (successesA + successesB) / (totalA + totalB);
  const pooledSe = Math.sqrt(pooled * (1 - pooled) * (1 / totalA + 1 / totalB));
  const se = Math.sqrt(pA * (1 - pA) / totalA + pB * (1 - pB) / totalB);
  const z = pooledSe === 0 ? 0 : (pB - pA) / pooledSe;
  const pValue = pooledSe === 0 ? 1 : Math.min(1, 2 * (1 - normalCdf(Math.abs(z))));
  return { difference: pB - pA, lower: pB - pA - 1.96 * se, upper: pB - pA + 1.96 * se, z, pValue };
}
function gamma(shape: number, random: () => number): number {
  if (shape < 1) return gamma(shape + 1, random) * Math.pow(random() || 1e-12, 1 / shape);
  const d = shape - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number, v: number;
    do { const u1 = random() || 1e-12, u2 = random(); x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2); v = 1 + c * x; } while (v <= 0);
    v = v * v * v; const u = random() || 1e-12;
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}
/** Bayesian beta-binomial P(rate_B > rate_A) with uniform Beta(1,1) priors, seeded Monte Carlo (reproducible). */
export function probabilityOfSuperiority(successesA: number, totalA: number, successesB: number, totalB: number, options: { draws?: number; seed?: string } = {}): number {
  sample(successesA, totalA); sample(successesB, totalB);
  const draws = Math.min(200_000, Math.max(1000, options.draws ?? 20_000)), random = seededRandom(options.seed ?? `superiority:${successesA}/${totalA}:${successesB}/${totalB}`);
  let wins = 0;
  for (let i = 0; i < draws; i++) {
    const a1 = gamma(1 + successesA, random), a2 = gamma(1 + totalA - successesA, random);
    const b1 = gamma(1 + successesB, random), b2 = gamma(1 + totalB - successesB, random);
    if (b1 / (b1 + b2) > a1 / (a1 + a2)) wins++;
  }
  return wins / draws;
}
/** Benjamini–Hochberg flags across simultaneous comparisons (true = discovery at the given FDR). */
export function benjaminiHochberg(pValues: number[], alpha = 0.05): boolean[] {
  const discovered = new Set(falseDiscoveryDiscoveries(pValues, alpha));
  return pValues.map((_, index) => discovered.has(index));
}
/** Sample-ratio-mismatch chi-square test of observed counts against expected allocation weights. */
export function sampleRatioMismatch(observed: number[], weights: number[]) {
  const total = observed.reduce((a, b) => a + b, 0), weightTotal = weights.reduce((a, b) => a + b, 0);
  if (!total || !weightTotal) return { statistic: 0, pValue: 1 };
  let statistic = 0, degrees = -1;
  observed.forEach((count, i) => { const expected = total * (weights[i] ?? 0) / weightTotal; if (expected > 0) { statistic += (count - expected) ** 2 / expected; degrees++; } else if (count > 0) statistic += Number.POSITIVE_INFINITY; });
  return { statistic, pValue: Number.isFinite(statistic) ? chiSquareUpperTail(statistic, Math.max(1, degrees)) : 0 };
}
/** Chi-square test of independence on an r×c contingency table. */
export function contingencyChiSquare(table: number[][]) {
  const rowsTotal = table.map(r => r.reduce((a, b) => a + b, 0)), columns = table[0]?.length ?? 0;
  const columnTotals = Array.from({ length: columns }, (_, j) => table.reduce((a, r) => a + (r[j] ?? 0), 0)), total = rowsTotal.reduce((a, b) => a + b, 0);
  const liveRows = rowsTotal.filter(Boolean).length, liveColumns = columnTotals.filter(Boolean).length;
  if (!total || liveRows < 2 || liveColumns < 2) return { statistic: 0, degrees: 0, pValue: 1 };
  let statistic = 0;
  table.forEach((r, i) => r.forEach((count, j) => { const expected = (rowsTotal[i]! * columnTotals[j]!) / total; if (expected > 0) statistic += (count - expected) ** 2 / expected; }));
  const degrees = (liveRows - 1) * (liveColumns - 1);
  return { statistic, degrees, pValue: chiSquareUpperTail(statistic, degrees) };
}

// ---------------------------------------------------------------- allocation and assignment
export type ArmRole = "champion" | "experimental";
/** Per-arm weights (basis points, summing to 10000) from the SAVED experimental share. */
export function armWeights(roles: ArmRole[], experimentalBasisPoints: number): number[] {
  if (!Number.isInteger(experimentalBasisPoints) || experimentalBasisPoints < 0 || experimentalBasisPoints > 10000) return fail("INVALID_ALLOCATION", 400);
  const champions = roles.filter(r => r === "champion").length, experimental = roles.length - champions;
  if (!champions || !experimental) return fail("CHAMPION_AND_EXPERIMENTAL_ARMS_REQUIRED", 400);
  return roles.map(role => role === "champion" ? (10000 - experimentalBasisPoints) / champions : experimentalBasisPoints / experimental);
}
export function hashBucket(seed: string, contactId: string): number { return parseInt(digest({ seed, contactId }).slice(0, 8), 16) % 10000; }
/**
 * Seeded restricted randomization within a stratum. The contact's hash bucket picks an arm by the saved weights;
 * if that would push the arm more than `tolerance` above its stratum target, the arm with the largest deficit is
 * used instead (deterministic tie-break by the bucket). Same seed + contact + stratum counts → same arm.
 */
export function chooseArm(input: { seed: string; contactId: string; weights: number[]; counts: number[]; tolerance: number }) {
  const { weights, counts, tolerance } = input, bucket = hashBucket(input.seed, input.contactId), total = weights.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return fail("INVALID_ALLOCATION", 400);
  let cumulative = 0, candidate = weights.findIndex(w => w > 0);
  for (let i = 0; i < weights.length; i++) { cumulative += (weights[i]! / total) * 10000; if (weights[i]! > 0 && bucket < cumulative) { candidate = i; break; } }
  const n = counts.reduce((a, b) => a + b, 0) + 1, target = (i: number) => (weights[i]! / total) * n;
  if ((counts[candidate] ?? 0) + 1 - target(candidate) <= tolerance) return { index: candidate, bucket, assignment: "randomized" as const };
  let best = -1, bestDeficit = Number.NEGATIVE_INFINITY;
  for (let k = 0; k < weights.length; k++) {
    const i = (bucket + k) % weights.length; if (!(weights[i]! > 0)) continue;
    const deficit = target(i) - (counts[i] ?? 0); if (deficit > bestDeficit) { best = i; bestDeficit = deficit; }
  }
  return { index: best, bucket, assignment: "balanced" as const };
}

// ---------------------------------------------------------------- evaluation (DOTS-115) and stop rules (DOTS-120)
export type ArmEvidence = { armId: string; armKey: string; role: ArmRole; strategyRevisionId: string; modelId: string | null; enrolled: number; exposed: number; maturedExposed: number; maturedSuccesses: number; complaints: number; unsubscribes: number; costCents: number; fundsCents: number };
export type ExperimentPolicy = { minSamplePerArm: number; alphaBasisPoints: number; maxComplaintBasisPoints: number; maxUnsubscribeBasisPoints: number; budgetCents: number; weights: number[]; seed: string; draws?: number };
export function stopRuleBreaches(arms: Pick<ArmEvidence, "armKey" | "exposed" | "complaints" | "unsubscribes" | "costCents">[], policy: Pick<ExperimentPolicy, "maxComplaintBasisPoints" | "maxUnsubscribeBasisPoints" | "budgetCents">): string[] {
  const breaches = new Set<string>();
  for (const arm of arms) {
    if (arm.complaints > 0 && arm.complaints * 10000 > policy.maxComplaintBasisPoints * Math.max(arm.exposed, 1)) breaches.add("COMPLAINT_LIMIT");
    if (arm.unsubscribes > 0 && arm.unsubscribes * 10000 > policy.maxUnsubscribeBasisPoints * Math.max(arm.exposed, 1)) breaches.add("UNSUBSCRIBE_LIMIT");
  }
  const spent = arms.reduce((a, arm) => a + arm.costCents, 0);
  if (spent > 0 && spent >= policy.budgetCents) breaches.add("BUDGET_EXHAUSTED");
  return [...breaches];
}
export function evaluateExperiment(arms: ArmEvidence[], policy: ExperimentPolicy) {
  const alpha = policy.alphaBasisPoints / 10000, warnings = new Set<string>();
  const champions = arms.filter(a => a.role === "champion"), challengers = arms.filter(a => a.role === "experimental");
  const pooled = { successes: champions.reduce((a, b) => a + b.maturedSuccesses, 0), total: champions.reduce((a, b) => a + b.maturedExposed, 0) };
  if (arms.every(a => a.exposed === 0)) warnings.add("NO_VERIFIED_EVIDENCE");
  if (arms.some(a => a.maturedExposed < policy.minSamplePerArm)) warnings.add("SAMPLE_BELOW_FLOOR");
  if (arms.some(a => a.exposed > a.maturedExposed)) warnings.add("LAG_WINDOW_OPEN");
  if (arms.some(a => a.maturedSuccesses < 10)) warnings.add("FEW_OUTCOME_EVENTS");
  const srm = sampleRatioMismatch(arms.map(a => a.enrolled), policy.weights);
  if (arms.reduce((a, b) => a + b.enrolled, 0) >= 20 && srm.pValue < 0.001) warnings.add("IMBALANCED_ALLOCATION");
  const exposureImbalance = contingencyChiSquare(arms.map(a => [a.exposed, Math.max(0, a.enrolled - a.exposed)]));
  if (exposureImbalance.pValue < 0.01) warnings.add("EXPOSURE_RATE_DIFFERS_BY_ARM");
  const breaches = stopRuleBreaches(arms, policy); breaches.forEach(b => warnings.add(b));
  const comparisons = challengers.map(arm => {
    const test = twoProportion(pooled.successes, pooled.total, arm.maturedSuccesses, arm.maturedExposed);
    const superiority = pooled.total && arm.maturedExposed ? probabilityOfSuperiority(pooled.successes, pooled.total, arm.maturedSuccesses, arm.maturedExposed, { seed: `${policy.seed}:${arm.armId}`, draws: policy.draws ?? 20000 }) : null;
    return { armId: arm.armId, armKey: arm.armKey, ...test, probabilityOfSuperiority: superiority, interval: wilson(arm.maturedSuccesses, arm.maturedExposed) };
  });
  const discoveries = benjaminiHochberg(comparisons.map(c => c.pValue ?? 1), alpha);
  const detailed = comparisons.map((c, i) => {
    const significant = discoveries[i]! && (c.difference ?? 0) > 0;
    const stable = significant && (c.lower ?? 0) > 0 && (c.probabilityOfSuperiority ?? 0) >= 0.95;
    return { ...c, bhSignificant: discoveries[i]!, stableUplift: stable };
  });
  if (!detailed.some(c => c.stableUplift)) warnings.add("UNSTABLE_UPLIFT");
  const blocking = ["NO_VERIFIED_EVIDENCE", "SAMPLE_BELOW_FLOOR", "LAG_WINDOW_OPEN", "IMBALANCED_ALLOCATION", "COMPLAINT_LIMIT", "UNSUBSCRIBE_LIMIT"].filter(w => warnings.has(w));
  const stableWinners = detailed.filter(c => c.stableUplift).sort((a, b) => (b.difference ?? 0) - (a.difference ?? 0));
  const autoPromotable = blocking.length === 0 && !warnings.has("FEW_OUTCOME_EVENTS") && !warnings.has("EXPOSURE_RATE_DIFFERS_BY_ARM") && stableWinners.length > 0;
  return {
    alpha, metric: "qualified_response_per_matured_verified_exposure", pooledChampion: { ...pooled, ...wilson(pooled.successes, pooled.total) },
    arms: arms.map(a => ({ armId: a.armId, armKey: a.armKey, role: a.role, successes: a.maturedSuccesses, denominator: a.maturedExposed, ...wilson(a.maturedSuccesses, a.maturedExposed) })),
    comparisons: detailed, sampleRatio: srm, warnings: [...warnings].sort(), blocking, safetyBreaches: breaches,
    manualPromotionAllowed: blocking.length === 0, autoPromotable, recommendedArmId: autoPromotable ? stableWinners[0]!.armId : null,
  };
}

// ---------------------------------------------------------------- factorial (DOTS-116)
export function factorialReport(arms: ArmEvidence[], segmentCounts: Record<string, Record<string, number>>) {
  const strategies = [...new Set(arms.map(a => a.strategyRevisionId))], models = [...new Set(arms.map(a => a.modelId ?? "unspecified"))], warnings = new Set<string>();
  const pool = (list: ArmEvidence[]) => { const successes = list.reduce((a, b) => a + b.maturedSuccesses, 0), total = list.reduce((a, b) => a + b.maturedExposed, 0), cost = list.reduce((a, b) => a + b.costCents, 0), exposed = list.reduce((a, b) => a + b.exposed, 0); return { successes, denominator: total, ...wilson(successes, total), costCents: cost, costPerExposureCents: exposed ? Math.round(cost / exposed) : null, complaints: list.reduce((a, b) => a + b.complaints, 0) }; };
  const missing = strategies.flatMap(s => models.filter(m => !arms.some(a => a.strategyRevisionId === s && (a.modelId ?? "unspecified") === m)).map(m => ({ strategyRevisionId: s, modelId: m })));
  if (missing.length) warnings.add("INCOMPLETE_FACTORIAL_CONFOUNDS_MODEL_AND_STRATEGY");
  if (strategies.length < 2 || models.length < 2) warnings.add("SINGLE_LEVEL_FACTOR_NOT_ESTIMABLE");
  const segments = [...new Set(Object.values(segmentCounts).flatMap(Object.keys))].sort();
  const segmentTest = contingencyChiSquare(arms.map(a => segments.map(s => segmentCounts[a.armId]?.[s] ?? 0)));
  if (segmentTest.pValue < 0.01) warnings.add("SEGMENT_IMBALANCE_ACROSS_CELLS");
  const exposureTest = contingencyChiSquare(arms.map(a => [a.exposed, Math.max(0, a.enrolled - a.exposed)]));
  if (exposureTest.pValue < 0.01) warnings.add("SELECTION_BIAS_EXPOSURE_RATE_DIFFERS");
  if (arms.some(a => a.maturedExposed < 30)) warnings.add("SMALL_CELLS");
  const strategyEffects = strategies.map(s => ({ strategyRevisionId: s, ...pool(arms.filter(a => a.strategyRevisionId === s)) }));
  const modelEffects = models.map(m => ({ modelId: m, ...pool(arms.filter(a => (a.modelId ?? "unspecified") === m)) }));
  type Pooled = { rate: number | null; lower: number | null; upper: number | null };
  const separated = <T extends Pooled>(list: T[]): T | null => { const sorted = [...list].sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1)); const [first, second] = sorted; return first && second && first.lower !== null && second.upper !== null && first.lower > second.upper ? first : null; };
  const strategyWinner = separated(strategyEffects), modelWinner = separated(modelEffects);
  return {
    cells: arms.map(a => ({ armId: a.armId, armKey: a.armKey, strategyRevisionId: a.strategyRevisionId, modelId: a.modelId, ...pool([a]), segmentMix: segmentCounts[a.armId] ?? {} })),
    strategyEffects, modelEffects, missingCells: missing, segmentBalance: segmentTest, exposureBalance: exposureTest,
    separatedWinner: { strategy: strategyWinner?.strategyRevisionId ?? null, model: modelWinner?.modelId ?? null },
    warnings: [...warnings].sort(), decisionNote: "Model and strategy effects are marginal pooled rates; review confounder and selection-bias warnings before acting.",
  };
}

// ---------------------------------------------------------------- constraint checks (DOTS-110)
export function strategyConstraintViolations(revision: { forbidden_claims: unknown; allowed_personalization: unknown; disclosures: unknown }, message: string, personalizationUsed: string[] = []): string[] {
  const body = message.toLowerCase(), violations: string[] = [];
  for (const claim of (revision.forbidden_claims as string[]) ?? []) if (claim && body.includes(claim.toLowerCase())) violations.push(`FORBIDDEN_CLAIM:${claim}`);
  for (const field of personalizationUsed) if (!((revision.allowed_personalization as string[]) ?? []).includes(field)) violations.push(`PERSONALIZATION_NOT_ALLOWED:${field}`);
  for (const disclosure of (revision.disclosures as string[]) ?? []) if (!body.includes(disclosure.toLowerCase())) violations.push(`DISCLOSURE_MISSING:${disclosure}`);
  return violations;
}

// ---------------------------------------------------------------- validators
function stringList(value: unknown, field: string, maxItems: number, maxLength: number, minItems = 0): string[] {
  if (!Array.isArray(value) || value.length < minItems || value.length > maxItems) return fail(`INVALID_${field.toUpperCase()}`, 400);
  const list = value.map(item => text(item, field, maxLength));
  return [...new Set(list)];
}
function integer(value: unknown, field: string, min: number, max: number, fallback?: number): number {
  const v = value === undefined || value === null ? fallback : value;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) return fail(`INVALID_${field.toUpperCase()}`, 400);
  return v;
}
export type RevisionInput = { objective: unknown; audienceRules: unknown; allowedPersonalization: unknown; forbiddenClaims: unknown; tone: unknown; disclosures: unknown; instructions: unknown };
export function normalizeRevision(input: RevisionInput) {
  const allowed = stringList(input.allowedPersonalization, "personalization", PERSONALIZATION_FIELDS.length, 40);
  if (allowed.some(f => !(PERSONALIZATION_FIELDS as readonly string[]).includes(f))) return fail("PERSONALIZATION_FIELD_NOT_ALLOWED", 400);
  return {
    objective: text(input.objective, "objective", 2000), audienceRules: stringList(input.audienceRules, "audience_rules", 20, 300, 1),
    allowedPersonalization: allowed.sort(), forbiddenClaims: stringList(input.forbiddenClaims, "forbidden_claims", 50, 300),
    tone: text(input.tone, "tone", 200), disclosures: stringList(input.disclosures, "disclosures", 10, 300, 1), instructions: text(input.instructions, "instructions", 6000),
  };
}
function occurred(value: unknown): string {
  const date = new Date(typeof value === "string" || value instanceof Date ? value : NaN);
  if (!Number.isFinite(date.getTime())) return fail("INVALID_OCCURRED_AT", 400);
  if (date.getTime() > Date.now() + CLOCK_SKEW_MS) return fail("FUTURE_OUTCOME_REJECTED", 400);
  return date.toISOString();
}

// ---------------------------------------------------------------- repository
export type ArmInput = { key: unknown; role: unknown; strategyRevisionId: unknown; modelId?: unknown };
export type OutcomeInput = { experimentId: unknown; contactId: unknown; kind: unknown; evidenceSource: unknown; occurredAt: unknown; idempotencyKey: unknown; amountCents?: unknown; originalCurrency?: unknown; originalAmountMinor?: unknown; fxSource?: unknown; isEstimate?: unknown; receiptProvider?: unknown; receiptEventId?: unknown; evidenceRef?: unknown };

export class StrategyLab {
  constructor(private readonly client: Client, private readonly ctx: Context) {}
  private get org() { return this.ctx.organizationId; }

  // DOTS-110: families and immutable revisions
  async createFamily(input: { label: unknown; projectId?: unknown } & RevisionInput) {
    const label = text(input.label, "label", 120), projectId = input.projectId ? identifier(input.projectId) : null, fields = normalizeRevision(input);
    return tenant(this.client, this.ctx, async tx => {
      const family = rows(await tx.query("INSERT INTO app.strategy_families(organization_id,project_id,label,owner_membership_id) VALUES($1,$2,$3,$4) RETURNING *", [this.org, projectId, label, this.ctx.membershipId]))[0]!;
      const revision = await this.insertRevision(tx, family.id, fields, []);
      await event(tx, this.ctx, "strategy.family_created", family.id, { revisionId: revision.id, fingerprint: revision.fingerprint });
      return { family, revision };
    });
  }
  private async insertRevision(tx: Client, familyId: string, fields: ReturnType<typeof normalizeRevision>, parents: { id: string; elements: string[] }[]) {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`strategy-family:${this.org}:${familyId}`]);
    const next = Number(rows(await tx.query("SELECT COALESCE(max(revision),0)+1 AS next FROM app.strategy_revisions WHERE organization_id=$1 AND family_id=$2", [this.org, familyId]))[0]!.next);
    const fingerprint = digest({ familyId, revision: next, ...fields, parents: parents.map(p => p.id).sort() });
    const revision = rows(await tx.query(`INSERT INTO app.strategy_revisions(organization_id,family_id,revision,objective,audience_rules,allowed_personalization,forbidden_claims,tone,disclosures,instructions,fingerprint,created_by_membership_id)
      VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9::jsonb,$10,$11,$12) RETURNING *`, [this.org, familyId, next, fields.objective, JSON.stringify(fields.audienceRules), JSON.stringify(fields.allowedPersonalization), JSON.stringify(fields.forbiddenClaims), fields.tone, JSON.stringify(fields.disclosures), fields.instructions, fingerprint, this.ctx.membershipId]))[0]!;
    for (const parent of parents) await tx.query("INSERT INTO app.strategy_lineage(organization_id,child_revision_id,parent_revision_id,inherited_elements) VALUES($1,$2,$3,$4::jsonb)", [this.org, revision.id, parent.id, JSON.stringify(parent.elements)]);
    return revision;
  }
  /** Editing never mutates a revision: it proposes the next revision of the family. */
  async proposeRevision(familyId: unknown, input: RevisionInput) {
    const family = identifier(familyId), fields = normalizeRevision(input);
    return tenant(this.client, this.ctx, async tx => {
      const owner = rows(await tx.query("SELECT id FROM app.strategy_families WHERE organization_id=$1 AND id=$2 AND status='active'", [this.org, family]))[0];
      if (!owner) return fail("STRATEGY_FAMILY_NOT_FOUND", 404);
      const revision = await this.insertRevision(tx, family, fields, []);
      await event(tx, this.ctx, "strategy.revision_proposed", revision.id, { familyId: family, revision: revision.revision, fingerprint: revision.fingerprint });
      return revision;
    });
  }
  async decideRevision(revisionId: unknown, approved: boolean) {
    const id = identifier(revisionId);
    return tenant(this.client, this.ctx, async tx => {
      const saved = rows(await tx.query("UPDATE app.strategy_revisions SET status=$3,decided_by_membership_id=$4,decided_at=app.utc_now() WHERE organization_id=$1 AND id=$2 AND status='proposed' RETURNING *", [this.org, id, approved ? "approved" : "rejected", this.ctx.membershipId]))[0];
      if (!saved) return fail("REVISION_NOT_PROPOSED");
      await event(tx, this.ctx, approved ? "strategy.revision_approved" : "strategy.revision_rejected", id, { fingerprint: saved.fingerprint });
      return saved;
    });
  }
  async retireRevision(revisionId: unknown) {
    const id = identifier(revisionId);
    return tenant(this.client, this.ctx, async tx => {
      const champion = rows(await tx.query("SELECT id FROM app.strategy_allocation_rules WHERE organization_id=$1 AND champion_revision_id=$2", [this.org, id]));
      if (champion.length) return fail("CHAMPION_REVISION_CANNOT_BE_RETIRED");
      const saved = rows(await tx.query("UPDATE app.strategy_revisions SET status='retired',decided_by_membership_id=$3,decided_at=app.utc_now() WHERE organization_id=$1 AND id=$2 AND status='approved' RETURNING id", [this.org, id, this.ctx.membershipId]))[0];
      if (!saved) return fail("REVISION_NOT_APPROVED");
      await event(tx, this.ctx, "strategy.revision_retired", id);
    });
  }

  // DOTS-111: stored allocation rules
  async saveAllocation(input: { projectId: unknown; campaignId?: unknown; experimentalBasisPoints?: unknown; minExplorationBasisPoints?: unknown; belowFloorAcknowledgement?: unknown; autoPromoteEnabled?: unknown; championRevisionId?: unknown; expectedVersion?: unknown }) {
    const projectId = identifier(input.projectId), campaignId = input.campaignId ? identifier(input.campaignId) : null;
    return tenant(this.client, this.ctx, async tx => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`strategy-allocation:${this.org}:${projectId}:${campaignId ?? ""}`]);
      const existing = rows(await tx.query("SELECT * FROM app.strategy_allocation_rules WHERE organization_id=$1 AND project_id=$2 AND campaign_id IS NOT DISTINCT FROM $3::uuid FOR UPDATE", [this.org, projectId, campaignId]))[0];
      if (existing && input.expectedVersion !== undefined && Number(existing.version) !== input.expectedVersion) return fail("STALE_ALLOCATION_RULE");
      if (campaignId && !rows(await tx.query("SELECT id FROM app.campaigns WHERE organization_id=$1 AND id=$2 AND project_id=$3", [this.org, campaignId, projectId])).length) return fail("CAMPAIGN_NOT_IN_PROJECT", 400);
      const experimental = integer(input.experimentalBasisPoints, "experimental_basis_points", 0, 10000, existing ? Number(existing.experimental_basis_points) : SUGGESTED_EXPERIMENTAL_BASIS_POINTS);
      const floor = integer(input.minExplorationBasisPoints, "min_exploration_basis_points", 0, 5000, existing ? Number(existing.min_exploration_basis_points) : SUGGESTED_MIN_EXPLORATION_BASIS_POINTS);
      const below = experimental < floor;
      const acknowledgement = below ? (typeof input.belowFloorAcknowledgement === "string" && input.belowFloorAcknowledgement.trim() ? text(input.belowFloorAcknowledgement, "acknowledgement", 500) : fail("EXPLORATION_FLOOR_ACKNOWLEDGEMENT_REQUIRED", 400)) : null;
      const autoPromote = input.autoPromoteEnabled === undefined ? Boolean(existing?.auto_promote_enabled) : input.autoPromoteEnabled === true;
      let champion: string | null = existing?.champion_revision_id ?? null;
      if (input.championRevisionId !== undefined) {
        if (existing?.champion_revision_id && input.championRevisionId !== existing.champion_revision_id) return fail("USE_PROMOTION_TO_CHANGE_CHAMPION");
        champion = input.championRevisionId === null ? null : identifier(input.championRevisionId);
        if (champion && !rows(await tx.query("SELECT id FROM app.strategy_revisions WHERE organization_id=$1 AND id=$2 AND status='approved'", [this.org, champion])).length) return fail("REVISION_NOT_APPROVED");
      }
      const rule = existing
        ? rows(await tx.query("UPDATE app.strategy_allocation_rules SET experimental_basis_points=$3,min_exploration_basis_points=$4,below_floor_acknowledgement=$5,auto_promote_enabled=$6,champion_revision_id=$7,version=version+1,updated_by_membership_id=$8,updated_at=app.utc_now() WHERE organization_id=$1 AND id=$2 RETURNING *", [this.org, existing.id, experimental, floor, acknowledgement, autoPromote, champion, this.ctx.membershipId]))[0]!
        : rows(await tx.query("INSERT INTO app.strategy_allocation_rules(organization_id,project_id,campaign_id,champion_revision_id,experimental_basis_points,min_exploration_basis_points,below_floor_acknowledgement,auto_promote_enabled,updated_by_membership_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *", [this.org, projectId, campaignId, champion, experimental, floor, acknowledgement, autoPromote, this.ctx.membershipId]))[0]!;
      await this.history(tx, rule);
      await event(tx, this.ctx, "strategy.allocation_saved", rule.id, { experimentalBasisPoints: experimental, minExplorationBasisPoints: floor, belowFloor: below, acknowledgementRecorded: Boolean(acknowledgement), version: Number(rule.version) });
      return rule;
    });
  }
  private async history(tx: Client, rule: Row) {
    await tx.query("INSERT INTO app.strategy_allocation_history(organization_id,rule_id,version,experimental_basis_points,min_exploration_basis_points,below_floor,below_floor_acknowledgement,auto_promote_enabled,champion_revision_id,changed_by_membership_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [this.org, rule.id, rule.version, rule.experimental_basis_points, rule.min_exploration_basis_points, Number(rule.experimental_basis_points) < Number(rule.min_exploration_basis_points), rule.below_floor_acknowledgement, rule.auto_promote_enabled, rule.champion_revision_id, this.ctx.membershipId]);
  }

  // DOTS-112: experiments and deterministic enrollment
  async createExperiment(input: { allocationRuleId: unknown; label: unknown; design?: unknown; arms: unknown; minSamplePerArm?: unknown; lagDays?: unknown; alphaBasisPoints?: unknown; maxComplaintBasisPoints?: unknown; maxUnsubscribeBasisPoints?: unknown; budgetCents?: unknown; stratumTolerance?: unknown; previousExperimentId?: unknown }) {
    const ruleId = identifier(input.allocationRuleId), label = text(input.label, "label", 160), design = selection(input.design ?? "ab", ["ab", "factorial"], "design");
    if (!Array.isArray(input.arms) || input.arms.length < 2 || input.arms.length > 12) return fail("INVALID_ARMS", 400);
    const arms = (input.arms as ArmInput[]).map(arm => ({ key: typeof arm.key === "string" && /^[a-z0-9_-]{1,40}$/.test(arm.key) ? arm.key : fail("INVALID_ARM_KEY", 400), role: selection(arm.role, ["champion", "experimental"], "arm_role") as ArmRole, strategyRevisionId: identifier(arm.strategyRevisionId), modelId: arm.modelId === undefined || arm.modelId === null || arm.modelId === "" ? null : text(arm.modelId, "model_id", 120) }));
    if (new Set(arms.map(a => a.key)).size !== arms.length) return fail("DUPLICATE_ARM_KEY", 400);
    armWeights(arms.map(a => a.role), 5000);
    if (design === "factorial" && arms.some(a => !a.modelId)) return fail("FACTORIAL_REQUIRES_MODEL_PER_ARM", 400);
    if (new Set(arms.map(a => `${a.strategyRevisionId}|${a.modelId ?? ""}`)).size !== arms.length) return fail("DUPLICATE_ARM_TREATMENT", 400);
    const policy = { minSamplePerArm: integer(input.minSamplePerArm, "min_sample_per_arm", 30, 1_000_000, 200), lagDays: integer(input.lagDays, "lag_days", 0, 365, 14), alphaBasisPoints: integer(input.alphaBasisPoints, "alpha_basis_points", 1, 2000, 500), maxComplaintBasisPoints: integer(input.maxComplaintBasisPoints, "max_complaint_basis_points", 0, 10000, 30), maxUnsubscribeBasisPoints: integer(input.maxUnsubscribeBasisPoints, "max_unsubscribe_basis_points", 0, 10000, 200), budgetCents: cents(input.budgetCents ?? 0), stratumTolerance: integer(input.stratumTolerance, "stratum_tolerance", 1, 20, 2) };
    return tenant(this.client, this.ctx, async tx => {
      const rule = rows(await tx.query("SELECT * FROM app.strategy_allocation_rules WHERE organization_id=$1 AND id=$2 FOR UPDATE", [this.org, ruleId]))[0];
      if (!rule) return fail("ALLOCATION_RULE_NOT_FOUND", 404);
      const revisions = rows(await tx.query("SELECT id,status,fingerprint FROM app.strategy_revisions WHERE organization_id=$1 AND id=ANY($2::uuid[])", [this.org, arms.map(a => a.strategyRevisionId)]));
      if (arms.some(a => revisions.find(r => r.id === a.strategyRevisionId)?.status !== "approved")) return fail("REVISION_NOT_APPROVED");
      if (rule.champion_revision_id && arms.some(a => a.role === "champion" && a.strategyRevisionId !== rule.champion_revision_id)) return fail("CHAMPION_ARM_MUST_USE_CURRENT_CHAMPION");
      let revision = 1, previous: Row | undefined;
      if (input.previousExperimentId) {
        previous = rows(await tx.query("SELECT * FROM app.strategy_experiments WHERE organization_id=$1 AND id=$2 AND allocation_rule_id=$3 FOR UPDATE", [this.org, identifier(input.previousExperimentId), ruleId]))[0];
        if (!previous) return fail("PREVIOUS_EXPERIMENT_NOT_FOUND", 404);
        revision = Number(previous.revision) + 1;
        if (["active", "paused"].includes(previous.state)) await tx.query("UPDATE app.strategy_experiments SET state='superseded',stop_reason='NEW_REVISION',updated_at=app.utc_now() WHERE organization_id=$1 AND id=$2", [this.org, previous.id]);
      }
      if (rows(await tx.query("SELECT id FROM app.strategy_experiments WHERE organization_id=$1 AND allocation_rule_id=$2 AND state IN ('active','paused')", [this.org, ruleId])).length) return fail("ACTIVE_EXPERIMENT_EXISTS");
      const seed = randomBytes(16).toString("hex");
      const fingerprint = digest({ ruleId, label, design, revision, arms: arms.map(a => ({ ...a, fingerprint: revisions.find(r => r.id === a.strategyRevisionId)?.fingerprint })), policy, seed });
      const experiment = rows(await tx.query(`INSERT INTO app.strategy_experiments(organization_id,project_id,campaign_id,allocation_rule_id,label,design,revision,previous_experiment_id,seed,min_sample_per_arm,lag_days,alpha_basis_points,max_complaint_basis_points,max_unsubscribe_basis_points,budget_cents,stratum_tolerance,fingerprint,created_by_membership_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`, [this.org, rule.project_id, rule.campaign_id, ruleId, label, design, revision, previous?.id ?? null, seed, policy.minSamplePerArm, policy.lagDays, policy.alphaBasisPoints, policy.maxComplaintBasisPoints, policy.maxUnsubscribeBasisPoints, policy.budgetCents, policy.stratumTolerance, fingerprint, this.ctx.membershipId]))[0]!;
      for (const arm of arms) await tx.query("INSERT INTO app.strategy_experiment_arms(organization_id,experiment_id,arm_key,role,strategy_revision_id,model_id) VALUES($1,$2,$3,$4,$5,$6)", [this.org, experiment.id, arm.key, arm.role, arm.strategyRevisionId, arm.modelId]);
      await tx.query("UPDATE app.strategy_variant_backlog SET status='evaluating',version=version+1,updated_at=app.utc_now() WHERE organization_id=$1 AND proposed_revision_id=ANY($2::uuid[]) AND status IN ('idea','drafted')", [this.org, arms.filter(a => a.role === "experimental").map(a => a.strategyRevisionId)]);
      await event(tx, this.ctx, "strategy.experiment_created", experiment.id, { revision, fingerprint, arms: arms.length, design });
      return experiment;
    });
  }
  async setExperimentState(experimentId: unknown, state: unknown, reason?: unknown) {
    const id = identifier(experimentId), next = selection(state, ["active", "paused", "stopped", "completed"], "state");
    const from = next === "active" ? ["paused"] : next === "paused" ? ["active"] : ["active", "paused"];
    return tenant(this.client, this.ctx, async tx => {
      const current = rows(await tx.query("SELECT state,stop_reason FROM app.strategy_experiments WHERE organization_id=$1 AND id=$2 FOR UPDATE", [this.org, id]))[0];
      if (!current) return fail("NOT_FOUND", 404);
      if (next === "active" && current.stop_reason) return fail("SAFETY_STOP_REQUIRES_NEW_REVISION");
      const saved = rows(await tx.query("UPDATE app.strategy_experiments SET state=$3,stop_reason=COALESCE($4,stop_reason),updated_at=app.utc_now() WHERE organization_id=$1 AND id=$2 AND state=ANY($5::text[]) RETURNING *", [this.org, id, next, reason ? text(reason, "reason", 200) : null, from]))[0];
      if (!saved) return fail("INVALID_EXPERIMENT_TRANSITION");
      await event(tx, this.ctx, "strategy.experiment_state", id, { state: next });
      return saved;
    });
  }
  async enroll(experimentId: unknown, contactId: unknown, options: { segment?: unknown } = {}) {
    const experiment = identifier(experimentId), contact = identifier(contactId);
    const explicitSegment = options.segment === undefined || options.segment === null || options.segment === "" ? null : text(options.segment, "segment", 80);
    return tenant(this.client, this.ctx, async tx => {
      const ex = rows(await tx.query("SELECT * FROM app.strategy_experiments WHERE organization_id=$1 AND id=$2", [this.org, experiment]))[0];
      if (!ex) return fail("NOT_FOUND", 404);
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`strategy-enroll:${this.org}:${ex.project_id}:${contact}`]);
      const existing = rows(await tx.query("SELECT en.*,a.arm_key FROM app.strategy_enrollments en JOIN app.strategy_experiment_arms a ON a.organization_id=en.organization_id AND a.id=en.arm_id WHERE en.organization_id=$1 AND en.experiment_id=$2 AND en.contact_id=$3", [this.org, experiment, contact]))[0];
      if (existing) return { armId: existing.arm_id, armKey: existing.arm_key, stratum: existing.stratum, assignment: existing.assignment, repeated: true };
      if (ex.state !== "active") return fail("EXPERIMENT_NOT_ACTIVE");
      const person = rows(await tx.query(`SELECT c.id,acc.sector FROM app.crm_contacts c LEFT JOIN app.crm_accounts acc ON acc.organization_id=c.organization_id AND acc.id=c.account_id
        WHERE c.organization_id=$1 AND c.id=$2 AND c.status='active' AND c.consent<>'opted_out' AND NOT EXISTS(SELECT 1 FROM app.contact_suppressions s WHERE s.organization_id=c.organization_id AND s.email_hash=c.email_hash)`, [this.org, contact]))[0];
      if (!person) return fail("CONTACT_NOT_ELIGIBLE");
      if (ex.campaign_id && !rows(await tx.query("SELECT 1 FROM app.campaign_audience WHERE organization_id=$1 AND campaign_id=$2 AND contact_id=$3", [this.org, ex.campaign_id, contact])).length) return fail("CONTACT_NOT_IN_CAMPAIGN_AUDIENCE");
      const overlap = rows(await tx.query(`SELECT 1 FROM app.strategy_enrollments en JOIN app.strategy_experiments e ON e.organization_id=en.organization_id AND e.id=en.experiment_id
        WHERE en.organization_id=$1 AND en.contact_id=$2 AND e.project_id=$3 AND e.id<>$4 AND e.state IN ('active','paused')
        UNION ALL SELECT 1 FROM app.experiment_enrollments le JOIN app.experiments le_ex ON le_ex.organization_id=le.organization_id AND le_ex.id=le.experiment_id WHERE le.organization_id=$1 AND le.contact_id=$2 AND le_ex.project_id=$3 AND le_ex.state='active'`, [this.org, contact, ex.project_id, experiment]));
      if (overlap.length) return fail("EXPERIMENT_OVERLAP");
      const rule = rows(await tx.query("SELECT * FROM app.strategy_allocation_rules WHERE organization_id=$1 AND id=$2 FOR SHARE", [this.org, ex.allocation_rule_id]))[0]!;
      const arms = rows(await tx.query("SELECT id,arm_key,role FROM app.strategy_experiment_arms WHERE organization_id=$1 AND experiment_id=$2 ORDER BY arm_key", [this.org, experiment]));
      const weights = armWeights(arms.map(a => a.role as ArmRole), Number(rule.experimental_basis_points));
      const segment = explicitSegment ?? (person.sector ? `sector:${String(person.sector).slice(0, 70)}` : "unsegmented");
      const stratum = `${ex.campaign_id ?? "project"}|${segment}`;
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`strategy-stratum:${this.org}:${experiment}:${stratum}`]);
      const counted = rows(await tx.query("SELECT arm_id,count(*)::int AS n FROM app.strategy_enrollments WHERE organization_id=$1 AND experiment_id=$2 AND stratum=$3 GROUP BY arm_id", [this.org, experiment, stratum]));
      const choice = chooseArm({ seed: ex.seed, contactId: contact, weights, counts: arms.map(a => Number(counted.find(c => c.arm_id === a.id)?.n ?? 0)), tolerance: Number(ex.stratum_tolerance) });
      const arm = arms[choice.index]!;
      const inserted = rows(await tx.query("INSERT INTO app.strategy_enrollments(organization_id,experiment_id,contact_id,arm_id,segment,stratum,hash_bucket,assignment,allocation_basis_points,allocation_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING RETURNING arm_id",
        [this.org, experiment, contact, arm.id, segment, stratum, choice.bucket, choice.assignment, Number(rule.experimental_basis_points), Number(rule.version)]));
      if (!inserted.length) {
        const winner = rows(await tx.query("SELECT en.*,a.arm_key FROM app.strategy_enrollments en JOIN app.strategy_experiment_arms a ON a.organization_id=en.organization_id AND a.id=en.arm_id WHERE en.organization_id=$1 AND en.experiment_id=$2 AND en.contact_id=$3", [this.org, experiment, contact]))[0]!;
        return { armId: winner.arm_id, armKey: winner.arm_key, stratum: winner.stratum, assignment: winner.assignment, repeated: true };
      }
      await event(tx, this.ctx, "strategy.enrolled", experiment, { armKey: arm.arm_key, stratum, assignment: choice.assignment, allocationVersion: Number(rule.version) }, "worker");
      return { armId: arm.id, armKey: arm.arm_key, stratum, assignment: choice.assignment, repeated: false };
    });
  }

  // DOTS-113: verified outcome accounting
  async recordOutcome(input: OutcomeInput) {
    const experiment = identifier(input.experimentId), contact = identifier(input.contactId), kind = selection(input.kind, OUTCOME_KINDS, "kind"), source = selection(input.evidenceSource, EVIDENCE_SOURCES, "evidence_source");
    const key = text(input.idempotencyKey, "idempotency_key", 200), occurredAt = occurred(input.occurredAt), amount = input.amountCents === undefined ? 0 : cents(input.amountCents);
    const currency = input.originalCurrency === undefined ? "USD" : (typeof input.originalCurrency === "string" && /^[A-Z]{3}$/.test(input.originalCurrency) ? input.originalCurrency : fail("INVALID_CURRENCY", 400));
    const originalMinor = currency === "USD" ? null : cents(input.originalAmountMinor), fxSource = currency === "USD" ? null : text(input.fxSource, "fx_source", 200);
    const isEstimate = kind === "deal" ? true : kind === "funds_received" ? false : input.isEstimate === true;
    if (["funds_received", "cost"].includes(kind) && amount <= 0) return fail("POSITIVE_AMOUNT_REQUIRED", 400);
    if (!["funds_received", "cost", "deal"].includes(kind) && amount !== 0) return fail("AMOUNT_NOT_APPLICABLE", 400);
    const receiptProvider = source === "provider" ? text(input.receiptProvider, "receipt_provider", 60) : null, receiptEventId = source === "provider" ? text(input.receiptEventId, "receipt_event_id", 200) : null;
    const evidenceRef = source === "owner_attested" ? text(input.evidenceRef, "evidence_ref", 500) : input.evidenceRef ? text(input.evidenceRef, "evidence_ref", 500) : null;
    const verified = (VERIFIED_SOURCES as readonly string[]).includes(source);
    const payload = { experiment, contact, kind, source, occurredAt, amount, currency, originalMinor, fxSource, isEstimate, receiptProvider, receiptEventId, evidenceRef };
    return tenant(this.client, this.ctx, async tx => {
      const prior = rows(await tx.query("SELECT * FROM app.strategy_outcome_events WHERE organization_id=$1 AND idempotency_key=$2", [this.org, key]))[0];
      if (prior) {
        const same = prior.experiment_id === experiment && prior.contact_id === contact && prior.kind === kind && prior.evidence_source === source && Number(prior.amount_cents) === amount && new Date(prior.occurred_at).toISOString() === occurredAt;
        if (!same) return fail("IDEMPOTENCY_CONFLICT");
        return { id: prior.id, counted: verified, repeated: true, stopReasons: [] as string[] };
      }
      const enrollment = rows(await tx.query("SELECT en.*,ex.state,ex.max_complaint_basis_points,ex.max_unsubscribe_basis_points,ex.budget_cents FROM app.strategy_enrollments en JOIN app.strategy_experiments ex ON ex.organization_id=en.organization_id AND ex.id=en.experiment_id WHERE en.organization_id=$1 AND en.experiment_id=$2 AND en.contact_id=$3", [this.org, experiment, contact]))[0];
      if (!enrollment) return fail("CONTACT_NOT_ENROLLED");
      if (new Date(occurredAt).getTime() < new Date(enrollment.enrolled_at).getTime() - CLOCK_SKEW_MS) return fail("OUTCOME_BEFORE_ENROLLMENT", 400);
      if (receiptProvider && !rows(await tx.query("SELECT 1 FROM app.provider_receipts WHERE organization_id=$1 AND provider=$2 AND event_id=$3", [this.org, receiptProvider, receiptEventId])).length) return fail("PROVIDER_RECEIPT_NOT_FOUND");
      if (verified && !["sent", "cost"].includes(kind) && !rows(await tx.query("SELECT 1 FROM app.strategy_outcome_events WHERE organization_id=$1 AND experiment_id=$2 AND contact_id=$3 AND kind='sent' AND evidence_source IN ('provider','owner_attested')", [this.org, experiment, contact])).length) return fail("OUTCOME_WITHOUT_VERIFIED_EXPOSURE");
      if (verified && kind === "sent" && enrollment.state !== "active") return fail("EXPERIMENT_NOT_ACTIVE");
      const saved = rows(await tx.query(`INSERT INTO app.strategy_outcome_events(organization_id,experiment_id,contact_id,arm_id,kind,amount_cents,original_currency,original_amount_minor,fx_source,is_estimate,evidence_source,receipt_provider,receipt_event_id,evidence_ref,idempotency_key,occurred_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`, [this.org, experiment, contact, enrollment.arm_id, kind, amount, currency, originalMinor, fxSource, isEstimate, source, receiptProvider, receiptEventId, evidenceRef, key, occurredAt]))[0]!;
      await event(tx, this.ctx, "strategy.outcome_recorded", saved.id, { experimentId: experiment, kind, evidenceSource: source, counted: verified, digest: digest(payload) }, source === "provider" ? "provider" : "human");
      let stopReasons: string[] = [];
      if (verified && ["spam_complaint", "unsubscribe", "cost", "sent"].includes(kind) && ["active", "paused"].includes(enrollment.state)) {
        const metrics = rows(await tx.query("SELECT arm_key,exposed,complaints,unsubscribes,cost_actual_cents+cost_estimated_cents AS cost FROM app.strategy_arm_metrics WHERE organization_id=$1 AND experiment_id=$2", [this.org, experiment]));
        stopReasons = stopRuleBreaches(metrics.map(m => ({ armKey: m.arm_key, exposed: Number(m.exposed), complaints: Number(m.complaints), unsubscribes: Number(m.unsubscribes), costCents: Number(m.cost) })), { maxComplaintBasisPoints: Number(enrollment.max_complaint_basis_points), maxUnsubscribeBasisPoints: Number(enrollment.max_unsubscribe_basis_points), budgetCents: Number(enrollment.budget_cents) });
        if (stopReasons.length) {
          await tx.query("UPDATE app.strategy_experiments SET state='stopped',stop_reason=$3,updated_at=app.utc_now() WHERE organization_id=$1 AND id=$2", [this.org, experiment, stopReasons.join(",")]);
          await event(tx, this.ctx, "strategy.experiment_stopped", experiment, { reasons: stopReasons }, "worker");
        }
      }
      return { id: saved.id as string, counted: verified, repeated: false, stopReasons };
    });
  }

  // DOTS-114: metrics
  private async armEvidence(tx: Client, experimentId: string): Promise<{ experiment: Row; rule: Row; arms: (ArmEvidence & { metrics: Row })[] }> {
    const experiment = rows(await tx.query("SELECT * FROM app.strategy_experiments WHERE organization_id=$1 AND id=$2", [this.org, experimentId]))[0];
    if (!experiment) return fail("NOT_FOUND", 404);
    const rule = rows(await tx.query("SELECT * FROM app.strategy_allocation_rules WHERE organization_id=$1 AND id=$2", [this.org, experiment.allocation_rule_id]))[0]!;
    const metrics = rows(await tx.query("SELECT * FROM app.strategy_arm_metrics WHERE organization_id=$1 AND experiment_id=$2 ORDER BY arm_key", [this.org, experimentId]));
    const matured = rows(await tx.query(`WITH sent AS (SELECT DISTINCT contact_id,arm_id FROM app.strategy_outcome_events WHERE organization_id=$1 AND experiment_id=$2 AND kind='sent' AND evidence_source IN ('provider','owner_attested') AND occurred_at<=app.utc_now()-make_interval(days=>$3::int))
      SELECT s.arm_id,count(DISTINCT q.contact_id)::int AS successes FROM sent s LEFT JOIN app.strategy_outcome_events q ON q.organization_id=$1 AND q.experiment_id=$2 AND q.contact_id=s.contact_id AND q.kind='qualified_response' AND q.evidence_source IN ('provider','owner_attested') GROUP BY s.arm_id`, [this.org, experimentId, Number(experiment.lag_days)]));
    return {
      experiment, rule, arms: metrics.map(m => ({
        armId: m.arm_id, armKey: m.arm_key, role: m.role, strategyRevisionId: m.strategy_revision_id, modelId: m.model_id, enrolled: Number(m.enrolled), exposed: Number(m.exposed), maturedExposed: Number(m.matured_exposed),
        maturedSuccesses: Number(matured.find(x => x.arm_id === m.arm_id)?.successes ?? 0), complaints: Number(m.complaints), unsubscribes: Number(m.unsubscribes), costCents: Number(m.cost_actual_cents) + Number(m.cost_estimated_cents), fundsCents: Number(m.funds_actual_cents), metrics: m,
      })),
    };
  }
  private policy(experiment: Row, rule: Row, arms: ArmEvidence[]): ExperimentPolicy {
    return { minSamplePerArm: Number(experiment.min_sample_per_arm), alphaBasisPoints: Number(experiment.alpha_basis_points), maxComplaintBasisPoints: Number(experiment.max_complaint_basis_points), maxUnsubscribeBasisPoints: Number(experiment.max_unsubscribe_basis_points), budgetCents: Number(experiment.budget_cents), weights: armWeights(arms.map(a => a.role), Number(rule.experimental_basis_points)), seed: experiment.seed };
  }
  private async report(tx: Client, experimentId: string) {
    const { experiment, rule, arms } = await this.armEvidence(tx, experimentId);
    const rate = (n: number, d: number) => ({ numerator: n, denominator: d, rate: d ? n / d : null });
    const armMetrics = arms.map(a => {
      const m = a.metrics, exposed = Number(m.exposed), qualified = Number(m.qualified), costActual = Number(m.cost_actual_cents);
      return {
        armId: a.armId, armKey: a.armKey, role: a.role, strategyRevisionId: a.strategyRevisionId, modelId: a.modelId,
        funnel: { enrolled: a.enrolled, exposed, replies: Number(m.replies), qualified, meetings: Number(m.meetings), deals: Number(m.deals), funded: Number(m.funded) },
        conversion: { reply: rate(Number(m.replies), exposed), qualified: rate(qualified, exposed), meeting: rate(Number(m.meetings), exposed), funded: rate(Number(m.funded), exposed) },
        complaintRate: rate(Number(m.complaints), exposed), unsubscribeRate: rate(Number(m.unsubscribes), exposed),
        actual: { fundsCents: Number(m.funds_actual_cents), convertedFundsCents: Number(m.funds_converted_cents), costCents: costActual, marginPerQualifiedCents: qualified ? Math.round((Number(m.funds_actual_cents) - costActual) / qualified) : null, costPerExposureCents: exposed ? Math.round(costActual / exposed) : null },
        estimated: { dealPipelineCents: Number(m.deal_estimated_cents), costCents: Number(m.cost_estimated_cents) },
        excluded: { simulationEvents: Number(m.excluded_simulation_events), modelClaimEvents: Number(m.excluded_model_claim_events) },
        maturedExposed: a.maturedExposed, maturedQualified: a.maturedSuccesses,
      };
    });
    const cohorts = rows(await tx.query(`SELECT a.arm_key,to_char(date_trunc('week',en.enrolled_at),'YYYY-MM-DD') AS cohort,count(*)::int AS enrolled,
      count(*) FILTER(WHERE EXISTS(SELECT 1 FROM app.strategy_outcome_events o WHERE o.organization_id=en.organization_id AND o.experiment_id=en.experiment_id AND o.contact_id=en.contact_id AND o.kind='sent' AND o.evidence_source IN ('provider','owner_attested')))::int AS exposed,
      count(*) FILTER(WHERE EXISTS(SELECT 1 FROM app.strategy_outcome_events o WHERE o.organization_id=en.organization_id AND o.experiment_id=en.experiment_id AND o.contact_id=en.contact_id AND o.kind='qualified_response' AND o.evidence_source IN ('provider','owner_attested')))::int AS qualified
      FROM app.strategy_enrollments en JOIN app.strategy_experiment_arms a ON a.organization_id=en.organization_id AND a.id=en.arm_id WHERE en.organization_id=$1 AND en.experiment_id=$2 GROUP BY 1,2 ORDER BY 2,1`, [this.org, experimentId]));
    const period = rows(await tx.query("SELECT min(enrolled_at) AS first_enrollment,max(enrolled_at) AS last_enrollment FROM app.strategy_enrollments WHERE organization_id=$1 AND experiment_id=$2", [this.org, experimentId]))[0]!;
    const segments = rows(await tx.query("SELECT arm_id,segment,count(*)::int AS n FROM app.strategy_enrollments WHERE organization_id=$1 AND experiment_id=$2 GROUP BY 1,2", [this.org, experimentId]));
    const segmentCounts: Record<string, Record<string, number>> = {};
    for (const s of segments) (segmentCounts[s.arm_id] ??= {})[s.segment] = Number(s.n);
    const evaluation = evaluateExperiment(arms, this.policy(experiment, rule, arms));
    const factorial = experiment.design === "factorial" ? factorialReport(arms, segmentCounts) : null;
    return {
      experiment, rule, arms: armMetrics, cohorts, evaluation, factorial,
      period: { firstEnrollment: period.first_enrollment, lastEnrollment: period.last_enrollment, lagDays: Number(experiment.lag_days), currency: "USD" },
      sources: { counted: VERIFIED_SOURCES, excluded: ["simulation", "model_claim"] },
    };
  }
  async metrics(experimentId: unknown) { const id = identifier(experimentId); return tenant(this.client, this.ctx, tx => this.report(tx, id)); }
  /** Persist an immutable, fingerprinted snapshot of metrics + evaluation (used as promotion evidence). */
  async snapshotMetrics(experimentId: unknown) {
    const id = identifier(experimentId);
    return tenant(this.client, this.ctx, async tx => this.writeSnapshot(tx, id));
  }
  private async writeSnapshot(tx: Client, id: string) {
    const report = await this.report(tx, id);
    const body = { arms: report.arms, cohorts: report.cohorts, period: report.period };
    const fingerprint = digest({ experimentFingerprint: report.experiment.fingerprint, ruleVersion: Number(report.rule.version), body, evaluation: report.evaluation });
    const snapshot = rows(await tx.query("INSERT INTO app.strategy_metric_snapshots(organization_id,experiment_id,metrics,evaluation,fingerprint) VALUES($1,$2,$3::jsonb,$4::jsonb,$5) RETURNING id,fingerprint,computed_at", [this.org, id, JSON.stringify(body), JSON.stringify(report.evaluation), fingerprint]))[0]!;
    await event(tx, this.ctx, "strategy.metrics_snapshot", snapshot.id, { experimentId: id, fingerprint }, "worker");
    return { snapshot, report };
  }
  async provenance(experimentId: unknown, armId?: unknown, limit = 100) {
    const id = identifier(experimentId), arm = armId ? identifier(armId) : null;
    return tenant(this.client, this.ctx, async tx => rows(await tx.query(`SELECT o.id,o.kind,o.evidence_source,o.evidence_source IN ('provider','owner_attested') AS counted,o.receipt_provider,o.receipt_event_id,o.evidence_ref,o.amount_cents,o.original_currency,o.original_amount_minor,o.fx_source,o.is_estimate,o.occurred_at,o.recorded_at,a.arm_key
      FROM app.strategy_outcome_events o JOIN app.strategy_experiment_arms a ON a.organization_id=o.organization_id AND a.id=o.arm_id WHERE o.organization_id=$1 AND o.experiment_id=$2 AND ($3::uuid IS NULL OR o.arm_id=$3::uuid) ORDER BY o.recorded_at DESC LIMIT $4`, [this.org, id, arm, Math.min(500, Math.max(1, Math.trunc(limit)))])));
  }

  // DOTS-117: auditable promotion and rollback
  async promote(input: { experimentId: unknown; armId: unknown; mode?: unknown; rationale: unknown; acknowledgeUncertainty?: unknown }) {
    const id = identifier(input.experimentId), armId = identifier(input.armId), mode = selection(input.mode ?? "manual", ["manual", "automatic"], "mode"), rationale = text(input.rationale, "rationale", 2000);
    const acknowledgement = typeof input.acknowledgeUncertainty === "string" && input.acknowledgeUncertainty.trim() ? text(input.acknowledgeUncertainty, "acknowledgement", 500) : null;
    return tenant(this.client, this.ctx, async tx => {
      const base = rows(await tx.query("SELECT allocation_rule_id,state FROM app.strategy_experiments WHERE organization_id=$1 AND id=$2", [this.org, id]))[0];
      if (!base) return fail("NOT_FOUND", 404);
      const rule = rows(await tx.query("SELECT * FROM app.strategy_allocation_rules WHERE organization_id=$1 AND id=$2 FOR UPDATE", [this.org, base.allocation_rule_id]))[0]!;
      if (!["active", "paused"].includes(base.state)) return fail("EXPERIMENT_NOT_PROMOTABLE");
      const { snapshot, report } = await this.writeSnapshot(tx, id);
      const evaluation = report.evaluation, arm = report.arms.find(a => a.armId === armId);
      if (!arm || arm.role !== "experimental") return fail("PROMOTION_REQUIRES_EVALUATED_EXPERIMENTAL_ARM", 400);
      if (evaluation.safetyBreaches.length) return fail("SAFETY_LIMIT_BREACHED");
      if (!evaluation.manualPromotionAllowed) return fail("INSUFFICIENT_VERIFIED_EVIDENCE");
      const comparison = evaluation.comparisons.find(c => c.armId === armId);
      if (mode === "automatic") {
        if (!rule.auto_promote_enabled) return fail("AUTO_PROMOTION_DISABLED", 403);
        if (!evaluation.autoPromotable || evaluation.recommendedArmId !== armId) return fail("UNSTABLE_UPLIFT_BLOCKS_AUTO_PROMOTION");
      } else if (!comparison?.stableUplift && !acknowledgement) return fail("UNCERTAINTY_ACKNOWLEDGEMENT_REQUIRED", 400);
      const revision = rows(await tx.query("SELECT id,fingerprint,status FROM app.strategy_revisions WHERE organization_id=$1 AND id=$2", [this.org, arm.strategyRevisionId]))[0]!;
      if (revision.status !== "approved") return fail("REVISION_NOT_APPROVED");
      const previous = rule.champion_revision_id ? rows(await tx.query("SELECT id,fingerprint FROM app.strategy_revisions WHERE organization_id=$1 AND id=$2", [this.org, rule.champion_revision_id]))[0]! : null;
      if (previous?.id === revision.id) return fail("ALREADY_CHAMPION");
      const safety = { warnings: evaluation.warnings, comparison: comparison ?? null, limits: { maxComplaintBasisPoints: Number(report.experiment.max_complaint_basis_points), maxUnsubscribeBasisPoints: Number(report.experiment.max_unsubscribe_basis_points) }, acknowledgement };
      const promotion = rows(await tx.query(`INSERT INTO app.strategy_promotions(organization_id,allocation_rule_id,experiment_id,mode,from_revision_id,to_revision_id,from_fingerprint,to_fingerprint,snapshot_id,safety,rationale,uncertainty_acknowledged,created_by_membership_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13) RETURNING *`, [this.org, rule.id, id, mode, previous?.id ?? null, revision.id, previous?.fingerprint ?? null, revision.fingerprint, snapshot.id, JSON.stringify(safety), rationale, Boolean(acknowledgement), this.ctx.membershipId]))[0]!;
      const updated = rows(await tx.query("UPDATE app.strategy_allocation_rules SET champion_revision_id=$3,version=version+1,updated_by_membership_id=$4,updated_at=app.utc_now() WHERE organization_id=$1 AND id=$2 RETURNING *", [this.org, rule.id, revision.id, this.ctx.membershipId]))[0]!;
      await this.history(tx, updated);
      await tx.query("UPDATE app.strategy_experiments SET state='completed',stop_reason='PROMOTED',updated_at=app.utc_now() WHERE organization_id=$1 AND id=$2", [this.org, id]);
      await tx.query("UPDATE app.strategy_variant_backlog SET status='adopted',version=version+1,updated_at=app.utc_now() WHERE organization_id=$1 AND proposed_revision_id=$2", [this.org, revision.id]);
      await event(tx, this.ctx, "strategy.champion_promoted", promotion.id, { mode, fromRevisionId: previous?.id ?? null, toRevisionId: revision.id, toFingerprint: revision.fingerprint, snapshotFingerprint: snapshot.fingerprint, uncertaintyAcknowledged: Boolean(acknowledgement) });
      return promotion;
    });
  }
  async rollback(promotionId: unknown, rationale: unknown) {
    const id = identifier(promotionId), reason = text(rationale, "rationale", 2000);
    return tenant(this.client, this.ctx, async tx => {
      const promotion = rows(await tx.query("SELECT * FROM app.strategy_promotions WHERE organization_id=$1 AND id=$2 AND mode<>'rollback'", [this.org, id]))[0];
      if (!promotion) return fail("PROMOTION_NOT_FOUND", 404);
      const rule = rows(await tx.query("SELECT * FROM app.strategy_allocation_rules WHERE organization_id=$1 AND id=$2 FOR UPDATE", [this.org, promotion.allocation_rule_id]))[0]!;
      if (rows(await tx.query("SELECT 1 FROM app.strategy_promotions WHERE organization_id=$1 AND reverts_promotion_id=$2", [this.org, id])).length) return fail("PROMOTION_ALREADY_ROLLED_BACK");
      if (rule.champion_revision_id !== promotion.to_revision_id) return fail("CHAMPION_CHANGED_SINCE_PROMOTION");
      const rolled = rows(await tx.query(`INSERT INTO app.strategy_promotions(organization_id,allocation_rule_id,mode,from_revision_id,to_revision_id,from_fingerprint,to_fingerprint,rationale,reverts_promotion_id,created_by_membership_id)
        VALUES($1,$2,'rollback',$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [this.org, rule.id, promotion.to_revision_id, promotion.from_revision_id, promotion.to_fingerprint, promotion.from_fingerprint, reason, id, this.ctx.membershipId]))[0]!;
      const updated = rows(await tx.query("UPDATE app.strategy_allocation_rules SET champion_revision_id=$3,version=version+1,updated_by_membership_id=$4,updated_at=app.utc_now() WHERE organization_id=$1 AND id=$2 RETURNING *", [this.org, rule.id, promotion.from_revision_id, this.ctx.membershipId]))[0]!;
      await this.history(tx, updated);
      await event(tx, this.ctx, "strategy.champion_rolled_back", rolled.id, { revertsPromotionId: id, restoredRevisionId: promotion.from_revision_id });
      return rolled;
    });
  }

  // DOTS-118: hybrids and backlog
  async createHybrid(familyId: unknown, parents: unknown, input: RevisionInput) {
    const family = identifier(familyId), fields = normalizeRevision(input);
    if (!Array.isArray(parents) || parents.length < 1 || parents.length > 5) return fail("INVALID_PARENTS", 400);
    const parentList = (parents as { revisionId: unknown; elements?: unknown }[]).map(p => ({ id: identifier(p.revisionId), elements: p.elements === undefined ? [] : stringList(p.elements, "elements", 10, 80) }));
    if (new Set(parentList.map(p => p.id)).size !== parentList.length) return fail("DUPLICATE_PARENT", 400);
    return tenant(this.client, this.ctx, async tx => {
      if (!rows(await tx.query("SELECT id FROM app.strategy_families WHERE organization_id=$1 AND id=$2 AND status='active'", [this.org, family])).length) return fail("STRATEGY_FAMILY_NOT_FOUND", 404);
      const found = rows(await tx.query("SELECT id FROM app.strategy_revisions WHERE organization_id=$1 AND id=ANY($2::uuid[]) AND status IN ('approved','retired')", [this.org, parentList.map(p => p.id)]));
      if (found.length !== parentList.length) return fail("PARENT_REVISION_NOT_APPROVED");
      const revision = await this.insertRevision(tx, family, fields, parentList);
      await event(tx, this.ctx, "strategy.hybrid_proposed", revision.id, { parents: parentList.map(p => p.id), fingerprint: revision.fingerprint });
      return revision;
    });
  }
  async addBacklogItem(input: { familyId: unknown; title: unknown; hypothesis: unknown; parentRevisionIds?: unknown; proposedRevisionId?: unknown }) {
    const family = identifier(input.familyId), title = text(input.title, "title", 160), hypothesis = text(input.hypothesis, "hypothesis", 2000);
    const parents = input.parentRevisionIds === undefined ? [] : (Array.isArray(input.parentRevisionIds) && input.parentRevisionIds.length <= 5 ? input.parentRevisionIds.map(identifier) : fail("INVALID_PARENTS", 400));
    const proposed = input.proposedRevisionId ? identifier(input.proposedRevisionId) : null;
    return tenant(this.client, this.ctx, async tx => {
      const item = rows(await tx.query("INSERT INTO app.strategy_variant_backlog(organization_id,family_id,title,hypothesis,parent_revision_ids,status,proposed_revision_id,created_by_membership_id) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8) RETURNING *", [this.org, family, title, hypothesis, JSON.stringify(parents), proposed ? "drafted" : "idea", proposed, this.ctx.membershipId]))[0]!;
      await event(tx, this.ctx, "strategy.backlog_added", item.id, { familyId: family });
      return item;
    });
  }
  async updateBacklogItem(id: unknown, input: { status?: unknown; proposedRevisionId?: unknown; expectedVersion: unknown }) {
    const itemId = identifier(id), status = input.status === undefined ? null : selection(input.status, ["idea", "drafted", "rejected"], "status");
    const proposed = input.proposedRevisionId ? identifier(input.proposedRevisionId) : null, version = integer(input.expectedVersion, "version", 1, Number.MAX_SAFE_INTEGER);
    return tenant(this.client, this.ctx, async tx => {
      const saved = rows(await tx.query("UPDATE app.strategy_variant_backlog SET status=COALESCE($3,CASE WHEN $4::uuid IS NOT NULL THEN 'drafted' ELSE status END),proposed_revision_id=COALESCE($4::uuid,proposed_revision_id),version=version+1,updated_at=app.utc_now() WHERE organization_id=$1 AND id=$2 AND version=$5 AND status NOT IN ('adopted') RETURNING *", [this.org, itemId, status, proposed, version]))[0];
      if (!saved) return fail("STALE_BACKLOG_ITEM");
      await event(tx, this.ctx, "strategy.backlog_updated", itemId, { status: saved.status });
      return saved;
    });
  }

  // Snapshot for the Strategy Lab view (DOTS-119)
  async snapshot() {
    return tenant(this.client, this.ctx, async tx => {
      const q = async (sql: string) => rows(await tx.query(sql, [this.org]));
      const queries = [
        "SELECT * FROM app.strategy_families WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 100",
        "SELECT * FROM app.strategy_revisions WHERE organization_id=$1 ORDER BY family_id,revision DESC LIMIT 500",
        "SELECT * FROM app.strategy_lineage WHERE organization_id=$1",
        "SELECT * FROM app.strategy_allocation_rules WHERE organization_id=$1 ORDER BY updated_at DESC LIMIT 100",
        "SELECT * FROM app.strategy_allocation_history WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 100",
        "SELECT * FROM app.strategy_experiments WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 20",
        "SELECT * FROM app.strategy_experiment_arms WHERE organization_id=$1 ORDER BY arm_key",
        "SELECT * FROM app.strategy_promotions WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 50",
        "SELECT * FROM app.strategy_variant_backlog WHERE organization_id=$1 ORDER BY updated_at DESC LIMIT 100",
        "SELECT id,label FROM app.projects WHERE organization_id=$1 AND status='active' ORDER BY label LIMIT 100",
        "SELECT id,project_id,label,state FROM app.campaigns WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 100",
      ];
      const results: Row[][] = [];
      for (const sql of queries) results.push(await q(sql));
      const [families, revisions, lineage, rules, history, experiments, arms, promotions, backlog, projects, campaigns] = results as [Row[], Row[], Row[], Row[], Row[], Row[], Row[], Row[], Row[], Row[], Row[]];
      const reports = [];
      for (const experiment of experiments.slice(0, 8)) {
        const report = await this.report(tx, experiment.id);
        const provenance = rows(await tx.query(`SELECT o.id,o.kind,o.evidence_source,o.evidence_source IN ('provider','owner_attested') AS counted,o.receipt_provider,o.receipt_event_id,o.evidence_ref,o.amount_cents,o.original_currency,o.is_estimate,o.occurred_at,a.arm_key FROM app.strategy_outcome_events o JOIN app.strategy_experiment_arms a ON a.organization_id=o.organization_id AND a.id=o.arm_id WHERE o.organization_id=$1 AND o.experiment_id=$2 ORDER BY o.recorded_at DESC LIMIT 25`, [this.org, experiment.id]));
        reports.push({ ...report, provenance });
      }
      return {
        families: families.map(f => ({ ...f, revisions: revisions.filter(r => r.family_id === f.id).map(r => ({ ...r, parents: lineage.filter(l => l.child_revision_id === r.id) })) })),
        rules: rules.map(r => ({ ...r, history: history.filter(h => h.rule_id === r.id).slice(0, 10) })),
        experiments: experiments.map(e => ({ ...e, arms: arms.filter(a => a.experiment_id === e.id) })), reports, promotions, backlog, projects, campaigns,
        defaults: { suggestedExperimentalBasisPoints: SUGGESTED_EXPERIMENTAL_BASIS_POINTS, suggestedMinExplorationBasisPoints: SUGGESTED_MIN_EXPLORATION_BASIS_POINTS, personalizationFields: PERSONALIZATION_FIELDS },
        observedAt: new Date().toISOString(),
      };
    });
  }
}
