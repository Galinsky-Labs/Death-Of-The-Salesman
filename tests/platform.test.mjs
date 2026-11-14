import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {operationalHealth,IncidentLog,runKillSwitchDrill,PortfolioAccess,portfolioSummary,provisionTenant,assertAllowedOutbound,OUTBOUND_HOST_ALLOWLIST,admissionDecision,SalesWorkspace,tenant} from '../packages/operations/dist/index.js';
import {setup,org,owner,agent,project,ctx} from './helpers/operations-fixture.mjs';

test('operational health derives every alert from persisted rows and reports none it cannot evidence',async()=>{const {db,client,control}=await setup();try{
 let health=await operationalHealth(client,ctx,{JOB_WORKER_ENABLED:'true'});
 assert.deepEqual(health.alerts.map(a=>a.id),['runtime.paused']);assert.equal(health.metrics.queued,0);
 await control.pause(false);const task=await control.enqueue(project,agent,'draft',{mode:'simulation'},'health-1');
 await db.query("UPDATE app.task_queue SET state='quarantined',last_reason='LEASE_EXPIRED' WHERE id=$1",[task.id]);
 health=await operationalHealth(client,ctx,{JOB_WORKER_ENABLED:'true'});
 assert.deepEqual(health.alerts.map(a=>a.id),['queue.quarantined']);assert.equal(health.alerts[0].evidence.quarantined,1);
 await db.query("UPDATE app.task_queue SET state='queued',available_at=now()-interval '1 hour' WHERE id=$1",[task.id]);
 health=await operationalHealth(client,ctx,{});
 const stale=health.alerts.find(a=>a.id==='queue.stale');assert.equal(stale.severity,'critical');assert.match(stale.detail,/worker is disabled/);
}finally{await db.close();}});

test('pause-all drill blocks claims and approval dispatch, records immutable evidence and restores the prior state',async()=>{const {db,client,control}=await setup();try{
 await control.pause(false);await control.enqueue(project,agent,'draft',{mode:'simulation'},'drill-task');
 const result=await runKillSwitchDrill(client,ctx);
 assert.equal(result.passed,true);assert.deepEqual(result.steps.map(s=>s.step),['drill.pause_applied','drill.claim_blocked','drill.approval_dispatch_blocked']);
 assert.equal((await db.query('SELECT paused FROM app.policy_controls')).rows[0].paused,false,'owner state restored');
 assert.equal((await db.query("SELECT state FROM app.task_queue WHERE idempotency_key='drill-task'")).rows[0].state,'queued','queued work preserved');
 const incidents=await new IncidentLog(client,ctx).list();assert.equal(incidents[0].state,'resolved');assert.equal(incidents[0].steps.length,4);
 await assert.rejects(db.query("UPDATE app.incident_events SET outcome='passed'"),/append-only/);
 await assert.rejects(new IncidentLog(client,ctx).transition(incidents[0].id,'mitigated',Number(incidents[0].version)),/STALE_RECORD/);
}finally{await db.close();}});

async function runtimeRole(db){
 await db.exec('CREATE ROLE dots_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;GRANT USAGE ON SCHEMA app TO dots_runtime;GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO dots_runtime;GRANT SELECT ON app.memberships,app.projects,app.agent_identities,app.agent_project_assignments,app.audit_events TO dots_runtime;GRANT INSERT ON app.audit_events TO dots_runtime;');
 await db.exec(await readFile(new URL('../database/runtime-grants.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../database/runtime-grants-0023.sql',import.meta.url),'utf8'));
}

test('portfolio tokens are hashed, scoped, revocable and return only aggregate non-personal summaries',async()=>{const {db,client}=await setup();try{
 await runtimeRole(db);
 const sales=new SalesWorkspace(client,ctx);await sales.addContact({name:'Private person',email:'private-sentinel@example.invalid',source:'Synthetic'});await sales.addDeal(project,'Synthetic deal',12345);
 const access=new PortfolioAccess(client,ctx);const issued=await access.issue('Boardroom read-only',30);
 assert.match(issued.token,new RegExp(`^${org}\\.`));
 const stored=(await db.query('SELECT token_hash FROM app.portfolio_access_tokens')).rows[0].token_hash;assert.notEqual(stored,issued.token);assert.ok(!stored.includes(issued.token.split('.')[1]));
 await db.exec('SET ROLE dots_runtime');
 const summary=await portfolioSummary(client,`Bearer ${issued.token}`);
 assert.equal(summary.contract,'dots-portfolio-summary-v1');assert.equal(summary.access,'read-only');assert.equal(summary.projects[0].pipeline.openPipelineCents,'12345');
 assert.equal(summary.projects[0].verifiedCash.salesCents,'0');assert.ok(!JSON.stringify(summary).includes('private-sentinel'));
 await assert.rejects(portfolioSummary(client,`Bearer ${issued.token.slice(0,-2)}xx`),/PORTFOLIO_TOKEN_INVALID/);
 await assert.rejects(portfolioSummary(client,`Bearer ${'66666666-6666-4666-8666-666666666666'}.${issued.token.split('.')[1]}`),/PORTFOLIO_TOKEN_INVALID/);
 await assert.rejects(portfolioSummary(client,null),/PORTFOLIO_TOKEN_INVALID/);
 await assert.rejects(portfolioSummary(client,`Bearer ${issued.token}`,new Date(Date.now()+31*86400000)),/PORTFOLIO_TOKEN_INVALID/);
 await db.exec('RESET ROLE');await access.revoke(issued.id);await db.exec('SET ROLE dots_runtime');
 await assert.rejects(portfolioSummary(client,`Bearer ${issued.token}`),/PORTFOLIO_TOKEN_INVALID/);
 await assert.rejects(client.query("UPDATE app.portfolio_access_tokens SET token_hash=repeat('0',64)"),/permission denied/);
}finally{await db.close();}});

test('commercial onboarding is disabled by default and a new tenant starts empty, paused and isolated from owner data',async()=>{const {db,client}=await setup();try{
 await runtimeRole(db);
 await assert.rejects(provisionTenant(client,{slug:'new-tenant',displayName:'New tenant',ownerSubject:'synthetic|new',ownerName:'New owner'},{}),/COMMERCIAL_ONBOARDING_NOT_AUTHORIZED/);
 const created=await provisionTenant(client,{slug:'new-tenant',displayName:'New tenant',ownerSubject:'synthetic|new',ownerName:'New owner'},{COMMERCIAL_SIGNUP_ENABLED:'true'});
 await db.exec('SET ROLE dots_runtime');
 const fresh={organizationId:created.organizationId,membershipId:created.membershipId};
 const view=await tenant(client,fresh,async tx=>({agents:(await tx.query('SELECT * FROM app.agent_identities')).rows.length,contacts:(await tx.query('SELECT * FROM app.crm_contacts')).rows.length,projects:(await tx.query('SELECT * FROM app.projects')).rows.length,policy:(await tx.query('SELECT paused,model_enabled,outbound_enabled FROM app.policy_controls')).rows[0],budget:(await tx.query('SELECT limit_cents FROM app.spending_policies')).rows[0]}));
 assert.deepEqual({...view,budget:Number(view.budget.limit_cents)},{agents:0,contacts:0,projects:0,policy:{paused:true,model_enabled:false,outbound_enabled:false},budget:0});
 const owners=await tenant(client,ctx,async tx=>(await tx.query('SELECT count(*)::int AS n FROM app.agent_identities')).rows[0].n);assert.equal(owners,1,'owner still sees only their own agent');
 await assert.rejects(tenant(client,fresh,tx=>tx.query("INSERT INTO app.crm_accounts(organization_id,name) VALUES($1,'Cross tenant')",[org])),/row-level security/);
}finally{await db.close();}});

test('outbound integrations can only reach fixed allow-listed HTTPS hosts (SSRF guard and source scan)',async()=>{
 for(const url of ['http://api.openai.com/v1','https://169.254.169.254/latest','https://api.openai.com.evil.example/x','https://user:pw@api.stripe.com/','https://api.stripe.com:8443/','not a url','file:///etc/passwd'])assert.throws(()=>assertAllowedOutbound(url),/OUTBOUND_/);
 assert.equal(assertAllowedOutbound('https://api.stripe.com/v1/checkout/sessions').hostname,'api.stripe.com');
 const directory=new URL('../packages/operations/src/',import.meta.url);
 for(const file of (await readdir(directory)).filter(f=>f.endsWith('.ts'))){
  const source=await readFile(new URL(file,directory),'utf8');
  for(const literal of source.matchAll(/https:\/\/([a-z0-9.-]+)\/(?!auth\/)/gi)){ // OAuth scope identifiers are not request endpoints
   const host=literal[1].toLowerCase();
   if(['huggingface.co','www.grants.gov','checkout.stripe.com','dashboard.stripe.com','resend.com','openrouter.ai','developers.openai.com','platform.claude.com','docs.x.ai','www.ftc.gov','www.sec.gov'].includes(host))continue;
   assert.ok(OUTBOUND_HOST_ALLOWLIST.includes(host),`${file} references unreviewed outbound host ${host}`);
  }
  assert.doesNotMatch(source,/(?:transport|fetch)\(\s*(?:body|payload|input|request|url|req)\./,`${file} passes caller-controlled URLs to a transport`);
 }
});

test('tenant admission applies backpressure from persisted queue depth and live concurrency',async()=>{const {db,client,control}=await setup();try{
 assert.equal((await admissionDecision(client,ctx)).admit,true);
 await control.enqueue(project,agent,'draft',{mode:'simulation'},'admission-1');
 const decision=await admissionDecision(client,ctx,{maxRunning:2,maxQueued:1});assert.equal(decision.admit,false);assert.equal(decision.reason,'TENANT_QUEUE_BACKPRESSURE');
 await db.query("UPDATE app.task_queue SET state='running',lease_expires_at=now()+interval '1 minute'");
 assert.equal((await admissionDecision(client,ctx,{maxRunning:1,maxQueued:10})).reason,'TENANT_CONCURRENCY_LIMIT');
}finally{await db.close();}});

test('read-path indexes exist for roster, CRM, timeline, campaign and metrics queries',async()=>{const {db}=await setup();try{
 const names=(await db.query("SELECT indexname FROM pg_indexes WHERE schemaname='app'")).rows.map(r=>r.indexname);
 for(const index of ['crm_contacts_recent','contact_events_timeline','messages_thread','task_queue_agent_state','agent_runs_task','money_entries_kind','agent_identities_name','approvals_pending'])assert.ok(names.includes(index),index);
}finally{await db.close();}});
