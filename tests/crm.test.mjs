// DOTS-070..081 CRM, lead integrity and revenue pipeline. Synthetic data only; no network calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {CrmWorkspace,SalesWorkspace,assertContactable,contactability,tenant,digest,maskEmail,redactPii,validateSegmentFilter} from '../packages/operations/dist/index.js';
import {setup,org,owner,agent,project,ctx} from './helpers/operations-fixture.mjs';

const otherOrg='66666666-6666-4666-8666-666666666666',otherOwner='77777777-7777-4777-8777-777777777777',otherCtx={organizationId:otherOrg,membershipId:otherOwner};
const secondAgent='55555555-5555-4555-8555-555555555555';
const productSource={label:'Synthetic opt-in form',kind:'opt_in_form',purpose:'product',lawfulBasis:'consent'};

async function addOtherTenant(db){
 await db.query("INSERT INTO app.organizations(id,slug,display_name) VALUES($1,'other-synthetic','Other synthetic organization')",[otherOrg]);
 await db.query("INSERT INTO app.owner_users(id,identity_subject,display_name) VALUES($1,'other-fixture','Other synthetic owner')",[otherOwner]);
 await db.exec(`SELECT set_config('app.organization_id','${otherOrg}',false);SELECT set_config('app.audit_actor_membership_id','${otherOwner}',false);`);
 await db.query("INSERT INTO app.memberships(id,organization_id,user_id,role) VALUES($1,$2,$1,'owner')",[otherOwner,otherOrg]);
 await db.exec("SELECT set_config('app.organization_id','',false);SELECT set_config('app.audit_actor_membership_id','',false);");
}
async function addSecondAgent(client){
 await tenant(client,ctx,async tx=>{
  await tx.query("INSERT INTO app.agent_identities(id,organization_id,approved_name_id,display_name,status,updated_by_membership_id) VALUES($1,$2,59,'Harry Wormwood','active',$3)",[secondAgent,org,owner]);
  await tx.query("INSERT INTO app.agent_project_assignments(organization_id,agent_identity_id,project_id,priority,allocation_basis_points,quota_limit,concurrency_cap,updated_by_membership_id) VALUES($1,$2,$3,40,5000,1,1,$4)",[org,secondAgent,project,owner]);
 });
}
// Serializes whole transactions like a single-connection pool so Promise.all callers interleave safely on PGlite.
function serialized(db){
 let chain=Promise.resolve(),release=null;
 return {query:async(statement,values)=>{
  if(statement==='BEGIN'){let unlock;const previous=chain;chain=new Promise(resolve=>{unlock=resolve;});await previous;release=unlock;}
  try{return await db.query(statement,values);}
  finally{if((statement==='COMMIT'||statement==='ROLLBACK')&&release){const done=release;release=null;done();}}
 }};
}
async function campaign(sales,label='Synthetic product campaign'){return sales.createCampaign({projectId:project,label,purpose:'product',goal:'Synthetic owner-approved offer review'});}
async function allowUS(crm){await crm.setRegionPolicy({jurisdiction:'US',allowed:true,requiresOptIn:false,legalReviewRef:'Synthetic legal review 1'});}
const count=async(db,table,where='')=>Number((await db.query(`SELECT count(*)::int AS n FROM app.${table} ${where}`)).rows[0].n);
async function sentMessage(db,client,contactId,{campaignId=null,providerId,daysAgo=1,state='sent'}){
 const conversation=await new SalesWorkspace(client,ctx).createConversation(contactId,'Synthetic thread',project);
 await db.query("INSERT INTO app.messages(organization_id,conversation_id,campaign_id,direction,subject,body,state,source,provider_message_id,content_hash,sent_at) VALUES($1,$2,$3,'outbound','Synthetic subject','Synthetic body',$4,'owner',$5,$6,now()-make_interval(days=>$7::int))",[org,conversation.id,campaignId,state,providerId,digest(providerId),daysAgo]);
 return conversation;
}
async function paidLiveInvoice(db,dealId,crm,amount,{source='provider',testMode=false}={}){
 const invoice=(await db.query("INSERT INTO app.invoices(organization_id,project_id,label,invoice_number,state,amount_cents,description,test_mode) VALUES($1,$2,'Synthetic invoice',$3,'paid',$4,'Synthetic invoice',$5) RETURNING id",[org,project,`INV-${Math.random().toString(16).slice(2,10)}`,amount,testMode])).rows[0].id;
 await crm.linkInvoice(dealId,invoice);
 const entry=(await db.query("INSERT INTO app.money_entries(organization_id,project_id,invoice_id,idempotency_key,kind,amount_cents,source,evidence_ref) VALUES($1,$2,$3,$4,'sale_receipt',$5,$6,'synthetic-provider-event') RETURNING id",[org,project,invoice,`receipt:${invoice}`,amount,source])).rows[0].id;
 return {invoice,entry};
}
async function advanceToNegotiation(crm,deal){
 let current=deal;
 for(const stage of ['qualified','proposal','negotiation'])current=await crm.transitionDeal({dealId:deal.id,toStage:stage,version:Number(current.version),evidence:{kind:'owner_note',ref:`Synthetic ${stage} review note`}});
 return current;
}

test('DOTS-070 accounts and people keep aliases, methods, owners and metadata tenant-isolated without silent organization merges',async()=>{
 const {db,client}=await setup();try{
  await addOtherTenant(db);
  const crm=new CrmWorkspace(client,ctx),other=new CrmWorkspace(client,otherCtx);
  const acme=await crm.createAccount({name:'Acme Synthetic, Inc.',domain:'acme.example',aliases:['ACME Labs'],metadata:{industry:'software'}});
  assert.equal(acme.created,true);assert.equal(acme.account.normalized_name,'acmesynthetic');assert.equal(acme.account.owner_membership_id,owner);
  const similar=await crm.createAccount({name:'ACME Synthetic Corporation'});
  assert.equal(similar.created,false);assert.equal(similar.account,null);assert.equal(similar.similar[0].id,acme.account.id);assert.equal(similar.similar[0].reason,'SAME_NORMALIZED_NAME');
  assert.equal((await crm.createAccount({name:'Different Name',domain:'https://www.acme.example/about'})).similar[0].reason,'SAME_DOMAIN');
  const distinct=await crm.createAccount({name:'ACME Synthetic Corporation',allowSimilar:true});assert.equal(distinct.created,true);assert.notEqual(distinct.account.id,acme.account.id);
  assert.equal(await count(db,'crm_accounts'),2,'similar names never merge silently');
  const person=await crm.createPerson({name:'Jordan Synthetic',email:'Jordan@Acme.example',source:productSource,accountId:acme.account.id,aliases:['J. Synthetic'],methods:[{kind:'phone',value:'+1 555 0100'},{kind:'email',value:'jordan.alt@acme.example'}],metadata:{tier:'gold'},consent:'opted_in',consentEvidence:'Synthetic form receipt 1',jurisdiction:'us'});
  assert.equal(person.duplicate,false);assert.equal(person.contact.email,undefined);assert.equal(person.contact.email_masked,'j***@acme.example');assert.equal(person.contact.jurisdiction,'US');assert.equal(person.contact.email_domain,'acme.example');
  assert.equal(await count(db,'crm_contact_methods',`WHERE contact_id='${person.contact.id}'`),3);
  const again=await crm.createPerson({name:'Jordan Again',email:'jordan@acme.example',source:{...productSource,label:'Synthetic event list',kind:'event_registration'}});
  assert.equal(again.duplicate,true);assert.equal(again.contact.id,person.contact.id);assert.equal(await count(db,'crm_contact_sources',`WHERE contact_id='${person.contact.id}'`),2,'provenance is appended, not replaced');
  await assert.rejects(crm.createPerson({name:'Method thief',email:'thief@acme.example',source:productSource,methods:[{kind:'email',value:'jordan.alt@acme.example'}]}),/CONTACT_METHOD_BELONGS_TO_OTHER_CONTACT/);
  await assert.rejects(crm.createPerson({name:'Scraped',email:'scraped@acme.example',source:{...productSource,kind:'scraped'}}),/PROHIBITED_SOURCE/);
  await assert.rejects(crm.createPerson({name:'Bad meta',email:'meta@acme.example',source:productSource,metadata:{note:'x@y.example'}}),/METADATA_MUST_NOT_CONTAIN_EMAIL/);
  assert.equal((await crm.searchContacts({q:'jordan'})).items.length,1);
  assert.equal((await crm.searchContacts({q:'j. synth'})).items[0].id,person.contact.id,'aliases are searchable');
  assert.equal((await crm.searchContacts({q:'jordan.alt@acme.example'})).items[0].id,person.contact.id,'secondary methods resolve');
  assert.equal((await crm.searchContacts({q:'acme.example'})).items.length,1);
  const updated=await crm.updateContact({id:person.contact.id,version:Number(person.contact.version),metadata:{tier:'silver'},ownerMembershipId:owner});assert.deepEqual(updated.metadata,{tier:'silver'});
  await assert.rejects(crm.updateContact({id:person.contact.id,version:1,metadata:{}}),/STALE_RECORD/);
  // Tenant isolation: the other organization cannot see, alias, update or merge these records.
  assert.equal((await other.searchContacts({q:'jordan'})).items.length,0);
  assert.equal((await other.accountMap()).accounts.length,0);
  await assert.rejects(other.addAlias({contactId:person.contact.id,alias:'Hijack'}),/NOT_FOUND/);
  await assert.rejects(other.updateContact({id:person.contact.id,version:Number(updated.version),metadata:{}}),/STALE_RECORD/);
  const theirs=await other.createPerson({name:'Jordan Synthetic',email:'jordan@acme.example',source:productSource});
  assert.equal(theirs.duplicate,false,'same address in another tenant is a separate record');
  await assert.rejects(crm.mergeContacts({survivorId:person.contact.id,duplicateId:theirs.contact.id}),/NOT_FOUND/);
  await assert.rejects(new CrmWorkspace(client,{organizationId:org,membershipId:otherOwner}).searchContacts({}),/NOT_AUTHORIZED/);
  const map=await crm.accountMap();assert.equal(map.accounts.find(a=>a.id===acme.account.id).contacts.length,1);assert.equal(map.accounts.find(a=>a.id===acme.account.id).aliases[0].alias,'ACME Labs');
 }finally{await db.close();}
});

test('DOTS-071 staged imports validate provenance, quarantine unlawful rows, preview before commit and never create outreach',async()=>{
 const {db,client}=await setup();try{
  const crm=new CrmWorkspace(client,ctx);
  await crm.setRegionPolicy({jurisdiction:'DE',allowed:false,requiresOptIn:true,legalReviewRef:'Synthetic legal hold'});
  const existing=await crm.createPerson({name:'Existing Buyer',email:'existing@buyer.example',source:productSource});
  await crm.suppress({email:'blocked@buyer.example',reason:'SYNTHETIC_OPT_OUT',source:'unsubscribe'});
  const before={messages:await count(db,'messages'),conversations:await count(db,'conversations'),tasks:await count(db,'task_queue'),audience:await count(db,'campaign_audience')};
  const staged=await crm.stageImport({source:{label:'Synthetic webinar opt-ins',kind:'opt_in_form',purpose:'product',lawfulBasis:'consent'},rows:[
   {name:'Valid One',email:'valid.one@buyer.example',account:'Buyer Synthetic LLC',domain:'buyer.example',jurisdiction:'US',consent:'opted_in',consentEvidence:'Synthetic receipt A'},
   {name:'Valid Two',email:'valid.two@buyer.example',consent:'opted_in',consentEvidence:'Synthetic receipt B'},
   {name:'Bad Email',email:'not-an-email'},
   {name:'',email:'noname@buyer.example',consent:'opted_in',consentEvidence:'x'},
   {name:'No Evidence',email:'noevidence@buyer.example',consent:'opted_in'},
   {name:'Valid One Again',email:'VALID.ONE@buyer.example',consent:'opted_in',consentEvidence:'Synthetic receipt C'},
   {name:'Existing Again',email:'existing@buyer.example',consent:'opted_in',consentEvidence:'Synthetic receipt D'},
   {name:'Blocked Person',email:'blocked@buyer.example',consent:'opted_in',consentEvidence:'Synthetic receipt E'},
   {name:'German Person',email:'german@buyer.example',jurisdiction:'DE',consent:'opted_in',consentEvidence:'Synthetic receipt F'},
  ]});
  assert.equal(staged.state,'staged');assert.equal(staged.total,9);assert.equal(staged.valid,2);assert.equal(staged.quarantined,4);assert.equal(staged.duplicate,2);assert.equal(staged.suppressed,1);assert.equal(staged.outreachQueued,0);
  assert.equal(staged.reasons.INVALID_EMAIL,1);assert.equal(staged.reasons.MISSING_NAME,1);assert.equal(staged.reasons.CONSENT_EVIDENCE_REQUIRED,1);assert.equal(staged.reasons.REGION_NOT_ALLOWED,1);assert.equal(staged.reasons.DUPLICATE_IN_BATCH,1);assert.equal(staged.reasons.EXISTING_CONTACT,1);
  assert.equal((await crm.searchContacts({q:'valid'})).items.length,0,'nothing is created before commit');
  const preview=await crm.previewImport(staged.batchId);
  assert.equal(preview.items.length,9);assert.ok(!JSON.stringify(preview).includes('valid.one@'),'preview masks addresses');assert.equal(preview.items[0].email_masked,'v***@buyer.example');
  assert.equal(preview.items.find(row=>row.row_number===7).match_contact_id,existing.contact.id);
  const committed=await crm.commitImport(staged.batchId);
  assert.equal(committed.created,2);assert.equal(committed.sourcesAdded,1);assert.equal(committed.quarantined,4);assert.equal(committed.outreachQueued,0);
  assert.deepEqual({messages:await count(db,'messages'),conversations:await count(db,'conversations'),tasks:await count(db,'task_queue'),audience:await count(db,'campaign_audience')},before,'commit sends and queues nothing');
  assert.equal(await count(db,'crm_import_rows',"WHERE email IS NOT NULL"),0,'staged raw addresses are cleared after commit');
  assert.equal(await count(db,'crm_contacts',"WHERE email='blocked@buyer.example' OR email='german@buyer.example' OR email='noevidence@buyer.example'"),0,'quarantined and suppressed rows are never created');
  const one=(await crm.searchContacts({q:'valid one'})).items[0];assert.equal(one.consent,'opted_in');assert.ok(one.account_id,'account created from the row');
  assert.equal(await count(db,'crm_consent_evidence',`WHERE contact_id='${one.id}' AND source='import'`),1);
  await assert.rejects(crm.commitImport(staged.batchId),/IMPORT_NOT_STAGED/);
  const purchased=await crm.stageImport({source:{label:'Bought list',kind:'purchased_list',purpose:'product',lawfulBasis:'legitimate_interest'},rows:[{name:'List Person',email:'list@buyer.example'}]});
  assert.equal(purchased.quarantined,1);assert.equal(purchased.reasons.PROHIBITED_SOURCE,1);
  await assert.rejects(crm.commitImport(purchased.batchId),/PROHIBITED_SOURCE/);
  const discarded=await crm.stageImport({source:productSource,rows:[{name:'Discard Me',email:'discard@buyer.example',consent:'opted_in',consentEvidence:'Synthetic'}]});
  await crm.discardImport(discarded.batchId);assert.equal(await count(db,'crm_import_rows',`WHERE batch_id='${discarded.batchId}' AND (email IS NOT NULL OR display_name IS NOT NULL)`),0);
  await assert.rejects(crm.stageImport({source:productSource,rows:[]}),/IMPORT_LIMIT_1000/);
 }finally{await db.close();}
});

test('DOTS-072 dedupe scores candidates, owner merge preserves sources and conversations, and duplicates are never double-contacted',async()=>{
 const {db,client}=await setup();try{
  const crm=new CrmWorkspace(client,ctx),sales=new SalesWorkspace(client,ctx);await allowUS(crm);
  const acme=(await crm.createAccount({name:'Acme Synthetic'})).account,other=(await crm.createAccount({name:'Other Synthetic'})).account;
  const base={source:productSource,consent:'opted_in',consentEvidence:'Synthetic receipt',jurisdiction:'US'};
  const a=(await crm.createPerson({...base,name:'Jordan Synthetic',email:'jordan@acme.example',accountId:acme.id})).contact;
  const b=(await crm.createPerson({...base,name:'Jordan  Synthetic',email:'j.synthetic@acme.example',accountId:acme.id,source:{...productSource,label:'Synthetic event badge scan',kind:'event_registration'}})).contact;
  const c=(await crm.createPerson({...base,name:'Casey Common',email:'casey1@gmail.com'})).contact;
  await crm.createPerson({...base,name:'Casey Common',email:'casey2@gmail.com'});
  const d=(await crm.createPerson({...base,name:'Jordan Synthetic',email:'jordan@other.example',accountId:other.id})).contact;
  assert.equal((await crm.detectDuplicates()).candidates,0,'candidates were proposed when the duplicate was created');
  const candidates=await crm.listCandidates();
  const pair=candidates.find(item=>[item.primary_contact_id,item.duplicate_contact_id].sort().join()===[a.id,b.id].sort().join());
  assert.equal(pair.score,90);assert.ok(pair.reasons.includes('SAME_EMAIL_DOMAIN'));assert.ok(!JSON.stringify(candidates).includes('jordan@acme'),'candidate review masks addresses');
  assert.ok(!candidates.some(item=>[item.primary_contact_id,item.duplicate_contact_id].includes(c.id)),'free-mail name collisions are not proposed');
  assert.equal((await crm.detectDuplicates()).candidates,0,'detection is idempotent');
  const sharedCampaign=await campaign(sales);
  const conversation=await sentMessage(db,client,b.id,{campaignId:sharedCampaign.id,providerId:'synthetic-provider-1'});
  await assert.rejects(crm.mergeContacts({survivorId:a.id,duplicateId:d.id}),/CROSS_ACCOUNT_MERGE_REQUIRES_CONFIRMATION/);
  const merge=await crm.mergeContacts({survivorId:a.id,duplicateId:b.id,candidateId:pair.id});
  assert.equal(merge.merged_contact_id,b.id);assert.ok(!JSON.stringify(merge.merged_snapshot).includes('@'),'merge snapshot holds no raw address');
  const merged=(await db.query('SELECT status,merged_into_id,email FROM app.crm_contacts WHERE id=$1',[b.id])).rows[0];
  assert.equal(merged.status,'merged');assert.equal(merged.merged_into_id,a.id);assert.equal(merged.email,'j.synthetic@acme.example','merged record keeps its original identity');
  assert.equal((await db.query('SELECT contact_id FROM app.conversations WHERE id=$1',[conversation.id])).rows[0].contact_id,b.id,'conversation history keeps its original contact');
  assert.equal(await count(db,'crm_contact_sources',`WHERE contact_id='${b.id}'`),1,'original sources preserved');
  const timeline=await crm.timeline(a.id);assert.ok(timeline.clusterIds.includes(b.id));assert.ok(timeline.items.some(item=>item.kind==='outreach'&&item.contact_id===b.id));assert.ok(timeline.items.some(item=>item.kind==='merge'));
  await assert.rejects(crm.mergeContacts({survivorId:a.id,duplicateId:b.id}),/CONTACT_ALREADY_MERGED/);
  await assert.rejects(db.query("UPDATE app.crm_merges SET cross_account=true WHERE id=$1",[merge.id]),/append-only/);
  // The duplicate is blocked, and the survivor inherits the duplicate's recent outreach for frequency limits.
  await tenant(client,ctx,async tx=>{
   await assert.rejects(assertContactable(tx,ctx,{contactId:b.id,campaignId:sharedCampaign.id,channel:'email'}),/CONTACT_MERGED/);
   const survivor=await contactability(tx,ctx,{contactId:a.id,campaignId:sharedCampaign.id,channel:'email'});
   assert.deepEqual(survivor.reasons,['FREQUENCY_LIMIT_REACHED']);
  });
  const crossed=await crm.mergeContacts({survivorId:a.id,duplicateId:d.id,confirmCrossAccount:true});assert.equal(crossed.cross_account,true);
  assert.equal((await crm.searchContacts({q:'jordan'})).items.length,1,'merged duplicates are hidden from the default lead list');
 }finally{await db.close();}
});

test('DOTS-073 universal do-not-contact blocks every agent and campaign; consent, region and frequency fail closed; overrides need lawful audit',async()=>{
 const {db,client}=await setup();try{
  await addSecondAgent(client);
  const crm=new CrmWorkspace(client,ctx),sales=new SalesWorkspace(client,ctx);
  const first=await campaign(sales,'Campaign one'),second=await campaign(sales,'Campaign two');
  const person=(await crm.createPerson({name:'Riley Synthetic',email:'riley@consent.example',source:productSource,consent:'opted_in',consentEvidence:'Synthetic receipt',jurisdiction:'US'})).contact;
  const check=input=>crm.checkContactable({contactId:person.id,channel:'email',...input});
  assert.deepEqual((await check({campaignId:first.id})).reasons,['REGION_NOT_ALLOWED'],'no region policy means not allowed');
  await crm.setRegionPolicy({jurisdiction:'US',allowed:true,requiresOptIn:true,legalReviewRef:'Synthetic legal review'});
  assert.deepEqual((await check({campaignId:first.id})).reasons,[]);
  const unknown=(await crm.createPerson({name:'Unknown Consent',email:'unknown@consent.example',source:productSource})).contact;
  assert.deepEqual((await crm.checkContactable({contactId:unknown.id,campaignId:first.id,channel:'email'})).reasons,['CONSENT_MISSING','REGION_UNREVIEWED']);
  await crm.recordConsent({contactId:unknown.id,consent:'existing_customer',evidenceRef:'Synthetic contract ref',jurisdiction:'US'});
  assert.deepEqual((await crm.checkContactable({contactId:unknown.id,campaignId:first.id,channel:'email'})).reasons,['REGION_REQUIRES_OPT_IN']);
  assert.equal(await count(db,'crm_consent_evidence',`WHERE contact_id='${unknown.id}'`),1,'consent history is recorded');
  assert.deepEqual((await check({campaignId:first.id,channel:'phone'})).reasons,['CHANNEL_UNAVAILABLE']);
  // Frequency limits count real outbound sends across the tenant.
  await crm.setContactPolicy({maxTouches:1,windowDays:7,exclusionDays:30});
  await sentMessage(db,client,unknown.id,{providerId:'synthetic-frequency'});
  await crm.recordConsent({contactId:unknown.id,consent:'opted_in',evidenceRef:'Synthetic opt-in',jurisdiction:'US'});
  assert.deepEqual((await crm.checkContactable({contactId:unknown.id,campaignId:second.id,channel:'email'})).reasons,['FREQUENCY_LIMIT_REACHED']);
  // Universal suppression: every campaign and agent is blocked by the same deterministic gate.
  await crm.suppress({contactId:person.id,reason:'SYNTHETIC_UNSUBSCRIBE',source:'unsubscribe'});
  for(const [campaignId,agentId] of [[first.id,undefined],[second.id,undefined],[first.id,agent],[second.id,secondAgent]])
   await tenant(client,ctx,async tx=>assert.rejects(assertContactable(tx,ctx,{contactId:person.id,campaignId,agentId,channel:'email'}),/CONTACT_SUPPRESSED/));
  await assert.rejects(crm.recordConsent({contactId:person.id,consent:'opted_in',evidenceRef:'Sneaky',jurisdiction:'US'}),/SUPPRESSED_CONTACT_REQUIRES_LAWFUL_OVERRIDE/);
  assert.equal((await crm.createPerson({name:'Reimport',email:'riley@consent.example',source:productSource})).duplicate,true);
  await assert.rejects(crm.overrideSuppression({contactId:person.id,lawfulBasis:'documented_new_opt_in',auditRef:'',consentEvidence:'x'}),/LAWFUL_AUDIT_REQUIRED/);
  await assert.rejects(crm.overrideSuppression({contactId:person.id,lawfulBasis:'owner_entry_error',auditRef:'Synthetic audit 1'}),/OPT_OUT_REQUIRES_NEW_OPT_IN/);
  await assert.rejects(crm.overrideSuppression({contactId:person.id,lawfulBasis:'documented_new_opt_in',auditRef:'Synthetic audit 1'}),/CONSENT_EVIDENCE_REQUIRED/);
  // There is no other way to remove the suppression: the lift function demands a same-transaction audit row.
  await assert.rejects(tenant(client,ctx,tx=>tx.query('SELECT app.crm_lift_suppression($1,$2)',[digest('riley@consent.example'),'99999999-9999-4999-8999-999999999999'])),/lawful audit record/);
  const overridden=await crm.overrideSuppression({contactId:person.id,lawfulBasis:'documented_new_opt_in',auditRef:'Synthetic audit 2',consentEvidence:'Synthetic new double opt-in receipt'});
  assert.equal(overridden.overridden,1);assert.equal(overridden.consent,'opted_in');
  assert.equal(await count(db,'crm_suppression_history',`WHERE email_hash='${digest('riley@consent.example')}'`),2);
  assert.deepEqual((await check({campaignId:first.id})).reasons,[]);
  await assert.rejects(db.query("DELETE FROM app.crm_suppression_history"),/append-only/);
  // Privacy erasure is permanent.
  await sales.redactContact(person.id);
  await assert.rejects(crm.overrideSuppression({contactId:person.id,lawfulBasis:'documented_new_opt_in',auditRef:'Synthetic audit 3',consentEvidence:'x'}),/PRIVACY_ERASURE_CANNOT_BE_OVERRIDDEN/);
  assert.equal((await check({campaignId:first.id})).reasons[0],'CONTACT_REDACTED');
  // Pre-emptive suppression of an address that is not yet a contact applies on creation.
  await crm.suppress({email:'future@consent.example',reason:'SYNTHETIC_COMPLAINT',source:'complaint'});
  assert.equal((await crm.createPerson({name:'Future',email:'future@consent.example',source:productSource})).contact.status,'suppressed');
 }finally{await db.close();}
});

test('DOTS-074 one active owner agent per prospect, tenant-wide exclusion windows, reported conflicts and safe concurrent claims',async()=>{
 const {db,client}=await setup();try{
  await addSecondAgent(client);
  const crm=new CrmWorkspace(client,ctx),sales=new SalesWorkspace(client,ctx);await allowUS(crm);
  const first=await campaign(sales,'Parallel one'),second=await campaign(sales,'Parallel two');
  const person=(await crm.createPerson({name:'Morgan Synthetic',email:'morgan@owner.example',source:productSource,consent:'opted_in',consentEvidence:'Synthetic',jurisdiction:'US'})).contact;
  const racing=new CrmWorkspace(serialized(db),ctx);
  const attempts=await Promise.all([[first.id,agent],[first.id,secondAgent],[second.id,agent],[second.id,secondAgent],[first.id,secondAgent],[second.id,agent]].map(([campaignId,agentId])=>racing.claimProspect({contactId:person.id,campaignId,agentId})));
  const winners=attempts.filter(result=>result.claimed&&!result.idempotent);
  assert.equal(winners.length,1,'exactly one agent owns the prospect');
  const winner=winners[0].claim;assert.equal(await count(db,'crm_prospect_claims',"WHERE state='active'"),1);
  for(const loser of attempts.filter(result=>!result.claimed))assert.match(loser.conflict.code,/PROSPECT_(IN_OTHER_CAMPAIGN|OWNED_BY_OTHER_AGENT)/);
  assert.ok(await count(db,'operation_events',"WHERE event_type='crm.prospect_claim_conflict'")>=4,'conflicts are reported');
  const otherAgent=winner.agent_identity_id===agent?secondAgent:agent,otherCampaign=winner.campaign_id===first.id?second.id:first.id;
  await tenant(client,ctx,async tx=>{
   assert.ok((await assertContactable(tx,ctx,{contactId:person.id,campaignId:winner.campaign_id,agentId:winner.agent_identity_id,channel:'email'})).allowed);
   await assert.rejects(assertContactable(tx,ctx,{contactId:person.id,campaignId:winner.campaign_id,agentId:otherAgent,channel:'email'}),/PROSPECT_OWNED_BY_OTHER_AGENT/);
   await assert.rejects(assertContactable(tx,ctx,{contactId:person.id,campaignId:otherCampaign,agentId:winner.agent_identity_id,channel:'email'}),/PROSPECT_IN_OTHER_CAMPAIGN/);
  });
  // Database-level guarantee for real concurrent connections.
  await assert.rejects(db.query('INSERT INTO app.crm_prospect_claims(organization_id,contact_id,campaign_id,agent_identity_id) VALUES($1,$2,$3,$4)',[org,person.id,otherCampaign,otherAgent]),/duplicate key|unique/);
  await crm.releaseClaim(winner.id,'Synthetic hand-back');
  const blocked=await crm.claimProspect({contactId:person.id,campaignId:otherCampaign,agentId:otherAgent});
  assert.equal(blocked.claimed,false);assert.equal(blocked.conflict.code,'PROSPECT_IN_EXCLUSION_WINDOW');
  await tenant(client,ctx,async tx=>assert.rejects(assertContactable(tx,ctx,{contactId:person.id,campaignId:otherCampaign,agentId:otherAgent,channel:'email'}),/PROSPECT_IN_EXCLUSION_WINDOW/));
  const reclaimed=await crm.claimProspect({contactId:person.id,campaignId:otherCampaign,agentId:winner.agent_identity_id});assert.equal(reclaimed.claimed,true,'the previous owner may continue in a new sequence');
  const unassigned=await tenant(client,ctx,async tx=>(await tx.query("INSERT INTO app.agent_identities(organization_id,approved_name_id,display_name,status,updated_by_membership_id) SELECT $1,id,name,'active',$2 FROM app.approved_agent_names WHERE id NOT IN (59,98) ORDER BY id LIMIT 1 RETURNING id",[org,owner])).rows[0]);
  await assert.rejects(crm.claimProspect({contactId:person.id,campaignId:first.id,agentId:unassigned.id}),/AGENT_NOT_ASSIGNED_TO_CAMPAIGN_PROJECT/);
  const unclaimed=(await crm.createPerson({name:'Taylor Unclaimed',email:'taylor@owner.example',source:productSource,consent:'opted_in',consentEvidence:'Synthetic',jurisdiction:'US'})).contact;
  assert.deepEqual((await crm.checkContactable({contactId:unclaimed.id,campaignId:first.id,agentId:agent,channel:'email'})).reasons,['PROSPECT_NOT_CLAIMED'],'agents must hold the claim before contacting');
 }finally{await db.close();}
});

test('DOTS-075 segments use allowed stored fields only and preview counts with exclusion reasons without inference or paid calls',async()=>{
 const {db,client}=await setup();try{
  const crm=new CrmWorkspace(client,ctx);await allowUS(crm);
  await crm.setRegionPolicy({jurisdiction:'FR',allowed:false,requiresOptIn:true,legalReviewRef:'Synthetic review'});
  const account=(await crm.createAccount({name:'Segment Synthetic',sector:'manufacturing'})).account;
  const make=(name,email,extra={})=>crm.createPerson({name,email,accountId:account.id,source:productSource,metadata:{industry:'robotics'},...extra});
  await make('Eligible One','e1@seg.example',{consent:'opted_in',consentEvidence:'r',jurisdiction:'US'});
  await make('Eligible Two','e2@seg.example',{consent:'business_reviewed',consentEvidence:'r',jurisdiction:'US'});
  await make('No Consent','nc@seg.example');
  await make('French Person','fr@seg.example',{consent:'opted_in',consentEvidence:'r',jurisdiction:'FR'});
  const suppressed=(await make('Suppressed Person','sp@seg.example',{consent:'opted_in',consentEvidence:'r',jurisdiction:'US'})).contact;await crm.suppress({contactId:suppressed.id});
  await crm.createPerson({name:'Elsewhere',email:'else@seg.example',source:productSource,metadata:{industry:'retail'}});
  const tasksBefore=await count(db,'task_queue'),runsBefore=await count(db,'agent_runs');
  const preview=await crm.previewSegment({filter:{sectors:['manufacturing'],metadata:{industry:'robotics'},sourceKinds:['opt_in_form']}});
  assert.equal(preview.matched,5);assert.equal(preview.eligible,2);assert.equal(preview.excluded,3);assert.equal(preview.inference,'none');assert.equal(preview.paidCalls,0);
  assert.deepEqual(Object.fromEntries(preview.exclusions.map(item=>[item.reason,item.count])),{CONSENT_MISSING:1,CONTACT_SUPPRESSED:1,REGION_NOT_ALLOWED:1});
  assert.equal(preview.sample.length,2);assert.ok(preview.sample.every(item=>item.email===undefined&&item.email_masked.includes('***')));
  assert.equal(await count(db,'task_queue'),tasksBefore);assert.equal(await count(db,'agent_runs'),runsBefore);
  for(const forbidden of [{age:[30]},{metadata:{ethnicity:'x'}},{inferredIntent:'high'},{metadata:{gender:'x'}}])assert.throws(()=>validateSegmentFilter(forbidden),/SEGMENT_FIELD_NOT_ALLOWED/);
  await assert.rejects(crm.saveSegment({label:'Bad',filter:{religion:['x']}}),/SEGMENT_FIELD_NOT_ALLOWED/);
  const segment=await crm.saveSegment({label:'Robotics manufacturers',filter:{sectors:['manufacturing'],metadata:{industry:'robotics'}}});
  assert.equal((await crm.previewSegment({segmentId:segment.id})).matched,5);
  const evaluated=await crm.materializeSegment(segment.id);assert.equal(evaluated.members,5);
  assert.equal((await crm.materializeSegment(segment.id)).members,0,'re-evaluation of the same version is idempotent');
  const updated=await crm.saveSegment({id:segment.id,version:Number(segment.version),label:'Robotics US',filter:{jurisdictions:['US'],metadata:{industry:'robotics'}}});assert.equal(Number(updated.version),2);
  await assert.rejects(crm.saveSegment({id:segment.id,version:1,label:'Stale',filter:{}}),/STALE_RECORD/);
 }finally{await db.close();}
});

test('DOTS-076 the relationship timeline links every event with timestamp, actor and source and labels model statements unverified',async()=>{
 const {db,client}=await setup();try{
  const crm=new CrmWorkspace(client,ctx),sales=new SalesWorkspace(client,ctx);
  const person=(await crm.createPerson({name:'Avery Timeline',email:'avery@timeline.example',source:productSource,consent:'opted_in',consentEvidence:'Synthetic receipt',jurisdiction:'US'})).contact;
  const segment=await crm.saveSegment({label:'Timeline segment',filter:{namePrefix:'avery'}});await crm.materializeSegment(segment.id);
  const conversation=await sentMessage(db,client,person.id,{providerId:'synthetic-timeline-1'});
  await db.query("INSERT INTO app.messages(organization_id,conversation_id,direction,subject,body,state,source,provider_message_id,content_hash) VALUES($1,$2,'inbound','Re: Synthetic','Synthetic reply','received','provider','synthetic-inbound-1','h')",[org,conversation.id]);
  await sales.addNote(person.id,'Synthetic owner note');
  await crm.addRelationshipEvent({contactId:person.id,kind:'model_statement',summary:'Model believes the buyer has budget',actorKind:'model',actorId:'synthetic-model',source:'draft-run'});
  await assert.rejects(crm.addRelationshipEvent({contactId:person.id,kind:'note',summary:'Model claims a fact',actorKind:'model',source:'run'}),/MODEL_OUTPUT_IS_UNVERIFIED/);
  await assert.rejects(db.query("INSERT INTO app.crm_relationship_events(organization_id,contact_id,kind,summary,actor_kind,actor_id,source,verified,evidence_ref) VALUES($1,$2,'model_statement','Forged fact','model','m','run',true,'ref')",[org,person.id]),/check constraint/);
  const agentNote=await crm.addRelationshipEvent({contactId:person.id,kind:'meeting',summary:'Agent says a meeting happened',actorKind:'agent',actorId:agent,source:'agent-run'});assert.equal(agentNote.verified,false,'agent claims without evidence are unverified');
  const deal=await crm.createDeal({projectId:project,label:'Timeline deal',valueCents:10000,contactIds:[person.id]});
  await crm.transitionDeal({dealId:deal.id,toStage:'qualified',version:Number(deal.version),evidence:{kind:'owner_note',ref:'Synthetic qualification call notes'}});
  const timeline=await crm.timeline(person.id);
  const kinds=new Set(timeline.items.map(item=>item.kind));
  for(const kind of ['source','consent','segmentation','outreach','inbound','note','model_statement','meeting','stage_transition'])assert.ok(kinds.has(kind),`timeline includes ${kind}`);
  for(const item of timeline.items){assert.ok(item.occurred_at,'timestamp');assert.ok(item.actor_kind&&item.actor_id,'actor');assert.ok(item.source,'source');}
  const statement=timeline.items.find(item=>item.kind==='model_statement');assert.equal(statement.verified,false);assert.equal(statement.label,'Unverified model statement');
  assert.equal(timeline.items.find(item=>item.kind==='inbound').verified,true);
  await assert.rejects(db.query("UPDATE app.crm_relationship_events SET summary='Rewritten' WHERE contact_id=$1",[person.id]),/only be redacted/);
  await sales.redactContact(person.id);
  assert.equal(await count(db,'crm_relationship_events',`WHERE contact_id='${person.id}' AND summary<>'[Redacted]'`),0,'privacy erasure reaches relationship events');
  assert.equal(await count(db,'crm_contact_methods',`WHERE contact_id='${person.id}' AND value IS NOT NULL`),0);
 }finally{await db.close();}
});

test('DOTS-077 configurable pipelines guard transitions with evidence and never fabricate a conversion',async()=>{
 const {db,client}=await setup();try{
  const crm=new CrmWorkspace(client,ctx),sales=new SalesWorkspace(client,ctx);
  const person=(await crm.createPerson({name:'Parker Pipeline',email:'parker@pipeline.example',source:productSource})).contact;
  const deal=await crm.createDeal({projectId:project,label:'Synthetic subscription',valueCents:50000,contactIds:[person.id],expectedCloseAt:'2027-01-31'});
  assert.equal(deal.stage,'new');assert.equal(deal.probability_label,'unknown');
  const pipelines=await crm.pipelines();assert.deepEqual(pipelines[0].stages.map(stage=>stage.stage_key),['new','qualified','proposal','trial','negotiation','won','lost']);
  await assert.rejects(crm.transitionDeal({dealId:deal.id,toStage:'won',version:1,evidence:{kind:'owner_note',ref:'We definitely won this one'}}),/TRANSITION_NOT_ALLOWED/);
  await assert.rejects(crm.transitionDeal({dealId:deal.id,toStage:'qualified',version:1}),/STAGE_REQUIRES_OWNER_NOTE/);
  await assert.rejects(crm.transitionDeal({dealId:deal.id,toStage:'qualified',version:7,evidence:{kind:'owner_note',ref:'Synthetic qualification'}}),/STALE_RECORD/);
  const negotiation=await advanceToNegotiation(crm,deal);assert.equal(negotiation.stage,'negotiation');assert.equal(negotiation.probability_label,'high');
  await assert.rejects(crm.transitionDeal({dealId:deal.id,toStage:'won',version:Number(negotiation.version),evidence:{kind:'owner_note',ref:'Owner says it closed'}}),/WON_REQUIRES_VERIFIED_PAYMENT_OR_SIGNATURE/);
  const sandbox=await paidLiveInvoice(db,deal.id,crm,50000,{testMode:true});
  await assert.rejects(crm.transitionDeal({dealId:deal.id,toStage:'won',version:Number(negotiation.version),evidence:{kind:'paid_invoice',ref:sandbox.invoice}}),/WON_REQUIRES_VERIFIED_PAYMENT_OR_SIGNATURE/,'sandbox payments are not conversions');
  const simulated=await paidLiveInvoice(db,deal.id,crm,50000,{source:'simulation'});
  await assert.rejects(crm.transitionDeal({dealId:deal.id,toStage:'won',version:Number(negotiation.version),evidence:{kind:'provider_receipt',ref:simulated.entry}}),/WON_REQUIRES_VERIFIED_PAYMENT_OR_SIGNATURE/,'simulated receipts are not conversions');
  const otherDeal=await crm.createDeal({projectId:project,label:'Other deal',valueCents:1,contactIds:[person.id]});
  const foreign=await paidLiveInvoice(db,otherDeal.id,crm,100);
  await assert.rejects(crm.transitionDeal({dealId:deal.id,toStage:'won',version:Number(negotiation.version),evidence:{kind:'provider_receipt',ref:foreign.entry}}),/WON_REQUIRES_VERIFIED_PAYMENT_OR_SIGNATURE/,'evidence must belong to this deal');
  await assert.rejects(crm.linkInvoice(deal.id,foreign.invoice),/INVOICE_LINKED_TO_OTHER_DEAL/);
  const live=await paidLiveInvoice(db,deal.id,crm,50000);
  const won=await crm.transitionDeal({dealId:deal.id,toStage:'won',version:Number(negotiation.version),evidence:{kind:'paid_invoice',ref:live.invoice}});
  assert.equal(won.stage,'won');assert.ok(won.won_at);
  await assert.rejects(crm.transitionDeal({dealId:deal.id,toStage:'lost',version:Number(won.version),evidence:{kind:'owner_note',ref:'Trying to reopen'}}),/TRANSITION_NOT_ALLOWED/,'won is terminal');
  assert.equal(await count(db,'crm_deal_transitions',`WHERE deal_id='${deal.id}'`),4);
  await assert.rejects(db.query('DELETE FROM app.crm_deal_transitions'),/append-only/);
  // The legacy board path can no longer fabricate wins or bypass pipeline rules.
  const legacy=await sales.addDeal(project,'Legacy deal',100);
  await assert.rejects(sales.moveDeal(legacy.id,'won',1),/WON_REQUIRES_VERIFIED_EVIDENCE/);
  await assert.rejects(sales.moveDeal(deal.id,'lost',Number(won.version)),/USE_PIPELINE_TRANSITION/);
  assert.equal((await sales.moveDeal(legacy.id,'qualified',1)).stage,'qualified');
  // Custom pipelines: a trial-first flow, with won always needing verified evidence.
  await assert.rejects(crm.createPipeline({label:'Unsafe',stages:[{key:'open',label:'Open',outcome:'open',evidenceRule:'none',probabilityLabel:'unknown'},{key:'won',label:'Won',outcome:'won',evidenceRule:'owner_note',probabilityLabel:'closed'}],transitions:[['open','won']]}),/WON_REQUIRES_VERIFIED_EVIDENCE_RULE/);
  const custom=await crm.createPipeline({label:'Self-serve trial',stages:[{key:'trial',label:'Trial',outcome:'open',evidenceRule:'none',probabilityLabel:'low'},{key:'converted',label:'Converted',outcome:'won',evidenceRule:'verified_payment_or_signature',probabilityLabel:'closed'},{key:'churned',label:'Churned',outcome:'lost',evidenceRule:'owner_note',probabilityLabel:'closed'}],transitions:[['trial','converted'],['trial','churned']]});
  const trial=await crm.createDeal({projectId:project,label:'Trial deal',valueCents:2000,contactIds:[person.id],pipelineId:custom.id});assert.equal(trial.stage,'trial');
  await assert.rejects(crm.transitionDeal({dealId:trial.id,toStage:'converted',version:1}),/WON_REQUIRES_VERIFIED_PAYMENT_OR_SIGNATURE/);
  const doc=(await db.query("INSERT INTO app.document_library(organization_id,project_id,title,content_type,encrypted_content,content_hash,rights_basis) VALUES($1,$2,'Synthetic signed agreement','text/plain','ciphertext','hash','owner_original') RETURNING id",[org,project])).rows[0].id;
  assert.equal((await crm.transitionDeal({dealId:trial.id,toStage:'converted',version:1,evidence:{kind:'document',ref:doc}})).stage,'converted','a stored signed agreement is accepted evidence');
 }finally{await db.close();}
});

test('DOTS-078 multi-contact deals keep forecast, invoiced and received cash separate',async()=>{
 const {db,client}=await setup();try{
  const crm=new CrmWorkspace(client,ctx),sales=new SalesWorkspace(client,ctx);
  const one=(await crm.createPerson({name:'Deal One',email:'one@deal.example',source:productSource})).contact,two=(await crm.createPerson({name:'Deal Two',email:'two@deal.example',source:productSource})).contact;
  const linked=await campaign(sales,'Deal campaign');
  const deal=await crm.createDeal({projectId:project,label:'Team plan',valueCents:50000,contactIds:[one.id,two.id,one.id],campaignId:linked.id,expectedCloseAt:'2027-02-01T00:00:00Z'});
  assert.equal(deal.campaign_id,linked.id);assert.equal(await count(db,'crm_deal_contacts',`WHERE deal_id='${deal.id}'`),2);
  const grant=await sales.createCampaign({projectId:project,label:'Grant',purpose:'grant',goal:'Synthetic'}).catch(()=>null);
  if(grant)await assert.rejects(crm.createDeal({projectId:project,label:'Mixed',valueCents:1,contactIds:[one.id],campaignId:grant.id}),/DEALS_ARE_PRODUCT_REVENUE_ONLY/);
  let financials=await crm.dealFinancials({dealId:deal.id});
  assert.deepEqual([financials.deals[0].forecast_cents,financials.deals[0].invoiced_cents,financials.deals[0].received_cents],[50000,0,0]);
  const issued=(await db.query("INSERT INTO app.invoices(organization_id,project_id,label,invoice_number,state,amount_cents,description,test_mode) VALUES($1,$2,'Deposit','INV-SYN-1','issued',30000,'Synthetic deposit',false) RETURNING id",[org,project])).rows[0].id;
  await crm.linkInvoice(deal.id,issued);
  await db.query("INSERT INTO app.money_entries(organization_id,project_id,invoice_id,idempotency_key,kind,amount_cents,source,evidence_ref) VALUES($1,$2,$3,'sandbox-1','sale_receipt',30000,'simulation','synthetic')",[org,project,issued]);
  financials=await crm.dealFinancials({dealId:deal.id});
  assert.deepEqual([financials.deals[0].forecast_cents,financials.deals[0].invoiced_cents,financials.deals[0].received_cents,financials.deals[0].sandbox_cents],[50000,30000,0,30000],'sandbox money is never received cash');
  await db.query("INSERT INTO app.money_entries(organization_id,project_id,invoice_id,idempotency_key,kind,amount_cents,source,evidence_ref) VALUES($1,$2,$3,'provider-1','sale_receipt',30000,'provider','synthetic-provider-event')",[org,project,issued]);
  financials=await crm.dealFinancials();
  assert.equal(financials.deals.find(item=>item.id===deal.id).received_cents,30000);
  assert.deepEqual(financials.totals,{forecastCents:50000,invoicedCents:30000,receivedCents:30000});
  assert.equal(financials.deals.find(item=>item.id===deal.id).contacts.length,2);
 }finally{await db.close();}
});

test('DOTS-079 conservative attribution uses verified receipts, dedupes touches, merges identities and never double counts a won deal',async()=>{
 const {db,client}=await setup();try{
  const crm=new CrmWorkspace(client,ctx),sales=new SalesWorkspace(client,ctx);
  const acme=(await crm.createAccount({name:'Attribution Synthetic'})).account;
  const a=(await crm.createPerson({name:'Sam Attribution',email:'sam@attr.example',source:productSource,accountId:acme.id})).contact;
  const dup=(await crm.createPerson({name:'Sam Attribution',email:'sam.a@attr.example',source:productSource,accountId:acme.id})).contact;
  const early=await campaign(sales,'Early campaign'),late=await campaign(sales,'Late campaign');
  await sentMessage(db,client,dup.id,{campaignId:early.id,providerId:'attr-1',daysAgo:20});
  await sentMessage(db,client,a.id,{campaignId:early.id,providerId:'attr-2',daysAgo:20});
  await sentMessage(db,client,a.id,{campaignId:late.id,providerId:'attr-3',daysAgo:3});
  await sentMessage(db,client,a.id,{campaignId:late.id,providerId:'attr-draft',daysAgo:2,state:'failed'});
  await sentMessage(db,client,a.id,{campaignId:early.id,providerId:'attr-old',daysAgo:200});
  await crm.mergeContacts({survivorId:a.id,duplicateId:dup.id});
  assert.equal((await crm.recordVerifiedTouchpoints()).inserted,4);assert.equal((await crm.recordVerifiedTouchpoints()).inserted,0,'idempotent');
  await crm.recordTouchpoint({contactId:a.id,campaignId:late.id,channel:'meeting',direction:'outbound',receiptRef:'owner-claimed-meeting',occurredAt:new Date(Date.now()-86400000).toISOString()});
  const deal=await crm.createDeal({projectId:project,label:'Attributed deal',valueCents:90000,contactIds:[a.id]});
  assert.deepEqual(await crm.attributeDeal(deal.id),{attributed:false,reason:'DEAL_NOT_WON'});
  const negotiation=await advanceToNegotiation(crm,deal);
  const doc=(await db.query("INSERT INTO app.document_library(organization_id,project_id,title,content_type,encrypted_content,content_hash,rights_basis) VALUES($1,$2,'Synthetic signed order','text/plain','c','h','owner_original') RETURNING id",[org,project])).rows[0].id;
  await crm.transitionDeal({dealId:deal.id,toStage:'won',version:Number(negotiation.version),evidence:{kind:'document',ref:doc}});
  assert.deepEqual(await crm.attributeDeal(deal.id),{attributed:false,reason:'NO_VERIFIED_RECEIPT'},'a signature without cash is not an attributed paid win');
  await paidLiveInvoice(db,deal.id,crm,90000);
  const attributed=await crm.attributeDeal(deal.id);
  assert.equal(attributed.attributed,true);assert.equal(attributed.consideredTouches,3);assert.equal(attributed.dedupedTouches,2,'same-campaign touches within the dedup window collapse');
  const byModel=Object.fromEntries(attributed.rows.map(row=>[row.model,row]));
  assert.equal(byModel.first_touch.campaign_id,early.id);assert.equal(byModel.last_touch.campaign_id,late.id);assert.equal(Number(byModel.first_touch.received_cents),90000);
  const again=await Promise.all([crm.attributeDeal(deal.id),new CrmWorkspace(serialized(db),ctx).attributeDeal(deal.id)]);
  assert.ok(again.every(result=>result.idempotent));
  const report=await crm.attributionReport();assert.equal(report.attributedDeals,1);
  for(const model of ['first_touch','last_touch'])assert.equal(report.byCampaign.filter(row=>row.model===model).reduce((sum,row)=>sum+row.won_deals,0),1,`${model} counts the deal once`);
  await assert.rejects(db.query("INSERT INTO app.crm_attributions(organization_id,deal_id,model,touchpoint_id,received_cents,receipt_evidence,window_days,dedup_hours) VALUES($1,$2,'first_touch',$3,1,'x',1,1)",[org,deal.id,byModel.first_touch.touchpoint_id]),/duplicate key|unique/);
 }finally{await db.close();}
});

test('DOTS-080 snapshot powers lead cards, account map, board and inspector with bulk review and no raw addresses',async()=>{
 const {db,client}=await setup();try{
  const crm=new CrmWorkspace(client,ctx);
  const acct=(await crm.createAccount({name:'Board Synthetic'})).account;
  const ids=[];for(let i=0;i<30;i++)ids.push((await crm.createPerson({name:`Board Person ${String(i).padStart(2,'0')}`,email:`board${i}@board.example`,source:productSource,accountId:acct.id})).contact.id);
  await crm.createDeal({projectId:project,label:'Board deal',valueCents:1000,contactIds:[ids[0]]});
  const snap=await crm.snapshot({contactId:ids[0]});
  assert.equal(snap.contacts.items.length,24);assert.ok(snap.contacts.nextCursor);
  const next=await crm.snapshot({cursor:snap.contacts.nextCursor});assert.equal(next.contacts.items.length,6);assert.equal(next.contacts.nextCursor,null);
  assert.equal(snap.accountMap.accounts[0].contact_count,30);assert.ok(snap.pipelines[0].stages.length>=6);assert.equal(snap.financials.deals.length,1);
  assert.ok(snap.inspector.timeline.length>0);assert.equal(snap.inspector.contact.id,ids[0]);
  const serialized=JSON.stringify(snap);assert.ok(!/board\d+@/.test(serialized),'snapshot never includes raw addresses');
  assert.equal((await crm.bulkReview({contactIds:ids.slice(0,3),action:'archive'})).affected,3);
  assert.equal((await crm.bulkReview({contactIds:ids.slice(3,5),action:'suppress'})).affected,2);
  assert.equal((await crm.bulkReview({contactIds:ids.slice(5,8),action:'assign_to_me'})).affected,3);
  await assert.rejects(crm.bulkReview({contactIds:ids,action:'delete_everything'}),/INVALID_BULK_ACTION/);
  await assert.rejects(crm.searchContacts({cursor:'not-a-cursor'}),/INVALID_CURSOR/);
  assert.equal(await count(db,'contact_suppressions'),2);
  const view=await readFile(new URL('../apps/web/app/views/crm-view.tsx',import.meta.url),'utf8');
  for(const required of ['export function CrmView','/api/v1/crm','aria-live','role="alert"','onDragStart','onDrop','aria-label','Move to stage','Bulk review','Contacts','Pipeline'])assert.ok(view.includes(required),`view includes ${required}`);
  assert.ok(!/<table/.test(view),'no dense mandatory tables');
  const route=await readFile(new URL('../apps/web/app/api/v1/crm/route.ts',import.meta.url),'utf8');
  for(const required of ["dynamic='force-dynamic'",'hasTrustedOrigin','ownerSession','private, no-store','withOperations','JSON_REQUIRED','REQUEST_TOO_LARGE'])assert.ok(route.includes(required),`route includes ${required}`);
 }finally{await db.close();}
});

test('DOTS-070..080 runtime grants allow CRM workflows under row-level security without deleting evidence or rewriting identity keys',async()=>{
 const {db,client}=await setup();try{
  await addOtherTenant(db);await addSecondAgent(client);
  await db.exec('CREATE ROLE dots_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;GRANT USAGE ON SCHEMA app TO dots_runtime;GRANT SELECT ON app.memberships,app.projects,app.agent_identities,app.agent_project_assignments,app.audit_events TO dots_runtime;GRANT INSERT ON app.audit_events TO dots_runtime;');
  await db.exec(await readFile(new URL('../database/runtime-grants.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../database/runtime-grants-0017.sql',import.meta.url),'utf8'));
  for(const table of ['crm_contact_sources','crm_merges','crm_consent_evidence','crm_suppression_history','crm_deal_transitions','crm_touchpoints','crm_attributions','crm_relationship_events','contact_suppressions','crm_prospect_claims'])assert.equal((await db.query("SELECT has_table_privilege('dots_runtime',$1,'DELETE') AS allowed",[`app.${table}`])).rows[0].allowed,false,table);
  for(const table of ['crm_aliases','crm_import_batches','crm_prospect_claims','crm_segments','crm_relationship_events'])for(const column of ['id','organization_id'])assert.equal((await db.query("SELECT has_column_privilege('dots_runtime',$1,$2,'UPDATE') AS allowed",[`app.${table}`,column])).rows[0].allowed,false,`${table}.${column}`);
  await db.exec('SET ROLE dots_runtime');
  const crm=new CrmWorkspace(client,ctx),sales=new SalesWorkspace(client,ctx);
  await allowUS(crm);await crm.setContactPolicy({maxTouches:2,windowDays:7,exclusionDays:14});
  const account=(await crm.createAccount({name:'Runtime Synthetic',aliases:['RT']})).account;
  const person=(await crm.createPerson({name:'Runtime Person',email:'runtime@rt.example',source:productSource,accountId:account.id,consent:'opted_in',consentEvidence:'Synthetic',jurisdiction:'US'})).contact;
  const twin=(await crm.createPerson({name:'Runtime Person',email:'runtime.two@rt.example',source:productSource,accountId:account.id})).contact;
  const staged=await crm.stageImport({source:productSource,rows:[{name:'Runtime Import',email:'import@rt.example',consent:'opted_in',consentEvidence:'Synthetic'}]});await crm.commitImport(staged.batchId);
  const candidate=(await crm.listCandidates()).find(item=>[item.primary_contact_id,item.duplicate_contact_id].includes(twin.id));assert.ok(candidate);
  await crm.mergeContacts({survivorId:person.id,duplicateId:twin.id,candidateId:candidate.id});
  const sequence=await campaign(sales,'Runtime campaign');
  assert.equal((await crm.claimProspect({contactId:person.id,campaignId:sequence.id,agentId:agent})).claimed,true);
  await crm.suppress({contactId:person.id,reason:'RUNTIME_TEST',source:'owner'});
  assert.equal((await crm.overrideSuppression({contactId:person.id,lawfulBasis:'owner_entry_error',auditRef:'Synthetic runtime audit'})).consent,'unknown','an entry-error override does not invent consent');
  await crm.recordConsent({contactId:person.id,consent:'opted_in',evidenceRef:'Synthetic runtime opt-in receipt',jurisdiction:'US'});
  await tenant(client,ctx,async tx=>assert.equal((await assertContactable(tx,ctx,{contactId:person.id,campaignId:sequence.id,channel:'email'})).allowed,true));
  const segment=await crm.saveSegment({label:'Runtime',filter:{accountIds:[account.id]}});await crm.previewSegment({segmentId:segment.id});await crm.materializeSegment(segment.id);
  await crm.addRelationshipEvent({contactId:person.id,kind:'note',summary:'Runtime owner note',actorKind:'owner',source:'owner'});
  const deal=await crm.createDeal({projectId:project,label:'Runtime deal',valueCents:100,contactIds:[person.id]});
  await crm.transitionDeal({dealId:deal.id,toStage:'qualified',version:1,evidence:{kind:'owner_note',ref:'Synthetic runtime qualification'}});
  await crm.recordVerifiedTouchpoints();await crm.bulkReview({contactIds:[person.id],action:'assign_to_me'});
  const snapshot=await crm.snapshot({contactId:person.id});assert.ok(snapshot.inspector.timeline.length>3);
  assert.equal(snapshot.claims.length,0,'suppression released the earlier claim');
  const reclaimed=await crm.claimProspect({contactId:person.id,campaignId:sequence.id,agentId:agent});assert.equal(reclaimed.claimed,true);await crm.releaseClaim(reclaimed.claim.id);
  await sales.redactContact(person.id);
  await assert.rejects(tenant(client,ctx,tx=>tx.query("INSERT INTO app.crm_segments(organization_id,label,filter,filter_hash) VALUES($1,'x','{}','h')",[otherOrg])),/row-level security/);
  assert.equal((await new CrmWorkspace(client,otherCtx).searchContacts({})).items.length,0);
  await assert.rejects(tenant(client,ctx,tx=>tx.query('DELETE FROM app.contact_suppressions')),/permission denied/);
 }finally{await db.close();}
});

test('migration 0017 rolls back and re-applies cleanly',async()=>{
 const db=new PGlite();try{
  const directory=new URL('../database/migrations/',import.meta.url);
  for(const file of (await readdir(directory)).filter(name=>name.endsWith('.up.sql')&&name<'0014').sort())await db.exec(await readFile(new URL(file,directory),'utf8'));
  await db.exec(await readFile(new URL('0017_crm_lead_integrity.up.sql',directory),'utf8'));
  await db.exec(await readFile(new URL('0017_crm_lead_integrity.down.sql',directory),'utf8'));
  assert.equal((await db.query("SELECT to_regclass('app.crm_segments') AS t")).rows[0].t,null);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema='app' AND table_name='crm_contacts' AND column_name='merged_into_id'")).rows[0].n,0);
  await db.exec(await readFile(new URL('0017_crm_lead_integrity.up.sql',directory),'utf8'));
  assert.ok((await db.query("SELECT to_regclass('app.crm_segments') AS t")).rows[0].t);
 }finally{await db.close();}
});

test('DOTS-081 50,000 synthetic contacts keep paginated search bounded, dedupe and suppression correct, tenants isolated and logs free of raw addresses',async()=>{
 const {db,client}=await setup();try{
  await addOtherTenant(db);
  const logged=[];const originals={log:console.log,error:console.error,warn:console.warn,info:console.info};
  for(const name of Object.keys(originals))console[name]=(...args)=>{logged.push(args.map(String).join(' '));};
  const started=Date.now();
  try{
   const seed=async(organizationId,total)=>{
    await db.query("INSERT INTO app.crm_accounts(organization_id,name,domain) SELECT $1,'Scale Account '||g,'scale'||g||'.example' FROM generate_series(0,99) g",[organizationId]);
    await db.query(`WITH acc AS (SELECT array_agg(id ORDER BY domain) AS ids FROM app.crm_accounts WHERE organization_id=$1)
     INSERT INTO app.crm_contacts(organization_id,account_id,display_name,email,email_hash,status,consent,lawful_source,jurisdiction,metadata)
     SELECT $1,acc.ids[1+(g%100)],'Scale Person '||g,'person'||g||'@scale'||(g%100)||'.example',encode(sha256(convert_to('"person'||g||'@scale'||(g%100)||'.example"','UTF8')),'hex'),
      'active',CASE WHEN g%3=0 THEN 'unknown' ELSE 'opted_in' END,'Synthetic scale fixture',CASE WHEN g%10=0 THEN 'unreviewed' ELSE 'US' END,
      jsonb_build_object('tier',CASE WHEN g%2=0 THEN 'gold' ELSE 'silver' END)
     FROM generate_series(1,$2::int) g,acc`,[organizationId,total]);
   };
   await seed(org,50000);await seed(otherOrg,1000);
   // 50 designed duplicates (same name and corporate domain, different address) and 500 suppressed addresses.
   await db.query(`INSERT INTO app.crm_contacts(organization_id,account_id,display_name,email,email_hash,status,consent,lawful_source,jurisdiction)
    SELECT organization_id,account_id,display_name,'alt.'||email,encode(sha256(convert_to('"alt.'||email||'"','UTF8')),'hex'),'active','opted_in','Synthetic duplicate','US'
    FROM app.crm_contacts WHERE organization_id=$1 AND display_name ~ '^Scale Person [0-9]+000$'`,[org]);
   await db.query(`INSERT INTO app.contact_suppressions(organization_id,email_hash,reason,source) SELECT organization_id,email_hash,'SYNTHETIC','owner' FROM app.crm_contacts WHERE organization_id=$1 AND email NOT LIKE 'alt.%' AND (substring(display_name from 14)::int)%100=7`,[org]);
   await db.exec('ANALYZE app.crm_contacts;ANALYZE app.contact_suppressions;ANALYZE app.crm_accounts;');
   assert.equal(await count(db,'crm_contacts',`WHERE organization_id='${org}'`),50050);
   const seededIn=Date.now()-started;
   const crm=new CrmWorkspace(client,ctx);await allowUS(crm);
   const timings=[];
   const timed=async fn=>{const start=performance.now();const result=await fn();timings.push(performance.now()-start);return result;};
   let page=await timed(()=>crm.searchContacts({q:'scale person 1',limit:25}));assert.equal(page.items.length,25);
   const seen=new Set(page.items.map(item=>item.id));
   for(let i=0;i<4;i++){page=await timed(()=>crm.searchContacts({q:'scale person 1',limit:25,cursor:page.nextCursor}));assert.ok(page.items.length<=25);for(const item of page.items){assert.ok(!seen.has(item.id),'keyset pages never repeat');seen.add(item.id);}}
   for(const q of ['scale person 4999','scale person 2','scale person 377','scale7.example','person12345@scale45.example','zzz'])await timed(()=>crm.searchContacts({q,limit:25}));
   assert.equal((await crm.searchContacts({q:'person12345@scale45.example'})).items[0].display_name,'Scale Person 12345');
   for(let i=0;i<10;i++)await timed(()=>crm.searchContacts({limit:50}));
   const sorted=[...timings].sort((a,b)=>a-b),p95=sorted[Math.floor(sorted.length*0.95)-1]??sorted[sorted.length-1];
   assert.ok(p95<1500,`search p95 ${p95.toFixed(1)}ms stays bounded`);
   const plan=(await db.query(`EXPLAIN SELECT c.* FROM app.crm_contacts c WHERE c.organization_id='${org}' AND c.status<>'merged' AND (c.normalized_name COLLATE "C")>='scaleperson1' AND (c.normalized_name COLLATE "C")<'scaleperson1{' ORDER BY (c.normalized_name COLLATE "C"),c.id LIMIT 26`)).rows.map(row=>row['QUERY PLAN']).join('\n');
   assert.match(plan,/Limit/);assert.match(plan,/Index Scan|Index Only Scan|Bitmap Index Scan/,'search uses an index');assert.doesNotMatch(plan,/Seq Scan on crm_contacts/);
   assert.equal((await crm.searchContacts({limit:1000})).items.length,50,'page size is capped at 50');
   // Dedupe correctness at scale.
   const dedupeStart=Date.now();const detected=await crm.detectDuplicates();
   assert.equal(detected.candidates,50,'exactly the designed duplicate pairs');assert.ok(Date.now()-dedupeStart<20000,'dedupe scan bounded');
   assert.ok((await crm.listCandidates(100)).every(item=>item.score===90));
   // Suppression correctness at scale.
   const suppressedCount=await count(db,'contact_suppressions',`WHERE organization_id='${org}'`);assert.equal(suppressedCount,500);
   const previewStart=Date.now();const preview=await crm.previewSegment({filter:{}});
   assert.ok(Date.now()-previewStart<20000,'segment preview bounded');assert.equal(preview.matched,50050);
   const reasons=Object.fromEntries(preview.exclusions.map(item=>[item.reason,item.count]));assert.equal(reasons.CONTACT_SUPPRESSED,500);
   assert.equal(preview.eligible+preview.excluded,preview.matched);assert.ok(preview.sample.length<=10);
   const suppressedOne=(await db.query("SELECT id FROM app.crm_contacts WHERE organization_id=$1 AND display_name='Scale Person 107'",[org])).rows[0].id;
   const sales=new SalesWorkspace(client,ctx);const sequence=await campaign(sales,'Scale campaign');
   await tenant(client,ctx,async tx=>assert.rejects(assertContactable(tx,ctx,{contactId:suppressedOne,campaignId:sequence.id,channel:'email'}),/CONTACT_SUPPRESSED/));
   // Tenant isolation at scale.
   const other=new CrmWorkspace(client,otherCtx);
   const theirs=await other.searchContacts({q:'scale person 1',limit:50});assert.ok(theirs.items.every(item=>item.organization_id===otherOrg));
   assert.equal((await other.previewSegment({filter:{}})).matched,1000);
   assert.equal((await other.searchContacts({q:'person12345@scale45.example'})).items.length,0);
   // Privacy: events, snapshot and console output never carry raw addresses.
   const snap=JSON.stringify(await crm.snapshot({q:'scale person 12'}));
   assert.ok(!/person\d+@/.test(snap),'snapshot masks every address');
   const events=(await db.query("SELECT details::text AS d FROM app.operation_events WHERE organization_id=$1",[org])).rows.map(row=>row.d).join('\n');
   assert.ok(!events.includes('@'),'operation events carry no addresses');
   assert.equal(redactPii('Contact person1@scale1.example now'),'Contact p***@scale1.example now');assert.equal(maskEmail('person1@scale1.example'),'p***@scale1.example');
   assert.ok(Date.now()-started<120000,`scale suite finished in ${Date.now()-started}ms (seed ${seededIn}ms)`);
  }finally{Object.assign(console,originals);}
  assert.ok(!logged.some(line=>/person\d+@/.test(line)),'no raw address reaches console output');
 }finally{await db.close();}
});
