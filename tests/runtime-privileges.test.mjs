import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {SalesWorkspace,ControlPlane,DurableQueue,tenant} from '../packages/operations/dist/index.js';import {setup,org,owner,agent,project,ctx} from './helpers/operations-fixture.mjs';
test('exact production runtime grants allow the requested workflows without identity-key, schema, auth, audit-mutation or financial-deletion privileges',async()=>{
 const {db,client}=await setup();try{
 const other='66666666-6666-4666-8666-666666666666',otherMember='77777777-7777-4777-8777-777777777777';
 await db.query('INSERT INTO app.organizations(id,slug,display_name) VALUES($1,\'other-synthetic\',\'Other synthetic organization\')',[other]);await db.query('INSERT INTO app.owner_users(id,identity_subject,display_name) VALUES($1,\'other-fixture\',\'Other synthetic owner\')',[otherMember]);
 await db.exec(`SELECT set_config('app.organization_id','${other}',false);SELECT set_config('app.audit_actor_membership_id','${otherMember}',false);`);
 await db.query("INSERT INTO app.memberships(id,organization_id,user_id,role) VALUES($1,$2,$1,'owner')",[otherMember,other]);
 await db.exec('CREATE ROLE dots_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;GRANT USAGE ON SCHEMA app TO dots_runtime;GRANT SELECT ON app.memberships,app.projects,app.agent_identities,app.agent_project_assignments,app.audit_events TO dots_runtime;GRANT INSERT ON app.audit_events TO dots_runtime;');
 await db.exec(await readFile(new URL('../database/runtime-grants.sql',import.meta.url),'utf8'));await db.exec('SET ROLE dots_runtime');
 for(const table of ['agent_identities','crm_contacts','messages','invoices','spending_policies'])assert.equal((await db.query("SELECT has_column_privilege('dots_runtime',$1,'id','UPDATE') AS allowed",[`app.${table}`])).rows[0].allowed,false,table);
 for(const table of ['money_entries','operation_events','audit_events','provider_receipts','document_library','crm_contacts'])assert.equal((await db.query("SELECT has_table_privilege('dots_runtime',$1,'DELETE') AS allowed",[`app.${table}`])).rows[0].allowed,false,table);
 assert.equal((await db.query("SELECT has_column_privilege('dots_runtime','app.provider_receipts','payload_hash','UPDATE') AS allowed")).rows[0].allowed,false);
 await assert.rejects(db.exec('CREATE TABLE app.forbidden_role_test(id int)'));
 await assert.rejects(db.query("UPDATE app.approved_agent_names SET name='forged' WHERE id=1"));
 const sales=new SalesWorkspace(client,ctx),control=new ControlPlane(client,ctx);await control.initialize();await control.pause(false);
 const contact=await sales.addContact({name:'Restricted fixture',email:'restricted@example.invalid',source:'Synthetic fixture'});assert.ok(contact.id);
 await tenant(client,ctx,async tx=>{assert.equal((await tx.query('SELECT id FROM app.memberships WHERE organization_id=$1',[other])).rows.length,0);});await assert.rejects(tenant(client,ctx,tx=>tx.query("INSERT INTO app.crm_accounts(organization_id,name) VALUES($1,'Cross tenant')",[other])),/row-level security/);
 const campaign=await sales.createCampaign({projectId:project,label:'Restricted campaign',purpose:'product',goal:'Synthetic goal'});await sales.setAudience(campaign.id,[contact.id]);await sales.setAudience(campaign.id,[]);
 await control.enqueue(project,agent,'draft',{mode:'simulation',brief:'Restricted runtime'},'restricted-task');const lease=await new DurableQueue(client,ctx,'restricted-worker').claim();assert.ok(lease);
 await sales.suppressContact(contact.id);await sales.redactContact(contact.id);
 }finally{await db.close();}
});
