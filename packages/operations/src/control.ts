import { type Client,type Context,rows,tenant,event,outbox,cents,text,digest,fail,randomUUID } from "./common.js";
export class ControlPlane {
  constructor(private readonly client: Client,private readonly ctx: Context) {}
  async initialize() {return tenant(this.client,this.ctx,async tx=>{
    await tx.query("INSERT INTO app.policy_controls(organization_id,updated_by_membership_id) VALUES($1,$2) ON CONFLICT DO NOTHING",[this.ctx.organizationId,this.ctx.membershipId]);
    await tx.query("INSERT INTO app.spending_policies(organization_id,updated_by_membership_id) VALUES($1,$2) ON CONFLICT DO NOTHING",[this.ctx.organizationId,this.ctx.membershipId]);
  });}
  async pause(paused: boolean) {return tenant(this.client,this.ctx,async tx=>{
    await tx.query("UPDATE app.policy_controls SET paused=$2,version=version+1,updated_by_membership_id=$3,updated_at=app.utc_now() WHERE organization_id=$1",[this.ctx.organizationId,paused,this.ctx.membershipId]);
    if(paused)await tx.query("UPDATE app.task_queue SET state='waiting',last_reason='OWNER_PAUSED',updated_at=app.utc_now() WHERE organization_id=$1 AND state='queued'",[this.ctx.organizationId]);
    else await tx.query("UPDATE app.task_queue SET state='queued',last_reason=NULL,available_at=app.utc_now(),updated_at=app.utc_now() WHERE organization_id=$1 AND state='waiting' AND last_reason='OWNER_PAUSED'",[this.ctx.organizationId]);
    await event(tx,this.ctx,paused?"runtime.paused":"runtime.resumed",null);
  });}
  async setBudget(limit: number, authorization: string|undefined, hardCap: number, projectId: string|null=null) {
    cents(limit);cents(hardCap);if(limit>hardCap || (limit>0&&!authorization))return fail("SPEND_NOT_AUTHORIZED",403);
    return tenant(this.client,this.ctx,async tx=>{
      const result=rows(await tx.query(`INSERT INTO app.spending_policies(organization_id,project_id,limit_cents,authorization_ref,updated_by_membership_id)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT (organization_id,project_id) DO UPDATE SET limit_cents=$3,authorization_ref=$4,version=app.spending_policies.version+1,updated_at=app.utc_now()
        WHERE app.spending_policies.spent_cents+app.spending_policies.reserved_cents<=$3 RETURNING id`,[this.ctx.organizationId,projectId,limit,authorization??null,this.ctx.membershipId]));
      if(!result.length)return fail("BUDGET_BELOW_COMMITTED");await event(tx,this.ctx,"budget.updated",result[0]!.id,{limitCents:limit});return result[0]!.id;
    });
  }
  async reserve(key: string, amount: number, projectId: string|null=null) {
    cents(amount);text(key,"idempotency_key",200);
    return tenant(this.client,this.ctx,async tx=>{
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`budget:${this.ctx.organizationId}`]);
      const prior=rows(await tx.query("SELECT * FROM app.budget_reservations WHERE organization_id=$1 AND idempotency_key=$2",[this.ctx.organizationId,key]))[0];
      if(prior){if(Number(prior.estimate_cents)!==amount)return fail("IDEMPOTENCY_CONFLICT");return prior;}
      const policies=rows(await tx.query("SELECT * FROM app.spending_policies WHERE organization_id=$1 AND (project_id IS NULL OR project_id=$2) ORDER BY project_id NULLS FIRST FOR UPDATE",[this.ctx.organizationId,projectId]));
      if(!policies.some(p=>p.project_id===null))return fail("BUDGET_UNCONFIGURED");
      for(const p of policies)if(Number(p.reserved_cents)+Number(p.spent_cents)+amount>Number(p.limit_cents))return fail("BUDGET_EXCEEDED");
      const reservation=rows(await tx.query("INSERT INTO app.budget_reservations(organization_id,policy_id,idempotency_key,estimate_cents) VALUES($1,$2,$3,$4) RETURNING *",[this.ctx.organizationId,policies[0]!.id,key,amount]))[0]!;
      for(const p of policies){await tx.query("UPDATE app.spending_policies SET reserved_cents=reserved_cents+$2 WHERE id=$1",[p.id,amount]);await tx.query("INSERT INTO app.reservation_policy_links(organization_id,reservation_id,policy_id) VALUES($1,$2,$3)",[this.ctx.organizationId,reservation.id,p.id]);}
      return reservation;
    });
  }
  async settle(id: string, actual: number, evidence: string, release=false,source?:"provider"|"simulation") {
    cents(actual);text(evidence,"evidence",240);
    return tenant(this.client,this.ctx,async tx=>{
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`budget:${this.ctx.organizationId}`]);
      const reservation=rows(await tx.query("SELECT * FROM app.budget_reservations WHERE organization_id=$1 AND id=$2 FOR UPDATE",[this.ctx.organizationId,id]))[0];
      if(!reservation)return fail("NOT_FOUND",404);
      if(reservation.status!=="reserved"){if(reservation.status===(release?"released":"settled")&&Number(reservation.actual_cents)===actual)return reservation;return fail("RESERVATION_ALREADY_FINAL");}
      if(actual>Number(reservation.estimate_cents))return fail("USAGE_EXCEEDS_RESERVATION");
      await tx.query("UPDATE app.spending_policies SET reserved_cents=reserved_cents-$2,spent_cents=spent_cents+$3 WHERE id IN(SELECT policy_id FROM app.reservation_policy_links WHERE organization_id=$1 AND reservation_id=$4)",[this.ctx.organizationId,Number(reservation.estimate_cents),release?0:actual,id]);
      const result=rows(await tx.query("UPDATE app.budget_reservations SET status=$3,actual_cents=$4,settled_at=app.utc_now() WHERE organization_id=$1 AND id=$2 RETURNING *",[this.ctx.organizationId,id,release?"released":"settled",actual]))[0];
      if(!release)await tx.query("INSERT INTO app.money_entries(organization_id,reservation_id,idempotency_key,kind,amount_cents,source,evidence_ref) VALUES($1,$2,$3,'expense',$4,$5,$6)",[this.ctx.organizationId,id,`settle:${id}`,actual,source??(actual===0?"simulation":"provider"),evidence]);
      await event(tx,this.ctx,release?"budget.released":"budget.settled",id,{actualCents:actual});return result;
    });
  }
  async requestApproval(kind: string, recordId: string, payload: unknown) {
    return tenant(this.client,this.ctx,async tx=>{
      const policy=rows(await tx.query("SELECT version FROM app.policy_controls WHERE organization_id=$1",[this.ctx.organizationId]))[0];if(!policy)return fail("POLICY_UNCONFIGURED");
      const result=rows(await tx.query("INSERT INTO app.action_approvals(organization_id,action_kind,record_id,payload_hash,policy_version,requested_by_membership_id,proposed_payload) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING *",[this.ctx.organizationId,kind,recordId,digest(payload),policy.version,this.ctx.membershipId,JSON.stringify(payload)]))[0];
      await event(tx,this.ctx,"approval.requested",result!.id,{kind});return result;
    });
  }
  async decideApproval(id: string, approved: boolean) {return tenant(this.client,this.ctx,async tx=>{
    const result=rows(await tx.query("UPDATE app.action_approvals SET status=$3,decided_at=app.utc_now(),decided_by_membership_id=$4 WHERE organization_id=$1 AND id=$2 AND status='pending' AND expires_at>app.utc_now() RETURNING *",[this.ctx.organizationId,id,approved?"approved":"rejected",this.ctx.membershipId]))[0];
    if(!result)return fail("APPROVAL_STALE");await event(tx,this.ctx,approved?"approval.approved":"approval.rejected",id);return result;
  });}
  async enqueue(projectId: string, agentId: string, kind: string, payload: Record<string,unknown>, key:string=randomUUID()) {
    return tenant(this.client,this.ctx,async tx=>{
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`enqueue:${this.ctx.organizationId}:${agentId}`]);
      const authority=rows(await tx.query(`SELECT a.id,a.quota_limit,a.concurrency_cap FROM app.agent_project_assignments a JOIN app.projects p ON p.id=a.project_id AND p.organization_id=a.organization_id JOIN app.agent_identities i ON i.id=a.agent_identity_id AND i.organization_id=a.organization_id
        WHERE a.organization_id=$1 AND a.project_id=$2 AND a.agent_identity_id=$3 AND p.status='active' AND i.status='active'`,[this.ctx.organizationId,projectId,agentId]));
      if(!authority.length)return fail("ASSIGN_AGENT_FIRST",400);
      const prior=rows(await tx.query("SELECT * FROM app.task_queue WHERE organization_id=$1 AND idempotency_key=$2",[this.ctx.organizationId,key]))[0];
      if(prior){if(prior.project_id!==projectId || prior.agent_identity_id!==agentId || prior.kind!==kind || digest(prior.payload)!==digest(payload))return fail("IDEMPOTENCY_CONFLICT");return prior;}
      const pending=rows(await tx.query("SELECT count(*)::int AS total FROM app.task_queue WHERE organization_id=$1 AND project_id=$2 AND agent_identity_id=$3 AND state IN ('queued','running','waiting')",[this.ctx.organizationId,projectId,agentId]))[0]!;
      if(Number(pending.total)>=Number(authority[0]!.quota_limit))return fail('ASSIGNMENT_QUEUE_LIMIT');
      const daily=rows(await tx.query("SELECT count(*)::int AS total FROM app.task_queue WHERE organization_id=$1 AND agent_identity_id=$2 AND created_at>=date_trunc('day',app.utc_now()) AND state<>'cancelled'",[this.ctx.organizationId,agentId]))[0]!;
      const config=rows(await tx.query('SELECT daily_task_limit FROM app.agent_configuration WHERE organization_id=$1 AND agent_identity_id=$2',[this.ctx.organizationId,agentId]))[0];if(Number(daily.total)>=Number(config?.daily_task_limit??10))return fail('AGENT_DAILY_QUOTA');
      const task=rows(await tx.query("INSERT INTO app.task_queue(organization_id,project_id,agent_identity_id,idempotency_key,kind,payload) VALUES($1,$2,$3,$4,$5,$6::jsonb) RETURNING *",[this.ctx.organizationId,projectId,agentId,key,kind,JSON.stringify(payload)]))[0]!;
      await event(tx,this.ctx,"task.queued",task.id,{kind});await outbox(tx,this.ctx,`task:${task.id}`,"task.queued",{taskId:task.id});return task;
    });
  }
  async consumeApproval(tx: Client, approvalId: string, kind: string, recordId: string, payload: unknown) {
    const approved=rows(await tx.query(`UPDATE app.action_approvals a SET status='consumed' FROM app.policy_controls p WHERE a.organization_id=$1 AND a.id=$2 AND a.action_kind=$3 AND a.record_id=$4 AND a.payload_hash=$5 AND a.status='approved' AND a.expires_at>app.utc_now() AND p.organization_id=a.organization_id AND p.version=a.policy_version AND NOT p.paused RETURNING a.id`,[this.ctx.organizationId,approvalId,kind,recordId,digest(payload)]));
    if(!approved.length)return fail("APPROVAL_INVALID",403);
  }
}
