import test from 'node:test';import assert from 'node:assert/strict';
import {TransactionalEventRepository,sourceEventHash,sourceEventSnapshot,relayOutboxBatch} from '../packages/database/dist/index.js';
const org='11111111-1111-4111-8111-111111111111',member='22222222-2222-4222-8222-222222222222',id='33333333-3333-4333-8333-333333333333',claim='44444444-4444-4444-8444-444444444444';
const context={organizationId:org,membershipId:member,correlationId:id,policyVersion:'test-v1'};
const input={consumer:'projection',source:'verified-provider',externalEventId:'evt/one',eventType:'project.changed',references:{recordId:id,recordType:'project',version:'9007199254740993',status:'ACTIVE'}};
function fake({authorized=true,duplicate=false,hash=sourceEventHash(input),commitError=false,claims=[]}={}){
 const calls=[];return {calls,query:async(sql,args)=>{calls.push({sql,args});
  if(sql.includes('SELECT id FROM app.memberships'))return {rows:authorized?[{id:member}]:[]};
  if(sql.startsWith('INSERT INTO app.event_receipts'))return {rows:duplicate?[]:[{id}]};
  if(sql.startsWith('SELECT id,request_hash'))return {rows:[{id,request_hash:hash}]};
  if(sql==='COMMIT'&&commitError)throw Error('commit confirmation lost');
  if(sql.startsWith('WITH selected'))return {rows:claims};
  if(sql.startsWith('UPDATE app.event_outbox'))return {rows:[]};
  return {rows:[]};}};
}
test('event normalization is immutable, bounded, order independent and rejects arbitrary payloads',()=>{
 const snapshot=sourceEventSnapshot(input);assert.ok(Object.isFrozen(snapshot));assert.ok(Object.isFrozen(snapshot.references));
 assert.equal(sourceEventHash(input),sourceEventHash({...input,references:{status:'ACTIVE',version:'9007199254740993',recordType:'project',recordId:id}}));
 for(const bad of [{...input,source:'wrong source'},{...input,source:null},{...input,consumer:undefined},{...input,references:{...input.references,version:1}},{...input,references:{...input.references,recordType:null}},{...input,externalEventId:'x'.repeat(201)},{...input,references:{...input.references,body:'private'}},{...input,references:{...input.references,version:'1.1'}},{...input,references:{...input.references,recordId:'foreign'}},{...input,references:{...input.references,status:'name@example.test'}}])assert.throws(()=>sourceEventSnapshot(bad));
});
test('receipt claim and database handler commit atomically, and handler failures rollback',async()=>{
 const db=fake();let handled=0;
 const result=await new TransactionalEventRepository(db).apply(context,input,async(tx,event)=>{handled++;assert.equal(event.references.recordId,id);await tx.query('SYNTHETIC EFFECT');});
 assert.equal(result.replay,false);assert.equal(handled,1);assert.equal(db.calls.at(-1).sql,'COMMIT');
 assert.ok(db.calls.findIndex(c=>c.sql.startsWith('INSERT INTO app.event_receipts'))<db.calls.findIndex(c=>c.sql==='SYNTHETIC EFFECT'));
 const failing=fake();await assert.rejects(new TransactionalEventRepository(failing).apply(context,input,async()=>{throw Error('effect failed');}),/effect failed/);
 assert.equal(failing.calls.at(-1).sql,'ROLLBACK');
});
test('identical retries do not apply effects twice; conflicting IDs and unauthorized actors fail closed',async()=>{
 const db=fake({duplicate:true});let calls=0;
 assert.equal((await new TransactionalEventRepository(db).apply(context,input,async()=>{calls++;})).replay,true);assert.equal(calls,0);
 await assert.rejects(new TransactionalEventRepository(fake({duplicate:true,hash:'different'})).apply(context,input,async()=>{calls++;}),/conflicts/);
 const denied=fake({authorized:false});await assert.rejects(new TransactionalEventRepository(denied).apply(context,input,async()=>{calls++;}),/not authorized/);
 assert.equal(denied.calls.some(c=>c.sql.startsWith('INSERT')),false);assert.equal(calls,0);
});
test('unknown COMMIT is not automatically retried or reported confirmed',async()=>{
 const db=fake({commitError:true});let calls=0;
 await assert.rejects(new TransactionalEventRepository(db).apply(context,input,async()=>{calls++;}),/confirmation lost/);
 assert.equal(calls,1);assert.equal(db.calls.filter(c=>c.sql==='BEGIN').length,1);
});
test('claims are bounded and stale acknowledgement cannot be reported delivered',async()=>{
 const db=fake(),repo=new TransactionalEventRepository(db);
 for(const limit of [0,101,1.1])assert.throws(()=>repo.claim(context,{limit}));
 for(const leaseSeconds of [0,301,1.1])assert.throws(()=>repo.claim(context,{leaseSeconds}));
 assert.deepEqual(await repo.claim(context,{limit:2,leaseSeconds:60}),[]);
 assert.match(db.calls.find(c=>c.sql.startsWith('WITH selected')).sql,/FOR UPDATE SKIP LOCKED/);
 assert.equal(await repo.acknowledge(context,id,claim),false);
 assert.match(db.calls.at(-2).sql,/claim_token=\$3 AND claim_until>clock_timestamp\(\)/);
 assert.throws(()=>repo.retry(context,id,claim,3601));
});
test('relay sends each stable event ID once per batch and retains unconfirmed outcomes',async()=>{
 const event={schemaVersion:1,id,organizationId:org,auditEventId:id,eventType:'project.changed',correlationId:id,evidenceHash:'a'.repeat(64),occurredAt:'2026-11-01T00:00:00.000001Z'};
 let sends=0,retries=0;
 const repo={claim:async()=>[{event,claimToken:claim,attempts:1}],acknowledge:async()=>false,retry:async()=>{retries++;return true;}};
 assert.deepEqual(await relayOutboxBatch(repo,context,async e=>{sends++;assert.equal(e.id,id);}),{acknowledged:0,unconfirmed:1});
 assert.equal(sends,1);assert.equal(retries,0);
 assert.deepEqual(await relayOutboxBatch(repo,context,async()=>{sends++;throw Error('remote confirmation lost');}),{acknowledged:0,unconfirmed:1});
 assert.equal(sends,2);assert.equal(retries,1);
});
