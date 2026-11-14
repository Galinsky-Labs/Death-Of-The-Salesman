// DOTS-110..120 Strategy Lab API. GET returns the tenant-scoped Strategy Lab snapshot; POST runs one owner action.
import {ownerSession} from '../../../../lib/auth';
import {hasTrustedOrigin} from '../../../../lib/request-origin';
import {withOperations} from '../../../../lib/operations';
import {OperationError,StrategyLab,identifier} from '@dots/operations';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store'};
function errorResponse(error:unknown){if(error instanceof OperationError)return Response.json({error:error.code},{status:error.status,headers});return Response.json({error:'OPERATION_UNAVAILABLE'},{status:503,headers});}
const revision=(body:Record<string,unknown>)=>({objective:body.objective,audienceRules:body.audienceRules,allowedPersonalization:body.allowedPersonalization,forbiddenClaims:body.forbiddenClaims,tone:body.tone,disclosures:body.disclosures,instructions:body.instructions});
export async function GET(){try{
 if(!await ownerSession())return Response.json({error:'OWNER_SESSION_REQUIRED'},{status:401,headers});
 const data=await withOperations((client,ctx)=>new StrategyLab(client,ctx).snapshot());return Response.json(data,{headers});
}catch(error){return errorResponse(error);}}
export async function POST(request:Request){try{
 if(!hasTrustedOrigin(request))return Response.json({error:'INVALID_ORIGIN'},{status:403,headers});if(!await ownerSession())return Response.json({error:'OWNER_SESSION_REQUIRED'},{status:401,headers});
 if(!request.headers.get('content-type')?.startsWith('application/json'))throw new OperationError('JSON_REQUIRED',400);const raw=await request.text();if(raw.length>200_000)throw new OperationError('REQUEST_TOO_LARGE',413);
 const body=JSON.parse(raw) as Record<string,unknown>;if(!body||typeof body!=='object'||Array.isArray(body))throw new OperationError('INVALID_REQUEST',400);
 const outcome=await withOperations(async(client,ctx)=>{const lab=new StrategyLab(client,ctx);switch(body.action){
  case 'createFamily':return lab.createFamily({label:body.label,projectId:body.projectId,...revision(body)});
  case 'proposeRevision':return lab.proposeRevision(body.familyId,revision(body));
  case 'decideRevision':return lab.decideRevision(body.revisionId,body.approved===true);
  case 'retireRevision':return lab.retireRevision(body.revisionId);
  case 'saveAllocation':return lab.saveAllocation({projectId:body.projectId,campaignId:body.campaignId,experimentalBasisPoints:body.experimentalBasisPoints,minExplorationBasisPoints:body.minExplorationBasisPoints,belowFloorAcknowledgement:body.belowFloorAcknowledgement,autoPromoteEnabled:body.autoPromoteEnabled,championRevisionId:body.championRevisionId,expectedVersion:body.expectedVersion});
  case 'createExperiment':return lab.createExperiment({allocationRuleId:body.allocationRuleId,label:body.label,design:body.design,arms:body.arms,minSamplePerArm:body.minSamplePerArm,lagDays:body.lagDays,alphaBasisPoints:body.alphaBasisPoints,maxComplaintBasisPoints:body.maxComplaintBasisPoints,maxUnsubscribeBasisPoints:body.maxUnsubscribeBasisPoints,budgetCents:body.budgetCents,stratumTolerance:body.stratumTolerance,previousExperimentId:body.previousExperimentId});
  case 'setExperimentState':return lab.setExperimentState(body.experimentId,body.state,body.reason);
  case 'enroll':return lab.enroll(body.experimentId,body.contactId,{segment:body.segment});
  case 'recordOutcome':return lab.recordOutcome({experimentId:body.experimentId,contactId:body.contactId,kind:body.kind,evidenceSource:body.evidenceSource,occurredAt:body.occurredAt,idempotencyKey:body.idempotencyKey,amountCents:body.amountCents,originalCurrency:body.originalCurrency,originalAmountMinor:body.originalAmountMinor,fxSource:body.fxSource,isEstimate:body.isEstimate,receiptProvider:body.receiptProvider,receiptEventId:body.receiptEventId,evidenceRef:body.evidenceRef});
  case 'metrics':return lab.metrics(body.experimentId);
  case 'snapshotMetrics':return (await lab.snapshotMetrics(body.experimentId)).snapshot;
  case 'provenance':return lab.provenance(body.experimentId,body.armId||undefined);
  case 'promote':return lab.promote({experimentId:body.experimentId,armId:body.armId,mode:body.mode,rationale:body.rationale,acknowledgeUncertainty:body.acknowledgeUncertainty});
  case 'rollback':return lab.rollback(body.promotionId,body.rationale);
  case 'createHybrid':return lab.createHybrid(identifier(body.familyId),body.parents,revision(body));
  case 'addBacklogItem':return lab.addBacklogItem({familyId:body.familyId,title:body.title,hypothesis:body.hypothesis,parentRevisionIds:body.parentRevisionIds,proposedRevisionId:body.proposedRevisionId});
  case 'updateBacklogItem':return lab.updateBacklogItem(body.id,{status:body.status,proposedRevisionId:body.proposedRevisionId,expectedVersion:body.expectedVersion});
  default:throw new OperationError('UNKNOWN_ACTION',400);
 }});
 const data=await withOperations((client,ctx)=>new StrategyLab(client,ctx).snapshot());
 return Response.json({data,outcome},{headers});
}catch(error){if(error instanceof SyntaxError)return Response.json({error:'INVALID_JSON'},{status:400,headers});return errorResponse(error);}}
