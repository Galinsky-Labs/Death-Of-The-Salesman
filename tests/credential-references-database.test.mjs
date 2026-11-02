import test from 'node:test';import assert from 'node:assert/strict';import {PGlite} from '@electric-sql/pglite';import {randomBytes} from 'node:crypto';import {readFile,readdir} from 'node:fs/promises';
import {CredentialCipher,CredentialReferenceRepository,CredentialUnavailableError,AuditEventRepository,setAuditContext,withTransaction} from '../packages/database/dist/index.js';
const org='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222',owner='33333333-3333-4333-8333-333333333333',admin='44444444-4444-4444-8444-444444444444',foreign='55555555-5555-4555-8555-555555555555';
const context={organizationId:org,membershipId:owner,correlationId:'66666666-6666-4666-8666-666666666666',policyVersion:'credentials-v1',verifiedMfaAt:new Date()};
test('credential SQL: encrypted-only persistence, tenant/provider isolation, rotation, revocation and audit',async()=>{
 const db=new PGlite();try{
  const directory=new URL('../database/migrations/',import.meta.url),names=(await readdir(directory)).filter(n=>n.endsWith('.up.sql')).sort();
  for(const name of names.filter(n=>n<'0010'))await db.exec(await readFile(new URL(name,directory),'utf8'));
  await db.query("INSERT INTO app.organizations(id,slug,display_name) VALUES($1,'first','Synthetic'),($2,'other','Synthetic')",[org,other]);
  for(const [id,tenant,role] of [[owner,org,'owner'],[admin,org,'admin'],[foreign,other,'owner']]){
   await db.query("INSERT INTO app.owner_users(id,identity_subject,display_name) VALUES($1::uuid,$1::text,'Synthetic')",[id]);
   await db.query("INSERT INTO app.memberships(id,organization_id,user_id,role) VALUES($1,$2,$1,$3)",[id,tenant,role]);
  }
  for(const name of names.filter(n=>n>='0010'))await db.exec(await readFile(new URL(name,directory),'utf8'));
  await db.exec("CREATE ROLE credential_runtime NOLOGIN NOBYPASSRLS;GRANT USAGE ON SCHEMA app TO credential_runtime;GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE ON ALL TABLES IN SCHEMA app TO credential_runtime;GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO credential_runtime;SET ROLE credential_runtime;");
  const client={query:(sql,args)=>db.query(sql,args)},keys=new Map([['key-1',randomBytes(32)],['key-2',randomBytes(32)]]);let active='key-1';
  const cipher=new CredentialCipher({active:async()=>({id:active,bytes:keys.get(active)}),get:async id=>keys.get(id)}),repo=new CredentialReferenceRepository(client,cipher);
  const secret=randomBytes(48),replacement=randomBytes(48);
  const reference=await repo.create(context,'synthetic-provider','oauth_refresh',secret);
  assert.equal(reference.version,1);assert.deepEqual(Object.keys(reference).sort(),['id','organizationId','provider','kind','version'].sort());
  let borrowed;await repo.withCredential(context,reference,async bytes=>{assert.deepEqual(bytes,secret);borrowed=bytes;});assert.ok(borrowed.every(b=>b===0));
  assert.equal(JSON.stringify(await repo.list(context,'synthetic-provider')).includes(secret.toString('base64')),false);
  await assert.rejects(repo.withCredential({...context,membershipId:admin},reference,async()=>assert.fail()),CredentialUnavailableError);
  await assert.rejects(repo.create({...context,membershipId:admin},'synthetic-provider','api_key',secret),CredentialUnavailableError);
  await assert.rejects(repo.withCredential({...context,organizationId:other,membershipId:foreign},reference,async()=>assert.fail()),CredentialUnavailableError);
  await assert.rejects(repo.withCredential(context,{...reference,provider:'other-provider'},async()=>assert.fail()),CredentialUnavailableError);
  active='key-2';const next=await repo.rotate(context,reference,replacement);assert.equal(next.version,2);
  await assert.rejects(repo.rotate(context,reference,replacement),CredentialUnavailableError);
  await assert.rejects(repo.withCredential(context,reference,async()=>assert.fail()),CredentialUnavailableError);
  await repo.withCredential(context,next,async bytes=>assert.deepEqual(bytes,replacement));
  const stored=await withTransaction(client,async tx=>{await setAuditContext(tx,context);return tx.query('SELECT key_id,nonce,auth_tag,ciphertext FROM app.credential_versions WHERE organization_id=$1 AND credential_id=$2 ORDER BY version',[org,reference.id]);});
  assert.deepEqual(stored.rows.map(r=>r.key_id),['key-1','key-2']);assert.equal(stored.rows.some(r=>Buffer.from(r.ciphertext).equals(secret)||Buffer.from(r.ciphertext).equals(replacement)),false);
  const audit=new AuditEventRepository(client),events=await audit.list({organizationId:org,membershipId:owner});
  assert.ok(events.some(e=>e.eventType==='integration_credentials.insert'));assert.ok(events.some(e=>e.eventType==='integration_credentials.update'));
  assert.ok(events.some(e=>e.eventType==='credential_versions.insert'&&e.evidence.version===2));
  assert.equal(JSON.stringify(events).includes(secret.toString('base64')),false);assert.equal(JSON.stringify(events).includes('ciphertext'),false);
  active='key-1';const newest=await repo.rotateEncryptionKey(context,next);assert.equal(newest.version,3);
  await assert.rejects(repo.withCredential(context,next,async()=>assert.fail()),CredentialUnavailableError);
  await repo.withCredential(context,newest,async bytes=>assert.deepEqual(bytes,replacement));
  assert.equal(await repo.revoke(context,newest),true);assert.equal(await repo.revoke(context,newest),false);
  await assert.rejects(repo.withCredential(context,next,async()=>assert.fail()),CredentialUnavailableError);
  await assert.rejects(repo.rotate(context,next,secret),CredentialUnavailableError);
  assert.equal((await repo.list(context,'synthetic-provider'))[0].revoked,true);
  await assert.rejects(withTransaction(client,async tx=>{await setAuditContext(tx,context);await tx.query("UPDATE app.credential_versions SET ciphertext=decode('ff','hex') WHERE credential_id=$1",[reference.id]);}),/append-only/);
  await assert.rejects(withTransaction(client,async tx=>{await setAuditContext(tx,context);await tx.query('UPDATE app.integration_credentials SET revoked_at=NULL WHERE id=$1',[reference.id]);}),/invalid credential/);
  await assert.rejects(db.query('TRUNCATE app.credential_versions'),/append-only/);
  await withTransaction(client,async tx=>{await tx.query("SELECT set_config('app.organization_id',$1,true)",[other]);assert.equal((await tx.query('SELECT id FROM app.integration_credentials WHERE id=$1',[reference.id])).rows.length,0);assert.equal((await tx.query('SELECT credential_id FROM app.credential_versions WHERE credential_id=$1',[reference.id])).rows.length,0);});
  const available=await repo.create(context,'synthetic-provider','api_key',secret);
  await assert.rejects(withTransaction(client,async tx=>{await setAuditContext(tx,context);await tx.query('UPDATE app.integration_credentials SET current_version=current_version+1 WHERE id=$1',[available.id]);}),/foreign key/);
  await repo.withCredential(context,available,async bytes=>assert.deepEqual(bytes,secret));
  await withTransaction(client,async tx=>{await setAuditContext(tx,context);await tx.query("UPDATE app.memberships SET status='inactive' WHERE id=$1",[owner]);});
  await assert.rejects(repo.withCredential(context,available,async()=>assert.fail()),CredentialUnavailableError);
  await db.exec('RESET ROLE');await db.exec(await readFile(new URL('0013_credential_references.down.sql',directory),'utf8'));
  assert.equal((await db.query("SELECT to_regclass('app.integration_credentials') name")).rows[0].name,null);
  await db.exec(await readFile(new URL('0013_credential_references.up.sql',directory),'utf8'));
 }finally{await db.close();}
});
