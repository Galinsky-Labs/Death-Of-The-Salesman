import { fail } from "./common.js";
export type ProviderId="openai"|"claude"|"grok"|"openrouter";
export type ProviderConfig={id:ProviderId;model:string;endpoint:string;apiKey:string;inputCentsPerMillion:number;outputCentsPerMillion:number;maxOutputTokens:number;billingMode?:"free"|"paid"};
export type Completion={text:string;inputTokens:number;outputTokens:number;providerRequestId:string|null};
export const providerIds:ProviderId[]=["openai","claude","grok","openrouter"];
const defaults:Record<ProviderId,string>={openai:"https://api.openai.com/v1/responses",claude:"https://api.anthropic.com/v1/messages",grok:"https://api.x.ai/v1/chat/completions",openrouter:"https://openrouter.ai/api/v1/chat/completions"};
export function providerConfiguration(id:ProviderId,source:Record<string,string|undefined>=process.env):ProviderConfig|null {
  const prefix=id.toUpperCase();
  if(!providerIds.includes(id)||source[`${prefix}_ENABLED`]!=="true")return null;
  if(id==='openrouter') {
    const apiKey=source.OPENROUTER_API_KEY,model=source.OPENROUTER_MODEL??'google/gemma-4-31b-it:free';
    if(!apiKey)return null;
    const maxOutputTokens=Number(source.OPENROUTER_MAX_OUTPUT_TOKENS??1000);
    if(!freeModelId(model)||!Number.isSafeInteger(maxOutputTokens)||maxOutputTokens<1||maxOutputTokens>4096)return fail('FREE_PROVIDER_CONFIGURATION_INVALID',503);
    return {id,model,apiKey,endpoint:defaults.openrouter,inputCentsPerMillion:0,outputCentsPerMillion:0,maxOutputTokens,billingMode:'free'};
  }
  const model=source[`${prefix}_MODEL`],apiKey=source[`${prefix}_API_KEY`];
  if(model&&/(?:deepseek|qwen|moonshot|kimi|mimo|chatglm|glm[-_.0-9]|zai|baichuan|minimax|doubao|hunyuan|internlm|stepfun|longcat)/i.test(model))return fail('PROVIDER_MODEL_NOT_ALLOWED',403);
  const endpoint=defaults[id];
  const inputCentsPerMillion=Number(source[`${prefix}_INPUT_CENTS_PER_MILLION`]);
  const outputCentsPerMillion=Number(source[`${prefix}_OUTPUT_CENTS_PER_MILLION`]);
  const maxOutputTokens=Number(source[`${prefix}_MAX_OUTPUT_TOKENS`]??1000);
  if(!model||!apiKey||!endpoint||!Number.isFinite(inputCentsPerMillion)||inputCentsPerMillion<0||!Number.isFinite(outputCentsPerMillion)||outputCentsPerMillion<0||!Number.isSafeInteger(maxOutputTokens)||maxOutputTokens<1||maxOutputTokens>8192)return fail("PROVIDER_CONFIGURATION_INVALID",503);
  const url=new URL(endpoint);if(url.protocol!=="https:"||url.username||url.password)return fail("PROVIDER_ENDPOINT_INVALID",503);
  return {id,model,endpoint,apiKey,inputCentsPerMillion,outputCentsPerMillion,maxOutputTokens};
}
export function usageCost(config:ProviderConfig,input:number,output:number):number {
  if(!Number.isSafeInteger(input)||!Number.isSafeInteger(output)||input<0||output<0)return fail("PROVIDER_USAGE_INVALID");
  return Math.ceil((input*config.inputCentsPerMillion+output*config.outputCentsPerMillion)/1_000_000);
}
export async function complete(config:ProviderConfig,system:string,prompt:string,signal?:AbortSignal,transport:typeof fetch=fetch):Promise<Completion> {
  if(config.id==='openrouter'&&(!freeModelId(config.model)||config.endpoint!==defaults.openrouter||config.inputCentsPerMillion!==0||config.outputCentsPerMillion!==0||config.billingMode!=='free'))return fail('FREE_PROVIDER_CONFIGURATION_INVALID',503);
  if(config.id!=='openrouter'&&(config.endpoint!==defaults[config.id]||/(?:deepseek|qwen|moonshot|kimi|mimo|chatglm|glm[-_.0-9]|zai|baichuan|minimax|doubao|hunyuan|internlm|stepfun|longcat)/i.test(config.model)))return fail('PROVIDER_MODEL_NOT_ALLOWED',403);
  if(!providerIds.includes(config.id))return fail('PROVIDER_NOT_ALLOWED',403);
  if(config.id==='openrouter'&&!(await discoverFreeModels(transport)).models.some(model=>model.id===config.model))return fail('FREE_MODEL_NOT_AVAILABLE',503);
  const headers:Record<string,string>={"content-type":"application/json"};let payload:Record<string,unknown>;
  if(config.id==="claude") {headers["x-api-key"]=config.apiKey;headers["anthropic-version"]="2023-06-01";payload={model:config.model,max_tokens:config.maxOutputTokens,system,messages:[{role:"user",content:prompt}]};}
  else if(config.id==="openai"){headers.authorization=`Bearer ${config.apiKey}`;payload={model:config.model,instructions:system,input:prompt,max_output_tokens:config.maxOutputTokens,store:false};}
  else {headers.authorization=`Bearer ${config.apiKey}`;payload={model:config.model,messages:[{role:"system",content:system},{role:"user",content:prompt}],max_tokens:config.maxOutputTokens,stream:false};}
  if(config.id==='openrouter')payload.provider={max_price:{prompt:0,completion:0,request:0,image:0},allow_fallbacks:false,only:['google-ai-studio'],data_collection:'allow'};
  const response=await transport(config.endpoint,{method:"POST",headers,body:JSON.stringify(payload),signal:signal??AbortSignal.timeout(25000),redirect:"error"});
  if(!response.ok)return fail(response.status===429?"PROVIDER_RATE_LIMITED":response.status>=500?"PROVIDER_UNAVAILABLE":"PROVIDER_REJECTED",503);
  const body=await response.json() as any;
  if(config.billingMode==='free'&&body.usage?.cost!==undefined&&body.usage.cost!==0)return fail('FREE_PROVIDER_UNEXPECTED_COST');
  let result:Completion;
  if(config.id==="claude")result={text:(body.content??[]).filter((p:any)=>p.type==="text").map((p:any)=>p.text).join("\n"),inputTokens:body.usage?.input_tokens,outputTokens:body.usage?.output_tokens,providerRequestId:body.id??null};
  else if(config.id==="openai")result={text:body.output_text??(body.output??[]).flatMap((p:any)=>p.content??[]).filter((p:any)=>p.type==="output_text").map((p:any)=>p.text).join("\n"),inputTokens:body.usage?.input_tokens,outputTokens:body.usage?.output_tokens,providerRequestId:body.id??null};
  else result={text:body.choices?.[0]?.message?.content,inputTokens:body.usage?.prompt_tokens,outputTokens:body.usage?.completion_tokens,providerRequestId:body.id??null};
  if(typeof result.text!=="string"||!result.text.trim()||result.text.length>100000)return fail("PROVIDER_RESPONSE_INVALID");
  usageCost(config,result.inputTokens,result.outputTokens);return result;
}

export function freeModelId(value:string):boolean{return value==='google/gemma-4-31b-it:free';}
const zeroPrice=(value:unknown)=>value===0||(typeof value==='string'&&/^0(?:\.0+)?$/.test(value));
export async function discoverFreeModels(transport:typeof fetch=fetch){
 const response=await transport('https://openrouter.ai/api/v1/models',{signal:AbortSignal.timeout(15000),redirect:'error'});
 if(!response.ok)return fail('FREE_MODEL_CATALOG_UNAVAILABLE',503);
 const body=await response.json() as {data?:any[]};if(!Array.isArray(body.data))return fail('FREE_MODEL_CATALOG_INVALID',503);
 return {source:'OpenRouter',observedAt:new Date().toISOString(),models:body.data.filter(model=>typeof model.hugging_face_id==='string'&&/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(model.hugging_face_id)&&freeModelId(String(model.id))&&zeroPrice(model.pricing?.prompt)&&zeroPrice(model.pricing?.completion)&&(model.pricing.request===undefined||zeroPrice(model.pricing.request))&&(!model.architecture?.input_modalities||model.architecture.input_modalities.includes('text'))).slice(0,100).map(model=>({id:String(model.id),name:String(model.name??model.id).slice(0,200),contextLength:Number(model.context_length??0),costCents:0,weightsUrl:`https://huggingface.co/${model.hugging_face_id}`})),note:'An account API key is required. Availability and free quotas can change; there is no paid fallback.'};
}

export async function checkFreeModelConnection(source:Record<string,string|undefined>=process.env,transport:typeof fetch=fetch){
 const config=providerConfiguration('openrouter',source);if(!config)return fail('PROVIDER_NOT_CONFIGURED',503);
 const response=await transport('https://openrouter.ai/api/v1/key',{headers:{authorization:`Bearer ${config.apiKey}`},signal:AbortSignal.timeout(10000),redirect:'error'});
 if(!response.ok)return fail(response.status===401?'PROVIDER_KEY_REJECTED':'PROVIDER_UNAVAILABLE',503);
 const available=await discoverFreeModels(transport);if(!available.models.some(model=>model.id===config.model))return fail('FREE_MODEL_NOT_AVAILABLE',503);
 return {authenticated:true,model:config.model,costCents:0,paidFallback:false,inferencePerformed:false,note:'API key and current free catalog verified. No inference request or spend occurred.'};
}
