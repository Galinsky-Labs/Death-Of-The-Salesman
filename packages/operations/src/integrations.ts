import {createHmac,timingSafeEqual} from 'node:crypto';
import {type Client,type Context,type Row,rows,tenant,event,digest,cents,fail,OperationError,randomUUID} from './common.js';
import {ControlPlane} from './control.js';
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
export class DeliveryGateway {
 constructor(private readonly client:Client,private readonly ctx:Context,private readonly environment:Record<string,string|undefined>=process.env,private readonly transport:typeof fetch=fetch){}
 async verifyMailbox(id:string){
  if(!this.environment.EMAIL_DELIVERY_TOKEN||!this.environment.SENDER_VERIFICATION_REFERENCE)return fail('SENDER_SETUP_INCOMPLETE',403);
  const mailbox=await tenant(this.client,this.ctx,async tx=>rows(await tx.query('SELECT * FROM app.mailboxes WHERE organization_id=$1 AND id=$2',[this.ctx.organizationId,id]))[0]);if(!mailbox)return fail('NOT_FOUND',404);
  const response=await this.transport('https://api.resend.com/domains',{headers:{authorization:`Bearer ${this.environment.EMAIL_DELIVERY_TOKEN}`},signal:AbortSignal.timeout(10000),redirect:'error'});if(!response.ok)return fail('SENDER_VERIFICATION_UNAVAILABLE',503);
  const result=await response.json() as {data?:{name:string;status:string}[]};const domain=String(mailbox.sender_email).split('@')[1]?.toLowerCase();if(!result.data?.some(item=>item.name.toLowerCase()===domain&&item.status==='verified'))return fail('SENDER_DOMAIN_NOT_VERIFIED',403);
  return tenant(this.client,this.ctx,async tx=>{await tx.query("UPDATE app.mailboxes SET verified=true,status='active' WHERE organization_id=$1 AND id=$2",[this.ctx.organizationId,id]);await event(tx,this.ctx,'mailbox.provider_verified',id);return {verified:true};});
 }
 async send(messageId:string){const env=this.environment;
  if(env.EMAIL_DELIVERY_ENABLED!=='true'||!env.EMAIL_DELIVERY_TOKEN||!env.OWNER_SPEND_AUTHORIZATION_ID||Number(env.PAID_SPEND_LIMIT_CENTS??0)<=0)return fail('EMAIL_DELIVERY_NOT_AUTHORIZED',403);
  if(!env.UNSUBSCRIBE_SIGNING_KEY||!env.APP_ORIGIN||!env.SENDER_VERIFICATION_REFERENCE)return fail('SENDER_SETUP_INCOMPLETE',503);
  if(!businessHours(new Date(),env.OUTREACH_TIMEZONE??'America/New_York'))return fail('OUTSIDE_BUSINESS_HOURS');
  const cost=Number(env.EMAIL_COST_CENTS);if(!Number.isSafeInteger(cost)||cost<0)return fail('EMAIL_PRICE_NOT_CONFIGURED',503);
  const budget=new ControlPlane(this.client,this.ctx);const scope=await tenant(this.client,this.ctx,async tx=>rows(await tx.query('SELECT m.approval_id,ca.project_id FROM app.messages m JOIN app.campaigns ca ON ca.id=m.campaign_id AND ca.organization_id=m.organization_id WHERE m.organization_id=$1 AND m.id=$2',[this.ctx.organizationId,messageId]))[0]);if(!scope?.approval_id)return fail('OWNER_APPROVAL_REQUIRED',403);const reservation=await budget.reserve(`message:${messageId}:${randomUUID()}`,Math.max(1,cost),scope.project_id);let sending=false;
  try {
   const message:Row=await tenant(this.client,this.ctx,async tx=>{
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`dispatch:${this.ctx.organizationId}`]);
    const item=rows(await tx.query(`SELECT m.*,c.contact_id,c.human_takeover,ct.email,ct.email_hash,ct.status AS contact_status,ct.consent,ct.jurisdiction,ca.state AS campaign_state,ca.purpose,ca.revision,ca.approved_revision,
      p.paused,p.outbound_enabled FROM app.messages m JOIN app.conversations c ON c.id=m.conversation_id AND c.organization_id=m.organization_id
      JOIN app.crm_contacts ct ON ct.id=c.contact_id AND ct.organization_id=m.organization_id
      JOIN app.policy_controls p ON p.organization_id=m.organization_id LEFT JOIN app.campaigns ca ON ca.id=m.campaign_id AND ca.organization_id=m.organization_id
      WHERE m.organization_id=$1 AND m.id=$2 FOR UPDATE OF m,ct`,[this.ctx.organizationId,messageId]))[0];
    if(!item)return fail('NOT_FOUND',404);if(!['pending_approval','approved'].includes(item.state)||!item.approval_id)return fail('OWNER_APPROVAL_REQUIRED',403);
    if(item.paused||!item.outbound_enabled)return fail('OUTBOUND_DISABLED',403);
    if(!item.campaign_id||item.campaign_state!=='active'||Number(item.revision)!==Number(item.approved_revision))return fail('CAMPAIGN_NOT_APPROVED',403);
    if(item.purpose!=='product')return fail('FUNDING_SOLICITATION_REQUIRES_SEPARATE_AUTHORITY',403);
    if(item.contact_status!=='active'||item.consent!=='opted_in'||!item.email)return fail('CONTACT_NOT_ELIGIBLE',403);
    const jurisdictions=(env.EMAIL_ALLOWED_JURISDICTIONS??'').split(',').map(x=>x.trim());if(!jurisdictions.includes(item.jurisdiction))return fail('JURISDICTION_NOT_APPROVED',403);
    if(rows(await tx.query('SELECT email_hash FROM app.contact_suppressions WHERE organization_id=$1 AND email_hash=$2',[this.ctx.organizationId,item.email_hash])).length)return fail('CONTACT_SUPPRESSED',403);
    const campaign=rows(await tx.query('SELECT daily_limit,cadence_days FROM app.campaigns WHERE organization_id=$1 AND id=$2',[this.ctx.organizationId,item.campaign_id]))[0]!;
    const daily=rows(await tx.query("SELECT count(*)::int AS total FROM app.messages WHERE organization_id=$1 AND campaign_id=$2 AND state IN ('sending','sent','delivered') AND COALESCE(sent_at,created_at)>=date_trunc('day',app.utc_now())",[this.ctx.organizationId,item.campaign_id]))[0]!;
    const contactHistory=rows(await tx.query("SELECT max(COALESCE(m.sent_at,m.created_at)) AS last_contact FROM app.messages m JOIN app.conversations c ON c.id=m.conversation_id AND c.organization_id=m.organization_id WHERE m.organization_id=$1 AND c.contact_id=$2 AND m.state IN ('sending','sent','delivered')",[this.ctx.organizationId,item.contact_id]))[0]!;
    if(daily.total>=campaign.daily_limit)return fail('DAILY_LIMIT_REACHED');if(contactHistory.last_contact&&Date.now()-new Date(contactHistory.last_contact).getTime()<Number(campaign.cadence_days)*86400000)return fail('CONTACT_CADENCE_LIMIT');
    const mailbox=rows(await tx.query("SELECT * FROM app.mailboxes WHERE organization_id=$1 AND verified AND status='active' ORDER BY created_at LIMIT 1",[this.ctx.organizationId]))[0];if(!mailbox)return fail('VERIFIED_SENDER_REQUIRED',403);
    if(mailbox.provider!=='resend')return fail('EMAIL_PROVIDER_UNSUPPORTED',503);
    const facts=rows(await tx.query("SELECT id,version,content FROM app.vetted_product_facts WHERE organization_id=$1 AND project_id=(SELECT project_id FROM app.campaigns WHERE id=$2 AND organization_id=$1) AND status='active' ORDER BY id",[this.ctx.organizationId,item.campaign_id]));if(!facts.length||facts.some(f=>!f.content.expiresAt||new Date(f.content.expiresAt).getTime()<Date.now()))return fail('APPROVED_FACTS_REQUIRED',403);
    if(digest(facts)!==item.fact_snapshot_hash||Number(item.approved_campaign_revision)!==Number(item.revision))return fail('APPROVED_FACTS_CHANGED',403);
    await budget.consumeApproval(tx,item.approval_id,'message',item.id,{subject:item.subject,body:item.body,factsHash:item.fact_snapshot_hash,campaignRevision:Number(item.approved_campaign_revision)});
    await tx.query("UPDATE app.messages SET state='sending' WHERE organization_id=$1 AND id=$2",[this.ctx.organizationId,messageId]);await event(tx,this.ctx,'message.dispatch_authorized',messageId);return {...item,mailbox};
   });sending=true;
   const url=`${env.APP_ORIGIN}/unsubscribe?token=${signedOptOut(this.ctx.organizationId,message.contact_id,env.UNSUBSCRIBE_SIGNING_KEY)}`;
   const response=await this.transport('https://api.resend.com/emails',{method:'POST',headers:{authorization:`Bearer ${env.EMAIL_DELIVERY_TOKEN}`,'content-type':'application/json','Idempotency-Key':`${messageId}:${message.content_hash}`},body:JSON.stringify({from:`${message.mailbox.sender_name} <${message.mailbox.sender_email}>`,to:[message.email],subject:message.subject,text:`${message.body}\n\n${message.mailbox.business_address}\nUnsubscribe: ${url}`,headers:{'List-Unsubscribe':`<${url}>`,'List-Unsubscribe-Post':'List-Unsubscribe=One-Click'}}),signal:AbortSignal.timeout(20000),redirect:'error'});
   if(!response.ok)return fail(response.status===429?'EMAIL_RATE_LIMITED':'EMAIL_DELIVERY_UNCERTAIN',503);
   const receipt=await response.json() as {id?:string};if(!receipt.id)return fail('EMAIL_DELIVERY_UNCERTAIN',503);
   await tenant(this.client,this.ctx,async tx=>{await tx.query("UPDATE app.messages SET state='sent',provider_message_id=$3,sent_at=app.utc_now() WHERE organization_id=$1 AND id=$2 AND state='sending'",[this.ctx.organizationId,messageId,receipt.id]);await event(tx,this.ctx,'message.sent',messageId,{source:'provider'});});await budget.settle(reservation.id,cost,receipt.id);return {state:'sent',providerMessageId:receipt.id};
  }catch(error){const code=error instanceof OperationError?error.code:'EMAIL_DELIVERY_UNCERTAIN';if(!sending||code==='EMAIL_RATE_LIMITED')await budget.settle(reservation.id,0,`not-sent:${messageId}`,true);if(sending)await tenant(this.client,this.ctx,async tx=>{await tx.query("UPDATE app.messages SET state=$3 WHERE organization_id=$1 AND id=$2 AND state='sending'",[this.ctx.organizationId,messageId,code==='EMAIL_RATE_LIMITED'?'failed':'quarantined']);await event(tx,this.ctx,'message.dispatch_failed',messageId,{reasonCode:code});});throw error;}
 }
 async ingestEmail(eventId:string,payload:any,trustedReplay=false){
  if(payload.type==='email.received')return this.receiveEmail(eventId,payload);
  return tenant(this.client,this.ctx,async tx=>{
  const existing=rows(await tx.query("SELECT payload_hash,processed_at,normalized_event FROM app.provider_receipts WHERE organization_id=$1 AND provider='resend' AND event_id=$2",[this.ctx.organizationId,eventId]))[0];if(existing){if(trustedReplay)payload=existing.normalized_event;else if(existing.payload_hash!==digest(payload))return fail('RECEIPT_CONFLICT');if(existing.processed_at)return {duplicate:true};}
  else await tx.query("INSERT INTO app.provider_receipts(organization_id,provider,event_id,payload_hash,normalized_event) VALUES($1,'resend',$2,$3,$4::jsonb)",[this.ctx.organizationId,eventId,digest(payload),JSON.stringify({type:payload.type,data:{email_id:payload.data?.email_id}})]);
  const providerId=payload.data?.email_id;if(!providerId)return {ignored:true};const message=rows(await tx.query('SELECT m.*,c.contact_id FROM app.messages m JOIN app.conversations c ON c.id=m.conversation_id AND c.organization_id=m.organization_id WHERE m.organization_id=$1 AND m.provider_message_id=$2',[this.ctx.organizationId,providerId]))[0];if(!message)return {ignored:true};
  if(payload.type==='email.delivered'){await tx.query("UPDATE app.messages SET state='delivered' WHERE organization_id=$1 AND id=$2 AND state IN ('sent','sending')",[this.ctx.organizationId,message.id]);await tx.query("UPDATE app.experiment_enrollments SET exposed_at=COALESCE(exposed_at,app.utc_now()),source='provider' WHERE organization_id=$1 AND contact_id=$2 AND experiment_id IN(SELECT ex.id FROM app.experiments ex JOIN app.campaigns ca ON ca.organization_id=ex.organization_id AND ca.project_id=ex.project_id WHERE ex.organization_id=$1 AND ex.state='active' AND ca.id=$3 AND (ca.strategy_id=ex.champion_strategy_id OR ca.strategy_id=ex.challenger_strategy_id))",[this.ctx.organizationId,message.contact_id,message.campaign_id]);}
  if(['email.bounced','email.complained'].includes(payload.type)){const contact=rows(await tx.query("UPDATE app.crm_contacts SET status='suppressed',consent='opted_out',version=version+1 WHERE organization_id=$1 AND id=$2 RETURNING email_hash",[this.ctx.organizationId,message.contact_id]))[0]!;await tx.query('INSERT INTO app.contact_suppressions(organization_id,email_hash,reason,source) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[this.ctx.organizationId,contact.email_hash,payload.type,payload.type==='email.bounced'?'bounce':'complaint']);await tx.query("UPDATE app.mailboxes SET status='paused' WHERE organization_id=$1",[this.ctx.organizationId]);}
  await tx.query("UPDATE app.provider_receipts SET processed_at=app.utc_now() WHERE organization_id=$1 AND provider='resend' AND event_id=$2",[this.ctx.organizationId,eventId]);await event(tx,this.ctx,'email.receipt',message.id,{type:String(payload.type).slice(0,100)},'provider');return {received:true};
 });}
 private async receiveEmail(eventId:string,payload:any){
  const env=this.environment;if(env.EMAIL_RECEIVING_ENABLED!=='true'||!env.EMAIL_DELIVERY_TOKEN)return fail('EMAIL_RECEIVING_NOT_CONFIGURED',503);
  const providerId=String(payload.data?.email_id??'');if(!/^[A-Za-z0-9_-]{1,200}$/.test(providerId))return fail('INVALID_RECEIPT',400);
  const existing=await tenant(this.client,this.ctx,async tx=>rows(await tx.query("SELECT payload_hash,processed_at FROM app.provider_receipts WHERE organization_id=$1 AND provider='resend' AND event_id=$2",[this.ctx.organizationId,eventId]))[0]);if(existing){if(existing.payload_hash!==digest(payload))return fail('RECEIPT_CONFLICT');if(existing.processed_at)return {duplicate:true};}
  const response=await this.transport(`https://api.resend.com/emails/receiving/${providerId}`,{headers:{authorization:`Bearer ${env.EMAIL_DELIVERY_TOKEN}`},signal:AbortSignal.timeout(10000),redirect:'error'});if(!response.ok)return fail('INBOUND_RETRIEVAL_UNAVAILABLE',503);
  const incoming=await response.json() as {from?:string;to?:string[];subject?:string;text?:string};const match=String(incoming.from??'').match(/(?:<)?([^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)>?$/);if(!match)return fail('INBOUND_SENDER_INVALID',400);const address=match[1]!.toLowerCase();
  return tenant(this.client,this.ctx,async tx=>{
   await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`inbound:${this.ctx.organizationId}:${providerId}`]);
   const duplicate=rows(await tx.query("SELECT payload_hash FROM app.provider_receipts WHERE organization_id=$1 AND provider='resend' AND event_id=$2",[this.ctx.organizationId,eventId]))[0];if(duplicate)return {duplicate:true};
   const mailboxes=rows(await tx.query("SELECT sender_email FROM app.mailboxes WHERE organization_id=$1 AND verified AND status='active'",[this.ctx.organizationId]));if(!mailboxes.some(mailbox=>incoming.to?.map(item=>item.toLowerCase()).includes(mailbox.sender_email.toLowerCase())))return fail('INBOUND_RECIPIENT_NOT_CONFIGURED',403);
   const hash=digest(address);let contact=rows(await tx.query('SELECT id,status FROM app.crm_contacts WHERE organization_id=$1 AND email_hash=$2',[this.ctx.organizationId,hash]))[0];if(!contact){contact=rows(await tx.query("INSERT INTO app.crm_contacts(organization_id,display_name,email,email_hash,lawful_source,consent) VALUES($1,$2,$2,$3,'Verified inbound email','unknown') RETURNING id,status",[this.ctx.organizationId,address,hash]))[0]!;}
   if(contact.status==='redacted')return {ignored:true};
   const subject=String(incoming.subject||'(No subject)').slice(0,240),body=String(incoming.text||'[Plain-text content unavailable. Attachments and HTML are not imported.]').slice(0,50000);
   const thread=rows(await tx.query("SELECT id FROM app.conversations WHERE organization_id=$1 AND contact_id=$2 AND state<>'closed' ORDER BY updated_at DESC LIMIT 1",[this.ctx.organizationId,contact.id]))[0]??rows(await tx.query('INSERT INTO app.conversations(organization_id,contact_id,subject) VALUES($1,$2,$3) RETURNING id',[this.ctx.organizationId,contact.id,subject]))[0]!;
   await tx.query("INSERT INTO app.messages(organization_id,conversation_id,direction,subject,body,state,source,provider_message_id,content_hash) VALUES($1,$2,'inbound',$3,$4,'received','provider',$5,$6) ON CONFLICT(organization_id,provider_message_id) DO NOTHING",[this.ctx.organizationId,thread.id,subject,body,providerId,digest({subject,body})]);
   await tx.query('UPDATE app.conversations SET updated_at=app.utc_now() WHERE organization_id=$1 AND id=$2',[this.ctx.organizationId,thread.id]);
   await tx.query("INSERT INTO app.provider_receipts(organization_id,provider,event_id,payload_hash,processed_at) VALUES($1,'resend',$2,$3,app.utc_now())",[this.ctx.organizationId,eventId,digest(payload)]);await event(tx,this.ctx,'message.received',thread.id,{},'provider');return {received:true};
  });
 }
}
export class PaymentGateway {
 constructor(private readonly client:Client,private readonly ctx:Context,private readonly environment:Record<string,string|undefined>=process.env,private readonly transport:typeof fetch=fetch){}
 async checkout(invoiceId:string){const env=this.environment;if(env.PAYMENTS_ENABLED!=='true'||!env.STRIPE_SECRET_KEY||!env.OWNER_MERCHANT_AUTHORIZATION_ID||!env.APP_ORIGIN)return fail('MERCHANT_SETUP_REQUIRED',403);if(!env.STRIPE_SECRET_KEY.startsWith('sk_test_')&&!env.PRODUCTION_PAYMENTS_AUTHORIZATION_ID)return fail('LIVE_PAYMENTS_NOT_AUTHORIZED',403);
  const invoice=await tenant(this.client,this.ctx,async tx=>rows(await tx.query("SELECT * FROM app.invoices WHERE organization_id=$1 AND id=$2 AND state='issued'",[this.ctx.organizationId,invoiceId]))[0]);if(!invoice)return fail('ISSUED_INVOICE_REQUIRED');const cap=Number(env.MAX_PAYMENT_CENTS??0);if(Number(invoice.amount_cents)>cap)return fail('PAYMENT_LIMIT_EXCEEDED',403);
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
