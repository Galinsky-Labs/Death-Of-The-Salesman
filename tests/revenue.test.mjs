import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {spawnSync} from 'node:child_process';
import {RevenueOperations,PaymentGateway,SalesWorkspace,ControlPlane,tenant,buildIcs,toCsv,quoteTotals,stableExternalId,issueLeadNonce,verifyLeadNonce,calendarAdapterFor,paymentMode,paymentConfiguration} from '../packages/operations/dist/index.js';
import {setup,org,owner,agent,project,ctx} from './helpers/operations-fixture.mjs';
import {evaluateGates,main as acceptance} from '../scripts/payment-acceptance.mjs';

const other='66666666-6666-4666-8666-666666666666',otherOwner='77777777-7777-4777-8777-777777777777',otherProject='88888888-8888-4888-8888-888888888888';
const otherCtx={organizationId:other,membershipId:otherOwner};
const live={PRODUCTION_PAYMENTS_AUTHORIZATION_ID:'synthetic-production-authority',PAYMENTS_LIVE_MODE:'true'};
const leadEnv={LEAD_FORM_SIGNING_KEY:'synthetic-lead-form-signing-key-0123456789'};
const consentText='I agree that Synthetic Product may store my details to answer this enquiry.';
async function secondTenant(db,client){
 await db.query("INSERT INTO app.organizations(id,slug,display_name) VALUES($1,'other-synthetic','Other synthetic organization')",[other]);
 await db.query("INSERT INTO app.owner_users(id,identity_subject,display_name) VALUES($1,'other-fixture','Other synthetic owner')",[otherOwner]);
 await db.exec(`SELECT set_config('app.organization_id','${other}',false);SELECT set_config('app.audit_actor_membership_id','${otherOwner}',false);`);
 await db.query("INSERT INTO app.memberships(id,organization_id,user_id,role) VALUES($1,$2,$1,'owner')",[otherOwner,other]);
 await tenant(client,otherCtx,tx=>tx.query("INSERT INTO app.projects(id,organization_id,label,updated_by_membership_id) VALUES($1,$2,'Other synthetic product',$3)",[otherProject,other,otherOwner]));
 await new ControlPlane(client,otherCtx).initialize();
}
async function secondAgent(db,client,assign=false){const name=(await db.query("SELECT id,name FROM app.approved_agent_names WHERE name='Harry Wormwood'")).rows[0];const id='55555555-5555-4555-8555-555555555555';
 await tenant(client,ctx,async tx=>{await tx.query("INSERT INTO app.agent_identities(id,organization_id,approved_name_id,display_name,status,updated_by_membership_id) VALUES($1,$2,$3,$4,'active',$5)",[id,org,name.id,name.name,owner]);if(assign)await tx.query("INSERT INTO app.agent_project_assignments(organization_id,agent_identity_id,project_id,priority,allocation_basis_points,quota_limit,concurrency_cap,updated_by_membership_id) VALUES($1,$2,$3,50,10000,1,1,$4)",[org,id,project,owner]);});return id;}
const count=async(db,table)=>(await db.query(`SELECT count(*)::int AS n FROM app.${table}`)).rows[0].n;
async function pricedBook(revenue,options={}){const book=await revenue.createPriceBook({projectId:project,label:'Synthetic plan'});await revenue.addPriceRevision(book.id,{unitPriceCents:10000,billingInterval:'month',maxDiscountBasisPoints:2000,offerTerms:'Synthetic monthly service terms.',quoteValidDays:14,...options});await revenue.approvePriceRevision(book.id,1,'owner-pricing-authority-1');return book;}

test('DOTS-135 quotes use only the current approved price, discounts need scoped approval and binding terms need an owner authorization',async()=>{const {db,client,control}=await setup();try{
 const revenue=new RevenueOperations(client,ctx),sales=new SalesWorkspace(client,ctx);
 const account=await sales.addAccount('Synthetic customer account');const contact=await sales.addContact({name:'Synthetic buyer',email:'buyer@example.invalid',source:'Synthetic fixture',accountId:account.id});
 const book=await revenue.createPriceBook({projectId:project,label:'Synthetic plan'});
 await revenue.addPriceRevision(book.id,{unitPriceCents:10000,billingInterval:'month',maxDiscountBasisPoints:2000,offerTerms:'Synthetic monthly service terms.'});
 await assert.rejects(revenue.createQuote({priceBookId:book.id,accountId:account.id}),/CURRENT_PRICE_NOT_APPROVED/);
 await assert.rejects(revenue.approvePriceRevision(book.id,1,''),/INVALID_PRICING_AUTHORIZATION/);
 await revenue.approvePriceRevision(book.id,1,'owner-pricing-authority-1');
 await assert.rejects(revenue.createQuote({priceBookId:book.id,accountId:account.id,discountBasisPoints:2500}),/DISCOUNT_EXCEEDS_POLICY/);
 await assert.rejects(revenue.createQuote({priceBookId:book.id}),/QUOTE_RECIPIENT_REQUIRED/);
 const plain=await revenue.createQuote({priceBookId:book.id,accountId:account.id,contactId:contact.id,quantity:2});
 assert.equal(plain.state,'ready');assert.equal(Number(plain.unit_price_cents),10000);assert.equal(Number(plain.total_cents),20000);
 assert.deepEqual(quoteTotals(10000,3,1500),{subtotalCents:30000,discountCents:4500,totalCents:25500});
 const discounted=await revenue.createQuote({priceBookId:book.id,accountId:account.id,discountBasisPoints:1000});
 assert.equal(discounted.state,'awaiting_discount_approval');assert.equal(Number(discounted.total_cents),9000);assert.ok(discounted.discount_approval_id);
 await assert.rejects(revenue.sendQuote(discounted.id,{channel:'owner_manual',evidence:'Owner emailed PDF manually',version:Number(discounted.version)}),/DISCOUNT_APPROVAL_REQUIRED/);
 await control.decideApproval(discounted.discount_approval_id,true);
 const fresh=(await db.query('SELECT version FROM app.quotes WHERE id=$1',[discounted.id])).rows[0];
 const sent=await revenue.sendQuote(discounted.id,{channel:'owner_manual',evidence:'Owner emailed PDF manually',version:Number(fresh.version)});assert.equal(sent.state,'sent');
 assert.equal((await db.query('SELECT status FROM app.action_approvals WHERE id=$1',[discounted.discount_approval_id])).rows[0].status,'consumed');
 // A new price revision makes older unsent quotes stale and blocks new quotes until approved.
 await revenue.addPriceRevision(book.id,{unitPriceCents:12000,billingInterval:'month',offerTerms:'Synthetic revised terms.'});
 await assert.rejects(revenue.sendQuote(plain.id,{channel:'owner_manual',evidence:'Owner delivered',version:Number(plain.version)}),/QUOTE_PRICE_STALE/);
 await assert.rejects(revenue.createQuote({priceBookId:book.id,accountId:account.id}),/CURRENT_PRICE_NOT_APPROVED/);
 await assert.rejects(revenue.approvePriceRevision(book.id,1,'stale'),/ONLY_CURRENT_REVISION_CAN_BE_APPROVED/);
 await revenue.approvePriceRevision(book.id,2,'owner-pricing-authority-2');
 const current=await revenue.createQuote({priceBookId:book.id,contactId:contact.id});assert.equal(Number(current.unit_price_cents),12000);assert.equal(current.price_revision,2);
 // Acceptance without authorization is non-binding and cannot become an invoice.
 const indicative=await revenue.acceptQuote(discounted.id,{evidence:'Customer replied yes',version:Number(sent.version)});assert.equal(indicative.binding,false);
 await assert.rejects(revenue.invoiceFromQuote(discounted.id),/BINDING_ACCEPTANCE_REQUIRED/);
 const sentCurrent=await revenue.sendQuote(current.id,{channel:'portal_link',evidence:'Portal link shared by owner',version:Number(current.version)});
 const bound=await revenue.acceptQuote(current.id,{evidence:'Signed order form',bindingAuthorizationRef:'owner-contract-authority-7',version:Number(sentCurrent.version)});assert.equal(bound.binding,true);
 const invoice=await revenue.invoiceFromQuote(current.id);assert.equal(invoice.state,'draft');assert.equal(Number(invoice.amount_cents),12000);
 assert.equal((await revenue.invoiceFromQuote(current.id)).id,invoice.id);
 // Pricing evidence is immutable.
 await assert.rejects(db.query('UPDATE app.price_book_revisions SET unit_price_cents=1'),/append-only/);
 await assert.rejects(db.query('UPDATE app.quotes SET total_cents=1,subtotal_cents=1,discount_cents=0 WHERE id=$1',[current.id]),/immutable/);
 // Suppressed contacts cannot be quoted.
 await sales.suppressContact(contact.id);await assert.rejects(revenue.createQuote({priceBookId:book.id,contactId:contact.id}),/CONTACT_SUPPRESSED/);
 assert.equal(await count(db,'messages'),0);
}finally{await db.close();}});

test('DOTS-136 payment connector stays opt-in: sandbox works, live needs owner authorization, a restricted key and a webhook secret',async()=>{const {db,client}=await setup();try{
 const sales=new SalesWorkspace(client,ctx);const invoice=await sales.createInvoice(project,'Synthetic invoice','Synthetic service',1000);await sales.issueInvoice(invoice.id,1);
 let calls=0;const transport=async(url,request)=>{calls++;assert.equal(url,'https://api.stripe.com/v1/checkout/sessions');assert.match(String(request.body),/payment_mode%5D=sandbox|payment_mode]=sandbox|payment_mode%5D=live/);return Response.json({url:'https://checkout.stripe.com/c/pay/synthetic',livemode:request.headers.authorization.includes('_live_')});};
 const sandbox={PAYMENTS_ENABLED:'true',STRIPE_SECRET_KEY:'rk_test_synthetic',OWNER_MERCHANT_AUTHORIZATION_ID:'synthetic-merchant',APP_ORIGIN:'https://example.invalid',MAX_PAYMENT_CENTS:'5000'};
 await assert.rejects(new PaymentGateway(client,ctx,{},transport).checkout(invoice.id),/MERCHANT_SETUP_REQUIRED/);
 await assert.rejects(new PaymentGateway(client,ctx,{...sandbox,STRIPE_SECRET_KEY:'pk_test_wrong'},transport).checkout(invoice.id),/MERCHANT_SETUP_REQUIRED/);
 await assert.rejects(new PaymentGateway(client,ctx,{...sandbox,STRIPE_SECRET_KEY:'rk_live_synthetic'},transport).checkout(invoice.id),/LIVE_PAYMENTS_NOT_AUTHORIZED/);
 await assert.rejects(new PaymentGateway(client,ctx,{...sandbox,STRIPE_SECRET_KEY:'rk_live_synthetic',PRODUCTION_PAYMENTS_AUTHORIZATION_ID:'x'},transport).checkout(invoice.id),/LIVE_PAYMENTS_NOT_AUTHORIZED/);
 await assert.rejects(new PaymentGateway(client,ctx,{...sandbox,...live,STRIPE_SECRET_KEY:'sk_live_synthetic'},transport).checkout(invoice.id),/LIVE_PAYMENTS_REQUIRE_RESTRICTED_KEY/);
 await assert.rejects(new PaymentGateway(client,ctx,{...sandbox,...live,STRIPE_SECRET_KEY:'rk_live_synthetic'},transport).checkout(invoice.id),/WEBHOOK_SECRET_REQUIRED/);
 assert.equal(calls,0);
 assert.deepEqual(await new PaymentGateway(client,ctx,sandbox,transport).checkout(invoice.id),{url:'https://checkout.stripe.com/c/pay/synthetic',mode:'sandbox'});
 assert.equal((await new PaymentGateway(client,ctx,{...sandbox,...live,STRIPE_SECRET_KEY:'rk_live_synthetic',STRIPE_WEBHOOK_SECRET:'whsec_synthetic'},transport).checkout(invoice.id)).mode,'live');
 await assert.rejects(new PaymentGateway(client,ctx,sandbox,async()=>Response.json({url:'https://checkout.stripe.com/x',livemode:true})).checkout(invoice.id),/PAYMENT_MODE_MISMATCH/);
 assert.equal(paymentMode({STRIPE_SECRET_KEY:'sk_test_abc'}),'sandbox');assert.equal(paymentMode({}),'invalid');
 const summary=paymentConfiguration({...sandbox,STRIPE_WEBHOOK_SECRET:'whsec_x'});assert.equal(summary.mode,'sandbox');assert.ok(!JSON.stringify(summary).includes('rk_test_synthetic'));
 // Live events are rejected unless the live switch and production authorization are both present.
 await assert.rejects(new PaymentGateway(client,ctx,{PRODUCTION_PAYMENTS_AUTHORIZATION_ID:'x'}).ingestStripe('evt_live',{id:'evt_live',livemode:true,type:'payment_intent.succeeded',data:{object:{id:'pi_live'}}}),/LIVE_PAYMENTS_NOT_AUTHORIZED/);
}finally{await db.close();}});

test('DOTS-137 payments, fees, refunds, disputes and subscription receipts reconcile into an immutable ledger; sandbox stays separate',async()=>{const {db,client}=await setup();try{
 const sales=new SalesWorkspace(client,ctx),payments=new PaymentGateway(client,ctx,live),revenue=new RevenueOperations(client,ctx);
 const issue=async(amount,label)=>{const invoice=await sales.createInvoice(project,label,'Synthetic service',amount);await sales.issueInvoice(invoice.id,1);return invoice;};
 const a=await issue(10000,'Synthetic A'),b=await issue(5000,'Synthetic B'),c=await issue(2000,'Synthetic sandbox');
 const paid=(id,invoice,amount,pi,extra={})=>({id,livemode:true,type:'payment_intent.succeeded',data:{object:{id:pi,currency:'usd',amount_received:amount,metadata:{organization_id:org,invoice_id:invoice},...extra}}});
 await payments.ingestStripe('evt_a',paid('evt_a',a.id,10000,'pi_a',{latest_charge:{balance_transaction:{fee:320}}}));
 assert.equal((await payments.ingestStripe('evt_a',paid('evt_a',a.id,10000,'pi_a',{latest_charge:{balance_transaction:{fee:320}}}))).duplicate,true);
 await assert.rejects(payments.ingestStripe('evt_a',paid('evt_a',a.id,9999,'pi_a')),/RECEIPT_CONFLICT/);
 await assert.rejects(payments.ingestStripe('evt_wrong_tenant',{...paid('evt_wrong_tenant',b.id,5000,'pi_x'),data:{object:{id:'pi_x',currency:'usd',amount_received:5000,metadata:{organization_id:other,invoice_id:b.id}}}}),/PAYMENT_TENANT_MISMATCH/);
 await payments.ingestStripe('evt_b',paid('evt_b',b.id,5000,'pi_b'));
 await payments.ingestStripe('evt_refund_a',{id:'evt_refund_a',livemode:true,type:'charge.refunded',data:{object:{id:'ch_a',payment_intent:'pi_a',amount_refunded:2500}}});
 await payments.ingestStripe('evt_dispute_b',{id:'evt_dispute_b',livemode:true,type:'charge.dispute.created',data:{object:{id:'dp_b',payment_intent:'pi_b',amount:5000,currency:'usd',balance_transactions:[{fee:1500}]}}});
 assert.equal((await db.query('SELECT state FROM app.invoices WHERE id=$1',[b.id])).rows[0].state,'disputed');
 await payments.ingestStripe('evt_dispute_b_closed',{id:'evt_dispute_b_closed',livemode:true,type:'charge.dispute.closed',data:{object:{id:'dp_b',payment_intent:'pi_b',amount:5000,currency:'usd',status:'won'}}});
 assert.equal((await db.query('SELECT state FROM app.invoices WHERE id=$1',[b.id])).rows[0].state,'paid');
 await payments.ingestStripe('evt_dispute_a',{id:'evt_dispute_a',livemode:true,type:'charge.dispute.created',data:{object:{id:'dp_a',payment_intent:'pi_a',amount:7500,currency:'usd'}}});
 await payments.ingestStripe('evt_dispute_a_closed',{id:'evt_dispute_a_closed',livemode:true,type:'charge.dispute.closed',data:{object:{id:'dp_a',payment_intent:'pi_a',amount:7500,currency:'usd',status:'lost'}}});
 await assert.rejects(payments.ingestStripe('evt_dispute_big',{id:'evt_dispute_big',livemode:true,type:'charge.dispute.created',data:{object:{id:'dp_big',payment_intent:'pi_a',amount:999999,currency:'usd'}}}),/DISPUTE_AMOUNT_MISMATCH/);
 // Subscription receipts, renewal, refund and cancellation.
 const subscription=await revenue.createSubscription({projectId:project,label:'Synthetic monthly',amountCents:3000,billingInterval:'month',trialDays:14,providerSubscriptionId:'sub_synthetic',testMode:false});
 const invoicePaid=(id,stripeInvoice,reason,pi)=>({id,livemode:true,type:'invoice.paid',data:{object:{id:stripeInvoice,subscription:'sub_synthetic',amount_paid:3000,currency:'usd',billing_reason:reason,payment_intent:pi,lines:{data:[{period:{end:1893456000}}]},subscription_details:{metadata:{organization_id:org}}}}});
 await payments.ingestStripe('evt_sub_1',invoicePaid('evt_sub_1','in_1','subscription_create','pi_sub_1'));
 assert.equal((await db.query('SELECT state FROM app.revenue_subscriptions WHERE id=$1',[subscription.id])).rows[0].state,'active');
 await payments.ingestStripe('evt_sub_2',invoicePaid('evt_sub_2','in_2','subscription_cycle','pi_sub_2'));
 assert.equal((await payments.ingestStripe('evt_sub_2_retry',invoicePaid('evt_sub_2_retry','in_2','subscription_cycle','pi_sub_2'))).duplicate,true);
 await payments.ingestStripe('evt_sub_refund',{id:'evt_sub_refund',livemode:true,type:'charge.refunded',data:{object:{id:'ch_sub_2',payment_intent:'pi_sub_2',amount_refunded:1000}}});
 await assert.rejects(payments.ingestStripe('evt_sub_overrefund',{id:'evt_sub_overrefund',livemode:true,type:'charge.refunded',data:{object:{id:'ch_sub_2',payment_intent:'pi_sub_2',amount_refunded:4000}}}),/REFUND_AMOUNT_MISMATCH/);
 await assert.rejects(payments.ingestStripe('evt_sub_sandbox',{...invoicePaid('evt_sub_sandbox','in_3','subscription_cycle','pi_3'),livemode:false}),/PAYMENT_MODE_MISMATCH/);
 await payments.ingestStripe('evt_sub_deleted',{id:'evt_sub_deleted',livemode:true,type:'customer.subscription.deleted',data:{object:{id:'sub_synthetic',status:'canceled',cancellation_details:{reason:'cancellation_requested'}}}});
 assert.equal((await db.query('SELECT state FROM app.revenue_subscriptions WHERE id=$1',[subscription.id])).rows[0].state,'cancelled');
 const kinds=(await db.query("SELECT kind FROM app.retention_events WHERE subscription_id=$1 ORDER BY occurred_at,kind",[subscription.id])).rows.map(r=>r.kind);
 for(const kind of ['trial_started','payment_received','trial_converted','renewed','cancelled'])assert.ok(kinds.includes(kind),kind);
 // Sandbox events never count as realized revenue.
 await new PaymentGateway(client,ctx,{}).ingestStripe('evt_c',{...paid('evt_c',c.id,2000,'pi_c'),livemode:false});
 const totals=await revenue.realizedRevenue();
 assert.deepEqual(totals.verified,{receiptsCents:21000,refundsCents:3500,disputesHeldCents:12500,disputesReversedCents:5000,processorFeesCents:1820,netRealizedCents:21000-3500-12500+5000-1820,expensesCents:0});
 assert.equal(totals.sandbox.receiptsCents,2000);assert.equal(totals.sandbox.netRealizedCents,2000);
 await assert.rejects(db.query("UPDATE app.money_entries SET amount_cents=1 WHERE kind='sale_receipt'"),/append-only/);
 await assert.rejects(db.query("DELETE FROM app.retention_events"),/append-only/);
 // Rollback refuses to discard ledger evidence.
 await assert.rejects(db.exec(await readFile(new URL('../database/migrations/0022_revenue_operations.down.sql',import.meta.url),'utf8')),/discard revenue ledger evidence/);
}finally{await db.close();}});

test('DOTS-138 renewals, onboarding, escalations, trials and churn respect support ownership and suppression; metrics use recorded evidence',async()=>{const {db,client}=await setup();try{
 const revenue=new RevenueOperations(client,ctx),sales=new SalesWorkspace(client,ctx);const outsider=await secondAgent(db,client,false);
 const contact=await sales.addContact({name:'Synthetic subscriber',email:'subscriber@example.invalid',source:'Synthetic fixture'});
 await assert.rejects(revenue.createSubscription({projectId:project,label:'Unassigned owner',amountCents:1000,billingInterval:'month',supportOwnerAgentId:outsider}),/SUPPORT_OWNER_NOT_ASSIGNED/);
 const trial=await revenue.createSubscription({projectId:project,label:'Synthetic trial',amountCents:1000,billingInterval:'month',trialDays:7,contactId:contact.id,supportOwnerAgentId:agent});
 assert.equal(trial.state,'trialing');
 const tasks=(await db.query('SELECT id FROM app.onboarding_tasks WHERE subscription_id=$1 ORDER BY position',[trial.id])).rows;assert.equal(tasks.length,4);
 await assert.rejects(revenue.completeOnboardingTask(tasks[0].id,{evidence:'Kickoff notes',actingAgentId:outsider}),/SUPPORT_OWNERSHIP_REQUIRED/);
 for(const task of tasks)await revenue.completeOnboardingTask(task.id,{evidence:'Owner verified step',actingAgentId:agent});
 assert.equal((await revenue.completeOnboardingTask(tasks[0].id,{evidence:'again'})).duplicate,true);
 const escalation=await revenue.openEscalation(trial.id,{severity:'high',summary:'Synthetic setup issue'});assert.equal(escalation.owner_agent_id,agent);
 await assert.rejects(revenue.resolveEscalation(escalation.id,{resolution:'Fixed',actingAgentId:outsider}),/SUPPORT_OWNERSHIP_REQUIRED/);
 assert.equal((await revenue.resolveEscalation(escalation.id,{resolution:'Fixed configuration',actingAgentId:agent})).state,'resolved');
 await assert.rejects(revenue.completeTrial(trial.id,{converted:true,evidence:'Customer said they would pay'}),/TRIAL_CONVERSION_REQUIRES_PAYMENT_EVIDENCE/);
 // Renewal queue flags suppressed contacts and never sends anything.
 const renewal=await revenue.renewals(30);assert.equal(renewal[0].outreach,'owner_review_required');
 await sales.suppressContact(contact.id);assert.equal((await revenue.renewals(30))[0].outreach,'blocked_contact_suppressed');
 await revenue.completeTrial(trial.id,{converted:false,evidence:'Trial ended without payment'});
 const active=await revenue.createSubscription({projectId:project,label:'Synthetic active',amountCents:2000,billingInterval:'year'});
 await revenue.recordRetentionOutcome(active.id,{outcome:'retained',reasonCode:'RENEWAL_CONFIRMED',evidence:'Owner call notes reference'});
 const metrics=await revenue.retentionMetrics();
 assert.equal(metrics.subscriptions,2);assert.equal(metrics.churnEvents,1);assert.equal(metrics.churnRate,0.5);assert.deepEqual(metrics.trialConversions,{converted:0,completed:1,rate:0});assert.equal(metrics.verifiedRecurringRevenueCents,0);
 const kinds=(await db.query('SELECT kind FROM app.retention_events WHERE subscription_id=$1',[trial.id])).rows.map(r=>r.kind).sort();
 assert.deepEqual(kinds,['churned','escalation_opened','escalation_resolved','onboarding_completed','trial_completed','trial_started']);
 assert.equal(await count(db,'messages'),0);assert.equal(await count(db,'task_queue'),0);
}finally{await db.close();}});

test('DOTS-139 calendar adapter requires per-agent delegation, cannot read unrelated calendars and produces RFC 5545 ICS',async()=>{const {db,client}=await setup();try{
 let now=new Date('2030-01-06T12:00:00Z');const revenue=new RevenueOperations(client,ctx,{clock:()=>now});const second=await secondAgent(db,client,true);
 const sales=new SalesWorkspace(client,ctx);const contact=await sales.addContact({name:'Synthetic attendee',email:'attendee@example.invalid',source:'Synthetic fixture'});
 const ics=buildIcs({uid:'u1@dots.invalid',sequence:0,method:'REQUEST',startsAt:new Date('2030-01-07T15:00:00Z'),endsAt:new Date('2030-01-07T15:30:00Z'),subject:'Demo; pricing, follow-up\nline two '+'x'.repeat(120),stamp:now});
 assert.match(ics,/^BEGIN:VCALENDAR\r\n/);assert.match(ics,/DTSTART:20300107T150000Z\r\n/);assert.match(ics,/SUMMARY:Demo\\; pricing\\, follow-up\\nline two/);
 assert.ok(ics.split('\r\n').every(line=>Buffer.byteLength(line)<=75),'lines folded to 75 octets');
 const calendar=await revenue.addCalendarConnection({label:'Owner sales calendar',provider:'local_ics',calendarRef:'owner-sales'});
 const unrelated=await revenue.addCalendarConnection({label:'Owner personal calendar',provider:'local_ics',calendarRef:'owner-personal'});
 const slot={connectionId:calendar.id,subject:'Synthetic discovery call',startsAt:'2030-01-07T15:00:00Z',endsAt:'2030-01-07T15:30:00Z',contactId:contact.id};
 await assert.rejects(revenue.scheduleMeeting(agent,slot),/CALENDAR_NOT_DELEGATED/);
 const readOnly=await revenue.delegateCalendar({connectionId:calendar.id,agentId:agent,scopes:['availability'],authorizationRef:'owner-calendar-delegation-1',expiresAt:'2030-02-01T00:00:00Z'});
 await assert.rejects(revenue.scheduleMeeting(agent,slot),/CALENDAR_NOT_DELEGATED/);
 await assert.rejects(revenue.delegateCalendar({connectionId:calendar.id,agentId:agent,scopes:['create'],authorizationRef:'x',expiresAt:'2031-01-01T00:00:00Z'}),/DELEGATION_EXPIRY_OUT_OF_RANGE/);
 await revenue.delegateCalendar({connectionId:calendar.id,agentId:agent,scopes:['create','update','cancel'],authorizationRef:'owner-calendar-delegation-2',expiresAt:'2030-02-01T00:00:00Z'});
 const created=await revenue.scheduleMeeting(agent,slot);assert.match(created.ics,/METHOD:REQUEST/);assert.match(created.ics,/ATTENDEE;ROLE=REQ-PARTICIPANT;RSVP=TRUE:mailto:attendee@example.invalid/);
 await assert.rejects(revenue.scheduleMeeting(agent,{...slot,startsAt:'2030-01-07T15:15:00Z',endsAt:'2030-01-07T15:45:00Z'}),/SLOT_UNAVAILABLE/);
 const busy=await revenue.availability(agent,calendar.id,'2030-01-07T00:00:00Z','2030-01-08T00:00:00Z');assert.deepEqual(busy.busy,[{startsAt:'2030-01-07T15:00:00.000Z',endsAt:'2030-01-07T15:30:00.000Z'}]);assert.ok(!JSON.stringify(busy).includes('discovery'));
 await assert.rejects(revenue.availability(agent,unrelated.id,'2030-01-07T00:00:00Z','2030-01-08T00:00:00Z'),/CALENDAR_NOT_DELEGATED/);
 await assert.rejects(revenue.availability(second,calendar.id,'2030-01-07T00:00:00Z','2030-01-08T00:00:00Z'),/CALENDAR_NOT_DELEGATED/);
 await revenue.delegateCalendar({connectionId:calendar.id,agentId:second,scopes:['update','cancel'],authorizationRef:'owner-calendar-delegation-3',expiresAt:'2030-02-01T00:00:00Z'});
 await assert.rejects(revenue.cancelMeeting(second,created.meeting.id),/MEETING_NOT_OWNED/);
 const moved=await revenue.rescheduleMeeting(agent,created.meeting.id,{startsAt:'2030-01-07T16:00:00Z',endsAt:'2030-01-07T16:30:00Z',version:Number(created.meeting.version)});assert.match(moved.ics,/SEQUENCE:1/);
 const cancelled=await revenue.cancelMeeting(agent,created.meeting.id);assert.match(cancelled.ics,/METHOD:CANCEL/);assert.match(cancelled.ics,/STATUS:CANCELLED/);assert.equal(cancelled.meeting.state,'cancelled');
 await revenue.revokeCalendarDelegation(readOnly.id);await assert.rejects(revenue.availability(agent,calendar.id,'2030-01-07T00:00:00Z','2030-01-08T00:00:00Z'),/CALENDAR_NOT_DELEGATED/);
 now=new Date('2030-03-01T00:00:00Z');await assert.rejects(revenue.scheduleMeeting(agent,{...slot,startsAt:'2030-03-02T15:00:00Z',endsAt:'2030-03-02T15:30:00Z'}),/CALENDAR_NOT_DELEGATED/);
 // External providers fail closed: no configuration means no provider call.
 await assert.rejects(revenue.addCalendarConnection({label:'Google',provider:'google',calendarRef:'primary'}),/CREDENTIAL_REFERENCE_REQUIRED/);
 await assert.rejects(calendarAdapterFor('google','GOOGLE_CALENDAR_TOKEN',{}).publish('primary',{}),/CALENDAR_PROVIDER_NOT_CONFIGURED/);
 await assert.rejects(calendarAdapterFor('microsoft','MS_CALENDAR_TOKEN',{CALENDAR_PROVIDERS_ENABLED:'true',MS_CALENDAR_TOKEN:'synthetic'}).freeBusy('primary'),/CALENDAR_PROVIDER_ADAPTER_UNAVAILABLE/);
 await sales.suppressContact(contact.id);now=new Date('2030-01-06T12:00:00Z');await assert.rejects(revenue.scheduleMeeting(agent,{...slot,startsAt:'2030-01-08T15:00:00Z',endsAt:'2030-01-08T15:30:00Z'}),/CONTACT_SUPPRESSED/);
}finally{await db.close();}});

test('DOTS-140 CRM export/import keeps stable external IDs, honours field ownership and never leaks across tenants',async()=>{const {db,client}=await setup();try{
 await secondTenant(db,client);const revenue=new RevenueOperations(client,ctx),otherRevenue=new RevenueOperations(client,otherCtx),sales=new SalesWorkspace(client,ctx);
 const account=await sales.addAccount('=HYPERLINK("https://example.invalid")');const contact=await sales.addContact({name:'Synthetic CRM contact',email:'crm@example.invalid',source:'Synthetic fixture',accountId:account.id});await sales.addDeal(project,'Synthetic deal',4500,contact.id);
 const csv=await revenue.exportCrm({format:'csv'});assert.equal(csv.recordCount,3);assert.ok(csv.content.includes(stableExternalId('contact',contact.id)));assert.ok(csv.content.includes(`"'=HYPERLINK(""https://example.invalid"")"`));
 assert.equal((await revenue.exportCrm({format:'csv'})).contentHash,csv.contentHash,'stable export');
 assert.equal(toCsv([{a:'+1',b:'x,y'}],['a','b']),"a,b\r\n'+1,\"x,y\"\r\n");
 // Import twice: no duplicates; email match links the existing contact.
 const records=[{kind:'contact',externalId:'hs-1',fields:{email:'CRM@example.invalid',display_name:'Renamed externally',role_title:'Buyer',consent:'opted_in'}},{kind:'contact',externalId:'hs-2',fields:{email:'new-crm@example.invalid',display_name:'New CRM person'}},{kind:'account',externalId:'hs-acc-1',fields:{name:'External account',website:'https://example.invalid'}},{kind:'deal',externalId:'hs-deal-1',fields:{label:'External deal',stage:'qualified',value_cents:900}}];
 const first=await revenue.importCrm({system:'hubspot',records,projectId:project});assert.deepEqual([first.created,first.updated],[3,0]);assert.ok(first.conflicts>=2);
 const second=await revenue.importCrm({system:'hubspot',records,projectId:project});assert.equal(second.created,0);
 assert.equal((await db.query("SELECT count(*)::int AS n FROM app.crm_contacts WHERE organization_id=$1",[org])).rows[0].n,2);
 const linked=(await db.query("SELECT display_name,role_title,consent FROM app.crm_contacts WHERE id=$1",[contact.id])).rows[0];
 assert.deepEqual(linked,{display_name:'Synthetic CRM contact',role_title:null,consent:'unknown'},'DOTS-owned fields kept and consent never imported');
 assert.ok((await db.query("SELECT resolution FROM app.crm_sync_conflicts WHERE field='consent'")).rows.some(r=>r.resolution==='refused_protected_field'));
 await assert.rejects(revenue.setCrmFieldOwnership({system:'hubspot',kind:'contact',field:'consent',owner:'external'}),/PROTECTED_FIELD_OWNED_BY_DOTS/);
 await revenue.setCrmFieldOwnership({system:'hubspot',kind:'contact',field:'role_title',owner:'external'});
 const third=await revenue.importCrm({system:'hubspot',records});assert.equal(third.updated,1);
 assert.equal((await db.query("SELECT role_title FROM app.crm_contacts WHERE id=$1",[contact.id])).rows[0].role_title,'Buyer');
 const newContact=(await db.query("SELECT consent,status,lawful_source FROM app.crm_contacts WHERE email='new-crm@example.invalid'")).rows[0];assert.deepEqual(newContact,{consent:'unknown',status:'active',lawful_source:'CRM import (hubspot)'});
 // Same external id mapped to a different entity is a conflict, not a duplicate link.
 const remap=await revenue.importCrm({system:'hubspot',records:[{kind:'contact',externalId:'hs-other',fields:{email:'crm@example.invalid'}}]});assert.equal(remap.skipped,1);
 // Second tenant: same external ids create separate records and exports never include the first tenant.
 const isolated=await otherRevenue.importCrm({system:'hubspot',records:[{kind:'contact',externalId:'hs-1',fields:{email:'crm@example.invalid',display_name:'Other tenant person'}}]});assert.equal(isolated.created,1);
 const otherExport=await otherRevenue.exportCrm({format:'json'});const parsed=JSON.parse(otherExport.content);assert.equal(parsed.records.length,1);assert.ok(!otherExport.content.includes(contact.id));assert.ok(!otherExport.content.includes('Synthetic deal'));
 const mine=JSON.parse((await revenue.exportCrm({format:'json',system:'hubspot'})).content);assert.ok(!JSON.stringify(mine).includes('Other tenant person'));assert.equal(mine.records.find(r=>r.external_id===stableExternalId('contact',contact.id)).linked_external_id,'hs-1');
 await assert.rejects(revenue.importCrm({system:'dots',records:[]}),/INVALID_SYSTEM/);await assert.rejects(revenue.importCrm({system:'hubspot',records:new Array(501).fill({})}),/IMPORT_LIMIT_500/);
}finally{await db.close();}});

test('DOTS-141 public lead form filters spam and replay, rate limits per IP, records consent and provenance with retention and never triggers outreach',async()=>{const {db,client}=await setup();try{
 let now=new Date('2030-05-01T12:00:00Z');const revenue=new RevenueOperations(client,ctx,{environment:leadEnv,clock:()=>now});const sales=new SalesWorkspace(client,ctx);
 await assert.rejects(new RevenueOperations(client,ctx,{environment:{}}).leadFormChallenge('lf_x'),/LEAD_FORM_NOT_CONFIGURED/);
 await assert.rejects(revenue.createLeadForm({projectId:project,label:'Website',consentText:'too short',consentVersion:'v1'}),/CONSENT_TEXT_TOO_SHORT/);
 const {form,formKey}=await revenue.createLeadForm({projectId:project,label:'Website',consentText,consentVersion:'2030-05',retentionDays:30,dailyLimitPerIp:6,allowedOrigin:'https://www.example.invalid'});
 assert.ok(!('form_key_hash' in form));assert.match(formKey,/^lf_/);
 await assert.rejects(revenue.leadFormChallenge('lf_'+'A'.repeat(32)),/FORM_UNAVAILABLE/);
 const challenge=await revenue.leadFormChallenge(formKey);assert.equal(challenge.consentVersion,'2030-05');
 const base={formKey,name:'Synthetic Lead',email:'lead@example.invalid',message:'Interested in a demo',consent:true,consentVersion:'2030-05',ip:'203.0.113.10',origin:'https://www.example.invalid',pageUrl:'https://www.example.invalid/pricing?utm=secret',userAgent:'Synthetic agent'};
 const before={messages:await count(db,'messages'),tasks:await count(db,'task_queue'),outbox:await count(db,'event_outbox'),audience:await count(db,'campaign_audience')};
 await assert.rejects(revenue.submitLead({...base,nonce:challenge.nonce}),/INVALID_SUBMISSION/,'too fast to be human');
 now=new Date(now.getTime()+5000);
 await assert.rejects(revenue.submitLead({...base,nonce:challenge.nonce,origin:'https://evil.invalid'}),/ORIGIN_NOT_ALLOWED/);
 await assert.rejects(revenue.submitLead({...base,nonce:challenge.nonce,consent:false}),/CONSENT_REQUIRED/);
 await assert.rejects(revenue.submitLead({...base,nonce:challenge.nonce,consentVersion:'old'}),/CONSENT_VERSION_MISMATCH/);
 assert.deepEqual(await revenue.submitLead({...base,nonce:challenge.nonce}),{accepted:true});
 await assert.rejects(revenue.submitLead({...base,nonce:challenge.nonce}),/SUBMISSION_REPLAYED/);
 await assert.rejects(revenue.submitLead({...base,nonce:challenge.nonce.replace(/.$/,c=>c==='A'?'B':'A')}),/INVALID_SUBMISSION/);
 const contact=(await db.query("SELECT * FROM app.crm_contacts WHERE email='lead@example.invalid'")).rows[0];
 assert.equal(contact.consent,'unknown');assert.match(contact.consent_evidence,/lead_submission:.*2030-05.*confirm before any outreach/);
 const submission=(await db.query('SELECT * FROM app.lead_submissions WHERE contact_id=$1',[contact.id])).rows[0];
 assert.equal(submission.outcome,'accepted');assert.equal(submission.consent_version,'2030-05');assert.equal(submission.provenance.pageUrl,'https://www.example.invalid/pricing');assert.equal(submission.provenance.channel,'website_lead_form');
 assert.ok(!JSON.stringify(submission).includes('203.0.113.10'),'IP stored only as keyed hash');assert.equal(new Date(submission.retention_until).toISOString(),'2030-05-31T12:00:05.000Z');
 await assert.rejects(db.query("UPDATE app.lead_submissions SET consent_version='forged'"),/immutable/);
 // Honeypot: indistinguishable response, nothing stored. Existing contact: same response, no consent change.
 const fill=async()=>{now=new Date(now.getTime()-10000);const value=(await revenue.leadFormChallenge(formKey)).nonce;now=new Date(now.getTime()+10000);return value;};
 assert.deepEqual(await revenue.submitLead({...base,email:'bot@example.invalid',honeypot:'https://spam.invalid',nonce:await fill()}),{accepted:true});
 assert.equal((await db.query("SELECT count(*)::int AS n FROM app.crm_contacts WHERE email='bot@example.invalid'")).rows[0].n,0);
 assert.deepEqual(await revenue.submitLead({...base,nonce:await fill()}),{accepted:true});
 await assert.rejects(revenue.submitLead({...base,nonce:await fill()}),/RATE_LIMITED/);
 assert.deepEqual(await revenue.submitLead({...base,ip:'203.0.113.11',nonce:await fill()}),{accepted:true});
 // Suppressed recipients stay suppressed and their message is not retained.
 const suppressed=await sales.addContact({name:'Opted out',email:'optout@example.invalid',source:'Synthetic fixture'});await sales.suppressContact(suppressed.id);
 assert.deepEqual(await revenue.submitLead({...base,email:'optout@example.invalid',ip:'203.0.113.12',nonce:await fill()}),{accepted:true});
 const blocked=(await db.query("SELECT outcome,contact_id,message FROM app.lead_submissions WHERE outcome='suppressed'")).rows[0];assert.deepEqual(blocked,{outcome:'suppressed',contact_id:null,message:null});
 assert.equal((await db.query('SELECT status FROM app.crm_contacts WHERE id=$1',[suppressed.id])).rows[0].status,'suppressed');
 // No outreach was triggered by any submission.
 assert.deepEqual({messages:await count(db,'messages'),tasks:await count(db,'task_queue'),outbox:await count(db,'event_outbox'),audience:await count(db,'campaign_audience')},before);
 // Retention purge clears free-text messages but keeps consent evidence.
 now=new Date('2030-07-01T00:00:00Z');assert.ok((await revenue.purgeExpiredLeads()).purged>=1);
 const purged=(await db.query('SELECT message,purged_at,consent_text_hash FROM app.lead_submissions WHERE contact_id=$1 ORDER BY created_at LIMIT 1',[contact.id])).rows[0];assert.equal(purged.message,null);assert.ok(purged.purged_at);assert.match(purged.consent_text_hash,/^[0-9a-f]{64}$/);
 await revenue.disableLeadForm(form.id);await assert.rejects(revenue.leadFormChallenge(formKey),/FORM_UNAVAILABLE/);
 const nonce=issueLeadNonce('a'.repeat(64),leadEnv.LEAD_FORM_SIGNING_KEY,new Date(0));assert.equal(verifyLeadNonce(nonce,'a'.repeat(64),leadEnv.LEAD_FORM_SIGNING_KEY,new Date(3*3600*1000)),null,'expired nonce');assert.equal(verifyLeadNonce(nonce,'b'.repeat(64),leadEnv.LEAD_FORM_SIGNING_KEY,new Date(5000)),null,'other form');
}finally{await db.close();}});

test('DOTS-142 portal links are signed, expiring, revocable and expose only the linked account without transcripts',async()=>{const {db,client}=await setup();try{
 let now=new Date();const revenue=new RevenueOperations(client,ctx,{clock:()=>now}),sales=new SalesWorkspace(client,ctx);
 const accountA=await sales.addAccount('Synthetic Account A'),accountB=await sales.addAccount('Synthetic Account B');
 const contactA=await sales.addContact({name:'Portal A',email:'portal-a@example.invalid',source:'Synthetic fixture',accountId:accountA.id});const contactB=await sales.addContact({name:'Portal B',email:'portal-b@example.invalid',source:'Synthetic fixture',accountId:accountB.id});
 const invoiceA=await sales.createInvoice(project,'Invoice for A','Service A',1500,contactA.id);await sales.issueInvoice(invoiceA.id,1);const invoiceB=await sales.createInvoice(project,'Invoice for B','Service B',2500,contactB.id);await sales.issueInvoice(invoiceB.id,1);
 await new PaymentGateway(client,ctx,{}).ingestStripe('evt_portal',{id:'evt_portal',livemode:false,type:'payment_intent.succeeded',data:{object:{id:'pi_portal',currency:'usd',amount_received:1500,metadata:{organization_id:org,invoice_id:invoiceA.id}}}});
 const conversation=await sales.createConversation(contactA.id,'Internal thread');await sales.draftMessage(conversation.id,'Internal subject','INTERNAL-TRANSCRIPT-DO-NOT-SHOW');await sales.addNote(contactA.id,'INTERNAL-NOTE-DO-NOT-SHOW');
 const book=await pricedBook(revenue);const quote=await revenue.createQuote({priceBookId:book.id,accountId:accountA.id});const sent=await revenue.sendQuote(quote.id,{channel:'portal_link',evidence:'Owner shared portal',version:Number(quote.version)});await revenue.acceptQuote(quote.id,{evidence:'Signed',bindingAuthorizationRef:'OWNER-SECRET-AUTH-REF',version:Number(sent.version)});
 const link=await revenue.createPortalLink(accountA.id,7);assert.match(link.token,/^pl_[0-9a-f]{32}\./);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM app.portal_links WHERE token_hash=$1',[link.token])).rows[0].n,0,'token stored only as hash');
 const view=await revenue.portalView(link.token);const serialized=JSON.stringify(view);
 assert.equal(view.account.name,'Synthetic Account A');assert.deepEqual(view.invoices.map(i=>i.invoiceNumber),[invoiceA.invoice_number]);assert.equal(view.invoices[0].state,'paid');assert.equal(view.invoices[0].sandbox,true);assert.equal(view.invoices[0].payments[0].verified,false);
 assert.equal(view.contracts.length,1);assert.equal(view.contracts[0].binding,true);assert.match(view.contracts[0].evidenceHash,/^[0-9a-f]{64}$/);
 for(const hidden of [invoiceB.invoice_number,'Synthetic Account B','INTERNAL-TRANSCRIPT-DO-NOT-SHOW','INTERNAL-NOTE-DO-NOT-SHOW','OWNER-SECRET-AUTH-REF','portal-a@example.invalid',org,accountA.id,'evt_portal'])assert.ok(!serialized.includes(hidden),hidden);
 assert.equal((await db.query('SELECT view_count FROM app.portal_links WHERE id=$1',[link.id])).rows[0].view_count,1);
 const tampered=link.token.slice(0,-1)+(link.token.endsWith('A')?'B':'A');await assert.rejects(revenue.portalView(tampered),/PORTAL_LINK_INVALID/);await assert.rejects(revenue.portalView('not-a-token'),/PORTAL_LINK_INVALID/);
 await assert.rejects(revenue.createPortalLink(accountA.id,31),/INVALID_PORTAL_EXPIRY/);
 now=new Date(Date.now()+8*86400000);await assert.rejects(revenue.portalView(link.token),/PORTAL_LINK_INVALID/);now=new Date();
 const other=await revenue.createPortalLink(accountB.id,1);assert.deepEqual((await revenue.portalView(other.token)).invoices.map(i=>i.invoiceNumber),[invoiceB.invoice_number]);
 await revenue.revokePortalLink(other.id);await assert.rejects(revenue.portalView(other.token),/PORTAL_LINK_INVALID/);
}finally{await db.close();}});

test('DOTS-143 cohort profitability matches the verified ledger, allocates model/channel spend and reports attribution uncertainty',async()=>{const {db,client,control}=await setup();try{
 const revenue=new RevenueOperations(client,ctx),sales=new SalesWorkspace(client,ctx),payments=new PaymentGateway(client,ctx,live);
 const account=await sales.addAccount('Cohort account');const buyer=await sales.addContact({name:'Cohort buyer',email:'cohort@example.invalid',source:'Synthetic fixture',accountId:account.id});
 const second=await sales.addContact({name:'Cohort second',email:'cohort2@example.invalid',source:'Synthetic fixture'});
 const pay=async(contact,amount,pi)=>{const invoice=await sales.createInvoice(project,`Cohort ${pi}`,'Synthetic service',amount,contact??undefined);await sales.issueInvoice(invoice.id,1);await payments.ingestStripe(`evt_${pi}`,{id:`evt_${pi}`,livemode:true,type:'payment_intent.succeeded',data:{object:{id:pi,currency:'usd',amount_received:amount,metadata:{organization_id:org,invoice_id:invoice.id},latest_charge:{balance_transaction:{fee:100}}}}});};
 await pay(buyer.id,10000,'pi_c1');await pay(buyer.id,4000,'pi_c2');await pay(second.id,6000,'pi_c3');await pay(null,1000,'pi_c4');
 await payments.ingestStripe('evt_c_refund',{id:'evt_c_refund',livemode:true,type:'charge.refunded',data:{object:{id:'ch_c3',payment_intent:'pi_c3',amount_refunded:1000}}});
 // Provider-settled spend: channel (message reservation), model (other reservation) and organisation-level (unallocated).
 await control.setBudget(10000,'owner-budget-authority',10000,project);await control.setBudget(10000,'owner-budget-authority',10000,null);
 const channel=await control.reserve('message:synthetic',500,project);await control.settle(channel.id,400,'provider-receipt-1',false,'provider');
 const model=await control.reserve('model:synthetic',900,project);await control.settle(model.id,900,'provider-receipt-2',false,'provider');
 const general=await control.reserve('general:synthetic',300,null);await control.settle(general.id,300,'provider-receipt-3',false,'provider');
 await new PaymentGateway(client,ctx,{}).ingestStripe('evt_sandbox_cohort',{id:'evt_sandbox_cohort',livemode:false,type:'payment_intent.succeeded',data:{object:{id:'pi_sb',currency:'usd',amount_received:777,metadata:{organization_id:org,invoice_id:(await (async()=>{const i=await sales.createInvoice(project,'Sandbox cohort','x',777);await sales.issueInvoice(i.id,1);return i;})()).id}}}});
 const report=await revenue.cohortReport();
 assert.equal(report.cohorts.length,1);const cohort=report.cohorts[0];
 assert.equal(cohort.newCustomers,2);assert.equal(cohort.receiptsCents,20000);assert.equal(cohort.refundsCents,1000);assert.equal(cohort.processorFeesCents,300);assert.equal(cohort.netRevenueCents,20000-1000-300);
 assert.equal(cohort.allocatedChannelSpendCents,400);assert.equal(cohort.allocatedModelSpendCents,900);assert.equal(cohort.netMarginCents,18700-1300);assert.equal(cohort.cacCents,650);
 assert.deepEqual(cohort.attribution,{touchedCustomers:0,coverage:0,uncertainty:'high'});
 assert.equal(report.unattributedRevenueCents,1000-100);assert.equal(report.unallocatedSpendCents,300);
 const totals=await revenue.realizedRevenue();assert.equal(report.reconciliation.ledgerNetCents,totals.verified.netRealizedCents-totals.verified.expensesCents);assert.equal(report.reconciliation.matches,true);
 assert.equal(report.sandbox.receiptsCents,777);assert.ok(!report.cohorts.some(c=>c.receiptsCents===777));
 const snapshot=await revenue.snapshot();assert.equal(snapshot.cohorts.reconciliation.matches,true);assert.equal(snapshot.payments.mode,'not_configured');assert.ok(Array.isArray(snapshot.leadForms));
}finally{await db.close();}});

test('DOTS-144 payment acceptance gate is opt-in, refuses live mode without owner authorization and passes synthetic sandbox checks',async()=>{
 assert.equal(evaluateGates('offline',{}).status,'not_opted_in');
 assert.equal(evaluateGates('live',{PAYMENT_ACCEPTANCE_ENABLED:'true'}).status,'refused');
 assert.equal(evaluateGates('sandbox',{PAYMENT_ACCEPTANCE_ENABLED:'true',STRIPE_SECRET_KEY:'rk_live_x',PAYMENTS_ENABLED:'true',OWNER_MERCHANT_AUTHORIZATION_ID:'x',STRIPE_WEBHOOK_SECRET:'x'}).status,'refused','live key refused in sandbox mode');
 const ready={PAYMENT_ACCEPTANCE_ENABLED:'true',PRODUCTION_PAYMENTS_AUTHORIZATION_ID:'synthetic-auth',OWNER_MERCHANT_AUTHORIZATION_ID:'synthetic-merchant',STRIPE_WEBHOOK_SECRET:'whsec_synthetic',PAYMENTS_LIVE_MODE:'true',STRIPE_SECRET_KEY:'rk_live_synthetic',PAYMENT_ACCEPTANCE_MAX_CENTS:'100'};
 assert.equal(evaluateGates('live',ready,{}).status,'refused','confirmation required');assert.equal(evaluateGates('live',{...ready,PAYMENT_ACCEPTANCE_MAX_CENTS:'100000'},{confirm:'synthetic-auth'}).status,'refused','high-risk amount refused');
 assert.equal(evaluateGates('live',ready,{confirm:'synthetic-auth'}).status,'ready');
 const lines=[];assert.equal(await acceptance(['--mode=live'],{PAYMENT_ACCEPTANCE_ENABLED:'true'},line=>lines.push(line)),2);assert.ok(lines.some(line=>line.includes('blocked on external prerequisite')));assert.ok(lines.some(line=>line.includes('Payment acceptance checklist')));
 let calls=0;const live=await acceptance(['--mode=live','--confirm=synthetic-auth'],ready,()=>{calls++;});assert.equal(live,0);assert.ok(calls>0);
 const run=spawnSync(process.execPath,['scripts/payment-acceptance.mjs','--mode=offline'],{env:{PATH:process.env.PATH,PAYMENT_ACCEPTANCE_ENABLED:'true'},encoding:'utf8',cwd:new URL('..',import.meta.url).pathname});
 assert.equal(run.status,0,run.stdout+run.stderr);assert.match(run.stdout,/All 8 offline checks passed/);assert.doesNotMatch(run.stdout,/FAIL/);
 const refused=spawnSync(process.execPath,['scripts/payment-acceptance.mjs'],{env:{PATH:process.env.PATH},encoding:'utf8',cwd:new URL('..',import.meta.url).pathname});assert.equal(refused.status,1);
});

test('migration 0022 runtime grants allow revenue workflows under row security without deletes on evidence',async()=>{const {db,client}=await setup();try{
 await db.exec('CREATE ROLE dots_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;GRANT USAGE ON SCHEMA app TO dots_runtime;GRANT SELECT ON app.memberships,app.projects,app.agent_identities,app.agent_project_assignments,app.audit_events TO dots_runtime;GRANT INSERT ON app.audit_events TO dots_runtime;');
 await db.exec(await readFile(new URL('../database/runtime-grants.sql',import.meta.url),'utf8'));await db.exec(await readFile(new URL('../database/runtime-grants-0022.sql',import.meta.url),'utf8'));
 for(const table of ['money_entries','retention_events','lead_submissions','quotes','price_book_revisions','crm_sync_runs','portal_links','lead_form_nonces'])assert.equal((await db.query("SELECT has_table_privilege('dots_runtime',$1,'DELETE') AS allowed",[`app.${table}`])).rows[0].allowed,false,table);
 for(const [table,column] of [['quotes','id'],['quotes','total_cents'],['quotes','organization_id'],['lead_submissions','consent_version'],['portal_links','token_hash'],['price_books','id']])assert.equal((await db.query("SELECT has_column_privilege('dots_runtime',$1,$2,'UPDATE') AS allowed",[`app.${table}`,column])).rows[0].allowed,false,`${table}.${column}`);
 await db.exec('SET ROLE dots_runtime');
 const revenue=new RevenueOperations(client,ctx,{environment:{...leadEnv,...live}}),sales=new SalesWorkspace(client,ctx);
 const account=await sales.addAccount('Runtime account');const contact=await sales.addContact({name:'Runtime contact',email:'runtime@example.invalid',source:'Synthetic fixture',accountId:account.id});
 const book=await pricedBook(revenue);const quote=await revenue.createQuote({priceBookId:book.id,accountId:account.id,contactId:contact.id});const sent=await revenue.sendQuote(quote.id,{channel:'owner_manual',evidence:'Owner delivered',version:Number(quote.version)});
 await revenue.acceptQuote(quote.id,{evidence:'Signed',bindingAuthorizationRef:'owner-contract',version:Number(sent.version)});const invoice=await revenue.invoiceFromQuote(quote.id);await sales.issueInvoice(invoice.id,Number(invoice.version));
 await new PaymentGateway(client,ctx,live).ingestStripe('evt_runtime',{id:'evt_runtime',livemode:true,type:'payment_intent.succeeded',data:{object:{id:'pi_runtime',currency:'usd',amount_received:10000,metadata:{organization_id:org,invoice_id:invoice.id},latest_charge:{balance_transaction:{fee:50}}}}});
 const subscription=await revenue.createSubscription({projectId:project,label:'Runtime subscription',amountCents:10000,billingInterval:'month',quoteId:quote.id,accountId:account.id,supportOwnerAgentId:agent,providerSubscriptionId:'sub_runtime',testMode:false});
 await new PaymentGateway(client,ctx,live).ingestStripe('evt_runtime_sub',{id:'evt_runtime_sub',livemode:true,type:'invoice.paid',data:{object:{id:'in_runtime',subscription:'sub_runtime',amount_paid:10000,currency:'usd',billing_reason:'subscription_cycle',payment_intent:'pi_runtime_sub'}}});
 const task=(await revenue.snapshot()).onboarding[0];await revenue.completeOnboardingTask(task.id,{evidence:'Runtime evidence',actingAgentId:agent});await revenue.recordRetentionOutcome(subscription.id,{outcome:'retained',reasonCode:'OK',evidence:'Owner notes'});
 const escalation=await revenue.openEscalation(subscription.id,{severity:'low',summary:'Runtime'});await revenue.resolveEscalation(escalation.id,{resolution:'Done'});
 const calendar=await revenue.addCalendarConnection({label:'Runtime calendar',provider:'local_ics',calendarRef:'runtime'});await revenue.delegateCalendar({connectionId:calendar.id,agentId:agent,scopes:['create','cancel'],authorizationRef:'owner-delegation',expiresAt:new Date(Date.now()+86400000).toISOString()});
 const start=new Date(Date.now()+3600000);const meeting=await revenue.scheduleMeeting(agent,{connectionId:calendar.id,subject:'Runtime meeting',startsAt:start.toISOString(),endsAt:new Date(start.getTime()+1800000).toISOString()});await revenue.cancelMeeting(agent,meeting.meeting.id);
 await revenue.setCrmFieldOwnership({system:'pipedrive',kind:'deal',field:'label',owner:'external'});await revenue.importCrm({system:'pipedrive',records:[{kind:'deal',externalId:'pd-1',fields:{label:'Runtime deal',value_cents:10}}],projectId:project});
 await revenue.importCrm({system:'pipedrive',records:[{kind:'deal',externalId:'pd-1',fields:{label:'Runtime deal renamed'}}]});await revenue.exportCrm({format:'csv'});
 let now=new Date(Date.now()-10000);const leads=new RevenueOperations(client,ctx,{environment:leadEnv,clock:()=>now});const {form,formKey}=await leads.createLeadForm({projectId:project,label:'Runtime form',consentText,consentVersion:'v1'});const nonce=(await leads.leadFormChallenge(formKey)).nonce;now=new Date();
 await leads.submitLead({formKey,nonce,name:'Runtime lead',email:'runtime-lead@example.invalid',consent:true,consentVersion:'v1',ip:'198.51.100.1'});await leads.purgeExpiredLeads();await leads.disableLeadForm(form.id);
 const link=await revenue.createPortalLink(account.id,3);assert.equal((await revenue.portalView(link.token)).invoices.length,1);await revenue.revokePortalLink(link.id);
 const report=await revenue.cohortReport();assert.equal(report.reconciliation.matches,true);
 await assert.rejects(tenant(client,ctx,tx=>tx.query("INSERT INTO app.price_books(organization_id,project_id,label) VALUES($1,$2,'Cross tenant')",[other,project])),/row-level security|violates foreign key/);
}finally{await db.close();}});

test('migration 0022 rolls back cleanly when no revenue evidence exists',async()=>{const {db}=await setup();try{
 const directory=new URL('../database/migrations/',import.meta.url);await db.exec(await readFile(new URL('0022_revenue_operations.down.sql',directory),'utf8'));
 assert.equal((await db.query("SELECT to_regclass('app.quotes') AS t")).rows[0].t,null);await assert.rejects(db.query("INSERT INTO app.money_entries(organization_id,idempotency_key,kind,amount_cents,source,evidence_ref) VALUES($1,'k','processor_fee',1,'simulation','x')",[org]),/check constraint/);
 await db.exec(await readFile(new URL('0022_revenue_operations.up.sql',directory),'utf8'));assert.ok((await db.query("SELECT to_regclass('app.quotes') AS t")).rows[0].t);
}finally{await db.close();}});

test('revenue routes: owner API requires session and trusted origin; public lead and portal routes never require or expose owner data',async()=>{
 const ownerRoute=await readFile(new URL('../apps/web/app/api/v1/revenue/route.ts',import.meta.url),'utf8');
 assert.match(ownerRoute,/export const dynamic='force-dynamic'/);assert.match(ownerRoute,/hasTrustedOrigin\(request\)\)return/);assert.equal((ownerRoute.match(/ownerSession\(\)/g)??[]).length,2);assert.match(ownerRoute,/private, no-store/);
 const lead=await readFile(new URL('../apps/web/app/api/public/lead/route.ts',import.meta.url),'utf8');
 assert.doesNotMatch(lead,/ownerSession/);assert.match(lead,/raw\.length>8192/);assert.match(lead,/submitLead/);assert.doesNotMatch(lead,/DeliveryGateway|enqueue/);assert.match(lead,/SUBMISSION_REJECTED/);
 const portal=await readFile(new URL('../apps/web/app/portal/[token]/page.tsx',import.meta.url),'utf8');
 assert.doesNotMatch(portal,/ownerSession|app\.messages|contact_events/);assert.match(portal,/portalView/);assert.match(portal,/index:false/);
 const view=await readFile(new URL('../apps/web/app/views/revenue-view.tsx',import.meta.url),'utf8');assert.match(view,/export function RevenueView\(\)/);assert.match(view,/aria-live="polite"/);assert.match(view,/role="alert"/);
});
