import {ownerSession} from '../../../../lib/auth';
import {hasTrustedOrigin} from '../../../../lib/request-origin';
import {withOperations} from '../../../../lib/operations';
import {OperationError,ModelOperations,identifier,planModelSmoke,planCheckpointInstall,runAdapterBenchmark,benchmarkBindings} from '@dots/operations';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store'};
function errorResponse(error:unknown){if(error instanceof OperationError)return Response.json({error:error.code},{status:error.status,headers});return Response.json({error:'OPERATION_UNAVAILABLE'},{status:503,headers});}
async function load(){const snapshot=await withOperations((client,ctx)=>new ModelOperations(client,ctx).snapshot(process.env));return {...snapshot,smoke:planModelSmoke(process.env)};}
export async function GET(){try{if(!await ownerSession())return Response.json({error:'OWNER_SESSION_REQUIRED'},{status:401,headers});return Response.json(await load(),{headers});}catch(error){return errorResponse(error);}}
export async function POST(request:Request){try{
 if(!hasTrustedOrigin(request))return Response.json({error:'INVALID_ORIGIN'},{status:403,headers});if(!await ownerSession())return Response.json({error:'OWNER_SESSION_REQUIRED'},{status:401,headers});
 if(!request.headers.get('content-type')?.startsWith('application/json'))throw new OperationError('JSON_REQUIRED',400);const raw=await request.text();if(raw.length>200_000)throw new OperationError('REQUEST_TOO_LARGE',413);const body=JSON.parse(raw);if(!body||typeof body!=='object'||Array.isArray(body))throw new OperationError('INVALID_REQUEST',400);
 let outcome:unknown=undefined;
 await withOperations(async(client,ctx)=>{const models=new ModelOperations(client,ctx);switch(body.action){
 case 'registerRevision':outcome=await models.registerRevision({provider:body.provider,model:body.model,status:body.status,reviewRef:body.reviewRef,privacyClass:body.privacyClass});break;
 case 'setRoutingWeight':outcome=await models.setRoutingWeight(identifier(body.agentId),body.provider,body.weight);break;
 case 'addPricingVersion':outcome=await models.addPricingVersion({provider:body.provider,model:body.model,inputCentsPerMillion:body.inputCentsPerMillion,outputCentsPerMillion:body.outputCentsPerMillion,cachedInputCentsPerMillion:body.cachedInputCentsPerMillion,sourceRef:body.sourceRef});break;
 case 'resetBreaker':await models.resetBreaker(body.provider,body.model);break;
 case 'recordInvoice':outcome=await models.recordInvoice({provider:body.provider,periodStart:body.periodStart,periodEnd:body.periodEnd,amountCents:body.amountCents,evidenceRef:body.evidenceRef});break;
 case 'releaseOutput':outcome=await models.releaseOutput(identifier(body.id),{use:body.use,authorizationRef:body.authorizationRef,securityCheckRef:body.securityCheckRef,sandboxRef:body.sandboxRef});break;
 case 'rejectOutput':await models.rejectOutput(identifier(body.id));break;
 case 'runBenchmark':outcome=await runAdapterBenchmark(benchmarkBindings(process.env));break;
 case 'planCheckpoint':outcome=planCheckpointInstall(body.spec,process.env);break;
 case 'planSmoke':outcome=planModelSmoke(process.env);break;
 case 'reconcile':outcome=await models.reconcile();break;
 default:throw new OperationError('UNKNOWN_ACTION',400);
 }});
 return Response.json({data:await load(),outcome},{headers});
 }catch(error){if(error instanceof SyntaxError)return Response.json({error:'INVALID_JSON'},{status:400,headers});return errorResponse(error);}}
