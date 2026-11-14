// DOTS-070..080 CRM, lead integrity and revenue pipeline API. Owner-only; every action is deterministic and sends nothing.
import {ownerSession} from '../../../../lib/auth';
import {hasTrustedOrigin} from '../../../../lib/request-origin';
import {withOperations} from '../../../../lib/operations';
import {OperationError,CrmWorkspace,identifier,cents} from '@dots/operations';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store'};
const version=(value:unknown)=>{if(typeof value!=='number'||!Number.isSafeInteger(value)||value<1)throw new OperationError('INVALID_VERSION',400);return value;};
const optionalId=(value:unknown)=>value?identifier(value):undefined;
const ids=(value:unknown,max=100)=>{if(!Array.isArray(value)||value.length>max)throw new OperationError('INVALID_IDS',400);return value.map(identifier);};
function errorResponse(error:unknown){if(error instanceof OperationError)return Response.json({error:error.code},{status:error.status,headers});return Response.json({error:'OPERATION_UNAVAILABLE'},{status:503,headers});}
async function snapshot(options:{q?:string;cursor?:string;contactId?:string}){return withOperations((client,ctx)=>new CrmWorkspace(client,ctx).snapshot(options));}
export async function GET(request:Request){try{
 if(!await ownerSession())return Response.json({error:'OWNER_SESSION_REQUIRED'},{status:401,headers});
 const url=new URL(request.url);
 const data=await snapshot({q:url.searchParams.get('q')?.slice(0,120)||undefined,cursor:url.searchParams.get('cursor')||undefined,contactId:url.searchParams.get('contact')?identifier(url.searchParams.get('contact')):undefined});
 return Response.json(data,{headers});
}catch(error){return errorResponse(error);}}
export async function POST(request:Request){try{
 if(!hasTrustedOrigin(request))return Response.json({error:'INVALID_ORIGIN'},{status:403,headers});if(!await ownerSession())return Response.json({error:'OWNER_SESSION_REQUIRED'},{status:401,headers});
 if(!request.headers.get('content-type')?.startsWith('application/json'))throw new OperationError('JSON_REQUIRED',400);const raw=await request.text();if(raw.length>1_100_000)throw new OperationError('REQUEST_TOO_LARGE',413);const body=JSON.parse(raw);if(!body||typeof body!=='object'||Array.isArray(body))throw new OperationError('INVALID_REQUEST',400);
 const outcome=await withOperations(async(client,ctx)=>{const crm=new CrmWorkspace(client,ctx);switch(body.action){
 case 'createAccount':return crm.createAccount({name:body.name,domain:body.domain,website:body.website,sector:body.sector,aliases:body.aliases,metadata:body.metadata,allowSimilar:body.allowSimilar===true});
 case 'addAlias':return crm.addAlias({accountId:optionalId(body.accountId),contactId:optionalId(body.contactId),alias:body.alias});
 case 'createPerson':return crm.createPerson({name:body.name,email:body.email,source:body.source,accountId:optionalId(body.accountId),role:body.role,aliases:body.aliases,methods:body.methods,metadata:body.metadata,consent:body.consent,consentEvidence:body.consentEvidence,jurisdiction:body.jurisdiction});
 case 'updateContact':return crm.updateContact({id:identifier(body.id),version:version(body.version),metadata:body.metadata,role:body.role,ownerMembershipId:body.ownerMembershipId===null?null:optionalId(body.ownerMembershipId),accountId:body.accountId===null?null:optionalId(body.accountId)});
 case 'stageImport':return crm.stageImport({source:body.source,rows:body.rows});
 case 'previewImport':return crm.previewImport(identifier(body.id),{offset:Number(body.offset??0)});
 case 'commitImport':return crm.commitImport(identifier(body.id),optionalId(body.accountId));
 case 'discardImport':return crm.discardImport(identifier(body.id));
 case 'detectDuplicates':return crm.detectDuplicates(body.contactIds===undefined?undefined:ids(body.contactIds,1000));
 case 'mergeContacts':return crm.mergeContacts({survivorId:identifier(body.survivorId),duplicateId:identifier(body.duplicateId),candidateId:optionalId(body.candidateId),confirmCrossAccount:body.confirmCrossAccount===true});
 case 'dismissCandidate':return crm.dismissCandidate(identifier(body.id));
 case 'setRegionPolicy':return crm.setRegionPolicy({jurisdiction:body.jurisdiction,allowed:body.allowed===true,requiresOptIn:body.requiresOptIn!==false,legalReviewRef:body.legalReviewRef});
 case 'setContactPolicy':return crm.setContactPolicy({maxTouches:body.maxTouches,windowDays:body.windowDays,exclusionDays:body.exclusionDays});
 case 'recordConsent':return crm.recordConsent({contactId:identifier(body.contactId),consent:body.consent,evidenceRef:body.evidenceRef,jurisdiction:body.jurisdiction});
 case 'suppress':return crm.suppress({contactId:optionalId(body.contactId),email:body.contactId?undefined:body.email,reason:body.reason,source:'owner'});
 case 'overrideSuppression':return crm.overrideSuppression({contactId:identifier(body.contactId),lawfulBasis:body.lawfulBasis,auditRef:body.auditRef,consentEvidence:body.consentEvidence,jurisdiction:body.jurisdiction});
 case 'checkContactable':return crm.checkContactable({contactId:identifier(body.contactId),campaignId:identifier(body.campaignId),agentId:optionalId(body.agentId),channel:body.channel??'email'});
 case 'claimProspect':return crm.claimProspect({contactId:identifier(body.contactId),campaignId:identifier(body.campaignId),agentId:identifier(body.agentId)});
 case 'releaseClaim':return crm.releaseClaim(identifier(body.id),typeof body.reason==='string'?body.reason:'OWNER_RELEASE');
 case 'saveSegment':return crm.saveSegment({id:optionalId(body.id),version:body.id?version(body.version):undefined,label:body.label,filter:body.filter});
 case 'previewSegment':return crm.previewSegment({segmentId:optionalId(body.segmentId),filter:body.filter});
 case 'materializeSegment':return crm.materializeSegment(identifier(body.id));
 case 'addNote':return crm.addRelationshipEvent({contactId:identifier(body.contactId),kind:'note',summary:body.summary,actorKind:'owner',source:'owner'});
 case 'createPipeline':return crm.createPipeline({label:body.label,stages:body.stages,transitions:body.transitions});
 case 'createDeal':return crm.createDeal({projectId:identifier(body.projectId),label:body.label,valueCents:cents(body.valueCents),contactIds:ids(body.contactIds,20),campaignId:optionalId(body.campaignId),pipelineId:optionalId(body.pipelineId),expectedCloseAt:body.expectedCloseAt});
 case 'transitionDeal':return crm.transitionDeal({dealId:identifier(body.id),toStage:body.toStage,version:version(body.version),evidence:body.evidence&&typeof body.evidence==='object'?{kind:String(body.evidence.kind??'none'),ref:typeof body.evidence.ref==='string'?body.evidence.ref:undefined}:undefined});
 case 'linkInvoice':return crm.linkInvoice(identifier(body.dealId),identifier(body.invoiceId));
 case 'recordVerifiedTouchpoints':return crm.recordVerifiedTouchpoints();
 case 'attributeDeal':return crm.attributeDeal(identifier(body.id));
 case 'bulkReview':return crm.bulkReview({contactIds:ids(body.contactIds),action:body.bulkAction,reason:typeof body.reason==='string'?body.reason:undefined});
 case 'inspectContact':return crm.inspector(identifier(body.contactId));
 default:throw new OperationError('UNKNOWN_ACTION',400);
 }});
 return Response.json({outcome},{headers});
}catch(error){if(error instanceof SyntaxError)return Response.json({error:'INVALID_JSON'},{status:400,headers});return errorResponse(error);}}
