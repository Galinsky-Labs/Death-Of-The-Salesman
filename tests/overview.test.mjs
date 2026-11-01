import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { deriveOverview } from "../apps/web/app/overview-model.ts";

const synthetic = () => ({
  source: "synthetic",
  observedAt: null,
  agentIdentities: 2,
  runningAgents: null,
  activeCampaigns: null,
  contacts: null,
  verifiedDeals: null,
  receivedRevenueCents: null,
  paidSpendingCapCents: 0,
  outboundEnabled: false,
});

test("preview counts are explicitly synthetic and live values remain unknown", () => {
  const result = deriveOverview(synthetic());
  const find = key => result.metrics.find(metric => metric.key === key);
  assert.equal(result.mode, "Synthetic preview");
  assert.equal(find("agents")?.value, "2");
  assert.equal(find("agents")?.provenance, "Synthetic");
  for (const key of ["running", "campaigns", "contacts", "deals", "revenue"]) {
    assert.equal(find(key)?.value, "—");
    assert.equal(find(key)?.provenance, "Not connected");
    assert.match(find(key)?.explanation ?? "", /not a zero/);
  }
  assert.equal(find("cap")?.value, "$0.00");
  assert.equal(find("cap")?.provenance, "Configured");
  assert.equal(find("dispatch")?.value, "Disabled");
  assert.equal(result.metrics.length, 8);
});

test("synthetic telemetry cannot pretend to have income, campaigns, active agents or paid execution", () => {
  for (const change of [
    { observedAt: "2026-11-01T00:00:00.000Z" },
    { runningAgents: 0 }, { activeCampaigns: 1 }, { contacts: 1 },
    { verifiedDeals: 1 }, { receivedRevenueCents: 2500 },
    { paidSpendingCapCents: 1 }, { outboundEnabled: true },
  ]) assert.throws(() => deriveOverview({ ...synthetic(), ...change }), /Synthetic preview/);
});

test("verified observations retain explicit provenance and do not fake missing data", () => {
  const result = deriveOverview({
    ...synthetic(), source: "verified", observedAt: "2026-11-01T16:00:00.000Z",
    runningAgents: 0, activeCampaigns: 3, contacts: 12,
    verifiedDeals: 1, receivedRevenueCents: 125000,
  });
  const map = Object.fromEntries(result.metrics.map(item => [item.key, item]));
  assert.equal(result.mode, "Verified observation");
  assert.equal(map.running.provenance, "Verified");
  assert.equal(map.running.value, "0");
  assert.equal(map.campaigns.value, "3");
  assert.equal(map.revenue.value, "$1,250.00");
  assert.throws(() => deriveOverview({ ...synthetic(), source:"verified" }), /timestamp/);
  assert.throws(() => deriveOverview({ ...synthetic(), source:"verified", observedAt:"yesterday" }), /timestamp/);
  assert.throws(() => deriveOverview({ ...synthetic(), agentIdentities: -1 }), /nonnegative safe integer/);
});

test("overview is read-only, labeled and visible on responsive home without a fetch loop", async () => {
  const [page, cards, css] = await Promise.all([
    readFile(new URL("../apps/web/app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../apps/web/app/overview-cards.tsx", import.meta.url), "utf8"),
    readFile(new URL("../apps/web/app/styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(page, /<OverviewCards overview=\{overview\}/);
  assert.match(cards, /aria-labelledby="overview-heading"/);
  assert.match(cards, /<dl className="overview-kpis">/);
  assert.match(cards, /overview\.metrics\.map/);
  assert.doesNotMatch(cards, /fetch\(|setInterval\(|useEffect\(/);
  assert.match(css, /\.overview-kpis/);
  assert.match(css, /grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(css, /max-width: 767px/);
});
