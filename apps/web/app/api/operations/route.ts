import {ownerSession} from '../../../lib/auth';
import {hasTrustedOrigin} from '../../../lib/request-origin';
import {withOperations,repositories,loadOperations} from '../../../lib/operations';
import {inWorkspace,tenant as workspaceTenant} from '../../../lib/database';
import {wakeWorker} from '../../../lib/worker-launcher';
import {OperationError,identifier,text,selection,cents,providerIds,digest,rows,tenant,event,discoverGrants} from '@dots/operations';
import {AgentIdentityRepository,ProjectCatalogRepository,AgentProjectAssignmentRepository} from '@dots/database';
import approvedNames from '../../../../../registry/approved-salesman-names.json';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store'};
const version=(value:unknown)=>{if(typeof value!=='number'||!Number.isSafeInteger(value)||value<1)throw new OperationError('INVALID_VERSION',400);return value;};
const optionalId=(value:unknown)=>value?identifier(value):undefined;
function errorResponse(error:unknown){if(error instanceof OperationError)return Response.json({error:error.code},{status:error.status,headers});return Response.json({error:'OPERATION_UNAVAILABLE'},{status:503,headers});}
export async function GET(request:Request){try{if(!await ownerSession())return Response.json({error:'OWNER_SESSION_REQUIRED'},{status:401,headers});const url=new URL(request.url);const data=await loadOperations({section:url.searchParams.get('section')??undefined,page:Number(url.searchParams.get('page')??0),query:url.searchParams.get('q')??undefined,conversation:url.searchParams.get('conversation')??undefined});return Response.json(data,{headers});}catch(error){return errorResponse(error);}}
export async function POST(request:Request){try{
 if(!hasTrustedOrigin(request))return Response.json({error:'INVALID_ORIGIN'},{status:403,headers});if(!await ownerSession())return Response.json({error:'OWNER_SESSION_REQUIRED'},{status:401,headers});
 if(!request.headers.get('content-type')?.startsWith('application/json'))throw new OperationError('JSON_REQUIRED',400);const raw=await request.text();if(raw.length>1_100_000)throw new OperationError('REQUEST_TOO_LARGE',413);const body=JSON.parse(raw);if(!body||typeof body!=='object'||Array.isArray(body))throw new OperationError('INVALID_REQUEST',400);
 let outcome:unknown=undefined;
 await withOperations(async(client,ctx)=>{const {control,sales,growth,documents,delivery,payments,queue}=repositories(client,ctx);await control.initialize();switch(body.action){
 case 'pauseAll':await control.pause(Boolean(body.paused));break;
 case 'setBudget':await control.setBudget(cents(body.limitCents),process.env.OWNER_SPEND_AUTHORIZATION_ID,Number(process.env.PAID_SPEND_LIMIT_CENTS??0),optionalId(body.projectId)??null);break;
 case 'decideApproval':await control.decideApproval(identifier(body.id),body.approved===true);break;
 case 'addAccount':outcome=await sales.addAccount(text(body.name,'name',160),typeof body.website==='string'?body.website:'');break;
 case 'addContact':outcome=await sales.addContact({name:body.name,email:body.email,source:body.source,accountId:optionalId(body.accountId),role:body.role,consent:body.consent,consentEvidence:body.consentEvidence,jurisdiction:body.jurisdiction});break;
 case 'importContacts':outcome=await sales.importContacts(body.contacts,text(body.source,'source',500),optionalId(body.accountId));break;
 case 'suppressContact':await sales.suppressContact(identifier(body.id));break;
 case 'redactContact':await sales.redactContact(identifier(body.id));break;
 case 'contactNote':await sales.addNote(identifier(body.id),text(body.content,'note',10000));break;
 case 'setConsent':await tenant(client,ctx,async tx=>{const consent=selection(body.consent,['unknown','opted_in','existing_customer','business_reviewed'],'consent');const evidence=text(body.evidence,'evidence',1000);const contact=rows(await tx.query("UPDATE app.crm_contacts SET consent=$3,consent_evidence=$4,jurisdiction=$5,version=version+1 WHERE organization_id=$1 AND id=$2 AND status='active' AND NOT EXISTS(SELECT 1 FROM app.contact_suppressions s WHERE s.organization_id=$1 AND s.email_hash=app.crm_contacts.email_hash) RETURNING id",[ctx.organizationId,identifier(body.id),consent,evidence,text(body.jurisdiction,'jurisdiction',40)]));if(!contact.length)throw new OperationError('SUPPRESSED_CONTACT_CANNOT_BE_REACTIVATED',403);await event(tx,ctx,'contact.consent_updated',body.id,{consent});});break;
 case 'addDeal':outcome=await sales.addDeal(identifier(body.projectId),text(body.label,'deal',160),cents(body.valueCents),optionalId(body.contactId));break;
 case 'moveDeal':outcome=await sales.moveDeal(identifier(body.id),body.stage,version(body.version));break;
 case 'createCampaign':outcome=await sales.createCampaign({projectId:identifier(body.projectId),label:body.label,purpose:body.purpose,goal:body.goal,strategyId:optionalId(body.strategyId),dailyLimit:body.dailyLimit,cadenceDays:body.cadenceDays});break;
 case 'campaignAudience':await sales.setAudience(identifier(body.id),body.contactIds);break;
 case 'simulateCampaign':outcome=await sales.simulateCampaign(identifier(body.id));break;
 case 'campaignApproval':outcome=await sales.campaignApproval(identifier(body.id));break;
 case 'pauseCampaign':await sales.pauseCampaign(identifier(body.id));break;
 case 'activateCampaign':{
  if(process.env.EMAIL_DELIVERY_ENABLED!=='true'||!process.env.OUTREACH_POLICY_AUTHORIZATION_ID)throw new OperationError('CONFIGURE_APPROVED_OUTREACH_FIRST',403);
  await tenant(client,ctx,async tx=>{const campaign=rows(await tx.query('SELECT * FROM app.campaigns WHERE organization_id=$1 AND id=$2 FOR UPDATE',[ctx.organizationId,identifier(body.id)]))[0];if(!campaign)throw new OperationError('NOT_FOUND',404);await control.consumeApproval(tx,identifier(body.approvalId),'campaign',campaign.id,{id:campaign.id,revision:Number(campaign.revision),goal:campaign.goal});await tx.query("UPDATE app.campaigns SET state='active',approved_revision=revision,version=version+1 WHERE organization_id=$1 AND id=$2",[ctx.organizationId,campaign.id]);await event(tx,ctx,'campaign.activated',campaign.id);});break;
 }
 case 'addStrategy':outcome=await sales.addStrategy(body.label,body.instructions);break;
 case 'createExperiment':outcome=await growth.createExperiment(identifier(body.projectId),body.label,identifier(body.championId),identifier(body.challengerId),body.challengerBasisPoints);break;
 case 'enrollExperiment':outcome=await growth.enroll(identifier(body.experimentId),identifier(body.contactId));break;
 case 'experimentResults':outcome=await growth.results(identifier(body.id));break;
 case 'promoteStrategy':outcome=await growth.promote(identifier(body.id));break;
 case 'createConversation':outcome=await sales.createConversation(identifier(body.contactId),body.subject,optionalId(body.projectId));break;
 case 'draftMessage':outcome=await sales.draftMessage(identifier(body.conversationId),body.subject,body.body,optionalId(body.campaignId));break;
 case 'editMessage':await tenant(client,ctx,async tx=>{const subject=text(body.subject,'subject',240),content=text(body.body,'body',50000);const saved=rows(await tx.query("UPDATE app.messages SET subject=$3,body=$4,content_hash=$5,state='draft',approval_id=NULL,fact_snapshot_hash=NULL,approved_campaign_revision=NULL,version=version+1 WHERE organization_id=$1 AND id=$2 AND version=$6 AND state IN ('draft','pending_approval','approved','failed') RETURNING id",[ctx.organizationId,identifier(body.id),subject,content,digest({subject,body:content}),version(body.version)]));if(!saved.length)throw new OperationError('MESSAGE_STALE_OR_ALREADY_SENT');await event(tx,ctx,'message.edited',body.id);});break;
 case 'messageApproval':outcome=await sales.messageApproval(identifier(body.id));break;
 case 'sendMessage':outcome=await delivery.send(identifier(body.id));break;
 case 'takeover':await sales.takeover(identifier(body.id),body.enabled===true);break;
 case 'discoverGrants':outcome=await discoverGrants(text(body.keyword,'keyword',120));break;
 case 'verifyMailbox':outcome=await delivery.verifyMailbox(identifier(body.id));break;
 case 'createFunding':outcome=await sales.createFunding({projectId:identifier(body.projectId),kind:body.kind,label:body.label,funder:body.funder,sourceUrl:body.sourceUrl,eligibility:body.eligibility,deadline:body.deadline,requestedCents:cents(body.requestedCents??0),restrictions:body.restrictions});break;
 case 'fundingStage':outcome=await sales.fundingStage(identifier(body.id),body.stage,version(body.version),body.authority);break;
 case 'fundingChecklist':await sales.updateChecklist(identifier(body.id),body.completed===true);break;
 case 'fundingDraft':outcome=await sales.saveFundingDraft(identifier(body.id),body.draft,version(body.version));break;
 case 'recordFundingReceipt':await tenant(client,ctx,async tx=>{const opportunity=rows(await tx.query('SELECT * FROM app.funding_opportunities WHERE organization_id=$1 AND id=$2',[ctx.organizationId,identifier(body.id)]))[0];if(!opportunity)throw new OperationError('NOT_FOUND',404);const amount=cents(body.amountCents);if(!amount)throw new OperationError('POSITIVE_AMOUNT_REQUIRED',400);await tx.query("INSERT INTO app.money_entries(organization_id,project_id,idempotency_key,kind,amount_cents,source,evidence_ref) VALUES($1,$2,$3,$4,$5,'owner_attested',$6) ON CONFLICT DO NOTHING",[ctx.organizationId,opportunity.project_id,text(body.idempotencyKey,'idempotency_key',200),opportunity.kind==='investment'?'investment_receipt':'grant_disbursement',amount,text(body.evidence,'evidence',240)]);await event(tx,ctx,'funding.receipt_attested',body.id,{amountCents:amount,source:'owner_attested'});});break;
 case 'createInvoice':outcome=await sales.createInvoice(identifier(body.projectId),body.label,body.description,cents(body.amountCents),optionalId(body.contactId),body.dueAt);break;
 case 'issueInvoice':outcome=await sales.issueInvoice(identifier(body.id),version(body.version));break;
 case 'invoiceCheckout':outcome=await payments.checkout(identifier(body.id));break;
 case 'saveDocument':outcome=await documents.save({title:body.title,content:body.content,contentType:body.contentType,rightsBasis:body.rightsBasis,projectId:optionalId(body.projectId)});break;
 case 'readDocument':outcome=await documents.read(identifier(body.id));break;
 case 'enqueueTask':{
  const mode=selection(body.mode??'simulation',['simulation','live'],'mode');const provider=body.provider?selection(body.provider,providerIds,'provider'):undefined;
  outcome=await control.enqueue(identifier(body.projectId),identifier(body.agentId),selection(body.kind,['research','draft','simulate_campaign','follow_up','grant_draft'],'task_kind'),{mode,provider,brief:text(body.brief,'brief',6000)},text(body.idempotencyKey,'idempotency_key',200));break;
 }
 case 'cancelTask':await queue.cancel(identifier(body.id));break;
 case 'retryTask':await tenant(client,ctx,async tx=>{const saved=rows(await tx.query("UPDATE app.task_queue SET state='queued',last_reason=NULL,available_at=app.utc_now(),attempts=0 WHERE organization_id=$1 AND id=$2 AND state IN ('failed','waiting') RETURNING id",[ctx.organizationId,identifier(body.id)]));if(!saved.length)throw new OperationError('TASK_REQUIRES_RECONCILIATION');await event(tx,ctx,'task.requeued',body.id);});break;
 case 'configureAgent':await tenant(client,ctx,async tx=>{const provider=body.provider?selection(body.provider,providerIds,'provider'):null;await tx.query('INSERT INTO app.agent_configuration(organization_id,agent_identity_id,role_label,provider_id,strategy_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(organization_id,agent_identity_id) DO UPDATE SET role_label=$3,provider_id=$4,strategy_id=$5,version=app.agent_configuration.version+1,updated_at=app.utc_now()',[ctx.organizationId,identifier(body.id),text(body.role,'role',120),provider,optionalId(body.strategyId)??null]);await event(tx,ctx,'agent.configured',body.id);});break;
 case 'createAgent':{const name=text(body.name,'name',120);if(!approvedNames.approvedNames.includes(name))throw new OperationError('NAME_NOT_APPROVED',400);const result=await new AgentIdentityRepository(client,approvedNames.approvedNames).create({organizationId:ctx.organizationId,ownerMembershipId:ctx.membershipId,approvedName:name,displayName:name.replaceAll('"','')});outcome=result;break;}
 case 'setAgentStatus':await tenant(client,ctx,async tx=>{const status=selection(body.status,['active','inactive'],'status');const saved=rows(await tx.query('UPDATE app.agent_identities SET status=$3,version=version+1,updated_by_membership_id=$4,updated_at=app.utc_now() WHERE organization_id=$1 AND id=$2 AND version=$5 RETURNING id',[ctx.organizationId,identifier(body.id),status,ctx.membershipId,version(body.version)]));if(!saved.length)throw new OperationError('STALE_RECORD');if(status==='inactive')await tx.query("UPDATE app.task_queue SET state='waiting',last_reason='AGENT_INACTIVE',updated_at=app.utc_now() WHERE organization_id=$1 AND agent_identity_id=$2 AND state='queued'",[ctx.organizationId,body.id]);else await tx.query("UPDATE app.task_queue SET state='queued',last_reason=NULL WHERE organization_id=$1 AND agent_identity_id=$2 AND state='waiting' AND last_reason='AGENT_INACTIVE'",[ctx.organizationId,body.id]);await event(tx,ctx,'agent.status_changed',body.id,{status});});break;
 case 'updateAssignment':outcome=await new AgentProjectAssignmentRepository(client).save({organizationId:ctx.organizationId,ownerMembershipId:ctx.membershipId,id:identifier(body.id),agentIdentityId:identifier(body.agentIdentityId),projectId:identifier(body.projectId),priority:body.priority,allocationBasisPoints:body.allocationBasisPoints,quotaLimit:body.quotaLimit,concurrencyCap:body.concurrencyCap,expectedVersion:version(body.expectedVersion)});break;
 case 'addOffer':outcome=await new ProjectCatalogRepository(client).create({kind:'offer',organizationId:ctx.organizationId,ownerMembershipId:ctx.membershipId,projectId:identifier(body.projectId),label:text(body.label,'offer',240),content:{description:text(body.description,'description',2000),priceCents:cents(body.priceCents)}});break;
 case 'addFact':{const verifiedAt=new Date().toISOString();const expiresAt=new Date(body.expiresAt);if(!Number.isFinite(expiresAt.getTime())||expiresAt.getTime()<=Date.now())throw new OperationError('FUTURE_EXPIRY_REQUIRED',400);const source=text(body.sourceUrl,'source',2048);if(!source.startsWith('https://'))throw new OperationError('HTTPS_SOURCE_REQUIRED',400);outcome=await new ProjectCatalogRepository(client).create({kind:'productFact',organizationId:ctx.organizationId,ownerMembershipId:ctx.membershipId,projectId:identifier(body.projectId),offerId:identifier(body.offerId),label:text(body.label,'fact',240),content:{body:text(body.body,'fact_body',2000),sourceUrl:source,verifiedAt,expiresAt:expiresAt.toISOString()}});break;}
 case 'configureExecution':{
  const model=body.modelEnabled===true,outbound=body.outboundEnabled===true;
  if(model&&(process.env.MODEL_API_ENABLED!=='true'||!process.env.OWNER_SPEND_AUTHORIZATION_ID||Number(process.env.PAID_SPEND_LIMIT_CENTS??0)<=0))throw new OperationError('MODEL_EXECUTION_NOT_AUTHORIZED',403);
  if(outbound&&(process.env.EMAIL_DELIVERY_ENABLED!=='true'||!process.env.OUTREACH_POLICY_AUTHORIZATION_ID||!process.env.SENDER_VERIFICATION_REFERENCE))throw new OperationError('OUTREACH_POLICY_NOT_AUTHORIZED',403);
  await tenant(client,ctx,async tx=>{await tx.query('UPDATE app.policy_controls SET model_enabled=$2,outbound_enabled=$3,version=version+1,updated_at=app.utc_now() WHERE organization_id=$1',[ctx.organizationId,model,outbound]);await event(tx,ctx,'execution.configuration_changed',null,{modelEnabled:model,outboundEnabled:outbound});});break;
 }
 case 'addMailbox':await tenant(client,ctx,async tx=>{const email=text(body.email,'email',254);if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new OperationError('INVALID_EMAIL',400);await tx.query("INSERT INTO app.mailboxes(organization_id,label,sender_email,sender_name,business_address,provider,verified,status) VALUES($1,$2,$3,$4,$5,'resend',false,'disabled')",[ctx.organizationId,text(body.label,'mailbox',120),email,text(body.name,'sender_name',120),text(body.address,'business_address',500)]);await event(tx,ctx,'mailbox.created',null);});break;
 default:throw new OperationError('UNKNOWN_ACTION',400);
 }});
 if(['enqueueTask','retryTask','pauseAll'].includes(body.action))wakeWorker();const data=await loadOperations({conversation:typeof body.conversationId==='string'&&body.conversationId?identifier(body.conversationId):undefined});return Response.json({data,outcome},{headers});
 }catch(error){if(error instanceof SyntaxError)return Response.json({error:'INVALID_JSON'},{status:400,headers});return errorResponse(error);}}
