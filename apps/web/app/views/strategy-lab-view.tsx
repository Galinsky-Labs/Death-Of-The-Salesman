"use client";
// DOTS-110..120 Strategy Lab view. Navigation label: "Strategy Lab".
// Fetches /api/v1/strategy itself. Shows only verified evidence; empty and small samples are explained, never filled in.
import {useCallback,useEffect,useState,type FormEvent,type ReactNode} from 'react';
import '../operations.css';
import './strategy-lab-view.css';

type Row=Record<string,any>;
type Snapshot={families:Row[];rules:Row[];experiments:Row[];reports:Row[];promotions:Row[];backlog:Row[];projects:Row[];campaigns:Row[];defaults:{suggestedExperimentalBasisPoints:number;suggestedMinExplorationBasisPoints:number;personalizationFields:string[]};observedAt:string};

const pct=(value:number|null|undefined,digits=1)=>value===null||value===undefined?'—':`${(value*100).toFixed(digits)}%`;
const bp=(value:number)=>`${(value/100).toFixed(2).replace(/\.00$/,'')}%`;
const money=(cents:unknown)=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(Number(cents??0)/100);
const label=(value:unknown)=>String(value??'').replaceAll('_',' ');
const lines=(value:string)=>value.split('\n').map(v=>v.trim()).filter(Boolean);
const short=(value:unknown)=>String(value??'').slice(0,12);

// Plain-language explanations for every evaluation warning (DOTS-115/116/119).
const explain:Record<string,string>={
 NO_VERIFIED_EVIDENCE:'No provider-receipted or owner-attested sends yet. Simulations and model claims are never counted, so there is nothing to compare.',
 SAMPLE_BELOW_FLOOR:'At least one arm has fewer matured verified exposures than the sample floor. Intervals are too wide to pick a winner.',
 LAG_WINDOW_OPEN:'Some exposures are still inside the outcome time-lag window; they are excluded from the comparison until it closes.',
 FEW_OUTCOME_EVENTS:'Fewer than 10 qualified responses in an arm. Rates from so few events are unstable.',
 IMBALANCED_ALLOCATION:'Enrollment counts do not match the saved allocation (sample-ratio mismatch). Investigate before trusting results.',
 EXPOSURE_RATE_DIFFERS_BY_ARM:'Arms were sent at different rates after randomization, which can bias results.',
 UNSTABLE_UPLIFT:'No arm shows uplift that survives the false-discovery correction, a positive interval and ≥95% probability of superiority. Automatic promotion is blocked.',
 COMPLAINT_LIMIT:'Spam complaints exceeded the configured limit; the experiment is stopped.',
 UNSUBSCRIBE_LIMIT:'Unsubscribes exceeded the configured limit; the experiment is stopped.',
 BUDGET_EXHAUSTED:'Verified cost reached the experiment budget; the experiment is stopped.',
 INCOMPLETE_FACTORIAL_CONFOUNDS_MODEL_AND_STRATEGY:'Not every model × strategy cell exists, so model and strategy effects are confounded.',
 SINGLE_LEVEL_FACTOR_NOT_ESTIMABLE:'Only one model or one strategy is present, so that factor\'s effect cannot be estimated.',
 SEGMENT_IMBALANCE_ACROSS_CELLS:'Segment mix differs across cells; differences may reflect audience rather than treatment.',
 SELECTION_BIAS_EXPOSURE_RATE_DIFFERS:'Cells were exposed at different rates after enrollment (possible selection bias).',
 SMALL_CELLS:'Some factorial cells have fewer than 30 matured exposures.',
};

function Badge({value}:{value:unknown}){const text=String(value??'unknown');return <span className={`ops-badge tone-${['approved','active','completed','champion'].includes(text)?'good':['rejected','stopped','retired'].includes(text)?'bad':'neutral'}`}>{label(text)}</span>;}
function Empty({title,children}:{title:string;children:ReactNode}){return <div className="ops-empty"><span aria-hidden="true">＋</span><h3>{title}</h3><p>{children}</p></div>;}
function Field({id,label:text,children,help}:{id:string;label:string;children:ReactNode;help?:string}){return <div className="ops-field"><label htmlFor={id}>{text}</label>{children}{help?<p className="ops-field-help">{help}</p>:null}</div>;}

/** Accessible interval chart: SVG bars with an equivalent text table (DOTS-119). */
function IntervalChart({arms,title}:{arms:Row[];title:string}){
 const width=320,rowHeight=28,height=arms.length*rowHeight+24,x=(v:number)=>110+v*(width-130);
 return <figure className="strategy-chart"><svg role="img" aria-labelledby={`${title}-caption`} viewBox={`0 0 ${width} ${height}`} width="100%">
  {[0,0.25,0.5,0.75,1].map(t=><g key={t}><line x1={x(t)} x2={x(t)} y1={4} y2={height-18} className="strategy-grid"/><text x={x(t)} y={height-4} textAnchor="middle" className="strategy-axis">{Math.round(t*100)}%</text></g>)}
  {arms.map((arm,i)=>{const y=10+i*rowHeight;return <g key={arm.armId}><text x={4} y={y+10} className="strategy-axis">{arm.armKey}</text>
   {arm.lower!==null&&arm.upper!==null?<rect x={x(arm.lower)} y={y+2} width={Math.max(2,x(arm.upper)-x(arm.lower))} height={12} rx={3} className={arm.role==='champion'?'strategy-ci-champion':'strategy-ci-experimental'}/>:<text x={x(0)+4} y={y+11} className="strategy-axis">no verified sample</text>}
   {arm.rate!==null?<line x1={x(arm.rate)} x2={x(arm.rate)} y1={y} y2={y+16} className="strategy-point"/>:null}</g>;})}
 </svg><figcaption id={`${title}-caption`}>{title}: 95% Wilson intervals for qualified responses per matured verified exposure.</figcaption>
 <table className="ops-table strategy-sr-table"><caption className="sr-only">{title} values</caption><thead><tr><th scope="col">Arm</th><th scope="col">Qualified / exposed</th><th scope="col">Rate</th><th scope="col">95% interval</th></tr></thead>
 <tbody>{arms.map(arm=><tr key={arm.armId}><td>{arm.armKey}</td><td>{arm.successes} / {arm.denominator}</td><td>{pct(arm.rate)}</td><td>{arm.lower===null?'—':`${pct(arm.lower)} – ${pct(arm.upper)}`}</td></tr>)}</tbody></table></figure>;
}

function Funnel({arms}:{arms:Row[]}){
 const stages=['enrolled','exposed','replies','qualified','meetings','deals','funded'];
 return <div className="ops-table-wrap"><table className="ops-table"><caption className="sr-only">Funnel by arm (verified evidence only)</caption><thead><tr><th scope="col">Funnel stage</th>{arms.map(a=><th scope="col" key={a.armId}>{a.armKey}</th>)}</tr></thead>
 <tbody>{stages.map(stage=><tr key={stage}><th scope="row">{label(stage)}</th>{arms.map(a=>{const top=Math.max(1,a.funnel.enrolled);const n=a.funnel[stage];return <td key={a.armId}><strong>{n}</strong><span className="strategy-bar" aria-hidden="true"><i style={{width:`${Math.min(100,n/top*100)}%`}}/></span><small>{stage==='enrolled'?'denominator':`${pct(a.funnel.exposed&&stage!=='exposed'?n/a.funnel.exposed:n/top)} of ${stage==='exposed'?'enrolled':'exposed'}`}</small></td>;})}</tr>)}</tbody></table></div>;
}

export function StrategyLabView(){
 const [data,setData]=useState<Snapshot|null>(null);const [error,setError]=useState('');const [notice,setNotice]=useState('');const [busy,setBusy]=useState(false);
 const load=useCallback(async()=>{try{const response=await fetch('/api/v1/strategy',{cache:'no-store'});const body=await response.json();if(!response.ok)throw new Error(body.error??'STRATEGY_LAB_UNAVAILABLE');setData(body);}catch(e){setError(e instanceof Error?e.message:'STRATEGY_LAB_UNAVAILABLE');}},[]);
 useEffect(()=>{void load();},[load]);
 async function act(action:string,payload:Row,success:string){setBusy(true);setError('');setNotice('');try{const response=await fetch('/api/v1/strategy',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,...payload})});const body=await response.json();if(!response.ok)throw new Error(body.error??'REQUEST_FAILED');setData(body.data);setNotice(success);return body.outcome;}catch(e){setError(label(e instanceof Error?e.message:'REQUEST_FAILED'));return null;}finally{setBusy(false);}}
 if(!data)return <section className="ops-console" aria-busy={!error}><h2>Strategy Lab</h2>{error?<p role="alert" className="live-error">Strategy Lab could not load: {label(error)}</p>:<p aria-live="polite">Loading Strategy Lab…</p>}</section>;
 const revisions=data.families.flatMap(f=>f.revisions.map((r:Row)=>({...r,familyLabel:f.label})));
 const approved=revisions.filter(r=>r.status==='approved');
 return <section className="ops-console strategy-lab" aria-labelledby="strategy-lab-title">
  <div className="ops-section-heading"><h2 id="strategy-lab-title">Strategy Lab</h2><small className="ops-small">Observed {new Date(data.observedAt).toLocaleString()}</small></div>
  <p className="ops-note">Only provider-receipted or owner-attested events count. Simulations and model claims are listed in provenance but excluded from every rate, interval and promotion decision.</p>
  <div aria-live="polite" className="strategy-notice">{notice}</div>{error?<p role="alert" className="live-error">{error}</p>:null}
  <Families data={data} busy={busy} act={act}/>
  <Allocations data={data} busy={busy} act={act} approved={approved}/>
  <Experiments data={data} busy={busy} act={act} approved={approved}/>
  <Promotions data={data} busy={busy} act={act} revisions={revisions}/>
  <Backlog data={data} busy={busy} act={act} approved={approved}/>
 </section>;
}
type Act=(action:string,payload:Row,success:string)=>Promise<unknown>;

function RevisionForm({prefix,initial,submit,busy,cta}:{prefix:string;initial?:Row;submit:(values:Row)=>void;busy:boolean;cta:string}){
 const [personalization,setPersonalization]=useState<string[]>(initial?.allowed_personalization??['company']);
 function onSubmit(event:FormEvent<HTMLFormElement>){event.preventDefault();const f=new FormData(event.currentTarget);submit({label:f.get('label'),objective:f.get('objective'),tone:f.get('tone'),instructions:f.get('instructions'),audienceRules:lines(String(f.get('audience')??'')),forbiddenClaims:lines(String(f.get('forbidden')??'')),disclosures:lines(String(f.get('disclosures')??'')),allowedPersonalization:personalization});}
 return <form className="ops-form" onSubmit={onSubmit}>
  {initial?null:<Field id={`${prefix}-label`} label="Family name"><input id={`${prefix}-label`} name="label" required maxLength={120}/></Field>}
  <Field id={`${prefix}-objective`} label="Objective"><input id={`${prefix}-objective`} name="objective" required maxLength={2000} defaultValue={initial?.objective}/></Field>
  <Field id={`${prefix}-tone`} label="Tone"><input id={`${prefix}-tone`} name="tone" required maxLength={200} defaultValue={initial?.tone}/></Field>
  <Field id={`${prefix}-audience`} label="Audience rules (one per line)"><textarea id={`${prefix}-audience`} name="audience" required rows={3} defaultValue={(initial?.audience_rules??[]).join('\n')}/></Field>
  <Field id={`${prefix}-forbidden`} label="Forbidden claims (one per line)"><textarea id={`${prefix}-forbidden`} name="forbidden" rows={3} defaultValue={(initial?.forbidden_claims??[]).join('\n')}/></Field>
  <Field id={`${prefix}-disclosures`} label="Required disclosures (one per line)"><textarea id={`${prefix}-disclosures`} name="disclosures" required rows={2} defaultValue={(initial?.disclosures??[]).join('\n')}/></Field>
  <Field id={`${prefix}-instructions`} label="Instructions"><textarea id={`${prefix}-instructions`} name="instructions" required rows={4} maxLength={6000} defaultValue={initial?.instructions}/></Field>
  <fieldset className="ops-multi wide"><legend>Allowed personalization fields</legend>{['first_name','company','role_title','sector','region','product_interest','recent_public_news'].map(field=><label key={field}><input type="checkbox" checked={personalization.includes(field)} onChange={e=>setPersonalization(e.target.checked?[...personalization,field]:personalization.filter(p=>p!==field))}/>{label(field)}</label>)}</fieldset>
  <div className="ops-form-actions wide"><button className="live-primary" type="submit" disabled={busy}>{cta}</button></div>
 </form>;
}

function Families({data,busy,act}:{data:Snapshot;busy:boolean;act:Act}){
 const [creating,setCreating]=useState(false);const [editing,setEditing]=useState<string|null>(null);
 return <section aria-labelledby="strategy-families"><div className="ops-section-heading"><h3 id="strategy-families">Strategy families</h3><button className="live-secondary" type="button" aria-expanded={creating} onClick={()=>setCreating(!creating)}>New strategy family</button></div>
  {creating?<div className="ops-card"><RevisionForm prefix="new-family" busy={busy} cta="Create proposed revision 1" submit={async v=>{if(await act('createFamily',v,'Strategy family created; revision 1 awaits approval.'))setCreating(false);}}/></div>:null}
  <div className="ops-card-grid">{data.families.length?data.families.map(family=>{const latest=family.revisions[0];return <article className="ops-card" key={family.id}>
   <div className="ops-card-heading"><h3>{family.label}</h3><Badge value={latest?.status}/></div>
   {latest?<><p>{latest.objective}</p><dl className="ops-card-metrics"><div><dt>Revision</dt><dd>{latest.revision} of {family.revisions.length}</dd></div><div><dt>Tone</dt><dd>{latest.tone}</dd></div><div><dt>Personalization</dt><dd>{latest.allowed_personalization.map(label).join(', ')||'None'}</dd></div><div><dt>Forbidden claims</dt><dd>{latest.forbidden_claims.join('; ')||'None listed'}</dd></div><div><dt>Disclosures</dt><dd>{latest.disclosures.join('; ')}</dd></div><div><dt>Audience</dt><dd>{latest.audience_rules.join('; ')}</dd></div></dl>
   <code className="ops-hash">Fingerprint {latest.fingerprint}</code>{latest.parents?.length?<small>Hybrid of {latest.parents.map((p:Row)=>short(p.parent_revision_id)).join(' + ')}</small>:null}</>:null}
   <details><summary>Revision history ({family.revisions.length})</summary><ul className="strategy-list">{family.revisions.map((r:Row)=><li key={r.id}>Revision {r.revision} · <Badge value={r.status}/> · {short(r.fingerprint)}{r.status==='proposed'?<span className="ops-row-actions"><button type="button" disabled={busy} onClick={()=>act('decideRevision',{revisionId:r.id,approved:true},`Revision ${r.revision} approved.`)}>Approve revision {r.revision}</button><button type="button" className="danger-text" disabled={busy} onClick={()=>act('decideRevision',{revisionId:r.id,approved:false},`Revision ${r.revision} rejected.`)}>Reject</button></span>:null}</li>)}</ul></details>
   <div className="ops-row-actions"><button type="button" aria-expanded={editing===family.id} onClick={()=>setEditing(editing===family.id?null:family.id)}>Propose new revision</button></div>
   {editing===family.id?<RevisionForm prefix={`edit-${family.id}`} initial={latest} busy={busy} cta="Propose revision (history is kept)" submit={async v=>{if(await act('proposeRevision',{familyId:family.id,...v},'New revision proposed; earlier revisions and experiments are unchanged.'))setEditing(null);}}/>:null}
  </article>;}):<Empty title="No strategies yet">Create a strategy family to define the objective, audience rules, allowed personalization, forbidden claims, tone and disclosures. Each edit becomes a new proposed revision.</Empty>}</div>
 </section>;
}

function AllocationCard({rule,data,busy,act,approved}:{rule:Row;data:Snapshot;busy:boolean;act:Act;approved:Row[]}){
 const [share,setShare]=useState<number>(rule.experimental_basis_points);const [floor,setFloor]=useState<number>(rule.min_exploration_basis_points);const [ack,setAck]=useState(rule.below_floor_acknowledgement??'');const [auto,setAuto]=useState<boolean>(rule.auto_promote_enabled);const [champion,setChampion]=useState<string>(rule.champion_revision_id??'');
 const below=share<floor,id=`rule-${rule.id}`;const scope=data.campaigns.find(c=>c.id===rule.campaign_id)?.label??data.projects.find(p=>p.id===rule.project_id)?.label??'Project';
 return <article className="ops-card"><div className="ops-card-heading"><h3>{scope}</h3><small className="ops-small">Rule v{rule.version}{rule.campaign_id?' · campaign':' · project'}</small></div>
  <div className="ops-allocation" aria-hidden="true"><span style={{width:`${(10000-share)/100}%`}}/><span style={{width:`${share/100}%`}}/></div>
  <p className="ops-small">Champion {bp(10000-share)} · Experimental {bp(share)}</p>
  <form className="ops-form" onSubmit={event=>{event.preventDefault();void act('saveAllocation',{projectId:rule.project_id,campaignId:rule.campaign_id??undefined,experimentalBasisPoints:share,minExplorationBasisPoints:floor,belowFloorAcknowledgement:below?ack:undefined,autoPromoteEnabled:auto,championRevisionId:rule.champion_revision_id?undefined:(champion||undefined),expectedVersion:Number(rule.version)},'Allocation saved; new enrollments use this split.');}}>
   <Field id={`${id}-slider`} label="Experimental share slider"><input id={`${id}-slider`} type="range" min={0} max={10000} step={100} value={share} onChange={e=>setShare(Number(e.target.value))} aria-valuetext={`${bp(share)} experimental`}/></Field>
   <Field id={`${id}-exact`} label="Exact experimental share (basis points, 100 = 1%)"><input id={`${id}-exact`} type="number" min={0} max={10000} step={1} value={share} onChange={e=>setShare(Math.max(0,Math.min(10000,Math.round(Number(e.target.value)||0))))}/></Field>
   <Field id={`${id}-floor`} label="Minimum exploration floor (basis points)" help="Going below the floor needs a recorded acknowledgement."><input id={`${id}-floor`} type="number" min={0} max={5000} step={1} value={floor} onChange={e=>setFloor(Math.max(0,Math.min(5000,Math.round(Number(e.target.value)||0))))}/></Field>
   {rule.champion_revision_id?<p className="ops-small">Champion: {short(rule.champion_revision_id)} (change it through promotion)</p>:<Field id={`${id}-champion`} label="Initial champion revision"><select id={`${id}-champion`} value={champion} onChange={e=>setChampion(e.target.value)}><option value="">None yet</option>{approved.map(r=><option key={r.id} value={r.id}>{r.familyLabel} · r{r.revision}</option>)}</select></Field>}
   <label className="strategy-check"><input type="checkbox" checked={auto} onChange={e=>setAuto(e.target.checked)}/>Allow guarded automatic promotion (only stable, verified uplift)</label>
   {below?<div className="wide" role="alert"><p className="ops-note">Warning: {bp(share)} is below the {bp(floor)} exploration floor. New strategies will rarely be tested.</p><Field id={`${id}-ack`} label="Acknowledgement (recorded in the audit history)"><textarea id={`${id}-ack`} name="belowFloorAcknowledgement" required rows={2} value={ack} onChange={e=>setAck(e.target.value)}/></Field></div>:null}
   <div className="ops-form-actions wide"><button className="live-primary" type="submit" disabled={busy||(below&&!ack.trim())}>Save allocation</button></div>
  </form>
  <details><summary>Allocation history</summary><ul className="strategy-list">{rule.history.map((h:Row)=><li key={h.id}>v{h.version}: {bp(h.experimental_basis_points)} experimental, floor {bp(h.min_exploration_basis_points)}{h.below_floor?` · below floor acknowledged: “${h.below_floor_acknowledgement}”`:''}</li>)}</ul></details>
 </article>;
}
function Allocations({data,busy,act,approved}:{data:Snapshot;busy:boolean;act:Act;approved:Row[]}){
 const [project,setProject]=useState('');const [campaign,setCampaign]=useState('');
 return <section aria-labelledby="strategy-allocation"><div className="ops-section-heading"><h3 id="strategy-allocation">Allocation rules</h3></div>
  <form className="ops-inline-tools" onSubmit={e=>{e.preventDefault();void act('saveAllocation',{projectId:project,campaignId:campaign||undefined},`Allocation rule created with the suggested ${bp(data.defaults.suggestedExperimentalBasisPoints)} experimental share; adjust and save.`);}}>
   <label htmlFor="new-rule-project">Project</label><select id="new-rule-project" required value={project} onChange={e=>setProject(e.target.value)}><option value="">Choose…</option>{data.projects.map(p=><option key={p.id} value={p.id}>{p.label}</option>)}</select>
   <label htmlFor="new-rule-campaign">Campaign</label><select id="new-rule-campaign" value={campaign} onChange={e=>setCampaign(e.target.value)}><option value="">Whole project</option>{data.campaigns.filter(c=>c.project_id===project).map(c=><option key={c.id} value={c.id}>{c.label}</option>)}</select>
   <button className="live-secondary" type="submit" disabled={busy||!project}>Add allocation rule</button></form>
  <div className="ops-card-grid">{data.rules.length?data.rules.map(rule=><AllocationCard key={`${rule.id}:${rule.version}`} rule={rule} data={data} busy={busy} act={act} approved={approved}/>):<Empty title="No allocation rules">Add a rule for a project or campaign. The suggested split is stored on the rule and can be changed with the slider or exact input.</Empty>}</div>
 </section>;
}

function ExperimentCard({report,busy,act}:{report:Row;busy:boolean;act:Act}){
 const ex=report.experiment,evaluation=report.evaluation,[rationale,setRationale]=useState(''),[ack,setAck]=useState(''),[target,setTarget]=useState<string>(report.arms.find((a:Row)=>a.role==='experimental')?.armId??'');
 const comparison=evaluation.comparisons.find((c:Row)=>c.armId===target);const enrolledTotal=report.arms.reduce((s:number,a:Row)=>s+a.funnel.enrolled,0);
 return <article className="ops-card strategy-experiment"><div className="ops-card-heading"><h3>{ex.label} · r{ex.revision}</h3><Badge value={ex.state}/></div>
  <small>Design {ex.design} · floor {ex.min_sample_per_arm}/arm · lag {ex.lag_days} days · α {ex.alpha_basis_points/100}% · budget {money(ex.budget_cents)}{ex.stop_reason?` · stopped: ${label(ex.stop_reason)}`:''}</small>
  <code className="ops-hash">Design fingerprint {ex.fingerprint}</code>
  <h4>Arms (enrolled share vs saved allocation)</h4>
  <ul className="strategy-list">{report.arms.map((a:Row)=><li key={a.armId}><strong>{a.armKey}</strong> <Badge value={a.role}/>{a.modelId?` · model ${a.modelId}`:''} · {a.funnel.enrolled} enrolled ({enrolledTotal?pct(a.funnel.enrolled/enrolledTotal):'—'})<span className="strategy-bar" aria-hidden="true"><i style={{width:`${enrolledTotal?a.funnel.enrolled/enrolledTotal*100:0}%`}}/></span></li>)}</ul>
  {enrolledTotal===0?<Empty title="No enrollments yet">Eligible contacts are enrolled once per experiment revision by the seeded, stratified allocator. Results appear after verified sends.</Empty>:null}
  <IntervalChart arms={evaluation.arms} title={`interval-${ex.id}`}/>
  {evaluation.warnings.length?<ul className="strategy-warnings" aria-label="Evaluation warnings">{evaluation.warnings.map((w:string)=><li key={w}><strong>{label(w)}</strong>: {explain[w]??'Review before acting.'}</li>)}</ul>:<p className="ops-small">No guardrail warnings.</p>}
  {evaluation.comparisons.map((c:Row)=><p className="ops-small" key={c.armId}>{c.armKey} vs champion: difference {c.difference===null?'—':pct(c.difference,2)} (95% CI {c.lower===null?'—':`${pct(c.lower,2)} to ${pct(c.upper,2)}`}), p={c.pValue===null?'—':c.pValue.toFixed(4)}, BH {c.bhSignificant?'significant':'not significant'}, P(superior)={c.probabilityOfSuperiority===null?'—':pct(c.probabilityOfSuperiority)}</p>)}
  <h4>Funnel</h4><Funnel arms={report.arms}/>
  <h4>Actual vs estimated</h4><div className="ops-table-wrap"><table className="ops-table"><caption className="sr-only">Money by arm</caption><thead><tr><th scope="col">Arm</th><th scope="col">Funds received (actual)</th><th scope="col">Converted from other currency</th><th scope="col">Cost (actual)</th><th scope="col">Margin per qualified</th><th scope="col">Pipeline (estimated)</th><th scope="col">Excluded events</th></tr></thead>
  <tbody>{report.arms.map((a:Row)=><tr key={a.armId}><td>{a.armKey}</td><td>{money(a.actual.fundsCents)}</td><td>{money(a.actual.convertedFundsCents)}</td><td>{money(a.actual.costCents)}<small>est. {money(a.estimated.costCents)}</small></td><td>{a.actual.marginPerQualifiedCents===null?'— (no qualified responses)':money(a.actual.marginPerQualifiedCents)}<small>÷ {a.funnel.qualified} qualified</small></td><td>{money(a.estimated.dealPipelineCents)}</td><td>{a.excluded.simulationEvents} simulated · {a.excluded.modelClaimEvents} model claims</td></tr>)}</tbody></table></div>
  {report.factorial?<><h4>Model × strategy</h4><p className="ops-small">{report.factorial.decisionNote}</p><ul className="strategy-list">{report.factorial.strategyEffects.map((s:Row)=><li key={s.strategyRevisionId}>Strategy {short(s.strategyRevisionId)}: {pct(s.rate)} of {s.denominator}</li>)}{report.factorial.modelEffects.map((m:Row)=><li key={m.modelId}>Model {m.modelId}: {pct(m.rate)} of {m.denominator}, cost/exposure {m.costPerExposureCents===null?'—':money(m.costPerExposureCents)}</li>)}</ul>{report.factorial.warnings.length?<ul className="strategy-warnings">{report.factorial.warnings.map((w:string)=><li key={w}><strong>{label(w)}</strong>: {explain[w]??''}</li>)}</ul>:null}</>:null}
  <details><summary>Provenance drilldown ({report.provenance.length} latest events)</summary>{report.provenance.length?<div className="ops-table-wrap"><table className="ops-table"><caption className="sr-only">Outcome evidence</caption><thead><tr><th scope="col">Event</th><th scope="col">Arm</th><th scope="col">Source</th><th scope="col">Counted</th><th scope="col">Evidence</th></tr></thead><tbody>{report.provenance.map((p:Row)=><tr key={p.id}><td>{label(p.kind)}{Number(p.amount_cents)?<small>{money(p.amount_cents)}{p.is_estimate?' estimate':''}{p.original_currency!=='USD'?` from ${p.original_currency}`:''}</small>:null}<small>{new Date(p.occurred_at).toLocaleString()}</small></td><td>{p.arm_key}</td><td>{label(p.evidence_source)}</td><td>{p.counted?'Yes':'No — excluded'}</td><td>{p.receipt_provider?`${p.receipt_provider} receipt ${p.receipt_event_id}`:p.evidence_ref??'—'}</td></tr>)}</tbody></table></div>:<p className="ops-small">No outcome events recorded yet.</p>}</details>
  {['active','paused'].includes(ex.state)?<>
   <div className="ops-row-actions">{ex.state==='active'?<button type="button" disabled={busy} onClick={()=>act('setExperimentState',{experimentId:ex.id,state:'paused'},'Experiment paused.')}>Pause enrollment</button>:<button type="button" disabled={busy} onClick={()=>act('setExperimentState',{experimentId:ex.id,state:'active'},'Experiment resumed.')}>Resume</button>}<button type="button" className="danger-text" disabled={busy} onClick={()=>act('setExperimentState',{experimentId:ex.id,state:'stopped',reason:'Owner stopped'},'Experiment stopped.')}>Stop experiment</button></div>
   <form className="ops-form" onSubmit={e=>{e.preventDefault();void act('promote',{experimentId:ex.id,armId:target,rationale,acknowledgeUncertainty:ack||undefined,mode:'manual'},'Champion promoted; rollback is available under Promotions.');}}>
    <Field id={`promote-arm-${ex.id}`} label="Arm to promote"><select id={`promote-arm-${ex.id}`} value={target} onChange={e=>setTarget(e.target.value)}>{report.arms.filter((a:Row)=>a.role==='experimental').map((a:Row)=><option key={a.armId} value={a.armId}>{a.armKey}</option>)}</select></Field>
    <Field id={`promote-rationale-${ex.id}`} label="Rationale"><input id={`promote-rationale-${ex.id}`} required value={rationale} onChange={e=>setRationale(e.target.value)}/></Field>
    {comparison&&!comparison.stableUplift?<Field id={`promote-ack-${ex.id}`} label="Uncertainty acknowledgement (required: uplift is not stable)"><textarea id={`promote-ack-${ex.id}`} rows={2} required value={ack} onChange={e=>setAck(e.target.value)}/></Field>:null}
    <div className="ops-form-actions wide"><button className="live-primary" type="submit" disabled={busy||!evaluation.manualPromotionAllowed}>{evaluation.manualPromotionAllowed?'Promote to champion':'Promotion blocked by guardrails'}</button></div>
   </form></>:null}
 </article>;
}
function Experiments({data,busy,act,approved}:{data:Snapshot;busy:boolean;act:Act;approved:Row[]}){
 const [open,setOpen]=useState(false);
 function submit(event:FormEvent<HTMLFormElement>){event.preventDefault();const f=new FormData(event.currentTarget);const rule=data.rules.find(r=>r.id===f.get('rule'));
  void act('createExperiment',{allocationRuleId:f.get('rule'),label:f.get('label'),arms:[{key:'champion',role:'champion',strategyRevisionId:rule?.champion_revision_id??f.get('champion')},{key:'challenger',role:'experimental',strategyRevisionId:f.get('challenger')}],minSamplePerArm:Number(f.get('floor')),lagDays:Number(f.get('lag')),budgetCents:0},'Experiment created with a fresh seed.').then(r=>{if(r)setOpen(false);});}
 return <section aria-labelledby="strategy-experiments"><div className="ops-section-heading"><h3 id="strategy-experiments">Experiments</h3><button className="live-secondary" type="button" aria-expanded={open} onClick={()=>setOpen(!open)}>New experiment</button></div>
  {open?<form className="ops-card ops-form" onSubmit={submit}>
   <Field id="exp-rule" label="Allocation rule"><select id="exp-rule" name="rule" required>{data.rules.map(r=><option key={r.id} value={r.id}>{data.campaigns.find(c=>c.id===r.campaign_id)?.label??data.projects.find(p=>p.id===r.project_id)?.label} · {bp(r.experimental_basis_points)} experimental</option>)}</select></Field>
   <Field id="exp-label" label="Experiment name"><input id="exp-label" name="label" required maxLength={160}/></Field>
   <Field id="exp-champion" label="Champion revision (used when the rule has none)"><select id="exp-champion" name="champion">{approved.map(r=><option key={r.id} value={r.id}>{r.familyLabel} · r{r.revision}</option>)}</select></Field>
   <Field id="exp-challenger" label="Experimental revision"><select id="exp-challenger" name="challenger" required>{approved.map(r=><option key={r.id} value={r.id}>{r.familyLabel} · r{r.revision}</option>)}</select></Field>
   <Field id="exp-floor" label="Sample floor per arm"><input id="exp-floor" name="floor" type="number" min={30} defaultValue={200}/></Field>
   <Field id="exp-lag" label="Outcome lag window (days)"><input id="exp-lag" name="lag" type="number" min={0} max={365} defaultValue={14}/></Field>
   <p className="ops-field-help wide">Budget starts at $0: any verified cost stops the experiment until the owner funds a new revision.</p>
   <div className="ops-form-actions wide"><button className="live-primary" type="submit" disabled={busy||!data.rules.length||approved.length<2}>Create experiment</button></div></form>:null}
  <div className="ops-card-grid strategy-single">{data.reports.length?data.reports.map(r=><ExperimentCard key={r.experiment.id} report={r} busy={busy} act={act}/>):<Empty title="No experiments yet">Approve at least two strategy revisions and save an allocation rule. Results stay empty until verified sends exist; nothing is estimated in their place.</Empty>}</div>
 </section>;
}
function Promotions({data,busy,act,revisions}:{data:Snapshot;busy:boolean;act:Act;revisions:Row[]}){
 const name=(id:string|null)=>{const r=revisions.find(x=>x.id===id);return r?`${r.familyLabel} r${r.revision}`:id?short(id):'none';};const rolled=new Set(data.promotions.map(p=>p.reverts_promotion_id).filter(Boolean));
 return <section aria-labelledby="strategy-promotions"><div className="ops-section-heading"><h3 id="strategy-promotions">Promotions and rollbacks</h3></div>
  {data.promotions.length?<div className="ops-table-wrap"><table className="ops-table"><caption className="sr-only">Promotion audit trail</caption><thead><tr><th scope="col">When</th><th scope="col">Mode</th><th scope="col">From → to</th><th scope="col">Fingerprints</th><th scope="col">Rationale</th><th scope="col">Action</th></tr></thead><tbody>{data.promotions.map(p=><tr key={p.id}><td>{new Date(p.created_at).toLocaleString()}</td><td><Badge value={p.mode}/>{p.uncertainty_acknowledged?<small>uncertainty acknowledged</small>:null}</td><td>{name(p.from_revision_id)} → {name(p.to_revision_id)}</td><td><small>{short(p.from_fingerprint)} → {short(p.to_fingerprint)}</small></td><td>{p.rationale}</td><td>{p.mode!=='rollback'&&!rolled.has(p.id)?<div className="ops-row-actions"><button type="button" className="danger-text" disabled={busy} onClick={()=>act('rollback',{promotionId:p.id,rationale:'Owner rollback from Strategy Lab'},'Previous champion restored.')}>Roll back</button></div>:'—'}</td></tr>)}</tbody></table></div>:<Empty title="No promotions">Promotions need verified evidence that meets the sample floor, lag window and safety limits. Every promotion records fingerprints and can be rolled back.</Empty>}
 </section>;
}
function Backlog({data,busy,act,approved}:{data:Snapshot;busy:boolean;act:Act;approved:Row[]}){
 const [parents,setParents]=useState<string[]>([]);const [family,setFamily]=useState('');
 function submit(event:FormEvent<HTMLFormElement>){event.preventDefault();const f=new FormData(event.currentTarget);const base=approved.find(r=>r.id===parents[0]);if(!base)return;
  void act('createHybrid',{familyId:family,parents:parents.map(id=>({revisionId:id})),objective:f.get('objective'),tone:base.tone,instructions:f.get('instructions'),audienceRules:base.audience_rules,forbiddenClaims:[...new Set(approved.filter(r=>parents.includes(r.id)).flatMap(r=>r.forbidden_claims))],disclosures:base.disclosures,allowedPersonalization:base.allowed_personalization},'Hybrid proposed; it must be approved and win its own experiment before replacing a champion.');}
 return <section aria-labelledby="strategy-backlog"><div className="ops-section-heading"><h3 id="strategy-backlog">Hybrids and new-variant backlog</h3></div>
  <form className="ops-card ops-form" onSubmit={submit}>
   <Field id="hybrid-family" label="Family for the hybrid"><select id="hybrid-family" required value={family} onChange={e=>setFamily(e.target.value)}><option value="">Choose…</option>{data.families.map(f=><option key={f.id} value={f.id}>{f.label}</option>)}</select></Field>
   <fieldset className="ops-multi"><legend>Parent revisions</legend>{approved.length?approved.map(r=><label key={r.id}><input type="checkbox" checked={parents.includes(r.id)} onChange={e=>setParents(e.target.checked?[...parents,r.id]:parents.filter(p=>p!==r.id))}/>{r.familyLabel} r{r.revision}</label>):<p>No approved revisions yet.</p>}</fieldset>
   <Field id="hybrid-objective" label="Hybrid objective"><input id="hybrid-objective" name="objective" required/></Field>
   <Field id="hybrid-instructions" label="Hybrid instructions"><textarea id="hybrid-instructions" name="instructions" required rows={3}/></Field>
   <div className="ops-form-actions wide"><button className="live-secondary" type="submit" disabled={busy||!parents.length||!family}>Propose hybrid</button></div></form>
  {data.backlog.length?<ul className="strategy-list">{data.backlog.map(item=><li key={item.id}><strong>{item.title}</strong> <Badge value={item.status}/> — {item.hypothesis}</li>)}</ul>:<p className="ops-small">The backlog is empty. Add hypotheses here; queued variants are evaluated through the reserved exploration share.</p>}
 </section>;
}
