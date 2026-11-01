"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  AGENT_ROSTER_PAGE_SIZE,
  filterRosterAgents,
  paginateRosterAgents,
  verifiedAgentDetail,
  type RosterAgent,
  type RosterStatusFilter,
} from "./agent-roster-model";

export type { RosterAgent } from "./agent-roster-model";

const statusOptions: readonly { value: RosterStatusFilter; label: string }[] = [
  { value: "all", label: "All statuses" },
  { value: "running", label: "Running" },
  { value: "waiting", label: "Waiting" },
  { value: "inactive", label: "Inactive" },
];

const initials = (name: string): string => name
  .split(/\s+/)
  .filter(Boolean)
  .map((part) => part[0])
  .join("")
  .slice(0, 2)
  .toLocaleUpperCase("en-US");

const money = (minor: number, currency: string): string => new Intl.NumberFormat("en-US", {
  style: "currency",
  currency,
}).format(minor / 100);

export function AgentRoster({ agents }: Readonly<{ agents: readonly RosterAgent[] }>) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<RosterStatusFilter>("all");
  const [requestedPage, setRequestedPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const selected = selectedId ? agents.find((agent) => agent.id === selectedId) ?? null : null;
  const selectedDetail = selected ? verifiedAgentDetail(selected) : null;

  const filtered = useMemo(
    () => filterRosterAgents(agents, query, status),
    [agents, query, status],
  );
  const rosterPage = useMemo(
    () => paginateRosterAgents(filtered, requestedPage),
    [filtered, requestedPage],
  );

  useEffect(() => {
    if (requestedPage !== rosterPage.page) setRequestedPage(rosterPage.page);
  }, [requestedPage, rosterPage.page]);

  useEffect(() => {
    if (!selected) return;
    closeRef.current?.focus();
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        const index = rosterPage.items.findIndex((agent) => agent.id === selected.id);
        setSelectedId(null);
        requestAnimationFrame(() => itemRefs.current[index]?.focus());
      }
    };
    globalThis.addEventListener("keydown", closeOnEscape);
    return () => globalThis.removeEventListener("keydown", closeOnEscape);
  }, [selected]);

  const resetPage = () => setRequestedPage(1);
  const closeDrawer = () => {
    const prior = selectedId;
    setSelectedId(null);
    requestAnimationFrame(() => {
      const index = rosterPage.items.findIndex((agent) => agent.id === prior);
      itemRefs.current[index]?.focus();
    });
  };

  const moveFocus = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = rosterPage.items.length - 1;
    let next = index;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = Math.min(last, index + 1);
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = Math.max(0, index - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    else return;
    event.preventDefault();
    itemRefs.current[next]?.focus();
  };

  const firstVisible = rosterPage.total === 0
    ? 0
    : (rosterPage.page - 1) * AGENT_ROSTER_PAGE_SIZE + 1;
  const lastVisible = Math.min(rosterPage.page * AGENT_ROSTER_PAGE_SIZE, rosterPage.total);

  return (
    <div className="agent-roster">
      <div className="roster-controls">
        <label>
          <span>Search agents</span>
          <input
            type="search"
            value={query}
            placeholder="Name, role, model, or availability"
            onChange={(event) => {
              setQuery(event.target.value);
              resetPage();
            }}
          />
        </label>
        <label>
          <span>Status</span>
          <select
            value={status}
            onChange={(event) => {
              setStatus(event.target.value as RosterStatusFilter);
              resetPage();
            }}
          >
            {statusOptions.map((option) => (
              <option value={option.value} key={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="roster-summary" aria-live="polite" aria-atomic="true">
        {rosterPage.total === 0
          ? "No agents match the current filters."
          : `Showing ${firstVisible}-${lastVisible} of ${rosterPage.total} agents.`}
      </div>

      {rosterPage.total > 0 ? (
        <div className="roster-grid" role="list" aria-label="Filtered agent roster">
          {rosterPage.items.map((agent, index) => {
            const detail = verifiedAgentDetail(agent);
            const latest = detail.events.at(0);
            return (
              <article className="roster-tile" role="listitem" key={agent.id}>
                <button
                  ref={(node) => { itemRefs.current[index] = node; }}
                  className="roster-tile-action"
                  type="button"
                  aria-labelledby={`${agent.id}-name`}
                  aria-describedby={`${agent.id}-details ${agent.id}-preview`}
                  aria-haspopup="dialog"
                  onClick={() => setSelectedId(agent.id)}
                  onKeyDown={(event) => moveFocus(event, index)}
                >
                  <span className="roster-avatar" aria-hidden="true">{initials(agent.name)}</span>
                  <span className="roster-identity">
                    <strong id={`${agent.id}-name`}>{agent.name}</strong>
                    <span>{agent.role}</span>
                  </span>
                  <span className="roster-status" data-state={agent.status}>
                    <span className="status-light" aria-hidden="true" />
                    <span>{agent.statusLabel}</span>
                  </span>
                  <span className="roster-details" id={`${agent.id}-details`}>
                    <span><b>Model</b>{agent.assignedModel}</span>
                    <span><b>Availability</b>{agent.availability}</span>
                  </span>
                  <span className="roster-quick-preview" id={`${agent.id}-preview`}>
                    <b>Current task</b>
                    <span>{detail.currentTask}</span>
                    <b>Latest verified event</b>
                    <span>{latest ? `${latest.label}: ${latest.result}` : "No verified event evidence"}</span>
                  </span>
                </button>
              </article>
            );
          })}
        </div>
      ) : (
        <p className="roster-empty">Try a broader search or another status.</p>
      )}

      <nav className="roster-pagination" aria-label="Agent roster pages">
        <button
          type="button"
          disabled={rosterPage.page === 1}
          onClick={() => setRequestedPage((value) => Math.max(1, value - 1))}
        >
          Previous
        </button>
        <span>Page {rosterPage.page} of {rosterPage.pageCount}</span>
        <button
          type="button"
          disabled={rosterPage.page === rosterPage.pageCount}
          onClick={() => setRequestedPage((value) => Math.min(rosterPage.pageCount, value + 1))}
        >
          Next
        </button>
      </nav>

      {selected && selectedDetail ? (
        <div className="agent-drawer-backdrop" onMouseDown={(event) => {
          if (event.currentTarget === event.target) closeDrawer();
        }}>
          <aside
            className="agent-detail-drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="agent-detail-title"
            onKeyDown={(event) => {
              if (event.key === "Tab") {
                event.preventDefault();
                closeRef.current?.focus();
              }
            }}
          >
            <div className="agent-detail-heading">
              <div>
                <p className="eyebrow">Verified agent detail</p>
                <h3 id="agent-detail-title">{selected.name}</h3>
                <p>{selected.statusLabel}</p>
              </div>
              <button ref={closeRef} type="button" onClick={closeDrawer} aria-label="Close agent detail">×</button>
            </div>
            <dl className="agent-detail-facts">
              <div><dt>Current task</dt><dd>{selectedDetail.currentTask}</dd></div>
              <div><dt>Strategy</dt><dd>{selectedDetail.strategy}</dd></div>
              <div><dt>Last activity</dt><dd><time dateTime={selectedDetail.lastActivityAt}>{selectedDetail.lastActivityAt}</time></dd></div>
              <div><dt>Observed</dt><dd><time dateTime={selectedDetail.observedAt}>{selectedDetail.observedAt}</time></dd></div>
              <div><dt>Recorded spend</dt><dd>{money(selectedDetail.spendMinor, selectedDetail.currency)}</dd></div>
            </dl>
            <section aria-labelledby="agent-events-title">
              <h4 id="agent-events-title">Verified events and results</h4>
              {selectedDetail.events.length ? (
                <ol className="agent-event-list">
                  {selectedDetail.events.map((event) => (
                    <li key={event.id}>
                      <time dateTime={event.occurredAt}>{event.occurredAt}</time>
                      <strong>{event.label}</strong>
                      <span>{event.result}</span>
                    </li>
                  ))}
                </ol>
              ) : <p>No verified event evidence is available.</p>}
            </section>
          </aside>
        </div>
      ) : null}
    </div>
  );
}
