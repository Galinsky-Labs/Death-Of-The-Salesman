export const AGENT_ROSTER_PAGE_SIZE = 24;

export type RosterStatus = "running" | "waiting" | "inactive";
export type RosterStatusFilter = "all" | RosterStatus;

export type AgentEvidenceEvent = {
  readonly id: string;
  readonly occurredAt: string;
  readonly label: string;
  readonly result: string;
  readonly verified: boolean;
};

export type AgentDetail = {
  readonly currentTask: string;
  readonly strategy: string;
  readonly observedAt: string;
  readonly lastActivityAt: string;
  readonly spendMinor: number;
  readonly currency: string;
  readonly events: readonly AgentEvidenceEvent[];
};

export type RosterAgent = {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly assignedModel: string;
  readonly status: RosterStatus;
  readonly statusLabel: string;
  readonly availability: string;
  readonly detail: AgentDetail;
};

export type RosterPage = {
  readonly items: readonly RosterAgent[];
  readonly page: number;
  readonly pageCount: number;
  readonly total: number;
};

const normalized = (value: string): string => value.trim().toLocaleLowerCase("en-US");
const utcTimestamp = (value: string): boolean => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value));
const boundedText = (value: string): boolean => typeof value === "string" && value.trim().length > 0 && value.length <= 240;

export const verifiedAgentDetail = (agent: RosterAgent): AgentDetail => {
  const detail = agent.detail;
  if (!detail || !boundedText(detail.currentTask) || !boundedText(detail.strategy)) {
    throw new Error("Agent detail requires bounded task and strategy evidence");
  }
  if (!utcTimestamp(detail.observedAt) || !utcTimestamp(detail.lastActivityAt)
    || Date.parse(detail.lastActivityAt) > Date.parse(detail.observedAt)) {
    throw new Error("Agent detail timestamps must be canonical, ordered UTC evidence");
  }
  if (!Number.isSafeInteger(detail.spendMinor) || detail.spendMinor < 0
    || !/^[A-Z]{3}$/.test(detail.currency)) {
    throw new Error("Agent spend must use nonnegative integer minor units and ISO currency");
  }
  if (!Array.isArray(detail.events) || detail.events.length > 50) {
    throw new Error("Agent detail supports at most 50 evidence events");
  }
  const events = detail.events.filter((event) => {
    if (!event || !boundedText(event.id) || !boundedText(event.label) || !boundedText(event.result)
      || !utcTimestamp(event.occurredAt) || Date.parse(event.occurredAt) > Date.parse(detail.observedAt)) {
      throw new Error("Agent event evidence is malformed");
    }
    return event.verified === true;
  });
  return Object.freeze({ ...detail, events: Object.freeze(events.map((event) => Object.freeze({ ...event }))) });
};

export const filterRosterAgents = (
  agents: readonly RosterAgent[],
  query: string,
  status: RosterStatusFilter,
): readonly RosterAgent[] => {
  const search = normalized(query);
  return agents.filter((agent) => {
    if (status !== "all" && agent.status !== status) return false;
    if (!search) return true;
    return [agent.name, agent.role, agent.assignedModel, agent.availability, agent.statusLabel]
      .some((value) => normalized(value).includes(search));
  });
};

export const paginateRosterAgents = (
  agents: readonly RosterAgent[],
  requestedPage: number,
  pageSize = AGENT_ROSTER_PAGE_SIZE,
): RosterPage => {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new Error("pageSize must be an integer from 1 to 100");
  }
  const pageCount = Math.max(1, Math.ceil(agents.length / pageSize));
  const finitePage = Number.isSafeInteger(requestedPage) ? requestedPage : 1;
  const page = Math.min(pageCount, Math.max(1, finitePage));
  const start = (page - 1) * pageSize;
  return Object.freeze({
    items: agents.slice(start, start + pageSize),
    page,
    pageCount,
    total: agents.length,
  });
};
