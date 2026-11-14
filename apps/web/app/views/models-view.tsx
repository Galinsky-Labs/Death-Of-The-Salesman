"use client";
/**
 * Models view (DOTS-055…069). Navigation label: "Models".
 * Shows the reviewed provider manifest, credential presence (names only — keys are configured as deployment
 * secrets, never typed into the browser), privacy ceilings, cost status, reviewed revisions, per-agent routing
 * weights, breaker health, usage reconciliation, quarantined output and the fixture benchmark / smoke gate.
 * No number here is invented: empty states say which evidence is missing.
 */
import {useCallback,useEffect,useState,type FormEvent,type ReactNode} from 'react';
import '../operations.css';

type Row=Record<string,any>;
type Snapshot={providers:Row[];revisions:Row[];pricing:Row[];agents:Row[];weights:Row[];breakers:Row[];executions:Row[];outputs:Row[];invoices:Row[];reconciliation:Row;controls:Row;smoke:Row;manifest:Row;observedAt:string};
const providerIds=['openai','claude','grok','openrouter'] as const;
const money=(cents:unknown)=>`$${(Number(cents??0)/100).toFixed(2)}`;
const label=(value:string)=>value.replaceAll('_',' ');
function Badge({value,good}:{value:string;good?:boolean}){return <span className={`ops-badge ${good===undefined?'':good?'tone-good':'tone-bad'}`}>{label(value)}</span>;}
function Section({title,tag,children}:{title:string;tag?:string;children:ReactNode}){return <section aria-label={title}><div className="ops-section-heading"><h3>{title}</h3>{tag&&<span className="category-tag">{tag}</span>}</div>{children}</section>;}
function Empty({title,children}:{title:string;children:ReactNode}){return <div className="ops-empty"><h3>{title}</h3><p>{children}</p></div>;}

export function ModelsView(){
 const [data,setData]=useState<Snapshot|null>(null);const [error,setError]=useState<string|null>(null);const [notice,setNotice]=useState('');const [busy,setBusy]=useState(false);
 const [outcome,setOutcome]=useState<Row|null>(null);const [weights,setWeights]=useState<Record<string,string>>({});
 const load=useCallback(async()=>{try{const response=await fetch('/api/v1/models',{cache:'no-store'});const body=await response.json();if(!response.ok)throw new Error(body.error??'MODELS_UNAVAILABLE');setData(body);setError(null);}catch(e){setError((e as Error).message);}},[]);
 useEffect(()=>{void load();},[load]);
 async function act(action:string,payload:Row={},message='Saved.'){
  setBusy(true);setError(null);setNotice('');
  try{const response=await fetch('/api/v1/models',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,...payload})});const body=await response.json();if(!response.ok)throw new Error(body.error??'REQUEST_FAILED');setData(body.data);setOutcome(body.outcome?{action,...body.outcome}:null);setNotice(message);}
  catch(e){setError((e as Error).message);}finally{setBusy(false);}
 }
 function form(action:string,message:string,transform:(values:Row)=>Row=v=>v){return (event:FormEvent<HTMLFormElement>)=>{event.preventDefault();const values=Object.fromEntries(new FormData(event.currentTarget).entries());void act(action,transform(values),message);};}
 const weightKey=(agentId:string,provider:string)=>`${agentId}:${provider}`;
 const currentWeight=(agentId:string,provider:string)=>weights[weightKey(agentId,provider)]??String(data?.weights.find(w=>w.agent_identity_id===agentId&&w.provider_id===provider)?.weight??0);
 const rec=data?.reconciliation;
 return <section className="ops-console" aria-label="Models workspace">
  <div className="ops-toolbar"><div><span className="ops-source"><i/>Reviewed model providers</span><p className="muted">Only OpenAI, Anthropic Claude, xAI Grok and the pinned free Gemma route are approved. Everything stays disabled until the owner provides keys and a funded cap.</p></div>
   <button className="live-secondary" type="button" onClick={()=>void load()} disabled={busy}>Refresh</button></div>
  <p aria-live="polite" className="ops-note">{notice}</p>
  {error&&<p role="alert" className="live-error">{error}</p>}
  {!data&&!error&&<p className="ops-note">Loading model catalog…</p>}
  {data&&<>
   <div className="ops-stat-grid">{[
    ['Paid execution',data.controls.paidExecutionAuthorized?'Authorized':'Not authorized','Requires MODEL_API_ENABLED, OWNER_SPEND_AUTHORIZATION_ID and PAID_SPEND_LIMIT_CENTS'],
    ['Free route',data.controls.freeModelEnabled?'Enabled':'Disabled','Public data only, $0, no fallback'],
    ['Hard spend cap',money(data.controls.hardCapCents),'Owner-configured deployment limit'],
    ['Live smoke gate',data.smoke.ready?'Ready':'Blocked',data.smoke.ready?'Owner flags and caps present':'Blocked on external prerequisite'],
   ].map(([title,value,help])=><article className="ops-card" key={title}><h3>{title}</h3><strong className="ops-large-number">{value}</strong><p className="ops-small">{help}</p></article>)}</div>

   <Section title="Provider catalog" tag={`MANIFEST v${data.manifest.version}`}>
    <div className="ops-card-grid">{data.providers.map(p=><article className="ops-card" key={p.id}>
     <div className="ops-card-heading"><span className="category-tag">{p.billing==='free'?'FREE ROUTE':'PAID API'}</span><Badge value={p.state} good={p.state==='ready'}/></div>
     <h3>{p.label}</h3><p className="ops-small">{p.approvedOrigin} · {p.endpointHost}</p>
     <dl className="ops-card-metrics">
      <div><dt>Credential</dt><dd>{p.credential.present?`${p.credential.name} present`:`Missing ${p.credential.name}`}</dd></div>
      <div><dt>Model</dt><dd>{p.configuredModel??'Not configured'}</dd></div>
      <div><dt>Privacy ceiling</dt><dd>{p.privacyCeiling}</dd></div>
      <div><dt>Cost status</dt><dd data-cost-status={p.costStatus}>{label(p.costStatus)}</dd></div>
      <div><dt>Tools</dt><dd>{p.capabilities.tools?'Supported':'Not supported'}</dd></div>
      <div><dt>Structured output</dt><dd>{label(p.capabilities.structuredOutput)}</dd></div>
     </dl>
     {p.reasons.length>0&&<ul aria-label={`${p.label} blockers`}>{p.reasons.map((reason:string)=><li key={reason}><code>{reason}</code></li>)}</ul>}
     <p className="ops-small">{p.notes}</p>
    </article>)}</div>
    <p className="ops-note">Keys are added only as deployment secrets (environment variables named above). This page never accepts or displays key values.</p>
   </Section>

   <Section title="Reviewed revisions" tag="APPEND-ONLY">
    {data.revisions.length?<div className="ops-table-wrap"><table className="ops-table"><thead><tr><th>Provider</th><th>Model</th><th>Revision</th><th>Status</th><th>Privacy</th><th>Review</th></tr></thead><tbody>{data.revisions.map(r=><tr key={r.id}><td>{r.provider_id}</td><td><code>{r.model_id}</code></td><td>{r.revision}</td><td><Badge value={r.status} good={r.status==='approved'}/></td><td>{r.privacy_class}</td><td>{r.review_ref}</td></tr>)}</tbody></table></div>
     :<Empty title="No reviewed models">A model cannot be routed until an owner records a security review for its exact provider and model id.</Empty>}
    <form className="ops-form" onSubmit={form('registerRevision','Revision recorded.')}>
     <div className="ops-field"><label htmlFor="rev-provider">Provider</label><select id="rev-provider" name="provider" defaultValue="openai">{providerIds.map(id=><option key={id} value={id}>{id}</option>)}</select></div>
     <div className="ops-field"><label htmlFor="rev-model">Exact model id</label><input id="rev-model" name="model" required maxLength={200}/></div>
     <div className="ops-field"><label htmlFor="rev-status">Decision</label><select id="rev-status" name="status" defaultValue="approved"><option value="approved">Approved</option><option value="retired">Retired</option><option value="denied">Denied</option></select></div>
     <div className="ops-field"><label htmlFor="rev-privacy">Privacy class</label><select id="rev-privacy" name="privacyClass" defaultValue="internal"><option value="public">Public</option><option value="internal">Internal</option><option value="private">Private</option></select></div>
     <div className="ops-field"><label htmlFor="rev-ref">Review reference</label><input id="rev-ref" name="reviewRef" required maxLength={240}/></div>
     <div className="ops-form-actions"><button className="live-primary" disabled={busy}>Record revision</button></div>
    </form>
   </Section>

   <Section title="Routing weights" tag="PER AGENT">
    {data.agents.length?<div className="ops-table-wrap"><table className="ops-table"><thead><tr><th>Agent</th>{providerIds.map(id=><th key={id}>{id}</th>)}</tr></thead><tbody>{data.agents.map(a=><tr key={a.id}><td><strong>{a.display_name}</strong></td>{providerIds.map(id=><td key={id}>
     <label className="sr-only" htmlFor={`w-${a.id}-${id}`}>{`${a.display_name} weight for ${id}`}</label>
     <input id={`w-${a.id}-${id}`} type="number" min={0} max={100} step={1} value={currentWeight(a.id,id)} onChange={event=>setWeights({...weights,[weightKey(a.id,id)]:event.target.value})}/>
     <button className="live-secondary" type="button" disabled={busy} onClick={()=>void act('setRoutingWeight',{agentId:a.id,provider:id,weight:Number(currentWeight(a.id,id))},'Routing weight saved.')}>Save</button>
    </td>)}</tr>)}</tbody></table></div>:<Empty title="No agents">Create an agent before assigning routing weights. New tenants start without agent instances.</Empty>}
    <p className="ops-note">Weight 0 disables a provider for that agent. Routing also requires an approved revision, a credential, privacy permission and remaining budget.</p>
   </Section>

   <Section title="Health and circuit breakers">
    {data.breakers.length?<div className="ops-table-wrap"><table className="ops-table"><thead><tr><th>Provider</th><th>Model</th><th>State</th><th>Failures</th><th>Retry after</th><th>Last reason</th><th>Action</th></tr></thead><tbody>{data.breakers.map(b=><tr key={`${b.provider_id}:${b.model_id}`}><td>{b.provider_id}</td><td><code>{b.model_id}</code></td><td><Badge value={b.state} good={b.state==='closed'}/></td><td>{b.consecutive_failures}</td><td>{b.retry_at??'—'}</td><td>{b.last_reason??'—'}</td><td><button className="live-secondary" type="button" disabled={busy} onClick={()=>void act('resetBreaker',{provider:b.provider_id,model:b.model_id},'Breaker reset.')}>Reset</button></td></tr>)}</tbody></table></div>
     :<Empty title="No provider calls recorded">Breaker health appears after the first real or failed provider call. No call has been made.</Empty>}
   </Section>

   <Section title="Usage and reconciliation" tag="LEDGER">
    {rec&&rec.usageRecords>0?<div className="ops-stat-grid">{[
     ['Provider-reported usage',money(rec.providerReportedCents)],['Ledger',money(rec.ledgerCents)],['Estimated usage',`${rec.estimated.count} · ${money(rec.estimated.cents)}`],['Missing usage',String(rec.missingUsage.count)],['Mismatches',String(rec.mismatched.length+rec.ledgerWithoutUsage.length)],['Status',rec.reconciled?'Reconciled':'Needs review'],
    ].map(([title,value])=><article className="ops-card" key={title}><h3>{title}</h3><strong className="ops-large-number">{value}</strong></article>)}</div>
     :<Empty title="No metered usage">No model usage has been recorded, so there is nothing to reconcile.</Empty>}
    {data.pricing.length>0&&<div className="ops-table-wrap"><table className="ops-table"><thead><tr><th>Provider</th><th>Model</th><th>Version</th><th>Input ¢/M</th><th>Output ¢/M</th><th>Cached ¢/M</th><th>Source</th></tr></thead><tbody>{data.pricing.map(p=><tr key={p.id}><td>{p.provider_id}</td><td><code>{p.model_id}</code></td><td>{p.version}</td><td>{p.input_cents_per_million}</td><td>{p.output_cents_per_million}</td><td>{p.cached_input_cents_per_million??'—'}</td><td>{p.source_ref}</td></tr>)}</tbody></table></div>}
    <form className="ops-form" onSubmit={form('recordInvoice','Invoice recorded.',v=>({...v,amountCents:Math.round(Number(v.amount)*100)}))}>
     <div className="ops-field"><label htmlFor="inv-provider">Provider</label><select id="inv-provider" name="provider" defaultValue="openai">{providerIds.map(id=><option key={id} value={id}>{id}</option>)}</select></div>
     <div className="ops-field"><label htmlFor="inv-start">Period start</label><input id="inv-start" name="periodStart" type="date" required/></div>
     <div className="ops-field"><label htmlFor="inv-end">Period end</label><input id="inv-end" name="periodEnd" type="date" required/></div>
     <div className="ops-field"><label htmlFor="inv-amount">Invoice amount (USD)</label><input id="inv-amount" name="amount" type="number" min={0} step="0.01" required/></div>
     <div className="ops-field"><label htmlFor="inv-ref">Invoice reference</label><input id="inv-ref" name="evidenceRef" required maxLength={240}/></div>
     <div className="ops-form-actions"><button className="live-primary" disabled={busy}>Record provider invoice</button></div>
    </form>
   </Section>

   <Section title="Generated output isolation" tag="QUARANTINE">
    {data.outputs.filter(o=>o.disposition==='quarantined').length?<div className="ops-card-grid">{data.outputs.filter(o=>o.disposition==='quarantined').map(o=><article className="ops-card" key={o.id}>
     <div className="ops-card-heading"><span className="category-tag">{o.content_type}</span><Badge value="quarantined" good={false}/></div>
     <p>Findings: {(o.findings as string[]).join(', ')||'none'}</p>
     <form className="ops-form" onSubmit={form('releaseOutput','Output released with recorded checks.',v=>({...v,id:o.id}))}>
      <div className="ops-field"><label htmlFor={`use-${o.id}`}>Release for</label><select id={`use-${o.id}`} name="use" defaultValue="publish"><option value="publish">Publish</option><option value="execute">Execute in isolated sandbox</option></select></div>
      <div className="ops-field"><label htmlFor={`auth-${o.id}`}>Owner authorization reference</label><input id={`auth-${o.id}`} name="authorizationRef" required maxLength={240}/></div>
      <div className="ops-field"><label htmlFor={`check-${o.id}`}>Security check reference</label><input id={`check-${o.id}`} name="securityCheckRef" required maxLength={240}/></div>
      <div className="ops-field"><label htmlFor={`sandbox-${o.id}`}>Sandbox reference (execution only)</label><input id={`sandbox-${o.id}`} name="sandboxRef" maxLength={240}/></div>
      <div className="ops-form-actions"><button className="live-secondary" type="button" disabled={busy} onClick={()=>void act('rejectOutput',{id:o.id},'Output rejected.')}>Reject</button><button className="live-primary" disabled={busy}>Release</button></div>
     </form>
    </article>)}</div>:<Empty title="Nothing quarantined">Executable, scripted or active-HTML model output appears here and cannot be published or run until released with a security check.</Empty>}
   </Section>

   <Section title="Adapter benchmark and live smoke" tag="FIXTURE EVIDENCE">
    <p className="ops-note">The benchmark replays fixed fixtures through the real adapters with stub responses. It makes no network call, spends nothing and is not a live performance measurement.</p>
    <div className="ops-row-actions"><button className="live-primary" type="button" disabled={busy} onClick={()=>void act('runBenchmark',{},'Fixture benchmark complete.')}>Run fixture benchmark</button><button className="live-secondary" type="button" disabled={busy} onClick={()=>void act('planSmoke',{},'Smoke plan refreshed.')}>Check live smoke prerequisites</button></div>
    {outcome?.action==='runBenchmark'&&<div className="ops-table-wrap"><table className="ops-table"><caption>Fixture results (stub transport, virtual clock)</caption><thead><tr><th>Provider</th><th>Model</th><th>Passed</th><th>Failed</th><th>Not applicable</th></tr></thead><tbody>{(outcome.summary as Row[]).map(s=><tr key={s.provider}><td>{s.provider}</td><td><code>{s.model}</code></td><td>{s.passed}</td><td>{s.failed}</td><td>{s.notApplicable}</td></tr>)}</tbody></table></div>}
    {data.smoke.ready?<p className="ops-note">Live smoke prerequisites are present. Run <code>node scripts/model-smoke.mjs</code> from an operator shell; results are reported with receipts, never assumed.</p>
     :<div className="ops-note"><p>Live smoke is blocked on external prerequisite (owner-funded provider account, scoped key, preapproved cap):</p><ul>{[...(data.smoke.blockers as string[]),...(data.smoke.providers as Row[]).flatMap(p=>(p.blockers as string[]).map(b=>`${p.provider}: ${b}`))].map(b=><li key={b}><code>{b}</code></li>)}</ul></div>}
   </Section>

   <Section title="Recent executions">
    {data.executions.length?<div className="ops-table-wrap"><table className="ops-table"><thead><tr><th>State</th><th>Task</th><th>Privacy</th><th>Provider</th><th>Attempts</th><th>Reason</th></tr></thead><tbody>{data.executions.map(e=><tr key={e.id}><td><Badge value={e.state} good={e.state==='succeeded'}/></td><td>{label(e.task_class)}</td><td>{e.privacy_class}</td><td>{e.provider_id??'—'}</td><td>{e.attempts}</td><td>{e.reason_code??'—'}</td></tr>)}</tbody></table></div>
     :<Empty title="No model executions">No live model request has been executed for this workspace.</Empty>}
   </Section>
   <p className="ops-small">Observed {data.observedAt}</p>
  </>}
 </section>;
}
