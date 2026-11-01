import assert from "node:assert/strict";
import test from "node:test";
import { deploymentFixture, ids } from "./helpers/deployment-fixture.mjs";
import { deploymentDependencies } from "../packages/api/dist/deployment-store.js";
import { handleDeployment } from "../packages/api/dist/deployment.js";
const req = (body, suffix = "", token = "synthetic-session") => new Request(`http://localhost/deployment${suffix}`, { method: body === undefined ? "GET" : "POST", headers: { cookie: `__Host-dots-session=${token}`, "x-csrf-token": "synthetic-csrf", "content-type": "application/json", origin: "http://localhost" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
test("real PostgreSQL engine: owner session, durable refresh, stale moves, hidden buckets and tenant isolation", async () => {
  const fixture = await deploymentFixture();
  const { db } = fixture;
  try {
    const { deps, pool } = fixture;
    const initial = await handleDeployment(req(), deps); assert.equal(initial.status, 200);
    const initialState = await initial.json(); assert.equal(initialState.agents.length, 1); assert.equal(initialState.assignments.length, 0);
    const input = { agentIdentityId: ids.agent, bucketId: ids.bucket, priority: 50, allocationBasisPoints: 4000, quotaLimit: 100, concurrencyCap: 2, expectedVersion: null };
    const createdResponse = await handleDeployment(req(input), deps); assert.equal(createdResponse.status, 200, await createdResponse.clone().text());
    const created = (await createdResponse.json()).assignment;
    const refreshed = await (await handleDeployment(req(), deploymentDependencies(pool, ids.org))).json(); assert.deepEqual(refreshed.assignments[0], created);
    assert.equal((await handleDeployment(req({ ...input, id: created.id, expectedVersion: 9, bucketId: ids.secondBucket }), deps)).status, 409);
    assert.equal((await handleDeployment(req({ ...input, bucketId: ids.secondBucket, allocationBasisPoints: 7000 }), deps)).status, 409);
    const movedResponse = await handleDeployment(req({ ...input, id: created.id, expectedVersion: 1, bucketId: ids.secondBucket }), deps); assert.equal(movedResponse.status, 200);
    const moved = (await movedResponse.json()).assignment; assert.equal(moved.projectId, ids.second); assert.equal(moved.version, 2);
    const preference = { bucketId: ids.secondBucket, visible: false, position: 1, expectedVersion: null };
    assert.equal((await handleDeployment(req(preference, "/preferences"), deps)).status, 200);
    const hidden = await (await handleDeployment(req(), deps)).json(); assert.equal(hidden.assignments.length, 1); assert.equal(hidden.buckets.find(b => b.id === ids.secondBucket).visible, false);
    assert.equal((await handleDeployment(req({ ...input, id: created.id, expectedVersion: 2, bucketId: ids.secondBucket }), deps)).status, 409);
    // Regression: a second preference update with a non-null version must actually execute.
    assert.equal((await handleDeployment(req({ ...preference, visible: true, expectedVersion: 1 }, "/preferences"), deps)).status, 200);
    const shown = await (await handleDeployment(req(), deps)).json(); assert.equal(shown.buckets.find(b => b.id === ids.secondBucket).preferenceVersion, 2); assert.equal(shown.buckets.find(b => b.id === ids.secondBucket).visible, true);
    assert.equal((await handleDeployment(req({ ...preference, expectedVersion: 1 }, "/preferences"), deps)).status, 409);
    assert.equal((await handleDeployment(req(), deploymentDependencies(pool, ids.second))).status, 401);
    assert.equal((await handleDeployment(req(undefined, "", "unknown-session"), deps)).status, 401);
    await db.query("BEGIN"); await db.query("SELECT set_config('app.organization_id',$1,true)", [ids.org]); await db.query("UPDATE app.memberships SET status='inactive' WHERE id=$1", [ids.owner]); await db.query("COMMIT");
    assert.equal((await handleDeployment(req(), deps)).status, 401);
  } finally { await db.close(); }
});
