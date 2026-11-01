/**
 * DOTS-028: no mocked data is permitted to look like production telemetry.
 * The data provider must explicitly mark server-backed observations verified;
 * an absent metric is unknown, never zero.
 */
export type OverviewMetric = {
  readonly key: string;
  readonly title: string;
  readonly value: string;
  readonly provenance: "Synthetic" | "Verified" | "Not connected" | "Configured";
  readonly explanation: string;
};

export type OverviewInput = {
  readonly source: "synthetic" | "verified";
  readonly observedAt: string | null;
  readonly agentIdentities: number | null;
  readonly runningAgents: number | null;
  readonly activeCampaigns: number | null;
  readonly contacts: number | null;
  readonly verifiedDeals: number | null;
  readonly receivedRevenueCents: number | null;
  readonly paidSpendingCapCents: number;
  readonly outboundEnabled: boolean;
};

export type OverviewView = {
  readonly mode: "Synthetic preview" | "Verified observation";
  readonly observedAt: string | null;
  readonly metrics: readonly OverviewMetric[];
};

const metricFields = [
  "agentIdentities",
  "runningAgents",
  "activeCampaigns",
  "contacts",
  "verifiedDeals",
  "receivedRevenueCents",
  "paidSpendingCapCents",
] as const;

function nonnegative(value: number | null, label: string): void {
  if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
    throw new Error(label + " must be a nonnegative safe integer or null");
  }
}

const dollars = (cents: number): string =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);

export function deriveOverview(input: OverviewInput): OverviewView {
  if (input.source !== "synthetic" && input.source !== "verified") {
    throw new Error("Unrecognized overview source");
  }
  for (const key of metricFields) nonnegative(input[key], key);
  if (typeof input.outboundEnabled !== "boolean") throw new Error("Invalid outbound capability");

  if (input.source === "synthetic") {
    if (input.observedAt !== null ||
        [input.runningAgents, input.activeCampaigns, input.contacts,
          input.verifiedDeals, input.receivedRevenueCents].some(value => value !== null) ||
        input.outboundEnabled || input.paidSpendingCapCents !== 0) {
      throw new Error("Synthetic preview must not claim live activity, revenue, outbound access, or paid budget");
    }
  } else if (!input.observedAt ||
             Number.isNaN(Date.parse(input.observedAt)) ||
             new Date(input.observedAt).toISOString() !== input.observedAt ||
             !input.observedAt.endsWith("Z")) {
    throw new Error("Verified overview requires a canonical UTC observation timestamp");
  }

  const measured = (key: string, title: string, value: number | null,
                    explanation: string, currency = false): OverviewMetric => ({
    key,
    title,
    value: value === null ? "—" : currency ? dollars(value) : value.toLocaleString("en-US"),
    provenance: value === null ? "Not connected" :
      input.source === "synthetic" ? "Synthetic" : "Verified",
    explanation: value === null
      ? "No verified production source is connected; this is not a zero."
      : explanation,
  });

  const metrics: OverviewMetric[] = [
      measured("agents", "Agent identities", input.agentIdentities,
        "Roster records in the stated source, not a count of running workers."),
      measured("running", "Running agents", input.runningAgents,
        "Requires a validated active lease and fresh worker heartbeat."),
      measured("campaigns", "Active campaigns", input.activeCampaigns,
        "Confirmed active campaign records, not merely draft plans."),
      measured("contacts", "CRM contacts", input.contacts,
        "Verified contact records; no synthetic contacts are counted as real."),
      measured("deals", "Verified deals", input.verifiedDeals,
        "Only evidence-backed closed deals count."),
      measured("revenue", "Received revenue", input.receivedRevenueCents,
        "Confirmed receipts, not forecasts, pledges, or generated pitches.", true),
      {
        key: "cap", title: "Allowed paid spend", value: dollars(input.paidSpendingCapCents),
        provenance: "Configured",
        explanation: "Spending authorization ceiling, not an incurred expense or invoice.",
      },
      {
        key: "dispatch", title: "Outbound messaging",
        value: input.outboundEnabled ? "Authorized" : "Disabled",
        provenance: "Configured",
        explanation: input.outboundEnabled
          ? "Additional consent, suppression, policy and send-approval gates still apply."
          : "No email, messaging, payment or model dispatch can be initiated by this preview.",
      },
  ];
  return Object.freeze({
    mode: input.source === "synthetic" ? "Synthetic preview" : "Verified observation",
    observedAt: input.observedAt,
    metrics: Object.freeze(metrics),
  });
}
