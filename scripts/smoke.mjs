// DOTS-152/153: post-deploy smoke proof. Verifies liveness, database readiness, the exact live revision
// and that every protected route rejects anonymous and cross-origin requests. Read-only; sends no messages.
// SMOKE_EXPECT_DATABASE=false is for CI against a database-less local server: readiness must then fail closed.
const origin=(process.env.PUBLIC_ORIGIN??'').replace(/\/$/,'');const expected=process.env.EXPECTED_REVISION;
const expectDatabase=process.env.SMOKE_EXPECT_DATABASE!=='false';
const loopback=/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
if(!/^https:\/\/[a-z0-9.-]+$/.test(origin)&&!loopback)throw new Error('PUBLIC_ORIGIN must be an https origin (or an http loopback origin for CI)');
if(!expectDatabase&&!loopback)throw new Error('SMOKE_EXPECT_DATABASE=false is only allowed against a loopback origin');
const get=async(path,init={})=>{for(let attempt=1;;attempt++){try{return await fetch(origin+path,{redirect:'manual',signal:AbortSignal.timeout(90000),...init});}catch(error){if(attempt>=3)throw error;await new Promise(r=>setTimeout(r,10000));}}};
const results=[];const check=(name,ok,detail)=>{results.push({name,ok,detail});if(!ok)process.exitCode=1;};
const health=await get('/api/health');check('liveness',health.status===200,health.status);
const readiness=await get('/api/readiness');const ready=readiness.ok?await readiness.json():{};
if(expectDatabase){
 check('readiness',ready.status==='ok'&&ready.database==='connected',ready);
 if(expected)check('revision',ready.revision===expected,{expected,actual:ready.revision});
}else check('readiness fails closed without a database',readiness.status===503,readiness.status);
// Every owner surface: anonymous reads are rejected, and forged-origin writes are rejected before authentication.
const ownerReads=['/api/operations','/api/workspace','/api/documents','/api/export?resource=contacts',
 ...['campaigns','communications','crm','funding','governance','models','platform','revenue','runtime','strategy'].map(r=>`/api/v1/${r}`)];
for(const path of ownerReads)check(`anonymous GET ${path}`,[401,403].includes((await get(path)).status),path);
const ownerWrites=['/api/operations','/api/workspace',...ownerReads.filter(p=>p.startsWith('/api/v1/'))];
for(const path of ownerWrites){
 const forged=await get(path,{method:'POST',headers:{'content-type':'application/json',origin:'https://attacker.example'},body:'{"action":"pauseAll","paused":false}'});
 check(`cross-origin POST ${path} rejected`,forged.status===403,forged.status);
 const anonymous=await get(path,{method:'POST',headers:{'content-type':'application/json',origin},body:'{"action":"pauseAll","paused":false}'});
 check(`anonymous same-origin POST ${path} rejected`,[401,403].includes(anonymous.status),anonymous.status);
}
for(const provider of ['stripe','resend']){
 const unsigned=await get(`/api/webhooks/${provider}`,{method:'POST',headers:{'content-type':'application/json'},body:'{"id":"evt_smoke"}'});
 check(`unsigned ${provider} webhook rejected`,unsigned.status===401,unsigned.status);
}
for(const authorization of [undefined,'Bearer not-a-token']){
 const portfolio=await get('/api/v1/portfolio',authorization?{headers:{authorization}}:{});
 check(`portfolio rejects ${authorization?'malformed':'missing'} token`,portfolio.status===401&&portfolio.headers.get('www-authenticate')==='Bearer',portfolio.status);
}
const portfolioWrite=await get('/api/v1/portfolio',{method:'POST'});check('portfolio is read-only',portfolioWrite.status===405,portfolioWrite.status);
console.log(JSON.stringify({origin,checkedAt:new Date().toISOString(),passed:results.every(r=>r.ok),results},null,2));
