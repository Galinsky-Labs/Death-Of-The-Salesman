import { fail } from "./common.js";
export type ProviderId="openai"|"claude"|"grok"|"mimo"|"glm"|"kimi"|"neon";
export type ProviderConfig={id:ProviderId;model:string;endpoint:string;apiKey:string;inputCentsPerMillion:number;outputCentsPerMillion:number;maxOutputTokens:number};
export type Completion={text:string;inputTokens:number;outputTokens:number;providerRequestId:string|null};
export const providerIds:ProviderId[]=["openai","claude","grok","mimo","glm","kimi","neon"];
const defaults:Record<ProviderId,string>={openai:"https://api.openai.com/v1/responses",claude:"https://api.anthropic.com/v1/messages",grok:"https://api.x.ai/v1/chat/completions",mimo:"",glm:"",kimi:"",neon:""};
export function providerConfiguration(id:ProviderId,source:Record<string,string|undefined>=process.env):ProviderConfig|null {
  const prefix=id.toUpperCase();
  if(source[`${prefix}_ENABLED`]!=="true")return null;
  const model=source[`${prefix}_MODEL`],apiKey=source[`${prefix}_API_KEY`];
  const endpoint=source[`${prefix}_ENDPOINT`]??defaults[id];
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
  const headers:Record<string,string>={"content-type":"application/json"};let payload:Record<string,unknown>;
  if(config.id==="claude") {headers["x-api-key"]=config.apiKey;headers["anthropic-version"]="2023-06-01";payload={model:config.model,max_tokens:config.maxOutputTokens,system,messages:[{role:"user",content:prompt}]};}
  else if(config.id==="openai"){headers.authorization=`Bearer ${config.apiKey}`;payload={model:config.model,instructions:system,input:prompt,max_output_tokens:config.maxOutputTokens,store:false};}
  else {headers.authorization=`Bearer ${config.apiKey}`;payload={model:config.model,messages:[{role:"system",content:system},{role:"user",content:prompt}],max_tokens:config.maxOutputTokens,stream:false};}
  const response=await transport(config.endpoint,{method:"POST",headers,body:JSON.stringify(payload),signal:signal??AbortSignal.timeout(25000),redirect:"error"});
  if(!response.ok)return fail(response.status===429?"PROVIDER_RATE_LIMITED":response.status>=500?"PROVIDER_UNAVAILABLE":"PROVIDER_REJECTED",503);
  const body=await response.json() as any;
  let result:Completion;
  if(config.id==="claude")result={text:(body.content??[]).filter((p:any)=>p.type==="text").map((p:any)=>p.text).join("\n"),inputTokens:body.usage?.input_tokens,outputTokens:body.usage?.output_tokens,providerRequestId:body.id??null};
  else if(config.id==="openai")result={text:body.output_text??(body.output??[]).flatMap((p:any)=>p.content??[]).filter((p:any)=>p.type==="output_text").map((p:any)=>p.text).join("\n"),inputTokens:body.usage?.input_tokens,outputTokens:body.usage?.output_tokens,providerRequestId:body.id??null};
  else result={text:body.choices?.[0]?.message?.content,inputTokens:body.usage?.prompt_tokens,outputTokens:body.usage?.completion_tokens,providerRequestId:body.id??null};
  if(typeof result.text!=="string"||!result.text.trim()||result.text.length>100000)return fail("PROVIDER_RESPONSE_INVALID");
  usageCost(config,result.inputTokens,result.outputTokens);return result;
}
