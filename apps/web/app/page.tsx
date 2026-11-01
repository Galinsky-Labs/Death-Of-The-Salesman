import {
  AccessiblePopover,
  CommandButton,
  LoadingSkeleton,
  MetricBars,
  OverlayPanel,
  StatusChip,
} from "./ui-primitives";
import { AgentRoster, type RosterAgent } from "./agent-roster";
import { WorkspaceNavigation } from "./workspace-navigation";

const rosterAgents: readonly RosterAgent[] = [
  {
    id: "agent-fast-eddie-felson",
    name: "Fast Eddie Felson",
    role: "Synthetic sales strategist",
    assignedModel: "Not assigned",
    status: "waiting",
    statusLabel: "Waiting — no provider",
    availability: "No provider or campaign assigned",
    detail: {
      currentTask: "Awaiting an owner-approved synthetic campaign brief",
      strategy: "No strategy assigned; outbound and paid execution remain disabled",
      observedAt: "2026-10-26T08:20:00.000Z",
      lastActivityAt: "2026-10-26T08:18:00.000Z",
      spendMinor: 0,
      currency: "USD",
      events: [
        {
          id: "event-eddie-preview-ready",
          occurredAt: "2026-10-26T08:18:00.000Z",
          label: "Synthetic profile prepared",
          result: "Preview evidence recorded; no provider or campaign activated",
          verified: true,
        },
      ],
    },
  },
  {
    id: "agent-harry-wormwood",
    name: "Harry Wormwood",
    role: "Synthetic fundraising researcher",
    assignedModel: "Not assigned",
    status: "inactive",
    statusLabel: "Inactive — dispatch disabled",
    availability: "Outbound actions disabled",
    detail: {
      currentTask: "No active task",
      strategy: "Research remains disabled until owner authority and source policy are configured",
      observedAt: "2026-10-26T08:20:00.000Z",
      lastActivityAt: "2026-10-26T08:15:00.000Z",
      spendMinor: 0,
      currency: "USD",
      events: [
        {
          id: "event-harry-dispatch-disabled",
          occurredAt: "2026-10-26T08:15:00.000Z",
          label: "Dispatch gate checked",
          result: "Outbound actions remained disabled",
          verified: true,
        },
      ],
    },
  },
];

const services = [
  { name: "Web console", status: "Ready", state: "ready" },
  { name: "API", status: "Local only", state: "waiting" },
  { name: "Worker", status: "Disabled", state: "inactive" },
] as const;

export default function Home() {
  return (
    <WorkspaceNavigation>
      <main className="shell">
      <header className="shell-header">
        <div className="shell-copy">
          <p className="eyebrow">Synthetic component preview</p>
          <h1>Death Of The Salesman</h1>
          <p className="summary">
            Accessible workspace primitives are shown with synthetic, non-operational data. No
            model, message, contact, or paid integration is active.
          </p>
        </div>
        <StatusChip state="inactive" label="Zero-cost mode" />
      </header>

      <section className="primitive-section" aria-labelledby="agents-heading">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Agent roster</p>
            <h2 id="agents-heading">Search and inspect agents</h2>
          </div>
          <AccessiblePopover label="Status definitions">
            <dl className="definition-list">
              <div><dt>Running</dt><dd>A live lease and fresh heartbeat are verified.</dd></div>
              <div><dt>Waiting</dt><dd>A named prerequisite is still pending.</dd></div>
              <div><dt>Inactive</dt><dd>No worker or outbound activity is running.</dd></div>
            </dl>
          </AccessiblePopover>
        </div>
        <AgentRoster agents={rosterAgents} />
      </section>

      <section className="primitive-grid" aria-label="Chart, loading, and overlay primitives">
        <MetricBars
          id="synthetic-work-evidence"
          title="Synthetic work evidence"
          values={[
            { label: "Reviewed", value: 7, maximum: 10 },
            { label: "Waiting", value: 2, maximum: 10 },
            { label: "Blocked", value: 1, maximum: 10 },
          ]}
        />
        <LoadingSkeleton label="Loading synthetic campaign summary" />
        <OverlayPanel id="approval-details" title="Approval details">
          <p>Nothing can be sent from this preview. Owner authority, policy, facts, suppression, and budget remain required.</p>
        </OverlayPanel>
      </section>

      <section className="runtime" aria-labelledby="services-heading">
        <div className="runtime-heading">
          <h2 id="services-heading">Runtime boundaries</h2>
          <CommandButton aria-label="Refresh local runtime evidence">Refresh</CommandButton>
        </div>
        <dl className="runtime-list">
          {services.map((service) => (
            <div className="runtime-row" key={service.name}>
              <dt>{service.name}</dt>
              <dd><StatusChip state={service.state} label={service.status} /></dd>
            </div>
          ))}
        </dl>
      </section>
      </main>
    </WorkspaceNavigation>
  );
}
