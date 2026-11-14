// Campaign Studio domain (DOTS-082..093): lifecycle, immutable revisions, versioned audiences and
// budgets, safe templates, claim/price/jurisdiction guardrails, variants, dry-run simulation,
// owner approval binding and idempotent, fail-closed work generation.
import {type Client,type Context,type Row,rows,tenant,event,outbox,digest,text,cents,fail} from './common.js';
import {identifier,selection,dateOrNull} from './sales.js';

/* ------------------------------------------------------------------ lifecycle */
export const campaignStates=['draft','validated','ready_for_approval','approved','scheduled','active','paused','completed','archived','aborted'] as const;
export type CampaignState=typeof campaignStates[number];
export const campaignTransitions:Readonly<Record<CampaignState,readonly CampaignState[]>>={
 draft:['validated','archived','aborted'],
 validated:['draft','ready_for_approval','archived','aborted'],
 ready_for_approval:['approved','draft','aborted'],
 approved:['scheduled','draft','aborted'],
 scheduled:['active','paused','draft','aborted'],
 active:['paused','completed','aborted'],
 paused:['active','scheduled','draft','completed','aborted'],
 completed:['archived'],
 aborted:['archived'],
 archived:[],
};
export function canTransition(from:string,to:string):boolean{return (campaignTransitions as Record<string,readonly string[]>)[from]?.includes(to)??false;}
/** States that may move into `to`; used as the `state = ANY(...)` guard of every lifecycle UPDATE. */
export function statesInto(to:CampaignState):CampaignState[]{return campaignStates.filter(s=>campaignTransitions[s].includes(to));}
/** Material edits are allowed only where a transition back to draft exists (plus draft itself). Active campaigns must be paused first. */
export const editableCampaignStates:readonly CampaignState[]=['draft',...statesInto('draft')];

export type Issue={code:string;severity:'blocking'|'warning';message:string;field?:string};
const blocking=(code:string,message:string,field?:string):Issue=>({code,severity:'blocking',message,...(field?{field}:{})});
const warning=(code:string,message:string,field?:string):Issue=>({code,severity:'warning',message,...(field?{field}:{})});

/* ------------------------------------------------------------- safe HTML */
const ALLOWED_TAGS=new Set(['p','br','strong','b','em','i','u','ul','ol','li','a','h2','h3','blockquote','hr','span']);
const VOID_TAGS=new Set(['br','hr']);
const DROP_WITH_CONTENT=new Set(['script','style','iframe','object','embed','noscript','template','svg','math','textarea','title','xmp','noembed','noframes','plaintext','applet','select','frameset']);
const NAMED_ENTITIES:Record<string,string>={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",colon:':',tab:'\t',newline:'\n',sol:'/',lpar:'(',rpar:')',nbsp:' ',period:'.',comma:','};
export function escapeHtml(value:string):string{return value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}
function escapeText(value:string):string{return value.replace(/&(?!(?:[a-zA-Z][a-zA-Z0-9]{1,31}|#\d{1,7}|#[xX][0-9a-fA-F]{1,6});)/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function decodeEntities(value:string):string{
 return value.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);?/g,(match,entity:string)=>{
  if(entity.startsWith('#')){const code=entity[1]==='x'||entity[1]==='X'?parseInt(entity.slice(2),16):parseInt(entity.slice(1),10);return Number.isFinite(code)&&code>0&&code<0x110000?String.fromCodePoint(code):'';}
  return NAMED_ENTITIES[entity.toLowerCase()]??match;
 });
}
/** Only absolute http(s) and mailto URLs survive; entity-encoded and whitespace-obfuscated schemes are decoded before the check. */
export function safeUrl(raw:string):string|null{
 const decoded=decodeEntities(raw).replace(/[\u0000-\u0020\u007f-\u00a0\u1680\u180e\u2000-\u200f\u2028\u2029\u205f\u3000\ufeff]/g,'');
 return /^(https?:\/\/[^/]|mailto:[^\s])/i.test(decoded)?decoded:null;
}
function attributeValue(attributes:string,name:string):string|null{
 const pattern=/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;let match:RegExpExecArray|null;
 while((match=pattern.exec(attributes)))if(match[1]!.toLowerCase()===name)return match[2]??match[3]??match[4]??'';
 return null;
}
/** Strict allowlist sanitizer: unknown tags are unwrapped, dangerous containers are dropped with their content, every attribute except a safe link href is removed. */
export function sanitizeHtml(input:string):string{
 const source=String(input??'').replace(/\u0000/g,'').slice(0,100000);let output='';const stack:string[]=[];let index=0;
 while(index<source.length){
  const open=source.indexOf('<',index);
  if(open<0){output+=escapeText(source.slice(index));break;}
  output+=escapeText(source.slice(index,open));index=open;
  if(source.startsWith('<!--',index)){const end=source.indexOf('-->',index+4);index=end<0?source.length:end+3;continue;}
  if(source[index+1]==='!'||source[index+1]==='?'){const end=source.indexOf('>',index);index=end<0?source.length:end+1;continue;}
  const tag=/^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*'){0,4000})>/.exec(source.slice(index,index+4200));
  if(!tag){output+='&lt;';index+=1;continue;}
  const closing=tag[1]==='/',name=tag[2]!.toLowerCase(),attributes=tag[3]??'';index+=tag[0].length;
  if(DROP_WITH_CONTENT.has(name)){if(!closing){const end=new RegExp(`</${name}\\s*>`,'i').exec(source.slice(index));index=end?index+end.index+end[0].length:source.length;}continue;}
  if(!ALLOWED_TAGS.has(name))continue;
  if(closing){const at=stack.lastIndexOf(name);if(at<0)continue;while(stack.length>at)output+=`</${stack.pop()}>`;continue;}
  if(VOID_TAGS.has(name)){output+=`<${name}>`;continue;}
  if(stack.length>=100)continue;
  let safeAttributes='';
  if(name==='a'){const href=attributeValue(attributes,'href');const safe=href===null?null:safeUrl(href);if(safe)safeAttributes=` href="${escapeHtml(safe)}" rel="noopener noreferrer nofollow"`;}
  output+=`<${name}${safeAttributes}>`;stack.push(name);
 }
 while(stack.length)output+=`</${stack.pop()}>`;
 return output;
}
export function htmlToText(html:string):string{return decodeEntities(sanitizeHtml(html).replace(/<\/(p|li|h2|h3|blockquote)>|<br>/g,'\n').replace(/<[^>]*>/g,'')).replace(/\n{3,}/g,'\n\n').trim();}

/* ------------------------------------------------------- templates and claims */
export const templateVariables=['contact.first_name','contact.last_name','contact.full_name','contact.company','contact.role','contact.country','sender.name','offer.name','project.name'] as const;
const PLACEHOLDER=/\{\{\s*([^{}]{1,120}?)\s*\}\}/g;
export function parsePlaceholders(source:string){
 const facts=new Set<string>(),variables=new Set<string>(),unknown=new Set<string>();
 for(const match of source.matchAll(PLACEHOLDER)){
  const key=match[1]!.trim();const fact=/^fact:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(key);
  if(fact)facts.add(fact[1]!.toLowerCase());else if((templateVariables as readonly string[]).includes(key))variables.add(key);else unknown.add(key);
 }
 return {facts:[...facts].sort(),variables:[...variables].sort(),unknown:[...unknown].sort(),malformed:/\{\{|\}\}/.test(source.replace(PLACEHOLDER,''))};
}
export type FactInfo={id:string;projectId:string;label:string;status:string;version:number;body:string;sourceUrl:string|null;verifiedAt:string|null;effectiveAt:string|null;expiresAt:string|null};
export function factInfo(row:Row):FactInfo{const c=row.content??{};return {id:String(row.id),projectId:String(row.project_id),label:String(row.label),status:String(row.status),version:Number(row.version),body:String(c.body??c.claim??''),sourceUrl:typeof c.sourceUrl==='string'?c.sourceUrl:typeof c.source==='string'?c.source:null,verifiedAt:c.verifiedAt??null,effectiveAt:c.effectiveAt??null,expiresAt:c.expiresAt??null};}
export function factProblem(fact:FactInfo|undefined,projectId:string|null,now:Date):{code:string;message:string}|null{
 if(!fact)return {code:'UNKNOWN_FACT',message:'The copy cites a fact that does not exist in the claim registry.'};
 if(projectId&&fact.projectId!==projectId)return {code:'FACT_OTHER_PROJECT',message:`Fact “${fact.label}” belongs to a different project.`};
 if(fact.status!=='active')return {code:'FACT_INACTIVE',message:`Fact “${fact.label}” is archived.`};
 if(!fact.sourceUrl)return {code:'FACT_WITHOUT_SOURCE',message:`Fact “${fact.label}” has no citation source.`};
 if(!fact.verifiedAt)return {code:'FACT_UNVERIFIED',message:`Fact “${fact.label}” has no verification date.`};
 if(fact.effectiveAt&&new Date(fact.effectiveAt).getTime()>now.getTime())return {code:'FACT_NOT_YET_EFFECTIVE',message:`Fact “${fact.label}” is not effective until ${fact.effectiveAt}.`};
 if(!fact.expiresAt||!(new Date(fact.expiresAt).getTime()>now.getTime()))return {code:'FACT_EXPIRED',message:`Fact “${fact.label}” has expired; re-verify it before use.`};
 return null;
}
const PRICE_PATTERN=/(?:US\$|\$|USD\s?)\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/gi;
const DISCOUNT_PATTERN=/(\d{1,3}(?:\.\d{1,2})?)\s?%\s?(?:off|discount)|(?:save|discount of|discounted by)\s(\d{1,3}(?:\.\d{1,2})?)\s?%/gi;
export function extractPrices(source:string):number[]{return [...source.replace(PLACEHOLDER,' ').matchAll(PRICE_PATTERN)].map(m=>Number(m[1]!.replace(/,/g,''))*100+Number((m[2]??'0').padEnd(2,'0')));}
export function extractDiscounts(source:string):number[]{return [...source.replace(PLACEHOLDER,' ').matchAll(DISCOUNT_PATTERN)].map(m=>Math.round(Number(m[1]??m[2])*100));}
const numbersIn=(value:string)=>[...value.matchAll(/\d+(?:[.,]\d+)*/g)].map(m=>m[0].replace(/,/g,''));
const SUPERLATIVE=/\b(fastest|cheapest|best|leading|largest|most popular|number one|proven|award[- ]winning|industry[- ]leading)\b|#1\b|no\.\s?1\b/i;
const OUTCOME_PROMISES=['guarantee','guaranteed','risk-free','risk free','no risk','assured return','cannot lose','can\'t lose','double your','triple your'];
export function splitSentences(source:string):string[]{return source.split(/(?<=[.!?])\s+|\n+/).map(s=>s.trim()).filter(Boolean);}
const quote=(value:string)=>`“${value.length>90?value.slice(0,87)+'…':value}”`;
/** DOTS-085: every number or measurable superlative must sit next to a cited, active, sourced, unexpired fact containing that number. */
export function checkClaims(source:string,facts:ReadonlyMap<string,FactInfo>,projectId:string|null,now:Date):Issue[]{
 const issues:Issue[]=[];const cited=parsePlaceholders(source).facts;
 for(const id of cited){const problem=factProblem(facts.get(id),projectId,now);if(problem)issues.push(blocking(problem.code,problem.message,'copy'));}
 for(const sentence of splitSentences(source)){
  const slotIds=parsePlaceholders(sentence).facts;const valid=slotIds.map(id=>facts.get(id)).filter((f):f is FactInfo=>Boolean(f)&&!factProblem(f,projectId,now));
  const bare=sentence.replace(PLACEHOLDER,' ').replace(PRICE_PATTERN,' ').replace(DISCOUNT_PATTERN,' ');
  const factNumbers=new Set(valid.flatMap(f=>numbersIn(f.body)));
  const unsupported=numbersIn(bare).filter(n=>!factNumbers.has(n));
  if(unsupported.length)issues.push(blocking('UNSUPPORTED_NUMERIC_CLAIM',`${quote(sentence)} states ${unsupported.join(', ')} without a cited vetted fact containing that figure. Put the number inside a {{fact:<id>}} slot or remove it.`,'copy'));
  if(SUPERLATIVE.test(bare)&&!valid.length)issues.push(blocking('UNSUPPORTED_SUPERLATIVE',`${quote(sentence)} makes a measurable superlative claim without a cited vetted fact.`,'copy'));
  const lower=bare.toLowerCase();const promise=OUTCOME_PROMISES.find(p=>lower.includes(p));
  if(promise)issues.push(blocking('UNAPPROVED_OUTCOME_PROMISE',`${quote(sentence)} promises an outcome (“${promise}”). Agents may not promise guaranteed or risk-free results.`,'copy'));
 }
 return issues;
}
export type PriceRule={authorizedPricesCents:number[];maxDiscountBp:number;restrictedPhrases:string[]};
export type PriceException={amountCents:number|null;discountBp:number|null};
const dollars=(value:number)=>`$${(value/100).toFixed(value%100?2:0)}`;
export function priceAllowed(rule:PriceRule,amount:number,exceptions:readonly PriceException[]=[]):boolean{
 if(rule.authorizedPricesCents.includes(amount)||exceptions.some(e=>e.amountCents===amount))return true;
 return rule.authorizedPricesCents.some(list=>amount<list&&(list-amount)*10000<=list*rule.maxDiscountBp);
}
/** Quote check (draft or quotation): exact authorized price, an authorized discount from one, or an owner-approved exception. */
export function validateQuote(rule:PriceRule|null,quotedCents:number,exceptions:readonly PriceException[]=[]):{ok:boolean;reason?:string}{
 if(!Number.isSafeInteger(quotedCents)||quotedCents<=0)return {ok:false,reason:'INVALID_AMOUNT'};
 if(!rule)return {ok:false,reason:'PRICE_RULE_MISSING'};
 return priceAllowed(rule,quotedCents,exceptions)?{ok:true}:{ok:false,reason:'PRICE_NOT_AUTHORIZED'};
}
/** DOTS-086: prices, discounts and restricted phrases in copy must match the offer's authorized terms. */
export function checkPricing(source:string,rule:PriceRule|null,exceptions:readonly PriceException[]=[]):Issue[]{
 const issues:Issue[]=[];const prices=extractPrices(source),discounts=extractDiscounts(source);
 if((prices.length||discounts.length)&&!rule)return [blocking('PRICE_RULE_MISSING','The copy mentions a price or discount, but the selected offer has no authorized price list.','copy')];
 if(!rule)return issues;
 for(const price of prices)if(!priceAllowed(rule,price,exceptions))issues.push(blocking('PRICE_NOT_AUTHORIZED',`The copy quotes ${dollars(price)}, which is not an authorized price for this offer (authorized: ${rule.authorizedPricesCents.map(dollars).join(', ')}; maximum discount ${rule.maxDiscountBp/100}%). Request an owner price exception or change the copy.`,'copy'));
 for(const bp of discounts)if(bp>rule.maxDiscountBp&&!exceptions.some(e=>(e.discountBp??0)>=bp))issues.push(blocking('DISCOUNT_EXCEEDS_LIMIT',`The copy offers ${bp/100}% off, above the ${rule.maxDiscountBp/100}% maximum discount for this offer.`,'copy'));
 const lower=source.toLowerCase();
 for(const phrase of rule.restrictedPhrases)if(phrase&&lower.includes(phrase.toLowerCase()))issues.push(blocking('RESTRICTED_CLAIM',`The copy uses the restricted phrase “${phrase}” for this offer.`,'copy'));
 return issues;
}
export type TemplateContent={subject:string;bodyText:string;bodyHtml?:string|null};
export type RenderValues={contact:Record<string,string>;sender?:string;offer?:string;project?:string;facts:ReadonlyMap<string,FactInfo>};
function substitute(source:string,values:RenderValues,escape:(v:string)=>string):string{
 return source.replace(PLACEHOLDER,(_m,key:string)=>{
  const name=key.trim();const fact=/^fact:(.+)$/i.exec(name);
  if(fact)return escape(values.facts.get(fact[1]!.toLowerCase())?.body??'[unverified fact removed]');
  const value=name.startsWith('contact.')?values.contact[name.slice(8)]:name==='sender.name'?values.sender:name==='offer.name'?values.offer:name==='project.name'?values.project:undefined;
  return escape(value??'');
 });
}
/** Renders exact copy; values are escaped and the final HTML is sanitized again so variables cannot smuggle markup or javascript: links. */
export function renderTemplate(content:TemplateContent,values:RenderValues){
 const subject=substitute(content.subject,values,v=>v).replace(/[\r\n]+/g,' ').slice(0,240);
 const textBody=substitute(content.bodyText,values,v=>v);
 const html=content.bodyHtml?sanitizeHtml(substitute(sanitizeHtml(content.bodyHtml),values,escapeHtml)):null;
 return {subject,text:textBody,html};
}
export function checkTemplate(content:TemplateContent,facts:ReadonlyMap<string,FactInfo>,projectId:string|null,rule:PriceRule|null,exceptions:readonly PriceException[],now:Date):Issue[]{
 const combined=[content.subject,content.bodyText,content.bodyHtml?htmlToText(content.bodyHtml):''].join('\n');
 const placeholders=parsePlaceholders(combined);const issues:Issue[]=[];
 for(const key of placeholders.unknown)issues.push(blocking('UNKNOWN_VARIABLE',`{{${key}}} is not a supported variable. Use one of: ${templateVariables.join(', ')} or {{fact:<id>}}.`,'copy'));
 if(placeholders.malformed)issues.push(blocking('MALFORMED_PLACEHOLDER','The copy contains an unbalanced {{ or }} placeholder.','copy'));
 return [...issues,...checkClaims(combined,facts,projectId,now),...checkPricing(combined,rule,exceptions)];
}
/** Synthetic prospects used for every preview and dry-run; never real people. */
export const syntheticProspects=[
 {first_name:'Avery',last_name:'Example',full_name:'Avery Example',company:'Example Fabrication Co. (synthetic)',role:'Operations lead',country:'US',consent:'opted_in'},
 {first_name:'Jordan',last_name:'Sample',full_name:'Jordan Sample',company:'Sample Analytics Ltd. (synthetic)',role:'Head of finance',country:'GB',consent:'opted_in'},
 {first_name:'Riley',last_name:'Placeholder',full_name:'Riley Placeholder',company:'Placeholder Health (synthetic)',role:'Clinic manager',country:'CA',consent:'existing_customer'},
 {first_name:'Morgan',last_name:'Fixture',full_name:'Morgan Fixture',company:'Fixture Logistics (synthetic)',role:'Procurement',country:'US',consent:'business_reviewed'},
 {first_name:'Casey',last_name:'Demo',full_name:'Casey Demo',company:'Demo Studio (synthetic)',role:'Founder',country:'DE',consent:'opted_in'},
] as const;

/* --------------------------------------------- jurisdiction, quiet hours, cadence */
export type ChannelPolicy={label:string;enabled:boolean;countries:readonly string[];maxDailyCap:number;consents:Readonly<Record<string,readonly string[]>>;disabledReason?:string};
export const channelPolicies:Readonly<Record<'email'|'sms',ChannelPolicy>>={
 email:{label:'Email',enabled:true,countries:['US','CA','GB','IE','AU','NZ','DE','FR','NL','ES','IT','SE','DK','FI','NO','BE','AT','CH','PT'],maxDailyCap:100,consents:{default:['opted_in','existing_customer'],US:['opted_in','existing_customer','business_reviewed']}},
 sms:{label:'SMS',enabled:false,countries:[],maxDailyCap:0,consents:{default:[]},disabledReason:'SMS outreach is disabled: no owner-reviewed SMS consent policy (express written consent under TCPA/PECR) exists for this workspace.'},
};
export const quietHours={startHour:20,endHour:8} as const;
export const maxMessagesPerContactPerWeek=2;
export function isValidTimeZone(zone:string):boolean{try{new Intl.DateTimeFormat('en-US',{timeZone:zone});return true;}catch{return false;}}
export function localClock(date:Date,zone:string){const parts=new Intl.DateTimeFormat('en-US',{timeZone:zone,hour:'numeric',hourCycle:'h23',weekday:'short'}).formatToParts(date);return {hour:Number(parts.find(p=>p.type==='hour')?.value??0)%24,weekday:parts.find(p=>p.type==='weekday')?.value??''};}
export type SendWindow={timezone:string;startHour:number;endHour:number;weekdaysOnly:boolean};
export function inSendWindow(date:Date,window:SendWindow):boolean{
 if(!isValidTimeZone(window.timezone))return false;const {hour,weekday}=localClock(date,window.timezone);
 if(window.weekdaysOnly&&(weekday==='Sat'||weekday==='Sun'))return false;
 return hour>=Math.max(window.startHour,quietHours.endHour)&&hour<Math.min(window.endHour,quietHours.startHour);
}
export function nextSendWindow(date:Date,window:SendWindow):Date|null{
 if(inSendWindow(date,window))return date;let probe=new Date(Math.ceil(date.getTime()/3600000)*3600000);
 for(let step=0;step<24*9;step++){if(inSendWindow(probe,window))return probe;probe=new Date(probe.getTime()+3600000);}
 return null;
}
const pad=(hour:number)=>`${String(hour).padStart(2,'0')}:00`;
export type RuleShape={purpose:string;channel:string;allowedCountries:string[];timezone:string;windowStartHour:number;windowEndHour:number;weekdaysOnly:boolean;dailyLimit:number;frequencyCap:number;cadenceDays:number;scheduleStartAt:Date|null;scheduleEndAt:Date|null;authorityRef:string|null};
/** DOTS-087: forbidden channel/country/purpose/time/cadence combinations fail with plain-language reasons. */
export function checkSendRules(rule:RuleShape,now:Date):Issue[]{
 const issues:Issue[]=[];const policy=channelPolicies[rule.channel as 'email'|'sms'];
 if(!policy)return [blocking('CHANNEL_UNKNOWN',`Channel ${rule.channel} is not supported.`,'channel')];
 if(!policy.enabled)issues.push(blocking('CHANNEL_DISABLED',policy.disabledReason??`${policy.label} outreach is disabled.`,'channel'));
 if(!rule.allowedCountries.length)issues.push(blocking('COUNTRIES_REQUIRED','Choose at least one recipient country for this campaign.','countries'));
 for(const country of rule.allowedCountries)if(!policy.countries.includes(country))issues.push(blocking('COUNTRY_CHANNEL_FORBIDDEN',`${policy.label} outreach to ${country} is not in the reviewed country list for this channel.`,'countries'));
 if(rule.purpose==='investment'){
  if(!rule.authorityRef)issues.push(blocking('AUTHORITY_REQUIRED','Investment outreach needs a reviewed owner/legal authority reference before it can be validated.','authority'));
  const foreign=rule.allowedCountries.filter(c=>c!=='US');if(foreign.length)issues.push(blocking('INVESTMENT_JURISDICTION_FORBIDDEN',`Investment outreach outside the United States (${foreign.join(', ')}) needs a separate securities-law review and is not allowed here.`,'countries'));
 }
 if(rule.purpose==='grant'&&!rule.authorityRef)issues.push(warning('AUTHORITY_RECOMMENDED','Grant outreach should record the owner authority reference used for later submissions.','authority'));
 if(!isValidTimeZone(rule.timezone))issues.push(blocking('TIMEZONE_INVALID',`“${rule.timezone}” is not a valid IANA time zone.`,'timezone'));
 if(rule.windowStartHour<quietHours.endHour||rule.windowEndHour>quietHours.startHour)issues.push(blocking('QUIET_HOURS',`The sending window ${pad(rule.windowStartHour)}–${pad(rule.windowEndHour)} overlaps quiet hours (${pad(quietHours.startHour)}–${pad(quietHours.endHour)} in ${rule.timezone}).`,'window'));
 if(rule.windowEndHour<=rule.windowStartHour)issues.push(blocking('WINDOW_INVALID','The sending window must end after it starts.','window'));
 if(policy.enabled&&rule.dailyLimit>policy.maxDailyCap)issues.push(blocking('DAILY_CAP_EXCEEDED',`A daily cap of ${rule.dailyLimit} exceeds the ${policy.maxDailyCap}-message daily limit for ${policy.label}.`,'dailyLimit'));
 if(rule.frequencyCap*7>maxMessagesPerContactPerWeek*rule.cadenceDays)issues.push(blocking('FREQUENCY_TOO_HIGH',`${rule.frequencyCap} message(s) per contact every ${rule.cadenceDays} day(s) exceeds the limit of ${maxMessagesPerContactPerWeek} per contact per week.`,'frequency'));
 if(!rule.scheduleStartAt)issues.push(blocking('SCHEDULE_REQUIRED','Set a start date and time for the campaign.','schedule'));
 else if(rule.scheduleStartAt.getTime()<now.getTime())issues.push(warning('SCHEDULE_START_PAST','The start time is in the past; the campaign starts as soon as it is activated.','schedule'));
 if(rule.scheduleEndAt&&rule.scheduleEndAt.getTime()<=now.getTime())issues.push(blocking('SCHEDULE_ENDED','The campaign end time has already passed.','schedule'));
 return issues;
}
export type ContactShape={id:string;status:string;consent:string;jurisdiction:string;role_title?:string|null;suppressed:boolean;recentTouches:number};
export const exclusionMessages:Record<string,string>={
 SUPPRESSED:'On the suppression list (opt-out, bounce, complaint or privacy request).',
 CONTACT_INACTIVE:'Contact is not active (suppressed, archived or redacted).',
 JURISDICTION_UNREVIEWED:'Contact country has not been reviewed.',
 COUNTRY_NOT_IN_CAMPAIGN:'Contact country is not in this campaign’s allowed countries.',
 COUNTRY_CHANNEL_FORBIDDEN:'This channel is not permitted for the contact’s country.',
 CONSENT_MISSING:'Recorded consent is not sufficient for this channel and country.',
 FREQUENCY_CAP:'Contact already reached the per-contact frequency cap in the cadence window.',
 NO_ELIGIBLE_VARIANT:'No active copy variant is eligible for this contact.',
};
export function contactExclusion(contact:ContactShape,rule:{channel:string;allowedCountries:string[];frequencyCap:number}):string|null{
 const policy=channelPolicies[rule.channel as 'email'|'sms'];const country=String(contact.jurisdiction??'').toUpperCase();
 if(contact.suppressed)return 'SUPPRESSED';
 if(contact.status!=='active')return 'CONTACT_INACTIVE';
 if(!country||country==='UNREVIEWED')return 'JURISDICTION_UNREVIEWED';
 if(!rule.allowedCountries.includes(country))return 'COUNTRY_NOT_IN_CAMPAIGN';
 if(!policy?.enabled||!policy.countries.includes(country))return 'COUNTRY_CHANNEL_FORBIDDEN';
 if(!(policy.consents[country]??policy.consents.default??[]).includes(contact.consent))return 'CONSENT_MISSING';
 if(contact.recentTouches>=rule.frequencyCap)return 'FREQUENCY_CAP';
 return null;
}

/* ------------------------------------------------------------------ variants */
export type VariantEligibility={countries?:string[];consents?:string[];roleIncludes?:string};
export type VariantShape={id:string;strategy_id:string;template_revision_id:string;weight:number;eligibility:VariantEligibility;status:string};
export function variantEligible(variant:VariantShape,contact:{jurisdiction:string;consent:string;role_title?:string|null}):boolean{
 const rule=variant.eligibility??{};if(variant.status!=='active')return false;
 if(rule.countries?.length&&!rule.countries.includes(String(contact.jurisdiction).toUpperCase()))return false;
 if(rule.consents?.length&&!rule.consents.includes(contact.consent))return false;
 if(rule.roleIncludes&&!String(contact.role_title??'').toLowerCase().includes(rule.roleIncludes.toLowerCase()))return false;
 return true;
}
/** Deterministic weighted assignment so retries and re-simulations pick the same variant for a contact. */
export function chooseVariant(variants:readonly VariantShape[],contact:{id:string;jurisdiction:string;consent:string;role_title?:string|null},campaignId:string):VariantShape|null{
 const eligible=[...variants].filter(v=>variantEligible(v,contact)).sort((a,b)=>a.id.localeCompare(b.id));if(!eligible.length)return null;
 const total=eligible.reduce((sum,v)=>sum+Number(v.weight),0);let point=parseInt(digest(`${campaignId}:${contact.id}`).slice(0,8),16)%total;
 for(const variant of eligible){point-=Number(variant.weight);if(point<0)return variant;}
 return eligible[eligible.length-1]!;
}

/* ---------------------------------------------------------- approval binding */
const iso=(value:unknown):string|null=>value===null||value===undefined?null:new Date(value as string).toISOString();
const asDate=(value:unknown):Date|null=>value===null||value===undefined?null:new Date(value as string);
type Loaded={campaign:Row;audience:Row|null;budget:Row|null;variants:Row[];template:Row|null;variantTemplates:Map<string,Row>;mailbox:Row|null;project:Row|null;offer:Row|null;rule:PriceRule|null;ruleVersion:number|null;exceptions:PriceException[];facts:Map<string,FactInfo>;strategy:Row|null};
/** Exactly what the owner approves: sender, audience hash, channel, budget, exact message revision(s), schedule and send rules. */
export function approvalBinding(loaded:Pick<Loaded,'campaign'|'audience'|'budget'|'variants'|'ruleVersion'>&{citedFacts?:{id:string;version:number}[]}){
 const c=loaded.campaign;
 return {
  campaignId:String(c.id),revision:Number(c.revision),purpose:c.purpose,projectId:c.project_id,goal:c.goal,offerId:c.offer_id??null,strategyId:c.strategy_id??null,
  senderMailboxId:c.mailbox_id??null,channel:c.channel,allowedCountries:[...(c.allowed_countries??[])].sort(),
  audienceRevisionId:loaded.audience?.id??null,audienceHash:loaded.audience?.audience_hash??null,audienceCount:loaded.audience?Number(loaded.audience.contact_count):0,
  totalBudgetCents:loaded.budget?Number(loaded.budget.total_cents):null,perMessageMaxCents:loaded.budget?Number(loaded.budget.per_message_max_cents):null,budgetRevisionId:loaded.budget?.id??null,
  messageRevisionId:c.template_revision_id??null,
  variants:loaded.variants.filter(v=>v.status==='active').map(v=>({id:v.id,strategyId:v.strategy_id,templateRevisionId:v.template_revision_id,weight:Number(v.weight),eligibility:v.eligibility})).sort((a,b)=>String(a.id).localeCompare(String(b.id))),
  schedule:{startAt:iso(c.schedule_start_at),endAt:iso(c.schedule_end_at),timezone:c.timezone,windowStartHour:Number(c.send_window_start_hour),windowEndHour:Number(c.send_window_end_hour),weekdaysOnly:Boolean(c.weekdays_only)},
  caps:{dailyLimit:Number(c.daily_limit),frequencyCap:Number(c.frequency_cap),cadenceDays:Number(c.cadence_days)},
  priceRuleVersion:loaded.ruleVersion,citedFacts:loaded.citedFacts??[],authorityRef:c.authority_ref??null,agentIdentityId:c.agent_identity_id??null,priority:Number(c.priority),
 };
}
const ruleShape=(c:Row):RuleShape=>({purpose:c.purpose,channel:c.channel,allowedCountries:[...(c.allowed_countries??[])],timezone:c.timezone,windowStartHour:Number(c.send_window_start_hour),windowEndHour:Number(c.send_window_end_hour),weekdaysOnly:Boolean(c.weekdays_only),dailyLimit:Number(c.daily_limit),frequencyCap:Number(c.frequency_cap),cadenceDays:Number(c.cadence_days),scheduleStartAt:asDate(c.schedule_start_at),scheduleEndAt:asDate(c.schedule_end_at),authorityRef:c.authority_ref??null});
const windowOf=(c:Row):SendWindow=>({timezone:c.timezone,startHour:Number(c.send_window_start_hour),endHour:Number(c.send_window_end_hour),weekdaysOnly:Boolean(c.weekdays_only)});
const contentOf=(t:Row):TemplateContent=>({subject:t.subject,bodyText:t.body_text,bodyHtml:t.body_html});

const MATERIAL_FIELDS:Record<string,string>={goal:'goal',offerId:'offer_id',strategyId:'strategy_id',mailboxId:'mailbox_id',channel:'channel',allowedCountries:'allowed_countries',timezone:'timezone',windowStartHour:'send_window_start_hour',windowEndHour:'send_window_end_hour',weekdaysOnly:'weekdays_only',frequencyCap:'frequency_cap',cadenceDays:'cadence_days',dailyLimit:'daily_limit',scheduleStartAt:'schedule_start_at',scheduleEndAt:'schedule_end_at',templateRevisionId:'template_revision_id',priority:'priority',agentIdentityId:'agent_identity_id',authorityRef:'authority_ref'};
const intIn=(value:unknown,min:number,max:number,code:string)=>{if(typeof value!=='number'||!Number.isSafeInteger(value)||value<min||value>max)return fail(code,400);return value;};
function normalizeField(key:string,value:unknown):unknown{
 switch(key){
  case 'goal':return text(value,'goal',2000);
  case 'offerId':case 'strategyId':case 'mailboxId':case 'templateRevisionId':case 'agentIdentityId':return value===null||value===''?null:identifier(value);
  case 'channel':return selection(value,['email','sms'],'channel');
  case 'allowedCountries':{if(!Array.isArray(value)||value.length>60)return fail('INVALID_COUNTRIES',400);const list=[...new Set(value.map(v=>String(v).trim().toUpperCase()))];if(list.some(c=>!/^[A-Z]{2}$/.test(c)))return fail('INVALID_COUNTRIES',400);return list.sort();}
  case 'timezone':{const zone=text(value,'timezone',64);if(!isValidTimeZone(zone))return fail('INVALID_TIMEZONE',400);return zone;}
  case 'windowStartHour':return intIn(value,0,23,'INVALID_WINDOW');
  case 'windowEndHour':return intIn(value,1,24,'INVALID_WINDOW');
  case 'weekdaysOnly':if(typeof value!=='boolean')return fail('INVALID_WEEKDAYS',400);return value;
  case 'frequencyCap':return intIn(value,1,10,'INVALID_FREQUENCY');
  case 'cadenceDays':return intIn(value,1,90,'INVALID_CADENCE');
  case 'dailyLimit':return intIn(value,1,100,'INVALID_DAILY_LIMIT');
  case 'priority':return intIn(value,0,100,'INVALID_PRIORITY');
  case 'scheduleStartAt':case 'scheduleEndAt':{const d=dateOrNull(value);return d===null?null:new Date(d).toISOString();}
  case 'authorityRef':return value===null||value===''?null:text(value,'authority',200);
  default:return fail('UNKNOWN_FIELD',400);
 }
}
const comparable=(value:unknown)=>value instanceof Date?value.toISOString():Array.isArray(value)?JSON.stringify([...value].map(String).sort()):value===null||value===undefined?null:typeof value==='number'||typeof value==='boolean'?value:String(value);

/* ------------------------------------------------------------------- studio */
export type CampaignDraftInput={projectId:string;label:string;purpose:string;goal:string}&Record<string,unknown>;
export class CampaignStudio {
 private readonly clock:()=>Date;
 constructor(private readonly client:Client,private readonly ctx:Context,options:{clock?:()=>Date}={}){this.clock=options.clock??(()=>new Date());}
 private run<T>(fn:(tx:Client)=>Promise<T>){return tenant(this.client,this.ctx,fn);}

 async createDraft(input:CampaignDraftInput){
  identifier(input.projectId);const label=text(input.label,'campaign',160),goal=text(input.goal,'goal',2000),purpose=selection(input.purpose,['product','grant','investment'],'purpose');
  const fields:Record<string,unknown>={};for(const [key,column] of Object.entries(MATERIAL_FIELDS))if(key!=='goal'&&input[key]!==undefined)fields[column]=normalizeField(key,input[key]);
  return this.run(async tx=>{
   const project=rows(await tx.query("SELECT content FROM app.projects WHERE organization_id=$1 AND id=$2 AND status='active'",[this.ctx.organizationId,input.projectId]))[0];if(!project)return fail('PROJECT_NOT_ACTIVE');
   if(project.content?.category&&project.content.category!==purpose)return fail('PROJECT_PURPOSE_MISMATCH',400);
   const columns=['organization_id','project_id','label','purpose','goal',...Object.keys(fields)];const values=[this.ctx.organizationId,input.projectId,label,purpose,goal,...Object.values(fields)];
   const campaign=rows(await tx.query(`INSERT INTO app.campaigns(${columns.join(',')}) VALUES(${columns.map((_,i)=>`$${i+1}`).join(',')}) RETURNING *`,values))[0]!;
   const snapshot={reason:'created',binding:approvalBinding({campaign,audience:null,budget:null,variants:[],ruleVersion:null})};
   await tx.query('INSERT INTO app.campaign_revisions(organization_id,campaign_id,revision,snapshot,content_hash) VALUES($1,$2,1,$3::jsonb,$4)',[this.ctx.organizationId,campaign.id,JSON.stringify(snapshot),digest(snapshot)]);
   await event(tx,this.ctx,'campaign.created',campaign.id,{purpose,revision:1});return campaign;
  });
 }

 private async lock(tx:Client,id:string,expectedVersion?:number){
  const campaign=rows(await tx.query('SELECT * FROM app.campaigns WHERE organization_id=$1 AND id=$2 FOR UPDATE',[this.ctx.organizationId,identifier(id)]))[0];if(!campaign)return fail('NOT_FOUND',404);
  if(expectedVersion!==undefined&&Number(campaign.version)!==expectedVersion)return fail('VERSION_CONFLICT');
  return campaign;
 }
 /** Any material edit: new immutable revision, back to draft, approvals revoked, unsent queued work cancelled. */
 private async revise(tx:Client,campaign:Row,changes:Record<string,unknown>,reason:string){
  if(!editableCampaignStates.includes(campaign.state))return fail(campaign.state==='active'?'PAUSE_CAMPAIGN_FIRST':'CAMPAIGN_NOT_EDITABLE');
  const columns=Object.keys(changes);const values=Object.values(changes);
  const sets=[...columns.map((c,i)=>`${c}=$${i+5}`),'revision=revision+1',"state='draft'",'approved_revision=NULL','approved_hash=NULL','approval_id=NULL','version=version+1','updated_at=app.utc_now()'];
  const updated=rows(await tx.query(`UPDATE app.campaigns SET ${sets.join(',')} WHERE organization_id=$1 AND id=$2 AND version=$3 AND state=ANY($4::text[]) RETURNING *`,[this.ctx.organizationId,campaign.id,campaign.version,[...editableCampaignStates],...values]))[0];
  if(!updated)return fail('VERSION_CONFLICT');
  const revoked=rows(await tx.query("UPDATE app.action_approvals SET status='expired' WHERE organization_id=$1 AND record_id=$2 AND action_kind='campaign' AND status IN ('pending','approved') RETURNING id",[this.ctx.organizationId,campaign.id]));
  const cancelled=rows(await tx.query("UPDATE app.task_queue SET state='cancelled',last_reason='CAMPAIGN_REVISED',fencing_token=fencing_token+1,lease_expires_at=NULL,updated_at=app.utc_now() WHERE organization_id=$1 AND state IN ('queued','waiting') AND id IN (SELECT task_id FROM app.campaign_work_items WHERE organization_id=$1 AND campaign_id=$2) RETURNING id",[this.ctx.organizationId,campaign.id]));
  const loaded=await this.load(tx,updated);const snapshot={reason,changedFields:columns,binding:this.binding(loaded)};
  await tx.query('INSERT INTO app.campaign_revisions(organization_id,campaign_id,revision,snapshot,content_hash) VALUES($1,$2,$3,$4::jsonb,$5)',[this.ctx.organizationId,campaign.id,Number(updated.revision),JSON.stringify(snapshot),digest(snapshot)]);
  await event(tx,this.ctx,'campaign.revised',campaign.id,{revision:Number(updated.revision),reason,changedFields:columns,previousState:campaign.state,approvalsRevoked:revoked.length,queuedWorkCancelled:cancelled.length});
  return updated;
 }
 private async move(tx:Client,campaign:Row,to:CampaignState,extra:Record<string,unknown>={},details:Record<string,unknown>={}){
  if(!canTransition(campaign.state,to))return fail('TRANSITION_NOT_ALLOWED');
  const columns=Object.keys(extra);const sets=[`state='${to}'`,...columns.map((c,i)=>`${c}=$${i+5}`),'version=version+1','updated_at=app.utc_now()'];
  const updated=rows(await tx.query(`UPDATE app.campaigns SET ${sets.join(',')} WHERE organization_id=$1 AND id=$2 AND version=$3 AND state=ANY($4::text[]) RETURNING *`,[this.ctx.organizationId,campaign.id,campaign.version,statesInto(to),...Object.values(extra)]))[0];
  if(!updated)return fail('VERSION_CONFLICT');
  await event(tx,this.ctx,'campaign.state_changed',campaign.id,{from:campaign.state,to,revision:Number(updated.revision),...details});return updated;
 }

 async saveDraft(id:string,expectedVersion:number,patch:Record<string,unknown>){
  intIn(expectedVersion,1,Number.MAX_SAFE_INTEGER,'INVALID_VERSION');if(!patch||typeof patch!=='object')return fail('INVALID_REQUEST',400);
  const label=patch.label===undefined?undefined:text(patch.label,'campaign',160);
  const normalized:Record<string,unknown>={};for(const [key,value] of Object.entries(patch))if(key!=='label'&&value!==undefined)normalized[MATERIAL_FIELDS[key]??fail('UNKNOWN_FIELD',400)]=normalizeField(key,value);
  return this.run(async tx=>{
   let campaign=await this.lock(tx,id,expectedVersion);
   const changes=Object.fromEntries(Object.entries(normalized).filter(([column,value])=>comparable(campaign[column])!==comparable(value)));
   if(changes.template_revision_id)await this.assertTemplateRevision(tx,String(changes.template_revision_id),campaign);
   if(changes.mailbox_id&&!rows(await tx.query('SELECT id FROM app.mailboxes WHERE organization_id=$1 AND id=$2',[this.ctx.organizationId,changes.mailbox_id])).length)return fail('MAILBOX_NOT_FOUND',404);
   if(label!==undefined&&label!==campaign.label){
    campaign=rows(await tx.query('UPDATE app.campaigns SET label=$4,version=version+1,updated_at=app.utc_now() WHERE organization_id=$1 AND id=$2 AND version=$3 RETURNING *',[this.ctx.organizationId,campaign.id,campaign.version,label]))[0]??fail('VERSION_CONFLICT');
    await event(tx,this.ctx,'campaign.renamed',campaign.id);
   }
   if(Object.keys(changes).length)campaign=await this.revise(tx,campaign,changes,'draft_saved');
   return campaign;
  });
 }
 private async assertTemplateRevision(tx:Client,revisionId:string,campaign:Row){
  const revision=rows(await tx.query('SELECT r.id,t.project_id,t.channel FROM app.message_template_revisions r JOIN app.message_templates t ON t.organization_id=r.organization_id AND t.id=r.template_id WHERE r.organization_id=$1 AND r.id=$2',[this.ctx.organizationId,revisionId]))[0];
  if(!revision)return fail('TEMPLATE_REVISION_NOT_FOUND',404);if(revision.project_id&&revision.project_id!==campaign.project_id)return fail('TEMPLATE_PROJECT_MISMATCH',400);return revision;
 }

 async setAudience(id:string,expectedVersion:number,input:{contactIds?:unknown;segment?:Record<string,unknown>}){
  const explicit=Array.isArray(input.contactIds)?input.contactIds.map(identifier):[];if(explicit.length>5000)return fail('AUDIENCE_TOO_LARGE',400);
  const raw=input.segment??{};const segment:{jurisdictions?:string[];consents?:string[];accountId?:string}={};
  if(Array.isArray(raw.jurisdictions))segment.jurisdictions=[...new Set(raw.jurisdictions.map(v=>String(v).toUpperCase()))].filter(v=>/^[A-Z]{2}$/.test(v)).sort();
  if(Array.isArray(raw.consents))segment.consents=raw.consents.map(v=>selection(v,['opted_in','existing_customer','business_reviewed','unknown'],'consent')).sort();
  if(raw.accountId)segment.accountId=identifier(raw.accountId);
  const useSegment=Boolean(segment.jurisdictions?.length||segment.consents?.length||segment.accountId);
  return this.run(async tx=>{
   const campaign=await this.lock(tx,id,expectedVersion);
   const matched=rows(await tx.query(`SELECT id::text AS id FROM app.crm_contacts WHERE organization_id=$1 AND status='active' AND (id::text=ANY($2::text[]) OR ($3::boolean AND ($4::text[] IS NULL OR jurisdiction=ANY($4::text[])) AND ($5::text[] IS NULL OR consent=ANY($5::text[])) AND ($6::uuid IS NULL OR account_id=$6::uuid))) ORDER BY id LIMIT 5001`,
    [this.ctx.organizationId,explicit,useSegment,segment.jurisdictions?.length?segment.jurisdictions:null,segment.consents?.length?segment.consents:null,segment.accountId??null])).map(r=>String(r.id));
   if(matched.length>5000)return fail('AUDIENCE_TOO_LARGE',400);
   const next=Number(rows(await tx.query('SELECT COALESCE(max(revision),0)+1 AS next FROM app.campaign_audience_revisions WHERE organization_id=$1 AND campaign_id=$2',[this.ctx.organizationId,campaign.id]))[0]!.next);
   const hash=digest({contactIds:matched,segment});
   const audience=rows(await tx.query('INSERT INTO app.campaign_audience_revisions(organization_id,campaign_id,revision,segment,contact_ids,contact_count,audience_hash,created_by_membership_id) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8) RETURNING *',[this.ctx.organizationId,campaign.id,next,JSON.stringify(segment),JSON.stringify(matched),matched.length,hash,this.ctx.membershipId]))[0]!;
   await tx.query('DELETE FROM app.campaign_audience WHERE organization_id=$1 AND campaign_id=$2',[this.ctx.organizationId,campaign.id]);
   if(matched.length)await tx.query('INSERT INTO app.campaign_audience(organization_id,campaign_id,contact_id) SELECT $1::app.entity_id,$2::app.entity_id,unnest($3::uuid[])',[this.ctx.organizationId,campaign.id,matched]);
   const updated=await this.revise(tx,campaign,{audience_revision_id:audience.id},'audience_changed');
   return {campaign:updated,audience};
  });
 }

 async setBudget(id:string,expectedVersion:number,input:{totalCents:unknown;perMessageMaxCents:unknown;authorizationRef?:unknown}){
  const total=cents(input.totalCents),per=cents(input.perMessageMaxCents);if(per>total)return fail('PER_MESSAGE_EXCEEDS_TOTAL',400);
  const authorization=input.authorizationRef?text(input.authorizationRef,'authorization',200):null;if(total>0&&!authorization)return fail('SPEND_AUTHORIZATION_REQUIRED',403);
  return this.run(async tx=>{
   const campaign=await this.lock(tx,id,expectedVersion);
   const next=Number(rows(await tx.query('SELECT COALESCE(max(revision),0)+1 AS next FROM app.campaign_budget_revisions WHERE organization_id=$1 AND campaign_id=$2',[this.ctx.organizationId,campaign.id]))[0]!.next);
   const budget=rows(await tx.query('INSERT INTO app.campaign_budget_revisions(organization_id,campaign_id,revision,total_cents,per_message_max_cents,authorization_ref,created_by_membership_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[this.ctx.organizationId,campaign.id,next,total,per,authorization,this.ctx.membershipId]))[0]!;
   const updated=await this.revise(tx,campaign,{budget_revision_id:budget.id,budget_cents:total},'budget_changed');
   return {campaign:updated,budget};
  });
 }

 async createTemplate(input:{projectId?:unknown;label:unknown;channel?:unknown}){
  const label=text(input.label,'template',160),channel=selection(input.channel??'email',['email','sms'],'channel');const projectId=input.projectId?identifier(input.projectId):null;
  return this.run(async tx=>{const template=rows(await tx.query('INSERT INTO app.message_templates(organization_id,project_id,label,channel) VALUES($1,$2,$3,$4) RETURNING *',[this.ctx.organizationId,projectId,label,channel]))[0]!;await event(tx,this.ctx,'template.created',template.id);return template;});
 }
 private normalizeContent(input:{subject:unknown;bodyText:unknown;bodyHtml?:unknown}){
  const subject=text(input.subject,'subject',240),bodyText=text(input.bodyText,'body',20000);
  const rawHtml=typeof input.bodyHtml==='string'&&input.bodyHtml.trim()?input.bodyHtml:null;if(rawHtml&&rawHtml.length>100000)return fail('INVALID_HTML',400);
  const bodyHtml=rawHtml?sanitizeHtml(rawHtml):null;return {subject,bodyText,bodyHtml,sanitized:rawHtml!==null&&bodyHtml!==rawHtml};
 }
 private async insertRevision(tx:Client,template:Row,content:{subject:string;bodyText:string;bodyHtml:string|null}){
  const placeholders=parsePlaceholders([content.subject,content.bodyText,content.bodyHtml??''].join('\n'));const revision=Number(template.latest_revision)+1;
  const saved=rows(await tx.query('INSERT INTO app.message_template_revisions(organization_id,template_id,revision,subject,body_text,body_html,fact_ids,variables,content_hash,created_by_membership_id) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10) RETURNING *',
   [this.ctx.organizationId,template.id,revision,content.subject,content.bodyText,content.bodyHtml,JSON.stringify(placeholders.facts),JSON.stringify(placeholders.variables),digest(content),this.ctx.membershipId]))[0]!;
  const updated=rows(await tx.query('UPDATE app.message_templates SET latest_revision=$4,version=version+1,updated_at=app.utc_now() WHERE organization_id=$1 AND id=$2 AND version=$3 RETURNING id',[this.ctx.organizationId,template.id,template.version,revision]));if(!updated.length)return fail('VERSION_CONFLICT');
  await event(tx,this.ctx,'template.revised',template.id,{revision,revisionId:saved.id,contentHash:saved.content_hash});return saved;
 }
 /** Template edits never mutate history: each save is a new immutable revision. */
 async reviseTemplate(templateId:string,expectedVersion:number,input:{subject:unknown;bodyText:unknown;bodyHtml?:unknown}){
  const content=this.normalizeContent(input);
  return this.run(async tx=>{
   const template=rows(await tx.query("SELECT * FROM app.message_templates WHERE organization_id=$1 AND id=$2 AND status='active' FOR UPDATE",[this.ctx.organizationId,identifier(templateId)]))[0];if(!template)return fail('NOT_FOUND',404);
   if(Number(template.version)!==expectedVersion)return fail('VERSION_CONFLICT');
   return {revision:await this.insertRevision(tx,template,content),sanitized:content.sanitized};
  });
 }
 /** Edit the campaign's copy in one step: creates a new template revision and points the campaign at it, which revokes any approval. */
 async editCopy(id:string,expectedVersion:number,input:{subject:unknown;bodyText:unknown;bodyHtml?:unknown}){
  const content=this.normalizeContent(input);
  return this.run(async tx=>{
   const campaign=await this.lock(tx,id,expectedVersion);if(!editableCampaignStates.includes(campaign.state))return fail(campaign.state==='active'?'PAUSE_CAMPAIGN_FIRST':'CAMPAIGN_NOT_EDITABLE');
   let template=campaign.template_revision_id?rows(await tx.query('SELECT t.* FROM app.message_templates t JOIN app.message_template_revisions r ON r.organization_id=t.organization_id AND r.template_id=t.id WHERE t.organization_id=$1 AND r.id=$2 FOR UPDATE OF t',[this.ctx.organizationId,campaign.template_revision_id]))[0]:undefined;
   if(!template)template=rows(await tx.query('INSERT INTO app.message_templates(organization_id,project_id,label,channel) VALUES($1,$2,$3,$4) RETURNING *',[this.ctx.organizationId,campaign.project_id,`${campaign.label} copy`.slice(0,160),campaign.channel]))[0]!;
   const revision=await this.insertRevision(tx,template,content);
   const updated=await this.revise(tx,campaign,{template_revision_id:revision.id},'copy_changed');
   return {campaign:updated,revision,sanitized:content.sanitized};
  });
 }

 async addVariant(id:string,expectedVersion:number,input:{label:unknown;strategyId:unknown;templateRevisionId:unknown;weight?:unknown;eligibility?:Record<string,unknown>}){
  const label=text(input.label,'variant',120),strategyId=identifier(input.strategyId),revisionId=identifier(input.templateRevisionId),weight=input.weight===undefined?1:intIn(input.weight,1,10000,'INVALID_WEIGHT');
  const raw=input.eligibility??{};const eligibility:VariantEligibility={};
  if(Array.isArray(raw.countries))eligibility.countries=[...new Set(raw.countries.map(v=>String(v).toUpperCase()))].filter(v=>/^[A-Z]{2}$/.test(v)).sort();
  if(Array.isArray(raw.consents))eligibility.consents=raw.consents.map(v=>selection(v,['opted_in','existing_customer','business_reviewed'],'consent')).sort();
  if(raw.roleIncludes)eligibility.roleIncludes=text(raw.roleIncludes,'role',80);
  return this.run(async tx=>{
   const campaign=await this.lock(tx,id,expectedVersion);await this.assertTemplateRevision(tx,revisionId,campaign);
   if(!editableCampaignStates.includes(campaign.state))return fail(campaign.state==='active'?'PAUSE_CAMPAIGN_FIRST':'CAMPAIGN_NOT_EDITABLE');
   const variant=rows(await tx.query('INSERT INTO app.campaign_variants(organization_id,campaign_id,label,strategy_id,template_revision_id,weight,eligibility) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING *',[this.ctx.organizationId,campaign.id,label,strategyId,revisionId,weight,JSON.stringify(eligibility)]))[0]!;
   const updated=await this.revise(tx,campaign,{},'variant_added');return {campaign:updated,variant};
  });
 }
 async retireVariant(id:string,expectedVersion:number,variantId:string){
  return this.run(async tx=>{
   const campaign=await this.lock(tx,id,expectedVersion);if(!editableCampaignStates.includes(campaign.state))return fail(campaign.state==='active'?'PAUSE_CAMPAIGN_FIRST':'CAMPAIGN_NOT_EDITABLE');
   const variant=rows(await tx.query("UPDATE app.campaign_variants SET status='retired',retired_at=app.utc_now() WHERE organization_id=$1 AND campaign_id=$2 AND id=$3 AND status='active' RETURNING id",[this.ctx.organizationId,campaign.id,identifier(variantId)]));if(!variant.length)return fail('NOT_FOUND',404);
   return this.revise(tx,campaign,{},'variant_retired');
  });
 }

 async setPriceRule(offerId:string,input:{authorizedPricesCents:unknown;maxDiscountBp:unknown;restrictedPhrases?:unknown},expectedVersion?:number){
  if(!Array.isArray(input.authorizedPricesCents)||!input.authorizedPricesCents.length||input.authorizedPricesCents.length>50)return fail('INVALID_PRICES',400);
  const prices=[...new Set(input.authorizedPricesCents.map(cents))].filter(p=>p>0).sort((a,b)=>a-b);if(!prices.length)return fail('INVALID_PRICES',400);
  const discount=intIn(input.maxDiscountBp,0,10000,'INVALID_DISCOUNT');
  const phrases=Array.isArray(input.restrictedPhrases)?input.restrictedPhrases.slice(0,100).map(p=>text(p,'phrase',120)):[];
  return this.run(async tx=>{
   const offer=rows(await tx.query("SELECT id,project_id FROM app.offers WHERE organization_id=$1 AND id=$2 AND status='active'",[this.ctx.organizationId,identifier(offerId)]))[0];if(!offer)return fail('OFFER_NOT_FOUND',404);
   const prior=rows(await tx.query('SELECT * FROM app.offer_price_rules WHERE organization_id=$1 AND offer_id=$2 FOR UPDATE',[this.ctx.organizationId,offer.id]))[0];
   let saved:Row;
   if(prior){if(expectedVersion!==undefined&&Number(prior.version)!==expectedVersion)return fail('VERSION_CONFLICT');saved=rows(await tx.query('UPDATE app.offer_price_rules SET authorized_prices_cents=$3,max_discount_bp=$4,restricted_phrases=$5,version=version+1,updated_by_membership_id=$6,updated_at=app.utc_now() WHERE organization_id=$1 AND id=$2 RETURNING *',[this.ctx.organizationId,prior.id,prices,discount,phrases,this.ctx.membershipId]))[0]!;}
   else saved=rows(await tx.query('INSERT INTO app.offer_price_rules(organization_id,project_id,offer_id,authorized_prices_cents,max_discount_bp,restricted_phrases,updated_by_membership_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[this.ctx.organizationId,offer.project_id,offer.id,prices,discount,phrases,this.ctx.membershipId]))[0]!;
   await event(tx,this.ctx,'offer.price_rule_saved',offer.id,{version:Number(saved.version),prices:prices.length,maxDiscountBp:discount});return saved;
  });
 }
 /** Exceptions to authorized prices/discounts require an explicit owner approval record. */
 async requestPriceException(campaignId:string,input:{amountCents?:unknown;discountBp?:unknown;reason:unknown}){
  const amount=input.amountCents===undefined||input.amountCents===null?null:cents(input.amountCents),discount=input.discountBp===undefined||input.discountBp===null?null:intIn(input.discountBp,1,10000,'INVALID_DISCOUNT');
  if(amount===null&&discount===null)return fail('EXCEPTION_TERMS_REQUIRED',400);if(amount===0)return fail('INVALID_AMOUNT',400);const reason=text(input.reason,'reason',1000);
  return this.run(async tx=>{
   const campaign=rows(await tx.query('SELECT id FROM app.campaigns WHERE organization_id=$1 AND id=$2',[this.ctx.organizationId,identifier(campaignId)]))[0];if(!campaign)return fail('NOT_FOUND',404);
   const policy=rows(await tx.query('SELECT version FROM app.policy_controls WHERE organization_id=$1',[this.ctx.organizationId]))[0];if(!policy)return fail('POLICY_UNCONFIGURED');
   const payload={campaignId:campaign.id,amountCents:amount,discountBp:discount,reason};
   const approval=rows(await tx.query("INSERT INTO app.action_approvals(organization_id,action_kind,record_id,payload_hash,policy_version,requested_by_membership_id,proposed_payload) VALUES($1,'quotation',$2,$3,$4,$5,$6::jsonb) RETURNING *",[this.ctx.organizationId,campaign.id,digest(payload),policy.version,this.ctx.membershipId,JSON.stringify(payload)]))[0]!;
   await event(tx,this.ctx,'campaign.price_exception_requested',campaign.id,{approvalId:approval.id});return approval;
  });
 }
 async decidePriceException(approvalId:string,approved:boolean){
  return this.run(async tx=>{
   const approval=rows(await tx.query("UPDATE app.action_approvals SET status=$3,decided_by_membership_id=$4,decided_at=app.utc_now() WHERE organization_id=$1 AND id=$2 AND action_kind='quotation' AND status='pending' AND expires_at>app.utc_now() RETURNING *",[this.ctx.organizationId,identifier(approvalId),approved?'approved':'rejected',this.ctx.membershipId]))[0];if(!approval)return fail('APPROVAL_STALE');
   const payload=approval.proposed_payload??{};if(digest(payload)!==approval.payload_hash)return fail('APPROVAL_TAMPERED',403);
   let exception:Row|null=null;
   if(approved)exception=rows(await tx.query('INSERT INTO app.campaign_price_exceptions(organization_id,campaign_id,amount_cents,discount_bp,reason,approval_id,created_by_membership_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[this.ctx.organizationId,payload.campaignId,payload.amountCents,payload.discountBp,payload.reason,approval.id,this.ctx.membershipId]))[0]!;
   await event(tx,this.ctx,approved?'campaign.price_exception_approved':'campaign.price_exception_rejected',payload.campaignId,{approvalId:approval.id});return {approval,exception};
  });
 }

 /* -------------------------------------------------------------- evaluation */
 private async load(tx:Client,campaign:Row):Promise<Loaded>{
  const org=this.ctx.organizationId;const one=async(sql:string,values:unknown[])=>rows(await tx.query(sql,values))[0]??null;
  const audience=campaign.audience_revision_id?await one('SELECT * FROM app.campaign_audience_revisions WHERE organization_id=$1 AND id=$2',[org,campaign.audience_revision_id]):null;
  const budget=campaign.budget_revision_id?await one('SELECT * FROM app.campaign_budget_revisions WHERE organization_id=$1 AND id=$2',[org,campaign.budget_revision_id]):null;
  const variants=rows(await tx.query('SELECT * FROM app.campaign_variants WHERE organization_id=$1 AND campaign_id=$2 ORDER BY created_at,id',[org,campaign.id]));
  const templateIds=[campaign.template_revision_id,...variants.filter(v=>v.status==='active').map(v=>v.template_revision_id)].filter(Boolean);
  const templates=templateIds.length?rows(await tx.query('SELECT r.*,t.channel,t.project_id FROM app.message_template_revisions r JOIN app.message_templates t ON t.organization_id=r.organization_id AND t.id=r.template_id WHERE r.organization_id=$1 AND r.id::text=ANY($2::text[])',[org,templateIds])):[];
  const byId=new Map(templates.map(t=>[String(t.id),t]));
  const mailbox=campaign.mailbox_id?await one('SELECT id,label,sender_name,provider,verified,status FROM app.mailboxes WHERE organization_id=$1 AND id=$2',[org,campaign.mailbox_id]):null;
  const project=await one('SELECT id,label,status FROM app.projects WHERE organization_id=$1 AND id=$2',[org,campaign.project_id]);
  const offer=campaign.offer_id?await one('SELECT id,label,status,content FROM app.offers WHERE organization_id=$1 AND id=$2',[org,campaign.offer_id]):null;
  const ruleRow=campaign.offer_id?await one('SELECT * FROM app.offer_price_rules WHERE organization_id=$1 AND offer_id=$2',[org,campaign.offer_id]):null;
  const rule=ruleRow?{authorizedPricesCents:(ruleRow.authorized_prices_cents??[]).map(Number),maxDiscountBp:Number(ruleRow.max_discount_bp),restrictedPhrases:[...(ruleRow.restricted_phrases??[])]}:null;
  const exceptions=rows(await tx.query('SELECT amount_cents,discount_bp FROM app.campaign_price_exceptions WHERE organization_id=$1 AND campaign_id=$2',[org,campaign.id])).map(e=>({amountCents:e.amount_cents===null?null:Number(e.amount_cents),discountBp:e.discount_bp===null?null:Number(e.discount_bp)}));
  const facts=new Map(rows(await tx.query('SELECT id,project_id,label,status,version,content FROM app.vetted_product_facts WHERE organization_id=$1 AND project_id=$2',[org,campaign.project_id])).map(r=>[String(r.id).toLowerCase(),factInfo(r)]));
  const strategy=campaign.strategy_id?await one('SELECT id,label,status FROM app.strategies WHERE organization_id=$1 AND id=$2',[org,campaign.strategy_id]):null;
  return {campaign,audience,budget,variants,template:campaign.template_revision_id?byId.get(String(campaign.template_revision_id))??null:null,variantTemplates:byId,mailbox,project,offer,rule,ruleVersion:ruleRow?Number(ruleRow.version):null,exceptions,facts,strategy};
 }
 private binding(loaded:Loaded){
  const cited=new Set<string>();for(const t of loaded.variantTemplates.values())for(const id of (t.fact_ids??[]) as string[])cited.add(String(id).toLowerCase());
  return approvalBinding({...loaded,citedFacts:[...cited].sort().map(id=>({id,version:loaded.facts.get(id)?.version??0}))});
 }
 private async audienceContacts(tx:Client,loaded:Loaded):Promise<ContactShape[]>{
  if(!loaded.audience)return [];const ids=(loaded.audience.contact_ids??[]) as string[];if(!ids.length)return [];
  return rows(await tx.query(`SELECT c.id::text AS id,c.status,c.consent,c.jurisdiction,c.role_title,(s.email_hash IS NOT NULL) AS suppressed,
   (SELECT count(*)::int FROM app.campaign_work_items w WHERE w.organization_id=c.organization_id AND w.contact_id=c.id AND w.campaign_id<>$4::uuid AND w.created_at>app.utc_now()-make_interval(days=>$3::int)) AS recent_touches
   FROM app.crm_contacts c LEFT JOIN app.contact_suppressions s ON s.organization_id=c.organization_id AND s.email_hash=c.email_hash
   WHERE c.organization_id=$1 AND c.id::text=ANY($2::text[]) ORDER BY c.id`,[this.ctx.organizationId,ids,Number(loaded.campaign.cadence_days),loaded.campaign.id])).map(r=>({id:r.id,status:r.status,consent:r.consent,jurisdiction:r.jurisdiction,role_title:r.role_title,suppressed:Boolean(r.suppressed),recentTouches:Number(r.recent_touches)}));
 }
 private variantShapes(loaded:Loaded):VariantShape[]{return loaded.variants.map(v=>({id:String(v.id),strategy_id:String(v.strategy_id),template_revision_id:String(v.template_revision_id),weight:Number(v.weight),eligibility:v.eligibility??{},status:v.status}));}
 /** Picks the exact strategy + content revision for a contact, or null when nothing is eligible. */
 private route(loaded:Loaded,contact:{id:string;jurisdiction:string;consent:string;role_title?:string|null}){
  const variant=chooseVariant(this.variantShapes(loaded),contact,String(loaded.campaign.id));
  if(variant)return {variantId:variant.id,strategyId:variant.strategy_id,templateRevisionId:variant.template_revision_id};
  if(loaded.campaign.template_revision_id)return {variantId:null,strategyId:loaded.campaign.strategy_id??null,templateRevisionId:String(loaded.campaign.template_revision_id)};
  return null;
 }
 private analyse(loaded:Loaded,contacts:ContactShape[]){
  const c=loaded.campaign;const excluded:{contactId:string;reason:string;message:string}[]=[];const eligible:(ContactShape&{route:NonNullable<ReturnType<CampaignStudio['route']>>})[]=[];
  for(const contact of contacts){const reason=contactExclusion(contact,{channel:c.channel,allowedCountries:[...(c.allowed_countries??[])],frequencyCap:Number(c.frequency_cap)});const route=reason?null:this.route(loaded,contact);
   if(reason||!route){const code=reason??'NO_ELIGIBLE_VARIANT';excluded.push({contactId:contact.id,reason:code,message:exclusionMessages[code]??code});}else eligible.push({...contact,route});}
  return {eligible,excluded};
 }
 private async evaluate(tx:Client,loaded:Loaded){
  const now=this.clock();const c=loaded.campaign;const issues:Issue[]=[];
  if(loaded.project?.status!=='active')issues.push(blocking('PROJECT_NOT_ACTIVE','The campaign project is archived.','project'));
  if(c.purpose==='product'&&!loaded.offer)issues.push(blocking('OFFER_REQUIRED','Select the offer this product campaign promotes.','offer'));
  if(loaded.offer&&loaded.offer.status!=='active')issues.push(blocking('OFFER_INACTIVE','The selected offer is archived.','offer'));
  if(c.strategy_id&&loaded.strategy?.status==='archived')issues.push(blocking('STRATEGY_ARCHIVED','The selected strategy is archived.','strategy'));
  if(!loaded.mailbox)issues.push(blocking('SENDER_REQUIRED','Choose a sender mailbox.','sender'));
  else{if(!loaded.mailbox.verified||loaded.mailbox.status!=='active')issues.push(blocking('SENDER_UNVERIFIED',`Sender “${loaded.mailbox.label}” is not verified and active.`,'sender'));
   issues.push(warning('DOMAIN_REPUTATION_UNMONITORED','Sender domain reputation is not monitored yet (blocked on external prerequisite: a deliverability/reputation feed). Keep daily caps low.','sender'));}
  issues.push(...checkSendRules(ruleShape(c),now));
  const templates=[...loaded.variantTemplates.values()];
  if(!loaded.template&&!loaded.variants.some(v=>v.status==='active'))issues.push(blocking('COPY_REQUIRED','Write the campaign copy (subject and body) before validation.','copy'));
  for(const template of templates){
   if(template.project_id&&template.project_id!==c.project_id)issues.push(blocking('TEMPLATE_PROJECT_MISMATCH',`Copy revision ${template.revision} belongs to a different project.`,'copy'));
   if(template.channel!==c.channel)issues.push(blocking('COPY_CHANNEL_MISMATCH',`Copy revision ${template.revision} was written for ${template.channel}, but the campaign uses ${c.channel}.`,'copy'));
   for(const issue of checkTemplate(contentOf(template),loaded.facts,String(c.project_id),loaded.rule,loaded.exceptions,now))issues.push({...issue,message:templates.length>1?`[copy r${template.revision}] ${issue.message}`:issue.message});
  }
  if(!loaded.budget)issues.push(blocking('BUDGET_REQUIRED','Set a campaign budget (USD 0 is allowed for free channels).','budget'));
  const contacts=await this.audienceContacts(tx,loaded);const {eligible,excluded}=this.analyse(loaded,contacts);
  if(!loaded.audience)issues.push(blocking('AUDIENCE_REQUIRED','Choose an audience segment or contacts.','audience'));
  else if(!eligible.length)issues.push(blocking('NO_ELIGIBLE_CONTACTS','No contact in the audience passes consent, suppression, country and frequency rules.','audience'));
  if(loaded.budget){
   const total=Number(loaded.budget.total_cents),per=Number(loaded.budget.per_message_max_cents);
   if(total>0){const policy=rows(await tx.query('SELECT limit_cents,reserved_cents,spent_cents FROM app.spending_policies WHERE organization_id=$1 AND project_id IS NULL',[this.ctx.organizationId]))[0];const available=policy?Number(policy.limit_cents)-Number(policy.reserved_cents)-Number(policy.spent_cents):0;
    if(total>available)issues.push(blocking('BUDGET_NOT_FUNDED',`The campaign budget (${dollars(total)}) exceeds the owner-funded spending policy still available (${dollars(Math.max(0,available))}).`,'budget'));}
   if(per>0&&eligible.length*per>total)issues.push(warning('BUDGET_COVERS_PART',`The budget covers ${Math.floor(total/per)} of ${eligible.length} eligible contacts at the ${dollars(per)} per-message maximum.`,'budget'));
  }
  return {issues,eligible,excluded,contacts,blockingCount:issues.filter(i=>i.severity==='blocking').length};
 }

 async validate(id:string){
  return this.run(async tx=>{
   let campaign=await this.lock(tx,id);const loaded=await this.load(tx,campaign);const result=await this.evaluate(tx,loaded);
   if(!result.blockingCount&&campaign.state==='draft')campaign=await this.move(tx,campaign,'validated',{},{bindingHash:digest(this.binding(loaded))});
   else if(result.blockingCount&&campaign.state==='validated')campaign=await this.move(tx,campaign,'draft',{},{reason:'validation_failed'});
   await event(tx,this.ctx,result.blockingCount?'campaign.validation_failed':'campaign.validation_passed',campaign.id,{revision:Number(campaign.revision),codes:[...new Set(result.issues.map(i=>i.code))].slice(0,40)});
   return {campaign,issues:result.issues,eligible:result.eligible.length,excluded:result.excluded.length};
  });
 }

 /** DOTS-089 dry run: synthetic prospects only, no network, no inference, no queue rows, no money rows. */
 async simulate(id:string,options:{sampleSize?:number}={}){
  const sampleSize=options.sampleSize===undefined?3:intIn(options.sampleSize,1,syntheticProspects.length,'INVALID_SAMPLE');
  return this.run(async tx=>{
   const campaign=await this.lock(tx,id);if(['archived','aborted','completed'].includes(campaign.state))return fail('CAMPAIGN_CLOSED');
   const loaded=await this.load(tx,campaign);const result=await this.evaluate(tx,loaded);const binding=this.binding(loaded);const now=this.clock();const c=campaign;
   const sample=syntheticProspects.slice(0,sampleSize).map((prospect,index)=>{
    const synthetic={id:`synthetic-${index+1}`,jurisdiction:prospect.country,consent:prospect.consent,role_title:prospect.role};
    const exclusion=contactExclusion({...synthetic,status:'active',suppressed:false,recentTouches:0},{channel:c.channel,allowedCountries:[...(c.allowed_countries??[])],frequencyCap:Number(c.frequency_cap)});
    const route=this.route(loaded,synthetic);const template=route?loaded.variantTemplates.get(route.templateRevisionId):undefined;
    const rendered=template?renderTemplate(contentOf(template),{contact:{...prospect},sender:loaded.mailbox?.sender_name,offer:loaded.offer?.label,project:loaded.project?.label,facts:loaded.facts}):null;
    return {persona:`Synthetic prospect ${index+1}`,country:prospect.country,consent:prospect.consent,wouldBeExcluded:exclusion?exclusionMessages[exclusion]:null,variantId:route?.variantId??null,strategyId:route?.strategyId??null,templateRevisionId:route?.templateRevisionId??null,rendered};
   });
   const per=loaded.budget?Number(loaded.budget.per_message_max_cents):0,total=loaded.budget?Number(loaded.budget.total_cents):0;
   const coverable=per>0?Math.min(result.eligible.length,Math.floor(total/per)):result.eligible.length;const daily=Number(c.daily_limit);
   const exclusionCounts=result.excluded.reduce<Record<string,number>>((acc,e)=>{acc[e.reason]=(acc[e.reason]??0)+1;return acc;},{});
   const start=asDate(c.schedule_start_at);const window=windowOf(c);const firstWindow=start?nextSendWindow(new Date(Math.max(start.getTime(),now.getTime())),window):null;
   const report={mode:'dry_run',campaignId:c.id,revision:Number(c.revision),bindingHash:digest(binding),
    sample,audience:{total:result.contacts.length,eligible:result.eligible.length,excluded:result.excluded.slice(0,500),exclusionCounts},
    predictedMaxCostCents:coverable*per,budgetTotalCents:total,perMessageMaxCents:per,contactsCoveredByBudget:coverable,
    sendPlan:{firstWindowAt:firstWindow?.toISOString()??null,dailyCap:daily,daysNeeded:coverable?Math.ceil(coverable/daily):0,timezone:c.timezone,window:`${pad(window.startHour)}–${pad(window.endHour)}`,weekdaysOnly:window.weekdaysOnly},
    proposedToolActions:[
     {tool:'queue.enqueue_campaign_work',count:coverable,executesNow:false,note:'Created only after owner approval, scheduling and activation.'},
     {tool:`${c.channel}.send`,count:coverable,executesNow:false,note:'Each send re-checks approval, consent, suppression, quiet hours, caps and budget immediately before dispatch.'},
     {tool:'budget.reserve',count:per>0?coverable:0,executesNow:false,note:per>0?`Up to ${dollars(per)} per message, capped at ${dollars(total)}.`:'USD 0: free channel only.'},
    ],
    issues:result.issues,blockingReasons:result.issues.filter(i=>i.severity==='blocking').map(i=>i.message),
    networkRequests:0,billableInferenceRequests:0,messagesSent:0,realPeopleContacted:0};
   const saved=rows(await tx.query('INSERT INTO app.campaign_simulations(organization_id,campaign_id,campaign_revision,binding_hash,blocking_count,report,created_by_membership_id) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7) RETURNING id,created_at',[this.ctx.organizationId,c.id,Number(c.revision),report.bindingHash,result.blockingCount,JSON.stringify(report),this.ctx.membershipId]))[0]!;
   await event(tx,this.ctx,'campaign.simulated',c.id,{simulationId:saved.id,revision:Number(c.revision),eligible:result.eligible.length,blocking:result.blockingCount,networkRequests:0,billableInferenceRequests:0});
   return {...report,simulationId:saved.id};
  });
 }

 /* ------------------------------------------------------------- approvals */
 async requestApproval(id:string){
  return this.run(async tx=>{
   const campaign=await this.lock(tx,id);if(campaign.state!=='validated')return fail('VALIDATE_CAMPAIGN_FIRST');
   const loaded=await this.load(tx,campaign);const result=await this.evaluate(tx,loaded);if(result.blockingCount)return fail('CAMPAIGN_HAS_BLOCKING_ISSUES');
   const binding=this.binding(loaded);const hash=digest(binding);
   const simulation=rows(await tx.query('SELECT id,blocking_count FROM app.campaign_simulations WHERE organization_id=$1 AND campaign_id=$2 AND campaign_revision=$3 AND binding_hash=$4 ORDER BY created_at DESC LIMIT 1',[this.ctx.organizationId,campaign.id,Number(campaign.revision),hash]))[0];
   if(!simulation||Number(simulation.blocking_count))return fail('SIMULATE_CURRENT_REVISION_FIRST');
   const policy=rows(await tx.query('SELECT version FROM app.policy_controls WHERE organization_id=$1',[this.ctx.organizationId]))[0];if(!policy)return fail('POLICY_UNCONFIGURED');
   await tx.query("UPDATE app.action_approvals SET status='expired' WHERE organization_id=$1 AND record_id=$2 AND action_kind='campaign' AND status='pending'",[this.ctx.organizationId,campaign.id]);
   const approval=rows(await tx.query("INSERT INTO app.action_approvals(organization_id,action_kind,record_id,payload_hash,policy_version,requested_by_membership_id,proposed_payload) VALUES($1,'campaign',$2,$3,$4,$5,$6::jsonb) RETURNING *",[this.ctx.organizationId,campaign.id,hash,policy.version,this.ctx.membershipId,JSON.stringify({...binding,simulationId:simulation.id})]))[0]!;
   const updated=await this.move(tx,campaign,'ready_for_approval',{approval_id:approval.id},{approvalId:approval.id,bindingHash:hash});
   return {campaign:updated,approval,binding};
  });
 }
 async decideApproval(approvalId:string,approved:boolean){
  return this.run(async tx=>{
   const approval=rows(await tx.query("SELECT * FROM app.action_approvals WHERE organization_id=$1 AND id=$2 AND action_kind='campaign' FOR UPDATE",[this.ctx.organizationId,identifier(approvalId)]))[0];
   if(!approval||approval.status!=='pending'||new Date(approval.expires_at).getTime()<=Date.now())return fail('APPROVAL_STALE');
   const campaign=await this.lock(tx,approval.record_id);if(campaign.state!=='ready_for_approval'||campaign.approval_id!==approval.id)return fail('APPROVAL_STALE');
   const loaded=await this.load(tx,campaign);const hash=digest(this.binding(loaded));if(hash!==approval.payload_hash)return fail('APPROVAL_STALE');
   await tx.query('UPDATE app.action_approvals SET status=$3,decided_by_membership_id=$4,decided_at=app.utc_now() WHERE organization_id=$1 AND id=$2',[this.ctx.organizationId,approval.id,approved?'approved':'rejected',this.ctx.membershipId]);
   const updated=approved?await this.move(tx,campaign,'approved',{approved_revision:Number(campaign.revision),approved_hash:hash},{approvalId:approval.id}):await this.move(tx,campaign,'draft',{approval_id:null},{approvalId:approval.id,reason:'owner_rejected'});
   await event(tx,this.ctx,approved?'approval.approved':'approval.rejected',approval.id,{kind:'campaign',campaignId:campaign.id});
   return updated;
  });
 }
 /** Throws unless the campaign's current material state still equals what the owner approved. */
 /** Internal (runs inside an open tenant transaction). */
 async assertFreshApproval(tx:Client,campaign:Row){
  if(!campaign.approval_id||Number(campaign.approved_revision)!==Number(campaign.revision)||!campaign.approved_hash)return fail('REAPPROVAL_REQUIRED',403);
  const approval=rows(await tx.query("SELECT status,payload_hash FROM app.action_approvals WHERE organization_id=$1 AND id=$2 AND action_kind='campaign' AND record_id=$3",[this.ctx.organizationId,campaign.approval_id,campaign.id]))[0];
  if(!approval||approval.status!=='approved'||approval.payload_hash!==campaign.approved_hash)return fail('REAPPROVAL_REQUIRED',403);
  const loaded=await this.load(tx,campaign);if(digest(this.binding(loaded))!==campaign.approved_hash)return fail('APPROVAL_STALE',403);
  return loaded;
 }
 async schedule(id:string){return this.run(async tx=>{const campaign=await this.lock(tx,id);if(campaign.state!=='approved')return fail('TRANSITION_NOT_ALLOWED');await this.assertFreshApproval(tx,campaign);if(!campaign.schedule_start_at)return fail('SCHEDULE_REQUIRED',400);return this.move(tx,campaign,'scheduled');});}
 async activate(id:string){return this.run(async tx=>{
  const campaign=await this.lock(tx,id);if(campaign.state!=='scheduled')return fail('TRANSITION_NOT_ALLOWED');await this.assertFreshApproval(tx,campaign);
  if(!campaign.schedule_start_at||new Date(campaign.schedule_start_at).getTime()>this.clock().getTime())return fail('CAMPAIGN_NOT_STARTED');
  if(campaign.schedule_end_at&&new Date(campaign.schedule_end_at).getTime()<=this.clock().getTime())return fail('CAMPAIGN_ENDED');
  return this.move(tx,campaign,'active');
 });}
 /** Worker hook: activates scheduled campaigns whose start time has arrived and whose approval is still fresh. */
 async activateDue(){
  const due=await this.run(async tx=>rows(await tx.query("SELECT id FROM app.campaigns WHERE organization_id=$1 AND state='scheduled' AND schedule_start_at<=$2",[this.ctx.organizationId,this.clock()])).map(r=>String(r.id)));
  const activated:string[]=[];for(const id of due){try{await this.activate(id);activated.push(id);}catch{/* stale approval or race: stays scheduled, visible in the control room */}}return activated;
 }
 private async holdWork(tx:Client,campaignId:string){
  return rows(await tx.query("UPDATE app.task_queue SET state='waiting',last_reason='CAMPAIGN_PAUSED',updated_at=app.utc_now() WHERE organization_id=$1 AND (state='queued' OR (state='waiting' AND last_reason='OWNER_PAUSED')) AND id IN (SELECT task_id FROM app.campaign_work_items WHERE organization_id=$1 AND campaign_id=$2) RETURNING id",[this.ctx.organizationId,campaignId])).length;
 }
 private async cancelWork(tx:Client,campaignId:string,reason:string){
  return rows(await tx.query("UPDATE app.task_queue SET state='cancelled',last_reason=$3,fencing_token=fencing_token+1,lease_expires_at=NULL,updated_at=app.utc_now() WHERE organization_id=$1 AND state IN ('queued','waiting') AND id IN (SELECT task_id FROM app.campaign_work_items WHERE organization_id=$1 AND campaign_id=$2) RETURNING id",[this.ctx.organizationId,campaignId,reason])).length;
 }
 async pause(id:string){return this.run(async tx=>{const campaign=await this.lock(tx,id);if(!['active','scheduled'].includes(campaign.state))return fail('TRANSITION_NOT_ALLOWED');const held=await this.holdWork(tx,campaign.id);return this.move(tx,campaign,'paused',{},{workHeld:held});});}
 async resume(id:string){return this.run(async tx=>{
  const campaign=await this.lock(tx,id);if(campaign.state!=='paused')return fail('TRANSITION_NOT_ALLOWED');await this.assertFreshApproval(tx,campaign);
  const started=campaign.schedule_start_at&&new Date(campaign.schedule_start_at).getTime()<=this.clock().getTime();
  const policy=rows(await tx.query('SELECT paused FROM app.policy_controls WHERE organization_id=$1',[this.ctx.organizationId]))[0];
  const released=rows(await tx.query(`UPDATE app.task_queue SET state=CASE WHEN $3::boolean THEN 'waiting' ELSE 'queued' END,last_reason=CASE WHEN $3::boolean THEN 'OWNER_PAUSED' ELSE NULL END,updated_at=app.utc_now() WHERE organization_id=$1 AND state='waiting' AND last_reason='CAMPAIGN_PAUSED' AND id IN (SELECT task_id FROM app.campaign_work_items WHERE organization_id=$1 AND campaign_id=$2) RETURNING id`,[this.ctx.organizationId,campaign.id,policy?.paused!==false])).length;
  return this.move(tx,campaign,started?'active':'scheduled',{},{workReleased:released});
 });}
 async complete(id:string){return this.run(async tx=>{const campaign=await this.lock(tx,id);if(!canTransition(campaign.state,'completed'))return fail('TRANSITION_NOT_ALLOWED');const cancelled=await this.cancelWork(tx,campaign.id,'CAMPAIGN_COMPLETED');return this.move(tx,campaign,'completed',{},{workCancelled:cancelled});});}
 async abort(id:string,reason='OWNER_ABORTED'){return this.run(async tx=>{
  const campaign=await this.lock(tx,id);if(!canTransition(campaign.state,'aborted'))return fail('TRANSITION_NOT_ALLOWED');const cancelled=await this.cancelWork(tx,campaign.id,'CAMPAIGN_ABORTED');
  await tx.query("UPDATE app.action_approvals SET status='expired' WHERE organization_id=$1 AND record_id=$2 AND action_kind='campaign' AND status IN ('pending','approved')",[this.ctx.organizationId,campaign.id]);
  return this.move(tx,campaign,'aborted',{},{workCancelled:cancelled,reason:text(reason,'reason',120)});
 });}
 async archive(id:string){return this.run(async tx=>{const campaign=await this.lock(tx,id);if(!canTransition(campaign.state,'archived'))return fail('TRANSITION_NOT_ALLOWED');return this.move(tx,campaign,'archived');});}

 /* ---------------------------------------------------------- work generation */
 /** DOTS-091: enqueue per-contact work for an active, started, freshly approved campaign within caps, quotas and budget. Idempotent per campaign+contact. */
 async generateWork(id:string,options:{maxItems?:number}={}){
  const maxItems=options.maxItems===undefined?500:intIn(options.maxItems,1,1000,'INVALID_LIMIT');
  return this.run(async tx=>{
   const campaign=await this.lock(tx,id);const now=this.clock();
   if(campaign.state!=='active')return fail('CAMPAIGN_NOT_ACTIVE',403);
   if(!campaign.schedule_start_at||new Date(campaign.schedule_start_at).getTime()>now.getTime())return fail('CAMPAIGN_NOT_STARTED',403);
   if(campaign.schedule_end_at&&new Date(campaign.schedule_end_at).getTime()<=now.getTime())return fail('CAMPAIGN_ENDED',403);
   const policy=rows(await tx.query('SELECT paused FROM app.policy_controls WHERE organization_id=$1',[this.ctx.organizationId]))[0];if(!policy||policy.paused)return fail('OWNER_PAUSED',403);
   const loaded=await this.assertFreshApproval(tx,campaign);
   const result=await this.evaluate(tx,loaded);if(result.blockingCount)return fail('CAMPAIGN_HAS_BLOCKING_ISSUES',403);
   const agent=rows(await tx.query(`SELECT a.agent_identity_id,a.quota_limit,COALESCE(cfg.daily_task_limit,10) AS daily_task_limit FROM app.agent_project_assignments a JOIN app.agent_identities i ON i.organization_id=a.organization_id AND i.id=a.agent_identity_id
    LEFT JOIN app.agent_configuration cfg ON cfg.organization_id=a.organization_id AND cfg.agent_identity_id=a.agent_identity_id
    WHERE a.organization_id=$1 AND a.project_id=$2 AND i.status='active' AND ($3::uuid IS NULL OR a.agent_identity_id=$3::uuid) ORDER BY a.priority DESC,a.agent_identity_id LIMIT 1`,[this.ctx.organizationId,campaign.project_id,campaign.agent_identity_id??null]))[0];
   if(!agent)return fail('ASSIGN_AGENT_FIRST',400);
   await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`enqueue:${this.ctx.organizationId}:${agent.agent_identity_id}`]);
   const counts=rows(await tx.query(`SELECT
     (SELECT count(*)::int FROM app.task_queue WHERE organization_id=$1 AND project_id=$2 AND agent_identity_id=$3 AND state IN ('queued','running','waiting')) AS pending,
     (SELECT count(*)::int FROM app.task_queue WHERE organization_id=$1 AND agent_identity_id=$3 AND created_at>=date_trunc('day',app.utc_now()) AND state<>'cancelled') AS agent_today,
     (SELECT count(*)::int FROM app.campaign_work_items WHERE organization_id=$1 AND campaign_id=$4 AND created_at>=date_trunc('day',app.utc_now())) AS campaign_today,
     (SELECT COALESCE(sum(max_cost_cents),0)::bigint FROM app.campaign_work_items WHERE organization_id=$1 AND campaign_id=$4) AS committed`,[this.ctx.organizationId,campaign.project_id,agent.agent_identity_id,campaign.id]))[0]!;
   const per=Number(loaded.budget!.per_message_max_cents),total=Number(loaded.budget!.total_cents),remaining=total-Number(counts.committed);
   const limits:Record<string,number>={request:maxItems,campaignDailyCap:Number(campaign.daily_limit)-Number(counts.campaign_today),agentQuota:Number(agent.quota_limit)-Number(counts.pending),agentDailyLimit:Number(agent.daily_task_limit)-Number(counts.agent_today),budget:per>0?Math.floor(remaining/per):Number.MAX_SAFE_INTEGER};
   const capacity=Math.max(0,Math.min(...Object.values(limits)));const limitedBy=Object.entries(limits).filter(([,v])=>v<=capacity).map(([k])=>k);
   const existing=new Set(rows(await tx.query('SELECT contact_id::text AS id FROM app.campaign_work_items WHERE organization_id=$1 AND campaign_id=$2',[this.ctx.organizationId,campaign.id])).map(r=>String(r.id)));
   const pending=result.eligible.filter(c=>!existing.has(c.id));
   if(pending.length&&per>0&&remaining<per)return fail('CAMPAIGN_BUDGET_EXHAUSTED',403);
   const availableAt=nextSendWindow(now,windowOf(campaign));if(!availableAt)return fail('NO_SENDING_WINDOW',403);
   const enqueued:{taskId:string;contactId:string;variantId:string|null;strategyId:string|null;templateRevisionId:string}[]=[];let duplicates=0;
   for(const contact of pending.slice(0,capacity)){
    const key=`campaign:${campaign.id}:contact:${contact.id}`;
    const payload={mode:'simulation',source:'campaign',campaignId:campaign.id,campaignRevision:Number(campaign.revision),approvalId:campaign.approval_id,contactId:contact.id,variantId:contact.route.variantId,strategyId:contact.route.strategyId,templateRevisionId:contact.route.templateRevisionId,brief:`Prepare the approved campaign message (revision ${campaign.revision}) for review. Do not send.`};
    const task=rows(await tx.query("INSERT INTO app.task_queue(organization_id,project_id,agent_identity_id,idempotency_key,kind,payload,priority,available_at) VALUES($1,$2,$3,$4,'follow_up',$5::jsonb,$6,$7) ON CONFLICT (organization_id,idempotency_key) DO NOTHING RETURNING id",[this.ctx.organizationId,campaign.project_id,agent.agent_identity_id,key,JSON.stringify(payload),Number(campaign.priority),availableAt]))[0];
    if(!task){duplicates++;continue;}
    await tx.query('INSERT INTO app.campaign_work_items(organization_id,campaign_id,contact_id,campaign_revision,approval_id,variant_id,strategy_id,template_revision_id,task_id,dedupe_key,max_cost_cents) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
     [this.ctx.organizationId,campaign.id,contact.id,Number(campaign.revision),campaign.approval_id,contact.route.variantId,contact.route.strategyId,contact.route.templateRevisionId,task.id,key,per]);
    await event(tx,this.ctx,'task.queued',task.id,{kind:'follow_up',campaignId:campaign.id},'worker');await outbox(tx,this.ctx,`task:${task.id}`,'task.queued',{taskId:task.id});
    enqueued.push({taskId:String(task.id),contactId:contact.id,variantId:contact.route.variantId,strategyId:contact.route.strategyId,templateRevisionId:contact.route.templateRevisionId});
   }
   const exclusionCounts=result.excluded.reduce<Record<string,number>>((acc,e)=>{acc[e.reason]=(acc[e.reason]??0)+1;return acc;},{});
   const summary={enqueued:enqueued.length,alreadyQueued:existing.size+duplicates,deferred:Math.max(0,pending.length-capacity),limitedBy:pending.length>capacity?limitedBy:[],excluded:exclusionCounts,availableAt:availableAt.toISOString()};
   await event(tx,this.ctx,'campaign.work_generated',campaign.id,{revision:Number(campaign.revision),...summary});
   return {...summary,items:enqueued};
  });
 }

 /* ---------------------------------------------------------- read models */
 async previewTemplate(input:{templateRevisionId?:unknown;subject?:unknown;bodyText?:unknown;bodyHtml?:unknown;projectId?:unknown;offerId?:unknown}){
  return this.run(async tx=>{
   let content:TemplateContent;let projectId:string|null=input.projectId?identifier(input.projectId):null;
   if(input.templateRevisionId){const revision=rows(await tx.query('SELECT r.*,t.project_id FROM app.message_template_revisions r JOIN app.message_templates t ON t.organization_id=r.organization_id AND t.id=r.template_id WHERE r.organization_id=$1 AND r.id=$2',[this.ctx.organizationId,identifier(input.templateRevisionId)]))[0];if(!revision)return fail('NOT_FOUND',404);content=contentOf(revision);projectId=projectId??revision.project_id??null;}
   else{const n=this.normalizeContent({subject:input.subject,bodyText:input.bodyText,bodyHtml:input.bodyHtml});content=n;}
   const facts=new Map(rows(await tx.query('SELECT id,project_id,label,status,version,content FROM app.vetted_product_facts WHERE organization_id=$1 AND ($2::uuid IS NULL OR project_id=$2::uuid)',[this.ctx.organizationId,projectId])).map(r=>[String(r.id).toLowerCase(),factInfo(r)]));
   const offerId=input.offerId?identifier(input.offerId):null;const offer=offerId?rows(await tx.query('SELECT label FROM app.offers WHERE organization_id=$1 AND id=$2',[this.ctx.organizationId,offerId]))[0]:null;
   const ruleRow=offerId?rows(await tx.query('SELECT * FROM app.offer_price_rules WHERE organization_id=$1 AND offer_id=$2',[this.ctx.organizationId,offerId]))[0]:null;
   const rule=ruleRow?{authorizedPricesCents:(ruleRow.authorized_prices_cents??[]).map(Number),maxDiscountBp:Number(ruleRow.max_discount_bp),restrictedPhrases:[...(ruleRow.restricted_phrases??[])]}:null;
   const issues=checkTemplate(content,facts,projectId,rule,[],this.clock());
   const previews=syntheticProspects.slice(0,3).map((prospect,index)=>({persona:`Synthetic prospect ${index+1}`,...renderTemplate(content,{contact:{...prospect},sender:'Your sender name',offer:offer?.label,project:undefined,facts})}));
   return {content,issues,previews};
  });
 }

 async snapshot(){
  return this.run(async tx=>{
   const org=[this.ctx.organizationId];const q=async(sql:string)=>rows(await tx.query(sql,org));
   const campaigns=await q(`SELECT c.id,c.project_id,c.label,c.purpose,c.goal,c.state,c.revision,c.version,c.offer_id,c.strategy_id,c.mailbox_id,c.channel,c.allowed_countries,c.timezone,c.send_window_start_hour,c.send_window_end_hour,c.weekdays_only,c.frequency_cap,c.cadence_days,c.daily_limit,c.schedule_start_at,c.schedule_end_at,c.template_revision_id,c.audience_revision_id,c.budget_revision_id,c.priority,c.agent_identity_id,c.approval_id,c.approved_revision,c.authority_ref,c.updated_at,
    a.contact_count AS audience_count,a.segment AS audience_segment,a.contact_ids AS audience_contact_ids,b.total_cents AS budget_total_cents,b.per_message_max_cents AS budget_per_message_cents,b.authorization_ref AS budget_authorization_ref,
    (SELECT count(*)::int FROM app.campaign_work_items w WHERE w.organization_id=c.organization_id AND w.campaign_id=c.id) AS work_items
    FROM app.campaigns c LEFT JOIN app.campaign_audience_revisions a ON a.organization_id=c.organization_id AND a.id=c.audience_revision_id LEFT JOIN app.campaign_budget_revisions b ON b.organization_id=c.organization_id AND b.id=c.budget_revision_id
    WHERE c.organization_id=$1 ORDER BY c.updated_at DESC LIMIT 200`);
   return {
    campaigns,
    projects:await q("SELECT id,label,status FROM app.projects WHERE organization_id=$1 AND status='active' ORDER BY label LIMIT 200"),
    offers:await q("SELECT o.id,o.project_id,o.label,o.content->>'priceCents' AS list_price_cents,r.id AS price_rule_id,r.authorized_prices_cents,r.max_discount_bp,r.restricted_phrases,r.version AS price_rule_version FROM app.offers o LEFT JOIN app.offer_price_rules r ON r.organization_id=o.organization_id AND r.offer_id=o.id WHERE o.organization_id=$1 AND o.status='active' ORDER BY o.label LIMIT 200"),
    facts:(await q("SELECT id,project_id,offer_id,label,status,version,content FROM app.vetted_product_facts WHERE organization_id=$1 AND status='active' ORDER BY label LIMIT 300")).map(r=>{const f=factInfo(r);return {...f,offerId:r.offer_id,usable:!factProblem(f,null,this.clock())};}),
    mailboxes:await q('SELECT id,label,sender_name,verified,status FROM app.mailboxes WHERE organization_id=$1 ORDER BY created_at LIMIT 50'),
    strategies:await q("SELECT id,label,status FROM app.strategies WHERE organization_id=$1 AND status<>'archived' ORDER BY created_at DESC LIMIT 100"),
    templates:await q('SELECT t.id,t.project_id,t.label,t.channel,t.latest_revision,t.version,r.id AS latest_revision_id,r.subject,r.body_text,r.body_html FROM app.message_templates t LEFT JOIN app.message_template_revisions r ON r.organization_id=t.organization_id AND r.template_id=t.id AND r.revision=t.latest_revision WHERE t.organization_id=$1 AND t.status=\'active\' ORDER BY t.updated_at DESC LIMIT 100'),
    contacts:await q("SELECT id,display_name,jurisdiction,consent,status,role_title FROM app.crm_contacts WHERE organization_id=$1 AND status='active' ORDER BY display_name LIMIT 500"),
    agents:await q("SELECT DISTINCT i.id,i.display_name,a.project_id FROM app.agent_identities i JOIN app.agent_project_assignments a ON a.organization_id=i.organization_id AND a.agent_identity_id=i.id WHERE i.organization_id=$1 AND i.status='active' ORDER BY i.display_name"),
    policy:(await q('SELECT paused,outbound_enabled,model_enabled FROM app.policy_controls WHERE organization_id=$1'))[0]??null,
    channelPolicies,quietHours,maxMessagesPerContactPerWeek,templateVariables,lifecycle:{states:campaignStates,transitions:campaignTransitions},
    observedAt:new Date().toISOString(),
   };
  });
 }

 /** DOTS-092 control room: every metric names its source; drafts, queued work, provider-confirmed sends and received revenue are never mixed. */
 async detail(id:string){
  return this.run(async tx=>{
   const campaign=rows(await tx.query('SELECT * FROM app.campaigns WHERE organization_id=$1 AND id=$2',[this.ctx.organizationId,identifier(id)]))[0];if(!campaign)return fail('NOT_FOUND',404);
   const loaded=await this.load(tx,campaign);const evaluation=await this.evaluate(tx,loaded);const binding=this.binding(loaded);const values=[this.ctx.organizationId,campaign.id];
   const q=async(sql:string)=>rows(await tx.query(sql,values));
   const funnel=(await q(`SELECT
     (SELECT count(*)::int FROM app.messages WHERE organization_id=$1 AND campaign_id=$2 AND direction='outbound' AND state IN ('draft','pending_approval','approved')) AS drafted,
     (SELECT count(*)::int FROM app.campaign_work_items w JOIN app.task_queue t ON t.organization_id=w.organization_id AND t.id=w.task_id WHERE w.organization_id=$1 AND w.campaign_id=$2 AND t.state IN ('queued','waiting','running')) AS scheduled,
     (SELECT count(*)::int FROM app.campaign_work_items WHERE organization_id=$1 AND campaign_id=$2) AS generated,
     (SELECT count(*)::int FROM app.messages WHERE organization_id=$1 AND campaign_id=$2 AND direction='outbound' AND state IN ('sent','delivered') AND provider_message_id IS NOT NULL) AS sent,
     (SELECT count(*)::int FROM app.messages i WHERE i.organization_id=$1 AND i.direction='inbound' AND i.source='provider' AND EXISTS(SELECT 1 FROM app.messages o WHERE o.organization_id=i.organization_id AND o.conversation_id=i.conversation_id AND o.campaign_id=$2 AND o.direction='outbound' AND o.state IN ('sent','delivered') AND o.created_at<i.created_at)) AS replies,
     (SELECT COALESCE(sum(m.amount_cents),0)::bigint FROM app.money_entries m JOIN app.invoices v ON v.organization_id=m.organization_id AND v.id=m.invoice_id WHERE m.organization_id=$1 AND m.kind='sale_receipt' AND m.source='provider' AND v.contact_id IN (SELECT contact_id FROM app.campaign_audience WHERE organization_id=$1 AND campaign_id=$2)) AS revenue_cents`))[0]!;
   const expenses=(await q(`SELECT COALESCE(sum(m.amount_cents) FILTER(WHERE m.source='provider'),0)::bigint AS provider_cents,COALESCE(sum(m.amount_cents) FILTER(WHERE m.source<>'provider'),0)::bigint AS non_provider_cents,count(*)::int AS entries
     FROM app.money_entries m JOIN app.budget_reservations r ON r.organization_id=m.organization_id AND r.id=m.reservation_id WHERE m.organization_id=$1 AND m.kind='expense' AND split_part(r.idempotency_key,':',1)='message' AND split_part(r.idempotency_key,':',2) IN (SELECT id::text FROM app.messages WHERE organization_id=$1 AND campaign_id=$2)`))[0]!;
   const committed=(await q('SELECT COALESCE(sum(max_cost_cents),0)::bigint AS committed FROM app.campaign_work_items WHERE organization_id=$1 AND campaign_id=$2'))[0]!;
   return {
    campaign,binding,bindingHash:digest(binding),approvalFresh:Boolean(campaign.approved_hash)&&campaign.approved_hash===digest(binding)&&Number(campaign.approved_revision)===Number(campaign.revision),
    issues:evaluation.issues,eligible:evaluation.eligible.length,excluded:evaluation.excluded.slice(0,200),
    template:loaded.template,variants:loaded.variants,audience:loaded.audience?{...loaded.audience,contact_ids:undefined}:null,budget:loaded.budget,
    revisions:await q('SELECT revision,content_hash,created_at,snapshot->>\'reason\' AS reason FROM app.campaign_revisions WHERE organization_id=$1 AND campaign_id=$2 ORDER BY revision DESC LIMIT 50'),
    simulations:await q('SELECT id,campaign_revision,binding_hash,blocking_count,network_requests,billable_requests,messages_sent,report,created_at FROM app.campaign_simulations WHERE organization_id=$1 AND campaign_id=$2 ORDER BY created_at DESC LIMIT 3'),
    decisions:await q("SELECT id,action_kind,status,payload_hash,created_at,decided_at,proposed_payload FROM app.action_approvals WHERE organization_id=$1 AND record_id=$2 AND action_kind IN ('campaign','quotation') ORDER BY created_at DESC LIMIT 50"),
    priceExceptions:await q('SELECT id,amount_cents,discount_bp,reason,approval_id,created_at FROM app.campaign_price_exceptions WHERE organization_id=$1 AND campaign_id=$2 ORDER BY created_at DESC'),
    timeline:await q('SELECT id,event_type,actor_kind,details,occurred_at FROM app.operation_events WHERE organization_id=$1 AND record_id=$2 ORDER BY occurred_at DESC,id DESC LIMIT 100'),
    work:await q('SELECT t.state,count(*)::int AS total FROM app.campaign_work_items w JOIN app.task_queue t ON t.organization_id=w.organization_id AND t.id=w.task_id WHERE w.organization_id=$1 AND w.campaign_id=$2 GROUP BY t.state ORDER BY t.state'),
    buckets:await q('SELECT id,label,default_position FROM app.project_buckets WHERE organization_id=$1 AND campaign_id=$2 ORDER BY default_position'),
    funnel:[
     {stage:'draft',label:'Drafted (not sent)',value:Number(funnel.drafted),source:'Campaign message drafts awaiting review; nothing was delivered.'},
     {stage:'scheduled',label:'Scheduled work',value:Number(funnel.scheduled),source:'Durable queue items generated from the approved revision (queued, waiting or running).'},
     {stage:'generated',label:'Work generated (all time)',value:Number(funnel.generated),source:'Campaign work-item ledger.'},
     {stage:'sent',label:'Actually sent',value:Number(funnel.sent),source:'Outbound messages with a provider message id (provider-confirmed only).'},
     {stage:'replies',label:'Replies',value:Number(funnel.replies),source:'Provider-received inbound messages in threads with a sent campaign message.'},
     {stage:'revenue',label:'Revenue received',value:Number(funnel.revenue_cents),unit:'cents',source:'Provider-verified sale receipts on invoices for audience contacts (sandbox receipts excluded).'},
    ],
    expenses:{providerCents:Number(expenses.provider_cents),nonProviderCents:Number(expenses.non_provider_cents),entries:Number(expenses.entries),committedMaxCents:Number(committed.committed),budgetTotalCents:loaded.budget?Number(loaded.budget.total_cents):null,source:'Ledger expense entries linked to this campaign’s message reservations; committed maximum comes from generated work items.'},
   };
  });
 }
}

/**
 * Integration hook for the dispatch path (DeliveryGateway / engine). Call inside an existing tenant transaction
 * immediately before any send or paid request. Throws OperationError unless the campaign is active, started,
 * unpaused, within its window and still bound to the exact approved revision.
 */
export async function assertCampaignDispatchable(tx:Client,ctx:Context,campaignId:string,messageRevision:number,now:Date=new Date()){
 const campaign=rows(await tx.query('SELECT * FROM app.campaigns WHERE organization_id=$1 AND id=$2 FOR SHARE',[ctx.organizationId,identifier(campaignId)]))[0];if(!campaign)return fail('CAMPAIGN_NOT_FOUND',404);
 if(campaign.state!=='active')return fail('CAMPAIGN_NOT_ACTIVE',403);
 if(!Number.isSafeInteger(messageRevision)||Number(campaign.revision)!==messageRevision||Number(campaign.approved_revision)!==messageRevision)return fail('CAMPAIGN_REVISION_MISMATCH',403);
 if(!campaign.schedule_start_at||new Date(campaign.schedule_start_at).getTime()>now.getTime())return fail('CAMPAIGN_NOT_STARTED',403);
 if(campaign.schedule_end_at&&new Date(campaign.schedule_end_at).getTime()<=now.getTime())return fail('CAMPAIGN_ENDED',403);
 const policy=rows(await tx.query('SELECT paused,outbound_enabled FROM app.policy_controls WHERE organization_id=$1',[ctx.organizationId]))[0];
 if(!policy||policy.paused)return fail('OWNER_PAUSED',403);if(!policy.outbound_enabled)return fail('OUTBOUND_DISABLED',403);
 if(!inSendWindow(now,windowOf(campaign)))return fail('OUTSIDE_SENDING_WINDOW',403);
 const studio=new CampaignStudio(tx,ctx,{clock:()=>now});
 const loaded=await studio.assertFreshApproval(tx,campaign);
 for(const template of loaded.variantTemplates.values())for(const id of (template.fact_ids??[]) as string[]){const problem=factProblem(loaded.facts.get(String(id).toLowerCase()),String(campaign.project_id),now);if(problem)return fail(problem.code,403);}
 const committed=rows(await tx.query('SELECT COALESCE(sum(max_cost_cents),0)::bigint AS committed FROM app.campaign_work_items WHERE organization_id=$1 AND campaign_id=$2',[ctx.organizationId,campaign.id]))[0]!;
 if(loaded.budget&&Number(committed.committed)>Number(loaded.budget.total_cents))return fail('CAMPAIGN_BUDGET_EXHAUSTED',403);
 return {campaignId:String(campaign.id),revision:Number(campaign.revision),approvalId:String(campaign.approval_id),bindingHash:String(campaign.approved_hash),senderMailboxId:campaign.mailbox_id as string|null,perMessageMaxCents:loaded.budget?Number(loaded.budget.per_message_max_cents):0};
}
