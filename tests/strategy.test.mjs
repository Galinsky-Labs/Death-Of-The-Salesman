// DOTS-110..120 Strategy Lab acceptance tests. Synthetic data only; no network.
import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {StrategyLab,SalesWorkspace,tenant,chooseArm,armWeights,hashBucket,twoProportion,probabilityOfSuperiority,benjaminiHochberg,evaluateExperiment,factorialReport,stopRuleBreaches,sampleRatioMismatch,seededRandom,normalCdf,strategyConstraintViolations,falseDiscoveryDiscoveries,wilson,experimentArm,GrowthWorkspace} from '../packages/operations/dist/index.js';
import {setup,org,owner,project,ctx} from './helpers/operations-fixture.mjs';

const revisionInput=(n='A')=>({objective:`Synthetic objective ${n}`,audienceRules:['Synthetic B2B buyers'],allowedPersonalization:['company','first_name'],forbiddenClaims:['guaranteed returns'],tone:'Plain and factual',disclosures:['AI-assisted message'],instructions:`Use approved facts only ${n}`});
const now=()=>new Date().toISOString();
async function approved(lab,label){const {family,revision}=await lab.createFamily({label,projectId:project,...revisionInput(label)});return {family,revision:await lab.decideRevision(revision.id,true)};}
async function contacts(client,n,prefix){return tenant(client,ctx,async tx=>(await tx.query("INSERT INTO app.crm_contacts(organization_id,display_name,email,email_hash,lawful_source) SELECT $1,'Synthetic '||$2||g,$2||g||'@example.invalid',encode(sha256(convert_to($2||g||'@example.invalid','UTF8')),'hex'),'Synthetic fixture' FROM generate_series(1,$3::int) g RETURNING id",[org,prefix,n])).rows.map(r=>r.id));}
async function experimentWith(lab,{experimentalBasisPoints=5000,minSamplePerArm=30,lagDays=0,budgetCents=100000,maxComplaintBasisPoints=500,maxUnsubscribeBasisPoints=1000,campaignId}={}){
 const champion=await approved(lab,'Synthetic champion'),challenger=await approved(lab,'Synthetic challenger');
 const rule=await lab.saveAllocation({projectId:project,campaignId,experimentalBasisPoints,championRevisionId:champion.revision.id});
 const experiment=await lab.createExperiment({allocationRuleId:rule.id,label:'Synthetic experiment',arms:[{key:'champion',role:'champion',strategyRevisionId:champion.revision.id},{key:'challenger',role:'experimental',strategyRevisionId:challenger.revision.id}],minSamplePerArm,lagDays,budgetCents,maxComplaintBasisPoints,maxUnsubscribeBasisPoints});
 return {champion,challenger,rule,experiment};
}
const sent=(lab,experimentId,contactId,extra={})=>lab.recordOutcome({experimentId,contactId,kind:'sent',evidenceSource:'owner_attested',evidenceRef:'Synthetic send log',occurredAt:now(),idempotencyKey:`sent:${experimentId}:${contactId}`,...extra});
const qualified=(lab,experimentId,contactId)=>lab.recordOutcome({experimentId,contactId,kind:'qualified_response',evidenceSource:'owner_attested',evidenceRef:'Synthetic inbox review',occurredAt:now(),idempotencyKey:`q:${experimentId}:${contactId}`});
async function populate(lab,client,experimentId,n,rates,prefix){const ids=await contacts(client,n,prefix);const counters={};for(const id of ids){const {armKey}=await lab.enroll(experimentId,id);await sent(lab,experimentId,id);counters[armKey]=(counters[armKey]??0)+1;if(counters[armKey]%rates[armKey]===0)await qualified(lab,experimentId,id);}return ids;}

test('DOTS-110 strategy families keep immutable revisions; edits propose new revisions without mutating historical experiments',async()=>{const {db,client}=await setup();try{
 const lab=new StrategyLab(client,ctx);const {family,revision}=await lab.createFamily({label:'Synthetic family',projectId:project,...revisionInput('v1')});
 assert.equal(revision.revision,1);assert.equal(revision.status,'proposed');assert.match(revision.fingerprint,/^[0-9a-f]{64}$/);
 await assert.rejects(lab.createFamily({label:'Bad',...revisionInput(),allowedPersonalization:['email_address']}),/PERSONALIZATION_FIELD_NOT_ALLOWED/);
 await assert.rejects(lab.createFamily({label:'Bad',...revisionInput(),disclosures:[]}),/INVALID_DISCLOSURES/);
 const rule=await lab.saveAllocation({projectId:project});
 const other=await approved(lab,'Synthetic other');
 await assert.rejects(lab.createExperiment({allocationRuleId:rule.id,label:'Uses proposed',arms:[{key:'a',role:'champion',strategyRevisionId:revision.id},{key:'b',role:'experimental',strategyRevisionId:other.revision.id}]}),/REVISION_NOT_APPROVED/);
 await lab.decideRevision(revision.id,true);await assert.rejects(lab.decideRevision(revision.id,false),/REVISION_NOT_PROPOSED/);
 const experiment=await lab.createExperiment({allocationRuleId:rule.id,label:'Historical',arms:[{key:'a',role:'champion',strategyRevisionId:revision.id},{key:'b',role:'experimental',strategyRevisionId:other.revision.id}]});
 const next=await lab.proposeRevision(family.id,{...revisionInput('v2'),tone:'Warmer'});assert.equal(next.revision,2);assert.equal(next.status,'proposed');assert.notEqual(next.fingerprint,revision.fingerprint);
 const arms=(await db.query('SELECT strategy_revision_id FROM app.strategy_experiment_arms WHERE experiment_id=$1 ORDER BY arm_key',[experiment.id])).rows;assert.equal(arms[0].strategy_revision_id,revision.id);
 const stored=(await db.query('SELECT tone,fingerprint FROM app.strategy_revisions WHERE id=$1',[revision.id])).rows[0];assert.equal(stored.tone,'Plain and factual');assert.equal(stored.fingerprint,revision.fingerprint);
 await assert.rejects(db.query("UPDATE app.strategy_revisions SET tone='Mutated' WHERE id=$1",[revision.id]),/immutable/);
 await assert.rejects(db.query('DELETE FROM app.strategy_revisions WHERE id=$1',[revision.id]),/immutable/);
 await assert.rejects(db.query("UPDATE app.strategy_experiments SET label='Mutated' WHERE id=$1",[experiment.id]),/immutable/);
 await assert.rejects(db.query("UPDATE app.strategy_experiment_arms SET model_id='mutated' WHERE experiment_id=$1",[experiment.id]),/append-only/);
 assert.deepEqual(strategyConstraintViolations(stored.tone?{...revision}:revision,'We offer guaranteed returns',['company','phone']),['FORBIDDEN_CLAIM:guaranteed returns','PERSONALIZATION_NOT_ALLOWED:phone','DISCLOSURE_MISSING:AI-assisted message']);
 assert.deepEqual(strategyConstraintViolations(revision,'AI-assisted message: hello',['company']),[]);
 assert.ok((await db.query("SELECT count(*)::int AS n FROM app.operation_events WHERE event_type='strategy.revision_proposed'")).rows[0].n>=1);
}finally{await db.close();}});

test('DOTS-111 saved allocation rules (not a hardcoded split) drive enrollment; below-floor requires a recorded acknowledgement',async()=>{const {db,client}=await setup();try{
 const lab=new StrategyLab(client,ctx);const champion=await approved(lab,'Synthetic champion'),challenger=await approved(lab,'Synthetic challenger');
 const rule=await lab.saveAllocation({projectId:project,championRevisionId:champion.revision.id});assert.equal(rule.experimental_basis_points,5000);assert.equal(rule.min_exploration_basis_points,1000);
 await assert.rejects(lab.saveAllocation({projectId:project,experimentalBasisPoints:500}),/EXPLORATION_FLOOR_ACKNOWLEDGEMENT_REQUIRED/);
 await assert.rejects(lab.saveAllocation({projectId:project,experimentalBasisPoints:10001}),/INVALID_EXPERIMENTAL_BASIS_POINTS/);
 const low=await lab.saveAllocation({projectId:project,experimentalBasisPoints:500,belowFloorAcknowledgement:'Owner accepts reduced exploration for a synthetic test',expectedVersion:1});
 assert.equal(low.below_floor_acknowledgement,'Owner accepts reduced exploration for a synthetic test');
 const history=(await db.query('SELECT below_floor,below_floor_acknowledgement FROM app.strategy_allocation_history WHERE rule_id=$1 ORDER BY version',[rule.id])).rows;assert.deepEqual(history.map(h=>h.below_floor),[false,true]);
 await assert.rejects(lab.saveAllocation({projectId:project,experimentalBasisPoints:2000,expectedVersion:1}),/STALE_ALLOCATION_RULE/);
 const twenty=await lab.saveAllocation({projectId:project,experimentalBasisPoints:2000,expectedVersion:2});assert.equal(twenty.below_floor_acknowledgement,null);
 await assert.rejects(lab.saveAllocation({projectId:project,championRevisionId:challenger.revision.id}),/USE_PROMOTION_TO_CHANGE_CHAMPION/);
 await assert.rejects(db.query('UPDATE app.strategy_allocation_rules SET experimental_basis_points=100,below_floor_acknowledgement=NULL WHERE id=$1',[rule.id]),/check constraint/);
 const arms=[{key:'champion',role:'champion',strategyRevisionId:champion.revision.id},{key:'challenger',role:'experimental',strategyRevisionId:challenger.revision.id}];
 const first=await lab.createExperiment({allocationRuleId:rule.id,label:'Twenty percent',arms});
 const ids=await contacts(client,400,'alloc');let experimental=0;for(const id of ids)if((await lab.enroll(first.id,id)).armKey==='challenger')experimental++;
 assert.ok(experimental>=60&&experimental<=100,`20% saved setting produced ${experimental}/400`);
 assert.ok((await db.query('SELECT bool_and(allocation_basis_points=2000) AS ok FROM app.strategy_enrollments WHERE experiment_id=$1',[first.id])).rows[0].ok);
 await lab.setExperimentState(first.id,'completed');await lab.saveAllocation({projectId:project,experimentalBasisPoints:8000});
 const second=await lab.createExperiment({allocationRuleId:rule.id,label:'Eighty percent',arms,previousExperimentId:first.id});assert.equal(second.revision,2);
 experimental=0;for(const id of ids)if((await lab.enroll(second.id,id)).armKey==='challenger')experimental++;
 assert.ok(experimental>=300&&experimental<=340,`80% saved setting produced ${experimental}/400`);
}finally{await db.close();}});

test('DOTS-112 deterministic, idempotent, stratified enrollment with no cross-experiment duplicate exposure',async()=>{const {db,client}=await setup();try{
 const lab=new StrategyLab(client,ctx),sales=new SalesWorkspace(client,ctx);const {experiment,champion,challenger}=await experimentWith(lab);
 const ids=await contacts(client,300,'strat');const segments=['sector:alpha','sector:beta','sector:gamma'];
 const first=await lab.enroll(experiment.id,ids[0],{segment:segments[0]});const again=await lab.enroll(experiment.id,ids[0],{segment:segments[1]});
 assert.equal(again.armId,first.armId);assert.equal(again.repeated,true);assert.equal(again.stratum,first.stratum);
 const raced=[];for(let worker=0;worker<3;worker++)raced.push(await new StrategyLab(client,ctx).enroll(experiment.id,ids[1]));assert.deepEqual(raced.map(r=>r.repeated),[false,true,true]);assert.equal(new Set(raced.map(r=>r.armId)).size,1);
 for(const [i,id] of ids.slice(2).entries())await lab.enroll(experiment.id,id,{segment:segments[i%3]});
 const strata=(await db.query("SELECT stratum,count(*) FILTER(WHERE a.arm_key='champion')::int AS c,count(*) FILTER(WHERE a.arm_key='challenger')::int AS x FROM app.strategy_enrollments en JOIN app.strategy_experiment_arms a ON a.id=en.arm_id WHERE en.experiment_id=$1 GROUP BY stratum",[experiment.id])).rows;
 for(const s of strata.filter(s=>s.c+s.x>20))assert.ok(Math.abs(s.c-s.x)<=4,`stratum ${s.stratum} imbalance ${s.c}/${s.x}`);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM app.strategy_enrollments WHERE experiment_id=$1',[experiment.id])).rows[0].n,300);
 const arm=chooseArm({seed:'a'.repeat(32),contactId:ids[5],weights:[5000,5000],counts:[3,4],tolerance:2});assert.deepEqual(chooseArm({seed:'a'.repeat(32),contactId:ids[5],weights:[5000,5000],counts:[3,4],tolerance:2}),arm);
 assert.notDeepEqual([0,1,2,3,4,5,6,7].map(i=>hashBucket('a'.repeat(32),String(i))),[0,1,2,3,4,5,6,7].map(i=>hashBucket('b'.repeat(32),String(i))));
 await assert.rejects(db.query("UPDATE app.strategy_enrollments SET arm_id=arm_id WHERE experiment_id=$1",[experiment.id]),/append-only/);
 const campaign=await sales.createCampaign({projectId:project,label:'Synthetic campaign',purpose:'product',goal:'Synthetic goal'});await sales.setAudience(campaign.id,[ids[0],ids[2]]);
 const rule2=await lab.saveAllocation({projectId:project,campaignId:campaign.id,championRevisionId:champion.revision.id});
 const other=await lab.createExperiment({allocationRuleId:rule2.id,label:'Campaign experiment',arms:[{key:'champion',role:'champion',strategyRevisionId:champion.revision.id},{key:'challenger',role:'experimental',strategyRevisionId:challenger.revision.id}]});
 await assert.rejects(lab.enroll(other.id,ids[0]),/EXPERIMENT_OVERLAP/);
 await assert.rejects(lab.enroll(other.id,ids[3]),/CONTACT_NOT_IN_CAMPAIGN_AUDIENCE/);
 const [fresh]=await contacts(client,1,'fresh');await sales.suppressContact(fresh);await assert.rejects(lab.enroll(experiment.id,fresh),/CONTACT_NOT_ELIGIBLE/);
 await lab.setExperimentState(experiment.id,'paused');await assert.rejects(lab.enroll(experiment.id,(await contacts(client,1,'late'))[0]),/EXPERIMENT_NOT_ACTIVE/);assert.equal((await lab.enroll(experiment.id,ids[0])).armId,first.armId);
}finally{await db.close();}});

test('DOTS-113 only verified exposures and outcomes count; simulations, model claims and unreceipted provider events are excluded or rejected',async()=>{const {db,client}=await setup();try{
 const lab=new StrategyLab(client,ctx);const {experiment}=await experimentWith(lab);const [a,b,c]=await contacts(client,3,'acct');
 for(const id of [a,b])await lab.enroll(experiment.id,id);
 await assert.rejects(lab.recordOutcome({experimentId:experiment.id,contactId:c,kind:'sent',evidenceSource:'owner_attested',evidenceRef:'x',occurredAt:now(),idempotencyKey:'unenrolled'}),/CONTACT_NOT_ENROLLED/);
 await assert.rejects(lab.recordOutcome({experimentId:experiment.id,contactId:a,kind:'qualified_response',evidenceSource:'owner_attested',evidenceRef:'x',occurredAt:now(),idempotencyKey:'early'}),/OUTCOME_WITHOUT_VERIFIED_EXPOSURE/);
 await assert.rejects(lab.recordOutcome({experimentId:experiment.id,contactId:a,kind:'sent',evidenceSource:'provider',receiptProvider:'resend',receiptEventId:'missing',occurredAt:now(),idempotencyKey:'noreceipt'}),/PROVIDER_RECEIPT_NOT_FOUND/);
 await assert.rejects(lab.recordOutcome({experimentId:experiment.id,contactId:a,kind:'sent',evidenceSource:'owner_attested',occurredAt:now(),idempotencyKey:'noref'}),/INVALID_EVIDENCE_REF/);
 await assert.rejects(lab.recordOutcome({experimentId:experiment.id,contactId:a,kind:'sent',evidenceSource:'owner_attested',evidenceRef:'x',occurredAt:new Date(Date.now()+86400000).toISOString(),idempotencyKey:'future'}),/FUTURE_OUTCOME_REJECTED/);
 await assert.rejects(lab.recordOutcome({experimentId:experiment.id,contactId:a,kind:'funds_received',evidenceSource:'owner_attested',evidenceRef:'x',occurredAt:now(),idempotencyKey:'zero'}),/POSITIVE_AMOUNT_REQUIRED/);
 // Simulated and model-claimed "closed deals" are stored for transparency but never counted.
 await lab.recordOutcome({experimentId:experiment.id,contactId:b,kind:'sent',evidenceSource:'simulation',occurredAt:now(),idempotencyKey:'sim-sent'});
 const claim=await lab.recordOutcome({experimentId:experiment.id,contactId:b,kind:'funds_received',evidenceSource:'model_claim',amountCents:999999,occurredAt:now(),idempotencyKey:'model-closed'});assert.equal(claim.counted,false);
 await db.query("INSERT INTO app.provider_receipts(organization_id,provider,event_id,payload_hash) VALUES($1,'resend','synthetic-evt-1',$2)",[org,'0'.repeat(64)]);
 const delivered=await lab.recordOutcome({experimentId:experiment.id,contactId:a,kind:'sent',evidenceSource:'provider',receiptProvider:'resend',receiptEventId:'synthetic-evt-1',occurredAt:now(),idempotencyKey:'sent-a'});assert.equal(delivered.counted,true);
 assert.equal((await lab.recordOutcome({experimentId:experiment.id,contactId:a,kind:'sent',evidenceSource:'provider',receiptProvider:'resend',receiptEventId:'synthetic-evt-1',occurredAt:delivered.id?(await db.query('SELECT occurred_at FROM app.strategy_outcome_events WHERE id=$1',[delivered.id])).rows[0].occurred_at.toISOString():now(),idempotencyKey:'sent-a'})).repeated,true);
 await assert.rejects(lab.recordOutcome({experimentId:experiment.id,contactId:a,kind:'reply',evidenceSource:'owner_attested',evidenceRef:'x',occurredAt:now(),idempotencyKey:'sent-a'}),/IDEMPOTENCY_CONFLICT/);
 for(const [kind,extra] of [['reply',{}],['qualified_response',{}],['meeting',{}],['deal',{amountCents:500000}],['funds_received',{amountCents:120000}],['cost',{amountCents:300}]])await lab.recordOutcome({experimentId:experiment.id,contactId:a,kind,evidenceSource:'owner_attested',evidenceRef:`Synthetic ${kind} evidence`,occurredAt:now(),idempotencyKey:`a-${kind}`,...extra});
 const m=(await lab.metrics(experiment.id)).arms;const armA=m.find(x=>x.funnel.exposed===1),armB=m.find(x=>x.excluded.modelClaimEvents===1);
 assert.deepEqual(armA.funnel,{enrolled:armA.funnel.enrolled,exposed:1,replies:1,qualified:1,meetings:1,deals:1,funded:1});
 assert.equal(armA.actual.fundsCents,120000);assert.equal(armA.estimated.dealPipelineCents,500000);assert.equal(armA.actual.costCents,300);
 if(armB!==armA){assert.equal(armB.funnel.exposed,0);assert.equal(armB.actual.fundsCents,0);assert.equal(armB.excluded.simulationEvents,1);}
 assert.equal((await db.query("SELECT COALESCE(sum(funds_actual_cents),0)::int AS n FROM app.strategy_arm_metrics WHERE experiment_id=$1",[experiment.id])).rows[0].n,120000);
 await assert.rejects(db.query("UPDATE app.strategy_outcome_events SET evidence_source='provider' WHERE idempotency_key='model-closed'"),/append-only/);
 await assert.rejects(db.query("DELETE FROM app.strategy_outcome_events WHERE idempotency_key='model-closed'"),/append-only/);
}finally{await db.close();}});

test('DOTS-114 metrics separate actual from estimated values, converted currency, periods, cohorts and denominators',async()=>{const {db,client}=await setup();try{
 const lab=new StrategyLab(client,ctx);const {experiment}=await experimentWith(lab);const ids=await contacts(client,6,'metric');
 for(const id of ids){await lab.enroll(experiment.id,id);await sent(lab,experiment.id,id);}
 await qualified(lab,experiment.id,ids[0]);await qualified(lab,experiment.id,ids[1]);
 await lab.recordOutcome({experimentId:experiment.id,contactId:ids[0],kind:'funds_received',evidenceSource:'owner_attested',evidenceRef:'Synthetic bank statement',amountCents:10870,originalCurrency:'EUR',originalAmountMinor:10000,fxSource:'Synthetic ECB reference rate',occurredAt:now(),idempotencyKey:'fx'});
 await assert.rejects(lab.recordOutcome({experimentId:experiment.id,contactId:ids[1],kind:'funds_received',evidenceSource:'owner_attested',evidenceRef:'x',amountCents:100,originalCurrency:'GBP',occurredAt:now(),idempotencyKey:'fx2'}),/INVALID_AMOUNT/);
 await lab.recordOutcome({experimentId:experiment.id,contactId:ids[0],kind:'cost',evidenceSource:'owner_attested',evidenceRef:'Synthetic invoice',amountCents:870,occurredAt:now(),idempotencyKey:'cost'});
 await lab.recordOutcome({experimentId:experiment.id,contactId:ids[1],kind:'cost',evidenceSource:'owner_attested',evidenceRef:'Synthetic estimate',amountCents:50,isEstimate:true,occurredAt:now(),idempotencyKey:'cost-est'});
 const report=await lab.metrics(experiment.id);const total=report.arms.reduce((s,a)=>s+a.funnel.exposed,0);assert.equal(total,6);
 const funded=report.arms.find(a=>a.actual.fundsCents>0);assert.equal(funded.actual.convertedFundsCents,10870);assert.equal(funded.conversion.qualified.denominator,funded.funnel.exposed);
 assert.equal(funded.actual.marginPerQualifiedCents,Math.round((10870-870)/funded.funnel.qualified));
 assert.equal(report.arms.reduce((s,a)=>s+a.estimated.costCents,0),50);assert.equal(report.period.currency,'USD');assert.ok(report.period.firstEnrollment);
 assert.equal(report.cohorts.reduce((s,c)=>s+c.enrolled,0),6);assert.equal(report.cohorts.reduce((s,c)=>s+c.qualified,0),2);
 assert.ok(report.evaluation.warnings.includes('SAMPLE_BELOW_FLOOR'));
 const {snapshot}=await lab.snapshotMetrics(experiment.id);assert.match(snapshot.fingerprint,/^[0-9a-f]{64}$/);await assert.rejects(db.query('UPDATE app.strategy_metric_snapshots SET fingerprint=fingerprint WHERE id=$1',[snapshot.id]),/append-only/);
}finally{await db.close();}});

test('DOTS-115 statistics: two-proportion, seeded Bayesian superiority, BH and guardrails warn on small, immature or imbalanced samples',()=>{
 assert.ok(Math.abs(normalCdf(1.96)-0.975)<1e-4);assert.ok(Math.abs(normalCdf(0)-0.5)<1e-9);
 const t=twoProportion(50,500,80,500);assert.ok(Math.abs(t.difference-0.06)<1e-12);assert.ok(t.pValue<0.01&&t.pValue>0.001,String(t.pValue));assert.ok(t.lower>0);
 assert.equal(twoProportion(0,0,1,10).pValue,null);assert.throws(()=>twoProportion(5,4,1,1),/INVALID_SAMPLE/);
 const p1=probabilityOfSuperiority(50,500,80,500,{seed:'s'}),p2=probabilityOfSuperiority(50,500,80,500,{seed:'s'});assert.equal(p1,p2);assert.ok(p1>0.98);
 assert.ok(Math.abs(probabilityOfSuperiority(50,500,50,500,{seed:'eq'})-0.5)<0.03);
 assert.deepEqual(benjaminiHochberg([0.001,0.02,0.5]),[true,true,false]);assert.deepEqual(benjaminiHochberg([0.045,0.045,0.045,0.045,0.9],0.05),[false,false,false,false,false]);
 const arm=(key,role,enrolled,exposed,matured,successes,extra={})=>({armId:key,armKey:key,role,strategyRevisionId:key,modelId:null,enrolled,exposed,maturedExposed:matured,maturedSuccesses:successes,complaints:0,unsubscribes:0,costCents:0,fundsCents:0,...extra});
 const policy={minSamplePerArm:200,alphaBasisPoints:500,maxComplaintBasisPoints:30,maxUnsubscribeBasisPoints:200,budgetCents:100000,weights:[5000,5000],seed:'p',draws:4000};
 const small=evaluateExperiment([arm('c','champion',20,20,20,2),arm('x','experimental',20,20,20,12)],policy);assert.ok(small.warnings.includes('SAMPLE_BELOW_FLOOR'));assert.equal(small.autoPromotable,false);assert.equal(small.manualPromotionAllowed,false);
 const lag=evaluateExperiment([arm('c','champion',500,500,300,30),arm('x','experimental',500,500,300,90)],policy);assert.ok(lag.warnings.includes('LAG_WINDOW_OPEN'));assert.equal(lag.autoPromotable,false);
 const srm=evaluateExperiment([arm('c','champion',900,900,900,90),arm('x','experimental',600,600,600,120)],policy);assert.ok(srm.warnings.includes('IMBALANCED_ALLOCATION'));assert.equal(srm.autoPromotable,false);
 const unstable=evaluateExperiment([arm('c','champion',500,500,500,50),arm('x','experimental',500,500,500,58)],policy);assert.ok(unstable.warnings.includes('UNSTABLE_UPLIFT'));assert.equal(unstable.autoPromotable,false);assert.equal(unstable.manualPromotionAllowed,true);
 const stable=evaluateExperiment([arm('c','champion',500,500,500,50),arm('x','experimental',500,500,500,110)],policy);assert.equal(stable.autoPromotable,true);assert.equal(stable.recommendedArmId,'x');assert.ok(stable.comparisons[0].probabilityOfSuperiority>0.99);
 const many=evaluateExperiment([arm('c','champion',500,500,500,50),...[1,2,3,4,5,6].map(i=>arm(`x${i}`,'experimental',500,500,500,i===1?66:50))],{...policy,weights:armWeights(['champion','experimental','experimental','experimental','experimental','experimental','experimental'],5000)});
 assert.equal(many.comparisons.find(c=>c.armKey==='x1').bhSignificant,false,'marginal raw p<0.05 must not survive BH across six simultaneous comparisons');assert.equal(many.autoPromotable,false);
 assert.ok(sampleRatioMismatch([500,500],[5000,5000]).pValue>0.5);assert.ok(sampleRatioMismatch([700,300],[5000,5000]).pValue<0.001);
 assert.equal(wilson(0,0).rate,null);assert.equal(experimentArm('legacy','c',5000),experimentArm('legacy','c',5000));
});

test('DOTS-116 model x strategy factorial report separates effects and warns about confounding and selection bias',async()=>{
 const arm=(key,s,m,enrolled,exposed,successes,cost=0)=>({armId:key,armKey:key,role:key==='c'?'champion':'experimental',strategyRevisionId:s,modelId:m,enrolled,exposed,maturedExposed:exposed,maturedSuccesses:successes,complaints:0,unsubscribes:0,costCents:cost,fundsCents:0});
 const balanced={a:{x:100,y:100},b:{x:100,y:100},c:{x:100,y:100},d:{x:100,y:100}};
 const full=factorialReport([arm('c','S1','M1',200,200,20,200),arm('b','S1','M2',200,200,22,800),arm('a','S2','M1',200,200,60,200),arm('d','S2','M2',200,200,62,800)],{c:balanced.c,b:balanced.b,a:balanced.a,d:balanced.d});
 assert.equal(full.missingCells.length,0);assert.equal(full.separatedWinner.strategy,'S2');assert.equal(full.separatedWinner.model,null);assert.ok(!full.warnings.includes('SEGMENT_IMBALANCE_ACROSS_CELLS'));
 assert.equal(full.modelEffects.find(m=>m.modelId==='M2').costPerExposureCents,4);assert.match(full.decisionNote,/confounder/);
 const partial=factorialReport([arm('c','S1','M1',200,200,20),arm('a','S2','M2',200,200,60)],{c:{x:180,y:20},a:{x:20,y:180}});
 assert.ok(partial.warnings.includes('INCOMPLETE_FACTORIAL_CONFOUNDS_MODEL_AND_STRATEGY'));assert.ok(partial.warnings.includes('SEGMENT_IMBALANCE_ACROSS_CELLS'));
 const selected=factorialReport([arm('c','S1','M1',200,190,20),arm('b','S1','M2',200,80,20),arm('a','S2','M1',200,190,20),arm('d','S2','M2',200,80,20)],balanced);assert.ok(selected.warnings.includes('SELECTION_BIAS_EXPOSURE_RATE_DIFFERS'));
 const {db,client}=await setup();try{const lab=new StrategyLab(client,ctx);const a=await approved(lab,'S1'),b=await approved(lab,'S2');const rule=await lab.saveAllocation({projectId:project});
  await assert.rejects(lab.createExperiment({allocationRuleId:rule.id,label:'Factorial',design:'factorial',arms:[{key:'a',role:'champion',strategyRevisionId:a.revision.id},{key:'b',role:'experimental',strategyRevisionId:b.revision.id,modelId:'synthetic-model-2'}]}),/FACTORIAL_REQUIRES_MODEL_PER_ARM/);
  const ex=await lab.createExperiment({allocationRuleId:rule.id,label:'Factorial',design:'factorial',arms:[{key:'s1m1',role:'champion',strategyRevisionId:a.revision.id,modelId:'synthetic-model-1'},{key:'s1m2',role:'experimental',strategyRevisionId:a.revision.id,modelId:'synthetic-model-2'},{key:'s2m1',role:'experimental',strategyRevisionId:b.revision.id,modelId:'synthetic-model-1'},{key:'s2m2',role:'experimental',strategyRevisionId:b.revision.id,modelId:'synthetic-model-2'}]});
  const ids=await contacts(client,80,'fact');for(const [i,id] of ids.entries())await lab.enroll(ex.id,id,{segment:i%2?'sector:a':'sector:b'});
  const report=await lab.metrics(ex.id);assert.ok(report.factorial);assert.equal(report.factorial.cells.length,4);assert.equal(report.factorial.strategyEffects.length,2);assert.ok(report.factorial.warnings.includes('SMALL_CELLS'));
 }finally{await db.close();}
});

test('DOTS-117/118 auditable promotion with fingerprints and safety criteria, rollback restoring the prior champion, and independently evaluated hybrids',async()=>{const {db,client}=await setup();try{
 const lab=new StrategyLab(client,ctx);const {experiment,champion,challenger,rule}=await experimentWith(lab,{minSamplePerArm:30});
 const exArms=(await db.query('SELECT id,arm_key FROM app.strategy_experiment_arms WHERE experiment_id=$1',[experiment.id])).rows;const armId=k=>exArms.find(a=>a.arm_key===k).id;
 await assert.rejects(lab.promote({experimentId:experiment.id,armId:armId('challenger'),rationale:'No evidence yet'}),/INSUFFICIENT_VERIFIED_EVIDENCE/);
 await populate(lab,client,experiment.id,200,{champion:6,challenger:2},'promo');
 await assert.rejects(lab.promote({experimentId:experiment.id,armId:armId('champion'),rationale:'Wrong arm'}),/PROMOTION_REQUIRES_EVALUATED_EXPERIMENTAL_ARM/);
 await assert.rejects(lab.promote({experimentId:experiment.id,armId:armId('challenger'),mode:'automatic',rationale:'Auto'}),/AUTO_PROMOTION_DISABLED/);
 const evaluation=(await lab.metrics(experiment.id)).evaluation;assert.equal(evaluation.autoPromotable,true,JSON.stringify(evaluation.warnings));
 await lab.saveAllocation({projectId:project,autoPromoteEnabled:true});
 const promotion=await lab.promote({experimentId:experiment.id,armId:armId('challenger'),mode:'automatic',rationale:'Guarded automatic promotion on synthetic evidence'});
 assert.equal(promotion.from_revision_id,champion.revision.id);assert.equal(promotion.to_revision_id,challenger.revision.id);assert.equal(promotion.to_fingerprint,challenger.revision.fingerprint);assert.ok(promotion.snapshot_id);
 assert.equal((await db.query('SELECT champion_revision_id FROM app.strategy_allocation_rules WHERE id=$1',[rule.id])).rows[0].champion_revision_id,challenger.revision.id);
 assert.equal((await db.query('SELECT state FROM app.strategy_experiments WHERE id=$1',[experiment.id])).rows[0].state,'completed');
 await assert.rejects(lab.retireRevision(challenger.revision.id),/CHAMPION_REVISION_CANNOT_BE_RETIRED/);
 const rolled=await lab.rollback(promotion.id,'Synthetic rollback drill');assert.equal(rolled.to_revision_id,champion.revision.id);
 assert.equal((await db.query('SELECT champion_revision_id FROM app.strategy_allocation_rules WHERE id=$1',[rule.id])).rows[0].champion_revision_id,champion.revision.id);
 await assert.rejects(lab.rollback(promotion.id,'Twice'),/PROMOTION_ALREADY_ROLLED_BACK/);
 await assert.rejects(db.query("UPDATE app.strategy_promotions SET rationale='forged' WHERE id=$1",[promotion.id]),/append-only/);
 const audit=(await db.query("SELECT event_type FROM app.operation_events WHERE event_type IN ('strategy.champion_promoted','strategy.champion_rolled_back','strategy.metrics_snapshot')")).rows.map(r=>r.event_type);
 for(const type of ['strategy.champion_promoted','strategy.champion_rolled_back','strategy.metrics_snapshot'])assert.ok(audit.includes(type),type);
 // DOTS-118: hybrid lineage, backlog, independent evaluation before replacing champion.
 const hybrid=await lab.createHybrid(challenger.family.id,[{revisionId:champion.revision.id,elements:['tone']},{revisionId:challenger.revision.id,elements:['objective']}],revisionInput('hybrid'));
 assert.equal(hybrid.status,'proposed');const lineage=(await db.query('SELECT parent_revision_id FROM app.strategy_lineage WHERE child_revision_id=$1',[hybrid.id])).rows.map(r=>r.parent_revision_id).sort();assert.deepEqual(lineage,[champion.revision.id,challenger.revision.id].sort());
 await assert.rejects(db.query('DELETE FROM app.strategy_lineage WHERE child_revision_id=$1',[hybrid.id]),/append-only/);
 const item=await lab.addBacklogItem({familyId:challenger.family.id,title:'Synthetic hybrid',hypothesis:'Combining tone and objective lifts qualified responses',parentRevisionIds:[champion.revision.id,challenger.revision.id],proposedRevisionId:hybrid.id});assert.equal(item.status,'drafted');
 await assert.rejects(lab.createExperiment({allocationRuleId:rule.id,label:'Hybrid',arms:[{key:'champion',role:'champion',strategyRevisionId:champion.revision.id},{key:'hybrid',role:'experimental',strategyRevisionId:hybrid.id}]}),/REVISION_NOT_APPROVED/);
 await lab.decideRevision(hybrid.id,true);
 await assert.rejects(lab.createExperiment({allocationRuleId:rule.id,label:'Wrong champion',arms:[{key:'champion',role:'champion',strategyRevisionId:challenger.revision.id},{key:'hybrid',role:'experimental',strategyRevisionId:hybrid.id}]}),/CHAMPION_ARM_MUST_USE_CURRENT_CHAMPION/);
 const hybridEx=await lab.createExperiment({allocationRuleId:rule.id,label:'Hybrid evaluation',arms:[{key:'champion',role:'champion',strategyRevisionId:champion.revision.id},{key:'hybrid',role:'experimental',strategyRevisionId:hybrid.id}],minSamplePerArm:30,lagDays:0,budgetCents:100000});
 assert.equal((await db.query('SELECT status FROM app.strategy_variant_backlog WHERE id=$1',[item.id])).rows[0].status,'evaluating');
 await lab.saveAllocation({projectId:project,autoPromoteEnabled:false});
 const hArms=(await db.query('SELECT id,arm_key FROM app.strategy_experiment_arms WHERE experiment_id=$1',[hybridEx.id])).rows;
 await assert.rejects(lab.promote({experimentId:hybridEx.id,armId:hArms.find(a=>a.arm_key==='hybrid').id,rationale:'Parents won before'}),/INSUFFICIENT_VERIFIED_EVIDENCE/,'parent evidence must not promote a hybrid');
 await populate(lab,client,hybridEx.id,120,{champion:5,hybrid:5},'hyb');
 const hEval=(await lab.metrics(hybridEx.id)).evaluation;assert.ok(hEval.warnings.includes('UNSTABLE_UPLIFT'));
 await assert.rejects(lab.promote({experimentId:hybridEx.id,armId:hArms.find(a=>a.arm_key==='hybrid').id,rationale:'Equal performance'}),/UNCERTAINTY_ACKNOWLEDGEMENT_REQUIRED/);
 const manual=await lab.promote({experimentId:hybridEx.id,armId:hArms.find(a=>a.arm_key==='hybrid').id,rationale:'Owner prefers hybrid for clarity',acknowledgeUncertainty:'Uplift not established; owner accepts uncertainty'});
 assert.equal(manual.uncertainty_acknowledged,true);assert.equal(manual.mode,'manual');assert.equal((await db.query('SELECT status FROM app.strategy_variant_backlog WHERE id=$1',[item.id])).rows[0].status,'adopted');
}finally{await db.close();}});

test('DOTS-119 Strategy Lab snapshot and view expose cards, allocation controls, CI bars, funnel, provenance and empty-sample explanations',async()=>{const {db,client}=await setup();try{
 const lab=new StrategyLab(client,ctx);const empty=await lab.snapshot();assert.deepEqual(empty.families,[]);assert.equal(empty.defaults.suggestedExperimentalBasisPoints,5000);
 const {experiment}=await experimentWith(lab);const snap=await lab.snapshot();assert.equal(snap.families.length,2);assert.equal(snap.rules[0].history.length,1);
 const report=snap.reports.find(r=>r.experiment.id===experiment.id);assert.ok(report.evaluation.warnings.includes('NO_VERIFIED_EVIDENCE'));assert.deepEqual(report.provenance,[]);
 const [id]=await contacts(client,1,'view');await lab.enroll(experiment.id,id);await sent(lab,experiment.id,id);const after=(await lab.snapshot()).reports[0];
 assert.equal(after.provenance.length,1);assert.equal(after.provenance[0].counted,true);assert.equal(after.arms.reduce((s,a)=>s+a.funnel.exposed,0),1);
 assert.equal((await lab.provenance(experiment.id)).length,1);
 const view=await readFile(new URL('../apps/web/app/views/strategy-lab-view.tsx',import.meta.url),'utf8');
 for(const marker of ['/api/v1/strategy','aria-live','role="alert"','type="range"','type="number"','belowFloorAcknowledgement','<svg','Provenance','Funnel','explain'])assert.ok(view.includes(marker),marker);
 assert.ok(!/quote/i.test(view.replace(/quoted|quotes? the/gi,'')),'no decorative salesman quote');
 const route=await readFile(new URL('../apps/web/app/api/v1/strategy/route.ts',import.meta.url),'utf8');for(const marker of ['ownerSession','hasTrustedOrigin','force-dynamic','private, no-store'])assert.ok(route.includes(marker),marker);
}finally{await db.close();}});

test('DOTS-120 large synthetic cohorts: stratification balance, null false-positive rate with BH, and stop rules honoring complaint/unsubscribe/budget limits',async()=>{
 // 20k in-memory enrollments over 12 strata with a 30% experimental share and three experimental arms.
 const roles=['champion','experimental','experimental','experimental'],weights=armWeights(roles,3000),strata=new Map();const totals=[0,0,0,0];const random=seededRandom('dots-120');
 for(let i=0;i<20000;i++){const stratum=`campaign-${i%3}|segment-${Math.floor(random()*4)}`;const counts=strata.get(stratum)??[0,0,0,0];const {index}=chooseArm({seed:'f'.repeat(32),contactId:`synthetic-${i}`,weights,counts,tolerance:2});counts[index]++;totals[index]++;strata.set(stratum,counts);}
 for(const [stratum,counts] of strata){const n=counts.reduce((a,b)=>a+b,0);counts.forEach((c,i)=>assert.ok(Math.abs(c-n*weights[i]/10000)<=3,`${stratum} arm ${i}: ${c} of ${n}`));}
 assert.ok(Math.abs(totals[0]/20000-0.7)<0.005);assert.ok(sampleRatioMismatch(totals,weights).pValue>0.01);
 // Null simulation: A/A experiments with varied base rates, deal sizes and timing; 10 simultaneous comparisons per family.
 const rng=seededRandom('null-sim');let rawRejections=0,tests=0,familiesWithDiscovery=0,autoPromotions=0;const families=120,alpha=0.05;
 for(let f=0;f<families;f++){const pValues=[];for(let k=0;k<10;k++){const base=0.03+rng()*0.12,n=300+Math.floor(rng()*700);let a=0,b=0,revenueA=0,revenueB=0;for(let i=0;i<n;i++){if(rng()<base){a++;revenueA+=Math.round(1000*Math.exp(rng()*5));}if(rng()<base){b++;revenueB+=Math.round(1000*Math.exp(rng()*5));}}
  const t=twoProportion(a,n,b,n);pValues.push(t.pValue);tests++;if(t.pValue<alpha)rawRejections++;
  if(k===0){const matured=Math.floor(n*(0.5+rng()/2));const arm=(key,role,s)=>({armId:key,armKey:key,role,strategyRevisionId:key,modelId:null,enrolled:n,exposed:n,maturedExposed:matured,maturedSuccesses:Math.round(s*matured/n),complaints:0,unsubscribes:0,costCents:0,fundsCents:key==='c'?revenueA:revenueB});
   if(evaluateExperiment([arm('c','champion',a),arm('x','experimental',b)],{minSamplePerArm:200,alphaBasisPoints:500,maxComplaintBasisPoints:30,maxUnsubscribeBasisPoints:200,budgetCents:0,weights:[5000,5000],seed:`f${f}`,draws:2000}).autoPromotable)autoPromotions++;}}
  if(benjaminiHochberg(pValues,alpha).some(Boolean))familiesWithDiscovery++;}
 const rawRate=rawRejections/tests;assert.ok(rawRate>0.02&&rawRate<0.08,`raw false-positive rate ${rawRate}`);
 assert.ok(familiesWithDiscovery/families<=0.09,`BH family-wise false discoveries ${familiesWithDiscovery}/${families}`);
 assert.ok(autoPromotions/families<=alpha,`null auto-promotions ${autoPromotions}/${families}`);
 assert.deepEqual(falseDiscoveryDiscoveries([0.2,0.3]),[]);
 // Stop-rule unit checks.
 const base={maxComplaintBasisPoints:30,maxUnsubscribeBasisPoints:200,budgetCents:1000};
 assert.deepEqual(stopRuleBreaches([{armKey:'a',exposed:10000,complaints:30,unsubscribes:200,costCents:999}],base),[]);
 assert.deepEqual(stopRuleBreaches([{armKey:'a',exposed:10000,complaints:31,unsubscribes:201,costCents:1000}],base).sort(),['BUDGET_EXHAUSTED','COMPLAINT_LIMIT','UNSUBSCRIBE_LIMIT']);
 assert.deepEqual(stopRuleBreaches([{armKey:'a',exposed:0,complaints:0,unsubscribes:0,costCents:1}],{...base,budgetCents:0}),['BUDGET_EXHAUSTED']);
 // DB stop rules: a verified complaint over the limit stops the experiment; enrollment and further sends are blocked; resume is refused.
 const {db,client}=await setup();try{const lab=new StrategyLab(client,ctx);const {experiment}=await experimentWith(lab,{maxComplaintBasisPoints:30});const ids=await contacts(client,40,'stop');
  for(const id of ids){await lab.enroll(experiment.id,id);await sent(lab,experiment.id,id);}
  const result=await lab.recordOutcome({experimentId:experiment.id,contactId:ids[0],kind:'spam_complaint',evidenceSource:'provider',receiptProvider:'resend',receiptEventId:(await db.query("INSERT INTO app.provider_receipts(organization_id,provider,event_id,payload_hash) VALUES($1,'resend','synthetic-complaint',$2) RETURNING event_id",[org,'1'.repeat(64)])).rows[0].event_id,occurredAt:now(),idempotencyKey:'complaint'});
  assert.deepEqual(result.stopReasons,['COMPLAINT_LIMIT']);const state=(await db.query('SELECT state,stop_reason FROM app.strategy_experiments WHERE id=$1',[experiment.id])).rows[0];assert.equal(state.state,'stopped');
  await assert.rejects(lab.enroll(experiment.id,(await contacts(client,1,'after'))[0]),/EXPERIMENT_NOT_ACTIVE/);
  await assert.rejects(sent(lab,experiment.id,ids[1],{idempotencyKey:'resend'}),/EXPERIMENT_NOT_ACTIVE/);
  await assert.rejects(lab.setExperimentState(experiment.id,'active'),/INVALID_EXPERIMENT_TRANSITION|SAFETY_STOP_REQUIRES_NEW_REVISION/);
  const arms=(await db.query("SELECT id FROM app.strategy_experiment_arms WHERE experiment_id=$1 AND role='experimental'",[experiment.id])).rows;await assert.rejects(lab.promote({experimentId:experiment.id,armId:arms[0].id,rationale:'Should not promote'}),/EXPERIMENT_NOT_PROMOTABLE/);
  // $0 default budget: the first verified cost stops a zero-budget experiment.
  await lab.setExperimentState(experiment.id,'completed').catch(()=>undefined);
  const zero=await lab.createExperiment({allocationRuleId:(await db.query('SELECT allocation_rule_id FROM app.strategy_experiments WHERE id=$1',[experiment.id])).rows[0].allocation_rule_id,label:'Zero budget',arms:(await db.query('SELECT arm_key AS key,role,strategy_revision_id AS "strategyRevisionId" FROM app.strategy_experiment_arms WHERE experiment_id=$1',[experiment.id])).rows,previousExperimentId:experiment.id});
  assert.equal(Number(zero.budget_cents),0);const [z]=await contacts(client,1,'zero');await lab.enroll(zero.id,z);await sent(lab,zero.id,z);
  const cost=await lab.recordOutcome({experimentId:zero.id,contactId:z,kind:'cost',evidenceSource:'owner_attested',evidenceRef:'Synthetic invoice',amountCents:1,occurredAt:now(),idempotencyKey:'zero-cost'});assert.deepEqual(cost.stopReasons,['BUDGET_EXHAUSTED']);
 }finally{await db.close();}
});

test('Strategy Lab tenant isolation, least-privilege runtime grants and reversible migration',async()=>{const {db,client}=await setup();try{
 const other='66666666-6666-4666-8666-666666666666',otherMember='77777777-7777-4777-8777-777777777777';
 await db.query("INSERT INTO app.organizations(id,slug,display_name) VALUES($1,'other-synthetic','Other synthetic organization')",[other]);await db.query("INSERT INTO app.owner_users(id,identity_subject,display_name) VALUES($1,'other-fixture','Other synthetic owner')",[otherMember]);
 await db.exec(`SELECT set_config('app.organization_id','${other}',false);SELECT set_config('app.audit_actor_membership_id','${otherMember}',false);`);await db.query("INSERT INTO app.memberships(id,organization_id,user_id,role) VALUES($1,$2,$1,'owner')",[otherMember,other]);
 await db.exec('CREATE ROLE dots_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;GRANT USAGE ON SCHEMA app TO dots_runtime;GRANT SELECT ON app.memberships,app.projects,app.agent_identities,app.agent_project_assignments,app.audit_events TO dots_runtime;GRANT INSERT ON app.audit_events TO dots_runtime;');
 await db.exec(await readFile(new URL('../database/runtime-grants.sql',import.meta.url),'utf8'));await db.exec(await readFile(new URL('../database/runtime-grants-0020.sql',import.meta.url),'utf8'));
 for(const table of ['strategy_outcome_events','strategy_enrollments','strategy_promotions','strategy_revisions','strategy_metric_snapshots','strategy_lineage'])assert.equal((await db.query("SELECT has_table_privilege('dots_runtime',$1,'DELETE') AS allowed",[`app.${table}`])).rows[0].allowed,false,table);
 for(const table of ['strategy_allocation_rules','strategy_revisions','strategy_experiments'])for(const column of ['id','organization_id'])assert.equal((await db.query("SELECT has_column_privilege('dots_runtime',$1,$2,'UPDATE') AS allowed",[`app.${table}`,column])).rows[0].allowed,false,`${table}.${column}`);
 assert.equal((await db.query("SELECT has_column_privilege('dots_runtime','app.strategy_revisions','objective','UPDATE') AS allowed")).rows[0].allowed,false);
 await db.exec('SET ROLE dots_runtime');
 const lab=new StrategyLab(client,ctx);const {experiment}=await experimentWith(lab);const [id]=await contacts(client,1,'grant');await lab.enroll(experiment.id,id);await sent(lab,experiment.id,id);await lab.snapshotMetrics(experiment.id);assert.ok((await lab.snapshot()).reports.length);
 const otherLab=new StrategyLab(client,{organizationId:other,membershipId:otherMember});const otherSnap=await otherLab.snapshot();assert.deepEqual(otherSnap.families,[]);assert.deepEqual(otherSnap.rules,[]);
 await assert.rejects(otherLab.enroll(experiment.id,id),/NOT_FOUND/);await assert.rejects(otherLab.metrics(experiment.id),/NOT_FOUND/);
 await assert.rejects(new StrategyLab(client,{organizationId:org,membershipId:otherMember}).snapshot(),/NOT_AUTHORIZED/);
 await db.exec('RESET ROLE');
 const fresh=await setup();try{const dir=new URL('../database/migrations/',import.meta.url);await fresh.db.exec(await readFile(new URL('0020_strategy_lab.down.sql',dir),'utf8'));assert.equal((await fresh.db.query("SELECT to_regclass('app.strategy_revisions') AS t")).rows[0].t,null);await fresh.db.exec(await readFile(new URL('0020_strategy_lab.up.sql',dir),'utf8'));assert.ok((await fresh.db.query("SELECT to_regclass('app.strategy_arm_metrics') AS t")).rows[0].t);}finally{await fresh.db.close();}
 // Legacy GrowthWorkspace exports remain available.
 assert.equal(typeof GrowthWorkspace,'function');
}finally{await db.close();}});
