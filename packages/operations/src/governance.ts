// DOTS-032..043 governance control plane.
// Budgets use a double-entry allocation ledger (integer USD cents only); every paid
// operation is fail-closed at the default $0 funding. Policy decisions, approvals, kill
// switches, dead letters, credentials, logging and retention all live here so the queue,
// engine and integration tracks can call the exported hooks before any dispatch.
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { type Client, type Context, type Row, OperationError, rows, tenant, event, cents, text, digest, fail, randomUUID } from "./common.js";

// ---------------------------------------------------------------- shared helpers
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,119}$/;
const id = (value: unknown, field = "id"): string => {
  if (typeof value !== "string" || !UUID.test(value)) return fail(`INVALID_${field.toUpperCase()}`, 400);
  return value.toLowerCase();
};
const optionalKey = (value: unknown, field: string): string | null => {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !KEY.test(value)) return fail(`INVALID_${field.toUpperCase()}`, 400);
  return value;
};
const n = (value: unknown): number => Number(value ?? 0);
export const GOVERNANCE_CHANNELS = ["email", "model", "payment", "webhook"] as const;
export type GovernanceChannel = (typeof GOVERNANCE_CHANNELS)[number];
const channelOf = (value: unknown): GovernanceChannel | null => {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !(GOVERNANCE_CHANNELS as readonly string[]).includes(value)) return fail("INVALID_CHANNEL", 400);
  return value as GovernanceChannel;
};

/** Fail-closed refusal carrying a stable, machine-readable rule identifier. */
export class GovernanceBlockedError extends OperationError {
  constructor(code: string, readonly ruleId: string, readonly reason: string, status = 423) {
    super(code, status);
    this.name = "GovernanceBlockedError";
  }
}

export type DispatchScope = { campaignId?: string | null; projectId?: string | null; providerId?: string | null; modelId?: string | null; channel?: string | null };
type Dimensions = { projectId: string | null; campaignId: string | null; providerId: string | null; modelId: string | null; channel: GovernanceChannel | null };

async function dimensions(tx: Client, ctx: Context, scope: DispatchScope): Promise<Dimensions> {
  let projectId = scope.projectId ? id(scope.projectId, "project_id") : null;
  const campaignId = scope.campaignId ? id(scope.campaignId, "campaign_id") : null;
  if (campaignId) {
    const campaign = rows(await tx.query("SELECT project_id FROM app.campaigns WHERE organization_id=$1 AND id=$2", [ctx.organizationId, campaignId]))[0];
    if (!campaign) return fail("CAMPAIGN_NOT_FOUND", 404);
    if (projectId && projectId !== campaign.project_id) return fail("CAMPAIGN_PROJECT_MISMATCH", 400);
    projectId = campaign.project_id as string;
  }
  return { projectId, campaignId, providerId: optionalKey(scope.providerId, "provider_id"), modelId: optionalKey(scope.modelId, "model_id"), channel: channelOf(scope.channel) };
}

// ---------------------------------------------------------------- kill switches + dispatch gate (DOTS-038)
export const KILL_SWITCH_SCOPES = ["organization", "campaign", "provider", "model", "channel"] as const;
export type KillSwitchScope = (typeof KILL_SWITCH_SCOPES)[number];

async function activeKillSwitches(tx: Client, ctx: Context, dims: Dimensions): Promise<Row[]> {
  return rows(await tx.query(
    `SELECT scope_kind,scope_key,rationale FROM app.kill_switches WHERE organization_id=$1 AND active AND (
      scope_kind='organization' OR (scope_kind='campaign' AND scope_key=$2) OR (scope_kind='provider' AND scope_key=$3)
      OR (scope_kind='model' AND scope_key=$4) OR (scope_kind='channel' AND scope_key=$5)) ORDER BY scope_kind,scope_key`,
    [ctx.organizationId, dims.campaignId ?? "", dims.providerId ?? "", dims.modelId ?? "", dims.channel ?? ""]));
}

/**
 * Integrator hook: call inside the dispatch transaction immediately before any external
 * side effect (model call, email send, payment). Throws GovernanceBlockedError with a
 * stable rule id when the runtime is paused, a matching kill switch is engaged, or (when
 * estimateCents > 0) any applicable spending ceiling would be exceeded.
 */
export async function assertDispatchAllowed(tx: Client, ctx: Context, scope: DispatchScope & { estimateCents?: number } = {}): Promise<{ ok: true }> {
  const dims = await dimensions(tx, ctx, scope);
  // Shared lock: a concurrent engage() waits for in-flight checks, and later checks see it.
  await tx.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))", [`kill:${ctx.organizationId}`]);
  const control = rows(await tx.query("SELECT paused FROM app.policy_controls WHERE organization_id=$1", [ctx.organizationId]))[0];
  if (!control || control.paused) throw new GovernanceBlockedError("RUNTIME_PAUSED", "runtime.paused", "Runtime is paused or unconfigured; the owner must resume explicitly.");
  const switches = await activeKillSwitches(tx, ctx, dims);
  if (switches.length) {
    const first = switches[0]!;
    throw new GovernanceBlockedError("KILL_SWITCH_ACTIVE", `kill_switch.${first.scope_kind}`, `Kill switch engaged for ${first.scope_kind} ${first.scope_key}.`);
  }
  const estimate = scope.estimateCents === undefined ? 0 : cents(scope.estimateCents);
  if (estimate > 0) {
    const violations = await spendViolations(tx, ctx, dims, estimate);
    if (violations.length) throw new GovernanceBlockedError("BUDGET_EXCEEDED", violations[0]!.id, violations[0]!.reason, 402);
  }
  return { ok: true };
}

// ---------------------------------------------------------------- budget ledger (DOTS-032..035)
type ScopeRow = Row & { id: string; scope_kind: string; scope_key: string };
const TREE = ["tenant", "project", "campaign"];

async function ensureTenantScope(tx: Client, ctx: Context): Promise<ScopeRow> {
  await tx.query("INSERT INTO app.budget_scopes(organization_id,scope_kind,scope_key,updated_by_membership_id) VALUES($1,'tenant','organization',$2) ON CONFLICT DO NOTHING", [ctx.organizationId, ctx.membershipId]);
  return rows(await tx.query("SELECT * FROM app.budget_scopes WHERE organization_id=$1 AND scope_kind='tenant'", [ctx.organizationId]))[0] as ScopeRow;
}

async function applicableScopes(tx: Client, ctx: Context, dims: Dimensions, lock: boolean): Promise<ScopeRow[]> {
  return rows(await tx.query(
    `SELECT * FROM app.budget_scopes WHERE organization_id=$1 AND (scope_kind='tenant' OR (scope_kind='project' AND scope_key=$2)
      OR (scope_kind='campaign' AND scope_key=$3) OR (scope_kind='provider' AND scope_key=$4) OR (scope_kind='model' AND scope_key=$5)
      OR (scope_kind='channel' AND scope_key=$6))
     ORDER BY array_position(ARRAY['tenant','project','campaign','provider','model','channel'],scope_kind)${lock ? " FOR UPDATE" : ""}`,
    [ctx.organizationId, dims.projectId ?? "", dims.campaignId ?? "", dims.providerId ?? "", dims.modelId ?? "", dims.channel ?? ""])) as ScopeRow[];
}

const usageFilter = `CASE $2 WHEN 'tenant' THEN true WHEN 'project' THEN project_id::text=$3 WHEN 'campaign' THEN campaign_id::text=$3
  WHEN 'provider' THEN provider_id=$3 WHEN 'model' THEN model_id=$3 WHEN 'channel' THEN channel=$3 ELSE false END`;
async function scopeUsage(tx: Client, ctx: Context, scope: ScopeRow): Promise<{ total: number; daily: number }> {
  const usage = rows(await tx.query(
    `SELECT COALESCE(sum(CASE status WHEN 'reserved' THEN estimate_cents WHEN 'settled' THEN actual_cents ELSE 0 END),0)::bigint AS total,
      COALESCE(sum(CASE status WHEN 'reserved' THEN estimate_cents WHEN 'settled' THEN actual_cents ELSE 0 END) FILTER (WHERE created_at>=date_trunc('day',app.utc_now())),0)::bigint AS daily
     FROM app.governed_reservations WHERE organization_id=$1 AND ${usageFilter}`,
    [ctx.organizationId, scope.scope_kind, scope.scope_key]))[0]!;
  return { total: n(usage.total), daily: n(usage.daily) };
}
async function scopeBalance(tx: Client, ctx: Context, scopeId: string): Promise<number> {
  return n(rows(await tx.query("SELECT COALESCE(sum(amount_cents),0)::bigint AS balance FROM app.budget_ledger_entries WHERE organization_id=$1 AND account='scope' AND scope_id=$2", [ctx.organizationId, scopeId]))[0]!.balance);
}
async function scopeAllocated(tx: Client, ctx: Context, scopeId: string): Promise<number> {
  return n(rows(await tx.query(
    `SELECT COALESCE(sum(e.amount_cents),0)::bigint AS allocated FROM app.budget_ledger_entries e JOIN app.budget_journals j ON j.organization_id=e.organization_id AND j.id=e.journal_id
     WHERE e.organization_id=$1 AND e.account='scope' AND e.scope_id=$2 AND j.kind IN ('funding','defunding','transfer')`, [ctx.organizationId, scopeId]))[0]!.allocated);
}

export type SpendViolation = { id: string; reason: string; scopeId: string };
/** Most-restrictive precedence: every applicable scope must admit the amount. */
async function spendViolations(tx: Client, ctx: Context, dims: Dimensions, amount: number, scopes?: ScopeRow[]): Promise<SpendViolation[]> {
  const applicable = scopes ?? await applicableScopes(tx, ctx, dims, false);
  const violations: SpendViolation[] = [];
  if (!applicable.some(s => s.scope_kind === "tenant")) return [{ id: "spend.tenant.unfunded", reason: "Tenant budget is $0 until the owner records authorized funding.", scopeId: "" }];
  const funding = fundingScope(applicable);
  if (amount > 0) {
    const available = await scopeBalance(tx, ctx, funding.id);
    if (available < amount) violations.push({ id: `spend.${funding.scope_kind}.total`, reason: `Unreserved ${funding.scope_kind} allocation is ${available} cents; ${amount} cents requested.`, scopeId: funding.id });
  }
  for (const scope of applicable) {
    const usage = await scopeUsage(tx, ctx, scope);
    if (scope.ceiling_cents !== null && scope.ceiling_cents !== undefined && usage.total + amount > n(scope.ceiling_cents)) violations.push({ id: `spend.${scope.scope_kind}.total`, reason: `${scope.scope_kind} ${scope.scope_key} ceiling ${n(scope.ceiling_cents)} cents would be exceeded.`, scopeId: scope.id });
    if (scope.daily_limit_cents !== null && scope.daily_limit_cents !== undefined && usage.daily + amount > n(scope.daily_limit_cents)) violations.push({ id: `spend.${scope.scope_kind}.daily`, reason: `${scope.scope_kind} ${scope.scope_key} daily ceiling ${n(scope.daily_limit_cents)} cents would be exceeded.`, scopeId: scope.id });
  }
  return violations;
}
const fundingScope = (scopes: ScopeRow[]): ScopeRow =>
  scopes.find(s => s.scope_kind === "campaign") ?? scopes.find(s => s.scope_kind === "project") ?? scopes.find(s => s.scope_kind === "tenant")!;

type Line = { account: "owner_funding" | "scope" | "reserved" | "spent"; scopeId?: string; reservationId?: string; amount: number };
async function journal(tx: Client, ctx: Context, input: { kind: string; key: string; reason: string; authorizationRef?: string | null; reservationId?: string | null; actor?: string }, lines: Line[]): Promise<string> {
  const nonZero = lines.filter(l => l.amount !== 0);
  if (nonZero.reduce((sum, l) => sum + l.amount, 0) !== 0) return fail("JOURNAL_UNBALANCED", 500);
  const created = rows(await tx.query(
    "INSERT INTO app.budget_journals(organization_id,kind,idempotency_key,reason,authorization_ref,reservation_id,created_by_actor) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id",
    [ctx.organizationId, input.kind, input.key, input.reason, input.authorizationRef ?? null, input.reservationId ?? null, input.actor ?? `membership:${ctx.membershipId}`]))[0]!;
  for (const line of nonZero) await tx.query("INSERT INTO app.budget_ledger_entries(organization_id,journal_id,account,scope_id,reservation_id,amount_cents) VALUES($1,$2,$3,$4,$5,$6)",
    [ctx.organizationId, created.id, line.account, line.scopeId ?? null, line.reservationId ?? null, line.amount]);
  return created.id as string;
}

export type ScopePolicyInput = { scopeKind: string; scopeKey?: string; ceilingCents?: number | null; dailyLimitCents?: number | null; alertThresholdBps?: number };
export type ReserveInput = DispatchScope & { key: string; amountCents: number; purpose: string; ttlSeconds?: number };

export class GovernedBudget {
  constructor(private readonly client: Client, private readonly ctx: Context) {}

  /** Creates or updates a scope's ceilings. Tree scopes (tenant/project/campaign) take totals from ledger allocations only. */
  async setScopePolicy(input: ScopePolicyInput) {
    const kind = input.scopeKind;
    if (!["tenant", "project", "campaign", "provider", "model", "channel"].includes(kind)) return fail("INVALID_SCOPE_KIND", 400);
    const tree = TREE.includes(kind);
    if (tree && input.ceilingCents !== undefined && input.ceilingCents !== null) return fail("TREE_SCOPE_TOTAL_COMES_FROM_ALLOCATIONS", 400);
    const ceiling = tree ? null : cents(input.ceilingCents ?? 0);
    const daily = input.dailyLimitCents === undefined || input.dailyLimitCents === null ? null : cents(input.dailyLimitCents);
    const bps = input.alertThresholdBps ?? 8000;
    if (!Number.isSafeInteger(bps) || bps < 1 || bps > 10000) return fail("INVALID_ALERT_THRESHOLD", 400);
    return tenant(this.client, this.ctx, async tx => {
      await ensureTenantScope(tx, this.ctx);
      let key = "organization", projectId: string | null = null, campaignId: string | null = null;
      if (kind === "project") { projectId = key = id(input.scopeKey, "project_id"); if (!rows(await tx.query("SELECT 1 FROM app.projects WHERE organization_id=$1 AND id=$2", [this.ctx.organizationId, projectId])).length) return fail("PROJECT_NOT_FOUND", 404); }
      if (kind === "campaign") { const dims = await dimensions(tx, this.ctx, { campaignId: input.scopeKey }); campaignId = key = dims.campaignId!; projectId = dims.projectId; }
      if (kind === "channel") key = channelOf(input.scopeKey) ?? fail("INVALID_CHANNEL", 400);
      if (kind === "provider" || kind === "model") key = optionalKey(input.scopeKey, `${kind}_id`) ?? fail(`INVALID_${kind.toUpperCase()}_ID`, 400);
      const result = rows(await tx.query(
        `INSERT INTO app.budget_scopes(organization_id,scope_kind,scope_key,project_id,campaign_id,ceiling_cents,daily_limit_cents,alert_threshold_bps,updated_by_membership_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(organization_id,scope_kind,scope_key) DO UPDATE SET ceiling_cents=$6,daily_limit_cents=$7,alert_threshold_bps=$8,
         version=app.budget_scopes.version+1,updated_by_membership_id=$9,updated_at=app.utc_now() RETURNING *`,
        [this.ctx.organizationId, kind, key, projectId, campaignId, ceiling, daily, bps, this.ctx.membershipId]))[0]!;
      await event(tx, this.ctx, "budget.scope_policy_set", result.id, { scopeKind: kind, ceilingCents: ceiling, dailyLimitCents: daily, alertThresholdBps: bps });
      return result;
    });
  }

  /** Owner funding into the tenant pool. Requires an authorization reference and stays within the deployment hard cap. */
  async fund(amountCents: number, authorizationRef: string | undefined, hardCapCents: number, key: string) {
    const amount = cents(amountCents); cents(hardCapCents); text(key, "idempotency_key", 200);
    if (amount === 0) return fail("INVALID_AMOUNT", 400);
    if (!authorizationRef || !authorizationRef.trim()) return fail("SPEND_NOT_AUTHORIZED", 403);
    return tenant(this.client, this.ctx, async tx => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`gov-budget:${this.ctx.organizationId}`]);
      const prior = rows(await tx.query("SELECT id FROM app.budget_journals WHERE organization_id=$1 AND idempotency_key=$2", [this.ctx.organizationId, `fund:${key}`]))[0];
      if (prior) return { journalId: prior.id as string, replayed: true };
      const tenantScope = await ensureTenantScope(tx, this.ctx);
      const funded = -n(rows(await tx.query("SELECT COALESCE(sum(amount_cents),0)::bigint AS total FROM app.budget_ledger_entries WHERE organization_id=$1 AND account='owner_funding'", [this.ctx.organizationId]))[0]!.total);
      if (funded + amount > hardCapCents) return fail("FUNDING_EXCEEDS_HARD_CAP", 403);
      const journalId = await journal(tx, this.ctx, { kind: "funding", key: `fund:${key}`, reason: "Owner-authorized funding", authorizationRef: authorizationRef.trim() },
        [{ account: "owner_funding", amount: -amount }, { account: "scope", scopeId: tenantScope.id, amount }]);
      await event(tx, this.ctx, "budget.funded", journalId, { amountCents: amount });
      return { journalId, replayed: false };
    });
  }

  /** Returns unreserved tenant allocation to the owner (lowers funding). */
  async defund(amountCents: number, key: string) {
    const amount = cents(amountCents); text(key, "idempotency_key", 200);
    if (amount === 0) return fail("INVALID_AMOUNT", 400);
    return tenant(this.client, this.ctx, async tx => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`gov-budget:${this.ctx.organizationId}`]);
      const prior = rows(await tx.query("SELECT id FROM app.budget_journals WHERE organization_id=$1 AND idempotency_key=$2", [this.ctx.organizationId, `defund:${key}`]))[0];
      if (prior) return { journalId: prior.id as string, replayed: true };
      const tenantScope = await ensureTenantScope(tx, this.ctx);
      if (await scopeBalance(tx, this.ctx, tenantScope.id) < amount) return fail("TRANSFER_EXCEEDS_UNALLOCATED", 409);
      const journalId = await journal(tx, this.ctx, { kind: "defunding", key: `defund:${key}`, reason: "Owner withdrew unallocated funding" },
        [{ account: "scope", scopeId: tenantScope.id, amount: -amount }, { account: "owner_funding", amount }]);
      await event(tx, this.ctx, "budget.defunded", journalId, { amountCents: amount });
      return { journalId, replayed: false };
    });
  }

  /** Moves unreserved allocation between tree scopes as an append-only journal; never overwrites a balance. */
  async transfer(input: { fromScopeId: string; toScopeId: string; amountCents: number; reason: string; key: string }) {
    const amount = cents(input.amountCents); const from = id(input.fromScopeId, "from_scope_id"), to = id(input.toScopeId, "to_scope_id");
    const reason = text(input.reason, "reason", 500); text(input.key, "idempotency_key", 200);
    if (amount === 0) return fail("INVALID_AMOUNT", 400);
    if (from === to) return fail("TRANSFER_SAME_SCOPE", 400);
    return tenant(this.client, this.ctx, async tx => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`gov-budget:${this.ctx.organizationId}`]);
      const prior = rows(await tx.query("SELECT id FROM app.budget_journals WHERE organization_id=$1 AND idempotency_key=$2", [this.ctx.organizationId, `transfer:${input.key}`]))[0];
      if (prior) return { journalId: prior.id as string, replayed: true };
      const scopes = rows(await tx.query("SELECT * FROM app.budget_scopes WHERE organization_id=$1 AND id IN ($2,$3) FOR UPDATE", [this.ctx.organizationId, from, to])) as ScopeRow[];
      const source = scopes.find(s => s.id === from), target = scopes.find(s => s.id === to);
      if (!source || !target) return fail("SCOPE_NOT_FOUND", 404);
      if (!TREE.includes(source.scope_kind) || !TREE.includes(target.scope_kind)) return fail("TRANSFER_SCOPE_NOT_FUNDABLE", 400);
      const available = await scopeBalance(tx, this.ctx, source.id);
      if (available < amount) return fail("TRANSFER_EXCEEDS_UNALLOCATED", 409);
      const journalId = await journal(tx, this.ctx, { kind: "transfer", key: `transfer:${input.key}`, reason },
        [{ account: "scope", scopeId: source.id, amount: -amount }, { account: "scope", scopeId: target.id, amount }]);
      await event(tx, this.ctx, "budget.transferred", journalId, { fromScopeId: source.id, toScopeId: target.id, amountCents: amount });
      return { journalId, replayed: false };
    });
  }

  /** Atomically checks every applicable scope and holds the worst-case estimate. */
  async reserve(input: ReserveInput) {
    const amount = cents(input.amountCents); const key = text(input.key, "idempotency_key", 200); const purpose = text(input.purpose, "purpose", 200);
    const ttl = input.ttlSeconds ?? 900;
    if (!Number.isSafeInteger(ttl) || ttl < 10 || ttl > 86400) return fail("INVALID_TTL", 400);
    return tenant(this.client, this.ctx, async tx => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`gov-budget:${this.ctx.organizationId}`]);
      const dims = await dimensions(tx, this.ctx, input);
      const requestHash = digest({ ...dims, amount, purpose });
      const prior = rows(await tx.query("SELECT * FROM app.governed_reservations WHERE organization_id=$1 AND idempotency_key=$2", [this.ctx.organizationId, key]))[0];
      if (prior) { if (prior.request_hash !== requestHash) return fail("IDEMPOTENCY_CONFLICT"); return prior; }
      const switches = await activeKillSwitches(tx, this.ctx, dims);
      if (switches.length) throw new GovernanceBlockedError("KILL_SWITCH_ACTIVE", `kill_switch.${switches[0]!.scope_kind}`, "A matching kill switch is engaged.");
      await ensureTenantScope(tx, this.ctx);
      const scopes = await applicableScopes(tx, this.ctx, dims, true);
      const violations = await spendViolations(tx, this.ctx, dims, amount, scopes);
      if (violations.length) {
        // The refusal rolls back the whole transaction, so no partial hold or ledger line can survive it.
        throw new GovernanceBlockedError("BUDGET_EXCEEDED", violations[0]!.id, violations[0]!.reason, 402);
      }
      const funding = fundingScope(scopes);
      const reservation = rows(await tx.query(
        `INSERT INTO app.governed_reservations(organization_id,idempotency_key,request_hash,funding_scope_id,project_id,campaign_id,provider_id,model_id,channel,purpose,estimate_cents,expires_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,app.utc_now()+make_interval(secs=>$12)) RETURNING *`,
        [this.ctx.organizationId, key, requestHash, funding.id, dims.projectId, dims.campaignId, dims.providerId, dims.modelId, dims.channel, purpose, amount, ttl]))[0]!;
      if (amount > 0) await journal(tx, this.ctx, { kind: "reservation", key: `reserve:${reservation.id}`, reason: purpose, reservationId: reservation.id },
        [{ account: "scope", scopeId: funding.id, amount: -amount }, { account: "reserved", reservationId: reservation.id, amount }]);
      await this.recordAlerts(tx, scopes);
      await event(tx, this.ctx, "budget.reserved", reservation.id, { amountCents: amount, fundingScopeId: funding.id });
      return reservation;
    });
  }

  private async recordAlerts(tx: Client, scopes: ScopeRow[]) {
    const today = rows(await tx.query("SELECT to_char(app.utc_now(),'YYYY-MM-DD') AS day"))[0]!.day as string;
    const funding = fundingScope(scopes);
    for (const scope of scopes) {
      const usage = await scopeUsage(tx, this.ctx, scope);
      const checks: Array<[string, string, number, number]> = [];
      if (scope.id === funding.id) { const allocated = await scopeAllocated(tx, this.ctx, scope.id); checks.push(["total", "total", allocated - await scopeBalance(tx, this.ctx, scope.id), allocated]); }
      if (scope.ceiling_cents !== null && scope.ceiling_cents !== undefined) checks.push(["total", "total", usage.total, n(scope.ceiling_cents)]);
      if (scope.daily_limit_cents !== null && scope.daily_limit_cents !== undefined) checks.push(["daily", today, usage.daily, n(scope.daily_limit_cents)]);
      for (const [period, periodKey, used, limit] of checks) {
        if (limit <= 0 || used * 10000 < limit * n(scope.alert_threshold_bps)) continue;
        const alert = rows(await tx.query("INSERT INTO app.budget_alerts(organization_id,scope_id,period,period_key,threshold_bps,usage_cents,limit_cents) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING id",
          [this.ctx.organizationId, scope.id, period, periodKey, scope.alert_threshold_bps, used, limit]))[0];
        if (alert) await event(tx, this.ctx, "budget.soft_alert", alert.id as string, { scopeKind: scope.scope_kind, period, usageCents: used, limitCents: limit });
      }
    }
  }

  /** Settles the actual charge (≤ estimate) and releases the excess back to the funding scope. Idempotent. */
  async settle(reservationId: string, actualCents: number, evidenceRef: string, source: "provider" | "simulation" = "provider") {
    const actual = cents(actualCents); const evidence = text(evidenceRef, "evidence", 240); const rid = id(reservationId, "reservation_id");
    return tenant(this.client, this.ctx, async tx => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`gov-budget:${this.ctx.organizationId}`]);
      const reservation = rows(await tx.query("SELECT * FROM app.governed_reservations WHERE organization_id=$1 AND id=$2 FOR UPDATE", [this.ctx.organizationId, rid]))[0];
      if (!reservation) return fail("NOT_FOUND", 404);
      if (reservation.status !== "reserved") { if (reservation.status === "settled" && n(reservation.actual_cents) === actual) return reservation; return fail("RESERVATION_ALREADY_FINAL"); }
      const estimate = n(reservation.estimate_cents);
      if (actual > estimate) return fail("USAGE_EXCEEDS_RESERVATION");
      if (estimate > 0) await journal(tx, this.ctx, { kind: "settlement", key: `settle:${rid}`, reason: `Settled: ${evidence}`, reservationId: rid },
        [{ account: "reserved", reservationId: rid, amount: -estimate }, { account: "spent", reservationId: rid, amount: actual }, { account: "scope", scopeId: reservation.funding_scope_id, amount: estimate - actual }]);
      if (actual > 0) await tx.query("INSERT INTO app.money_entries(organization_id,project_id,idempotency_key,kind,amount_cents,source,evidence_ref) VALUES($1,$2,$3,'expense',$4,$5,$6)",
        [this.ctx.organizationId, reservation.project_id, `gov-settle:${rid}`, actual, source, evidence]);
      const result = rows(await tx.query("UPDATE app.governed_reservations SET status='settled',actual_cents=$3,evidence_ref=$4,final_reason='SETTLED',finalized_at=app.utc_now() WHERE organization_id=$1 AND id=$2 RETURNING *", [this.ctx.organizationId, rid, actual, evidence]))[0];
      await event(tx, this.ctx, "budget.settled", rid, { actualCents: actual, releasedCents: estimate - actual });
      return result;
    });
  }

  /** Releases the full hold (failure, cancellation, timeout). Idempotent. */
  async release(reservationId: string, reason: string) {
    const rid = id(reservationId, "reservation_id"); const why = text(reason, "reason", 200);
    return tenant(this.client, this.ctx, async tx => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`gov-budget:${this.ctx.organizationId}`]);
      return this.releaseLocked(tx, rid, why);
    });
  }
  private async releaseLocked(tx: Client, rid: string, why: string) {
    const reservation = rows(await tx.query("SELECT * FROM app.governed_reservations WHERE organization_id=$1 AND id=$2 FOR UPDATE", [this.ctx.organizationId, rid]))[0];
    if (!reservation) return fail("NOT_FOUND", 404);
    if (reservation.status === "released") return reservation;
    if (reservation.status !== "reserved") return fail("RESERVATION_ALREADY_FINAL");
    const estimate = n(reservation.estimate_cents);
    if (estimate > 0) await journal(tx, this.ctx, { kind: "release", key: `release:${rid}`, reason: why, reservationId: rid },
      [{ account: "reserved", reservationId: rid, amount: -estimate }, { account: "scope", scopeId: reservation.funding_scope_id, amount: estimate }]);
    const result = rows(await tx.query("UPDATE app.governed_reservations SET status='released',actual_cents=0,final_reason=$3,finalized_at=app.utc_now() WHERE organization_id=$1 AND id=$2 RETURNING *", [this.ctx.organizationId, rid, why]))[0];
    await event(tx, this.ctx, "budget.released", rid, { releasedCents: estimate, reason: why });
    return result;
  }

  /** Releases holds whose execution window timed out so no allocation stays stranded. */
  async reconcileExpired() {
    return tenant(this.client, this.ctx, async tx => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`gov-budget:${this.ctx.organizationId}`]);
      const expired = rows(await tx.query("SELECT id FROM app.governed_reservations WHERE organization_id=$1 AND status='reserved' AND expires_at<=app.utc_now() ORDER BY created_at", [this.ctx.organizationId]));
      for (const row of expired) await this.releaseLocked(tx, row.id as string, "TIMEOUT");
      return { released: expired.length };
    });
  }

  /** Allocation summary that reconciles scope balances + holds + spend to owner funding. */
  async summary() { return tenant(this.client, this.ctx, tx => budgetSummary(tx, this.ctx)); }
}

export async function budgetSummary(tx: Client, ctx: Context) {
  const scopes = rows(await tx.query(
    `SELECT s.*,
      COALESCE((SELECT sum(e.amount_cents) FROM app.budget_ledger_entries e WHERE e.organization_id=s.organization_id AND e.account='scope' AND e.scope_id=s.id),0)::bigint AS available_cents,
      COALESCE((SELECT sum(e.amount_cents) FROM app.budget_ledger_entries e JOIN app.budget_journals j ON j.organization_id=e.organization_id AND j.id=e.journal_id
        WHERE e.organization_id=s.organization_id AND e.account='scope' AND e.scope_id=s.id AND j.kind IN ('funding','defunding','transfer')),0)::bigint AS allocated_cents,
      COALESCE((SELECT sum(e.amount_cents) FROM app.budget_ledger_entries e JOIN app.governed_reservations r ON r.organization_id=e.organization_id AND r.id=e.reservation_id
        WHERE e.organization_id=s.organization_id AND e.account='reserved' AND r.funding_scope_id=s.id),0)::bigint AS reserved_cents,
      COALESCE((SELECT sum(e.amount_cents) FROM app.budget_ledger_entries e JOIN app.governed_reservations r ON r.organization_id=e.organization_id AND r.id=e.reservation_id
        WHERE e.organization_id=s.organization_id AND e.account='spent' AND r.funding_scope_id=s.id),0)::bigint AS spent_cents
     FROM app.budget_scopes s WHERE s.organization_id=$1
     ORDER BY array_position(ARRAY['tenant','project','campaign','provider','model','channel'],s.scope_kind),s.scope_key`, [ctx.organizationId]));
  const enriched: Row[] = [];
  for (const scope of scopes) {
    const usage = await scopeUsage(tx, ctx, scope as ScopeRow);
    enriched.push({ ...scope, available_cents: n(scope.available_cents), allocated_cents: n(scope.allocated_cents), reserved_cents: n(scope.reserved_cents), spent_cents: n(scope.spent_cents),
      ceiling_cents: scope.ceiling_cents === null ? null : n(scope.ceiling_cents), daily_limit_cents: scope.daily_limit_cents === null ? null : n(scope.daily_limit_cents),
      usage_total_cents: usage.total, usage_daily_cents: usage.daily });
  }
  const accounts = rows(await tx.query("SELECT account,COALESCE(sum(amount_cents),0)::bigint AS balance FROM app.budget_ledger_entries WHERE organization_id=$1 GROUP BY account", [ctx.organizationId]));
  const balance = (name: string) => n(accounts.find(a => a.account === name)?.balance);
  const fundedCents = -balance("owner_funding"), unreservedCents = balance("scope"), reservedCents = balance("reserved"), spentCents = balance("spent");
  const tenantScope = enriched.find(s => s.scope_kind === "tenant");
  const unbalanced = rows(await tx.query("SELECT count(*)::int AS total FROM (SELECT journal_id FROM app.budget_ledger_entries WHERE organization_id=$1 GROUP BY journal_id HAVING sum(amount_cents)<>0) j", [ctx.organizationId]))[0]!;
  const heldByReservations = n(rows(await tx.query("SELECT COALESCE(sum(estimate_cents),0)::bigint AS held FROM app.governed_reservations WHERE organization_id=$1 AND status='reserved'", [ctx.organizationId]))[0]!.held);
  const settledSpend = n(rows(await tx.query("SELECT COALESCE(sum(actual_cents),0)::bigint AS spent FROM app.governed_reservations WHERE organization_id=$1 AND status='settled'", [ctx.organizationId]))[0]!.spent);
  return {
    currency: "USD", fundedCents, unallocatedCents: n(tenantScope?.available_cents), unreservedCents, reservedCents, spentCents,
    reconciled: fundedCents === unreservedCents + reservedCents + spentCents && n(unbalanced.total) === 0 && heldByReservations === reservedCents && settledSpend === spentCents,
    unbalancedJournals: n(unbalanced.total), scopes: enriched,
  };
}

// ---------------------------------------------------------------- policy decisions (DOTS-036)
export const POLICY_RULESET_VERSION = "governance-2026-11-v1";
export type PolicyDecision = "ALLOW" | "REVIEW" | "DENY";
export type PolicyRuleResult = { id: string; outcome: PolicyDecision; reason: string };
export type PolicyFacts = {
  actionKind: string;
  actorRole: string;
  channel?: string | null;
  ownerAuthorityRef?: string | null;
  requiredClaimIds?: string[];
  approvedClaimIds?: string[];
  sender?: { verified: boolean; status: string } | null;
  contact?: { status: string; consent: string; jurisdiction: string; suppressed: boolean } | null;
  allowedJurisdictions?: string[];
  blockedJurisdictions?: string[];
  estimateCents?: number;
  spendViolations?: Array<{ id: string; reason: string }>;
  runtimePaused?: boolean;
  killSwitches?: Array<{ scope_kind: string; scope_key: string }>;
  approvalValid?: boolean;
  /** Free text written by an agent/model/browser. Never read by any rule and excluded from the decision hash. */
  agentAssertion?: unknown;
};
const OWNER_AUTHORITY_KINDS = ["investment_disclosure", "grant_submission"];
const KNOWN_ACTIONS = ["message", "campaign", "grant_submission", "investment_disclosure", "quotation", "payment", "provider_activation"];

/** Pure, deterministic rule evaluation. DENY dominates REVIEW dominates ALLOW. */
export function decidePolicy(facts: PolicyFacts): { decision: PolicyDecision; rules: PolicyRuleResult[]; inputHash: string } {
  const { agentAssertion: _ignored, ...relevant } = facts;
  const rules: PolicyRuleResult[] = [];
  const add = (ruleId: string, outcome: PolicyDecision, reason: string) => rules.push({ id: ruleId, outcome, reason });
  add("permission.owner_role", relevant.actorRole === "owner" ? "ALLOW" : "DENY", relevant.actorRole === "owner" ? "Active owner membership." : "Only an active owner may authorize external actions.");
  if (!KNOWN_ACTIONS.includes(relevant.actionKind)) add("permission.action_kind", "DENY", "Unknown action kind.");
  else if (OWNER_AUTHORITY_KINDS.includes(relevant.actionKind) && !relevant.ownerAuthorityRef) add("permission.owner_authority", "REVIEW", "Investment and grant actions need a reviewed owner/legal authority reference.");
  else add("permission.action_kind", "ALLOW", "Action kind is permitted.");
  const required = [...new Set(relevant.requiredClaimIds ?? [])], approved = new Set(relevant.approvedClaimIds ?? []);
  const missing = required.filter(claim => !approved.has(claim));
  add("claims.approved", missing.length ? "DENY" : "ALLOW", missing.length ? `${missing.length} referenced claim(s) are not active vetted facts.` : "Every referenced claim is an active vetted fact.");
  if (relevant.channel === "email") {
    const sender = relevant.sender;
    add("sender.verified", sender && sender.verified && sender.status === "active" ? "ALLOW" : "DENY", sender ? (sender.verified ? `Sender status is ${sender.status}.` : "Sender identity is not verified.") : "No sender identity selected.");
  }
  const contact = relevant.contact;
  if (contact) {
    add("suppression.clear", contact.suppressed || contact.status !== "active" ? "DENY" : "ALLOW", contact.suppressed ? "Recipient is on the suppression list." : contact.status !== "active" ? `Recipient status is ${contact.status}.` : "Recipient is not suppressed.");
    add("consent.basis", contact.consent === "opted_out" ? "DENY" : contact.consent === "unknown" ? "REVIEW" : "ALLOW", contact.consent === "unknown" ? "Consent basis is unknown." : `Consent basis: ${contact.consent}.`);
    const jurisdiction = contact.jurisdiction;
    if ((relevant.blockedJurisdictions ?? []).includes(jurisdiction)) add("jurisdiction.permitted", "DENY", `Jurisdiction ${jurisdiction} is blocked by policy.`);
    else if (jurisdiction === "unreviewed" || (relevant.allowedJurisdictions && !relevant.allowedJurisdictions.includes(jurisdiction))) add("jurisdiction.permitted", "REVIEW", `Jurisdiction ${jurisdiction} needs owner review.`);
    else add("jurisdiction.permitted", "ALLOW", `Jurisdiction ${jurisdiction} is permitted.`);
  }
  const spend = relevant.spendViolations ?? [];
  add("spend.capacity", spend.length ? "DENY" : "ALLOW", spend.length ? spend.map(v => `${v.id}: ${v.reason}`).join(" ") : `Estimate ${relevant.estimateCents ?? 0} cents fits every applicable ceiling.`);
  add("runtime.paused", relevant.runtimePaused ? "DENY" : "ALLOW", relevant.runtimePaused ? "Runtime is paused." : "Runtime is running.");
  const switches = relevant.killSwitches ?? [];
  add("kill_switch.clear", switches.length ? "DENY" : "ALLOW", switches.length ? `Kill switch engaged: ${switches.map(s => `${s.scope_kind}:${s.scope_key}`).join(", ")}.` : "No matching kill switch.");
  add("approval.owner", relevant.approvalValid ? "ALLOW" : "REVIEW", relevant.approvalValid ? "Exact-hash owner approval is valid." : "Owner approval for this exact payload is required.");
  const decision: PolicyDecision = rules.some(r => r.outcome === "DENY") ? "DENY" : rules.some(r => r.outcome === "REVIEW") ? "REVIEW" : "ALLOW";
  return { decision, rules, inputHash: digest({ ruleset: POLICY_RULESET_VERSION, ...relevant }) };
}

export type DispatchEvaluationInput = DispatchScope & {
  actionKind: string; subjectId?: string | null; contactId?: string | null; mailboxId?: string | null; estimateCents?: number;
  claimIds?: string[]; approvalId?: string | null; ownerAuthorityRef?: string | null; agentAssertion?: unknown;
  allowedJurisdictions?: string[]; blockedJurisdictions?: string[];
};

export class PolicyService {
  constructor(private readonly client: Client, private readonly ctx: Context) {}
  /** Persists a decision for caller-supplied facts. */
  async record(subjectKind: string, subjectId: string | null, facts: PolicyFacts) {
    return tenant(this.client, this.ctx, tx => recordDecision(tx, this.ctx, subjectKind, subjectId, facts));
  }
  /** Gathers every fact from the database (never from the prompt) and persists the decision. */
  async evaluateDispatch(input: DispatchEvaluationInput) {
    return tenant(this.client, this.ctx, async tx => {
      const facts = await gatherDispatchFacts(tx, this.ctx, input);
      return recordDecision(tx, this.ctx, input.actionKind === "message" ? "message" : "dispatch", input.subjectId ? id(input.subjectId, "subject_id") : null, facts);
    });
  }
}

export async function gatherDispatchFacts(tx: Client, ctx: Context, input: DispatchEvaluationInput): Promise<PolicyFacts> {
  const dims = await dimensions(tx, ctx, input);
  const estimate = input.estimateCents === undefined ? 0 : cents(input.estimateCents);
  const member = rows(await tx.query("SELECT role FROM app.memberships WHERE organization_id=$1 AND id=$2 AND status='active'", [ctx.organizationId, ctx.membershipId]))[0];
  const claimIds = [...new Set((input.claimIds ?? []).map(c => id(c, "claim_id")))];
  const approved = claimIds.length ? rows(await tx.query("SELECT id FROM app.vetted_product_facts WHERE organization_id=$1 AND status='active' AND id=ANY($2::uuid[])", [ctx.organizationId, claimIds])).map(r => r.id as string) : [];
  const mailbox = input.mailboxId ? rows(await tx.query("SELECT verified,status FROM app.mailboxes WHERE organization_id=$1 AND id=$2", [ctx.organizationId, id(input.mailboxId, "mailbox_id")]))[0] : undefined;
  const contact = input.contactId ? rows(await tx.query(
    "SELECT c.status,c.consent,c.jurisdiction,(s.email_hash IS NOT NULL) AS suppressed FROM app.crm_contacts c LEFT JOIN app.contact_suppressions s ON s.organization_id=c.organization_id AND s.email_hash=c.email_hash WHERE c.organization_id=$1 AND c.id=$2",
    [ctx.organizationId, id(input.contactId, "contact_id")]))[0] : undefined;
  if (input.contactId && !contact) return fail("CONTACT_NOT_FOUND", 404);
  const control = rows(await tx.query("SELECT paused FROM app.policy_controls WHERE organization_id=$1", [ctx.organizationId]))[0];
  const approval = input.approvalId ? rows(await tx.query("SELECT 1 FROM app.action_approvals WHERE organization_id=$1 AND id=$2 AND status='approved' AND expires_at>app.utc_now()", [ctx.organizationId, id(input.approvalId, "approval_id")]))[0] : undefined;
  return {
    actionKind: input.actionKind, actorRole: String(member?.role ?? "none"), channel: dims.channel, ownerAuthorityRef: input.ownerAuthorityRef ?? null,
    requiredClaimIds: claimIds, approvedClaimIds: approved,
    sender: mailbox ? { verified: Boolean(mailbox.verified), status: String(mailbox.status) } : null,
    contact: contact ? { status: String(contact.status), consent: String(contact.consent), jurisdiction: String(contact.jurisdiction), suppressed: Boolean(contact.suppressed) } : null,
    allowedJurisdictions: input.allowedJurisdictions, blockedJurisdictions: input.blockedJurisdictions,
    estimateCents: estimate, spendViolations: estimate > 0 ? (await spendViolations(tx, ctx, dims, estimate)).map(({ id: ruleId, reason }) => ({ id: ruleId, reason })) : [],
    runtimePaused: !control || Boolean(control.paused), killSwitches: (await activeKillSwitches(tx, ctx, dims)).map(s => ({ scope_kind: s.scope_kind, scope_key: s.scope_key })),
    approvalValid: Boolean(approval), agentAssertion: input.agentAssertion,
  };
}

/** Integrator hook: evaluate + persist inside an existing tenant transaction. */
export async function recordDecision(tx: Client, ctx: Context, subjectKind: string, subjectId: string | null, facts: PolicyFacts) {
  if (!/^[a-z][a-z_]{1,39}$/.test(subjectKind)) return fail("INVALID_SUBJECT_KIND", 400);
  const result = decidePolicy(facts);
  const row = rows(await tx.query(
    "INSERT INTO app.policy_decisions(organization_id,subject_kind,subject_id,input_hash,decision,rules,ruleset_version,decided_by_membership_id) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8) RETURNING *",
    [ctx.organizationId, subjectKind, subjectId, result.inputHash, result.decision, JSON.stringify(result.rules), POLICY_RULESET_VERSION, ctx.membershipId]))[0]!;
  await event(tx, ctx, "policy.decided", row.id as string, { decision: result.decision, ruleIds: result.rules.filter(r => r.outcome !== "ALLOW").map(r => r.id) });
  return { ...result, id: row.id as string };
}

// ---------------------------------------------------------------- owner action inbox (DOTS-037)
export type ApprovalScope = { kind: string; recordId: string; content: unknown; audienceContactIds: string[]; campaignRevision?: number | null; budgetCents: number; senderIdentity: string };
const audienceList = (ids: string[]) => { if (!Array.isArray(ids) || ids.length > 10000) return fail("INVALID_AUDIENCE", 400); return [...new Set(ids.map(v => id(v, "contact_id")))].sort(); };
function scopeHashes(scope: ApprovalScope) {
  const audience = audienceList(scope.audienceContactIds);
  const revision = scope.campaignRevision === undefined || scope.campaignRevision === null ? null : scope.campaignRevision;
  if (revision !== null && (!Number.isSafeInteger(revision) || revision < 1)) return fail("INVALID_CAMPAIGN_REVISION", 400);
  const contentHash = digest(scope.content), audienceHash = digest(audience), budget = cents(scope.budgetCents), sender = text(scope.senderIdentity, "sender_identity", 200);
  const recordId = id(scope.recordId, "record_id");
  return { recordId, audience, revision, contentHash, audienceHash, budget, sender, payloadHash: digest({ kind: scope.kind, recordId, contentHash, audienceHash, revision, budget, sender }) };
}

/**
 * Integrator hook: consume an exact-scope approval inside the dispatch transaction.
 * Any change to content, recipients, campaign revision, budget or sender fails closed,
 * as do expiry, a changed policy version, the paused runtime or a matching kill switch.
 */
export async function consumeScopedApproval(tx: Client, ctx: Context, approvalId: string, scope: ApprovalScope, dispatch: DispatchScope = {}) {
  const hashes = scopeHashes(scope);
  const approval = rows(await tx.query("SELECT a.*,(a.expires_at>app.utc_now()) AS fresh,p.version AS current_policy_version FROM app.action_approvals a JOIN app.policy_controls p ON p.organization_id=a.organization_id WHERE a.organization_id=$1 AND a.id=$2 FOR UPDATE OF a",
    [ctx.organizationId, id(approvalId, "approval_id")]))[0];
  if (!approval) return fail("APPROVAL_NOT_FOUND", 404);
  if (approval.status !== "approved") return fail(approval.status === "revoked" ? "APPROVAL_REVOKED" : "APPROVAL_NOT_APPROVED", 403);
  if (!approval.fresh) return fail("APPROVAL_EXPIRED", 403);
  if (approval.action_kind !== scope.kind || approval.record_id !== hashes.recordId) return fail("APPROVAL_SCOPE_MISMATCH", 403);
  if (approval.content_hash !== hashes.contentHash) return fail("APPROVAL_CONTENT_CHANGED", 403);
  if (approval.audience_hash !== hashes.audienceHash) return fail("APPROVAL_AUDIENCE_MISMATCH", 403);
  if ((approval.campaign_revision ?? null) !== hashes.revision) return fail("APPROVAL_REVISION_MISMATCH", 403);
  if (n(approval.budget_cents) !== hashes.budget) return fail("APPROVAL_BUDGET_MISMATCH", 403);
  if (approval.sender_identity !== hashes.sender) return fail("APPROVAL_SENDER_MISMATCH", 403);
  if (approval.payload_hash !== hashes.payloadHash) return fail("APPROVAL_SCOPE_MISMATCH", 403);
  if (n(approval.policy_version) !== n(approval.current_policy_version)) return fail("APPROVAL_POLICY_CHANGED", 403);
  await assertDispatchAllowed(tx, ctx, dispatch);
  await tx.query("UPDATE app.action_approvals SET status='consumed' WHERE organization_id=$1 AND id=$2 AND status='approved'", [ctx.organizationId, approval.id]);
  await event(tx, ctx, "approval.consumed", approval.id as string, { kind: scope.kind });
  return { id: approval.id as string };
}

/** Integrator hook: revoke pending/approved approvals for a record whose content no longer matches. */
export async function revokeChangedApprovals(tx: Client, ctx: Context, kind: string, recordId: string, currentContent: unknown) {
  const revoked = rows(await tx.query("UPDATE app.action_approvals SET status='revoked',decided_at=app.utc_now(),decided_by_membership_id=$5 WHERE organization_id=$1 AND action_kind=$2 AND record_id=$3 AND status IN ('pending','approved') AND content_hash IS NOT NULL AND content_hash<>$4 RETURNING id",
    [ctx.organizationId, kind, recordId, digest(currentContent), ctx.membershipId]));
  for (const row of revoked) await event(tx, ctx, "approval.revoked", row.id as string, { reason: "CONTENT_CHANGED" });
  return revoked.length;
}

export class OwnerActionInbox {
  constructor(private readonly client: Client, private readonly ctx: Context) {}
  async request(input: ApprovalScope & { title: string; consequences: string[]; expiresInMinutes?: number }) {
    const title = text(input.title, "title", 200); const recordId = id(input.recordId, "record_id");
    if (!KNOWN_ACTIONS.includes(input.kind)) return fail("INVALID_ACTION_KIND", 400);
    if (!Array.isArray(input.consequences) || !input.consequences.length || input.consequences.length > 12) return fail("CONSEQUENCES_REQUIRED", 400);
    const consequences = input.consequences.map(c => text(c, "consequence", 300));
    const minutes = input.expiresInMinutes ?? 1440;
    if (!Number.isSafeInteger(minutes) || minutes < 5 || minutes > 10080) return fail("INVALID_EXPIRY", 400);
    const hashes = scopeHashes({ ...input, recordId });
    return tenant(this.client, this.ctx, async tx => {
      const policy = rows(await tx.query("SELECT version FROM app.policy_controls WHERE organization_id=$1", [this.ctx.organizationId]))[0];
      if (!policy) return fail("POLICY_UNCONFIGURED");
      await revokeChangedApprovals(tx, this.ctx, input.kind, recordId, input.content);
      const proposed = { content: input.content, audience: hashes.audience, campaignRevision: hashes.revision, budgetCents: hashes.budget, senderIdentity: hashes.sender };
      const row = rows(await tx.query(
        `INSERT INTO app.action_approvals(organization_id,action_kind,record_id,payload_hash,policy_version,requested_by_membership_id,proposed_payload,expires_at,title,content_hash,audience_hash,audience_count,campaign_revision,budget_cents,sender_identity,consequences)
         VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,app.utc_now()+make_interval(mins=>$8),$9,$10,$11,$12,$13,$14,$15,$16::jsonb) RETURNING *`,
        [this.ctx.organizationId, input.kind, recordId, hashes.payloadHash, policy.version, this.ctx.membershipId, JSON.stringify(proposed), minutes, title, hashes.contentHash, hashes.audienceHash, hashes.audience.length, hashes.revision, hashes.budget, hashes.sender, JSON.stringify(consequences)]))[0]!;
      await event(tx, this.ctx, "approval.requested", row.id as string, { kind: input.kind, audienceCount: hashes.audience.length, budgetCents: hashes.budget });
      return row;
    });
  }
  async decide(approvalId: string, approved: boolean) {
    return tenant(this.client, this.ctx, async tx => {
      const row = rows(await tx.query("UPDATE app.action_approvals SET status=$3,decided_at=app.utc_now(),decided_by_membership_id=$4 WHERE organization_id=$1 AND id=$2 AND status='pending' AND expires_at>app.utc_now() RETURNING *",
        [this.ctx.organizationId, id(approvalId, "approval_id"), approved ? "approved" : "rejected", this.ctx.membershipId]))[0];
      if (!row) return fail("APPROVAL_STALE");
      await event(tx, this.ctx, approved ? "approval.approved" : "approval.rejected", row.id as string);
      return row;
    });
  }
  async consume(approvalId: string, scope: ApprovalScope, dispatch: DispatchScope = {}) {
    return tenant(this.client, this.ctx, tx => consumeScopedApproval(tx, this.ctx, approvalId, scope, dispatch));
  }
  async revokeChanged(kind: string, recordId: string, currentContent: unknown) {
    return tenant(this.client, this.ctx, tx => revokeChangedApprovals(tx, this.ctx, kind, id(recordId, "record_id"), currentContent));
  }
}

// ---------------------------------------------------------------- kill switches (DOTS-038)
export class KillSwitches {
  constructor(private readonly client: Client, private readonly ctx: Context) {}
  private key(kind: string, key: unknown): string {
    if (!(KILL_SWITCH_SCOPES as readonly string[]).includes(kind)) return fail("INVALID_SCOPE_KIND", 400);
    if (kind === "organization") return "organization";
    if (kind === "campaign") return id(key, "campaign_id");
    if (kind === "channel") return channelOf(key) ?? fail("INVALID_CHANNEL", 400);
    return optionalKey(key, `${kind}_id`) ?? fail(`INVALID_${kind.toUpperCase()}_ID`, 400);
  }
  /** Engages a switch; queued tasks are preserved (organization scope parks them as waiting/OWNER_PAUSED). */
  async engage(scopeKind: string, scopeKey: unknown, rationale: string) {
    const key = this.key(scopeKind, scopeKey); const why = text(rationale, "rationale", 1000);
    return tenant(this.client, this.ctx, async tx => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`kill:${this.ctx.organizationId}`]);
      if (scopeKind === "campaign" && !rows(await tx.query("SELECT 1 FROM app.campaigns WHERE organization_id=$1 AND id=$2", [this.ctx.organizationId, key])).length) return fail("CAMPAIGN_NOT_FOUND", 404);
      const row = rows(await tx.query(
        `INSERT INTO app.kill_switches(organization_id,scope_kind,scope_key,active,rationale,updated_by_membership_id) VALUES($1,$2,$3,true,$4,$5)
         ON CONFLICT(organization_id,scope_kind,scope_key) DO UPDATE SET active=true,rationale=$4,version=app.kill_switches.version+1,updated_by_membership_id=$5,updated_at=app.utc_now() RETURNING *`,
        [this.ctx.organizationId, scopeKind, key, why, this.ctx.membershipId]))[0]!;
      let preserved = 0;
      if (scopeKind === "organization") {
        await tx.query("UPDATE app.policy_controls SET paused=true,version=version+1,updated_by_membership_id=$2,updated_at=app.utc_now() WHERE organization_id=$1", [this.ctx.organizationId, this.ctx.membershipId]);
        preserved = rows(await tx.query("UPDATE app.task_queue SET state='waiting',last_reason='OWNER_PAUSED',updated_at=app.utc_now() WHERE organization_id=$1 AND state='queued' RETURNING id", [this.ctx.organizationId])).length;
      } else preserved = n(rows(await tx.query("SELECT count(*)::int AS total FROM app.task_queue WHERE organization_id=$1 AND state IN ('queued','waiting')", [this.ctx.organizationId]))[0]!.total);
      await tx.query("INSERT INTO app.kill_switch_audit(organization_id,kill_switch_id,action,rationale,actor_membership_id,preserved_task_count) VALUES($1,$2,'engaged',$3,$4,$5)", [this.ctx.organizationId, row.id, why, this.ctx.membershipId, preserved]);
      await event(tx, this.ctx, "kill_switch.engaged", row.id as string, { scopeKind, preservedTasks: preserved });
      return { ...row, preservedTasks: preserved };
    });
  }
  /** Explicit resume with its own rationale. Organization release also resumes the runtime and requeues parked tasks. */
  async release(scopeKind: string, scopeKey: unknown, rationale: string) {
    const key = this.key(scopeKind, scopeKey); const why = text(rationale, "rationale", 1000);
    return tenant(this.client, this.ctx, async tx => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`kill:${this.ctx.organizationId}`]);
      const row = rows(await tx.query("UPDATE app.kill_switches SET active=false,version=version+1,updated_by_membership_id=$4,updated_at=app.utc_now() WHERE organization_id=$1 AND scope_kind=$2 AND scope_key=$3 AND active RETURNING *",
        [this.ctx.organizationId, scopeKind, key, this.ctx.membershipId]))[0];
      if (!row) return fail("KILL_SWITCH_NOT_ACTIVE", 409);
      let resumed = 0;
      if (scopeKind === "organization") {
        await tx.query("UPDATE app.policy_controls SET paused=false,version=version+1,updated_by_membership_id=$2,updated_at=app.utc_now() WHERE organization_id=$1", [this.ctx.organizationId, this.ctx.membershipId]);
        resumed = rows(await tx.query("UPDATE app.task_queue SET state='queued',last_reason=NULL,available_at=app.utc_now(),updated_at=app.utc_now() WHERE organization_id=$1 AND state='waiting' AND last_reason='OWNER_PAUSED' RETURNING id", [this.ctx.organizationId])).length;
      }
      await tx.query("INSERT INTO app.kill_switch_audit(organization_id,kill_switch_id,action,rationale,actor_membership_id,preserved_task_count) VALUES($1,$2,'released',$3,$4,$5)", [this.ctx.organizationId, row.id, why, this.ctx.membershipId, resumed]);
      await event(tx, this.ctx, "kill_switch.released", row.id as string, { scopeKind, resumedTasks: resumed });
      return { ...row, resumedTasks: resumed };
    });
  }
}

// ---------------------------------------------------------------- retries, dead letters, outbox (DOTS-031/039)
/** Exponential backoff: base·2^(attempt-1), capped, with optional proportional jitter (deterministic when jitterRatio=0). */
export function backoffDelayMs(attempt: number, options: { baseMs?: number; maxMs?: number; jitterRatio?: number; random?: () => number } = {}): number {
  const base = options.baseMs ?? 1000, max = options.maxMs ?? 15 * 60 * 1000, jitter = options.jitterRatio ?? 0;
  if (!Number.isSafeInteger(attempt) || attempt < 1) return fail("INVALID_ATTEMPT", 400);
  if (!(base > 0) || !(max >= base) || !(jitter >= 0 && jitter <= 1)) return fail("INVALID_BACKOFF", 400);
  const raw = Math.min(max, base * 2 ** Math.min(attempt - 1, 40));
  const factor = jitter ? 1 - jitter * Math.min(1, Math.max(0, (options.random ?? Math.random)())) : 1;
  return Math.max(0, Math.floor(raw * factor));
}

/**
 * Integrator hook for queue failures: requeues with backoff or moves the task to dead_letter
 * once attempts reach max_attempts. A fencing token, when supplied, must match the lease.
 */
export async function retryOrDeadLetter(tx: Client, ctx: Context, input: { taskId: string; reason: string; fence?: number; baseMs?: number; maxMs?: number }) {
  const reason = text(input.reason, "reason", 200);
  const task = rows(await tx.query("SELECT * FROM app.task_queue WHERE organization_id=$1 AND id=$2 FOR UPDATE", [ctx.organizationId, id(input.taskId, "task_id")]))[0];
  if (!task) return fail("NOT_FOUND", 404);
  if (input.fence !== undefined && n(task.fencing_token) !== input.fence) return fail("LEASE_LOST");
  if (!["running", "failed", "queued", "waiting"].includes(task.state)) return fail("TASK_NOT_RETRYABLE");
  if (n(task.attempts) >= n(task.max_attempts)) {
    await tx.query("UPDATE app.task_queue SET state='dead_letter',lease_owner=NULL,lease_expires_at=NULL,last_reason=$3,updated_at=app.utc_now() WHERE organization_id=$1 AND id=$2", [ctx.organizationId, task.id, reason]);
    await tx.query("INSERT INTO app.task_dead_letters(organization_id,task_id,attempts,reason,payload_hash) VALUES($1,$2,$3,$4,$5)", [ctx.organizationId, task.id, n(task.attempts), reason, digest(task.payload)]);
    await event(tx, ctx, "task.dead_lettered", task.id as string, { attempts: n(task.attempts), reason }, "worker");
    return { state: "dead_letter" as const, delayMs: null };
  }
  const delayMs = backoffDelayMs(Math.max(1, n(task.attempts)), { baseMs: input.baseMs, maxMs: input.maxMs });
  await tx.query("UPDATE app.task_queue SET state='queued',lease_owner=NULL,lease_expires_at=NULL,last_reason=$3,available_at=app.utc_now()+make_interval(secs=>$4::double precision/1000),updated_at=app.utc_now() WHERE organization_id=$1 AND id=$2",
    [ctx.organizationId, task.id, reason, delayMs]);
  await event(tx, ctx, "task.retry_scheduled", task.id as string, { attempts: n(task.attempts), delayMs, reason }, "worker");
  return { state: "queued" as const, delayMs };
}

export type OutboxEvent = { id: string; idempotencyKey: string; type: string; payload: Record<string, unknown>; attempts: number };
export class OutboxPublisher {
  constructor(private readonly client: Client, private readonly ctx: Context) {}
  /** At-least-once delivery keyed by the idempotency key; failures back off and quarantine after maxAttempts. */
  async publishPending(handler: (event: OutboxEvent) => Promise<void>, options: { limit?: number; maxAttempts?: number; baseMs?: number } = {}) {
    const limit = Math.min(100, Math.max(1, options.limit ?? 20)), maxAttempts = options.maxAttempts ?? 5;
    return tenant(this.client, this.ctx, async tx => {
      const pending = rows(await tx.query("SELECT * FROM app.event_outbox WHERE organization_id=$1 AND status='pending' AND available_at<=app.utc_now() ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT $2", [this.ctx.organizationId, limit]));
      const result = { published: 0, retried: 0, quarantined: 0 };
      for (const row of pending) {
        try {
          await handler({ id: row.id, idempotencyKey: row.idempotency_key, type: row.event_type, payload: row.payload, attempts: n(row.attempts) });
          await tx.query("UPDATE app.event_outbox SET status='published',attempts=attempts+1,published_at=app.utc_now() WHERE organization_id=$1 AND id=$2 AND status='pending'", [this.ctx.organizationId, row.id]);
          result.published++;
        } catch {
          const attempts = n(row.attempts) + 1;
          const quarantine = attempts >= maxAttempts;
          await tx.query("UPDATE app.event_outbox SET attempts=$3,status=$4,available_at=app.utc_now()+make_interval(secs=>$5::double precision/1000) WHERE organization_id=$1 AND id=$2 AND status='pending'",
            [this.ctx.organizationId, row.id, attempts, quarantine ? "quarantined" : "pending", backoffDelayMs(attempts, { baseMs: options.baseMs ?? 1000 })]);
          if (quarantine) { result.quarantined++; await event(tx, this.ctx, "outbox.quarantined", row.id as string, { attempts }, "worker"); } else result.retried++;
        }
      }
      return result;
    });
  }
  /** Idempotent: marking an already-published event is a no-op that reports false. */
  async markPublished(eventId: string) {
    return tenant(this.client, this.ctx, async tx => rows(await tx.query("UPDATE app.event_outbox SET status='published',published_at=app.utc_now() WHERE organization_id=$1 AND id=$2 AND status='pending' RETURNING id", [this.ctx.organizationId, id(eventId, "event_id")])).length === 1);
  }
}

// ---------------------------------------------------------------- encrypted credential references (DOTS-041)
export const CREDENTIAL_KINDS = ["api_key", "oauth_refresh_token", "webhook_secret"] as const;
function credentialKey(secret: string | undefined): Buffer {
  if (!secret) return fail("CREDENTIAL_ENCRYPTION_NOT_CONFIGURED", 503);
  const key = /^[0-9a-f]{64}$/i.test(secret) ? Buffer.from(secret, "hex") : Buffer.from(secret, "base64url");
  if (key.length !== 32) return fail("CREDENTIAL_ENCRYPTION_KEY_INVALID", 503);
  return key;
}
const credentialAad = (organizationId: string, providerId: string, credentialId: string) => Buffer.from(`dots-credential:v1:${organizationId}:${providerId}:${credentialId}`, "utf8");
export function encryptCredential(secretValue: string, key: Buffer, aad: Buffer): string {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  const encrypted = Buffer.concat([cipher.update(secretValue, "utf8"), cipher.final()]);
  return `v1.${Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url")}`;
}
export function decryptCredential(ciphertext: string, key: Buffer, aad: Buffer): string {
  if (!ciphertext.startsWith("v1.")) return fail("CREDENTIAL_CORRUPT");
  const data = Buffer.from(ciphertext.slice(3), "base64url");
  if (data.length < 29) return fail("CREDENTIAL_CORRUPT");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
    decipher.setAAD(aad); decipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString("utf8");
  } catch { return fail("CREDENTIAL_DECRYPT_FAILED"); }
}
const CREDENTIAL_METADATA = "id,provider_id,label,kind,fingerprint,last4,status,replaces_id,revocation_reason,version,created_at,rotated_at,revoked_at";

export class CredentialStore {
  constructor(private readonly client: Client, private readonly ctx: Context, private readonly secret: string | undefined = process.env.CREDENTIAL_ENCRYPTION_KEY) {}
  private material(providerId: string, credentialId: string, value: string) {
    const key = credentialKey(this.secret);
    return { ciphertext: encryptCredential(value, key, credentialAad(this.ctx.organizationId, providerId, credentialId)), fingerprint: createHmac("sha256", key).update(`fingerprint:${value}`).digest("hex").slice(0, 16), last4: value.slice(-4) };
  }
  private static validate(input: { providerId: string; label: string; kind?: string; secret: string }) {
    if (typeof input.providerId !== "string" || !/^[a-z][a-z0-9_-]{1,39}$/.test(input.providerId)) return fail("INVALID_PROVIDER_ID", 400);
    if (typeof input.label !== "string" || !/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,79}$/.test(input.label)) return fail("INVALID_LABEL", 400);
    if (input.kind !== undefined && !(CREDENTIAL_KINDS as readonly string[]).includes(input.kind)) return fail("INVALID_CREDENTIAL_KIND", 400);
    if (typeof input.secret !== "string" || input.secret.length < 8 || input.secret.length > 8192 || input.secret.trim() !== input.secret) return fail("INVALID_SECRET", 400);
  }
  /** Stores a new tenant/provider-scoped reference. Returns metadata only. */
  async store(input: { providerId: string; label: string; kind: string; secret: string }) {
    CredentialStore.validate(input);
    const credentialId = randomUUID(); const material = this.material(input.providerId, credentialId, input.secret);
    return tenant(this.client, this.ctx, async tx => {
      const existing = rows(await tx.query("SELECT 1 FROM app.credential_references WHERE organization_id=$1 AND provider_id=$2 AND label=$3 AND status='active'", [this.ctx.organizationId, input.providerId, input.label]));
      if (existing.length) return fail("CREDENTIAL_EXISTS_ROTATE_INSTEAD");
      const row = rows(await tx.query(`INSERT INTO app.credential_references(id,organization_id,provider_id,label,kind,ciphertext,fingerprint,last4,created_by_membership_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${CREDENTIAL_METADATA}`,
        [credentialId, this.ctx.organizationId, input.providerId, input.label, input.kind, material.ciphertext, material.fingerprint, material.last4, this.ctx.membershipId]))[0]!;
      await event(tx, this.ctx, "credential.stored", credentialId, { providerId: input.providerId, kind: input.kind, fingerprint: material.fingerprint });
      return row;
    });
  }
  /** Rotation creates a new active reference and crypto-shreds the previous ciphertext. */
  async rotate(credentialId: string, newSecret: string) {
    const cid = id(credentialId, "credential_id");
    return tenant(this.client, this.ctx, async tx => {
      const old = rows(await tx.query("SELECT * FROM app.credential_references WHERE organization_id=$1 AND id=$2 FOR UPDATE", [this.ctx.organizationId, cid]))[0];
      if (!old) return fail("NOT_FOUND", 404);
      if (old.status !== "active") return fail("CREDENTIAL_NOT_ACTIVE");
      CredentialStore.validate({ providerId: old.provider_id, label: old.label, secret: newSecret });
      const nextId = randomUUID(); const material = this.material(old.provider_id, nextId, newSecret);
      if (material.fingerprint === old.fingerprint) return fail("CREDENTIAL_UNCHANGED", 400);
      await tx.query("UPDATE app.credential_references SET status='rotated',ciphertext=NULL,rotated_at=app.utc_now(),version=version+1 WHERE organization_id=$1 AND id=$2", [this.ctx.organizationId, cid]);
      const row = rows(await tx.query(`INSERT INTO app.credential_references(id,organization_id,provider_id,label,kind,ciphertext,fingerprint,last4,replaces_id,created_by_membership_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${CREDENTIAL_METADATA}`,
        [nextId, this.ctx.organizationId, old.provider_id, old.label, old.kind, material.ciphertext, material.fingerprint, material.last4, cid, this.ctx.membershipId]))[0]!;
      await event(tx, this.ctx, "credential.rotated", nextId, { replaces: cid, fingerprint: material.fingerprint });
      return row;
    });
  }
  async revoke(credentialId: string, reason: string) {
    const cid = id(credentialId, "credential_id"); const why = text(reason, "reason", 500);
    return tenant(this.client, this.ctx, async tx => {
      const row = rows(await tx.query(`UPDATE app.credential_references SET status='revoked',ciphertext=NULL,revocation_reason=$3,revoked_at=app.utc_now(),version=version+1 WHERE organization_id=$1 AND id=$2 AND status='active' RETURNING ${CREDENTIAL_METADATA}`, [this.ctx.organizationId, cid, why]))[0];
      if (!row) return fail("CREDENTIAL_NOT_ACTIVE");
      await event(tx, this.ctx, "credential.revoked", cid, { reason: why });
      return row;
    });
  }
  /** Metadata only: never selects ciphertext. */
  async list() { return tenant(this.client, this.ctx, async tx => rows(await tx.query(`SELECT ${CREDENTIAL_METADATA} FROM app.credential_references WHERE organization_id=$1 ORDER BY provider_id,label,created_at DESC`, [this.ctx.organizationId]))); }
  /** Worker-only resolution of the active secret for an outbound call. Never expose through HTTP or logs. */
  async resolveForUse(providerId: string, label: string): Promise<string> {
    return tenant(this.client, this.ctx, async tx => {
      const row = rows(await tx.query("SELECT id,provider_id,ciphertext FROM app.credential_references WHERE organization_id=$1 AND provider_id=$2 AND label=$3 AND status='active'", [this.ctx.organizationId, providerId, label]))[0];
      if (!row) return fail("CREDENTIAL_NOT_FOUND", 404);
      const value = decryptCredential(row.ciphertext as string, credentialKey(this.secret), credentialAad(this.ctx.organizationId, row.provider_id as string, row.id as string));
      await event(tx, this.ctx, "credential.used", row.id as string, { providerId }, "worker");
      return value;
    });
  }
}

// ---------------------------------------------------------------- privacy-safe structured logging (DOTS-042)
const SENSITIVE_KEY = /(pass(word)?|secret|token|api[-_]?key|authorization|cookie|credential|session|ciphertext|private[-_]?key|signature|email|phone|address|body|content|display[-_]?name|ssn|card)/i;
const REDACTIONS: Array<[RegExp, string]> = [
  [/-----BEGIN[^-]+-----[\s\S]*?-----END[^-]+-----/g, "[redacted:pem]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted:token]"],
  [/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}\b/g, "[redacted:key]"],
  [/\bsk-[A-Za-z0-9_-]{12,}/g, "[redacted:key]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[redacted:key]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[redacted:jwt]"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted:email]"],
  [/(?<![\w-])\+?\(?\d{1,4}\)?[ .-]?\(?\d{2,4}\)?[ .-]?\d{3,4}[ .-]?\d{3,4}(?![\w-])/g, "[redacted:phone]"],
  [/\b(?=[A-Za-z0-9+/_-]*\d)(?=[A-Za-z0-9+/_-]*[A-Za-z])[A-Za-z0-9+/_-]{40,}={0,2}/g, "[redacted:opaque]"],
];
const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
export function redactText(value: string): string {
  // Entity UUIDs are diagnostic and non-personal; protect them from the generic opaque-token rule.
  const ids: string[] = [];
  let masked = value.replace(UUID_ANYWHERE, match => `\u0000${ids.push(match) - 1}\u0000`);
  for (const [pattern, replacement] of REDACTIONS) masked = masked.replace(pattern, replacement);
  masked = masked.replace(/\u0000(\d+)\u0000/g, (_, index: string) => ids[Number(index)] ?? "");
  return masked.length > 2000 ? `${masked.slice(0, 2000)}…[truncated]` : masked;
}
/** Recursively redacts sensitive keys and secret/PII-shaped values. Pure; never mutates input. */
export function redactForLog(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[redacted:depth]";
  if (typeof value === "string") return redactText(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return { name: value.name, code: (value as { code?: unknown }).code ?? null, message: redactText(value.message) };
  if (Array.isArray(value)) return value.slice(0, 50).map(item => redactForLog(item, depth + 1));
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 100)) output[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : redactForLog(item, depth + 1);
    return output;
  }
  return "[redacted:unsupported]";
}
export const newCorrelationId = (): string => randomUUID();
export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogRecord = { ts: string; level: LogLevel; msg: string; correlationId: string; service: string; fields: unknown; error?: unknown };
/** Builds one JSON log line. Messages are redacted too, so interpolated secrets never leak. */
export function structuredLogLine(level: LogLevel, message: string, fields: Record<string, unknown> = {}, options: { correlationId?: string; service?: string; now?: Date; error?: unknown } = {}): string {
  const record: LogRecord = { ts: (options.now ?? new Date()).toISOString(), level, msg: redactText(String(message)), correlationId: options.correlationId && UUID.test(options.correlationId) ? options.correlationId : newCorrelationId(), service: options.service ?? "dots", fields: redactForLog(fields) };
  if (options.error !== undefined) record.error = redactForLog(options.error instanceof Error ? options.error : { value: options.error });
  return JSON.stringify(record);
}
export function createLogger(options: { service?: string; correlationId?: string; sink?: (line: string) => void; now?: () => Date } = {}) {
  const correlationId = options.correlationId && UUID.test(options.correlationId) ? options.correlationId : newCorrelationId();
  const sink = options.sink ?? ((line: string) => process.stdout.write(`${line}\n`));
  const write = (level: LogLevel) => (message: string, fields: Record<string, unknown> = {}, error?: unknown) =>
    sink(structuredLogLine(level, message, fields, { correlationId, service: options.service, now: options.now?.(), error }));
  return { correlationId, debug: write("debug"), info: write("info"), warn: write("warn"), error: write("error"),
    child: (service: string) => createLogger({ ...options, service, correlationId }) };
}

// ---------------------------------------------------------------- retention, holds, deletion, export, audit (DOTS-042/043)
export const DEFAULT_RETENTION: Array<{ recordKind: string; days: number; action: string; basis: string }> = [
  { recordKind: "crm_contacts", days: 365, action: "redact", basis: "Archived or suppressed contacts are redacted after one year unless an evidence hold applies; the suppression hash is kept to honor opt-outs." },
  { recordKind: "messages", days: 730, action: "redact", basis: "Message bodies of redacted contacts are cleared with the contact." },
  { recordKind: "contact_events", days: 730, action: "redact", basis: "Contact notes follow contact redaction." },
  { recordKind: "operation_events", days: 2555, action: "retain_as_evidence", basis: "Append-only operational evidence; details carry identifiers, not contact data." },
  { recordKind: "policy_decisions", days: 2555, action: "retain_as_evidence", basis: "Decision evidence for compliance review." },
  { recordKind: "money_entries", days: 2555, action: "retain_as_evidence", basis: "Financial records retained for accounting." },
  { recordKind: "credential_references", days: 30, action: "crypto_shred", basis: "Rotated and revoked secrets are shredded immediately; metadata kept 30 days for audit." },
  { recordKind: "export_jobs", days: 90, action: "retain_as_evidence", basis: "Export artifacts are never stored; only hashes and counts." },
];

export class GovernanceService {
  constructor(private readonly client: Client, private readonly ctx: Context) {}

  async setRetention(recordKind: string, retentionDays: number, action: string, basis: string) {
    if (!DEFAULT_RETENTION.some(r => r.recordKind === recordKind)) return fail("INVALID_RECORD_KIND", 400);
    if (!Number.isSafeInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) return fail("INVALID_RETENTION_DAYS", 400);
    if (!["redact", "retain_as_evidence", "crypto_shred"].includes(action)) return fail("INVALID_RETENTION_ACTION", 400);
    const why = text(basis, "basis", 500);
    return tenant(this.client, this.ctx, async tx => {
      const row = rows(await tx.query(`INSERT INTO app.retention_policies(organization_id,record_kind,retention_days,action,basis,updated_by_membership_id) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(organization_id,record_kind) DO UPDATE SET retention_days=$3,action=$4,basis=$5,version=app.retention_policies.version+1,updated_by_membership_id=$6,updated_at=app.utc_now() RETURNING *`,
        [this.ctx.organizationId, recordKind, retentionDays, action, why, this.ctx.membershipId]))[0]!;
      await event(tx, this.ctx, "retention.policy_set", row.id as string, { recordKind, retentionDays, action });
      return row;
    });
  }

  async ensureDefaultRetention() {
    return tenant(this.client, this.ctx, async tx => {
      for (const policy of DEFAULT_RETENTION) await tx.query("INSERT INTO app.retention_policies(organization_id,record_kind,retention_days,action,basis,updated_by_membership_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
        [this.ctx.organizationId, policy.recordKind, policy.days, policy.action, policy.basis, this.ctx.membershipId]);
    });
  }

  /** Redacts contacts past their retention window that are archived/suppressed and not under an active evidence hold. */
  async applyRetention() {
    return tenant(this.client, this.ctx, async tx => {
      const policy = rows(await tx.query("SELECT retention_days,action FROM app.retention_policies WHERE organization_id=$1 AND record_kind='crm_contacts'", [this.ctx.organizationId]))[0];
      if (!policy || policy.action !== "redact") return { redacted: 0, held: 0 };
      const candidates = rows(await tx.query(`SELECT c.id,EXISTS(SELECT 1 FROM app.evidence_holds h WHERE h.organization_id=c.organization_id AND h.active AND ((h.subject_kind='contact' AND h.subject_id=c.id) OR h.subject_kind='organization')) AS held
        FROM app.crm_contacts c WHERE c.organization_id=$1 AND c.status IN ('archived','suppressed') AND c.updated_at<app.utc_now()-make_interval(days=>$2)`, [this.ctx.organizationId, n(policy.retention_days)]));
      let redacted = 0;
      for (const candidate of candidates) if (!candidate.held) { await redactContactInTx(tx, this.ctx, candidate.id as string); redacted++; }
      const held = candidates.length - redacted;
      await event(tx, this.ctx, "retention.applied", null, { redacted, held });
      return { redacted, held };
    });
  }

  async placeHold(subjectKind: string, subjectId: string, reason: string) {
    if (!["contact", "campaign", "organization"].includes(subjectKind)) return fail("INVALID_SUBJECT_KIND", 400);
    const subject = subjectKind === "organization" ? this.ctx.organizationId : id(subjectId, "subject_id"); const why = text(reason, "reason", 1000);
    return tenant(this.client, this.ctx, async tx => {
      const row = rows(await tx.query("INSERT INTO app.evidence_holds(organization_id,subject_kind,subject_id,reason,created_by_membership_id) VALUES($1,$2,$3,$4,$5) RETURNING *", [this.ctx.organizationId, subjectKind, subject, why, this.ctx.membershipId]))[0]!;
      await event(tx, this.ctx, "evidence_hold.placed", row.id as string, { subjectKind });
      return row;
    });
  }
  async releaseHold(holdId: string, rationale: string) {
    const why = text(rationale, "rationale", 1000);
    return tenant(this.client, this.ctx, async tx => {
      const row = rows(await tx.query("UPDATE app.evidence_holds SET active=false,released_at=app.utc_now(),released_by_membership_id=$3,release_rationale=$4 WHERE organization_id=$1 AND id=$2 AND active RETURNING *", [this.ctx.organizationId, id(holdId, "hold_id"), this.ctx.membershipId, why]))[0];
      if (!row) return fail("HOLD_NOT_ACTIVE");
      await event(tx, this.ctx, "evidence_hold.released", row.id as string);
      return row;
    });
  }

  async requestDeletion(subjectKind: string, subjectId: string, reason: string) {
    if (subjectKind !== "contact") return fail("INVALID_SUBJECT_KIND", 400);
    const subject = id(subjectId, "subject_id"); const why = text(reason, "reason", 1000);
    return tenant(this.client, this.ctx, async tx => {
      if (!rows(await tx.query("SELECT 1 FROM app.crm_contacts WHERE organization_id=$1 AND id=$2", [this.ctx.organizationId, subject])).length) return fail("NOT_FOUND", 404);
      const row = rows(await tx.query("INSERT INTO app.deletion_requests(organization_id,subject_kind,subject_id,reason,requested_by_membership_id) VALUES($1,$2,$3,$4,$5) RETURNING *", [this.ctx.organizationId, subjectKind, subject, why, this.ctx.membershipId]))[0]!;
      await event(tx, this.ctx, "deletion.requested", row.id as string, { subjectKind });
      return row;
    });
  }
  /** Processes a request: an active evidence hold parks it as 'held'; otherwise the contact is redacted and suppressed. */
  async processDeletion(requestId: string) {
    return tenant(this.client, this.ctx, async tx => {
      const request = rows(await tx.query("SELECT * FROM app.deletion_requests WHERE organization_id=$1 AND id=$2 FOR UPDATE", [this.ctx.organizationId, id(requestId, "request_id")]))[0];
      if (!request) return fail("NOT_FOUND", 404);
      if (request.status === "completed") return request;
      const hold = rows(await tx.query("SELECT id FROM app.evidence_holds WHERE organization_id=$1 AND active AND ((subject_kind='contact' AND subject_id=$2) OR subject_kind='organization') LIMIT 1", [this.ctx.organizationId, request.subject_id]))[0];
      if (hold) {
        const row = rows(await tx.query("UPDATE app.deletion_requests SET status='held',outcome=$3::jsonb,decided_at=app.utc_now() WHERE organization_id=$1 AND id=$2 RETURNING *", [this.ctx.organizationId, request.id, JSON.stringify({ holdId: hold.id })]))[0];
        await event(tx, this.ctx, "deletion.held", request.id as string, { holdId: hold.id });
        return row;
      }
      const outcome = await redactContactInTx(tx, this.ctx, request.subject_id as string);
      const row = rows(await tx.query("UPDATE app.deletion_requests SET status='completed',outcome=$3::jsonb,decided_at=app.utc_now() WHERE organization_id=$1 AND id=$2 RETURNING *", [this.ctx.organizationId, request.id, JSON.stringify(outcome)]))[0];
      await event(tx, this.ctx, "deletion.completed", request.id as string, outcome);
      return row;
    });
  }

  async requeueDeadLetter(taskId: string, rationale: string) {
    const why = text(rationale, "rationale", 500);
    return tenant(this.client, this.ctx, async tx => {
      const row = rows(await tx.query("UPDATE app.task_queue SET state='queued',attempts=0,last_reason=NULL,available_at=app.utc_now(),updated_at=app.utc_now() WHERE organization_id=$1 AND id=$2 AND state='dead_letter' RETURNING id", [this.ctx.organizationId, id(taskId, "task_id")]))[0];
      if (!row) return fail("TASK_NOT_DEAD_LETTERED");
      await event(tx, this.ctx, "task.dead_letter_requeued", row.id as string, { rationale: why });
      return row;
    });
  }

  /** Tenant-scoped export. The artifact is returned once and only its hash and count are persisted. */
  async runExport(scope: string) {
    if (!["audit", "ledger", "contacts"].includes(scope)) return fail("INVALID_EXPORT_SCOPE", 400);
    return tenant(this.client, this.ctx, async tx => {
      const job = rows(await tx.query("INSERT INTO app.export_jobs(organization_id,scope,requested_by_membership_id) VALUES($1,$2,$3) RETURNING *", [this.ctx.organizationId, scope, this.ctx.membershipId]))[0]!;
      const org = this.ctx.organizationId;
      const sections: Record<string, Row[]> = {};
      if (scope === "audit") {
        sections.events = rows(await tx.query("SELECT id,actor_kind,event_type,record_id,correlation_id,details,occurred_at FROM app.operation_events WHERE organization_id=$1 ORDER BY occurred_at,id LIMIT 10000", [org]));
        sections.decisions = rows(await tx.query("SELECT id,subject_kind,subject_id,decision,rules,ruleset_version,created_at FROM app.policy_decisions WHERE organization_id=$1 ORDER BY created_at", [org]));
        sections.approvals = rows(await tx.query("SELECT id,action_kind,record_id,status,payload_hash,content_hash,audience_hash,audience_count,campaign_revision,budget_cents,sender_identity,created_at,decided_at,expires_at FROM app.action_approvals WHERE organization_id=$1 ORDER BY created_at", [org]));
        sections.killSwitchAudit = rows(await tx.query("SELECT * FROM app.kill_switch_audit WHERE organization_id=$1 ORDER BY created_at", [org]));
      } else if (scope === "ledger") {
        sections.journals = rows(await tx.query("SELECT * FROM app.budget_journals WHERE organization_id=$1 ORDER BY created_at,id", [org]));
        sections.entries = rows(await tx.query("SELECT * FROM app.budget_ledger_entries WHERE organization_id=$1 ORDER BY created_at,id", [org]));
        sections.reservations = rows(await tx.query("SELECT * FROM app.governed_reservations WHERE organization_id=$1 ORDER BY created_at,id", [org]));
        sections.moneyEntries = rows(await tx.query("SELECT * FROM app.money_entries WHERE organization_id=$1 ORDER BY occurred_at,id", [org]));
      } else {
        sections.contacts = rows(await tx.query("SELECT id,display_name,email,role_title,status,consent,lawful_source,jurisdiction,consent_evidence,created_at,updated_at FROM app.crm_contacts WHERE organization_id=$1 ORDER BY created_at,id", [org]));
        sections.suppressions = rows(await tx.query("SELECT email_hash,reason,source,created_at FROM app.contact_suppressions WHERE organization_id=$1 ORDER BY created_at", [org]));
      }
      const data = { organizationId: org, scope, exportId: job.id, sections };
      const rowCount = Object.values(sections).reduce((sum, list) => sum + list.length, 0);
      const artifactHash = digest(data);
      const completed = rows(await tx.query("UPDATE app.export_jobs SET status='completed',row_count=$3,artifact_hash=$4,completed_at=app.utc_now() WHERE organization_id=$1 AND id=$2 RETURNING *", [org, job.id, rowCount, artifactHash]))[0]!;
      await event(tx, this.ctx, "export.completed", job.id as string, { scope, rowCount, artifactHash });
      return { job: completed, data };
    });
  }

  async metrics() { return tenant(this.client, this.ctx, tx => governanceMetrics(tx, this.ctx)); }

  /** Everything the governance console renders, tenant-scoped and without secrets. */
  async snapshot() {
    return tenant(this.client, this.ctx, async tx => {
      const org = this.ctx.organizationId;
      const q = async (sql: string) => rows(await tx.query(sql, [org]));
      return {
        budget: await budgetSummary(tx, this.ctx),
        reservations: await q("SELECT id,purpose,status,estimate_cents,actual_cents,funding_scope_id,campaign_id,provider_id,model_id,channel,final_reason,expires_at,created_at,finalized_at FROM app.governed_reservations WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 25"),
        journals: await q("SELECT j.id,j.kind,j.reason,j.created_at,COALESCE(jsonb_agg(jsonb_build_object('account',e.account,'scope_id',e.scope_id,'amount_cents',e.amount_cents) ORDER BY e.amount_cents) FILTER (WHERE e.id IS NOT NULL),'[]') AS lines FROM app.budget_journals j LEFT JOIN app.budget_ledger_entries e ON e.organization_id=j.organization_id AND e.journal_id=j.id WHERE j.organization_id=$1 GROUP BY j.id ORDER BY j.created_at DESC LIMIT 25"),
        alerts: await q("SELECT a.*,s.scope_kind,s.scope_key FROM app.budget_alerts a JOIN app.budget_scopes s ON s.organization_id=a.organization_id AND s.id=a.scope_id WHERE a.organization_id=$1 ORDER BY a.created_at DESC LIMIT 20"),
        killSwitches: await q("SELECT * FROM app.kill_switches WHERE organization_id=$1 ORDER BY active DESC,updated_at DESC"),
        killSwitchAudit: await q("SELECT * FROM app.kill_switch_audit WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 20"),
        runtime: (await q("SELECT paused,model_enabled,outbound_enabled,version,updated_at FROM app.policy_controls WHERE organization_id=$1"))[0] ?? null,
        approvals: await q("SELECT id,action_kind,record_id,title,status,payload_hash,content_hash,audience_hash,audience_count,campaign_revision,budget_cents,sender_identity,consequences,proposed_payload,policy_version,created_at,expires_at,decided_at,(expires_at<=app.utc_now()) AS expired FROM app.action_approvals WHERE organization_id=$1 ORDER BY (status='pending') DESC,created_at DESC LIMIT 30"),
        decisions: await q("SELECT id,subject_kind,subject_id,decision,rules,ruleset_version,created_at FROM app.policy_decisions WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 20"),
        credentials: await q(`SELECT ${CREDENTIAL_METADATA} FROM app.credential_references WHERE organization_id=$1 ORDER BY provider_id,label,created_at DESC`),
        deadLetters: await q("SELECT d.id,d.task_id,d.attempts,d.reason,d.created_at,t.kind,t.state FROM app.task_dead_letters d JOIN app.task_queue t ON t.organization_id=d.organization_id AND t.id=d.task_id WHERE d.organization_id=$1 ORDER BY d.created_at DESC LIMIT 20"),
        retention: await q("SELECT * FROM app.retention_policies WHERE organization_id=$1 ORDER BY record_kind"),
        holds: await q("SELECT * FROM app.evidence_holds WHERE organization_id=$1 ORDER BY active DESC,created_at DESC LIMIT 20"),
        deletionRequests: await q("SELECT * FROM app.deletion_requests WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 20"),
        exports: await q("SELECT * FROM app.export_jobs WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 10"),
        projects: await q("SELECT id,label FROM app.projects WHERE organization_id=$1 ORDER BY label LIMIT 100"),
        campaigns: await q("SELECT id,label,project_id,revision,state FROM app.campaigns WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 100"),
        metrics: await governanceMetrics(tx, this.ctx),
        audit: await auditSummary(tx, this.ctx),
      };
    });
  }
}

export async function redactContactInTx(tx: Client, ctx: Context, contactId: string) {
  const contact = rows(await tx.query("SELECT email_hash FROM app.crm_contacts WHERE organization_id=$1 AND id=$2 FOR UPDATE", [ctx.organizationId, contactId]))[0];
  if (!contact) return fail("NOT_FOUND", 404);
  await tx.query("INSERT INTO app.contact_suppressions(organization_id,email_hash,reason,source) VALUES($1,$2,'PRIVACY_ERASURE','privacy') ON CONFLICT DO NOTHING", [ctx.organizationId, contact.email_hash]);
  await tx.query("UPDATE app.crm_contacts SET display_name='[Redacted]',email=NULL,role_title=NULL,lawful_source='Redacted by owner',consent_evidence=NULL,status='redacted',consent='opted_out',version=version+1,updated_at=app.utc_now() WHERE organization_id=$1 AND id=$2", [ctx.organizationId, contactId]);
  const events = rows(await tx.query("UPDATE app.contact_events SET content='[Redacted]' WHERE organization_id=$1 AND contact_id=$2 RETURNING 1", [ctx.organizationId, contactId])).length;
  const messages = rows(await tx.query("UPDATE app.messages SET body='[Redacted]',subject='[Redacted]',state='redacted',version=version+1 WHERE organization_id=$1 AND conversation_id IN (SELECT id FROM app.conversations WHERE organization_id=$1 AND contact_id=$2) RETURNING 1", [ctx.organizationId, contactId])).length;
  return { contactRedacted: true, suppressionKept: true, contactEventsRedacted: events, messagesRedacted: messages };
}

export async function governanceMetrics(tx: Client, ctx: Context) {
  const org = ctx.organizationId;
  const queue = rows(await tx.query("SELECT state,count(*)::int AS total FROM app.task_queue WHERE organization_id=$1 GROUP BY state ORDER BY state", [org]));
  const oldest = rows(await tx.query("SELECT COALESCE(EXTRACT(EPOCH FROM app.utc_now()-min(available_at)),0)::int AS seconds FROM app.task_queue WHERE organization_id=$1 AND state='queued' AND available_at<=app.utc_now()", [org]))[0]!;
  const outbox = rows(await tx.query("SELECT status,count(*)::int AS total FROM app.event_outbox WHERE organization_id=$1 GROUP BY status ORDER BY status", [org]));
  const runs = rows(await tx.query("SELECT state,count(*)::int AS total FROM app.agent_runs WHERE organization_id=$1 AND started_at>app.utc_now()-interval '24 hours' GROUP BY state ORDER BY state", [org]));
  const mutations = rows(await tx.query("SELECT event_type,count(*)::int AS total FROM app.operation_events WHERE organization_id=$1 AND occurred_at>app.utc_now()-interval '24 hours' GROUP BY event_type ORDER BY total DESC,event_type LIMIT 12", [org]));
  const errors = rows(await tx.query("SELECT reason_code,count(*)::int AS total FROM app.agent_runs WHERE organization_id=$1 AND state IN ('failed','quarantined') AND started_at>app.utc_now()-interval '7 days' GROUP BY reason_code ORDER BY total DESC LIMIT 10", [org]));
  return { queue, oldestQueuedSeconds: n(oldest.seconds), outbox, runs, mutations, errors };
}

export async function auditSummary(tx: Client, ctx: Context, days = 30) {
  const org = ctx.organizationId;
  const approvals = rows(await tx.query("SELECT status,count(*)::int AS total FROM app.action_approvals WHERE organization_id=$1 AND created_at>app.utc_now()-make_interval(days=>$2) GROUP BY status ORDER BY status", [org, days]));
  const decisions = rows(await tx.query("SELECT decision,count(*)::int AS total FROM app.policy_decisions WHERE organization_id=$1 AND created_at>app.utc_now()-make_interval(days=>$2) GROUP BY decision ORDER BY decision", [org, days]));
  const killSwitches = rows(await tx.query("SELECT action,count(*)::int AS total FROM app.kill_switch_audit WHERE organization_id=$1 AND created_at>app.utc_now()-make_interval(days=>$2) GROUP BY action ORDER BY action", [org, days]));
  const events = n(rows(await tx.query("SELECT count(*)::int AS total FROM app.operation_events WHERE organization_id=$1 AND occurred_at>app.utc_now()-make_interval(days=>$2)", [org, days]))[0]!.total);
  return { days, approvals, decisions, killSwitches, events };
}
