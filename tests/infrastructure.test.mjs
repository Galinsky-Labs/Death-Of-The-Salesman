import test from 'node:test';import assert from 'node:assert/strict';import {readFile,readdir} from 'node:fs/promises';
const read=path=>readFile(new URL(`../${path}`,import.meta.url),'utf8');
test('render blueprint provisions only free resources, keeps paid paths off and never commits secret values',async()=>{
 const blueprint=await read('render.yaml');
 const plans=[...blueprint.matchAll(/^\s+plan:\s*(\S+)/gm)].map(m=>m[1]);assert.ok(plans.length>0);assert.deepEqual([...new Set(plans)],['free']);
 assert.doesNotMatch(blueprint,/^\s*-?\s*type:\s*(worker|pserv|cron|keyvalue|redis)/m,'no extra always-on/billable services');
 assert.match(blueprint,/autoDeploy:\s*false/);
 const vars=[...blueprint.matchAll(/- key:\s*(\S+)\n\s+(value|sync):\s*(.+)/g)].map(m=>({key:m[1],kind:m[2],value:m[3].trim().replace(/^"|"$/g,'')}));
 const get=key=>vars.find(v=>v.key===key);
 for(const [key,value] of Object.entries({PAID_SPEND_LIMIT_CENTS:'0',MODEL_API_ENABLED:'false',EMAIL_DELIVERY_ENABLED:'false',PAYMENTS_ENABLED:'false',COMMERCIAL_SIGNUP_ENABLED:'false',APP_ENV:'production'}))assert.equal(get(key)?.value,value,key);
 for(const key of ['DATABASE_URL','NEON_AUTH_BASE_URL','NEON_AUTH_COOKIE_SECRET','OWNER_EMAIL','OWNER_ORGANIZATION_ID','OWNER_MEMBERSHIP_ID','DOCUMENT_ENCRYPTION_KEY','UNSUBSCRIBE_SIGNING_KEY','CREDENTIAL_ENCRYPTION_KEY'])assert.deepEqual([get(key)?.kind,get(key)?.value],['sync','false'],`${key} must be entered privately`);
 for(const v of vars.filter(v=>v.kind==='value'))assert.doesNotMatch(v.key,/(SECRET|TOKEN|KEY|PASSWORD|URL)$/.test(v.key)&&v.key!=='APP_ORIGIN'?/./:/^$/,`${v.key} must not carry a committed value`);
});
test('environment inventory declares zero monthly spend and no paid resources',async()=>{
 const inventory=JSON.parse(await read('infra/environments.json'));assert.equal(inventory.costPolicy.monthlyUsdMax,0);
 for(const env of Object.values(inventory.environments))assert.equal(env.paidResources,false);
 assert.notEqual(inventory.environments.staging.neonBranch,inventory.environments.production.neonBranch,'staging and production are isolated branches');
});
test('deploy workflow is manual, environment-gated, pinned to a CI-verified SHA on main and verifies the live revision',async()=>{
 const workflow=await read('.github/workflows/deploy.yml');
 assert.match(workflow,/^on:\n\s+workflow_dispatch:/m);assert.doesNotMatch(workflow,/^\s+push:|^\s+pull_request:|schedule:/m);
 assert.match(workflow,/environment: \$\{\{ inputs.environment \}\}/);assert.match(workflow,/merge-base --is-ancestor/);assert.match(workflow,/check-runs/);
 assert.match(workflow,/EXPECTED_REVISION/);assert.match(workflow,/secrets\.RENDER_API_KEY/);assert.doesNotMatch(workflow,/rnd_[A-Za-z0-9]{10,}/);
 for(const script of ['render-deploy.mjs','smoke.mjs'])assert.ok((await readdir(new URL('../scripts/',import.meta.url))).includes(script));
});
test('production smoke workflow is manual, read-only and uses no secrets or deploy step',async()=>{
 const workflow=await read('.github/workflows/production-smoke.yml');
 assert.match(workflow,/^on:\n\s+workflow_dispatch:/m);assert.doesNotMatch(workflow,/^\s+push:|^\s+pull_request:|schedule:/m);
 assert.match(workflow,/^permissions:\n\s+contents: read\n/m);assert.doesNotMatch(workflow,/secrets\.|render-deploy|environment:/);
 assert.match(workflow,/node scripts\/smoke\.mjs/);assert.match(workflow,/EXPECTED_REVISION/);
});
test('operational scripts fail closed without explicit targets and refuse unsafe restore or scale targets',async()=>{
 const {spawnSync}=await import('node:child_process');const run=(script,env)=>spawnSync(process.execPath,[`scripts/${script}`],{env:{PATH:process.env.PATH,...env},encoding:'utf8',cwd:new URL('..',import.meta.url).pathname});
 for(const script of ['backup.mjs','restore-drill.mjs','render-deploy.mjs','smoke.mjs'])assert.notEqual(run(script,{}).status,0,script);
 assert.match(run('scale-identities.mjs',{SCALE_DATABASE_URL:'postgresql://user@prod.neon.tech/db'}).stderr,/local disposable/);
 assert.match(run('provision-tenant.mjs',{}).stderr,/COMMERCIAL_ONBOARDING_NOT_AUTHORIZED|ADMIN_DATABASE_URL/);
});
