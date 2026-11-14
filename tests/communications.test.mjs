// DOTS-094..DOTS-109 communications track. Synthetic data only; every transport is injected and no network is used.
import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {createHmac} from 'node:crypto';
import {productionDispatchChecks,KillSwitches,SalesWorkspace,ControlPlane,CommunicationsWorkspace,DeliveryGateway,communicationsGateway,communicationDispatchChecks,tenant,digest,verifyWebhook,verifySvix,
 normalizeMessageId,parseReferences,normalizeSubject,classifyReply,stripQuotedText,sniffContentType,containsEicar,attachmentDownloadHeaders,nextAllowedSendTime,inQuietHours,deliveryLabel,normalizeInbound,signedOptOut,verifyOptOut} from '../packages/operations/dist/index.js';
import {setup,org,owner,project,ctx} from './helpers/operations-fixture.mjs';
import {preflight,verifyEvidence,checklist} from '../scripts/mailbox-canary.mjs';

const BUSINESS=new Date('2026-11-09T16:00:00Z');
const EICAR='X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
const PNG=Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,13]);
const mailEnv={EMAIL_DELIVERY_ENABLED:'true',EMAIL_DELIVERY_TOKEN:'synthetic-key',EMAIL_BILLING_MODE:'free',EMAIL_FREE_PLAN_CONFIRMED:'true',EMAIL_COST_CENTS:'0',PAID_SPEND_LIMIT_CENTS:'0',OUTREACH_POLICY_AUTHORIZATION_ID:'synthetic-policy',SENDER_VERIFICATION_REFERENCE:'synthetic-verification',UNSUBSCRIBE_SIGNING_KEY:'synthetic-signing-key',APP_ORIGIN:'https://app.example.invalid',EMAIL_ALLOWED_JURISDICTIONS:'US',EMAIL_RECEIVING_ENABLED:'true'};
const dmarc=async()=>[['v=DMARC1; p=reject; rua=mailto:dmarc@example.invalid']];

function fakeTransport(){
 const calls=[];let mode='ok',counter=0;const inbound=new Map();
 const transport=async(url,init={})=>{calls.push({url,init});
  if(url==='https://api.resend.com/domains')return Response.json({data:[{name:'example.invalid',status:'verified'}]});
  if(url.startsWith('https://api.resend.com/emails/receiving/')){const item=inbound.get(url.split('/').pop());return item?Response.json(item):new Response('',{status:404});}
  if(url==='https://api.resend.com/emails'){if(mode==='timeout'){throw new DOMException('The operation timed out','TimeoutError');}if(mode==='reject')return Response.json({message:'invalid'},{status:422});if(mode==='server')return new Response('',{status:500});counter++;return Response.json({id:`re_synthetic_${counter}`});}
  throw new Error(`unexpected network call ${url}`);
 };
 return {transport,calls,sends:()=>calls.filter(c=>c.url==='https://api.resend.com/emails'),setMode:m=>{mode=m;},inbound};
}
/** Wraps PGlite so that whole transactions serialize; lets Promise.all exercise interleavings safely on one connection. */
function serialized(db){let chain=Promise.resolve(),release=null;return {query:async(q,v)=>{if(q==='BEGIN'){let done;const previous=chain;chain=new Promise(r=>{done=r;});await previous;release=done;return db.query(q,v);}const result=await db.query(q,v).catch(error=>{throw error;});if(q==='COMMIT'||q==='ROLLBACK'){const r=release;release=null;r?.();}return result;}};}

async function world(options={}){
 const base=await setup();const {db,control}=base;const client=options.serial?serialized(db):base.client;
 await control.pause(false);await db.query('UPDATE app.policy_controls SET outbound_enabled=true WHERE organization_id=$1',[org]);
 const sales=new SalesWorkspace(client,ctx);const net=fakeTransport();const env={...mailEnv,...(options.env??{})};let now=options.now??BUSINESS;const clock=()=>now;
 const comms=new CommunicationsWorkspace(client,ctx,env,net.transport,clock);
 const campaign=await sales.createCampaign({projectId:project,label:'Synthetic campaign',purpose:'product',goal:'Public fixture',dailyLimit:20,cadenceDays:7});
 const contacts=[];for(let i=0;i<(options.contacts??3);i++)contacts.push(await sales.addContact({name:`Synthetic Prospect ${i}`,email:`prospect${i}@example.invalid`,source:'Synthetic fixture',consent:'opted_in',consentEvidence:'Synthetic evidence',jurisdiction:'US'}));
 await sales.setAudience(campaign.id,contacts.map(c=>c.id));
 await tenant(client,ctx,async tx=>{await tx.query("UPDATE app.campaigns SET state='active',approved_revision=revision WHERE id=$1",[campaign.id]);await tx.query("INSERT INTO app.offers(organization_id,project_id,label,content,updated_by_membership_id) VALUES($1,$2,'Synthetic offer','{}',$3)",[org,project,owner]);const offer=(await tx.query('SELECT id FROM app.offers WHERE organization_id=$1 LIMIT 1',[org])).rows[0];await tx.query("INSERT INTO app.vetted_product_facts(organization_id,project_id,offer_id,label,content,updated_by_membership_id) VALUES($1,$2,$3,'Public fixture',$4::jsonb,$5)",[org,project,offer.id,JSON.stringify({body:'Synthetic public fact',verifiedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+86400000).toISOString()}),owner]);});
 let mailbox=null;
 if(options.ready!==false){await comms.setSenderProfile({legalName:'Synthetic Labs LLC',postalAddress:'100 Synthetic Way, Testville 00000'});mailbox=await comms.connectMailbox({label:'Owner sender',email:'owner@example.invalid',senderName:'Synthetic Owner',provider:'resend'});
  await new DeliveryGateway(client,ctx,env,net.transport,clock).verifyMailbox(mailbox.id);await comms.checkDmarc(mailbox.id,dmarc);await comms.grantMailboxConsent(mailbox.id,'synthetic-owner-consent');}
 const conversations=[];for(const contact of contacts)conversations.push(await sales.createConversation(contact.id,`Hello ${contact.display_name}`,project));
 net.calls.length=0;
 return {db,client,control,sales,comms,net,env,campaign,contacts,conversations,mailbox,setNow:value=>{now=value;},clock};
}
async function approvedDraft(w,index=0,extra={}){const draft=await w.comms.composeDraft({conversationId:w.conversations[index].id,mode:'new',subject:'Synthetic introduction',body:'Hello {{contact_name}}, a synthetic note.',campaignId:w.campaign.id,...extra});await w.comms.approveExact(draft.id,draft.revisionHash);return draft;}
const one=async(db,sql,values=[])=>(await db.query(sql,values)).rows[0];
const all=async(db,sql,values=[])=>(await db.query(sql,values)).rows;

test('DOTS-094 mailbox onboarding stays disabled until owner consent, records sender authentication and token rotation, and has no global shared sender',async()=>{
 const w=await world({ready:false});try{
  const {comms,db,client,env,net}=w;
  await assert.rejects(comms.connectMailbox({label:'Bad',email:'owner@example.invalid',senderName:'Owner',provider:'gmail',tokenRef:'ya29.raw-token-value',scopes:['https://www.googleapis.com/auth/gmail.send']}),/INVALID_TOKEN_REFERENCE/);
  await assert.rejects(comms.connectMailbox({label:'Bad',email:'owner@example.invalid',senderName:'Owner',provider:'gmail',tokenRef:'vault:mail/owner',scopes:['https://mail.google.com/']}),/SCOPE_NOT_ALLOWED/);
  const oauth=await comms.connectMailbox({label:'Owner Gmail',email:'gmail-owner@example.invalid',senderName:'Synthetic Owner',provider:'gmail',tokenRef:'vault:mail/gmail-owner',scopes:['https://www.googleapis.com/auth/gmail.send']});
  assert.equal(oauth.status,'disabled');assert.equal(oauth.connection_kind,'oauth');
  const mailbox=await comms.connectMailbox({label:'Owner sender',email:'owner@example.invalid',senderName:'Synthetic Owner',provider:'resend'});assert.equal(mailbox.status,'disabled');
  await assert.rejects(comms.grantMailboxConsent(mailbox.id,'synthetic-consent'),/SENDER_PROFILE_REQUIRED/);
  await assert.rejects(comms.setSenderProfile({legalName:'Synthetic Labs',postalAddress:'No number here'}),/POSTAL_ADDRESS_INCOMPLETE/);
  await comms.setSenderProfile({legalName:'Synthetic Labs LLC',postalAddress:'100 Synthetic Way, Testville 00000'});
  const verified=await new DeliveryGateway(client,ctx,env,net.transport,w.clock).verifyMailbox(mailbox.id);assert.deepEqual([verified.spf,verified.dkim,verified.dmarc],['pass','pass','unknown']);
  let row=await one(db,'SELECT * FROM app.mailboxes WHERE id=$1',[mailbox.id]);assert.equal(row.verified,true);assert.equal(row.status,'disabled','provider verification alone never activates a sender');
  const consent=await comms.grantMailboxConsent(mailbox.id,'synthetic-consent');assert.equal(consent.status,'disabled');assert.deepEqual(consent.waitingFor,['sender_authentication']);
  assert.equal((await comms.checkDmarc(mailbox.id,async()=>{throw Object.assign(new Error('nx'),{code:'ENOTFOUND'});})).dmarc,'fail');
  assert.equal((await comms.checkDmarc(mailbox.id,dmarc)).dmarc,'pass');row=await one(db,'SELECT * FROM app.mailboxes WHERE id=$1',[mailbox.id]);assert.equal(row.status,'active');assert.match(row.business_address,/100 Synthetic Way/);
  const auth=await comms.recordSenderAuthentication(mailbox.id,{records:[{record:'SPF',status:'verified'},{record:'DKIM',status:'failed'},{record:'DMARC',status:'verified'}]});assert.equal(auth.dkim,'fail');
  row=await one(db,'SELECT * FROM app.mailboxes WHERE id=$1',[mailbox.id]);assert.equal(row.status,'paused');assert.equal(row.pause_reason,'SENDER_AUTHENTICATION_INCOMPLETE');
  assert.equal((await all(db,'SELECT * FROM app.mailbox_auth_checks WHERE mailbox_id=$1',[mailbox.id])).length,4);
  await assert.rejects(db.query('UPDATE app.mailbox_auth_checks SET spf_status=$1',['pass']),/append-only/);
  await assert.rejects(comms.rotateMailboxToken(oauth.id,'not a reference'),/INVALID_TOKEN_REFERENCE/);
  await comms.rotateMailboxToken(oauth.id,'vault:mail/gmail-owner-v2',new Date(Date.now()+30*86400000).toISOString());
  const rotations=await all(db,'SELECT token_ref FROM app.mailbox_credential_rotations WHERE mailbox_id=$1 ORDER BY rotated_at',[oauth.id]);assert.deepEqual(rotations.map(r=>r.token_ref),['vault:mail/gmail-owner','vault:mail/gmail-owner-v2']);
  // No global shared sender: a second tenant cannot consent to a sender address another tenant already consented to.
  const other='66666666-6666-4666-8666-666666666666',otherMember='77777777-7777-4777-8777-777777777777',otherCtx={organizationId:other,membershipId:otherMember};
  await db.query("INSERT INTO app.organizations(id,slug,display_name) VALUES($1,'other-synthetic','Other synthetic organization')",[other]);await db.query("INSERT INTO app.owner_users(id,identity_subject,display_name) VALUES($1,'other-fixture','Other synthetic owner')",[otherMember]);
  await db.exec(`SELECT set_config('app.organization_id','${other}',false);SELECT set_config('app.audit_actor_membership_id','${otherMember}',false);`);await db.query("INSERT INTO app.memberships(id,organization_id,user_id,role) VALUES($1,$2,$1,'owner')",[otherMember,other]);
  const foreign=new CommunicationsWorkspace(client,otherCtx,env,net.transport,w.clock);await foreign.setSenderProfile({legalName:'Other Synthetic LLC',postalAddress:'200 Other Road, Elsewhere 11111'});
  const copy=await foreign.connectMailbox({label:'Copy',email:'OWNER@example.invalid',senderName:'Impostor',provider:'resend'});await assert.rejects(foreign.grantMailboxConsent(copy.id,'other-consent'),/SENDER_ALREADY_CLAIMED/);
  assert.equal(net.calls.filter(c=>c.url==='https://api.resend.com/emails').length,0);
 }finally{await w.db.close();}
});

test('DOTS-095 signed events: forged and stale signatures fail, duplicates and conflicts are idempotent, out-of-order receipts never fabricate state, polling is bounded',async()=>{
 const w=await world();try{
  const {comms,db,net}=w;const secret='synthetic-webhook-secret',raw='{"id":"evt"}',now=Date.now(),t=Math.floor(now/1000);const sig=createHmac('sha256',secret).update(`${t}.${raw}`).digest('hex');
  assert.equal(verifyWebhook(raw,`t=${t},v1=${sig}`,secret,now),true);assert.equal(verifyWebhook(raw,`t=${t},v1=${'0'.repeat(64)}`,secret,now),false,'forged');assert.equal(verifyWebhook(raw,`t=${t},v1=${sig}`,secret,now+301000),false,'replay window');
  const svixKey=Buffer.alloc(24,9);const svixSig=createHmac('sha256',svixKey).update(`msg_1.${t}.${raw}`).digest('base64');assert.equal(verifySvix(raw,{id:'msg_1',timestamp:String(t),signature:`v1,${svixSig}`},`whsec_${svixKey.toString('base64')}`,now),true);assert.equal(verifySvix(raw,{id:'msg_2',timestamp:String(t),signature:`v1,${svixSig}`},`whsec_${svixKey.toString('base64')}`,now),false);
  // A delivery receipt for a message we never recorded is quarantined for the owner, not attached to anything.
  const earlyPayload={type:'message.delivered',provider_message_id:'re_unknown',occurred_at:new Date().toISOString()};const early=await comms.ingestSignedEvent('evt_early',earlyPayload);assert.equal(early.matched,false);
  assert.equal((await all(db,"SELECT * FROM app.reconciliation_items WHERE kind='unmatched_receipt' AND state='open'")).length,1);
  assert.equal((await comms.ingestSignedEvent('evt_early',earlyPayload)).duplicate,true);
  await assert.rejects(comms.ingestSignedEvent('evt_early',{type:'message.bounced',provider_message_id:'re_unknown'}),/RECEIPT_CONFLICT/);
  await assert.rejects(comms.ingestSignedEvent('evt_bad',{type:'message.teleported',provider_message_id:'re_x'}),/UNSUPPORTED_EVENT/);
  // Out-of-order: delivered arrives before accepted; a late "accepted" never downgrades.
  const draft=await approvedDraft(w,0);const sent=await comms.send(draft.id);
  await comms.ingestSignedEvent('evt_d1',{type:'message.delivered',provider_message_id:sent.providerMessageId});await comms.ingestSignedEvent('evt_a1',{type:'message.accepted',provider_message_id:sent.providerMessageId});
  let message=await one(db,'SELECT state,delivery_status FROM app.messages WHERE id=$1',[draft.id]);assert.equal(message.delivery_status,'delivered');assert.equal(message.state,'delivered');
  // Forged inbound: unauthenticated sender is quarantined and escalated instead of appearing as a reply.
  const forged=await comms.ingestSignedEvent('evt_forged',{type:'message.received',message:{id:'in_forged',from:'Prospect <prospect0@example.invalid>',to:['owner@example.invalid'],subject:'Re: Synthetic introduction',text:'Yes, I am interested!',in_reply_to:`<${(await one(db,'SELECT message_id_header FROM app.messages WHERE id=$1',[draft.id])).message_id_header}>`,headers:{'authentication-results':'mx.example.invalid; spf=fail; dkim=fail; dmarc=fail'}}});
  message=await one(db,'SELECT state,authentication FROM app.messages WHERE id=$1',[forged.messageId]);assert.equal(message.state,'quarantined');assert.equal(message.authentication,'fail');
  assert.equal((await all(db,"SELECT * FROM app.reconciliation_items WHERE kind='unverified_inbound'")).length,1);
  const view=await comms.snapshot(forged.conversationId);assert.equal(view.conversation.messages.find(m=>m.id===forged.messageId).label.label,'Quarantined: sender authentication failed');
  // Mail to a recipient that is not a configured mailbox is refused.
  await assert.rejects(comms.ingestSignedEvent('evt_wrong_rcpt',{type:'message.received',message:{id:'in_wrong',from:'x@example.invalid',to:['someone-else@example.invalid'],subject:'Hi',text:'Hello'}}),/INBOUND_RECIPIENT_NOT_CONFIGURED/);
  // Bounded polling with cursor, interval and idempotent duplicates.
  const pages={null:{messages:[{id:'poll_1',from:'poller@example.invalid',to:['owner@example.invalid'],subject:'Poll one',text:'First',message_id:'<poll-1@example.invalid>'},{id:'poll_x',from:'bad',to:['owner@example.invalid'],subject:'Bad',text:'x'}],nextCursor:'c1'},c1:{messages:[{id:'poll_2',from:'poller@example.invalid',to:['owner@example.invalid'],subject:'Poll two',text:'Second',message_id:'<poll-2@example.invalid>'},{id:'poll_1_copy',from:'poller@example.invalid',to:['owner@example.invalid'],subject:'Poll one',text:'First',message_id:'<poll-1@example.invalid>'}],nextCursor:'c2'},c2:{messages:[{id:'poll_3',from:'poller@example.invalid',to:['owner@example.invalid'],subject:'Poll three',text:'Third'}],nextCursor:'c3'}};
  const seen=[];const poller=async({cursor})=>{seen.push(cursor);return pages[String(cursor)]??{messages:[],nextCursor:null};};
  const polled=await comms.pollMailbox(w.mailbox.id,poller,{maxPages:2});assert.deepEqual(polled,{imported:2,duplicates:1,rejected:1,pages:2});assert.deepEqual(seen,[null,'c1']);
  assert.equal((await one(db,'SELECT cursor FROM app.mailbox_sync_cursors WHERE mailbox_id=$1',[w.mailbox.id])).cursor,'c2');
  assert.equal((await comms.pollMailbox(w.mailbox.id,poller)).skipped,'POLL_INTERVAL');
  w.setNow(new Date(BUSINESS.getTime()+120000));const second=await comms.pollMailbox(w.mailbox.id,poller);assert.equal(second.imported,1);assert.deepEqual(seen.slice(2),['c2','c3']);
  assert.equal(net.sends().length,1);
 }finally{await w.db.close();}
});

test('DOTS-096 canonical threading normalizes headers, attaches replies and CC participants to the right contact and campaign, and duplicate imports are idempotent',async()=>{
 assert.equal(normalizeMessageId(' <Abc.123@Mail.Example.INVALID> '),'Abc.123@mail.example.invalid');assert.equal(normalizeMessageId('no-at-sign'),null);
 assert.deepEqual(parseReferences('<a@x.invalid> <b@X.invalid>\n <a@x.invalid>'),['a@x.invalid','b@x.invalid']);assert.equal(normalizeSubject('RE: Fwd: AW:  Synthetic   Intro'),'synthetic intro');
 assert.throws(()=>normalizeInbound({id:'x',from:'not an address',to:[]}),/INBOUND_SENDER_INVALID/);
 const w=await world();try{
  const {comms,db}=w;const draft=await approvedDraft(w,0);await comms.send(draft.id);const header=(await one(db,'SELECT message_id_header FROM app.messages WHERE id=$1',[draft.id])).message_id_header;
  assert.match(header,/^dots\.[0-9a-f-]+@example\.invalid$/);
  const reply={id:'in_reply_1',from:'Synthetic Prospect <prospect0@example.invalid>',to:['owner@example.invalid'],cc:['Colleague <colleague@example.invalid>'],subject:'RE: Synthetic introduction',text:'Could you share pricing?\n\nOn Mon, Owner wrote:\n> Hello',message_id:'<reply-1@example.invalid>',in_reply_to:`<${header}>`,references:`<${header}>`};
  const imported=await comms.ingestSignedEvent('evt_reply_1',{type:'message.received',message:reply});assert.equal(imported.conversationId,w.conversations[0].id);assert.equal(imported.thread,'references');assert.equal(imported.triage,'question');
  const conv=await one(db,'SELECT campaign_id,needs_owner,priority,sla_due_at FROM app.conversations WHERE id=$1',[w.conversations[0].id]);assert.equal(conv.campaign_id,w.campaign.id);assert.equal(conv.needs_owner,true);assert.ok(conv.sla_due_at);
  const stored=await one(db,'SELECT campaign_id,cc_addresses,from_address,in_reply_to_header,references_headers FROM app.messages WHERE id=$1',[imported.messageId]);assert.equal(stored.campaign_id,w.campaign.id);assert.deepEqual(stored.cc_addresses,['colleague@example.invalid']);assert.equal(stored.in_reply_to_header,header);
  // Same Message-ID re-delivered under another provider id and event id: no second message.
  const again=await comms.ingestSignedEvent('evt_reply_1_redelivery',{type:'message.received',message:{...reply,id:'in_reply_1_copy'}});assert.equal(again.duplicate,true);
  assert.equal((await one(db,"SELECT count(*)::int AS n FROM app.messages WHERE direction='inbound'")).n,1);
  // A CC participant replying in-thread attaches to the same conversation.
  const cc=await comms.ingestSignedEvent('evt_cc',{type:'message.received',message:{id:'in_cc',from:'colleague@example.invalid',to:['owner@example.invalid'],subject:'Re: Synthetic introduction',text:'Adding my thoughts.',message_id:'<cc-1@example.invalid>',in_reply_to:'<reply-1@example.invalid>',references:`<${header}> <reply-1@example.invalid>`}});assert.equal(cc.conversationId,w.conversations[0].id);
  // A non-participant citing our Message-ID is not attached to the prospect's thread.
  const stranger=await comms.ingestSignedEvent('evt_stranger',{type:'message.received',message:{id:'in_stranger',from:'stranger@example.invalid',to:['owner@example.invalid'],subject:'Re: Synthetic introduction',text:'Hi',in_reply_to:`<${header}>`}});
  assert.notEqual(stranger.conversationId,w.conversations[0].id);assert.equal((await all(db,"SELECT * FROM app.reconciliation_items WHERE kind='thread_mismatch'")).length,1);
  // Header-less follow-up falls back to normalized subject within the contact's open thread.
  const plain=await comms.ingestSignedEvent('evt_plain',{type:'message.received',message:{id:'in_plain',from:'prospect1@example.invalid',to:['owner@example.invalid'],subject:'Re: hello synthetic prospect 1',text:'Plain client reply'}});assert.equal(plain.conversationId,w.conversations[1].id);assert.equal(plain.thread,'subject');
  // Resend receiving path normalizes the same way and stays idempotent.
  w.net.inbound.set('rcv_1',{from:'prospect2@example.invalid',to:['owner@example.invalid'],subject:'Question',text:'What does it cost?',headers:{'message-id':'<rcv-1@example.invalid>'}});
  const gateway=communicationsGateway(w.client,ctx,w.env,w.net.transport,w.clock);await gateway.ingestEmail('svix_rcv_1',{type:'email.received',data:{email_id:'rcv_1'}});assert.equal((await gateway.ingestEmail('svix_rcv_1',{type:'email.received',data:{email_id:'rcv_1'}})).duplicate,true);
  assert.equal((await one(db,"SELECT count(*)::int AS n FROM app.messages WHERE message_id_header='rcv-1@example.invalid'")).n,1);
 }finally{await w.db.close();}
});

test('DOTS-097 snapshot gives accurate sender, time and delivery labels and an owner-priority thread order; the view is three-pane, accessible and quote-free',async()=>{
 assert.equal(deliveryLabel({direction:'outbound',state:'draft'}).label,'Drafted');assert.equal(deliveryLabel({direction:'outbound',state:'sent',provider_message_id:'re_1'}).label,'Provider accepted');
 assert.equal(deliveryLabel({direction:'outbound',state:'delivered',delivery_status:'delivered',provider_message_id:'re_1'}).label,'Delivered');assert.equal(deliveryLabel({direction:'outbound',state:'sent',delivery_status:'bounced',provider_message_id:'re_1'}).label,'Bounced');
 assert.equal(deliveryLabel({direction:'outbound',state:'quarantined'}).label,'Uncertain · needs reconciliation');assert.match(deliveryLabel({direction:'outbound',state:'sent',provider_message_id:'re_9'}).evidence,/re_9/);
 const w=await world();try{
  const {comms}=w;const draft=await approvedDraft(w,0);const result=await comms.send(draft.id);await comms.ingestSignedEvent('evt_del',{type:'message.delivered',provider_message_id:result.providerMessageId});
  await comms.ingestSignedEvent('evt_q',{type:'message.received',message:{id:'in_q',from:'prospect1@example.invalid',to:['owner@example.invalid'],subject:'Question',text:'How does it work?'}});
  const view=await comms.snapshot(w.conversations[0].id);const labels=view.conversation.messages.map(m=>m.label.label);assert.deepEqual(labels,['Delivered']);
  assert.equal(view.conversation.messages[0].from_address,'owner@example.invalid');assert.ok(view.conversation.messages[0].sent_at);assert.equal(view.conversation.contact_name,'Synthetic Prospect 0');assert.equal(view.conversation.campaign_label,null);
  assert.equal(view.threads[0].needs_owner,true,'threads needing the owner sort first');assert.equal(view.threads[0].last_triage,'question');
  assert.equal(view.senderProfile.legal_name,'Synthetic Labs LLC');assert.equal(view.mailboxes[0].dmarc_status,'pass');assert.ok(!JSON.stringify(view).includes('synthetic-key'));
 }finally{await w.db.close();}
 const source=await readFile(new URL('../apps/web/app/views/conversation-center-view.tsx',import.meta.url),'utf8');
 assert.match(source,/export function ConversationCenterView/);assert.match(source,/\/api\/v1\/communications/);for(const pane of ['Thread list','Transcript','Contact and campaign context'])assert.match(source,new RegExp(pane));
 assert.match(source,/aria-live="polite"/);assert.match(source,/role="alert"/);assert.match(source,/data-pane=/);assert.doesNotMatch(source,/always be closing|coffee is for closers/i);
 const css=await readFile(new URL('../apps/web/app/views/conversation-center-view.css',import.meta.url),'utf8');assert.match(css,/@media\(max-width:900px\)/);assert.match(css,/min-height:44px/);
});

test('DOTS-098 versioned drafts keep source evidence, headers, recipients, variables and expiry; AI text is labelled and never presented as verified fact',async()=>{
 const w=await world();try{
  const {comms,db}=w;const fact=await one(db,'SELECT id FROM app.vetted_product_facts LIMIT 1');
  await assert.rejects(comms.composeDraft({conversationId:w.conversations[0].id,subject:'Hi',body:'Hello {{missing_value}}'}),/UNRESOLVED_VARIABLE/);
  await assert.rejects(comms.composeDraft({conversationId:w.conversations[0].id,subject:'Hi',body:'Hi',sourceEvidence:[{kind:'vetted_fact',ref:'99999999-9999-4999-8999-999999999999'}]}),/EVIDENCE_NOT_FOUND/);
  await assert.rejects(comms.composeDraft({conversationId:w.conversations[0].id,subject:'Hi',body:'Hi',expiresAt:new Date(BUSINESS.getTime()+40*86400000).toISOString()}),/INVALID_EXPIRY/);
  const inbound=await comms.ingestSignedEvent('evt_ai_src',{type:'message.received',message:{id:'in_ai',from:'prospect0@example.invalid',to:['owner@example.invalid'],subject:'Hello Synthetic Prospect 0',text:'Tell me more?'}});
  const ai=await comms.saveModelSuggestion(w.conversations[0].id,inbound.messageId,'Our product handles synthetic workflows.','synthetic-model-ref');
  const preview=await comms.preview(ai.id);assert.equal(preview.aiGenerated,true);assert.equal(preview.authorKind,'model');assert.match(preview.provenance,/not verified fact/);assert.match(preview.subject,/^Re: /);
  const draft=await comms.composeDraft({conversationId:w.conversations[0].id,subject:'Offer for {{contact_name}}',body:'Hi {{contact_name}}, {{detail}}',variables:{detail:'see the vetted fact'},cc:['partner@example.invalid'],sourceEvidence:[{kind:'vetted_fact',ref:fact.id,label:'Public fixture'}],campaignId:w.campaign.id});
  const revision=await one(db,'SELECT * FROM app.message_revisions WHERE message_id=$1 AND revision=1',[draft.id]);assert.equal(revision.subject,'Offer for Synthetic Prospect 0');assert.deepEqual(revision.to_addresses,['prospect0@example.invalid']);assert.deepEqual(revision.cc_addresses,['partner@example.invalid']);
  assert.deepEqual(revision.variables,{detail:'see the vetted fact'});assert.equal(revision.source_evidence[0].ref,fact.id);assert.match(revision.headers.messageId,/@example\.invalid$/);assert.ok(new Date(revision.expires_at)>BUSINESS);assert.equal(revision.ai_generated,false);
  const edited=await comms.reviseDraft(ai.id,1,{body:'Owner-edited synthetic suggestion.'});assert.equal(edited.revision,2);assert.equal((await comms.preview(ai.id)).aiGenerated,true,'owner edits do not launder AI provenance');
  await assert.rejects(comms.reviseDraft(ai.id,1,{body:'stale'}),/STALE_REVISION/);
  await assert.rejects(db.query("UPDATE app.message_revisions SET body='tampered'"),/append-only/);await assert.rejects(db.query("INSERT INTO app.message_revisions(organization_id,message_id,revision,subject,body,to_addresses,reply_mode,author_kind,ai_generated,expires_at,content_hash,created_by_membership_id) VALUES($1,$2,9,'s','b','{}','new','model',false,app.utc_now(),$3,$4)",[org,ai.id,'a'.repeat(64),owner]),/check/);
 }finally{await w.db.close();}
});

test('DOTS-099 exact-message approval: the previewed revision is what is approved, any content edit invalidates it, stale previews are refused',async()=>{
 const w=await world();try{
  const {comms,db,net}=w;const draft=await comms.composeDraft({conversationId:w.conversations[0].id,subject:'Synthetic intro',body:'Version one',campaignId:w.campaign.id});
  const preview=await comms.preview(draft.id);assert.equal(preview.revisionHash,draft.revisionHash);assert.match(preview.plainText,/Version one\n\nSynthetic Labs LLC\n100 Synthetic Way/);assert.equal(preview.headers['List-Unsubscribe-Post'],'List-Unsubscribe=One-Click');
  await assert.rejects(comms.approveExact(draft.id,'f'.repeat(64)),/STALE_PREVIEW/);
  const approval=await comms.approveExact(draft.id,draft.revisionHash);assert.equal((await comms.preview(draft.id)).approved,true);
  const revised=await comms.reviseDraft(draft.id,1,{body:'Version two'});assert.equal(revised.approvalInvalidated,true);
  assert.equal((await one(db,'SELECT status FROM app.action_approvals WHERE id=$1',[approval.approvalId])).status,'expired');
  await assert.rejects(comms.send(draft.id),/OWNER_APPROVAL_REQUIRED/);await assert.rejects(comms.approveExact(draft.id,draft.revisionHash),/STALE_PREVIEW/);
  // Approval recorded for revision N cannot be reused after a direct tamper of the approved hash.
  await comms.approveExact(draft.id,revised.revisionHash);await db.query("UPDATE app.messages SET approved_revision_hash=$2 WHERE id=$1",[draft.id,'0'.repeat(64)]);await assert.rejects(comms.send(draft.id),/EXACT_APPROVAL_REQUIRED/);
  assert.equal(net.sends().length,0);
  await db.query('UPDATE app.messages SET approved_revision_hash=$2 WHERE id=$1',[draft.id,revised.revisionHash]);const sent=await comms.send(draft.id);assert.equal(sent.state,'sent');
  assert.equal(JSON.parse(net.sends()[0].init.body).text.startsWith('Version two'),true);
 }finally{await w.db.close();}
});

test('DOTS-100 gateway sends only when approval, suppression, sender authentication, profile, budget and identity hold; uses provider idempotency and one-click unsubscribe headers',async()=>{
 const w=await world();try{
  const {comms,db,net,client,env}=w;
  const draft=await approvedDraft(w,0,{cc:['partner@example.invalid']});const result=await comms.send(draft.id);assert.equal(result.state,'sent');
  const request=net.sends()[0];const body=JSON.parse(request.init.body);assert.equal(request.init.headers['Idempotency-Key'],`${draft.id}:${(await one(db,'SELECT content_hash FROM app.messages WHERE id=$1',[draft.id])).content_hash}`);
  assert.equal(body.from,'Synthetic Owner <owner@example.invalid>');assert.deepEqual(body.to,['prospect0@example.invalid']);assert.deepEqual(body.cc,['partner@example.invalid']);assert.match(body.headers['List-Unsubscribe'],/^<https:\/\/app\.example\.invalid\/api\/unsubscribe\?token=/);assert.equal(body.headers['List-Unsubscribe-Post'],'List-Unsubscribe=One-Click');
  assert.match(body.headers['Message-ID'],/^<dots\./);assert.match(body.text,/Synthetic Labs LLC\n100 Synthetic Way/);assert.equal(body.text.includes('synthetic-key'),false);
  const token=body.headers['List-Unsubscribe'].match(/token=([^>]+)>/)[1];assert.deepEqual(verifyOptOut(token,env.UNSUBSCRIBE_SIGNING_KEY),{org,contact:w.contacts[0].id});
  const attempt=await one(db,'SELECT * FROM app.dispatch_attempts WHERE message_id=$1',[draft.id]);assert.equal(attempt.state,'accepted');assert.equal(attempt.provider_message_id,result.providerMessageId);assert.match(attempt.receipt_hash,/^[0-9a-f]{64}$/);
  // Suppressed CC blocks dispatch even though the main recipient is fine.
  const cced=await approvedDraft(w,1,{cc:['blocked@example.invalid']});await db.query("INSERT INTO app.contact_suppressions(organization_id,email_hash,reason,source) VALUES($1,$2,'synthetic','owner')",[org,digest('blocked@example.invalid')]);await assert.rejects(comms.send(cced.id),/CONTACT_SUPPRESSED/);
  // Missing sender profile and incomplete DMARC block through the communications dispatch checks.
  const second=await approvedDraft(w,2);await db.query('DELETE FROM app.sender_profiles WHERE organization_id=$1',[org]);await assert.rejects(comms.send(second.id),/SENDER_PROFILE_REQUIRED/);
  await comms.setSenderProfile({legalName:'Synthetic Labs LLC',postalAddress:'100 Synthetic Way, Testville 00000'});
  await db.query("UPDATE app.mailboxes SET dmarc_status='pending' WHERE id=$1",[w.mailbox.id]);await assert.rejects(comms.send(second.id),/SENDER_AUTHENTICATION_INCOMPLETE/);await db.query("UPDATE app.mailboxes SET dmarc_status='pass' WHERE id=$1",[w.mailbox.id]);
  await db.query("UPDATE app.mailboxes SET owner_consent_at=NULL WHERE id=$1",[w.mailbox.id]);await assert.rejects(comms.send(second.id),/MAILBOX_CONSENT_REQUIRED/);await db.query("UPDATE app.mailboxes SET owner_consent_at=app.utc_now() WHERE id=$1",[w.mailbox.id]);
  // Pluggable beforeDispatch hook (integrator CRM/governance checks) blocks and the approval is not consumed.
  let hookSaw=null;const blocking=new DeliveryGateway(client,ctx,env,net.transport,w.clock,{beforeDispatch:[...communicationDispatchChecks,async input=>{hookSaw=input.message.id;const {fail}=await import('../packages/operations/dist/index.js');fail('CRM_STAGE_BLOCKED',403);}]});
  await assert.rejects(blocking.send(second.id,{actor:'owner'}),/CRM_STAGE_BLOCKED/);assert.equal(hookSaw,second.id);assert.equal((await one(db,'SELECT a.status FROM app.action_approvals a JOIN app.messages m ON m.approval_id=a.id WHERE m.id=$1',[second.id])).status,'approved');
  // Policy recheck: pausing outbound right before dispatch blocks.
  await db.query('UPDATE app.policy_controls SET outbound_enabled=false WHERE organization_id=$1',[org]);await assert.rejects(comms.send(second.id),/OUTBOUND_DISABLED/);await db.query('UPDATE app.policy_controls SET outbound_enabled=true WHERE organization_id=$1',[org]);
  // Header injection in sender identity is refused.
  await db.query("UPDATE app.mailboxes SET sender_name=$2 WHERE id=$1",[w.mailbox.id,'Owner\r\nBcc: victim@example.invalid']);await assert.rejects(comms.send(second.id),/SENDER_INVALID/);await db.query("UPDATE app.mailboxes SET sender_name='Synthetic Owner' WHERE id=$1",[w.mailbox.id]);
  // Non-campaign or unapproved messages never send.
  const loose=await comms.composeDraft({conversationId:w.conversations[2].id,subject:'No campaign',body:'Hi'});await assert.rejects(comms.send(loose.id),/OWNER_APPROVAL_REQUIRED/);
  assert.equal((await comms.send(second.id)).state,'sent');assert.equal(net.sends().length,2);
 }finally{await w.db.close();}
});

test('DOTS-101 transport timeout never sends twice; uncertain and unmatched outcomes wait for owner reconciliation with recorded evidence',async()=>{
 const w=await world();try{
  const {comms,db,net}=w;const draft=await approvedDraft(w,0);net.setMode('timeout');await assert.rejects(comms.send(draft.id),/EMAIL_DELIVERY_UNCERTAIN/);
  assert.equal((await one(db,'SELECT state FROM app.messages WHERE id=$1',[draft.id])).state,'quarantined');net.setMode('ok');
  await assert.rejects(comms.send(draft.id),/OWNER_APPROVAL_REQUIRED/);assert.equal(net.sends().length,1,'a timed-out send is never retried automatically');
  const item=await one(db,"SELECT * FROM app.reconciliation_items WHERE kind='uncertain_send' AND message_id=$1",[draft.id]);assert.equal(item.state,'open');
  assert.equal((await one(db,"SELECT state FROM app.dispatch_attempts WHERE message_id=$1",[draft.id])).state,'uncertain');
  // A receipt for the unknown provider id arrives before the owner reconciles.
  await comms.ingestSignedEvent('evt_late_delivery',{type:'message.delivered',provider_message_id:'re_found_in_provider_log'});
  await assert.rejects(comms.resolveReconciliation(item.id,'sent','Found in provider dashboard'),/PROVIDER_MESSAGE_ID_REQUIRED/);
  await assert.rejects(comms.resolveReconciliation(item.id,'sent','',  're_found_in_provider_log'),/INVALID_EVIDENCE/);
  await comms.resolveReconciliation(item.id,'sent','Provider log shows accepted at 16:00Z','re_found_in_provider_log');
  const message=await one(db,'SELECT state,provider_message_id,delivery_status FROM app.messages WHERE id=$1',[draft.id]);assert.equal(message.provider_message_id,'re_found_in_provider_log');assert.equal(message.delivery_status,'delivered');assert.equal(message.state,'delivered');
  const resolved=await one(db,'SELECT * FROM app.reconciliation_items WHERE id=$1',[item.id]);assert.equal(resolved.resolution,'sent');assert.equal(resolved.evidence,'Provider log shows accepted at 16:00Z');assert.equal(resolved.resolved_by_membership_id,owner);
  assert.equal((await one(db,"SELECT count(*)::int AS n FROM app.reconciliation_items WHERE kind='unmatched_receipt' AND state='open'")).n,0);
  await assert.rejects(comms.resolveReconciliation(item.id,'not_sent','again'),/ALREADY_RESOLVED/);
  // Not-sent reconciliation releases the reservation and leaves the message failed (new approval needed).
  const other=await approvedDraft(w,1);net.setMode('server');await assert.rejects(comms.send(other.id),/EMAIL_DELIVERY_UNCERTAIN/);net.setMode('ok');
  const second=await one(db,"SELECT id FROM app.reconciliation_items WHERE message_id=$1",[other.id]);await comms.resolveReconciliation(second.id,'not_sent','Provider search returned no message for idempotency key');
  assert.equal((await one(db,'SELECT state FROM app.messages WHERE id=$1',[other.id])).state,'failed');assert.equal((await one(db,"SELECT state FROM app.dispatch_attempts WHERE message_id=$1",[other.id])).state,'resolved_not_sent');
  // Definite provider rejection is not ambiguous: failed, no reconciliation item.
  const rejected=await approvedDraft(w,2);net.setMode('reject');await assert.rejects(comms.send(rejected.id),/EMAIL_PROVIDER_REJECTED/);
  assert.equal((await one(db,'SELECT state FROM app.messages WHERE id=$1',[rejected.id])).state,'failed');assert.equal((await one(db,'SELECT count(*)::int AS n FROM app.reconciliation_items WHERE message_id=$1',[rejected.id])).n,0);
  assert.equal((await one(db,"SELECT count(*)::int AS n FROM app.budget_reservations WHERE status='reserved'")).n,0);
 }finally{await w.db.close();}
});

test('DOTS-102 opt-out (one-click, link or reply) immediately suppresses, cancels pending drafts and sequence steps, and is auditable; no launch without postal profile',async()=>{
 const w=await world();try{
  const {comms,db,sales}=w;const sequence=await comms.createSequence({campaignId:w.campaign.id,label:'Synthetic follow-up',subjectTemplate:'Following up, {{contact_name}}',bodyTemplate:'Checking in, {{contact_name}}.',maxTouches:3,intervalDays:2});
  const enrollment=await comms.enroll(sequence.id,w.contacts[0].id);const pending=await approvedDraft(w,0);
  const outcome=await comms.processOptOut(w.contacts[0].id,'one_click',{source:'List-Unsubscribe-Post'});assert.equal(outcome.cancelledSteps,1);assert.equal(outcome.cancelledMessages,1);
  assert.equal((await one(db,'SELECT state FROM app.messages WHERE id=$1',[pending.id])).state,'cancelled');assert.equal((await one(db,'SELECT state,state_reason FROM app.sequence_enrollments WHERE id=$1',[enrollment.id])).state_reason,'opt_out');
  assert.equal((await one(db,'SELECT source FROM app.contact_suppressions WHERE email_hash=$1',[digest('prospect0@example.invalid')])).source,'unsubscribe');
  const record=await one(db,'SELECT * FROM app.opt_out_records WHERE contact_id=$1',[w.contacts[0].id]);assert.equal(record.channel,'one_click');await assert.rejects(db.query('DELETE FROM app.opt_out_records'),/append-only/);
  assert.ok((await all(db,"SELECT * FROM app.operation_events WHERE event_type='contact.opted_out'")).length>=1);
  await assert.rejects(comms.composeDraft({conversationId:w.conversations[0].id,subject:'x',body:'y'}),/CONTACT_SUPPRESSED/);await assert.rejects(comms.enroll(sequence.id,w.contacts[0].id),/CONTACT_NOT_ELIGIBLE|ALREADY_ENROLLED/);
  // Signed one-click token round trip stays tenant-bound.
  const token=signedOptOut(org,w.contacts[1].id,'synthetic-signing-key');assert.deepEqual(verifyOptOut(token,'synthetic-signing-key'),{org,contact:w.contacts[1].id});assert.equal(verifyOptOut(token,'other-key'),null);
  // Unsubscribe route uses the communications opt-out path and supports RFC 8058 one-click POST.
  const route=await readFile(new URL('../apps/web/app/api/unsubscribe/route.ts',import.meta.url),'utf8');assert.match(route,/processOptOut/);assert.match(route,/List-Unsubscribe=One-Click/);
  const fresh=await world({ready:false});try{const mailbox=await fresh.comms.connectMailbox({label:'x',email:'owner@example.invalid',senderName:'Owner',provider:'resend'});await assert.rejects(fresh.comms.grantMailboxConsent(mailbox.id,'consent'),/SENDER_PROFILE_REQUIRED/);}finally{await fresh.db.close();}
 }finally{await w.db.close();}
});

test('DOTS-103 hard bounces and complaints suppress addresses and auto-pause the campaign and mailbox at threshold; soft bounces do not suppress',async()=>{
 const w=await world({contacts:3});try{
  const {comms,db}=w;const ids=[];for(let i=0;i<3;i++){const d=await approvedDraft(w,i);ids.push((await comms.send(d.id)).providerMessageId);}
  await comms.ingestSignedEvent('evt_soft',{type:'message.bounced',provider_message_id:ids[0],bounce_type:'soft'});assert.equal((await one(db,'SELECT status FROM app.crm_contacts WHERE id=$1',[w.contacts[0].id])).status,'active');
  assert.equal((await one(db,'SELECT state FROM app.campaigns WHERE id=$1',[w.campaign.id])).state,'active');
  const gateway=communicationsGateway(w.client,ctx,{...w.env,SENDER_BOUNCE_PAUSE_BASIS_POINTS:'5000'},w.net.transport,w.clock);
  await gateway.ingestEmail('svix_bounce',{type:'email.bounced',created_at:new Date().toISOString(),data:{email_id:ids[1],bounce:{type:'Permanent'}}});
  assert.equal((await one(db,'SELECT status FROM app.crm_contacts WHERE id=$1',[w.contacts[1].id])).status,'suppressed');assert.equal((await one(db,'SELECT source FROM app.contact_suppressions WHERE email_hash=$1',[digest('prospect1@example.invalid')])).source,'bounce');
  assert.equal((await one(db,'SELECT state FROM app.campaigns WHERE id=$1',[w.campaign.id])).state,'active','1 hard bounce in 3 sends is below the 50% test threshold');
  await comms.ingestSignedEvent('evt_complaint',{type:'message.complained',provider_message_id:ids[2]});
  assert.equal((await one(db,'SELECT state FROM app.campaigns WHERE id=$1',[w.campaign.id])).state,'paused');const mailbox=await one(db,'SELECT status,pause_reason FROM app.mailboxes WHERE id=$1',[w.mailbox.id]);assert.equal(mailbox.status,'paused');assert.equal(mailbox.pause_reason,'COMPLAINT_RATE_EXCEEDED');
  assert.equal((await one(db,'SELECT source FROM app.contact_suppressions WHERE email_hash=$1',[digest('prospect2@example.invalid')])).source,'complaint');
  const health=await comms.senderHealth();const campaignHealth=health.campaigns.find(c=>c.id===w.campaign.id);assert.equal(campaignHealth.sent,3);assert.equal(campaignHealth.bounced,1);assert.equal(campaignHealth.complaints,1);assert.equal(campaignHealth.complaintBasisPoints,3333);
  assert.equal((await one(db,"SELECT count(*)::int AS n FROM app.operation_events WHERE event_type IN ('campaign.risk_paused','mailbox.risk_paused')")).n,2);
 }finally{await w.db.close();}
});

test('DOTS-104 reply triage is deterministic: multilingual opt-outs, quoted footers ignored, uncertain replies escalate, model suggestions stay drafts',async()=>{
 for(const [body,label] of [['Please unsubscribe me.','opt_out'],['STOP','opt_out'],['Por favor, darme de baja.','opt_out'],['Merci de me désabonner','opt_out'],['Bitte abmelden','opt_out'],['Quero descadastrar','opt_out'],['Not interested, thanks.','not_interested'],['Sounds great, let\'s schedule a call','interested'],['How much does it cost?','question'],['ok','ambiguous']])assert.equal(classifyReply(body).label,label,body);
 const quoted='Sounds great, let\'s talk.\n\nOn Mon, Nov 9, Owner wrote:\n> Hello\n> Unsubscribe: https://app.example.invalid/unsubscribe?token=abc';assert.equal(classifyReply(quoted).label,'interested');assert.equal(stripQuotedText('Thanks\n> quoted unsubscribe'),'Thanks');
 const opt=classifyReply('Please remove me from this list');assert.equal(opt.confidenceBasisPoints,10000);assert.equal(opt.escalate,false);assert.match(opt.citations[0].excerpt,/remove me/);
 const vague=classifyReply('hmm, maybe later');assert.equal(vague.label,'ambiguous');assert.equal(vague.escalate,true);
 const w=await world();try{
  const {comms,db,net}=w;
  const out=await comms.ingestSignedEvent('evt_optout_reply',{type:'message.received',message:{id:'in_optout',from:'prospect1@example.invalid',to:['owner@example.invalid'],subject:'Re: hello',text:'Bitte keine E-Mails mehr.'}});assert.equal(out.triage,'opt_out');
  assert.equal((await one(db,'SELECT status,consent FROM app.crm_contacts WHERE id=$1',[w.contacts[1].id])).consent,'opted_out');assert.equal((await one(db,"SELECT channel FROM app.opt_out_records WHERE contact_id=$1",[w.contacts[1].id])).channel,'reply_keyword');
  const amb=await comms.ingestSignedEvent('evt_amb',{type:'message.received',message:{id:'in_amb',from:'prospect2@example.invalid',to:['owner@example.invalid'],subject:'Re: hello',text:'hmm'}});
  const triage=await one(db,'SELECT * FROM app.reply_triage WHERE message_id=$1',[amb.messageId]);assert.equal(triage.label,'ambiguous');assert.equal(triage.escalated,true);assert.equal(triage.method,'deterministic_rules');
  const conv=await one(db,'SELECT needs_owner,sla_due_at FROM app.conversations WHERE id=$1',[amb.conversationId]);assert.equal(conv.needs_owner,true);assert.ok(conv.sla_due_at);
  const suggestion=await comms.saveModelSuggestion(amb.conversationId,amb.messageId,'Synthetic suggested answer.','synthetic-model');assert.equal((await one(db,'SELECT state,ai_generated,approval_id FROM app.messages WHERE id=$1',[suggestion.id])).state,'draft');assert.equal(net.sends().length,0);
 }finally{await w.db.close();}
});

test('DOTS-105 follow-up scheduler: max touches, quiet hours, cancellation on reply/pause/suppression, and cancel-vs-dispatch cannot both win',async()=>{
 assert.equal(inQuietHours(new Date('2026-11-10T02:00:00Z'),18,9,'America/New_York'),true);assert.equal(nextAllowedSendTime(new Date('2026-11-10T02:00:00Z'),18,9,'America/New_York').toISOString(),'2026-11-10T14:00:00.000Z');
 const w=await world({contacts:3});try{
  const {comms,db,net}=w;await assert.rejects(comms.createSequence({campaignId:w.campaign.id,label:'x',subjectTemplate:'s',bodyTemplate:'b',maxTouches:11,intervalDays:2}),/INVALID_MAX_TOUCHES/);
  const sequence=await comms.createSequence({campaignId:w.campaign.id,label:'Synthetic cadence',subjectTemplate:'Following up, {{contact_name}}',bodyTemplate:'Checking in, {{contact_name}}.',maxTouches:2,intervalDays:2});
  const night=new Date('2026-11-10T02:00:00Z');w.setNow(night);const enrolled=await comms.enroll(sequence.id,w.contacts[0].id);assert.equal(enrolled.firstDueAt,'2026-11-10T14:00:00.000Z','first touch moved out of quiet hours');
  assert.deepEqual(await comms.claimDueSteps(),[],'nothing due during quiet hours');
  w.setNow(new Date('2026-11-10T15:00:00Z'));const claimed=await comms.claimDueSteps();assert.equal(claimed[0].outcome,'drafted');
  const steps=await all(db,'SELECT s.touch_number,s.state,s.due_at FROM app.sequence_steps s JOIN app.sequence_enrollments e ON e.id=s.enrollment_id WHERE e.id=$1 ORDER BY touch_number',[enrolled.id]);assert.deepEqual(steps.map(s=>[s.touch_number,s.state]),[[1,'dispatching'],[2,'scheduled']]);
  w.setNow(new Date('2026-11-12T15:00:00Z'));await comms.claimDueSteps();assert.equal((await one(db,"SELECT count(*)::int AS n FROM app.sequence_steps s WHERE s.enrollment_id=$1",[enrolled.id])).n,2,'max touches respected');
  // A reply cancels the remaining touches.
  const second=await comms.enroll(sequence.id,w.contacts[1].id);await comms.ingestSignedEvent('evt_seq_reply',{type:'message.received',message:{id:'in_seq',from:'prospect1@example.invalid',to:['owner@example.invalid'],subject:w.conversations[1].subject,text:'Thanks, received.'}});
  assert.equal((await one(db,'SELECT state,state_reason FROM app.sequence_enrollments WHERE id=$1',[second.id])).state_reason,'replied');
  // Paused sequence does not draft; suppression cancels.
  const third=await comms.enroll(sequence.id,w.contacts[2].id);await comms.setSequenceState(sequence.id,'paused');assert.equal((await comms.claimDueSteps())[0]?.outcome??'none','sequence_paused');await comms.setSequenceState(sequence.id,'active');
  await db.query("INSERT INTO app.contact_suppressions(organization_id,email_hash,reason,source) VALUES($1,$2,'synthetic','owner')",[org,digest('prospect2@example.invalid')]);const res=await comms.claimDueSteps();assert.ok(res.some(r=>r.outcome==='suppressed'));
  assert.equal((await one(db,'SELECT state FROM app.sequence_enrollments WHERE id=$1',[third.id])).state,'cancelled');assert.equal(net.sends().length,0,'the scheduler never sends without exact owner approval');
 }finally{await w.db.close();}
 // Race: cancellation and dispatch of the same approved touch, run concurrently on a transaction-serialized connection, in both orders.
 for(const order of ['cancel-first','dispatch-first','concurrent']){
  const r=await world({serial:true,contacts:1});try{
   const sequence=await r.comms.createSequence({campaignId:r.campaign.id,label:'Race',subjectTemplate:'Race {{contact_name}}',bodyTemplate:'Race body',maxTouches:1,intervalDays:1});const enrollment=await r.comms.enroll(sequence.id,r.contacts[0].id);
   const [drafted]=await r.comms.claimDueSteps();await r.comms.approveExact(drafted.messageId,drafted.revisionHash);
   const cancel=()=>r.comms.cancelEnrollment(enrollment.id,'owner_cancelled');const dispatch=()=>r.comms.send(drafted.messageId).then(v=>({sent:v}),e=>({error:e.code}));
   let cancelResult,dispatchResult;
   if(order==='cancel-first'){cancelResult=await cancel();dispatchResult=await dispatch();}else if(order==='dispatch-first'){dispatchResult=await dispatch();cancelResult=await cancel();}else [cancelResult,dispatchResult]=await Promise.all([cancel(),dispatch()]);
   const sends=r.net.sends().length;const step=await one(r.db,'SELECT state FROM app.sequence_steps WHERE enrollment_id=$1',[enrollment.id]);const message=await one(r.db,'SELECT state FROM app.messages WHERE id=$1',[drafted.messageId]);
   assert.ok(sends<=1,order);
   if(sends===1){assert.equal(dispatchResult.sent.state,'sent');assert.deepEqual(cancelResult.alreadyDispatched.length,1,order);assert.equal(step.state,'sent');}
   else{assert.ok(['SEQUENCE_CANCELLED','OWNER_APPROVAL_REQUIRED'].includes(dispatchResult.error),`${order}:${dispatchResult.error}`);assert.equal(step.state,'cancelled');assert.equal(message.state,'cancelled');}
   if(order==='cancel-first')assert.equal(sends,0);if(order==='dispatch-first')assert.equal(sends,1);
  }finally{await r.db.close();}
 }
});

test('DOTS-106 human takeover: agent cannot send while the owner owns the thread unless delegated; release resumes; SLA priority sort',async()=>{
 const w=await world();try{
  const {comms,db,client,env,net}=w;const sequence=await comms.createSequence({campaignId:w.campaign.id,label:'Takeover cadence',subjectTemplate:'Hi {{contact_name}}',bodyTemplate:'Body',maxTouches:2,intervalDays:2});const enrollment=await comms.enroll(sequence.id,w.contacts[0].id);
  const conversation=(await one(db,'SELECT conversation_id FROM app.sequence_enrollments WHERE id=$1',[enrollment.id])).conversation_id;
  const claim=await comms.claimThread(conversation);assert.equal(claim.pausedEnrollments,1);assert.deepEqual(await comms.claimDueSteps(),[{stepId:(await one(db,'SELECT id FROM app.sequence_steps WHERE enrollment_id=$1',[enrollment.id])).id,outcome:'enrollment_paused'}]);
  const draft=await comms.composeDraft({conversationId:conversation,subject:'Owner reply',body:'Owner-written synthetic reply',campaignId:w.campaign.id});await comms.approveExact(draft.id,draft.revisionHash);
  const agent=communicationsGateway(client,ctx,env,net.transport,w.clock);await assert.rejects(agent.send(draft.id),/OWNER_CONTROLS_CONVERSATION/);await assert.rejects(agent.send(draft.id,{actor:'agent'}),/OWNER_CONTROLS_CONVERSATION/);
  await comms.delegateThread(conversation,true);assert.equal((await agent.send(draft.id)).state,'sent','explicit delegation lets the agent send');
  await comms.delegateThread(conversation,false);const ownerDraft=await comms.composeDraft({conversationId:conversation,mode:'reply',replyToMessageId:draft.id,body:'Owner follow-up',campaignId:w.campaign.id});await comms.approveExact(ownerDraft.id,ownerDraft.revisionHash);
  await assert.rejects(agent.send(ownerDraft.id),/OWNER_CONTROLS_CONVERSATION/);
  const released=await comms.releaseThread(conversation);assert.equal(released.resumedEnrollments,1);await assert.rejects(comms.releaseThread(conversation),/THREAD_NOT_CLAIMED_BY_OWNER/);
  await comms.setPriority(w.conversations[2].id,3,2);const view=await comms.snapshot();assert.equal(view.threads[0].id,w.conversations[2].id);assert.equal(view.threads[0].priority,3);
  await assert.rejects(comms.setPriority(w.conversations[2].id,9),/INVALID_PRIORITY/);await comms.markHandled(w.conversations[2].id);assert.equal((await one(db,'SELECT needs_owner FROM app.conversations WHERE id=$1',[w.conversations[2].id])).needs_owner,false);
 }finally{await w.db.close();}
});

test('DOTS-107 attachments: allowlist, magic bytes, EICAR quarantine, size limits and safe downloads; quarantined content never reaches model context',async()=>{
 assert.equal(sniffContentType(PNG),'image/png');assert.equal(sniffContentType(Buffer.from('%PDF-1.7')),'application/pdf');assert.equal(sniffContentType(Buffer.from('MZ\x90\x00')),'application/x-msdownload');assert.equal(containsEicar(Buffer.from(EICAR)),true);
 const headers=attachmentDownloadHeaders({filename:'../../evil".pdf',sniffed_type:'application/pdf'});assert.equal(headers['Content-Type'],'application/octet-stream');assert.match(headers['Content-Disposition'],/^attachment; filename="evil_.pdf"/);assert.equal(headers['X-Content-Type-Options'],'nosniff');assert.match(headers['Content-Security-Policy'],/sandbox/);
 const w=await world({env:{ATTACHMENT_MAX_BYTES:'1024'}});try{
  const {comms,db}=w;const conv=w.conversations[0].id;
  const clean=await comms.uploadAttachment({conversationId:conv,filename:'chart.png',declaredType:'image/png',base64:PNG.toString('base64')});assert.equal(clean.scanState,'clean');
  const malware=await comms.uploadAttachment({conversationId:conv,filename:'notes.txt',declaredType:'text/plain',base64:Buffer.from(EICAR).toString('base64')});assert.equal(malware.scanState,'quarantined');assert.equal(malware.reason,'MALWARE_SIGNATURE');
  const exe=await comms.uploadAttachment({conversationId:conv,filename:'invoice.exe',declaredType:'application/pdf',base64:Buffer.from('MZ').toString('base64')});assert.equal(exe.scanState,'rejected');assert.equal(exe.reason,'FORBIDDEN_EXTENSION');
  const disguised=await comms.uploadAttachment({conversationId:conv,filename:'report.pdf',declaredType:'application/pdf',base64:Buffer.from('MZ\x90\x00binary').toString('base64')});assert.equal(disguised.scanState,'quarantined');
  const mismatch=await comms.uploadAttachment({conversationId:conv,filename:'photo.jpg',declaredType:'image/jpeg',base64:PNG.toString('base64')});assert.equal(mismatch.reason,'TYPE_MISMATCH');
  await assert.rejects(comms.uploadAttachment({conversationId:conv,filename:'big.txt',declaredType:'text/plain',base64:Buffer.alloc(2048,65).toString('base64')}),/ATTACHMENT_TOO_LARGE/);
  assert.equal((await one(db,"SELECT count(*)::int AS n FROM app.message_attachments WHERE scan_state<>'clean' AND content IS NOT NULL")).n,0,'non-clean bytes are never retained');
  const download=await comms.downloadAttachment(clean.id);assert.equal(download.headers['Content-Type'],'image/png');assert.equal(Buffer.from(download.body).equals(PNG),true);await assert.rejects(comms.downloadAttachment(malware.id),/ATTACHMENT_NOT_AVAILABLE/);
  // Inbound attachment metadata is staged; oversized/forbidden declared types are rejected before any bytes are fetched.
  const inbound=await comms.ingestSignedEvent('evt_att',{type:'message.received',message:{id:'in_att',from:'prospect0@example.invalid',to:['owner@example.invalid'],subject:'Re: Hello Synthetic Prospect 0',text:'See attached',attachments:[{id:'att_1',filename:'deck.pdf',content_type:'application/pdf',size:500},{id:'att_2',filename:'run.js',content_type:'text/javascript',size:10},{id:'att_3',filename:'huge.pdf',content_type:'application/pdf',size:999999}]}});
  const staged=await all(db,'SELECT filename,scan_state,scan_reason FROM app.message_attachments WHERE message_id=$1 ORDER BY filename',[inbound.messageId]);assert.deepEqual(staged.map(s=>[s.filename,s.scan_state,s.scan_reason]),[['deck.pdf','staged',null],['huge.pdf','rejected','OVERSIZED'],['run.js','rejected','FORBIDDEN_EXTENSION']]);
  const deck=await one(db,"SELECT id FROM app.message_attachments WHERE filename='deck.pdf'");assert.equal((await comms.scanAttachment(deck.id,Buffer.from(`%PDF-1.4 ${EICAR}`))).scanState,'quarantined');
  await assert.rejects(comms.composeDraft({conversationId:conv,subject:'x',body:'y',attachmentIds:[malware.id]}),/ATTACHMENT_NOT_CLEAN/);
  const context=await comms.modelContext(conv);const serialized=JSON.stringify(context);assert.equal(serialized.includes('EICAR'),false);assert.deepEqual(context.attachments.map(a=>a.filename),['chart.png']);assert.ok(context.excluded.attachments>=4);
  assert.equal(context.messages.find(m=>m.direction==='inbound').trust,'untrusted_external_content');
 }finally{await w.db.close();}
});

test('DOTS-108 simulated end-to-end: signed events, reply, takeover, opt-out, bounce and crash mid-send reconcile without a real mailbox, money or outreach',async()=>{
 const w=await world({contacts:3});try{
  const {comms,db,net}=w;const secret='synthetic-mail-webhook';const sign=(payload,ts=Math.floor(Date.now()/1000))=>{const raw=JSON.stringify(payload);return {raw,signature:`t=${ts},v1=${createHmac('sha256',secret).update(`${ts}.${raw}`).digest('hex')}`};};
  const deliver=async(id,payload)=>{const {raw,signature}=sign(payload);assert.equal(verifyWebhook(raw,signature,secret),true);return comms.ingestSignedEvent(id,JSON.parse(raw));};
  // 1. Owner sends an approved intro; provider accepts; signed delivered receipt.
  const intro=await approvedDraft(w,0);const sent=await comms.send(intro.id);await deliver('e2e_delivered',{type:'message.delivered',provider_message_id:sent.providerMessageId});
  // 2. Prospect replies with interest; it threads, escalates and gets an SLA.
  const header=(await one(db,'SELECT message_id_header FROM app.messages WHERE id=$1',[intro.id])).message_id_header;
  const reply=await deliver('e2e_reply',{type:'message.received',message:{id:'e2e_in_1',from:'prospect0@example.invalid',to:['owner@example.invalid'],subject:'Re: Synthetic introduction',text:"I'm interested, let's schedule a call.",message_id:'<e2e-1@example.invalid>',in_reply_to:`<${header}>`}});
  assert.equal(reply.conversationId,w.conversations[0].id);assert.equal(reply.triage,'interested');
  // A forged copy (bad signature) is rejected before ingestion.
  const forged=sign({type:'message.received',message:{id:'e2e_forged'}});assert.equal(verifyWebhook(forged.raw,forged.signature.replace(/v1=[0-9a-f]+/,'v1='+'0'.repeat(64)),secret),false);
  // 3. Owner takes over and replies; cadence does not block a genuine reply; agent is locked out.
  await comms.claimThread(reply.conversationId);const answer=await comms.composeDraft({conversationId:reply.conversationId,mode:'reply',replyToMessageId:reply.messageId,body:'Happy to talk. Synthetic times attached in text.',campaignId:w.campaign.id});
  await comms.approveExact(answer.id,answer.revisionHash);await assert.rejects(communicationsGateway(w.client,ctx,w.env,net.transport,w.clock).send(answer.id),/OWNER_CONTROLS_CONVERSATION/);
  const answered=await comms.send(answer.id);assert.equal(answered.state,'sent');const answerBody=JSON.parse(net.sends().at(-1).init.body);assert.equal(answerBody.headers['In-Reply-To'],'<e2e-1@example.invalid>');
  assert.equal((await one(db,'SELECT needs_owner FROM app.conversations WHERE id=$1',[reply.conversationId])).needs_owner,false,'answering clears the SLA');
  // 4. Second prospect opts out by replying; pending draft cancelled.
  const pending=await approvedDraft(w,1);await deliver('e2e_optout',{type:'message.received',message:{id:'e2e_in_2',from:'prospect1@example.invalid',to:['owner@example.invalid'],subject:'Re: hello',text:'Please unsubscribe me'}});
  assert.equal((await one(db,'SELECT state FROM app.messages WHERE id=$1',[pending.id])).state,'cancelled');await assert.rejects(comms.send(pending.id),/OWNER_APPROVAL_REQUIRED|CONTACT_SUPPRESSED/);
  // 5. Third prospect: crash mid-send (timeout), then the late signed receipt arrives, then owner reconciles.
  const third=await approvedDraft(w,2);net.setMode('timeout');await assert.rejects(comms.send(third.id),/EMAIL_DELIVERY_UNCERTAIN/);net.setMode('ok');
  await deliver('e2e_bounce',{type:'message.bounced',provider_message_id:'re_crash_recovered',bounce_type:'hard'});
  const item=await one(db,"SELECT id FROM app.reconciliation_items WHERE kind='uncertain_send' AND message_id=$1",[third.id]);await comms.resolveReconciliation(item.id,'sent','Synthetic provider log lookup by idempotency key','re_crash_recovered');
  const crashed=await one(db,'SELECT delivery_status FROM app.messages WHERE id=$1',[third.id]);assert.equal(crashed.delivery_status,'bounced');assert.equal((await one(db,'SELECT status FROM app.crm_contacts WHERE id=$1',[w.contacts[2].id])).status,'suppressed');
  // Invariants: exactly the approved sends, no paid spend, no real network, every message labelled truthfully.
  assert.equal(net.sends().length,3);assert.ok(net.calls.every(c=>c.url.startsWith('https://api.resend.com/')));
  assert.equal((await one(db,"SELECT COALESCE(sum(actual_cents),0)::int AS spent FROM app.budget_reservations")).spent,0);
  const view=await comms.snapshot(reply.conversationId);assert.deepEqual(view.conversation.messages.map(m=>m.label.label),['Delivered','Received','Provider accepted']);assert.equal(view.reconciliation.length,0);
 }finally{await w.db.close();}
});

test('DOTS-109 canary script refuses without explicit authorization, verified sender and allow-listed recipients, and verifies recorded evidence',async()=>{
 const refused=preflight({});assert.equal(refused.ok,false);assert.ok(refused.failures.some(f=>/MAILBOX_CANARY_ENABLED/.test(f)));
 const env={MAILBOX_CANARY_ENABLED:'true',MAILBOX_CANARY_AUTHORIZATION_ID:'owner-canary-2026',MAILBOX_CANARY_SENDER:'owner@canary.test',SENDER_VERIFICATION_REFERENCE:'ref',MAILBOX_CANARY_RECIPIENTS:'inbox1@canary.test',MAILBOX_CANARY_ALLOWED_RECIPIENTS:'inbox1@canary.test,inbox2@canary.test',EMAIL_DELIVERY_ENABLED:'true',EMAIL_DELIVERY_TOKEN:'x',OUTREACH_POLICY_AUTHORIZATION_ID:'x',UNSUBSCRIBE_SIGNING_KEY:'x',EMAIL_WEBHOOK_SECRET:'x',APP_ORIGIN:'https://app.canary.test',EMAIL_BILLING_MODE:'free',EMAIL_FREE_PLAN_CONFIRMED:'true',EMAIL_COST_CENTS:'0'};
 assert.equal(preflight(env).ok,true);assert.equal(preflight({...env,MAILBOX_CANARY_RECIPIENTS:'stranger@other.test'}).ok,false);assert.equal(preflight({...env,MAILBOX_CANARY_RECIPIENTS:'a@x.invalid',MAILBOX_CANARY_ALLOWED_RECIPIENTS:'a@x.invalid'}).ok,false);
 assert.equal(preflight({...env,EMAIL_BILLING_MODE:'paid'}).ok,false);assert.equal(JSON.stringify(preflight(env)).includes('inbox1@'),false,'recipients are masked');assert.ok(checklist.length>=8);
 assert.equal(verifyEvidence({authorizationId:'owner-canary-2026',sends:[{recipient:'inbox1@canary.test',providerMessageId:'re_1',finalReceipt:'delivered'}],replyThreaded:true,optOutSuppressed:true},env).ok,true);
 assert.equal(verifyEvidence({authorizationId:'owner-canary-2026',sends:[{recipient:'other@canary.test',providerMessageId:'re_1',finalReceipt:'delivered'}],replyThreaded:true,optOutSuppressed:true},env).ok,false);
});

test('runtime grants for 0019 support the workflows without DELETE or identity-key updates, and tenant isolation holds under the runtime role',async()=>{
 const w=await world({ready:false});try{
  const {db,client,env,net}=w;
  await db.exec('CREATE ROLE dots_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;GRANT USAGE ON SCHEMA app TO dots_runtime;GRANT SELECT ON app.memberships,app.projects,app.agent_identities,app.agent_project_assignments,app.audit_events TO dots_runtime;GRANT INSERT ON app.audit_events TO dots_runtime;');
  await db.exec(await readFile(new URL('../database/runtime-grants.sql',import.meta.url),'utf8'));await db.exec(await readFile(new URL('../database/runtime-grants-0019.sql',import.meta.url),'utf8'));
  for(const table of ['sender_profiles','message_revisions','dispatch_attempts','reconciliation_items','delivery_events','opt_out_records','reply_triage','message_attachments','sequence_steps'])assert.equal((await one(db,"SELECT has_table_privilege('dots_runtime',$1,'DELETE') AS allowed",[`app.${table}`])).allowed,false,table);
  for(const table of ['dispatch_attempts','reconciliation_items','message_attachments','sequence_steps','sequence_enrollments'])for(const column of ['id','organization_id'])assert.equal((await one(db,"SELECT has_column_privilege('dots_runtime',$1,$2,'UPDATE') AS allowed",[`app.${table}`,column])).allowed,false,`${table}.${column}`);
  assert.equal((await one(db,"SELECT has_column_privilege('dots_runtime','app.message_revisions','body','UPDATE') AS allowed")).allowed,false);
  await db.exec('SET ROLE dots_runtime');
  const comms=new CommunicationsWorkspace(client,ctx,env,net.transport,w.clock);await comms.setSenderProfile({legalName:'Synthetic Labs LLC',postalAddress:'100 Synthetic Way, Testville 00000'});
  const mailbox=await comms.connectMailbox({label:'Owner sender',email:'owner@example.invalid',senderName:'Synthetic Owner',provider:'resend'});await new DeliveryGateway(client,ctx,env,net.transport,w.clock).verifyMailbox(mailbox.id);await comms.checkDmarc(mailbox.id,dmarc);await comms.grantMailboxConsent(mailbox.id,'consent');
  const sequence=await comms.createSequence({campaignId:w.campaign.id,label:'Runtime cadence',subjectTemplate:'Hi {{contact_name}}',bodyTemplate:'Body',maxTouches:2,intervalDays:2});const enrollment=await comms.enroll(sequence.id,w.contacts[0].id);const [step]=await comms.claimDueSteps();
  await comms.approveExact(step.messageId,step.revisionHash);const result=await comms.send(step.messageId);assert.equal(result.state,'sent');
  await comms.ingestSignedEvent('rt_delivered',{type:'message.delivered',provider_message_id:result.providerMessageId});
  const inbound=await comms.ingestSignedEvent('rt_reply',{type:'message.received',message:{id:'rt_in',from:'prospect1@example.invalid',to:['owner@example.invalid'],subject:'Question',text:'What is the price?',attachments:[{filename:'a.pdf',content_type:'application/pdf',size:3}]}});
  const draft=await comms.composeDraft({conversationId:inbound.conversationId,mode:'reply',replyToMessageId:inbound.messageId,body:'Draft'});await comms.reviseDraft(draft.id,1,{body:'Revised'});
  await comms.claimThread(inbound.conversationId);await comms.delegateThread(inbound.conversationId,true);await comms.releaseThread(inbound.conversationId);await comms.setPriority(inbound.conversationId,2,4);
  const upload=await comms.uploadAttachment({conversationId:inbound.conversationId,filename:'c.png',declaredType:'image/png',base64:PNG.toString('base64')});assert.equal(upload.scanState,'clean');
  await comms.processOptOut(w.contacts[2].id,'owner',{reason:'synthetic'});await comms.cancelEnrollment(enrollment.id);await comms.rotateMailboxToken(mailbox.id,'env:EMAIL_DELIVERY_TOKEN');
  const pages={null:{messages:[],nextCursor:null}};await comms.pollMailbox(mailbox.id,async({cursor})=>pages[String(cursor)]);
  const timeout=await comms.composeDraft({conversationId:w.conversations[1].id,subject:'x',body:'y',campaignId:w.campaign.id});void timeout;
  await comms.snapshot(inbound.conversationId);
  await assert.rejects(db.query('DELETE FROM app.dispatch_attempts'),/permission denied/);await assert.rejects(db.query("UPDATE app.message_revisions SET body='x'"),/permission denied|append-only/);
  // Tenant isolation under RLS: another organization sees none of these rows.
  await db.exec('RESET ROLE');const other='66666666-6666-4666-8666-666666666666',otherMember='77777777-7777-4777-8777-777777777777';
  await db.query("INSERT INTO app.organizations(id,slug,display_name) VALUES($1,'other-synthetic','Other')",[other]);await db.query("INSERT INTO app.owner_users(id,identity_subject,display_name) VALUES($1,'other-fixture','Other owner')",[otherMember]);
  await db.exec(`SELECT set_config('app.organization_id','${other}',false);SELECT set_config('app.audit_actor_membership_id','${otherMember}',false);`);await db.query("INSERT INTO app.memberships(id,organization_id,user_id,role) VALUES($1,$2,$1,'owner')",[otherMember,other]);
  await db.exec('SET ROLE dots_runtime');const foreign=new CommunicationsWorkspace(client,{organizationId:other,membershipId:otherMember},env,net.transport,w.clock);const view=await foreign.snapshot();
  assert.equal(view.threads.length,0);assert.equal(view.mailboxes.length,0);assert.equal(view.senderProfile,null);await assert.rejects(foreign.preview(draft.id),/NOT_FOUND/);await assert.rejects(foreign.claimThread(inbound.conversationId),/THREAD_ALREADY_CLAIMED|NOT_FOUND/);
  await db.exec('RESET ROLE');
 }finally{await w.db.close();}
});

test('migration 0019 rolls back and re-applies cleanly',async()=>{
 const {db}=await setup();try{const dir=new URL('../database/migrations/',import.meta.url);await db.exec(await readFile(new URL('0019_unified_communications.down.sql',dir),'utf8'));
  assert.equal((await one(db,"SELECT to_regclass('app.message_revisions') AS t")).t,null);assert.equal((await one(db,"SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema='app' AND table_name='messages' AND column_name='message_id_header'")).n,0);
  await db.exec(await readFile(new URL('0019_unified_communications.up.sql',dir),'utf8'));assert.ok((await one(db,"SELECT to_regclass('app.message_revisions') AS t")).t);}finally{await db.close();}
});

test('production send path composes governance, CRM contactability and campaign approval gates before any provider request',async()=>{
 const w=await world();try{
  const production=new CommunicationsWorkspace(w.client,ctx,w.env,w.net.transport,w.clock,productionDispatchChecks);
  const draft=await approvedDraft(w,0);
  await assert.rejects(production.send(draft.id),/REGION_UNREVIEWED|REGION_NOT_ALLOWED|CAMPAIGN_|REAPPROVAL_REQUIRED|BUDGET_EXCEEDED|CONSENT_MISSING/);
  assert.equal(w.net.sends().length,0,'no provider request when a composed gate fails');
  assert.equal((await one(w.db,'SELECT state FROM app.messages WHERE id=$1',[draft.id])).state,'pending_approval','the approved draft is preserved, not consumed');
  await new KillSwitches(w.client,ctx).engage('channel','email','Synthetic email outage drill');
  await assert.rejects(production.send(draft.id),/KILL_SWITCH_ACTIVE/);assert.equal(w.net.sends().length,0);
 }finally{await w.db.close();}
});
