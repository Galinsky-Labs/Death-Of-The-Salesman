import { randomUUID } from "node:crypto";
import { withTransaction, type TransactionClient } from "./index.js";

export type ProjectBucket = {
  id: string;
  organizationId: string;
  projectId: string;
  campaignId: string | null;
  label: string;
  defaultPosition: number;
  visible: boolean;
  position: number;
  preferenceVersion: number | null;
};

export class ProjectBucketWriteError extends Error {
  readonly code: "NOT_FOUND_OR_STALE";

  constructor(message = "NOT_FOUND_OR_STALE") {
    super(message);
    this.code = "NOT_FOUND_OR_STALE";
    this.name = "ProjectBucketWriteError";
  }
}

type QueryResult = { rows?: unknown[] };

const resultOf = (value: unknown): QueryResult =>
  typeof value === "object" && value !== null ? (value as QueryResult) : {};

const positivePosition = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("position must be a non-negative safe integer");
  return value;
};

const labelOf = (value: string): string => {
  const label = value.trim();
  if (!label || label.length > 120) throw new Error("label must contain 1 to 120 characters");
  return label;
};

const bucketOf = (value: unknown): ProjectBucket => {
  if (typeof value !== "object" || value === null) throw new Error("bucket query returned no row");
  const row = value as Record<string, unknown>;
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    projectId: String(row.project_id),
    campaignId: row.campaign_id === null || row.campaign_id === undefined ? null : String(row.campaign_id),
    label: String(row.label),
    defaultPosition: Number(row.default_position),
    visible: row.visible === undefined ? true : Boolean(row.visible),
    position: Number(row.position ?? row.default_position),
    preferenceVersion: row.preference_version === null || row.preference_version === undefined
      ? null
      : Number(row.preference_version),
  };
};

export class ProjectBucketRepository {
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
    organizationId: string;
    ownerMembershipId: string;
    projectId: string;
    campaignId?: string | null;
    label: string;
    defaultPosition: number;
  }): Promise<ProjectBucket> {
    const id = randomUUID();
    const label = labelOf(input.label);
    const position = positivePosition(input.defaultPosition);
    return this.inTenant(input.organizationId, async (tx) => {
      const result = resultOf(await tx.query(
        `INSERT INTO app.project_buckets (
          id, organization_id, project_id, campaign_id, label, default_position,
          updated_by_membership_id
        )
        SELECT $1, $2, projects.id, $4, $5, $6, memberships.id
        FROM app.projects
        JOIN app.memberships ON memberships.id = $7
          AND memberships.organization_id = $2
          AND memberships.role = 'owner'
          AND memberships.status = 'active'
        WHERE projects.id = $3
          AND projects.organization_id = $2
          AND projects.status = 'active'
        RETURNING id, organization_id, project_id, campaign_id, label,
          default_position, default_position AS position, true AS visible,
          NULL::bigint AS preference_version`,
        [id, input.organizationId, input.projectId, input.campaignId ?? null, label, position, input.ownerMembershipId],
      ));
      const row = result.rows?.[0];
      if (!row) throw new ProjectBucketWriteError();
      return bucketOf(row);
    });
  }

  async listForOwner(input: { organizationId: string; ownerMembershipId: string }): Promise<ProjectBucket[]> {
    return this.inTenant(input.organizationId, async (tx) => {
      const result = resultOf(await tx.query(
        `SELECT buckets.id, buckets.organization_id, buckets.project_id, buckets.campaign_id,
          buckets.label, buckets.default_position,
          COALESCE(preferences.visible, true) AS visible,
          COALESCE(preferences.display_position, buckets.default_position) AS position,
          preferences.version AS preference_version
        FROM app.memberships
        JOIN app.project_buckets AS buckets ON buckets.organization_id = memberships.organization_id
        LEFT JOIN app.project_bucket_preferences AS preferences
          ON preferences.organization_id = buckets.organization_id
          AND preferences.owner_membership_id = memberships.id
          AND preferences.bucket_id = buckets.id
        WHERE memberships.id = $2
          AND memberships.organization_id = $1
          AND memberships.role = 'owner'
          AND memberships.status = 'active'
        ORDER BY position, buckets.id`,
        [input.organizationId, input.ownerMembershipId],
      ));
      return (result.rows ?? []).map(bucketOf);
    });
  }

  async savePreference(input: {
    organizationId: string;
    ownerMembershipId: string;
    bucketId: string;
    visible: boolean;
    position: number;
    expectedVersion: number | null;
  }): Promise<ProjectBucket> {
    const position = positivePosition(input.position);
    if (input.expectedVersion !== null && (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1)) {
      throw new Error("expectedVersion must be null or a positive safe integer");
    }
    return this.inTenant(input.organizationId, async (tx) => {
      // Serialize bucket visibility with deployment writes that hold a shared bucket lock.
      await tx.query("SELECT id FROM app.project_buckets WHERE organization_id=$1 AND id=$2 FOR UPDATE", [input.organizationId, input.bucketId]);
      const result = resultOf(await tx.query(
        `INSERT INTO app.project_bucket_preferences AS preference (
          organization_id, owner_membership_id, bucket_id, visible, display_position, version
        )
        SELECT $1, memberships.id, buckets.id, $4, $5, 1
        FROM app.memberships
        JOIN app.project_buckets AS buckets
          ON buckets.id = $3 AND buckets.organization_id = $1
        WHERE memberships.id = $2
          AND memberships.organization_id = $1
          AND memberships.role = 'owner'
          AND memberships.status = 'active'
          AND ($6::bigint IS NULL OR EXISTS (
            SELECT 1 FROM app.project_bucket_preferences existing
            WHERE existing.organization_id=$1 AND existing.owner_membership_id=$2
              AND existing.bucket_id=$3 AND existing.version=$6
          ))
        ON CONFLICT (organization_id, owner_membership_id, bucket_id) DO UPDATE
        SET visible = EXCLUDED.visible,
            display_position = EXCLUDED.display_position,
            version = preference.version + 1,
            updated_at = app.utc_now()
        WHERE preference.version = $6
        RETURNING bucket_id`,
        [input.organizationId, input.ownerMembershipId, input.bucketId, input.visible, position, input.expectedVersion],
      ));
      if (!result.rows?.[0]) throw new ProjectBucketWriteError();

      const loaded = resultOf(await tx.query(
        `SELECT buckets.id, buckets.organization_id, buckets.project_id, buckets.campaign_id,
          buckets.label, buckets.default_position, preference.visible,
          preference.display_position AS position, preference.version AS preference_version
        FROM app.project_bucket_preferences AS preference
        JOIN app.project_buckets AS buckets
          ON buckets.organization_id = preference.organization_id
          AND buckets.id = preference.bucket_id
        WHERE preference.organization_id = $1
          AND preference.owner_membership_id = $2
          AND preference.bucket_id = $3`,
        [input.organizationId, input.ownerMembershipId, input.bucketId],
      ));
      return bucketOf(loaded.rows?.[0]);
    });
  }
}

