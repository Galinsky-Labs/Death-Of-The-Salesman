import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  AgentProjectAssignmentRepository,
  AssignmentWriteError,
} from "../packages/database/dist/agent-project-assignments.js";

const organizationId = "11111111-1111-4111-8111-111111111111";
const ownerMembershipId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const agentIdentityId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const projectId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const row = (overrides = {}) => ({
  id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  organization_id: organizationId,
  agent_identity_id: agentIdentityId,
  project_id: projectId,
  campaign_id: null,
  priority: 50,
  allocation_basis_points: 4_000,
  quota_limit: 100,
  concurrency_cap: 2,
  version: 1,
  updated_at: "2026-10-26T08:00:00.000Z",
  ...overrides,
});

const repositoryWith = (responses, statements = []) => new AgentProjectAssignmentRepository({
  query: async (statement) => {
    statements.push(statement);
    return responses.shift() ?? {};
  },
});

test("creates an owner-authorized tenant assignment under a locked agent budget", async () => {
  const statements = [];
  const repository = repositoryWith([
    {}, {}, {}, { rows: [{ id: agentIdentityId }] }, { rows: [{ allocated: "0" }] },
    { rows: [row()] }, {},
  ], statements);
  const assignment = await repository.save({
    organizationId, ownerMembershipId, agentIdentityId, projectId,
    priority: 50, allocationBasisPoints: 4_000, quotaLimit: 100,
    concurrencyCap: 2, expectedVersion: null,
  });
  assert.equal(assignment.allocationBasisPoints, 4_000);
  assert.equal(assignment.version, 1);
  const lock = statements.find((statement) => statement.includes("FOR UPDATE OF projects"));
  assert.ok(statements.some(statement=>statement.includes("pg_advisory_xact_lock")));
  assert.match(lock ?? "", /identities\.status = 'active'/);
  assert.match(lock ?? "", /memberships\.role = 'owner'/);
  assert.ok(statements.some((statement) => statement.includes("ON CONFLICT DO NOTHING")));
});

test("one agent can serve multiple projects with deterministic priority order", async () => {
  const second = row({
    id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    project_id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    priority: 90,
    allocation_basis_points: 6_000,
  });
  const repository = repositoryWith([{}, {}, { rows: [second, row()] }, {}]);
  const assignments = await repository.listForAgent({
    organizationId, ownerMembershipId, agentIdentityId,
  });
  assert.deepEqual(assignments.map(({ projectId, priority }) => ({ projectId, priority })), [
    { projectId: second.project_id, priority: 90 },
    { projectId, priority: 50 },
  ]);
});

test("allocation above one hundred percent fails atomically", async () => {
  const repository = repositoryWith([
    {}, {}, {}, { rows: [{ id: agentIdentityId }] }, { rows: [{ allocated: "7000" }] }, {},
  ]);
  await assert.rejects(
    repository.save({
      organizationId, ownerMembershipId, agentIdentityId, projectId,
      priority: 50, allocationBasisPoints: 4_000, quotaLimit: 100,
      concurrencyCap: 2, expectedVersion: null,
    }),
    (error) => error instanceof AssignmentWriteError
      && error.code === "ALLOCATION_EXCEEDED"
      && error.retryable === false,
  );
});

test("exact versions update allocation and stale conflicts are explicitly retryable", async () => {
  const repository = repositoryWith([
    {}, {}, {}, { rows: [{ id: agentIdentityId }] }, { rows: [{ allocated: "2000" }] },
    { rows: [row({ allocation_basis_points: 5_000, version: 2 })] }, {},
  ]);
  const updated = await repository.save({
    id: row().id, organizationId, ownerMembershipId, agentIdentityId, projectId,
    priority: 60, allocationBasisPoints: 5_000, quotaLimit: 120,
    concurrencyCap: 3, expectedVersion: 1,
  });
  assert.equal(updated.version, 2);
  assert.equal(updated.allocationBasisPoints, 5_000);

  const stale = repositoryWith([
    {}, {}, {}, { rows: [{ id: agentIdentityId }] }, { rows: [{ allocated: "2000" }] },
    { rows: [] }, {},
  ]);
  await assert.rejects(
    stale.save({
      id: row().id, organizationId, ownerMembershipId, agentIdentityId, projectId,
      priority: 60, allocationBasisPoints: 5_000, quotaLimit: 120,
      concurrencyCap: 3, expectedVersion: 1,
    }),
    (error) => error instanceof AssignmentWriteError
      && error.code === "NOT_FOUND_OR_STALE"
      && error.retryable === true,
  );
});

test("invalid priorities, percentages, quotas, caps, and version modes fail before SQL", async () => {
  let queries = 0;
  const repository = new AgentProjectAssignmentRepository({
    query: async () => { queries += 1; return {}; },
  });
  const valid = {
    organizationId, ownerMembershipId, agentIdentityId, projectId,
    priority: 50, allocationBasisPoints: 5_000, quotaLimit: 100,
    concurrencyCap: 2, expectedVersion: null,
  };
  await assert.rejects(repository.save({ ...valid, priority: 101 }), /priority/);
  await assert.rejects(repository.save({ ...valid, allocationBasisPoints: 0 }), /allocationBasisPoints/);
  await assert.rejects(repository.save({ ...valid, quotaLimit: 0 }), /quotaLimit/);
  await assert.rejects(repository.save({ ...valid, concurrencyCap: 1_001 }), /concurrencyCap/);
  await assert.rejects(repository.save({ ...valid, id: row().id }), /version/);
  assert.equal(queries, 0);
});

test("migration binds assignments to tenant agents, projects, owners, and row security", async () => {
  const source = await readFile(
    new URL("../database/migrations/0009_agent_project_assignments.up.sql", import.meta.url),
    "utf8",
  );
  assert.match(source, /UNIQUE NULLS NOT DISTINCT/);
  assert.match(source, /REFERENCES app\.agent_identities\(organization_id, id\)/);
  assert.match(source, /REFERENCES app\.projects\(organization_id, id\)/);
  assert.match(source, /REFERENCES app\.memberships\(organization_id, id\)/);
  assert.match(source, /FORCE ROW LEVEL SECURITY/);
});
