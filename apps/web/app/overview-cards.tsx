import type { OverviewView } from "./overview-model";

/** Read-only, no polling, no provider calls, no fake production metrics. */
export function OverviewCards({ overview }: Readonly<{ overview: OverviewView }>) {
  return (
    <section className="overview-panel" aria-labelledby="overview-heading" id="overview">
      <div className="section-heading">
        <div>
          <p className="eyebrow">{overview.mode}</p>
          <h2 id="overview-heading">Operations overview</h2>
        </div>
        <p className="overview-timestamp">
          {overview.observedAt
            ? "Source observed " + overview.observedAt.replace("T", " ")
            : "No live production metrics connected"}
        </p>
      </div>
      <dl className="overview-kpis">
        {overview.metrics.map(metric => (
          <div className="overview-kpi" key={metric.key}>
            <dt>{metric.title}</dt>
            <dd className="overview-value">{metric.value}</dd>
            <dd className="overview-provenance">{metric.provenance}</dd>
            <dd className="overview-explanation">{metric.explanation}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
