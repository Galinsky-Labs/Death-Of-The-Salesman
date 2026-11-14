import {ownerSession} from '../../../../lib/auth';
import {hasTrustedOrigin} from '../../../../lib/request-origin';
import {withOperations} from '../../../../lib/operations';
import {OperationError,CampaignStudio,ControlPlane,identifier} from '@dots/operations';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store'};
const version=(value:unknown)=>{if(typeof value!=='number'||!Number.isSafeInteger(value)||value<1)throw new OperationError('INVALID_VERSION',400);return value;};
const record=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
function errorResponse(error:unknown){if(error instanceof OperationError)return Response.json({error:error.code},{status:error.status,headers});return Response.json({error:'OPERATION_UNAVAILABLE'},{status:503,headers});}

export async function GET(request:Request){try{
 if(!await ownerSession())return Response.json({error:'OWNER_SESSION_REQUIRED'},{status:401,headers});
 const selected=new URL(request.url).searchParams.get('campaign');
 const data=await withOperations(async(client,ctx)=>{await new ControlPlane(client,ctx).initialize();const studio=new CampaignStudio(client,ctx);return {snapshot:await studio.snapshot(),detail:selected?await studio.detail(identifier(selected)):null};});
 return Response.json(data,{headers});
}catch(error){return errorResponse(error);}}

export async function POST(request:Request){try{
 if(!hasTrustedOrigin(request))return Response.json({error:'INVALID_ORIGIN'},{status:403,headers});
 if(!await ownerSession())return Response.json({error:'OWNER_SESSION_REQUIRED'},{status:401,headers});
 if(!request.headers.get('content-type')?.startsWith('application/json'))throw new OperationError('JSON_REQUIRED',400);
 const raw=await request.text();if(raw.length>300_000)throw new OperationError('REQUEST_TOO_LARGE',413);
 const body=JSON.parse(raw);if(!body||typeof body!=='object'||Array.isArray(body))throw new OperationError('INVALID_REQUEST',400);
 const result=await withOperations(async(client,ctx)=>{
  await new ControlPlane(client,ctx).initialize();const studio=new CampaignStudio(client,ctx);let outcome:unknown;let campaignId:string|null=body.id?identifier(body.id):null;
  switch(body.action){
   case 'createDraft':{const created=await studio.createDraft({...record(body.fields),projectId:identifier(body.projectId),label:body.label,purpose:body.purpose,goal:body.goal});campaignId=created.id;outcome=created;break;}
   case 'saveDraft':outcome=await studio.saveDraft(identifier(body.id),version(body.version),record(body.fields));break;
   case 'setAudience':outcome=await studio.setAudience(identifier(body.id),version(body.version),{contactIds:body.contactIds,segment:record(body.segment)});break;
   case 'setBudget':outcome=await studio.setBudget(identifier(body.id),version(body.version),{totalCents:body.totalCents,perMessageMaxCents:body.perMessageMaxCents,authorizationRef:body.authorizationRef});break;
   case 'editCopy':outcome=await studio.editCopy(identifier(body.id),version(body.version),{subject:body.subject,bodyText:body.bodyText,bodyHtml:body.bodyHtml});break;
   case 'createTemplate':outcome=await studio.createTemplate({projectId:body.projectId,label:body.label,channel:body.channel});break;
   case 'reviseTemplate':outcome=await studio.reviseTemplate(identifier(body.templateId),version(body.version),{subject:body.subject,bodyText:body.bodyText,bodyHtml:body.bodyHtml});break;
   case 'previewTemplate':outcome=await studio.previewTemplate({templateRevisionId:body.templateRevisionId,subject:body.subject,bodyText:body.bodyText,bodyHtml:body.bodyHtml,projectId:body.projectId,offerId:body.offerId});break;
   case 'addVariant':outcome=await studio.addVariant(identifier(body.id),version(body.version),{label:body.label,strategyId:body.strategyId,templateRevisionId:body.templateRevisionId,weight:body.weight,eligibility:record(body.eligibility)});break;
   case 'retireVariant':outcome=await studio.retireVariant(identifier(body.id),version(body.version),identifier(body.variantId));break;
   case 'setPriceRule':outcome=await studio.setPriceRule(identifier(body.offerId),{authorizedPricesCents:body.authorizedPricesCents,maxDiscountBp:body.maxDiscountBp,restrictedPhrases:body.restrictedPhrases},body.version===undefined?undefined:version(body.version));break;
   case 'requestPriceException':outcome=await studio.requestPriceException(identifier(body.id),{amountCents:body.amountCents,discountBp:body.discountBp,reason:body.reason});break;
   case 'decidePriceException':outcome=await studio.decidePriceException(identifier(body.approvalId),body.approved===true);break;
   case 'validate':outcome=await studio.validate(identifier(body.id));break;
   case 'simulate':outcome=await studio.simulate(identifier(body.id),{sampleSize:body.sampleSize});break;
   case 'requestApproval':outcome=await studio.requestApproval(identifier(body.id));break;
   case 'decideApproval':{const decided=await studio.decideApproval(identifier(body.approvalId),body.approved===true);campaignId=decided.id;outcome=decided;break;}
   case 'schedule':outcome=await studio.schedule(identifier(body.id));break;
   case 'activate':outcome=await studio.activate(identifier(body.id));break;
   case 'pause':outcome=await studio.pause(identifier(body.id));break;
   case 'resume':outcome=await studio.resume(identifier(body.id));break;
   case 'complete':outcome=await studio.complete(identifier(body.id));break;
   case 'abort':outcome=await studio.abort(identifier(body.id));break;
   case 'archive':outcome=await studio.archive(identifier(body.id));break;
   case 'generateWork':outcome=await studio.generateWork(identifier(body.id),{maxItems:body.maxItems});break;
   default:throw new OperationError('UNKNOWN_ACTION',400);
  }
  return {outcome,snapshot:await studio.snapshot(),detail:campaignId?await studio.detail(campaignId):null};
 });
 return Response.json(result,{headers});
}catch(error){if(error instanceof SyntaxError)return Response.json({error:'INVALID_JSON'},{status:400,headers});return errorResponse(error);}}
