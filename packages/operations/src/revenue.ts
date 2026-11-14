// DOTS-135..143 revenue operations: owner-approved price books and quotes, subscriptions and
// retention evidence, delegated calendar scheduling, scoped CRM import/export, a public lead form
// that never triggers outreach, signed client portal links and ledger-reconciled cohort reporting.
import {createHash,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {type Client,type Context,type Row,rows,tenant,event,digest,text,cents,fail,randomUUID} from './common.js';
import {identifier,selection,emailAddress,dateOrNull} from './sales.js';

type Environment=Record<string,string|undefined>;
const sha256=(value:string)=>createHash('sha256').update(value).digest('hex');
const hmacHex=(secret:string,value:string)=>createHmac('sha256',secret).update(value).digest('hex');
const query=async(tx:Client,statement:string,values:unknown[]=[])=>rows(await tx.query(statement,values));
const one=async(tx:Client,statement:string,values:unknown[]=[])=>(await query(tx,statement,values))[0];
const optionalId=(value:unknown)=>value===undefined||value===null||value===''?null:identifier(value);
const integer=(value:unknown,minimum:number,maximum:number,code:string)=>{if(typeof value!=='number'||!Number.isSafeInteger(value)||value<minimum||value>maximum)return fail(code,400);return value;};
const reference=(value:unknown,field:string)=>text(value,field,200);
const sameHash=(a:string,b:string)=>{const left=Buffer.from(a,'hex'),right=Buffer.from(b,'hex');return left.length===right.length&&left.length>0&&timingSafeEqual(left,right);};

// ---------- Pure helpers (exported for tests and the acceptance script) ----------
export const billingIntervals=['one_time','month','year'] as const;
export const calendarScopes=['availability','create','update','cancel'] as const;
export const crmKinds=['account','contact','deal'] as const;
export const crmFields:Record<string,readonly string[]>={account:['name','website','sector'],contact:['display_name','role_title'],deal:['label','stage','value_cents']};
/** Fields that are always owned by this application: identity, consent and suppression are never imported. */
export const protectedCrmFields:Record<string,readonly string[]>={account:[],contact:['email','consent','status'],deal:[]};

export function quoteTotals(unitPriceCents:number,quantity:number,discountBasisPoints:number){
 const subtotal=unitPriceCents*quantity;if(!Number.isSafeInteger(subtotal))return fail('QUOTE_TOTAL_TOO_LARGE',400);
 const discount=Math.floor(subtotal*discountBasisPoints/10000);return {subtotalCents:subtotal,discountCents:discount,totalCents:subtotal-discount};
}
export function stableExternalId(kind:string,id:string){return `dots-${kind}-${id}`;}
/** CSV with RFC 4180 quoting and spreadsheet formula-injection neutralisation. */
export function toCsv(records:Record<string,unknown>[],columns:string[]):string{
 const cell=(value:unknown)=>{if(value===null||value===undefined)return '';let result=String(value);if(/^[=+\-@\t\r]/.test(result))result=`'${result}`;return /[",\r\n]/.test(result)?`"${result.replaceAll('"','""')}"`:result;};
 return [columns.join(','),...records.map(record=>columns.map(column=>cell(record[column])).join(','))].join('\r\n')+'\r\n';
}
const icsText=(value:string)=>value.replace(/\\/g,'\\\\').replace(/;/g,'\\;').replace(/,/g,'\\,').replace(/\r?\n/g,'\\n');
const icsDate=(value:Date)=>value.toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,'');
function foldIcs(line:string){const bytes=Buffer.from(line,'utf8');if(bytes.length<=75)return line;const parts:string[]=[];let current='';for(const char of line){if(Buffer.byteLength(current+char,'utf8')>(parts.length?74:75)){parts.push(current);current='';}current+=char;}parts.push(current);return parts.join('\r\n ');}
export type IcsEvent={uid:string;sequence:number;method:'REQUEST'|'CANCEL';startsAt:Date;endsAt:Date;subject:string;location?:string|null;attendeeEmail?:string|null;stamp:Date};
/** RFC 5545 calendar object. No provider call is made; owners deliver the file themselves. */
export function buildIcs(input:IcsEvent):string{
 const lines=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Death Of The Salesman//Revenue Operations//EN','CALSCALE:GREGORIAN',`METHOD:${input.method}`,'BEGIN:VEVENT',
  `UID:${icsText(input.uid)}`,`SEQUENCE:${input.sequence}`,`DTSTAMP:${icsDate(input.stamp)}`,`DTSTART:${icsDate(input.startsAt)}`,`DTEND:${icsDate(input.endsAt)}`,
  `SUMMARY:${icsText(input.subject)}`,...(input.location?[`LOCATION:${icsText(input.location)}`]:[]),...(input.attendeeEmail?[`ATTENDEE;ROLE=REQ-PARTICIPANT;RSVP=TRUE:mailto:${input.attendeeEmail}`]:[]),
  `STATUS:${input.method==='CANCEL'?'CANCELLED':'CONFIRMED'}`,'END:VEVENT','END:VCALENDAR'];
 return lines.map(foldIcs).join('\r\n')+'\r\n';
}
export type CalendarSlot={startsAt:string;endsAt:string};
/** Provider-neutral calendar adapter. Implementations must only touch the single calendar reference they are given. */
export interface CalendarAdapter{
 readonly provider:string;
 freeBusy(calendarRef:string,from:Date,to:Date,recorded:CalendarSlot[]):Promise<CalendarSlot[]>;
 publish(calendarRef:string,event:IcsEvent):Promise<{ics:string;providerEventId:string|null}>;
}
/** Local adapter: availability comes only from meetings recorded here; publishing produces an ICS file and calls no provider. */
export class LocalIcsCalendarAdapter implements CalendarAdapter{
 readonly provider='local_ics';
 async freeBusy(_ref:string,_from:Date,_to:Date,recorded:CalendarSlot[]){return recorded;}
 async publish(_ref:string,event:IcsEvent){return {ics:buildIcs(event),providerEventId:null};}
}
/** External providers stay fail-closed: no Google/Microsoft/CalDAV calls exist until an owner-approved adapter ships. */
export class UnavailableCalendarAdapter implements CalendarAdapter{
 constructor(readonly provider:string,private readonly reason:string){}
 async freeBusy():Promise<CalendarSlot[]>{return fail(this.reason,503);}
 async publish():Promise<{ics:string;providerEventId:string|null}>{return fail(this.reason,503);}
}
export function calendarAdapterFor(provider:string,credentialEnvRef:string|null,environment:Environment,registered:Record<string,CalendarAdapter>={}):CalendarAdapter{
 if(provider==='local_ics')return registered.local_ics??new LocalIcsCalendarAdapter();
 if(environment.CALENDAR_PROVIDERS_ENABLED!=='true'||!credentialEnvRef||!environment[credentialEnvRef])return new UnavailableCalendarAdapter(provider,'CALENDAR_PROVIDER_NOT_CONFIGURED');
 return registered[provider]??new UnavailableCalendarAdapter(provider,'CALENDAR_PROVIDER_ADAPTER_UNAVAILABLE');
}
const leadSecret=(environment:Environment)=>{const secret=environment.LEAD_FORM_SIGNING_KEY;if(!secret||secret.length<32)return fail('LEAD_FORM_NOT_CONFIGURED',503);return secret;};
export const leadNonceWindow={minimumSeconds:2,maximumSeconds:7200};
export function issueLeadNonce(formKeyHash:string,secret:string,now:Date):string{
 const payload=`${formKeyHash.slice(0,16)}.${Math.floor(now.getTime()/1000)}.${randomBytes(16).toString('base64url')}`;
 return `${Buffer.from(payload).toString('base64url')}.${createHmac('sha256',secret).update(payload).digest('base64url')}`;
}
export function verifyLeadNonce(token:unknown,formKeyHash:string,secret:string,now:Date):{nonceHash:string}|null{
 if(typeof token!=='string'||token.length>400)return null;const [encoded,signature]=token.split('.');if(!encoded||!signature)return null;
 const payload=Buffer.from(encoded,'base64url').toString('utf8');const expected=createHmac('sha256',secret).update(payload).digest();const actual=Buffer.from(signature,'base64url');
 if(actual.length!==expected.length||!timingSafeEqual(actual,expected))return null;
 const [form,issued]=payload.split('.');const age=now.getTime()/1000-Number(issued);
 if(form!==formKeyHash.slice(0,16)||!Number.isFinite(age)||age<leadNonceWindow.minimumSeconds||age>leadNonceWindow.maximumSeconds)return null;
 return {nonceHash:sha256(payload)};
}
export function hashLeadIp(ip:string,secret:string){return hmacHex(secret,`lead-ip:${ip.trim().toLowerCase()}`);}
const portalTokenPattern=/^pl_([0-9a-f]{32})\.([A-Za-z0-9_-]{43})$/;

// ---------- Revenue operations ----------
export type RevenueOptions={environment?:Environment;clock?:()=>Date;calendarAdapters?:Record<string,CalendarAdapter>};
export class RevenueOperations{
 private readonly environment:Environment;private readonly clock:()=>Date;private readonly adapters:Record<string,CalendarAdapter>;
 constructor(private readonly client:Client,private readonly ctx:Context,options:RevenueOptions={}){this.environment=options.environment??process.env;this.clock=options.clock??(()=>new Date());this.adapters=options.calendarAdapters??{};}
 private run<T>(fn:(tx:Client)=>Promise<T>){return tenant(this.client,this.ctx,fn);}
 private get org(){return this.ctx.organizationId;}

 // ----- DOTS-135 price books, offer terms, discounts and quotes -----
 async createPriceBook(input:{projectId:string;label:string;offerId?:string|null}){const projectId=identifier(input.projectId),label=text(input.label,'price_book',160),offerId=optionalId(input.offerId);
  return this.run(async tx=>{const book=await one(tx,'INSERT INTO app.price_books(organization_id,project_id,offer_id,label) VALUES($1,$2,$3,$4) RETURNING *',[this.org,projectId,offerId,label]);await event(tx,this.ctx,'price_book.created',book!.id);return book!;});}
 async addPriceRevision(priceBookId:string,input:{unitPriceCents:number;billingInterval:string;maxDiscountBasisPoints?:number;offerTerms:string;trialDays?:number;quoteValidDays?:number}){
  identifier(priceBookId);const unit=cents(input.unitPriceCents);if(!unit)return fail('POSITIVE_PRICE_REQUIRED',400);
  const terms={unitPriceCents:unit,billingInterval:selection(input.billingInterval,billingIntervals,'billing_interval'),maxDiscountBasisPoints:integer(input.maxDiscountBasisPoints??0,0,5000,'INVALID_DISCOUNT_POLICY'),offerTerms:text(input.offerTerms,'offer_terms',4000),trialDays:integer(input.trialDays??0,0,90,'INVALID_TRIAL_DAYS'),quoteValidDays:integer(input.quoteValidDays??14,1,90,'INVALID_QUOTE_VALIDITY')};
  if(terms.billingInterval==='one_time'&&terms.trialDays)return fail('TRIAL_REQUIRES_RECURRING_PRICE',400);
  return this.run(async tx=>{const book=await one(tx,"SELECT * FROM app.price_books WHERE organization_id=$1 AND id=$2 AND status='active' FOR UPDATE",[this.org,priceBookId]);if(!book)return fail('NOT_FOUND',404);
   const revision=Number(book.current_revision)+1;
   const saved=await one(tx,'INSERT INTO app.price_book_revisions(organization_id,price_book_id,revision,unit_price_cents,billing_interval,max_discount_basis_points,offer_terms,trial_days,quote_valid_days,content_hash,created_by_membership_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',
    [this.org,priceBookId,revision,terms.unitPriceCents,terms.billingInterval,terms.maxDiscountBasisPoints,terms.offerTerms,terms.trialDays,terms.quoteValidDays,digest({priceBookId,revision,...terms}),this.ctx.membershipId]);
   await tx.query('UPDATE app.price_books SET current_revision=$3,version=version+1,updated_at=app.utc_now() WHERE organization_id=$1 AND id=$2',[this.org,priceBookId,revision]);
   await event(tx,this.ctx,'price_book.revision_added',priceBookId,{revision,awaitingApproval:true});return saved!;});}
 async approvePriceRevision(priceBookId:string,revision:number,authorizationRef:unknown){identifier(priceBookId);const authority=reference(authorizationRef,'pricing_authorization');integer(revision,1,1_000_000,'INVALID_REVISION');
  return this.run(async tx=>{const book=await one(tx,"SELECT * FROM app.price_books WHERE organization_id=$1 AND id=$2 AND status='active' FOR UPDATE",[this.org,priceBookId]);if(!book)return fail('NOT_FOUND',404);
   if(Number(book.current_revision)!==revision)return fail('ONLY_CURRENT_REVISION_CAN_BE_APPROVED');
   const saved=await one(tx,'UPDATE app.price_books SET approved_revision=$3,approval_authorization_ref=$4,approved_by_membership_id=$5,approved_at=app.utc_now(),version=version+1,updated_at=app.utc_now() WHERE organization_id=$1 AND id=$2 RETURNING *',[this.org,priceBookId,revision,authority,this.ctx.membershipId]);
   await event(tx,this.ctx,'price_book.revision_approved',priceBookId,{revision});return saved!;});}
 async archivePriceBook(priceBookId:string){identifier(priceBookId);return this.run(async tx=>{const saved=await query(tx,"UPDATE app.price_books SET status='archived',version=version+1,updated_at=app.utc_now() WHERE organization_id=$1 AND id=$2 AND status='active' RETURNING id",[this.org,priceBookId]);if(!saved.length)return fail('NOT_FOUND',404);await event(tx,this.ctx,'price_book.archived',priceBookId);});}
 private discountPayload(quote:Row){return {scope:'quote_discount',quoteId:quote.id,priceBookId:quote.price_book_id,revision:Number(quote.price_revision),discountBasisPoints:Number(quote.discount_basis_points),totalCents:Number(quote.total_cents)};}
 private async eligibleContact(tx:Client,contactId:string|null,accountId:string|null){
  if(!contactId)return null;const contact=await one(tx,'SELECT c.id,c.account_id,c.status,c.email,s.email_hash AS suppressed FROM app.crm_contacts c LEFT JOIN app.contact_suppressions s ON s.organization_id=c.organization_id AND s.email_hash=c.email_hash WHERE c.organization_id=$1 AND c.id=$2',[this.org,contactId]);
  if(!contact)return fail('CONTACT_NOT_FOUND',404);if(contact.status!=='active'||contact.suppressed)return fail('CONTACT_SUPPRESSED',403);if(accountId&&contact.account_id&&contact.account_id!==accountId)return fail('CONTACT_ACCOUNT_MISMATCH',400);return contact;
 }
 async createQuote(input:{priceBookId:string;quantity?:number;discountBasisPoints?:number;accountId?:string|null;contactId?:string|null;dealId?:string|null}){
  const priceBookId=identifier(input.priceBookId),quantity=integer(input.quantity??1,1,10000,'INVALID_QUANTITY'),discount=integer(input.discountBasisPoints??0,0,5000,'INVALID_DISCOUNT');
  const accountId=optionalId(input.accountId),contactId=optionalId(input.contactId),dealId=optionalId(input.dealId);if(!accountId&&!contactId)return fail('QUOTE_RECIPIENT_REQUIRED',400);
  return this.run(async tx=>{
   const book=await one(tx,"SELECT * FROM app.price_books WHERE organization_id=$1 AND id=$2 AND status='active'",[this.org,priceBookId]);if(!book)return fail('NOT_FOUND',404);
   if(book.approved_revision===null||Number(book.approved_revision)!==Number(book.current_revision))return fail('CURRENT_PRICE_NOT_APPROVED',409);
   const price=(await one(tx,'SELECT * FROM app.price_book_revisions WHERE organization_id=$1 AND price_book_id=$2 AND revision=$3',[this.org,priceBookId,book.approved_revision]))!;
   if(discount>Number(price.max_discount_basis_points))return fail('DISCOUNT_EXCEEDS_POLICY',403);
   await this.eligibleContact(tx,contactId,accountId);
   if(accountId&&!(await one(tx,'SELECT id FROM app.crm_accounts WHERE organization_id=$1 AND id=$2',[this.org,accountId])))return fail('ACCOUNT_NOT_FOUND',404);
   const totals=quoteTotals(Number(price.unit_price_cents),quantity,discount);
   const number=`Q-${randomBytes(5).toString('hex').toUpperCase()}`;const expires=new Date(this.clock().getTime()+Number(price.quote_valid_days)*86400000).toISOString();
   const evidence={priceBookId,revision:Number(price.revision),priceHash:price.content_hash,quantity,discountBasisPoints:discount,...totals,billingInterval:price.billing_interval,offerTerms:price.offer_terms,accountId,contactId};
   const quote=(await one(tx,`INSERT INTO app.quotes(organization_id,project_id,price_book_id,price_revision,account_id,contact_id,deal_id,quote_number,quantity,unit_price_cents,discount_basis_points,subtotal_cents,discount_cents,total_cents,billing_interval,offer_terms,content_hash,state,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,[this.org,book.project_id,priceBookId,price.revision,accountId,contactId,dealId,number,quantity,price.unit_price_cents,discount,totals.subtotalCents,totals.discountCents,totals.totalCents,price.billing_interval,price.offer_terms,digest(evidence),discount?'awaiting_discount_approval':'ready',expires]))!;
   if(discount){const policy=await one(tx,'SELECT version FROM app.policy_controls WHERE organization_id=$1',[this.org]);if(!policy)return fail('POLICY_UNCONFIGURED');const payload=this.discountPayload(quote);
    const approval=(await one(tx,"INSERT INTO app.action_approvals(organization_id,action_kind,record_id,payload_hash,policy_version,requested_by_membership_id,proposed_payload) VALUES($1,'quotation',$2,$3,$4,$5,$6::jsonb) RETURNING id",[this.org,quote.id,digest(payload),policy.version,this.ctx.membershipId,JSON.stringify(payload)]))!;
    await tx.query('UPDATE app.quotes SET discount_approval_id=$3 WHERE organization_id=$1 AND id=$2',[this.org,quote.id,approval.id]);quote.discount_approval_id=approval.id;await event(tx,this.ctx,'approval.requested',approval.id,{kind:'quotation',scope:'quote_discount'});}
   await event(tx,this.ctx,'quote.created',quote.id,{totalCents:totals.totalCents,discountBasisPoints:discount});return quote;
  });
 }
 /** Records that the owner delivered the quote (manually or via a portal link). No message is sent by the application. */
 async sendQuote(quoteId:string,input:{channel:string;evidence:unknown;version:number}){identifier(quoteId);const channel=selection(input.channel,['owner_manual','portal_link'],'channel'),evidence=text(input.evidence,'evidence',500);
  return this.run(async tx=>{
   const quote=await one(tx,'SELECT * FROM app.quotes WHERE organization_id=$1 AND id=$2 FOR UPDATE',[this.org,quoteId]);if(!quote)return fail('NOT_FOUND',404);if(Number(quote.version)!==input.version)return fail('STALE_RECORD');
   if(!['ready','awaiting_discount_approval'].includes(quote.state))return fail('QUOTE_NOT_SENDABLE');if(new Date(quote.expires_at).getTime()<=this.clock().getTime())return fail('QUOTE_EXPIRED');
   const book=await one(tx,"SELECT approved_revision,current_revision,status FROM app.price_books WHERE organization_id=$1 AND id=$2",[this.org,quote.price_book_id]);
   if(!book||book.status!=='active'||Number(book.approved_revision)!==Number(quote.price_revision)||Number(book.current_revision)!==Number(quote.price_revision))return fail('QUOTE_PRICE_STALE');
   await this.eligibleContact(tx,quote.contact_id,quote.account_id);
   if(Number(quote.discount_basis_points)>0){const consumed=await query(tx,"UPDATE app.action_approvals SET status='consumed' WHERE organization_id=$1 AND id=$2 AND action_kind='quotation' AND record_id=$3 AND payload_hash=$4 AND status='approved' AND expires_at>app.utc_now() RETURNING id",[this.org,quote.discount_approval_id,quote.id,digest(this.discountPayload(quote))]);if(!consumed.length)return fail('DISCOUNT_APPROVAL_REQUIRED',403);}
   const saved=await one(tx,"UPDATE app.quotes SET state='sent',sent_at=app.utc_now(),sent_channel=$3,sent_evidence=$4,version=version+1,updated_at=app.utc_now() WHERE organization_id=$1 AND id=$2 RETURNING *",[this.org,quoteId,channel,evidence]);
   await event(tx,this.ctx,'quote.sent',quoteId,{channel,source:'owner_attested'});return saved!;});}
 /** Acceptance without an owner authorization reference is recorded as non-binding (indicative) only. */
 async acceptQuote(quoteId:string,input:{evidence:unknown;bindingAuthorizationRef?:unknown;version:number}){identifier(quoteId);const evidence=text(input.evidence,'evidence',500);const binding=input.bindingAuthorizationRef===undefined||input.bindingAuthorizationRef===null||input.bindingAuthorizationRef===''?null:reference(input.bindingAuthorizationRef,'binding_authorization');
  return this.run(async tx=>{const quote=await one(tx,'SELECT * FROM app.quotes WHERE organization_id=$1 AND id=$2 FOR UPDATE',[this.org,quoteId]);if(!quote)return fail('NOT_FOUND',404);if(Number(quote.version)!==input.version)return fail('STALE_RECORD');
   if(quote.state!=='sent')return fail('QUOTE_NOT_SENT');if(new Date(quote.expires_at).getTime()<=this.clock().getTime())return fail('QUOTE_EXPIRED');
   const saved=await one(tx,"UPDATE app.quotes SET state='accepted',accepted_at=app.utc_now(),acceptance_evidence=$3,binding=$4,binding_authorization_ref=$5,version=version+1,updated_at=app.utc_now() WHERE organization_id=$1 AND id=$2 RETURNING *",[this.org,quoteId,evidence,Boolean(binding),binding]);
   await event(tx,this.ctx,'quote.accepted',quoteId,{binding:Boolean(binding),source:'owner_attested'});return saved!;});}
 async declineQuote(quoteId:string,version:number){identifier(quoteId);return this.run(async tx=>{const saved=await one(tx,"UPDATE app.quotes SET state='declined',declined_at=app.utc_now(),version=version+1,updated_at=app.utc_now() WHERE organization_id=$1 AND id=$2 AND version=$3 AND state IN ('ready','awaiting_discount_approval','sent') RETURNING *",[this.org,quoteId,version]);if(!saved)return fail('STALE_RECORD');await event(tx,this.ctx,'quote.declined',quoteId);return saved;});}
 async expireQuotes(){return this.run(async tx=>{const expired=await query(tx,"UPDATE app.quotes SET state='expired',version=version+1,updated_at=app.utc_now() WHERE organization_id=$1 AND state IN ('ready','awaiting_discount_approval','sent') AND expires_at<=$2 RETURNING id",[this.org,this.clock().toISOString()]);for(const quote of expired)await event(tx,this.ctx,'quote.expired',quote.id);return {expired:expired.length};});}
 /** Only a binding (owner-authorized) accepted quote becomes a draft invoice; issuing it stays a separate owner step. */
 async invoiceFromQuote(quoteId:string){identifier(quoteId);return this.run(async tx=>{
  const quote=await one(tx,'SELECT * FROM app.quotes WHERE organization_id=$1 AND id=$2 FOR UPDATE',[this.org,quoteId]);if(!quote)return fail('NOT_FOUND',404);
  if(quote.invoice_id)return (await one(tx,'SELECT * FROM app.invoices WHERE organization_id=$1 AND id=$2',[this.org,quote.invoice_id]))!;
  if(quote.state!=='accepted'||!quote.binding)return fail('BINDING_ACCEPTANCE_REQUIRED',403);
  let contactId=quote.contact_id;if(!contactId&&quote.account_id)contactId=(await one(tx,"SELECT id FROM app.crm_contacts WHERE organization_id=$1 AND account_id=$2 AND status='active' ORDER BY created_at LIMIT 1",[this.org,quote.account_id]))?.id??null;
  const invoice=(await one(tx,'INSERT INTO app.invoices(organization_id,project_id,contact_id,label,invoice_number,description,amount_cents) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[this.org,quote.project_id,contactId,`Quote ${quote.quote_number}`,`INV-${randomBytes(4).toString('hex').toUpperCase()}`,String(quote.offer_terms).slice(0,2000),quote.total_cents]))!;
  await tx.query('UPDATE app.quotes SET invoice_id=$3,version=version+1,updated_at=app.utc_now() WHERE organization_id=$1 AND id=$2',[this.org,quoteId,invoice.id]);
  await event(tx,this.ctx,'invoice.created',invoice.id,{quoteId});return invoice;});}

 // ----- DOTS-138 subscriptions, onboarding, escalations, renewals and churn -----
 private async supportOwner(tx:Client,projectId:string,agentId:string|null){if(!agentId)return null;
  const assigned=await one(tx,"SELECT i.id FROM app.agent_identities i JOIN app.agent_project_assignments a ON a.organization_id=i.organization_id AND a.agent_identity_id=i.id WHERE i.organization_id=$1 AND i.id=$2 AND a.project_id=$3 AND i.status='active'",[this.org,agentId,projectId]);
  if(!assigned)return fail('SUPPORT_OWNER_NOT_ASSIGNED',403);return agentId;}
 private ownership(subscription:Row,actingAgentId:string|null){if(actingAgentId&&subscription.support_owner_agent_id&&actingAgentId!==subscription.support_owner_agent_id)return fail('SUPPORT_OWNERSHIP_REQUIRED',403);if(actingAgentId&&!subscription.support_owner_agent_id)return fail('SUPPORT_OWNERSHIP_REQUIRED',403);}
 async createSubscription(input:{projectId:string;label:string;amountCents:number;billingInterval:string;accountId?:string|null;contactId?:string|null;quoteId?:string|null;trialDays?:number;supportOwnerAgentId?:string|null;providerSubscriptionId?:string|null;testMode?:boolean}){
  const projectId=identifier(input.projectId),label=text(input.label,'subscription',160),amount=cents(input.amountCents),interval=selection(input.billingInterval,['month','year'],'billing_interval'),trial=integer(input.trialDays??0,0,90,'INVALID_TRIAL_DAYS');if(!amount)return fail('POSITIVE_AMOUNT_REQUIRED',400);
  const accountId=optionalId(input.accountId),contactId=optionalId(input.contactId),quoteId=optionalId(input.quoteId),agentId=optionalId(input.supportOwnerAgentId);
  const providerId=input.providerSubscriptionId?String(input.providerSubscriptionId):null;if(providerId&&!/^sub_[A-Za-z0-9_]{1,120}$/.test(providerId))return fail('INVALID_PROVIDER_SUBSCRIPTION',400);
  return this.run(async tx=>{
   if(quoteId){const quote=await one(tx,'SELECT * FROM app.quotes WHERE organization_id=$1 AND id=$2',[this.org,quoteId]);if(!quote||quote.state!=='accepted'||!quote.binding)return fail('BINDING_ACCEPTANCE_REQUIRED',403);if(Number(quote.total_cents)!==amount||quote.billing_interval!==interval)return fail('SUBSCRIPTION_TERMS_MISMATCH',400);}
   if(contactId&&!(await one(tx,'SELECT id FROM app.crm_contacts WHERE organization_id=$1 AND id=$2',[this.org,contactId])))return fail('CONTACT_NOT_FOUND',404);
   const owner=await this.supportOwner(tx,projectId,agentId);const trialEnds=trial?new Date(this.clock().getTime()+trial*86400000).toISOString():null;
   const subscription=(await one(tx,'INSERT INTO app.revenue_subscriptions(organization_id,project_id,account_id,contact_id,quote_id,label,amount_cents,billing_interval,state,provider_subscription_id,test_mode,support_owner_membership_id,support_owner_agent_id,trial_ends_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *',
    [this.org,projectId,accountId,contactId,quoteId,label,amount,interval,trial?'trialing':'active',providerId,input.testMode!==false,this.ctx.membershipId,owner,trialEnds]))!;
   const steps=['Confirm lawful customer contact and support owner','Share onboarding materials','Complete product setup with customer','Confirm customer success criteria'];
   for(const [index,step] of steps.entries())await tx.query('INSERT INTO app.onboarding_tasks(organization_id,subscription_id,label,position) VALUES($1,$2,$3,$4)',[this.org,subscription.id,step,index+1]);
   if(trial)await this.retention(tx,subscription.id,'trial_started','owner_attested',`subscription:${subscription.id}`,{trialDays:trial});
   await event(tx,this.ctx,'subscription.created',subscription.id,{trial:Boolean(trial)});return subscription;});}
 private async retention(tx:Client,subscriptionId:string,kind:string,source:string,evidence:string,details:Record<string,unknown>={}){await tx.query('INSERT INTO app.retention_events(organization_id,subscription_id,kind,source,evidence_ref,details) VALUES($1,$2,$3,$4,$5,$6::jsonb)',[this.org,subscriptionId,kind,source,evidence.slice(0,240),JSON.stringify(details)]);}
 async completeOnboardingTask(taskId:string,input:{evidence:unknown;actingAgentId?:string|null}){identifier(taskId);const evidence=text(input.evidence,'evidence',240),agent=optionalId(input.actingAgentId);
  return this.run(async tx=>{const task=await one(tx,'SELECT t.*,s.support_owner_agent_id,s.id AS subscription FROM app.onboarding_tasks t JOIN app.revenue_subscriptions s ON s.organization_id=t.organization_id AND s.id=t.subscription_id WHERE t.organization_id=$1 AND t.id=$2 FOR UPDATE OF t',[this.org,taskId]);if(!task)return fail('NOT_FOUND',404);
   this.ownership(task,agent);if(task.completed_at)return {duplicate:true};
   await tx.query('UPDATE app.onboarding_tasks SET completed_at=app.utc_now(),completed_by_agent_id=$3,evidence_ref=$4 WHERE organization_id=$1 AND id=$2',[this.org,taskId,agent,evidence]);
   const remaining=await one(tx,'SELECT count(*)::int AS open FROM app.onboarding_tasks WHERE organization_id=$1 AND subscription_id=$2 AND completed_at IS NULL',[this.org,task.subscription]);
   if(Number(remaining!.open)===0)await this.retention(tx,task.subscription,'onboarding_completed','owner_attested',evidence);
   await event(tx,this.ctx,'onboarding.task_completed',taskId,{actingAgentId:agent});return {completed:true,remaining:Number(remaining!.open)};});}
 async openEscalation(subscriptionId:string,input:{severity:string;summary:unknown}){identifier(subscriptionId);const severity=selection(input.severity,['low','normal','high','urgent'],'severity'),summary=text(input.summary,'summary',2000);
  return this.run(async tx=>{const subscription=await one(tx,'SELECT * FROM app.revenue_subscriptions WHERE organization_id=$1 AND id=$2',[this.org,subscriptionId]);if(!subscription)return fail('NOT_FOUND',404);
   const escalation=(await one(tx,'INSERT INTO app.service_escalations(organization_id,subscription_id,severity,summary,owner_membership_id,owner_agent_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[this.org,subscriptionId,severity,summary,subscription.support_owner_membership_id,subscription.support_owner_agent_id]))!;
   await this.retention(tx,subscriptionId,'escalation_opened','owner_attested',`escalation:${escalation.id}`,{severity});await event(tx,this.ctx,'escalation.opened',escalation.id,{severity});return escalation;});}
 async resolveEscalation(escalationId:string,input:{resolution:unknown;actingAgentId?:string|null}){identifier(escalationId);const resolution=text(input.resolution,'resolution',2000),agent=optionalId(input.actingAgentId);
  return this.run(async tx=>{const escalation=await one(tx,"SELECT * FROM app.service_escalations WHERE organization_id=$1 AND id=$2 FOR UPDATE",[this.org,escalationId]);if(!escalation)return fail('NOT_FOUND',404);
   this.ownership({support_owner_agent_id:escalation.owner_agent_id},agent);if(escalation.state==='resolved')return escalation;
   const saved=await one(tx,"UPDATE app.service_escalations SET state='resolved',resolution=$3,resolved_at=app.utc_now(),version=version+1 WHERE organization_id=$1 AND id=$2 RETURNING *",[this.org,escalationId,resolution]);
   await this.retention(tx,escalation.subscription_id,'escalation_resolved','owner_attested',`escalation:${escalationId}`);await event(tx,this.ctx,'escalation.resolved',escalationId);return saved!;});}
 /** Trial conversion must be backed by a recorded processor receipt for the subscription; otherwise the trial is recorded as churned. */
 async completeTrial(subscriptionId:string,input:{converted:boolean;evidence:unknown}){identifier(subscriptionId);const evidence=text(input.evidence,'evidence',240);
  return this.run(async tx=>{const subscription=await one(tx,'SELECT * FROM app.revenue_subscriptions WHERE organization_id=$1 AND id=$2 FOR UPDATE',[this.org,subscriptionId]);if(!subscription)return fail('NOT_FOUND',404);if(subscription.state!=='trialing')return fail('SUBSCRIPTION_NOT_TRIALING');
   if(input.converted===true){const receipt=await one(tx,"SELECT source FROM app.money_entries WHERE organization_id=$1 AND subscription_id=$2 AND kind='subscription_receipt' ORDER BY occurred_at LIMIT 1",[this.org,subscriptionId]);if(!receipt)return fail('TRIAL_CONVERSION_REQUIRES_PAYMENT_EVIDENCE',409);
    await tx.query("UPDATE app.revenue_subscriptions SET state='active',version=version+1,updated_at=app.utc_now() WHERE organization_id=$1 AND id=$2",[this.org,subscriptionId]);await this.retention(tx,subscriptionId,'trial_converted',receipt.source==='provider'?'provider':'simulation',evidence);}
   else{await tx.query("UPDATE app.revenue_subscriptions SET state='churned',ended_at=app.utc_now(),version=version+1,updated_at=app.utc_now() WHERE organization_id=$1 AND id=$2",[this.org,subscriptionId]);await this.retention(tx,subscriptionId,'trial_completed','owner_attested',evidence,{converted:false});await this.retention(tx,subscriptionId,'churned','owner_attested',evidence,{reasonCode:'TRIAL_NOT_CONVERTED'});}
   await event(tx,this.ctx,'subscription.trial_completed',subscriptionId,{converted:input.converted===true});return {converted:input.converted===true};});}
 async recordRetentionOutcome(subscriptionId:string,input:{outcome:string;reasonCode:unknown;evidence:unknown}){identifier(subscriptionId);const outcome=selection(input.outcome,['churned','retained'],'outcome'),reason=text(input.reasonCode,'reason',80),evidence=text(input.evidence,'evidence',240);
  return this.run(async tx=>{const subscription=await one(tx,'SELECT * FROM app.revenue_subscriptions WHERE organization_id=$1 AND id=$2 FOR UPDATE',[this.org,subscriptionId]);if(!subscription)return fail('NOT_FOUND',404);
   if(['churned','cancelled'].includes(subscription.state)&&outcome==='churned')return {duplicate:true};
   if(outcome==='churned')await tx.query("UPDATE app.revenue_subscriptions SET state='churned',ended_at=app.utc_now(),version=version+1,updated_at=app.utc_now() WHERE organization_id=$1 AND id=$2",[this.org,subscriptionId]);
   await this.retention(tx,subscriptionId,outcome,'owner_attested',evidence,{reasonCode:reason});await event(tx,this.ctx,`subscription.${outcome}`,subscriptionId,{reasonCode:reason});return {outcome};});}
 /** Renewal work items. Outreach is never sent automatically; suppressed or non-active contacts are flagged for owner handling only. */
 async renewals(days=30){return this.run(async tx=>{
  const due=await query(tx,`SELECT s.id,s.label,s.amount_cents,s.billing_interval,s.current_period_end,s.trial_ends_at,s.state,s.support_owner_agent_id,c.status AS contact_status,sup.email_hash AS suppressed
   FROM app.revenue_subscriptions s LEFT JOIN app.crm_contacts c ON c.organization_id=s.organization_id AND c.id=s.contact_id LEFT JOIN app.contact_suppressions sup ON sup.organization_id=c.organization_id AND sup.email_hash=c.email_hash
   WHERE s.organization_id=$1 AND s.state IN ('trialing','active','past_due') AND COALESCE(s.current_period_end,s.trial_ends_at)<=$2::timestamptz ORDER BY COALESCE(s.current_period_end,s.trial_ends_at)`,[this.org,new Date(this.clock().getTime()+days*86400000).toISOString()]);
  return due.map(item=>({id:item.id,label:item.label,amountCents:Number(item.amount_cents),billingInterval:item.billing_interval,dueAt:item.current_period_end??item.trial_ends_at,state:item.state,supportOwnerAgentId:item.support_owner_agent_id,
   outreach:item.suppressed||(item.contact_status&&item.contact_status!=='active')?'blocked_contact_suppressed':'owner_review_required'}));});}
 async retentionMetrics(){return this.run(async tx=>{
  const counts=(await one(tx,`SELECT count(*)::int AS total,count(*) FILTER(WHERE state IN ('trialing','active','past_due'))::int AS live,count(*) FILTER(WHERE state IN ('churned','cancelled'))::int AS ended FROM app.revenue_subscriptions WHERE organization_id=$1`,[this.org]))!;
  const events=await query(tx,"SELECT kind,source,count(DISTINCT subscription_id)::int AS subscriptions FROM app.retention_events WHERE organization_id=$1 GROUP BY kind,source",[this.org]);
  const evidenced=(kind:string,sources=['provider','owner_attested'])=>events.filter(e=>e.kind===kind&&sources.includes(e.source)).reduce((sum,e)=>sum+Number(e.subscriptions),0);
  const churned=evidenced('churned')+evidenced('cancelled'),converted=evidenced('trial_converted',['provider']),trialsDone=converted+evidenced('trial_completed');
  const revenue=(await one(tx,"SELECT COALESCE(sum(amount_cents) FILTER(WHERE source='provider'),0)::text AS verified,COALESCE(sum(amount_cents) FILTER(WHERE source='simulation'),0)::text AS sandbox FROM app.money_entries WHERE organization_id=$1 AND kind='subscription_receipt'",[this.org]))!;
  return {subscriptions:Number(counts.total),live:Number(counts.live),ended:Number(counts.ended),churnEvents:churned,churnRate:Number(counts.total)?churned/Number(counts.total):null,
   trialConversions:{converted,completed:trialsDone,rate:trialsDone?converted/trialsDone:null},verifiedRecurringRevenueCents:Number(revenue.verified),sandboxRecurringRevenueCents:Number(revenue.sandbox),
   basis:'Counts use retention events with provider or owner-attested evidence; recurring revenue uses provider-verified subscription receipts only.'};});}

 // ----- DOTS-139 provider-neutral calendar with delegated permission -----
 async addCalendarConnection(input:{label:unknown;provider:string;calendarRef:unknown;timezone?:unknown;credentialEnvRef?:unknown}){const label=text(input.label,'calendar',120),provider=selection(input.provider,['local_ics','google','microsoft','caldav'],'calendar_provider'),ref=text(input.calendarRef,'calendar_ref',200);
  const timezone=typeof input.timezone==='string'&&input.timezone?input.timezone:'UTC';try{new Intl.DateTimeFormat('en-US',{timeZone:timezone});}catch{return fail('INVALID_TIMEZONE',400);}
  const credential=input.credentialEnvRef?String(input.credentialEnvRef):null;if(credential&&!/^[A-Z][A-Z0-9_]{2,63}$/.test(credential))return fail('INVALID_CREDENTIAL_REFERENCE',400);if(provider!=='local_ics'&&!credential)return fail('CREDENTIAL_REFERENCE_REQUIRED',400);
  return this.run(async tx=>{const saved=(await one(tx,"INSERT INTO app.calendar_connections(organization_id,label,provider,calendar_ref,credential_env_ref,timezone,status,created_by_membership_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",[this.org,label,provider,ref,credential,timezone,'active',this.ctx.membershipId]))!;await event(tx,this.ctx,'calendar.connected',saved.id,{provider});return saved;});}
 async delegateCalendar(input:{connectionId:string;agentId:string;scopes:unknown;authorizationRef:unknown;expiresAt:unknown}){const connectionId=identifier(input.connectionId),agentId=identifier(input.agentId),authority=reference(input.authorizationRef,'delegation_authorization');
  if(!Array.isArray(input.scopes)||!input.scopes.length)return fail('INVALID_SCOPES',400);const scopes=[...new Set(input.scopes.map(scope=>selection(scope,calendarScopes,'scope')))].sort();
  const expires=dateOrNull(input.expiresAt);if(!expires)return fail('EXPIRY_REQUIRED',400);const span=new Date(expires).getTime()-this.clock().getTime();if(span<=0||span>90*86400000)return fail('DELEGATION_EXPIRY_OUT_OF_RANGE',400);
  return this.run(async tx=>{if(!(await one(tx,"SELECT id FROM app.calendar_connections WHERE organization_id=$1 AND id=$2 AND status='active'",[this.org,connectionId])))return fail('CALENDAR_NOT_FOUND',404);
   if(!(await one(tx,"SELECT id FROM app.agent_identities WHERE organization_id=$1 AND id=$2 AND status='active'",[this.org,agentId])))return fail('AGENT_NOT_ACTIVE',403);
   const saved=(await one(tx,'INSERT INTO app.calendar_delegations(organization_id,connection_id,agent_identity_id,scopes,authorization_ref,granted_by_membership_id,expires_at) VALUES($1,$2,$3,$4::text[],$5,$6,$7) RETURNING *',[this.org,connectionId,agentId,scopes,authority,this.ctx.membershipId,expires]))!;
   await event(tx,this.ctx,'calendar.delegated',saved.id,{agentId,scopes});return saved;});}
 async revokeCalendarDelegation(id:string){identifier(id);return this.run(async tx=>{const saved=await query(tx,'UPDATE app.calendar_delegations SET revoked_at=app.utc_now() WHERE organization_id=$1 AND id=$2 AND revoked_at IS NULL RETURNING id',[this.org,id]);if(!saved.length)return fail('NOT_FOUND',404);await event(tx,this.ctx,'calendar.delegation_revoked',id);});}
 private async delegation(tx:Client,agentId:string,connectionId:string,scope:string){
  const grant=await one(tx,`SELECT d.id,c.provider,c.calendar_ref,c.credential_env_ref,c.timezone FROM app.calendar_delegations d JOIN app.calendar_connections c ON c.organization_id=d.organization_id AND c.id=d.connection_id
   JOIN app.agent_identities i ON i.organization_id=d.organization_id AND i.id=d.agent_identity_id
   WHERE d.organization_id=$1 AND d.agent_identity_id=$2 AND d.connection_id=$3 AND $4=ANY(d.scopes) AND d.revoked_at IS NULL AND d.expires_at>$5::timestamptz AND c.status='active' AND i.status='active' ORDER BY d.created_at DESC LIMIT 1`,[this.org,agentId,connectionId,scope,this.clock().toISOString()]);
  if(!grant)return fail('CALENDAR_NOT_DELEGATED',403);return grant;}
 private recorded(tx:Client,connectionId:string,from:string,to:string,except:string|null=null){return query(tx,"SELECT starts_at,ends_at FROM app.meetings WHERE organization_id=$1 AND connection_id=$2 AND state='scheduled' AND starts_at<$4::timestamptz AND ends_at>$3::timestamptz AND ($5::uuid IS NULL OR id<>$5::uuid) ORDER BY starts_at",[this.org,connectionId,from,to,except]).then(list=>list.map(item=>({startsAt:new Date(item.starts_at).toISOString(),endsAt:new Date(item.ends_at).toISOString()})));}
 /** Busy windows only (no subjects or attendees) for a calendar the agent was explicitly delegated. */
 async availability(agentId:string,connectionId:string,fromValue:unknown,toValue:unknown){identifier(agentId);identifier(connectionId);const from=dateOrNull(fromValue),to=dateOrNull(toValue);if(!from||!to||new Date(to)<=new Date(from)||new Date(to).getTime()-new Date(from).getTime()>31*86400000)return fail('INVALID_RANGE',400);
  const {grant,recorded}=await this.run(async tx=>{const grant=await this.delegation(tx,agentId,connectionId,'availability');await event(tx,this.ctx,'calendar.availability_read',connectionId,{agentId});return {grant,recorded:await this.recorded(tx,connectionId,from,to)};});
  const adapter=calendarAdapterFor(grant.provider,grant.credential_env_ref,this.environment,this.adapters);return {connectionId,busy:await adapter.freeBusy(grant.calendar_ref,new Date(from),new Date(to),recorded)};}
 private slot(startsValue:unknown,endsValue:unknown){const starts=dateOrNull(startsValue),ends=dateOrNull(endsValue);if(!starts||!ends)return fail('INVALID_TIME',400);const length=new Date(ends).getTime()-new Date(starts).getTime();if(length<=0||length>8*3600000)return fail('INVALID_MEETING_LENGTH',400);if(new Date(starts).getTime()<this.clock().getTime())return fail('MEETING_IN_PAST',400);return {starts,ends};}
 async scheduleMeeting(agentId:string,input:{connectionId:string;subject:unknown;startsAt:unknown;endsAt:unknown;contactId?:string|null;accountId?:string|null;location?:unknown}){identifier(agentId);const connectionId=identifier(input.connectionId),subject=text(input.subject,'subject',200),{starts,ends}=this.slot(input.startsAt,input.endsAt);
  const contactId=optionalId(input.contactId),accountId=optionalId(input.accountId),location=typeof input.location==='string'&&input.location.trim()?input.location.trim().slice(0,300):null;
  const prepared=await this.run(async tx=>{const grant=await this.delegation(tx,agentId,connectionId,'create');const contact=await this.eligibleContact(tx,contactId,accountId);
   if((await this.recorded(tx,connectionId,starts,ends)).length)return fail('SLOT_UNAVAILABLE');return {grant,email:contact?.email??null};});
  const uid=`${randomBytes(12).toString('hex')}@dots.invalid`;const adapter=calendarAdapterFor(prepared.grant.provider,prepared.grant.credential_env_ref,this.environment,this.adapters);
  const published=await adapter.publish(prepared.grant.calendar_ref,{uid,sequence:0,method:'REQUEST',startsAt:new Date(starts),endsAt:new Date(ends),subject,location,attendeeEmail:prepared.email,stamp:this.clock()});
  return this.run(async tx=>{await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`calendar:${this.org}:${connectionId}`]);const grant=await this.delegation(tx,agentId,connectionId,'create');if((await this.recorded(tx,connectionId,starts,ends)).length)return fail('SLOT_UNAVAILABLE');
   const meeting=(await one(tx,'INSERT INTO app.meetings(organization_id,connection_id,agent_identity_id,delegation_id,contact_id,account_id,subject,location,starts_at,ends_at,timezone,ics_uid) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *',[this.org,connectionId,agentId,grant.id,contactId,accountId,subject,location,starts,ends,grant.timezone,uid]))!;
   await event(tx,this.ctx,'meeting.scheduled',meeting.id,{agentId,provider:grant.provider});return {meeting,ics:published.ics};});}
 private async ownedMeeting(tx:Client,agentId:string,meetingId:string,scope:string){const meeting=await one(tx,'SELECT * FROM app.meetings WHERE organization_id=$1 AND id=$2 FOR UPDATE',[this.org,meetingId]);if(!meeting)return fail('NOT_FOUND',404);if(meeting.agent_identity_id!==agentId)return fail('MEETING_NOT_OWNED',403);const grant=await this.delegation(tx,agentId,meeting.connection_id,scope);if(meeting.state!=='scheduled')return fail('MEETING_CANCELLED');return {meeting,grant};}
 async rescheduleMeeting(agentId:string,meetingId:string,input:{startsAt:unknown;endsAt:unknown;version:number}){identifier(agentId);identifier(meetingId);const {starts,ends}=this.slot(input.startsAt,input.endsAt);
  return this.run(async tx=>{const {meeting,grant}=await this.ownedMeeting(tx,agentId,meetingId,'update');if(Number(meeting.version)!==input.version)return fail('STALE_RECORD');if((await this.recorded(tx,meeting.connection_id,starts,ends,meetingId)).length)return fail('SLOT_UNAVAILABLE');
   const adapter=calendarAdapterFor(grant.provider,grant.credential_env_ref,this.environment,this.adapters);const sequence=Number(meeting.sequence)+1;
   const published=await adapter.publish(grant.calendar_ref,{uid:meeting.ics_uid,sequence,method:'REQUEST',startsAt:new Date(starts),endsAt:new Date(ends),subject:meeting.subject,location:meeting.location,stamp:this.clock()});
   const saved=(await one(tx,'UPDATE app.meetings SET starts_at=$3,ends_at=$4,sequence=$5,version=version+1,updated_at=app.utc_now() WHERE organization_id=$1 AND id=$2 RETURNING *',[this.org,meetingId,starts,ends,sequence]))!;
   await event(tx,this.ctx,'meeting.rescheduled',meetingId,{agentId});return {meeting:saved,ics:published.ics};});}
 async cancelMeeting(agentId:string,meetingId:string){identifier(agentId);identifier(meetingId);return this.run(async tx=>{const {meeting,grant}=await this.ownedMeeting(tx,agentId,meetingId,'cancel');
  const adapter=calendarAdapterFor(grant.provider,grant.credential_env_ref,this.environment,this.adapters);const sequence=Number(meeting.sequence)+1;
  const published=await adapter.publish(grant.calendar_ref,{uid:meeting.ics_uid,sequence,method:'CANCEL',startsAt:new Date(meeting.starts_at),endsAt:new Date(meeting.ends_at),subject:meeting.subject,location:meeting.location,stamp:this.clock()});
  const saved=(await one(tx,"UPDATE app.meetings SET state='cancelled',sequence=$3,version=version+1,updated_at=app.utc_now() WHERE organization_id=$1 AND id=$2 RETURNING *",[this.org,meetingId,sequence]))!;await event(tx,this.ctx,'meeting.cancelled',meetingId,{agentId});return {meeting:saved,ics:published.ics};});}
 async meetingIcs(meetingId:string){identifier(meetingId);return this.run(async tx=>{const meeting=await one(tx,'SELECT m.*,c.email FROM app.meetings m LEFT JOIN app.crm_contacts c ON c.organization_id=m.organization_id AND c.id=m.contact_id WHERE m.organization_id=$1 AND m.id=$2',[this.org,meetingId]);if(!meeting)return fail('NOT_FOUND',404);
  return {filename:`meeting-${meetingId}.ics`,ics:buildIcs({uid:meeting.ics_uid,sequence:Number(meeting.sequence),method:meeting.state==='cancelled'?'CANCEL':'REQUEST',startsAt:new Date(meeting.starts_at),endsAt:new Date(meeting.ends_at),subject:meeting.subject,location:meeting.location,attendeeEmail:meeting.state==='scheduled'?meeting.email:null,stamp:new Date(meeting.updated_at)})};});}

 // ----- DOTS-140 CRM export/import with stable IDs and field ownership -----
 async exportCrm(input:{format:string;kinds?:unknown;system?:string}){const format=selection(input.format,['csv','json'],'format'),system=input.system?text(input.system,'system',40).toLowerCase():'dots';if(!/^[a-z][a-z0-9_]{1,39}$/.test(system))return fail('INVALID_SYSTEM',400);
  const kinds=Array.isArray(input.kinds)&&input.kinds.length?[...new Set(input.kinds.map(kind=>selection(kind,crmKinds,'kind')))]:[...crmKinds];
  return this.run(async tx=>{const links=await query(tx,'SELECT entity_kind,entity_id,external_id FROM app.crm_external_links WHERE organization_id=$1 AND system=$2',[this.org,system]);const linked=new Map(links.map(link=>[`${link.entity_kind}:${link.entity_id}`,link.external_id]));
   const records:Record<string,unknown>[]=[];
   if(kinds.includes('account'))for(const account of await query(tx,'SELECT id,name,website,sector,created_at FROM app.crm_accounts WHERE organization_id=$1 ORDER BY created_at,id',[this.org]))records.push({kind:'account',external_id:stableExternalId('account',account.id),linked_external_id:linked.get(`account:${account.id}`)??null,name:account.name,website:account.website,sector:account.sector,created_at:new Date(account.created_at).toISOString()});
   if(kinds.includes('contact'))for(const contact of await query(tx,'SELECT c.id,c.account_id,c.display_name,c.email,c.role_title,c.status,c.consent,c.created_at,s.email_hash AS suppressed FROM app.crm_contacts c LEFT JOIN app.contact_suppressions s ON s.organization_id=c.organization_id AND s.email_hash=c.email_hash WHERE c.organization_id=$1 ORDER BY c.created_at,c.id',[this.org])){const redacted=contact.status==='redacted';
    records.push({kind:'contact',external_id:stableExternalId('contact',contact.id),linked_external_id:linked.get(`contact:${contact.id}`)??null,account_external_id:contact.account_id?stableExternalId('account',contact.account_id):null,display_name:redacted?'[Redacted]':contact.display_name,email:redacted?null:contact.email,role_title:redacted?null:contact.role_title,consent:contact.consent,do_not_contact:Boolean(contact.suppressed)||contact.status!=='active',created_at:new Date(contact.created_at).toISOString()});}
   if(kinds.includes('deal'))for(const deal of await query(tx,'SELECT id,project_id,contact_id,label,stage,value_cents,created_at FROM app.deals WHERE organization_id=$1 ORDER BY created_at,id',[this.org]))records.push({kind:'deal',external_id:stableExternalId('deal',deal.id),linked_external_id:linked.get(`deal:${deal.id}`)??null,contact_external_id:deal.contact_id?stableExternalId('contact',deal.contact_id):null,label:deal.label,stage:deal.stage,value_cents:Number(deal.value_cents),created_at:new Date(deal.created_at).toISOString()});
   const columns=['kind','external_id','linked_external_id','account_external_id','contact_external_id','name','display_name','email','role_title','consent','do_not_contact','website','sector','label','stage','value_cents','created_at'];
   const content=format==='csv'?toCsv(records,columns):JSON.stringify({system,exportedAt:this.clock().toISOString(),records},null,2);
   const run=(await one(tx,"INSERT INTO app.crm_sync_runs(organization_id,system,direction,format,record_count,content_hash) VALUES($1,$2,'export',$3,$4,$5) RETURNING id",[this.org,system,format,records.length,sha256(content)]))!;
   await event(tx,this.ctx,'crm.exported',run.id,{system,format,records:records.length});return {runId:run.id,format,recordCount:records.length,contentHash:sha256(content),content};});}
 async setCrmFieldOwnership(input:{system:unknown;kind:string;field:string;owner:string}){const system=text(input.system,'system',40).toLowerCase(),kind=selection(input.kind,crmKinds,'kind'),owner=selection(input.owner,['dots','external'],'owner');if(!/^[a-z][a-z0-9_]{1,39}$/.test(system))return fail('INVALID_SYSTEM',400);
  if((protectedCrmFields[kind]??[]).includes(input.field))return fail('PROTECTED_FIELD_OWNED_BY_DOTS',403);const field=selection(input.field,crmFields[kind]??[],'field');
  return this.run(async tx=>{await tx.query('INSERT INTO app.crm_field_ownership(organization_id,system,entity_kind,field,owner) VALUES($1,$2,$3,$4,$5) ON CONFLICT(organization_id,system,entity_kind,field) DO UPDATE SET owner=$5,version=app.crm_field_ownership.version+1,updated_at=app.utc_now()',[this.org,system,kind,field,owner]);await event(tx,this.ctx,'crm.field_ownership_set',null,{system,kind,field,owner});return {system,kind,field,owner};});}
 /**
  * Imports external CRM records. Links are keyed by (tenant, system, kind, external id) so repeated imports never duplicate;
  * contacts are matched by email hash; consent/suppression/email are never imported; fields owned by this app are kept and logged as conflicts.
  */
 async importCrm(input:{system:unknown;format?:string;records:unknown;projectId?:string|null}){const system=text(input.system,'system',40).toLowerCase();if(!/^[a-z][a-z0-9_]{1,39}$/.test(system)||system==='dots')return fail('INVALID_SYSTEM',400);const format=selection(input.format??'json',['csv','json'],'format');
  if(!Array.isArray(input.records)||input.records.length>500)return fail('IMPORT_LIMIT_500',400);const projectId=optionalId(input.projectId);
  const records=input.records.map(raw=>{const item=raw as Record<string,unknown>;const kind=selection(item.kind,crmKinds,'kind');const externalId=text(item.externalId,'external_id',200);const fields=(item.fields&&typeof item.fields==='object'&&!Array.isArray(item.fields)?item.fields:{}) as Record<string,unknown>;return {kind,externalId,fields};});
  return this.run(async tx=>{const ownership=await query(tx,'SELECT entity_kind,field,owner FROM app.crm_field_ownership WHERE organization_id=$1 AND system=$2',[this.org,system]);const ownerOf=(kind:string,field:string)=>ownership.find(o=>o.entity_kind===kind&&o.field===field)?.owner??'dots';
   const run=(await one(tx,"INSERT INTO app.crm_sync_runs(organization_id,system,direction,format,record_count,content_hash) VALUES($1,$2,'import',$3,$4,$5) RETURNING id",[this.org,system,format,records.length,digest(records)]))!;
   let created=0,updated=0,conflicts=0,skipped=0;const tables:Record<string,string>={account:'crm_accounts',contact:'crm_contacts',deal:'deals'};
   const conflict=async(kind:string,entityId:string,field:string,current:unknown,incoming:unknown,resolution:string)=>{conflicts++;await tx.query('INSERT INTO app.crm_sync_conflicts(organization_id,run_id,system,entity_kind,entity_id,field,dots_value_hash,external_value_hash,resolution) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[this.org,run.id,system,kind,entityId,field,digest(current??null),digest(incoming??null),resolution]);};
   for(const record of records){
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`crm:${this.org}:${system}:${record.kind}:${record.externalId}`]);
    let entityId:string|undefined=(await one(tx,'SELECT entity_id FROM app.crm_external_links WHERE organization_id=$1 AND system=$2 AND entity_kind=$3 AND external_id=$4',[this.org,system,record.kind,record.externalId]))?.entity_id;
    const email=record.kind==='contact'&&record.fields.email!==undefined?emailAddress(record.fields.email):null;
    if(!entityId&&email)entityId=(await one(tx,'SELECT id FROM app.crm_contacts WHERE organization_id=$1 AND email_hash=$2',[this.org,digest(email)]))?.id;
    if(entityId){const prior=await one(tx,'SELECT external_id FROM app.crm_external_links WHERE organization_id=$1 AND system=$2 AND entity_kind=$3 AND entity_id=$4',[this.org,system,record.kind,entityId]);
     if(prior&&prior.external_id!==record.externalId){skipped++;await conflict(record.kind,entityId,'external_id',prior.external_id,record.externalId,'kept_dots_value');continue;}
     if(!prior)await tx.query('INSERT INTO app.crm_external_links(organization_id,system,entity_kind,entity_id,external_id) VALUES($1,$2,$3,$4,$5)',[this.org,system,record.kind,entityId,record.externalId]);
     const current=(await one(tx,`SELECT * FROM app.${tables[record.kind]} WHERE organization_id=$1 AND id=$2 FOR UPDATE`,[this.org,entityId]))!;let changed=false;
     for(const field of protectedCrmFields[record.kind]??[])if(field!=='email'&&record.fields[field]!==undefined&&record.fields[field]!==current[field])await conflict(record.kind,entityId,field,current[field],record.fields[field],'refused_protected_field');
     if(record.kind==='contact'&&current.status==='redacted'){skipped++;continue;}
     for(const field of crmFields[record.kind]??[]){if(record.fields[field]===undefined)continue;const incoming=this.crmValue(record.kind,field,record.fields[field]);if(String(incoming??'')===String(current[field]??''))continue;
      if(ownerOf(record.kind,field)==='external'){await tx.query(`UPDATE app.${tables[record.kind]} SET ${field}=$3 WHERE organization_id=$1 AND id=$2`,[this.org,entityId,incoming]);changed=true;}else await conflict(record.kind,entityId,field,current[field],incoming,'kept_dots_value');}
     if(changed){updated++;if(record.kind!=='account')await tx.query(`UPDATE app.${tables[record.kind]} SET version=version+1,updated_at=app.utc_now() WHERE organization_id=$1 AND id=$2`,[this.org,entityId]);}
     continue;}
    let saved:Row|undefined;
    if(record.kind==='account')saved=await one(tx,'INSERT INTO app.crm_accounts(organization_id,name,website,sector) VALUES($1,$2,$3,$4) RETURNING id',[this.org,this.crmValue('account','name',record.fields.name),this.crmValue('account','website',record.fields.website??null),this.crmValue('account','sector',record.fields.sector??null)]);
    else if(record.kind==='contact'){if(!email){skipped++;continue;}const hash=digest(email);const suppressed=Boolean(await one(tx,'SELECT 1 FROM app.contact_suppressions WHERE organization_id=$1 AND email_hash=$2',[this.org,hash]));
     saved=await one(tx,"INSERT INTO app.crm_contacts(organization_id,display_name,email,email_hash,role_title,status,consent,lawful_source) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",[this.org,this.crmValue('contact','display_name',record.fields.display_name??email),email,hash,this.crmValue('contact','role_title',record.fields.role_title??null),suppressed?'suppressed':'active',suppressed?'opted_out':'unknown',`CRM import (${system})`]);}
    else{if(!projectId){skipped++;continue;}saved=await one(tx,'INSERT INTO app.deals(organization_id,project_id,label,stage,value_cents) VALUES($1,$2,$3,$4,$5) RETURNING id',[this.org,projectId,this.crmValue('deal','label',record.fields.label),this.crmValue('deal','stage',record.fields.stage??'new'),this.crmValue('deal','value_cents',record.fields.value_cents??0)]);}
    await tx.query('INSERT INTO app.crm_external_links(organization_id,system,entity_kind,entity_id,external_id) VALUES($1,$2,$3,$4,$5)',[this.org,system,record.kind,saved!.id,record.externalId]);created++;}
   await event(tx,this.ctx,'crm.imported',run.id,{system,created,updated,conflicts,skipped});
   return {runId:run.id,created,updated,conflicts,skipped,records:records.length};});}
 private crmValue(kind:string,field:string,value:unknown):unknown{
  if(field==='value_cents')return cents(value);if(field==='stage')return selection(value,['new','qualified','proposal','negotiation','won','lost'],'stage');
  if(value===null)return field==='name'||field==='label'||field==='display_name'?fail(`INVALID_${field.toUpperCase()}`,400):null;
  const result=text(value,`${kind}_${field}`,field==='website'?300:160);if(field==='website'&&!/^https:\/\//.test(result))return fail('HTTPS_WEBSITE_REQUIRED',400);return result;}

 // ----- DOTS-141 public lead form (anti-abuse, consent evidence, retention; never triggers outreach) -----
 async createLeadForm(input:{projectId:string;label:unknown;consentText:unknown;consentVersion:unknown;retentionDays?:number;dailyLimitPerIp?:number;allowedOrigin?:unknown}){
  const projectId=identifier(input.projectId),label=text(input.label,'form',120),consentText=text(input.consentText,'consent_text',2000),consentVersion=text(input.consentVersion,'consent_version',40);
  if(consentText.length<20)return fail('CONSENT_TEXT_TOO_SHORT',400);if(!/^[A-Za-z0-9._-]{1,40}$/.test(consentVersion))return fail('INVALID_CONSENT_VERSION',400);
  const retention=integer(input.retentionDays??365,1,1095,'INVALID_RETENTION'),limit=integer(input.dailyLimitPerIp??5,1,50,'INVALID_RATE_LIMIT');
  const origin=input.allowedOrigin?text(input.allowedOrigin,'origin',200).toLowerCase():null;if(origin&&!/^https:\/\/[a-z0-9.-]+(:[0-9]+)?$/.test(origin))return fail('HTTPS_ORIGIN_REQUIRED',400);
  const formKey=`lf_${randomBytes(24).toString('base64url')}`;
  return this.run(async tx=>{const form=(await one(tx,'INSERT INTO app.lead_forms(organization_id,project_id,label,form_key_hash,consent_text,consent_version,retention_days,daily_limit_per_ip,allowed_origin) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,project_id,label,consent_text,consent_version,retention_days,daily_limit_per_ip,allowed_origin,status,created_at',[this.org,projectId,label,sha256(formKey),consentText,consentVersion,retention,limit,origin]))!;
   await event(tx,this.ctx,'lead_form.created',form.id);return {form,formKey};});}
 async disableLeadForm(id:string){identifier(id);return this.run(async tx=>{const saved=await query(tx,"UPDATE app.lead_forms SET status='disabled',version=version+1,updated_at=app.utc_now() WHERE organization_id=$1 AND id=$2 RETURNING id",[this.org,id]);if(!saved.length)return fail('NOT_FOUND',404);await event(tx,this.ctx,'lead_form.disabled',id);});}
 private async activeForm(tx:Client,formKey:unknown){if(typeof formKey!=='string'||!/^lf_[A-Za-z0-9_-]{32}$/.test(formKey))return fail('FORM_UNAVAILABLE',404);const form=await one(tx,"SELECT * FROM app.lead_forms WHERE organization_id=$1 AND form_key_hash=$2 AND status='active'",[this.org,sha256(formKey)]);if(!form)return fail('FORM_UNAVAILABLE',404);return form;}
 /** Public: returns the consent text/version and a signed single-use nonce. */
 async leadFormChallenge(formKey:unknown){const secret=leadSecret(this.environment);return this.run(async tx=>{const form=await this.activeForm(tx,formKey);return {nonce:issueLeadNonce(form.form_key_hash,secret,this.clock()),consentText:form.consent_text,consentVersion:form.consent_version};});}
 /** Public: always returns the same minimal body on success so responses never reveal whether a contact exists. */
 async submitLead(input:{formKey:unknown;nonce:unknown;honeypot?:unknown;name:unknown;email:unknown;message?:unknown;consent:unknown;consentVersion:unknown;ip:string;origin?:string|null;pageUrl?:unknown;userAgent?:string|null}):Promise<{accepted:true}>{
  const secret=leadSecret(this.environment),now=this.clock();const ipHash=hashLeadIp(input.ip||'unknown',secret);
  const outcome=await this.run(async tx=>{const form=await this.activeForm(tx,input.formKey);
   if(form.allowed_origin&&input.origin!==form.allowed_origin)return fail('ORIGIN_NOT_ALLOWED',403);
   const day=now.toISOString().slice(0,10);const attempts=(await one(tx,'INSERT INTO app.lead_rate_limits(organization_id,form_id,ip_hash,day,attempts) VALUES($1,$2,$3,$4,1) ON CONFLICT(organization_id,form_id,ip_hash,day) DO UPDATE SET attempts=app.lead_rate_limits.attempts+1 RETURNING attempts',[this.org,form.id,ipHash,day]))!;
   if(Number(attempts.attempts)>Number(form.daily_limit_per_ip))return {rateLimited:true};
   if(typeof input.honeypot==='string'&&input.honeypot.trim()!=='')return {spam:true};
   const nonce=verifyLeadNonce(input.nonce,form.form_key_hash,secret,now);if(!nonce)return {invalid:true};
   if(!(await query(tx,'INSERT INTO app.lead_form_nonces(organization_id,form_id,nonce_hash) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING nonce_hash',[this.org,form.id,nonce.nonceHash])).length)return {replayed:true};
   if(input.consent!==true&&input.consent!=='true'&&input.consent!=='on')return fail('CONSENT_REQUIRED',400);if(input.consentVersion!==form.consent_version)return fail('CONSENT_VERSION_MISMATCH',409);
   const name=text(input.name,'name',160),email=emailAddress(input.email),message=input.message===undefined||input.message===''?null:text(input.message,'message',2000);
   let page:string|null=null;if(typeof input.pageUrl==='string'&&input.pageUrl){try{const url=new URL(input.pageUrl);if(url.protocol==='https:')page=`${url.origin}${url.pathname}`.slice(0,500);}catch{page=null;}}
   const hash=digest(email);await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`contact:${this.org}:${hash}`]);
   const suppressed=Boolean(await one(tx,'SELECT 1 FROM app.contact_suppressions WHERE organization_id=$1 AND email_hash=$2',[this.org,hash]));
   let contact=await one(tx,'SELECT id,status FROM app.crm_contacts WHERE organization_id=$1 AND email_hash=$2',[this.org,hash]);
   const result=suppressed||(contact&&contact.status!=='active')?'suppressed':contact?'existing_contact':'accepted';const submissionId=randomUUID(),consentHash=sha256(form.consent_text);
   if(result==='accepted')contact=await one(tx,"INSERT INTO app.crm_contacts(organization_id,display_name,email,email_hash,status,consent,lawful_source,consent_evidence) VALUES($1,$2,$3,$4,'active','unknown',$5,$6) RETURNING id,status",
    [this.org,name,email,hash,`Website lead form: ${form.label}`.slice(0,500),`lead_submission:${submissionId}; consent ${form.consent_version} (${consentHash.slice(0,12)}); email unverified - confirm before any outreach`]);
   const linked=result==='suppressed'?null:contact?.id??null;
   await tx.query('INSERT INTO app.lead_submissions(id,organization_id,form_id,contact_id,outcome,consent_given,consent_version,consent_text_hash,provenance,ip_hash,message,retention_until) VALUES($1,$2,$3,$4,$5,true,$6,$7,$8::jsonb,$9,$10,$11)',
    [submissionId,this.org,form.id,linked,result,form.consent_version,consentHash,JSON.stringify({channel:'website_lead_form',formId:form.id,formLabel:form.label,projectId:form.project_id,origin:input.origin??null,pageUrl:page,userAgentHash:input.userAgent?sha256(input.userAgent).slice(0,32):null,receivedAt:now.toISOString()}),ipHash,linked?message:null,new Date(now.getTime()+Number(form.retention_days)*86400000).toISOString()]);
   if(linked)await tx.query("INSERT INTO app.contact_events(organization_id,contact_id,kind,content,source) VALUES($1,$2,'inbound',$3,'provider')",[this.org,linked,`Website lead form submission (${form.label}); submission ${submissionId}`]);
   await event(tx,this.ctx,'lead.received',submissionId,{formId:form.id,outcome:result},'provider');return {submission:submissionId,result};});
  if('rateLimited' in outcome)return fail('RATE_LIMITED',429);if('invalid' in outcome)return fail('INVALID_SUBMISSION',400);if('replayed' in outcome)return fail('SUBMISSION_REPLAYED',409);
  return {accepted:true};}
 async purgeExpiredLeads(){return this.run(async tx=>{const purged=await query(tx,"UPDATE app.lead_submissions SET message=NULL,purged_at=app.utc_now() WHERE organization_id=$1 AND retention_until<=$2::timestamptz AND purged_at IS NULL RETURNING id",[this.org,this.clock().toISOString()]);
  await tx.query('DELETE FROM app.lead_rate_limits WHERE organization_id=$1 AND day<$2::date',[this.org,new Date(this.clock().getTime()-2*86400000).toISOString().slice(0,10)]);await event(tx,this.ctx,'lead.retention_purged',null,{purged:purged.length});return {purged:purged.length};});}

 // ----- DOTS-142 signed, expiring, revocable client portal links -----
 async createPortalLink(accountId:string,expiresInDays=14){identifier(accountId);const days=integer(expiresInDays,1,30,'INVALID_PORTAL_EXPIRY');const id=randomBytes(16).toString('hex'),secret=randomBytes(32).toString('base64url');const token=`pl_${id}.${secret}`;
  return this.run(async tx=>{if(!(await one(tx,'SELECT id FROM app.crm_accounts WHERE organization_id=$1 AND id=$2',[this.org,accountId])))return fail('ACCOUNT_NOT_FOUND',404);
   const link=(await one(tx,"INSERT INTO app.portal_links(organization_id,account_id,token_hash,expires_at,created_by_membership_id) VALUES($1,$2,$3,app.utc_now()+make_interval(days=>$4),$5) RETURNING id,account_id,expires_at,created_at",[this.org,accountId,sha256(token),days,this.ctx.membershipId]))!;
   await event(tx,this.ctx,'portal_link.created',link.id,{accountId,expiresInDays:days});return {...link,token};});}
 async revokePortalLink(id:string){identifier(id);return this.run(async tx=>{const saved=await query(tx,'UPDATE app.portal_links SET revoked_at=app.utc_now() WHERE organization_id=$1 AND id=$2 AND revoked_at IS NULL RETURNING id',[this.org,id]);if(!saved.length)return fail('NOT_FOUND',404);await event(tx,this.ctx,'portal_link.revoked',id);});}
 /** Customer-facing view: only the linked account's invoices, verified payment status, contract evidence and meeting history. Never messages or model output. */
 async portalView(token:unknown){if(typeof token!=='string'||!portalTokenPattern.test(token))return fail('PORTAL_LINK_INVALID',404);const hash=sha256(token);
  return this.run(async tx=>{const link=await one(tx,'SELECT * FROM app.portal_links WHERE organization_id=$1 AND token_hash=$2',[this.org,hash]);
   if(!link||!sameHash(link.token_hash,hash)||link.revoked_at||new Date(link.expires_at).getTime()<=this.clock().getTime())return fail('PORTAL_LINK_INVALID',404);
   await tx.query('UPDATE app.portal_links SET last_viewed_at=app.utc_now(),view_count=view_count+1 WHERE organization_id=$1 AND id=$2',[this.org,link.id]);
   const account=(await one(tx,'SELECT id,name FROM app.crm_accounts WHERE organization_id=$1 AND id=$2',[this.org,link.account_id]))!;
   const invoices=await query(tx,`SELECT DISTINCT i.id,i.invoice_number,i.label,i.description,i.state,i.amount_cents,i.due_at,i.created_at,i.test_mode FROM app.invoices i
    LEFT JOIN app.crm_contacts c ON c.organization_id=i.organization_id AND c.id=i.contact_id LEFT JOIN app.quotes q ON q.organization_id=i.organization_id AND q.invoice_id=i.id
    WHERE i.organization_id=$1 AND i.state<>'draft' AND (c.account_id=$2 OR q.account_id=$2) ORDER BY i.created_at DESC`,[this.org,account.id]);
   const ids=invoices.map(invoice=>invoice.id);
   const payments=ids.length?await query(tx,"SELECT invoice_id,kind,amount_cents,source,occurred_at FROM app.money_entries WHERE organization_id=$1 AND invoice_id=ANY($2::uuid[]) AND kind IN ('sale_receipt','refund','dispute_hold','dispute_reversal') ORDER BY occurred_at",[this.org,ids]):[];
   const contracts=await query(tx,"SELECT q.quote_number,q.total_cents,q.billing_interval,q.offer_terms,q.state,q.binding,q.sent_at,q.accepted_at,q.expires_at,q.content_hash FROM app.quotes q LEFT JOIN app.crm_contacts c ON c.organization_id=q.organization_id AND c.id=q.contact_id WHERE q.organization_id=$1 AND (q.account_id=$2 OR c.account_id=$2) AND q.state IN ('sent','accepted') ORDER BY q.created_at DESC",[this.org,account.id]);
   const subscriptions=await query(tx,"SELECT label,state,amount_cents,billing_interval,current_period_end,trial_ends_at FROM app.revenue_subscriptions s WHERE s.organization_id=$1 AND (s.account_id=$2 OR s.contact_id IN (SELECT id FROM app.crm_contacts WHERE organization_id=$1 AND account_id=$2)) ORDER BY s.created_at DESC",[this.org,account.id]);
   const meetings=await query(tx,"SELECT m.subject,m.starts_at,m.ends_at,m.state FROM app.meetings m LEFT JOIN app.crm_contacts c ON c.organization_id=m.organization_id AND c.id=m.contact_id WHERE m.organization_id=$1 AND (m.account_id=$2 OR c.account_id=$2) ORDER BY m.starts_at DESC LIMIT 50",[this.org,account.id]);
   await event(tx,this.ctx,'portal_link.viewed',link.id,{},'provider');
   return {account:{name:account.name},expiresAt:new Date(link.expires_at).toISOString(),
    invoices:invoices.map(invoice=>({invoiceNumber:invoice.invoice_number,label:invoice.label,description:invoice.description,state:invoice.state,amountCents:Number(invoice.amount_cents),dueAt:invoice.due_at,issuedAt:invoice.created_at,sandbox:invoice.test_mode,
     payments:payments.filter(entry=>entry.invoice_id===invoice.id).map(entry=>({kind:entry.kind,amountCents:Number(entry.amount_cents),verified:entry.source==='provider',occurredAt:entry.occurred_at}))})),
    contracts:contracts.map(quote=>({quoteNumber:quote.quote_number,totalCents:Number(quote.total_cents),billingInterval:quote.billing_interval,terms:quote.offer_terms,state:quote.state,binding:quote.binding,sentAt:quote.sent_at,acceptedAt:quote.accepted_at,expiresAt:quote.expires_at,evidenceHash:quote.content_hash})),
    subscriptions:subscriptions.map(item=>({label:item.label,state:item.state,amountCents:Number(item.amount_cents),billingInterval:item.billing_interval,renewsAt:item.current_period_end??item.trial_ends_at})),
    history:meetings.map(item=>({kind:'meeting',subject:item.subject,startsAt:item.starts_at,endsAt:item.ends_at,state:item.state}))};});}

 // ----- DOTS-137/143 realized revenue and cohort profitability -----
 async realizedRevenue(){return this.run(async tx=>this.revenueTotals(tx));}
 private async revenueTotals(tx:Client){const totals=await query(tx,"SELECT source,kind,COALESCE(sum(amount_cents),0)::text AS total FROM app.money_entries WHERE organization_id=$1 AND source IN ('provider','simulation') GROUP BY source,kind",[this.org]);
  const build=(source:string)=>{const get=(kind:string)=>Number(totals.find(t=>t.source===source&&t.kind===kind)?.total??0);const receipts=get('sale_receipt')+get('subscription_receipt');
   return {receiptsCents:receipts,refundsCents:get('refund'),disputesHeldCents:get('dispute_hold'),disputesReversedCents:get('dispute_reversal'),processorFeesCents:get('processor_fee'),netRealizedCents:receipts-get('refund')-get('dispute_hold')+get('dispute_reversal')-get('processor_fee'),expensesCents:get('expense')};};
  return {verified:build('provider'),sandbox:build('simulation'),basis:'Only signed processor webhook events create ledger rows; sandbox events are kept separate and never count as realized revenue.'};}
 async cohortReport(){return this.run(async tx=>{
  const entries=await query(tx,`SELECT m.id,m.kind,m.amount_cents,m.source,m.occurred_at,m.reservation_id,
    COALESCE(m.project_id,i.project_id,s.project_id,(SELECT sp.project_id FROM app.reservation_policy_links l JOIN app.spending_policies sp ON sp.organization_id=l.organization_id AND sp.id=l.policy_id WHERE l.organization_id=m.organization_id AND l.reservation_id=m.reservation_id AND sp.project_id IS NOT NULL LIMIT 1)) AS project_id,
    COALESCE(s.account_id,ic.account_id,sc.account_id) AS account_id,COALESCE(i.contact_id,s.contact_id) AS contact_id,r.idempotency_key AS reservation_key
   FROM app.money_entries m LEFT JOIN app.invoices i ON i.organization_id=m.organization_id AND i.id=m.invoice_id LEFT JOIN app.revenue_subscriptions s ON s.organization_id=m.organization_id AND s.id=m.subscription_id
   LEFT JOIN app.crm_contacts ic ON ic.organization_id=m.organization_id AND ic.id=i.contact_id LEFT JOIN app.crm_contacts sc ON sc.organization_id=m.organization_id AND sc.id=s.contact_id
   LEFT JOIN app.budget_reservations r ON r.organization_id=m.organization_id AND r.id=m.reservation_id
   WHERE m.organization_id=$1 AND m.source='provider' AND m.kind IN ('sale_receipt','subscription_receipt','refund','dispute_hold','dispute_reversal','processor_fee','expense') ORDER BY m.occurred_at,m.id`,[this.org]);
  const touches=await query(tx,"SELECT DISTINCT c.contact_id,ct.account_id,min(COALESCE(m.sent_at,m.created_at)) AS first_touch FROM app.messages m JOIN app.conversations c ON c.organization_id=m.organization_id AND c.id=m.conversation_id JOIN app.crm_contacts ct ON ct.organization_id=c.organization_id AND ct.id=c.contact_id WHERE m.organization_id=$1 AND m.direction='outbound' AND m.campaign_id IS NOT NULL AND m.state IN ('sent','delivered') GROUP BY c.contact_id,ct.account_id",[this.org]);
  const month=(value:unknown)=>new Date(String(value instanceof Date?value.toISOString():value)).toISOString().slice(0,7);
  const customer=(entry:Row)=>entry.account_id?`account:${entry.account_id}`:entry.contact_id?`contact:${entry.contact_id}`:null;
  const signed:Record<string,number>={sale_receipt:1,subscription_receipt:1,refund:-1,dispute_hold:-1,dispute_reversal:1,processor_fee:-1};
  const firstReceipt=new Map<string,{cohort:string;at:string}>();
  for(const entry of entries)if(['sale_receipt','subscription_receipt'].includes(entry.kind)){const key=customer(entry);if(key&&!firstReceipt.has(key))firstReceipt.set(key,{cohort:`${entry.project_id}|${month(entry.occurred_at)}`,at:new Date(entry.occurred_at).toISOString()});}
  type Cohort={cohort:string;projectId:string;month:string;customers:Set<string>;touched:Set<string>;receiptsCents:number;refundsCents:number;disputeLossCents:number;feesCents:number;netRevenueCents:number;modelSpendCents:number;channelSpendCents:number;otherSpendCents:number};
  const cohorts=new Map<string,Cohort>();const cohortFor=(key:string)=>{let item=cohorts.get(key);if(!item){const [projectId,m]=key.split('|') as [string,string];item={cohort:key,projectId,month:m,customers:new Set(),touched:new Set(),receiptsCents:0,refundsCents:0,disputeLossCents:0,feesCents:0,netRevenueCents:0,modelSpendCents:0,channelSpendCents:0,otherSpendCents:0};cohorts.set(key,item);}return item;};
  for(const [key,first] of firstReceipt){const item=cohortFor(first.cohort);item.customers.add(key);const touched=touches.some(t=>(`contact:${t.contact_id}`===key||(t.account_id&&`account:${t.account_id}`===key))&&new Date(t.first_touch).getTime()<=new Date(first.at).getTime());if(touched)item.touched.add(key);}
  let unattributedRevenue=0,unallocatedSpend=0,ledgerNet=0;
  for(const entry of entries){const amount=Number(entry.amount_cents);
   if(entry.kind==='expense'){ledgerNet-=amount;const key=entry.project_id?`${entry.project_id}|${month(entry.occurred_at)}`:null;const item=key?cohorts.get(key):undefined;if(!item){unallocatedSpend+=amount;continue;}
    const reservationKey=String(entry.reservation_key??'');if(reservationKey.startsWith('message:'))item.channelSpendCents+=amount;else if(entry.reservation_id)item.modelSpendCents+=amount;else item.otherSpendCents+=amount;continue;}
   const value=(signed[entry.kind]??0)*amount;ledgerNet+=value;const key=customer(entry);const first=key?firstReceipt.get(key):undefined;if(!first){unattributedRevenue+=value;continue;}
   const item=cohortFor(first.cohort);item.netRevenueCents+=value;if(entry.kind==='refund')item.refundsCents+=amount;else if(entry.kind==='dispute_hold')item.disputeLossCents+=amount;else if(entry.kind==='dispute_reversal')item.disputeLossCents-=amount;else if(entry.kind==='processor_fee')item.feesCents+=amount;else item.receiptsCents+=amount;}
  const report=[...cohorts.values()].sort((a,b)=>a.month.localeCompare(b.month)||a.projectId.localeCompare(b.projectId)).map(item=>{const spend=item.modelSpendCents+item.channelSpendCents+item.otherSpendCents,customers=item.customers.size;const coverage=customers?item.touched.size/customers:0;
   return {cohort:item.month,projectId:item.projectId,newCustomers:customers,receiptsCents:item.receiptsCents,refundsCents:item.refundsCents,disputeLossCents:item.disputeLossCents,processorFeesCents:item.feesCents,netRevenueCents:item.netRevenueCents,
    allocatedModelSpendCents:item.modelSpendCents,allocatedChannelSpendCents:item.channelSpendCents,allocatedOtherSpendCents:item.otherSpendCents,netMarginCents:item.netRevenueCents-spend,cacCents:customers?Math.round(spend/customers):null,
    attribution:{touchedCustomers:item.touched.size,coverage,uncertainty:customers===0?'high':coverage>=0.8?'low':coverage>=0.4?'medium':'high'}};});
  const reported=report.reduce((sum,item)=>sum+item.netMarginCents,0)+unattributedRevenue-unallocatedSpend;
  return {cohorts:report,unattributedRevenueCents:unattributedRevenue,unallocatedSpendCents:unallocatedSpend,
   reconciliation:{ledgerNetCents:ledgerNet,reportedNetCents:reported,matches:ledgerNet===reported},
   method:'Cohort = project and month of a customer\'s first provider-verified receipt. Spend is provider-settled expense allocated to the cohort with the same project and month; touchpoint coverage is the share of new customers with a sent campaign message before first payment. No multi-touch model is applied, so coverage below 80% is reported as medium/high uncertainty.',
   sandbox:(await this.revenueTotals(tx)).sandbox};});}

 // ----- Owner snapshot -----
 async snapshot(){const [revenue,retention,renewals,cohorts]=[await this.realizedRevenue(),await this.retentionMetrics(),await this.renewals(),await this.cohortReport()];
  return this.run(async tx=>{const list=(statement:string)=>query(tx,statement,[this.org]);
   return {priceBooks:await list('SELECT * FROM app.price_books WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 100'),
    priceRevisions:await list('SELECT * FROM app.price_book_revisions WHERE organization_id=$1 ORDER BY price_book_id,revision DESC LIMIT 500'),
    quotes:await list('SELECT * FROM app.quotes WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 100'),
    quoteApprovals:await list("SELECT id,record_id,status,expires_at,proposed_payload FROM app.action_approvals WHERE organization_id=$1 AND action_kind='quotation' ORDER BY created_at DESC LIMIT 100"),
    subscriptions:await list('SELECT * FROM app.revenue_subscriptions WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 100'),
    onboarding:await list('SELECT * FROM app.onboarding_tasks WHERE organization_id=$1 ORDER BY subscription_id,position'),
    escalations:await list('SELECT * FROM app.service_escalations WHERE organization_id=$1 ORDER BY opened_at DESC LIMIT 100'),
    retentionEvents:await list('SELECT * FROM app.retention_events WHERE organization_id=$1 ORDER BY occurred_at DESC LIMIT 100'),
    calendars:await list('SELECT id,label,provider,calendar_ref,credential_env_ref,timezone,status,created_at FROM app.calendar_connections WHERE organization_id=$1 ORDER BY created_at DESC'),
    delegations:await list('SELECT * FROM app.calendar_delegations WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 100'),
    meetings:await list('SELECT * FROM app.meetings WHERE organization_id=$1 ORDER BY starts_at DESC LIMIT 100'),
    crmRuns:await list('SELECT * FROM app.crm_sync_runs WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 50'),
    crmConflicts:await list('SELECT * FROM app.crm_sync_conflicts WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 100'),
    crmOwnership:await list('SELECT * FROM app.crm_field_ownership WHERE organization_id=$1 ORDER BY system,entity_kind,field'),
    leadForms:await list('SELECT id,project_id,label,consent_text,consent_version,retention_days,daily_limit_per_ip,allowed_origin,status,created_at FROM app.lead_forms WHERE organization_id=$1 ORDER BY created_at DESC'),
    leadSubmissions:await list('SELECT id,form_id,contact_id,outcome,consent_version,retention_until,purged_at,created_at FROM app.lead_submissions WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 100'),
    portalLinks:await list('SELECT id,account_id,expires_at,revoked_at,last_viewed_at,view_count,created_at FROM app.portal_links WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 100'),
    projects:await list("SELECT id,label FROM app.projects WHERE organization_id=$1 AND status='active' ORDER BY label"),
    accounts:await list('SELECT id,name FROM app.crm_accounts WHERE organization_id=$1 ORDER BY name LIMIT 500'),
    contacts:await list("SELECT id,display_name,account_id,status FROM app.crm_contacts WHERE organization_id=$1 AND status<>'redacted' ORDER BY display_name LIMIT 500"),
    agents:await list("SELECT id,display_name,status FROM app.agent_identities WHERE organization_id=$1 ORDER BY display_name"),
    invoices:await list('SELECT id,invoice_number,label,state,amount_cents,test_mode,version FROM app.invoices WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 100'),
    revenue,retention,renewals,cohorts,payments:paymentConfiguration(this.environment),observedAt:this.clock().toISOString()};});}
}
/** Non-secret payment configuration summary: names and modes only. */
export function paymentConfiguration(environment:Environment){const key=environment.STRIPE_SECRET_KEY??'';const mode=/^(sk|rk)_test_/.test(key)?'sandbox':/^(sk|rk)_live_/.test(key)?'live':'not_configured';
 return {enabled:environment.PAYMENTS_ENABLED==='true',mode,restrictedKey:/^rk_/.test(key),merchantAuthorized:Boolean(environment.OWNER_MERCHANT_AUTHORIZATION_ID),liveAuthorized:Boolean(environment.PRODUCTION_PAYMENTS_AUTHORIZATION_ID)&&environment.PAYMENTS_LIVE_MODE==='true',
  webhookSecretConfigured:Boolean(environment.STRIPE_WEBHOOK_SECRET),maxPaymentCents:Number(environment.MAX_PAYMENT_CENTS??0)||0};}
