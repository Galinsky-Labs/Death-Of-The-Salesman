import {ownerSession} from '../../../../lib/auth';
import {hasTrustedOrigin} from '../../../../lib/request-origin';
import {withOperations} from '../../../../lib/operations';
import {OperationError,identifier,operationalHealth,IncidentLog,runKillSwitchDrill,PortfolioAccess,admissionDecision} from '@dots/operations';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store'};
function errorResponse(error:unknown){if(error instanceof OperationError)return Response.json({error:error.code},{status:error.status,headers});return Response.json({error:'OPERATION_UNAVAILABLE'},{status:503,headers});}
async function snapshot(){return withOperations(async(client,ctx)=>{const [health,incidents,tokens,admission]=[await operationalHealth(client,ctx),await new IncidentLog(client,ctx).list(),await new PortfolioAccess(client,ctx).list(),await admissionDecision(client,ctx)];return {health,incidents,tokens,admission,release:{revision:process.env.RENDER_GIT_COMMIT??'local',environment:process.env.APP_ENV??'development'}};});}
export async function GET(){try{if(!await ownerSession())return Response.json({error:'OWNER_SESSION_REQUIRED'},{status:401,headers});return Response.json(await snapshot(),{headers});}catch(error){return errorResponse(error);}}
export async function POST(request:Request){try{
 if(!hasTrustedOrigin(request))return Response.json({error:'INVALID_ORIGIN'},{status:403,headers});
 if(!await ownerSession())return Response.json({error:'OWNER_SESSION_REQUIRED'},{status:401,headers});
 if(!request.headers.get('content-type')?.startsWith('application/json'))throw new OperationError('JSON_REQUIRED',400);
 const raw=await request.text();if(raw.length>20000)throw new OperationError('REQUEST_TOO_LARGE',413);
 const body=JSON.parse(raw);if(!body||typeof body!=='object'||Array.isArray(body))throw new OperationError('INVALID_REQUEST',400);
 let outcome:unknown;
 await withOperations(async(client,ctx)=>{const log=new IncidentLog(client,ctx),portfolio=new PortfolioAccess(client,ctx);switch(body.action){
  case 'openIncident':outcome=await log.open(body.kind,body.severity,body.summary);break;
  case 'recordIncidentStep':await log.record(identifier(body.id),String(body.step??''),body.outcome,typeof body.note==='string'?{note:body.note.slice(0,2000)}:{});break;
  case 'transitionIncident':outcome=await log.transition(identifier(body.id),body.state,Number(body.version));break;
  case 'runKillSwitchDrill':outcome=await runKillSwitchDrill(client,ctx);break;
  case 'issuePortfolioToken':outcome=await portfolio.issue(body.label,Number(body.days??90));break;
  case 'revokePortfolioToken':await portfolio.revoke(identifier(body.id));break;
  default:throw new OperationError('UNKNOWN_ACTION',400);
 }});
 return Response.json({data:await snapshot(),outcome},{headers});
}catch(error){if(error instanceof SyntaxError)return Response.json({error:'INVALID_JSON'},{status:400,headers});return errorResponse(error);}}
