import {text,fail} from './common.js';
/** Fixed official public source; results are leads for owner eligibility review. */
export async function discoverGrants(keyword:string,transport:typeof fetch=fetch){
 text(keyword,'keyword',120);
 const response=await transport('https://api.grants.gov/v1/api/search2',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({keyword,oppStatuses:'posted',rows:20,startRecordNum:0}),signal:AbortSignal.timeout(15000),redirect:'error'});
 if(!response.ok)return fail('GRANT_SOURCE_UNAVAILABLE',503);
 const result=await response.json() as {errorcode?:number;data?:{hitCount?:number;oppHits?:Record<string,unknown>[]}};
 if(result.errorcode!==0||!Array.isArray(result.data?.oppHits))return fail('GRANT_SOURCE_RESPONSE_INVALID',503);
 return {source:'Grants.gov',queriedAt:new Date().toISOString(),total:Number(result.data.hitCount??0),opportunities:result.data.oppHits.filter(hit=>/^\d+$/.test(String(hit.id))).map(hit=>({id:String(hit.id),title:String(hit.title??'').slice(0,240),agency:String(hit.agency??'').slice(0,240),number:String(hit.number??'').slice(0,100),deadline:String(hit.closeDate??''),url:`https://www.grants.gov/search-results-detail/${hit.id}`,eligibility:'Review the official notice; search results do not establish eligibility.'}))};
}
