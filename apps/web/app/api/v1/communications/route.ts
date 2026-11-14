// DOTS-094..DOTS-108: Conversation Center API. Owner session required; POST also requires a trusted origin.
import {ownerSession} from '../../../../lib/auth';
import {hasTrustedOrigin} from '../../../../lib/request-origin';
import {withOperations} from '../../../../lib/operations';
import {OperationError,CommunicationsWorkspace,DeliveryGateway,productionDispatchChecks,identifier,text,ControlPlane,type OptOutChannel} from '@dots/operations';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store'};
function errorResponse(error:unknown){if(error instanceof OperationError)return Response.json({error:error.code},{status:error.status,headers});return Response.json({error:'COMMUNICATIONS_UNAVAILABLE'},{status:503,headers});}
const workspace=(client:Parameters<Parameters<typeof withOperations>[0]>[0],ctx:Parameters<Parameters<typeof withOperations>[0]>[1])=>new CommunicationsWorkspace(client,ctx,process.env,fetch,()=>new Date(),productionDispatchChecks);
const whole=(value:unknown,name:string)=>{if(typeof value!=='number'||!Number.isSafeInteger(value)||value<1)throw new OperationError(`INVALID_${name}`,400);return value;};

export async function GET(request:Request){try{
 if(!await ownerSession())return Response.json({error:'OWNER_SESSION_REQUIRED'},{status:401,headers});
 const url=new URL(request.url);const attachment=url.searchParams.get('attachment');
 if(attachment){const file=await withOperations((client,ctx)=>workspace(client,ctx).downloadAttachment(identifier(attachment)));return new Response(Buffer.from(file.body),{headers:{...file.headers}});}
 const conversation=url.searchParams.get('conversation');
 const data=await withOperations((client,ctx)=>workspace(client,ctx).snapshot(conversation?identifier(conversation):undefined));
 return Response.json({...data,capabilities:{emailEnabled:process.env.EMAIL_DELIVERY_ENABLED==='true',receivingEnabled:process.env.EMAIL_RECEIVING_ENABLED==='true',outreachPolicy:Boolean(process.env.OUTREACH_POLICY_AUTHORIZATION_ID)}},{headers});
}catch(error){return errorResponse(error);}}

export async function POST(request:Request){try{
 if(!hasTrustedOrigin(request))return Response.json({error:'INVALID_ORIGIN'},{status:403,headers});if(!await ownerSession())return Response.json({error:'OWNER_SESSION_REQUIRED'},{status:401,headers});
 if(!request.headers.get('content-type')?.startsWith('application/json'))throw new OperationError('JSON_REQUIRED',400);const raw=await request.text();if(raw.length>7_500_000)throw new OperationError('REQUEST_TOO_LARGE',413);
 const body=JSON.parse(raw);if(!body||typeof body!=='object'||Array.isArray(body))throw new OperationError('INVALID_REQUEST',400);
 let outcome:unknown=undefined;
 await withOperations(async(client,ctx)=>{const comms=workspace(client,ctx);await new ControlPlane(client,ctx).initialize();switch(body.action){
  case 'setSenderProfile':outcome=await comms.setSenderProfile({legalName:body.legalName,postalAddress:body.postalAddress});break;
  case 'connectMailbox':outcome=await comms.connectMailbox({label:body.label,email:body.email,senderName:body.senderName,provider:body.provider,tokenRef:body.tokenRef,scopes:body.scopes});break;
  case 'verifyMailbox':outcome=await new DeliveryGateway(client,ctx).verifyMailbox(identifier(body.id));break;
  case 'checkDmarc':outcome=await comms.checkDmarc(identifier(body.id));break;
  case 'grantMailboxConsent':outcome=await comms.grantMailboxConsent(identifier(body.id),body.consentRef);break;
  case 'revokeMailboxConsent':outcome=await comms.revokeMailboxConsent(identifier(body.id));break;
  case 'rotateMailboxToken':outcome=await comms.rotateMailboxToken(identifier(body.id),body.tokenRef,body.expiresAt);break;
  case 'composeDraft':outcome=await comms.composeDraft({conversationId:body.conversationId,mode:body.mode,replyToMessageId:body.replyToMessageId||undefined,forwardMessageId:body.forwardMessageId||undefined,subject:body.subject||undefined,body:body.body,cc:body.cc,variables:body.variables,sourceEvidence:body.sourceEvidence,attachmentIds:body.attachmentIds,expiresAt:body.expiresAt||undefined,mailboxId:body.mailboxId||undefined,campaignId:body.campaignId||undefined});break;
  case 'reviseDraft':outcome=await comms.reviseDraft(identifier(body.id),whole(body.revision,'REVISION'),{subject:body.subject,body:body.body,cc:body.cc,attachmentIds:body.attachmentIds,expiresAt:body.expiresAt});break;
  case 'previewDraft':outcome=await comms.preview(identifier(body.id));break;
  case 'approveExact':outcome=await comms.approveExact(identifier(body.id),body.revisionHash);break;
  case 'sendMessage':outcome=await comms.send(identifier(body.id));break;
  case 'claimThread':outcome=await comms.claimThread(identifier(body.id));break;
  case 'releaseThread':outcome=await comms.releaseThread(identifier(body.id));break;
  case 'delegateThread':outcome=await comms.delegateThread(identifier(body.id),body.enabled===true);break;
  case 'setPriority':outcome=await comms.setPriority(identifier(body.id),body.priority,body.slaHours);break;
  case 'markHandled':outcome=await comms.markHandled(identifier(body.id));break;
  case 'createSequence':outcome=await comms.createSequence({campaignId:body.campaignId,label:body.label,subjectTemplate:body.subjectTemplate,bodyTemplate:body.bodyTemplate,maxTouches:body.maxTouches,intervalDays:body.intervalDays,quietStartHour:body.quietStartHour,quietEndHour:body.quietEndHour,timezone:body.timezone});break;
  case 'setSequenceState':outcome=await comms.setSequenceState(identifier(body.id),body.state);break;
  case 'enrollSequence':outcome=await comms.enroll(identifier(body.sequenceId),identifier(body.contactId));break;
  case 'claimDueSteps':outcome=await comms.claimDueSteps(10);break;
  case 'cancelEnrollment':outcome=await comms.cancelEnrollment(identifier(body.id),'owner_cancelled');break;
  case 'processOptOut':outcome=await comms.processOptOut(identifier(body.contactId),'owner' as OptOutChannel,{note:typeof body.note==='string'?body.note.slice(0,200):''});break;
  case 'uploadAttachment':outcome=await comms.uploadAttachment({conversationId:body.conversationId,filename:body.filename,declaredType:body.declaredType,base64:body.base64});break;
  case 'resolveReconciliation':outcome=await comms.resolveReconciliation(identifier(body.id),body.resolution,text(body.evidence,'evidence',500),body.providerMessageId);break;
  default:throw new OperationError('UNKNOWN_ACTION',400);
 }});
 return Response.json({outcome},{headers});
}catch(error){if(error instanceof SyntaxError)return Response.json({error:'INVALID_JSON'},{status:400,headers});return errorResponse(error);}}
