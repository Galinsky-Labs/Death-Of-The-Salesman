"use client";
// DOTS-039..054 agent runtime view.
// Navigation: show under "Work queue" (work items, review queue, dead letters, reconciliation) and
// "Agents" (per-agent run history, status explanation, timeline). Data comes only from /api/v1/runtime.
import {useCallback,useEffect,useState,type FormEvent} from 'react';
import '../operations.css';
import './runtime-view.css';

type Reason={code:string;detail:string;evidence:string[];at:string|null};
type TimelineEntry={at:string|null;kind:string;label:string;reason:string|null;evidence:string;workItemId:string};
type Capability={role:string;allowedTaskKinds:string[];allowedTools:string[];allowedChannels:string[];skills:string[];modelPolicy:string;paused:boolean;maxSteps:number;wallClockSeconds:number;dailyRunQuota:number;windowStartMinute:number|null;windowEndMinute:number|null;version:number};
type AgentCard={id:string;displayName:string;identityStatus:string;status:{color:'green'|'yellow'|'red';reasons:Reason[]};capability:Capability|null;assignments:{projectId:string;projectLabel:string;priority:number}[];model:string|null;strategy:string|null;counts:{runs:number;draftsProposed:number;proposalsRejected:number;sent:number};costCents:number;timeline:TimelineEntry[]};
type WorkItem={id:string;agentId:string;projectId:string;kind:string;state:string;reason:string|null;version:number;priority:number;attempts:number;maxAttempts:number;availableAt:string|null;leadKey:string|null;channel:string;updatedAt:string|null};
type Run={runId:string;workItemId:string;agentId:string;modelId:string;status:string;steps:number;maxSteps:number;checkpoints:number;contextVersion:string;costCents:number;summary:string|null;reasonCode:string|null;startedAt:string|null;endedAt:string|null};
type Snapshot={observedAt:string;policy:{paused:boolean;modelEnabled:boolean;outboundEnabled:boolean}|null;agents:AgentCard[];workItems:WorkItem[];runs:Run[];reviewQueue:{id:string;runId:string;workItemId:string;agentId:string;tool:string;input:Record<string,unknown>|null;traceId:string;createdAt:string|null}[];deadLetters:{id:string;taskId:string;reasonCode:string;attempts:number;createdAt:string|null}[];dispatches:{id:string;workItemId:string|null;actionKind:string;status:string;attempts:number;providerRef:string|null;evidence:string|null;updatedAt:string|null}[]};

const TASK_KINDS=['research','draft','simulate_campaign','follow_up','grant_draft'];
const TOOLS=['propose_draft','propose_crm_note','propose_stage_change','request_owner_review'];
const CHANNELS=['none','crm','email'];
const when=(value:string|null)=>value?new Date(value).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit',second:'2-digit'}):'—';
const label=(value:string)=>value.replaceAll('_',' ').toLowerCase();
const statusText={green:'Working (live lease and heartbeat)',yellow:'Waiting',red:'Inactive'} as const;

export function RuntimeView(){
 const [data,setData]=useState<Snapshot|null>(null);
 const [error,setError]=useState<string|null>(null);
 const [notice,setNotice]=useState<string>('');
 const [busy,setBusy]=useState(false);
 const load=useCallback(async()=>{try{const response=await fetch('/api/v1/runtime',{cache:'no-store'});const body=await response.json();if(!response.ok)throw new Error(body.error??'RUNTIME_UNAVAILABLE');setData(body as Snapshot);setError(null);}catch(e){setError(e instanceof Error?e.message:'RUNTIME_UNAVAILABLE');}},[]);
 useEffect(()=>{void load();},[load]);
 async function act(payload:Record<string,unknown>,success:string){
  setBusy(true);setError(null);
  try{const response=await fetch('/api/v1/runtime',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});const body=await response.json();if(!response.ok)throw new Error(body.error??'REQUEST_FAILED');setData(body.data as Snapshot);setNotice(success);}
  catch(e){setError(e instanceof Error?e.message:'REQUEST_FAILED');}
  finally{setBusy(false);}
 }
 function enqueue(event:FormEvent<HTMLFormElement>){
  event.preventDefault();const form=new FormData(event.currentTarget);const [agentId,projectId]=String(form.get('assignment')??'').split('|');
  void act({action:'enqueueWork',agentId,projectId,kind:form.get('kind'),channel:form.get('channel'),brief:form.get('brief')||undefined,leadKey:form.get('leadKey')||undefined,skill:form.get('skill')||undefined,priority:Number(form.get('priority')??50),idempotencyKey:`ui-${Date.now()}-${Math.random().toString(36).slice(2,10)}`},'Work item queued.');
 }
 function configure(event:FormEvent<HTMLFormElement>,agent:AgentCard){
  event.preventDefault();const form=new FormData(event.currentTarget);
  const skills=String(form.get('skills')??'').split(',').map(s=>s.trim()).filter(Boolean);
  void act({action:'configureCapability',agentId:agent.id,role:form.get('role')||undefined,allowedTaskKinds:form.getAll('kinds'),allowedTools:form.getAll('tools'),allowedChannels:form.getAll('channels'),skills,paused:form.get('paused')==='on',maxSteps:Number(form.get('maxSteps')),dailyRunQuota:Number(form.get('dailyRunQuota')),expectedVersion:agent.capability?.version},`Capabilities saved for ${agent.displayName}.`);
 }
 const agentName=(id:string)=>data?.agents.find(a=>a.id===id)?.displayName??'Unknown agent';
 const assignmentOptions=(data?.agents??[]).flatMap(a=>a.assignments.map(p=>({value:`${a.id}|${p.projectId}`,label:`${a.displayName} — ${p.projectLabel}`})));
 return (
  <section className="ops-console runtime-view" aria-labelledby="runtime-heading">
   <div className="ops-section-heading">
    <h2 id="runtime-heading">Agent runtime</h2>
    <div className="ops-row-actions">
     <button type="button" className="live-secondary" onClick={()=>void load()} disabled={busy}>Refresh evidence</button>
     <button type="button" className="live-secondary" onClick={()=>void act({action:'recoverOrphans'},'Stale runs were checked and fenced where needed.')} disabled={busy}>Recover stale runs</button>
     <button type="button" className="live-primary" onClick={()=>void act({action:'runSimulation'},'One $0 simulation run was processed (or nothing was eligible).')} disabled={busy}>Run one $0 simulation</button>
    </div>
   </div>
   <p className="ops-note">Runs here use the deterministic simulation executor only: no model inference, no outbound contact and no spend. Status colours are derived from persisted leases, heartbeats and work-item records.</p>
   <div aria-live="polite" className="ops-small">{notice}</div>
   {error?<p role="alert" className="live-error">Error: {label(error)}</p>:null}
   {!data?<p className="ops-empty">{error?'Runtime evidence could not be loaded.':'Loading runtime evidence…'}</p>:<>
    <p className="ops-small">Observed {when(data.observedAt)}. Queue {data.policy?.paused?'paused by owner':'running'}; outbound {data.policy?.outboundEnabled?'enabled':'disabled'}.</p>

    <h3 className="runtime-subheading">Agents</h3>
    {data.agents.length===0?<p className="ops-empty">No agent identities exist yet. Create an approved agent and assign it to a project bucket first.</p>:
    <div className="ops-card-grid">
     {data.agents.map(agent=>(
      <article key={agent.id} className="ops-card runtime-agent" aria-labelledby={`agent-${agent.id}`}>
       <div className="ops-card-heading">
        <h4 id={`agent-${agent.id}`}>{agent.displayName}</h4>
        <span className={`ops-badge runtime-status runtime-${agent.status.color}`}><span aria-hidden="true" className="runtime-dot"/> {statusText[agent.status.color]}</span>
       </div>
       <ul className="runtime-reasons" aria-label={`Why ${agent.displayName} is ${agent.status.color}`}>
        {agent.status.reasons.map((reason,i)=>(<li key={i}><strong>{label(reason.code)}</strong> — {reason.detail}{reason.evidence.length?<> <span className="ops-hash">[{reason.evidence.join(', ')}]</span></>:null}{reason.at?<> at {when(reason.at)}</>:null}</li>))}
       </ul>
       <dl className="ops-definition">
        <dt>Model</dt><dd>{agent.model??'No run recorded'}</dd>
        <dt>Strategy</dt><dd>{agent.strategy??'None configured'}</dd>
        <dt>Runs</dt><dd>{agent.counts.runs}</dd>
        <dt>Drafts proposed</dt><dd>{agent.counts.draftsProposed}</dd>
        <dt>Rejected proposals</dt><dd>{agent.counts.proposalsRejected}</dd>
        <dt>Sent (verified)</dt><dd>{agent.counts.sent}</dd>
        <dt>Runtime cost</dt><dd>${(agent.costCents/100).toFixed(2)}</dd>
        <dt>Projects</dt><dd>{agent.assignments.length?agent.assignments.map(a=>a.projectLabel).join(', '):'Unassigned'}</dd>
       </dl>
       <details>
        <summary>Capabilities{agent.capability?` (v${agent.capability.version}${agent.capability.paused?', paused':''})`:' (not configured — all work rejected)'}</summary>
        <form className="ops-form" onSubmit={e=>configure(e,agent)}>
         <label className="ops-field">Role<input name="role" defaultValue={agent.capability?.role??'sales_strategist'} pattern="[a-z][a-z0-9_]{1,59}"/></label>
         <fieldset className="ops-field"><legend>Task kinds</legend>{TASK_KINDS.map(k=><label key={k}><input type="checkbox" name="kinds" value={k} defaultChecked={agent.capability?.allowedTaskKinds.includes(k)}/> {label(k)}</label>)}</fieldset>
         <fieldset className="ops-field"><legend>Tools (proposals only)</legend>{TOOLS.map(k=><label key={k}><input type="checkbox" name="tools" value={k} defaultChecked={agent.capability?.allowedTools.includes(k)}/> {label(k)}</label>)}</fieldset>
         <fieldset className="ops-field"><legend>Channels</legend>{CHANNELS.map(k=><label key={k}><input type="checkbox" name="channels" value={k} defaultChecked={agent.capability?agent.capability.allowedChannels.includes(k):k==='none'}/> {k}</label>)}</fieldset>
         <label className="ops-field">Skills (comma separated)<input name="skills" defaultValue={agent.capability?.skills.join(', ')??''}/></label>
         <label className="ops-field">Max steps per run<input name="maxSteps" type="number" min={1} max={20} defaultValue={agent.capability?.maxSteps??4}/></label>
         <label className="ops-field">Daily run quota<input name="dailyRunQuota" type="number" min={1} max={500} defaultValue={agent.capability?.dailyRunQuota??20}/></label>
         <label><input type="checkbox" name="paused" defaultChecked={agent.capability?.paused??true}/> Paused</label>
         <p className="ops-field-help">Model policy: {agent.capability?.modelPolicy??'simulation_only'}. Runtime runs are $0 simulation only.</p>
         <div className="ops-form-actions"><button className="live-primary" type="submit" disabled={busy}>Save capabilities</button></div>
        </form>
       </details>
       <h5>Timeline</h5>
       {agent.timeline.length===0?<p className="ops-empty">No persisted transitions or runs yet.</p>:
       <ol className="ops-timeline">{agent.timeline.map((t,i)=>(<li key={i}><time dateTime={t.at??undefined}>{when(t.at)}</time> {t.label}{t.reason?` — ${label(t.reason)}`:''} <span className="ops-hash">{t.evidence}</span></li>))}</ol>}
      </article>))}
    </div>}

    <h3 className="runtime-subheading">Work queue</h3>
    <form className="ops-form runtime-enqueue" onSubmit={enqueue} aria-label="Queue synthetic work">
     <label className="ops-field">Agent and project<select name="assignment" required>{assignmentOptions.length?assignmentOptions.map(o=><option key={o.value} value={o.value}>{o.label}</option>):<option value="">No assignments</option>}</select></label>
     <label className="ops-field">Kind<select name="kind">{TASK_KINDS.map(k=><option key={k} value={k}>{label(k)}</option>)}</select></label>
     <label className="ops-field">Channel<select name="channel">{CHANNELS.map(k=><option key={k} value={k}>{k}</option>)}</select></label>
     <label className="ops-field">Lead key (optional)<input name="leadKey" placeholder="contact:ID"/></label>
     <label className="ops-field">Required skill (optional)<input name="skill"/></label>
     <label className="ops-field">Priority<input name="priority" type="number" min={0} max={100} defaultValue={50}/></label>
     <label className="ops-field">Brief (treated as untrusted data)<textarea name="brief" maxLength={6000} rows={3}/></label>
     <div className="ops-form-actions"><button className="live-primary" type="submit" disabled={busy||!assignmentOptions.length}>Queue work</button></div>
    </form>
    {data.workItems.length===0?<p className="ops-empty">No work items. Queue work for an assigned agent with configured capabilities.</p>:
    <div className="ops-table-wrap"><table className="ops-table"><caption className="ops-small">Most recent 200 work items</caption><thead><tr><th scope="col">Agent</th><th scope="col">Kind</th><th scope="col">State</th><th scope="col">Reason</th><th scope="col">Attempts</th><th scope="col">Updated</th><th scope="col">Actions</th></tr></thead>
     <tbody>{data.workItems.map(w=>(<tr key={w.id}>
      <td>{agentName(w.agentId)}</td><td>{label(w.kind)}</td><td><span className="category-tag">{label(w.state)}</span></td><td>{w.reason?label(w.reason):'—'}</td><td>{w.attempts}/{w.maxAttempts}</td><td>{when(w.updatedAt)}</td>
      <td><div className="ops-row-actions">
       {['DRAFTED','WAITING_FOR_APPROVAL','WAITING_FOR_REPLY','BLOCKED'].includes(w.state)?<button type="button" className="live-secondary" disabled={busy} onClick={()=>void act({action:'transitionWork',id:w.id,expectedVersion:w.version,to:'COMPLETED',reason:'OWNER_REVIEWED'},'Marked reviewed and completed.')}>Mark reviewed</button>:null}
       {['BLOCKED','WAITING_FOR_APPROVAL','WAITING_FOR_REPLY','WAITING_FOR_BUDGET','DRAFTED'].includes(w.state)?<button type="button" className="live-secondary" disabled={busy} onClick={()=>void act({action:'transitionWork',id:w.id,expectedVersion:w.version,to:'ELIGIBLE',reason:'OWNER_REQUEUED'},'Returned to the queue.')}>Requeue</button>:null}
       {!['COMPLETED','FAILED_FINAL','CANCELLED','RECOVERING'].includes(w.state)?<button type="button" className="live-secondary" disabled={busy} onClick={()=>void act({action:'cancelWork',id:w.id,expectedVersion:w.version},w.state==='RUNNING'?'Cancellation requested; the run stops at its next step.':'Cancelled.')}>Cancel</button>:null}
      </div></td></tr>))}</tbody></table></div>}

    <h3 className="runtime-subheading">Owner review queue</h3>
    {data.reviewQueue.length===0?<p className="ops-empty">No accepted proposals are awaiting review.</p>:
    <ul className="ops-message-list">{data.reviewQueue.map(p=>(<li key={p.id} className="ops-message"><strong>{label(p.tool)}</strong> by {agentName(p.agentId)} <span className="ops-hash">{p.traceId}</span><pre className="ops-thread-body">{JSON.stringify(p.input,null,2)}</pre></li>))}</ul>}

    <h3 className="runtime-subheading">Runs</h3>
    {data.runs.length===0?<p className="ops-empty">No runs have started. Runs require an eligible work item, an unpaused queue and an unpaused, assigned agent.</p>:
    <div className="ops-table-wrap"><table className="ops-table"><thead><tr><th scope="col">Agent</th><th scope="col">Status</th><th scope="col">Steps</th><th scope="col">Checkpoints</th><th scope="col">Model</th><th scope="col">Started</th><th scope="col">Ended</th><th scope="col">Summary</th><th scope="col">Actions</th></tr></thead>
     <tbody>{data.runs.map(r=>(<tr key={r.runId}><td>{agentName(r.agentId)}</td><td>{label(r.status)}{r.reasonCode?` (${label(r.reasonCode)})`:''}</td><td>{r.steps}/{r.maxSteps}</td><td>{r.checkpoints}</td><td>{r.modelId}</td><td>{when(r.startedAt)}</td><td>{when(r.endedAt)}</td><td>{r.summary??'—'}</td>
      <td>{r.status==='running'?<button type="button" className="live-secondary" disabled={busy} onClick={()=>void act({action:'cancelRun',runId:r.runId},'Cancellation requested.')}>Cancel run</button>:null}</td></tr>))}</tbody></table></div>}

    <h3 className="runtime-subheading">Dispatch reconciliation</h3>
    {data.dispatches.filter(d=>['ambiguous','started'].includes(d.status)).length===0?<p className="ops-empty">No external effects need reconciliation.</p>:
    data.dispatches.filter(d=>['ambiguous','started'].includes(d.status)).map(d=>(
     <form key={d.id} className="ops-form" onSubmit={e=>{e.preventDefault();const form=new FormData(e.currentTarget);void act({action:'reconcileDispatch',id:d.id,outcome:form.get('outcome'),evidence:form.get('evidence')},'Reconciliation recorded. Nothing was resent.');}}>
      <p><strong>{label(d.actionKind)}</strong> is {d.status}: verify with the provider before deciding. It will never be resent automatically.</p>
      <label className="ops-field">Verified outcome<select name="outcome" required><option value="not_sent">Provider shows it was not sent</option><option value="sent">Provider shows it was sent</option></select></label>
      <label className="ops-field">Evidence reference<input name="evidence" required maxLength={500}/></label>
      <div className="ops-form-actions"><button className="live-primary" type="submit" disabled={busy}>Record reconciliation</button></div>
     </form>))}

    <h3 className="runtime-subheading">Dead letters</h3>
    {data.deadLetters.length===0?<p className="ops-empty">No work has exhausted its retries.</p>:
    <ul>{data.deadLetters.map(d=>(<li key={d.id}>{label(d.reasonCode)} after {d.attempts} attempt(s), {when(d.createdAt)} <span className="ops-hash">task:{d.taskId}</span></li>))}</ul>}
   </>}
  </section>
 );
}
