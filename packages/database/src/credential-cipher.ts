import {createCipheriv,createDecipheriv,randomBytes} from "node:crypto";
export type CredentialKind="api_key"|"oauth_refresh";
export type CredentialReference={id:string;organizationId:string;provider:string;kind:CredentialKind;version:number};
export type EncryptedCredential={keyId:string;nonce:Uint8Array;tag:Uint8Array;ciphertext:Uint8Array};
export interface CredentialKeyProvider{
 active():Promise<{id:string;bytes:Uint8Array}>;
 get(id:string):Promise<Uint8Array>;
}
export class CredentialUnavailableError extends Error{
 constructor(){super("Credential operation unavailable");this.name="CredentialUnavailableError";}
}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function validateCredentialReference(reference:CredentialReference):void{
 if(!reference||!uuid.test(reference.id)||!uuid.test(reference.organizationId)||typeof reference.provider!=="string"||
  !/^[a-z][a-z0-9_.-]{0,63}$/.test(reference.provider)||!["api_key","oauth_refresh"].includes(reference.kind)||
  !Number.isSafeInteger(reference.version)||reference.version<1||reference.version>2147483647)throw new CredentialUnavailableError();
}
const aad=(reference:CredentialReference,keyId:string)=>Buffer.from(JSON.stringify({schemaVersion:1,
 organizationId:reference.organizationId,id:reference.id,provider:reference.provider,kind:reference.kind,version:reference.version,keyId}));
/** Maintained Node/OpenSSL AES-GCM. No key material is enumerable or serialized. */
export class CredentialCipher{
 readonly #keys:CredentialKeyProvider;
 constructor(keys:CredentialKeyProvider){this.#keys=keys;}
 async seal(reference:CredentialReference,secret:Uint8Array):Promise<EncryptedCredential>{
  let plaintext:Buffer|undefined,key:Buffer|undefined;
  try{
   validateCredentialReference(reference);
   if(!(secret instanceof Uint8Array)||secret.byteLength<1||secret.byteLength>16384)throw new Error();
   plaintext=Buffer.from(secret);
   const active=await this.#keys.active();
   if(typeof active.id!=="string"||!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(active.id)||!(active.bytes instanceof Uint8Array)||active.bytes.byteLength!==32)throw new Error();
   key=Buffer.from(active.bytes);
   const nonce=randomBytes(12),cipher=createCipheriv("aes-256-gcm",key,nonce,{authTagLength:16});cipher.setAAD(aad(reference,active.id));
   const ciphertext=Buffer.concat([cipher.update(plaintext),cipher.final()]);
   return {keyId:active.id,nonce,tag:cipher.getAuthTag(),ciphertext};
  }catch{throw new CredentialUnavailableError();}finally{plaintext?.fill(0);key?.fill(0);}
 }
 async open(reference:CredentialReference,record:EncryptedCredential):Promise<Buffer>{
  let key:Buffer|undefined,plaintext:Buffer|undefined;
  try{
   validateCredentialReference(reference);
   if(!record||typeof record.keyId!=="string"||!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(record.keyId)||
    !(record.nonce instanceof Uint8Array)||record.nonce.byteLength!==12||!(record.tag instanceof Uint8Array)||record.tag.byteLength!==16||
    !(record.ciphertext instanceof Uint8Array)||record.ciphertext.byteLength<1||record.ciphertext.byteLength>16384)throw new Error();
   const bytes=await this.#keys.get(record.keyId);
   if(!(bytes instanceof Uint8Array)||bytes.byteLength!==32)throw new Error();key=Buffer.from(bytes);
   const decipher=createDecipheriv("aes-256-gcm",key,record.nonce,{authTagLength:16});decipher.setAAD(aad(reference,record.keyId));decipher.setAuthTag(record.tag);
   plaintext=Buffer.concat([decipher.update(record.ciphertext),decipher.final()]);return plaintext;
  }catch{plaintext?.fill(0);throw new CredentialUnavailableError();}finally{key?.fill(0);}
 }
}
