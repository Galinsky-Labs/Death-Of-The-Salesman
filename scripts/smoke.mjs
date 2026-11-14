// DOTS-152/153: post-deploy smoke proof. Verifies liveness, database readiness, the exact live revision
// and that protected routes reject anonymous and cross-origin requests. Read-only; sends no messages.
const origin=(process.env.PUBLIC_ORIGIN??'').replace(/\/$/,'');const expected=process.env.EXPECTED_REVISION;
if(!/^https:\/\/[a-z0-9.-]+$/.test(origin))throw new Error('PUBLIC_ORIGIN must be an https origin');
const get=async(path,init={})=>{for(let attempt=1;;attempt++){try{return await fetch(origin+path,{redirect:'manual',signal:AbortSignal.timeout(90000),...init});}catch(error){if(attempt>=3)throw error;await new Promise(r=>setTimeout(r,10000));}}};
const results=[];const check=(name,ok,detail)=>{results.push({name,ok,detail});if(!ok)process.exitCode=1;};
const health=await get('/api/health');check('liveness',health.status===200,health.status);
const readiness=await get('/api/readiness');const ready=readiness.ok?await readiness.json():{};
check('readiness',ready.status==='ok'&&ready.database==='connected',ready);
if(expected)check('revision',ready.revision===expected,{expected,actual:ready.revision});
for(const path of ['/api/operations','/api/workspace','/api/v1/platform','/api/export?resource=contacts'])check(`anonymous ${path}`,[401,403].includes((await get(path)).status),path);
const forged=await get('/api/operations',{method:'POST',headers:{'content-type':'application/json',origin:'https://attacker.example'},body:'{"action":"pauseAll","paused":false}'});
check('cross-origin mutation rejected',forged.status===403,forged.status);
const unsigned=await get('/api/webhooks/stripe',{method:'POST',headers:{'content-type':'application/json'},body:'{"id":"evt_smoke"}'});
check('unsigned webhook rejected',unsigned.status===401,unsigned.status);
const portfolio=await get('/api/v1/portfolio');check('portfolio requires token',portfolio.status===401,portfolio.status);
console.log(JSON.stringify({origin,checkedAt:new Date().toISOString(),passed:results.every(r=>r.ok),results},null,2));
