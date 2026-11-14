import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {
 CampaignStudio,SalesWorkspace,DeliveryGateway,runOneTask,tenant,assertCampaignDispatchable,
 sanitizeHtml,safeUrl,renderTemplate,parsePlaceholders,checkClaims,checkPricing,validateQuote,priceAllowed,checkSendRules,
 canTransition,campaignStates,campaignTransitions,statesInto,editableCampaignStates,chooseVariant,inSendWindow,nextSendWindow,
 contactExclusion,factInfo,syntheticProspects,
} from '../packages/operations/dist/index.js';
import {setup,org,owner,project,ctx} from './helpers/operations-fixture.mjs';

const NOW=new Date('2026-11-10T15:00:00Z'); // Tuesday 10:00 in America/New_York
const migrations=new URL('../database/migrations/',import.meta.url);

/** Serializes whole transactions so concurrent async flows interleave like separate pooled connections with row locks. */
function serialized(db){
 let chain=Promise.resolve(),release=null;
 const finish=()=>{const done=release;release=null;done?.();};
 return {async query(statement,values){
  if(statement==='BEGIN'){const previous=chain;let unlock;chain=new Promise(resolve=>{unlock=resolve;});await previous;release=unlock;return db.query(statement,values);}
  try{return await db.query(statement,values);}finally{if(statement==='COMMIT'||statement==='ROLLBACK')finish();}
 }};
}

async function build(options={}){
 const {db,client,control}=await setup();
 const runtime=options.serialize?serialized(db):client;
 await control.pause(false);
 let now=options.now??NOW;
 const clock=()=>now;
 const studio=new CampaignStudio(runtime,ctx,{clock}),sales=new SalesWorkspace(runtime,ctx);
 const ids=await tenant(client,ctx,async tx=>{
  const insertFact=async(offer,label,content)=>(await tx.query('INSERT INTO app.vetted_product_facts(organization_id,project_id,offer_id,label,content,updated_by_membership_id) VALUES($1,$2,$3,$4,$5::jsonb,$6) RETURNING id',[org,project,offer,label,JSON.stringify(content),owner])).rows[0].id;
  const offer=(await tx.query("INSERT INTO app.offers(organization_id,project_id,label,content,updated_by_membership_id) VALUES($1,$2,'Synthetic onboarding plan','{\"priceCents\":4900}',$3) RETURNING id",[org,project,owner])).rows[0].id;
  const fact=await insertFact(offer,'Pilot onboarding result',{body:'Synthetic pilot customers cut onboarding time by 40% in 2025.',sourceUrl:'https://example.invalid/synthetic-pilot',verifiedAt:'2026-10-01T00:00:00Z',expiresAt:'2027-10-01T00:00:00Z'});
  const expired=await insertFact(offer,'Old benchmark',{body:'Synthetic benchmark of 3 days.',sourceUrl:'https://example.invalid/old',verifiedAt:'2025-01-01T00:00:00Z',expiresAt:'2026-01-01T00:00:00Z'});
  const unsourced=await insertFact(offer,'Unsourced statement',{body:'Synthetic 99 percent uptime.',verifiedAt:'2026-10-01T00:00:00Z',expiresAt:'2027-10-01T00:00:00Z'});
  const mailbox=(await tx.query("INSERT INTO app.mailboxes(organization_id,label,sender_email,sender_name,business_address,provider,verified,status) VALUES($1,'Synthetic sender','owner@example.invalid','Synthetic Sender','Synthetic business address','resend',true,'active') RETURNING id",[org])).rows[0].id;
  const unverified=(await tx.query("INSERT INTO app.mailboxes(organization_id,label,sender_email,sender_name,business_address,provider) VALUES($1,'Unverified sender','other@example.invalid','Other','Synthetic business address','resend') RETURNING id",[org])).rows[0].id;
  await tx.query('UPDATE app.agent_project_assignments SET quota_limit=100,concurrency_cap=5 WHERE organization_id=$1',[org]);
  return {offer,fact,expired,unsourced,mailbox,unverified};
 });
 await studio.setPriceRule(ids.offer,{authorizedPricesCents:[4900,9900],maxDiscountBp:1000,restrictedPhrases:['lifetime access']});
 const strategy=(await sales.addStrategy('Synthetic champion','Use vetted facts only')).id;
 const strategy2=(await sales.addStrategy('Synthetic challenger','Lead with the pilot result')).id;
 const contact=(name,email,jurisdiction,consent)=>sales.addContact({name,email,source:'Synthetic fixture',jurisdiction,consent,consentEvidence:consent==='unknown'?undefined:'Synthetic consent evidence'});
 const c1=await contact('Synthetic One','one@example.invalid','US','opted_in'),c2=await contact('Synthetic Two','two@example.invalid','US','opted_in'),c3=await contact('Synthetic Three','three@example.invalid','CA','opted_in');
 const c4=await contact('Synthetic Four','four@example.invalid','US','unknown'),c5=await contact('Synthetic Five','five@example.invalid','FR','opted_in'),c6=await contact('Synthetic Six','six@example.invalid','CA','business_reviewed');
 return {db,client,runtime,control,studio,sales,...ids,strategy,strategy2,contacts:[c1,c2,c3,c4,c5,c6].map(c=>c.id),setNow:value=>{now=value;}};
}
const goodCopy=w=>({subject:'Faster onboarding for {{contact.company}}',bodyText:`Hi {{contact.first_name}},\n{{fact:${w.fact}}}\nPlans start at $49.\nReply if a short call would help.`,bodyHtml:`<p>Hi {{contact.first_name}},</p><p>{{fact:${w.fact}}}</p><p>Plans start at <strong>$49</strong>.</p>`});
async function draft(w,extra={}){
 return w.studio.createDraft({projectId:project,label:'Synthetic launch',purpose:'product',goal:'Book synthetic demos',offerId:w.offer,mailboxId:w.mailbox,strategyId:w.strategy,allowedCountries:['US','CA'],timezone:'America/New_York',windowStartHour:9,windowEndHour:17,scheduleStartAt:new Date(NOW.getTime()-60000).toISOString(),dailyLimit:10,frequencyCap:1,cadenceDays:7,...extra});
}
async function prepared(w,{copy,budget={totalCents:0,perMessageMaxCents:0},extra={}}={}){
 let c=await draft(w,extra);
 c=(await w.studio.editCopy(c.id,Number(c.version),copy??goodCopy(w))).campaign;
 c=(await w.studio.setAudience(c.id,Number(c.version),{contactIds:w.contacts})).campaign;
 c=(await w.studio.setBudget(c.id,Number(c.version),budget)).campaign;
 return c;
}
async function approved(w,options={}){
 const c=await prepared(w,options);
 const validation=await w.studio.validate(c.id);
 assert.equal(validation.campaign.state,'validated',JSON.stringify(validation.issues.filter(i=>i.severity==='blocking')));
 const simulation=await w.studio.simulate(c.id);
 const request=await w.studio.requestApproval(c.id);
 const decided=await w.studio.decideApproval(request.approval.id,true);
 return {campaign:decided,approval:request.approval,simulation,binding:request.binding};
}
async function active(w,options={}){const result=await approved(w,options);await w.studio.schedule(result.campaign.id);const campaign=await w.studio.activate(result.campaign.id);return {...result,campaign};}
const count=async(db,sql,values=[])=>(await db.query(sql,values)).rows[0].n;

/* ------------------------------------------------------------- pure rules */
test('DOTS-082 lifecycle transition table is closed: only listed transitions apply and active campaigns cannot be edited in place',()=>{
 let allowed=0;
 for(const from of campaignStates)for(const to of campaignStates){const expected=campaignTransitions[from].includes(to);assert.equal(canTransition(from,to),expected,`${from}->${to}`);if(expected)allowed++;}
 assert.equal(allowed,27);
 assert.equal(canTransition('draft','active'),false);assert.equal(canTransition('archived','draft'),false);assert.equal(canTransition('completed','active'),false);assert.equal(canTransition('legacy','draft'),false);
 assert.deepEqual([...statesInto('approved')],['ready_for_approval']);
 assert.ok(!editableCampaignStates.includes('active'));assert.ok(editableCampaignStates.includes('paused'));assert.ok(!editableCampaignStates.includes('archived'));
});

test('DOTS-084 sanitizer strips scripts, styles, event handlers and javascript: URLs including obfuscated payloads',()=>{
 const payloads=[
  '<script>alert(1)</script>','<img src=x onerror=alert(1)>','<svg onload=alert(1)><circle/></svg>','<a href="javascript:alert(1)">x</a>',
  '<a href="  JaVaScRiPt:alert(1)">x</a>','<a href="jav&#x09;ascript:alert(1)">x</a>','<a href="&#106;avascript:alert(1)">x</a>','<a href="java\nscript:alert(1)">x</a>',
  '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>','<p onclick="alert(1)" style="background:url(javascript:alert(1))">x</p>',
  '<style>body{background:url("javascript:alert(1)")}</style>','<iframe src="https://example.invalid"></iframe>','<scr<script>ipt>alert(1)</script>',
  '<a title="a>b" href="javascript:alert(1)">x</a>','<!--<script>alert(1)</script>-->','<math><mtext><img src=x onerror=alert(1)></mtext></math>',
  '<p>unterminated <script>alert(1)','<object data="javascript:alert(1)"></object>','<a href=vbscript:msgbox(1)>x</a>','"><img src=x onerror=alert(1)>',
 ];
 for(const payload of payloads){
  const clean=sanitizeHtml(payload);
  assert.doesNotMatch(clean,/<script|<style|<iframe|<svg|<math|<object|<img|onerror|onload|onclick|javascript:|vbscript:|data:text/i,`${payload} -> ${clean}`);
  assert.doesNotMatch(clean,/<[a-z]+[^>]*\s(?!href=|rel=)[a-z-]+=/i,`attribute leaked: ${clean}`);
 }
 assert.equal(sanitizeHtml('<p>Hello <strong>world</strong> & <em>friends</em></p>'),'<p>Hello <strong>world</strong> &amp; <em>friends</em></p>');
 assert.equal(sanitizeHtml('<a href="https://example.invalid/a?b=1&c=2" target="_blank">ok</a>'),'<a href="https://example.invalid/a?b=1&amp;c=2" rel="noopener noreferrer nofollow">ok</a>');
 assert.equal(sanitizeHtml('<ul><li>one<li>two</ul><div>unwrapped</div>'),'<ul><li>one<li>two</li></li></ul>unwrapped');
 assert.equal(sanitizeHtml('<p>open'),'<p>open</p>');
 assert.equal(safeUrl('mailto:owner@example.invalid'),'mailto:owner@example.invalid');assert.equal(safeUrl('/relative'),null);assert.equal(safeUrl('&#x6A;avascript:alert(1)'),null);
});

test('DOTS-084 templates render exact copy for synthetic prospects; variables are escaped so they cannot inject markup or links',()=>{
 const facts=new Map([['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',factInfo({id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',project_id:project,label:'Fact',status:'active',version:1,content:{body:'Cut setup time by 40%.',sourceUrl:'https://example.invalid',verifiedAt:'2026-01-01',expiresAt:'2027-01-01'}})]]);
 const content={subject:'Hello {{contact.first_name}}\n',bodyText:'Hi {{contact.first_name}} at {{contact.company}}. {{fact:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa}}',bodyHtml:'<p>Hi {{contact.company}}</p><a href="{{contact.company}}">site</a><p>{{fact:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa}}</p>'};
 const rendered=renderTemplate(content,{contact:{first_name:'Avery',company:'<img src=x onerror=alert(1)>'},facts});
 assert.equal(rendered.subject,'Hello Avery ');
 assert.match(rendered.text,/Cut setup time by 40%\./);
 assert.doesNotMatch(rendered.html,/<img/);assert.match(rendered.html,/&lt;img/);
 const jsLink=renderTemplate(content,{contact:{company:'javascript:alert(1)'},facts});assert.doesNotMatch(jsLink.html,/href=/);
 const parsed=parsePlaceholders('{{contact.first_name}} {{contact.ssn}} {{fact:AAAAAAAA-aaaa-4aaa-8aaa-aaaaaaaaaaaa}} {{ broken');
 assert.deepEqual(parsed.unknown,['contact.ssn']);assert.deepEqual(parsed.facts,['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']);assert.equal(parsed.malformed,true);
 for(const prospect of syntheticProspects)assert.match(prospect.company,/synthetic/);
});

test('DOTS-085 numeric and superlative claims need an active, sourced, unexpired cited fact containing the figure',()=>{
 const id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',expiredId='cccccccc-cccc-4ccc-8ccc-cccccccccccc',unsourcedId='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
 const make=(fid,content,status='active')=>[fid,factInfo({id:fid,project_id:project,label:fid.slice(0,4),status,version:1,content})];
 const facts=new Map([make(id,{body:'Pilot users saved 40% of setup time in 2025.',sourceUrl:'https://example.invalid',verifiedAt:'2026-01-01',expiresAt:'2027-06-01'}),make(expiredId,{body:'3 day setup.',sourceUrl:'https://example.invalid',verifiedAt:'2024-01-01',expiresAt:'2025-01-01'}),make(unsourcedId,{body:'99 percent uptime.',verifiedAt:'2026-01-01',expiresAt:'2027-01-01'})]);
 const codes=source=>checkClaims(source,facts,project,NOW).map(i=>i.code);
 assert.deepEqual(codes('We cut setup time by 40%.'),['UNSUPPORTED_NUMERIC_CLAIM']);
 assert.deepEqual(codes(`We cut setup time by 40% {{fact:${id}}}.`),[]);
 assert.deepEqual(codes(`{{fact:${id}}}`),[]);
 assert.deepEqual(codes(`We cut setup time by 70% {{fact:${id}}}.`),['UNSUPPORTED_NUMERIC_CLAIM']);
 assert.deepEqual(codes(`Setup in {{fact:${expiredId}}}`),['FACT_EXPIRED']);
 assert.deepEqual(codes(`Reliable: {{fact:${unsourcedId}}}`),['FACT_WITHOUT_SOURCE']);
 assert.deepEqual(codes('{{fact:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee}}'),['UNKNOWN_FACT']);
 assert.deepEqual(codes('We are the fastest onboarding tool.'),['UNSUPPORTED_SUPERLATIVE']);
 assert.deepEqual(codes('Results are guaranteed.'),['UNAPPROVED_OUTCOME_PROMISE']);
 assert.deepEqual(codes('Hello {{contact.first_name}}, happy to help.'),[]);
 const issue=checkClaims('Join 500 teams today.',facts,project,NOW)[0];assert.equal(issue.severity,'blocking');assert.match(issue.message,/500.*without a cited vetted fact/);
});

test('DOTS-086 copy and quotes cannot invent prices or exceed the authorized discount without an owner exception',()=>{
 const rule={authorizedPricesCents:[4900,9900],maxDiscountBp:1000,restrictedPhrases:['lifetime access']};
 const codes=(source,exceptions=[])=>checkPricing(source,rule,exceptions).map(i=>i.code);
 assert.deepEqual(codes('Plans start at $49 or USD 99.00.'),[]);
 assert.deepEqual(codes('Now only $45.'),[]);
 assert.deepEqual(codes('Now only $39.'),['PRICE_NOT_AUTHORIZED']);
 assert.deepEqual(codes('Enterprise is $1,500.'),['PRICE_NOT_AUTHORIZED']);
 assert.deepEqual(codes('Take 25% off this week.'),['DISCOUNT_EXCEEDS_LIMIT']);
 assert.deepEqual(codes('Take 10% off this week.'),[]);
 assert.deepEqual(codes('Includes lifetime access.'),['RESTRICTED_CLAIM']);
 assert.deepEqual(codes('Now only $39.',[{amountCents:3900,discountBp:null}]),[]);
 assert.deepEqual(codes('Take 25% off.',[{amountCents:null,discountBp:2500}]),[]);
 assert.deepEqual(checkPricing('Only $10.',null).map(i=>i.code),['PRICE_RULE_MISSING']);
 assert.match(checkPricing('Now only $39.',rule)[0].message,/\$39.*not an authorized price.*\$49, \$99/);
 assert.deepEqual(validateQuote(rule,4410),{ok:true});assert.deepEqual(validateQuote(rule,4409),{ok:false,reason:'PRICE_NOT_AUTHORIZED'});assert.deepEqual(validateQuote(rule,12000),{ok:false,reason:'PRICE_NOT_AUTHORIZED'});
 assert.deepEqual(validateQuote(null,4900),{ok:false,reason:'PRICE_RULE_MISSING'});assert.equal(priceAllowed(rule,3000,[{amountCents:3000,discountBp:null}]),true);
});

test('DOTS-087 forbidden channel, country, purpose, quiet-hour and cadence combinations fail with plain-language reasons',()=>{
 const base={purpose:'product',channel:'email',allowedCountries:['US'],timezone:'America/New_York',windowStartHour:9,windowEndHour:17,weekdaysOnly:true,dailyLimit:20,frequencyCap:1,cadenceDays:7,scheduleStartAt:new Date('2026-11-11T14:00:00Z'),scheduleEndAt:null,authorityRef:null};
 const check=overrides=>checkSendRules({...base,...overrides},NOW).filter(i=>i.severity==='blocking');
 assert.deepEqual(check({}),[]);
 const cases=[
  [{channel:'sms'},'CHANNEL_DISABLED',/SMS outreach is disabled/],
  [{allowedCountries:['US','BR']},'COUNTRY_CHANNEL_FORBIDDEN',/Email outreach to BR is not in the reviewed country list/],
  [{allowedCountries:[]},'COUNTRIES_REQUIRED',/at least one recipient country/],
  [{purpose:'investment'},'AUTHORITY_REQUIRED',/Investment outreach needs a reviewed owner\/legal authority/],
  [{purpose:'investment',authorityRef:'synthetic-legal-review',allowedCountries:['US','GB']},'INVESTMENT_JURISDICTION_FORBIDDEN',/outside the United States \(GB\)/],
  [{windowStartHour:7},'QUIET_HOURS',/07:00–17:00 overlaps quiet hours \(20:00–08:00 in America\/New_York\)/],
  [{windowEndHour:22},'QUIET_HOURS',/overlaps quiet hours/],
  [{dailyLimit:150},'DAILY_CAP_EXCEEDED',/exceeds the 100-message daily limit for Email/],
  [{frequencyCap:3,cadenceDays:7},'FREQUENCY_TOO_HIGH',/3 message\(s\) per contact every 7 day\(s\)/],
  [{timezone:'Mars/Olympus'},'TIMEZONE_INVALID',/not a valid IANA time zone/],
  [{scheduleStartAt:null},'SCHEDULE_REQUIRED',/Set a start date/],
 ];
 for(const [overrides,code,message] of cases){const issues=check(overrides);const issue=issues.find(i=>i.code===code);assert.ok(issue,`${code} missing: ${JSON.stringify(issues)}`);assert.match(issue.message,message);}
 const window={timezone:'America/New_York',startHour:9,endHour:17,weekdaysOnly:true};
 assert.equal(inSendWindow(NOW,window),true);assert.equal(inSendWindow(new Date('2026-11-11T02:00:00Z'),window),false);assert.equal(inSendWindow(new Date('2026-11-14T15:00:00Z'),window),false);
 assert.equal(nextSendWindow(new Date('2026-11-13T23:30:00Z'),window).toISOString(),'2026-11-16T14:00:00.000Z');
 const rule={channel:'email',allowedCountries:['US','CA'],frequencyCap:1};const contact={id:'x',status:'active',consent:'opted_in',jurisdiction:'US',suppressed:false,recentTouches:0};
 assert.equal(contactExclusion(contact,rule),null);assert.equal(contactExclusion({...contact,suppressed:true},rule),'SUPPRESSED');assert.equal(contactExclusion({...contact,jurisdiction:'unreviewed'},rule),'JURISDICTION_UNREVIEWED');
 assert.equal(contactExclusion({...contact,jurisdiction:'FR'},rule),'COUNTRY_NOT_IN_CAMPAIGN');assert.equal(contactExclusion({...contact,consent:'business_reviewed'},rule),null);assert.equal(contactExclusion({...contact,jurisdiction:'CA',consent:'business_reviewed'},rule),'CONSENT_MISSING');
 assert.equal(contactExclusion({...contact,recentTouches:1},rule),'FREQUENCY_CAP');
});

test('DOTS-088 variant choice is deterministic, weighted and constrained by eligibility',()=>{
 const variants=[{id:'v1',strategy_id:'s1',template_revision_id:'t1',weight:1,eligibility:{countries:['CA']},status:'active'},{id:'v2',strategy_id:'s2',template_revision_id:'t2',weight:3,eligibility:{consents:['opted_in']},status:'active'},{id:'v3',strategy_id:'s3',template_revision_id:'t3',weight:5,eligibility:{},status:'retired'}];
 assert.equal(chooseVariant(variants,{id:'c',jurisdiction:'US',consent:'opted_in'},'camp').id,'v2');
 assert.equal(chooseVariant(variants,{id:'c',jurisdiction:'US',consent:'existing_customer'},'camp'),null);
 const picks=new Map();for(let i=0;i<400;i++){const v=chooseVariant(variants,{id:`c${i}`,jurisdiction:'CA',consent:'opted_in'},'camp').id;picks.set(v,(picks.get(v)??0)+1);}
 assert.ok(picks.get('v2')>picks.get('v1'));assert.ok(!picks.has('v3'));
 assert.equal(chooseVariant(variants,{id:'c9',jurisdiction:'CA',consent:'opted_in'},'camp').id,chooseVariant(variants,{id:'c9',jurisdiction:'CA',consent:'opted_in'},'camp').id);
});

/* --------------------------------------------------------- database flows */
test('DOTS-082/083/090 drafts save and restore, material edits create immutable revisions and revoke approval, label edits do not',async()=>{
 const w=await build();try{
  const empty=await w.studio.snapshot();assert.deepEqual(empty.campaigns,[]);assert.equal(empty.templates.length,0);
  let c=await draft(w);assert.equal(c.state,'draft');assert.equal(Number(c.revision),1);
  const renamed=await w.studio.saveDraft(c.id,Number(c.version),{label:'Synthetic launch renamed'});assert.equal(Number(renamed.revision),1);assert.equal(renamed.label,'Synthetic launch renamed');
  const saved=await w.studio.saveDraft(c.id,Number(renamed.version),{goal:'Book synthetic demos with operations leads',dailyLimit:5,allowedCountries:['ca','US']});
  assert.equal(Number(saved.revision),2);assert.deepEqual(saved.allowed_countries,['CA','US']);
  const restored=(await w.studio.snapshot()).campaigns.find(x=>x.id===c.id);assert.equal(restored.goal,'Book synthetic demos with operations leads');assert.equal(restored.daily_limit,5);
  await assert.rejects(w.studio.saveDraft(c.id,Number(renamed.version),{dailyLimit:6}),/VERSION_CONFLICT/);
  await assert.rejects(w.studio.saveDraft(c.id,Number(saved.version),{unknownField:1}),/UNKNOWN_FIELD/);
  await assert.rejects(w.studio.saveDraft(c.id,Number(saved.version),{timezone:'Nowhere/Invalid'}),/INVALID_TIMEZONE/);

  const result=await approved(w);c=result.campaign;assert.equal(c.state,'approved');assert.equal(Number(c.approved_revision),Number(c.revision));
  const binding=result.binding;assert.equal(binding.senderMailboxId,w.mailbox);assert.equal(binding.channel,'email');assert.equal(binding.totalBudgetCents,0);assert.ok(binding.audienceHash);assert.ok(binding.messageRevisionId);assert.equal(binding.schedule.timezone,'America/New_York');
  const before=Number(c.revision);
  const edited=await w.studio.editCopy(c.id,Number(c.version),{subject:'Updated synthetic subject',bodyText:`Hello {{contact.first_name}}. {{fact:${w.fact}}}`});
  assert.equal(edited.campaign.state,'draft');assert.equal(Number(edited.campaign.revision),before+1);assert.equal(edited.campaign.approved_revision,null);assert.equal(edited.campaign.approval_id,null);
  assert.equal((await w.db.query('SELECT status FROM app.action_approvals WHERE id=$1',[result.approval.id])).rows[0].status,'expired');
  await assert.rejects(w.studio.decideApproval(result.approval.id,true),/APPROVAL_STALE/);
  const revisions=(await w.db.query('SELECT revision,snapshot FROM app.campaign_revisions WHERE campaign_id=$1 ORDER BY revision',[c.id])).rows;
  assert.equal(revisions.at(-1).snapshot.reason,'copy_changed');assert.notEqual(revisions.at(-1).snapshot.binding.messageRevisionId,binding.messageRevisionId);
  await assert.rejects(w.db.query('UPDATE app.campaign_revisions SET content_hash=$2 WHERE campaign_id=$1',[c.id,'0'.repeat(64)]),/append-only/);
  await assert.rejects(w.db.query('UPDATE app.message_template_revisions SET subject=$1',['tampered']),/append-only/);
  // audience and budget changes also revoke a fresh approval
  for(const change of [async x=>(await w.studio.setAudience(x.id,Number(x.version),{contactIds:w.contacts.slice(0,2)})).campaign,async x=>(await w.studio.setBudget(x.id,Number(x.version),{totalCents:0,perMessageMaxCents:0})).campaign]){
   const fresh=await approved(w);const revised=await change(fresh.campaign);assert.equal(revised.state,'draft');assert.equal(revised.approved_revision,null);
   assert.equal((await w.db.query('SELECT status FROM app.action_approvals WHERE id=$1',[fresh.approval.id])).rows[0].status,'expired');
  }
  const audiences=(await w.db.query('SELECT revision,contact_count FROM app.campaign_audience_revisions ORDER BY created_at')).rows;assert.ok(audiences.length>=4);
 }finally{await w.db.close();}
});

test('DOTS-082 lifecycle UPDATEs only apply permitted transitions; terminal campaigns are immutable',async()=>{
 const w=await build();try{
  const c=await prepared(w);
  await assert.rejects(w.studio.activate(c.id),/TRANSITION_NOT_ALLOWED/);await assert.rejects(w.studio.schedule(c.id),/TRANSITION_NOT_ALLOWED/);await assert.rejects(w.studio.pause(c.id),/TRANSITION_NOT_ALLOWED/);
  await assert.rejects(w.studio.requestApproval(c.id),/VALIDATE_CAMPAIGN_FIRST/);await assert.rejects(w.studio.complete(c.id),/TRANSITION_NOT_ALLOWED/);
  await assert.rejects(w.sales.pauseCampaign(c.id),/TRANSITION_NOT_ALLOWED/);
  const aborted=await w.studio.abort(c.id);assert.equal(aborted.state,'aborted');
  await assert.rejects(w.studio.saveDraft(c.id,Number(aborted.version),{dailyLimit:3}),/CAMPAIGN_NOT_EDITABLE/);
  await assert.rejects(w.sales.setAudience(c.id,[]),/CAMPAIGN_NOT_EDITABLE/);
  await assert.rejects(w.studio.simulate(c.id),/CAMPAIGN_CLOSED/);
  assert.equal((await w.studio.archive(c.id)).state,'archived');await assert.rejects(w.studio.abort(c.id),/TRANSITION_NOT_ALLOWED/);
  await assert.rejects(w.db.query("UPDATE app.campaigns SET state='simulated' WHERE id=$1",[c.id]),/campaigns_state_check/);
  const events=(await w.db.query("SELECT details FROM app.operation_events WHERE record_id=$1 AND event_type='campaign.state_changed' ORDER BY occurred_at",[c.id])).rows.map(r=>`${r.details.from}->${r.details.to}`);
  assert.deepEqual(events,['draft->aborted','aborted->archived']);
 }finally{await w.db.close();}
});

test('DOTS-084/085/086 unsupported claims, invented prices and unknown variables block validation and approval until fixed or excepted',async()=>{
 const w=await build();try{
  const bad=await prepared(w,{copy:{subject:'Hi {{contact.nickname}}',bodyText:`Teams save 12 hours a week. {{fact:${w.expired}}} Only $39 today.`}});
  const result=await w.studio.validate(bad.id);assert.equal(result.campaign.state,'draft');
  const codes=result.issues.filter(i=>i.severity==='blocking').map(i=>i.code);
  for(const code of ['UNKNOWN_VARIABLE','UNSUPPORTED_NUMERIC_CLAIM','FACT_EXPIRED','PRICE_NOT_AUTHORIZED'])assert.ok(codes.includes(code),`${code} in ${codes}`);
  await assert.rejects(w.studio.requestApproval(bad.id),/VALIDATE_CAMPAIGN_FIRST/);
  const preview=await w.studio.previewTemplate({subject:'Hi {{contact.first_name}}',bodyText:'Save 12 hours.',bodyHtml:'<p onclick="x()">Hi</p><script>alert(1)</script>',projectId:project,offerId:w.offer});
  assert.equal(preview.previews.length,3);assert.match(preview.previews[0].subject,/Hi Avery/);assert.doesNotMatch(preview.previews[0].html,/script|onclick/);assert.ok(preview.issues.some(i=>i.code==='UNSUPPORTED_NUMERIC_CLAIM'));
  // price exception path: $39 is below the 10% discount floor and needs an owner exception record
  let c=await prepared(w,{copy:{subject:'Synthetic offer',bodyText:`{{fact:${w.fact}}} Launch price $39.`}});
  assert.ok((await w.studio.validate(c.id)).issues.some(i=>i.code==='PRICE_NOT_AUTHORIZED'));
  const exception=await w.studio.requestPriceException(c.id,{amountCents:3900,reason:'Synthetic launch pricing reviewed by owner'});
  assert.ok((await w.studio.validate(c.id)).issues.some(i=>i.code==='PRICE_NOT_AUTHORIZED'),'pending exception must not count');
  await w.studio.decidePriceException(exception.id,true);await assert.rejects(w.studio.decidePriceException(exception.id,true),/APPROVAL_STALE/);
  const after=await w.studio.validate(c.id);assert.equal(after.campaign.state,'validated',JSON.stringify(after.issues));
  await assert.rejects(w.db.query('DELETE FROM app.campaign_price_exceptions'),/append-only/);
  const html=await w.studio.reviseTemplate((await w.db.query('SELECT template_id FROM app.message_template_revisions WHERE id=$1',[after.campaign.template_revision_id])).rows[0].template_id,2,{subject:'S',bodyText:'B',bodyHtml:'<p>ok</p><img src=x onerror=alert(1)>'});
  assert.equal(html.sanitized,true);assert.equal(html.revision.body_html,'<p>ok</p>');
 }finally{await w.db.close();}
});

test('DOTS-089 simulation renders synthetic prospects, predicts max cost and exclusions, and makes zero network, inference, queue or money writes',async()=>{
 const w=await build();const originalFetch=globalThis.fetch;let fetches=0;globalThis.fetch=async()=>{fetches++;throw new Error('network forbidden in simulation');};
 try{
  await w.control.setBudget(1000,'synthetic-owner-authorization',1000);
  const c=await prepared(w,{budget:{totalCents:300,perMessageMaxCents:100,authorizationRef:'synthetic-owner-authorization'}});
  await assert.rejects(w.studio.setBudget(c.id,Number(c.version),{totalCents:300,perMessageMaxCents:100}),/SPEND_AUTHORIZATION_REQUIRED/);
  const tasks=await count(w.db,'SELECT count(*)::int AS n FROM app.task_queue'),money=await count(w.db,'SELECT count(*)::int AS n FROM app.money_entries'),reservations=await count(w.db,'SELECT count(*)::int AS n FROM app.budget_reservations');
  const report=await w.studio.simulate(c.id,{sampleSize:5});
  assert.equal(fetches,0);assert.equal(report.networkRequests,0);assert.equal(report.billableInferenceRequests,0);assert.equal(report.messagesSent,0);assert.equal(report.realPeopleContacted,0);
  assert.equal(report.sample.length,5);assert.match(report.sample[0].rendered.subject,/Example Fabrication Co\. \(synthetic\)/);assert.match(report.sample[0].rendered.text,/cut onboarding time by 40% in 2025/);
  assert.match(report.sample[4].wouldBeExcluded,/allowed countries/);assert.equal(report.sample[0].templateRevisionId,c.template_revision_id);
  assert.equal(report.audience.total,6);assert.equal(report.audience.eligible,3);assert.deepEqual(report.audience.exclusionCounts,{CONSENT_MISSING:2,COUNTRY_NOT_IN_CAMPAIGN:1});
  assert.ok(report.audience.excluded.every(e=>e.message&&!('email' in e)));
  assert.equal(report.predictedMaxCostCents,300);assert.equal(report.contactsCoveredByBudget,3);assert.equal(report.sendPlan.daysNeeded,1);
  assert.deepEqual(report.proposedToolActions.map(a=>[a.tool,a.count,a.executesNow]),[['queue.enqueue_campaign_work',3,false],['email.send',3,false],['budget.reserve',3,false]]);
  assert.equal(await count(w.db,'SELECT count(*)::int AS n FROM app.task_queue'),tasks);assert.equal(await count(w.db,'SELECT count(*)::int AS n FROM app.money_entries'),money);assert.equal(await count(w.db,'SELECT count(*)::int AS n FROM app.budget_reservations'),reservations);
  await assert.rejects(w.db.query('UPDATE app.campaign_simulations SET network_requests=1'),/append-only/);
  await assert.rejects(tenant(w.client,ctx,tx=>tx.query("INSERT INTO app.campaign_simulations(organization_id,campaign_id,campaign_revision,binding_hash,blocking_count,network_requests,report,created_by_membership_id) VALUES($1,$2,1,$3,0,1,'{}',$4)",[org,c.id,'0'.repeat(64),owner])),/check constraint/);
  // approval needs a clean simulation of the exact current revision
  const unsimulated=await prepared(w);await w.studio.validate(unsimulated.id);await assert.rejects(w.studio.requestApproval(unsimulated.id),/SIMULATE_CURRENT_REVISION_FIRST/);
  const blocked=await w.studio.simulate((await prepared(w,{extra:{mailboxId:w.unverified}})).id);assert.ok(blocked.blockingReasons.some(r=>/not verified/.test(r)));
 }finally{globalThis.fetch=originalFetch;await w.db.close();}
});

test('DOTS-090 approval binds exact sender, audience, channel, budget, message revision and schedule; any drift makes it stale',async()=>{
 const w=await build();try{
  const c=await prepared(w);await w.studio.validate(c.id);await w.studio.simulate(c.id);
  const request=await w.studio.requestApproval(c.id);const payload=(await w.db.query('SELECT proposed_payload,payload_hash FROM app.action_approvals WHERE id=$1',[request.approval.id])).rows[0];
  for(const key of ['senderMailboxId','audienceHash','channel','totalBudgetCents','messageRevisionId','schedule'])assert.ok(key in payload.proposed_payload,key);
  assert.equal(payload.proposed_payload.messageRevisionId,c.template_revision_id);
  // an offer price-rule change between request and decision changes the binding hash
  await w.studio.setPriceRule(w.offer,{authorizedPricesCents:[4900],maxDiscountBp:500});
  await assert.rejects(w.studio.decideApproval(request.approval.id,true),/APPROVAL_STALE/);
  const reject=await approved(w).catch(e=>e);assert.ok(!(reject instanceof Error),String(reject));
  // owner rejection returns the campaign to draft and it can never be scheduled from there
  const other=await prepared(w);await w.studio.validate(other.id);await w.studio.simulate(other.id);const r2=await w.studio.requestApproval(other.id);
  const rejected=await w.studio.decideApproval(r2.approval.id,false);assert.equal(rejected.state,'draft');await assert.rejects(w.studio.schedule(other.id),/TRANSITION_NOT_ALLOWED/);await assert.rejects(w.studio.generateWork(other.id),/CAMPAIGN_NOT_ACTIVE/);
  // the active campaign stays bound: a fact edit after approval makes work generation fail closed
  const live=await active(w);
  await tenant(w.client,ctx,tx=>tx.query("UPDATE app.vetted_product_facts SET version=version+1,content=content||'{\"body\":\"Synthetic pilot customers cut onboarding time by 45% in 2025.\"}'::jsonb WHERE id=$1",[w.fact]));
  await assert.rejects(w.studio.generateWork(live.campaign.id),/APPROVAL_STALE/);
  assert.equal(await count(w.db,'SELECT count(*)::int AS n FROM app.campaign_work_items'),0);
 }finally{await w.db.close();}
});

test('DOTS-091/088 work generation is idempotent, traces exact strategy+content revisions, honours caps and never runs for paused, future or denied campaigns',async()=>{
 const w=await build();try{
  // future start: approval and scheduling succeed but activation and generation do not
  const future=await approved(w,{extra:{scheduleStartAt:'2026-12-01T15:00:00Z'}});await w.studio.schedule(future.campaign.id);
  await assert.rejects(w.studio.activate(future.campaign.id),/CAMPAIGN_NOT_STARTED/);await assert.rejects(w.studio.generateWork(future.campaign.id),/CAMPAIGN_NOT_ACTIVE/);
  assert.deepEqual(await w.studio.activateDue(),[]);
  // variants: Canadian contacts get the challenger copy revision
  let c=await prepared(w);
  const challenger=await w.studio.createTemplate({projectId:project,label:'Challenger copy'});
  const rev=(await w.studio.reviseTemplate(challenger.id,1,{subject:'For {{contact.company}}',bodyText:`{{fact:${w.fact}}} Plans from $99.`})).revision;
  c=(await w.studio.addVariant(c.id,Number(c.version),{label:'Canada challenger',strategyId:w.strategy2,templateRevisionId:rev.id,weight:1,eligibility:{countries:['CA']}})).campaign;
  assert.equal(Number(c.revision),5);
  const vv=await w.studio.validate(c.id);assert.equal(vv.campaign.state,'validated',JSON.stringify(vv.issues));await w.studio.simulate(c.id);const req=await w.studio.requestApproval(c.id);await w.studio.decideApproval(req.approval.id,true);await w.studio.schedule(c.id);await w.studio.activate(c.id);
  await w.control.pause(true);await assert.rejects(w.studio.generateWork(c.id),/OWNER_PAUSED/);await w.control.pause(false);
  const first=await w.studio.generateWork(c.id);assert.equal(first.enqueued,3);assert.deepEqual(first.excluded,{CONSENT_MISSING:2,COUNTRY_NOT_IN_CAMPAIGN:1});
  const second=await w.studio.generateWork(c.id);assert.equal(second.enqueued,0);assert.equal(second.alreadyQueued,3);
  const items=(await w.db.query('SELECT w.*,t.payload,t.kind,t.available_at FROM app.campaign_work_items w JOIN app.task_queue t ON t.id=w.task_id ORDER BY w.created_at')).rows;
  assert.equal(items.length,3);
  for(const item of items){
   assert.equal(item.kind,'follow_up');assert.equal(item.payload.mode,'simulation');assert.equal(item.campaign_revision,Number(c.revision));assert.equal(item.payload.templateRevisionId,item.template_revision_id);assert.equal(item.payload.strategyId,item.strategy_id);
   const canadian=item.contact_id===w.contacts[2];assert.equal(item.template_revision_id,canadian?rev.id:c.template_revision_id);assert.equal(item.strategy_id,canadian?w.strategy2:w.strategy);
  }
  await assert.rejects(w.db.query('UPDATE app.campaign_work_items SET template_revision_id=NULL'),/append-only/);
  await assert.rejects(w.db.query("UPDATE app.campaign_variants SET template_revision_id=$1",[c.template_revision_id]),/immutable/);
  // a later suppression is honoured, and the frequency cap stops a second campaign from re-contacting the same people
  await w.sales.suppressContact(w.contacts[0]);
  const second2=await prepared(w);assert.ok((await w.studio.validate(second2.id)).issues.some(i=>i.code==='NO_ELIGIBLE_CONTACTS'));
  assert.deepEqual((await w.studio.simulate(second2.id)).audience.exclusionCounts,{FREQUENCY_CAP:2,CONSENT_MISSING:2,COUNTRY_NOT_IN_CAMPAIGN:1});
  const timeline=(await w.studio.detail(c.id));assert.equal(timeline.funnel.find(f=>f.stage==='scheduled').value,3);assert.equal(timeline.funnel.find(f=>f.stage==='sent').value,0);
  assert.ok(timeline.funnel.every(f=>f.source.length>10));assert.equal(timeline.excluded.find(e=>e.contactId===w.contacts[0]).reason,'SUPPRESSED');assert.ok(timeline.timeline.some(e=>e.event_type==='campaign.work_generated'));assert.equal(timeline.approvalFresh,true);
 }finally{await w.db.close();}
});

test('DOTS-093 draft->review->approved->queued->paused: no claim, send or paid request happens in prohibited states',async()=>{
 const w=await build();try{
  const {campaign}=await active(w);await w.studio.generateWork(campaign.id);
  await tenant(w.client,ctx,tx=>tx.query('UPDATE app.policy_controls SET outbound_enabled=true WHERE organization_id=$1',[org]));
  const dispatch=()=>tenant(w.client,ctx,tx=>assertCampaignDispatchable(tx,ctx,campaign.id,Number(campaign.revision),NOW));
  const ok=await dispatch();assert.equal(ok.approvalId,campaign.approval_id);assert.equal(ok.senderMailboxId,w.mailbox);
  await assert.rejects(tenant(w.client,ctx,tx=>assertCampaignDispatchable(tx,ctx,campaign.id,Number(campaign.revision)-1,NOW)),/CAMPAIGN_REVISION_MISMATCH/);
  await assert.rejects(tenant(w.client,ctx,tx=>assertCampaignDispatchable(tx,ctx,campaign.id,Number(campaign.revision),new Date('2026-11-11T03:00:00Z'))),/OUTSIDE_SENDING_WINDOW/);
  const paused=await w.studio.pause(campaign.id);assert.equal(paused.state,'paused');
  assert.equal(await count(w.db,"SELECT count(*)::int AS n FROM app.task_queue WHERE state='waiting' AND last_reason='CAMPAIGN_PAUSED'"),3);
  await assert.rejects(dispatch(),/CAMPAIGN_NOT_ACTIVE/);await assert.rejects(w.studio.generateWork(campaign.id),/CAMPAIGN_NOT_ACTIVE/);
  // owner pause/resume must not release campaign-paused work
  await w.control.pause(true);await w.control.pause(false);assert.equal(await count(w.db,"SELECT count(*)::int AS n FROM app.task_queue WHERE state='queued'"),0);
  let requests=0;const transport=async()=>{requests++;return Response.json({});};
  assert.equal(await runOneTask(w.client,ctx,'campaign-test-worker',{},transport),null);assert.equal(requests,0);
  // a delivery attempt for a paused campaign is refused before any provider request
  const conversation=await w.sales.createConversation(w.contacts[0],'Synthetic thread',project);const message=await w.sales.draftMessage(conversation.id,'Synthetic subject','Synthetic body',campaign.id);
  const messageApproval=await w.sales.messageApproval(message.id);await w.control.decideApproval(messageApproval.id,true);
  const env={EMAIL_DELIVERY_ENABLED:'true',EMAIL_DELIVERY_TOKEN:'synthetic-key',EMAIL_BILLING_MODE:'free',EMAIL_FREE_PLAN_CONFIRMED:'true',EMAIL_COST_CENTS:'0',OUTREACH_POLICY_AUTHORIZATION_ID:'synthetic-policy',SENDER_VERIFICATION_REFERENCE:'synthetic',UNSUBSCRIBE_SIGNING_KEY:'synthetic-signing',APP_ORIGIN:'https://example.invalid',EMAIL_ALLOWED_JURISDICTIONS:'US'};
  await assert.rejects(new DeliveryGateway(w.client,ctx,env,transport,()=>NOW).send(message.id),/CAMPAIGN_NOT_APPROVED/);assert.equal(requests,0);
  // resuming keeps the approval binding and releases held work exactly once
  const resumed=await w.studio.resume(campaign.id);assert.equal(resumed.state,'active');assert.equal(await count(w.db,"SELECT count(*)::int AS n FROM app.task_queue WHERE state='queued'"),3);
  // worker processes campaign work only as simulation: no provider request, no spend
  const outcome=await runOneTask(w.client,ctx,'campaign-test-worker',{MODEL_API_ENABLED:'true'},transport);assert.equal(outcome.state,'completed');assert.equal(requests,0);
  assert.equal(await count(w.db,"SELECT count(*)::int AS n FROM app.money_entries WHERE source='provider'"),0);
  // an edit while paused cancels unsent work and requires re-approval before any dispatch
  await w.studio.pause(campaign.id);const current=(await w.db.query('SELECT version FROM app.campaigns WHERE id=$1',[campaign.id])).rows[0];
  await w.studio.saveDraft(campaign.id,Number(current.version),{dailyLimit:4});
  assert.equal(await count(w.db,"SELECT count(*)::int AS n FROM app.task_queue WHERE state IN ('queued','waiting')"),0);
  await assert.rejects(w.studio.resume(campaign.id),/TRANSITION_NOT_ALLOWED/);await assert.rejects(dispatch(),/CAMPAIGN_NOT_ACTIVE/);
  const done=await active(w,{extra:{frequencyCap:10,cadenceDays:90}});assert.equal((await w.studio.complete(done.campaign.id)).state,'completed');await assert.rejects(w.studio.generateWork(done.campaign.id),/CAMPAIGN_NOT_ACTIVE/);
 }finally{await w.db.close();}
});

test('DOTS-093 budget exhaustion stops work generation and dispatch without creating spend',async()=>{
 const w=await build();try{
  await w.control.setBudget(1000,'synthetic-owner-authorization',1000);
  const {campaign}=await active(w,{budget:{totalCents:200,perMessageMaxCents:100,authorizationRef:'synthetic-owner-authorization'}});
  const first=await w.studio.generateWork(campaign.id);assert.equal(first.enqueued,2);assert.deepEqual(first.limitedBy,['budget']);assert.equal(first.deferred,1);
  await assert.rejects(w.studio.generateWork(campaign.id),/CAMPAIGN_BUDGET_EXHAUSTED/);
  assert.equal(await count(w.db,'SELECT count(*)::int AS n FROM app.campaign_work_items'),2);
  assert.equal(await count(w.db,'SELECT count(*)::int AS n FROM app.money_entries'),0);assert.equal(await count(w.db,'SELECT count(*)::int AS n FROM app.budget_reservations'),0);
  const detail=await w.studio.detail(campaign.id);assert.equal(detail.expenses.committedMaxCents,200);assert.equal(detail.expenses.providerCents,0);
  // a budget larger than the owner-funded spending policy cannot be validated
  const unfunded=await prepared(w,{budget:{totalCents:5000,perMessageMaxCents:100,authorizationRef:'synthetic-owner-authorization'}});
  assert.ok((await w.studio.validate(unfunded.id)).issues.some(i=>i.code==='BUDGET_NOT_FUNDED'));
 }finally{await w.db.close();}
});

test('DOTS-093 concurrent edits and racing generate/pause/edit flows keep versions consistent and never leave sendable work behind',async()=>{
 const w=await build({serialize:true});try{
  const c=await draft(w);
  const edits=await Promise.allSettled([w.studio.saveDraft(c.id,Number(c.version),{dailyLimit:3}),w.studio.saveDraft(c.id,Number(c.version),{dailyLimit:4}),w.studio.saveDraft(c.id,Number(c.version),{frequencyCap:2,cadenceDays:14})]);
  assert.equal(edits.filter(e=>e.status==='fulfilled').length,1);assert.ok(edits.filter(e=>e.status==='rejected').every(e=>/VERSION_CONFLICT/.test(e.reason.message)));
  assert.equal(Number((await w.db.query('SELECT revision FROM app.campaigns WHERE id=$1',[c.id])).rows[0].revision),2);
  for(const [loop,order] of [['generate','pause','generate'],['pause','generate','generate'],['generate','generate','pause']].entries()){
   const {campaign}=await active(w,{extra:{frequencyCap:10,cadenceDays:90}});
   const ops={generate:()=>w.studio.generateWork(campaign.id),pause:()=>w.studio.pause(campaign.id)};
   const outcomes=await Promise.allSettled(order.map(name=>ops[name]()));
   for(const [index,outcome] of outcomes.entries())if(outcome.status==='rejected')assert.match(outcome.reason.message,/CAMPAIGN_NOT_ACTIVE/,order[index]);
   const state=(await w.db.query('SELECT state FROM app.campaigns WHERE id=$1',[campaign.id])).rows[0].state;assert.equal(state,'paused');
   const items=(await w.db.query("SELECT w.contact_id,t.state FROM app.campaign_work_items w JOIN app.task_queue t ON t.id=w.task_id WHERE w.campaign_id=$1",[campaign.id])).rows;
   assert.equal(new Set(items.map(i=>i.contact_id)).size,items.length,'no duplicate contacts');assert.ok(items.every(i=>i.state==='waiting'),`order ${order}: ${JSON.stringify(items)}`);
   const after=await w.studio.generateWork(campaign.id).catch(e=>e.message);assert.match(after,/CAMPAIGN_NOT_ACTIVE/);
   const v=(await w.db.query('SELECT version FROM app.campaigns WHERE id=$1',[campaign.id])).rows[0].version;
   const resume=()=>w.studio.resume(campaign.id),edit=()=>w.studio.saveDraft(campaign.id,Number(v),{dailyLimit:2});
   const [first,second]=await Promise.allSettled(loop%2?[edit(),resume()]:[resume(),edit()]);const [editResult,resumeResult]=loop%2?[first,second]:[second,first];
   const final=(await w.db.query('SELECT state,approved_revision,revision FROM app.campaigns WHERE id=$1',[campaign.id])).rows[0];
   if(editResult.status==='fulfilled'){assert.equal(final.state,'draft');assert.equal(final.approved_revision,null);assert.match(resumeResult.reason.message,/TRANSITION_NOT_ALLOWED/);assert.equal(await count(w.db,"SELECT count(*)::int AS n FROM app.task_queue t JOIN app.campaign_work_items w ON w.task_id=t.id WHERE w.campaign_id=$1 AND t.state IN ('queued','waiting')",[campaign.id]),0);}
   else{assert.match(editResult.reason.message,/VERSION_CONFLICT/);assert.equal(resumeResult.status,'fulfilled');assert.equal(final.state,'active');}
   assert.ok([0,1,2].includes(loop));
  }
  let requests=0;for(let i=0;i<10;i++){const result=await runOneTask(w.runtime,ctx,'race-worker',{},async()=>{requests++;return Response.json({});});if(!result)break;}
  assert.equal(requests,0);assert.equal(await count(w.db,"SELECT count(*)::int AS n FROM app.money_entries WHERE source='provider'"),0);
 }finally{await w.db.close();}
});

test('tenant isolation: another organization cannot read, edit or generate work for a campaign',async()=>{
 const w=await build();try{
  const {campaign}=await active(w);
  const other='66666666-6666-4666-8666-666666666666',otherMember='77777777-7777-4777-8777-777777777777';
  await w.db.query("INSERT INTO app.organizations(id,slug,display_name) VALUES($1,'other-synthetic','Other synthetic organization')",[other]);await w.db.query("INSERT INTO app.owner_users(id,identity_subject,display_name) VALUES($1,'other-fixture','Other synthetic owner')",[otherMember]);
  await w.db.exec(`SELECT set_config('app.organization_id','${other}',false);SELECT set_config('app.audit_actor_membership_id','${otherMember}',false);`);
  await w.db.query("INSERT INTO app.memberships(id,organization_id,user_id,role) VALUES($1,$2,$1,'owner')",[otherMember,other]);
  await w.db.exec('CREATE ROLE tenant_probe NOLOGIN NOBYPASSRLS;GRANT USAGE ON SCHEMA app TO tenant_probe;GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA app TO tenant_probe;SET ROLE tenant_probe');
  const intruder=new CampaignStudio(w.client,{organizationId:other,membershipId:otherMember},{clock:()=>NOW});
  assert.deepEqual((await intruder.snapshot()).campaigns,[]);
  await assert.rejects(intruder.detail(campaign.id),/NOT_FOUND/);await assert.rejects(intruder.generateWork(campaign.id),/NOT_FOUND/);await assert.rejects(intruder.pause(campaign.id),/NOT_FOUND/);
  await assert.rejects(new CampaignStudio(w.client,{organizationId:org,membershipId:otherMember}).snapshot(),/NOT_AUTHORIZED/);
 }finally{await w.db.close();}
});

test('runtime grants 0018 allow the full studio workflow as dots_runtime without evidence deletion or identity updates',async()=>{
 const w=await build();try{
  await w.db.exec('CREATE ROLE dots_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;GRANT USAGE ON SCHEMA app TO dots_runtime;GRANT SELECT ON app.memberships,app.projects,app.agent_identities,app.agent_project_assignments,app.audit_events TO dots_runtime;GRANT INSERT ON app.audit_events TO dots_runtime;');
  await w.db.exec(await readFile(new URL('../database/runtime-grants.sql',import.meta.url),'utf8'));await w.db.exec(await readFile(new URL('../database/runtime-grants-0018.sql',import.meta.url),'utf8'));
  await w.db.exec('SET ROLE dots_runtime');
  const {campaign}=await active(w);const work=await w.studio.generateWork(campaign.id);assert.equal(work.enqueued,3);
  await w.studio.pause(campaign.id);await w.studio.resume(campaign.id);await w.sales.pauseCampaign(campaign.id);await w.studio.detail(campaign.id);await w.studio.snapshot();
  for(const table of ['message_template_revisions','campaign_audience_revisions','campaign_budget_revisions','campaign_simulations','campaign_work_items','campaign_price_exceptions','campaign_variants','offer_price_rules','message_templates'])
   assert.equal((await w.db.query("SELECT has_table_privilege('dots_runtime',$1,'DELETE') AS allowed",[`app.${table}`])).rows[0].allowed,false,table);
  for(const table of ['campaigns','message_templates','campaign_variants','offer_price_rules'])for(const column of ['id','organization_id'])
   assert.equal((await w.db.query("SELECT has_column_privilege('dots_runtime',$1,$2,'UPDATE') AS allowed",[`app.${table}`,column])).rows[0].allowed,false,`${table}.${column}`);
  assert.equal((await w.db.query("SELECT has_column_privilege('dots_runtime','app.campaign_variants','template_revision_id','UPDATE') AS allowed")).rows[0].allowed,false);
 }finally{await w.db.close();}
});

test('DOTS-083/092 route and view contracts: owner session, trusted origin, no-store, accessible notices, sandboxed previews and no raw HTML injection',async()=>{
 const route=await readFile(new URL('../apps/web/app/api/v1/campaigns/route.ts',import.meta.url),'utf8');
 for(const required of ["export const dynamic='force-dynamic'",'hasTrustedOrigin(request)','ownerSession()','private, no-store','withOperations(','REQUEST_TOO_LARGE','UNKNOWN_ACTION'])assert.ok(route.includes(required),required);
 assert.ok(route.indexOf('hasTrustedOrigin(request)')<route.indexOf('JSON.parse(raw)'));
 const view=await readFile(new URL('../apps/web/app/views/campaign-studio-view.tsx',import.meta.url),'utf8');
 for(const required of ['export function CampaignStudioView()','aria-live="polite"','role="alert"','sandbox=""','Navigation label: "Campaign Studio"','Source:','synthetic'])assert.ok(view.includes(required),required);
 assert.ok(!view.includes('dangerouslySetInnerHTML'));assert.doesNotMatch(view,/always be closing|coffee is for closers/i);
});

test('migration 0018 maps legacy states forward and back and its down migration restores the 0012 vocabulary',async()=>{
 const w=await build();try{
  const legacy=await w.sales.createCampaign({projectId:project,label:'Legacy synthetic',purpose:'product',goal:'Legacy flow'});await w.sales.setAudience(legacy.id,[w.contacts[0]]);
  await w.sales.simulateCampaign(legacy.id);assert.equal((await w.db.query('SELECT state FROM app.campaigns WHERE id=$1',[legacy.id])).rows[0].state,'validated');
  const approval=await w.sales.campaignApproval(legacy.id);assert.equal(approval.action_kind,'campaign');
  const c=await prepared(w);const aborted=await w.studio.abort(c.id);assert.equal(aborted.state,'aborted');
  await w.db.exec(await readFile(new URL('0018_campaign_studio.down.sql',migrations),'utf8'));
  const states=Object.fromEntries((await w.db.query('SELECT id,state FROM app.campaigns')).rows.map(r=>[r.id,r.state]));
  assert.equal(states[legacy.id],'simulated');assert.equal(states[c.id],'archived');
  await w.db.exec(await readFile(new URL('0018_campaign_studio.up.sql',migrations),'utf8'));
  assert.equal((await w.db.query('SELECT state FROM app.campaigns WHERE id=$1',[legacy.id])).rows[0].state,'validated');
 }finally{await w.db.close();}
});
