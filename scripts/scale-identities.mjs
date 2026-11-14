// DOTS-157: one million registered agent identities as database records with bounded active workers.
// Run only against a DISPOSABLE migrated database: SCALE_DATABASE_URL=… node scripts/scale-identities.mjs [total]
// Identities are spread across synthetic tenants (each tenant may instantiate up to 264 approved names).
// Measures bulk load, keyset-paginated roster pages, name search and storage. No worker or model runs.
import {spawnSync} from 'node:child_process';
const url=process.env.SCALE_DATABASE_URL,total=Number(process.argv[2]??1_000_000);
if(!url||!/localhost|127\.0\.0\.1/.test(url))throw new Error('SCALE_DATABASE_URL must point at a local disposable database');
const psql=sql=>{const r=spawnSync('psql',[url,'-X','-At','-v','ON_ERROR_STOP=1','-c',sql],{encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);return r.stdout.trim();};
const perTenant=264,tenants=Math.ceil(total/perTenant);const t0=Date.now();
psql(`BEGIN;
SET LOCAL session_replication_role=replica; -- bulk synthetic load: skips audit triggers for speed (disposable database only)
INSERT INTO app.organizations(id,slug,display_name) SELECT md5('scale-org-'||t)::uuid,'scale-'||t,'Synthetic scale tenant '||t FROM generate_series(1,${tenants}) t;
INSERT INTO app.owner_users(id,identity_subject,display_name) SELECT md5('scale-user-'||t)::uuid,'synthetic|scale|'||t,'Synthetic owner '||t FROM generate_series(1,${tenants}) t;
INSERT INTO app.memberships(id,organization_id,user_id,role) SELECT md5('scale-member-'||t)::uuid,md5('scale-org-'||t)::uuid,md5('scale-user-'||t)::uuid,'owner' FROM generate_series(1,${tenants}) t;
INSERT INTO app.agent_identities(organization_id,approved_name_id,display_name,status,updated_by_membership_id)
 SELECT md5('scale-org-'||t)::uuid,n.id,n.name,CASE WHEN n.id<=2 THEN 'active' ELSE 'inactive' END,md5('scale-member-'||t)::uuid
 FROM generate_series(1,${tenants}) t CROSS JOIN app.approved_agent_names n WHERE (t-1)*${perTenant}+n.id<=${total};
COMMIT;ANALYZE app.agent_identities;`);
const loadMs=Date.now()-t0;
const count=Number(psql('SELECT count(*) FROM app.agent_identities'));
const timed=sql=>{const out=psql(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`);const plan=JSON.parse(out)[0];return {ms:plan['Execution Time'],usesIndex:/Index/.test(JSON.stringify(plan.Plan))};};
const samples=[];for(let i=0;i<50;i++){const t=1+Math.floor(Math.random()*tenants);samples.push(timed(`SELECT id,display_name,status FROM app.agent_identities WHERE organization_id=md5('scale-org-${t}')::uuid AND (lower(display_name),id) > ('m','00000000-0000-0000-0000-000000000000') ORDER BY lower(display_name),id LIMIT 24`));}
const search=[];for(let i=0;i<20;i++){const t=1+Math.floor(Math.random()*tenants);search.push(timed(`SELECT id,display_name FROM app.agent_identities WHERE organization_id=md5('scale-org-${t}')::uuid AND lower(display_name) LIKE 'fast%' ORDER BY lower(display_name) LIMIT 24`));}
const p95=list=>{const v=list.map(s=>s.ms).sort((a,b)=>a-b);return Number(v[Math.floor(v.length*0.95)-1].toFixed(3));};
const report={unit:'DOTS-157',measuredAt:new Date().toISOString(),identities:count,tenants,bulkLoadMs:loadMs,
 rosterPage:{p95Ms:p95(samples),indexUsed:samples.every(s=>s.usesIndex)},nameSearch:{p95Ms:p95(search),indexUsed:search.every(s=>s.usesIndex)},
 storage:psql("SELECT pg_size_pretty(pg_total_relation_size('app.agent_identities'))"),
 activeIdentities:Number(psql("SELECT count(*) FROM app.agent_identities WHERE status='active'")),
 runningWorkers:Number(psql("SELECT count(*) FROM app.task_queue WHERE state='running'")),
 note:'Registered identity records only. Active execution stays bounded by queue leases; no always-running agents are implied.'};
console.log(JSON.stringify(report,null,2));
