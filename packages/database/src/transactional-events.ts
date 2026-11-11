import {createHash,randomUUID} from "node:crypto";
import {withTransaction,type TransactionClient} from "./index.js";
import {setAuditContext,type AuditContext} from "./audit-events.js";
export type EventReferences={recordId:string;recordType:string;version?:string;status?:string;evidenceHash?:string};
export type VerifiedSourceEvent={consumer:string;source:string;externalEventId:string;eventType:string;references:EventReferences};
export type OutboxEvent={schemaVersion:1;id:string;organizationId:string;auditEventId:string;eventType:string;correlationId:string;evidenceHash:string;occurredAt:string};
export type ClaimedOutboxEvent={event:OutboxEvent;claimToken:string;attempts:number};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const name=/^[a-z][a-z0-9_.:-]{0,63}$/;
const matches=(value:unknown,pattern:RegExp):value is string=>typeof value==="string"&&pattern.test(value);
const rows=(result:unknown)=>(result as {rows:Record<string,unknown>[]}).rows;
/** Call only after provider signature/audience/age validation in a trusted adapter. */
export function sourceEventSnapshot(value:VerifiedSourceEvent):Readonly<VerifiedSourceEvent>{
 if(!value||!matches(value.consumer,name)||!matches(value.source,name)||
  !matches(value.externalEventId,/^[A-Za-z0-9_.:/-]{1,200}$/)||!matches(value.eventType,name)||
  !value.references||Object.keys(value.references).some(key=>!["recordId","recordType","version","status","evidenceHash"].includes(key)))throw new Error("Invalid verified source event");
 const r=value.references;
 if(!matches(r.recordId,uuid)||!matches(r.recordType,name)||r.version!==undefined&&!matches(r.version,/^[1-9][0-9]{0,18}$/)||
   r.status!==undefined&&!matches(r.status,/^[A-Z][A-Z0-9_]{0,63}$/)||r.evidenceHash!==undefined&&!matches(r.evidenceHash,/^[0-9a-f]{64}$/))throw new Error("Invalid event references");
 return Object.freeze({consumer:value.consumer,source:value.source,externalEventId:value.externalEventId,eventType:value.eventType,
  references:Object.freeze({recordId:r.recordId,recordType:r.recordType,...(r.version!==undefined?{version:r.version}:{}),...(r.status!==undefined?{status:r.status}:{}),...(r.evidenceHash!==undefined?{evidenceHash:r.evidenceHash}:{})})});
}
export function sourceEventHash(value:VerifiedSourceEvent):string{
 return createHash("sha256").update(JSON.stringify(sourceEventSnapshot(value))).digest("hex");
}
function mapClaim(row:Record<string,unknown>):ClaimedOutboxEvent{
 const event:OutboxEvent={schemaVersion:1,id:String(row.id),organizationId:String(row.organization_id),auditEventId:String(row.audit_event_id),eventType:String(row.event_type),correlationId:String(row.correlation_id),evidenceHash:String(row.evidence_hash),occurredAt:String(row.occurred_at_exact)};
 if(![event.id,event.organizationId,event.auditEventId,event.correlationId,String(row.claim_token)].every(v=>uuid.test(v))||
  !/^[a-z][a-z0-9_.]{2,119}$/.test(event.eventType)||!/^[0-9a-f]{64}$/.test(event.evidenceHash)||
  !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(event.occurredAt)||!Number.isSafeInteger(row.attempts)||Number(row.attempts)<1)throw new Error("Invalid outbox envelope");
 return {event,claimToken:String(row.claim_token),attempts:Number(row.attempts)};
}
/** Trusted server-only capability; do not construct context from model/browser fields. */
export class TransactionalEventRepository{
 constructor(private readonly client:TransactionClient){}
 private transaction<T>(context:AuditContext,operation:(tx:TransactionClient)=>Promise<T>):Promise<T>{
  return withTransaction(this.client,async tx=>{
   await setAuditContext(tx,context);
   const member=rows(await tx.query("SELECT id FROM app.memberships WHERE organization_id=$1 AND id=$2 AND role IN ('owner','admin') AND status='active'",[context.organizationId,context.membershipId]));
   if(member.length!==1)throw new Error("Event operation is not authorized");
   return operation(tx);
  });
 }
 /** Handler must apply only database effects on tx. External I/O cannot roll back. */
 apply(context:AuditContext,input:VerifiedSourceEvent,handler:(tx:TransactionClient,event:Readonly<VerifiedSourceEvent>)=>Promise<void>):Promise<{id:string;replay:boolean}>{
  const event=sourceEventSnapshot(input),hash=sourceEventHash(event);
  return this.transaction(context,async tx=>{
   const inserted=rows(await tx.query(`INSERT INTO app.event_receipts(organization_id,consumer,source,external_event_id,request_hash)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(organization_id,consumer,source,external_event_id) DO NOTHING RETURNING id`,[context.organizationId,event.consumer,event.source,event.externalEventId,hash]));
   if(!inserted.length){
    const previous=rows(await tx.query("SELECT id,request_hash FROM app.event_receipts WHERE organization_id=$1 AND consumer=$2 AND source=$3 AND external_event_id=$4",[context.organizationId,event.consumer,event.source,event.externalEventId]))[0];
    if(!previous||previous.request_hash!==hash)throw new Error("Event ID conflicts with different content");
    return {id:String(previous.id),replay:true};
   }
   if(inserted.length!==1)throw new Error("Event intake was not confirmed");
   await handler(tx,event);
   return {id:String(inserted[0]!.id),replay:false};
  });
 }
 claim(context:AuditContext,options:{limit?:number;leaseSeconds?:number}={}):Promise<ClaimedOutboxEvent[]>{
  const limit=options.limit??10,lease=options.leaseSeconds??60;
  if(!Number.isSafeInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(lease)||lease<5||lease>300)throw new Error("Invalid outbox claim bounds");
  return this.transaction(context,async tx=>rows(await tx.query(`WITH selected AS (
    SELECT id FROM app.event_outbox WHERE organization_id=$1 AND delivered_at IS NULL AND available_at<=clock_timestamp()
     AND (claim_until IS NULL OR claim_until<=clock_timestamp()) ORDER BY occurred_at,id LIMIT $2 FOR UPDATE SKIP LOCKED
   ) UPDATE app.event_outbox e SET claim_token=$3,claim_until=clock_timestamp()+($4::integer*interval '1 second'),attempts=e.attempts+1
     FROM selected WHERE e.id=selected.id AND e.organization_id=$1
     RETURNING e.*,to_char(e.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at_exact`,[context.organizationId,limit,randomUUID(),lease])).map(mapClaim));
 }
 acknowledge(context:AuditContext,id:string,claimToken:string):Promise<boolean>{
  if(!uuid.test(id)||!uuid.test(claimToken))throw new Error("Invalid event claim");
  return this.transaction(context,async tx=>rows(await tx.query(`UPDATE app.event_outbox SET delivered_at=clock_timestamp(),claim_token=NULL,claim_until=NULL
   WHERE organization_id=$1 AND id=$2 AND claim_token=$3 AND claim_until>clock_timestamp() AND delivered_at IS NULL RETURNING id`,[context.organizationId,id,claimToken])).length===1);
 }
 retry(context:AuditContext,id:string,claimToken:string,delaySeconds=30):Promise<boolean>{
  if(!uuid.test(id)||!uuid.test(claimToken)||!Number.isSafeInteger(delaySeconds)||delaySeconds<1||delaySeconds>3600)throw new Error("Invalid event retry");
  return this.transaction(context,async tx=>rows(await tx.query(`UPDATE app.event_outbox SET available_at=clock_timestamp()+($4::integer*interval '1 second'),claim_token=NULL,claim_until=NULL
   WHERE organization_id=$1 AND id=$2 AND claim_token=$3 AND claim_until>clock_timestamp() AND delivered_at IS NULL RETURNING id`,[context.organizationId,id,claimToken,delaySeconds])).length===1);
 }
}
/** At-least-once transport. Receiver MUST dedupe by event.id before applying effects. */
export async function relayOutboxBatch(repository:TransactionalEventRepository,context:AuditContext,
 deliver:(event:OutboxEvent)=>Promise<void>,limit=10):Promise<{acknowledged:number;unconfirmed:number}>{
 const claimed=await repository.claim(context,{limit}),result={acknowledged:0,unconfirmed:0};
 for(const item of claimed){
  try{
   await deliver(item.event);
   if(await repository.acknowledge(context,item.event.id,item.claimToken))result.acknowledged++;else result.unconfirmed++;
  }catch{
   // A timed-out transport may already have committed remotely. Never inline-retry.
   result.unconfirmed++;
   await repository.retry(context,item.event.id,item.claimToken);
  }
 }
 return result;
}
