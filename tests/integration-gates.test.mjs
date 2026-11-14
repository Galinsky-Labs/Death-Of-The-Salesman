import test from 'node:test';import assert from 'node:assert/strict';
import {runOneTask,KillSwitches,GovernedBudget} from '../packages/operations/dist/index.js';
import {setup,project,agent,ctx} from './helpers/operations-fixture.mjs';
const env={MODEL_API_ENABLED:'true',OWNER_SPEND_AUTHORIZATION_ID:'synthetic-authorization',PAID_SPEND_LIMIT_CENTS:'100',OPENAI_ENABLED:'true',OPENAI_MODEL:'synthetic-model',OPENAI_API_KEY:'synthetic-fixture-only',OPENAI_INPUT_CENTS_PER_MILLION:'100',OPENAI_OUTPUT_CENTS_PER_MILLION:'200',OPENAI_MAX_OUTPUT_TOKENS:'100'};
async function liveTask(db,client,control,key){await control.pause(false);await control.setBudget(100,'synthetic-authorization',100);await db.query('UPDATE app.policy_controls SET model_enabled=true');return control.enqueue(project,agent,'draft',{mode:'live',provider:'openai',brief:'Synthetic gate fixture'},key);}
test('paid model execution is blocked before any provider request when the governed ledger is unfunded',async()=>{const {db,client,control}=await setup();try{
 await liveTask(db,client,control,'gate-unfunded');let requests=0;
 const result=await runOneTask(client,ctx,'gate-worker',env,async()=>{requests++;return Response.json({});});
 assert.equal(result.reasonCode,'BUDGET_EXCEEDED');assert.equal(requests,0);
 assert.equal((await db.query("SELECT count(*)::int AS n FROM app.budget_reservations WHERE status='reserved'")).rows[0].n,0,'no reservation is left held');
}finally{await db.close();}});
test('a provider kill switch blocks a funded paid run with zero provider requests',async()=>{const {db,client,control}=await setup();try{
 await liveTask(db,client,control,'gate-kill');await new GovernedBudget(client,ctx).fund(100,'synthetic-authorization',100,'gate-fund');
 const switches=new KillSwitches(client,ctx);await switches.engage('provider','openai','Synthetic provider outage drill');
 let requests=0;const result=await runOneTask(client,ctx,'gate-worker',env,async()=>{requests++;return Response.json({});});
 assert.equal(result.reasonCode,'KILL_SWITCH_ACTIVE');assert.equal(requests,0);
}finally{await db.close();}});
