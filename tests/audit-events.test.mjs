import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { AuditEventRepository, ProjectCatalogRepository, setAuditContext, withTransaction } from "../packages/database/dist/index.js";
const org="11111111-1111-4111-8111-111111111111", other="22222222-2222-4222-8222-222222222222";
const owner="33333333-3333-4333-8333-333333333333", foreign="44444444-4444-4444-8444-444444444444", manager="55555555-5555-4555-8555-555555555555";
const correlation="66666666-6666-4666-8666-666666666666";
const context={organizationId:org,membershipId:owner,correlationId:correlation,policyVersion:"authorization-v1"};
test("audit: real SQL captures high-risk writes atomically, preserves provenance, isolates tenants and denies tampering", async () => {
  const db=new PGlite();
  try {
    const dir=new URL("../database/migrations/",import.meta.url);
    const names=(await readdir(dir)).filter(p=>p.endsWith(".up.sql")).sort();
    for(const name of names.filter(p=>p<"0010")) await db.exec(await readFile(new URL(name,dir),"utf8"));
    for(const [id,slug] of [[org,"first"],[other,"second"]]) await db.query("INSERT INTO app.organizations(id,slug,display_name) VALUES($1,$2,'Synthetic organization')",[id,slug]);
    for(const [id,organization,role] of [[owner,org,"owner"],[foreign,other,"owner"],[manager,org,"sales_manager"]]) {
      await db.query("INSERT INTO app.owner_users(id,identity_subject,display_name) VALUES($1,$2,'Synthetic actor')",[id,id]);
      await db.query("INSERT INTO app.memberships(id,organization_id,user_id,role) VALUES($1,$2,$1,$3)",[id,organization,role]);
    }
    const up=await readFile(new URL("0010_append_only_audit.up.sql",dir),"utf8");
    await db.exec(up);
    for(const name of names.filter(p=>p>"0010_append_only_audit.up.sql")) await db.exec(await readFile(new URL(name,dir),"utf8"));
    await db.exec("CREATE ROLE audit_runtime NOLOGIN NOBYPASSRLS; GRANT USAGE ON SCHEMA app TO audit_runtime; GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE ON ALL TABLES IN SCHEMA app TO audit_runtime; GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO audit_runtime; SET ROLE audit_runtime;");
    const client={query:(sql,values)=>db.query(sql,values)};
    const repo=new AuditEventRepository(client), catalog=new ProjectCatalogRepository(client);
    const list=()=>repo.list({organizationId:org,membershipId:owner});
    const project=await catalog.create({kind:"project",organizationId:org,ownerMembershipId:owner,label:"Synthetic project",content:{unnecessaryPrivateContent:"not copied into audit"}});
    let events=await list(); assert.equal(events.length,1); assert.equal(events[0].eventType,"projects.insert");
    assert.equal(events[0].actorMembershipId,owner);assert.equal(events[0].actorUserId,owner);assert.equal(events[0].actorRole,"owner");
    assert.equal(events[0].policyVersion,"dots-authorization-v1");assert.equal(events[0].evidence.recordId,project.id);assert.match(events[0].entryHash,/^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(events).includes("not copied into audit"));
    await withTransaction(client,async tx=>{
      await setAuditContext(tx,context);
      await tx.query("UPDATE app.projects SET label='Changed',version=version+1 WHERE id=$1",[project.id]);
      await tx.query("UPDATE app.projects SET label='Changed again',version=version+1 WHERE id=$1",[project.id]);
    });
    events=await list();const correlated=events.filter(e=>e.correlationId===correlation);assert.equal(correlated.length,2);
    assert.ok(correlated.every(e=>e.policyVersion==="authorization-v1"&&e.evidence.changedFields.includes("label")));
    const before=events.length;
    await assert.rejects(withTransaction(client,async tx=>{await setAuditContext(tx,context);await tx.query("UPDATE app.projects SET label='Rolled back' WHERE id=$1",[project.id]);throw new Error("rollback synthetic mutation");}),/rollback synthetic/);
    assert.equal((await list()).length,before);assert.equal((await catalog.get({kind:"project",organizationId:org,id:project.id})).label,"Changed again");
    const explicit=await repo.append(context,"policy.denied",{reasonCode:"BUDGET_ZERO",evidenceHashes:["a".repeat(64)]});
    assert.equal(explicit.correlationId,correlation);
    await assert.rejects(repo.append({...context,membershipId:manager},"policy.denied",{reasonCode:"DENIED"}),/not authorized/);
    await assert.rejects(repo.append(context,"policy.denied",{credential:"synthetic forbidden field"}),/not allowed/);
    await assert.rejects(repo.append(context,"policy.denied",{evidenceHashes:["not-a-hash"]}),/evidence hash/);
    await assert.rejects(repo.list({organizationId:org,membershipId:manager}),/not authorized/);
    await assert.rejects(repo.list({organizationId:other,membershipId:owner}),/not authorized/);
    await withTransaction(client,async tx=>{
      await tx.query("SELECT set_config('app.organization_id',$1,true)",[other]);
      assert.equal((await tx.query("SELECT id FROM app.audit_events WHERE id=$1",[explicit.id])).rows.length,0);
      assert.equal((await tx.query("UPDATE app.audit_events SET event_type='forged.event' WHERE id=$1 RETURNING id",[explicit.id])).rows.length,0);
    });
    // RLS also suppresses same-tenant UPDATE/DELETE; broad table grants cannot mutate history.
    await withTransaction(client,async tx=>{
      await setAuditContext(tx,context);
      assert.equal((await tx.query("UPDATE app.audit_events SET event_type='forged.event' WHERE id=$1 RETURNING id",[explicit.id])).rows.length,0);
      assert.equal((await tx.query("DELETE FROM app.audit_events WHERE id=$1 RETURNING id",[explicit.id])).rows.length,0);
    });
    await assert.rejects(withTransaction(client,async tx=>{await setAuditContext(tx,context);await tx.query("TRUNCATE app.audit_events");}),/append-only/);
    await assert.rejects(withTransaction(client,async tx=>{await setAuditContext(tx,context);await tx.query("INSERT INTO app.audit_events(organization_id,actor_type,actor_membership_id,actor_user_id,actor_role,event_type,policy_version,correlation_id,evidence,entry_hash) VALUES($1,'human',$2,$2,'owner','forged.event','v1',$3,'{}','')",[other,foreign,correlation]);}),/tenant context/);
    await assert.rejects(withTransaction(client,async tx=>{
      await tx.query("SELECT set_config('app.organization_id',$1,true)",[org]);
      await tx.query("INSERT INTO app.memberships(id,organization_id,user_id,role) VALUES('77777777-7777-4777-8777-777777777777',$1,$2,'admin')",[org,foreign]);
    }),/owner actor/);
    await withTransaction(client,async tx=>{
      await setAuditContext(tx,context);
      await tx.query("INSERT INTO app.memberships(id,organization_id,user_id,role) VALUES('77777777-7777-4777-8777-777777777777',$1,$2,'admin')",[org,foreign]);
    });
    assert.equal((await list()).find(e=>e.eventType==="memberships.insert").actorMembershipId,owner);
    // Capturing authentication must preserve valid sales-manager sessions, without granting audit-read authority.
    await withTransaction(client,async tx=>{
      await tx.query("SELECT set_config('app.organization_id',$1,true)",[org]);
      await tx.query("INSERT INTO app.owner_sessions(id,organization_id,user_id,membership_id,token_hash,csrf_hash,expires_at,idle_expires_at,idle_timeout_seconds) VALUES('88888888-8888-4888-8888-888888888888',$1,$2,$2,decode(repeat('ef',32),'hex'),decode(repeat('01',32),'hex'),now()+interval '1 hour',now()+interval '10 minutes',600)",[org,manager]);
    });
    assert.equal((await list()).find(e=>e.actorMembershipId===manager).actorRole,"sales_manager");
    // Critical security changes are captured; ordinary session touches are excluded.
    await withTransaction(client,async tx=>{
      await setAuditContext(tx,context);
      await tx.query("INSERT INTO app.organization_auth_policies(organization_id) VALUES($1)",[org]);
      await tx.query("UPDATE app.memberships SET status='inactive' WHERE id=$1",[manager]);
      await tx.query("INSERT INTO app.owner_sessions(id,organization_id,user_id,membership_id,token_hash,csrf_hash,expires_at,idle_expires_at,idle_timeout_seconds) VALUES($1,$2,$3,$3,decode(repeat('ab',32),'hex'),decode(repeat('cd',32),'hex'),now()+interval '1 hour',now()+interval '10 minutes',600)",[correlation,org,owner]);
    });
    const sessionCount=(await list()).filter(e=>e.eventType.startsWith("owner_sessions.")).length;
    assert.equal(sessionCount,2);
    await withTransaction(client,async tx=>{
      await tx.query("SELECT set_config('app.organization_id',$1,true)",[org]);
      await tx.query("UPDATE app.owner_sessions SET last_seen_at=now(),idle_expires_at=now()+interval '11 minutes' WHERE id=$1",[correlation]);
    });
    assert.equal((await list()).filter(e=>e.eventType.startsWith("owner_sessions.")).length,sessionCount);
    await withTransaction(client,async tx=>{await setAuditContext(tx,context);await tx.query("UPDATE app.owner_sessions SET revoked_at=now() WHERE id=$1",[correlation]);});
    assert.equal((await list()).filter(e=>e.eventType.startsWith("owner_sessions.")).length,sessionCount+1);
    assert.equal((await list()).find(e=>e.eventType==="memberships.update").actorMembershipId,owner);
    assert.ok(!JSON.stringify(await list()).includes("abababab"));
    await db.query("SET TIME ZONE 'America/New_York'");
    assert.ok((await list()).every(e=>/\.\d{6}Z$/.test(e.occurredAt)),"cursor preserves SQL microseconds independently of session time zone");
    await db.query("SET TIME ZONE 'UTC'");
    // The immutable trigger denies even a privileged direct UPDATE or DELETE.
    await db.exec("RESET ROLE");
    await assert.rejects(db.query("UPDATE app.audit_events SET event_type='forged.event' WHERE id=$1",[explicit.id]),/append-only/);
    await assert.rejects(db.query("DELETE FROM app.audit_events WHERE id=$1",[explicit.id]),/append-only/);
    await db.exec("SET ROLE audit_runtime");
    assert.equal((await list()).find(e=>e.id===explicit.id).eventType,"policy.denied");
    const firstPage=await repo.list({organizationId:org,membershipId:owner,limit:2});
    const tail=firstPage.at(-1);const secondPage=await repo.list({organizationId:org,membershipId:owner,limit:2,before:{occurredAt:tail.occurredAt,id:tail.id}});
    assert.ok(secondPage.every(e=>!firstPage.some(p=>p.id===e.id)));
    // Auditing failure fails the business mutation closed, rather than saving unaudited data.
    await assert.rejects(withTransaction(client,async tx=>{await setAuditContext(tx,{...context,membershipId:foreign});await tx.query("UPDATE app.projects SET label='Not authorized' WHERE id=$1",[project.id]);}),/not authorized/);
    assert.equal((await catalog.get({kind:"project",organizationId:org,id:project.id})).label,"Changed again");
    await db.exec("RESET ROLE");
    for(const name of names.filter(p=>p>"0010_append_only_audit.up.sql").reverse()) await db.exec(await readFile(new URL(name.replace(".up.sql",".down.sql"),dir),"utf8"));
    await db.exec(await readFile(new URL("0010_append_only_audit.down.sql",dir),"utf8"));
    assert.equal((await db.query("SELECT to_regclass('app.audit_events') AS name")).rows[0].name,null);
    await db.exec(up);assert.equal((await db.query("SELECT count(*)::int AS n FROM app.audit_events")).rows[0].n,0);
  } finally {await db.close();}
});

