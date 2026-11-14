// DOTS-135..143 owner revenue operations API. Owner session required for every method; POST also requires a trusted origin.
import {ownerSession} from '../../../../lib/auth';
import {hasTrustedOrigin} from '../../../../lib/request-origin';
import {withOperations} from '../../../../lib/operations';
import {OperationError,identifier,RevenueOperations,ControlPlane,PaymentGateway} from '@dots/operations';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store'};
const version=(value:unknown)=>{if(typeof value!=='number'||!Number.isSafeInteger(value)||value<1)throw new OperationError('INVALID_VERSION',400);return value;};
const optionalId=(value:unknown)=>value?identifier(value):null;
function errorResponse(error:unknown){if(error instanceof OperationError)return Response.json({error:error.code},{status:error.status,headers});return Response.json({error:'OPERATION_UNAVAILABLE'},{status:503,headers});}
export async function GET(){try{if(!await ownerSession())return Response.json({error:'OWNER_SESSION_REQUIRED'},{status:401,headers});
 const data=await withOperations((client,ctx)=>new RevenueOperations(client,ctx).snapshot());return Response.json(data,{headers});}catch(error){return errorResponse(error);}}
export async function POST(request:Request){try{
 if(!hasTrustedOrigin(request))return Response.json({error:'INVALID_ORIGIN'},{status:403,headers});if(!await ownerSession())return Response.json({error:'OWNER_SESSION_REQUIRED'},{status:401,headers});
 if(!request.headers.get('content-type')?.startsWith('application/json'))throw new OperationError('JSON_REQUIRED',400);const raw=await request.text();if(raw.length>1_100_000)throw new OperationError('REQUEST_TOO_LARGE',413);
 const body=JSON.parse(raw);if(!body||typeof body!=='object'||Array.isArray(body))throw new OperationError('INVALID_REQUEST',400);
 const outcome=await withOperations(async(client,ctx)=>{const revenue=new RevenueOperations(client,ctx);switch(body.action){
  case 'createPriceBook':return revenue.createPriceBook({projectId:body.projectId,label:body.label,offerId:optionalId(body.offerId)});
  case 'addPriceRevision':return revenue.addPriceRevision(identifier(body.priceBookId),{unitPriceCents:body.unitPriceCents,billingInterval:body.billingInterval,maxDiscountBasisPoints:body.maxDiscountBasisPoints,offerTerms:body.offerTerms,trialDays:body.trialDays,quoteValidDays:body.quoteValidDays});
  case 'approvePriceRevision':return revenue.approvePriceRevision(identifier(body.priceBookId),body.revision,body.authorizationRef);
  case 'archivePriceBook':return revenue.archivePriceBook(identifier(body.priceBookId));
  case 'createQuote':return revenue.createQuote({priceBookId:body.priceBookId,quantity:body.quantity,discountBasisPoints:body.discountBasisPoints,accountId:optionalId(body.accountId),contactId:optionalId(body.contactId),dealId:optionalId(body.dealId)});
  case 'decideQuoteDiscount':{const approval=identifier(body.approvalId);const control=new ControlPlane(client,ctx);await control.initialize();return control.decideApproval(approval,body.approved===true);}
  case 'sendQuote':return revenue.sendQuote(identifier(body.id),{channel:body.channel,evidence:body.evidence,version:version(body.version)});
  case 'acceptQuote':return revenue.acceptQuote(identifier(body.id),{evidence:body.evidence,bindingAuthorizationRef:body.bindingAuthorizationRef,version:version(body.version)});
  case 'declineQuote':return revenue.declineQuote(identifier(body.id),version(body.version));
  case 'expireQuotes':return revenue.expireQuotes();
  case 'invoiceFromQuote':return revenue.invoiceFromQuote(identifier(body.id));
  case 'invoiceCheckout':return new PaymentGateway(client,ctx).checkout(identifier(body.invoiceId));
  case 'createSubscription':return revenue.createSubscription({projectId:body.projectId,label:body.label,amountCents:body.amountCents,billingInterval:body.billingInterval,accountId:optionalId(body.accountId),contactId:optionalId(body.contactId),quoteId:optionalId(body.quoteId),trialDays:body.trialDays,supportOwnerAgentId:optionalId(body.supportOwnerAgentId),providerSubscriptionId:body.providerSubscriptionId||null,testMode:body.testMode!==false});
  case 'completeOnboardingTask':return revenue.completeOnboardingTask(identifier(body.id),{evidence:body.evidence,actingAgentId:optionalId(body.actingAgentId)});
  case 'openEscalation':return revenue.openEscalation(identifier(body.subscriptionId),{severity:body.severity,summary:body.summary});
  case 'resolveEscalation':return revenue.resolveEscalation(identifier(body.id),{resolution:body.resolution,actingAgentId:optionalId(body.actingAgentId)});
  case 'completeTrial':return revenue.completeTrial(identifier(body.subscriptionId),{converted:body.converted===true,evidence:body.evidence});
  case 'recordRetentionOutcome':return revenue.recordRetentionOutcome(identifier(body.subscriptionId),{outcome:body.outcome,reasonCode:body.reasonCode,evidence:body.evidence});
  case 'addCalendarConnection':return revenue.addCalendarConnection({label:body.label,provider:body.provider,calendarRef:body.calendarRef,timezone:body.timezone,credentialEnvRef:body.credentialEnvRef});
  case 'delegateCalendar':return revenue.delegateCalendar({connectionId:body.connectionId,agentId:body.agentId,scopes:body.scopes,authorizationRef:body.authorizationRef,expiresAt:body.expiresAt});
  case 'revokeCalendarDelegation':return revenue.revokeCalendarDelegation(identifier(body.id));
  case 'calendarAvailability':return revenue.availability(identifier(body.agentId),identifier(body.connectionId),body.from,body.to);
  case 'scheduleMeeting':return revenue.scheduleMeeting(identifier(body.agentId),{connectionId:body.connectionId,subject:body.subject,startsAt:body.startsAt,endsAt:body.endsAt,contactId:optionalId(body.contactId),accountId:optionalId(body.accountId),location:body.location});
  case 'rescheduleMeeting':return revenue.rescheduleMeeting(identifier(body.agentId),identifier(body.id),{startsAt:body.startsAt,endsAt:body.endsAt,version:version(body.version)});
  case 'cancelMeeting':return revenue.cancelMeeting(identifier(body.agentId),identifier(body.id));
  case 'meetingIcs':return revenue.meetingIcs(identifier(body.id));
  case 'exportCrm':return revenue.exportCrm({format:body.format,kinds:body.kinds,system:body.system});
  case 'importCrm':return revenue.importCrm({system:body.system,format:body.format,records:body.records,projectId:optionalId(body.projectId)});
  case 'setCrmFieldOwnership':return revenue.setCrmFieldOwnership({system:body.system,kind:body.kind,field:body.field,owner:body.owner});
  case 'createLeadForm':return revenue.createLeadForm({projectId:body.projectId,label:body.label,consentText:body.consentText,consentVersion:body.consentVersion,retentionDays:body.retentionDays,dailyLimitPerIp:body.dailyLimitPerIp,allowedOrigin:body.allowedOrigin||null});
  case 'disableLeadForm':return revenue.disableLeadForm(identifier(body.id));
  case 'purgeExpiredLeads':return revenue.purgeExpiredLeads();
  case 'createPortalLink':{const link=await revenue.createPortalLink(identifier(body.accountId),typeof body.expiresInDays==='number'?body.expiresInDays:14);const origin=process.env.APP_ORIGIN;return {...link,url:origin?`${origin}/portal/${link.token}`:null};}
  case 'revokePortalLink':return revenue.revokePortalLink(identifier(body.id));
  case 'cohortReport':return revenue.cohortReport();
  default:throw new OperationError('UNKNOWN_ACTION',400);
 }});
 const data=await withOperations((client,ctx)=>new RevenueOperations(client,ctx).snapshot());return Response.json({data,outcome:outcome??null},{headers});
 }catch(error){if(error instanceof SyntaxError)return Response.json({error:'INVALID_JSON'},{status:400,headers});return errorResponse(error);}}
