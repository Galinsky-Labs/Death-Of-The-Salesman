/**
 * DOTS-121..134 Funding Agents: funding source directory, discovery connectors, eligibility rules,
 * visual pipeline, grant applications, source-grounded drafting, deadline calendar, human-reviewed
 * submission, awards/disbursements, investor relations, pitch assets, commitments, sponsorships and
 * the funding performance dashboard.
 *
 * Hard boundaries enforced here (fail-closed):
 * - Grants, investor relations, sponsorships/partnerships and product revenue are separate record families.
 * - Nothing in this module submits an application, signs, certifies, executes a contract or sends investor
 *   communication. Those acts are performed by the owner outside the system and recorded with evidence.
 * - Interest, term sheets, requested amounts and unaccepted awards are never money. Cash exists only as
 *   append-only money_entries with provider or owner-attested receipt evidence.
 */
import {type Client,type Context,type Row,rows,tenant,event,digest,text,cents,fail} from './common.js';
import {identifier,selection,dateOrNull} from './sales.js';
import {discoverGrants} from './discovery.js';
import {ControlPlane} from './control.js';

export const fundingSourceKinds=['grant_program','foundation','government_agency','sponsor','partner','investor_fund'] as const;
export const eligibilityRuleKinds=['entity_type','jurisdiction','stage','restriction','required_document'] as const;
export const communicationClasses=['meeting_logistics','relationship_update','factual_company_update','offering_material'] as const;
export const commitmentStages=['meeting','interest','term_sheet','signed_commitment','cash_received'] as const;
export const sponsorshipStages=['research','proposal','approved','contract_review','signed','exchanged','declined'] as const;
export const DEFAULT_ELIGIBILITY_STALE_DAYS=30;
const DAY=86_400_000;

export type Actor='owner'|'agent';
/** Agents (worker/model contexts) can never sign, certify, accept, submit or execute binding terms. */
export function assertHumanActor(actor:Actor|undefined,code='AGENT_CANNOT_CERTIFY'){if(actor!==undefined&&actor!=='owner')fail(code,403);}
function httpsUrl(value:unknown,field='source_url'):string{const url=text(value,field,1990);let parsed:URL;try{parsed=new URL(url);}catch{return fail(`INVALID_${field.toUpperCase()}`,400);}if(parsed.protocol!=='https:'||parsed.username||parsed.password)return fail('HTTPS_SOURCE_REQUIRED',400);return parsed.toString();}
export function timezone(value:unknown):string{const zone=text(value??'UTC','timezone',64);try{new Intl.DateTimeFormat('en-US',{timeZone:zone});}catch{return fail('INVALID_TIMEZONE',400);}return zone;}
function list(value:unknown,field:string,max=25):string[]{if(value===undefined||value===null)return [];if(!Array.isArray(value)||value.length>max)return fail(`INVALID_${field.toUpperCase()}`,400);return [...new Set(value.map(item=>text(item,field,80)))];}
function optionalCents(value:unknown):number|null{return value===undefined||value===null?null:cents(value);}
function positive(value:unknown):number{const amount=cents(value);if(!amount)return fail('POSITIVE_AMOUNT_REQUIRED',400);return amount;}
function pastOrNow(value:unknown,field:string):string{const iso=dateOrNull(value);if(!iso)return fail(`INVALID_${field.toUpperCase()}`,400);if(new Date(iso).getTime()>Date.now()+5*60_000)return fail('FUTURE_EVIDENCE_TIMESTAMP',400);return iso;}
const one=async(tx:Client,sql:string,params:unknown[])=>rows(await tx.query(sql,params))[0];
/** Wall-clock time in an IANA zone converted to a UTC instant. */
export function zonedInstant(year:number,month:number,day:number,hour:number,minute:number,zone:string):Date{
 const guess=Date.UTC(year,month-1,day,hour,minute);
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:zone,hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).formatToParts(new Date(guess)).map(p=>[p.type,p.value]));
 const shown=Date.UTC(Number(parts.year),Number(parts.month)-1,Number(parts.day),Number(parts.hour),Number(parts.minute));
 return new Date(guess-(shown-guess));
}

// ---------------------------------------------------------------- deterministic gates (pure)
export type EligibilityRule={id?:string;kind:string;allowed:string[];description:string;citation_url:string};
export type ApplicantProfile={entity_type:string;jurisdiction:string;stage:string;documents:Record<string,string>;restrictions_confirmed:string[]};
export type EligibilityLine={ruleId:string|null;kind:string;outcome:'pass'|'fail'|'unknown';detail:string;citation:string};
/**
 * Unknown is never upgraded to eligible: missing profile, no rules, any unresolved rule, a missing or stale
 * source, or a missing deadline all yield `unknown`. Every line cites the source it was evaluated against.
 */
export function evaluateEligibility(input:{profile:ApplicantProfile|null;rules:EligibilityRule[];source:{url:string;verifiedAt:string|Date}|null;deadline:string|Date|null;now?:Date;staleDays?:number}){
 const now=input.now??new Date(),staleDays=input.staleDays??DEFAULT_ELIGIBILITY_STALE_DAYS,lines:EligibilityLine[]=[];
 if(!input.source)return {result:'unknown' as const,explanation:[{ruleId:null,kind:'source',outcome:'unknown' as const,detail:'No verified funding source is linked; eligibility cannot be established.',citation:''}],citation:null};
 const citation={url:input.source.url,verifiedAt:new Date(input.source.verifiedAt).toISOString()};
 const ageDays=(now.getTime()-new Date(input.source.verifiedAt).getTime())/DAY;
 if(ageDays>staleDays)lines.push({ruleId:null,kind:'source',outcome:'unknown',detail:`Source last verified ${Math.floor(ageDays)} days ago (limit ${staleDays}); re-verify before relying on it.`,citation:citation.url});
 if(!input.deadline)lines.push({ruleId:null,kind:'deadline',outcome:'unknown',detail:'No published deadline is recorded.',citation:citation.url});
 else if(new Date(input.deadline).getTime()<now.getTime())lines.push({ruleId:null,kind:'deadline',outcome:'fail',detail:`Deadline ${new Date(input.deadline).toISOString()} has passed.`,citation:citation.url});
 else lines.push({ruleId:null,kind:'deadline',outcome:'pass',detail:`Deadline ${new Date(input.deadline).toISOString()} is in the future.`,citation:citation.url});
 if(!input.profile)lines.push({ruleId:null,kind:'profile',outcome:'unknown',detail:'No applicant profile (entity type, jurisdiction, stage) is recorded.',citation:citation.url});
 if(!input.rules.length)lines.push({ruleId:null,kind:'rules',outcome:'unknown',detail:'No eligibility rules have been transcribed from the official source.',citation:citation.url});
 for(const rule of input.rules){
  const base={ruleId:rule.id??null,kind:rule.kind,citation:rule.citation_url};
  if(!input.profile){lines.push({...base,outcome:'unknown',detail:`${rule.description} (applicant profile missing)`});continue;}
  const p=input.profile;const allowed=rule.allowed.map(v=>v.toLowerCase());
  if(rule.kind==='entity_type'||rule.kind==='stage'){const value=(rule.kind==='entity_type'?p.entity_type:p.stage).toLowerCase();if(!allowed.length)lines.push({...base,outcome:'unknown',detail:`${rule.description} (no allowed values transcribed)`});else lines.push({...base,outcome:allowed.includes(value)?'pass':'fail',detail:`${rule.description}: applicant ${rule.kind.replace('_',' ')} is "${value}".`});}
  else if(rule.kind==='jurisdiction'){const value=p.jurisdiction.toUpperCase();const ok=rule.allowed.some(a=>value===a.toUpperCase()||value.startsWith(`${a.toUpperCase()}-`));if(!allowed.length)lines.push({...base,outcome:'unknown',detail:`${rule.description} (no jurisdictions transcribed)`});else lines.push({...base,outcome:ok?'pass':'fail',detail:`${rule.description}: applicant jurisdiction is ${value}.`});}
  else if(rule.kind==='required_document'){const missing=rule.allowed.filter(kind=>!p.documents[kind]);lines.push({...base,outcome:missing.length?'unknown':'pass',detail:missing.length?`${rule.description}: missing ${missing.join(', ')}.`:`${rule.description}: on file.`});}
  else if(rule.kind==='restriction'){const confirmed=rule.id?p.restrictions_confirmed.includes(rule.id):false;lines.push({...base,outcome:confirmed?'pass':'unknown',detail:confirmed?`${rule.description}: owner confirmed compliance.`:`${rule.description}: owner has not confirmed compliance.`});}
  else lines.push({...base,outcome:'unknown',detail:`Unsupported rule kind ${rule.kind}.`});
 }
 const result=lines.some(l=>l.outcome==='fail')?'ineligible' as const:lines.some(l=>l.outcome==='unknown')?'unknown' as const:'eligible' as const;
 return {result,explanation:lines,citation};
}

export type Fact={id:string;statement:string;category?:string};
export type ClaimFinding={sentence:string;reason:'UNCITED_CLAIM'|'UNKNOWN_CITATION'|'NUMBER_NOT_IN_FACT'|'UNAPPROVED_FACT'};
const pronounPattern=/\b(we|our|us|ours)\b/i;
const financialPattern=/revenue|customers?|clients?|users?|subscribers?|traction|growth|grew|profit|margin|\bARR\b|\bMRR\b|raised|bookings/i;
const claimPattern=/revenue|customers?|clients?|users?|traction|growth|profit|\bARR\b|\bMRR\b|award|patent|certified|accredited|partner(ship)?s?\b|funded|raised|employees|staff|nonprofit|501\(c\)|registered|incorporated|founded|served|impact/i;
const numbersIn=(value:string)=>(value.replace(/\[\d+\]/g,'').match(/\d[\d,]*(\.\d+)?/g)??[]).map(n=>n.replace(/,/g,'')).filter(Boolean);
/** Organizational/financial/traction claims must cite an approved fact, and every number must appear in a cited fact. */
export function findUnsupportedClaims(content:string,facts:Fact[],citedIds:string[],mode:'organizational'|'financial'='organizational'):ClaimFinding[]{
 const findings:ClaimFinding[]=[];const known=new Map(facts.map(f=>[f.id,f]));
 for(const id of citedIds)if(!known.has(id))findings.push({sentence:id,reason:'UNAPPROVED_FACT'});
 for(const sentence of content.split(/(?<=[.!?])\s+|\n+/).map(s=>s.trim()).filter(Boolean)){
  const markers=[...sentence.matchAll(/\[(\d+)\]/g)].map(m=>Number(m[1]));
  const bare=sentence.replace(/\[\d+\]/g,'');
  if(!(mode==='financial'?financialPattern:claimPattern).test(bare)&&!/\d|\$|%/.test(bare)&&!(mode==='organizational'&&pronounPattern.test(bare)))continue;
  if(!markers.length){findings.push({sentence,reason:'UNCITED_CLAIM'});continue;}
  const cited=markers.map(n=>known.get(citedIds[n-1]??''));
  if(cited.some(f=>!f)){findings.push({sentence,reason:'UNKNOWN_CITATION'});continue;}
  const available=new Set(cited.flatMap(f=>numbersIn(f!.statement)));
  if(numbersIn(bare).some(n=>!available.has(n)))findings.push({sentence,reason:'NUMBER_NOT_IN_FACT'});
 }
 return findings;
}
const offerTerms=[/\binvest(ing|ment|ments|or|ors)?\b/i,/\breturns?\b/i,/\bguarantee(d|s)?\b/i,/\bROI\b/i,/\byields?\b/i,/\bequity\b/i,/\bshares?\b/i,/\bstock\b/i,/\bvaluation\b/i,/\bSAFE\b/,/\bconvertible\b/i,/\bterm sheet\b/i,/\boffering\b/i,/\bsecurities\b/i,/\braise|raising\b/i,/\bminimum (check|ticket|commitment)\b/i,/\bpre-money|post-money\b/i,/\bdividends?\b/i];
/** Regulated offer / general-solicitation vocabulary. Matching content cannot be cleared without owner + legal review. */
export function regulatedOfferFindings(content:string):string[]{return offerTerms.map(p=>content.match(p)?.[0]?.toLowerCase()).filter((v):v is string=>Boolean(v));}
export function fundingUrgency(deadline:string|Date|null|undefined,now=new Date()){if(!deadline)return 'no_deadline';const days=(new Date(deadline).getTime()-now.getTime())/DAY;return days<0?'overdue':days<=7?'critical':days<=30?'soon':'later';}
/** Visual truth class: received > commitment > pending_award > lead. Interest never leaves `lead`. */
export function fundingStatusClass(card:{receivedCents:number;signedCommitmentCents:number;sponsorshipSigned:boolean;awardStatus:string|null;applicationStatus:string|null}){
 if(card.receivedCents>0)return 'received';if(card.signedCommitmentCents>0||card.sponsorshipSigned)return 'commitment';
 if(card.awardStatus==='offered'||card.awardStatus==='accepted'||card.applicationStatus==='submitted')return 'pending_award';return 'lead';
}
const icsText=(value:string)=>value.replace(/\\/g,'\\\\').replace(/;/g,'\\;').replace(/,/g,'\\,').replace(/\r?\n/g,'\\n');
const icsDate=(value:string|Date)=>new Date(value).toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,'');
export function deadlineIcs(milestones:Row[],now=new Date()):string{
 const lines=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Death Of The Salesman//Funding deadlines//EN','CALSCALE:GREGORIAN','METHOD:PUBLISH'];
 for(const m of milestones){const p=m.provenance??{};lines.push('BEGIN:VEVENT',`UID:${m.id}@funding.dots`,`DTSTAMP:${icsDate(now)}`,`DTSTART:${icsDate(m.due_at)}`,`DTEND:${icsDate(new Date(new Date(m.due_at).getTime()+30*60_000))}`,
  `SUMMARY:${icsText(String(m.label))}`,`DESCRIPTION:${icsText(`Kind: ${m.kind}. Timezone: ${m.timezone}. Source: ${p.sourceUrl??'not recorded'} (verified ${p.sourceVerifiedAt??'unknown'}). Deadline as published: ${p.deadlineAsPublished??'n/a'}. Submission is performed manually by the owner; this system never submits.`)}`,'END:VEVENT');}
 lines.push('END:VCALENDAR');return lines.map(l=>l.length>74?l.match(/.{1,74}/g)!.join('\r\n '):l).join('\r\n')+'\r\n';
}
export const fundingConnectors=[
 {id:'grants_gov',label:'Grants.gov search (US federal)',access:'public_api',url:'https://api.grants.gov/v1/api/search2'},
 {id:'manual',label:'Manual import with source evidence',access:'owner',url:null},
 {id:'candid',label:'Candid foundation directory',access:'blocked_external_prerequisite',url:null,prerequisite:'Requires an owner-purchased Candid API subscription and a CANDID_API_KEY secret; not enabled at $0.'},
] as const;

// ---------------------------------------------------------------- workspace
export class FundingWorkspace {
 private readonly control:ControlPlane;
 constructor(private readonly client:Client,private readonly ctx:Context){this.control=new ControlPlane(client,ctx);}
 private run<T>(fn:(tx:Client)=>Promise<T>){return tenant(this.client,this.ctx,fn);}

 // ---- DOTS-121 directory
 private async upsertSource(tx:Client,input:Row){
  const prior=await one(tx,'SELECT * FROM app.funding_sources WHERE organization_id=$1 AND connector=$2 AND external_id=$3 FOR UPDATE',[this.ctx.organizationId,input.connector,input.externalId]);
  const values=[this.ctx.organizationId,input.kind,input.name,input.funder,input.sourceUrl,input.geography,input.entityEligibility,input.programType,input.minAwardCents,input.maxAwardCents,input.deadline,input.deadlineTimezone,input.connector,input.externalId,JSON.stringify(input.provenance),input.verifiedAt,input.refreshDays];
  const source=prior?(await one(tx,`UPDATE app.funding_sources SET kind=$2,name=$3,funder=$4,source_url=$5,geography=$6,entity_eligibility=$7,program_type=$8,min_award_cents=$9,max_award_cents=$10,deadline=$11,deadline_timezone=$12,provenance=$15::jsonb,verified_at=$16,refresh_days=$17,status='active',version=version+1,updated_at=app.utc_now() WHERE organization_id=$1 AND connector=$13 AND external_id=$14 RETURNING *`,values))!
   :(await one(tx,`INSERT INTO app.funding_sources(organization_id,kind,name,funder,source_url,geography,entity_eligibility,program_type,min_award_cents,max_award_cents,deadline,deadline_timezone,connector,external_id,provenance,verified_at,refresh_days) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17) RETURNING *`,values))!;
  const snapshot={...source};delete snapshot.version;delete snapshot.updated_at;
  await tx.query('INSERT INTO app.funding_source_revisions(organization_id,source_id,revision,snapshot,content_hash) VALUES($1,$2,$3,$4::jsonb,$5)',[this.ctx.organizationId,source.id,Number(source.version),JSON.stringify(snapshot),digest(snapshot)]);
  return {source,created:!prior};
 }
 /** Manual import: requires an https source URL, a description of the evidence and when it was retrieved. */
 async importSource(input:{kind:string;name:string;funder:string;sourceUrl:string;evidence:string;retrievedAt:string;geography?:string[];entityEligibility?:string[];programType?:string;minAwardCents?:number|null;maxAwardCents?:number|null;deadline?:string|null;deadlineTimezone?:string;refreshDays?:number;externalId?:string}){
  const sourceUrl=httpsUrl(input.sourceUrl);const verifiedAt=pastOrNow(input.retrievedAt,'retrieved_at');const refreshDays=input.refreshDays??14;
  if(!Number.isSafeInteger(refreshDays)||refreshDays<1||refreshDays>365)return fail('INVALID_REFRESH_DAYS',400);
  const normalized={kind:selection(input.kind,fundingSourceKinds,'source_kind'),name:text(input.name,'name',240),funder:text(input.funder,'funder',240),sourceUrl,
   geography:list(input.geography,'geography').map(g=>g.toUpperCase()),entityEligibility:list(input.entityEligibility,'entity_eligibility').map(e=>e.toLowerCase()),programType:input.programType?text(input.programType,'program_type',80):'unspecified',
   minAwardCents:optionalCents(input.minAwardCents),maxAwardCents:optionalCents(input.maxAwardCents),deadline:dateOrNull(input.deadline),deadlineTimezone:timezone(input.deadlineTimezone??'UTC'),
   connector:'manual',externalId:input.externalId?text(input.externalId,'external_id',200):digest(sourceUrl).slice(0,40),verifiedAt,refreshDays,
   provenance:{connector:'manual',evidence:text(input.evidence,'evidence',1000),retrievedAt:verifiedAt,recordedBy:this.ctx.membershipId}};
  if(normalized.minAwardCents!==null&&normalized.maxAwardCents!==null&&normalized.minAwardCents>normalized.maxAwardCents)return fail('INVALID_AWARD_RANGE',400);
  return this.run(async tx=>{const {source,created}=await this.upsertSource(tx,normalized);
   await tx.query("INSERT INTO app.funding_connector_runs(organization_id,connector,state,result_count) VALUES($1,'manual','ok',1)",[this.ctx.organizationId]);
   await event(tx,this.ctx,created?'funding.source_imported':'funding.source_reverified',source.id,{connector:'manual',revision:Number(source.version)});return source;});
 }
 async addEligibilityRule(sourceId:string,input:{kind:string;allowed?:string[];description:string;citationUrl:string}){
  identifier(sourceId);const kind=selection(input.kind,eligibilityRuleKinds,'rule_kind');const allowed=list(input.allowed,'allowed');const description=text(input.description,'description',1000);const citation=httpsUrl(input.citationUrl,'citation_url');
  return this.run(async tx=>{const source=await one(tx,'SELECT id FROM app.funding_sources WHERE organization_id=$1 AND id=$2',[this.ctx.organizationId,sourceId]);if(!source)return fail('NOT_FOUND',404);
   const rule=(await one(tx,'INSERT INTO app.funding_eligibility_rules(organization_id,source_id,kind,allowed,description,citation_url) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[this.ctx.organizationId,sourceId,kind,allowed,description,citation]))!;
   await event(tx,this.ctx,'funding.rule_added',rule.id,{sourceId,kind});return rule;});
 }
 async listSources(filter:{geography?:string;entityType?:string;kind?:string;programType?:string;deadlineAfter?:string;deadlineBefore?:string;includeArchived?:boolean}={}){
  const geography=filter.geography?text(filter.geography,'geography',80).toUpperCase():null,entity=filter.entityType?text(filter.entityType,'entity_type',80).toLowerCase():null;
  const kind=filter.kind?selection(filter.kind,fundingSourceKinds,'source_kind'):null,program=filter.programType?text(filter.programType,'program_type',80):null;
  return this.run(async tx=>rows(await tx.query(`SELECT s.*,(s.verified_at+make_interval(days=>s.refresh_days))<app.utc_now() AS needs_recheck,
   (SELECT count(*)::int FROM app.funding_source_revisions r WHERE r.organization_id=s.organization_id AND r.source_id=s.id) AS revisions
   FROM app.funding_sources s WHERE s.organization_id=$1 AND ($2::text IS NULL OR $2=ANY(s.geography) OR 'GLOBAL'=ANY(s.geography)) AND ($3::text IS NULL OR $3=ANY(s.entity_eligibility))
   AND ($4::text IS NULL OR s.kind=$4) AND ($5::text IS NULL OR s.program_type=$5) AND ($6::timestamptz IS NULL OR s.deadline>=$6) AND ($7::timestamptz IS NULL OR s.deadline<=$7) AND ($8 OR s.status<>'archived')
   ORDER BY s.deadline NULLS LAST,s.name LIMIT 200`,[this.ctx.organizationId,geography,entity,kind,program,dateOrNull(filter.deadlineAfter),dateOrNull(filter.deadlineBefore),filter.includeArchived===true])));
 }

 // ---- DOTS-122 connectors
 async discover(connector:string,keyword:string,transport:typeof fetch=fetch){
  selection(connector,fundingConnectors.map(c=>c.id),'connector');const query=text(keyword,'keyword',120);
  if(connector==='candid')return this.run(async tx=>{await tx.query("INSERT INTO app.funding_connector_runs(organization_id,connector,state,reason_code,query_hash) VALUES($1,'candid','blocked_external_prerequisite','CANDID_API_SUBSCRIPTION_REQUIRED',$2)",[this.ctx.organizationId,digest(query)]);return {connector,state:'blocked_external_prerequisite',reasonCode:'CANDID_API_SUBSCRIPTION_REQUIRED',imported:0,programs:[] as Row[]};});
  if(connector==='manual')return fail('USE_MANUAL_IMPORT',400);
  let found:Awaited<ReturnType<typeof discoverGrants>>;
  try{found=await discoverGrants(query,transport);}catch(error){
   const reasonCode=(error as {code?:string})?.code&&/^[A-Z_]+$/.test(String((error as {code?:string}).code))?String((error as {code:string}).code):'GRANT_SOURCE_UNREACHABLE';
   return this.run(async tx=>{await tx.query("INSERT INTO app.funding_connector_runs(organization_id,connector,state,reason_code,query_hash) VALUES($1,'grants_gov','waiting',$2,$3)",[this.ctx.organizationId,reasonCode,digest(query)]);await event(tx,this.ctx,'funding.connector_waiting',null,{connector,reasonCode},'provider');return {connector,state:'waiting',reasonCode,imported:0,programs:[] as Row[]};});
  }
  return this.run(async tx=>{const programs:Row[]=[];
   for(const hit of found.opportunities){
    const date=/^(\d{2})\/(\d{2})\/(\d{4})$/.exec(hit.deadline);const deadline=date?zonedInstant(Number(date[3]),Number(date[1]),Number(date[2]),0,0,'America/New_York').toISOString():null;
    const {source}=await this.upsertSource(tx,{kind:'grant_program',name:hit.title||`Grants.gov opportunity ${hit.id}`,funder:hit.agency||'Unspecified federal agency',sourceUrl:hit.url,geography:['US'],entityEligibility:[],programType:'federal_grant',minAwardCents:null,maxAwardCents:null,deadline,deadlineTimezone:'America/New_York',connector:'grants_gov',externalId:hit.id,verifiedAt:found.queriedAt,refreshDays:7,
     provenance:{connector:'grants_gov',queriedAt:found.queriedAt,opportunityNumber:hit.number,deadlineAsPublished:hit.deadline||null,timeOfDayUnverified:true,eligibilityNote:hit.eligibility,responseDigest:digest(hit)}});
    programs.push(source);
   }
   await tx.query("INSERT INTO app.funding_connector_runs(organization_id,connector,state,query_hash,result_count) VALUES($1,'grants_gov','ok',$2,$3)",[this.ctx.organizationId,digest(query),programs.length]);
   await event(tx,this.ctx,'funding.connector_synced',null,{connector,imported:programs.length},'provider');return {connector,state:'ok',reasonCode:null,imported:programs.length,programs};});
 }
 async connectorStatus(){return this.run(async tx=>{const latest=rows(await tx.query('SELECT DISTINCT ON(connector) connector,state,reason_code,result_count,observed_at FROM app.funding_connector_runs WHERE organization_id=$1 ORDER BY connector,observed_at DESC',[this.ctx.organizationId]));
  return fundingConnectors.map(c=>{const run=latest.find(r=>r.connector===c.id);return {...c,state:c.access==='blocked_external_prerequisite'?'blocked_external_prerequisite':run?.state??'not_run',reasonCode:run?.reason_code??null,lastResultCount:run?.result_count??0,observedAt:run?.observed_at??null};});});}

 // ---- DOTS-123 eligibility
 async setApplicantProfile(projectId:string,input:{entityType:string;jurisdiction:string;stage:string;documents?:Record<string,string>;restrictionsConfirmed?:string[]}){
  identifier(projectId);const entity=text(input.entityType,'entity_type',80).toLowerCase(),jurisdiction=text(input.jurisdiction,'jurisdiction',40).toUpperCase(),stage=text(input.stage,'stage',80).toLowerCase();
  const documents=input.documents??{};if(typeof documents!=='object'||Array.isArray(documents)||Object.keys(documents).length>50)return fail('INVALID_DOCUMENTS',400);
  for(const [kind,id] of Object.entries(documents)){text(kind,'document_kind',80);identifier(id);}
  const confirmed=list(input.restrictionsConfirmed,'restrictions_confirmed',50);confirmed.forEach(identifier);
  return this.run(async tx=>{for(const id of Object.values(documents))if(!await one(tx,'SELECT id FROM app.document_library WHERE organization_id=$1 AND id=$2',[this.ctx.organizationId,id]))return fail('DOCUMENT_NOT_FOUND',404);
   const profile=(await one(tx,`INSERT INTO app.funding_applicant_profiles(organization_id,project_id,entity_type,jurisdiction,stage,documents,restrictions_confirmed) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)
    ON CONFLICT(organization_id,project_id) DO UPDATE SET entity_type=$3,jurisdiction=$4,stage=$5,documents=$6::jsonb,restrictions_confirmed=$7,version=app.funding_applicant_profiles.version+1,updated_at=app.utc_now() RETURNING *`,[this.ctx.organizationId,projectId,entity,jurisdiction,stage,JSON.stringify(documents),confirmed]))!;
   await event(tx,this.ctx,'funding.profile_updated',projectId,{version:Number(profile.version)});return profile;});
 }
 async evaluateEligibility(opportunityId:string,now=new Date(),staleDays=DEFAULT_ELIGIBILITY_STALE_DAYS){identifier(opportunityId);return this.run(async tx=>{
  const opportunity=await one(tx,'SELECT * FROM app.funding_opportunities WHERE organization_id=$1 AND id=$2',[this.ctx.organizationId,opportunityId]);if(!opportunity)return fail('NOT_FOUND',404);
  if(!opportunity.source_id)return fail('LINK_FUNDING_SOURCE_FIRST',409);
  const source=(await one(tx,'SELECT * FROM app.funding_sources WHERE organization_id=$1 AND id=$2',[this.ctx.organizationId,opportunity.source_id]))!;
  const rules=rows(await tx.query("SELECT * FROM app.funding_eligibility_rules WHERE organization_id=$1 AND source_id=$2 AND status='active' ORDER BY created_at,id",[this.ctx.organizationId,source.id])) as EligibilityRule[];
  const profile=(await one(tx,'SELECT * FROM app.funding_applicant_profiles WHERE organization_id=$1 AND project_id=$2',[this.ctx.organizationId,opportunity.project_id])) as ApplicantProfile|undefined;
  const effectiveStale=Math.min(staleDays,Number(source.refresh_days)*2);
  const evaluation=evaluateEligibility({profile:profile??null,rules,source:{url:source.source_url,verifiedAt:source.verified_at},deadline:source.deadline??opportunity.deadline,now,staleDays:effectiveStale});
  const saved=(await one(tx,'INSERT INTO app.funding_eligibility_results(organization_id,opportunity_id,source_id,result,explanation,citation_url,source_verified_at,source_revision,profile_hash) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9) RETURNING *',
   [this.ctx.organizationId,opportunityId,source.id,evaluation.result,JSON.stringify(evaluation.explanation),source.source_url,source.verified_at,Number(source.version),digest(profile??null)]))!;
  await event(tx,this.ctx,'funding.eligibility_evaluated',opportunityId,{result:evaluation.result,resultId:saved.id});return {...saved,citation:evaluation.citation};
 });}

 // ---- DOTS-124 pipeline
 async createOpportunity(input:{projectId:string;kind:string;label:string;sourceId?:string;investorId?:string;funder?:string;ownerLabel?:string;rangeMinCents?:number|null;rangeMaxCents?:number|null;requestedCents?:number;deadline?:string|null;restrictions?:string}){
  identifier(input.projectId);const kind=selection(input.kind,['grant','investment','sponsorship','partnership'],'funding_kind');const label=text(input.label,'opportunity',200);
  const min=optionalCents(input.rangeMinCents),max=optionalCents(input.rangeMaxCents);if(min!==null&&max!==null&&min>max)return fail('INVALID_AWARD_RANGE',400);
  if(input.sourceId)identifier(input.sourceId);if(input.investorId)identifier(input.investorId);if(kind==='investment'&&!input.investorId)return fail('INVESTOR_REQUIRED',400);if(kind!=='investment'&&input.investorId)return fail('INVESTOR_ONLY_FOR_INVESTMENT',400);
  return this.run(async tx=>{
   const source=input.sourceId?await one(tx,'SELECT * FROM app.funding_sources WHERE organization_id=$1 AND id=$2',[this.ctx.organizationId,input.sourceId]):null;if(input.sourceId&&!source)return fail('NOT_FOUND',404);
   if(source&&kind==='grant'&&!['grant_program','foundation','government_agency'].includes(source.kind))return fail('SOURCE_FAMILY_MISMATCH',400);
   if(source&&(kind==='sponsorship'||kind==='partnership')&&!['sponsor','partner','foundation'].includes(source.kind))return fail('SOURCE_FAMILY_MISMATCH',400);
   if(source&&kind==='investment'&&source.kind!=='investor_fund')return fail('SOURCE_FAMILY_MISMATCH',400);
   const investor=input.investorId?await one(tx,'SELECT * FROM app.investor_organizations WHERE organization_id=$1 AND id=$2',[this.ctx.organizationId,input.investorId]):null;if(input.investorId&&!investor)return fail('NOT_FOUND',404);
   const funder=text(input.funder??source?.funder??investor?.name,'funder',200);
   const result=(await one(tx,`INSERT INTO app.funding_opportunities(organization_id,project_id,kind,label,funder,source_url,eligibility,deadline,requested_cents,restrictions,source_id,investor_id,owner_label,range_min_cents,range_max_cents)
    VALUES($1,$2,$3,$4,$5,$6,'',$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,[this.ctx.organizationId,input.projectId,kind,label,funder,source?.source_url??null,dateOrNull(input.deadline)??source?.deadline??null,cents(input.requestedCents??0),(input.restrictions??'').slice(0,2000),source?.id??null,investor?.id??null,input.ownerLabel?text(input.ownerLabel,'owner_label',120):null,min??source?.min_award_cents??null,max??source?.max_award_cents??null]))!;
   if(kind==='grant')for(const item of ['Verify source and eligibility','Collect required documents','Review application and claims','Owner submission authorization'])await tx.query('INSERT INTO app.funding_checklist(organization_id,opportunity_id,label) VALUES($1,$2,$3)',[this.ctx.organizationId,result.id,item]);
   await event(tx,this.ctx,'funding.created',result.id,{kind,sourceId:source?.id??null});return result;
  });
 }
 private async cards(tx:Client,now:Date){
  const list=rows(await tx.query(`SELECT o.*,s.source_url AS directory_url,s.verified_at AS source_verified_at,s.provenance AS source_provenance,
   e.result AS eligibility_result,e.evaluated_at AS eligibility_evaluated_at,e.citation_url AS eligibility_citation,
   a.status AS application_status,w.status AS award_status,w.amount_cents AS award_cents,
   COALESCE((SELECT sum(amount_cents) FROM app.funding_receipts r WHERE r.organization_id=o.organization_id AND r.opportunity_id=o.id),0)::bigint AS received_cents,
   COALESCE((SELECT sum(amount_cents) FROM app.investment_commitment_events c WHERE c.organization_id=o.organization_id AND c.opportunity_id=o.id AND c.stage='signed_commitment'),0)::bigint AS signed_commitment_cents,
   EXISTS(SELECT 1 FROM app.investment_commitment_events c WHERE c.organization_id=o.organization_id AND c.opportunity_id=o.id AND c.stage IN ('interest','term_sheet')) AS has_interest,
   sw.stage AS sponsorship_stage
   FROM app.funding_opportunities o LEFT JOIN app.funding_sources s ON s.organization_id=o.organization_id AND s.id=o.source_id
   LEFT JOIN LATERAL (SELECT result,evaluated_at,citation_url FROM app.funding_eligibility_results x WHERE x.organization_id=o.organization_id AND x.opportunity_id=o.id ORDER BY evaluated_at DESC,id DESC LIMIT 1) e ON true
   LEFT JOIN app.funding_applications a ON a.organization_id=o.organization_id AND a.opportunity_id=o.id
   LEFT JOIN LATERAL (SELECT status,amount_cents FROM app.funding_awards x WHERE x.organization_id=o.organization_id AND x.opportunity_id=o.id AND x.status IN ('offered','accepted') ORDER BY created_at DESC LIMIT 1) w ON true
   LEFT JOIN app.sponsorship_workflows sw ON sw.organization_id=o.organization_id AND sw.opportunity_id=o.id
   WHERE o.organization_id=$1 ORDER BY o.deadline NULLS LAST,o.created_at DESC LIMIT 300`,[this.ctx.organizationId]));
  return list.map(o=>{const receivedCents=Number(o.received_cents),signedCommitmentCents=Number(o.signed_commitment_cents);
   return {id:o.id,projectId:o.project_id,kind:o.kind,label:o.label,funder:o.funder,stage:o.stage,version:Number(o.version),owner:o.owner_label??'Unassigned',
    rangeMinCents:o.range_min_cents===null?null:Number(o.range_min_cents),rangeMaxCents:o.range_max_cents===null?null:Number(o.range_max_cents),requestedCents:Number(o.requested_cents),
    deadline:o.deadline,urgency:fundingUrgency(o.deadline,now),sourceUrl:o.directory_url??o.source_url,sourceVerifiedAt:o.source_verified_at??null,
    eligibility:o.eligibility_result?{result:o.eligibility_result,evaluatedAt:o.eligibility_evaluated_at,citation:o.eligibility_citation}:{result:'unknown',evaluatedAt:null,citation:null},
    applicationStatus:o.application_status??null,awardStatus:o.award_status??null,awardCents:o.award_cents===null||o.award_cents===undefined?null:Number(o.award_cents),
    receivedCents,signedCommitmentCents,hasInterest:Boolean(o.has_interest),sponsorshipStage:o.sponsorship_stage??null,
    statusClass:fundingStatusClass({receivedCents,signedCommitmentCents,sponsorshipSigned:['signed','exchanged'].includes(o.sponsorship_stage),awardStatus:o.award_status??null,applicationStatus:o.application_status??null})};});
 }
 async pipeline(now=new Date()){return this.run(async tx=>{const cards=await this.cards(tx,now);
  return {grants:cards.filter(c=>c.kind==='grant'),investors:cards.filter(c=>c.kind==='investment'),sponsorships:cards.filter(c=>c.kind==='sponsorship'||c.kind==='partnership')};});}

 // ---- DOTS-125 applications
 async openApplication(opportunityId:string,input:{questions:{key:string;prompt:string}[];documents?:{label:string;required?:boolean}[]}){
  identifier(opportunityId);if(!Array.isArray(input.questions)||!input.questions.length||input.questions.length>50)return fail('QUESTIONS_REQUIRED',400);
  const questions=input.questions.map(q=>({key:text(q.key,'question_key',80).toLowerCase(),prompt:text(q.prompt,'prompt',2000)}));if(questions.some(q=>!/^[a-z0-9_.-]+$/.test(q.key)))return fail('INVALID_QUESTION_KEY',400);
  const documents=(input.documents??[]).map(d=>({label:text(d.label,'document_label',200),required:d.required!==false}));
  return this.run(async tx=>{const opportunity=await one(tx,'SELECT * FROM app.funding_opportunities WHERE organization_id=$1 AND id=$2',[this.ctx.organizationId,opportunityId]);if(!opportunity)return fail('NOT_FOUND',404);if(opportunity.kind!=='grant')return fail('APPLICATIONS_ARE_GRANT_ONLY',400);
   const prior=await one(tx,'SELECT * FROM app.funding_applications WHERE organization_id=$1 AND opportunity_id=$2',[this.ctx.organizationId,opportunityId]);
   const application=prior??(await one(tx,'INSERT INTO app.funding_applications(organization_id,opportunity_id) VALUES($1,$2) RETURNING *',[this.ctx.organizationId,opportunityId]))!;
   if(prior&&!['draft','in_review'].includes(prior.status))return fail('APPLICATION_LOCKED');
   for(const q of questions)await tx.query('INSERT INTO app.funding_application_answers(organization_id,application_id,question_key,prompt) VALUES($1,$2,$3,$4) ON CONFLICT(organization_id,application_id,question_key) DO NOTHING',[this.ctx.organizationId,application.id,q.key,q.prompt]);
   for(const d of documents)await tx.query('INSERT INTO app.funding_application_documents(organization_id,application_id,label,required) VALUES($1,$2,$3,$4) ON CONFLICT(organization_id,application_id,label) DO NOTHING',[this.ctx.organizationId,application.id,d.label,d.required]);
   await event(tx,this.ctx,prior?'funding.application_extended':'funding.application_opened',application.id,{questions:questions.length,documents:documents.length});return application;});
 }
 private async approvedFacts(tx:Client,projectId:string):Promise<Fact[]>{
  const org=rows(await tx.query("SELECT id,statement,category FROM app.funding_org_facts WHERE organization_id=$1 AND project_id=$2 AND status='approved' ORDER BY id",[this.ctx.organizationId,projectId]));
  const product=rows(await tx.query("SELECT id,label,content FROM app.vetted_product_facts WHERE organization_id=$1 AND project_id=$2 AND status='active' ORDER BY id",[this.ctx.organizationId,projectId]));
  return [...org.map(f=>({id:`org:${f.id}`,statement:String(f.statement),category:String(f.category)})),...product.map(f=>({id:`product:${f.id}`,statement:`${f.label}${typeof f.content?.statement==='string'?`: ${f.content.statement}`:''}`,category:'product'}))];
 }
 private async answerContext(tx:Client,answerId:string){
  const answer=await one(tx,`SELECT x.*,a.status AS application_status,o.project_id FROM app.funding_application_answers x JOIN app.funding_applications a ON a.organization_id=x.organization_id AND a.id=x.application_id JOIN app.funding_opportunities o ON o.organization_id=a.organization_id AND o.id=a.opportunity_id WHERE x.organization_id=$1 AND x.id=$2 FOR UPDATE OF x`,[this.ctx.organizationId,answerId]);
  if(!answer)return fail('NOT_FOUND',404);if(!['draft','in_review'].includes(answer.application_status))return fail('APPLICATION_LOCKED');return answer;
 }
 /** Saves a draft answer. Unsupported organizational claims are blocked and the attempt is recorded. */
 async saveAnswer(answerId:string,input:{answer:string;citations?:string[];version:number;source?:'owner'|'model'}){
  identifier(answerId);const content=text(input.answer,'answer',20000);const citations=list(input.citations,'citations',30);const source=selection(input.source??'owner',['owner','model'],'answer_source');
  return this.run(async tx=>{const answer=await this.answerContext(tx,answerId);
   const findings=findUnsupportedClaims(content,await this.approvedFacts(tx,answer.project_id),citations);
   if(findings.length){await event(tx,this.ctx,'funding.claim_blocked',answerId,{findings:findings.map(f=>f.reason),source});return {saved:false,findings};}
   const saved=await one(tx,"UPDATE app.funding_application_answers SET answer=$3,citations=$4::jsonb,status='draft',source=$5,version=version+1,updated_at=app.utc_now() WHERE organization_id=$1 AND id=$2 AND version=$6 RETURNING *",[this.ctx.organizationId,answerId,content,JSON.stringify(citations),source,input.version]);
   if(!saved)return fail('STALE_RECORD');await tx.query("UPDATE app.funding_applications SET status='draft',version=version+1,updated_at=app.utc_now() WHERE organization_id=$1 AND id=$2 AND status='in_review'",[this.ctx.organizationId,answer.application_id]);
   await event(tx,this.ctx,'funding.answer_saved',answerId,{source,citations:citations.length});return {saved:true,findings:[] as ClaimFinding[],answer:saved};});
 }
 /** Assembles a narrative strictly from approved facts, with numbered citations. */
 async assembleAnswer(answerId:string,factIds:string[],version:number){
  identifier(answerId);const ids=list(factIds,'fact_ids',30);if(!ids.length)return fail('FACTS_REQUIRED',400);
  return this.run(async tx=>{const answer=await this.answerContext(tx,answerId);const facts=await this.approvedFacts(tx,answer.project_id);
   const chosen=ids.map(id=>facts.find(f=>f.id===id));if(chosen.some(f=>!f))return fail('UNAPPROVED_FACT',422);
   const narrative=chosen.map((f,i)=>`${f!.statement.trim().replace(/[.!?]+$/,'')} [${i+1}].`).join(' ');
   const saved=await one(tx,"UPDATE app.funding_application_answers SET answer=$3,citations=$4::jsonb,status='draft',source='assembled',version=version+1,updated_at=app.utc_now() WHERE organization_id=$1 AND id=$2 AND version=$5 RETURNING *",[this.ctx.organizationId,answerId,narrative.slice(0,20000),JSON.stringify(ids),version]);
   if(!saved)return fail('STALE_RECORD');await event(tx,this.ctx,'funding.answer_assembled',answerId,{facts:ids.length});return saved;});
 }
 async markAnswerReviewed(answerId:string,version:number){identifier(answerId);return this.run(async tx=>{const answer=await this.answerContext(tx,answerId);if(!answer.answer)return fail('ANSWER_EMPTY');
  const findings=findUnsupportedClaims(answer.answer,await this.approvedFacts(tx,answer.project_id),answer.citations);if(findings.length)return fail('UNSUPPORTED_CLAIM',422);
  const saved=await one(tx,"UPDATE app.funding_application_answers SET status='reviewed',version=version+1,updated_at=app.utc_now() WHERE organization_id=$1 AND id=$2 AND version=$3 RETURNING *",[this.ctx.organizationId,answerId,version]);if(!saved)return fail('STALE_RECORD');
  await event(tx,this.ctx,'funding.answer_reviewed',answerId);return saved;});}
 async attachDocument(applicationDocumentId:string,documentId:string,privacyClass='private'){identifier(applicationDocumentId);identifier(documentId);const privacy=selection(privacyClass,['private','model_allowed'],'privacy_class');
  return this.run(async tx=>{if(!await one(tx,'SELECT id FROM app.document_library WHERE organization_id=$1 AND id=$2',[this.ctx.organizationId,documentId]))return fail('DOCUMENT_NOT_FOUND',404);
   const row=await one(tx,`UPDATE app.funding_application_documents d SET document_id=$3,privacy_class=$4 FROM app.funding_applications a WHERE d.organization_id=$1 AND d.id=$2 AND a.organization_id=d.organization_id AND a.id=d.application_id AND a.status IN ('draft','in_review') RETURNING d.*`,[this.ctx.organizationId,applicationDocumentId,documentId,privacy]);
   if(!row)return fail('NOT_FOUND_OR_LOCKED',404);await event(tx,this.ctx,'funding.document_attached',applicationDocumentId,{privacyClass:privacy});return row;});}
 async requestReview(applicationId:string){identifier(applicationId);return this.run(async tx=>{const app=await one(tx,"UPDATE app.funding_applications SET status='in_review',version=version+1,updated_at=app.utc_now() WHERE organization_id=$1 AND id=$2 AND status='draft' RETURNING *",[this.ctx.organizationId,applicationId]);if(!app)return fail('APPLICATION_NOT_DRAFT');await event(tx,this.ctx,'funding.application_review_requested',applicationId);return app;});}
 async reviewApplication(applicationId:string,decision:string,notes=''){identifier(applicationId);const d=selection(decision,['changes_requested','approved_for_submission_prep'],'decision');if(typeof notes!=='string'||notes.length>4000)return fail('INVALID_NOTES',400);
  return this.run(async tx=>{const app=await one(tx,'SELECT * FROM app.funding_applications WHERE organization_id=$1 AND id=$2 FOR UPDATE',[this.ctx.organizationId,applicationId]);if(!app)return fail('NOT_FOUND',404);if(app.status!=='in_review')return fail('REQUEST_REVIEW_FIRST');
   const answers=rows(await tx.query('SELECT question_key,answer,status FROM app.funding_application_answers WHERE organization_id=$1 AND application_id=$2 ORDER BY question_key',[this.ctx.organizationId,applicationId]));
   if(d==='approved_for_submission_prep'&&answers.some(a=>a.status!=='reviewed'))return fail('ANSWERS_NOT_REVIEWED');
   await tx.query('INSERT INTO app.funding_application_reviews(organization_id,application_id,reviewer_membership_id,decision,notes,content_hash) VALUES($1,$2,$3,$4,$5,$6)',[this.ctx.organizationId,applicationId,this.ctx.membershipId,d,notes,digest(answers)]);
   const saved=(await one(tx,'UPDATE app.funding_applications SET status=$3,version=version+1,updated_at=app.utc_now() WHERE organization_id=$1 AND id=$2 RETURNING *',[this.ctx.organizationId,applicationId,d==='approved_for_submission_prep'?'ready':'draft']))!;
   await event(tx,this.ctx,'funding.application_reviewed',applicationId,{decision:d});return saved;});}

 // ---- DOTS-126 organization facts and safe model payloads
 async addOrganizationFact(projectId:string,input:{label:string;statement:string;evidenceRef:string;category?:string}){identifier(projectId);const category=selection(input.category??'organization',['organization','financial','traction','team','program'],'fact_category');
  const label=text(input.label,'label',160),statement=text(input.statement,'statement',2000),evidence=text(input.evidenceRef,'evidence',500);
  return this.run(async tx=>{const fact=(await one(tx,'INSERT INTO app.funding_org_facts(organization_id,project_id,label,statement,evidence_ref,category) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[this.ctx.organizationId,projectId,label,statement,evidence,category]))!;await event(tx,this.ctx,'funding.fact_proposed',fact.id,{category});return fact;});}
 async approveOrganizationFact(factId:string,actor:Actor='owner'){assertHumanActor(actor,'AGENT_CANNOT_APPROVE_FACTS');identifier(factId);return this.run(async tx=>{const fact=await one(tx,"UPDATE app.funding_org_facts SET status='approved',approved_by_membership_id=$3,approved_at=app.utc_now() WHERE organization_id=$1 AND id=$2 AND status='pending' RETURNING *",[this.ctx.organizationId,factId,this.ctx.membershipId]);if(!fact)return fail('FACT_NOT_PENDING');await event(tx,this.ctx,'funding.fact_approved',factId);return fact;});}
 /** The only payload a model may receive for grant drafting: approved facts and question prompts. Document contents are never included. */
 async modelDraftPayload(applicationId:string){identifier(applicationId);return this.run(async tx=>this.draftPayload(tx,applicationId));}
 private async draftPayload(tx:Client,applicationId:string){
  const app=await one(tx,'SELECT a.*,o.project_id,o.label AS opportunity_label,o.funder FROM app.funding_applications a JOIN app.funding_opportunities o ON o.organization_id=a.organization_id AND o.id=a.opportunity_id WHERE a.organization_id=$1 AND a.id=$2',[this.ctx.organizationId,applicationId]);if(!app)return fail('NOT_FOUND',404);
  const questions=rows(await tx.query('SELECT question_key,prompt FROM app.funding_application_answers WHERE organization_id=$1 AND application_id=$2 ORDER BY question_key',[this.ctx.organizationId,applicationId]));
  const documents=rows(await tx.query('SELECT label,required,document_id IS NOT NULL AS attached,privacy_class FROM app.funding_application_documents WHERE organization_id=$1 AND application_id=$2 ORDER BY label',[this.ctx.organizationId,applicationId]));
  return {applicationId,opportunity:app.opportunity_label,funder:app.funder,questions:questions.map(q=>({key:q.question_key,prompt:q.prompt})),facts:await this.approvedFacts(tx,app.project_id),
   documents:documents.map(d=>({label:d.label,required:d.required,attached:d.attached,privacyClass:d.privacy_class})),
   rules:['Use only the listed facts and cite them as [n] in the order given.','Do not state any organizational, financial or traction claim that is not in a cited fact.','Never certify, sign or submit; output is a draft for owner review.'],projectId:app.project_id as string};
 }
 /** Queues a durable grant_draft task carrying only the safe payload; output still passes the claim gate on save. */
 async queueDraftTask(applicationId:string,agentId:string,idempotencyKey:string){identifier(applicationId);identifier(agentId);const key=text(idempotencyKey,'idempotency_key',200);
  const payload=await this.modelDraftPayload(applicationId);const brief=JSON.stringify({questions:payload.questions,facts:payload.facts,rules:payload.rules}).slice(0,6000);
  return this.control.enqueue(payload.projectId,agentId,'grant_draft',{mode:'simulation',publicDataOnly:true,applicationId,payloadHash:digest(payload),brief},key);}

 // ---- DOTS-127 calendar and reminders
 async scheduleTimeline(opportunityId:string,zone='UTC'){identifier(opportunityId);const tz=timezone(zone);return this.run(async tx=>{
  const o=await one(tx,'SELECT o.*,s.source_url AS directory_url,s.verified_at,s.provenance FROM app.funding_opportunities o LEFT JOIN app.funding_sources s ON s.organization_id=o.organization_id AND s.id=o.source_id WHERE o.organization_id=$1 AND o.id=$2',[this.ctx.organizationId,opportunityId]);
  if(!o)return fail('NOT_FOUND',404);if(!o.deadline)return fail('DEADLINE_REQUIRED');const deadline=new Date(o.deadline).getTime();
  const provenance={sourceUrl:o.directory_url??o.source_url??null,sourceVerifiedAt:o.verified_at?new Date(o.verified_at).toISOString():null,deadlineAsPublished:o.provenance?.deadlineAsPublished??new Date(o.deadline).toISOString(),timezone:tz,autoSubmit:false};
  const plan:[string,string,number][]=[['draft_complete','Draft answers complete',21],['internal_review','Internal review of claims and documents',14],['owner_final_check','Owner final check before manual submission',3],['funder_deadline','Funder deadline (owner submits manually)',0]];
  let created=0;for(const [kind,label,days] of plan){const r=rows(await tx.query('INSERT INTO app.funding_milestones(organization_id,opportunity_id,kind,label,due_at,timezone,provenance) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT DO NOTHING RETURNING id',[this.ctx.organizationId,opportunityId,kind,`${label}: ${o.label}`,new Date(deadline-days*DAY).toISOString(),tz,JSON.stringify(provenance)]));created+=r.length;}
  await event(tx,this.ctx,'funding.timeline_scheduled',opportunityId,{created,timezone:tz});return {created};});}
 /** Creates owner alert records and stale-source recheck milestones. Never submits anything. */
 async refreshReminders(now=new Date(),windowDays=14){return this.run(async tx=>{
  const stale=rows(await tx.query("UPDATE app.funding_sources SET status='stale',version=version+1,updated_at=app.utc_now() WHERE organization_id=$1 AND status='active' AND verified_at+make_interval(days=>refresh_days)<$2 RETURNING id,name,source_url,verified_at",[this.ctx.organizationId,now.toISOString()]));
  const due=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate())).toISOString();
  for(const s of stale)await tx.query("INSERT INTO app.funding_milestones(organization_id,source_id,kind,label,due_at,timezone,provenance) VALUES($1,$2,'source_recheck',$3,$4,'UTC',$5::jsonb) ON CONFLICT DO NOTHING",[this.ctx.organizationId,s.id,`Re-verify program details: ${s.name}`.slice(0,200),due,JSON.stringify({sourceUrl:s.source_url,sourceVerifiedAt:new Date(s.verified_at).toISOString(),autoSubmit:false})]);
  const open=rows(await tx.query('SELECT * FROM app.funding_milestones WHERE organization_id=$1 AND completed_at IS NULL AND due_at<=$2',[this.ctx.organizationId,new Date(now.getTime()+windowDays*DAY).toISOString()]));
  let alerts=0;for(const m of open){const kind=new Date(m.due_at).getTime()<now.getTime()?'overdue':'upcoming';
   const r=rows(await tx.query('INSERT INTO app.funding_owner_alerts(organization_id,milestone_id,alert_kind,message) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id',[this.ctx.organizationId,m.id,kind,`${kind==='overdue'?'Overdue':'Upcoming'}: ${m.label} — due ${new Date(m.due_at).toISOString()} (${m.timezone}). Owner action required; nothing is submitted automatically.`.slice(0,500)]));alerts+=r.length;}
  await event(tx,this.ctx,'funding.reminders_refreshed',null,{staleSources:stale.length,alerts},'worker');return {staleSources:stale.length,alerts,submitted:0};});}
 async completeMilestone(id:string){identifier(id);return this.run(async tx=>{const m=await one(tx,'UPDATE app.funding_milestones SET completed_at=app.utc_now() WHERE organization_id=$1 AND id=$2 AND completed_at IS NULL RETURNING *',[this.ctx.organizationId,id]);if(!m)return fail('NOT_FOUND',404);
  await event(tx,this.ctx,'funding.milestone_completed',id);return m;});}
 async acknowledgeAlert(id:string){identifier(id);return this.run(async tx=>{const a=await one(tx,"UPDATE app.funding_owner_alerts SET state='acknowledged',acknowledged_at=app.utc_now() WHERE organization_id=$1 AND id=$2 AND state='open' RETURNING *",[this.ctx.organizationId,id]);if(!a)return fail('NOT_FOUND',404);await event(tx,this.ctx,'funding.alert_acknowledged',id);return a;});}
 async calendarIcs(now=new Date()){return this.run(async tx=>deadlineIcs(rows(await tx.query('SELECT * FROM app.funding_milestones WHERE organization_id=$1 AND completed_at IS NULL ORDER BY due_at LIMIT 500',[this.ctx.organizationId])),now));}

 // ---- DOTS-128 human-reviewed submission
 async certifyEligibility(applicationId:string,input:{signerName:string;statement:string},actor:Actor='owner',now=new Date()){
  assertHumanActor(actor,'AGENT_CANNOT_CERTIFY');identifier(applicationId);const signer=text(input.signerName,'signer_name',160),statement=text(input.statement,'statement',4000);
  return this.run(async tx=>{const app=await one(tx,'SELECT a.*,o.id AS opportunity_id FROM app.funding_applications a JOIN app.funding_opportunities o ON o.organization_id=a.organization_id AND o.id=a.opportunity_id WHERE a.organization_id=$1 AND a.id=$2',[this.ctx.organizationId,applicationId]);if(!app)return fail('NOT_FOUND',404);
   const latest=await one(tx,'SELECT * FROM app.funding_eligibility_results WHERE organization_id=$1 AND opportunity_id=$2 ORDER BY evaluated_at DESC,id DESC LIMIT 1',[this.ctx.organizationId,app.opportunity_id]);
   if(!latest||latest.result!=='eligible')return fail('ELIGIBILITY_NOT_ESTABLISHED',409);
   if(now.getTime()-new Date(latest.evaluated_at).getTime()>7*DAY)return fail('ELIGIBILITY_RESULT_STALE',409);
   const cert=(await one(tx,'INSERT INTO app.funding_certifications(organization_id,application_id,certified_by_membership_id,signer_name,statement,eligibility_result_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[this.ctx.organizationId,applicationId,this.ctx.membershipId,signer,statement,latest.id]))!;
   await event(tx,this.ctx,'funding.eligibility_certified',applicationId,{certificationId:cert.id});return cert;});
 }
 private async submissionPayload(tx:Client,applicationId:string,now:Date){
  const app=await one(tx,'SELECT a.*,o.project_id,o.label,o.funder,o.deadline,o.source_url FROM app.funding_applications a JOIN app.funding_opportunities o ON o.organization_id=a.organization_id AND o.id=a.opportunity_id WHERE a.organization_id=$1 AND a.id=$2 FOR UPDATE OF a',[this.ctx.organizationId,applicationId]);if(!app)return fail('NOT_FOUND',404);
  if(app.deadline&&new Date(app.deadline).getTime()<now.getTime())return fail('DEADLINE_PASSED');
  const answers=rows(await tx.query('SELECT id,question_key,answer,citations,status FROM app.funding_application_answers WHERE organization_id=$1 AND application_id=$2 ORDER BY question_key',[this.ctx.organizationId,applicationId]));
  if(!answers.length||answers.some(a=>a.status!=='reviewed'))return fail('ANSWERS_NOT_REVIEWED');
  const facts=await this.approvedFacts(tx,app.project_id);for(const a of answers)if(findUnsupportedClaims(a.answer,facts,a.citations).length)return fail('UNSUPPORTED_CLAIM',422);
  const docs=rows(await tx.query('SELECT d.label,d.required,d.document_id,l.content_hash FROM app.funding_application_documents d LEFT JOIN app.document_library l ON l.organization_id=d.organization_id AND l.id=d.document_id WHERE d.organization_id=$1 AND d.application_id=$2 ORDER BY d.label',[this.ctx.organizationId,applicationId]));
  const missing=docs.filter(d=>d.required&&(!d.document_id||!d.content_hash));if(missing.length)return fail('REQUIRED_DOCUMENTS_MISSING',409);
  const cert=await one(tx,`SELECT c.* FROM app.funding_certifications c WHERE c.organization_id=$1 AND c.application_id=$2 AND c.eligibility_result_id=(SELECT id FROM app.funding_eligibility_results e WHERE e.organization_id=$1 AND e.opportunity_id=$3 ORDER BY evaluated_at DESC,id DESC LIMIT 1) ORDER BY certified_at DESC LIMIT 1`,[this.ctx.organizationId,applicationId,app.opportunity_id]);
  if(!cert)return fail('OWNER_CERTIFICATION_REQUIRED',403);
  return {app,payload:{applicationId,opportunityId:app.opportunity_id,funder:app.funder,opportunity:app.label,sourceUrl:app.source_url,answers:answers.map(a=>({key:a.question_key,answer:a.answer,citations:a.citations})),
   documents:docs.filter(d=>d.document_id).map(d=>({label:d.label,documentId:d.document_id,contentHash:d.content_hash})),certificationId:cert.id,eligibilityResultId:cert.eligibility_result_id,signer:cert.signer_name,submittedBy:'owner_manual'}};
 }
 /** Freezes the exact submission payload and requests an owner approval bound to its hash. */
 async prepareSubmission(applicationId:string,now=new Date()){identifier(applicationId);return this.run(async tx=>{
  const {app,payload}=await this.submissionPayload(tx,applicationId,now);if(app.status!=='ready')return fail('APPLICATION_NOT_READY');
  const policy=await one(tx,'SELECT version FROM app.policy_controls WHERE organization_id=$1',[this.ctx.organizationId]);if(!policy)return fail('POLICY_UNCONFIGURED');
  const approval=(await one(tx,"INSERT INTO app.action_approvals(organization_id,action_kind,record_id,payload_hash,policy_version,requested_by_membership_id,proposed_payload) VALUES($1,'grant_submission',$2,$3,$4,$5,$6::jsonb) RETURNING *",[this.ctx.organizationId,applicationId,digest(payload),policy.version,this.ctx.membershipId,JSON.stringify(payload)]))!;
  await tx.query("UPDATE app.funding_applications SET status='awaiting_owner_submission',approval_id=$3,submission_payload_hash=$4,version=version+1,updated_at=app.utc_now() WHERE organization_id=$1 AND id=$2",[this.ctx.organizationId,applicationId,approval.id,approval.payload_hash]);
  await event(tx,this.ctx,'approval.requested',approval.id,{kind:'grant_submission'});return {approval,payload,payloadHash:approval.payload_hash as string};});}
 /**
  * Records that the OWNER submitted the approved payload through the funder's own portal.
  * Requires the approved, unexpired approval for the exact current payload plus a provider receipt or owner-verified evidence.
  */
 async recordSubmission(applicationId:string,input:{approvalId:string;evidenceKind:string;evidenceRef:string},actor:Actor='owner',now=new Date()){
  assertHumanActor(actor,'AGENT_CANNOT_SUBMIT');identifier(applicationId);identifier(input.approvalId);const kind=selection(input.evidenceKind,['provider_receipt','owner_verified'],'evidence_kind');const evidence=text(input.evidenceRef,'evidence',240);
  return this.run(async tx=>{const current=await one(tx,'SELECT status FROM app.funding_applications WHERE organization_id=$1 AND id=$2',[this.ctx.organizationId,applicationId]);if(!current)return fail('NOT_FOUND',404);
   if(current.status==='submitted')return fail('ALREADY_SUBMITTED');if(current.status!=='awaiting_owner_submission')return fail('PREPARE_SUBMISSION_FIRST');
   const {payload}=await this.submissionPayload(tx,applicationId,now);
   const consumed=rows(await tx.query(`UPDATE app.action_approvals a SET status='consumed' FROM app.policy_controls p WHERE a.organization_id=$1 AND a.id=$2 AND a.action_kind='grant_submission' AND a.record_id=$3 AND a.payload_hash=$4 AND a.status='approved' AND a.expires_at>app.utc_now() AND p.organization_id=a.organization_id AND p.version=a.policy_version RETURNING a.id`,[this.ctx.organizationId,input.approvalId,applicationId,digest(payload)]));
   if(!consumed.length)return fail('APPROVAL_INVALID',403);
   const app=(await one(tx,"UPDATE app.funding_applications SET status='submitted',submission_evidence_kind=$3,submission_evidence_ref=$4,submitted_by_membership_id=$5,submitted_at=app.utc_now(),version=version+1,updated_at=app.utc_now() WHERE organization_id=$1 AND id=$2 RETURNING *",[this.ctx.organizationId,applicationId,kind,evidence,this.ctx.membershipId]))!;
   await tx.query("UPDATE app.funding_opportunities SET stage='submitted',owner_authority_ref=$3,version=version+1,updated_at=app.utc_now() WHERE organization_id=$1 AND id=$2",[this.ctx.organizationId,app.opportunity_id,`${kind}:${evidence}`.slice(0,240)]);
   await event(tx,this.ctx,'funding.application_submitted_by_owner',applicationId,{evidenceKind:kind,approvalId:input.approvalId});return app;});
 }

 // ---- DOTS-129 awards, restrictions, disbursements
 async recordAward(opportunityId:string,input:{amountCents:number;restrictedCents?:number;offerEvidenceRef:string}){identifier(opportunityId);const amount=positive(input.amountCents),restricted=cents(input.restrictedCents??0);if(restricted>amount)return fail('RESTRICTED_EXCEEDS_AWARD',400);const evidence=text(input.offerEvidenceRef,'evidence',240);
  return this.run(async tx=>{const o=await one(tx,'SELECT * FROM app.funding_opportunities WHERE organization_id=$1 AND id=$2',[this.ctx.organizationId,opportunityId]);if(!o)return fail('NOT_FOUND',404);if(o.kind!=='grant')return fail('AWARDS_ARE_GRANT_ONLY',400);
   const app=await one(tx,'SELECT status FROM app.funding_applications WHERE organization_id=$1 AND opportunity_id=$2',[this.ctx.organizationId,opportunityId]);if(app?.status!=='submitted')return fail('SUBMITTED_APPLICATION_REQUIRED');
   const award=(await one(tx,'INSERT INTO app.funding_awards(organization_id,opportunity_id,amount_cents,restricted_cents,offer_evidence_ref) VALUES($1,$2,$3,$4,$5) RETURNING *',[this.ctx.organizationId,opportunityId,amount,restricted,evidence]))!;
   await event(tx,this.ctx,'funding.award_offered',award.id,{amountCents:amount,cash:false});return award;});}
 async decideAward(awardId:string,accept:boolean,version:number,authorityRef?:string,actor:Actor='owner'){assertHumanActor(actor,'AGENT_CANNOT_ACCEPT_AWARD');identifier(awardId);if(accept&&!authorityRef)return fail('OWNER_AUTHORITY_REFERENCE_REQUIRED',403);
  return this.run(async tx=>{const award=await one(tx,`UPDATE app.funding_awards SET status=$3,acceptance_authority_ref=$4,accepted_by_membership_id=$5,accepted_at=CASE WHEN $3='accepted' THEN app.utc_now() END,version=version+1 WHERE organization_id=$1 AND id=$2 AND status='offered' AND version=$6 RETURNING *`,[this.ctx.organizationId,awardId,accept?'accepted':'declined',accept?text(authorityRef,'authority',240):null,accept?this.ctx.membershipId:null,version]);
   if(!award)return fail('STALE_RECORD');if(accept)await tx.query("UPDATE app.funding_opportunities SET stage='awarded',version=version+1,updated_at=app.utc_now() WHERE organization_id=$1 AND id=$2",[this.ctx.organizationId,award.opportunity_id]);
   await event(tx,this.ctx,accept?'funding.award_accepted':'funding.award_declined',awardId,{cash:false});return award;});}
 async addRestriction(awardId:string,input:{purpose:string;amountCents:number;expiresAt?:string|null;evidenceRef:string}){identifier(awardId);const amount=positive(input.amountCents);const purpose=text(input.purpose,'purpose',500),evidence=text(input.evidenceRef,'evidence',240);
  return this.run(async tx=>{const award=await one(tx,'SELECT * FROM app.funding_awards WHERE organization_id=$1 AND id=$2 FOR UPDATE',[this.ctx.organizationId,awardId]);if(!award)return fail('NOT_FOUND',404);
   const used=Number((await one(tx,'SELECT COALESCE(sum(amount_cents),0)::bigint AS total FROM app.funding_restrictions WHERE organization_id=$1 AND award_id=$2',[this.ctx.organizationId,awardId]))!.total);
   if(used+amount>Number(award.restricted_cents))return fail('RESTRICTIONS_EXCEED_RESTRICTED_AMOUNT',409);
   const r=(await one(tx,'INSERT INTO app.funding_restrictions(organization_id,award_id,purpose,amount_cents,expires_at,evidence_ref) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[this.ctx.organizationId,awardId,purpose,amount,dateOrNull(input.expiresAt),evidence]))!;
   await event(tx,this.ctx,'funding.restriction_recorded',r.id,{awardId,amountCents:amount});return r;});}
 private async money(tx:Client,input:{projectId:string;key:string;kind:string;amount:number;source:string;evidence:string}){
  const prior=await one(tx,'SELECT * FROM app.money_entries WHERE organization_id=$1 AND idempotency_key=$2',[this.ctx.organizationId,input.key]);
  if(prior){if(prior.kind!==input.kind||Number(prior.amount_cents)!==input.amount||prior.evidence_ref!==input.evidence)return fail('IDEMPOTENCY_CONFLICT');return {entry:prior,duplicate:true};}
  const entry=(await one(tx,'INSERT INTO app.money_entries(organization_id,project_id,idempotency_key,kind,amount_cents,source,evidence_ref) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[this.ctx.organizationId,input.projectId,input.key,input.kind,input.amount,input.source,input.evidence]))!;
  return {entry,duplicate:false};
 }
 private receiptInput(input:{amountCents:number;source:string;evidenceRef:string;idempotencyKey:string}){return {amount:positive(input.amountCents),source:selection(input.source,['provider','owner_attested'],'receipt_source'),evidence:text(input.evidenceRef,'evidence',240),key:`funding:${text(input.idempotencyKey,'idempotency_key',180)}`};}
 /** Cash exists only as a verified receipt against an ACCEPTED award; restricted and unrestricted funds are kept apart. */
 async recordDisbursement(awardId:string,input:{amountCents:number;source:string;evidenceRef:string;idempotencyKey:string;restrictionId?:string}){identifier(awardId);const r=this.receiptInput(input);if(input.restrictionId)identifier(input.restrictionId);
  return this.run(async tx=>{await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`award:${this.ctx.organizationId}:${awardId}`]);
   const award=await one(tx,'SELECT w.*,o.project_id FROM app.funding_awards w JOIN app.funding_opportunities o ON o.organization_id=w.organization_id AND o.id=w.opportunity_id WHERE w.organization_id=$1 AND w.id=$2',[this.ctx.organizationId,awardId]);if(!award)return fail('NOT_FOUND',404);
   if(award.status!=='accepted')return fail('AWARD_NOT_ACCEPTED',409);
   const existing=await one(tx,'SELECT * FROM app.funding_receipts WHERE organization_id=$1 AND money_entry_key=$2',[this.ctx.organizationId,r.key]);
   if(existing){if(Number(existing.amount_cents)!==r.amount||existing.award_id!==awardId||(existing.restriction_id??undefined)!==input.restrictionId)return fail('IDEMPOTENCY_CONFLICT');return {receipt:existing,duplicate:true};}
   const totals=(await one(tx,'SELECT COALESCE(sum(amount_cents),0)::bigint AS total,COALESCE(sum(amount_cents) FILTER(WHERE restricted),0)::bigint AS restricted FROM app.funding_receipts WHERE organization_id=$1 AND award_id=$2',[this.ctx.organizationId,awardId]))!;
   if(Number(totals.total)+r.amount>Number(award.amount_cents))return fail('DISBURSEMENT_EXCEEDS_AWARD',409);
   if(input.restrictionId){const restriction=await one(tx,'SELECT * FROM app.funding_restrictions WHERE organization_id=$1 AND id=$2 AND award_id=$3',[this.ctx.organizationId,input.restrictionId,awardId]);if(!restriction)return fail('RESTRICTION_NOT_FOUND',404);
    const used=Number((await one(tx,'SELECT COALESCE(sum(amount_cents),0)::bigint AS total FROM app.funding_receipts WHERE organization_id=$1 AND restriction_id=$2',[this.ctx.organizationId,input.restrictionId]))!.total);if(used+r.amount>Number(restriction.amount_cents))return fail('DISBURSEMENT_EXCEEDS_RESTRICTION',409);}
   else if(Number(totals.total)-Number(totals.restricted)+r.amount>Number(award.amount_cents)-Number(award.restricted_cents))return fail('UNRESTRICTED_AMOUNT_EXCEEDED',409);
   await this.money(tx,{projectId:award.project_id,key:r.key,kind:'grant_disbursement',amount:r.amount,source:r.source,evidence:r.evidence});
   const receipt=(await one(tx,"INSERT INTO app.funding_receipts(organization_id,opportunity_id,family,money_entry_key,amount_cents,award_id,restriction_id,restricted) VALUES($1,$2,'grant',$3,$4,$5,$6,$7) RETURNING *",[this.ctx.organizationId,award.opportunity_id,r.key,r.amount,awardId,input.restrictionId??null,Boolean(input.restrictionId)]))!;
   await event(tx,this.ctx,'funding.disbursement_received',awardId,{amountCents:r.amount,source:r.source,restricted:Boolean(input.restrictionId)},r.source==='provider'?'provider':'human');return {receipt,duplicate:false};});}
 async reconciliation(){return this.run(async tx=>{
  const awards=rows(await tx.query(`SELECT w.id,w.opportunity_id,w.status,w.amount_cents,w.restricted_cents,o.label,
   COALESCE(sum(r.amount_cents),0)::bigint AS received_cents,COALESCE(sum(r.amount_cents) FILTER(WHERE r.restricted),0)::bigint AS restricted_received_cents,
   COALESCE(sum(m.amount_cents),0)::bigint AS ledger_cents
   FROM app.funding_awards w JOIN app.funding_opportunities o ON o.organization_id=w.organization_id AND o.id=w.opportunity_id
   LEFT JOIN app.funding_receipts r ON r.organization_id=w.organization_id AND r.award_id=w.id LEFT JOIN app.money_entries m ON m.organization_id=r.organization_id AND m.idempotency_key=r.money_entry_key
   WHERE w.organization_id=$1 GROUP BY w.id,o.label ORDER BY w.created_at`,[this.ctx.organizationId]));
  return awards.map(a=>({awardId:a.id,opportunityId:a.opportunity_id,label:a.label,status:a.status,awardedCents:Number(a.amount_cents),restrictedAwardCents:Number(a.restricted_cents),receivedCents:Number(a.received_cents),
   restrictedReceivedCents:Number(a.restricted_received_cents),unrestrictedReceivedCents:Number(a.received_cents)-Number(a.restricted_received_cents),outstandingCents:a.status==='accepted'?Number(a.amount_cents)-Number(a.received_cents):0,ledgerMatches:Number(a.ledger_cents)===Number(a.received_cents)}));});}

 // ---- DOTS-130 investor relations
 async addInvestor(input:{name:string;kind:string;sourceId?:string;relationship?:string;allowedCommunicationClasses?:string[]}){const name=text(input.name,'name',200),kind=selection(input.kind,['angel','venture_fund','corporate','family_office','accelerator','other'],'investor_kind');
  const relationship=selection(input.relationship??'none',['none','introduced','preexisting_substantive'],'relationship');const classes=(input.allowedCommunicationClasses??['meeting_logistics']).map(c=>selection(c,communicationClasses,'communication_class'));if(input.sourceId)identifier(input.sourceId);
  return this.run(async tx=>{const investor=(await one(tx,'INSERT INTO app.investor_organizations(organization_id,name,kind,source_id,relationship,allowed_communication_classes) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[this.ctx.organizationId,name,kind,input.sourceId??null,relationship,[...new Set(classes)]]))!;await event(tx,this.ctx,'investor.created',investor.id,{relationship});return investor;});}
 /** Rule 506(c)-style accreditation flag; requires owner-recorded verification evidence (e.g. third-party verification letter id). */
 async verifyAccreditation(investorId:string,evidenceRef:string,actor:Actor='owner'){assertHumanActor(actor,'AGENT_CANNOT_VERIFY_ACCREDITATION');identifier(investorId);const evidence=text(evidenceRef,'evidence',240);
  return this.run(async tx=>{const inv=await one(tx,"UPDATE app.investor_organizations SET accreditation='verified_506c',accreditation_evidence_ref=$3,accreditation_verified_at=app.utc_now(),version=version+1 WHERE organization_id=$1 AND id=$2 RETURNING *",[this.ctx.organizationId,investorId,evidence]);if(!inv)return fail('NOT_FOUND',404);await event(tx,this.ctx,'investor.accreditation_verified',investorId);return inv;});}
 async recordMeeting(investorId:string,input:{opportunityId?:string;occurredAt:string;qualified?:boolean;interestLevel?:string;summary?:string;evidenceRef:string}){identifier(investorId);if(input.opportunityId)identifier(input.opportunityId);const occurred=pastOrNow(input.occurredAt,'occurred_at');
  const level=selection(input.interestLevel??'none',['none','low','medium','high'],'interest_level');const evidence=text(input.evidenceRef,'evidence',240);const summary=typeof input.summary==='string'?input.summary.slice(0,4000):'';
  return this.run(async tx=>{if(!await one(tx,'SELECT id FROM app.investor_organizations WHERE organization_id=$1 AND id=$2',[this.ctx.organizationId,investorId]))return fail('NOT_FOUND',404);
   if(input.opportunityId){const o=await one(tx,'SELECT investor_id FROM app.funding_opportunities WHERE organization_id=$1 AND id=$2',[this.ctx.organizationId,input.opportunityId]);if(!o||o.investor_id!==investorId)return fail('OPPORTUNITY_INVESTOR_MISMATCH',400);}
   const meeting=(await one(tx,'INSERT INTO app.investor_meetings(organization_id,investor_id,opportunity_id,occurred_at,qualified,interest_level,summary,evidence_ref) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',[this.ctx.organizationId,investorId,input.opportunityId??null,occurred,input.qualified===true,level,summary,evidence]))!;
   await event(tx,this.ctx,'investor.meeting_recorded',meeting.id,{qualified:meeting.qualified,interestLevel:level});return meeting;});}
 /**
  * Classifies (never sends) proposed investor communication. Disallowed classes and general-solicitation risk are blocked;
  * regulated offer content is routed to an owner + legal review record. Uncited traction/financial claims are blocked.
  */
 async reviewInvestorCommunication(investorId:string,input:{communicationClass:string;content:string;factIds?:string[];projectId?:string}){identifier(investorId);const cls=selection(input.communicationClass,communicationClasses,'communication_class');const content=text(input.content,'content',20000);const factIds=list(input.factIds,'fact_ids',30);if(input.projectId)identifier(input.projectId);
  return this.run(async tx=>{const investor=await one(tx,'SELECT * FROM app.investor_organizations WHERE organization_id=$1 AND id=$2',[this.ctx.organizationId,investorId]);if(!investor)return fail('NOT_FOUND',404);
   const offer=regulatedOfferFindings(content);const findings:string[]=offer.map(t=>`REGULATED_TERM:${t}`);
   const claims=findUnsupportedClaims(content,input.projectId?await this.approvedFacts(tx,input.projectId):[],factIds,'financial');findings.push(...claims.map(c=>`${c.reason}`));
   let status:string;
   if(!investor.allowed_communication_classes.includes(cls)){findings.push('CLASS_NOT_ALLOWED_FOR_INVESTOR');status='blocked';}
   else if(claims.length)status='blocked';
   else if(offer.length||cls==='offering_material'){if(investor.relationship!=='preexisting_substantive'&&investor.accreditation!=='verified_506c'){findings.push('GENERAL_SOLICITATION_RISK');status='blocked';}else status='owner_legal_review_required';}
   else status='cleared_for_owner_send';
   const review=(await one(tx,'INSERT INTO app.investor_communication_reviews(organization_id,investor_id,communication_class,content_hash,content,findings,status) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7) RETURNING *',[this.ctx.organizationId,investorId,cls,digest(content),content,JSON.stringify(findings),status]))!;
   await event(tx,this.ctx,'investor.communication_reviewed',review.id,{status,findings:findings.length});return review;});}
 async decideInvestorCommunication(reviewId:string,approve:boolean,legalReviewRef?:string,actor:Actor='owner'){assertHumanActor(actor,'AGENT_CANNOT_APPROVE_DISCLOSURE');identifier(reviewId);if(approve&&!legalReviewRef)return fail('LEGAL_REVIEW_REFERENCE_REQUIRED',403);
  return this.run(async tx=>{const review=await one(tx,'SELECT * FROM app.investor_communication_reviews WHERE organization_id=$1 AND id=$2 FOR UPDATE',[this.ctx.organizationId,reviewId]);if(!review)return fail('NOT_FOUND',404);if(review.status!=='owner_legal_review_required')return fail('REVIEW_NOT_PENDING',409);
   let approvalId:string|null=null;
   if(approve){const legal=text(legalReviewRef,'legal_review',240);const policy=await one(tx,'SELECT version FROM app.policy_controls WHERE organization_id=$1',[this.ctx.organizationId]);if(!policy)return fail('POLICY_UNCONFIGURED');const payload={reviewId,contentHash:review.content_hash,legalReviewRef:legal};
    approvalId=(await one(tx,"INSERT INTO app.action_approvals(organization_id,action_kind,record_id,payload_hash,policy_version,requested_by_membership_id,proposed_payload,status,decided_by_membership_id,decided_at) VALUES($1,'investment_disclosure',$2,$3,$4,$5,$6::jsonb,'approved',$5,app.utc_now()) RETURNING id",[this.ctx.organizationId,reviewId,digest(payload),policy.version,this.ctx.membershipId,JSON.stringify(payload)]))!.id;}
   const saved=(await one(tx,'UPDATE app.investor_communication_reviews SET status=$3,legal_review_ref=$4,approval_id=$5,decided_by_membership_id=$6,decided_at=app.utc_now() WHERE organization_id=$1 AND id=$2 RETURNING *',[this.ctx.organizationId,reviewId,approve?'approved_after_legal_review':'rejected',approve?legalReviewRef:null,approvalId,this.ctx.membershipId]))!;
   await event(tx,this.ctx,approve?'investor.communication_approved':'investor.communication_rejected',reviewId,{approvalId});return saved;});}

 // ---- DOTS-131 pitch assets and diligence
 async createPitchAsset(projectId:string,kind:string,label:string){identifier(projectId);const k=selection(kind,['deck_narrative','investor_email','one_pager','sponsorship_proposal'],'asset_kind');const l=text(label,'label',160);
  return this.run(async tx=>{const asset=(await one(tx,'INSERT INTO app.pitch_assets(organization_id,project_id,kind,label) VALUES($1,$2,$3,$4) RETURNING *',[this.ctx.organizationId,projectId,k,l]))!;await event(tx,this.ctx,'pitch.asset_created',asset.id,{kind:k});return asset;});}
 /** Every version must link approved facts; fictitious traction/revenue claims fail. */
 async savePitchVersion(assetId:string,content:string,factIds:string[]){identifier(assetId);const body=text(content,'content',50000);const ids=list(factIds,'fact_ids',50);if(!ids.length)return fail('APPROVED_FACTS_REQUIRED',422);
  return this.run(async tx=>{const asset=await one(tx,'SELECT * FROM app.pitch_assets WHERE organization_id=$1 AND id=$2 FOR UPDATE',[this.ctx.organizationId,assetId]);if(!asset)return fail('NOT_FOUND',404);
   const facts=await this.approvedFacts(tx,asset.project_id);const findings=findUnsupportedClaims(body,facts,ids);
   if(findings.length){await event(tx,this.ctx,'pitch.claim_blocked',assetId,{findings:findings.map(f=>f.reason)});return fail('UNSUPPORTED_CLAIM',422);}
   const next=Number(asset.current_version)+1;const snapshot=ids.map(id=>facts.find(f=>f.id===id));
   const version=(await one(tx,'INSERT INTO app.pitch_asset_versions(organization_id,asset_id,version,content,fact_ids,fact_snapshot_hash,content_hash,created_by_membership_id) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8) RETURNING *',[this.ctx.organizationId,assetId,next,body,JSON.stringify(ids),digest(snapshot),digest(body),this.ctx.membershipId]))!;
   await tx.query('UPDATE app.pitch_assets SET current_version=$3 WHERE organization_id=$1 AND id=$2',[this.ctx.organizationId,assetId,next]);await event(tx,this.ctx,'pitch.version_saved',assetId,{version:next});return version;});}
 async addDiligenceItem(opportunityId:string,label:string){identifier(opportunityId);const l=text(label,'label',200);return this.run(async tx=>{const o=await one(tx,'SELECT kind FROM app.funding_opportunities WHERE organization_id=$1 AND id=$2',[this.ctx.organizationId,opportunityId]);if(!o)return fail('NOT_FOUND',404);
  const item=await one(tx,'INSERT INTO app.funding_diligence_items(organization_id,opportunity_id,label) VALUES($1,$2,$3) ON CONFLICT(organization_id,opportunity_id,label) DO NOTHING RETURNING *',[this.ctx.organizationId,opportunityId,l]);await event(tx,this.ctx,'funding.diligence_item_added',opportunityId,{label:l});return item??null;});}
 async completeDiligenceItem(itemId:string,documentId:string){identifier(itemId);identifier(documentId);return this.run(async tx=>{if(!await one(tx,'SELECT id FROM app.document_library WHERE organization_id=$1 AND id=$2',[this.ctx.organizationId,documentId]))return fail('DOCUMENT_NOT_FOUND',404);
  const item=await one(tx,'UPDATE app.funding_diligence_items SET completed=true,document_id=$3 WHERE organization_id=$1 AND id=$2 RETURNING *',[this.ctx.organizationId,itemId,documentId]);if(!item)return fail('NOT_FOUND',404);await event(tx,this.ctx,'funding.diligence_item_completed',itemId);return item;});}

 // ---- DOTS-132 commitments
 async recordCommitmentStage(opportunityId:string,input:{stage:string;amountCents?:number;proofRef:string;documentId?:string;meetingId?:string;legalReviewRef?:string;authorityRef?:string},actor:Actor='owner'){
  identifier(opportunityId);const stage=selection(input.stage,['meeting','interest','term_sheet','signed_commitment'],'commitment_stage');if(stage==='signed_commitment')assertHumanActor(actor,'AGENT_CANNOT_SIGN');
  const proof=text(input.proofRef,'proof',240);const amount=cents(input.amountCents??0);if(input.documentId)identifier(input.documentId);if(input.meetingId)identifier(input.meetingId);
  if(stage==='meeting'&&!input.meetingId)return fail('MEETING_RECORD_REQUIRED',400);if(stage==='term_sheet'&&!input.documentId)return fail('TERM_SHEET_DOCUMENT_REQUIRED',400);
  if(stage==='signed_commitment'&&(!input.documentId||!input.legalReviewRef||!input.authorityRef||!amount))return fail('SIGNED_COMMITMENT_PROOF_REQUIRED',400);
  return this.run(async tx=>{const o=await one(tx,'SELECT * FROM app.funding_opportunities WHERE organization_id=$1 AND id=$2',[this.ctx.organizationId,opportunityId]);if(!o)return fail('NOT_FOUND',404);if(o.kind!=='investment'||!o.investor_id)return fail('INVESTMENT_OPPORTUNITY_REQUIRED',400);
   const prior=rows(await tx.query('SELECT stage FROM app.investment_commitment_events WHERE organization_id=$1 AND opportunity_id=$2',[this.ctx.organizationId,opportunityId])).map(r=>r.stage as string);
   const requires:Record<string,string|null>={meeting:null,interest:'meeting',term_sheet:'interest',signed_commitment:'term_sheet'};const need=requires[stage];if(need&&!prior.includes(need))return fail(`${need.toUpperCase()}_REQUIRED_FIRST`,409);
   if(input.meetingId&&!await one(tx,'SELECT id FROM app.investor_meetings WHERE organization_id=$1 AND id=$2 AND investor_id=$3',[this.ctx.organizationId,input.meetingId,o.investor_id]))return fail('MEETING_NOT_FOUND',404);
   if(input.documentId&&!await one(tx,'SELECT id FROM app.document_library WHERE organization_id=$1 AND id=$2',[this.ctx.organizationId,input.documentId]))return fail('DOCUMENT_NOT_FOUND',404);
   const legal={meeting:'non_binding',interest:'non_binding',term_sheet:'under_legal_review',signed_commitment:'binding_signed'}[stage]!;
   const ev=(await one(tx,'INSERT INTO app.investment_commitment_events(organization_id,opportunity_id,investor_id,stage,amount_cents,legal_status,proof_ref,document_id,meeting_id,legal_review_ref,authority_ref,recorded_by_membership_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *',
    [this.ctx.organizationId,opportunityId,o.investor_id,stage,amount,legal,proof,input.documentId??null,input.meetingId??null,input.legalReviewRef??null,input.authorityRef??null,this.ctx.membershipId]))!;
   if(stage==='signed_commitment')await tx.query("UPDATE app.funding_opportunities SET stage='committed',committed_cents=committed_cents+$3,owner_authority_ref=$4,version=version+1,updated_at=app.utc_now() WHERE organization_id=$1 AND id=$2",[this.ctx.organizationId,opportunityId,amount,input.authorityRef]);
   await event(tx,this.ctx,'investment.stage_recorded',ev.id,{stage,legalStatus:legal,cash:false});return ev;});}
 async recordInvestmentReceipt(opportunityId:string,input:{amountCents:number;source:string;evidenceRef:string;idempotencyKey:string}){identifier(opportunityId);const r=this.receiptInput(input);
  return this.run(async tx=>{await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`investment:${this.ctx.organizationId}:${opportunityId}`]);
   const o=await one(tx,'SELECT * FROM app.funding_opportunities WHERE organization_id=$1 AND id=$2',[this.ctx.organizationId,opportunityId]);if(!o)return fail('NOT_FOUND',404);if(o.kind!=='investment')return fail('INVESTMENT_OPPORTUNITY_REQUIRED',400);
   const existing=await one(tx,'SELECT * FROM app.funding_receipts WHERE organization_id=$1 AND money_entry_key=$2',[this.ctx.organizationId,r.key]);if(existing){if(Number(existing.amount_cents)!==r.amount||existing.opportunity_id!==opportunityId)return fail('IDEMPOTENCY_CONFLICT');return {receipt:existing,duplicate:true};}
   const sums=(await one(tx,`SELECT COALESCE(sum(amount_cents) FILTER(WHERE stage='signed_commitment'),0)::bigint AS signed,COALESCE(sum(amount_cents) FILTER(WHERE stage='cash_received'),0)::bigint AS cash FROM app.investment_commitment_events WHERE organization_id=$1 AND opportunity_id=$2`,[this.ctx.organizationId,opportunityId]))!;
   if(!Number(sums.signed))return fail('SIGNED_COMMITMENT_REQUIRED',409);if(Number(sums.cash)+r.amount>Number(sums.signed))return fail('RECEIPT_EXCEEDS_SIGNED_COMMITMENT',409);
   await this.money(tx,{projectId:o.project_id,key:r.key,kind:'investment_receipt',amount:r.amount,source:r.source,evidence:r.evidence});
   const receipt=(await one(tx,"INSERT INTO app.funding_receipts(organization_id,opportunity_id,family,money_entry_key,amount_cents) VALUES($1,$2,'investment',$3,$4) RETURNING *",[this.ctx.organizationId,opportunityId,r.key,r.amount]))!;
   await tx.query("INSERT INTO app.investment_commitment_events(organization_id,opportunity_id,investor_id,stage,amount_cents,legal_status,proof_ref,money_entry_key,recorded_by_membership_id) VALUES($1,$2,$3,'cash_received',$4,'settled',$5,$6,$7)",[this.ctx.organizationId,opportunityId,o.investor_id,r.amount,r.evidence,r.key,this.ctx.membershipId]);
   await event(tx,this.ctx,'investment.cash_received',opportunityId,{amountCents:r.amount,source:r.source},r.source==='provider'?'provider':'human');return {receipt,duplicate:false};});}

 // ---- DOTS-133 sponsorships and partnerships
 async startSponsorship(opportunityId:string){identifier(opportunityId);return this.run(async tx=>{const o=await one(tx,'SELECT kind FROM app.funding_opportunities WHERE organization_id=$1 AND id=$2',[this.ctx.organizationId,opportunityId]);if(!o)return fail('NOT_FOUND',404);if(!['sponsorship','partnership'].includes(o.kind))return fail('SPONSORSHIP_OPPORTUNITY_REQUIRED',400);
  const w=await one(tx,'INSERT INTO app.sponsorship_workflows(organization_id,opportunity_id) VALUES($1,$2) ON CONFLICT(organization_id,opportunity_id) DO NOTHING RETURNING *',[this.ctx.organizationId,opportunityId])??await one(tx,'SELECT * FROM app.sponsorship_workflows WHERE organization_id=$1 AND opportunity_id=$2',[this.ctx.organizationId,opportunityId]);
  await event(tx,this.ctx,'sponsorship.started',w!.id);return w!;});}
 /** research → proposal → approved → contract_review → signed. Binding terms need an owner authority reference and contract review. */
 async advanceSponsorship(workflowId:string,stage:string,version:number,details:{proposalAssetId?:string;contractDocumentId?:string;contractReviewRef?:string;authorityRef?:string}={},actor:Actor='owner'){
  identifier(workflowId);const next=selection(stage,['proposal','approved','contract_review','signed','declined'],'sponsorship_stage');if(['approved','signed'].includes(next))assertHumanActor(actor,'AGENT_CANNOT_EXECUTE_CONTRACT');
  return this.run(async tx=>{const w=await one(tx,'SELECT * FROM app.sponsorship_workflows WHERE organization_id=$1 AND id=$2 FOR UPDATE',[this.ctx.organizationId,workflowId]);if(!w)return fail('NOT_FOUND',404);if(Number(w.version)!==version)return fail('STALE_RECORD');
   const from:Record<string,string[]>={proposal:['research'],approved:['proposal'],contract_review:['approved'],signed:['contract_review'],declined:['research','proposal','approved','contract_review']};if(!from[next]!.includes(w.stage))return fail('INVALID_SPONSORSHIP_TRANSITION',409);
   const set:Row={};
   if(next==='proposal'){const id=identifier(details.proposalAssetId);const asset=await one(tx,"SELECT current_version FROM app.pitch_assets WHERE organization_id=$1 AND id=$2 AND kind='sponsorship_proposal'",[this.ctx.organizationId,id]);if(!asset||!Number(asset.current_version))return fail('FACT_LINKED_PROPOSAL_REQUIRED',409);set.proposal_asset_id=id;}
   if(next==='approved')set.approval_membership_id=this.ctx.membershipId;
   if(next==='contract_review'){const id=identifier(details.contractDocumentId);if(!await one(tx,'SELECT id FROM app.document_library WHERE organization_id=$1 AND id=$2',[this.ctx.organizationId,id]))return fail('DOCUMENT_NOT_FOUND',404);set.contract_document_id=id;set.contract_review_ref=text(details.contractReviewRef,'contract_review',240);}
   if(next==='signed'){if(!details.authorityRef)return fail('OWNER_AUTHORITY_REFERENCE_REQUIRED',403);set.signed_authority_ref=text(details.authorityRef,'authority',240);set.signed_by_membership_id=this.ctx.membershipId;set.signed_at=new Date().toISOString();}
   const cols=Object.keys(set);const saved=(await one(tx,`UPDATE app.sponsorship_workflows SET stage=$3${cols.map((c,i)=>`,${c}=$${i+4}`).join('')},version=version+1,updated_at=app.utc_now() WHERE organization_id=$1 AND id=$2 RETURNING *`,[this.ctx.organizationId,workflowId,next,...cols.map(c=>set[c])]))!;
   if(next==='signed')await tx.query("UPDATE app.funding_opportunities SET stage='committed',owner_authority_ref=$3,version=version+1,updated_at=app.utc_now() WHERE organization_id=$1 AND id=$2",[this.ctx.organizationId,w.opportunity_id,set.signed_authority_ref]);
   await event(tx,this.ctx,'sponsorship.stage_changed',workflowId,{stage:next});return saved;});}
 async recordSponsorshipExchange(workflowId:string,input:{kind:string;description:string;valueCents:number;evidenceRef:string;source?:string;idempotencyKey?:string}){
  identifier(workflowId);const kind=selection(input.kind,['funds','in_kind'],'exchange_kind');const description=text(input.description,'description',1000),value=positive(input.valueCents),evidence=text(input.evidenceRef,'evidence',240);
  const receipt=kind==='funds'?this.receiptInput({amountCents:value,source:input.source??'',evidenceRef:evidence,idempotencyKey:input.idempotencyKey??''}):null;
  return this.run(async tx=>{const w=await one(tx,'SELECT w.*,o.project_id FROM app.sponsorship_workflows w JOIN app.funding_opportunities o ON o.organization_id=w.organization_id AND o.id=w.opportunity_id WHERE w.organization_id=$1 AND w.id=$2 FOR UPDATE OF w',[this.ctx.organizationId,workflowId]);if(!w)return fail('NOT_FOUND',404);
   if(!['signed','exchanged'].includes(w.stage))return fail('SIGNED_AGREEMENT_REQUIRED',409);
   if(receipt){const existing=await one(tx,'SELECT * FROM app.funding_receipts WHERE organization_id=$1 AND money_entry_key=$2',[this.ctx.organizationId,receipt.key]);if(existing){if(Number(existing.amount_cents)!==value)return fail('IDEMPOTENCY_CONFLICT');return {duplicate:true};}
    await this.money(tx,{projectId:w.project_id,key:receipt.key,kind:'sponsorship_receipt',amount:value,source:receipt.source,evidence});
    await tx.query("INSERT INTO app.funding_receipts(organization_id,opportunity_id,family,money_entry_key,amount_cents) VALUES($1,$2,'sponsorship',$3,$4)",[this.ctx.organizationId,w.opportunity_id,receipt.key,value]);}
   const ex=(await one(tx,'INSERT INTO app.sponsorship_exchanges(organization_id,workflow_id,kind,description,value_cents,evidence_ref,money_entry_key) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[this.ctx.organizationId,workflowId,kind,description,value,evidence,receipt?.key??null]))!;
   await tx.query("UPDATE app.sponsorship_workflows SET stage='exchanged',version=version+1,updated_at=app.utc_now() WHERE organization_id=$1 AND id=$2",[this.ctx.organizationId,workflowId]);
   await event(tx,this.ctx,'sponsorship.exchange_recorded',ex.id,{kind,valueCents:value});return {...ex,duplicate:false};});}

 // ---- DOTS-134 dashboard
 async dashboard(){return this.run(async tx=>this.metrics(tx));}
 private async metrics(tx:Client){
  const o=this.ctx.organizationId;
  const grants=(await one(tx,`SELECT
   (SELECT count(DISTINCT x.opportunity_id)::int FROM app.funding_opportunities f JOIN LATERAL (SELECT opportunity_id,result FROM app.funding_eligibility_results e WHERE e.organization_id=f.organization_id AND e.opportunity_id=f.id ORDER BY evaluated_at DESC,id DESC LIMIT 1) x ON true WHERE f.organization_id=$1 AND f.kind='grant' AND x.result='eligible') AS eligible,
   (SELECT count(*)::int FROM app.funding_applications WHERE organization_id=$1 AND status='submitted') AS applied,
   (SELECT count(*)::int FROM app.funding_applications a WHERE a.organization_id=$1 AND a.status='submitted' AND NOT EXISTS(SELECT 1 FROM app.funding_awards w WHERE w.organization_id=a.organization_id AND w.opportunity_id=a.opportunity_id AND w.status IN ('accepted','declined'))) AS pending,
   (SELECT count(*)::int FROM app.funding_awards WHERE organization_id=$1 AND status='accepted') AS won,
   (SELECT COALESCE(sum(amount_cents),0)::bigint FROM app.funding_awards WHERE organization_id=$1 AND status='accepted') AS won_award_cents,
   (SELECT COALESCE(sum(amount_cents),0)::bigint FROM app.funding_receipts WHERE organization_id=$1 AND family='grant') AS received_cents,
   (SELECT COALESCE(sum(amount_cents) FILTER(WHERE restricted),0)::bigint FROM app.funding_receipts WHERE organization_id=$1 AND family='grant') AS restricted_cents`,[o]))!;
  const investors=(await one(tx,`SELECT (SELECT count(*)::int FROM app.investor_meetings WHERE organization_id=$1 AND qualified) AS qualified_meetings,
   (SELECT count(DISTINCT opportunity_id)::int FROM app.investment_commitment_events WHERE organization_id=$1 AND stage='interest') AS interested,
   (SELECT count(*)::int FROM app.investment_commitment_events WHERE organization_id=$1 AND stage='term_sheet') AS term_sheets,
   (SELECT COALESCE(sum(amount_cents),0)::bigint FROM app.investment_commitment_events WHERE organization_id=$1 AND stage='signed_commitment') AS signed_cents,
   (SELECT COALESCE(sum(amount_cents),0)::bigint FROM app.funding_receipts WHERE organization_id=$1 AND family='investment') AS raised_cents`,[o]))!;
  const sponsors=(await one(tx,`SELECT (SELECT count(*)::int FROM app.sponsorship_workflows WHERE organization_id=$1 AND stage IN ('signed','exchanged')) AS signed,
   (SELECT COALESCE(sum(amount_cents),0)::bigint FROM app.funding_receipts WHERE organization_id=$1 AND family='sponsorship') AS cash_cents,
   (SELECT COALESCE(sum(value_cents) FILTER(WHERE kind='in_kind'),0)::bigint FROM app.sponsorship_exchanges WHERE organization_id=$1) AS in_kind_cents`,[o]))!;
  const ledger=(await one(tx,`SELECT COALESCE(sum(r.amount_cents),0)::bigint AS receipts,COALESCE(sum(m.amount_cents),0)::bigint AS ledger,
   COALESCE(sum(m.amount_cents) FILTER(WHERE m.source='provider'),0)::bigint AS provider_verified,COALESCE(sum(m.amount_cents) FILTER(WHERE m.source='owner_attested'),0)::bigint AS owner_attested
   FROM app.funding_receipts r LEFT JOIN app.money_entries m ON m.organization_id=r.organization_id AND m.idempotency_key=r.money_entry_key WHERE r.organization_id=$1`,[o]))!;
  const n=(v:unknown)=>Number(v);
  return {
   grants:{eligible:grants.eligible,applied:grants.applied,pending:grants.pending,won:grants.won,wonAwardCents:n(grants.won_award_cents),receivedCents:n(grants.received_cents),restrictedReceivedCents:n(grants.restricted_cents),unrestrictedReceivedCents:n(grants.received_cents)-n(grants.restricted_cents)},
   investors:{qualifiedMeetings:investors.qualified_meetings,interestedOpportunities:investors.interested,termSheets:investors.term_sheets,signedCommitmentCents:n(investors.signed_cents),raisedCents:n(investors.raised_cents)},
   sponsorships:{signed:sponsors.signed,cashReceivedCents:n(sponsors.cash_cents),inKindValueCents:n(sponsors.in_kind_cents)},
   netFunding:{receivedCents:n(ledger.receipts),ledgerCents:n(ledger.ledger),providerVerifiedCents:n(ledger.provider_verified),ownerAttestedCents:n(ledger.owner_attested),reconciled:n(ledger.receipts)===n(ledger.ledger),
    excluded:['requested amounts','award ranges','verbal or written interest','term sheets','signed but unpaid commitments','offered or accepted but unpaid awards','in-kind value']},
  };
 }

 /** Snapshot for the funding command center UI. */
 async snapshot(now=new Date()){return this.run(async tx=>{const o=this.ctx.organizationId;const q=async(sql:string)=>rows(await tx.query(sql,[o]));
  const latest=await q('SELECT DISTINCT ON(connector) connector,state,reason_code,result_count,observed_at FROM app.funding_connector_runs WHERE organization_id=$1 ORDER BY connector,observed_at DESC');
  return {observedAt:now.toISOString(),
   sources:await q(`SELECT s.*,(s.verified_at+make_interval(days=>s.refresh_days))<app.utc_now() AS needs_recheck FROM app.funding_sources s WHERE organization_id=$1 AND status<>'archived' ORDER BY deadline NULLS LAST,name LIMIT 200`),
   rules:await q('SELECT * FROM app.funding_eligibility_rules WHERE organization_id=$1 AND status=\'active\' ORDER BY created_at LIMIT 500'),
   connectors:fundingConnectors.map(c=>{const run=latest.find(r=>r.connector===c.id);return {...c,state:c.access==='blocked_external_prerequisite'?'blocked_external_prerequisite':run?.state??'not_run',reasonCode:run?.reason_code??null,lastResultCount:run?.result_count??0,observedAt:run?.observed_at??null};}),
   profiles:await q('SELECT * FROM app.funding_applicant_profiles WHERE organization_id=$1'),
   pipeline:await(async()=>{const cards=await this.cards(tx,now);return {grants:cards.filter(c=>c.kind==='grant'),investors:cards.filter(c=>c.kind==='investment'),sponsorships:cards.filter(c=>c.kind==='sponsorship'||c.kind==='partnership')};})(),
   applications:await q('SELECT a.*,o.label AS opportunity_label FROM app.funding_applications a JOIN app.funding_opportunities o ON o.organization_id=a.organization_id AND o.id=a.opportunity_id WHERE a.organization_id=$1 ORDER BY a.updated_at DESC LIMIT 100'),
   answers:await q('SELECT * FROM app.funding_application_answers WHERE organization_id=$1 ORDER BY application_id,question_key LIMIT 1000'),
   documents:await q('SELECT * FROM app.funding_application_documents WHERE organization_id=$1 ORDER BY application_id,label LIMIT 1000'),
   libraryDocuments:await q('SELECT id,title,content_type,created_at FROM app.document_library WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 200'),
   facts:await q('SELECT * FROM app.funding_org_facts WHERE organization_id=$1 AND status<>\'retired\' ORDER BY created_at DESC LIMIT 300'),
   milestones:await q('SELECT * FROM app.funding_milestones WHERE organization_id=$1 AND completed_at IS NULL ORDER BY due_at LIMIT 200'),
   alerts:await q('SELECT a.*,m.label AS milestone_label,m.due_at,m.timezone FROM app.funding_owner_alerts a JOIN app.funding_milestones m ON m.organization_id=a.organization_id AND m.id=a.milestone_id WHERE a.organization_id=$1 AND a.state=\'open\' ORDER BY m.due_at LIMIT 100'),
   awards:await q('SELECT * FROM app.funding_awards WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 100'),
   restrictions:await q('SELECT * FROM app.funding_restrictions WHERE organization_id=$1 ORDER BY created_at LIMIT 300'),
   investors:await q('SELECT * FROM app.investor_organizations WHERE organization_id=$1 ORDER BY name LIMIT 200'),
   meetings:await q('SELECT * FROM app.investor_meetings WHERE organization_id=$1 ORDER BY occurred_at DESC LIMIT 200'),
   communications:await q('SELECT id,investor_id,communication_class,content_hash,findings,status,legal_review_ref,approval_id,created_at,decided_at FROM app.investor_communication_reviews WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 100'),
   pitchAssets:await q('SELECT a.*,v.content AS latest_content,v.fact_ids AS latest_fact_ids,v.created_at AS latest_saved_at FROM app.pitch_assets a LEFT JOIN app.pitch_asset_versions v ON v.organization_id=a.organization_id AND v.asset_id=a.id AND v.version=a.current_version WHERE a.organization_id=$1 ORDER BY a.created_at DESC LIMIT 100'),
   diligence:await q('SELECT * FROM app.funding_diligence_items WHERE organization_id=$1 ORDER BY opportunity_id,label LIMIT 500'),
   commitments:await q('SELECT * FROM app.investment_commitment_events WHERE organization_id=$1 ORDER BY recorded_at DESC LIMIT 300'),
   sponsorships:await q('SELECT * FROM app.sponsorship_workflows WHERE organization_id=$1 ORDER BY updated_at DESC LIMIT 100'),
   exchanges:await q('SELECT * FROM app.sponsorship_exchanges WHERE organization_id=$1 ORDER BY recorded_at DESC LIMIT 100'),
   projects:await q("SELECT id,label FROM app.projects WHERE organization_id=$1 AND status='active' ORDER BY label LIMIT 100"),
   dashboard:await this.metrics(tx)};});}
}
