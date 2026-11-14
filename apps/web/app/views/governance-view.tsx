"use client";
// Governance control plane (DOTS-032..043).
// Navigation: mount under "Budget" (section="budget"), "Approvals" (section="approvals")
// and "Safety" (section="safety"); with no section prop all three render in order.
// Every number shown comes from the tenant ledger or audit tables; empty states say what evidence is missing.
import {useCallback,useEffect,useState,type FormEvent,type ReactNode} from 'react';
import '../operations.css';
import './governance-view.css';

type Row=Record<string,any>;
export type GovernanceSnapshot={
  budget:{currency:string;fundedCents:number;unallocatedCents:number;unreservedCents:number;reservedCents:number;spentCents:number;reconciled:boolean;unbalancedJournals:number;scopes:Row[]};
  reservations:Row[];journals:Row[];alerts:Row[];killSwitches:Row[];killSwitchAudit:Row[];runtime:Row|null;approvals:Row[];decisions:Row[];credentials:Row[];
  deadLetters:Row[];retention:Row[];holds:Row[];deletionRequests:Row[];exports:Row[];projects:Row[];campaigns:Row[];
  metrics:{queue:Row[];oldestQueuedSeconds:number;outbox:Row[];runs:Row[];mutations:Row[];errors:Row[]};
  audit:{days:number;approvals:Row[];decisions:Row[];killSwitches:Row[];events:number};
  capabilities:{credentialEncryptionConfigured:boolean;spendAuthorizationConfigured:boolean;hardCapCents:number};observedAt:string;
};
export type GovernanceSection='budget'|'approvals'|'safety';

const money=(value:unknown)=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(Number(value??0)/100);
const when=(value:unknown)=>value?new Date(String(value)).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'—';
const label=(value:unknown)=>String(value??'').replaceAll('_',' ');
const newKey=()=>globalThis.crypto?.randomUUID?.()??`${Date.now()}-${Math.random().toString(16).slice(2)}`;
/** Exact currency input: dollars with at most two decimals become integer cents; no floating-point math. */
export function parseDollarsToCents(value:unknown):number{
  const input=String(value??'').trim();
  if(!/^\d{1,13}(\.\d{1,2})?$/.test(input))throw new Error('Enter a dollar amount such as 12 or 12.50 (at most two decimals).');
  const [dollars,fraction='']=input.split('.');const amount=Number(dollars)*100+Number(fraction.padEnd(2,'0'));
  if(!Number.isSafeInteger(amount))throw new Error('Amount is too large.');return amount;
}
const optionalDollars=(value:FormDataEntryValue|null)=>String(value??'').trim()===''?null:parseDollarsToCents(value);
const messages:Record<string,string>={
  SPEND_NOT_AUTHORIZED:'Funding needs OWNER_SPEND_AUTHORIZATION_ID configured on the server.',FUNDING_EXCEEDS_HARD_CAP:'Funding would exceed the deployment hard cap (PAID_SPEND_LIMIT_CENTS).',
  TRANSFER_EXCEEDS_UNALLOCATED:'The source scope does not have that much unreserved allocation.',TRANSFER_SCOPE_NOT_FUNDABLE:'Only tenant, project and campaign scopes hold allocations; provider, model and channel scopes take ceilings.',
  TRANSFER_SAME_SCOPE:'Choose two different scopes.',CREDENTIAL_ENCRYPTION_NOT_CONFIGURED:'Set CREDENTIAL_ENCRYPTION_KEY on the server before storing credentials.',CREDENTIAL_EXISTS_ROTATE_INSTEAD:'An active credential with this provider and label exists; rotate it instead.',
  KILL_SWITCH_NOT_ACTIVE:'That kill switch is not engaged.',APPROVAL_STALE:'This approval already changed state or expired.',TASK_NOT_DEAD_LETTERED:'That task is no longer dead-lettered.',HOLD_NOT_ACTIVE:'That hold was already released.',
};
const readable=(code:string)=>messages[code]??code.replaceAll('_',' ').toLowerCase();

function Gauge({title,used,limit,threshold}:{title:string;used:number;limit:number|null;threshold?:number}){
  if(limit===null)return null;
  const percent=limit>0?Math.min(100,Math.round(used*100/limit)):used>0?100:0;
  const tone=limit===0||used>=limit?'stop':threshold&&used*10000>=limit*threshold?'warn':'';
  return <div className="gov-gauge">
    <div className="gov-gauge-label"><span>{title}</span><span>{money(used)} of {money(limit)}</span></div>
    <div className="gov-gauge-track" role="meter" aria-label={`${title}: ${money(used)} of ${money(limit)}`} aria-valuemin={0} aria-valuemax={limit} aria-valuenow={Math.min(used,limit)}><div className={`gov-gauge-fill ${tone}`} style={{width:`${percent}%`}}/></div>
  </div>;
}
function Empty({title,children}:{title:string;children:ReactNode}){return <div className="ops-empty"><h3>{title}</h3><p>{children}</p></div>;}
const scopeName=(scope:Row,data:GovernanceSnapshot)=>{
  if(scope.scope_kind==='tenant')return 'Organization pool';
  if(scope.scope_kind==='project')return `Project · ${data.projects.find(p=>p.id===scope.scope_key)?.label??scope.scope_key}`;
  if(scope.scope_kind==='campaign')return `Campaign · ${data.campaigns.find(c=>c.id===scope.scope_key)?.label??scope.scope_key}`;
  return `${label(scope.scope_kind)} · ${scope.scope_key}`;
};

export function GovernanceView({section,initialData}:{section?:GovernanceSection;initialData?:GovernanceSnapshot}={}){
  const [data,setData]=useState<GovernanceSnapshot|null>(initialData??null);const [error,setError]=useState('');const [notice,setNotice]=useState('');const [busy,setBusy]=useState(false);
  const [policyKind,setPolicyKind]=useState('project');const [switchKind,setSwitchKind]=useState('campaign');
  const load=useCallback(async()=>{try{const response=await fetch('/api/v1/governance',{cache:'no-store'});const body=await response.json();if(!response.ok)throw new Error(body.error??'GOVERNANCE_UNAVAILABLE');setData(body);setError('');}catch(e){setError(readable(e instanceof Error?e.message:'GOVERNANCE_UNAVAILABLE'));}},[]);
  useEffect(()=>{void load();},[load]);
  async function act(action:string,payload:Record<string,unknown>={},done?:string){
    setBusy(true);setError('');setNotice('');
    try{const response=await fetch('/api/v1/governance',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,...payload})});const body=await response.json();
      if(!response.ok)throw new Error(body.ruleId?`${body.error}: ${body.ruleId}`:body.error??'OPERATION_UNAVAILABLE');setData(body.data);setNotice(done??'Saved.');return body.outcome;}
    catch(e){setError(readable(e instanceof Error?e.message:'OPERATION_UNAVAILABLE'));return undefined;}finally{setBusy(false);}
  }
  const submit=(handler:(form:FormData)=>Promise<unknown>)=>async(event:FormEvent<HTMLFormElement>)=>{event.preventDefault();const form=event.currentTarget;try{const result=await handler(new FormData(form));if(result!==undefined)form.reset();}catch(e){setError(e instanceof Error?e.message:'Invalid input.');}};
  const show=(name:GovernanceSection)=>!section||section===name;
  if(!data)return <section className="gov-view" aria-busy={!error}>{error?<p className="live-error" role="alert">{error}</p>:<p className="ops-note">Loading governance evidence…</p>}</section>;
  const tree=data.budget.scopes.filter(s=>['tenant','project','campaign'].includes(s.scope_kind));
  const pending=data.approvals.filter(a=>a.status==='pending'&&!a.expired);
  return <section className="gov-view" aria-label="Governance control plane">
    <p aria-live="polite" className={notice?'ops-note':'sr-only'}>{notice}</p>
    {error&&<p className="live-error" role="alert">{error}</p>}

    {show('budget')&&<section aria-labelledby="gov-budget-heading">
      <div className="ops-section-heading"><h3 id="gov-budget-heading">Budget and funding</h3><span className={`ops-badge ${data.budget.reconciled?'tone-good':'tone-bad'}`}>{data.budget.reconciled?'Ledger reconciled':'Ledger mismatch — investigate'}</span></div>
      <div className="ops-stat-grid">
        <article><span>Owner funding</span><strong>{money(data.budget.fundedCents)}</strong><small>Hard cap {money(data.capabilities.hardCapCents)}</small></article>
        <article><span>Unallocated pool</span><strong>{money(data.budget.unallocatedCents)}</strong><small>Unreserved across all scopes {money(data.budget.unreservedCents)}</small></article>
        <article><span>Reserved (held)</span><strong>{money(data.budget.reservedCents)}</strong><small>Worst-case estimates awaiting settlement</small></article>
        <article><span>Settled spend</span><strong>{money(data.budget.spentCents)}</strong><small>Funding = unreserved + reserved + spent</small></article>
      </div>
      {data.budget.fundedCents===0&&<p className="ops-note">Paid spend is $0. Every paid model, email or payment operation is blocked until the owner records authorized funding below. Free (zero-cost) operations are unaffected.</p>}
      <div className="ops-card-grid">
        {data.budget.scopes.length===0?<Empty title="No spending scopes yet">The organization pool appears after the first funding, policy or reservation. Until then the effective budget is $0.</Empty>:
          data.budget.scopes.map(scope=><article className="ops-card" key={scope.id}>
            <div className="ops-card-heading"><h3>{scopeName(scope,data)}</h3><span className="category-tag">{label(scope.scope_kind)}</span></div>
            {['tenant','project','campaign'].includes(scope.scope_kind)&&<Gauge title="Allocation used" used={scope.reserved_cents+scope.spent_cents} limit={scope.allocated_cents} threshold={scope.alert_threshold_bps}/>}
            {scope.ceiling_cents!==null&&<Gauge title="Total ceiling" used={scope.usage_total_cents} limit={scope.ceiling_cents} threshold={scope.alert_threshold_bps}/>}
            <Gauge title="Today" used={scope.usage_daily_cents} limit={scope.daily_limit_cents} threshold={scope.alert_threshold_bps}/>
            <small>Available {money(scope.available_cents)} · reserved {money(scope.reserved_cents)} · spent {money(scope.spent_cents)} · soft alert at {scope.alert_threshold_bps/100}%</small>
          </article>)}
      </div>

      <div className="ops-card-grid" style={{marginTop:18}}>
        <article className="ops-card"><h3>Record owner funding</h3>
          <p className="ops-small">Requires the server's spend authorization reference and stays within the deployment hard cap. Recorded as a ledger journal; nothing is overwritten.</p>
          {!data.capabilities.spendAuthorizationConfigured&&<p className="ops-note">Blocked on external prerequisite: set OWNER_SPEND_AUTHORIZATION_ID and PAID_SPEND_LIMIT_CENTS after the owner approves a funded cap.</p>}
          <form className="gov-form" onSubmit={submit(async form=>act('fund',{amountCents:parseDollarsToCents(form.get('amount')),key:newKey()},'Funding recorded.'))}>
            <label className="wide">Amount (USD)<input name="amount" inputMode="decimal" autoComplete="off" required placeholder="0.00"/></label>
            <div className="wide gov-actions"><button className="live-primary" disabled={busy}>Record funding</button></div>
          </form>
        </article>
        <article className="ops-card"><h3>Transfer allocation</h3>
          <p className="ops-small">Moves unreserved money between the organization pool, projects and campaigns. Over-budget or unallocated transfers are rejected.</p>
          {tree.length<2?<p className="ops-note">Create a project or campaign scope in the allocation editor before transferring.</p>:
          <form className="gov-form" onSubmit={submit(async form=>act('transfer',{fromScopeId:form.get('from'),toScopeId:form.get('to'),amountCents:parseDollarsToCents(form.get('amount')),reason:form.get('reason'),key:newKey()},'Transfer recorded.'))}>
            <label>From<select name="from" required>{tree.map(s=><option key={s.id} value={s.id}>{scopeName(s,data)} ({money(s.available_cents)})</option>)}</select></label>
            <label>To<select name="to" required defaultValue={tree[1]?.id}>{tree.map(s=><option key={s.id} value={s.id}>{scopeName(s,data)}</option>)}</select></label>
            <label>Amount (USD)<input name="amount" inputMode="decimal" autoComplete="off" required placeholder="0.00"/></label>
            <label>Reason<input name="reason" required maxLength={500}/></label>
            <div className="wide gov-actions"><button className="live-primary" disabled={busy}>Transfer</button></div>
          </form>}
        </article>
        <article className="ops-card"><h3>Allocation editor</h3>
          <p className="ops-small">Project and campaign totals come from transfers. Provider, model and channel scopes take an explicit total ceiling (blank means $0). Daily ceilings apply to any scope; the most restrictive scope wins.</p>
          <form className="gov-form" onSubmit={submit(async form=>act('setScopePolicy',{scopeKind:policyKind,scopeKey:form.get('scopeKey')??undefined,ceilingCents:['provider','model','channel'].includes(policyKind)?(optionalDollars(form.get('ceiling'))??0):null,dailyLimitCents:optionalDollars(form.get('daily')),alertThresholdBps:Math.round(Number(form.get('alert')||80)*100)},'Scope policy saved.'))}>
            <label>Scope<select name="scopeKind" value={policyKind} onChange={e=>setPolicyKind(e.target.value)}>{['tenant','project','campaign','provider','model','channel'].map(k=><option key={k} value={k}>{label(k)}</option>)}</select></label>
            {policyKind==='project'&&<label>Project<select name="scopeKey" required>{data.projects.map(p=><option key={p.id} value={p.id}>{p.label}</option>)}</select></label>}
            {policyKind==='campaign'&&<label>Campaign<select name="scopeKey" required>{data.campaigns.map(c=><option key={c.id} value={c.id}>{c.label}</option>)}</select></label>}
            {policyKind==='channel'&&<label>Channel<select name="scopeKey">{['email','model','payment','webhook'].map(c=><option key={c}>{c}</option>)}</select></label>}
            {(policyKind==='provider'||policyKind==='model')&&<label>{policyKind==='provider'?'Provider id':'Model id'}<input name="scopeKey" required pattern="[A-Za-z0-9][A-Za-z0-9_.:/\-]{0,119}"/></label>}
            {['provider','model','channel'].includes(policyKind)&&<label>Total ceiling (USD)<input name="ceiling" inputMode="decimal" placeholder="0.00"/></label>}
            <label>Daily ceiling (USD, optional)<input name="daily" inputMode="decimal" placeholder="No daily ceiling"/></label>
            <label>Soft alert at (% of limit)<input name="alert" type="number" min={1} max={100} defaultValue={80}/></label>
            <div className="wide gov-actions"><button className="live-primary" disabled={busy}>Save scope policy</button></div>
          </form>
        </article>
        <article className="ops-card"><h3>Soft alerts</h3>
          {data.alerts.length===0?<p className="ops-small">No scope has crossed its alert threshold.</p>:<ul className="gov-list">{data.alerts.map(a=><li key={a.id}>{scopeName(a,data)}: {money(a.usage_cents)} of {money(a.limit_cents)} ({a.period}{a.period==='daily'?` ${a.period_key}`:''}) · {when(a.created_at)}</li>)}</ul>}
        </article>
      </div>

      <div className="ops-section-heading"><h3>Reservations</h3><button className="live-secondary" disabled={busy} onClick={()=>void act('reconcileExpired',{},'Expired holds released.')}>Release timed-out holds</button></div>
      {data.reservations.length===0?<Empty title="No reservations">Reservations appear when a worker estimates a metered call. None have been requested.</Empty>:
      <div className="ops-table-wrap"><table className="ops-table"><thead><tr><th>Purpose</th><th>Status</th><th>Estimate</th><th>Actual</th><th>Scope</th><th>Created</th><th>Actions</th></tr></thead><tbody>
        {data.reservations.map(r=><tr key={r.id}><td><strong>{r.purpose}</strong><small>{[r.provider_id,r.model_id,r.channel].filter(Boolean).join(' · ')||'—'}</small></td><td><span className="ops-badge">{r.status}</span>{r.final_reason&&<small>{label(r.final_reason)}</small>}</td><td>{money(r.estimate_cents)}</td><td>{r.actual_cents===null?'—':money(r.actual_cents)}</td>
          <td>{scopeName(data.budget.scopes.find(s=>s.id===r.funding_scope_id)??{scope_kind:'tenant'},data)}</td><td>{when(r.created_at)}</td>
          <td><div className="ops-row-actions">{r.status==='reserved'&&<button disabled={busy} onClick={()=>void act('releaseReservation',{id:r.id,reason:'OWNER_RELEASED'},'Hold released.')}>Release hold</button>}</div></td></tr>)}
      </tbody></table></div>}
      <div className="ops-section-heading"><h3>Ledger journals</h3></div>
      {data.journals.length===0?<p className="ops-small">No journals yet. Every funding, transfer, reservation, settlement and release appears here as balanced entries.</p>:
      <div className="ops-table-wrap"><table className="ops-table"><thead><tr><th>Kind</th><th>Reason</th><th>Entries</th><th>When</th></tr></thead><tbody>
        {data.journals.map(j=><tr key={j.id}><td>{label(j.kind)}</td><td>{j.reason}</td><td>{(j.lines as Row[]).map((l,i)=><small key={i}>{label(l.account)}{l.scope_id?` (${scopeName(data.budget.scopes.find(s=>s.id===l.scope_id)??{scope_kind:'tenant'},data)})`:''}: {Number(l.amount_cents)>0?'+':''}{money(l.amount_cents)}</small>)}</td><td>{when(j.created_at)}</td></tr>)}
      </tbody></table></div>}
    </section>}

    {show('approvals')&&<section aria-labelledby="gov-approvals-heading">
      <div className="ops-section-heading"><h3 id="gov-approvals-heading">Owner action inbox</h3><span className="ops-badge">{pending.length} pending</span></div>
      <p className="ops-small">Each approval is bound to the exact content hash, recipient list, campaign revision, budget and sender shown. Any change — or an engaged kill switch — blocks dispatch and requires a new request.</p>
      <div className="ops-card-grid">
        {data.approvals.length===0?<Empty title="Nothing awaits your decision">Requests appear when a campaign, message, quotation or funding action is prepared for dispatch.</Empty>:
        data.approvals.map(a=><article className="ops-card" key={a.id}>
          <div className="ops-card-heading"><h3>{a.title??label(a.action_kind)}</h3><span className={`ops-badge ${a.status==='approved'||a.status==='consumed'?'tone-good':a.status==='pending'&&!a.expired?'':'tone-bad'}`}>{a.status==='pending'&&a.expired?'expired':a.status}</span></div>
          <dl className="ops-card-metrics">
            <div><dt>Recipients</dt><dd>{a.audience_count??'—'}</dd></div><div><dt>Budget</dt><dd>{a.budget_cents===null?'—':money(a.budget_cents)}</dd></div>
            <div><dt>Campaign revision</dt><dd>{a.campaign_revision??'—'}</dd></div><div><dt>Sender</dt><dd>{a.sender_identity??'—'}</dd></div>
            <div><dt>Expires</dt><dd>{when(a.expires_at)}</dd></div><div><dt>Policy version</dt><dd>{a.policy_version}</dd></div>
          </dl>
          {Array.isArray(a.consequences)&&<><strong className="ops-small">Consequences if approved</strong><ul className="gov-list">{(a.consequences as string[]).map((c,i)=><li key={i}>{c}</li>)}</ul></>}
          <details><summary>Exact payload and hashes</summary><pre className="gov-payload">{JSON.stringify(a.proposed_payload,null,2)}</pre><code className="ops-hash">content {a.content_hash??'—'}<br/>audience {a.audience_hash??'—'}<br/>scope {a.payload_hash}</code></details>
          {a.status==="pending"&&!a.expired&&<div className="gov-actions"><button className="live-primary" disabled={busy} onClick={()=>void act('decideApproval',{id:a.id,approved:true},'Approved for this exact payload.')}>Approve exact payload</button><button className="live-secondary" disabled={busy} onClick={()=>void act('decideApproval',{id:a.id,approved:false},'Rejected.')}>Reject</button></div>}
        </article>)}
      </div>
      <div className="ops-section-heading"><h3>Policy decisions</h3></div>
      {data.decisions.length===0?<p className="ops-small">No dispatch has been evaluated yet.</p>:
      <div className="ops-table-wrap"><table className="ops-table"><thead><tr><th>Decision</th><th>Subject</th><th>Rules not allowing</th><th>When</th></tr></thead><tbody>
        {data.decisions.map(d=><tr key={d.id}><td><span className={`ops-badge ${d.decision==='ALLOW'?'tone-good':d.decision==='DENY'?'tone-bad':''}`}>{d.decision}</span></td><td>{label(d.subject_kind)}</td>
          <td>{(d.rules as Row[]).filter(r=>r.outcome!=='ALLOW').map(r=><small key={r.id}><strong>{r.id}</strong> {r.reason}</small>)}{(d.rules as Row[]).every(r=>r.outcome==='ALLOW')&&'All rules allowed'}</td><td>{when(d.created_at)}</td></tr>)}
      </tbody></table></div>}
    </section>}

    {show('safety')&&<section aria-labelledby="gov-safety-heading">
      <div className="ops-section-heading"><h3 id="gov-safety-heading">Safety controls</h3><span className={`ops-badge ${data.runtime&&!data.runtime.paused?'tone-good':'tone-bad'}`}>{!data.runtime?'Runtime not initialized':data.runtime.paused?'Runtime paused':'Runtime running'}</span></div>
      <div className="ops-card-grid">
        <article className="ops-card"><h3>Kill switches</h3>
          <p className="ops-small">Engaging blocks external dispatch immediately, even for approved actions. Queued tasks are preserved; organization pause parks them until an explicit resume.</p>
          <form className="gov-form" onSubmit={submit(async form=>act('engageKillSwitch',{scopeKind:switchKind,scopeKey:form.get('scopeKey'),rationale:form.get('rationale')},'Kill switch engaged.'))}>
            <label>Scope<select value={switchKind} onChange={e=>setSwitchKind(e.target.value)}>{['organization','campaign','provider','model','channel'].map(k=><option key={k} value={k}>{label(k)}</option>)}</select></label>
            {switchKind==='campaign'&&<label>Campaign<select name="scopeKey" required>{data.campaigns.map(c=><option key={c.id} value={c.id}>{c.label}</option>)}</select></label>}
            {switchKind==='channel'&&<label>Channel<select name="scopeKey">{['email','model','payment','webhook'].map(c=><option key={c}>{c}</option>)}</select></label>}
            {(switchKind==='provider'||switchKind==='model')&&<label>{switchKind==='provider'?'Provider id':'Model id'}<input name="scopeKey" required/></label>}
            <label className="wide">Rationale (recorded in the audit trail)<textarea name="rationale" required maxLength={1000} rows={2}/></label>
            <div className="wide gov-actions"><button className="live-primary" disabled={busy}>Engage kill switch</button></div>
          </form>
          {data.killSwitches.filter(k=>k.active).map(k=><form key={k.id} className="gov-inline" onSubmit={submit(async form=>act('releaseKillSwitch',{scopeKind:k.scope_kind,scopeKey:k.scope_key,rationale:form.get('rationale')},'Resumed.'))}>
            <span className="ops-badge tone-bad">{label(k.scope_kind)} {k.scope_kind==='organization'?'':k.scope_key}</span>
            <label>Resume rationale<input name="rationale" required maxLength={1000}/></label><button className="live-secondary" disabled={busy}>Resume</button></form>)}
          {data.killSwitchAudit.length>0&&<details><summary>Audit trail</summary><ul className="gov-list">{data.killSwitchAudit.map(a=><li key={a.id}>{a.action} · {a.rationale} · {when(a.created_at)}</li>)}</ul></details>}
        </article>
        <article className="ops-card"><h3>Credential references</h3>
          <p className="ops-small">Secrets are encrypted with AES-256-GCM and bound to this tenant and provider. Only fingerprints and the last four characters are ever shown.</p>
          {!data.capabilities.credentialEncryptionConfigured&&<p className="ops-note">Blocked on external prerequisite: set CREDENTIAL_ENCRYPTION_KEY (32 random bytes, base64url) on the server.</p>}
          {data.credentials.length===0?<p className="ops-small">No credential references stored.</p>:<ul className="gov-list">{data.credentials.map(c=><li key={c.id}>
            <strong>{c.provider_id} · {c.label}</strong> <span className={`ops-badge ${c.status==='active'?'tone-good':''}`}>{c.status}</span> {label(c.kind)} · fp {c.fingerprint} · …{c.last4} · {when(c.created_at)}
            {c.status==='active'&&<><form className="gov-inline" onSubmit={submit(async form=>act('rotateCredential',{id:c.id,secret:form.get('secret')},'Credential rotated.'))}><label>New secret<input name="secret" type="password" autoComplete="new-password" required minLength={8}/></label><button className="live-secondary" disabled={busy}>Rotate</button></form>
            <form className="gov-inline" onSubmit={submit(async form=>act('revokeCredential',{id:c.id,reason:form.get('reason')},'Credential revoked.'))}><label>Revocation reason<input name="reason" required/></label><button className="live-secondary danger-text" disabled={busy}>Revoke</button></form></>}
          </li>)}</ul>}
          <form className="gov-form" onSubmit={submit(async form=>act('storeCredential',{providerId:form.get('providerId'),label:form.get('label'),kind:form.get('kind'),secret:form.get('secret')},'Credential stored.'))}>
            <label>Provider id<input name="providerId" required pattern="[a-z][a-z0-9_\-]{1,39}"/></label><label>Label<input name="label" required defaultValue="primary"/></label>
            <label>Kind<select name="kind">{['api_key','oauth_refresh_token','webhook_secret'].map(k=><option key={k} value={k}>{label(k)}</option>)}</select></label>
            <label>Secret<input name="secret" type="password" autoComplete="new-password" required minLength={8}/></label>
            <div className="wide gov-actions"><button className="live-primary" disabled={busy}>Store encrypted reference</button></div>
          </form>
        </article>
        <article className="ops-card"><h3>Queue health</h3>
          <dl className="ops-card-metrics">{data.metrics.queue.length===0?<div><dt>Tasks</dt><dd>None queued</dd></div>:data.metrics.queue.map(q=><div key={q.state}><dt>{label(q.state)}</dt><dd>{q.total}</dd></div>)}
            <div><dt>Oldest ready task</dt><dd>{data.metrics.oldestQueuedSeconds}s</dd></div>{data.metrics.outbox.map(o=><div key={o.status}><dt>Outbox {o.status}</dt><dd>{o.total}</dd></div>)}</dl>
          {data.deadLetters.length===0?<p className="ops-small">No dead-lettered tasks.</p>:data.deadLetters.filter(d=>d.state==='dead_letter').map(d=><form key={d.id} className="gov-inline" onSubmit={submit(async form=>act('requeueDeadLetter',{id:d.task_id,rationale:form.get('rationale')},'Task requeued.'))}>
            <span className="ops-badge tone-bad">{label(d.kind)} · {d.attempts} attempts · {label(d.reason)}</span><label>Requeue rationale<input name="rationale" required/></label><button className="live-secondary" disabled={busy}>Requeue</button></form>)}
          {data.metrics.errors.length>0&&<ul className="gov-list">{data.metrics.errors.map((e,i)=><li key={i}>{label(e.reason_code??'unknown')}: {e.total} failed runs (7 days)</li>)}</ul>}
        </article>
        <article className="ops-card"><h3>Retention, holds and privacy requests</h3>
          {data.retention.length===0?<><p className="ops-small">No retention annotations yet.</p><button className="live-secondary" disabled={busy} onClick={()=>void act('ensureDefaultRetention',{},'Default retention annotations recorded.')}>Record default retention policy</button></>:
            <><ul className="gov-list">{data.retention.map(r=><li key={r.id}>{label(r.record_kind)}: {r.retention_days} days · {label(r.action)}</li>)}</ul><div className="gov-actions"><button className="live-secondary" disabled={busy} onClick={()=>void act('applyRetention',{},'Retention applied.')}>Apply retention now</button></div></>}
          <form className="gov-inline" onSubmit={submit(async form=>act('placeHold',{subjectKind:'organization',reason:form.get('reason')},'Evidence hold placed.'))}><label>Organization-wide evidence hold reason<input name="reason" required/></label><button className="live-secondary" disabled={busy}>Place hold</button></form>
          {data.holds.filter(h=>h.active).map(h=><form key={h.id} className="gov-inline" onSubmit={submit(async form=>act('releaseHold',{id:h.id,rationale:form.get('rationale')},'Hold released.'))}><span className="ops-badge">{label(h.subject_kind)} hold · {h.reason}</span><label>Release rationale<input name="rationale" required/></label><button className="live-secondary" disabled={busy}>Release</button></form>)}
          {data.deletionRequests.length>0&&<ul className="gov-list">{data.deletionRequests.map(d=><li key={d.id}>{label(d.subject_kind)} deletion · <span className="ops-badge">{d.status}</span> · {when(d.created_at)}{d.status!=='completed'&&<button className="live-secondary" disabled={busy} onClick={()=>void act('processDeletion',{id:d.id},'Deletion request processed.')}>Process</button>}</li>)}</ul>}
          <div className="gov-actions">{['audit','ledger','contacts'].map(scope=><button key={scope} className="live-secondary" disabled={busy} onClick={async()=>{const outcome=await act('runExport',{scope},`${label(scope)} export prepared.`) as Row|undefined;if(outcome?.data){const url=URL.createObjectURL(new Blob([JSON.stringify(outcome.data,null,2)],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download=`dots-${scope}-export.json`;link.click();URL.revokeObjectURL(url);}}}>Export {scope}</button>)}</div>
          <p className="ops-small">Audit (last {data.audit.days} days): {data.audit.events} operational events · decisions {data.audit.decisions.map(d=>`${d.decision} ${d.total}`).join(', ')||'none'} · kill-switch actions {data.audit.killSwitches.map(k=>`${k.action} ${k.total}`).join(', ')||'none'}.</p>
        </article>
      </div>
    </section>}
    <p className="ops-small">Observed {when(data.observedAt)}.</p>
  </section>;
}
