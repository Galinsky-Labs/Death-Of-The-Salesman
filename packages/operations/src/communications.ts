// DOTS-094..DOTS-108: unified communications and owner-managed outreach.
// Every mutation runs through tenant() (row-level security + owner membership check) and appends an operation event.
// Nothing here sends mail by itself: dispatch always goes through DeliveryGateway with communicationDispatchChecks.
import {createHash} from 'node:crypto';
import {promises as dns} from 'node:dns';
import {type Client,type Context,type Row,rows,tenant,event,digest,fail,text,randomUUID} from './common.js';
import {identifier,selection,SalesWorkspace} from './sales.js';
import {ControlPlane} from './control.js';
import {DeliveryGateway,type DispatchCheck} from './integrations.js';

type Env=Record<string,string|undefined>;
export type DeliveryKind='accepted'|'deferred'|'delivered'|'bounced'|'complained'|'failed';
export type AuthStatus='unknown'|'pending'|'pass'|'fail';
export type ReplyLabel='interested'|'not_interested'|'question'|'opt_out'|'ambiguous';
export type InboundAttachment={filename:string;contentType:string;size:number;providerRef:string|null};
export type InboundMessage={providerMessageId:string;messageId:string|null;inReplyTo:string|null;references:string[];from:string;to:string[];cc:string[];subject:string;text:string;receivedAt:Date|null;providerThreadId:string|null;authentication:'pass'|'fail'|'unknown';attachments:InboundAttachment[]};
export type Citation={rule:string;excerpt:string;offset:number};
export type Triage={label:ReplyLabel;confidenceBasisPoints:number;escalate:boolean;rules:string[];citations:Citation[];method:'deterministic_rules'};
export type OptOutChannel='one_click'|'link'|'reply_keyword'|'owner'|'complaint'|'bounce';

const providerIdPattern=/^[A-Za-z0-9_.:@-]{1,200}$/;
const emailPattern=/^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;
const tokenRefPattern=/^(env|vault):[A-Za-z0-9_./-]{3,120}$/;
const day=86400000;
const int=(value:string|undefined,fallback:number,min:number,max:number)=>{const parsed=Number(value);return Number.isSafeInteger(parsed)&&parsed>=min&&parsed<=max?parsed:fallback;};
const unique=<T>(values:T[])=>[...new Set(values)];

// ---------- Pure normalization helpers (DOTS-096) ----------
export function normalizeMessageId(value:unknown):string|null {
 if(typeof value!=='string')return null;let item=value.trim();const bracketed=item.match(/<([^<>\s]+)>/);if(bracketed)item=bracketed[1]!;
 if(!/^[^\s<>@]{1,240}@[^\s<>@]{1,240}$/.test(item))return null;const at=item.lastIndexOf('@');return `${item.slice(0,at)}@${item.slice(at+1).toLowerCase()}`;
}
export function parseReferences(value:unknown):string[] {
 const source=Array.isArray(value)?value.map(String).join(' '):typeof value==='string'?value:'';if(!source)return [];
 const bracketed=[...source.matchAll(/<([^<>\s]+)>/g)].map(match=>match[1]!);const tokens=bracketed.length?bracketed:source.split(/[\s,]+/);
 return unique(tokens.map(normalizeMessageId).filter((item):item is string=>Boolean(item))).slice(-50);
}
export function normalizeSubject(value:unknown):string {
 let subject=String(value??'').replace(/[\r\n\t]+/g,' ');let previous='';
 while(previous!==subject){previous=subject;subject=subject.replace(/^\s*(re|fw|fwd|aw|sv|wg|rv|tr|antw|res)\s*(\[\d+\])?\s*:\s*/i,'');}
 return subject.replace(/\s+/g,' ').trim().toLowerCase().slice(0,240);
}
export function parseAddress(value:unknown):string|null {
 if(typeof value!=='string'||value.length>500)return null;const match=value.trim().match(/<?([^\s<>@",;]+@[^\s<>@",;]+\.[^\s<>@",;]+)>?$/);return match?match[1]!.toLowerCase():null;
}
export function parseAddressList(value:unknown):string[] {
 const items=Array.isArray(value)?value:typeof value==='string'?value.split(','):[];return unique(items.map(parseAddress).filter((item):item is string=>Boolean(item))).slice(0,50);
}
function headerLookup(headers:unknown):(name:string)=>string|undefined {
 if(Array.isArray(headers))return name=>{const found=headers.find(item=>String(item?.name??'').toLowerCase()===name);return typeof found?.value==='string'?found.value:undefined;};
 if(headers&&typeof headers==='object'){const map=new Map(Object.entries(headers as Record<string,unknown>).map(([key,value])=>[key.toLowerCase(),value]));return name=>{const value=map.get(name);return typeof value==='string'?value:Array.isArray(value)?value.join(' '):undefined;};}
 return ()=>undefined;
}
export function authenticationVerdict(results:string|undefined):'pass'|'fail'|'unknown' {
 if(!results)return 'unknown';const value=results.toLowerCase();
 if(/dmarc=fail/.test(value)||(/spf=(fail|softfail)/.test(value)&&/dkim=fail/.test(value)))return 'fail';
 if(/dmarc=pass/.test(value)||/dkim=pass/.test(value))return 'pass';return 'unknown';
}
/** Normalizes an authenticated provider payload (Resend receiving API or the signed generic format) into a canonical inbound message. */
export function normalizeInbound(raw:Record<string,any>):InboundMessage {
 const header=headerLookup(raw.headers);const from=parseAddress(String(raw.from??header('from')??''));if(!from)return fail('INBOUND_SENDER_INVALID',400);
 const providerMessageId=String(raw.provider_message_id??raw.id??'');if(!providerIdPattern.test(providerMessageId))return fail('INVALID_RECEIPT',400);
 const received=new Date(String(raw.received_at??raw.created_at??''));
 const attachments=(Array.isArray(raw.attachments)?raw.attachments:[]).slice(0,20).map((item:any)=>({filename:String(item?.filename??'attachment').slice(0,500),contentType:String(item?.content_type??item?.contentType??'application/octet-stream').toLowerCase().split(';')[0]!.trim(),size:Number(item?.size??item?.size_bytes??-1),providerRef:typeof item?.id==='string'&&providerIdPattern.test(item.id)?item.id:null}));
 return {providerMessageId,messageId:normalizeMessageId(raw.message_id??header('message-id')),inReplyTo:normalizeMessageId(raw.in_reply_to??header('in-reply-to')),references:parseReferences(raw.references??header('references')),
  from,to:parseAddressList(raw.to??header('to')),cc:parseAddressList(raw.cc??header('cc')),subject:String(raw.subject||'(No subject)').replace(/[\r\n]+/g,' ').slice(0,240),
  text:String(raw.text||'[Plain-text content unavailable. Attachments and HTML are not imported.]').slice(0,50000),receivedAt:Number.isFinite(received.getTime())?received:null,
  providerThreadId:typeof raw.thread_id==='string'&&raw.thread_id.length<=200?raw.thread_id:null,
  authentication:raw.authentication==='pass'||raw.authentication==='fail'?raw.authentication:authenticationVerdict(header('authentication-results')),attachments};
}

// ---------- Deterministic reply triage (DOTS-104) ----------
const quoteBoundary=/^(On\s.+\swrote:\s*$|-{2,}\s*(Original Message|Forwarded message)|From:\s.*@.*$|Le\s.+\sa\s[ée]crit\s?:|Am\s.+\sschrieb\s.+:|El\s.+\sescribi[óo]:|Em\s.+\sescreveu:|Il\s.+\sha\sscritto:)/i;
/** Removes quoted history and our own unsubscribe footer so a quoted footer is never read as the contact opting out. */
export function stripQuotedText(body:string):string {
 const kept:string[]=[];for(const line of String(body).split(/\r?\n/)){if(quoteBoundary.test(line.trim()))break;if(/^\s*>/.test(line))continue;if(/\/unsubscribe\?token=|^\s*unsubscribe:\s*https?:\/\//i.test(line))continue;kept.push(line);}
 return kept.join('\n').trim();
}
const optOutRules:[string,RegExp][]=[
 ['en.unsubscribe',/\bunsubscribe\b/i],['en.remove_me',/\bremove me\b|\btake me off\b|\bremove (my|this) (e-?mail|address)\b/i],
 ['en.stop_contact',/\bstop (e-?mailing|contacting|sending|messaging|writing)\b/i],['en.opt_out',/\bopt[- ]?out\b/i],
 ['en.do_not_contact',/\bdo not (contact|email|e-mail|message|write)\b|\bdon'?t (contact|email|e-mail|message) (me|us)\b|\bno more e-?mails?\b/i],
 ['en.stop',/^\s*stop\s*[.!]*\s*$/im],
 ['es.baja',/dar(me)? de baja|no me (escriba|escribas|contacte|contactes|env[íi]e)|no quiero recibir/i],
 ['fr.desabonner',/d[ée]sabonn|d[ée]sinscri|ne plus recevoir|ne me contactez plus/i],
 ['de.abmelden',/\babmelden\b|\baustragen\b|keine (e-?mails|nachrichten) mehr|nicht mehr kontaktieren/i],
 ['pt.descadastrar',/descadastr|remover da lista|n[ãa]o quero (mais )?receber/i],
 ['it.disiscrivi',/disiscriv|cancellami|non voglio (pi[uù] )?ricevere/i],
 ['nl.afmelden',/\bafmelden\b|\buitschrijven\b/i],
];
const notInterestedRules:[string,RegExp][]=[['not_interested.explicit',/\bnot interested\b|\bno interest\b|\bno estamos interesados\b|\bpas int[ée]ress[ée]|\bkein interesse\b/i],['not_interested.decline',/\bno,? thanks?\b|\bno,? thank you\b|\bnot a (good )?fit\b|\bwe(')?ll pass\b|\bnot for us\b/i]];
const interestedRules:[string,RegExp][]=[['interested.explicit',/\b(i'?m|we'?re|i am|we are) (very )?interested\b|\bsounds (good|great|interesting)\b/i],['interested.meeting',/\blet'?s (talk|chat|meet|schedule)\b|\bbook a (call|meeting|demo)\b|\bhappy to (chat|talk|meet)\b|\bset up a (call|meeting|time)\b/i],['interested.info',/\bsend (me |us )?more (info|information|details)\b/i]];
const questionRules:[string,RegExp][]=[['question.mark',/\?/],['question.lead',/^\s*(what|how|when|where|why|who|which|can|could|does|do|is|are|would|will)\b/im]];
function matches(rules:[string,RegExp][],body:string){const found:{rule:string;citation:Citation}[]=[];for(const [rule,pattern] of rules){const match=pattern.exec(body);if(match){const offset=match.index;found.push({rule,citation:{rule,offset,excerpt:body.slice(Math.max(0,offset-40),offset+match[0].length+40).replace(/\s+/g,' ').trim()}});}}return found;}
/** Deterministic classification; opt-out detection never depends on a model. */
export function classifyReply(body:string):Triage {
 const clean=stripQuotedText(body).slice(0,20000);const optOut=matches(optOutRules,clean);
 const build=(label:ReplyLabel,confidence:number,found:{rule:string;citation:Citation}[]):Triage=>({label,confidenceBasisPoints:confidence,escalate:label==='ambiguous'||confidence<7500,rules:found.map(item=>item.rule),citations:found.map(item=>item.citation),method:'deterministic_rules'});
 if(optOut.length)return build('opt_out',10000,optOut);
 const no=matches(notInterestedRules,clean),yes=no.length?[]:matches(interestedRules,clean),question=matches(questionRules,clean);
 if(no.length&&!question.length)return build('not_interested',8500,no);
 if(no.length)return build('not_interested',6000,[...no,...question]);
 if(yes.length&&question.length)return build('interested',7000,[...yes,...question]);
 if(yes.length)return build('interested',8000,yes);
 if(question.length)return build('question',7500,question);
 return build('ambiguous',3000,[]);
}

// ---------- Attachment safety (DOTS-107) ----------
export const attachmentTypes=['application/pdf','image/png','image/jpeg','image/gif','image/webp','text/plain','text/csv'] as const;
const forbiddenExtensions=/\.(exe|dll|com|bat|cmd|scr|pif|vbs|vbe|js|jse|mjs|wsf|ps1|psm1|msi|msp|jar|apk|app|dmg|iso|img|lnk|hta|html?|svg|xhtml|docm|xlsm|pptm|zip|rar|7z|gz|tar|sh)$/i;
const eicar='X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
export function maxAttachmentBytes(env:Env=process.env){return int(env.ATTACHMENT_MAX_BYTES,5242880,1,5242880);}
export function sanitizeFilename(value:unknown):string {const name=String(value??'').split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f"<>|:*?]/g,'_').replace(/^\.+/,'').trim().slice(0,200);return name||'attachment';}
export function containsEicar(bytes:Uint8Array):boolean {return Buffer.from(bytes).includes(Buffer.from(eicar,'latin1'));}
export function sniffContentType(bytes:Uint8Array):string {
 const b=Buffer.from(bytes);const starts=(...sig:number[])=>sig.every((value,index)=>b[index]===value);
 if(b.subarray(0,5).toString('latin1')==='%PDF-')return 'application/pdf';if(starts(0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a))return 'image/png';if(starts(0xff,0xd8,0xff))return 'image/jpeg';
 if(['GIF87a','GIF89a'].includes(b.subarray(0,6).toString('latin1')))return 'image/gif';if(b.subarray(0,4).toString('latin1')==='RIFF'&&b.subarray(8,12).toString('latin1')==='WEBP')return 'image/webp';
 if(starts(0x4d,0x5a))return 'application/x-msdownload';if(starts(0x50,0x4b,0x03,0x04))return 'application/zip';if(starts(0x7f,0x45,0x4c,0x46))return 'application/x-elf';
 if(b.length&&!b.includes(0)){try{const decoded=new TextDecoder('utf-8',{fatal:true}).decode(b);if(/^\s*<(!doctype|html|svg|script|\?xml)/i.test(decoded))return 'text/html';return 'text/plain';}catch{return 'application/octet-stream';}}
 return 'application/octet-stream';
}
export function attachmentDownloadHeaders(row:{filename:string;sniffed_type?:string|null}):Record<string,string> {
 const name=sanitizeFilename(row.filename);const ascii=name.replace(/[^\x20-\x7e]/g,'_');const inlineSafe=['image/png','image/jpeg','image/gif','image/webp'].includes(String(row.sniffed_type));
 return {'Content-Type':inlineSafe?String(row.sniffed_type):'application/octet-stream','Content-Disposition':`attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,'X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox",'Cache-Control':'private, no-store','Cross-Origin-Resource-Policy':'same-origin'};
}
function stagedState(input:{filename:string;contentType:string;size:number},env:Env):{state:'staged'|'rejected';reason:string|null} {
 if(forbiddenExtensions.test(input.filename))return {state:'rejected',reason:'FORBIDDEN_EXTENSION'};
 if(!(attachmentTypes as readonly string[]).includes(input.contentType))return {state:'rejected',reason:'FORBIDDEN_TYPE'};
 if(!Number.isSafeInteger(input.size)||input.size<0)return {state:'staged',reason:null};
 if(input.size>maxAttachmentBytes(env))return {state:'rejected',reason:'OVERSIZED'};return {state:'staged',reason:null};
}

// ---------- Scheduling helpers (DOTS-105) ----------
function localHour(date:Date,timezone:string){return Number(new Intl.DateTimeFormat('en-US',{timeZone:timezone,hour:'2-digit',hourCycle:'h23'}).format(date));}
export function inQuietHours(date:Date,quietStart:number,quietEnd:number,timezone:string){if(quietStart===quietEnd)return false;const hour=localHour(date,timezone);return quietStart<quietEnd?hour>=quietStart&&hour<quietEnd:hour>=quietStart||hour<quietEnd;}
/** First instant at or after `date` outside the quiet window, at 15-minute resolution. */
export function nextAllowedSendTime(date:Date,quietStart:number,quietEnd:number,timezone:string):Date {let candidate=new Date(date.getTime());for(let step=0;step<200&&inQuietHours(candidate,quietStart,quietEnd,timezone);step++)candidate=new Date(candidate.getTime()+900000);return candidate;}
function validTimezone(value:unknown){const zone=text(value??'America/New_York','timezone',64);try{new Intl.DateTimeFormat('en-US',{timeZone:zone});return zone;}catch{return fail('INVALID_TIMEZONE',400);}}

// ---------- Delivery labels (DOTS-097) ----------
export function deliveryLabel(message:Row):{label:string;tone:'good'|'bad'|'neutral'|'waiting';evidence:string} {
 const provider=message.provider_message_id?`Provider message id ${message.provider_message_id}`:'No provider receipt';
 if(message.direction==='inbound'){if(message.state==='quarantined')return {label:'Quarantined: sender authentication failed',tone:'bad',evidence:'Inbound authentication results failed; owner review required'};if(message.state==='redacted')return {label:'Redacted',tone:'neutral',evidence:'Privacy erasure'};return {label:'Received',tone:'good',evidence:`Authenticated provider event (${message.authentication??'unknown'} sender authentication). ${provider}`};}
 switch(message.state){
  case 'draft':return {label:'Drafted',tone:'neutral',evidence:'Not approved; nothing sent'};
  case 'pending_approval':return {label:'Drafted · awaiting owner approval',tone:'waiting',evidence:'Approval requested; nothing sent'};
  case 'approved':return {label:'Drafted · approved',tone:'waiting',evidence:'Approved but not dispatched'};
  case 'sending':return {label:'Sending · awaiting provider',tone:'waiting',evidence:'Dispatch authorized; no provider receipt yet'};
  case 'quarantined':return {label:'Uncertain · needs reconciliation',tone:'bad',evidence:'Transport outcome unknown; will not be retried automatically'};
  case 'failed':return {label:'Not sent',tone:'bad',evidence:'Provider rejected the request or the owner reconciled it as not sent'};
  case 'cancelled':return {label:'Cancelled',tone:'neutral',evidence:'Cancelled before dispatch (opt-out, reply or sequence cancellation)'};
  case 'redacted':return {label:'Redacted',tone:'neutral',evidence:'Privacy erasure'};
 }
 if(message.delivery_status==='bounced')return {label:'Bounced',tone:'bad',evidence:provider};
 if(message.delivery_status==='complained')return {label:'Spam complaint',tone:'bad',evidence:provider};
 if(message.delivery_status==='failed')return {label:'Delivery failed',tone:'bad',evidence:provider};
 if(message.delivery_status==='delivered'||message.state==='delivered')return {label:'Delivered',tone:'good',evidence:provider};
 if(message.delivery_status==='deferred')return {label:'Delivery delayed',tone:'waiting',evidence:provider};
 return {label:'Provider accepted',tone:'good',evidence:provider};
}

// ---------- Transaction-level building blocks shared with DeliveryGateway ----------
export async function applyMailboxAuthentication(tx:Client,ctx:Context,mailboxId:string,result:{spf:string;dkim:string;dmarc:string}) {
 const allPass=result.spf==='pass'&&result.dkim==='pass'&&result.dmarc==='pass';
 await tx.query(`UPDATE app.mailboxes SET spf_status=$3,dkim_status=$4,dmarc_status=$5,auth_checked_at=app.utc_now(),verified=CASE WHEN $3='pass' AND $4='pass' THEN true ELSE verified END,
  status=CASE WHEN $6::boolean AND owner_consent_at IS NOT NULL AND verified AND status='disabled' THEN 'active' WHEN NOT $6::boolean AND status='active' THEN 'paused' ELSE status END,
  pause_reason=CASE WHEN NOT $6::boolean AND status='active' THEN 'SENDER_AUTHENTICATION_INCOMPLETE' ELSE pause_reason END,version=version+1 WHERE organization_id=$1 AND id=$2`,[ctx.organizationId,mailboxId,result.spf,result.dkim,result.dmarc,allPass]);
}
const deliveryRank:Record<string,number>={accepted:1,deferred:2,delivered:3,failed:4,bounced:4,complained:5};
export function healthThresholds(env:Env=process.env){return {bounceBasisPoints:int(env.SENDER_BOUNCE_PAUSE_BASIS_POINTS,500,1,10000),complaintBasisPoints:int(env.SENDER_COMPLAINT_PAUSE_BASIS_POINTS,30,1,10000),windowDays:30};}
async function healthStats(tx:Client,ctx:Context,column:'campaign_id'|'mailbox_id',id:string){
 const sent=rows(await tx.query(`SELECT count(DISTINCT a.message_id)::int AS n FROM app.dispatch_attempts a JOIN app.messages m ON m.id=a.message_id AND m.organization_id=a.organization_id WHERE a.organization_id=$1 AND m.${column}=$2 AND a.state IN ('accepted','resolved_sent') AND a.started_at>app.utc_now()-interval '30 days'`,[ctx.organizationId,id]))[0]!;
 const events=rows(await tx.query(`SELECT count(DISTINCT message_id) FILTER(WHERE kind='bounced' AND bounce_type='hard')::int AS bounced,count(DISTINCT message_id) FILTER(WHERE kind='complained')::int AS complaints FROM app.delivery_events WHERE organization_id=$1 AND ${column}=$2 AND occurred_at>app.utc_now()-interval '30 days'`,[ctx.organizationId,id]))[0]!;
 const bounced=Number(events.bounced),complaints=Number(events.complaints),denominator=Math.max(Number(sent.n),bounced,complaints);
 return {sent:Number(sent.n),bounced,complaints,bounceBasisPoints:denominator?Math.round(bounced*10000/denominator):null,complaintBasisPoints:denominator?Math.round(complaints*10000/denominator):null};
}
async function evaluateSenderHealth(tx:Client,ctx:Context,scope:{mailboxId?:string|null;campaignId?:string|null},env:Env){
 const limits=healthThresholds(env);const paused:string[]=[];
 const breach=(stats:Awaited<ReturnType<typeof healthStats>>)=>stats.complaints>0&&Number(stats.complaintBasisPoints)>=limits.complaintBasisPoints?'COMPLAINT_RATE_EXCEEDED':stats.bounced>0&&Number(stats.bounceBasisPoints)>=limits.bounceBasisPoints?'BOUNCE_RATE_EXCEEDED':null;
 if(scope.campaignId){const reason=breach(await healthStats(tx,ctx,'campaign_id',scope.campaignId));if(reason&&rows(await tx.query("UPDATE app.campaigns SET state='paused',version=version+1,updated_at=app.utc_now() WHERE organization_id=$1 AND id=$2 AND state='active' RETURNING id",[ctx.organizationId,scope.campaignId])).length){paused.push(`campaign:${reason}`);await event(tx,ctx,'campaign.risk_paused',scope.campaignId,{reasonCode:reason},'worker');}}
 if(scope.mailboxId){const reason=breach(await healthStats(tx,ctx,'mailbox_id',scope.mailboxId));if(reason&&rows(await tx.query("UPDATE app.mailboxes SET status='paused',pause_reason=$3,version=version+1 WHERE organization_id=$1 AND id=$2 AND status='active' RETURNING id",[ctx.organizationId,scope.mailboxId,reason])).length){paused.push(`mailbox:${reason}`);await event(tx,ctx,'mailbox.risk_paused',scope.mailboxId,{reasonCode:reason},'worker');}}
 return paused;
}
async function applyDelivery(tx:Client,ctx:Context,message:Row,kind:DeliveryKind,bounceType:string|null,providerEventId:string,env:Env){
 const status=kind==='bounced'&&bounceType==='soft'?'deferred':kind;// a soft bounce is a delay, not a final bounce
 if((deliveryRank[status]??0)>(deliveryRank[String(message.delivery_status)]??0))await tx.query("UPDATE app.messages SET delivery_status=$3,delivery_updated_at=app.utc_now(),state=CASE WHEN $3='delivered' AND state IN ('sent','sending') THEN 'delivered' ELSE state END WHERE organization_id=$1 AND id=$2",[ctx.organizationId,message.id,status]);
 let optOut=null;if((kind==='bounced'&&bounceType==='hard')||kind==='complained')optOut=await processOptOutTx(tx,ctx,message.contact_id,kind==='complained'?'complaint':'bounce',{providerEventId},'provider');
 const paused=['bounced','complained'].includes(kind)?await evaluateSenderHealth(tx,ctx,{mailboxId:message.mailbox_id,campaignId:message.campaign_id},env):[];
 return {suppressed:Boolean(optOut),paused};
}
/** Records one provider delivery receipt exactly once. Unknown provider ids are never guessed: they go to the owner reconciliation queue. Out-of-order receipts never downgrade a status. */
export async function recordDeliveryEvent(tx:Client,ctx:Context,input:{providerEventId:string;providerMessageId:string;kind:DeliveryKind;bounceType:string|null;occurredAt:Date;source:'provider'|'simulation'},env:Env=process.env):Promise<{duplicate?:boolean;matched:boolean;messageId?:string;suppressed?:boolean;paused?:string[]}> {
 if(rows(await tx.query('SELECT id FROM app.delivery_events WHERE organization_id=$1 AND provider_event_id=$2',[ctx.organizationId,input.providerEventId])).length)return {duplicate:true,matched:false};
 const message=rows(await tx.query("SELECT m.id,m.mailbox_id,m.campaign_id,m.delivery_status,m.state,c.contact_id FROM app.messages m JOIN app.conversations c ON c.id=m.conversation_id AND c.organization_id=m.organization_id WHERE m.organization_id=$1 AND m.provider_message_id=$2 AND m.direction='outbound'",[ctx.organizationId,input.providerMessageId]))[0];
 await tx.query('INSERT INTO app.delivery_events(organization_id,message_id,mailbox_id,campaign_id,provider_event_id,provider_message_id,kind,bounce_type,source,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[ctx.organizationId,message?.id??null,message?.mailbox_id??null,message?.campaign_id??null,input.providerEventId,input.providerMessageId,input.kind,input.kind==='bounced'?input.bounceType??'hard':null,input.source,input.occurredAt.toISOString()]);
 if(!message){await tx.query("INSERT INTO app.reconciliation_items(organization_id,kind,provider_ref,details) VALUES($1,'unmatched_receipt',$2,$3::jsonb)",[ctx.organizationId,input.providerMessageId,JSON.stringify({kind:input.kind,providerEventId:input.providerEventId})]);await event(tx,ctx,'delivery.unmatched',null,{kind:input.kind},'provider');return {matched:false};}
 const outcome=await applyDelivery(tx,ctx,message,input.kind,input.kind==='bounced'?input.bounceType??'hard':null,input.providerEventId,env);
 await event(tx,ctx,'delivery.recorded',message.id,{kind:input.kind,bounceType:input.bounceType,source:input.source},'provider');return {matched:true,messageId:message.id,...outcome};
}
/** Marks a message provider-accepted and applies any receipts that arrived before the acceptance was known. */
export async function markProviderAccepted(tx:Client,ctx:Context,messageId:string,providerMessageId:string,attemptId:string,attemptState:'accepted'|'resolved_sent',env:Env=process.env){
 if(!providerIdPattern.test(providerMessageId))return fail('INVALID_PROVIDER_MESSAGE_ID',400);
 const message=rows(await tx.query("UPDATE app.messages SET state='sent',provider_message_id=$3,sent_at=COALESCE(sent_at,app.utc_now()),delivery_status=COALESCE(delivery_status,'accepted'),delivery_updated_at=app.utc_now() WHERE organization_id=$1 AND id=$2 AND state IN ('sending','quarantined') RETURNING id,conversation_id,mailbox_id,campaign_id,delivery_status",[ctx.organizationId,messageId,providerMessageId]))[0];
 if(!message)return fail('MESSAGE_NOT_IN_FLIGHT');
 await tx.query("UPDATE app.dispatch_attempts SET state=$3,provider_message_id=$4,receipt_hash=$5,finished_at=app.utc_now() WHERE organization_id=$1 AND id=$2",[ctx.organizationId,attemptId,attemptState,providerMessageId,digest({providerMessageId,attemptState})]);
 await tx.query("UPDATE app.sequence_steps SET state='sent',updated_at=app.utc_now() WHERE organization_id=$1 AND message_id=$2 AND state='dispatching'",[ctx.organizationId,messageId]);
 await tx.query('UPDATE app.conversations SET needs_owner=false,sla_due_at=NULL,updated_at=app.utc_now() WHERE organization_id=$1 AND id=$2',[ctx.organizationId,message.conversation_id]);
 const contact=rows(await tx.query('SELECT contact_id FROM app.conversations WHERE organization_id=$1 AND id=$2',[ctx.organizationId,message.conversation_id]))[0]!;
 const early=rows(await tx.query("SELECT provider_event_id,kind,bounce_type FROM app.delivery_events WHERE organization_id=$1 AND provider_message_id=$2 AND message_id IS NULL ORDER BY occurred_at",[ctx.organizationId,providerMessageId]));
 for(const item of early)await applyDelivery(tx,ctx,{...message,id:messageId,contact_id:contact.contact_id,delivery_status:rows(await tx.query('SELECT delivery_status FROM app.messages WHERE organization_id=$1 AND id=$2',[ctx.organizationId,messageId]))[0]!.delivery_status},item.kind,item.bounce_type,item.provider_event_id,env);
 if(early.length)await tx.query("UPDATE app.reconciliation_items SET state='resolved',resolution='accepted',evidence='Matched after provider acceptance was recorded',resolved_at=app.utc_now() WHERE organization_id=$1 AND kind='unmatched_receipt' AND provider_ref=$2 AND state='open'",[ctx.organizationId,providerMessageId]);
}
const suppressionSource:Record<OptOutChannel,string>={one_click:'unsubscribe',link:'unsubscribe',reply_keyword:'unsubscribe',owner:'owner',complaint:'complaint',bounce:'bounce'};
/** Cancels a sequence enrollment. Lock order is messages -> enrollment -> steps, matching the dispatch path, so cancellation and dispatch serialize instead of racing. */
export async function cancelEnrollmentTx(tx:Client,ctx:Context,enrollmentId:string,reason:string){
 await tx.query("SELECT m.id FROM app.messages m JOIN app.sequence_steps s ON s.message_id=m.id AND s.organization_id=m.organization_id WHERE m.organization_id=$1 AND s.enrollment_id=$2 FOR UPDATE OF m",[ctx.organizationId,enrollmentId]);
 const enrollment=rows(await tx.query('SELECT * FROM app.sequence_enrollments WHERE organization_id=$1 AND id=$2 FOR UPDATE',[ctx.organizationId,enrollmentId]))[0];if(!enrollment)return fail('NOT_FOUND',404);
 if(['cancelled','completed'].includes(enrollment.state))return {cancelledSteps:0,alreadyDispatched:[] as string[],state:enrollment.state};
 await tx.query("UPDATE app.sequence_enrollments SET state='cancelled',state_reason=$3,version=version+1,updated_at=app.utc_now() WHERE organization_id=$1 AND id=$2",[ctx.organizationId,enrollmentId,reason]);
 const steps=rows(await tx.query("SELECT s.id,s.state,s.message_id,m.state AS message_state FROM app.sequence_steps s LEFT JOIN app.messages m ON m.id=s.message_id AND m.organization_id=s.organization_id WHERE s.organization_id=$1 AND s.enrollment_id=$2 AND s.state IN ('scheduled','dispatching','sent') FOR UPDATE OF s",[ctx.organizationId,enrollmentId]));
 let cancelledSteps=0;const alreadyDispatched:string[]=[];
 for(const step of steps){
  if(step.state==='sent'||step.state==='dispatching'&&step.message_id&&!['draft','pending_approval','approved','cancelled','failed'].includes(step.message_state)){alreadyDispatched.push(step.id);continue;}
  if(step.message_id)await tx.query("UPDATE app.messages SET state='cancelled',version=version+1 WHERE organization_id=$1 AND id=$2 AND state IN ('draft','pending_approval','approved')",[ctx.organizationId,step.message_id]);
  await tx.query("UPDATE app.sequence_steps SET state='cancelled',state_reason=$3,updated_at=app.utc_now() WHERE organization_id=$1 AND id=$2",[ctx.organizationId,step.id,reason]);cancelledSteps++;
 }
 await event(tx,ctx,'sequence.enrollment_cancelled',enrollmentId,{reasonCode:reason,cancelledSteps,alreadyDispatched:alreadyDispatched.length});
 return {cancelledSteps,alreadyDispatched,state:'cancelled'};
}
async function cancelContactSequences(tx:Client,ctx:Context,contactId:string,reason:string){
 let cancelled=0;for(const enrollment of rows(await tx.query("SELECT id FROM app.sequence_enrollments WHERE organization_id=$1 AND contact_id=$2 AND state IN ('active','paused') ORDER BY id",[ctx.organizationId,contactId])))cancelled+=(await cancelEnrollmentTx(tx,ctx,enrollment.id,reason)).cancelledSteps;return cancelled;
}
/** High-priority opt-out: suppresses the address, cancels every pending outbound draft and sequence step for the contact, and records evidence, all in one transaction. */
export async function processOptOutTx(tx:Client,ctx:Context,contactId:string,channel:OptOutChannel,evidence:Record<string,unknown>,actor:'human'|'provider'='provider'){
 await tx.query("SELECT m.id FROM app.messages m JOIN app.conversations c ON c.id=m.conversation_id AND c.organization_id=m.organization_id WHERE m.organization_id=$1 AND c.contact_id=$2 AND m.direction='outbound' AND m.state IN ('draft','pending_approval','approved') FOR UPDATE OF m",[ctx.organizationId,contactId]);
 const contact=rows(await tx.query("UPDATE app.crm_contacts SET status=CASE WHEN status='redacted' THEN status ELSE 'suppressed' END,consent='opted_out',version=version+1,updated_at=app.utc_now() WHERE organization_id=$1 AND id=$2 RETURNING email_hash",[ctx.organizationId,contactId]))[0];if(!contact)return fail('NOT_FOUND',404);
 await tx.query('INSERT INTO app.contact_suppressions(organization_id,email_hash,reason,source) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[ctx.organizationId,contact.email_hash,`OPT_OUT_${channel.toUpperCase()}`,suppressionSource[channel]]);
 const cancelledMessages=rows(await tx.query("UPDATE app.messages m SET state='cancelled',version=m.version+1 FROM app.conversations c WHERE c.id=m.conversation_id AND c.organization_id=m.organization_id AND m.organization_id=$1 AND c.contact_id=$2 AND m.direction='outbound' AND m.state IN ('draft','pending_approval','approved') RETURNING m.id",[ctx.organizationId,contactId])).length;
 const cancelledSteps=await cancelContactSequences(tx,ctx,contactId,'opt_out');
 await tx.query('INSERT INTO app.opt_out_records(organization_id,contact_id,email_hash,channel,evidence_hash,cancelled_steps,cancelled_messages) VALUES($1,$2,$3,$4,$5,$6,$7)',[ctx.organizationId,contactId,contact.email_hash,channel,digest(evidence),cancelledSteps,cancelledMessages]);
 await event(tx,ctx,'contact.opted_out',contactId,{channel,cancelledSteps,cancelledMessages},actor);
 return {contactId,channel,cancelledSteps,cancelledMessages};
}
async function stageAttachmentTx(tx:Client,ctx:Context,input:{messageId?:string|null;conversationId?:string|null;direction:'inbound'|'outbound';filename:string;contentType:string;size:number;providerRef?:string|null},env:Env){
 const filename=sanitizeFilename(input.filename),contentType=String(input.contentType).toLowerCase().split(';')[0]!.trim().slice(0,120)||'application/octet-stream';const verdict=stagedState({filename,contentType,size:input.size},env);
 return rows(await tx.query('INSERT INTO app.message_attachments(organization_id,message_id,conversation_id,direction,filename,declared_type,size_bytes,provider_ref,scan_state,scan_reason,scanned_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id,scan_state,scan_reason',[ctx.organizationId,input.messageId??null,input.conversationId??null,input.direction,filename,contentType,Math.max(0,Number.isSafeInteger(input.size)?input.size:0),input.providerRef??null,verdict.state,verdict.reason,verdict.state==='rejected'?new Date().toISOString():null]))[0]!;
}
/** Imports one authenticated inbound message into canonical threads. Idempotent on provider id and Message-ID; never attaches a reply to a thread the sender did not participate in. */
export async function importInboundMessage(tx:Client,ctx:Context,message:InboundMessage,env:Env=process.env):Promise<{duplicate:boolean;ignored?:boolean;messageId?:string;conversationId?:string;triage?:ReplyLabel;thread?:string}> {
 await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`inbound-message:${ctx.organizationId}:${message.messageId??message.providerMessageId}`]);
 const prior=rows(await tx.query('SELECT id,conversation_id FROM app.messages WHERE organization_id=$1 AND (provider_message_id=$2 OR ($3::text IS NOT NULL AND message_id_header=$3)) LIMIT 1',[ctx.organizationId,message.providerMessageId,message.messageId]))[0];
 if(prior)return {duplicate:true,messageId:prior.id,conversationId:prior.conversation_id};
 const recipients=[...message.to,...message.cc];const mailbox=rows(await tx.query('SELECT id,sender_email FROM app.mailboxes WHERE organization_id=$1 AND verified ORDER BY created_at',[ctx.organizationId])).find(item=>recipients.includes(String(item.sender_email).toLowerCase()));
 if(!mailbox)return fail('INBOUND_RECIPIENT_NOT_CONFIGURED',403);
 const hash=digest(message.from);let contact=rows(await tx.query('SELECT id,status,email FROM app.crm_contacts WHERE organization_id=$1 AND email_hash=$2',[ctx.organizationId,hash]))[0];
 if(!contact)contact=rows(await tx.query("INSERT INTO app.crm_contacts(organization_id,display_name,email,email_hash,lawful_source,consent) VALUES($1,$2,$2,$3,'Verified inbound email','unknown') RETURNING id,status,email",[ctx.organizationId,message.from,hash]))[0]!;
 if(contact.status==='redacted')return {duplicate:false,ignored:true};
 const subjectKey=normalizeSubject(message.subject);let conversation:Row|undefined;let thread='new';let mismatch:string|null=null;
 const references=unique([message.inReplyTo,...message.references.slice().reverse()].filter((item):item is string=>Boolean(item)));
 if(references.length){
  const referenced=rows(await tx.query('SELECT m.id,m.conversation_id,m.campaign_id,m.from_address,m.to_addresses,m.cc_addresses,ct.email AS contact_email FROM app.messages m JOIN app.conversations c ON c.id=m.conversation_id AND c.organization_id=m.organization_id JOIN app.crm_contacts ct ON ct.id=c.contact_id AND ct.organization_id=c.organization_id WHERE m.organization_id=$1 AND m.message_id_header=ANY($2::text[]) ORDER BY array_position($2::text[],m.message_id_header) LIMIT 1',[ctx.organizationId,references]))[0];
  if(referenced){const participants=[referenced.contact_email,referenced.from_address,...(referenced.to_addresses??[]),...(referenced.cc_addresses??[])].filter(Boolean).map((item:string)=>item.toLowerCase());
   if(participants.includes(message.from)){conversation=rows(await tx.query('SELECT * FROM app.conversations WHERE organization_id=$1 AND id=$2',[ctx.organizationId,referenced.conversation_id]))[0];thread='references';if(conversation&&!conversation.campaign_id&&referenced.campaign_id){await tx.query('UPDATE app.conversations SET campaign_id=$3 WHERE organization_id=$1 AND id=$2',[ctx.organizationId,conversation.id,referenced.campaign_id]);conversation.campaign_id=referenced.campaign_id;}}
   else mismatch=referenced.id;}
 }
 if(!conversation&&!mismatch&&message.providerThreadId){conversation=rows(await tx.query('SELECT * FROM app.conversations WHERE organization_id=$1 AND provider_thread_id=$2 AND contact_id=$3 LIMIT 1',[ctx.organizationId,message.providerThreadId,contact.id]))[0];if(conversation)thread='provider_thread';}
 if(!conversation&&!mismatch){const open=rows(await tx.query("SELECT * FROM app.conversations WHERE organization_id=$1 AND contact_id=$2 AND state<>'closed' AND updated_at>app.utc_now()-interval '30 days' ORDER BY updated_at DESC LIMIT 20",[ctx.organizationId,contact.id]));conversation=open.find(item=>(item.normalized_subject??normalizeSubject(item.subject))===subjectKey);if(conversation)thread='subject';}
 if(!conversation)conversation=rows(await tx.query('INSERT INTO app.conversations(organization_id,contact_id,subject,normalized_subject,mailbox_id,provider_thread_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[ctx.organizationId,contact.id,message.subject,subjectKey,mailbox.id,message.providerThreadId]))[0]!;
 const state=message.authentication==='fail'?'quarantined':'received';
 const inserted=rows(await tx.query(`INSERT INTO app.messages(organization_id,conversation_id,campaign_id,mailbox_id,direction,subject,body,state,source,provider_message_id,content_hash,message_id_header,in_reply_to_header,references_headers,from_address,to_addresses,cc_addresses,authentication,received_at)
  VALUES($1,$2,$3,$4,'inbound',$5,$6,$7,'provider',$8,$9,$10,$11,$12::text[],$13,$14::text[],$15::text[],$16,$17) ON CONFLICT DO NOTHING RETURNING id`,[ctx.organizationId,conversation.id,conversation.campaign_id??null,mailbox.id,message.subject,message.text,state,message.providerMessageId,digest({subject:message.subject,body:message.text}),message.messageId,message.inReplyTo,message.references,message.from,message.to,message.cc,message.authentication,(message.receivedAt??new Date()).toISOString()]))[0];
 if(!inserted)return {duplicate:true,conversationId:conversation.id};
 for(const attachment of message.attachments)await stageAttachmentTx(tx,ctx,{messageId:inserted.id,conversationId:conversation.id,direction:'inbound',filename:attachment.filename,contentType:attachment.contentType,size:attachment.size,providerRef:attachment.providerRef},env);
 const triage=classifyReply(message.text);const escalate=triage.escalate||state==='quarantined';
 await tx.query("INSERT INTO app.reply_triage(organization_id,message_id,label,confidence_basis_points,method,rules,citations,escalated) VALUES($1,$2,$3,$4,'deterministic_rules',$5::jsonb,$6::jsonb,$7)",[ctx.organizationId,inserted.id,triage.label,triage.confidenceBasisPoints,JSON.stringify(triage.rules),JSON.stringify(triage.citations),escalate]);
 if(mismatch)await tx.query("INSERT INTO app.reconciliation_items(organization_id,kind,message_id,details) VALUES($1,'thread_mismatch',$2,$3::jsonb)",[ctx.organizationId,inserted.id,JSON.stringify({referencedMessageId:mismatch})]);
 if(state==='quarantined')await tx.query("INSERT INTO app.reconciliation_items(organization_id,kind,message_id,details) VALUES($1,'unverified_inbound',$2,$3::jsonb)",[ctx.organizationId,inserted.id,JSON.stringify({authentication:'fail'})]);
 // Opt-out keywords are honoured even from unauthenticated mail (over-suppression is the safe direction); any reply stops follow-ups.
 if(triage.label==='opt_out')await processOptOutTx(tx,ctx,contact.id,'reply_keyword',{messageId:inserted.id,rules:triage.rules},'provider');
 else await cancelContactSequences(tx,ctx,contact.id,'replied');
 const priority={interested:3,question:2,ambiguous:2,not_interested:1,opt_out:0}[triage.label];const slaHours={interested:4,question:8,ambiguous:8,not_interested:48,opt_out:0}[triage.label];
 const needsOwner=escalate||['interested','question'].includes(triage.label);
 await tx.query(`UPDATE app.conversations SET updated_at=app.utc_now(),last_inbound_at=app.utc_now(),state='open',needs_owner=needs_owner OR $3,priority=GREATEST(priority,$4),
  sla_due_at=CASE WHEN $3 THEN LEAST(COALESCE(sla_due_at,app.utc_now()+make_interval(hours=>$5)),app.utc_now()+make_interval(hours=>$5)) ELSE sla_due_at END WHERE organization_id=$1 AND id=$2`,[ctx.organizationId,conversation.id,needsOwner,priority,slaHours]);
 await event(tx,ctx,'message.received',conversation.id,{thread,triage:triage.label,escalated:escalate,authentication:message.authentication},'provider');
 return {duplicate:false,messageId:inserted.id,conversationId:conversation.id,triage:triage.label,thread};
}

// ---------- Dispatch checks plugged into DeliveryGateway (DOTS-094/099/100/102/103/105) ----------
// Reads the message columns directly: the gateway row also carries campaign columns with overlapping names (approved_revision).
async function currentRevision(tx:Client,ctx:Context,messageId:string){return rows(await tx.query('SELECT m.current_revision,m.approved_revision,m.approved_revision_hash,r.content_hash,r.expires_at FROM app.messages m LEFT JOIN app.message_revisions r ON r.organization_id=m.organization_id AND r.message_id=m.id AND r.revision=m.current_revision WHERE m.organization_id=$1 AND m.id=$2',[ctx.organizationId,messageId]))[0];}
export const communicationDispatchChecks:readonly DispatchCheck[]=[
 async({tx,ctx})=>{if(!rows(await tx.query('SELECT 1 FROM app.sender_profiles WHERE organization_id=$1',[ctx.organizationId])).length)return fail('SENDER_PROFILE_REQUIRED',403);},
 async({mailbox,environment,now})=>{
  if(!mailbox.owner_consent_at)return fail('MAILBOX_CONSENT_REQUIRED',403);
  if(mailbox.spf_status!=='pass'||mailbox.dkim_status!=='pass'||mailbox.dmarc_status!=='pass')return fail('SENDER_AUTHENTICATION_INCOMPLETE',403);
  if(mailbox.connection_kind==='oauth'&&!mailbox.token_ref)return fail('MAILBOX_TOKEN_REQUIRED',403);
  if(mailbox.token_expires_at&&new Date(mailbox.token_expires_at).getTime()<=now.getTime())return fail('MAILBOX_TOKEN_EXPIRED',403);
  const maxAge=int(environment.MAILBOX_TOKEN_MAX_AGE_DAYS,90,1,365);if(mailbox.token_ref&&(!mailbox.token_rotated_at||now.getTime()-new Date(mailbox.token_rotated_at).getTime()>maxAge*day))return fail('MAILBOX_TOKEN_ROTATION_REQUIRED',403);
 },
 async({tx,ctx,message,now})=>{
  const revision=await currentRevision(tx,ctx,message.id);if(!revision||revision.current_revision==null)return;
  if(!revision.content_hash||Number(revision.approved_revision)!==Number(revision.current_revision)||revision.approved_revision_hash!==revision.content_hash)return fail('EXACT_APPROVAL_REQUIRED',403);
  if(new Date(revision.expires_at).getTime()<=now.getTime())return fail('DRAFT_EXPIRED',403);
 },
 async({tx,ctx,message})=>{
  if(!message.sequence_step_id)return;
  const step=rows(await tx.query('SELECT s.state,s.enrollment_id FROM app.sequence_steps s WHERE s.organization_id=$1 AND s.id=$2',[ctx.organizationId,message.sequence_step_id]))[0];if(!step)return fail('SEQUENCE_CANCELLED',409);
  const enrollment=rows(await tx.query('SELECT e.state,q.state AS sequence_state FROM app.sequence_enrollments e JOIN app.follow_up_sequences q ON q.id=e.sequence_id AND q.organization_id=e.organization_id WHERE e.organization_id=$1 AND e.id=$2 FOR UPDATE OF e',[ctx.organizationId,step.enrollment_id]))[0];
  const current=rows(await tx.query('SELECT state FROM app.sequence_steps WHERE organization_id=$1 AND id=$2',[ctx.organizationId,message.sequence_step_id]))[0];
  if(!enrollment||enrollment.state!=='active'||enrollment.sequence_state!=='active'||current?.state!=='dispatching')return fail('SEQUENCE_CANCELLED',409);
 },
 async({tx,ctx,message,mailbox,environment})=>{
  const mailboxCap=int(environment.MAILBOX_DAILY_SEND_CAP,50,1,10000),domainCap=int(environment.RECIPIENT_DOMAIN_DAILY_CAP,20,1,10000);
  const sent=rows(await tx.query("SELECT count(*)::int AS n FROM app.messages WHERE organization_id=$1 AND mailbox_id=$2 AND direction='outbound' AND state IN ('sending','sent','delivered','quarantined') AND sent_at>=date_trunc('day',app.utc_now())",[ctx.organizationId,mailbox.id]))[0]!;
  if(Number(sent.n)>=mailboxCap)return fail('MAILBOX_DAILY_CAP_REACHED');
  const domain=String(message.email??'').split('@')[1]??'';const toDomain=rows(await tx.query("SELECT count(*)::int AS n FROM app.messages m JOIN app.conversations c ON c.id=m.conversation_id AND c.organization_id=m.organization_id JOIN app.crm_contacts ct ON ct.id=c.contact_id AND ct.organization_id=c.organization_id WHERE m.organization_id=$1 AND m.direction='outbound' AND m.state IN ('sending','sent','delivered','quarantined') AND m.sent_at>=date_trunc('day',app.utc_now()) AND split_part(ct.email,'@',2)=$2",[ctx.organizationId,domain]))[0]!;
  if(Number(toDomain.n)>=domainCap)return fail('RECIPIENT_DOMAIN_CAP_REACHED');
 },
];
export function communicationsGateway(client:Client,ctx:Context,environment:Env=process.env,transport:typeof fetch=fetch,clock:()=>Date=()=>new Date()){return new DeliveryGateway(client,ctx,environment,transport,clock,{beforeDispatch:communicationDispatchChecks});}

// ---------- Owner workspace ----------
type DraftInput={conversationId:string;mode?:string;replyToMessageId?:string;forwardMessageId?:string;subject?:string;body:string;cc?:unknown;variables?:unknown;sourceEvidence?:unknown;attachmentIds?:unknown;expiresAt?:string;mailboxId?:string;campaignId?:string;authorKind?:'owner'|'model'};
const evidenceKinds=['vetted_fact','message','document','owner_note'] as const;
function renderTemplate(template:string,variables:Record<string,string>):string{const rendered=template.replace(/\{\{\s*([a-z_]{1,40})\s*\}\}/g,(_all,key:string)=>{if(!(key in variables))return fail('UNRESOLVED_VARIABLE',400);return variables[key]!;});if(/\{\{|\}\}/.test(rendered))return fail('UNRESOLVED_VARIABLE',400);return rendered;}
function parseVariables(value:unknown):Record<string,string>{if(value==null)return {};if(typeof value!=='object'||Array.isArray(value))return fail('INVALID_VARIABLES',400);const entries=Object.entries(value as Record<string,unknown>);if(entries.length>30)return fail('INVALID_VARIABLES',400);return Object.fromEntries(entries.map(([key,item])=>{if(!/^[a-z_]{1,40}$/.test(key)||typeof item!=='string'||item.length>500||/[\r\0]/.test(item))return fail('INVALID_VARIABLES',400);return [key,item];}));}
function parseCc(value:unknown):string[]{if(value==null)return [];const items=Array.isArray(value)?value:String(value).split(',');const list=unique(items.map(item=>String(item).trim().toLowerCase()).filter(Boolean));if(list.length>10||list.some(item=>!emailPattern.test(item)))return fail('RECIPIENT_INVALID',400);return list;}
function parseIds(value:unknown):string[]{if(value==null)return [];if(!Array.isArray(value)||value.length>10)return fail('INVALID_ATTACHMENTS',400);return unique(value.map(identifier));}
function revisionHash(content:{subject:string;body:string;to:string[];cc:string[];headers:Record<string,unknown>;attachmentIds:string[];replyMode:string;expiresAt:string}){return digest(content);}

export class CommunicationsWorkspace {
 constructor(private readonly client:Client,private readonly ctx:Context,private readonly environment:Env=process.env,private readonly transport:typeof fetch=fetch,private readonly clock:()=>Date=()=>new Date()){}
 private run<T>(fn:(tx:Client)=>Promise<T>){return tenant(this.client,this.ctx,fn);}
 private now(){return this.clock();}
 gateway(){return communicationsGateway(this.client,this.ctx,this.environment,this.transport,this.clock);}

 // DOTS-094 / DOTS-102: sender profile, mailbox onboarding, consent, authentication and token rotation.
 async setSenderProfile(input:{legalName:unknown;postalAddress:unknown}){const legalName=text(input.legalName,'legal_name',200),postal=text(input.postalAddress,'postal_address',500);if(postal.length<10||!/\d/.test(postal))return fail('POSTAL_ADDRESS_INCOMPLETE',400);
  return this.run(async tx=>{const profile=rows(await tx.query('INSERT INTO app.sender_profiles(organization_id,legal_name,postal_address,updated_by_membership_id) VALUES($1,$2,$3,$4) ON CONFLICT(organization_id) DO UPDATE SET legal_name=$2,postal_address=$3,updated_by_membership_id=$4,version=app.sender_profiles.version+1,updated_at=app.utc_now() RETURNING *',[this.ctx.organizationId,legalName,postal,this.ctx.membershipId]))[0]!;await event(tx,this.ctx,'sender_profile.saved',null,{version:Number(profile.version)});return profile;});}
 async connectMailbox(input:{label:unknown;email:unknown;senderName:unknown;provider:unknown;tokenRef?:unknown;scopes?:unknown}){
  const provider=selection(input.provider,['resend','gmail','microsoft365'],'provider');const email=text(input.email,'email',254).toLowerCase();if(!emailPattern.test(email))return fail('INVALID_EMAIL',400);
  const senderName=text(input.senderName,'sender_name',120);if(/[\r\n\0<>"]/.test(senderName))return fail('SENDER_INVALID',400);const label=text(input.label,'mailbox',120);
  const allowedScopes:Record<string,string[]>={resend:[],gmail:['https://www.googleapis.com/auth/gmail.send','https://www.googleapis.com/auth/gmail.readonly'],microsoft365:['Mail.Send','Mail.Read','offline_access']};
  const scopes=Array.isArray(input.scopes)?unique(input.scopes.map(String)):[];if(scopes.some(scope=>!allowedScopes[provider]!.includes(scope)))return fail('SCOPE_NOT_ALLOWED',400);
  const tokenRef=input.tokenRef==null||input.tokenRef===''?null:String(input.tokenRef);if(tokenRef&&!tokenRefPattern.test(tokenRef))return fail('INVALID_TOKEN_REFERENCE',400);if(provider!=='resend'&&(!tokenRef||!scopes.length))return fail('OAUTH_TOKEN_REFERENCE_REQUIRED',400);
  return this.run(async tx=>{const profile=rows(await tx.query('SELECT postal_address FROM app.sender_profiles WHERE organization_id=$1',[this.ctx.organizationId]))[0];
   const mailbox=rows(await tx.query("INSERT INTO app.mailboxes(organization_id,label,sender_email,sender_name,business_address,provider,verified,status,connection_kind,oauth_scopes,token_ref,token_rotated_at,credential_env_ref) VALUES($1,$2,$3,$4,$5,$6,false,'disabled',$7,$8::text[],$9,CASE WHEN $9::text IS NULL THEN NULL ELSE app.utc_now() END,$10) RETURNING id,label,sender_email,provider,status,connection_kind",[this.ctx.organizationId,label,email,senderName,profile?.postal_address??'Sender profile required before launch',provider,provider==='resend'?'api_key':'oauth',scopes,tokenRef,tokenRef?.startsWith('env:')?tokenRef.slice(4):'EMAIL_DELIVERY_TOKEN']))[0]!;
   if(tokenRef)await tx.query('INSERT INTO app.mailbox_credential_rotations(organization_id,mailbox_id,token_ref,rotated_by_membership_id) VALUES($1,$2,$3,$4)',[this.ctx.organizationId,mailbox.id,tokenRef,this.ctx.membershipId]);
   await event(tx,this.ctx,'mailbox.connected',mailbox.id,{provider,connectionKind:mailbox.connection_kind});return mailbox;});
 }
 async grantMailboxConsent(id:string,consentRef:unknown){identifier(id);const reference=text(consentRef,'consent_reference',200);
  try{return await this.run(async tx=>{
   if(!rows(await tx.query('SELECT 1 FROM app.sender_profiles WHERE organization_id=$1',[this.ctx.organizationId])).length)return fail('SENDER_PROFILE_REQUIRED',403);
   const mailbox=rows(await tx.query('SELECT * FROM app.mailboxes WHERE organization_id=$1 AND id=$2 FOR UPDATE',[this.ctx.organizationId,id]))[0];if(!mailbox)return fail('NOT_FOUND',404);
   if(mailbox.connection_kind==='oauth'&&!mailbox.token_ref)return fail('MAILBOX_TOKEN_REQUIRED',403);
   const ready=mailbox.verified&&mailbox.spf_status==='pass'&&mailbox.dkim_status==='pass'&&mailbox.dmarc_status==='pass';
   const saved=rows(await tx.query("UPDATE app.mailboxes SET owner_consent_at=app.utc_now(),owner_consent_by=$3,owner_consent_ref=$4,business_address=(SELECT legal_name||E'\\n'||postal_address FROM app.sender_profiles WHERE organization_id=$1),status=CASE WHEN $5::boolean AND status='disabled' THEN 'active' ELSE status END,version=version+1 WHERE organization_id=$1 AND id=$2 RETURNING id,status",[this.ctx.organizationId,id,this.ctx.membershipId,reference,ready]))[0]!;
   await event(tx,this.ctx,'mailbox.owner_consented',id,{active:saved.status==='active'});return {id,status:saved.status,waitingFor:ready?[]:['sender_authentication']};});}
  catch(error){if((error as {code?:string})?.code==='23505')return fail('SENDER_ALREADY_CLAIMED',409);throw error;}
 }
 async revokeMailboxConsent(id:string){identifier(id);return this.run(async tx=>{const saved=rows(await tx.query("UPDATE app.mailboxes SET owner_consent_at=NULL,owner_consent_by=NULL,owner_consent_ref=NULL,status='disabled',version=version+1 WHERE organization_id=$1 AND id=$2 RETURNING id",[this.ctx.organizationId,id]));if(!saved.length)return fail('NOT_FOUND',404);await event(tx,this.ctx,'mailbox.consent_revoked',id);return {id,status:'disabled'};});}
 /** Records SPF/DKIM/DMARC from a provider domain-verification response ({records:[{record,status}]}). */
 async recordSenderAuthentication(id:string,response:unknown,source:'provider'|'simulation'='provider'){identifier(id);
  const records=Array.isArray((response as {records?:unknown})?.records)?(response as {records:{record?:unknown;type?:unknown;status?:unknown}[]}).records:fail('INVALID_VERIFICATION_RESPONSE',400);
  const status=(name:string):AuthStatus=>{const found=records.filter(item=>String(item?.record??item?.type??'').toUpperCase()===name);if(!found.length)return 'unknown';if(found.every(item=>['verified','pass'].includes(String(item.status))))return 'pass';if(found.some(item=>['failed','fail','temporary_failure'].includes(String(item.status))))return 'fail';return 'pending';};
  const result={spf:status('SPF'),dkim:status('DKIM'),dmarc:status('DMARC')};
  return this.run(async tx=>{if(!rows(await tx.query('SELECT 1 FROM app.mailboxes WHERE organization_id=$1 AND id=$2 FOR UPDATE',[this.ctx.organizationId,id])).length)return fail('NOT_FOUND',404);
   await tx.query('INSERT INTO app.mailbox_auth_checks(organization_id,mailbox_id,spf_status,dkim_status,dmarc_status,source,evidence_hash) VALUES($1,$2,$3,$4,$5,$6,$7)',[this.ctx.organizationId,id,result.spf,result.dkim,result.dmarc,source,digest(response)]);
   await applyMailboxAuthentication(tx,this.ctx,id,result);await event(tx,this.ctx,'mailbox.authentication_recorded',id,{...result,source});return result;});}
 /** Looks up the published DMARC policy for the sender domain (free DNS lookup; resolver injectable for tests). */
 async checkDmarc(id:string,resolveTxt:(name:string)=>Promise<string[][]>=dns.resolveTxt){identifier(id);
  const mailbox=await this.run(async tx=>rows(await tx.query('SELECT sender_email,spf_status,dkim_status FROM app.mailboxes WHERE organization_id=$1 AND id=$2',[this.ctx.organizationId,id]))[0]);if(!mailbox)return fail('NOT_FOUND',404);
  const domain=String(mailbox.sender_email).split('@')[1]!;let dmarc:AuthStatus='fail';let records:string[]=[];
  try{records=(await resolveTxt(`_dmarc.${domain}`)).map(parts=>parts.join(''));dmarc=records.some(record=>/^v=DMARC1;\s*(.*;\s*)?p=(none|quarantine|reject)\b/i.test(record.trim()))?'pass':'fail';}catch{dmarc='fail';}
  return this.run(async tx=>{await tx.query("INSERT INTO app.mailbox_auth_checks(organization_id,mailbox_id,spf_status,dkim_status,dmarc_status,source,evidence_hash) VALUES($1,$2,$3,$4,$5,'provider',$6)",[this.ctx.organizationId,id,mailbox.spf_status,mailbox.dkim_status,dmarc,digest({domain,records})]);
   await applyMailboxAuthentication(tx,this.ctx,id,{spf:mailbox.spf_status,dkim:mailbox.dkim_status,dmarc});await event(tx,this.ctx,'mailbox.dmarc_checked',id,{dmarc});return {dmarc};});}
 async rotateMailboxToken(id:string,tokenRef:unknown,expiresAt?:unknown){identifier(id);const ref=String(tokenRef??'');if(!tokenRefPattern.test(ref))return fail('INVALID_TOKEN_REFERENCE',400);
  const expiry=expiresAt==null||expiresAt===''?null:new Date(String(expiresAt));if(expiry&&(!Number.isFinite(expiry.getTime())||expiry.getTime()<=this.now().getTime()))return fail('FUTURE_EXPIRY_REQUIRED',400);
  return this.run(async tx=>{const saved=rows(await tx.query('UPDATE app.mailboxes SET token_ref=$3,token_rotated_at=app.utc_now(),token_expires_at=$4,version=version+1 WHERE organization_id=$1 AND id=$2 RETURNING id,token_rotated_at',[this.ctx.organizationId,id,ref,expiry?.toISOString()??null]))[0];if(!saved)return fail('NOT_FOUND',404);
   await tx.query('INSERT INTO app.mailbox_credential_rotations(organization_id,mailbox_id,token_ref,expires_at,rotated_by_membership_id) VALUES($1,$2,$3,$4,$5)',[this.ctx.organizationId,id,ref,expiry?.toISOString()??null,this.ctx.membershipId]);await event(tx,this.ctx,'mailbox.token_rotated',id);return saved;});}

 // DOTS-095: authenticated signed events and bounded polling.
 async ingestSignedEvent(eventId:string,payload:any){
  if(typeof eventId!=='string'||!/^[A-Za-z0-9_.:-]{1,200}$/.test(eventId))return fail('INVALID_EVENT',400);const type=String(payload?.type??'');
  const normalized=type==='message.received'?normalizeInbound(payload?.message??{}):null;
  return this.run(async tx=>{
   await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`mail-event:${this.ctx.organizationId}:${eventId}`]);
   const existing=rows(await tx.query("SELECT payload_hash,processed_at FROM app.provider_receipts WHERE organization_id=$1 AND provider='mail' AND event_id=$2",[this.ctx.organizationId,eventId]))[0];
   if(existing){if(existing.payload_hash!==digest(payload))return fail('RECEIPT_CONFLICT');return {duplicate:true};}
   let outcome:Record<string,unknown>;
   if(normalized)outcome=await importInboundMessage(tx,this.ctx,normalized,this.environment);
   else{const kind=type.startsWith('message.')?type.slice(8):'';if(!['accepted','deferred','delivered','bounced','complained','failed'].includes(kind))return fail('UNSUPPORTED_EVENT',400);
    const providerMessageId=String(payload?.provider_message_id??'');if(!providerIdPattern.test(providerMessageId))return fail('INVALID_RECEIPT',400);const occurred=new Date(String(payload?.occurred_at??''));
    outcome=await recordDeliveryEvent(tx,this.ctx,{providerEventId:`mail:${eventId}`,providerMessageId,kind:kind as DeliveryKind,bounceType:payload?.bounce_type==='soft'?'soft':'hard',occurredAt:Number.isFinite(occurred.getTime())?occurred:this.now(),source:payload?.simulation===true?'simulation':'provider'},this.environment);}
   await tx.query("INSERT INTO app.provider_receipts(organization_id,provider,event_id,payload_hash,processed_at) VALUES($1,'mail',$2,$3,app.utc_now())",[this.ctx.organizationId,eventId,digest(payload)]);return {received:true,...outcome};
  });
 }
 /** Polls a mailbox through an injected provider adapter, bounded by pages, messages and a minimum interval; the cursor advances only after a page is imported. */
 async pollMailbox(id:string,poller:(input:{cursor:string|null;limit:number})=>Promise<{messages:Record<string,any>[];nextCursor:string|null}>,limits:{maxPages?:number;maxMessages?:number;minIntervalSeconds?:number}={}){
  identifier(id);const maxPages=Math.min(10,Math.max(1,limits.maxPages??5)),maxMessages=Math.min(500,Math.max(1,limits.maxMessages??100)),interval=Math.min(86400,Math.max(30,limits.minIntervalSeconds??60));
  const start=await this.run(async tx=>{const mailbox=rows(await tx.query('SELECT id,verified FROM app.mailboxes WHERE organization_id=$1 AND id=$2',[this.ctx.organizationId,id]))[0];if(!mailbox)return fail('NOT_FOUND',404);if(!mailbox.verified)return fail('VERIFIED_MAILBOX_REQUIRED',403);
   await tx.query('INSERT INTO app.mailbox_sync_cursors(organization_id,mailbox_id,next_poll_after) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[this.ctx.organizationId,id,this.now().toISOString()]);
   const cursor=rows(await tx.query('SELECT * FROM app.mailbox_sync_cursors WHERE organization_id=$1 AND mailbox_id=$2 FOR UPDATE',[this.ctx.organizationId,id]))[0]!;if(new Date(cursor.next_poll_after).getTime()>this.now().getTime())return {skipped:true as const,cursor};
   const claimed=rows(await tx.query('UPDATE app.mailbox_sync_cursors SET next_poll_after=$3,version=version+1 WHERE organization_id=$1 AND mailbox_id=$2 RETURNING *',[this.ctx.organizationId,id,new Date(this.now().getTime()+interval*1000).toISOString()]))[0]!;return {skipped:false as const,cursor:claimed};});
  if(start.skipped)return {skipped:'POLL_INTERVAL',imported:0,duplicates:0,rejected:0,pages:0};
  let cursor:string|null=start.cursor.cursor??null,version=Number(start.cursor.version),imported=0,duplicates=0,rejected=0,pages=0;
  while(pages<maxPages&&imported+duplicates+rejected<maxMessages){
   const page=await poller({cursor,limit:Math.min(50,maxMessages-imported-duplicates-rejected)});pages++;if(!page||!Array.isArray(page.messages))return fail('POLL_RESPONSE_INVALID',502);
   const next=page.nextCursor==null?null:String(page.nextCursor);if(next&&(next.length>500||!next.length))return fail('POLL_RESPONSE_INVALID',502);
   const batch=page.messages.slice(0,maxMessages-imported-duplicates-rejected);
   const result=await this.run(async tx=>{let i=0,d=0,r=0;for(const raw of batch){let normalized:InboundMessage;try{normalized=normalizeInbound(raw);}catch{r++;continue;}
     const recipients=[...normalized.to,...normalized.cc];const known=rows(await tx.query('SELECT sender_email FROM app.mailboxes WHERE organization_id=$1 AND id=$2',[this.ctx.organizationId,id]))[0]!;if(!recipients.includes(String(known.sender_email).toLowerCase())){r++;continue;}
     const outcome=await importInboundMessage(tx,this.ctx,normalized,this.environment);if(outcome.duplicate)d++;else if(!outcome.ignored)i++;}
    const saved=rows(await tx.query("UPDATE app.mailbox_sync_cursors SET cursor=$3,last_polled_at=app.utc_now(),imported_total=imported_total+$4,last_result=$5,version=version+1 WHERE organization_id=$1 AND mailbox_id=$2 AND version=$6 RETURNING version",[this.ctx.organizationId,id,next??cursor,i,`imported:${i} duplicates:${d} rejected:${r}`,version]))[0];if(!saved)return fail('POLL_CONFLICT');
    await event(tx,this.ctx,'mailbox.polled',id,{imported:i,duplicates:d,rejected:r},'worker');return {i,d,r,version:Number(saved.version)};});
   imported+=result.i;duplicates+=result.d;rejected+=result.r;version=result.version;if(!next||!page.messages.length)break;cursor=next;
  }
  return {imported,duplicates,rejected,pages};
 }

 // DOTS-098 / DOTS-099: versioned drafts, preview and exact-message approval.
 async composeDraft(input:DraftInput){
  const conversationId=identifier(input.conversationId),mode=selection(input.mode??'new',['new','reply','forward'],'mode'),authorKind=input.authorKind==='model'?'model':'owner';
  const body=text(input.body,'body',50000),cc=parseCc(input.cc),variables=parseVariables(input.variables),attachmentIds=parseIds(input.attachmentIds);
  const evidence=Array.isArray(input.sourceEvidence)?input.sourceEvidence.slice(0,20).map(item=>({kind:selection(item?.kind,evidenceKinds,'evidence_kind'),ref:identifier(item?.ref),label:typeof item?.label==='string'?item.label.slice(0,200):undefined})):input.sourceEvidence==null?[]:fail('INVALID_EVIDENCE',400);
  const expires=input.expiresAt?new Date(input.expiresAt):new Date(this.now().getTime()+7*day);if(!Number.isFinite(expires.getTime())||expires.getTime()<=this.now().getTime()||expires.getTime()>this.now().getTime()+30*day)return fail('INVALID_EXPIRY',400);
  return this.run(async tx=>{
   const conversation=rows(await tx.query('SELECT c.*,ct.email,ct.display_name,ct.status AS contact_status FROM app.conversations c JOIN app.crm_contacts ct ON ct.id=c.contact_id AND ct.organization_id=c.organization_id WHERE c.organization_id=$1 AND c.id=$2',[this.ctx.organizationId,conversationId]))[0];if(!conversation)return fail('NOT_FOUND',404);
   if(!conversation.email||conversation.contact_status==='redacted')return fail('CONTACT_NOT_ELIGIBLE',403);
   if(rows(await tx.query('SELECT 1 FROM app.contact_suppressions WHERE organization_id=$1 AND email_hash=ANY($2::text[])',[this.ctx.organizationId,[digest(String(conversation.email).toLowerCase()),...cc.map(item=>digest(item))]])).length)return fail('CONTACT_SUPPRESSED',403);
   const mailbox=input.mailboxId?rows(await tx.query('SELECT * FROM app.mailboxes WHERE organization_id=$1 AND id=$2',[this.ctx.organizationId,identifier(input.mailboxId)]))[0]:rows(await tx.query("SELECT * FROM app.mailboxes WHERE organization_id=$1 ORDER BY (status='active') DESC,(owner_consent_at IS NOT NULL) DESC,created_at LIMIT 1",[this.ctx.organizationId]))[0];if(!mailbox)return fail('MAILBOX_REQUIRED',409);
   for(const ref of evidence){const table=ref.kind==='vetted_fact'?'vetted_product_facts':ref.kind==='message'?'messages':ref.kind==='document'?'document_library':null;if(table&&!rows(await tx.query(`SELECT 1 FROM app.${table} WHERE organization_id=$1 AND id=$2`,[this.ctx.organizationId,ref.ref])).length)return fail('EVIDENCE_NOT_FOUND',400);}
   if(attachmentIds.length&&rows(await tx.query("SELECT id FROM app.message_attachments WHERE organization_id=$1 AND id=ANY($2::uuid[]) AND scan_state='clean'",[this.ctx.organizationId,attachmentIds])).length!==attachmentIds.length)return fail('ATTACHMENT_NOT_CLEAN',403);
   let inReplyTo:string|null=null,references:string[]=[],subject:string,quoted='';
   if(mode==='reply'){const target=rows(await tx.query("SELECT * FROM app.messages WHERE organization_id=$1 AND id=$2 AND conversation_id=$3 AND state NOT IN ('quarantined','redacted')",[this.ctx.organizationId,identifier(input.replyToMessageId),conversationId]))[0];if(!target)return fail('REPLY_TARGET_REQUIRED',400);
    inReplyTo=target.message_id_header??null;references=unique([...(target.references_headers??[]),...(target.message_id_header?[target.message_id_header]:[])]).slice(-20);subject=input.subject?text(input.subject,'subject',240):`Re: ${normalizeSubject(target.subject)===''?conversation.subject:String(target.subject).replace(/^\s*(re|fwd?|fw)\s*:\s*/i,'')}`.slice(0,240);}
   else if(mode==='forward'){const target=rows(await tx.query("SELECT * FROM app.messages WHERE organization_id=$1 AND id=$2 AND state NOT IN ('quarantined','redacted')",[this.ctx.organizationId,identifier(input.forwardMessageId)]))[0];if(!target)return fail('FORWARD_SOURCE_REQUIRED',400);
    subject=input.subject?text(input.subject,'subject',240):`Fwd: ${target.subject}`.slice(0,240);quoted=`\n\n---------- Forwarded message ----------\nSubject: ${target.subject}\n\n${target.body}`;}
   else subject=text(input.subject,'subject',240);
   const allVariables={contact_name:String(conversation.display_name),...variables};const renderedSubject=renderTemplate(subject,allVariables).replace(/[\r\n]+/g,' ').slice(0,240),renderedBody=`${renderTemplate(body,allVariables)}${quoted}`.slice(0,50000);
   const messageId=randomUUID(),headerId=`dots.${messageId}@${String(mailbox.sender_email).split('@')[1]}`;const headers={messageId:headerId,inReplyTo,references};
   const campaignId=input.campaignId?identifier(input.campaignId):conversation.campaign_id??null;
   const message=rows(await tx.query(`INSERT INTO app.messages(id,organization_id,conversation_id,campaign_id,mailbox_id,direction,subject,body,state,source,content_hash,message_id_header,in_reply_to_header,references_headers,from_address,to_addresses,cc_addresses,reply_mode,ai_generated,current_revision,draft_expires_at,attachment_ids)
    VALUES($1,$2,$3,$4,$5,'outbound',$6,$7,'draft',$8,$9,$10,$11,$12::text[],$13,$14::text[],$15::text[],$16,$17,1,$18,$19::uuid[]) RETURNING *`,[messageId,this.ctx.organizationId,conversationId,campaignId,mailbox.id,renderedSubject,renderedBody,authorKind==='model'?'model':'owner',digest({subject:renderedSubject,body:renderedBody}),headerId,inReplyTo,references,mailbox.sender_email,[conversation.email],cc,mode,authorKind==='model',expires.toISOString(),attachmentIds]))[0]!;
   const hash=revisionHash({subject:renderedSubject,body:renderedBody,to:[conversation.email],cc,headers,attachmentIds,replyMode:mode,expiresAt:expires.toISOString()});
   await tx.query('INSERT INTO app.message_revisions(organization_id,message_id,revision,subject,body,to_addresses,cc_addresses,headers,variables,source_evidence,attachment_ids,reply_mode,author_kind,ai_generated,expires_at,content_hash,created_by_membership_id) VALUES($1,$2,1,$3,$4,$5::text[],$6::text[],$7::jsonb,$8::jsonb,$9::jsonb,$10::uuid[],$11,$12,$13,$14,$15,$16)',[this.ctx.organizationId,messageId,renderedSubject,renderedBody,[conversation.email],cc,JSON.stringify(headers),JSON.stringify(variables),JSON.stringify(evidence),attachmentIds,mode,authorKind,authorKind==='model',expires.toISOString(),hash,this.ctx.membershipId]);
   await tx.query('UPDATE app.conversations SET updated_at=app.utc_now() WHERE organization_id=$1 AND id=$2',[this.ctx.organizationId,conversationId]);
   await event(tx,this.ctx,'message.drafted',messageId,{revision:1,mode,authorKind,aiGenerated:authorKind==='model'});return {...message,revision:1,revisionHash:hash};
  });
 }
 /** Saves an optional model suggestion strictly as an AI-labelled draft; it never approves or sends anything. */
 async saveModelSuggestion(conversationId:string,replyToMessageId:string,body:unknown,modelRef:unknown){const ref=text(modelRef,'model_reference',120);return this.composeDraft({conversationId,mode:'reply',replyToMessageId,body:text(body,'body',20000),authorKind:'model',sourceEvidence:[{kind:'message',ref:replyToMessageId,label:`Suggested by ${ref}; not verified fact`}]});}
 async reviseDraft(messageId:string,expectedRevision:number,changes:{subject?:unknown;body?:unknown;cc?:unknown;attachmentIds?:unknown;expiresAt?:unknown;sourceEvidence?:unknown}){
  identifier(messageId);if(!Number.isSafeInteger(expectedRevision)||expectedRevision<1)return fail('INVALID_REVISION',400);
  return this.run(async tx=>{
   const message=rows(await tx.query('SELECT * FROM app.messages WHERE organization_id=$1 AND id=$2 FOR UPDATE',[this.ctx.organizationId,messageId]))[0];if(!message||message.direction!=='outbound')return fail('NOT_FOUND',404);
   if(!['draft','pending_approval','approved','failed'].includes(message.state))return fail('MESSAGE_ALREADY_DISPATCHED');if(Number(message.current_revision)!==expectedRevision)return fail('STALE_REVISION');
   const previous=rows(await tx.query('SELECT * FROM app.message_revisions WHERE organization_id=$1 AND message_id=$2 AND revision=$3',[this.ctx.organizationId,messageId,expectedRevision]))[0];if(!previous)return fail('REVISION_NOT_FOUND',404);
   const subject=changes.subject===undefined?previous.subject:text(changes.subject,'subject',240).replace(/[\r\n]+/g,' '),body=changes.body===undefined?previous.body:text(changes.body,'body',50000);
   const cc=changes.cc===undefined?previous.cc_addresses:parseCc(changes.cc),attachmentIds=changes.attachmentIds===undefined?previous.attachment_ids:parseIds(changes.attachmentIds);
   const expires=changes.expiresAt===undefined||changes.expiresAt===''?new Date(previous.expires_at):new Date(String(changes.expiresAt));if(!Number.isFinite(expires.getTime())||expires.getTime()<=this.now().getTime()||expires.getTime()>this.now().getTime()+30*day)return fail('INVALID_EXPIRY',400);
   if(cc.length&&rows(await tx.query('SELECT 1 FROM app.contact_suppressions WHERE organization_id=$1 AND email_hash=ANY($2::text[])',[this.ctx.organizationId,cc.map((item:string)=>digest(item))])).length)return fail('CONTACT_SUPPRESSED',403);
   if(attachmentIds.length&&rows(await tx.query("SELECT id FROM app.message_attachments WHERE organization_id=$1 AND id=ANY($2::uuid[]) AND scan_state='clean'",[this.ctx.organizationId,attachmentIds])).length!==attachmentIds.length)return fail('ATTACHMENT_NOT_CLEAN',403);
   const revision=expectedRevision+1,headers=previous.headers;const hash=revisionHash({subject,body,to:previous.to_addresses,cc,headers,attachmentIds,replyMode:previous.reply_mode,expiresAt:expires.toISOString()});
   // An owner edit of AI-drafted text stays labelled as AI-originated; editing never converts it into verified fact.
   await tx.query('INSERT INTO app.message_revisions(organization_id,message_id,revision,subject,body,to_addresses,cc_addresses,headers,variables,source_evidence,attachment_ids,reply_mode,author_kind,ai_generated,expires_at,content_hash,created_by_membership_id) VALUES($1,$2,$3,$4,$5,$6::text[],$7::text[],$8::jsonb,$9::jsonb,$10::jsonb,$11::uuid[],$12,$13,$14,$15,$16,$17)',[this.ctx.organizationId,messageId,revision,subject,body,previous.to_addresses,cc,JSON.stringify(headers),JSON.stringify(previous.variables),JSON.stringify(changes.sourceEvidence===undefined?previous.source_evidence:changes.sourceEvidence),attachmentIds,previous.reply_mode,'owner',Boolean(previous.ai_generated),expires.toISOString(),hash,this.ctx.membershipId]);
   const invalidated=message.approval_id?rows(await tx.query("UPDATE app.action_approvals SET status='expired' WHERE organization_id=$1 AND id=$2 AND status IN ('pending','approved') RETURNING id",[this.ctx.organizationId,message.approval_id])).length>0:false;
   await tx.query("UPDATE app.messages SET subject=$3,body=$4,content_hash=$5,cc_addresses=$6::text[],attachment_ids=$7::uuid[],current_revision=$8,draft_expires_at=$9,state='draft',approval_id=NULL,fact_snapshot_hash=NULL,approved_campaign_revision=NULL,approved_revision=NULL,approved_revision_hash=NULL,version=version+1 WHERE organization_id=$1 AND id=$2",[this.ctx.organizationId,messageId,subject,body,digest({subject,body}),cc,attachmentIds,revision,expires.toISOString()]);
   await event(tx,this.ctx,'message.revised',messageId,{revision,approvalInvalidated:invalidated||Boolean(message.approval_id)});return {messageId,revision,revisionHash:hash,approvalInvalidated:invalidated||Boolean(message.approval_id)};
  });
 }
 /** Plain-text preview of exactly what would be sent, including headers, recipients, footer and AI labelling. */
 async preview(messageId:string){identifier(messageId);return this.run(async tx=>{
  const message=rows(await tx.query('SELECT * FROM app.messages WHERE organization_id=$1 AND id=$2',[this.ctx.organizationId,messageId]))[0];if(!message||message.direction!=='outbound')return fail('NOT_FOUND',404);
  const revision=message.current_revision?rows(await tx.query('SELECT * FROM app.message_revisions WHERE organization_id=$1 AND message_id=$2 AND revision=$3',[this.ctx.organizationId,messageId,message.current_revision]))[0]:null;
  const profile=rows(await tx.query('SELECT legal_name,postal_address FROM app.sender_profiles WHERE organization_id=$1',[this.ctx.organizationId]))[0];const mailbox=message.mailbox_id?rows(await tx.query('SELECT sender_name,sender_email,status,owner_consent_at FROM app.mailboxes WHERE organization_id=$1 AND id=$2',[this.ctx.organizationId,message.mailbox_id]))[0]:null;
  const attachments=(message.attachment_ids??[]).length?rows(await tx.query('SELECT id,filename,sniffed_type,size_bytes,scan_state FROM app.message_attachments WHERE organization_id=$1 AND id=ANY($2::uuid[])',[this.ctx.organizationId,message.attachment_ids])):[];
  const footer=profile?`${profile.legal_name}\n${profile.postal_address}`:'[Sender postal address missing: sending is blocked until the sender profile is saved]';
  return {messageId,revision:message.current_revision??null,revisionHash:revision?.content_hash??null,state:message.state,from:mailbox?`${mailbox.sender_name} <${mailbox.sender_email}>`:null,to:message.to_addresses?.length?message.to_addresses:[],cc:message.cc_addresses??[],subject:message.subject,
   headers:{'Message-ID':message.message_id_header?`<${message.message_id_header}>`:null,'In-Reply-To':message.in_reply_to_header?`<${message.in_reply_to_header}>`:null,References:(message.references_headers??[]).map((item:string)=>`<${item}>`).join(' ')||null,'List-Unsubscribe':'<one-click unsubscribe URL generated at dispatch>','List-Unsubscribe-Post':'List-Unsubscribe=One-Click'},
   plainText:`${message.body}\n\n${footer}\nUnsubscribe: <personal unsubscribe link generated at dispatch>`,attachments,aiGenerated:Boolean(message.ai_generated),authorKind:revision?.author_kind??message.source,
   provenance:message.ai_generated?'AI-drafted text. It is not verified fact; only linked vetted facts are verified.':'Owner-written text.',sourceEvidence:revision?.source_evidence??[],expiresAt:revision?.expires_at??message.draft_expires_at??null,approved:Boolean(message.approval_id)&&Number(message.approved_revision)===Number(message.current_revision)};
 });}
 /** Owner approves the exact revision they previewed. A later edit creates a new revision and invalidates this approval. */
 async approveExact(messageId:string,revisionHash:unknown){identifier(messageId);const expected=text(revisionHash,'revision_hash',64);
  const current=await this.run(async tx=>rows(await tx.query('SELECT m.current_revision,m.state,r.content_hash,r.expires_at FROM app.messages m JOIN app.message_revisions r ON r.message_id=m.id AND r.organization_id=m.organization_id AND r.revision=m.current_revision WHERE m.organization_id=$1 AND m.id=$2',[this.ctx.organizationId,messageId]))[0]);
  if(!current)return fail('NOT_FOUND',404);if(current.content_hash!==expected)return fail('STALE_PREVIEW');if(new Date(current.expires_at).getTime()<=this.now().getTime())return fail('DRAFT_EXPIRED',403);
  const approval=await new SalesWorkspace(this.client,this.ctx).messageApproval(messageId);await new ControlPlane(this.client,this.ctx).decideApproval(approval.id,true);
  return this.run(async tx=>{const saved=rows(await tx.query("UPDATE app.messages SET approved_revision=$3,approved_revision_hash=$4,version=version+1 WHERE organization_id=$1 AND id=$2 AND current_revision=$3 AND approval_id=$5 RETURNING id",[this.ctx.organizationId,messageId,current.current_revision,expected,approval.id]));
   if(!saved.length){await tx.query("UPDATE app.action_approvals SET status='expired' WHERE organization_id=$1 AND id=$2 AND status='approved'",[this.ctx.organizationId,approval.id]);return fail('STALE_PREVIEW');}
   await event(tx,this.ctx,'message.exact_approved',messageId,{revision:Number(current.current_revision),revisionHash:expected});return {messageId,approvalId:approval.id,revision:Number(current.current_revision)};});
 }
 /** Owner-initiated send through the hardened gateway (all built-in gates plus communicationDispatchChecks). */
 async send(messageId:string){return this.gateway().send(identifier(messageId),{actor:'owner'});}

 // DOTS-106: human takeover, delegation and SLA.
 async claimThread(id:string){identifier(id);return this.run(async tx=>{const saved=rows(await tx.query('UPDATE app.conversations SET human_takeover=true,claimed_by_membership_id=$3,claimed_at=app.utc_now(),agent_delegated=false,updated_at=app.utc_now() WHERE organization_id=$1 AND id=$2 AND (claimed_by_membership_id IS NULL OR claimed_by_membership_id=$3) RETURNING id',[this.ctx.organizationId,id,this.ctx.membershipId]));if(!saved.length)return fail('THREAD_ALREADY_CLAIMED');
  const paused=rows(await tx.query("UPDATE app.sequence_enrollments SET state='paused',state_reason='owner_takeover',version=version+1,updated_at=app.utc_now() WHERE organization_id=$1 AND conversation_id=$2 AND state='active' RETURNING id",[this.ctx.organizationId,id])).length;
  await event(tx,this.ctx,'conversation.takeover',id,{pausedEnrollments:paused});return {id,claimed:true,pausedEnrollments:paused};});}
 async releaseThread(id:string){identifier(id);return this.run(async tx=>{const saved=rows(await tx.query('UPDATE app.conversations SET human_takeover=false,claimed_by_membership_id=NULL,claimed_at=NULL,agent_delegated=false,updated_at=app.utc_now() WHERE organization_id=$1 AND id=$2 AND claimed_by_membership_id=$3 RETURNING id',[this.ctx.organizationId,id,this.ctx.membershipId]));if(!saved.length)return fail('THREAD_NOT_CLAIMED_BY_OWNER');
  const resumed=rows(await tx.query("UPDATE app.sequence_enrollments SET state='active',state_reason=NULL,version=version+1,updated_at=app.utc_now() WHERE organization_id=$1 AND conversation_id=$2 AND state='paused' AND state_reason='owner_takeover' RETURNING id",[this.ctx.organizationId,id])).length;
  await event(tx,this.ctx,'conversation.released',id,{resumedEnrollments:resumed});return {id,claimed:false,resumedEnrollments:resumed};});}
 async delegateThread(id:string,enabled:boolean){identifier(id);return this.run(async tx=>{const saved=rows(await tx.query('UPDATE app.conversations SET agent_delegated=$4,updated_at=app.utc_now() WHERE organization_id=$1 AND id=$2 AND claimed_by_membership_id=$3 AND human_takeover RETURNING id',[this.ctx.organizationId,id,this.ctx.membershipId,enabled===true]));if(!saved.length)return fail('THREAD_NOT_CLAIMED_BY_OWNER');await event(tx,this.ctx,enabled?'conversation.delegated':'conversation.delegation_revoked',id);return {id,delegated:enabled===true};});}
 async setPriority(id:string,priority:unknown,slaHours?:unknown){identifier(id);const level=Number(priority);if(!Number.isSafeInteger(level)||level<0||level>3)return fail('INVALID_PRIORITY',400);const hours=slaHours==null||slaHours===''?null:Number(slaHours);if(hours!==null&&(!Number.isSafeInteger(hours)||hours<1||hours>720))return fail('INVALID_SLA',400);
  return this.run(async tx=>{const saved=rows(await tx.query('UPDATE app.conversations SET priority=$3,sla_due_at=CASE WHEN $4::int IS NULL THEN sla_due_at ELSE app.utc_now()+make_interval(hours=>$4::int) END,needs_owner=CASE WHEN $4::int IS NULL THEN needs_owner ELSE true END WHERE organization_id=$1 AND id=$2 RETURNING id,priority,sla_due_at',[this.ctx.organizationId,id,level,hours]))[0];if(!saved)return fail('NOT_FOUND',404);await event(tx,this.ctx,'conversation.prioritized',id,{priority:level,slaHours:hours});return saved;});}
 async markHandled(id:string){identifier(id);return this.run(async tx=>{const saved=rows(await tx.query('UPDATE app.conversations SET needs_owner=false,sla_due_at=NULL WHERE organization_id=$1 AND id=$2 RETURNING id',[this.ctx.organizationId,id]));if(!saved.length)return fail('NOT_FOUND',404);await event(tx,this.ctx,'conversation.handled',id);return {id};});}

 // DOTS-105: follow-up sequences.
 async createSequence(input:{campaignId:unknown;label:unknown;subjectTemplate:unknown;bodyTemplate:unknown;maxTouches:unknown;intervalDays:unknown;quietStartHour?:unknown;quietEndHour?:unknown;timezone?:unknown}){
  const campaignId=identifier(input.campaignId),label=text(input.label,'sequence',160),subject=text(input.subjectTemplate,'subject',240),body=text(input.bodyTemplate,'body',20000);
  const whole=(value:unknown,min:number,max:number,name:string,fallback?:number)=>{const parsed=value==null&&fallback!==undefined?fallback:Number(value);if(!Number.isSafeInteger(parsed)||parsed<min||parsed>max)return fail(`INVALID_${name}`,400);return parsed;};
  const maxTouches=whole(input.maxTouches,1,10,'MAX_TOUCHES'),interval=whole(input.intervalDays,1,90,'INTERVAL'),quietStart=whole(input.quietStartHour,0,23,'QUIET_HOURS',18),quietEnd=whole(input.quietEndHour,0,23,'QUIET_HOURS',9),timezone=validTimezone(input.timezone);
  renderTemplate(subject,{contact_name:'x'});renderTemplate(body,{contact_name:'x'});
  return this.run(async tx=>{if(!rows(await tx.query('SELECT 1 FROM app.campaigns WHERE organization_id=$1 AND id=$2',[this.ctx.organizationId,campaignId])).length)return fail('NOT_FOUND',404);
   const sequence=rows(await tx.query('INSERT INTO app.follow_up_sequences(organization_id,campaign_id,label,subject_template,body_template,max_touches,interval_days,quiet_start_hour,quiet_end_hour,timezone) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',[this.ctx.organizationId,campaignId,label,subject,body,maxTouches,interval,quietStart,quietEnd,timezone]))[0]!;await event(tx,this.ctx,'sequence.created',sequence.id,{maxTouches,intervalDays:interval});return sequence;});
 }
 async setSequenceState(id:string,state:unknown){identifier(id);const next=selection(state,['active','paused','archived'],'sequence_state');return this.run(async tx=>{const saved=rows(await tx.query('UPDATE app.follow_up_sequences SET state=$3,version=version+1 WHERE organization_id=$1 AND id=$2 RETURNING id,state',[this.ctx.organizationId,id,next]))[0];if(!saved)return fail('NOT_FOUND',404);await event(tx,this.ctx,'sequence.state_changed',id,{state:next});return saved;});}
 async enroll(sequenceId:string,contactId:string){identifier(sequenceId);identifier(contactId);return this.run(async tx=>{
  const sequence=rows(await tx.query('SELECT * FROM app.follow_up_sequences WHERE organization_id=$1 AND id=$2',[this.ctx.organizationId,sequenceId]))[0];if(!sequence)return fail('NOT_FOUND',404);if(sequence.state!=='active')return fail('SEQUENCE_NOT_ACTIVE');
  const contact=rows(await tx.query('SELECT c.*,EXISTS(SELECT 1 FROM app.contact_suppressions s WHERE s.organization_id=c.organization_id AND s.email_hash=c.email_hash) AS suppressed FROM app.crm_contacts c WHERE c.organization_id=$1 AND c.id=$2',[this.ctx.organizationId,contactId]))[0];if(!contact)return fail('NOT_FOUND',404);
  if(contact.status!=='active'||contact.suppressed||contact.consent==='opted_out')return fail('CONTACT_NOT_ELIGIBLE',403);
  if(!rows(await tx.query('SELECT 1 FROM app.campaign_audience WHERE organization_id=$1 AND campaign_id=$2 AND contact_id=$3',[this.ctx.organizationId,sequence.campaign_id,contactId])).length)return fail('CONTACT_NOT_IN_AUDIENCE',403);
  const campaign=rows(await tx.query('SELECT label,project_id FROM app.campaigns WHERE organization_id=$1 AND id=$2',[this.ctx.organizationId,sequence.campaign_id]))[0]!;
  const conversation=rows(await tx.query("SELECT id FROM app.conversations WHERE organization_id=$1 AND contact_id=$2 AND campaign_id=$3 AND state<>'closed' ORDER BY updated_at DESC LIMIT 1",[this.ctx.organizationId,contactId,sequence.campaign_id]))[0]??rows(await tx.query('INSERT INTO app.conversations(organization_id,contact_id,project_id,campaign_id,subject,normalized_subject) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',[this.ctx.organizationId,contactId,campaign.project_id,sequence.campaign_id,String(campaign.label).slice(0,240),normalizeSubject(campaign.label)]))[0]!;
  const enrollment=rows(await tx.query('INSERT INTO app.sequence_enrollments(organization_id,sequence_id,contact_id,conversation_id) VALUES($1,$2,$3,$4) ON CONFLICT(organization_id,sequence_id,contact_id) DO NOTHING RETURNING *',[this.ctx.organizationId,sequenceId,contactId,conversation.id]))[0];if(!enrollment)return fail('ALREADY_ENROLLED');
  const due=nextAllowedSendTime(this.now(),sequence.quiet_start_hour,sequence.quiet_end_hour,sequence.timezone);
  await tx.query('INSERT INTO app.sequence_steps(organization_id,enrollment_id,touch_number,due_at) VALUES($1,$2,1,$3)',[this.ctx.organizationId,enrollment.id,due.toISOString()]);
  await event(tx,this.ctx,'sequence.enrolled',enrollment.id);return {...enrollment,firstDueAt:due.toISOString()};});}
 /** Turns due steps into owner-approvable drafts. Locks enrollment then step (same order as cancellation) and re-checks every stop condition. Drafts still require exact owner approval before dispatch. */
 async claimDueSteps(limit=10){const now=this.now();const candidates=await this.run(async tx=>rows(await tx.query("SELECT id,enrollment_id FROM app.sequence_steps WHERE organization_id=$1 AND state='scheduled' AND due_at<=$2 ORDER BY due_at LIMIT $3",[this.ctx.organizationId,now.toISOString(),Math.min(50,Math.max(1,limit))])));
  const results:Row[]=[];
  for(const candidate of candidates)results.push(await this.run(async tx=>{
   const enrollment=rows(await tx.query('SELECT e.*,q.state AS sequence_state,q.max_touches,q.interval_days,q.quiet_start_hour,q.quiet_end_hour,q.timezone,q.subject_template,q.body_template,q.campaign_id FROM app.sequence_enrollments e JOIN app.follow_up_sequences q ON q.id=e.sequence_id AND q.organization_id=e.organization_id WHERE e.organization_id=$1 AND e.id=$2 FOR UPDATE OF e',[this.ctx.organizationId,candidate.enrollment_id]))[0];
   const step=rows(await tx.query("SELECT * FROM app.sequence_steps WHERE organization_id=$1 AND id=$2 AND state='scheduled' FOR UPDATE SKIP LOCKED",[this.ctx.organizationId,candidate.id]))[0];
   if(!enrollment||!step)return {stepId:candidate.id,outcome:'skipped'};
   const skip=async(reason:string,cancelEnrollment=false)=>{if(cancelEnrollment){await cancelEnrollmentTx(tx,this.ctx,enrollment.id,reason);}else await tx.query("UPDATE app.sequence_steps SET state='skipped',state_reason=$3,updated_at=app.utc_now() WHERE organization_id=$1 AND id=$2",[this.ctx.organizationId,step.id,reason]);return {stepId:step.id,outcome:reason};};
   if(enrollment.state!=='active')return {stepId:step.id,outcome:`enrollment_${enrollment.state}`};
   if(enrollment.sequence_state!=='active')return {stepId:step.id,outcome:'sequence_paused'};
   const context=rows(await tx.query(`SELECT ct.display_name,ct.status,ct.consent,ct.email,EXISTS(SELECT 1 FROM app.contact_suppressions s WHERE s.organization_id=ct.organization_id AND s.email_hash=ct.email_hash) AS suppressed,ca.state AS campaign_state,cv.human_takeover,cv.agent_delegated,
     EXISTS(SELECT 1 FROM app.messages m WHERE m.organization_id=cv.organization_id AND m.conversation_id=cv.id AND m.direction='inbound' AND m.created_at>=$3) AS replied
     FROM app.crm_contacts ct JOIN app.conversations cv ON cv.contact_id=ct.id AND cv.organization_id=ct.organization_id JOIN app.campaigns ca ON ca.id=$4 AND ca.organization_id=ct.organization_id WHERE ct.organization_id=$1 AND cv.id=$2`,[this.ctx.organizationId,enrollment.conversation_id,enrollment.created_at,enrollment.campaign_id]))[0]!;
   if(context.suppressed||context.status!=='active'||context.consent==='opted_out')return skip('suppressed',true);
   if(context.replied)return skip('replied',true);
   if(context.campaign_state!=='active')return {stepId:step.id,outcome:'campaign_not_active'};
   if(context.human_takeover&&!context.agent_delegated)return {stepId:step.id,outcome:'owner_controls_conversation'};
   if(inQuietHours(now,enrollment.quiet_start_hour,enrollment.quiet_end_hour,enrollment.timezone)){const next=nextAllowedSendTime(now,enrollment.quiet_start_hour,enrollment.quiet_end_hour,enrollment.timezone);await tx.query('UPDATE app.sequence_steps SET due_at=$3,updated_at=app.utc_now() WHERE organization_id=$1 AND id=$2',[this.ctx.organizationId,step.id,next.toISOString()]);return {stepId:step.id,outcome:'quiet_hours',nextDueAt:next.toISOString()};}
   const used=rows(await tx.query("SELECT count(*)::int AS n FROM app.sequence_steps WHERE organization_id=$1 AND enrollment_id=$2 AND state IN ('dispatching','sent')",[this.ctx.organizationId,enrollment.id]))[0]!;if(Number(used.n)>=Number(enrollment.max_touches)||step.touch_number>enrollment.max_touches)return skip('max_touches');
   const mailbox=rows(await tx.query("SELECT id,sender_email FROM app.mailboxes WHERE organization_id=$1 ORDER BY (status='active') DESC,created_at LIMIT 1",[this.ctx.organizationId]))[0];if(!mailbox)return {stepId:step.id,outcome:'mailbox_required'};
   const variables={contact_name:String(context.display_name)};const subject=renderTemplate(enrollment.subject_template,variables).slice(0,240),body=renderTemplate(enrollment.body_template,variables);
   const prior=rows(await tx.query("SELECT message_id_header,references_headers FROM app.messages WHERE organization_id=$1 AND conversation_id=$2 AND message_id_header IS NOT NULL AND state NOT IN ('quarantined','redacted','cancelled') ORDER BY created_at DESC LIMIT 1",[this.ctx.organizationId,enrollment.conversation_id]))[0];
   const references=prior?unique([...(prior.references_headers??[]),prior.message_id_header]).slice(-20):[];const messageId=randomUUID(),headerId=`dots.${messageId}@${String(mailbox.sender_email).split('@')[1]}`;const expires=new Date(now.getTime()+3*day);const headers={messageId:headerId,inReplyTo:prior?.message_id_header??null,references};
   await tx.query(`INSERT INTO app.messages(id,organization_id,conversation_id,campaign_id,mailbox_id,direction,subject,body,state,source,content_hash,message_id_header,in_reply_to_header,references_headers,from_address,to_addresses,reply_mode,current_revision,draft_expires_at,sequence_step_id)
    VALUES($1,$2,$3,$4,$5,'outbound',$6,$7,'draft','owner',$8,$9,$10,$11::text[],$12,$13::text[],$14,1,$15,$16)`,[messageId,this.ctx.organizationId,enrollment.conversation_id,enrollment.campaign_id,mailbox.id,subject,body,digest({subject,body}),headerId,headers.inReplyTo,references,mailbox.sender_email,[context.email],prior?'reply':'new',expires.toISOString(),step.id]);
   const hash=revisionHash({subject,body,to:[context.email],cc:[],headers,attachmentIds:[],replyMode:prior?'reply':'new',expiresAt:expires.toISOString()});
   await tx.query("INSERT INTO app.message_revisions(organization_id,message_id,revision,subject,body,to_addresses,headers,variables,source_evidence,reply_mode,author_kind,ai_generated,expires_at,content_hash,created_by_membership_id) VALUES($1,$2,1,$3,$4,$5::text[],$6::jsonb,$7::jsonb,'[]'::jsonb,$8,'owner',false,$9,$10,$11)",[this.ctx.organizationId,messageId,subject,body,[context.email],JSON.stringify(headers),JSON.stringify(variables),prior?'reply':'new',expires.toISOString(),hash,this.ctx.membershipId]);
   await tx.query("UPDATE app.sequence_steps SET state='dispatching',message_id=$3,updated_at=app.utc_now() WHERE organization_id=$1 AND id=$2",[this.ctx.organizationId,step.id,messageId]);
   if(step.touch_number<enrollment.max_touches){const next=nextAllowedSendTime(new Date(new Date(step.due_at).getTime()+Number(enrollment.interval_days)*day),enrollment.quiet_start_hour,enrollment.quiet_end_hour,enrollment.timezone);await tx.query('INSERT INTO app.sequence_steps(organization_id,enrollment_id,touch_number,due_at) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[this.ctx.organizationId,enrollment.id,step.touch_number+1,next.toISOString()]);}
   else await tx.query("UPDATE app.sequence_enrollments SET state_reason='final_touch_drafted',updated_at=app.utc_now() WHERE organization_id=$1 AND id=$2",[this.ctx.organizationId,enrollment.id]);
   await event(tx,this.ctx,'sequence.step_drafted',step.id,{touch:step.touch_number},'worker');return {stepId:step.id,outcome:'drafted',messageId,revisionHash:hash};
  }));
  return results;
 }
 async cancelEnrollment(id:string,reason:unknown='owner_cancelled'){identifier(id);const code=typeof reason==='string'&&/^[a-z_]{1,60}$/.test(reason)?reason:'owner_cancelled';return this.run(tx=>cancelEnrollmentTx(tx,this.ctx,id,code));}

 // DOTS-102: opt-out.
 async processOptOut(contactId:string,channel:OptOutChannel,evidence:Record<string,unknown>={}){identifier(contactId);selection(channel,['one_click','link','reply_keyword','owner','complaint','bounce'],'channel');return this.run(tx=>processOptOutTx(tx,this.ctx,contactId,channel,evidence,channel==='owner'?'human':'provider'));}

 // DOTS-107: attachments.
 async uploadAttachment(input:{conversationId?:unknown;filename:unknown;declaredType:unknown;base64:unknown}){
  const conversationId=input.conversationId?identifier(input.conversationId):null;if(typeof input.base64!=='string'||!/^[A-Za-z0-9+/=\s]*$/.test(input.base64))return fail('INVALID_ATTACHMENT',400);
  const bytes=Buffer.from(input.base64,'base64');if(bytes.length>maxAttachmentBytes(this.environment))return fail('ATTACHMENT_TOO_LARGE',413);
  const staged=await this.run(async tx=>{if(conversationId&&!rows(await tx.query('SELECT 1 FROM app.conversations WHERE organization_id=$1 AND id=$2',[this.ctx.organizationId,conversationId])).length)return fail('NOT_FOUND',404);
   const row=await stageAttachmentTx(tx,this.ctx,{conversationId,direction:'outbound',filename:String(input.filename??''),contentType:String(input.declaredType??''),size:bytes.length},this.environment);await event(tx,this.ctx,'attachment.staged',row.id,{state:row.scan_state});return row;});
  if(staged.scan_state==='rejected')return {id:staged.id,scanState:'rejected',reason:staged.scan_reason};
  return this.scanAttachment(staged.id,bytes);
 }
 /** Scans staged bytes: size, magic-byte type, declared/sniffed mismatch and the EICAR malware stand-in. Only clean bytes are retained. */
 async scanAttachment(id:string,bytes:Uint8Array){identifier(id);return this.run(async tx=>{
  const row=rows(await tx.query('SELECT * FROM app.message_attachments WHERE organization_id=$1 AND id=$2 FOR UPDATE',[this.ctx.organizationId,id]))[0];if(!row)return fail('NOT_FOUND',404);if(row.scan_state!=='staged')return {id,scanState:row.scan_state,reason:row.scan_reason};
  const sniffed=sniffContentType(bytes),hash=createHash('sha256').update(bytes).digest('hex');const declared=String(row.declared_type);
  let state:'clean'|'quarantined'|'rejected'='clean',reason:string|null=null;
  if(containsEicar(bytes)){state='quarantined';reason='MALWARE_SIGNATURE';}
  else if(bytes.length>maxAttachmentBytes(this.environment)){state='rejected';reason='OVERSIZED';}
  else if(row.size_bytes>0&&Number(row.size_bytes)!==bytes.length&&row.direction==='inbound'){state='quarantined';reason='SIZE_MISMATCH';}
  else if(!(attachmentTypes as readonly string[]).includes(sniffed)){state=['application/x-msdownload','application/x-elf','text/html'].includes(sniffed)?'quarantined':'rejected';reason='FORBIDDEN_TYPE';}
  else if(sniffed!==declared&&!(sniffed==='text/plain'&&declared==='text/csv')){state='quarantined';reason='TYPE_MISMATCH';}
  await tx.query('UPDATE app.message_attachments SET sniffed_type=$3,sha256=$4,scan_state=$5,scan_reason=$6,content=$7,size_bytes=$8,scanned_at=app.utc_now() WHERE organization_id=$1 AND id=$2',[this.ctx.organizationId,id,sniffed,hash,state,reason,state==='clean'?Buffer.from(bytes):null,bytes.length]);
  await event(tx,this.ctx,'attachment.scanned',id,{state,reasonCode:reason});return {id,scanState:state,reason,sha256:hash,sniffedType:sniffed};
 });}
 async downloadAttachment(id:string){identifier(id);return this.run(async tx=>{const row=rows(await tx.query('SELECT id,filename,sniffed_type,scan_state,content FROM app.message_attachments WHERE organization_id=$1 AND id=$2',[this.ctx.organizationId,id]))[0];if(!row)return fail('NOT_FOUND',404);if(row.scan_state!=='clean'||!row.content)return fail('ATTACHMENT_NOT_AVAILABLE',403);await event(tx,this.ctx,'attachment.downloaded',id);return {headers:attachmentDownloadHeaders({filename:String(row.filename),sniffed_type:row.sniffed_type}),body:new Uint8Array(row.content)};});}
 /** The only conversation view intended for model/tool context: excludes quarantined, cancelled and redacted messages and every non-clean attachment, and never includes attachment bytes. */
 async modelContext(conversationId:string){identifier(conversationId);return this.run(async tx=>{
  const conversation=rows(await tx.query('SELECT id,subject FROM app.conversations WHERE organization_id=$1 AND id=$2',[this.ctx.organizationId,conversationId]))[0];if(!conversation)return fail('NOT_FOUND',404);
  const messages=rows(await tx.query("SELECT id,direction,subject,body,ai_generated,created_at FROM app.messages WHERE organization_id=$1 AND conversation_id=$2 AND state NOT IN ('quarantined','redacted','cancelled') ORDER BY created_at",[this.ctx.organizationId,conversationId]));
  const attachments=rows(await tx.query("SELECT id,message_id,filename,sniffed_type,size_bytes FROM app.message_attachments WHERE organization_id=$1 AND conversation_id=$2 AND scan_state='clean'",[this.ctx.organizationId,conversationId]));
  const excluded=rows(await tx.query("SELECT (SELECT count(*)::int FROM app.messages WHERE organization_id=$1 AND conversation_id=$2 AND state IN ('quarantined','redacted','cancelled')) AS messages,(SELECT count(*)::int FROM app.message_attachments WHERE organization_id=$1 AND conversation_id=$2 AND scan_state<>'clean') AS attachments",[this.ctx.organizationId,conversationId]))[0]!;
  return {conversationId,subject:conversation.subject,messages:messages.map(item=>({id:item.id,direction:item.direction,subject:item.subject,body:item.body,trust:item.direction==='inbound'?'untrusted_external_content':item.ai_generated?'ai_drafted_unverified':'owner_written',at:item.created_at})),attachments,excluded:{messages:Number(excluded.messages),attachments:Number(excluded.attachments)}};
 });}

 // DOTS-101: owner reconciliation.
 async resolveReconciliation(id:string,resolution:unknown,evidence:unknown,providerMessageId?:unknown){identifier(id);const decision=selection(resolution,['sent','not_sent','accepted','dismissed'],'resolution');const proof=text(evidence,'evidence',500);
  const settle=await this.run(async tx=>{
   const item=rows(await tx.query("SELECT * FROM app.reconciliation_items WHERE organization_id=$1 AND id=$2 FOR UPDATE",[this.ctx.organizationId,id]))[0];if(!item)return fail('NOT_FOUND',404);if(item.state!=='open')return fail('ALREADY_RESOLVED');
   let budget:{reservationId:string;actual:number;evidence:string;release:boolean}|null=null;
   if(item.kind==='uncertain_send'){
    if(!['sent','not_sent'].includes(decision))return fail('INVALID_RESOLUTION',400);
    await tx.query('SELECT id FROM app.messages WHERE organization_id=$1 AND id=$2 FOR UPDATE',[this.ctx.organizationId,item.message_id]);
    const attempt=rows(await tx.query("SELECT * FROM app.dispatch_attempts WHERE organization_id=$1 AND message_id=$2 AND state='uncertain' FOR UPDATE",[this.ctx.organizationId,item.message_id]))[0];
    if(decision==='sent'){const provider=String(providerMessageId??'');if(!providerIdPattern.test(provider))return fail('PROVIDER_MESSAGE_ID_REQUIRED',400);if(!attempt)return fail('NO_UNCERTAIN_ATTEMPT');
     await markProviderAccepted(tx,this.ctx,item.message_id,provider,attempt.id,'resolved_sent',this.environment);if(attempt.reservation_id)budget={reservationId:attempt.reservation_id,actual:Number(attempt.cost_cents),evidence:provider,release:false};}
    else{await tx.query("UPDATE app.messages SET state='failed',version=version+1 WHERE organization_id=$1 AND id=$2 AND state='quarantined'",[this.ctx.organizationId,item.message_id]);
     if(attempt){await tx.query("UPDATE app.dispatch_attempts SET state='resolved_not_sent',finished_at=app.utc_now() WHERE organization_id=$1 AND id=$2",[this.ctx.organizationId,attempt.id]);if(attempt.reservation_id)budget={reservationId:attempt.reservation_id,actual:0,evidence:`not-sent:${item.message_id}`,release:true};}}
   }else if(item.kind==='unverified_inbound'){if(!['accepted','dismissed'].includes(decision))return fail('INVALID_RESOLUTION',400);if(decision==='accepted')await tx.query("UPDATE app.messages SET state='received' WHERE organization_id=$1 AND id=$2 AND state='quarantined' AND direction='inbound'",[this.ctx.organizationId,item.message_id]);}
   else if(decision!=='dismissed')return fail('INVALID_RESOLUTION',400);
   await tx.query("UPDATE app.reconciliation_items SET state='resolved',resolution=$3,evidence=$4,resolved_by_membership_id=$5,resolved_at=app.utc_now() WHERE organization_id=$1 AND id=$2",[this.ctx.organizationId,id,decision,proof,this.ctx.membershipId]);
   await event(tx,this.ctx,'reconciliation.resolved',id,{kind:item.kind,resolution:decision,evidenceHash:digest(proof)});return budget;
  });
  if(settle)await new ControlPlane(this.client,this.ctx).settle(settle.reservationId,settle.actual,settle.evidence,settle.release,settle.release?undefined:'provider');
  return {id,resolution:decision};
 }

 // DOTS-103 / DOTS-097: health and snapshot.
 async senderHealth(){return this.run(async tx=>{const limits=healthThresholds(this.environment);
  const mailboxes=[];for(const item of rows(await tx.query('SELECT id,label,status,pause_reason FROM app.mailboxes WHERE organization_id=$1 ORDER BY created_at',[this.ctx.organizationId])))mailboxes.push({...item,...await healthStats(tx,this.ctx,'mailbox_id',item.id)});
  const campaigns=[];for(const item of rows(await tx.query("SELECT id,label,state FROM app.campaigns WHERE organization_id=$1 AND state IN ('active','paused') ORDER BY updated_at DESC LIMIT 50",[this.ctx.organizationId])))campaigns.push({...item,...await healthStats(tx,this.ctx,'campaign_id',item.id)});
  return {thresholds:limits,mailboxes,campaigns};});}
 async snapshot(conversationId?:string){const selected=conversationId?identifier(conversationId):null;const health=await this.senderHealth();return this.run(async tx=>{
  const org=this.ctx.organizationId;
  const threads=rows(await tx.query(`SELECT c.id,c.subject,c.state,c.human_takeover,c.claimed_by_membership_id,c.agent_delegated,c.needs_owner,c.priority,c.sla_due_at,c.updated_at,c.last_inbound_at,c.campaign_id,ct.display_name AS contact_name,
   (SELECT jsonb_build_object('direction',m.direction,'state',m.state,'delivery_status',m.delivery_status,'created_at',m.created_at,'provider_message_id',m.provider_message_id,'authentication',m.authentication) FROM app.messages m WHERE m.organization_id=c.organization_id AND m.conversation_id=c.id ORDER BY m.created_at DESC LIMIT 1) AS last_message,
   (SELECT label FROM app.reply_triage t JOIN app.messages m ON m.id=t.message_id AND m.organization_id=t.organization_id WHERE t.organization_id=c.organization_id AND m.conversation_id=c.id ORDER BY t.created_at DESC LIMIT 1) AS last_triage
   FROM app.conversations c JOIN app.crm_contacts ct ON ct.id=c.contact_id AND ct.organization_id=c.organization_id WHERE c.organization_id=$1 ORDER BY c.needs_owner DESC,c.priority DESC,c.sla_due_at ASC NULLS LAST,c.updated_at DESC LIMIT 100`,[org])).map(item=>({...item,last_label:item.last_message?deliveryLabel(item.last_message).label:null}));
  let conversation=null;
  if(selected){const thread=rows(await tx.query('SELECT c.*,ct.display_name AS contact_name,ct.email AS contact_email,ct.status AS contact_status,ct.consent AS contact_consent,ca.label AS campaign_label,ca.state AS campaign_state,ca.purpose AS campaign_purpose FROM app.conversations c JOIN app.crm_contacts ct ON ct.id=c.contact_id AND ct.organization_id=c.organization_id LEFT JOIN app.campaigns ca ON ca.id=c.campaign_id AND ca.organization_id=c.organization_id WHERE c.organization_id=$1 AND c.id=$2',[org,selected]))[0];
   if(thread){const messages=rows(await tx.query('SELECT id,direction,subject,body,state,source,provider_message_id,delivery_status,delivery_updated_at,authentication,from_address,to_addresses,cc_addresses,message_id_header,in_reply_to_header,reply_mode,ai_generated,current_revision,approved_revision,approval_id,version,created_at,sent_at,received_at,sequence_step_id,attachment_ids FROM app.messages WHERE organization_id=$1 AND conversation_id=$2 ORDER BY COALESCE(received_at,sent_at,created_at),created_at',[org,selected]));
    const triage=rows(await tx.query('SELECT t.message_id,t.label,t.confidence_basis_points,t.rules,t.citations,t.escalated FROM app.reply_triage t JOIN app.messages m ON m.id=t.message_id AND m.organization_id=t.organization_id WHERE t.organization_id=$1 AND m.conversation_id=$2',[org,selected]));
    const attachments=rows(await tx.query('SELECT id,message_id,direction,filename,declared_type,sniffed_type,size_bytes,scan_state,scan_reason FROM app.message_attachments WHERE organization_id=$1 AND conversation_id=$2 ORDER BY created_at',[org,selected]));
    const enrollments=rows(await tx.query("SELECT e.id,e.state,e.state_reason,q.label,q.max_touches,(SELECT jsonb_agg(jsonb_build_object('touch',s.touch_number,'state',s.state,'due_at',s.due_at,'reason',s.state_reason) ORDER BY s.touch_number) FROM app.sequence_steps s WHERE s.organization_id=e.organization_id AND s.enrollment_id=e.id) AS steps FROM app.sequence_enrollments e JOIN app.follow_up_sequences q ON q.id=e.sequence_id AND q.organization_id=e.organization_id WHERE e.organization_id=$1 AND e.conversation_id=$2",[org,selected]));
    conversation={...thread,messages:messages.map(item=>({...item,label:deliveryLabel(item),triage:triage.find(t=>t.message_id===item.id)??null})),attachments,enrollments};}}
  const mailboxes=rows(await tx.query('SELECT id,label,sender_email,sender_name,provider,connection_kind,verified,status,pause_reason,spf_status,dkim_status,dmarc_status,auth_checked_at,owner_consent_at,token_ref,token_rotated_at,token_expires_at FROM app.mailboxes WHERE organization_id=$1 ORDER BY created_at',[org]));
  const senderProfile=rows(await tx.query('SELECT legal_name,postal_address,version,updated_at FROM app.sender_profiles WHERE organization_id=$1',[org]))[0]??null;
  const reconciliation=rows(await tx.query("SELECT id,kind,message_id,provider_ref,details,created_at FROM app.reconciliation_items WHERE organization_id=$1 AND state='open' ORDER BY created_at LIMIT 50",[org]));
  const sequences=rows(await tx.query("SELECT q.id,q.label,q.state,q.max_touches,q.interval_days,q.quiet_start_hour,q.quiet_end_hour,q.timezone,q.campaign_id,(SELECT count(*)::int FROM app.sequence_enrollments e WHERE e.organization_id=q.organization_id AND e.sequence_id=q.id AND e.state='active') AS active_enrollments FROM app.follow_up_sequences q WHERE q.organization_id=$1 ORDER BY q.created_at DESC LIMIT 50",[org]));
  const optOuts=rows(await tx.query('SELECT channel,cancelled_steps,cancelled_messages,created_at FROM app.opt_out_records WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 20',[org]));
  const campaigns=rows(await tx.query("SELECT id,label,state,purpose FROM app.campaigns WHERE organization_id=$1 ORDER BY updated_at DESC LIMIT 50",[org]));
  return {threads,conversation,mailboxes,senderProfile,reconciliation,sequences,optOuts,campaigns,health,observedAt:this.now().toISOString()};
 });}
}
