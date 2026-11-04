import assert from "node:assert/strict";
import test from "node:test";
import {
  ProjectBucketRepository,
  ProjectBucketWriteError,
} from "../packages/database/dist/project-buckets.js";

const organizationId = "11111111-1111-4111-8111-111111111111";
const ownerMembershipId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const bucketId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const projectId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const row = (overrides = {}) => ({
  id: bucketId,
  organization_id: organizationId,
  project_id: projectId,
  campaign_id: null,
  label: "Launch",
  default_position: 0,
  visible: true,
  position: 0,
  preference_version: null,
  ...overrides,
});

test("creates a tenant-bound presentation bucket with optional campaign linkage", async () => {
  const statements = [];
  const responses = [{}, {}, { rows: [row({ campaign_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" })] }, {}];
  const repository = new ProjectBucketRepository({ query: async (statement) => {
    statements.push(statement);
    return responses.shift() ?? {};
  } });
  const bucket = await repository.create({
    organizationId, ownerMembershipId, projectId,
    campaignId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    label: " Launch ", defaultPosition: 0,
  });
  assert.equal(bucket.label, "Launch");
  assert.equal(bucket.campaignId, "dddddddd-dddd-4ddd-8ddd-dddddddddddd");
  assert.ok(statements.some((statement) => statement.includes("memberships.role = 'owner'")));
});

test("lists owner preferences with visible defaults and deterministic order", async () => {
  const responses = [{}, {}, { rows: [row(), row({ id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", visible: false, position: 2, version: 3 })] }, {}];
  const repository = new ProjectBucketRepository({ query: async () => responses.shift() ?? {} });
  const buckets = await repository.listForOwner({ organizationId, ownerMembershipId });
  assert.deepEqual(buckets.map(({ visible, position }) => ({ visible, position })), [
    { visible: true, position: 0 },
    { visible: false, position: 2 },
  ]);
});

test("visibility updates only the preference row and preserves bucket-backed work", async () => {
  const statements = [];
  const responses = [{}, {}, {}, { rows: [{ bucket_id: bucketId }] }, { rows: [row({ visible: false, position: 4, preference_version: 2 })] }, {}];
  const repository = new ProjectBucketRepository({ query: async (statement) => {
    statements.push(statement);
    return responses.shift() ?? {};
  } });
  const saved = await repository.savePreference({
    organizationId, ownerMembershipId, bucketId, visible: false, position: 4, expectedVersion: 1,
  });
  assert.equal(saved.visible, false);
  assert.equal(saved.position, 4);
  assert.equal(saved.preferenceVersion, 2);
  const mutation = statements.find((statement) => statement.includes("project_bucket_preferences AS preference"));
  assert.match(mutation ?? "", /ON CONFLICT/);
  assert.doesNotMatch(mutation ?? "", /DELETE|assignments|work_items/i);
});

test("an unsaved default preference uses a null version for its first write", async () => {
  const responses = [
    {}, {}, { rows: [row()] }, {},
    {}, {}, {}, { rows: [{ bucket_id: bucketId }] }, { rows: [row({ visible: false, preference_version: 1 })] }, {},
  ];
  const repository = new ProjectBucketRepository({ query: async () => responses.shift() ?? {} });
  const [bucket] = await repository.listForOwner({ organizationId, ownerMembershipId });
  assert.equal(bucket?.preferenceVersion, null);
  const saved = await repository.savePreference({
    organizationId, ownerMembershipId, bucketId, visible: false, position: 0,
    expectedVersion: bucket?.preferenceVersion ?? null,
  });
  assert.equal(saved.preferenceVersion, 1);
});

test("stale, missing, cross-tenant, and non-owner preference writes fail closed", async () => {
  const responses = [{}, {}, { rows: [] }, {}];
  const repository = new ProjectBucketRepository({ query: async () => responses.shift() ?? {} });
  await assert.rejects(
    repository.savePreference({
      organizationId, ownerMembershipId, bucketId, visible: false, position: 0, expectedVersion: 8,
    }),
    (error) => error instanceof ProjectBucketWriteError && error.code === "NOT_FOUND_OR_STALE",
  );
});

