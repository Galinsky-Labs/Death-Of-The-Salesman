import { type Client,type Context,rows,tenant,event,digest,fail } from "./common.js";
export class DurableQueue {
  constructor(private readonly client: Client,private readonly ctx: Context,readonly workerId: string) {}
  async claim() {return tenant(this.client,this.ctx,async tx=>{
    const candidate=rows(await tx.query(`SELECT q.* FROM app.task_queue q JOIN app.policy_controls p USING(organization_id)
      WHERE q.organization_id=$1 AND q.state='queued' AND q.available_at<=app.utc_now() AND q.attempts<q.max_attempts AND NOT p.paused
      ORDER BY q.priority DESC,q.created_at FOR UPDATE OF q SKIP LOCKED LIMIT 1`,[this.ctx.organizationId]))[0];if(!candidate)return null;
    const locked=rows(await tx.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired',[`queue-agent:${this.ctx.organizationId}:${candidate.agent_identity_id}`]))[0];if(!locked?.acquired)return null;
    const assignment=rows(await tx.query("SELECT a.concurrency_cap FROM app.agent_project_assignments a JOIN app.agent_identities i ON i.organization_id=a.organization_id AND i.id=a.agent_identity_id JOIN app.projects p ON p.organization_id=a.organization_id AND p.id=a.project_id WHERE a.organization_id=$1 AND a.agent_identity_id=$2 AND a.project_id=$3 AND i.status='active' AND p.status='active'",[this.ctx.organizationId,candidate.agent_identity_id,candidate.project_id]))[0];
    if(!assignment){await tx.query("UPDATE app.task_queue SET state='waiting',last_reason='ASSIGNMENT_INACTIVE' WHERE id=$1",[candidate.id]);return null;}
    const active=rows(await tx.query("SELECT count(*)::int AS total FROM app.task_queue WHERE organization_id=$1 AND agent_identity_id=$2 AND state='running' AND lease_expires_at>app.utc_now()",[this.ctx.organizationId,candidate.agent_identity_id]))[0]!;if(Number(active.total)>=Number(assignment.concurrency_cap))return null;
    const lease=rows(await tx.query("UPDATE app.task_queue SET state='running',attempts=attempts+1,fencing_token=fencing_token+1,lease_owner=$2,lease_expires_at=app.utc_now()+interval '45 seconds',heartbeat_at=app.utc_now(),updated_at=app.utc_now() WHERE id=$1 AND state='queued' RETURNING *",[candidate.id,this.workerId]))[0];
    if(!lease)return null;
    await event(tx,this.ctx,"task.claimed",lease.id,{fence:Number(lease.fencing_token)},"worker");return lease;
  });}
  async heartbeat(taskId: string, fence: number) {return tenant(this.client,this.ctx,async tx=>{
    const result=rows(await tx.query(`UPDATE app.task_queue SET heartbeat_at=app.utc_now(),lease_expires_at=app.utc_now()+interval '45 seconds'
      WHERE organization_id=$1 AND id=$2 AND fencing_token=$3 AND lease_owner=$4 AND state='running' AND lease_expires_at>app.utc_now() RETURNING id`,[this.ctx.organizationId,taskId,fence,this.workerId]));
    if(!result.length)return fail("LEASE_LOST");
  });}
  async startRun(taskId: string,fence: number,mode: string,modelId?: string) {return tenant(this.client,this.ctx,async tx=>{
    const result=rows(await tx.query(`INSERT INTO app.agent_runs(organization_id,task_id,fencing_token,mode,state,model_id)
      SELECT organization_id,id,fencing_token,$5,'running',$6 FROM app.task_queue WHERE organization_id=$1 AND id=$2 AND fencing_token=$3 AND lease_owner=$4 AND state='running' AND lease_expires_at>app.utc_now() RETURNING *`,[this.ctx.organizationId,taskId,fence,this.workerId,mode,modelId??null]))[0];
    if(!result)return fail("LEASE_LOST");return result;
  });}
  async checkpoint(runId: string,taskId: string,fence: number,sequence: number,state: Record<string,unknown>) {return tenant(this.client,this.ctx,async tx=>{
    const result=rows(await tx.query(`INSERT INTO app.run_checkpoints(organization_id,run_id,sequence,state,content_hash)
      SELECT $1::app.entity_id,$2::app.entity_id,$3,$4::jsonb,$5 FROM app.task_queue WHERE organization_id=$1 AND id=$6 AND fencing_token=$7 AND lease_owner=$8 AND state='running' AND lease_expires_at>app.utc_now()
      ON CONFLICT DO NOTHING RETURNING id`,[this.ctx.organizationId,runId,sequence,JSON.stringify(state),digest(state),taskId,fence,this.workerId]));
    if(!result.length)return fail("CHECKPOINT_CONFLICT");
  });}
  async finish(taskId: string,fence: number,runId: string,result: Record<string,unknown>,state="completed",reason?: string) {return tenant(this.client,this.ctx,async tx=>{
    if(!["completed","failed","quarantined"].includes(state))return fail("INVALID_RUN_STATE",400);
    const task=rows(await tx.query(`UPDATE app.task_queue SET state=$5,last_reason=$6,lease_expires_at=NULL,updated_at=app.utc_now()
      WHERE organization_id=$1 AND id=$2 AND fencing_token=$3 AND lease_owner=$4 AND state='running' AND lease_expires_at>app.utc_now() RETURNING id`,[this.ctx.organizationId,taskId,fence,this.workerId,state,reason??null]));
    if(!task.length)return fail("LEASE_LOST");
    await tx.query("UPDATE app.agent_runs SET state=$3,result=$4::jsonb,reason_code=$5,ended_at=app.utc_now() WHERE organization_id=$1 AND id=$2",[this.ctx.organizationId,runId,state,JSON.stringify(result),reason??null]);
    await event(tx,this.ctx,`task.${state}`,taskId,{runId,reasonCode:reason??"OK"},"worker");
  });}
  async recoverExpired() {return tenant(this.client,this.ctx,async tx=>{
    const lost=rows(await tx.query("UPDATE app.task_queue SET state='quarantined',last_reason='LEASE_EXPIRED',updated_at=app.utc_now() WHERE organization_id=$1 AND state='running' AND lease_expires_at<=app.utc_now() RETURNING id",[this.ctx.organizationId]));
    for(const task of lost){await tx.query("UPDATE app.agent_runs SET state='quarantined',reason_code='LEASE_EXPIRED',ended_at=app.utc_now() WHERE organization_id=$1 AND task_id=$2 AND state='running'",[this.ctx.organizationId,task.id]);await event(tx,this.ctx,"task.quarantined",task.id,{reasonCode:"LEASE_EXPIRED"},"worker");}
    return lost.length;
  });}
  async cancel(taskId: string) {return tenant(this.client,this.ctx,async tx=>{
    const result=rows(await tx.query("UPDATE app.task_queue SET state='cancelled',last_reason='OWNER_CANCELLED',fencing_token=fencing_token+1,lease_expires_at=NULL,updated_at=app.utc_now() WHERE organization_id=$1 AND id=$2 AND state IN ('queued','waiting','running') RETURNING id",[this.ctx.organizationId,taskId]));
    if(!result.length)return fail("TASK_NOT_CANCELLABLE");await tx.query("UPDATE app.agent_runs SET state='quarantined',reason_code='OWNER_CANCELLED',ended_at=app.utc_now() WHERE organization_id=$1 AND task_id=$2 AND state='running'",[this.ctx.organizationId,taskId]);await event(tx,this.ctx,"task.cancelled",taskId);
  });}
}
