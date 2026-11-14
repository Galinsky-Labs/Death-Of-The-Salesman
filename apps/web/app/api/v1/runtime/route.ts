// DOTS-039..054 agent runtime API: owner-only run history/evidence snapshot and bounded runtime controls.
// No action here sends anything externally: dispatch requires a provider sender that is not wired to HTTP.
import {ownerSession} from '../../../../lib/auth';
import {hasTrustedOrigin} from '../../../../lib/request-origin';
import {withOperations} from '../../../../lib/operations';
import {OperationError,identifier,text,AgentCapabilities,RuntimeQueue,RunCoordinator,RuntimeEvidence,OwnerGatedDispatcher,simulationExecutor,type CapabilityInput} from '@dots/operations';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store'};
const version=(value:unknown)=>{if(typeof value!=='number'||!Number.isSafeInteger(value)||value<1)throw new OperationError('INVALID_VERSION',400);return value;};
const optionalText=(value:unknown,field:string,max:number)=>value===undefined||value===null||value===''?undefined:text(value,field,max);
function errorResponse(error:unknown){if(error instanceof OperationError)return Response.json({error:error.code},{status:error.status,headers});return Response.json({error:'OPERATION_UNAVAILABLE'},{status:503,headers});}
function capabilityInput(body:Record<string,unknown>):CapabilityInput{
 const pick=<T>(key:string)=>body[key] as T|undefined;
 return {role:pick<string>('role'),allowedTaskKinds:pick<string[]>('allowedTaskKinds'),allowedTools:pick<string[]>('allowedTools'),allowedChannels:pick<string[]>('allowedChannels'),skills:pick<string[]>('skills'),modelPolicy:pick<string>('modelPolicy'),campaignScope:pick<string[]>('campaignScope'),paused:body.paused===undefined?undefined:body.paused===true,maxSteps:pick<number>('maxSteps'),wallClockSeconds:pick<number>('wallClockSeconds'),dailyRunQuota:pick<number>('dailyRunQuota'),windowStartMinute:pick<number|null>('windowStartMinute'),windowEndMinute:pick<number|null>('windowEndMinute'),expectedVersion:pick<number>('expectedVersion')};
}
export async function GET(){try{
 if(!await ownerSession())return Response.json({error:'OWNER_SESSION_REQUIRED'},{status:401,headers});
 const data=await withOperations((client,ctx)=>new RuntimeEvidence(client,ctx).snapshot());
 return Response.json(data,{headers});
}catch(error){return errorResponse(error);}}
export async function POST(request:Request){try{
 if(!hasTrustedOrigin(request))return Response.json({error:'INVALID_ORIGIN'},{status:403,headers});
 if(!await ownerSession())return Response.json({error:'OWNER_SESSION_REQUIRED'},{status:401,headers});
 if(!request.headers.get('content-type')?.startsWith('application/json'))throw new OperationError('JSON_REQUIRED',400);
 const raw=await request.text();if(raw.length>64_000)throw new OperationError('REQUEST_TOO_LARGE',413);
 const body=JSON.parse(raw) as Record<string,unknown>;if(!body||typeof body!=='object'||Array.isArray(body))throw new OperationError('INVALID_REQUEST',400);
 const result=await withOperations(async(client,ctx)=>{
  let outcome:unknown=undefined;
  const queue=new RuntimeQueue(client,ctx);
  switch(body.action){
   case 'configureCapability':outcome=await new AgentCapabilities(client,ctx).configure(identifier(body.agentId),capabilityInput(body));break;
   case 'setAgentPaused':outcome=await new AgentCapabilities(client,ctx).setPaused(identifier(body.agentId),body.paused===true);break;
   case 'enqueueWork':outcome=await queue.enqueue({projectId:identifier(body.projectId),agentId:identifier(body.agentId),kind:text(body.kind,'kind',40),idempotencyKey:text(body.idempotencyKey,'idempotency_key',200),payload:{brief:optionalText(body.brief,'brief',6000)??null},leadKey:optionalText(body.leadKey,'lead_key',160)??null,channel:optionalText(body.channel,'channel',20),skill:optionalText(body.skill,'skill',41)??null,campaignId:body.campaignId?identifier(body.campaignId):null,priority:body.priority as number|undefined,maxAttempts:body.maxAttempts as number|undefined,deadlineAt:optionalText(body.deadlineAt,'deadline',40)??null,notBefore:optionalText(body.notBefore,'not_before',40)??null});break;
   case 'transitionWork':outcome=await queue.transition(identifier(body.id),version(body.expectedVersion),text(body.to,'state',40),{reason:optionalText(body.reason,'reason',200),idempotencyKey:optionalText(body.idempotencyKey,'idempotency_key',200)});break;
   case 'cancelWork':outcome=await queue.cancel(identifier(body.id),version(body.expectedVersion));break;
   case 'cancelRun':await new RunCoordinator(client,ctx).requestCancel(identifier(body.runId));break;
   case 'runSimulation':outcome=await new RunCoordinator(client,ctx).execute('owner-simulation',simulationExecutor());break;
   case 'recoverOrphans':outcome=await queue.recoverOrphans();break;
   case 'reconcileDispatch':{const decision=body.outcome==='sent'?'sent':body.outcome==='not_sent'?'not_sent':null;if(!decision)throw new OperationError('INVALID_OUTCOME',400);outcome=await new OwnerGatedDispatcher(client,ctx).reconcile(identifier(body.id),decision,text(body.evidence,'evidence',500));break;}
   default:throw new OperationError('UNKNOWN_ACTION',400);
  }
  return {outcome,data:await new RuntimeEvidence(client,ctx).snapshot()};
 });
 return Response.json(result,{headers});
}catch(error){if(error instanceof SyntaxError)return Response.json({error:'INVALID_JSON'},{status:400,headers});return errorResponse(error);}}
