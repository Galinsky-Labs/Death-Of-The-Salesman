import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { deploymentDependencies } from "../packages/api/dist/deployment-store.js";
import { handleDeployment } from "../packages/api/dist/deployment.js";
const ids = { org: "11111111-1111-4111-8111-111111111111", user: "22222222-2222-4222-8222-222222222222", owner: "33333333-3333-4333-8333-333333333333", agent: "44444444-4444-4444-8444-444444444444", project: "55555555-5555-4555-8555-555555555555", bucket: "66666666-6666-4666-8666-666666666666", second: "77777777-7777-4777-8777-777777777777", secondBucket: "88888888-8888-4888-8888-888888888888" };
const hash = text => createHash("sha256").update(text).digest("hex");
const req = (body, suffix = "", token = "synthetic-session") => new Request(`http://localhost/deployment${suffix}`, { method: body === undefined ? "GET" : "POST", headers: { cookie: `__Host-dots-session=${token}`, "x-csrf-token": "synthetic-csrf", "content-type": "application/json", origin: "http://localhost" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
test("real PostgreSQL engine: owner session, durable refresh, stale moves, hidden buckets and tenant isolation", async () => {
  const db = new PGlite();
  try {
    const dir = new URL("../database/migrations/", import.meta.url);
    for (const file of (await readdir(dir)).filter(x => x.endsWith(".up.sql")).sort()) await db.exec(await readFile(new URL(file, dir), "utf8"));
    await db.query("INSERT INTO app.organizations(id,slug,display_name) VALUES ($1,'synthetic','Synthetic organization')", [ids.org]);
    await db.query("INSERT INTO app.owner_users(id,identity_subject,display_name) VALUES ($1,'synthetic-oidc','Synthetic owner')", [ids.user]);
    await db.query("INSERT INTO app.memberships(id,organization_id,user_id,role) VALUES ($1,$2,$3,'owner')", [ids.owner, ids.org, ids.user]);
    for (const p of [ids.project, ids.second]) await db.query("INSERT INTO app.projects(id,organization_id,label,content,updated_by_membership_id) VALUES ($1,$2,'Synthetic project','{}',$3)", [p, ids.org, ids.owner]);
    await db.query("INSERT INTO app.agent_identities(id,organization_id,approved_name_id,display_name,status,updated_by_membership_id) VALUES ($1,$2,1,'Synthetic agent','active',$3)", [ids.agent, ids.org, ids.owner]);
    for (const [b, p] of [[ids.bucket, ids.project], [ids.secondBucket, ids.second]]) await db.query("INSERT INTO app.project_buckets(id,organization_id,project_id,label,default_position,updated_by_membership_id) VALUES ($1,$2,$3,'Synthetic bucket',0,$4)", [b, ids.org, p, ids.owner]);
    await db.query("INSERT INTO app.owner_sessions(organization_id,user_id,membership_id,token_hash,csrf_hash,expires_at,idle_expires_at,idle_timeout_seconds) VALUES ($1,$2,$3,decode($4,'hex'),decode($5,'hex'),now()+interval '1 hour',now()+interval '15 minutes',900)", [ids.org, ids.user, ids.owner, hash("synthetic-session"), hash("synthetic-csrf")]);
    await db.exec("CREATE ROLE deployment_runtime NOLOGIN NOBYPASSRLS; GRANT USAGE ON SCHEMA app TO deployment_runtime; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA app TO deployment_runtime; GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO deployment_runtime; SET ROLE deployment_runtime;");
    const pool = { connect: async () => ({ query: (sql, values) => db.query(sql, values), release() {} }) };
    const deps = deploymentDependencies(pool, ids.org);
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
