import { Pool, neonConfig, type PoolClient } from "@neondatabase/serverless";

neonConfig.webSocketConstructor = WebSocket;
let pool: Pool | undefined;

export function database() {
  if (!process.env.DATABASE_URL) throw new Error("Database is not configured");
  pool ??= new Pool({ connectionString: process.env.DATABASE_URL, max: 3, connectionTimeoutMillis: 10000 });
  return pool;
}

export function tenant() {
  const organizationId = process.env.OWNER_ORGANIZATION_ID;
  const ownerMembershipId = process.env.OWNER_MEMBERSHIP_ID;
  if (!organizationId || !ownerMembershipId) throw new Error("Owner workspace is not configured");
  return { organizationId, ownerMembershipId };
}

export async function inWorkspace<T>(operation: (client: PoolClient) => Promise<T>) {
  const client = await database().connect();
  const owner = tenant();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE dots_runtime");
    await client.query("SELECT set_config('app.organization_id', $1, true), set_config('app.audit_actor_membership_id', $2, true)",
      [owner.organizationId, owner.ownerMembershipId]);
    const authority = await client.query("SELECT id FROM app.memberships WHERE id=$1 AND organization_id=$2 AND status='active' AND role='owner'",
      [owner.ownerMembershipId, owner.organizationId]);
    if (!authority.rows.length) throw new Error("Owner membership is inactive");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
