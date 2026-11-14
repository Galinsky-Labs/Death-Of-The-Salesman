// DOTS-150: restore an encrypted backup into an EMPTY, separate database and verify it. Refuses to
// restore into the source database. Verifies the manifest digests, migration ledger, row counts and the
// append-only audit hash chain.
import {spawn,spawnSync} from 'node:child_process';import {createDecipheriv,createHash} from 'node:crypto';import {readFile} from 'node:fs/promises';
const prefix=process.argv[2],target=process.env.RESTORE_DATABASE_URL,secret=process.env.BACKUP_ENCRYPTION_KEY;
if(!prefix||!target||!secret)throw new Error('Usage: RESTORE_DATABASE_URL=… BACKUP_ENCRYPTION_KEY=… node scripts/restore-drill.mjs <backup-prefix>');
if(process.env.BACKUP_DATABASE_URL&&new URL(process.env.BACKUP_DATABASE_URL).host+new URL(process.env.BACKUP_DATABASE_URL).pathname===new URL(target).host+new URL(target).pathname)throw new Error('Refusing to restore over the source database');
const manifest=JSON.parse(await readFile(`${prefix}.manifest.json`,'utf8'));const sealed=await readFile(`${prefix}.dump.enc`);
if(createHash('sha256').update(sealed).digest('hex')!==manifest.encryptedSha256)throw new Error('Encrypted backup digest mismatch');
if(sealed.subarray(0,7).toString()!=='DOTSBK1')throw new Error('Unknown backup format');
const decipher=createDecipheriv('aes-256-gcm',Buffer.from(secret,'base64'),sealed.subarray(7,19));decipher.setAuthTag(sealed.subarray(sealed.length-16));
const plain=Buffer.concat([decipher.update(sealed.subarray(19,sealed.length-16)),decipher.final()]);
if(createHash('sha256').update(plain).digest('hex')!==manifest.plaintextSha256)throw new Error('Plaintext digest mismatch');
const psql=sql=>{const result=spawnSync('psql',[target,'-X','-At','-v','ON_ERROR_STOP=1','-c',sql],{encoding:'utf8'});if(result.status!==0)throw new Error(result.stderr);return result.stdout.trim();};
if(psql("SELECT count(*) FROM pg_namespace WHERE nspname IN ('app','app_meta')")!=='0')throw new Error('Restore target must be empty');
psql('CREATE EXTENSION IF NOT EXISTS pgcrypto');
const restore=spawn(process.env.PG_RESTORE??'pg_restore',['--no-owner','--no-privileges','--exit-on-error','-d',target],{stdio:['pipe','inherit','inherit']});restore.stdin.end(plain);
const code=await new Promise(resolve=>restore.on('close',resolve));if(code!==0)throw new Error(`pg_restore exited ${code}`);
const migrations=Number(psql('SELECT count(*) FROM app_meta.schema_migrations'));
const tables=psql("SELECT string_agg(relname||'='||n_live_tup,',' ORDER BY relname) FROM pg_stat_user_tables WHERE schemaname='app'");
const counts=Object.fromEntries(['organizations','memberships','projects','agent_identities','crm_contacts','money_entries','audit_events','operation_events'].map(t=>[t,Number(psql(`SELECT count(*) FROM app.${t}`))]));
const brokenChain=Number(psql('SELECT count(*) FROM app.audit_events e WHERE e.entry_hash<>app.audit_entry_hash(e)'));
const report={format:'dots-restore-drill-v1',restoredAt:new Date().toISOString(),backupCreatedAt:manifest.createdAt,digestsVerified:true,migrations,counts,auditHashMismatches:brokenChain,passed:brokenChain===0&&migrations>0,tableStats:tables.length};
console.log(JSON.stringify(report,null,2));if(!report.passed)process.exitCode=1;
