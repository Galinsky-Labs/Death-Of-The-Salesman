import test from 'node:test';import assert from 'node:assert/strict';import {PGlite} from '@electric-sql/pglite';import {readFile,readdir} from 'node:fs/promises';
import {PrivacyFoundationRepository,ProjectCatalogRepository,setAuditContext,withTransaction} from '../packages/database/dist/index.js';
const org='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222',owner='33333333-3333-4333-8333-333333333333',foreign='44444444-4444-4444-8444-444444444444';
const context={organizationId:org,membershipId:owner,correlationId:'55555555-5555-4555-8555-555555555555',policyVersion:'privacy-v1'};
test('privacy SQL: bounded retention, live holds, cleanup, tenant export and audited requests',async()=>{
 const db=new PGlite();try{
  const dir=new URL('../database/migrations/',import.meta.url),names=(await readdir(dir)).filter(n=>n.endsWith('.up.sql')).sort();
  for(const name of names.filter(n=>n<'0010'))await db.exec(await readFile(new URL(name,dir),'utf8'));
  await db.query("INSERT INTO app.organizations(id,slug,display_name) VALUES($1,'first','Synthetic'),($2,'other','Synthetic')",[org,other]);
  for(const [id,tenant] of [[owner,org],[foreign,other]]){
   await db.query("INSERT INTO app.owner_users(id,identity_subject,display_name) VALUES($1::uuid,$1::text,'Synthetic')",[id]);
   await db.query("INSERT INTO app.memberships(id,organization_id,user_id,role) VALUES($1,$2,$1,'owner')",[id,tenant]);
  }
  for(const name of names.filter(n=>n>='0010'))await db.exec(await readFile(new URL(name,dir),'utf8'));
  await db.exec("CREATE ROLE privacy_runtime NOLOGIN NOBYPASSRLS;GRANT USAGE ON SCHEMA app TO privacy_runtime;GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE ON ALL TABLES IN SCHEMA app TO privacy_runtime;GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO privacy_runtime;SET ROLE privacy_runtime;");
  const client={query:(sql,args)=>db.query(sql,args)},repo=new PrivacyFoundationRepository(client),catalog=new ProjectCatalogRepository(client);
  const project=await catalog.create({kind:'project',organizationId:org,ownerMembershipId:owner,label:'Synthetic',content:{summary:'Synthetic source'}});
  await catalog.create({kind:'offer',organizationId:org,ownerMembershipId:owner,projectId:project.id,label:'Synthetic offer',content:{price:'100'}});
  const snapshot=await repo.exportProject(context,project.id);assert.equal(snapshot.organizationId,org);assert.equal(snapshot.offers.length,1);
  await assert.rejects(repo.exportProject({...context,organizationId:other,membershipId:foreign},project.id),/unavailable/);
  await assert.rejects(repo.exportProject({...context,membershipId:foreign},project.id),/not authorized/);
  const request=await repo.request(context,'correct','project',project.id,'OWNER_REQUEST');assert.ok(request);
  await assert.rejects(repo.request({...context,organizationId:other,membershipId:foreign},'delete','project',project.id,'OWNER_REQUEST'),/unavailable/);
  const cached=await repo.putCache(context,{derived:'Synthetic summary'},1),hold=await repo.holdCache(context,cached,'REVIEW_HOLD',60);
  await new Promise(resolve=>setTimeout(resolve,1100));
  assert.deepEqual(await repo.expireCaches(context),[]);
  await assert.rejects(withTransaction(client,async tx=>{await setAuditContext(tx,context);await tx.query('DELETE FROM app.privacy_cache WHERE id=$1',[cached]);}),/hold prevents/);
  await withTransaction(client,async tx=>{await setAuditContext(tx,context);await tx.query('UPDATE app.privacy_holds SET released_at=clock_timestamp() WHERE id=$1',[hold]);});
  assert.deepEqual(await repo.expireCaches(context),[cached]);assert.deepEqual(await repo.expireCaches(context),[]);
  await assert.rejects(withTransaction(client,async tx=>{await setAuditContext(tx,context);await tx.query("INSERT INTO app.privacy_cache(organization_id,payload,expires_at,updated_by_membership_id) VALUES($1,'{}','infinity',$2)",[org,owner]);}),/expiry must be finite/);
  await assert.rejects(withTransaction(client,async tx=>{await setAuditContext(tx,context);await tx.query('TRUNCATE app.privacy_cache');}),/append-only/);
  await withTransaction(client,async tx=>{await tx.query("SELECT set_config('app.organization_id',$1,true)",[other]);assert.equal((await tx.query('SELECT id FROM app.privacy_requests WHERE id=$1',[request])).rows.length,0);});
  await db.exec('RESET ROLE');await db.exec(await readFile(new URL('0014_privacy_foundations.down.sql',dir),'utf8'));
  assert.equal((await db.query("SELECT to_regclass('app.privacy_cache') name")).rows[0].name,null);
 }finally{await db.close();}
});
