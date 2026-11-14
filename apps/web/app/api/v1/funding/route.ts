import {ownerSession} from '../../../../lib/auth';
import {hasTrustedOrigin} from '../../../../lib/request-origin';
import {withOperations} from '../../../../lib/operations';
import {OperationError,FundingWorkspace,ControlPlane,identifier,text} from '@dots/operations';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store'};
const version=(value:unknown)=>{if(typeof value!=='number'||!Number.isSafeInteger(value)||value<1)throw new OperationError('INVALID_VERSION',400);return value;};
const optionalId=(value:unknown)=>value?identifier(value):undefined;
const strings=(value:unknown)=>Array.isArray(value)?value.map(String):undefined;
/** Receipts typed in by the owner are owner-attested; provider-verified receipts only arrive through verified integrations. */
const ownerReceipt=(body:Record<string,any>)=>({amountCents:body.amountCents,source:'owner_attested',evidenceRef:body.evidenceRef,idempotencyKey:body.idempotencyKey});
function errorResponse(error:unknown){if(error instanceof OperationError)return Response.json({error:error.code},{status:error.status,headers});return Response.json({error:'OPERATION_UNAVAILABLE'},{status:503,headers});}
export async function GET(request:Request){try{
 if(!await ownerSession())return Response.json({error:'OWNER_SESSION_REQUIRED'},{status:401,headers});
 const url=new URL(request.url);
 if(url.searchParams.get('format')==='ics'){const ics=await withOperations((client,ctx)=>new FundingWorkspace(client,ctx).calendarIcs());return new Response(ics,{headers:{...headers,'Content-Type':'text/calendar; charset=utf-8','Content-Disposition':'attachment; filename="funding-deadlines.ics"'}});}
 const filter={geography:url.searchParams.get('geography')||undefined,entityType:url.searchParams.get('entityType')||undefined,kind:url.searchParams.get('kind')||undefined,deadlineAfter:url.searchParams.get('deadlineAfter')||undefined,deadlineBefore:url.searchParams.get('deadlineBefore')||undefined};
 const data=await withOperations(async(client,ctx)=>{const funding=new FundingWorkspace(client,ctx);const snapshot=await funding.snapshot();
  return Object.values(filter).some(Boolean)?{...snapshot,sources:await funding.listSources(filter),filter}:snapshot;});
 return Response.json(data,{headers});
}catch(error){return errorResponse(error);}}
export async function POST(request:Request){try{
 if(!hasTrustedOrigin(request))return Response.json({error:'INVALID_ORIGIN'},{status:403,headers});if(!await ownerSession())return Response.json({error:'OWNER_SESSION_REQUIRED'},{status:401,headers});
 if(!request.headers.get('content-type')?.startsWith('application/json'))throw new OperationError('JSON_REQUIRED',400);const raw=await request.text();if(raw.length>200_000)throw new OperationError('REQUEST_TOO_LARGE',413);
 const body=JSON.parse(raw);if(!body||typeof body!=='object'||Array.isArray(body))throw new OperationError('INVALID_REQUEST',400);
 let outcome:unknown=undefined;
 const data=await withOperations(async(client,ctx)=>{const control=new ControlPlane(client,ctx);await control.initialize();const f=new FundingWorkspace(client,ctx);switch(body.action){
  case 'importSource':outcome=await f.importSource({kind:body.kind,name:body.name,funder:body.funder,sourceUrl:body.sourceUrl,evidence:body.evidence,retrievedAt:body.retrievedAt,geography:strings(body.geography),entityEligibility:strings(body.entityEligibility),programType:body.programType,minAwardCents:body.minAwardCents??null,maxAwardCents:body.maxAwardCents??null,deadline:body.deadline??null,deadlineTimezone:body.deadlineTimezone,refreshDays:body.refreshDays});break;
  case 'addEligibilityRule':outcome=await f.addEligibilityRule(identifier(body.sourceId),{kind:body.kind,allowed:strings(body.allowed),description:body.description,citationUrl:body.citationUrl});break;
  case 'discover':outcome=await f.discover(text(body.connector,'connector',40),text(body.keyword,'keyword',120));break;
  case 'setApplicantProfile':outcome=await f.setApplicantProfile(identifier(body.projectId),{entityType:body.entityType,jurisdiction:body.jurisdiction,stage:body.stage,documents:body.documents,restrictionsConfirmed:strings(body.restrictionsConfirmed)});break;
  case 'evaluateEligibility':outcome=await f.evaluateEligibility(identifier(body.opportunityId));break;
  case 'createOpportunity':outcome=await f.createOpportunity({projectId:identifier(body.projectId),kind:body.kind,label:body.label,sourceId:optionalId(body.sourceId),investorId:optionalId(body.investorId),funder:body.funder||undefined,ownerLabel:body.ownerLabel||undefined,rangeMinCents:body.rangeMinCents??null,rangeMaxCents:body.rangeMaxCents??null,requestedCents:body.requestedCents??0,deadline:body.deadline||null});break;
  case 'openApplication':outcome=await f.openApplication(identifier(body.opportunityId),{questions:body.questions,documents:body.documents});break;
  case 'saveAnswer':outcome=await f.saveAnswer(identifier(body.answerId),{answer:body.answer,citations:strings(body.citations),version:version(body.version),source:'owner'});break;
  case 'assembleAnswer':outcome=await f.assembleAnswer(identifier(body.answerId),strings(body.factIds)??[],version(body.version));break;
  case 'markAnswerReviewed':outcome=await f.markAnswerReviewed(identifier(body.answerId),version(body.version));break;
  case 'attachDocument':outcome=await f.attachDocument(identifier(body.applicationDocumentId),identifier(body.documentId),body.privacyClass??'private');break;
  case 'requestReview':outcome=await f.requestReview(identifier(body.applicationId));break;
  case 'reviewApplication':outcome=await f.reviewApplication(identifier(body.applicationId),body.decision,typeof body.notes==='string'?body.notes:'');break;
  case 'addOrganizationFact':outcome=await f.addOrganizationFact(identifier(body.projectId),{label:body.label,statement:body.statement,evidenceRef:body.evidenceRef,category:body.category});break;
  case 'approveOrganizationFact':outcome=await f.approveOrganizationFact(identifier(body.factId));break;
  case 'queueDraftTask':outcome=await f.queueDraftTask(identifier(body.applicationId),identifier(body.agentId),text(body.idempotencyKey,'idempotency_key',200));break;
  case 'scheduleTimeline':outcome=await f.scheduleTimeline(identifier(body.opportunityId),body.timezone??'UTC');break;
  case 'refreshReminders':outcome=await f.refreshReminders();break;
  case 'completeMilestone':outcome=await f.completeMilestone(identifier(body.id));break;
  case 'acknowledgeAlert':outcome=await f.acknowledgeAlert(identifier(body.id));break;
  case 'certifyEligibility':outcome=await f.certifyEligibility(identifier(body.applicationId),{signerName:body.signerName,statement:body.statement});break;
  case 'prepareSubmission':outcome=await f.prepareSubmission(identifier(body.applicationId));break;
  case 'decideSubmissionApproval':outcome=await control.decideApproval(identifier(body.approvalId),body.approved===true);break;
  case 'recordSubmission':outcome=await f.recordSubmission(identifier(body.applicationId),{approvalId:identifier(body.approvalId),evidenceKind:body.evidenceKind,evidenceRef:body.evidenceRef});break;
  case 'recordAward':outcome=await f.recordAward(identifier(body.opportunityId),{amountCents:body.amountCents,restrictedCents:body.restrictedCents??0,offerEvidenceRef:body.offerEvidenceRef});break;
  case 'decideAward':outcome=await f.decideAward(identifier(body.awardId),body.accept===true,version(body.version),body.authorityRef||undefined);break;
  case 'addRestriction':outcome=await f.addRestriction(identifier(body.awardId),{purpose:body.purpose,amountCents:body.amountCents,expiresAt:body.expiresAt??null,evidenceRef:body.evidenceRef});break;
  case 'recordDisbursement':outcome=await f.recordDisbursement(identifier(body.awardId),{...ownerReceipt(body),restrictionId:optionalId(body.restrictionId)});break;
  case 'reconciliation':outcome=await f.reconciliation();break;
  case 'addInvestor':outcome=await f.addInvestor({name:body.name,kind:body.kind,sourceId:optionalId(body.sourceId),relationship:body.relationship,allowedCommunicationClasses:strings(body.allowedCommunicationClasses)});break;
  case 'verifyAccreditation':outcome=await f.verifyAccreditation(identifier(body.investorId),body.evidenceRef);break;
  case 'recordMeeting':outcome=await f.recordMeeting(identifier(body.investorId),{opportunityId:optionalId(body.opportunityId),occurredAt:body.occurredAt,qualified:body.qualified===true,interestLevel:body.interestLevel,summary:body.summary,evidenceRef:body.evidenceRef});break;
  case 'reviewInvestorCommunication':outcome=await f.reviewInvestorCommunication(identifier(body.investorId),{communicationClass:body.communicationClass,content:body.content,factIds:strings(body.factIds),projectId:optionalId(body.projectId)});break;
  case 'decideInvestorCommunication':outcome=await f.decideInvestorCommunication(identifier(body.reviewId),body.approve===true,body.legalReviewRef||undefined);break;
  case 'createPitchAsset':outcome=await f.createPitchAsset(identifier(body.projectId),body.kind,body.label);break;
  case 'savePitchVersion':outcome=await f.savePitchVersion(identifier(body.assetId),body.content,strings(body.factIds)??[]);break;
  case 'addDiligenceItem':outcome=await f.addDiligenceItem(identifier(body.opportunityId),body.label);break;
  case 'completeDiligenceItem':outcome=await f.completeDiligenceItem(identifier(body.itemId),identifier(body.documentId));break;
  case 'recordCommitmentStage':outcome=await f.recordCommitmentStage(identifier(body.opportunityId),{stage:body.stage,amountCents:body.amountCents??0,proofRef:body.proofRef,documentId:optionalId(body.documentId),meetingId:optionalId(body.meetingId),legalReviewRef:body.legalReviewRef||undefined,authorityRef:body.authorityRef||undefined});break;
  case 'recordInvestmentReceipt':outcome=await f.recordInvestmentReceipt(identifier(body.opportunityId),ownerReceipt(body));break;
  case 'startSponsorship':outcome=await f.startSponsorship(identifier(body.opportunityId));break;
  case 'advanceSponsorship':outcome=await f.advanceSponsorship(identifier(body.workflowId),body.stage,version(body.version),{proposalAssetId:optionalId(body.proposalAssetId),contractDocumentId:optionalId(body.contractDocumentId),contractReviewRef:body.contractReviewRef||undefined,authorityRef:body.authorityRef||undefined});break;
  case 'recordSponsorshipExchange':outcome=await f.recordSponsorshipExchange(identifier(body.workflowId),{kind:body.kind,description:body.description,valueCents:body.valueCents,evidenceRef:body.evidenceRef,source:'owner_attested',idempotencyKey:body.idempotencyKey});break;
  default:throw new OperationError('UNKNOWN_ACTION',400);
 }return f.snapshot();});
 return Response.json({data,outcome},{headers});
}catch(error){if(error instanceof SyntaxError)return Response.json({error:'INVALID_JSON'},{status:400,headers});return errorResponse(error);}}
