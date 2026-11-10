import { randomUUID } from "node:crypto";
import { withTransaction, type TransactionClient } from "./index.js";

export type AgentIdentityStatus = "inactive" | "active" | "archived";

export type AgentIdentity = {
  id: string;
  organizationId: string;
  approvedNameId: number;
  approvedName: string;
  displayName: string;
  status: AgentIdentityStatus;
  version: number;
  updatedAt: string;
};

export class AgentIdentityWriteError extends Error {
  readonly code: "NOT_FOUND_OR_STALE" | "NAME_NOT_APPROVED";

  constructor(code: "NOT_FOUND_OR_STALE" | "NAME_NOT_APPROVED") {
    super(code);
    this.code = code;
    this.name = "AgentIdentityWriteError";
  }
}

type QueryResult = { rows?: unknown[] };

const resultOf = (value: unknown): QueryResult =>
  typeof value === "object" && value !== null ? (value as QueryResult) : {};

const identityOf = (value: unknown): AgentIdentity => {
  if (typeof value !== "object" || value === null) throw new Error("agent identity query returned no row");
  const row = value as Record<string, unknown>;
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    approvedNameId: Number(row.approved_name_id),
    approvedName: String(row.approved_name),
    displayName: String(row.display_name),
    status: row.status as AgentIdentityStatus,
    version: Number(row.version),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
};

const displayNameOf = (value: string): string => {
  const displayName = value.trim();
  if (!displayName || displayName.length > 120) {
    throw new Error("displayName must contain 1 to 120 characters");
  }
  return displayName;
};

const initialDemoIdentities = [
  { approvedName: '"Fast Eddie" Felson', displayName: "Fast Eddie Felson" },
  { approvedName: "Harry Wormwood", displayName: "Harry Wormwood" },
] as const;

export class AgentIdentityRepository {
  private readonly client: TransactionClient;
  private readonly approvedNames: readonly string[];

  constructor(client: TransactionClient, approvedNames: readonly string[]) {
    if (approvedNames.length !== 264 || new Set(approvedNames).size !== 264) {
      throw new Error("approved name catalog must contain exactly 264 unique names");
    }
    if (approvedNames.some((name) => !name.trim())) throw new Error("approved names must be non-empty");
    for (const initial of initialDemoIdentities) {
      if (!approvedNames.includes(initial.approvedName)) throw new Error("initial demo identity is not approved");
    }
    this.client = client;
    this.approvedNames = approvedNames;
  }

  private approvedNameId(name: string): number {
    const index = this.approvedNames.indexOf(name);
    if (index < 0) throw new AgentIdentityWriteError("NAME_NOT_APPROVED");
    return index + 1;
  }

  private async inTenant<T>(organizationId: string, operation: (tx: TransactionClient) => Promise<T>): Promise<T> {
    return withTransaction(this.client, async (tx) => {
      await tx.query("SELECT set_config('app.organization_id', $1, true)", [organizationId]);
      return operation(tx);
    });
  }

  async create(input: {
    organizationId: string;
    ownerMembershipId: string;
    approvedName: string;
    displayName?: string;
  }): Promise<AgentIdentity> {
    const approvedNameId = this.approvedNameId(input.approvedName);
    const displayName = displayNameOf(input.displayName ?? input.approvedName.replaceAll('"', ""));
    return this.inTenant(input.organizationId, async (tx) => {
      const result = resultOf(await tx.query(
        `INSERT INTO app.agent_identities (
          id, organization_id, approved_name_id, display_name, updated_by_membership_id
        )
        SELECT $1::app.entity_id, $2::app.entity_id, names.id, $5, memberships.id
        FROM app.approved_agent_names AS names
        JOIN app.memberships ON memberships.id = $6
          AND memberships.organization_id = $2
          AND memberships.role = 'owner'
          AND memberships.status = 'active'
        WHERE names.id = $3 AND names.name = $4
        RETURNING id, organization_id, approved_name_id,
          (SELECT name FROM app.approved_agent_names WHERE id = approved_name_id) AS approved_name,
          display_name, status, version, updated_at`,
        [randomUUID(), input.organizationId, approvedNameId, input.approvedName, displayName, input.ownerMembershipId],
      ));
      const row = result.rows?.[0];
      if (!row) throw new AgentIdentityWriteError("NOT_FOUND_OR_STALE");
      return identityOf(row);
    });
  }

  async list(input: { organizationId: string; ownerMembershipId: string }): Promise<AgentIdentity[]> {
    return this.inTenant(input.organizationId, async (tx) => {
      const result = resultOf(await tx.query(
        `SELECT identities.id, identities.organization_id, identities.approved_name_id,
          names.name AS approved_name, identities.display_name, identities.status,
          identities.version, identities.updated_at
        FROM app.memberships
        JOIN app.agent_identities AS identities
          ON identities.organization_id = memberships.organization_id
        JOIN app.approved_agent_names AS names ON names.id = identities.approved_name_id
        WHERE memberships.id = $2
          AND memberships.organization_id = $1
          AND memberships.role = 'owner'
          AND memberships.status = 'active'
        ORDER BY identities.created_at, identities.id`,
        [input.organizationId, input.ownerMembershipId],
      ));
      return (result.rows ?? []).map(identityOf);
    });
  }

  async update(input: {
    organizationId: string;
    ownerMembershipId: string;
    id: string;
    expectedVersion: number;
    displayName: string;
    status: Exclude<AgentIdentityStatus, "archived">;
  }): Promise<AgentIdentity> {
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw new Error("expectedVersion must be a positive safe integer");
    }
    const displayName = displayNameOf(input.displayName);
    return this.inTenant(input.organizationId, async (tx) => {
      const result = resultOf(await tx.query(
        `UPDATE app.agent_identities AS identity
         SET display_name = $4, status = $5, version = identity.version + 1,
             updated_by_membership_id = memberships.id, updated_at = app.utc_now()
         FROM app.memberships, app.approved_agent_names AS names
         WHERE identity.organization_id = $1 AND identity.id = $2
           AND identity.version = $3 AND identity.status <> 'archived'
           AND memberships.id = $6 AND memberships.organization_id = $1
           AND memberships.role = 'owner' AND memberships.status = 'active'
           AND names.id = identity.approved_name_id
         RETURNING identity.id, identity.organization_id, identity.approved_name_id,
           names.name AS approved_name, identity.display_name, identity.status,
           identity.version, identity.updated_at`,
        [input.organizationId, input.id, input.expectedVersion, displayName, input.status, input.ownerMembershipId],
      ));
      const row = result.rows?.[0];
      if (!row) throw new AgentIdentityWriteError("NOT_FOUND_OR_STALE");
      return identityOf(row);
    });
  }

  async seedPrivateDemo(input: {
    organizationId: string;
    ownerMembershipId: string;
    privateDemo: boolean;
  }): Promise<AgentIdentity[]> {
    if (!input.privateDemo) return [];
    const approvedNameIds = initialDemoIdentities.map(({ approvedName }) => this.approvedNameId(approvedName));
    const approvedNames = initialDemoIdentities.map(({ approvedName }) => approvedName);
    const ids = initialDemoIdentities.map(() => randomUUID());
    const displayNames = initialDemoIdentities.map(({ displayName }) => displayName);
    return this.inTenant(input.organizationId, async (tx) => {
      await tx.query(
        `INSERT INTO app.agent_identities (
          id, organization_id, approved_name_id, display_name, updated_by_membership_id
        )
        SELECT seed.id, $1, names.id, seed.display_name, memberships.id
        FROM unnest($3::uuid[], $4::smallint[], $5::text[], $6::text[])
          AS seed(id, approved_name_id, approved_name, display_name)
        JOIN app.approved_agent_names AS names
          ON names.id = seed.approved_name_id AND names.name = seed.approved_name
        JOIN app.memberships ON memberships.id = $2
          AND memberships.organization_id = $1
          AND memberships.role = 'owner'
          AND memberships.status = 'active'
        ON CONFLICT (organization_id, approved_name_id) DO NOTHING`,
        [input.organizationId, input.ownerMembershipId, ids, approvedNameIds, approvedNames, displayNames],
      );
      const result = resultOf(await tx.query(
        `SELECT identities.id, identities.organization_id, identities.approved_name_id,
          names.name AS approved_name, identities.display_name, identities.status,
          identities.version, identities.updated_at
        FROM app.agent_identities AS identities
        JOIN app.approved_agent_names AS names ON names.id = identities.approved_name_id
        JOIN app.memberships ON memberships.id = $3
          AND memberships.organization_id = $1
          AND memberships.role = 'owner'
          AND memberships.status = 'active'
        WHERE identities.organization_id = $1
          AND identities.approved_name_id = ANY($2::smallint[])
        ORDER BY array_position($2::smallint[], identities.approved_name_id)`,
        [input.organizationId, approvedNameIds, input.ownerMembershipId],
      ));
      if ((result.rows ?? []).length !== 2) throw new AgentIdentityWriteError("NOT_FOUND_OR_STALE");
      return (result.rows ?? []).map(identityOf);
    });
  }
}
