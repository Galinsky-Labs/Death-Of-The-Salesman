import {randomUUID} from "node:crypto";
import {withTransaction,type TransactionClient} from "./index.js";
import {setAuditContext,type AuditContext} from "./audit-events.js";
import {CredentialCipher,CredentialUnavailableError,validateCredentialReference,type CredentialKind,type CredentialReference,type EncryptedCredential} from "./credential-cipher.js";
export type CredentialAccessContext=AuditContext & {verifiedMfaAt:Date};
const rows=(value:unknown)=>(value as {rows:Record<string,unknown>[]}).rows;
const map=(r:Record<string,unknown>):CredentialReference=>({id:String(r.id),organizationId:String(r.organization_id),provider:String(r.provider),kind:r.kind as CredentialKind,version:Number(r.current_version)});
/** Server-only, current-owner capability. Public methods return references, never plaintext. */
export class CredentialReferenceRepository{
 readonly #client:TransactionClient;readonly #cipher:CredentialCipher;readonly #now:()=>number;
 constructor(client:TransactionClient,cipher:CredentialCipher,now:()=>number=Date.now){this.#client=client;this.#cipher=cipher;this.#now=now;}
 private async transaction<T>(context:CredentialAccessContext,operation:(tx:TransactionClient)=>Promise<T>):Promise<T>{
  const now=this.#now(),mfa=context.verifiedMfaAt instanceof Date?context.verifiedMfaAt.getTime():NaN;
  if(!Number.isSafeInteger(now)||!Number.isSafeInteger(mfa)||mfa>now||now-mfa>15*60*1000)throw new CredentialUnavailableError();
  try{return await withTransaction(this.#client,async tx=>{
   await setAuditContext(tx,context);
   const member=rows(await tx.query("SELECT id FROM app.memberships WHERE organization_id=$1 AND id=$2 AND role='owner' AND status='active'",[context.organizationId,context.membershipId]));
   if(member.length!==1)throw new Error();return operation(tx);
  });}catch{throw new CredentialUnavailableError();}
 }
 private async insertVersion(tx:TransactionClient,reference:CredentialReference,secret:Uint8Array):Promise<void>{
  const encrypted=await this.#cipher.seal(reference,secret);
  await tx.query(`INSERT INTO app.credential_versions(organization_id,credential_id,provider,kind,version,key_id,nonce,auth_tag,ciphertext)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[reference.organizationId,reference.id,reference.provider,reference.kind,reference.version,encrypted.keyId,encrypted.nonce,encrypted.tag,encrypted.ciphertext]);
 }
 async create(context:CredentialAccessContext,provider:string,kind:CredentialKind,secret:Uint8Array):Promise<CredentialReference>{
  const reference={id:randomUUID(),organizationId:context.organizationId,provider,kind,version:1};validateCredentialReference(reference);
  return this.transaction(context,async tx=>{
   await tx.query("INSERT INTO app.integration_credentials(id,organization_id,provider,kind,current_version,updated_by_membership_id) VALUES($1,$2,$3,$4,1,$5)",[reference.id,reference.organizationId,reference.provider,reference.kind,context.membershipId]);
   await this.insertVersion(tx,reference,secret);return reference;
  });
 }
 async rotate(context:CredentialAccessContext,expected:CredentialReference,secret:Uint8Array):Promise<CredentialReference>{
  validateCredentialReference(expected);
  if(context.organizationId!==expected.organizationId||expected.version===2147483647)throw new CredentialUnavailableError();
  return this.transaction(context,async tx=>{
   const changed=rows(await tx.query(`UPDATE app.integration_credentials SET current_version=current_version+1,updated_by_membership_id=$6
    WHERE organization_id=$1 AND id=$2 AND provider=$3 AND kind=$4 AND current_version=$5 AND revoked_at IS NULL RETURNING *`,[expected.organizationId,expected.id,expected.provider,expected.kind,expected.version,context.membershipId]));
   if(changed.length!==1)throw new Error();
   const reference=map(changed[0]!);validateCredentialReference(reference);
   await this.insertVersion(tx,reference,secret);return reference;
  });
 }
 async revoke(context:CredentialAccessContext,expected:CredentialReference):Promise<boolean>{
  validateCredentialReference(expected);if(context.organizationId!==expected.organizationId)throw new CredentialUnavailableError();
  return this.transaction(context,async tx=>rows(await tx.query(`UPDATE app.integration_credentials SET revoked_at=clock_timestamp(),updated_by_membership_id=$6
   WHERE organization_id=$1 AND id=$2 AND provider=$3 AND kind=$4 AND current_version=$5 AND revoked_at IS NULL RETURNING id`,[expected.organizationId,expected.id,expected.provider,expected.kind,expected.version,context.membershipId])).length===1);
 }
 async list(context:CredentialAccessContext,provider:string,limit=25):Promise<{reference:CredentialReference;revoked:boolean}[]>{
  if(typeof provider!=="string"||!/^[a-z][a-z0-9_.-]{0,63}$/.test(provider)||!Number.isSafeInteger(limit)||limit<1||limit>100)throw new CredentialUnavailableError();
  return this.transaction(context,async tx=>rows(await tx.query("SELECT id,organization_id,provider,kind,current_version,revoked_at FROM app.integration_credentials WHERE organization_id=$1 AND provider=$2 ORDER BY id LIMIT $3",[context.organizationId,provider,limit])).map(row=>{
   const reference=map(row);validateCredentialReference(reference);return {reference,revoked:row.revoked_at!==null};
  }));
 }
 /** Trusted provider-adapter callback only. Never return/serialize bytes or use for an HTTP response. */
 async withCredential(context:CredentialAccessContext,reference:CredentialReference,consume:(secret:Uint8Array)=>Promise<void>):Promise<void>{
  validateCredentialReference(reference);if(context.organizationId!==reference.organizationId)throw new CredentialUnavailableError();
  let plaintext:Buffer|undefined;
  try{
   // Keep a share lock while using the key: rotation/revocation serializes behind
   // any already authorized in-flight use; new uses see the committed new state.
   await this.transaction(context,async tx=>{
    const found=rows(await tx.query(`SELECT v.key_id,v.nonce,v.auth_tag,v.ciphertext FROM app.integration_credentials c JOIN app.credential_versions v
      ON v.organization_id=c.organization_id AND v.credential_id=c.id AND v.version=c.current_version AND v.provider=c.provider AND v.kind=c.kind
      WHERE c.organization_id=$1 AND c.id=$2 AND c.provider=$3 AND c.kind=$4 AND c.current_version=$5 AND c.revoked_at IS NULL FOR SHARE OF c`,[reference.organizationId,reference.id,reference.provider,reference.kind,reference.version]));
    if(found.length!==1)throw new Error();
    const r=found[0]!;const encrypted:EncryptedCredential={keyId:String(r.key_id),nonce:r.nonce as Uint8Array,tag:r.auth_tag as Uint8Array,ciphertext:r.ciphertext as Uint8Array};
    plaintext=await this.#cipher.open(reference,encrypted);await consume(plaintext);
   });
  }catch{throw new CredentialUnavailableError();}finally{plaintext?.fill(0);}
 }
}
