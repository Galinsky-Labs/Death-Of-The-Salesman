import test from 'node:test';import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';import {readFile,readdir} from 'node:fs/promises';import {randomUUID} from 'node:crypto';
import {TransactionalEventRepository,ProjectCatalogRepository,setAuditContext,withTransaction} from '../packages/database/dist/index.js';
const org='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222',owner='33333333-3333-4333-8333-333333333333',foreign='44444444-4444-4444-8444-444444444444',manager='55555555-5555-4555-8555-555555555555';
const context={organizationId:org,membershipId:owner,correlationId:'66666666-6666-4666-8666-666666666666',policyVersion:'events-v1'};
test('transactional outbox SQL: rollback, durable retry, stale fencing, receipt dedupe and tenant isolation',async()=>{
 const db=new PGlite();try{
  const directory=new URL('../database/migrations/',import.meta.url),names=(await readdir(directory)).filter(n=>n.endsWith('.up.sql')).sort();
  for(const name of names.filter(n=>n<'0010'))await db.exec(await readFile(new URL(name,directory),'utf8'));
  await db.query("INSERT INTO app.organizations(id,slug,display_name) VALUES($1,'first','Synthetic'),($2,'other','Synthetic')",[org,other]);
  for(const [id,tenant,role] of [[owner,org,'owner'],[foreign,other,'owner'],[manager,org,'sales_manager']]){
   await db.query("INSERT INTO app.owner_users(id,identity_subject,display_name) VALUES($1,$1,'Synthetic')",[id]);
   await db.query("INSERT INTO app.memberships(id,organization_id,user_id,role) VALUES($1,$2,$1,$3)",[id,tenant,role]);
  }
  for(const name of names.filter(n=>n>='0010'))await db.exec(await readFile(new URL(name,directory),'utf8'));
  await db.exec("CREATE ROLE events_runtime NOLOGIN NOBYPASSRLS; GRANT USAGE ON SCHEMA app TO events_runtime; GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE ON ALL TABLES IN SCHEMA app TO events_runtime; GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO events_runtime; SET ROLE events_runtime;");
  const client={query:(sql,parameters)=>db.query(sql,parameters)},repo=new TransactionalEventRepository(client),catalog=new ProjectCatalogRepository(client);
  const query=sql=>withTransaction(client,async tx=>{await setAuditContext(tx,context);return tx.query(sql);});
  const project=await catalog.create({kind:'project',organizationId:org,ownerMembershipId:owner,label:'Synthetic project',content:{privateBody:'never included in event'}});
  assert.equal((await query('SELECT count(*)::int n FROM app.event_outbox')).rows[0].n,1);
  const first=(await repo.claim(context,{limit:1,leaseSeconds:5}))[0];assert.ok(first);
  assert.equal(first.event.auditEventId,first.event.id);assert.equal(first.attempts,1);
  assert.ok(!JSON.stringify(first.event).includes('privateBody'));
  assert.equal((await repo.claim(context,{limit:1})).length,0);
  assert.equal(await repo.acknowledge(context,first.event.id,randomUUID()),false);
  // Simulate a worker crash by allowing the actual database-clock lease to expire.
  await new Promise(resolve=>setTimeout(resolve,5100));
  const recovered=(await new TransactionalEventRepository(client).claim(context,{limit:1}))[0];
  assert.equal(recovered.event.id,first.event.id);assert.equal(recovered.attempts,2);assert.notEqual(recovered.claimToken,first.claimToken);
  assert.equal(await repo.acknowledge(context,first.event.id,first.claimToken),false);
  assert.equal(await repo.acknowledge(context,recovered.event.id,recovered.claimToken),true);
  assert.equal(await repo.acknowledge(context,recovered.event.id,recovered.claimToken),false);
  assert.equal((await repo.claim(context)).length,0);
  const before=(await query('SELECT count(*)::int n FROM app.event_outbox')).rows[0].n;
  await assert.rejects(withTransaction(client,async tx=>{
   await setAuditContext(tx,context);await tx.query("UPDATE app.projects SET label='Rollback' WHERE organization_id=$1 AND id=$2",[org,project.id]);throw Error('simulated crash before commit');
  }),/crash before commit/);
  assert.equal((await query('SELECT count(*)::int n FROM app.event_outbox')).rows[0].n,before);
  assert.equal((await catalog.get({kind:'project',organizationId:org,id:project.id})).label,'Synthetic project');
  const source={consumer:'project-label-projection',source:'verified-source',externalEventId:'event-1',eventType:'project.updated',references:{recordId:project.id,recordType:'project',version:'2',status:'ACTIVE'}};
  let handlers=0;
  const effect=async tx=>{handlers++;await tx.query("UPDATE app.projects SET label='Applied once',version=version+1 WHERE organization_id=$1 AND id=$2",[org,project.id]);};
  const applied=await repo.apply(context,source,effect);assert.equal(applied.replay,false);
  // Crash/lost confirmation after receiver COMMIT: a new repository receives the same ID.
  assert.equal((await new TransactionalEventRepository(client).apply(context,source,effect)).replay,true);assert.equal(handlers,1);
  assert.equal((await catalog.get({kind:'project',organizationId:org,id:project.id})).version,2);
  await assert.rejects(repo.apply(context,{...source,references:{...source.references,version:'3'}},effect),/conflicts/);assert.equal(handlers,1);
  const failSource={...source,externalEventId:'event-rollback'};
  await assert.rejects(repo.apply(context,failSource,async tx=>{await effect(tx);throw Error('handler crashed');}),/handler crashed/);
  assert.equal((await catalog.get({kind:'project',organizationId:org,id:project.id})).version,2);
  const retried=await repo.apply(context,failSource,async()=>{});assert.equal(retried.replay,false);
  await assert.rejects(repo.apply({...context,membershipId:manager},{...source,externalEventId:'denied'},effect),/not authorized/);
  await assert.rejects(repo.claim({...context,organizationId:other}),/not authorized/);
  await withTransaction(client,async tx=>{
   await tx.query("SELECT set_config('app.organization_id',$1,true)",[other]);
   assert.equal((await tx.query('SELECT id FROM app.event_receipts WHERE id=$1',[applied.id])).rows.length,0);
   assert.equal((await tx.query('SELECT id FROM app.event_outbox WHERE id=$1',[first.event.id])).rows.length,0);
  });
  await assert.rejects(query("TRUNCATE app.event_receipts"),/append-only/);
  await assert.rejects(query("TRUNCATE app.event_outbox"),/cannot be deleted/);
  await assert.rejects(query("UPDATE app.event_outbox SET event_type='forged.type'"),/immutable/);
  await withTransaction(client,async tx=>{
   await setAuditContext(tx,context);const event=(await tx.query('SELECT * FROM app.event_outbox LIMIT 1')).rows[0];
   await assert.rejects(tx.query("INSERT INTO app.event_outbox(id,organization_id,audit_event_id,event_type,correlation_id,evidence_hash,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7)",[randomUUID(),org,event.audit_event_id,event.event_type,event.correlation_id,event.evidence_hash,event.occurred_at]),/audit capture/);
   // The transaction is aborted by the denied insert; explicitly roll it back below.
   throw Error('denied insert rollback');
  }).then(()=>assert.fail('expected rollback'),error=>assert.match(error.message,/denied insert rollback/));
  await db.exec('RESET ROLE');
  await db.exec(await readFile(new URL('0012_transactional_events.down.sql',directory),'utf8'));
  assert.equal((await db.query("SELECT to_regclass('app.event_outbox') name")).rows[0].name,null);
  await db.exec(await readFile(new URL('0012_transactional_events.up.sql',directory),'utf8'));
  assert.equal((await db.query('SELECT count(*)::int n FROM app.event_outbox')).rows[0].n,0);
 }finally{await db.close();}
});
