// DOTS-032..043 governance control plane API. Owner session + trusted origin only.
// Never returns credential ciphertext or raw secrets; exports are returned once and only hashed at rest.
import {ownerSession} from '../../../../lib/auth';
import {hasTrustedOrigin} from '../../../../lib/request-origin';
import {withOperations} from '../../../../lib/operations';
import {OperationError,GovernanceBlockedError,GovernedBudget,KillSwitches,OwnerActionInbox,CredentialStore,GovernanceService,ControlPlane,identifier,text,cents} from '@dots/operations';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store'};
const optionalCents=(value:unknown)=>value===null||value===undefined||value===''?null:cents(value);
function errorResponse(error:unknown){
 if(error instanceof GovernanceBlockedError)return Response.json({error:error.code,ruleId:error.ruleId},{status:error.status,headers});
 if(error instanceof OperationError)return Response.json({error:error.code},{status:error.status,headers});
 return Response.json({error:'OPERATION_UNAVAILABLE'},{status:503,headers});
}
async function snapshot(){return withOperations(async(client,ctx)=>({
 ...(await new GovernanceService(client,ctx).snapshot()),
 capabilities:{
  credentialEncryptionConfigured:Boolean(process.env.CREDENTIAL_ENCRYPTION_KEY),
  spendAuthorizationConfigured:Boolean(process.env.OWNER_SPEND_AUTHORIZATION_ID),
  hardCapCents:Number(process.env.PAID_SPEND_LIMIT_CENTS??0)||0,
 },
 observedAt:new Date().toISOString(),
}));}
export async function GET(){try{
 if(!await ownerSession())return Response.json({error:'OWNER_SESSION_REQUIRED'},{status:401,headers});
 return Response.json(await snapshot(),{headers});
}catch(error){return errorResponse(error);}}
export async function POST(request:Request){try{
 if(!hasTrustedOrigin(request))return Response.json({error:'INVALID_ORIGIN'},{status:403,headers});
 if(!await ownerSession())return Response.json({error:'OWNER_SESSION_REQUIRED'},{status:401,headers});
 if(!request.headers.get('content-type')?.startsWith('application/json'))throw new OperationError('JSON_REQUIRED',400);
 const raw=await request.text();if(raw.length>65_536)throw new OperationError('REQUEST_TOO_LARGE',413);
 const body=JSON.parse(raw);if(!body||typeof body!=='object'||Array.isArray(body))throw new OperationError('INVALID_REQUEST',400);
 let outcome:unknown=undefined;
 await withOperations(async(client,ctx)=>{
  const budget=new GovernedBudget(client,ctx),switches=new KillSwitches(client,ctx),inbox=new OwnerActionInbox(client,ctx),governance=new GovernanceService(client,ctx);
  const credentials=new CredentialStore(client,ctx,process.env.CREDENTIAL_ENCRYPTION_KEY);
  await new ControlPlane(client,ctx).initialize();
  switch(body.action){
  case 'setScopePolicy':outcome=await budget.setScopePolicy({scopeKind:text(body.scopeKind,'scope_kind',20),scopeKey:typeof body.scopeKey==='string'?body.scopeKey:undefined,ceilingCents:optionalCents(body.ceilingCents),dailyLimitCents:optionalCents(body.dailyLimitCents),alertThresholdBps:body.alertThresholdBps===undefined?undefined:Number(body.alertThresholdBps)});break;
  case 'fund':outcome=await budget.fund(cents(body.amountCents),process.env.OWNER_SPEND_AUTHORIZATION_ID,Number(process.env.PAID_SPEND_LIMIT_CENTS??0)||0,text(body.key,'idempotency_key',200));break;
  case 'defund':outcome=await budget.defund(cents(body.amountCents),text(body.key,'idempotency_key',200));break;
  case 'transfer':outcome=await budget.transfer({fromScopeId:identifier(body.fromScopeId),toScopeId:identifier(body.toScopeId),amountCents:cents(body.amountCents),reason:text(body.reason,'reason',500),key:text(body.key,'idempotency_key',200)});break;
  case 'releaseReservation':outcome=await budget.release(identifier(body.id),text(body.reason,'reason',200));break;
  case 'reconcileExpired':outcome=await budget.reconcileExpired();break;
  case 'engageKillSwitch':outcome=await switches.engage(text(body.scopeKind,'scope_kind',20),body.scopeKey,text(body.rationale,'rationale',1000));break;
  case 'releaseKillSwitch':outcome=await switches.release(text(body.scopeKind,'scope_kind',20),body.scopeKey,text(body.rationale,'rationale',1000));break;
  case 'decideApproval':outcome=await inbox.decide(identifier(body.id),body.approved===true);break;
  case 'storeCredential':outcome=await credentials.store({providerId:body.providerId,label:body.label,kind:body.kind,secret:body.secret});break;
  case 'rotateCredential':outcome=await credentials.rotate(identifier(body.id),body.secret);break;
  case 'revokeCredential':outcome=await credentials.revoke(identifier(body.id),text(body.reason,'reason',500));break;
  case 'requeueDeadLetter':outcome=await governance.requeueDeadLetter(identifier(body.id),text(body.rationale,'rationale',500));break;
  case 'ensureDefaultRetention':await governance.ensureDefaultRetention();break;
  case 'setRetention':outcome=await governance.setRetention(text(body.recordKind,'record_kind',40),Number(body.retentionDays),text(body.retentionAction,'retention_action',40),text(body.basis,'basis',500));break;
  case 'applyRetention':outcome=await governance.applyRetention();break;
  case 'placeHold':outcome=await governance.placeHold(text(body.subjectKind,'subject_kind',20),body.subjectKind==='organization'?ctx.organizationId:identifier(body.subjectId),text(body.reason,'reason',1000));break;
  case 'releaseHold':outcome=await governance.releaseHold(identifier(body.id),text(body.rationale,'rationale',1000));break;
  case 'requestDeletion':outcome=await governance.requestDeletion('contact',identifier(body.subjectId),text(body.reason,'reason',1000));break;
  case 'processDeletion':outcome=await governance.processDeletion(identifier(body.id));break;
  case 'runExport':outcome=await governance.runExport(text(body.scope,'scope',20));break;
  default:throw new OperationError('UNKNOWN_ACTION',400);
  }
 });
 return Response.json({data:await snapshot(),outcome},{headers});
}catch(error){if(error instanceof SyntaxError)return Response.json({error:'INVALID_JSON'},{status:400,headers});return errorResponse(error);}}
