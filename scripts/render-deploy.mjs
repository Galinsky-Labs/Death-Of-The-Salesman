// DOTS-153: deploy an exact commit to a Render service and wait until it is live. Used by the
// owner-authorized deploy workflow. Never creates services or changes plans.
const {RENDER_API_KEY:key,RENDER_SERVICE_ID:service,SHA:sha}=process.env;
if(!key||!/^srv-[a-z0-9]+$/.test(service??'')||!/^[0-9a-f]{40}$/.test(sha??''))throw new Error('RENDER_API_KEY, RENDER_SERVICE_ID and a full SHA are required');
const api=async(path,init={})=>{const response=await fetch(`https://api.render.com/v1${path}`,{...init,headers:{authorization:`Bearer ${key}`,accept:'application/json','content-type':'application/json'},signal:AbortSignal.timeout(30000)});const body=await response.text();if(!response.ok)throw new Error(`Render API ${response.status}: ${body.slice(0,300)}`);return body?JSON.parse(body):{};};
const deploy=await api(`/services/${service}/deploys`,{method:'POST',body:JSON.stringify({commitId:sha,clearCache:'do_not_clear'})});
console.log(JSON.stringify({event:'deploy.created',id:deploy.id,commit:sha}));
const deadline=Date.now()+25*60000;
while(Date.now()<deadline){
 await new Promise(resolve=>setTimeout(resolve,15000));
 const current=await api(`/services/${service}/deploys/${deploy.id}`);
 console.log(JSON.stringify({event:'deploy.status',status:current.status}));
 if(current.status==='live'){process.exit(0);}
 if(['build_failed','update_failed','canceled','deactivated','pre_deploy_failed'].includes(current.status))throw new Error(`Deploy ended with ${current.status}`);
}
throw new Error('Deploy did not become live within 25 minutes');
