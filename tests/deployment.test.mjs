import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { handleDeployment } from "../packages/api/dist/deployment.js";
import { createApiServer } from "../packages/api/dist/http-server.js";
import { AssignmentWriteError } from "../packages/database/dist/agent-project-assignments.js";
import { prepareDrop, assignmentsIn } from "../apps/web/app/deployment-model.ts";
const agent = "11111111-1111-4111-8111-111111111111";
const bucket = "22222222-2222-4222-8222-222222222222";
const project = "33333333-3333-4333-8333-333333333333";
const organization = "44444444-4444-4444-8444-444444444444";
const membership = "55555555-5555-4555-8555-555555555555";
const assignment = "66666666-6666-4666-8666-666666666666";
const hash = text => createHash("sha256").update(text).digest("hex");
const session = () => ({ id: membership, organizationId: organization, userId: membership, membershipId: membership, role: "owner", tokenHash: hash("test-session"), csrfHash: hash("test-csrf"), createdAt: new Date(), lastSeenAt: new Date(), expiresAt: new Date(Date.now() + 60000), idleExpiresAt: new Date(Date.now() + 60000), idleTimeoutSeconds: 60 });
const snapshot = () => ({ agents: [{ id: agent, displayName: "Synthetic agent", status: "active" }], buckets: [{ id: bucket, projectId: project, campaignId: null, visible: true, label: "Synthetic project", position: 0, preferenceVersion: null }], assignments: [] });
const input = () => ({ agentIdentityId: agent, bucketId: bucket, allocationBasisPoints: 4000, priority: 50, quotaLimit: 100, concurrencyCap: 1, expectedVersion: null });
const request = (body, options = {}) => new Request("http://localhost/deployment", { method: body === undefined ? "GET" : "POST", headers: { cookie: "__Host-dots-session=test-session", "x-csrf-token": "test-csrf", origin: "http://localhost", "content-type": "application/json", ...options.headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...options });
const dependencies = (overrides = {}) => {
  let current = snapshot();
  return { sessions: { create: async () => {}, touch: async () => {}, findByTokenHash: async token => token === hash("test-session") ? session() : undefined }, store: { snapshot: async () => structuredClone(current), preference: async () => {}, save: async (owner, body) => {
    assert.equal(owner.organizationId, organization); assert.equal(owner.membershipId, membership);
    const value = { id: assignment, organizationId: organization, agentIdentityId: body.agentIdentityId, projectId: project, campaignId: null, priority: body.priority, allocationBasisPoints: body.allocationBasisPoints, quotaLimit: body.quotaLimit, concurrencyCap: body.concurrencyCap, version: 1, updatedAt: new Date().toISOString() };
    current.assignments = [value]; return value;
  }, ...overrides } };
};
test("confirmed assignment is returned by a fresh server read", async () => {
  const deps = dependencies();
  assert.equal((await handleDeployment(request(input()), deps)).status, 200);
  const reread = await (await handleDeployment(request(), deps)).json();
  assert.equal(reread.assignments[0].id, assignment);
  assert.equal(reread.assignments[0].allocationBasisPoints, 4000);
});
test("expired, anonymous, non-owner and CSRF-invalid requests cannot write", async () => {
  let writes = 0; const deps = dependencies({ save: async () => { writes++; } });
  assert.equal((await handleDeployment(request(input(), { headers: {} }), deps)).status, 401);
  deps.sessions.findByTokenHash = async () => ({ ...session(), expiresAt: new Date(0) });
  assert.equal((await handleDeployment(request(input()), deps)).status, 401);
  deps.sessions.findByTokenHash = async () => ({ ...session(), role: "admin" });
  assert.equal((await handleDeployment(request(input()), deps)).status, 403);
  deps.sessions.findByTokenHash = async () => session();
  assert.equal((await handleDeployment(request(input(), { headers: { cookie: "__Host-dots-session=test-session", "x-csrf-token": "wrong" } }), deps)).status, 403);
  assert.equal(writes, 0);
});
test("browser-supplied authority, malformed version, over-allocation and unsafe origin fail closed", async () => {
  const deps = dependencies();
  for (const bad of [{ ...input(), organizationId: organization }, { ...input(), ownerMembershipId: membership }, { ...input(), expectedVersion: 1 }, { ...input(), allocationBasisPoints: 10001 }, { ...input(), quotaLimit: 0 }, { ...input(), concurrencyCap: 1001 }]) assert.equal((await handleDeployment(request(bad), deps)).status, 400);
  assert.equal((await handleDeployment(request(input(), { headers: { cookie: "__Host-dots-session=test-session", "x-csrf-token": "test-csrf", origin: "https://foreign.example" } }), deps)).status, 403);
});
test("conflicts and unknown save errors cannot become successful confirmations", async () => {
  for (const code of ["NOT_FOUND_OR_STALE", "ALLOCATION_EXCEEDED", "TARGET_CONFLICT"]) {
    const response = await handleDeployment(request(input()), dependencies({ save: async () => { throw new AssignmentWriteError(code); } }));
    assert.equal(response.status, 409); assert.equal((await response.json()).code, code);
  }
  const response = await handleDeployment(request(input()), dependencies({ save: async () => { throw new Error("private database details"); } }));
  assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /private database details/);
  assert.equal((await handleDeployment(request(input()))).status, 503);
});
test("drop is optimistic and leaves confirmed state untouched; hidden allocation is counted", () => {
  const confirmed = snapshot();
  const intent = { ...input(), assignmentId: null };
  const result = prepareDrop(confirmed, intent);
  assert.equal(confirmed.assignments.length, 0); assert.equal(result.optimistic.assignments.length, 1);
  assert.equal(result.input.expectedVersion, null);
  const hidden = { ...confirmed.buckets[0], id: membership, projectId: membership, visible: false };
  confirmed.buckets.push(hidden);
  confirmed.assignments.push({ ...result.optimistic.assignments[0], id: assignment, projectId: membership, allocationBasisPoints: 8000, version: 4 });
  assert.throws(() => prepareDrop(confirmed, intent), /Hidden buckets/);
  const move = prepareDrop(confirmed, { ...intent, assignmentId: assignment });
  assert.equal(move.input.expectedVersion, 4); assert.equal(move.optimistic.assignments.length, 1);
  assert.equal(assignmentsIn(move.optimistic, confirmed.buckets[0]).length, 1);
  assert.throws(() => prepareDrop(move.optimistic, intent), /already assigned/);
  assert.throws(() => prepareDrop(confirmed, { ...intent, bucketId: hidden.id }), /checked bucket/);
});
test("actual HTTP service enforces body bounds and persists via its supplied store", async () => {
  const server = createApiServer(dependencies());
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const headers = { cookie: "__Host-dots-session=test-session", "x-csrf-token": "test-csrf", origin: base, "content-type": "application/json" };
    const saved = await fetch(`${base}/deployment`, { method: "POST", headers, body: JSON.stringify(input()) });
    assert.equal(saved.status, 200);
    const reread = await (await fetch(`${base}/deployment`, { headers })).json();
    assert.equal(reread.assignments[0].id, assignment);
    const oversized = await fetch(`${base}/deployment`, { method: "POST", headers, body: "x".repeat(5000) });
    assert.equal(oversized.status, 413);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
