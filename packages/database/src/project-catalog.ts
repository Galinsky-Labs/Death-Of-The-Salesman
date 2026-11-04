import { randomUUID } from "node:crypto";
import { withTransaction, type TransactionClient } from "./index.js";

export type CatalogKind = "project" | "offer" | "pricingSummary" | "productFact";
export type CatalogStatus = "active" | "archived";

export type CatalogRecord = {
  id: string;
  organizationId: string;
  kind: CatalogKind;
  projectId: string | null;
  offerId: string | null;
  label: string;
  content: Readonly<Record<string, unknown>>;
  status: CatalogStatus;
  version: number;
  updatedAt: string;
};

export class CatalogWriteError extends Error {
  readonly code: "NOT_FOUND_OR_STALE" | "INVALID_PARENT";

  constructor(code: "NOT_FOUND_OR_STALE" | "INVALID_PARENT", message = code) {
    super(message);
    this.code = code;
    this.name = "CatalogWriteError";
  }
}

const tableByKind = {
  project: "projects",
  offer: "offers",
  pricingSummary: "pricing_summaries",
  productFact: "vetted_product_facts",
} as const;

type QueryResult = { rows?: unknown[]; rowCount?: number | null };

const resultOf = (value: unknown): QueryResult =>
  typeof value === "object" && value !== null ? (value as QueryResult) : {};

const rowToRecord = (kind: CatalogKind, value: unknown): CatalogRecord => {
  if (typeof value !== "object" || value === null) throw new Error("catalog query returned no row");
  const row = value as Record<string, unknown>;
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    kind,
    projectId: row.project_id === null || row.project_id === undefined ? null : String(row.project_id),
    offerId: row.offer_id === null || row.offer_id === undefined ? null : String(row.offer_id),
    label: String(row.label),
    content: row.content as Readonly<Record<string, unknown>>,
    status: row.status as CatalogStatus,
    version: Number(row.version),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
};

const assertText = (value: string, field: string): string => {
  const normalized = value.trim();
  if (!normalized || normalized.length > 240) throw new Error(`${field} must contain 1 to 240 characters`);
  return normalized;
};

const assertParents = (kind: CatalogKind, projectId?: string, offerId?: string): void => {
  const valid =
    (kind === "project" && !projectId && !offerId) ||
    (kind === "offer" && Boolean(projectId) && !offerId) ||
    ((kind === "pricingSummary" || kind === "productFact") && Boolean(projectId) && Boolean(offerId));
  if (!valid) throw new CatalogWriteError("INVALID_PARENT");
};

const returningColumns =
  "id, organization_id, project_id, offer_id, label, content, status, version, updated_at";
const qualifiedReturningColumns =
  "item.id, item.organization_id, item.project_id, item.offer_id, item.label, item.content, item.status, item.version, item.updated_at";

export class ProjectCatalogRepository {
  private readonly client: TransactionClient;

  constructor(client: TransactionClient) {
    this.client = client;
  }

  private async inTenant<T>(organizationId: string, operation: (tx: TransactionClient) => Promise<T>): Promise<T> {
    return withTransaction(this.client, async (tx) => {
      await tx.query("SELECT set_config('app.organization_id', $1, true)", [organizationId]);
      return operation(tx);
    });
  }

  async create(input: {
    kind: CatalogKind;
    organizationId: string;
    ownerMembershipId: string;
    projectId?: string;
    offerId?: string;
    label: string;
    content: Readonly<Record<string, unknown>>;
  }): Promise<CatalogRecord> {
    assertParents(input.kind, input.projectId, input.offerId);
    const table = tableByKind[input.kind];
    const id = randomUUID();
    const label = assertText(input.label, "label");
    return this.inTenant(input.organizationId, async (tx) => {
      const result = resultOf(await tx.query(
        `INSERT INTO app.${table} (
          id, organization_id, project_id, offer_id, label, content, updated_by_membership_id
        )
        SELECT $1, $2::app.entity_id, $3, $4, $5, $6::jsonb, memberships.id
        FROM app.memberships
        WHERE memberships.id = $7
          AND memberships.organization_id = $2::app.entity_id
          AND memberships.role = 'owner'
          AND memberships.status = 'active'
        RETURNING ${returningColumns}`,
        [id, input.organizationId, input.projectId ?? null, input.offerId ?? null, label, JSON.stringify(input.content), input.ownerMembershipId],
      ));
      const row = result.rows?.[0];
      if (!row) throw new CatalogWriteError("NOT_FOUND_OR_STALE");
      return rowToRecord(input.kind, row);
    });
  }

  async get(input: { kind: CatalogKind; organizationId: string; id: string }): Promise<CatalogRecord | null> {
    const table = tableByKind[input.kind];
    return this.inTenant(input.organizationId, async (tx) => {
      const result = resultOf(await tx.query(
        `SELECT ${returningColumns} FROM app.${table}
         WHERE organization_id = $1 AND id = $2`,
        [input.organizationId, input.id],
      ));
      return result.rows?.[0] ? rowToRecord(input.kind, result.rows[0]) : null;
    });
  }

  async update(input: {
    kind: CatalogKind;
    organizationId: string;
    ownerMembershipId: string;
    id: string;
    expectedVersion: number;
    label: string;
    content: Readonly<Record<string, unknown>>;
  }): Promise<CatalogRecord> {
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw new Error("expectedVersion must be a positive safe integer");
    }
    const table = tableByKind[input.kind];
    const label = assertText(input.label, "label");
    return this.inTenant(input.organizationId, async (tx) => {
      const result = resultOf(await tx.query(
        `UPDATE app.${table} AS item
         SET label = $4, content = $5::jsonb, version = item.version + 1,
             updated_by_membership_id = memberships.id, updated_at = app.utc_now()
         FROM app.memberships
         WHERE item.organization_id = $1 AND item.id = $2 AND item.version = $3
           AND item.status = 'active'
           AND memberships.id = $6 AND memberships.organization_id = $1
           AND memberships.role = 'owner' AND memberships.status = 'active'
         RETURNING ${qualifiedReturningColumns}`,
        [input.organizationId, input.id, input.expectedVersion, label, JSON.stringify(input.content), input.ownerMembershipId],
      ));
      const row = result.rows?.[0];
      if (!row) throw new CatalogWriteError("NOT_FOUND_OR_STALE");
      return rowToRecord(input.kind, row);
    });
  }

  async archive(input: {
    kind: CatalogKind;
    organizationId: string;
    ownerMembershipId: string;
    id: string;
    expectedVersion: number;
  }): Promise<CatalogRecord> {
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw new Error("expectedVersion must be a positive safe integer");
    }
    const table = tableByKind[input.kind];
    return this.inTenant(input.organizationId, async (tx) => {
      const result = resultOf(await tx.query(
        `UPDATE app.${table} AS item
         SET status = 'archived', version = item.version + 1,
             updated_by_membership_id = memberships.id, updated_at = app.utc_now()
         FROM app.memberships
         WHERE item.organization_id = $1 AND item.id = $2 AND item.version = $3
           AND item.status = 'active'
           AND memberships.id = $4 AND memberships.organization_id = $1
           AND memberships.role = 'owner' AND memberships.status = 'active'
         RETURNING ${qualifiedReturningColumns}`,
        [input.organizationId, input.id, input.expectedVersion, input.ownerMembershipId],
      ));
      const row = result.rows?.[0];
      if (!row) throw new CatalogWriteError("NOT_FOUND_OR_STALE");
      return rowToRecord(input.kind, row);
    });
  }
}

