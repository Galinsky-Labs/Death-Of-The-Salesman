import { randomUUID } from "node:crypto";
import { withTransaction, type TransactionClient } from "./index.js";

export type AgentProjectAssignment = {
  id: string;
  organizationId: string;
  agentIdentityId: string;
  projectId: string;
  campaignId: string | null;
  priority: number;
  allocationBasisPoints: number;
  quotaLimit: number;
  concurrencyCap: number;
  version: number;
  updatedAt: string;
};

export type AssignmentWriteErrorCode =
  | "NOT_FOUND_OR_STALE"
  | "ALLOCATION_EXCEEDED"
  | "TARGET_CONFLICT";

export class AssignmentWriteError extends Error {
  readonly code: AssignmentWriteErrorCode;
  readonly retryable: boolean;

  constructor(code: AssignmentWriteErrorCode) {
    super(code);
    this.code = code;
    this.retryable = code === "NOT_FOUND_OR_STALE";
    this.name = "AssignmentWriteError";
  }
}

type QueryResult = { rows?: unknown[] };

const resultOf = (value: unknown): QueryResult =>
  typeof value === "object" && value !== null ? value as QueryResult : {};

const boundedInteger = (value: number, field: string, minimum: number, maximum: number): number => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${field} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
};

const assignmentOf = (value: unknown): AgentProjectAssignment => {
  if (typeof value !== "object" || value === null) throw new Error("assignment query returned no row");
  const row = value as Record<string, unknown>;
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    agentIdentityId: String(row.agent_identity_id),
    projectId: String(row.project_id),
    campaignId: row.campaign_id === null || row.campaign_id === undefined ? null : String(row.campaign_id),
    priority: Number(row.priority),
    allocationBasisPoints: Number(row.allocation_basis_points),
    quotaLimit: Number(row.quota_limit),
    concurrencyCap: Number(row.concurrency_cap),
    version: Number(row.version),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
};

const returningColumns =
  "id, organization_id, agent_identity_id, project_id, campaign_id, priority, " +
  "allocation_basis_points, quota_limit, concurrency_cap, version, updated_at";

export class AgentProjectAssignmentRepository {
  private readonly client: TransactionClient;

  constructor(client: TransactionClient) {
    this.client = client;
  }

  private async inTenant<T>(
    organizationId: string,
    operation: (tx: TransactionClient) => Promise<T>,
  ): Promise<T> {
    return withTransaction(this.client, async (tx) => {
      await tx.query("SELECT set_config('app.organization_id', $1, true)", [organizationId]);
      return operation(tx);
    });
  }

  async save(input: {
    id?: string;
    organizationId: string;
    ownerMembershipId: string;
    agentIdentityId: string;
    projectId: string;
    campaignId?: string | null;
    priority: number;
    allocationBasisPoints: number;
    quotaLimit: number;
    concurrencyCap: number;
    expectedVersion: number | null;
  }): Promise<AgentProjectAssignment> {
    const priority = boundedInteger(input.priority, "priority", 0, 100);
    const allocation = boundedInteger(input.allocationBasisPoints, "allocationBasisPoints", 1, 10_000);
    const quota = boundedInteger(input.quotaLimit, "quotaLimit", 1, Number.MAX_SAFE_INTEGER);
    const concurrency = boundedInteger(input.concurrencyCap, "concurrencyCap", 1, 1_000);
    const id = input.id ?? randomUUID();
    if ((input.id === undefined) !== (input.expectedVersion === null)) {
      throw new Error("new assignments require a null version; updates require an id and version");
    }
    if (input.expectedVersion !== null) {
      boundedInteger(input.expectedVersion, "expectedVersion", 1, Number.MAX_SAFE_INTEGER);
    }

    return this.inTenant(input.organizationId, async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `dots-assignment:${input.organizationId}:${input.agentIdentityId}`,
      ]);
      const authority = resultOf(await tx.query(
        `SELECT identities.id
         FROM app.memberships
         JOIN app.agent_identities AS identities
           ON identities.organization_id = memberships.organization_id
           AND identities.id = $3
           AND identities.status = 'active'
         JOIN app.projects
           ON projects.organization_id = memberships.organization_id
           AND projects.id = $4
           AND projects.status = 'active'
         WHERE memberships.organization_id = $1
           AND memberships.id = $2
           AND memberships.role = 'owner'
           AND memberships.status = 'active'
         FOR UPDATE OF projects`,
        [input.organizationId, input.ownerMembershipId, input.agentIdentityId, input.projectId],
      ));
      if (!authority.rows?.[0]) throw new AssignmentWriteError("NOT_FOUND_OR_STALE");

      const allocated = resultOf(await tx.query(
        `SELECT COALESCE(SUM(allocation_basis_points), 0) AS allocated
         FROM app.agent_project_assignments
         WHERE organization_id = $1
           AND agent_identity_id = $2
           AND id <> $3`,
        [input.organizationId, input.agentIdentityId, id],
      ));
      const currentAllocation = Number(
        (allocated.rows?.[0] as Record<string, unknown> | undefined)?.allocated ?? 0,
      );
      if (!Number.isSafeInteger(currentAllocation) || currentAllocation + allocation > 10_000) {
        throw new AssignmentWriteError("ALLOCATION_EXCEEDED");
      }

      const values = [
        id, input.organizationId, input.agentIdentityId, input.projectId,
        input.campaignId ?? null, priority, allocation, quota, concurrency,
        input.ownerMembershipId,
      ] as const;
      if (input.expectedVersion === null) {
        const created = resultOf(await tx.query(
          `INSERT INTO app.agent_project_assignments (
            id, organization_id, agent_identity_id, project_id, campaign_id,
            priority, allocation_basis_points, quota_limit, concurrency_cap,
            updated_by_membership_id
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          ON CONFLICT DO NOTHING
          RETURNING ${returningColumns}`,
          values,
        ));
        if (!created.rows?.[0]) throw new AssignmentWriteError("TARGET_CONFLICT");
        return assignmentOf(created.rows[0]);
      }

      const updated = resultOf(await tx.query(
        `UPDATE app.agent_project_assignments
         SET project_id = $4, campaign_id = $5, priority = $6,
             allocation_basis_points = $7, quota_limit = $8,
             concurrency_cap = $9, updated_by_membership_id = $10,
             version = version + 1, updated_at = app.utc_now()
         WHERE id = $1 AND organization_id = $2
           AND agent_identity_id = $3 AND version = $11
         RETURNING ${returningColumns}`,
        [...values, input.expectedVersion],
      ));
      if (!updated.rows?.[0]) throw new AssignmentWriteError("NOT_FOUND_OR_STALE");
      return assignmentOf(updated.rows[0]);
    });
  }

  async listForAgent(input: {
    organizationId: string;
    ownerMembershipId: string;
    agentIdentityId: string;
  }): Promise<AgentProjectAssignment[]> {
    return this.inTenant(input.organizationId, async (tx) => {
      const result = resultOf(await tx.query(
        `SELECT assignments.${returningColumns.replaceAll(", ", ", assignments.")}
         FROM app.memberships
         JOIN app.agent_project_assignments AS assignments
           ON assignments.organization_id = memberships.organization_id
         WHERE memberships.organization_id = $1
           AND memberships.id = $2
           AND memberships.role = 'owner'
           AND memberships.status = 'active'
           AND assignments.agent_identity_id = $3
         ORDER BY assignments.priority DESC, assignments.created_at, assignments.id`,
        [input.organizationId, input.ownerMembershipId, input.agentIdentityId],
      ));
      return (result.rows ?? []).map(assignmentOf);
    });
  }
}
