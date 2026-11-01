import { authorizeOwnerRequest, AuthenticationError, type SessionStore } from "@dots/auth";
import { AssignmentWriteError, type AgentProjectAssignment } from "@dots/database";

export type DeploymentBucket = { id: string; projectId: string; campaignId: string | null; label: string; visible: boolean; position: number; preferenceVersion: number | null };
export type DeploymentAgent = { id: string; displayName: string; status: string };
export type DeploymentSnapshot = { agents: DeploymentAgent[]; buckets: DeploymentBucket[]; assignments: AgentProjectAssignment[] };
export type Owner = { organizationId: string; membershipId: string };
export interface DeploymentStore {
  snapshot(owner: Owner): Promise<DeploymentSnapshot>;
  save(owner: Owner, input: AssignmentInput): Promise<AgentProjectAssignment>;
  preference(owner: Owner, input: { bucketId: string; visible: boolean; position: number; expectedVersion: number | null }): Promise<void>;
}
export type AssignmentInput = { id?: string; agentIdentityId: string; bucketId: string; priority: number; allocationBasisPoints: number; quotaLimit: number; concurrencyCap: number; expectedVersion: number | null };
export type DeploymentDependencies = { sessions: SessionStore; store: DeploymentStore };
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const integer = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
const version = (value: unknown): value is number | null => value === null || integer(value, 1);
const json = (body: unknown, status = 200): Response => Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
export const cookiesOf = (header: string | null): Record<string, string> => Object.fromEntries((header ?? "").split(";").map(x => x.trim().split(/=(.*)/s)).filter(x => x[0] && x[1]).map(x => [x[0], x[1]]));

export async function handleDeployment(request: Request, dependencies?: DeploymentDependencies): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path !== "/deployment" && path !== "/deployment/preferences") return json({ code: "NOT_FOUND" }, 404);
  if (request.method !== "GET" && request.method !== "POST") return json({ code: "METHOD_NOT_ALLOWED" }, 405);
  if (path.endsWith("preferences") && request.method !== "POST") return json({ code: "METHOD_NOT_ALLOWED" }, 405);
  if (!dependencies) return json({ code: "DEPLOYMENT_UNAVAILABLE", message: "Deployment storage and owner authentication are not configured." }, 503);
  try {
    const cookie = cookiesOf(request.headers.get("cookie"));
    const owner = await authorizeOwnerRequest({ sessionToken: cookie["__Host-dots-session"], csrfToken: request.headers.get("x-csrf-token") ?? undefined, method: request.method, sessions: dependencies.sessions });
    if (owner.role !== "owner") return json({ code: "FORBIDDEN" }, 403);
    if (request.method === "GET") return json(await dependencies.store.snapshot(owner));
    const origin = request.headers.get("origin");
    if (origin !== new URL(request.url).origin) return json({ code: "ORIGIN_REJECTED" }, 403);
    if (!request.headers.get("content-type")?.startsWith("application/json")) return json({ code: "INVALID_BODY" }, 415);
    const raw = await request.text();
    if (new TextEncoder().encode(raw).length > 4096) return json({ code: "BODY_TOO_LARGE" }, 413);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw) as Record<string, unknown>; } catch { return json({ code: "INVALID_BODY" }, 400); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return json({ code: "INVALID_BODY" }, 400);
    if (path.endsWith("preferences")) {
      if (Object.keys(body).some(key => !["bucketId", "visible", "position", "expectedVersion"].includes(key)) || !uuid(body.bucketId) || typeof body.visible !== "boolean" || !integer(body.position, 0) || !version(body.expectedVersion)) return json({ code: "INVALID_BODY" }, 400);
      await dependencies.store.preference(owner, body as { bucketId: string; visible: boolean; position: number; expectedVersion: number | null });
      return json({ saved: true });
    }
    if (Object.keys(body).some(key => !["id", "agentIdentityId", "bucketId", "priority", "allocationBasisPoints", "quotaLimit", "concurrencyCap", "expectedVersion"].includes(key)) || !uuid(body.agentIdentityId) || !uuid(body.bucketId) || !integer(body.priority, 0, 100) || !integer(body.allocationBasisPoints, 1, 10000) || !integer(body.quotaLimit, 1) || !integer(body.concurrencyCap, 1, 1000) || !version(body.expectedVersion) || (body.id === undefined ? body.expectedVersion !== null : !uuid(body.id) || body.expectedVersion === null)) return json({ code: "INVALID_BODY" }, 400);
    return json({ assignment: await dependencies.store.save(owner, body as AssignmentInput) });
  } catch (error) {
    if (error instanceof AuthenticationError) return json({ code: error.code }, error.status);
    if (error instanceof AssignmentWriteError || (error instanceof Error && error.name === "ProjectBucketWriteError")) return json({ code: "code" in error ? error.code : "NOT_FOUND_OR_STALE", message: "Assignment changed or target is unavailable. Reload before retrying." }, 409);
    // A unique target can race an update; expose a conflict without SQL details.
    if (typeof error === "object" && error && "code" in error && error.code === "23505") return json({ code: "TARGET_CONFLICT" }, 409);
    return json({ code: "DEPLOYMENT_UNAVAILABLE", message: "Could not confirm the save. Reload server state before trying again." }, 503);
  }
}
