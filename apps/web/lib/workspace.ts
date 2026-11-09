import { AgentProjectAssignmentRepository, ProjectCatalogRepository, type TransactionClient } from "@dots/database";
import { database, inWorkspace, tenant } from "./database";

export type Project = { id: string; label: string; content: { description?: string; category?: string }; version: number };
export type Agent = { id: string; display_name: string; status: string };
export type Assignment = { id: string; agent_identity_id: string; project_id: string; allocation_basis_points: number; version: number };
export type Activity = { id: string; event_type: string; occurred_at: string };
export type WorkspaceData = { projects: Project[]; agents: Agent[]; assignments: Assignment[]; activity: Activity[]; observedAt: string };

export async function loadWorkspace(): Promise<WorkspaceData> {
  return inWorkspace(async client => {
    const projects = await client.query("SELECT id,label,content,version::int FROM app.projects WHERE status='active' ORDER BY created_at DESC LIMIT 200");
    const agents = await client.query("SELECT id,display_name,status FROM app.agent_identities WHERE status <> 'archived' ORDER BY approved_name_id DESC LIMIT 264");
    const assignments = await client.query("SELECT id,agent_identity_id,project_id,allocation_basis_points,version::int FROM app.agent_project_assignments ORDER BY created_at LIMIT 2000");
    const activity = await client.query("SELECT id,event_type,occurred_at FROM app.audit_events ORDER BY occurred_at DESC,id DESC LIMIT 12");
    return { projects: projects.rows, agents: agents.rows, assignments: assignments.rows,
      activity: activity.rows.map(row=>({...row,occurred_at:new Date(row.occurred_at).toISOString()})), observedAt: new Date().toISOString() };
  });
}

async function repositoryOperation<T>(operation: (client: TransactionClient) => Promise<T>) {
  const client = await database().connect();
  const owner = tenant();
  const scoped: TransactionClient = {
    async query(statement, values) {
      const result = await client.query(statement, values ? [...values] : undefined);
      if (statement === "BEGIN") {
        await client.query("SET LOCAL ROLE dots_runtime");
        await client.query("SELECT set_config('app.organization_id',$1,true), set_config('app.audit_actor_membership_id',$2,true)",
          [owner.organizationId,owner.ownerMembershipId]);
      }
      return result;
    },
  };
  try { return await operation(scoped); }
  finally {
    // Also clears a transaction if initialization failed before the repository's try block.
    await client.query("ROLLBACK");
    client.release();
  }
}

export async function createProject(label: string, description: string, category: string) {
  return repositoryOperation(client => new ProjectCatalogRepository(client).create({
    ...tenant(), kind:"project", label, content:{description,category},
  }));
}

export async function archiveProject(id: string, expectedVersion: number) {
  return inWorkspace(async client => {
    const locked = await client.query("SELECT id FROM app.projects WHERE id=$1 AND version=$2 AND status='active' FOR UPDATE",[id,expectedVersion]);
    if (!locked.rows.length) throw new Error("NOT_FOUND_OR_STALE");
    const assigned = await client.query("SELECT id FROM app.agent_project_assignments WHERE project_id=$1 LIMIT 1",[id]);
    if (assigned.rows.length) throw new Error("PROJECT_HAS_ASSIGNMENTS");
    await client.query("UPDATE app.projects SET status='archived',version=version+1,updated_at=app.utc_now(),updated_by_membership_id=$2 WHERE id=$1",[id,tenant().ownerMembershipId]);
  });
}

export async function assignAgent(agentIdentityId: string, projectId: string, allocationBasisPoints: number) {
  return repositoryOperation(client => new AgentProjectAssignmentRepository(client).save({
    ...tenant(),agentIdentityId,projectId,allocationBasisPoints,priority:50,quotaLimit:1,concurrencyCap:1,expectedVersion:null,
  }));
}

export async function removeAssignment(id: string, expectedVersion: number) {
  return inWorkspace(async client => {
    const result = await client.query("DELETE FROM app.agent_project_assignments WHERE id=$1 AND version=$2 RETURNING id",[id,expectedVersion]);
    if (!result.rows.length) throw new Error("NOT_FOUND_OR_STALE");
  });
}
