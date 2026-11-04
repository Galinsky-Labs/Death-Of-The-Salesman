import { Pool, type PoolClient } from "pg";
import { AgentProjectAssignmentRepository, AssignmentWriteError, ProjectBucketRepository, withTransaction, type TransactionClient } from "@dots/database";
import type { SessionRecord, SessionStore } from "@dots/auth";
import type { AssignmentInput, DeploymentDependencies, DeploymentSnapshot, DeploymentStore, Owner } from "./deployment.js";

// Every transaction is pinned to one checked-out connection; no shared BEGIN/COMMIT.
const adapter = (client: PoolClient): TransactionClient => ({ query: (sql, values) => client.query(sql, values ? [...values] : undefined) });
export function deploymentDependencies(pool: Pool, organizationId: string): DeploymentDependencies {
  const tenant = async <T>(operation: (client: PoolClient) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try { return await withTransaction(adapter(client), async tx => { await tx.query("SELECT set_config('app.organization_id', $1, true)", [organizationId]); return operation(client); }); }
    finally { client.release(); }
  };
  const sessions: SessionStore = {
    create: async () => { throw new Error("Use the configured OIDC session issuer"); },
    findByTokenHash: async hash => tenant(async client => {
      const result = await client.query(`SELECT s.*, m.role FROM app.owner_sessions s JOIN app.memberships m ON m.organization_id = s.organization_id AND m.id = s.membership_id AND m.user_id = s.user_id WHERE s.organization_id = $1 AND s.token_hash = decode($2, 'hex') AND m.status = 'active'`, [organizationId, hash]);
      const row = result.rows[0];
      if (!row) return undefined;
      return { id: row.id, organizationId: row.organization_id, userId: row.user_id, membershipId: row.membership_id, role: row.role, tokenHash: Buffer.from(row.token_hash).toString("hex"), csrfHash: Buffer.from(row.csrf_hash).toString("hex"), createdAt: row.created_at, lastSeenAt: row.last_seen_at, expiresAt: row.expires_at, idleExpiresAt: row.idle_expires_at, idleTimeoutSeconds: row.idle_timeout_seconds, ...(row.mfa_verified_at ? { mfaVerifiedAt: row.mfa_verified_at } : {}), ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}) } as SessionRecord;
    }),
    touch: async (id, lastSeenAt, idleExpiresAt) => tenant(async client => { await client.query("UPDATE app.owner_sessions SET last_seen_at = $3, idle_expires_at = $4 WHERE organization_id = $1 AND id = $2 AND revoked_at IS NULL", [organizationId, id, lastSeenAt, idleExpiresAt]); }),
  };
  const withClient = async <T>(operation: (client: TransactionClient) => Promise<T>): Promise<T> => { const client = await pool.connect(); try { return await operation(adapter(client)); } finally { client.release(); } };
  const store: DeploymentStore = {
    snapshot: async owner => {
      const snapshot = await tenant(async client => {
        const member = await client.query("SELECT id FROM app.memberships WHERE organization_id=$1 AND id=$2 AND role='owner' AND status='active'", [owner.organizationId, owner.membershipId]);
        if (!member.rowCount) throw new AssignmentWriteError("NOT_FOUND_OR_STALE");
        const agents = await client.query("SELECT id, display_name, status FROM app.agent_identities WHERE organization_id=$1 AND status <> 'archived' ORDER BY display_name, id", [owner.organizationId]);
        const buckets = await client.query(`SELECT b.id, b.project_id, b.campaign_id, b.label, COALESCE(p.visible,true) visible, COALESCE(p.display_position,b.default_position) position, p.version FROM app.project_buckets b JOIN app.projects project ON project.organization_id=b.organization_id AND project.id=b.project_id AND project.status='active' LEFT JOIN app.project_bucket_preferences p ON p.organization_id=b.organization_id AND p.bucket_id=b.id AND p.owner_membership_id=$2 WHERE b.organization_id=$1 ORDER BY position,b.id`, [owner.organizationId, owner.membershipId]);
        const assignments = await client.query("SELECT id, agent_identity_id, project_id, campaign_id, priority, allocation_basis_points, quota_limit, concurrency_cap, version, updated_at FROM app.agent_project_assignments WHERE organization_id=$1 ORDER BY id", [owner.organizationId]);
        return { agents: agents.rows.map(r => ({ id: r.id, displayName: r.display_name, status: r.status })), buckets: buckets.rows.map(r => ({ id: r.id, projectId: r.project_id, campaignId: r.campaign_id, label: r.label, visible: r.visible, position: Number(r.position), preferenceVersion: r.version === null ? null : Number(r.version) })), assignments: assignments.rows.map(r => ({ id: r.id, organizationId: owner.organizationId, agentIdentityId: r.agent_identity_id, projectId: r.project_id, campaignId: r.campaign_id, priority: r.priority, allocationBasisPoints: r.allocation_basis_points, quotaLimit: Number(r.quota_limit), concurrencyCap: r.concurrency_cap, version: Number(r.version), updatedAt: r.updated_at.toISOString() })) } satisfies DeploymentSnapshot;
      });
      return snapshot;
    },
    save: async (owner: Owner, input: AssignmentInput) => {
      // Resolve the checked bucket on the server. Browser project/campaign claims are rejected.
      const buckets = await withClient(client => new ProjectBucketRepository(client).listForOwner({ organizationId: owner.organizationId, ownerMembershipId: owner.membershipId }));
      const bucket = buckets.find(b => b.id === input.bucketId && b.visible);
      if (!bucket) throw new AssignmentWriteError("NOT_FOUND_OR_STALE");
      return withClient(client => new AgentProjectAssignmentRepository(client).save({ ...(input.id ? { id: input.id } : {}), organizationId: owner.organizationId, ownerMembershipId: owner.membershipId, agentIdentityId: input.agentIdentityId, projectId: bucket.projectId, campaignId: bucket.campaignId, bucketId: bucket.id, priority: input.priority, allocationBasisPoints: input.allocationBasisPoints, quotaLimit: input.quotaLimit, concurrencyCap: input.concurrencyCap, expectedVersion: input.expectedVersion }));
    },
    preference: (owner, input) => withClient(async client => { await new ProjectBucketRepository(client).savePreference({ organizationId: owner.organizationId, ownerMembershipId: owner.membershipId, ...input }); }),
  };
  return { sessions, store };
}
