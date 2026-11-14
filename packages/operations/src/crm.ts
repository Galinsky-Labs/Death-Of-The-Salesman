// DOTS-070..081 CRM, lead integrity and revenue pipeline.
// Every mutation runs inside tenant(), writes an operational event without raw contact details,
// and fails closed with stable reason codes. Nothing in this module sends, queues or schedules outreach.
import {type Client,type Context,type Row,rows,tenant,event,digest,text,cents,fail,OperationError} from './common.js';
import {emailAddress,identifier,selection,dateOrNull} from './sales.js';

export const consentStates=['unknown','opted_in','existing_customer','business_reviewed','opted_out'] as const;
export const sourceKinds=['owner_collected','opt_in_form','existing_customer','event_registration','referral','public_business_directory','purchased_list','scraped','unknown'] as const;
export const prohibitedSourceKinds=['purchased_list','scraped','unknown'] as const;
export const lawfulBases=['consent','legitimate_interest','contract','none'] as const;
export const purposes=['product','grant','investment'] as const;
export const probabilityLabels=['unknown','low','medium','high','closed'] as const;
export const evidenceRules=['none','owner_note','document','verified_payment_or_signature'] as const;
export const segmentMetadataKeys=['industry','employee_band','revenue_band','country','tier','customer_status'] as const;
export const contactabilityReasons=['CONTACT_NOT_FOUND','CONTACT_MERGED','CONTACT_REDACTED','CONTACT_INACTIVE','CONTACT_SUPPRESSED','CONSENT_MISSING','REGION_UNREVIEWED','REGION_NOT_ALLOWED','REGION_REQUIRES_OPT_IN','CAMPAIGN_NOT_FOUND','CAMPAIGN_CLOSED','SOURCE_PURPOSE_MISMATCH','CHANNEL_UNAVAILABLE','FREQUENCY_LIMIT_REACHED','PROSPECT_IN_OTHER_CAMPAIGN','PROSPECT_OWNED_BY_OTHER_AGENT','PROSPECT_IN_EXCLUSION_WINDOW','PROSPECT_NOT_CLAIMED'] as const;
const freeMailDomains=new Set(['gmail.com','googlemail.com','yahoo.com','outlook.com','hotmail.com','live.com','icloud.com','me.com','aol.com','proton.me','protonmail.com','gmx.com','mail.com']);
const DEFAULT_POLICY={max_touches:1,window_days:7,exclusion_days:30};

// ---------- normalization and privacy helpers ----------
export const normalizePerson=(value:string):string=>value.toLowerCase().replace(/[^a-z0-9]+/g,'');
export const normalizeOrganization=(value:string):string=>value.toLowerCase().replace(/\b(incorporated|inc|llc|ltd|limited|corp|corporation|co|company|gmbh|plc|ag|bv)\b/g,'').replace(/[^a-z0-9]+/g,'');
export function normalizeDomain(value:unknown):string|null {
 if(value===undefined||value===null||value==='')return null;
 const raw=text(value,'domain',253).toLowerCase().replace(/^https?:\/\//,'').replace(/^www\./,'').split(/[/?#:]/)[0]!;
 if(!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(raw))return fail('INVALID_DOMAIN',400);
 return raw;
}
export const isFreeMailDomain=(domain:string|null|undefined)=>!domain||freeMailDomains.has(domain);
export function maskEmail(email:unknown):string|null {
 if(typeof email!=='string'||!email.includes('@'))return null;
 const [local,domain]=email.split('@');return `${(local??'').slice(0,1)}***@${domain}`;
}
/** Replaces any email-like substring before a value reaches a log line or snapshot. */
export function redactPii(value:string):string {return value.replace(/[^\s@<>"'(),;]+@[^\s@<>"'(),;]+\.[a-z]{2,}/gi,match=>maskEmail(match)??'[redacted]');}
function names(value:unknown,field:string,max=50):string[] {
 if(value===undefined||value===null)return [];
 if(!Array.isArray(value)||value.length>max)return fail(`INVALID_${field.toUpperCase()}`,400);
 return value.map(item=>text(item,field,160));
}
function metadataObject(value:unknown,allowed?:readonly string[]):Record<string,string> {
 if(value===undefined||value===null)return {};
 if(typeof value!=='object'||Array.isArray(value))return fail('INVALID_METADATA',400);
 const entries=Object.entries(value as Record<string,unknown>);if(entries.length>20)return fail('INVALID_METADATA',400);
 const output:Record<string,string>={};
 for(const [key,item] of entries){
  if(!/^[a-z][a-z0-9_]{0,39}$/.test(key))return fail('INVALID_METADATA',400);
  if(allowed&&!allowed.includes(key))return fail('SEGMENT_FIELD_NOT_ALLOWED',400);
  if(typeof item!=='string'||item.length>160)return fail('INVALID_METADATA',400);
  if(/@/.test(item))return fail('METADATA_MUST_NOT_CONTAIN_EMAIL',400);
  output[key]=item.trim();
 }
 return output;
}
function jurisdictionCode(value:unknown):string {const code=text(value,'jurisdiction',6).toUpperCase();if(!/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/.test(code))return fail('INVALID_JURISDICTION',400);return code;}
const lock=(tx:Client,key:string)=>tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[key]);
const isUniqueViolation=(error:unknown)=>String((error as {code?:string})?.code??'')==='23505'||/duplicate key|unique constraint/i.test(String((error as Error)?.message??''));
function publicContact(row:Row):Row {
 const {email,email_hash:_hash,...rest}=row;return {...rest,email_masked:maskEmail(email)};
}

// ---------- contact clusters (survivor + merged duplicates) ----------
async function cluster(tx:Client,org:string,contactId:string){
 const contact=rows(await tx.query('SELECT * FROM app.crm_contacts WHERE organization_id=$1 AND id=$2',[org,contactId]))[0];
 if(!contact)return null;
 const survivorId=contact.status==='merged'?String(contact.merged_into_id):String(contact.id);
 const members=rows(await tx.query('SELECT * FROM app.crm_contacts WHERE organization_id=$1 AND (id=$2 OR merged_into_id=$2)',[org,survivorId]));
 const ids=members.map(member=>String(member.id));
 const methodHashes=rows(await tx.query("SELECT value_hash FROM app.crm_contact_methods WHERE organization_id=$1 AND kind='email' AND contact_id=ANY($2::uuid[])",[org,ids])).map(row=>String(row.value_hash));
 const hashes=[...new Set([...members.map(member=>String(member.email_hash)),...methodHashes])];
 return {contact,survivorId,members,ids,hashes};
}
async function contactPolicy(tx:Client,org:string){return rows(await tx.query('SELECT * FROM app.crm_contact_policies WHERE organization_id=$1',[org]))[0]??DEFAULT_POLICY;}

export type ContactabilityInput={contactId:string;campaignId:string;agentId?:string;channel:string};
/** Returns every reason a contact may not be contacted right now; an empty list means allowed. Never mutates. */
export async function contactability(tx:Client,ctx:Context,input:ContactabilityInput):Promise<{allowed:boolean;reasons:string[];survivorId:string|null;clusterIds:string[]}> {
 const org=ctx.organizationId;identifier(input.contactId);identifier(input.campaignId);if(input.agentId)identifier(input.agentId);
 const channel=selection(input.channel,['email','phone'],'channel');
 const found=await cluster(tx,org,input.contactId);
 if(!found)return {allowed:false,reasons:['CONTACT_NOT_FOUND'],survivorId:null,clusterIds:[]};
 const {contact,survivorId,ids,hashes}=found;const reasons:string[]=[];
 if(contact.status==='merged')reasons.push('CONTACT_MERGED');
 else if(contact.status==='redacted')reasons.push('CONTACT_REDACTED');
 else if(contact.status==='archived')reasons.push('CONTACT_INACTIVE');
 const suppressed=rows(await tx.query('SELECT 1 FROM app.contact_suppressions WHERE organization_id=$1 AND email_hash=ANY($2::text[]) LIMIT 1',[org,hashes])).length>0;
 if(suppressed||contact.status==='suppressed'||contact.consent==='opted_out')reasons.push('CONTACT_SUPPRESSED');
 else if(contact.consent==='unknown')reasons.push('CONSENT_MISSING');
 const jurisdiction=String(contact.jurisdiction??'unreviewed');
 if(jurisdiction==='unreviewed'||!jurisdiction)reasons.push('REGION_UNREVIEWED');
 else{
  const region=rows(await tx.query('SELECT * FROM app.crm_region_policies WHERE organization_id=$1 AND jurisdiction=$2',[org,jurisdiction]))[0];
  if(!region||!region.allowed)reasons.push('REGION_NOT_ALLOWED');
  else if(region.requires_opt_in&&contact.consent!=='opted_in')reasons.push('REGION_REQUIRES_OPT_IN');
 }
 const campaign=rows(await tx.query('SELECT id,purpose,state FROM app.campaigns WHERE organization_id=$1 AND id=$2',[org,input.campaignId]))[0];
 if(!campaign)reasons.push('CAMPAIGN_NOT_FOUND');
 else{
  if(['archived','completed'].includes(campaign.state))reasons.push('CAMPAIGN_CLOSED');
  const sourcePurposes=rows(await tx.query('SELECT DISTINCT purpose FROM app.crm_contact_sources WHERE organization_id=$1 AND contact_id=ANY($2::uuid[])',[org,ids])).map(row=>row.purpose);
  if(sourcePurposes.length&&!sourcePurposes.includes(campaign.purpose))reasons.push('SOURCE_PURPOSE_MISMATCH');
 }
 if(channel==='email'&&!contact.email)reasons.push('CHANNEL_UNAVAILABLE');
 if(channel==='phone'&&!rows(await tx.query("SELECT 1 FROM app.crm_contact_methods WHERE organization_id=$1 AND kind='phone' AND contact_id=ANY($2::uuid[]) AND value IS NOT NULL LIMIT 1",[org,ids])).length)reasons.push('CHANNEL_UNAVAILABLE');
 const policy=await contactPolicy(tx,org);
 const touches=rows(await tx.query(`SELECT
   (SELECT count(*) FROM app.messages m JOIN app.conversations c ON c.organization_id=m.organization_id AND c.id=m.conversation_id
     WHERE m.organization_id=$1 AND c.contact_id=ANY($2::uuid[]) AND m.direction='outbound' AND m.state IN ('sending','sent','delivered')
     AND COALESCE(m.sent_at,m.created_at)>app.utc_now()-make_interval(days=>$3::int))
  +(SELECT count(*) FROM app.crm_touchpoints t WHERE t.organization_id=$1 AND t.contact_id=ANY($2::uuid[]) AND t.direction='outbound' AND t.message_id IS NULL
     AND t.occurred_at>app.utc_now()-make_interval(days=>$3::int)) AS total`,[org,ids,Number(policy.window_days)]))[0]!;
 if(Number(touches.total)>=Number(policy.max_touches))reasons.push('FREQUENCY_LIMIT_REACHED');
 const active=rows(await tx.query("SELECT * FROM app.crm_prospect_claims WHERE organization_id=$1 AND contact_id=ANY($2::uuid[]) AND state='active'",[org,ids]));
 if(active.length){
  const claim=active[0]!;
  if(String(claim.campaign_id)!==input.campaignId)reasons.push('PROSPECT_IN_OTHER_CAMPAIGN');
  else if(input.agentId&&String(claim.agent_identity_id)!==input.agentId)reasons.push('PROSPECT_OWNED_BY_OTHER_AGENT');
 }else{
  const recent=rows(await tx.query("SELECT agent_identity_id,campaign_id FROM app.crm_prospect_claims WHERE organization_id=$1 AND contact_id=ANY($2::uuid[]) AND state='released' AND exclusive_until>app.utc_now()",[org,ids]));
  if(recent.some(claim=>input.agentId?String(claim.agent_identity_id)!==input.agentId:String(claim.campaign_id)!==input.campaignId))reasons.push('PROSPECT_IN_EXCLUSION_WINDOW');
  if(input.agentId)reasons.push('PROSPECT_NOT_CLAIMED');
 }
 return {allowed:reasons.length===0,reasons,survivorId,clusterIds:ids};
}
/**
 * Deterministic gate for the send path and the queue. Call it inside the same transaction that dispatches,
 * immediately before dispatch. Throws OperationError(<reason code>,403) on the first failing rule.
 */
export async function assertContactable(tx:Client,ctx:Context,input:ContactabilityInput){
 const found=rows(await tx.query('SELECT merged_into_id,id FROM app.crm_contacts WHERE organization_id=$1 AND id=$2',[ctx.organizationId,identifier(input.contactId)]))[0];
 await lock(tx,`contact-touch:${ctx.organizationId}:${found?.merged_into_id??input.contactId}`);
 const result=await contactability(tx,ctx,input);
 if(!result.allowed)throw new OperationError(result.reasons[0]!,403);
 return result;
}

// ---------- segment filters ----------
export type SegmentFilter={accountIds?:string[];sectors?:string[];jurisdictions?:string[];consents?:string[];sourceKinds?:string[];purposes?:string[];domains?:string[];hasOwner?:boolean;metadata?:Record<string,string>;namePrefix?:string};
const segmentKeys=['accountIds','sectors','jurisdictions','consents','sourceKinds','purposes','domains','hasOwner','metadata','namePrefix'];
export function validateSegmentFilter(value:unknown):SegmentFilter {
 if(!value||typeof value!=='object'||Array.isArray(value))return fail('INVALID_SEGMENT',400);
 const input=value as Record<string,unknown>;
 for(const key of Object.keys(input))if(!segmentKeys.includes(key))return fail('SEGMENT_FIELD_NOT_ALLOWED',400);
 const filter:SegmentFilter={};
 if(input.accountIds!==undefined)filter.accountIds=names(input.accountIds,'account_ids').map(identifier);
 if(input.sectors!==undefined)filter.sectors=names(input.sectors,'sectors');
 if(input.jurisdictions!==undefined)filter.jurisdictions=names(input.jurisdictions,'jurisdictions');
 if(input.consents!==undefined)filter.consents=names(input.consents,'consents').map(item=>selection(item,consentStates,'consent'));
 if(input.sourceKinds!==undefined)filter.sourceKinds=names(input.sourceKinds,'source_kinds').map(item=>selection(item,sourceKinds,'source_kind'));
 if(input.purposes!==undefined)filter.purposes=names(input.purposes,'purposes').map(item=>selection(item,purposes,'purpose'));
 if(input.domains!==undefined)filter.domains=names(input.domains,'domains').map(item=>normalizeDomain(item)!);
 if(input.hasOwner!==undefined){if(typeof input.hasOwner!=='boolean')return fail('INVALID_SEGMENT',400);filter.hasOwner=input.hasOwner;}
 if(input.metadata!==undefined)filter.metadata=metadataObject(input.metadata,segmentMetadataKeys);
 if(input.namePrefix!==undefined){const prefix=normalizePerson(text(input.namePrefix,'name_prefix',80));if(prefix)filter.namePrefix=prefix;}
 return filter;
}
function segmentWhere(filter:SegmentFilter,values:unknown[]):string {
 const conditions:string[]=[];const add=(value:unknown)=>{values.push(value);return `$${values.length}`;};
 if(filter.accountIds?.length)conditions.push(`c.account_id=ANY(${add(filter.accountIds)}::uuid[])`);
 if(filter.sectors?.length)conditions.push(`a.sector=ANY(${add(filter.sectors)}::text[])`);
 if(filter.jurisdictions?.length)conditions.push(`c.jurisdiction=ANY(${add(filter.jurisdictions)}::text[])`);
 if(filter.consents?.length)conditions.push(`c.consent=ANY(${add(filter.consents)}::text[])`);
 if(filter.domains?.length)conditions.push(`c.email_domain=ANY(${add(filter.domains)}::text[])`);
 if(filter.sourceKinds?.length)conditions.push(`EXISTS(SELECT 1 FROM app.crm_contact_sources s WHERE s.organization_id=c.organization_id AND s.contact_id=c.id AND s.source_kind=ANY(${add(filter.sourceKinds)}::text[]))`);
 if(filter.purposes?.length)conditions.push(`EXISTS(SELECT 1 FROM app.crm_contact_sources s WHERE s.organization_id=c.organization_id AND s.contact_id=c.id AND s.purpose=ANY(${add(filter.purposes)}::text[]))`);
 if(filter.hasOwner!==undefined)conditions.push(filter.hasOwner?'c.owner_membership_id IS NOT NULL':'c.owner_membership_id IS NULL');
 if(filter.metadata&&Object.keys(filter.metadata).length)conditions.push(`c.metadata @> ${add(JSON.stringify(filter.metadata))}::jsonb`);
 if(filter.namePrefix){conditions.push(`(c.normalized_name COLLATE "C")>=${add(filter.namePrefix)} AND (c.normalized_name COLLATE "C")<${add(`${filter.namePrefix}{`)}`);}
 return conditions.length?` AND ${conditions.join(' AND ')}`:'';
}
const exclusionCase=`CASE
 WHEN m.status='merged' THEN 'MERGED_DUPLICATE'
 WHEN m.status='redacted' THEN 'CONTACT_REDACTED'
 WHEN m.status='archived' THEN 'CONTACT_INACTIVE'
 WHEN m.status='suppressed' OR m.consent='opted_out'
  OR EXISTS(SELECT 1 FROM app.contact_suppressions s WHERE s.organization_id=m.organization_id AND s.email_hash=m.email_hash)
  OR EXISTS(SELECT 1 FROM app.crm_contacts d JOIN app.contact_suppressions s ON s.organization_id=d.organization_id AND s.email_hash=d.email_hash WHERE d.organization_id=m.organization_id AND d.merged_into_id=m.id) THEN 'CONTACT_SUPPRESSED'
 WHEN m.consent='unknown' THEN 'CONSENT_MISSING'
 WHEN m.jurisdiction IS NULL OR m.jurisdiction='unreviewed' THEN 'REGION_UNREVIEWED'
 WHEN r.allowed IS NOT TRUE THEN 'REGION_NOT_ALLOWED'
 WHEN r.requires_opt_in AND m.consent<>'opted_in' THEN 'REGION_REQUIRES_OPT_IN'
 WHEN EXISTS(SELECT 1 FROM app.crm_prospect_claims p WHERE p.organization_id=m.organization_id AND p.contact_id=m.id AND p.state='active') THEN 'PROSPECT_CLAIMED'
 ELSE NULL END`;

// ---------- pipeline defaults ----------
type StageSpec={key:string;label:string;outcome:'open'|'won'|'lost';evidenceRule:string;probabilityLabel:string};
export const defaultPipelineStages:StageSpec[]=[
 {key:'new',label:'New',outcome:'open',evidenceRule:'none',probabilityLabel:'unknown'},
 {key:'qualified',label:'Qualified',outcome:'open',evidenceRule:'owner_note',probabilityLabel:'low'},
 {key:'proposal',label:'Proposal',outcome:'open',evidenceRule:'owner_note',probabilityLabel:'medium'},
 {key:'trial',label:'Trial',outcome:'open',evidenceRule:'owner_note',probabilityLabel:'medium'},
 {key:'negotiation',label:'Negotiation',outcome:'open',evidenceRule:'owner_note',probabilityLabel:'high'},
 {key:'won',label:'Won',outcome:'won',evidenceRule:'verified_payment_or_signature',probabilityLabel:'closed'},
 {key:'lost',label:'Lost',outcome:'lost',evidenceRule:'owner_note',probabilityLabel:'closed'},
];
export const defaultPipelineTransitions:[string,string][]=[['new','qualified'],['new','lost'],['qualified','proposal'],['qualified','trial'],['qualified','lost'],['proposal','trial'],['proposal','negotiation'],['proposal','lost'],['trial','proposal'],['trial','negotiation'],['trial','lost'],['negotiation','proposal'],['negotiation','won'],['negotiation','lost'],['lost','qualified']];

export type SourceInput={label:string;kind:string;purpose:string;lawfulBasis:string};
function sourceInput(value:unknown):SourceInput {
 const input=(value&&typeof value==='object'?value:{}) as Record<string,unknown>;
 const source={label:text(input.label,'source',500),kind:selection(input.kind,sourceKinds,'source_kind'),purpose:selection(input.purpose,purposes,'purpose'),lawfulBasis:selection(input.lawfulBasis,lawfulBases,'lawful_basis')};
 if((prohibitedSourceKinds as readonly string[]).includes(source.kind))return fail('PROHIBITED_SOURCE',400);
 if(source.lawfulBasis==='none')return fail('NO_LAWFUL_BASIS',400);
 return source;
}
type ImportRowInput={name?:unknown;email?:unknown;account?:unknown;domain?:unknown;jurisdiction?:unknown;consent?:unknown;consentEvidence?:unknown};

export class CrmWorkspace {
 constructor(private readonly client:Client,private readonly ctx:Context){}
 private get org(){return this.ctx.organizationId;}

 // ===== DOTS-070 accounts and people =====
 async createAccount(input:{name:string;domain?:string;website?:string;sector?:string;aliases?:string[];ownerMembershipId?:string;metadata?:Record<string,string>;allowSimilar?:boolean}){
  const name=text(input.name,'account',160),domain=normalizeDomain(input.domain??input.website),aliases=names(input.aliases,'alias',20),metadata=metadataObject(input.metadata);
  const website=input.website?text(input.website,'website',300):null;if(website&&!website.startsWith('https://'))return fail('HTTPS_WEBSITE_REQUIRED',400);
  const owner=input.ownerMembershipId?identifier(input.ownerMembershipId):this.ctx.membershipId;
  const normalized=normalizeOrganization(name);if(!normalized)return fail('INVALID_ACCOUNT',400);
  return tenant(this.client,this.ctx,async tx=>{
   await lock(tx,`crm-account:${this.org}:${normalized}`);
   const similar=rows(await tx.query(`SELECT a.id,a.name,a.domain,CASE WHEN a.normalized_name=$2 THEN 'SAME_NORMALIZED_NAME' WHEN a.domain=$3 THEN 'SAME_DOMAIN' ELSE 'ALIAS_MATCH' END AS reason
     FROM app.crm_accounts a WHERE a.organization_id=$1 AND (a.normalized_name=$2 OR ($3::text IS NOT NULL AND a.domain=$3)
     OR EXISTS(SELECT 1 FROM app.crm_aliases l WHERE l.organization_id=a.organization_id AND l.account_id=a.id AND l.normalized=$2)) ORDER BY a.created_at LIMIT 10`,[this.org,normalized,domain]));
   if(similar.length&&!input.allowSimilar)return {account:null,similar,created:false};
   const account=rows(await tx.query('INSERT INTO app.crm_accounts(organization_id,name,website,sector,domain,owner_membership_id,metadata) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING *',[this.org,name,website,input.sector?text(input.sector,'sector',120):null,domain,owner,JSON.stringify(metadata)]))[0]!;
   for(const alias of aliases)await tx.query('INSERT INTO app.crm_aliases(organization_id,account_id,alias,normalized) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[this.org,account.id,alias,normalizeOrganization(alias)||normalizePerson(alias)]);
   await event(tx,this.ctx,'crm.account_created',account.id,{similarAcknowledged:similar.length>0});
   return {account,similar,created:true};
  });
 }
 async addAlias(input:{accountId?:string;contactId?:string;alias:string}){
  const alias=text(input.alias,'alias',160);if(Boolean(input.accountId)===Boolean(input.contactId))return fail('ALIAS_TARGET_REQUIRED',400);
  const normalized=input.accountId?normalizeOrganization(alias):normalizePerson(alias);if(!normalized)return fail('INVALID_ALIAS',400);
  return tenant(this.client,this.ctx,async tx=>{
   const target=input.accountId?rows(await tx.query('SELECT id FROM app.crm_accounts WHERE organization_id=$1 AND id=$2',[this.org,identifier(input.accountId)])):rows(await tx.query("SELECT id FROM app.crm_contacts WHERE organization_id=$1 AND id=$2 AND status<>'redacted'",[this.org,identifier(input.contactId)]));
   if(!target.length)return fail('NOT_FOUND',404);
   const saved=rows(await tx.query('INSERT INTO app.crm_aliases(organization_id,account_id,contact_id,alias,normalized) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING *',[this.org,input.accountId??null,input.contactId??null,alias,normalized]))[0];
   await event(tx,this.ctx,'crm.alias_added',input.accountId??input.contactId??null,{target:input.accountId?'account':'contact'});return saved??{duplicate:true};
  });
 }
 /** Creates a person with a lawful source. Re-adding a known email adds provenance instead of a second contact. */
 async createPerson(input:{name:string;email:string;source:SourceInput;accountId?:string;role?:string;aliases?:string[];methods?:{kind:string;value:string}[];ownerMembershipId?:string;metadata?:Record<string,string>;consent?:string;consentEvidence?:string;jurisdiction?:string}){
  const name=text(input.name,'contact_name',160),email=emailAddress(input.email),source=sourceInput(input.source),metadata=metadataObject(input.metadata),aliases=names(input.aliases,'alias',20);
  const consent=selection(input.consent??'unknown',consentStates,'consent');const evidence=input.consentEvidence?text(input.consentEvidence,'consent_evidence',1000):null;
  if(consent!=='unknown'&&!evidence)return fail('CONSENT_EVIDENCE_REQUIRED',400);
  const jurisdiction=input.jurisdiction?jurisdictionCode(input.jurisdiction):'unreviewed';
  const methods=(Array.isArray(input.methods)?input.methods:[]).slice(0,10).map(method=>{const kind=selection(method?.kind,['email','phone','url'],'method_kind');const value=kind==='email'?emailAddress(method.value):text(method.value,'method_value',320);if(kind==='phone'&&!/^\+?[0-9 ().-]{6,30}$/.test(value))return fail('INVALID_PHONE',400);if(kind==='url'&&!value.startsWith('https://'))return fail('HTTPS_URL_REQUIRED',400);return {kind,value,hash:digest(kind==='phone'?value.replace(/[^0-9+]/g,''):value)};});
  return tenant(this.client,this.ctx,async tx=>{
   const hash=digest(email);await lock(tx,`contact:${this.org}:${hash}`);
   if(input.accountId&&!rows(await tx.query('SELECT 1 FROM app.crm_accounts WHERE organization_id=$1 AND id=$2',[this.org,identifier(input.accountId)])).length)return fail('ACCOUNT_NOT_FOUND',404);
   const prior=rows(await tx.query('SELECT * FROM app.crm_contacts WHERE organization_id=$1 AND email_hash=$2',[this.org,hash]))[0];
   if(prior){
    if(prior.status!=='redacted')await tx.query('INSERT INTO app.crm_contact_sources(organization_id,contact_id,source_label,source_kind,purpose,lawful_basis,recorded_by_membership_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[this.org,prior.id,source.label,source.kind,source.purpose,source.lawfulBasis,this.ctx.membershipId]);
    await event(tx,this.ctx,'crm.contact_source_added',prior.id,{duplicate:true});return {contact:publicContact(prior),duplicate:true};
   }
   const methodOwner=methods.length?rows(await tx.query('SELECT contact_id FROM app.crm_contact_methods WHERE organization_id=$1 AND value_hash=ANY($2::text[]) LIMIT 1',[this.org,methods.map(m=>m.hash)]))[0]:undefined;
   if(methodOwner)return fail('CONTACT_METHOD_BELONGS_TO_OTHER_CONTACT');
   const suppressed=rows(await tx.query('SELECT 1 FROM app.contact_suppressions WHERE organization_id=$1 AND email_hash=$2',[this.org,hash])).length>0||consent==='opted_out';
   const contact=rows(await tx.query(`INSERT INTO app.crm_contacts(organization_id,account_id,display_name,email,email_hash,role_title,status,consent,lawful_source,jurisdiction,consent_evidence,owner_membership_id,metadata)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb) RETURNING *`,[this.org,input.accountId??null,name,email,hash,input.role?text(input.role,'role',160):null,suppressed?'suppressed':'active',suppressed?'opted_out':consent,source.label,jurisdiction,evidence,input.ownerMembershipId?identifier(input.ownerMembershipId):this.ctx.membershipId,JSON.stringify(metadata)]))[0]!;
   await tx.query("INSERT INTO app.crm_contact_methods(organization_id,contact_id,kind,value,value_hash,is_primary) VALUES($1,$2,'email',$3,$4,true)",[this.org,contact.id,email,hash]);
   for(const method of methods)if(method.hash!==hash)await tx.query('INSERT INTO app.crm_contact_methods(organization_id,contact_id,kind,value,value_hash) VALUES($1,$2,$3,$4,$5)',[this.org,contact.id,method.kind,method.value,method.hash]);
   for(const alias of aliases)await tx.query('INSERT INTO app.crm_aliases(organization_id,contact_id,alias,normalized) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[this.org,contact.id,alias,normalizePerson(alias)]);
   await tx.query('INSERT INTO app.crm_contact_sources(organization_id,contact_id,source_label,source_kind,purpose,lawful_basis,recorded_by_membership_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[this.org,contact.id,source.label,source.kind,source.purpose,source.lawfulBasis,this.ctx.membershipId]);
   if(evidence)await tx.query("INSERT INTO app.crm_consent_evidence(organization_id,contact_id,consent,evidence_ref,jurisdiction,source,recorded_by_membership_id) VALUES($1,$2,$3,$4,$5,'owner',$6)",[this.org,contact.id,consent,evidence,jurisdiction,this.ctx.membershipId]);
   if(suppressed)await tx.query("INSERT INTO app.contact_suppressions(organization_id,email_hash,reason,source) VALUES($1,$2,'OPTED_OUT','owner') ON CONFLICT DO NOTHING",[this.org,hash]);
   const candidates=await this.detectInTransaction(tx,[String(contact.id)]);
   await event(tx,this.ctx,'crm.contact_created',contact.id,{consent:contact.consent,sourceKind:source.kind,purpose:source.purpose,mergeCandidates:candidates});
   return {contact:publicContact(contact),duplicate:false,mergeCandidates:candidates};
  });
 }
 async updateContact(input:{id:string;version:number;ownerMembershipId?:string|null;metadata?:Record<string,string>;role?:string;accountId?:string|null}){
  identifier(input.id);if(!Number.isSafeInteger(input.version))return fail('INVALID_VERSION',400);
  const metadata=input.metadata===undefined?undefined:metadataObject(input.metadata);
  return tenant(this.client,this.ctx,async tx=>{
   const saved=rows(await tx.query(`UPDATE app.crm_contacts SET owner_membership_id=CASE WHEN $4::boolean THEN $5::uuid ELSE owner_membership_id END,
     metadata=COALESCE($6::jsonb,metadata),role_title=COALESCE($7,role_title),account_id=CASE WHEN $8::boolean THEN $9::uuid ELSE account_id END,version=version+1,updated_at=app.utc_now()
     WHERE organization_id=$1 AND id=$2 AND version=$3 AND status NOT IN ('redacted','merged') RETURNING *`,
    [this.org,input.id,input.version,input.ownerMembershipId!==undefined,input.ownerMembershipId?identifier(input.ownerMembershipId):null,metadata?JSON.stringify(metadata):null,input.role?text(input.role,'role',160):null,input.accountId!==undefined,input.accountId?identifier(input.accountId):null]))[0];
   if(!saved)return fail('STALE_RECORD');await event(tx,this.ctx,'crm.contact_updated',input.id);return publicContact(saved);
  });
 }
 /** Keyset-paginated, index-backed search. Never returns raw email addresses. */
 async searchContacts(input:{q?:string;accountId?:string;cursor?:string;limit?:number;includeMerged?:boolean}={}){
  const limit=Math.max(1,Math.min(50,Number.isSafeInteger(input.limit)?Number(input.limit):25));
  const raw=typeof input.q==='string'?input.q.trim().slice(0,120):'';
  const after=input.cursor?decodeCursor(input.cursor):null;
  return tenant(this.client,this.ctx,async tx=>{
   const values:unknown[]=[this.org];const add=(value:unknown)=>{values.push(value);return `$${values.length}`;};
   const where:string[]=['c.organization_id=$1'];
   if(!input.includeMerged)where.push("c.status<>'merged'");
   if(input.accountId)where.push(`c.account_id=${add(identifier(input.accountId))}`);
   let aliasHits:Row[]=[];
   if(raw.includes('@')){const email=emailAddress(raw);where.push(`(c.email_hash=${add(digest(email))} OR c.id IN (SELECT contact_id FROM app.crm_contact_methods WHERE organization_id=$1 AND value_hash=${add(digest(email))}))`);}
   else if(raw.includes('.')&&!raw.includes(' ')){where.push(`c.email_domain=${add(normalizeDomain(raw))}`);}
   else if(raw){const prefix=normalizePerson(raw);if(prefix){where.push(`(c.normalized_name COLLATE "C")>=${add(prefix)} AND (c.normalized_name COLLATE "C")<${add(`${prefix}{`)}`);
    if(!after)aliasHits=rows(await tx.query(`SELECT c.* FROM app.crm_aliases l JOIN app.crm_contacts c ON c.organization_id=l.organization_id AND c.id=l.contact_id WHERE l.organization_id=$1 AND l.normalized LIKE $2 AND c.status<>'merged' LIMIT 10`,[this.org,`${prefix}%`]));}}
   if(after)where.push(`((c.normalized_name COLLATE "C"),c.id)>(${add(after.name)},${add(after.id)}::uuid)`);
   const found=rows(await tx.query(`SELECT c.* FROM app.crm_contacts c WHERE ${where.join(' AND ')} ORDER BY (c.normalized_name COLLATE "C"),c.id LIMIT ${limit+1}`,values));
   const page=found.slice(0,limit);const last=page[page.length-1];
   const seen=new Set(page.map(row=>String(row.id)));const extra=aliasHits.filter(row=>!seen.has(String(row.id)));
   return {items:[...page,...extra].map(publicContact),nextCursor:found.length>limit&&last?encodeCursor(String(last.normalized_name),String(last.id)):null,limit};
  });
 }
 async accountMap(input:{limit?:number;contactsPerAccount?:number}={}){
  const limit=Math.max(1,Math.min(50,input.limit??24)),perAccount=Math.max(1,Math.min(12,input.contactsPerAccount??6));
  return tenant(this.client,this.ctx,async tx=>{
   const accounts=rows(await tx.query(`SELECT a.id,a.name,a.domain,a.sector,a.owner_membership_id,a.metadata,
     (SELECT count(*)::int FROM app.crm_contacts c WHERE c.organization_id=a.organization_id AND c.account_id=a.id AND c.status<>'merged') AS contact_count,
     (SELECT COALESCE(jsonb_agg(jsonb_build_object('alias',l.alias)),'[]'::jsonb) FROM (SELECT alias FROM app.crm_aliases l WHERE l.organization_id=a.organization_id AND l.account_id=a.id LIMIT 10) l) AS aliases
     FROM app.crm_accounts a WHERE a.organization_id=$1 ORDER BY a.normalized_name,a.id LIMIT $2`,[this.org,limit]));
   for(const account of accounts)account.contacts=rows(await tx.query("SELECT * FROM app.crm_contacts WHERE organization_id=$1 AND account_id=$2 AND status<>'merged' ORDER BY (normalized_name COLLATE \"C\"),id LIMIT $3",[this.org,account.id,perAccount])).map(publicContact);
   const unassigned=rows(await tx.query("SELECT count(*)::int AS n FROM app.crm_contacts WHERE organization_id=$1 AND account_id IS NULL AND status<>'merged'",[this.org]))[0]!.n;
   return {accounts,unassignedContacts:unassigned};
  });
 }

 // ===== DOTS-071 lawful import staging =====
 async stageImport(input:{source:SourceInput;rows:ImportRowInput[]}){
  const raw=(input.source&&typeof input.source==='object'?input.source:{}) as Record<string,unknown>;
  const label=text(raw.label,'source',500),kind=selection(raw.kind,sourceKinds,'source_kind'),purpose=selection(raw.purpose,purposes,'purpose'),basis=selection(raw.lawfulBasis,lawfulBases,'lawful_basis');
  if(!Array.isArray(input.rows)||input.rows.length<1||input.rows.length>1000)return fail('IMPORT_LIMIT_1000',400);
  return tenant(this.client,this.ctx,async tx=>{
   const batch=rows(await tx.query('INSERT INTO app.crm_import_batches(organization_id,source_label,source_kind,purpose,lawful_basis,created_by_membership_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[this.org,label,kind,purpose,basis,this.ctx.membershipId]))[0]!;
   const blockedRegions=new Set(rows(await tx.query('SELECT jurisdiction FROM app.crm_region_policies WHERE organization_id=$1 AND NOT allowed',[this.org])).map(row=>String(row.jurisdiction)));
   const seen=new Set<string>();const counts={valid:0,quarantined:0,duplicate:0,suppressed:0};const reasonCounts:Record<string,number>={};
   let index=0;
   for(const row of input.rows){
    index++;const reasons:string[]=[];const item=(row&&typeof row==='object'?row:{}) as ImportRowInput;
    const name=typeof item.name==='string'&&item.name.trim()&&item.name.trim().length<=160?item.name.trim():null;if(!name)reasons.push('MISSING_NAME');
    let email:string|null=null;try{email=emailAddress(item.email);}catch{reasons.push('INVALID_EMAIL');}
    if((prohibitedSourceKinds as readonly string[]).includes(kind))reasons.push('PROHIBITED_SOURCE');
    if(basis==='none')reasons.push('NO_LAWFUL_BASIS');
    const consent=typeof item.consent==='string'&&item.consent?item.consent:'unknown';
    if(!(consentStates as readonly string[]).includes(consent))reasons.push('INVALID_CONSENT');
    const evidence=typeof item.consentEvidence==='string'&&item.consentEvidence.trim()?item.consentEvidence.trim().slice(0,1000):null;
    if(consent!=='unknown'&&consent!=='opted_out'&&!evidence)reasons.push('CONSENT_EVIDENCE_REQUIRED');
    if(basis==='consent'&&consent!=='opted_in')reasons.push('CONSENT_BASIS_WITHOUT_OPT_IN');
    const jurisdiction=typeof item.jurisdiction==='string'&&item.jurisdiction.trim()?item.jurisdiction.trim().toUpperCase().slice(0,40):'unreviewed';
    if(blockedRegions.has(jurisdiction))reasons.push('REGION_NOT_ALLOWED');
    let domain:string|null=null;try{domain=normalizeDomain(item.domain);}catch{reasons.push('INVALID_DOMAIN');}
    const account=typeof item.account==='string'&&item.account.trim()?item.account.trim().slice(0,160):null;
    const hash=email?digest(email):null;let status='valid';let match:string|null=null;
    if(reasons.length)status='quarantined';
    else if(hash&&seen.has(hash)){status='duplicate';reasons.push('DUPLICATE_IN_BATCH');}
    else if(hash){
     seen.add(hash);
     if(rows(await tx.query('SELECT 1 FROM app.contact_suppressions WHERE organization_id=$1 AND email_hash=$2',[this.org,hash])).length||consent==='opted_out'){status='suppressed';reasons.push('SUPPRESSED');}
     else{const existing=rows(await tx.query("SELECT id,COALESCE(merged_into_id,id) AS survivor FROM app.crm_contacts WHERE organization_id=$1 AND (email_hash=$2 OR id IN (SELECT contact_id FROM app.crm_contact_methods WHERE organization_id=$1 AND value_hash=$2)) AND status<>'redacted' LIMIT 1",[this.org,hash]))[0];if(existing){status='duplicate';match=String(existing.survivor);reasons.push('EXISTING_CONTACT');}}
    }
    if(status==='valid')counts.valid++;else if(status==='quarantined')counts.quarantined++;else if(status==='duplicate')counts.duplicate++;else counts.suppressed++;
    for(const reason of reasons)reasonCounts[reason]=(reasonCounts[reason]??0)+1;
    await tx.query('INSERT INTO app.crm_import_rows(organization_id,batch_id,row_number,display_name,email,email_hash,account_name,domain,jurisdiction,consent,consent_evidence,status,reasons,match_contact_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::text[],$14)',
     [this.org,batch.id,index,name,status==='quarantined'?null:email,hash,account,domain,jurisdiction,(consentStates as readonly string[]).includes(consent)?consent:'unknown',evidence,status,reasons,match]);
   }
   await tx.query('UPDATE app.crm_import_batches SET total_rows=$3,valid_rows=$4,quarantined_rows=$5,duplicate_rows=$6 WHERE organization_id=$1 AND id=$2',[this.org,batch.id,index,counts.valid,counts.quarantined,counts.duplicate+counts.suppressed]);
   await event(tx,this.ctx,'crm.import_staged',batch.id,{total:index,...counts,sourceKind:kind,purpose});
   return {batchId:String(batch.id),state:'staged',total:index,...counts,reasons:reasonCounts,outreachQueued:0};
  });
 }
 async previewImport(batchId:string,input:{offset?:number;limit?:number}={}){
  identifier(batchId);const limit=Math.max(1,Math.min(100,input.limit??25)),offset=Math.max(0,Math.min(100000,input.offset??0));
  return tenant(this.client,this.ctx,async tx=>{
   const batch=rows(await tx.query('SELECT * FROM app.crm_import_batches WHERE organization_id=$1 AND id=$2',[this.org,batchId]))[0];if(!batch)return fail('NOT_FOUND',404);
   const items=rows(await tx.query('SELECT row_number,display_name,email,account_name,domain,jurisdiction,consent,status,reasons,match_contact_id,created_contact_id FROM app.crm_import_rows WHERE organization_id=$1 AND batch_id=$2 ORDER BY row_number LIMIT $3 OFFSET $4',[this.org,batchId,limit,offset]))
    .map(({email,...row})=>({...row,email_masked:maskEmail(email)}));
   return {batch,items};
  });
 }
 /** Commits only valid rows. Creates contacts and provenance; never creates conversations, messages, tasks or audiences. */
 async commitImport(batchId:string,accountId?:string){
  identifier(batchId);
  return tenant(this.client,this.ctx,async tx=>{
   const batch=rows(await tx.query('SELECT * FROM app.crm_import_batches WHERE organization_id=$1 AND id=$2 FOR UPDATE',[this.org,batchId]))[0];if(!batch)return fail('NOT_FOUND',404);
   if(batch.state!=='staged')return fail('IMPORT_NOT_STAGED');
   if((prohibitedSourceKinds as readonly string[]).includes(batch.source_kind)||batch.lawful_basis==='none')return fail('PROHIBITED_SOURCE',403);
   if(accountId&&!rows(await tx.query('SELECT 1 FROM app.crm_accounts WHERE organization_id=$1 AND id=$2',[this.org,identifier(accountId)])).length)return fail('ACCOUNT_NOT_FOUND',404);
   let created=0,sourcesAdded=0,skipped=0;const createdIds:string[]=[];
   const pending=rows(await tx.query("SELECT * FROM app.crm_import_rows WHERE organization_id=$1 AND batch_id=$2 AND status IN ('valid','duplicate') ORDER BY row_number",[this.org,batchId]));
   for(const row of pending){
    if(row.status==='duplicate'){
     if(row.match_contact_id){await tx.query('INSERT INTO app.crm_contact_sources(organization_id,contact_id,batch_id,source_label,source_kind,purpose,lawful_basis,recorded_by_membership_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[this.org,row.match_contact_id,batchId,batch.source_label,batch.source_kind,batch.purpose,batch.lawful_basis,this.ctx.membershipId]);sourcesAdded++;
      await tx.query("UPDATE app.crm_import_rows SET status='merged_source',email=NULL WHERE organization_id=$1 AND id=$2",[this.org,row.id]);}
     else{skipped++;await tx.query('UPDATE app.crm_import_rows SET email=NULL WHERE organization_id=$1 AND id=$2',[this.org,row.id]);}
     continue;
    }
    await lock(tx,`contact:${this.org}:${row.email_hash}`);
    const raced=rows(await tx.query('SELECT 1 FROM app.contact_suppressions WHERE organization_id=$1 AND email_hash=$2 UNION ALL SELECT 1 FROM app.crm_contacts WHERE organization_id=$1 AND email_hash=$2',[this.org,row.email_hash])).length>0;
    if(raced){skipped++;await tx.query("UPDATE app.crm_import_rows SET status='duplicate',reasons=array_append(reasons,'CHANGED_SINCE_PREVIEW'),email=NULL WHERE organization_id=$1 AND id=$2",[this.org,row.id]);continue;}
    let rowAccount=accountId??null;
    if(!rowAccount&&row.account_name){
     const normalized=normalizeOrganization(String(row.account_name));
     const existing=normalized?rows(await tx.query('SELECT id FROM app.crm_accounts WHERE organization_id=$1 AND (normalized_name=$2 OR ($3::text IS NOT NULL AND domain=$3)) ORDER BY created_at LIMIT 2',[this.org,normalized,row.domain]))[0]:undefined;
     rowAccount=existing?String(existing.id):String(rows(await tx.query('INSERT INTO app.crm_accounts(organization_id,name,domain,owner_membership_id) VALUES($1,$2,$3,$4) RETURNING id',[this.org,row.account_name,row.domain,this.ctx.membershipId]))[0]!.id);
    }
    const consent=row.consent_evidence?row.consent:'unknown';
    const contact=rows(await tx.query(`INSERT INTO app.crm_contacts(organization_id,account_id,display_name,email,email_hash,status,consent,lawful_source,jurisdiction,consent_evidence,owner_membership_id)
      VALUES($1,$2,$3,$4,$5,'active',$6,$7,$8,$9,$10) RETURNING id`,[this.org,rowAccount,row.display_name,row.email,row.email_hash,consent,batch.source_label,row.jurisdiction,row.consent_evidence,this.ctx.membershipId]))[0]!;
    await tx.query("INSERT INTO app.crm_contact_methods(organization_id,contact_id,kind,value,value_hash,is_primary) VALUES($1,$2,'email',$3,$4,true) ON CONFLICT DO NOTHING",[this.org,contact.id,row.email,row.email_hash]);
    await tx.query('INSERT INTO app.crm_contact_sources(organization_id,contact_id,batch_id,source_label,source_kind,purpose,lawful_basis,recorded_by_membership_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[this.org,contact.id,batchId,batch.source_label,batch.source_kind,batch.purpose,batch.lawful_basis,this.ctx.membershipId]);
    if(row.consent_evidence)await tx.query("INSERT INTO app.crm_consent_evidence(organization_id,contact_id,consent,evidence_ref,jurisdiction,source,recorded_by_membership_id) VALUES($1,$2,$3,$4,$5,'import',$6)",[this.org,contact.id,consent,row.consent_evidence,row.jurisdiction,this.ctx.membershipId]);
    await tx.query("UPDATE app.crm_import_rows SET status='committed',created_contact_id=$3,email=NULL WHERE organization_id=$1 AND id=$2",[this.org,row.id,contact.id]);
    created++;createdIds.push(String(contact.id));
   }
   await tx.query("UPDATE app.crm_import_rows SET email=NULL WHERE organization_id=$1 AND batch_id=$2 AND status IN ('quarantined','suppressed')",[this.org,batchId]);
   await tx.query("UPDATE app.crm_import_batches SET state='committed',committed_at=app.utc_now(),version=version+1 WHERE organization_id=$1 AND id=$2",[this.org,batchId]);
   const candidates=createdIds.length?await this.detectInTransaction(tx,createdIds):0;
   await event(tx,this.ctx,'crm.import_committed',batchId,{created,sourcesAdded,skipped,quarantined:Number(batch.quarantined_rows),candidates});
   return {batchId,created,sourcesAdded,skipped,quarantined:Number(batch.quarantined_rows),mergeCandidates:candidates,outreachQueued:0};
  });
 }
 async discardImport(batchId:string){identifier(batchId);return tenant(this.client,this.ctx,async tx=>{
  const saved=rows(await tx.query("UPDATE app.crm_import_batches SET state='discarded',version=version+1 WHERE organization_id=$1 AND id=$2 AND state='staged' RETURNING id",[this.org,batchId]));if(!saved.length)return fail('IMPORT_NOT_STAGED');
  await tx.query('UPDATE app.crm_import_rows SET email=NULL,display_name=NULL,consent_evidence=NULL WHERE organization_id=$1 AND batch_id=$2',[this.org,batchId]);
  await event(tx,this.ctx,'crm.import_discarded',batchId);return {discarded:true};
 });}

 // ===== DOTS-072 dedupe and identity resolution =====
 private async detectInTransaction(tx:Client,contactIds?:string[]):Promise<number>{
  const scope=contactIds?'AND (a.id=ANY($2::uuid[]) OR b.id=ANY($2::uuid[]))':'';
  const values=contactIds?[this.org,contactIds]:[this.org];
  const free=[...freeMailDomains];values.push(free);const freeParam=`$${values.length}`;
  const inserted=rows(await tx.query(`INSERT INTO app.crm_merge_candidates(organization_id,primary_contact_id,duplicate_contact_id,score,reasons)
   SELECT organization_id,primary_id,duplicate_id,score,reasons FROM (
    SELECT a.organization_id,a.id AS primary_id,b.id AS duplicate_id,
     CASE WHEN a.email_domain=b.email_domain AND NOT (a.email_domain=ANY(${freeParam}::text[])) THEN 90
          WHEN a.account_id IS NOT NULL AND a.account_id=b.account_id THEN 80
          WHEN acc_a.normalized_name IS NOT NULL AND acc_a.normalized_name=acc_b.normalized_name THEN 70 ELSE 40 END AS score,
     ARRAY_REMOVE(ARRAY['SAME_NORMALIZED_NAME',
      CASE WHEN a.email_domain=b.email_domain AND NOT (a.email_domain=ANY(${freeParam}::text[])) THEN 'SAME_EMAIL_DOMAIN' END,
      CASE WHEN a.account_id IS NOT NULL AND a.account_id=b.account_id THEN 'SAME_ACCOUNT' END,
      CASE WHEN acc_a.normalized_name IS NOT NULL AND acc_a.normalized_name=acc_b.normalized_name AND a.account_id<>b.account_id THEN 'SIMILAR_ACCOUNT_NAME' END],NULL) AS reasons
    FROM app.crm_contacts a JOIN app.crm_contacts b ON b.organization_id=a.organization_id AND (b.normalized_name COLLATE "C")=(a.normalized_name COLLATE "C") AND b.id>a.id
    LEFT JOIN app.crm_accounts acc_a ON acc_a.organization_id=a.organization_id AND acc_a.id=a.account_id
    LEFT JOIN app.crm_accounts acc_b ON acc_b.organization_id=b.organization_id AND acc_b.id=b.account_id
    WHERE a.organization_id=$1 AND a.status IN ('active','suppressed','archived') AND b.status IN ('active','suppressed','archived') AND length(a.normalized_name)>=4 ${scope}
   ) pairs WHERE score>=70 LIMIT 5000
   ON CONFLICT DO NOTHING RETURNING id`,values));
  return inserted.length;
 }
 async detectDuplicates(contactIds?:string[]){
  if(contactIds!==undefined){if(!Array.isArray(contactIds)||contactIds.length>1000)return fail('INVALID_CONTACT_IDS',400);contactIds.forEach(identifier);}
  return tenant(this.client,this.ctx,async tx=>{const created=await this.detectInTransaction(tx,contactIds);await event(tx,this.ctx,'crm.duplicates_detected',null,{candidates:created});return {candidates:created};});
 }
 async listCandidates(limit=25){return tenant(this.client,this.ctx,async tx=>rows(await tx.query(`SELECT m.*,a.display_name AS primary_name,a.account_id AS primary_account_id,a.email AS primary_email,b.display_name AS duplicate_name,b.account_id AS duplicate_account_id,b.email AS duplicate_email
  FROM app.crm_merge_candidates m JOIN app.crm_contacts a ON a.organization_id=m.organization_id AND a.id=m.primary_contact_id JOIN app.crm_contacts b ON b.organization_id=m.organization_id AND b.id=m.duplicate_contact_id
  WHERE m.organization_id=$1 AND m.state='open' ORDER BY m.score DESC,m.created_at LIMIT $2`,[this.org,Math.max(1,Math.min(100,limit))])).map(({primary_email,duplicate_email,...row})=>({...row,primary_email_masked:maskEmail(primary_email),duplicate_email_masked:maskEmail(duplicate_email)})));}
 /** Owner-reviewed merge. The duplicate keeps its own rows, conversations and sources; a merge record links it to the survivor. */
 async mergeContacts(input:{survivorId:string;duplicateId:string;candidateId?:string;confirmCrossAccount?:boolean}){
  identifier(input.survivorId);identifier(input.duplicateId);if(input.candidateId)identifier(input.candidateId);
  if(input.survivorId===input.duplicateId)return fail('MERGE_REQUIRES_TWO_CONTACTS',400);
  return tenant(this.client,this.ctx,async tx=>{
   const [first,second]=[input.survivorId,input.duplicateId].sort();
   await lock(tx,`contact-merge:${this.org}:${first}`);await lock(tx,`contact-merge:${this.org}:${second}`);
   const found=rows(await tx.query('SELECT * FROM app.crm_contacts WHERE organization_id=$1 AND id=ANY($2::uuid[]) FOR UPDATE',[this.org,[input.survivorId,input.duplicateId]]));
   const survivor=found.find(row=>String(row.id)===input.survivorId),duplicate=found.find(row=>String(row.id)===input.duplicateId);
   if(!survivor||!duplicate)return fail('NOT_FOUND',404);
   if([survivor.status,duplicate.status].includes('merged'))return fail('CONTACT_ALREADY_MERGED');
   if([survivor.status,duplicate.status].includes('redacted'))return fail('REDACTED_CONTACT_CANNOT_MERGE');
   const crossAccount=Boolean(survivor.account_id&&duplicate.account_id&&String(survivor.account_id)!==String(duplicate.account_id));
   if(crossAccount&&input.confirmCrossAccount!==true)return fail('CROSS_ACCOUNT_MERGE_REQUIRES_CONFIRMATION');
   const candidate=input.candidateId?rows(await tx.query("SELECT * FROM app.crm_merge_candidates WHERE organization_id=$1 AND id=$2 AND state='open' FOR UPDATE",[this.org,input.candidateId]))[0]:null;
   if(input.candidateId&&(!candidate||![String(candidate.primary_contact_id),String(candidate.duplicate_contact_id)].sort().every((id,i)=>id===[input.survivorId,input.duplicateId].sort()[i])))return fail('CANDIDATE_MISMATCH');
   const snapshot={id:duplicate.id,account_id:duplicate.account_id,email_hash:duplicate.email_hash,status:duplicate.status,consent:duplicate.consent,jurisdiction:duplicate.jurisdiction,lawful_source_hash:digest(duplicate.lawful_source),owner_agent_id:duplicate.owner_agent_id,version:duplicate.version};
   await tx.query("UPDATE app.crm_contacts SET merged_into_id=$3,version=version+1,updated_at=app.utc_now() WHERE organization_id=$1 AND merged_into_id=$2",[this.org,duplicate.id,survivor.id]);
   await tx.query("UPDATE app.crm_contacts SET status='merged',merged_into_id=$3,version=version+1,updated_at=app.utc_now() WHERE organization_id=$1 AND id=$2",[this.org,duplicate.id,survivor.id]);
   // The more restrictive consent state wins: a suppressed duplicate suppresses the survivor everywhere.
   if(duplicate.status==='suppressed'||duplicate.consent==='opted_out')await tx.query("UPDATE app.crm_contacts SET status='suppressed',consent='opted_out',version=version+1 WHERE organization_id=$1 AND id=$2",[this.org,survivor.id]);
   const policy=await contactPolicy(tx,this.org);
   await tx.query("UPDATE app.crm_prospect_claims SET state='released',released_at=app.utc_now(),exclusive_until=app.utc_now()+make_interval(days=>$3::int),release_reason='CONTACT_MERGED' WHERE organization_id=$1 AND contact_id=$2 AND state='active'",[this.org,duplicate.id,Number(policy.exclusion_days)]);
   const merge=rows(await tx.query('INSERT INTO app.crm_merges(organization_id,survivor_contact_id,merged_contact_id,candidate_id,merged_snapshot,cross_account,decided_by_membership_id) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7) RETURNING *',[this.org,survivor.id,duplicate.id,candidate?.id??null,JSON.stringify(snapshot),crossAccount,this.ctx.membershipId]))[0]!;
   if(candidate)await tx.query("UPDATE app.crm_merge_candidates SET state='merged',decided_by_membership_id=$3,decided_at=app.utc_now() WHERE organization_id=$1 AND id=$2",[this.org,candidate.id,this.ctx.membershipId]);
   await tx.query("UPDATE app.crm_merge_candidates SET state='dismissed',decided_by_membership_id=$3,decided_at=app.utc_now() WHERE organization_id=$1 AND state='open' AND (primary_contact_id=$2 OR duplicate_contact_id=$2)",[this.org,duplicate.id,this.ctx.membershipId]);
   await event(tx,this.ctx,'crm.contacts_merged',merge.id,{survivorId:survivor.id,mergedId:duplicate.id,crossAccount});
   return merge;
  });
 }
 async dismissCandidate(id:string){identifier(id);return tenant(this.client,this.ctx,async tx=>{const saved=rows(await tx.query("UPDATE app.crm_merge_candidates SET state='dismissed',decided_by_membership_id=$3,decided_at=app.utc_now() WHERE organization_id=$1 AND id=$2 AND state='open' RETURNING id",[this.org,id,this.ctx.membershipId]));if(!saved.length)return fail('NOT_FOUND',404);await event(tx,this.ctx,'crm.merge_dismissed',id);return {dismissed:true};});}

 // ===== DOTS-073 universal do-not-contact =====
 async setRegionPolicy(input:{jurisdiction:string;allowed:boolean;requiresOptIn:boolean;legalReviewRef:string}){
  const jurisdiction=text(input.jurisdiction,'jurisdiction',6).toUpperCase();if(!/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/.test(jurisdiction))return fail('INVALID_JURISDICTION',400);
  const ref=text(input.legalReviewRef,'legal_review_ref',240);
  return tenant(this.client,this.ctx,async tx=>{
   const saved=rows(await tx.query(`INSERT INTO app.crm_region_policies(organization_id,jurisdiction,allowed,requires_opt_in,legal_review_ref,updated_by_membership_id) VALUES($1,$2,$3,$4,$5,$6)
    ON CONFLICT(organization_id,jurisdiction) DO UPDATE SET allowed=$3,requires_opt_in=$4,legal_review_ref=$5,updated_by_membership_id=$6,version=app.crm_region_policies.version+1,updated_at=app.utc_now() RETURNING *`,[this.org,jurisdiction,input.allowed===true,input.requiresOptIn!==false,ref,this.ctx.membershipId]))[0]!;
   await event(tx,this.ctx,'crm.region_policy_set',null,{jurisdiction,allowed:saved.allowed,requiresOptIn:saved.requires_opt_in});return saved;
  });
 }
 async setContactPolicy(input:{maxTouches:number;windowDays:number;exclusionDays:number}){
  for(const [value,min,max] of [[input.maxTouches,1,20],[input.windowDays,1,365],[input.exclusionDays,0,365]] as const)if(!Number.isSafeInteger(value)||value<min||value>max)return fail('INVALID_CONTACT_POLICY',400);
  return tenant(this.client,this.ctx,async tx=>{
   const saved=rows(await tx.query(`INSERT INTO app.crm_contact_policies(organization_id,max_touches,window_days,exclusion_days,updated_by_membership_id) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(organization_id) DO UPDATE SET max_touches=$2,window_days=$3,exclusion_days=$4,updated_by_membership_id=$5,version=app.crm_contact_policies.version+1,updated_at=app.utc_now() RETURNING *`,[this.org,input.maxTouches,input.windowDays,input.exclusionDays,this.ctx.membershipId]))[0]!;
   await event(tx,this.ctx,'crm.contact_policy_set',null,{maxTouches:input.maxTouches,windowDays:input.windowDays,exclusionDays:input.exclusionDays});return saved;
  });
 }
 async recordConsent(input:{contactId:string;consent:string;evidenceRef:string;jurisdiction:string}){
  identifier(input.contactId);const consent=selection(input.consent,consentStates,'consent'),evidence=text(input.evidenceRef,'evidence',1000),jurisdiction=jurisdictionCode(input.jurisdiction);
  if(consent==='opted_out')return this.suppress({contactId:input.contactId,reason:'OPTED_OUT',source:'owner'});
  return tenant(this.client,this.ctx,async tx=>{
   const found=await cluster(tx,this.org,input.contactId);if(!found||found.contact.status==='redacted')return fail('NOT_FOUND',404);
   if(found.contact.status==='merged')return fail('CONTACT_MERGED');
   if(found.contact.status==='suppressed'||rows(await tx.query('SELECT 1 FROM app.contact_suppressions WHERE organization_id=$1 AND email_hash=ANY($2::text[])',[this.org,found.hashes])).length)return fail('SUPPRESSED_CONTACT_REQUIRES_LAWFUL_OVERRIDE',403);
   await tx.query("INSERT INTO app.crm_consent_evidence(organization_id,contact_id,consent,evidence_ref,jurisdiction,source,recorded_by_membership_id) VALUES($1,$2,$3,$4,$5,'owner',$6)",[this.org,input.contactId,consent,evidence,jurisdiction,this.ctx.membershipId]);
   const saved=rows(await tx.query('UPDATE app.crm_contacts SET consent=$3,consent_evidence=$4,jurisdiction=$5,version=version+1,updated_at=app.utc_now() WHERE organization_id=$1 AND id=$2 RETURNING *',[this.org,input.contactId,consent,evidence,jurisdiction]))[0]!;
   await event(tx,this.ctx,'crm.consent_recorded',input.contactId,{consent,jurisdiction});return publicContact(saved);
  });
 }
 /** Universal suppression by contact (all cluster addresses) or by a raw address that is not yet a contact. */
 async suppress(input:{contactId?:string;email?:string;reason?:string;source?:string}){
  const reason=text(input.reason??'OWNER_REQUEST','reason',120),source=selection(input.source??'owner',['owner','unsubscribe','complaint','bounce','privacy'],'suppression_source');
  return tenant(this.client,this.ctx,async tx=>{
   let hashes:string[];let ids:string[]=[];
   if(input.contactId){const found=await cluster(tx,this.org,identifier(input.contactId));if(!found)return fail('NOT_FOUND',404);hashes=found.hashes;ids=found.ids;}
   else hashes=[digest(emailAddress(input.email))];
   for(const hash of hashes){
    await tx.query('INSERT INTO app.contact_suppressions(organization_id,email_hash,reason,source) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[this.org,hash,reason,source]);
    await tx.query("INSERT INTO app.crm_suppression_history(organization_id,email_hash,action,reason,source,actor_membership_id) VALUES($1,$2,'suppressed',$3,$4,$5)",[this.org,hash,reason,source,this.ctx.membershipId]);
   }
   await tx.query("UPDATE app.crm_contacts SET status=CASE WHEN status IN ('active','archived') THEN 'suppressed' ELSE status END,consent='opted_out',version=version+1,updated_at=app.utc_now() WHERE organization_id=$1 AND (email_hash=ANY($2::text[]) OR id=ANY($3::uuid[])) AND status<>'redacted'",[this.org,hashes,ids]);
   await tx.query("UPDATE app.crm_prospect_claims SET state='released',released_at=app.utc_now(),release_reason='SUPPRESSED' WHERE organization_id=$1 AND contact_id=ANY($2::uuid[]) AND state='active'",[this.org,ids]);
   await event(tx,this.ctx,'crm.contact_suppressed',input.contactId??null,{reasonCode:reason,source,addresses:hashes.length});
   return {suppressed:hashes.length};
  });
 }
 /** The only way to lift a suppression. Requires a lawful basis and an audit reference; privacy erasures cannot be lifted. */
 async overrideSuppression(input:{contactId:string;lawfulBasis:string;auditRef:string;consentEvidence?:string;jurisdiction?:string}){
  identifier(input.contactId);const basis=selection(input.lawfulBasis,['documented_new_opt_in','owner_entry_error'],'lawful_basis');
  const audit=typeof input.auditRef==='string'?input.auditRef.trim():'';if(audit.length<3||audit.length>240)return fail('LAWFUL_AUDIT_REQUIRED',403);
  const evidence=input.consentEvidence?text(input.consentEvidence,'consent_evidence',1000):null;if(basis==='documented_new_opt_in'&&!evidence)return fail('CONSENT_EVIDENCE_REQUIRED',400);
  return tenant(this.client,this.ctx,async tx=>{
   const found=await cluster(tx,this.org,input.contactId);if(!found)return fail('NOT_FOUND',404);
   const contact=found.contact;if(contact.status==='redacted')return fail('PRIVACY_ERASURE_CANNOT_BE_OVERRIDDEN',403);if(contact.status==='merged')return fail('CONTACT_MERGED');
   const active=rows(await tx.query('SELECT email_hash,source FROM app.contact_suppressions WHERE organization_id=$1 AND email_hash=ANY($2::text[])',[this.org,found.hashes]));
   if(active.some(row=>row.source==='privacy'))return fail('PRIVACY_ERASURE_CANNOT_BE_OVERRIDDEN',403);
   if(basis!=='documented_new_opt_in'&&active.some(row=>['complaint','unsubscribe'].includes(row.source)))return fail('OPT_OUT_REQUIRES_NEW_OPT_IN',403);
   for(const row of active){
    const history=rows(await tx.query("INSERT INTO app.crm_suppression_history(organization_id,email_hash,action,reason,source,lawful_basis,audit_ref,actor_membership_id) VALUES($1,$2,'overridden','LAWFUL_OVERRIDE',$3,$4,$5,$6) RETURNING id",[this.org,row.email_hash,row.source,basis,audit,this.ctx.membershipId]))[0]!;
    await tx.query('SELECT app.crm_lift_suppression($1,$2)',[row.email_hash,history.id]);
   }
   const consent=basis==='documented_new_opt_in'?'opted_in':'unknown';const jurisdiction=input.jurisdiction?jurisdictionCode(input.jurisdiction):String(contact.jurisdiction);
   await tx.query("UPDATE app.crm_contacts SET status='active',consent=$3,consent_evidence=$4,jurisdiction=$5,version=version+1,updated_at=app.utc_now() WHERE organization_id=$1 AND id=ANY($2::uuid[]) AND status='suppressed' AND merged_into_id IS NULL",[this.org,[found.survivorId],consent,evidence,jurisdiction]);
   await tx.query("INSERT INTO app.crm_consent_evidence(organization_id,contact_id,consent,evidence_ref,jurisdiction,source,recorded_by_membership_id) VALUES($1,$2,$3,$4,$5,'override',$6)",[this.org,found.survivorId,consent,`${basis}: ${audit}`,jurisdiction,this.ctx.membershipId]);
   await event(tx,this.ctx,'crm.suppression_overridden',found.survivorId,{lawfulBasis:basis,auditRefHash:digest(audit),addresses:active.length});
   return {overridden:active.length,consent};
  });
 }
 async checkContactable(input:ContactabilityInput){return tenant(this.client,this.ctx,tx=>contactability(tx,this.ctx,input));}

 // ===== DOTS-074 prospect ownership =====
 async claimProspect(input:{contactId:string;campaignId:string;agentId:string}){
  identifier(input.contactId);identifier(input.campaignId);identifier(input.agentId);
  return tenant(this.client,this.ctx,async tx=>{
   const found=await cluster(tx,this.org,input.contactId);if(!found)return fail('NOT_FOUND',404);
   if(found.contact.status==='merged')return fail('CONTACT_MERGED');if(['redacted','archived','suppressed'].includes(found.contact.status))return fail('CONTACT_NOT_CLAIMABLE');
   const campaign=rows(await tx.query("SELECT id,project_id,state FROM app.campaigns WHERE organization_id=$1 AND id=$2",[this.org,input.campaignId]))[0];if(!campaign)return fail('CAMPAIGN_NOT_FOUND',404);
   if(['archived','completed'].includes(campaign.state))return fail('CAMPAIGN_CLOSED');
   const agent=rows(await tx.query("SELECT a.id FROM app.agent_identities a JOIN app.agent_project_assignments p ON p.organization_id=a.organization_id AND p.agent_identity_id=a.id AND p.project_id=$3 WHERE a.organization_id=$1 AND a.id=$2 AND a.status='active' LIMIT 1",[this.org,input.agentId,campaign.project_id]))[0];
   if(!agent)return fail('AGENT_NOT_ASSIGNED_TO_CAMPAIGN_PROJECT');
   await lock(tx,`prospect:${this.org}:${found.survivorId}`);
   const report=async(code:string,holder?:Row)=>{await event(tx,this.ctx,'crm.prospect_claim_conflict',found.survivorId,{code,requestedAgentId:input.agentId,campaignId:input.campaignId});return {claimed:false as const,conflict:{code,agentId:holder?.agent_identity_id??null,campaignId:holder?.campaign_id??null,until:holder?.exclusive_until??null}};};
   const active=rows(await tx.query("SELECT * FROM app.crm_prospect_claims WHERE organization_id=$1 AND contact_id=ANY($2::uuid[]) AND state='active'",[this.org,found.ids]))[0];
   if(active){
    if(String(active.agent_identity_id)===input.agentId&&String(active.campaign_id)===input.campaignId)return {claimed:true as const,claim:active,idempotent:true};
    return report(String(active.campaign_id)!==input.campaignId?'PROSPECT_IN_OTHER_CAMPAIGN':'PROSPECT_OWNED_BY_OTHER_AGENT',active);
   }
   const window=rows(await tx.query("SELECT * FROM app.crm_prospect_claims WHERE organization_id=$1 AND contact_id=ANY($2::uuid[]) AND state='released' AND exclusive_until>app.utc_now() AND agent_identity_id<>$3 ORDER BY exclusive_until DESC LIMIT 1",[this.org,found.ids,input.agentId]))[0];
   if(window)return report('PROSPECT_IN_EXCLUSION_WINDOW',window);
   try{
    await tx.query('SAVEPOINT crm_claim');
    const claim=rows(await tx.query('INSERT INTO app.crm_prospect_claims(organization_id,contact_id,campaign_id,agent_identity_id) VALUES($1,$2,$3,$4) RETURNING *',[this.org,found.survivorId,input.campaignId,input.agentId]))[0]!;
    await tx.query('RELEASE SAVEPOINT crm_claim');
    await event(tx,this.ctx,'crm.prospect_claimed',claim.id,{agentId:input.agentId,campaignId:input.campaignId});return {claimed:true as const,claim,idempotent:false};
   }catch(error){if(!isUniqueViolation(error))throw error;await tx.query('ROLLBACK TO SAVEPOINT crm_claim');return report('PROSPECT_CLAIM_CONFLICT');}
  });
 }
 async releaseClaim(id:string,reason='OWNER_RELEASE'){identifier(id);const why=text(reason,'reason',120);return tenant(this.client,this.ctx,async tx=>{
  const policy=await contactPolicy(tx,this.org);
  const saved=rows(await tx.query("UPDATE app.crm_prospect_claims SET state='released',released_at=app.utc_now(),exclusive_until=app.utc_now()+make_interval(days=>$3::int),release_reason=$4 WHERE organization_id=$1 AND id=$2 AND state='active' RETURNING *",[this.org,id,Number(policy.exclusion_days),why]))[0];
  if(!saved)return fail('NOT_FOUND',404);await event(tx,this.ctx,'crm.prospect_released',id,{reason:why});return saved;
 });}

 // ===== DOTS-075 segments =====
 async saveSegment(input:{id?:string;version?:number;label:string;filter:unknown}){
  const label=text(input.label,'segment',160),filter=validateSegmentFilter(input.filter);
  return tenant(this.client,this.ctx,async tx=>{
   const saved=input.id?rows(await tx.query('UPDATE app.crm_segments SET label=$3,filter=$4::jsonb,filter_hash=$5,version=version+1,updated_at=app.utc_now() WHERE organization_id=$1 AND id=$2 AND version=$6 RETURNING *',[this.org,identifier(input.id),label,JSON.stringify(filter),digest(filter),input.version]))[0]
    :rows(await tx.query('INSERT INTO app.crm_segments(organization_id,label,filter,filter_hash) VALUES($1,$2,$3::jsonb,$4) RETURNING *',[this.org,label,JSON.stringify(filter),digest(filter)]))[0];
   if(!saved)return fail('STALE_RECORD');await event(tx,this.ctx,'crm.segment_saved',saved.id,{filterHash:saved.filter_hash});return saved;
  });
 }
 /** Deterministic preview on stored fields only: count, exclusions with reasons and a small masked sample. No model or paid calls. */
 async previewSegment(input:{segmentId?:string;filter?:unknown}){
  return tenant(this.client,this.ctx,async tx=>{
   let filter:SegmentFilter;
   if(input.segmentId){const segment=rows(await tx.query('SELECT filter FROM app.crm_segments WHERE organization_id=$1 AND id=$2',[this.org,identifier(input.segmentId)]))[0];if(!segment)return fail('NOT_FOUND',404);filter=validateSegmentFilter(segment.filter);}
   else filter=validateSegmentFilter(input.filter??{});
   const values:unknown[]=[this.org];const where=segmentWhere(filter,values);
   const base=`WITH matched AS (SELECT c.* FROM app.crm_contacts c LEFT JOIN app.crm_accounts a ON a.organization_id=c.organization_id AND a.id=c.account_id WHERE c.organization_id=$1${where}),
    classified AS (SELECT m.id,m.display_name,m.email,m.account_id,m.normalized_name,${exclusionCase} AS reason FROM matched m LEFT JOIN app.crm_region_policies r ON r.organization_id=m.organization_id AND r.jurisdiction=m.jurisdiction)`;
   const groups=rows(await tx.query(`${base} SELECT reason,count(*)::int AS count FROM classified GROUP BY reason ORDER BY reason NULLS FIRST`,values));
   const sample=rows(await tx.query(`${base} SELECT id,display_name,email,account_id FROM classified WHERE reason IS NULL ORDER BY (normalized_name COLLATE "C"),id LIMIT 10`,values)).map(({email,...row})=>({...row,email_masked:maskEmail(email)}));
   const matched=groups.reduce((sum,row)=>sum+Number(row.count),0),eligible=Number(groups.find(row=>row.reason===null)?.count??0);
   return {filter,matched,eligible,excluded:matched-eligible,exclusions:groups.filter(row=>row.reason!==null).map(row=>({reason:String(row.reason),count:Number(row.count)})),sample,inference:'none',paidCalls:0};
  });
 }
 async materializeSegment(segmentId:string){identifier(segmentId);return tenant(this.client,this.ctx,async tx=>{
  const segment=rows(await tx.query('SELECT * FROM app.crm_segments WHERE organization_id=$1 AND id=$2 FOR UPDATE',[this.org,segmentId]))[0];if(!segment)return fail('NOT_FOUND',404);
  const values:unknown[]=[this.org];const where=segmentWhere(validateSegmentFilter(segment.filter),values);values.push(segmentId,segment.version);
  const inserted=rows(await tx.query(`INSERT INTO app.crm_segment_members(organization_id,segment_id,segment_version,contact_id)
   SELECT $1::uuid,$${values.length-1}::uuid,$${values.length}::bigint,c.id FROM app.crm_contacts c LEFT JOIN app.crm_accounts a ON a.organization_id=c.organization_id AND a.id=c.account_id
   WHERE c.organization_id=$1 AND c.status NOT IN ('merged','redacted')${where} ORDER BY c.id LIMIT 5000 ON CONFLICT DO NOTHING RETURNING contact_id`,values));
  await event(tx,this.ctx,'crm.segment_evaluated',segmentId,{members:inserted.length,version:Number(segment.version)});return {members:inserted.length,version:Number(segment.version)};
 });}

 // ===== DOTS-076 relationship timeline =====
 async addRelationshipEvent(input:{contactId:string;kind:string;summary:string;actorKind:string;actorId?:string;source:string;evidenceRef?:string}){
  identifier(input.contactId);const kind=selection(input.kind,['note','inbound','outreach','meeting','model_statement','handover'],'event_kind');
  const actorKind=selection(input.actorKind,['owner','agent','model','provider'],'actor_kind');const summary=text(input.summary,'summary',4000),source=text(input.source,'source',240);
  if(kind==='model_statement'&&actorKind!=='model')return fail('MODEL_STATEMENT_REQUIRES_MODEL_ACTOR',400);
  if(actorKind==='model'&&kind!=='model_statement')return fail('MODEL_OUTPUT_IS_UNVERIFIED',400);
  const evidence=input.evidenceRef?text(input.evidenceRef,'evidence',240):null;
  const verified=actorKind==='owner'||(actorKind!=='model'&&Boolean(evidence));
  const actorId=actorKind==='owner'?this.ctx.membershipId:text(input.actorId??actorKind,'actor',200);
  return tenant(this.client,this.ctx,async tx=>{
   const contact=rows(await tx.query("SELECT id FROM app.crm_contacts WHERE organization_id=$1 AND id=$2 AND status<>'redacted'",[this.org,input.contactId]))[0];if(!contact)return fail('NOT_FOUND',404);
   const saved=rows(await tx.query('INSERT INTO app.crm_relationship_events(organization_id,contact_id,kind,summary,actor_kind,actor_id,source,verified,evidence_ref) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',[this.org,input.contactId,kind,summary,actorKind,actorId,source,verified,evidence]))[0]!;
   await event(tx,this.ctx,'crm.relationship_event_added',saved.id,{kind,actorKind,verified});return saved;
  });
 }
 /** Unified, newest-first relationship history for a contact and every duplicate merged into it. */
 async timeline(contactId:string,limit=50){
  identifier(contactId);const bounded=Math.max(1,Math.min(200,limit));
  return tenant(this.client,this.ctx,async tx=>{
   const found=await cluster(tx,this.org,contactId);if(!found)return fail('NOT_FOUND',404);
   const items=rows(await tx.query(`SELECT * FROM (
    SELECT s.id::text AS id,'source' AS kind,s.created_at AS occurred_at,'owner' AS actor_kind,s.recorded_by_membership_id::text AS actor_id,s.source_kind||': '||s.source_label AS source,'Lead source recorded for '||s.purpose||' ('||s.lawful_basis||')' AS summary,true AS verified,s.contact_id::text AS contact_id
     FROM app.crm_contact_sources s WHERE s.organization_id=$1 AND s.contact_id=ANY($2::uuid[])
    UNION ALL SELECT e.id::text,'consent',e.created_at,CASE WHEN e.source='provider' THEN 'provider' ELSE 'owner' END,COALESCE(e.recorded_by_membership_id::text,'verified-integration'),'consent:'||e.source,'Consent '||e.consent||' in '||e.jurisdiction,true,e.contact_id::text
     FROM app.crm_consent_evidence e WHERE e.organization_id=$1 AND e.contact_id=ANY($2::uuid[])
    UNION ALL SELECT g.id::text||':'||sm.segment_version||':'||sm.contact_id::text,'segmentation',sm.evaluated_at,'owner','segment-evaluator','segment:'||g.id::text,'Included in saved segment '||g.label||' v'||sm.segment_version,true,sm.contact_id::text
     FROM app.crm_segment_members sm JOIN app.crm_segments g ON g.organization_id=sm.organization_id AND g.id=sm.segment_id WHERE sm.organization_id=$1 AND sm.contact_id=ANY($2::uuid[])
    UNION ALL SELECT m.id::text,CASE WHEN m.direction='outbound' THEN 'outreach' ELSE 'inbound' END,COALESCE(m.sent_at,m.created_at),CASE m.source WHEN 'model' THEN 'model' WHEN 'provider' THEN 'provider' WHEN 'simulation' THEN 'simulation' ELSE 'owner' END,
      COALESCE(m.provider_message_id,m.source),'message:'||m.state,m.subject,(m.source<>'model' AND m.state IN ('sent','delivered','received')),c.contact_id::text
     FROM app.messages m JOIN app.conversations c ON c.organization_id=m.organization_id AND c.id=m.conversation_id WHERE m.organization_id=$1 AND c.contact_id=ANY($2::uuid[])
    UNION ALL SELECT ce.id::text,ce.kind,ce.created_at,ce.source,ce.source,'contact_event:'||ce.source,left(ce.content,500),ce.source<>'simulation',ce.contact_id::text
     FROM app.contact_events ce WHERE ce.organization_id=$1 AND ce.contact_id=ANY($2::uuid[])
    UNION ALL SELECT r.id::text,r.kind,r.occurred_at,r.actor_kind,r.actor_id,r.source,left(r.summary,500),r.verified,r.contact_id::text
     FROM app.crm_relationship_events r WHERE r.organization_id=$1 AND r.contact_id=ANY($2::uuid[])
    UNION ALL SELECT t.id::text,'stage_transition',t.created_at,'owner',t.actor_membership_id::text,'deal:'||d.label,'Stage '||t.from_stage||' → '||t.to_stage||' ('||t.evidence_kind||')',true,NULL
     FROM app.crm_deal_transitions t JOIN app.deals d ON d.organization_id=t.organization_id AND d.id=t.deal_id
     WHERE t.organization_id=$1 AND (d.contact_id=ANY($2::uuid[]) OR EXISTS(SELECT 1 FROM app.crm_deal_contacts dc WHERE dc.organization_id=d.organization_id AND dc.deal_id=d.id AND dc.contact_id=ANY($2::uuid[])))
    UNION ALL SELECT g.id::text,'merge',g.created_at,'owner',g.decided_by_membership_id::text,'merge-review','Duplicate record merged into this contact; original sources and conversations retained',true,g.merged_contact_id::text
     FROM app.crm_merges g WHERE g.organization_id=$1 AND (g.survivor_contact_id=ANY($2::uuid[]) OR g.merged_contact_id=ANY($2::uuid[]))
    UNION ALL SELECT h.id::text,CASE WHEN h.action='suppressed' THEN 'suppression' ELSE 'suppression_override' END,h.created_at,CASE WHEN h.source IN ('bounce','complaint','unsubscribe') AND h.action='suppressed' THEN 'provider' ELSE 'owner' END,COALESCE(h.actor_membership_id::text,h.source),'suppression:'||h.source,
      CASE WHEN h.action='suppressed' THEN 'Do-not-contact: '||h.reason ELSE 'Suppression lifted under '||h.lawful_basis END,true,NULL
     FROM app.crm_suppression_history h WHERE h.organization_id=$1 AND h.email_hash=ANY($3::text[])
    UNION ALL SELECT p.id::text,'ownership',p.claimed_at,'agent',p.agent_identity_id::text,'campaign:'||p.campaign_id::text,CASE WHEN p.state='active' THEN 'Prospect claimed by agent' ELSE 'Prospect claim released: '||COALESCE(p.release_reason,'') END,true,p.contact_id::text
     FROM app.crm_prospect_claims p WHERE p.organization_id=$1 AND p.contact_id=ANY($2::uuid[])
   ) t ORDER BY occurred_at DESC,id LIMIT $4`,[this.org,found.ids,found.hashes,bounded]));
   return {contactId:found.survivorId,clusterIds:found.ids,items:items.map(item=>({...item,summary:redactPii(String(item.summary??'')),label:item.actor_kind==='model'?'Unverified model statement':item.verified?'Recorded evidence':'Unverified'}))};
  });
 }

 // ===== DOTS-077 pipelines =====
 async ensureDefaultPipeline(){return tenant(this.client,this.ctx,async tx=>this.defaultPipeline(tx));}
 private async defaultPipeline(tx:Client):Promise<string>{
  await lock(tx,`crm-default-pipeline:${this.org}`);
  const existing=rows(await tx.query('SELECT id FROM app.crm_pipelines WHERE organization_id=$1 AND is_default',[this.org]))[0];if(existing)return String(existing.id);
  return this.insertPipeline(tx,'Product sales',defaultPipelineStages,defaultPipelineTransitions,true);
 }
 private async insertPipeline(tx:Client,label:string,stages:StageSpec[],transitions:[string,string][],isDefault:boolean):Promise<string>{
  const pipeline=rows(await tx.query('INSERT INTO app.crm_pipelines(organization_id,label,is_default) VALUES($1,$2,$3) RETURNING id',[this.org,label,isDefault]))[0]!;
  let position=0;for(const stage of stages)await tx.query('INSERT INTO app.crm_pipeline_stages(organization_id,pipeline_id,stage_key,label,position,outcome,evidence_rule,probability_label) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[this.org,pipeline.id,stage.key,stage.label,position++,stage.outcome,stage.evidenceRule,stage.probabilityLabel]);
  for(const [from,to] of transitions)await tx.query('INSERT INTO app.crm_pipeline_transitions(organization_id,pipeline_id,from_stage,to_stage) VALUES($1,$2,$3,$4)',[this.org,pipeline.id,from,to]);
  await event(tx,this.ctx,'crm.pipeline_created',pipeline.id,{stages:stages.length,isDefault});return String(pipeline.id);
 }
 async createPipeline(input:{label:string;stages:StageSpec[];transitions:[string,string][]}){
  const label=text(input.label,'pipeline',120);if(!Array.isArray(input.stages)||input.stages.length<2||input.stages.length>20)return fail('INVALID_PIPELINE',400);
  const stages=input.stages.map(stage=>({key:typeof stage?.key==='string'&&/^[a-z][a-z0-9_]{1,39}$/.test(stage.key)?stage.key:fail('INVALID_STAGE_KEY',400),label:text(stage.label,'stage_label',80),outcome:selection(stage.outcome,['open','won','lost'],'outcome') as StageSpec['outcome'],evidenceRule:selection(stage.evidenceRule,evidenceRules,'evidence_rule'),probabilityLabel:selection(stage.probabilityLabel,probabilityLabels,'probability_label')}));
  if(new Set(stages.map(stage=>stage.key)).size!==stages.length)return fail('DUPLICATE_STAGE',400);
  if(stages[0]!.outcome!=='open')return fail('FIRST_STAGE_MUST_BE_OPEN',400);
  if(stages.some(stage=>stage.outcome==='won'&&stage.evidenceRule!=='verified_payment_or_signature'))return fail('WON_REQUIRES_VERIFIED_EVIDENCE_RULE',400);
  if(!Array.isArray(input.transitions)||input.transitions.length>200)return fail('INVALID_TRANSITIONS',400);
  const keys=new Set(stages.map(stage=>stage.key));const transitions=input.transitions.map(pair=>{if(!Array.isArray(pair)||pair.length!==2||!keys.has(pair[0])||!keys.has(pair[1])||pair[0]===pair[1])return fail('INVALID_TRANSITIONS',400);return [pair[0],pair[1]] as [string,string];});
  if(stages.some(stage=>stage.outcome==='won')&&transitions.some(([from])=>stages.find(stage=>stage.key===from)?.outcome==='won'))return fail('WON_IS_TERMINAL',400);
  return tenant(this.client,this.ctx,async tx=>({id:await this.insertPipeline(tx,label,stages,transitions,false)}));
 }
 async pipelines(){return tenant(this.client,this.ctx,async tx=>this.loadPipelines(tx));}
 private async loadPipelines(tx:Client){
  const pipelines=rows(await tx.query('SELECT * FROM app.crm_pipelines WHERE organization_id=$1 ORDER BY is_default DESC,created_at LIMIT 20',[this.org]));
  for(const pipeline of pipelines){
   pipeline.stages=rows(await tx.query('SELECT stage_key,label,position,outcome,evidence_rule,probability_label FROM app.crm_pipeline_stages WHERE organization_id=$1 AND pipeline_id=$2 ORDER BY position',[this.org,pipeline.id]));
   pipeline.transitions=rows(await tx.query('SELECT from_stage,to_stage FROM app.crm_pipeline_transitions WHERE organization_id=$1 AND pipeline_id=$2 ORDER BY from_stage,to_stage',[this.org,pipeline.id]));
  }
  return pipelines;
 }

 // ===== DOTS-078 deals =====
 async createDeal(input:{projectId:string;label:string;valueCents:number;contactIds:string[];campaignId?:string;pipelineId?:string;expectedCloseAt?:string}){
  identifier(input.projectId);const label=text(input.label,'deal',160);cents(input.valueCents);
  if(!Array.isArray(input.contactIds)||input.contactIds.length<1||input.contactIds.length>20)return fail('DEAL_CONTACTS_REQUIRED',400);input.contactIds.forEach(identifier);
  if(input.campaignId)identifier(input.campaignId);const expected=dateOrNull(input.expectedCloseAt);
  return tenant(this.client,this.ctx,async tx=>{
   const pipelineId=input.pipelineId?identifier(input.pipelineId):await this.defaultPipeline(tx);
   const first=rows(await tx.query('SELECT stage_key,probability_label FROM app.crm_pipeline_stages WHERE organization_id=$1 AND pipeline_id=$2 ORDER BY position LIMIT 1',[this.org,pipelineId]))[0];if(!first)return fail('PIPELINE_NOT_FOUND',404);
   if(!rows(await tx.query("SELECT 1 FROM app.projects WHERE organization_id=$1 AND id=$2",[this.org,input.projectId])).length)return fail('PROJECT_NOT_FOUND',404);
   if(input.campaignId){const campaign=rows(await tx.query('SELECT project_id,purpose FROM app.campaigns WHERE organization_id=$1 AND id=$2',[this.org,input.campaignId]))[0];if(!campaign)return fail('CAMPAIGN_NOT_FOUND',404);if(String(campaign.project_id)!==input.projectId)return fail('CAMPAIGN_PROJECT_MISMATCH',400);if(campaign.purpose!=='product')return fail('DEALS_ARE_PRODUCT_REVENUE_ONLY',400);}
   const contacts:string[]=[];
   for(const id of input.contactIds){const found=await cluster(tx,this.org,id);if(!found||found.contact.status==='redacted')return fail('CONTACT_NOT_FOUND',404);if(!contacts.includes(found.survivorId))contacts.push(found.survivorId);}
   const deal=rows(await tx.query('INSERT INTO app.deals(organization_id,project_id,contact_id,label,stage,value_cents,pipeline_id,campaign_id,expected_close_at,probability_label) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',[this.org,input.projectId,contacts[0],label,first.stage_key,input.valueCents,pipelineId,input.campaignId??null,expected,first.probability_label]))[0]!;
   for(const [index,id] of contacts.entries())await tx.query('INSERT INTO app.crm_deal_contacts(organization_id,deal_id,contact_id,role) VALUES($1,$2,$3,$4)',[this.org,deal.id,id,index===0?'decision_maker':'participant']);
   await event(tx,this.ctx,'crm.deal_created',deal.id,{pipelineId,contacts:contacts.length});return deal;
  });
 }
 async linkInvoice(dealId:string,invoiceId:string){identifier(dealId);identifier(invoiceId);return tenant(this.client,this.ctx,async tx=>{
  const deal=rows(await tx.query('SELECT project_id FROM app.deals WHERE organization_id=$1 AND id=$2',[this.org,dealId]))[0],invoice=rows(await tx.query('SELECT project_id FROM app.invoices WHERE organization_id=$1 AND id=$2',[this.org,invoiceId]))[0];
  if(!deal||!invoice)return fail('NOT_FOUND',404);if(String(deal.project_id)!==String(invoice.project_id))return fail('INVOICE_PROJECT_MISMATCH',400);
  const saved=rows(await tx.query('INSERT INTO app.crm_deal_invoices(organization_id,deal_id,invoice_id) VALUES($1,$2,$3) ON CONFLICT(organization_id,invoice_id) DO NOTHING RETURNING deal_id',[this.org,dealId,invoiceId]))[0];
  if(!saved){const owner=rows(await tx.query('SELECT deal_id FROM app.crm_deal_invoices WHERE organization_id=$1 AND invoice_id=$2',[this.org,invoiceId]))[0]!;if(String(owner.deal_id)!==dealId)return fail('INVOICE_LINKED_TO_OTHER_DEAL');}
  await event(tx,this.ctx,'crm.deal_invoice_linked',dealId,{invoiceId});return {linked:true};
 });}
 /** Evidence-guarded stage change. Won requires a paid live invoice, a provider receipt or a stored signed agreement linked to the deal. */
 async transitionDeal(input:{dealId:string;toStage:string;version:number;evidence?:{kind:string;ref?:string}}){
  identifier(input.dealId);if(!Number.isSafeInteger(input.version))return fail('INVALID_VERSION',400);const toStage=text(input.toStage,'stage',40);
  return tenant(this.client,this.ctx,async tx=>{
   const deal=rows(await tx.query('SELECT * FROM app.deals WHERE organization_id=$1 AND id=$2 FOR UPDATE',[this.org,input.dealId]))[0];if(!deal)return fail('NOT_FOUND',404);
   if(Number(deal.version)!==input.version)return fail('STALE_RECORD');
   if(!deal.pipeline_id)return fail('DEAL_HAS_NO_PIPELINE');
   const target=rows(await tx.query('SELECT * FROM app.crm_pipeline_stages WHERE organization_id=$1 AND pipeline_id=$2 AND stage_key=$3',[this.org,deal.pipeline_id,toStage]))[0];if(!target)return fail('UNKNOWN_STAGE',400);
   if(!rows(await tx.query('SELECT 1 FROM app.crm_pipeline_transitions WHERE organization_id=$1 AND pipeline_id=$2 AND from_stage=$3 AND to_stage=$4',[this.org,deal.pipeline_id,deal.stage,toStage])).length)return fail('TRANSITION_NOT_ALLOWED');
   const proof=await this.verifyEvidence(tx,deal,String(target.evidence_rule),input.evidence);
   const saved=rows(await tx.query('UPDATE app.deals SET stage=$3,probability_label=$4,won_at=CASE WHEN $5::boolean THEN app.utc_now() ELSE NULL END,version=version+1,updated_at=app.utc_now() WHERE organization_id=$1 AND id=$2 RETURNING *',[this.org,deal.id,toStage,target.probability_label,target.outcome==='won']))[0]!;
   await tx.query('INSERT INTO app.crm_deal_transitions(organization_id,deal_id,from_stage,to_stage,evidence_kind,evidence_ref,actor_membership_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[this.org,deal.id,deal.stage,toStage,proof.kind,proof.ref,this.ctx.membershipId]);
   await event(tx,this.ctx,'crm.deal_stage_changed',deal.id,{from:deal.stage,to:toStage,evidenceKind:proof.kind});return saved;
  });
 }
 private async verifyEvidence(tx:Client,deal:Row,rule:string,evidence?:{kind:string;ref?:string}):Promise<{kind:string;ref:string|null}>{
  const kind=evidence?.kind??'none';
  if(rule==='none')return kind==='owner_note'&&evidence?.ref?{kind,ref:text(evidence.ref,'evidence',1000)}:{kind:'none',ref:null};
  if(rule==='owner_note'){if(kind!=='owner_note'||typeof evidence?.ref!=='string'||evidence.ref.trim().length<10)return fail('STAGE_REQUIRES_OWNER_NOTE',400);return {kind,ref:text(evidence.ref,'evidence',1000)};}
  if(rule==='document'||(rule==='verified_payment_or_signature'&&kind==='document')){
   if(kind!=='document')return fail('STAGE_REQUIRES_DOCUMENT',400);
   const ref=identifier(evidence?.ref);
   if(!rows(await tx.query('SELECT 1 FROM app.document_library WHERE organization_id=$1 AND id=$2 AND (project_id IS NULL OR project_id=$3)',[this.org,ref,deal.project_id])).length)return fail('EVIDENCE_DOCUMENT_NOT_FOUND',400);
   return {kind,ref};
  }
  if(rule==='verified_payment_or_signature'){
   if(kind==='paid_invoice'){
    const ref=identifier(evidence?.ref);
    const ok=rows(await tx.query(`SELECT 1 FROM app.invoices i JOIN app.crm_deal_invoices l ON l.organization_id=i.organization_id AND l.invoice_id=i.id AND l.deal_id=$3
      WHERE i.organization_id=$1 AND i.id=$2 AND i.state='paid' AND NOT i.test_mode
      AND EXISTS(SELECT 1 FROM app.money_entries m WHERE m.organization_id=i.organization_id AND m.invoice_id=i.id AND m.kind='sale_receipt' AND m.source='provider')`,[this.org,ref,deal.id])).length>0;
    if(!ok)return fail('WON_REQUIRES_VERIFIED_PAYMENT_OR_SIGNATURE',400);return {kind,ref};
   }
   if(kind==='provider_receipt'){
    const ref=identifier(evidence?.ref);
    const ok=rows(await tx.query(`SELECT 1 FROM app.money_entries m JOIN app.crm_deal_invoices l ON l.organization_id=m.organization_id AND l.invoice_id=m.invoice_id AND l.deal_id=$3
      WHERE m.organization_id=$1 AND m.id=$2 AND m.kind='sale_receipt' AND m.source='provider'`,[this.org,ref,deal.id])).length>0;
    if(!ok)return fail('WON_REQUIRES_VERIFIED_PAYMENT_OR_SIGNATURE',400);return {kind,ref};
   }
   return fail('WON_REQUIRES_VERIFIED_PAYMENT_OR_SIGNATURE',400);
  }
  return fail('UNKNOWN_EVIDENCE_RULE',400);
 }
 /** Forecast (open pipeline value), invoiced and provider-received cash are reported separately and never blended. */
 async dealFinancials(input:{dealId?:string;limit?:number}={}){
  const limit=Math.max(1,Math.min(100,input.limit??50));if(input.dealId)identifier(input.dealId);
  return tenant(this.client,this.ctx,async tx=>this.loadDealFinancials(tx,input.dealId??null,limit));
 }
 private async loadDealFinancials(tx:Client,dealId:string|null,limit:number){
  const deals=rows(await tx.query(`SELECT d.id,d.label,d.stage,d.pipeline_id,d.project_id,d.campaign_id,d.probability_label,d.expected_close_at,d.won_at,d.version,d.value_cents,
    s.outcome,CASE WHEN COALESCE(s.outcome,CASE WHEN d.stage IN ('won','lost') THEN d.stage ELSE 'open' END)='open' THEN d.value_cents ELSE 0 END AS forecast_cents,
    COALESCE((SELECT sum(i.amount_cents) FROM app.crm_deal_invoices l JOIN app.invoices i ON i.organization_id=l.organization_id AND i.id=l.invoice_id WHERE l.organization_id=d.organization_id AND l.deal_id=d.id AND i.state IN ('issued','paid','refunded','disputed')),0) AS invoiced_cents,
    COALESCE((SELECT sum(CASE WHEN m.kind='refund' THEN -m.amount_cents ELSE m.amount_cents END) FROM app.crm_deal_invoices l JOIN app.money_entries m ON m.organization_id=l.organization_id AND m.invoice_id=l.invoice_id WHERE l.organization_id=d.organization_id AND l.deal_id=d.id AND m.source='provider' AND m.kind IN ('sale_receipt','refund')),0) AS received_cents,
    COALESCE((SELECT sum(m.amount_cents) FROM app.crm_deal_invoices l JOIN app.money_entries m ON m.organization_id=l.organization_id AND m.invoice_id=l.invoice_id WHERE l.organization_id=d.organization_id AND l.deal_id=d.id AND m.source='simulation'),0) AS sandbox_cents,
    (SELECT COALESCE(jsonb_agg(jsonb_build_object('contact_id',dc.contact_id,'role',dc.role,'name',c.display_name)),'[]'::jsonb) FROM app.crm_deal_contacts dc JOIN app.crm_contacts c ON c.organization_id=dc.organization_id AND c.id=dc.contact_id WHERE dc.organization_id=d.organization_id AND dc.deal_id=d.id) AS contacts
   FROM app.deals d LEFT JOIN app.crm_pipeline_stages s ON s.organization_id=d.organization_id AND s.pipeline_id=d.pipeline_id AND s.stage_key=d.stage
   WHERE d.organization_id=$1 AND ($2::uuid IS NULL OR d.id=$2) ORDER BY d.updated_at DESC LIMIT $3`,[this.org,dealId,limit]));
  const normalized=deals.map(deal=>({...deal,value_cents:Number(deal.value_cents),forecast_cents:Number(deal.forecast_cents),invoiced_cents:Number(deal.invoiced_cents),received_cents:Number(deal.received_cents),sandbox_cents:Number(deal.sandbox_cents)}));
  const totals=rows(await tx.query(`SELECT
    COALESCE((SELECT sum(d.value_cents) FROM app.deals d LEFT JOIN app.crm_pipeline_stages s ON s.organization_id=d.organization_id AND s.pipeline_id=d.pipeline_id AND s.stage_key=d.stage WHERE d.organization_id=$1 AND COALESCE(s.outcome,CASE WHEN d.stage IN ('won','lost') THEN d.stage ELSE 'open' END)='open'),0)::text AS forecast_cents,
    COALESCE((SELECT sum(i.amount_cents) FROM app.crm_deal_invoices l JOIN app.invoices i ON i.organization_id=l.organization_id AND i.id=l.invoice_id WHERE l.organization_id=$1 AND i.state IN ('issued','paid','refunded','disputed')),0)::text AS invoiced_cents,
    COALESCE((SELECT sum(CASE WHEN m.kind='refund' THEN -m.amount_cents ELSE m.amount_cents END) FROM app.crm_deal_invoices l JOIN app.money_entries m ON m.organization_id=l.organization_id AND m.invoice_id=l.invoice_id WHERE l.organization_id=$1 AND m.source='provider' AND m.kind IN ('sale_receipt','refund')),0)::text AS received_cents`,[this.org]))[0]!;
  return {deals:normalized,totals:{forecastCents:Number(totals.forecast_cents),invoicedCents:Number(totals.invoiced_cents),receivedCents:Number(totals.received_cents)}};
 }

 // ===== DOTS-079 conservative attribution =====
 /** Builds verified touchpoints only from messages with a provider message id in a delivered state. Idempotent. */
 async recordVerifiedTouchpoints(){return tenant(this.client,this.ctx,async tx=>{
  const inserted=rows(await tx.query(`INSERT INTO app.crm_touchpoints(organization_id,contact_id,campaign_id,channel,direction,message_id,receipt_ref,verified,occurred_at)
   SELECT m.organization_id,COALESCE(k.merged_into_id,k.id),m.campaign_id,'email',m.direction,m.id,'message:'||m.provider_message_id,true,COALESCE(m.sent_at,m.created_at)
   FROM app.messages m JOIN app.conversations c ON c.organization_id=m.organization_id AND c.id=m.conversation_id JOIN app.crm_contacts k ON k.organization_id=c.organization_id AND k.id=c.contact_id
   WHERE m.organization_id=$1 AND m.provider_message_id IS NOT NULL AND m.source IN ('provider','owner','model') AND m.state IN ('sent','delivered','received')
   ON CONFLICT DO NOTHING RETURNING id`,[this.org]));
  await event(tx,this.ctx,'crm.touchpoints_recorded',null,{inserted:inserted.length});return {inserted:inserted.length};
 });}
 async recordTouchpoint(input:{contactId:string;campaignId?:string;agentId?:string;channel:string;direction:string;receiptRef:string;occurredAt:string}){
  identifier(input.contactId);const channel=selection(input.channel,['email','phone','meeting','web'],'channel'),direction=selection(input.direction,['outbound','inbound'],'direction'),receipt=text(input.receiptRef,'receipt',200);
  const occurred=dateOrNull(input.occurredAt);if(!occurred)return fail('INVALID_DATE',400);
  return tenant(this.client,this.ctx,async tx=>{
   const found=await cluster(tx,this.org,input.contactId);if(!found)return fail('NOT_FOUND',404);
   // Owner-entered touchpoints are stored for context but never count as verified attribution evidence.
   const saved=rows(await tx.query('INSERT INTO app.crm_touchpoints(organization_id,contact_id,campaign_id,agent_identity_id,channel,direction,receipt_ref,verified,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,false,$8) ON CONFLICT DO NOTHING RETURNING *',[this.org,found.survivorId,input.campaignId?identifier(input.campaignId):null,input.agentId?identifier(input.agentId):null,channel,direction,`owner:${receipt}`,occurred]))[0];
   await event(tx,this.ctx,'crm.touchpoint_recorded',found.survivorId,{verified:false,channel});return saved??{duplicate:true};
  });
 }
 async attributeDeal(dealId:string,input:{windowDays?:number;dedupHours?:number}={}){
  identifier(dealId);const windowDays=input.windowDays??90,dedupHours=input.dedupHours??24;
  if(!Number.isSafeInteger(windowDays)||windowDays<1||windowDays>365||!Number.isSafeInteger(dedupHours)||dedupHours<1||dedupHours>720)return fail('INVALID_ATTRIBUTION_WINDOW',400);
  return tenant(this.client,this.ctx,async tx=>{
   await lock(tx,`attribution:${this.org}:${dealId}`);
   const existing=rows(await tx.query('SELECT * FROM app.crm_attributions WHERE organization_id=$1 AND deal_id=$2 ORDER BY model',[this.org,dealId]));
   if(existing.length)return {attributed:true,idempotent:true,rows:existing};
   const deal=rows(await tx.query(`SELECT d.*,s.outcome FROM app.deals d LEFT JOIN app.crm_pipeline_stages s ON s.organization_id=d.organization_id AND s.pipeline_id=d.pipeline_id AND s.stage_key=d.stage WHERE d.organization_id=$1 AND d.id=$2`,[this.org,dealId]))[0];
   if(!deal)return fail('NOT_FOUND',404);if(deal.outcome!=='won'||!deal.won_at)return {attributed:false,reason:'DEAL_NOT_WON'};
   const receipts=rows(await tx.query(`SELECT m.id,CASE WHEN m.kind='refund' THEN -m.amount_cents ELSE m.amount_cents END AS amount FROM app.crm_deal_invoices l JOIN app.money_entries m ON m.organization_id=l.organization_id AND m.invoice_id=l.invoice_id
     WHERE l.organization_id=$1 AND l.deal_id=$2 AND m.source='provider' AND m.kind IN ('sale_receipt','refund') ORDER BY m.occurred_at,m.id`,[this.org,dealId]));
   const received=receipts.reduce((sum,row)=>sum+Number(row.amount),0);
   if(received<=0)return {attributed:false,reason:'NO_VERIFIED_RECEIPT'};
   const contacts=rows(await tx.query(`SELECT DISTINCT COALESCE(c.merged_into_id,c.id) AS id FROM app.crm_contacts c WHERE c.organization_id=$1 AND (c.id IN (SELECT contact_id FROM app.crm_deal_contacts WHERE organization_id=$1 AND deal_id=$2) OR c.id=$3)`,[this.org,dealId,deal.contact_id])).map(row=>String(row.id));
   const clusterIds=rows(await tx.query('SELECT id FROM app.crm_contacts WHERE organization_id=$1 AND (id=ANY($2::uuid[]) OR merged_into_id=ANY($2::uuid[]))',[this.org,contacts])).map(row=>String(row.id));
   const touches=rows(await tx.query(`SELECT id,contact_id,campaign_id,occurred_at FROM app.crm_touchpoints WHERE organization_id=$1 AND contact_id=ANY($2::uuid[]) AND verified AND direction='outbound'
     AND occurred_at<=$3 AND occurred_at>=$3::timestamptz-make_interval(days=>$4::int) ORDER BY occurred_at,id`,[this.org,clusterIds,deal.won_at,windowDays]));
   const deduped:Row[]=[];
   for(const touch of touches){const prior=[...deduped].reverse().find(item=>String(item.campaign_id)===String(touch.campaign_id));if(prior&&new Date(touch.occurred_at).getTime()-new Date(prior.occurred_at).getTime()<dedupHours*3600000)continue;deduped.push(touch);}
   if(!deduped.length)return {attributed:false,reason:'NO_VERIFIED_TOUCHPOINT'};
   const evidence=`receipts:${receipts.map(row=>row.id).join(',')}`.slice(0,240);
   const saved:Row[]=[];
   for(const [model,touch] of [['first_touch',deduped[0]!],['last_touch',deduped[deduped.length-1]!]] as const)
    saved.push(rows(await tx.query('INSERT INTO app.crm_attributions(organization_id,deal_id,model,touchpoint_id,campaign_id,received_cents,receipt_evidence,window_days,dedup_hours) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',[this.org,dealId,model,touch.id,touch.campaign_id,received,evidence,windowDays,dedupHours]))[0]!);
   await event(tx,this.ctx,'crm.deal_attributed',dealId,{receivedCents:received,touches:deduped.length});
   return {attributed:true,idempotent:false,rows:saved,consideredTouches:touches.length,dedupedTouches:deduped.length};
  });
 }
 async attributionReport(){return tenant(this.client,this.ctx,async tx=>this.loadAttribution(tx));}
 private async loadAttribution(tx:Client){
  const byCampaign=rows(await tx.query(`SELECT a.model,a.campaign_id,c.label AS campaign_label,count(DISTINCT a.deal_id)::int AS won_deals,sum(a.received_cents)::text AS received_cents
   FROM app.crm_attributions a LEFT JOIN app.campaigns c ON c.organization_id=a.organization_id AND c.id=a.campaign_id WHERE a.organization_id=$1 GROUP BY a.model,a.campaign_id,c.label ORDER BY a.model,c.label LIMIT 100`,[this.org]));
  const totals=rows(await tx.query('SELECT count(DISTINCT deal_id)::int AS attributed_deals FROM app.crm_attributions WHERE organization_id=$1',[this.org]))[0]!;
  return {byCampaign:byCampaign.map(row=>({...row,received_cents:Number(row.received_cents)})),attributedDeals:Number(totals.attributed_deals)};
 }

 // ===== DOTS-080 bulk review and snapshot =====
 async bulkReview(input:{contactIds:string[];action:string;reason?:string}){
  if(!Array.isArray(input.contactIds)||input.contactIds.length<1||input.contactIds.length>100)return fail('BULK_LIMIT_100',400);input.contactIds.forEach(identifier);
  const action=selection(input.action,['assign_to_me','archive','suppress','detect_duplicates'],'bulk_action');
  if(action==='suppress'){let total=0;for(const id of input.contactIds)total+=(await this.suppress({contactId:id,reason:input.reason??'OWNER_BULK_REVIEW',source:'owner'})).suppressed;return {action,affected:total};}
  if(action==='detect_duplicates')return {action,...await this.detectDuplicates(input.contactIds)};
  return tenant(this.client,this.ctx,async tx=>{
   const sql=action==='archive'?"UPDATE app.crm_contacts SET status='archived',version=version+1,updated_at=app.utc_now() WHERE organization_id=$1 AND id=ANY($2::uuid[]) AND status='active' RETURNING id"
    :"UPDATE app.crm_contacts SET owner_membership_id=$3,version=version+1,updated_at=app.utc_now() WHERE organization_id=$1 AND id=ANY($2::uuid[]) AND status NOT IN ('merged','redacted') RETURNING id";
   const saved=rows(await tx.query(sql,action==='archive'?[this.org,input.contactIds]:[this.org,input.contactIds,this.ctx.membershipId]));
   if(action==='archive')await tx.query("UPDATE app.crm_prospect_claims SET state='released',released_at=app.utc_now(),release_reason='ARCHIVED' WHERE organization_id=$1 AND contact_id=ANY($2::uuid[]) AND state='active'",[this.org,saved.map(row=>row.id)]);
   await event(tx,this.ctx,'crm.bulk_review',null,{action,affected:saved.length});return {action,affected:saved.length};
  });
 }
 async inspector(contactId:string){
  identifier(contactId);
  const detail=await tenant(this.client,this.ctx,async tx=>{
   const found=await cluster(tx,this.org,contactId);if(!found)return fail('NOT_FOUND',404);
   const methods=rows(await tx.query('SELECT id,contact_id,kind,value,is_primary FROM app.crm_contact_methods WHERE organization_id=$1 AND contact_id=ANY($2::uuid[]) ORDER BY is_primary DESC,created_at LIMIT 20',[this.org,found.ids])).map(({value,...row})=>({...row,value_masked:row.kind==='email'?maskEmail(value):value?`${String(value).slice(0,3)}…`:null}));
   const aliases=rows(await tx.query('SELECT alias FROM app.crm_aliases WHERE organization_id=$1 AND contact_id=ANY($2::uuid[]) LIMIT 20',[this.org,found.ids]));
   const sources=rows(await tx.query('SELECT id,contact_id,batch_id,source_label,source_kind,purpose,lawful_basis,created_at FROM app.crm_contact_sources WHERE organization_id=$1 AND contact_id=ANY($2::uuid[]) ORDER BY created_at LIMIT 50',[this.org,found.ids]));
   const consent=rows(await tx.query('SELECT consent,evidence_ref,jurisdiction,source,created_at FROM app.crm_consent_evidence WHERE organization_id=$1 AND contact_id=ANY($2::uuid[]) ORDER BY created_at DESC LIMIT 20',[this.org,found.ids]));
   const claims=rows(await tx.query('SELECT * FROM app.crm_prospect_claims WHERE organization_id=$1 AND contact_id=ANY($2::uuid[]) ORDER BY claimed_at DESC LIMIT 10',[this.org,found.ids]));
   const survivor=found.members.find(member=>String(member.id)===found.survivorId)??found.contact;
   return {contact:publicContact(survivor),mergedRecords:found.members.filter(member=>String(member.id)!==found.survivorId).map(publicContact),methods,aliases,sources,consent,claims};
  });
  return {...detail,timeline:(await this.timeline(contactId,50)).items};
 }
 /** Bounded owner snapshot for the CRM view. Raw email addresses are never included. */
 async snapshot(input:{q?:string;cursor?:string;contactId?:string}={}){
  const contacts=await this.searchContacts({q:input.q,cursor:input.cursor,limit:24});
  const map=await this.accountMap({limit:12});
  const candidates=await this.listCandidates(12);
  const rest=await tenant(this.client,this.ctx,async tx=>{
   const imports=rows(await tx.query('SELECT id,source_label,source_kind,purpose,lawful_basis,state,total_rows,valid_rows,quarantined_rows,duplicate_rows,created_at,committed_at FROM app.crm_import_batches WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 10',[this.org]));
   const segments=rows(await tx.query('SELECT id,label,filter,version,updated_at FROM app.crm_segments WHERE organization_id=$1 ORDER BY updated_at DESC LIMIT 20',[this.org]));
   const pipelines=await this.loadPipelines(tx);
   const financials=await this.loadDealFinancials(tx,null,60);
   const claims=rows(await tx.query("SELECT p.id,p.contact_id,p.campaign_id,p.agent_identity_id,p.claimed_at,c.display_name FROM app.crm_prospect_claims p JOIN app.crm_contacts c ON c.organization_id=p.organization_id AND c.id=p.contact_id WHERE p.organization_id=$1 AND p.state='active' ORDER BY p.claimed_at DESC LIMIT 25",[this.org]));
   const conflicts=rows(await tx.query("SELECT record_id,details,occurred_at FROM app.operation_events WHERE organization_id=$1 AND event_type='crm.prospect_claim_conflict' ORDER BY occurred_at DESC LIMIT 10",[this.org]));
   const policy=await contactPolicy(tx,this.org);
   const regions=rows(await tx.query('SELECT jurisdiction,allowed,requires_opt_in,legal_review_ref,updated_at FROM app.crm_region_policies WHERE organization_id=$1 ORDER BY jurisdiction LIMIT 100',[this.org]));
   const campaigns=rows(await tx.query('SELECT id,label,purpose,state,project_id FROM app.campaigns WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 25',[this.org]));
   const agents=rows(await tx.query("SELECT id,display_name,status FROM app.agent_identities WHERE organization_id=$1 ORDER BY display_name LIMIT 25",[this.org]));
   const projects=rows(await tx.query("SELECT id,label FROM app.projects WHERE organization_id=$1 ORDER BY label LIMIT 25",[this.org]));
   const counts=rows(await tx.query("SELECT count(*) FILTER(WHERE status='active')::int AS active,count(*) FILTER(WHERE status='suppressed')::int AS suppressed,count(*) FILTER(WHERE status='merged')::int AS merged,(SELECT count(*)::int FROM app.contact_suppressions WHERE organization_id=$1) AS suppression_entries FROM app.crm_contacts WHERE organization_id=$1",[this.org]))[0]!;
   const attribution=await this.loadAttribution(tx);
   return {imports,segments,pipelines,financials,claims,conflicts,contactPolicy:{maxTouches:Number(policy.max_touches),windowDays:Number(policy.window_days),exclusionDays:Number(policy.exclusion_days),configured:'organization_id' in policy},regions,campaigns,agents,projects,counts,attribution};
  });
  const inspector=input.contactId?await this.inspector(input.contactId):null;
  return {contacts,accountMap:map,candidates,...rest,inspector,observedAt:new Date().toISOString()};
 }
}
function encodeCursor(name:string,id:string){return Buffer.from(JSON.stringify([name,id])).toString('base64url');}
function decodeCursor(value:string):{name:string;id:string}{
 try{const [name,id]=JSON.parse(Buffer.from(String(value).slice(0,400),'base64url').toString('utf8'));if(typeof name!=='string'||!/^[a-z0-9]{0,160}$/.test(name))throw new Error();return {name,id:identifier(id)};}
 catch{return fail('INVALID_CURSOR',400);}
}
