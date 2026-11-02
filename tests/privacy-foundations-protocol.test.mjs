import test from 'node:test';import assert from 'node:assert/strict';
import {cacheExpiry,tenantProjectExport,PrivacyFoundationRepository} from '../packages/database/dist/index.js';
const org='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222',id='33333333-3333-4333-8333-333333333333',member='44444444-4444-4444-8444-444444444444';
const context={organizationId:org,membershipId:member,correlationId:id,policyVersion:'privacy-v1'};
const project={id,organization_id:org,label:'Synthetic project',content:{summary:'Synthetic'},status:'active',version:'9007199254740993',credential:'must not copy'};
const offer={...project,id:member,project_id:id};
test('derived cache retention is finite, bounded and defaults to seven days',()=>{
 assert.equal(cacheExpiry(0),'1970-01-08T00:00:00.000Z');
 assert.equal(cacheExpiry(0,1),'1970-01-01T00:00:01.000Z');
 for(const ttl of [0,-1,Infinity,NaN,30*86400+1,1.5])assert.throws(()=>cacheExpiry(0,ttl));
});
test('export rejects foreign tenant/parent and selects only approved public document fields',()=>{
 const result=tenantProjectExport(org,project,[offer]);
 assert.equal(result.project.version,'9007199254740993');assert.equal(JSON.stringify(result).includes('must not copy'),false);
 assert.equal(result.offers.length,1);
 assert.throws(()=>tenantProjectExport(other,project,[offer]),/tenant/);
 assert.throws(()=>tenantProjectExport(org,project,[{...offer,organization_id:other}]),/tenant/);
 assert.throws(()=>tenantProjectExport(org,project,[{...offer,project_id:other}]),/resource/);
 assert.throws(()=>tenantProjectExport(org,project,Array(101).fill(offer)),/resource/);
 assert.throws(()=>tenantProjectExport(org,{...project,content:{data:'x'.repeat(2100000)}},[]),/bounded/);
});
function fixture(authorized=true){const calls=[];return {calls,query:async(sql,args)=>{calls.push({sql,args});
 if(sql.includes('SELECT id FROM app.memberships'))return {rows:authorized?[{id:member}]:[]};
 if(sql.startsWith('INSERT INTO app.privacy_'))return {rows:[{id}]};
 if(sql.startsWith('WITH expired'))return {rows:[{id}]};
 if(sql.startsWith('SELECT p.id'))return {rows:[{...project,offers:[offer]}]};
 return {rows:[]};}};}
test('current owner and tenant authorization precede every cache/export operation',async()=>{
 const db=fixture(false),repo=new PrivacyFoundationRepository(db);
 await assert.rejects(repo.exportProject(context,id),/not authorized/);
 await assert.rejects(repo.putCache(context,{derived:true}),/not authorized/);
 await assert.rejects(repo.expireCaches(context),/not authorized/);
 assert.equal(db.calls.some(c=>c.sql.startsWith('INSERT')),false);
 assert.equal(db.calls.at(-1).sql,'ROLLBACK');
});
test('expiry cleanup is bounded, tenant-bound and excludes live evidence holds',async()=>{
 const db=fixture(),repo=new PrivacyFoundationRepository(db);
 assert.deepEqual(await repo.expireCaches(context,10),[id]);
 const cleanup=db.calls.find(c=>c.sql.startsWith('WITH expired'));
 assert.deepEqual(cleanup.args,[org,10]);assert.match(cleanup.sql,/h.released_at IS NULL AND h.expires_at>clock_timestamp/);assert.match(cleanup.sql,/FOR UPDATE OF c SKIP LOCKED/);
 assert.throws(()=>repo.expireCaches(context,101));
 assert.throws(()=>repo.holdCache(context,id,'HOLD',365*86400+1));
});
test('cache payload/hold metadata is bounded and export uses one same-tenant statement',async()=>{
 const db=fixture(),repo=new PrivacyFoundationRepository(db);
 assert.equal(await repo.putCache(context,{derived:true}),id);
 assert.equal(await repo.holdCache(context,id,'REVIEW_HOLD',3600),id);
 assert.throws(()=>repo.putCache(context,{large:'x'.repeat(16385)}));
 const exported=await repo.exportProject(context,id);assert.equal(exported.organizationId,org);
 const query=db.calls.find(c=>c.sql.startsWith('SELECT p.id'));
 assert.deepEqual(query.args,[org,id]);assert.match(query.sql,/LIMIT 101/);assert.match(query.sql,/2000000/);
 assert.equal(db.calls.at(-1).sql,'COMMIT');
});
test('privacy requests validate kind/resource and reject foreign targets before recording a request',async()=>{
 const db=fixture(),repo=new PrivacyFoundationRepository(db);
 assert.throws(()=>repo.request(context,'other','project',id,'REQUEST'));
 assert.throws(()=>repo.request(context,'delete','credentials',id,'REQUEST'));
 await assert.rejects(repo.request(context,'delete','project',id,'REQUEST'),/resource unavailable/);
 assert.equal(db.calls.some(c=>c.sql.startsWith('INSERT INTO app.privacy_requests')),false);
});

test('correction applies the recorded version atomically and rolls back stale updates',async()=>{
 const calls=[];const database={query:async(sql,args)=>{calls.push({sql,args});
  if(sql.includes('SELECT id FROM app.memberships'))return {rows:[{id:member}]};
  if(sql.startsWith('SELECT resource_type'))return {rows:[{resource_type:'project',resource_id:id,expected_version:'7'}]};
  if(sql.startsWith('UPDATE app.projects'))return {rows:[]};
  return {rows:[]};}};
 await assert.rejects(new PrivacyFoundationRepository(database).correct(context,id,{label:'Corrected',content:{summary:'Synthetic correction'}}),/version conflict/);
 const write=calls.find(c=>c.sql.startsWith('UPDATE app.projects'));assert.equal(write.args[5],'7');assert.match(write.sql,/version=\$6::bigint/);
 assert.equal(calls.at(-1).sql,'ROLLBACK');assert.equal(calls.some(c=>c.sql.startsWith('UPDATE app.privacy_requests')),false);
});

test('database failures cannot leak source content through repository errors',async()=>{
 const database={query:async sql=>{if(sql.includes('SELECT id FROM app.memberships'))return {rows:[{id:member}]};if(sql==='ROLLBACK'||sql==='BEGIN'||sql.startsWith('SELECT set_config'))return {rows:[]};throw Error('private source content in driver detail');}};
 await assert.rejects(new PrivacyFoundationRepository(database).exportProject(context,id),error=>error.message==='Privacy operation unavailable'&&!String(error).includes('private source'));
});

test('export requests enqueue one durable job without claiming a completed artifact',async()=>{
 const calls=[];const database={query:async(sql,args)=>{calls.push({sql,args});
  if(sql.includes('SELECT id FROM app.memberships')||sql.startsWith('SELECT id FROM app.privacy_requests'))return {rows:[{id}]};
  if(sql.startsWith('SELECT id FROM app.privacy_export_jobs'))return {rows:[{id:member}]};return {rows:[]};}};
 assert.equal(await new PrivacyFoundationRepository(database).enqueueExport(context,id),member);
 const insert=calls.find(c=>c.sql.startsWith('INSERT INTO app.privacy_export_jobs'));assert.deepEqual(insert.args,[org,id,member]);assert.match(insert.sql,/ON CONFLICT\(organization_id,request_id\) DO NOTHING/);
 assert.equal(calls.at(-1).sql,'COMMIT');assert.equal(insert.sql.includes("'ready'"),false);
});
