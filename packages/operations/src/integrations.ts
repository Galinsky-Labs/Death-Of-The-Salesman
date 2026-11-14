import {createHmac,timingSafeEqual} from 'node:crypto';
import {type Client,type Context,type Row,rows,tenant,event,digest,cents,fail,OperationError,randomUUID} from './common.js';
import {ControlPlane} from './control.js';
import {recordDeliveryEvent,importInboundMessage,normalizeInbound,markProviderAccepted,applyMailboxAuthentication,type DeliveryKind} from './communications.js';
export function signedOptOut(org:string,contact:string,secret:string):string{const value=Buffer.from(JSON.stringify({org,contact})).toString('base64url');return `${value}.${createHmac('sha256',secret).update(value).digest('base64url')}`;}
export function verifyOptOut(token:string,secret:string|undefined):{org:string;contact:string}|null {if(!secret||token.length>1000)return null;const [value,signature]=token.split('.');if(!value||!signature)return null;const expected=createHmac('sha256',secret).update(value).digest();const actual=Buffer.from(signature,'base64url');if(actual.length!==expected.length||!timingSafeEqual(actual,expected))return null;try{const result=JSON.parse(Buffer.from(value,'base64url').toString('utf8'));return typeof result.org==='string'&&typeof result.contact==='string'?result:null;}catch{return null;}}
export function verifyWebhook(raw:string,signature:string|null,secret:string|undefined,now=Date.now()):boolean {
 if(!signature||!secret)return false;const parts=Object.fromEntries(signature.split(',').map(item=>item.split('=')));const timestamp=Number(parts.t);if(!Number.isFinite(timestamp)||Math.abs(now/1000-timestamp)>300||!parts.v1)return false;
 const expected=createHmac('sha256',secret).update(`${timestamp}.${raw}`).digest();const actual=Buffer.from(parts.v1,'hex');return actual.length===expected.length&&timingSafeEqual(actual,expected);
}
export function verifySvix(raw:string,headers:{id:string|null;timestamp:string|null;signature:string|null},secret:string|undefined,now=Date.now()):boolean {
 if(!secret||!headers.id||!headers.timestamp||!headers.signature||!Number.isFinite(Number(headers.timestamp))||Math.abs(now/1000-Number(headers.timestamp))>300)return false;
 const key=Buffer.from(secret.startsWith('whsec_')?secret.slice(6):secret,'base64');if(key.length<16)return false;
 const expected=createHmac('sha256',key).update(`${headers.id}.${headers.timestamp}.${raw}`).digest();return headers.signature.split(' ').some(part=>{const [version,value]=part.split(',');if(version!=='v1'||!value)return false;const actual=Buffer.from(value,'base64');return actual.length===expected.length&&timingSafeEqual(actual,expected);});
}
export function businessHours(now:Date,timezone:string):boolean {const weekday=new Intl.DateTimeFormat('en-US',{timeZone:timezone,weekday:'short'}).format(now);const hour=Number(new Intl.DateTimeFormat('en-US',{timeZone:timezone,hour:'2-digit',hourCycle:'h23'}).format(now));return !['Sat','Sun'].includes(weekday)&&hour>=9&&hour<17;}
export type DispatchActor='owner'|'agent';
export type DispatchCheckInput={tx:Client;ctx:Context;message:Row;mailbox:Row;actor:DispatchActor;environment:Record<string,string|undefined>;now:Date};
/** A governance check run inside the dispatch transaction, after the built-in gates and immediately before the approval is consumed. Throw (fail) to block the send. */
export type DispatchCheck=(input:DispatchCheckInput)=>Promise<void>;
export type DeliveryOptions={beforeDispatch?:readonly DispatchCheck[]};
const providerIdPattern=/^[A-Za-z0-9_.:@-]{1,200}$/;
const unsafeHeader=/[\r\n\0<>"]/;
const mailPattern=/^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;
const deliveryKinds:Record<string,DeliveryKind>={'email.sent':'accepted','email.delivered':'delivered','email.delivery_delayed':'deferred','email.bounced':'bounced','email.complained':'complained','email.failed':'failed'};
export class DeliveryGateway {
 constructor(private readonly client:Client,private readonly ctx:Context,private readonly environment:Record<string,string|undefined>=process.env,private readonly transport:typeof fetch=fetch,private readonly clock:()=>Date=()=>new Date(),private readonly options:DeliveryOptions={}){}
 async verifyMailbox(id:string){
  if(!this.environment.EMAIL_DELIVERY_TOKEN||!this.environment.SENDER_VERIFICATION_REFERENCE)return fail('SENDER_SETUP_INCOMPLETE',403);
  const mailbox=await tenant(this.client,this.ctx,async tx=>rows(await tx.query('SELECT * FROM app.mailboxes WHERE organization_id=$1 AND id=$2',[this.ctx.organizationId,id]))[0]);if(!mailbox)return fail('NOT_FOUND',404);
  if(mailbox.provider!=='resend')return fail('EMAIL_PROVIDER_UNSUPPORTED',503);
  const response=await this.transport('https://api.resend.com/domains',{headers:{authorization:`Bearer ${this.environment.EMAIL_DELIVERY_TOKEN}`},signal:AbortSignal.timeout(10000),redirect:'error'});if(!response.ok)return fail('SENDER_VERIFICATION_UNAVAILABLE',503);
  const result=await response.json() as {data?:{name:string;status:string;records?:{record?:string;type?:string;status?:string}[]}[]};const domain=String(mailbox.sender_email).split('@')[1]?.toLowerCase();
  const match=result.data?.find(item=>typeof item?.name==='string'&&item.name.toLowerCase()===domain&&item.status==='verified');if(!match)return fail('SENDER_DOMAIN_NOT_VERIFIED',403);
  // Resend reports a domain as verified only once its SPF and DKIM records verify; per-record statuses win when present. DMARC is checked separately (CommunicationsWorkspace.checkDmarc).
  const record=(name:string)=>{const found=(match.records??[]).filter(item=>String(item.record??item.type??'').toUpperCase()===name);if(!found.length)return name==='DMARC'?String(mailbox.dmarc_status??'unknown'):'pass';return found.every(item=>item.status==='verified')?'pass':found.some(item=>item.status==='failed')?'fail':'pending';};
  const spf=record('SPF'),dkim=record('DKIM'),dmarc=record('DMARC');
  return tenant(this.client,this.ctx,async tx=>{
   await tx.query("INSERT INTO app.mailbox_auth_checks(organization_id,mailbox_id,spf_status,dkim_status,dmarc_status,source,evidence_hash) VALUES($1,$2,$3,$4,$5,'provider',$6)",[this.ctx.organizationId,id,spf,dkim,dmarc,digest({domain,status:match.status,records:match.records??[]})]);
   await applyMailboxAuthentication(tx,this.ctx,id,{spf,dkim,dmarc});
   await event(tx,this.ctx,'mailbox.provider_verified',id,{spf,dkim,dmarc});return {verified:true,spf,dkim,dmarc};});
 }
 /** Dispatches one owner-approved outbound message. `actor` defaults to the agent so a conversation under human takeover fails closed. */
 async send(messageId:string,sendOptions:{actor?:DispatchActor}={}){const env=this.environment;const actor:DispatchActor=sendOptions.actor==='owner'?'owner':'agent';
  const free=env.EMAIL_BILLING_MODE==='free';
  if(env.EMAIL_DELIVERY_ENABLED!=='true'||!env.EMAIL_DELIVERY_TOKEN)return fail('EMAIL_DELIVERY_NOT_AUTHORIZED',403);
  if(!env.OUTREACH_POLICY_AUTHORIZATION_ID)return fail('OUTREACH_POLICY_NOT_AUTHORIZED',403);
  if(free){if(env.EMAIL_FREE_PLAN_CONFIRMED!=='true'||env.EMAIL_COST_CENTS!=='0')return fail('FREE_EMAIL_PLAN_NOT_CONFIRMED',403);}
  else if(!env.OWNER_SPEND_AUTHORIZATION_ID||Number(env.PAID_SPEND_LIMIT_CENTS??0)<=0)return fail('EMAIL_DELIVERY_NOT_AUTHORIZED',403);
  if(!env.UNSUBSCRIBE_SIGNING_KEY||!env.APP_ORIGIN||!env.SENDER_VERIFICATION_REFERENCE)return fail('SENDER_SETUP_INCOMPLETE',503);
  if(!businessHours(this.clock(),env.OUTREACH_TIMEZONE??'America/New_York'))return fail('OUTSIDE_BUSINESS_HOURS');
  const cost=Number(env.EMAIL_COST_CENTS);if(!Number.isSafeInteger(cost)||cost<0)return fail('EMAIL_PRICE_NOT_CONFIGURED',503);
  const budget=new ControlPlane(this.client,this.ctx);const scope=await tenant(this.client,this.ctx,async tx=>rows(await tx.query('SELECT m.approval_id,ca.project_id FROM app.messages m JOIN app.campaigns ca ON ca.id=m.campaign_id AND ca.organization_id=m.organization_id WHERE m.organization_id=$1 AND m.id=$2',[this.ctx.organizationId,messageId]))[0]);if(!scope?.approval_id)return fail('OWNER_APPROVAL_REQUIRED',403);const charge=free?0:Math.max(1,cost);const reservation=await budget.reserve(`message:${messageId}:${randomUUID()}`,charge,scope.project_id);let sending=false,attemptId:string|null=null;
  try {
   const message:Row=await tenant(this.client,this.ctx,async tx=>{
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`dispatch:${this.ctx.organizationId}`]);
    if(free){const usage=rows(await tx.query("SELECT count(*) FILTER(WHERE COALESCE(sent_at,created_at)>=date_trunc('day',app.utc_now()))::int AS daily,count(*)::int AS monthly FROM app.messages WHERE organization_id=$1 AND direction='outbound' AND state IN ('sending','sent','delivered','quarantined') AND COALESCE(sent_at,created_at)>=date_trunc('month',app.utc_now())",[this.ctx.organizationId]))[0]!;if(Number(usage.daily)>=100||Number(usage.monthly)>=3000)return fail('FREE_EMAIL_QUOTA_REACHED');}
    const item=rows(await tx.query(`SELECT m.*,c.contact_id,c.human_takeover,c.claimed_by_membership_id,c.agent_delegated,ct.email,ct.email_hash,ct.status AS contact_status,ct.consent,ct.jurisdiction,ca.state AS campaign_state,ca.purpose,ca.revision,ca.approved_revision,
      p.paused,p.outbound_enabled FROM app.messages m JOIN app.conversations c ON c.id=m.conversation_id AND c.organization_id=m.organization_id
      JOIN app.crm_contacts ct ON ct.id=c.contact_id AND ct.organization_id=m.organization_id
      JOIN app.policy_controls p ON p.organization_id=m.organization_id LEFT JOIN app.campaigns ca ON ca.id=m.campaign_id AND ca.organization_id=m.organization_id
      WHERE m.organization_id=$1 AND m.id=$2 FOR UPDATE OF m,ct`,[this.ctx.organizationId,messageId]))[0];
    if(!item)return fail('NOT_FOUND',404);if(item.direction!=='outbound')return fail('OUTBOUND_MESSAGE_REQUIRED',400);if(!['pending_approval','approved'].includes(item.state)||!item.approval_id)return fail('OWNER_APPROVAL_REQUIRED',403);
    if(item.paused||!item.outbound_enabled)return fail('OUTBOUND_DISABLED',403);
    if(item.human_takeover&&!item.agent_delegated&&!(actor==='owner'&&item.claimed_by_membership_id===this.ctx.membershipId))return fail('OWNER_CONTROLS_CONVERSATION',403);
    if(item.draft_expires_at&&new Date(item.draft_expires_at).getTime()<=this.clock().getTime())return fail('DRAFT_EXPIRED',403);
    if(!item.campaign_id||item.campaign_state!=='active'||Number(item.revision)!==Number(item.approved_revision))return fail('CAMPAIGN_NOT_APPROVED',403);
    if(item.purpose!=='product')return fail('FUNDING_SOLICITATION_REQUIRES_SEPARATE_AUTHORITY',403);
    if(item.contact_status!=='active'||item.consent!=='opted_in'||!item.email)return fail('CONTACT_NOT_ELIGIBLE',403);
    const jurisdictions=(env.EMAIL_ALLOWED_JURISDICTIONS??'').split(',').map(x=>x.trim());if(!jurisdictions.includes(item.jurisdiction))return fail('JURISDICTION_NOT_APPROVED',403);
    const cc:string[]=(item.cc_addresses??[]).map((value:string)=>String(value).toLowerCase());if(cc.length>10||cc.some(address=>!mailPattern.test(address)||unsafeHeader.test(address)))return fail('RECIPIENT_INVALID',400);
    if(rows(await tx.query('SELECT email_hash FROM app.contact_suppressions WHERE organization_id=$1 AND email_hash=ANY($2::text[])',[this.ctx.organizationId,[item.email_hash,...cc.map(address=>digest(address))]])).length)return fail('CONTACT_SUPPRESSED',403);
    const campaign=rows(await tx.query('SELECT daily_limit,cadence_days FROM app.campaigns WHERE organization_id=$1 AND id=$2',[this.ctx.organizationId,item.campaign_id]))[0]!;
    const daily=rows(await tx.query("SELECT count(*)::int AS total FROM app.messages WHERE organization_id=$1 AND campaign_id=$2 AND state IN ('sending','sent','delivered') AND COALESCE(sent_at,created_at)>=date_trunc('day',app.utc_now())",[this.ctx.organizationId,item.campaign_id]))[0]!;
    const contactHistory=rows(await tx.query("SELECT max(COALESCE(m.sent_at,m.created_at)) AS last_contact FROM app.messages m JOIN app.conversations c ON c.id=m.conversation_id AND c.organization_id=m.organization_id WHERE m.organization_id=$1 AND c.contact_id=$2 AND m.state IN ('sending','sent','delivered')",[this.ctx.organizationId,item.contact_id]))[0]!;
    if(daily.total>=campaign.daily_limit)return fail('DAILY_LIMIT_REACHED');
    // Cadence limits unsolicited touches; an owner reply to a contact who wrote back after our last outbound message is exempt.
    const answering=item.reply_mode==='reply'&&rows(await tx.query("SELECT 1 FROM app.messages WHERE organization_id=$1 AND conversation_id=$2 AND direction='inbound' AND state='received' AND created_at>COALESCE($3::timestamptz,'-infinity'::timestamptz) LIMIT 1",[this.ctx.organizationId,item.conversation_id,contactHistory.last_contact??null])).length>0;
    if(contactHistory.last_contact&&!answering&&Date.now()-new Date(contactHistory.last_contact).getTime()<Number(campaign.cadence_days)*86400000)return fail('CONTACT_CADENCE_LIMIT');
    const mailbox=item.mailbox_id?rows(await tx.query("SELECT * FROM app.mailboxes WHERE organization_id=$1 AND id=$2 AND verified AND status='active'",[this.ctx.organizationId,item.mailbox_id]))[0]:rows(await tx.query("SELECT * FROM app.mailboxes WHERE organization_id=$1 AND verified AND status='active' ORDER BY created_at LIMIT 1",[this.ctx.organizationId]))[0];if(!mailbox)return fail('VERIFIED_SENDER_REQUIRED',403);
    if(mailbox.provider!=='resend')return fail('EMAIL_PROVIDER_UNSUPPORTED',503);
    if(!mailPattern.test(String(mailbox.sender_email))||unsafeHeader.test(String(mailbox.sender_email))||unsafeHeader.test(String(mailbox.sender_name))||String(mailbox.sender_name).length>120)return fail('SENDER_INVALID',403);
    if((item.attachment_ids??[]).length)return fail('ATTACHMENT_TRANSPORT_NOT_CONFIGURED',503);
    const facts=rows(await tx.query("SELECT id,version,content FROM app.vetted_product_facts WHERE organization_id=$1 AND project_id=(SELECT project_id FROM app.campaigns WHERE id=$2 AND organization_id=$1) AND status='active' ORDER BY id",[this.ctx.organizationId,item.campaign_id]));if(!facts.length||facts.some(f=>!f.content.expiresAt||new Date(f.content.expiresAt).getTime()<Date.now()))return fail('APPROVED_FACTS_REQUIRED',403);
    if(digest(facts)!==item.fact_snapshot_hash||Number(item.approved_campaign_revision)!==Number(item.revision))return fail('APPROVED_FACTS_CHANGED',403);
    for(const check of this.options.beforeDispatch??[])await check({tx,ctx:this.ctx,message:item,mailbox,actor,environment:env,now:this.clock()});
    await budget.consumeApproval(tx,item.approval_id,'message',item.id,{subject:item.subject,body:item.body,factsHash:item.fact_snapshot_hash,campaignRevision:Number(item.approved_campaign_revision)});
    const profile=rows(await tx.query('SELECT legal_name,postal_address FROM app.sender_profiles WHERE organization_id=$1',[this.ctx.organizationId]))[0];
    await tx.query("UPDATE app.messages SET state='sending',mailbox_id=$3 WHERE organization_id=$1 AND id=$2",[this.ctx.organizationId,messageId,mailbox.id]);
    const attempt=rows(await tx.query('INSERT INTO app.dispatch_attempts(organization_id,message_id,idempotency_key,reservation_id,cost_cents) VALUES($1,$2,$3,$4,$5) RETURNING id',[this.ctx.organizationId,messageId,`${messageId}:${item.content_hash}`,reservation.id,charge]))[0]!;
    await event(tx,this.ctx,'message.dispatch_authorized',messageId,{actor});return {...item,cc,mailbox,profile,attemptId:attempt.id};
   });sending=true;attemptId=message.attemptId;
   const token=signedOptOut(this.ctx.organizationId,message.contact_id,env.UNSUBSCRIBE_SIGNING_KEY);const page=`${env.APP_ORIGIN}/unsubscribe?token=${token}`,oneClick=`${env.APP_ORIGIN}/api/unsubscribe?token=${token}`;
   const postal=message.profile?`${message.profile.legal_name}\n${message.profile.postal_address}`:message.mailbox.business_address;
   const headers:Record<string,string>={'List-Unsubscribe':`<${oneClick}>`,'List-Unsubscribe-Post':'List-Unsubscribe=One-Click'};
   if(message.message_id_header)headers['Message-ID']=`<${message.message_id_header}>`;if(message.in_reply_to_header)headers['In-Reply-To']=`<${message.in_reply_to_header}>`;if((message.references_headers??[]).length)headers.References=message.references_headers.map((value:string)=>`<${value}>`).join(' ');
   if(Object.values(headers).some(value=>/[\r\n\0]/.test(value)))return fail('HEADER_INVALID',400);
   let response:Response;
   try{response=await this.transport('https://api.resend.com/emails',{method:'POST',headers:{authorization:`Bearer ${env.EMAIL_DELIVERY_TOKEN}`,'content-type':'application/json','Idempotency-Key':`${messageId}:${message.content_hash}`},body:JSON.stringify({from:`${message.mailbox.sender_name} <${message.mailbox.sender_email}>`,to:[message.email],...(message.cc.length?{cc:message.cc}:{}),subject:message.subject,text:`${message.body}\n\n${postal}\nUnsubscribe: ${page}`,headers}),signal:AbortSignal.timeout(20000),redirect:'error'});}
   catch{return fail('EMAIL_DELIVERY_UNCERTAIN',503);}
   if(!response.ok){if(response.status===429)return fail('EMAIL_RATE_LIMITED',503);if(response.status>=400&&response.status<500&&![408,409].includes(response.status))return fail('EMAIL_PROVIDER_REJECTED',502);return fail('EMAIL_DELIVERY_UNCERTAIN',503);}
   let receipt:{id?:unknown};try{receipt=await response.json() as {id?:unknown};}catch{return fail('EMAIL_DELIVERY_UNCERTAIN',503);}
   if(typeof receipt.id!=='string'||!providerIdPattern.test(receipt.id))return fail('EMAIL_DELIVERY_UNCERTAIN',503);const providerId=receipt.id;
   await tenant(this.client,this.ctx,async tx=>{await markProviderAccepted(tx,this.ctx,messageId,providerId,attemptId!,'accepted');await event(tx,this.ctx,'message.sent',messageId,{source:'provider'});});await budget.settle(reservation.id,cost,providerId,false,'provider');return {state:'sent',providerMessageId:providerId};
  }catch(error){const code=error instanceof OperationError?error.code:'EMAIL_DELIVERY_UNCERTAIN';const certainNotSent=!sending||['EMAIL_RATE_LIMITED','EMAIL_PROVIDER_REJECTED','HEADER_INVALID'].includes(code);
   if(certainNotSent)await budget.settle(reservation.id,0,`not-sent:${messageId}`,true);
   if(sending)await tenant(this.client,this.ctx,async tx=>{const updated=rows(await tx.query("UPDATE app.messages SET state=$3 WHERE organization_id=$1 AND id=$2 AND state='sending' RETURNING id",[this.ctx.organizationId,messageId,certainNotSent?'failed':'quarantined']));
    if(attemptId)await tx.query("UPDATE app.dispatch_attempts SET state=$3,reason_code=$4,finished_at=app.utc_now() WHERE organization_id=$1 AND id=$2 AND state='dispatching'",[this.ctx.organizationId,attemptId,certainNotSent?'rejected':'uncertain',code]);
    if(updated.length&&!certainNotSent)await tx.query("INSERT INTO app.reconciliation_items(organization_id,kind,message_id,details) VALUES($1,'uncertain_send',$2,$3::jsonb)",[this.ctx.organizationId,messageId,JSON.stringify({reasonCode:code,attemptId})]);
    await event(tx,this.ctx,'message.dispatch_failed',messageId,{reasonCode:code,quarantined:!certainNotSent});});throw error;}
 }
 async ingestEmail(eventId:string,payload:any,trustedReplay=false){
  if(payload?.type==='email.received')return this.receiveEmail(eventId,payload);
  return tenant(this.client,this.ctx,async tx=>{
  const existing=rows(await tx.query("SELECT payload_hash,processed_at,normalized_event FROM app.provider_receipts WHERE organization_id=$1 AND provider='resend' AND event_id=$2",[this.ctx.organizationId,eventId]))[0];if(existing){if(trustedReplay)payload=existing.normalized_event;else if(existing.payload_hash!==digest(payload))return fail('RECEIPT_CONFLICT');if(existing.processed_at)return {duplicate:true};}
  else await tx.query("INSERT INTO app.provider_receipts(organization_id,provider,event_id,payload_hash,normalized_event) VALUES($1,'resend',$2,$3,$4::jsonb)",[this.ctx.organizationId,eventId,digest(payload),JSON.stringify({type:payload?.type,created_at:payload?.created_at,data:{email_id:payload?.data?.email_id,bounce:{type:payload?.data?.bounce?.type}}})]);
  const providerId=payload?.data?.email_id;const kind=deliveryKinds[String(payload?.type)];
  if(typeof providerId!=='string'||!providerIdPattern.test(providerId)||!kind){await tx.query("UPDATE app.provider_receipts SET processed_at=app.utc_now() WHERE organization_id=$1 AND provider='resend' AND event_id=$2",[this.ctx.organizationId,eventId]);return {ignored:true};}
  const bounceType=kind==='bounced'?(/transient|soft/i.test(String(payload.data?.bounce?.type??''))?'soft':'hard'):null;
  const occurred=new Date(payload.created_at??this.clock());
  const outcome=await recordDeliveryEvent(tx,this.ctx,{providerEventId:`resend:${eventId}`,providerMessageId:providerId,kind,bounceType,occurredAt:Number.isFinite(occurred.getTime())?occurred:this.clock(),source:'provider'},this.environment);
  if(outcome.messageId&&kind==='delivered'){const message=rows(await tx.query('SELECT m.campaign_id,c.contact_id FROM app.messages m JOIN app.conversations c ON c.id=m.conversation_id AND c.organization_id=m.organization_id WHERE m.organization_id=$1 AND m.id=$2',[this.ctx.organizationId,outcome.messageId]))[0];if(message?.campaign_id)await tx.query("UPDATE app.experiment_enrollments SET exposed_at=COALESCE(exposed_at,app.utc_now()),source='provider' WHERE organization_id=$1 AND contact_id=$2 AND experiment_id IN(SELECT ex.id FROM app.experiments ex JOIN app.campaigns ca ON ca.organization_id=ex.organization_id AND ca.project_id=ex.project_id WHERE ex.organization_id=$1 AND ex.state='active' AND ca.id=$3 AND (ca.strategy_id=ex.champion_strategy_id OR ca.strategy_id=ex.challenger_strategy_id))",[this.ctx.organizationId,message.contact_id,message.campaign_id]);}
  await tx.query("UPDATE app.provider_receipts SET processed_at=app.utc_now() WHERE organization_id=$1 AND provider='resend' AND event_id=$2",[this.ctx.organizationId,eventId]);await event(tx,this.ctx,'email.receipt',outcome.messageId??null,{type:String(payload.type).slice(0,100),matched:Boolean(outcome.messageId)},'provider');return {received:true,...outcome};
 });}
 private async receiveEmail(eventId:string,payload:any){
  const env=this.environment;if(env.EMAIL_RECEIVING_ENABLED!=='true'||!env.EMAIL_DELIVERY_TOKEN)return fail('EMAIL_RECEIVING_NOT_CONFIGURED',503);
  const providerId=String(payload.data?.email_id??'');if(!/^[A-Za-z0-9_-]{1,200}$/.test(providerId))return fail('INVALID_RECEIPT',400);
  const existing=await tenant(this.client,this.ctx,async tx=>rows(await tx.query("SELECT payload_hash,processed_at FROM app.provider_receipts WHERE organization_id=$1 AND provider='resend' AND event_id=$2",[this.ctx.organizationId,eventId]))[0]);if(existing){if(existing.payload_hash!==digest(payload))return fail('RECEIPT_CONFLICT');if(existing.processed_at)return {duplicate:true};}
  const response=await this.transport(`https://api.resend.com/emails/receiving/${providerId}`,{headers:{authorization:`Bearer ${env.EMAIL_DELIVERY_TOKEN}`},signal:AbortSignal.timeout(10000),redirect:'error'});if(!response.ok)return fail('INBOUND_RETRIEVAL_UNAVAILABLE',503);
  const incoming=await response.json() as Record<string,unknown>;const normalized=normalizeInbound({...incoming,provider_message_id:providerId});
  return tenant(this.client,this.ctx,async tx=>{
   await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`inbound:${this.ctx.organizationId}:${providerId}`]);
   const duplicate=rows(await tx.query("SELECT payload_hash FROM app.provider_receipts WHERE organization_id=$1 AND provider='resend' AND event_id=$2",[this.ctx.organizationId,eventId]))[0];if(duplicate)return {duplicate:true};
   const outcome=await importInboundMessage(tx,this.ctx,normalized,this.environment);
   await tx.query("INSERT INTO app.provider_receipts(organization_id,provider,event_id,payload_hash,processed_at) VALUES($1,'resend',$2,$3,app.utc_now())",[this.ctx.organizationId,eventId,digest(payload)]);
   return outcome.ignored?{ignored:true}:{received:true,duplicate:outcome.duplicate,conversationId:outcome.conversationId,messageId:outcome.messageId};
  });
 }
}
export class PaymentGateway {
 constructor(private readonly client:Client,private readonly ctx:Context,private readonly environment:Record<string,string|undefined>=process.env,private readonly transport:typeof fetch=fetch){}
 async checkout(invoiceId:string){const env=this.environment;if(env.PAYMENTS_ENABLED!=='true'||!env.STRIPE_SECRET_KEY||!env.OWNER_MERCHANT_AUTHORIZATION_ID||!env.APP_ORIGIN)return fail('MERCHANT_SETUP_REQUIRED',403);if(!/^(sk|rk)_test_/.test(env.STRIPE_SECRET_KEY)&&!env.PRODUCTION_PAYMENTS_AUTHORIZATION_ID)return fail('LIVE_PAYMENTS_NOT_AUTHORIZED',403);
  const invoice=await tenant(this.client,this.ctx,async tx=>rows(await tx.query("SELECT * FROM app.invoices WHERE organization_id=$1 AND id=$2 AND state='issued'",[this.ctx.organizationId,invoiceId]))[0]);if(!invoice)return fail('ISSUED_INVOICE_REQUIRED');const cap=Number(env.MAX_PAYMENT_CENTS??0);if(!Number.isSafeInteger(cap)||cap<=0||Number(invoice.amount_cents)>cap)return fail('PAYMENT_LIMIT_EXCEEDED',403);
  const body=new URLSearchParams({mode:'payment','line_items[0][price_data][currency]':'usd','line_items[0][price_data][unit_amount]':String(invoice.amount_cents),'line_items[0][price_data][product_data][name]':invoice.label,'line_items[0][quantity]':'1','payment_intent_data[metadata][organization_id]':this.ctx.organizationId,'payment_intent_data[metadata][invoice_id]':invoiceId,success_url:`${env.APP_ORIGIN}/dashboard?payment=received`,cancel_url:`${env.APP_ORIGIN}/dashboard?payment=cancelled`});
  const response=await this.transport('https://api.stripe.com/v1/checkout/sessions',{method:'POST',headers:{authorization:`Bearer ${env.STRIPE_SECRET_KEY}`,'content-type':'application/x-www-form-urlencoded','Idempotency-Key':`invoice:${invoiceId}`},body,signal:AbortSignal.timeout(20000),redirect:'error'});if(!response.ok)return fail('PAYMENT_PROVIDER_REJECTED',503);const result=await response.json() as {url?:string};if(!result.url||new URL(result.url).hostname!=='checkout.stripe.com')return fail('PAYMENT_RESPONSE_INVALID',503);return {url:result.url};
 }
 async ingestStripe(eventId:string,payload:any){return tenant(this.client,this.ctx,async tx=>{
  const existing=rows(await tx.query("SELECT payload_hash FROM app.provider_receipts WHERE organization_id=$1 AND provider='stripe' AND event_id=$2",[this.ctx.organizationId,eventId]))[0];if(existing){if(existing.payload_hash!==digest(payload))return fail('RECEIPT_CONFLICT');return {duplicate:true};}
  if(payload.livemode===true&&!this.environment.PRODUCTION_PAYMENTS_AUTHORIZATION_ID)return fail('LIVE_PAYMENTS_NOT_AUTHORIZED',403);const receiptSource=payload.livemode===true?'provider':'simulation';
  const object=payload.data?.object;if(!object||typeof object.id!=='string')return fail('INVALID_RECEIPT',400);
  await tx.query("INSERT INTO app.provider_receipts(organization_id,provider,event_id,payload_hash) VALUES($1,'stripe',$2,$3)",[this.ctx.organizationId,eventId,digest(payload)]);
  if(payload.type==='payment_intent.succeeded'){
   if(object.metadata?.organization_id!==this.ctx.organizationId)return fail('PAYMENT_TENANT_MISMATCH',403);
   const invoice=rows(await tx.query("SELECT * FROM app.invoices WHERE organization_id=$1 AND id=$2 FOR UPDATE",[this.ctx.organizationId,object.metadata?.invoice_id]))[0];if(!invoice)return fail('INVOICE_NOT_FOUND',404);
   if(object.currency!=='usd'||Number(object.amount_received)!==Number(invoice.amount_cents))return fail('PAYMENT_AMOUNT_MISMATCH',400);
   if(invoice.state==='paid')return {duplicate:true};if(invoice.state!=='issued')return fail('INVOICE_NOT_ISSUED');
   await tx.query("UPDATE app.invoices SET state='paid',provider_payment_id=$3,test_mode=$4,version=version+1 WHERE organization_id=$1 AND id=$2",[this.ctx.organizationId,invoice.id,object.id,payload.livemode!==true]);
   await tx.query("INSERT INTO app.money_entries(organization_id,project_id,invoice_id,idempotency_key,kind,amount_cents,source,evidence_ref) VALUES($1,$2,$3,$4,'sale_receipt',$5,$7,$6)",[this.ctx.organizationId,invoice.project_id,invoice.id,`stripe:${object.id}`,invoice.amount_cents,eventId,receiptSource]);
   if(invoice.contact_id&&receiptSource==='provider')await tx.query("UPDATE app.experiment_enrollments SET converted_at=COALESCE(converted_at,app.utc_now()) WHERE organization_id=$1 AND contact_id=$2 AND source='provider' AND exposed_at>app.utc_now()-interval '30 days' AND experiment_id IN(SELECT id FROM app.experiments WHERE organization_id=$1 AND project_id=$3 AND state='active')",[this.ctx.organizationId,invoice.contact_id,invoice.project_id]);
   await event(tx,this.ctx,'invoice.paid',invoice.id,{source:receiptSource,amountCents:Number(invoice.amount_cents)},'provider');
  }else if(payload.type==='charge.refunded'){
   const invoice=rows(await tx.query("SELECT * FROM app.invoices WHERE organization_id=$1 AND provider_payment_id=$2 FOR UPDATE",[this.ctx.organizationId,object.payment_intent]))[0];if(!invoice)return {ignored:true};
   const refunded=rows(await tx.query("SELECT COALESCE(sum(amount_cents),0) AS total FROM app.money_entries WHERE organization_id=$1 AND invoice_id=$2 AND kind='refund'",[this.ctx.organizationId,invoice.id]))[0]!;
   const total=Number(object.amount_refunded);cents(total);const delta=total-Number(refunded.total);if(delta<0||total>Number(invoice.amount_cents))return fail('REFUND_AMOUNT_MISMATCH',400);
   if(delta>0)await tx.query("INSERT INTO app.money_entries(organization_id,project_id,invoice_id,idempotency_key,kind,amount_cents,source,evidence_ref) VALUES($1,$2,$3,$4,'refund',$5,$7,$6)",[this.ctx.organizationId,invoice.project_id,invoice.id,`stripe-refund:${object.id}:${total}`,delta,eventId,receiptSource]);
   if(total===Number(invoice.amount_cents))await tx.query("UPDATE app.invoices SET state='refunded',version=version+1 WHERE organization_id=$1 AND id=$2",[this.ctx.organizationId,invoice.id]);await event(tx,this.ctx,'invoice.refund_received',invoice.id,{amountCents:delta},'provider');
  }
  return {received:true};
 });}
}
