// DOTS-150: encrypted logical backup. Streams pg_dump (custom format) through AES-256-GCM and writes
// <out>.dump.enc plus a manifest with SHA-256 digests. Requires BACKUP_DATABASE_URL (administrative,
// never the web runtime URL), BACKUP_ENCRYPTION_KEY (32 random bytes, base64) and an output path.
// pg_dump must be the same or newer major version than the server (Neon production runs Postgres 17).
import {spawn} from 'node:child_process';import {createCipheriv,createHash,randomBytes} from 'node:crypto';import {createWriteStream} from 'node:fs';import {writeFile} from 'node:fs/promises';
const url=process.env.BACKUP_DATABASE_URL,secret=process.env.BACKUP_ENCRYPTION_KEY,out=process.argv[2];
if(!url||!secret||!out)throw new Error('Usage: BACKUP_DATABASE_URL=… BACKUP_ENCRYPTION_KEY=… node scripts/backup.mjs <output-prefix>');
const key=Buffer.from(secret,'base64');if(key.length!==32)throw new Error('BACKUP_ENCRYPTION_KEY must be 32 bytes base64');
const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv),plain=createHash('sha256'),sealed=createHash('sha256');
const file=createWriteStream(`${out}.dump.enc`);const header=Buffer.concat([Buffer.from('DOTSBK1'),iv]);file.write(header);sealed.update(header);
const dump=spawn(process.env.PG_DUMP??'pg_dump',['--format=custom','--no-owner','--no-privileges','--schema=app','--schema=app_meta',url],{stdio:['ignore','pipe','inherit']});
let bytes=0;dump.stdout.on('data',chunk=>{bytes+=chunk.length;plain.update(chunk);const encrypted=cipher.update(chunk);sealed.update(encrypted);file.write(encrypted);});
const code=await new Promise(resolve=>dump.on('close',resolve));if(code!==0)throw new Error(`pg_dump exited ${code}`);
const tail=Buffer.concat([cipher.final(),cipher.getAuthTag()]);sealed.update(tail);file.end(tail);await new Promise(resolve=>file.on('close',resolve));
const manifest={format:'dots-backup-v1',createdAt:new Date().toISOString(),plaintextBytes:bytes,plaintextSha256:plain.digest('hex'),encryptedSha256:sealed.digest('hex'),cipher:'aes-256-gcm',schemas:['app','app_meta']};
await writeFile(`${out}.manifest.json`,JSON.stringify(manifest,null,2));console.log(JSON.stringify(manifest));
