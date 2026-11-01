import { withTransaction, type TransactionClient } from "./index.js";
export type AuditContext = { organizationId: string; membershipId: string; correlationId: string; policyVersion: string };
export type AuditEvidence = { recordId?: string; recordType?: string; operation?: string; version?: number; status?: string; changedFields?: readonly string[]; reasonCode?: string; evidenceHashes?: readonly string[] };
export type AuditEvent = { id: string; organizationId: string; actorMembershipId: string; actorUserId: string; actorRole: string; eventType: string; policyVersion: string; correlationId: string; evidence: AuditEvidence; occurredAt: string; entryHash: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const result = (value: unknown) => value as { rows: Record<string, unknown>[] };
// Call inside a checked-out connection's transaction, after authenticating the actor.
// The database independently rechecks active same-tenant owner/admin membership.
export async function setAuditContext(tx: TransactionClient, context: AuditContext): Promise<void> {
  if (![context.organizationId, context.membershipId, context.correlationId].every(x => uuid.test(x)) || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,119}$/.test(context.policyVersion)) throw new Error("Invalid audit context");
  await tx.query("SELECT set_config('app.organization_id',$1,true), set_config('app.audit_actor_membership_id',$2,true), set_config('app.audit_correlation_id',$3,true), set_config('app.audit_policy_version',$4,true)", [context.organizationId, context.membershipId, context.correlationId, context.policyVersion]);
}
const map = (row: Record<string, unknown>): AuditEvent => ({ id: String(row.id), organizationId: String(row.organization_id), actorMembershipId: String(row.actor_membership_id), actorUserId: String(row.actor_user_id), actorRole: String(row.actor_role), eventType: String(row.event_type), policyVersion: String(row.policy_version), correlationId: String(row.correlation_id), evidence: row.evidence as AuditEvidence, occurredAt: String(row.occurred_at_exact), entryHash: String(row.entry_hash) });
export class AuditEventRepository {
  constructor(private readonly client: TransactionClient) {}
  async append(context: AuditContext, eventType: string, evidence: AuditEvidence): Promise<AuditEvent> {
    if (!/^[a-z][a-z0-9_.]{2,119}$/.test(eventType)) throw new Error("Invalid audit event type");
    return withTransaction(this.client, async tx => {
      await setAuditContext(tx, context);
      const actor = result(await tx.query("SELECT id FROM app.memberships WHERE organization_id=$1 AND id=$2 AND status='active' AND role IN ('owner','admin')", [context.organizationId, context.membershipId]));
      if (!actor.rows.length) throw new Error("Audit append is not authorized");
      const r = result(await tx.query(`INSERT INTO app.audit_events(organization_id,actor_type,actor_membership_id,actor_user_id,actor_role,event_type,policy_version,correlation_id,evidence,entry_hash)
        VALUES($1,'human',$2,$2,'owner',$3,$4,$5,$6::jsonb,'') RETURNING *,to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at_exact`, [context.organizationId, context.membershipId, eventType, context.policyVersion, context.correlationId, JSON.stringify(evidence)]));
      if (!r.rows[0]) throw new Error("Audit append was not confirmed");
      return map(r.rows[0]);
    });
  }
  async list(input: { organizationId: string; membershipId: string; before?: { occurredAt: string; id: string }; limit?: number }): Promise<AuditEvent[]> {
    const limit = input.limit ?? 50;
    if (!uuid.test(input.organizationId) || !uuid.test(input.membershipId) || !Number.isSafeInteger(limit) || limit < 1 || limit > 200 || (input.before && (!uuid.test(input.before.id) || Number.isNaN(Date.parse(input.before.occurredAt))))) throw new Error("Invalid audit query");
    return withTransaction(this.client, async tx => {
      await tx.query("SELECT set_config('app.organization_id',$1,true)", [input.organizationId]);
      const actor = result(await tx.query("SELECT id FROM app.memberships WHERE organization_id=$1 AND id=$2 AND status='active' AND role IN ('owner','admin')", [input.organizationId, input.membershipId]));
      if (!actor.rows.length) throw new Error("Audit read is not authorized");
      const r = result(await tx.query(`SELECT e.*,to_char(e.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at_exact, app.audit_entry_hash(e)=e.entry_hash AS hash_valid
        FROM app.audit_events e WHERE organization_id=$1 AND ($2::timestamptz IS NULL OR (occurred_at,id)<($2::timestamptz,$3::uuid)) ORDER BY occurred_at DESC,id DESC LIMIT $4`, [input.organizationId, input.before?.occurredAt ?? null, input.before?.id ?? null, limit]));
      if (r.rows.some(row => row.hash_valid !== true)) throw new Error("Audit integrity verification failed");
      return r.rows.map(map);
    });
  }
}
