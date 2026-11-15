import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { withTransaction } from "@dots/database";
import { type Client, type Context, type Row, rows, tenant, event, fail, text } from "./common.js";
import { selection, identifier } from "./sales.js";
import { DurableQueue } from "./queue.js";
import { ControlPlane } from "./control.js";

/**
 * DOTS-145/149/155/156/158/159: production platform operations.
 * Every alert, drill result and portfolio figure is derived from persisted rows; nothing is estimated here.
 */
export type Alert = { id: string; severity: "info" | "warning" | "critical"; title: string; detail: string; evidence: Record<string, unknown> };
export const PORTFOLIO_CONTRACT_VERSION = "dots-portfolio-summary-v1" as const;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export async function operationalHealth(client: Client, ctx: Context, environment: Record<string, string | undefined> = process.env, now = new Date()): Promise<{ observedAt: string; alerts: Alert[]; metrics: Record<string, number> }> {
  return tenant(client, ctx, async tx => {
    const org = ctx.organizationId;
    const one = async (sql: string, values: unknown[] = []) => rows(await tx.query(sql, [org, ...values]))[0] ?? {};
    const queue = await one(`SELECT count(*) FILTER (WHERE state='queued')::int AS queued,
      count(*) FILTER (WHERE state='queued' AND available_at < $2::timestamptz - interval '15 minutes')::int AS stale_queued,
      count(*) FILTER (WHERE state='running')::int AS running,
      count(*) FILTER (WHERE state='running' AND lease_expires_at <= $2::timestamptz)::int AS expired_leases,
      count(*) FILTER (WHERE state='quarantined')::int AS quarantined,
      count(*) FILTER (WHERE state='failed')::int AS failed,
      min(available_at) FILTER (WHERE state='queued') AS oldest_queued
      FROM app.task_queue WHERE organization_id=$1`, [now.toISOString()]);
    const policy = await one("SELECT paused,model_enabled,outbound_enabled,updated_at FROM app.policy_controls WHERE organization_id=$1");
    const budget = await one("SELECT limit_cents,reserved_cents,spent_cents FROM app.spending_policies WHERE organization_id=$1 AND project_id IS NULL");
    const reservations = await one("SELECT count(*)::int AS stale FROM app.budget_reservations WHERE organization_id=$1 AND status='reserved' AND created_at < $2::timestamptz - interval '1 hour'", [now.toISOString()]);
    const delivery = await one(`SELECT count(*) FILTER (WHERE source='bounce')::int AS bounces, count(*) FILTER (WHERE source='complaint')::int AS complaints
      FROM app.contact_suppressions WHERE organization_id=$1 AND created_at >= $2::timestamptz - interval '7 days'`, [now.toISOString()]);
    const sent = await one("SELECT count(*)::int AS sent FROM app.messages WHERE organization_id=$1 AND direction='outbound' AND state IN ('sent','delivered') AND sent_at >= $2::timestamptz - interval '7 days'", [now.toISOString()]);
    const mailboxes = await one("SELECT count(*) FILTER (WHERE status='paused')::int AS paused, count(*) FILTER (WHERE status='active' AND verified)::int AS active FROM app.mailboxes WHERE organization_id=$1");
    const receipts = await one("SELECT count(*)::int AS pending FROM app.provider_receipts WHERE organization_id=$1 AND processed_at IS NULL AND received_at < $2::timestamptz - interval '10 minutes'", [now.toISOString()]);
    const approvals = await one("SELECT count(*)::int AS expiring FROM app.action_approvals WHERE organization_id=$1 AND status='pending' AND expires_at BETWEEN $2::timestamptz AND $2::timestamptz + interval '2 hours'", [now.toISOString()]);
    const quarantinedMessages = await one("SELECT count(*)::int AS total FROM app.messages WHERE organization_id=$1 AND state='quarantined'");
    const incidents = await one("SELECT count(*) FILTER (WHERE state<>'resolved')::int AS open FROM app.incidents WHERE organization_id=$1");
    const alerts: Alert[] = [];
    const add = (id: string, severity: Alert["severity"], title: string, detail: string, evidence: Record<string, unknown>) => alerts.push({ id, severity, title, detail, evidence });
    if (policy.paused) add("runtime.paused", "info", "Queue paused by owner", "No queued work will be claimed until the owner resumes it.", { since: policy.updated_at });
    if (Number(queue.stale_queued) > 0 && !policy.paused) add("queue.stale", environment.JOB_WORKER_ENABLED === "true" ? "warning" : "critical", "Queued work is waiting", environment.JOB_WORKER_ENABLED === "true" ? "Tasks have been due for more than 15 minutes. The free web service may be asleep; open the workspace to wake it." : "The worker is disabled in this deployment, so due tasks cannot run.", { staleQueued: queue.stale_queued, oldestQueued: queue.oldest_queued });
    if (Number(queue.expired_leases) > 0) add("queue.expired_leases", "warning", "Worker leases expired", "Running tasks lost their heartbeat. The next worker pass quarantines them for reconciliation.", { expiredLeases: queue.expired_leases });
    if (Number(queue.quarantined) > 0) add("queue.quarantined", "warning", "Tasks need reconciliation", "Quarantined tasks have an uncertain external outcome and are never retried automatically.", { quarantined: queue.quarantined });
    if (Number(reservations.stale) > 0) add("budget.stale_reservations", "warning", "Budget reservations are still held", "Reservations older than one hour need provider usage reconciliation.", { stale: reservations.stale });
    const limit = Number(budget.limit_cents ?? 0), used = Number(budget.reserved_cents ?? 0) + Number(budget.spent_cents ?? 0);
    if (limit > 0 && used / limit >= 0.8) add("budget.threshold", used >= limit ? "critical" : "warning", used >= limit ? "Budget hard cap reached" : "Budget above 80%", "Paid operations stop at the hard cap.", { limitCents: limit, usedCents: used });
    const sentCount = Number(sent.sent ?? 0), complaints = Number(delivery.complaints ?? 0), bounces = Number(delivery.bounces ?? 0);
    if (complaints > 0) add("delivery.complaints", sentCount > 0 && complaints / sentCount >= 0.001 ? "critical" : "warning", "Spam complaints received", "Complaining recipients were suppressed and their mailbox paused.", { complaints7d: complaints, sent7d: sentCount });
    if (bounces > 0) add("delivery.bounces", sentCount > 0 && bounces / sentCount >= 0.05 ? "critical" : "warning", "Bounces received", "Bounced addresses were suppressed.", { bounces7d: bounces, sent7d: sentCount });
    if (Number(mailboxes.paused) > 0) add("delivery.mailbox_paused", "warning", "A sender mailbox is paused", "Review complaints and bounces before resuming delivery.", { paused: mailboxes.paused });
    if (Number(receipts.pending) > 0) add("receipts.pending", "warning", "Provider receipts await processing", "Signed webhook receipts were stored but not yet applied.", { pending: receipts.pending });
    if (Number(approvals.expiring) > 0) add("approvals.expiring", "info", "Approvals expire soon", "Pending owner approvals expire within two hours.", { expiring: approvals.expiring });
    if (Number(quarantinedMessages.total) > 0) add("delivery.uncertain", "critical", "Message delivery outcome uncertain", "Quarantined messages must be reconciled with the provider before any resend.", { quarantined: quarantinedMessages.total });
    if (Number(incidents.open) > 0) add("incidents.open", "warning", "Open incidents", "Resolve or mitigate incidents with recorded evidence.", { open: incidents.open });
    return { observedAt: now.toISOString(), alerts, metrics: {
      queued: Number(queue.queued ?? 0), running: Number(queue.running ?? 0), quarantined: Number(queue.quarantined ?? 0), failed: Number(queue.failed ?? 0),
      budgetLimitCents: limit, budgetUsedCents: used, sent7d: sentCount, bounces7d: bounces, complaints7d: complaints,
      activeMailboxes: Number(mailboxes.active ?? 0), openIncidents: Number(incidents.open ?? 0),
    } };
  });
}

export class IncidentLog {
  constructor(private readonly client: Client, private readonly ctx: Context) {}
  open(kind: string, severity: string, summary: string) {
    selection(kind, ["kill_switch_drill", "credential_revocation_drill", "queue", "budget", "delivery", "security", "privacy", "availability", "other"], "incident_kind");
    selection(severity, ["low", "medium", "high", "critical"], "severity");
    text(summary, "summary", 500);
    return tenant(this.client, this.ctx, async tx => {
      const incident = rows(await tx.query("INSERT INTO app.incidents(organization_id,kind,severity,summary,opened_by_membership_id) VALUES($1,$2,$3,$4,$5) RETURNING *", [this.ctx.organizationId, kind, severity, summary.trim(), this.ctx.membershipId]))[0]!;
      await event(tx, this.ctx, "incident.opened", incident.id, { kind, severity });
      return incident;
    });
  }
  record(incidentId: string, step: string, outcome: "passed" | "failed" | "info", evidence: Record<string, unknown> = {}) {
    identifier(incidentId);
    if (!/^[a-z][a-z0-9_.]{2,79}$/.test(step)) return fail("INVALID_STEP", 400);
    selection(outcome, ["passed", "failed", "info"], "outcome");
    return tenant(this.client, this.ctx, async tx => {
      const saved = rows(await tx.query("INSERT INTO app.incident_events(organization_id,incident_id,step,outcome,evidence) SELECT $1::app.entity_id,id,$3,$4,$5::jsonb FROM app.incidents WHERE organization_id=$1 AND id=$2 RETURNING id", [this.ctx.organizationId, incidentId, step, outcome, JSON.stringify(evidence)]));
      if (!saved.length) return fail("NOT_FOUND", 404);
    });
  }
  transition(incidentId: string, state: "mitigated" | "resolved", version: number) {
    identifier(incidentId);
    selection(state, ["mitigated", "resolved"], "state");
    return tenant(this.client, this.ctx, async tx => {
      const result = rows(await tx.query("UPDATE app.incidents SET state=$3,resolved_at=CASE WHEN $3='resolved' THEN app.utc_now() ELSE NULL END,version=version+1 WHERE organization_id=$1 AND id=$2 AND version=$4 AND state<>'resolved' RETURNING *", [this.ctx.organizationId, incidentId, state, version]))[0];
      if (!result) return fail("STALE_RECORD");
      await event(tx, this.ctx, `incident.${state}`, incidentId);
      return result;
    });
  }
  list(limit = 50) {
    return tenant(this.client, this.ctx, async tx => {
      const incidents = rows(await tx.query("SELECT * FROM app.incidents WHERE organization_id=$1 ORDER BY opened_at DESC LIMIT $2", [this.ctx.organizationId, Math.min(Math.max(limit, 1), 200)]));
      const steps = incidents.length ? rows(await tx.query("SELECT * FROM app.incident_events WHERE organization_id=$1 AND incident_id = ANY($2::uuid[]) ORDER BY recorded_at", [this.ctx.organizationId, incidents.map(i => i.id)])) : [];
      return incidents.map(incident => ({ ...incident, steps: steps.filter(step => step.incident_id === incident.id) }));
    });
  }
}

/**
 * Pause-all drill (DOTS-155): pauses the workspace, proves a worker cannot claim queued work and that a
 * prior exact-content approval cannot be consumed while paused, records each step, then restores the
 * owner's previous pause state. Uses only the real queue and approval tables; no provider is called.
 */
export async function runKillSwitchDrill(client: Client, ctx: Context): Promise<{ incidentId: string; passed: boolean; steps: { step: string; outcome: string }[] }> {
  const control = new ControlPlane(client, ctx), log = new IncidentLog(client, ctx);
  await control.initialize();
  const prior = await tenant(client, ctx, async tx => Boolean(rows(await tx.query("SELECT paused FROM app.policy_controls WHERE organization_id=$1", [ctx.organizationId]))[0]?.paused));
  const incident = await log.open("kill_switch_drill", "low", "Scheduled pause-all drill");
  const steps: { step: string; outcome: "passed" | "failed" }[] = [];
  const check = async (step: string, ok: boolean, evidence: Record<string, unknown>) => { steps.push({ step, outcome: ok ? "passed" : "failed" }); await log.record(incident.id, step, ok ? "passed" : "failed", evidence); };
  try {
    await control.pause(true);
    const paused = await tenant(client, ctx, async tx => rows(await tx.query("SELECT paused FROM app.policy_controls WHERE organization_id=$1", [ctx.organizationId]))[0]?.paused === true);
    await check("drill.pause_applied", paused, { paused });
    const claim = await new DurableQueue(client, ctx, `drill-${randomBytes(4).toString("hex")}`).claim();
    await check("drill.claim_blocked", claim === null, { claimedTaskId: claim?.id ?? null });
    const probe = { drill: incident.id };
    const approval = (await control.requestApproval("provider_activation", incident.id, probe))!;
    await control.decideApproval(approval.id, true);
    let consumed = true;
    try { await tenant(client, ctx, tx => control.consumeApproval(tx, approval.id, "provider_activation", incident.id, probe)); } catch { consumed = false; }
    await check("drill.approval_dispatch_blocked", !consumed, { approvalId: approval.id });
  } finally {
    await control.pause(prior);
    await log.record(incident.id, "drill.state_restored", "info", { paused: prior });
  }
  const passed = steps.every(step => step.outcome === "passed");
  const current = await tenant(client, ctx, async tx => rows(await tx.query("SELECT version FROM app.incidents WHERE organization_id=$1 AND id=$2", [ctx.organizationId, incident.id]))[0]!);
  await log.transition(incident.id, "resolved", Number(current.version));
  return { incidentId: incident.id, passed, steps };
}

/** Read-only Boardroom/Engine Room interoperability (DOTS-159). Tokens are `<organizationId>.<secret>` and stored hashed. */
export class PortfolioAccess {
  constructor(private readonly client: Client, private readonly ctx: Context) {}
  issue(label: string, days = 90) {
    text(label, "label", 120);
    if (!Number.isSafeInteger(days) || days < 1 || days > 365) return fail("INVALID_TOKEN_LIFETIME", 400);
    const secret = randomBytes(32).toString("base64url"), token = `${this.ctx.organizationId}.${secret}`;
    return tenant(this.client, this.ctx, async tx => {
      const saved = rows(await tx.query("INSERT INTO app.portfolio_access_tokens(organization_id,label,token_hash,created_by_membership_id,expires_at) VALUES($1,$2,$3,$4,app.utc_now()+make_interval(days=>$5)) RETURNING id,label,expires_at,created_at", [this.ctx.organizationId, label.trim(), sha256(token), this.ctx.membershipId, days]))[0]!;
      await event(tx, this.ctx, "portfolio.token_issued", saved.id, { days });
      return { ...saved, token };
    });
  }
  revoke(id: string) {
    identifier(id);
    return tenant(this.client, this.ctx, async tx => {
      const result = rows(await tx.query("UPDATE app.portfolio_access_tokens SET revoked_at=app.utc_now() WHERE organization_id=$1 AND id=$2 AND revoked_at IS NULL RETURNING id", [this.ctx.organizationId, id]));
      if (!result.length) return fail("NOT_FOUND", 404);
      await event(tx, this.ctx, "portfolio.token_revoked", id);
    });
  }
  list() {
    return tenant(this.client, this.ctx, async tx => rows(await tx.query("SELECT id,label,scopes,created_at,expires_at,revoked_at,last_used_at FROM app.portfolio_access_tokens WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 50", [this.ctx.organizationId])));
  }
}

/**
 * Validates a bearer token without an owner session and returns aggregate, non-personal summaries only.
 * The caller supplies a client already restricted to the runtime role; tenant context comes from the token
 * prefix and is then proven by a constant-time hash comparison inside that tenant's row-level security scope.
 */
/** Validates the bearer token's shape without touching the database, so malformed or anonymous requests never wake it. */
export function portfolioBearer(bearer: string | null): { token: string; organizationId: string } {
  const token = bearer?.startsWith("Bearer ") ? bearer.slice(7).trim() : "";
  const match = token.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/i);
  if (!match) return fail("PORTFOLIO_TOKEN_INVALID", 401);
  return { token, organizationId: match[1]!.toLowerCase() };
}
export async function portfolioSummary(client: Client, bearer: string | null, now = new Date()) {
  const { token, organizationId } = portfolioBearer(bearer);
  return withTransaction(client, async tx => {
    await tx.query("SELECT set_config('app.organization_id',$1,true)", [organizationId]);
    const record = rows(await tx.query("SELECT id,token_hash FROM app.portfolio_access_tokens WHERE organization_id=$1 AND token_hash=$2 AND revoked_at IS NULL AND expires_at > $3::timestamptz", [organizationId, sha256(token), now.toISOString()]))[0];
    if (!record || !timingSafeEqual(Buffer.from(record.token_hash, "hex"), Buffer.from(sha256(token), "hex"))) return fail("PORTFOLIO_TOKEN_INVALID", 401);
    await tx.query("UPDATE app.portfolio_access_tokens SET last_used_at=$3::timestamptz WHERE organization_id=$1 AND id=$2", [organizationId, record.id, now.toISOString()]);
    const q = async (sql: string) => rows(await tx.query(sql, [organizationId]));
    const projects = await q("SELECT id,label,content->>'category' AS category,updated_at FROM app.projects WHERE organization_id=$1 AND status='active' ORDER BY created_at LIMIT 200");
    const agents = (await q("SELECT count(*) FILTER (WHERE status='active')::int AS active,count(*)::int AS total FROM app.agent_identities WHERE organization_id=$1 AND status<>'archived'"))[0]!;
    const campaigns = await q("SELECT project_id,state,count(*)::int AS total FROM app.campaigns WHERE organization_id=$1 GROUP BY project_id,state");
    const deals = await q("SELECT project_id,count(*) FILTER (WHERE stage NOT IN ('won','lost'))::int AS open_deals,COALESCE(sum(value_cents) FILTER (WHERE stage NOT IN ('won','lost')),0)::text AS open_pipeline_cents FROM app.deals WHERE organization_id=$1 GROUP BY project_id");
    const money = await q("SELECT project_id,COALESCE(sum(amount_cents) FILTER (WHERE kind='sale_receipt'),0)::text AS sales_cents,COALESCE(sum(amount_cents) FILTER (WHERE kind IN ('grant_disbursement','investment_receipt')),0)::text AS funding_cents,COALESCE(sum(amount_cents) FILTER (WHERE kind='refund'),0)::text AS refunds_cents,COALESCE(sum(amount_cents) FILTER (WHERE kind='expense'),0)::text AS costs_cents FROM app.money_entries WHERE organization_id=$1 AND source='provider' GROUP BY project_id");
    const incidents = (await q("SELECT count(*) FILTER (WHERE state<>'resolved')::int AS open FROM app.incidents WHERE organization_id=$1"))[0]!;
    const events = await q("SELECT event_type,occurred_at FROM app.operation_events WHERE organization_id=$1 AND event_type IN ('campaign.activated','campaign.paused','invoice.paid','funding.stage_changed','runtime.paused','runtime.resumed','incident.opened','incident.resolved') ORDER BY occurred_at DESC LIMIT 25");
    const byProject = (list: Row[], id: string) => list.filter(row => row.project_id === id);
    return {
      contract: PORTFOLIO_CONTRACT_VERSION, organizationId, observedAt: now.toISOString(), access: "read-only",
      agents: { active: agents.active, total: agents.total },
      projects: projects.map(project => {
        const m = byProject(money, project.id)[0], d = byProject(deals, project.id)[0];
        return { id: project.id, label: project.label, category: project.category ?? null, updatedAt: project.updated_at,
          campaigns: Object.fromEntries(byProject(campaigns, project.id).map(row => [row.state, row.total])),
          pipeline: { openDeals: d?.open_deals ?? 0, openPipelineCents: d?.open_pipeline_cents ?? "0", label: "estimate, not cash" },
          verifiedCash: { salesCents: m?.sales_cents ?? "0", fundingCents: m?.funding_cents ?? "0", refundsCents: m?.refunds_cents ?? "0", costsCents: m?.costs_cents ?? "0", source: "provider receipts only" } };
      }),
      openIncidents: incidents.open,
      recentEvents: events.map(item => ({ type: item.event_type, occurredAt: item.occurred_at })),
    };
  });
}

/**
 * Commercial tenant provisioning (DOTS-158). Runs only with an administrative client in a script, never in
 * the web runtime. A new tenant starts paused, with $0 budget, outbound and models disabled, and no agents,
 * contacts, keys or owner data. Gated behind COMMERCIAL_SIGNUP_ENABLED until the owner commercializes.
 */
export async function provisionTenant(adminClient: Client, input: { slug: string; displayName: string; ownerSubject: string; ownerName: string }, environment: Record<string, string | undefined> = process.env) {
  if (environment.COMMERCIAL_SIGNUP_ENABLED !== "true") return fail("COMMERCIAL_ONBOARDING_NOT_AUTHORIZED", 403);
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(input.slug)) return fail("INVALID_SLUG", 400);
  text(input.displayName, "display_name", 120); text(input.ownerSubject, "owner_subject", 200); text(input.ownerName, "owner_name", 120);
  return withTransaction(adminClient, async tx => {
    const organization = rows(await tx.query("INSERT INTO app.organizations(slug,display_name) VALUES($1,$2) RETURNING id", [input.slug, input.displayName.trim()]))[0]!;
    const user = rows(await tx.query("INSERT INTO app.owner_users(identity_subject,display_name) VALUES($1,$2) ON CONFLICT(identity_subject) DO UPDATE SET updated_at=app.owner_users.updated_at RETURNING id", [input.ownerSubject.trim(), input.ownerName.trim()]))[0]!;
    const membership = rows(await tx.query("SELECT app.new_id() AS id"))[0]!.id as string;
    await tx.query("SELECT set_config('app.organization_id',$1,true),set_config('app.audit_actor_membership_id',$2,true)", [organization.id, membership]);
    await tx.query("INSERT INTO app.memberships(id,organization_id,user_id,role) VALUES($1,$2,$3,'owner')", [membership, organization.id, user.id]);
    await tx.query("INSERT INTO app.policy_controls(organization_id,updated_by_membership_id,paused,model_enabled,outbound_enabled) VALUES($1,$2,true,false,false)", [organization.id, membership]);
    await tx.query("INSERT INTO app.spending_policies(organization_id,updated_by_membership_id,limit_cents) VALUES($1,$2,0)", [organization.id, membership]);
    await tx.query("INSERT INTO app.operation_events(organization_id,actor_kind,actor_id,event_type,details) VALUES($1,'human',$2,'tenant.provisioned',$3::jsonb)", [organization.id, membership, JSON.stringify({ agents: 0, budgetCents: 0 })]);
    return { organizationId: organization.id as string, membershipId: membership };
  });
}

/** SSRF guard (DOTS-145): outbound integrations may only reach these fixed HTTPS hosts. */
export const OUTBOUND_HOST_ALLOWLIST = Object.freeze(["api.openai.com", "api.anthropic.com", "api.x.ai", "openrouter.ai", "api.resend.com", "api.stripe.com", "api.grants.gov"]);
export function assertAllowedOutbound(url: string): URL {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return fail("OUTBOUND_URL_INVALID", 400); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port || !OUTBOUND_HOST_ALLOWLIST.includes(parsed.hostname)) return fail("OUTBOUND_HOST_NOT_ALLOWED", 403);
  return parsed;
}

/** Fair-share admission (DOTS-156): bounded tenant concurrency and queue depth, computed from persisted queue state. */
export async function admissionDecision(client: Client, ctx: Context, limits = { maxRunning: 2, maxQueued: 500 }) {
  return tenant(client, ctx, async tx => {
    const state = rows(await tx.query("SELECT count(*) FILTER (WHERE state='running' AND lease_expires_at>app.utc_now())::int AS running,count(*) FILTER (WHERE state IN ('queued','waiting'))::int AS queued FROM app.task_queue WHERE organization_id=$1", [ctx.organizationId]))[0]!;
    if (Number(state.queued) >= limits.maxQueued) return { admit: false, reason: "TENANT_QUEUE_BACKPRESSURE", ...state };
    if (Number(state.running) >= limits.maxRunning) return { admit: false, reason: "TENANT_CONCURRENCY_LIMIT", ...state };
    return { admit: true, reason: "OK", ...state };
  });
}
