import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { verifiedAgentDetail } from "../apps/web/app/agent-roster-model.ts";

const agent = {
  id: "agent-1", name: "Synthetic Agent", role: "Researcher", assignedModel: "None",
  status: "waiting", statusLabel: "Waiting", availability: "Awaiting review",
  detail: {
    currentTask: "Review synthetic evidence", strategy: "No outbound action",
    observedAt: "2026-10-26T08:20:00.000Z", lastActivityAt: "2026-10-26T08:19:00.000Z",
    spendMinor: 0, currency: "USD",
    events: [
      { id: "verified", occurredAt: "2026-10-26T08:19:00.000Z", label: "Review", result: "Passed", verified: true },
      { id: "claim", occurredAt: "2026-10-26T08:18:00.000Z", label: "Claim", result: "Unverified", verified: false },
    ],
  },
};

test("detail preview exposes only verified event evidence", () => {
  const detail = verifiedAgentDetail(agent);
  assert.deepEqual(detail.events.map((event) => event.id), ["verified"]);
  assert.equal(detail.spendMinor, 0);
  assert.equal(Object.isFrozen(detail.events), true);
});

test("malformed timestamps, future events, spend, and oversized histories fail closed", () => {
  assert.throws(() => verifiedAgentDetail({ ...agent, detail: { ...agent.detail, lastActivityAt: "later" } }), /timestamps/);
  assert.throws(() => verifiedAgentDetail({ ...agent, detail: { ...agent.detail, spendMinor: 0.5 } }), /integer minor/);
  assert.throws(() => verifiedAgentDetail({ ...agent, detail: { ...agent.detail, events: [{ ...agent.detail.events[0], occurredAt: "2026-10-26T08:21:00.000Z" }] } }), /event evidence/);
  assert.throws(() => verifiedAgentDetail({ ...agent, detail: { ...agent.detail, events: Array(51).fill(agent.detail.events[0]) } }), /at most 50/);
});

test("roster provides hover/focus preview and a keyboard/tap dialog", async () => {
  const source = await readFile(new URL("../apps/web/app/agent-roster.tsx", import.meta.url), "utf8");
  for (const contract of [
    'aria-haspopup="dialog"', 'role="dialog"', 'aria-modal="true"', 'event.key === "Escape"',
    "onClick={() => setSelectedId(agent.id)}", "Latest verified event", "Recorded spend",
    'aria-label="Close agent detail"',
  ]) assert.ok(source.includes(contract), `missing agent detail contract: ${contract}`);
});
