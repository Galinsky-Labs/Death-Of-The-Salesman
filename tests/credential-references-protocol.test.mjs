import test from 'node:test';import assert from 'node:assert/strict';import {randomBytes} from 'node:crypto';
import {CredentialCipher,CredentialReferenceRepository,CredentialUnavailableError} from '../packages/database/dist/index.js';
const org='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222',owner='33333333-3333-4333-8333-333333333333',other='44444444-4444-4444-8444-444444444444';
const context={organizationId:org,membershipId:owner,correlationId:id,policyVersion:'credential-test-v1',verifiedMfaAt:new Date()};
const reference={id,organizationId:org,provider:'synthetic-provider',kind:'api_key',version:1};
function keyring(){const keys=new Map([['test-key-1',randomBytes(32)],['test-key-2',randomBytes(32)]]);let active='test-key-1';return {active:async()=>({id:active,bytes:keys.get(active)}),get:async id=>{if(!keys.has(id))throw Error('private key detail');return keys.get(id);},rotate:()=>{active='test-key-2';}};}
test('AES-GCM authenticates tenant, provider, kind, version, key identifier and ciphertext',async()=>{
 const keys=keyring(),cipher=new CredentialCipher(keys),secret=randomBytes(57),record=await cipher.seal(reference,secret);
 assert.deepEqual(await cipher.open(reference,record),secret);assert.notDeepEqual(record.ciphertext,secret);
 assert.equal(JSON.stringify(cipher),'{}');
 const again=await cipher.seal(reference,secret);assert.notDeepEqual(again.nonce,record.nonce);
 for(const modified of [{...reference,organizationId:other},{...reference,provider:'other'},{...reference,kind:'oauth_refresh'},{...reference,version:2},{...reference,id:other}])await assert.rejects(cipher.open(modified,record),CredentialUnavailableError);
 const tampered={...record,ciphertext:Buffer.from(record.ciphertext)};tampered.ciphertext[0]^=1;
 await assert.rejects(cipher.open(reference,tampered),CredentialUnavailableError);
 await assert.rejects(cipher.open(reference,{...record,keyId:'test-key-2'}),CredentialUnavailableError);
 keys.rotate();const rotated=await cipher.seal({...reference,version:2},secret);assert.equal(rotated.keyId,'test-key-2');
 assert.deepEqual(await cipher.open({...reference,version:2},rotated),secret);
});
test('bad secret/key material and provider failures produce only redacted errors',async()=>{
 const cipher=new CredentialCipher(keyring());
 for(const bytes of [Buffer.alloc(0),Buffer.alloc(16385)])await assert.rejects(cipher.seal(reference,bytes),error=>error.message==='Credential operation unavailable');
 await assert.rejects(new CredentialCipher({active:async()=>{throw Error('never expose key detail');},get:async()=>randomBytes(32)}).seal(reference,Buffer.from('synthetic')),error=>!String(error).includes('never expose'));
 await assert.rejects(new CredentialCipher({active:async()=>({id:'test',bytes:Buffer.alloc(31)}),get:async()=>Buffer.alloc(31)}).seal(reference,Buffer.from('synthetic')),CredentialUnavailableError);
});
function db({authorized=true,record,revoked=false,fail=false,updated=false}={}){const calls=[];return {calls,query:async(sql,args)=>{calls.push({sql,args});
 if(sql.includes('SELECT id FROM app.memberships'))return {rows:authorized?[{id:owner}]:[]};
 if(sql.startsWith('SELECT v.key_id'))return {rows:record&&!revoked?[{key_id:record.keyId,nonce:record.nonce,auth_tag:record.tag,ciphertext:record.ciphertext}]:[]};
 if(sql.startsWith('UPDATE app.integration_credentials')&&updated)return {rows:[{id}]};
 if(sql.startsWith('INSERT INTO app.credential_versions')&&fail)throw Error('driver error with private material');
 return {rows:[]};}};}
test('unauthorized requests never retrieve an encryption key or store secret bytes',async()=>{
 let calls=0;const cipher=new CredentialCipher({active:async()=>{calls++;return {id:'test',bytes:randomBytes(32)};},get:async()=>{calls++;return randomBytes(32);}}),database=db({authorized:false}),repo=new CredentialReferenceRepository(database,cipher);
 await assert.rejects(repo.create(context,'synthetic-provider','api_key',Buffer.from('synthetic')),CredentialUnavailableError);
 await assert.rejects(repo.withCredential(context,reference,async()=>assert.fail()),CredentialUnavailableError);
 assert.equal(calls,0);assert.equal(database.calls.some(c=>c.sql.startsWith('INSERT')),false);
});
test('create returns only public reference, SQL receives ciphertext, failures are redacted',async()=>{
 const database=db(),cipher=new CredentialCipher(keyring()),secret=randomBytes(31),repo=new CredentialReferenceRepository(database,cipher);
 const result=await repo.create(context,'synthetic-provider','api_key',secret);
 assert.deepEqual(Object.keys(result).sort(),['id','organizationId','provider','kind','version'].sort());
 const write=database.calls.find(c=>c.sql.startsWith('INSERT INTO app.credential_versions'));
 assert.ok(write);assert.equal(write.args.some(value=>value instanceof Uint8Array&&Buffer.from(value).equals(secret)),false);
 assert.equal(database.calls.at(-1).sql,'COMMIT');assert.equal(JSON.stringify(repo),'{}');
 await assert.rejects(new CredentialReferenceRepository(db({fail:true}),cipher).create(context,'synthetic-provider','api_key',secret),error=>!String(error).includes('private material'));
});
test('withCredential zeroes temporary plaintext after success/failure and denies revocation',async()=>{
 const cipher=new CredentialCipher(keyring()),secret=randomBytes(32),record=await cipher.seal(reference,secret);
 let retained;
 await new CredentialReferenceRepository(db({record}),cipher).withCredential(context,reference,async bytes=>{retained=bytes;assert.deepEqual(bytes,secret);});
 assert.ok(retained.every(byte=>byte===0));
 await assert.rejects(new CredentialReferenceRepository(db({record}),cipher).withCredential(context,reference,async bytes=>{retained=bytes;throw Error('private provider response');}),error=>!String(error).includes('provider response'));
 assert.ok(retained.every(byte=>byte===0));
 await assert.rejects(new CredentialReferenceRepository(db({record,revoked:true}),cipher).withCredential(context,reference,async()=>assert.fail()),CredentialUnavailableError);
 await assert.rejects(new CredentialReferenceRepository(db({record}),cipher).withCredential({...context,organizationId:other},reference,async()=>assert.fail()),CredentialUnavailableError);
});
test('rotation/revocation predicates bind exact tenant, provider, kind and version',async()=>{
 const database=db(),repo=new CredentialReferenceRepository(database,new CredentialCipher(keyring()));
 await assert.rejects(repo.rotate(context,reference,randomBytes(32)),CredentialUnavailableError);
 const rotate=database.calls.find(c=>c.sql.startsWith('UPDATE app.integration_credentials'));
 assert.match(rotate.sql,/current_version=\$5 AND revoked_at IS NULL/);assert.deepEqual(rotate.args.slice(0,5),[org,id,reference.provider,reference.kind,1]);
 assert.equal(await repo.revoke(context,reference),false);
 assert.equal(database.calls.at(-1).sql,'COMMIT');
});

test('fresh server-verified MFA is required before database or key access',async()=>{
 const database=db(),repo=new CredentialReferenceRepository(database,new CredentialCipher(keyring()),()=>1800000000000);
 for(const verifiedMfaAt of [undefined,new Date(NaN),new Date(1800000000001),new Date(1800000000000-900001)]){
  await assert.rejects(repo.list({...context,verifiedMfaAt},'synthetic-provider'),CredentialUnavailableError);
 }
 assert.equal(database.calls.length,0);
});

test('key-manager rotation re-encrypts the same secret under a new reference without exporting it',async()=>{
 const keys=keyring(),cipher=new CredentialCipher(keys),secret=randomBytes(32),record=await cipher.seal(reference,secret);keys.rotate();
 const database=db({record,updated:true}),repo=new CredentialReferenceRepository(database,cipher),next=await repo.rotateEncryptionKey(context,reference);
 assert.equal(next.version,2);const saved=database.calls.find(c=>c.sql.startsWith('INSERT INTO app.credential_versions')).args;
 assert.equal(saved[5],'test-key-2');assert.deepEqual(await cipher.open(next,{keyId:saved[5],nonce:saved[6],tag:saved[7],ciphertext:saved[8]}),secret);
 assert.equal(database.calls.at(-1).sql,'COMMIT');
 assert.match(database.calls.find(c=>c.sql.startsWith('SELECT v.key_id')).sql,/FOR UPDATE OF c/);
});
