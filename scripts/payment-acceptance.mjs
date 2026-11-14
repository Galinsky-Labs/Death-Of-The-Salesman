#!/usr/bin/env node
// DOTS-144 opt-in payment acceptance gate.
//   PAYMENT_ACCEPTANCE_ENABLED=true node scripts/payment-acceptance.mjs --mode=offline   (default; synthetic, no network)
//   PAYMENT_ACCEPTANCE_ENABLED=true node scripts/payment-acceptance.mjs --mode=sandbox   (Stripe test-mode key; one read-only API call)
//   PAYMENT_ACCEPTANCE_ENABLED=true node scripts/payment-acceptance.mjs --mode=live --confirm=<authorization id>
// The script never creates a live charge or refund. Live mode only verifies that every owner gate is present and
// prints the owner-run checklist. Exit codes: 0 passed, 1 not opted in / check failed, 2 refused by a gate.
import {createHmac} from 'node:crypto';
import {readdir,readFile} from 'node:fs/promises';

export const checklist=[
 'Owner opens a separate Stripe account for this product and completes processor onboarding (blocked on external prerequisite).',
 'Owner records OWNER_MERCHANT_AUTHORIZATION_ID and the approved maximum transaction (MAX_PAYMENT_CENTS) in the deployment environment.',
 'Sandbox: set a test-mode restricted key (rk_test_...) and STRIPE_WEBHOOK_SECRET, run --mode=offline and --mode=sandbox, then pay one issued invoice with a Stripe test card and confirm the webhook marks it paid as sandbox (not realized revenue).',
 'Sandbox: issue a test refund and a test dispute in the Stripe dashboard; confirm the Revenue view shows them as sandbox ledger entries only.',
 'Live switch: owner records PRODUCTION_PAYMENTS_AUTHORIZATION_ID, sets PAYMENTS_LIVE_MODE=true, replaces the key with a restricted live key (rk_live_...) limited to Checkout Sessions write, and registers the live webhook endpoint secret.',
 'Live low-risk transaction: owner pays one invoice no larger than PAYMENT_ACCEPTANCE_MAX_CENTS with their own card through the app checkout link.',
 'Reconciliation: confirm the signed payment_intent.succeeded webhook created exactly one provider-source sale_receipt (and processor_fee if expanded) and the Revenue view net realized revenue matches the Stripe balance transaction.',
 'Refund: owner refunds the transaction in Stripe; confirm charge.refunded creates exactly one refund ledger entry and the invoice shows refunded.',
 'Rollback: set PAYMENTS_ENABLED=false (and PAYMENTS_LIVE_MODE=false); confirm checkout is refused with MERCHANT_SETUP_REQUIRED while webhooks for existing payments still reconcile.',
 'Record dates, Stripe object IDs (no card data) and screenshots in docs/evidence before any wider rollout.',
];

const parse=(argv)=>Object.fromEntries(argv.filter(a=>a.startsWith('--')).map(a=>{const [k,...v]=a.slice(2).split('=');return [k,v.length?v.join('='):'true'];}));

/** Gate evaluation is pure so it can be tested without network or database access. */
export function evaluateGates(mode,env,args={}){
 const problems=[];const key=env.STRIPE_SECRET_KEY??'';
 if(env.PAYMENT_ACCEPTANCE_ENABLED!=='true')return {status:'not_opted_in',problems:['Set PAYMENT_ACCEPTANCE_ENABLED=true to run the payment acceptance gate.']};
 if(!['offline','sandbox','live'].includes(mode))return {status:'refused',problems:[`Unknown mode ${mode}.`]};
 if(mode==='sandbox'){
  if(!/^(sk|rk)_test_/.test(key))problems.push('Sandbox mode requires a Stripe test-mode key (sk_test_/rk_test_). Live keys are refused.');
  for(const name of ['PAYMENTS_ENABLED','OWNER_MERCHANT_AUTHORIZATION_ID','STRIPE_WEBHOOK_SECRET'])if(!env[name])problems.push(`Missing ${name}.`);
 }
 if(mode==='live'){
  for(const name of ['PRODUCTION_PAYMENTS_AUTHORIZATION_ID','OWNER_MERCHANT_AUTHORIZATION_ID','STRIPE_WEBHOOK_SECRET'])if(!env[name])problems.push(`Missing ${name} (owner authorization required).`);
  if(env.PAYMENTS_LIVE_MODE!=='true')problems.push('PAYMENTS_LIVE_MODE must be true.');
  if(!/^rk_live_/.test(key))problems.push('Live mode requires a restricted live key (rk_live_...).');
  const cap=Number(env.PAYMENT_ACCEPTANCE_MAX_CENTS);if(!Number.isSafeInteger(cap)||cap<50||cap>500)problems.push('PAYMENT_ACCEPTANCE_MAX_CENTS must be an integer between 50 and 500 (low-risk transaction).');
  if(!env.PRODUCTION_PAYMENTS_AUTHORIZATION_ID||args.confirm!==env.PRODUCTION_PAYMENTS_AUTHORIZATION_ID)problems.push('Pass --confirm=<PRODUCTION_PAYMENTS_AUTHORIZATION_ID> to confirm the owner authorization.');
 }
 return {status:problems.length?'refused':'ready',problems};
}

/** Synthetic end-to-end checks against an in-memory database. No network, no credentials, no spend. */
export async function offlineChecks(){
 const {PGlite}=await import('@electric-sql/pglite');
 const ops=await import('../packages/operations/dist/index.js');
 const org='11111111-1111-4111-8111-111111111111',owner='22222222-2222-4222-8222-222222222222',project='44444444-4444-4444-8444-444444444444';const ctx={organizationId:org,membershipId:owner};
 const db=new PGlite();const directory=new URL('../database/migrations/',import.meta.url);
 for(const file of (await readdir(directory)).filter(f=>f.endsWith('.up.sql')).sort()){if(file.startsWith('0010')){await db.query("INSERT INTO app.organizations(id,slug,display_name) VALUES($1,'acceptance','Synthetic acceptance organization')",[org]);await db.query("INSERT INTO app.owner_users(id,identity_subject,display_name) VALUES($1,'acceptance-owner','Synthetic owner')",[owner]);await db.query("INSERT INTO app.memberships(id,organization_id,user_id,role) VALUES($1,$2,$1,'owner')",[owner,org]);}await db.exec(await readFile(new URL(file,directory),'utf8'));}
 const client={query:(q,v)=>db.query(q,v)};const results=[];const check=async(name,fn)=>{try{await fn();results.push({name,passed:true});}catch(error){results.push({name,passed:false,error:String(error?.message??error)});}};
 const expectReject=async(promise,code)=>{try{await promise;}catch(error){if(String(error.message).includes(code))return;throw new Error(`expected ${code}, got ${error.message}`);}throw new Error(`expected ${code}`);};
 try{
  await ops.tenant(client,ctx,tx=>tx.query("INSERT INTO app.projects(id,organization_id,label,updated_by_membership_id) VALUES($1,$2,'Synthetic product',$3)",[project,org,owner]));
  await new ops.ControlPlane(client,ctx).initialize();
  const sales=new ops.SalesWorkspace(client,ctx);const invoice=await sales.createInvoice(project,'Synthetic acceptance invoice','Synthetic service',100);await sales.issueInvoice(invoice.id,Number(invoice.version));
  let calls=0;const transport=async()=>{calls++;return Response.json({url:'https://checkout.stripe.com/c/pay/synthetic',livemode:false});};
  const sandbox={PAYMENTS_ENABLED:'true',STRIPE_SECRET_KEY:'rk_test_synthetic',OWNER_MERCHANT_AUTHORIZATION_ID:'synthetic-authority',APP_ORIGIN:'https://example.invalid',MAX_PAYMENT_CENTS:'500'};
  await check('checkout is refused by default without calling the processor',async()=>{await expectReject(new ops.PaymentGateway(client,ctx,{},transport).checkout(invoice.id),'MERCHANT_SETUP_REQUIRED');if(calls)throw new Error('processor called');});
  await check('live key without owner production authorization is refused',async()=>{await expectReject(new ops.PaymentGateway(client,ctx,{...sandbox,STRIPE_SECRET_KEY:'rk_live_synthetic'},transport).checkout(invoice.id),'LIVE_PAYMENTS_NOT_AUTHORIZED');if(calls)throw new Error('processor called');});
  await check('sandbox checkout creates an isolated test session',async()=>{const result=await new ops.PaymentGateway(client,ctx,sandbox,transport).checkout(invoice.id);if(result.mode!=='sandbox'||calls!==1)throw new Error('sandbox checkout failed');});
  await check('webhook signatures are verified',async()=>{const secret='synthetic-acceptance-secret',raw='{"id":"evt"}',t=Math.floor(Date.now()/1000);const sig=createHmac('sha256',secret).update(`${t}.${raw}`).digest('hex');if(!ops.verifyWebhook(raw,`t=${t},v1=${sig}`,secret)||ops.verifyWebhook(raw+' ',`t=${t},v1=${sig}`,secret))throw new Error('signature check failed');});
  const payments=new ops.PaymentGateway(client,ctx,sandbox,transport);
  await check('sandbox settlement reconciles as sandbox, never realized revenue',async()=>{await payments.ingestStripe('evt_acceptance_paid',{id:'evt_acceptance_paid',livemode:false,type:'payment_intent.succeeded',data:{object:{id:'pi_acceptance',currency:'usd',amount_received:100,metadata:{organization_id:org,invoice_id:invoice.id},latest_charge:{balance_transaction:{fee:33}}}}});const revenue=await new ops.RevenueOperations(client,ctx).realizedRevenue();if(revenue.verified.netRealizedCents!==0||revenue.sandbox.receiptsCents!==100||revenue.sandbox.processorFeesCents!==33)throw new Error(JSON.stringify(revenue));});
  await check('sandbox refund reconciles exactly once',async()=>{const refund={id:'evt_acceptance_refund',livemode:false,type:'charge.refunded',data:{object:{id:'ch_acceptance',payment_intent:'pi_acceptance',amount_refunded:100}}};await payments.ingestStripe(refund.id,refund);await payments.ingestStripe(refund.id,refund);const revenue=await new ops.RevenueOperations(client,ctx).realizedRevenue();if(revenue.sandbox.refundsCents!==100)throw new Error('refund not reconciled');});
  await check('live events are refused without owner production authorization',async()=>{await expectReject(payments.ingestStripe('evt_acceptance_live',{id:'evt_acceptance_live',livemode:true,type:'payment_intent.succeeded',data:{object:{id:'pi_live'}}}),'LIVE_PAYMENTS_NOT_AUTHORIZED');});
  await check('rollback (PAYMENTS_ENABLED=false) stops new checkouts',async()=>{await expectReject(new ops.PaymentGateway(client,ctx,{...sandbox,PAYMENTS_ENABLED:'false'},transport).checkout(invoice.id),'MERCHANT_SETUP_REQUIRED');});
 }finally{await db.close();}
 return results;
}

export async function sandboxProbe(env,transport=fetch){
 const response=await transport('https://api.stripe.com/v1/balance',{headers:{authorization:`Bearer ${env.STRIPE_SECRET_KEY}`},signal:AbortSignal.timeout(15000),redirect:'error'});
 if(!response.ok)return {name:'sandbox key can read its test-mode balance',passed:false,error:`HTTP ${response.status}`};
 const body=await response.json();return {name:'sandbox key can read its test-mode balance',passed:body.livemode===false,error:body.livemode===false?undefined:'key is not in test mode'};
}

export async function main(argv=process.argv.slice(2),env=process.env,log=console.log){
 const args=parse(argv);const mode=args.mode??'offline';
 log('Payment acceptance checklist (DOTS-144):');checklist.forEach((item,index)=>log(`  ${index+1}. ${item}`));
 const gate=evaluateGates(mode,env,args);
 if(gate.status==='not_opted_in'){log(`NOT RUN: ${gate.problems.join(' ')}`);return 1;}
 if(gate.status==='refused'){log(`REFUSED (${mode}):`);gate.problems.forEach(problem=>log(`  - ${problem}`));if(mode==='live')log('Live acceptance is blocked on external prerequisite: owner merchant account, processor onboarding and explicit permission to run a real payment and refund.');return 2;}
 if(mode==='live'){log('Live gates are present. This script never charges or refunds: the owner performs checklist steps 6-10 through the application and records the evidence.');return 0;}
 const results=await offlineChecks();if(mode==='sandbox')results.push(await sandboxProbe(env));
 for(const result of results)log(`${result.passed?'PASS':'FAIL'} ${result.name}${result.error?` (${result.error})`:''}`);
 const failed=results.filter(result=>!result.passed).length;log(failed?`${failed} check(s) failed.`:`All ${results.length} ${mode} checks passed. No live charge was attempted.`);return failed?1:0;
}

if(import.meta.url===`file://${process.argv[1]}`)process.exitCode=await main();
