export type BoardAgent = { id: string; displayName: string; status: string };
export type BoardBucket = { id: string; projectId: string; campaignId: string | null; label: string; visible: boolean; position: number; preferenceVersion: number | null };
export type BoardAssignment = { id: string; organizationId: string; agentIdentityId: string; projectId: string; campaignId: string | null; priority: number; allocationBasisPoints: number; quotaLimit: number; concurrencyCap: number; version: number; updatedAt: string };
export type BoardSnapshot = { agents: BoardAgent[]; buckets: BoardBucket[]; assignments: BoardAssignment[] };
export type DropIntent = { agentIdentityId: string; assignmentId: string | null; bucketId: string; allocationBasisPoints: number; priority: number; quotaLimit: number; concurrencyCap: number };
export const assignmentsIn = (board: BoardSnapshot, bucket: BoardBucket): BoardAssignment[] => board.assignments.filter(a => a.projectId === bucket.projectId && a.campaignId === bucket.campaignId);
export function prepareDrop(board: BoardSnapshot, intent: DropIntent) {
  const agent = board.agents.find(a => a.id === intent.agentIdentityId && a.status === "active");
  const bucket = board.buckets.find(b => b.id === intent.bucketId && b.visible);
  const prior = intent.assignmentId ? board.assignments.find(a => a.id === intent.assignmentId && a.agentIdentityId === intent.agentIdentityId) : undefined;
  if (!agent || !bucket || (intent.assignmentId && !prior)) throw new Error("Agent or checked bucket is unavailable. Reload the board.");
  if (board.assignments.some(a => a.id !== prior?.id && a.agentIdentityId === agent.id && a.projectId === bucket.projectId && a.campaignId === bucket.campaignId)) throw new Error("This agent is already assigned to this bucket.");
  if (!Number.isSafeInteger(intent.allocationBasisPoints) || intent.allocationBasisPoints < 1 || intent.allocationBasisPoints > 10000 || !Number.isSafeInteger(intent.priority) || intent.priority < 0 || intent.priority > 100 || !Number.isSafeInteger(intent.quotaLimit) || intent.quotaLimit < 1 || !Number.isSafeInteger(intent.concurrencyCap) || intent.concurrencyCap < 1 || intent.concurrencyCap > 1000) throw new Error("Enter valid allocation, priority, quota and concurrency values.");
  const allocated = board.assignments.filter(a => a.agentIdentityId === agent.id && a.id !== prior?.id).reduce((sum, a) => sum + a.allocationBasisPoints, 0);
  if (allocated + intent.allocationBasisPoints > 10000) throw new Error("Combined allocation cannot exceed 100%. Hidden buckets still count.");
  const input = { ...(prior ? { id: prior.id } : {}), agentIdentityId: agent.id, bucketId: bucket.id, allocationBasisPoints: intent.allocationBasisPoints, priority: intent.priority, quotaLimit: intent.quotaLimit, concurrencyCap: intent.concurrencyCap, expectedVersion: prior?.version ?? null };
  const optimistic: BoardAssignment = { id: prior?.id ?? "pending", organizationId: prior?.organizationId ?? "", agentIdentityId: agent.id, projectId: bucket.projectId, campaignId: bucket.campaignId, allocationBasisPoints: intent.allocationBasisPoints, priority: intent.priority, quotaLimit: intent.quotaLimit, concurrencyCap: intent.concurrencyCap, version: prior?.version ?? 0, updatedAt: prior?.updatedAt ?? "" };
  return { input, optimistic: { ...board, assignments: [...board.assignments.filter(a => a.id !== prior?.id), optimistic] } };
}
export const EMPTY_BOARD: BoardSnapshot = { agents: [], buckets: [], assignments: [] };
