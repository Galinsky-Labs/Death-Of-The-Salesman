import {withTransaction,type TransactionClient} from "./index.js";
import {setAuditContext,type AuditContext} from "./audit-events.js";
export class PrivacyOperationError extends Error{constructor(message="Privacy operation unavailable"){super(message);this.name="PrivacyOperationError";}}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const rows=(value:unknown)=>(value as {rows:Record<string,unknown>[]}).rows;
export const DEFAULT_CACHE_TTL_SECONDS=7*86400;
export function cacheExpiry(now:number,ttlSeconds=DEFAULT_CACHE_TTL_SECONDS):string{
 if(!Number.isSafeInteger(now)||!Number.isSafeInteger(ttlSeconds)||ttlSeconds<1||ttlSeconds>30*86400)throw new PrivacyOperationError("Invalid derived cache retention");
 return new Date(now+ttlSeconds*1000).toISOString();
}
export function tenantProjectExport(organizationId:string,project:Record<string,unknown>,offers:Record<string,unknown>[]):Record<string,unknown>{
 if(!uuid.test(organizationId)||project.organization_id!==organizationId||offers.length>100||offers.some(row=>row.organization_id!==organizationId||row.project_id!==project.id))throw new PrivacyOperationError("Export tenant or resource mismatch");
 const projectFields=(row:Record<string,unknown>)=>({id:row.id,label:row.label,content:row.content,status:row.status,version:String(row.version)});
 const document={schemaVersion:1,organizationId,project:projectFields(project),offers:offers.map(projectFields)};
 if(Buffer.byteLength(JSON.stringify(document))>2100000)throw new PrivacyOperationError("Export exceeds bounded snapshot size");
 return document;
}
/** Trusted authenticated owner context only. No public endpoint or background erasure. */
export class PrivacyFoundationRepository{
 constructor(private readonly client:TransactionClient){}
 private async transaction<T>(context:AuditContext,operation:(tx:TransactionClient)=>Promise<T>):Promise<T>{
  try{return await withTransaction(this.client,async tx=>{
   await setAuditContext(tx,context);
   if(rows(await tx.query("SELECT id FROM app.memberships WHERE organization_id=$1 AND id=$2 AND role='owner' AND status='active'",[context.organizationId,context.membershipId])).length!==1)throw new PrivacyOperationError("Privacy operation is not authorized");
   return operation(tx);
  });}catch(error){if(error instanceof PrivacyOperationError)throw error;throw new PrivacyOperationError();}
 }
 putCache(context:AuditContext,payload:Readonly<Record<string,unknown>>,ttlSeconds=DEFAULT_CACHE_TTL_SECONDS):Promise<string>{
  cacheExpiry(Date.now(),ttlSeconds);
  const serialized=JSON.stringify(payload);
  if(!payload||typeof payload!=="object"||Array.isArray(payload)||Buffer.byteLength(serialized)>16384)throw new PrivacyOperationError("Invalid bounded derived cache");
  return this.transaction(context,async tx=>{
   const result=rows(await tx.query("INSERT INTO app.privacy_cache(organization_id,payload,expires_at,updated_by_membership_id) VALUES($1,$2::jsonb,clock_timestamp()+($3::integer*interval '1 second'),$4) RETURNING id",[context.organizationId,serialized,ttlSeconds,context.membershipId]));
   if(result.length!==1)throw new PrivacyOperationError("Cache save unconfirmed");return String(result[0]!.id);
  });
 }
 holdCache(context:AuditContext,cacheId:string,reasonCode:string,holdSeconds:number):Promise<string>{
  if(!uuid.test(cacheId)||!/^[A-Z][A-Z0-9_]{0,63}$/.test(reasonCode)||!Number.isSafeInteger(holdSeconds)||holdSeconds<1||holdSeconds>365*86400)throw new PrivacyOperationError("Invalid finite evidence hold");
  return this.transaction(context,async tx=>{
   const result=rows(await tx.query("INSERT INTO app.privacy_holds(organization_id,cache_id,reason_code,expires_at,updated_by_membership_id) VALUES($1,$2,$3,clock_timestamp()+($4::integer*interval '1 second'),$5) RETURNING id",[context.organizationId,cacheId,reasonCode,holdSeconds,context.membershipId]));
   if(result.length!==1)throw new PrivacyOperationError("Hold save unconfirmed");return String(result[0]!.id);
  });
 }
 expireCaches(context:AuditContext,limit=100):Promise<string[]>{
  if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new PrivacyOperationError("Invalid expiry batch");
  return this.transaction(context,async tx=>rows(await tx.query(`WITH expired AS (
   SELECT c.id FROM app.privacy_cache c WHERE c.organization_id=$1 AND c.expires_at<=clock_timestamp()
    AND NOT EXISTS(SELECT 1 FROM app.privacy_holds h WHERE h.organization_id=c.organization_id AND h.cache_id=c.id AND h.released_at IS NULL AND h.expires_at>clock_timestamp())
   ORDER BY c.expires_at,c.id LIMIT $2 FOR UPDATE OF c SKIP LOCKED
  ) DELETE FROM app.privacy_cache c USING expired WHERE c.organization_id=$1 AND c.id=expired.id RETURNING c.id`,[context.organizationId,limit])).map(row=>String(row.id)));
 }
 request(context:AuditContext,kind:"delete"|"correct"|"export",resourceType:"project"|"offer"|"derived_cache",resourceId:string,reasonCode:string):Promise<string>{
  const tables={project:"projects",offer:"offers",derived_cache:"privacy_cache"} as const;
  if(!["delete","correct","export"].includes(kind)||!Object.hasOwn(tables,resourceType)||!uuid.test(resourceId)||typeof reasonCode!=="string"||!/^[A-Z][A-Z0-9_]{0,63}$/.test(reasonCode))throw new PrivacyOperationError("Invalid privacy request");
  return this.transaction(context,async tx=>{
   const target=rows(await tx.query(`SELECT id,${resourceType==="derived_cache"?"NULL::text":"version::text"} version FROM app.${tables[resourceType]} WHERE organization_id=$1 AND id=$2`,[context.organizationId,resourceId]));
   if(target.length!==1)throw new PrivacyOperationError("Privacy resource unavailable");
   const created=rows(await tx.query("INSERT INTO app.privacy_requests(organization_id,kind,resource_type,resource_id,reason_code,updated_by_membership_id,expected_version) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id",[context.organizationId,kind,resourceType,resourceId,reasonCode,context.membershipId,target[0]!.version]));
   if(created.length!==1)throw new PrivacyOperationError("Privacy request unconfirmed");
   return String(created[0]!.id);
  });
 }
 correct(context:AuditContext,requestId:string,patch:{label:string;content:Readonly<Record<string,unknown>>}):Promise<void>{
  const serialized=JSON.stringify(patch.content);
  if(!uuid.test(requestId)||typeof patch.label!=="string"||!patch.label.trim()||patch.label.trim().length>240||!patch.content||typeof patch.content!=="object"||Array.isArray(patch.content)||Buffer.byteLength(serialized)>16384)throw new PrivacyOperationError("Invalid bounded correction");
  return this.transaction(context,async tx=>{
   const request=rows(await tx.query("SELECT resource_type,resource_id,expected_version::text FROM app.privacy_requests WHERE organization_id=$1 AND id=$2 AND kind='correct' AND state='pending' FOR UPDATE",[context.organizationId,requestId]))[0];
   if(!request||!["project","offer"].includes(String(request.resource_type))||!String(request.expected_version).match(/^[1-9][0-9]{0,18}$/))throw new PrivacyOperationError("Correction request unavailable");
   const table=request.resource_type==="project"?"projects":"offers";
   const changed=rows(await tx.query(`UPDATE app.${table} SET label=$3,content=$4::jsonb,version=version+1,updated_by_membership_id=$5,updated_at=clock_timestamp()
    WHERE organization_id=$1 AND id=$2 AND version=$6::bigint AND status='active' RETURNING id`,[context.organizationId,request.resource_id,patch.label.trim(),serialized,context.membershipId,request.expected_version]));
   if(changed.length!==1)throw new PrivacyOperationError("Correction version conflict");
   await tx.query("UPDATE app.privacy_requests SET state='completed',updated_by_membership_id=$3 WHERE organization_id=$1 AND id=$2",[context.organizationId,requestId,context.membershipId]);
  });
 }
 enqueueExport(context:AuditContext,requestId:string):Promise<string>{
  if(!uuid.test(requestId))throw new PrivacyOperationError("Invalid export request");
  return this.transaction(context,async tx=>{
   const request=rows(await tx.query("SELECT id FROM app.privacy_requests WHERE organization_id=$1 AND id=$2 AND kind='export' AND state='pending' FOR UPDATE",[context.organizationId,requestId]));
   if(request.length!==1)throw new PrivacyOperationError("Export request unavailable");
   const created=rows(await tx.query("INSERT INTO app.privacy_export_jobs(organization_id,request_id,expires_at,updated_by_membership_id) VALUES($1,$2,clock_timestamp()+interval '7 days',$3) ON CONFLICT(organization_id,request_id) DO NOTHING RETURNING id",[context.organizationId,requestId,context.membershipId]));
   if(created.length===1)return String(created[0]!.id);
   const prior=rows(await tx.query("SELECT id FROM app.privacy_export_jobs WHERE organization_id=$1 AND request_id=$2 AND expires_at>clock_timestamp() AND state<>'expired'",[context.organizationId,requestId]));
   if(prior.length!==1)throw new PrivacyOperationError("Export scheduling unconfirmed");return String(prior[0]!.id);
  });
 }
 /** Internal plaintext snapshot: encrypt in the artifact layer before any download. */
 exportProject(context:AuditContext,id:string):Promise<Record<string,unknown>>{
  if(!uuid.test(id))throw new PrivacyOperationError("Invalid project export");
  return this.transaction(context,async tx=>{
   // One statement snapshot, bounded children; never export credentials or sessions.
   const found=rows(await tx.query(`SELECT p.id,p.organization_id,p.label,p.content,p.status,p.version,
    COALESCE((SELECT jsonb_agg(child) FROM (SELECT id,organization_id,project_id,label,content,status,version::text version FROM app.offers WHERE organization_id=$1 AND project_id=p.id ORDER BY id LIMIT 101) child),'[]'::jsonb) offers
    FROM app.projects p WHERE p.organization_id=$1 AND p.id=$2
     AND octet_length(p.content::text)+COALESCE((SELECT sum(octet_length(o.content::text)) FROM app.offers o WHERE o.organization_id=$1 AND o.project_id=p.id),0)<=2000000`,[context.organizationId,id]));
   if(found.length!==1||!Array.isArray(found[0]!.offers))throw new PrivacyOperationError("Export unavailable");
   return tenantProjectExport(context.organizationId,found[0]!,found[0]!.offers as Record<string,unknown>[]);
  });
 }
}
