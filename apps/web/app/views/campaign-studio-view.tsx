"use client";
// Campaign Studio (DOTS-082..093). Navigation label: "Campaign Studio".
// Split-pane builder: goal, project/offer, audience, sender/channel/rules, copy (versioned templates with
// fact slots and synthetic previews), schedule, budget, variants, review/approval and the control room.
// Every metric shows its evidence source; nothing here sends messages or spends money.
import {useCallback,useEffect,useMemo,useState,type ReactNode} from 'react';
import '../operations.css';
import './campaign-studio-view.css';

type Row=Record<string,any>;
type Snapshot={campaigns:Row[];projects:Row[];offers:Row[];facts:Row[];mailboxes:Row[];strategies:Row[];templates:Row[];contacts:Row[];agents:Row[];policy:Row|null;channelPolicies:Record<string,Row>;templateVariables:string[];lifecycle:{states:string[];transitions:Record<string,string[]>};quietHours:{startHour:number;endHour:number}};
type Detail=Row&{issues:Row[];funnel:Row[];timeline:Row[];decisions:Row[];expenses:Row;revisions:Row[];simulations:Row[];variants:Row[];template:Row|null;work:Row[];buckets:Row[];priceExceptions:Row[]};

const LIFECYCLE=['draft','validated','ready_for_approval','approved','scheduled','active','paused','completed','archived','aborted'];
const money=(cents:unknown)=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(Number(cents??0)/100);
const label=(value:unknown)=>String(value??'').replaceAll('_',' ');
const when=(value:unknown)=>value?new Date(String(value)).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'—';
const toLocalInput=(value:unknown)=>{if(!value)return '';const d=new Date(String(value));const p=(n:number)=>String(n).padStart(2,'0');return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;};
const fromLocalInput=(value:string)=>value?new Date(value).toISOString():null;
const dollarsToCents=(value:string)=>{const v=value.trim()||'0';if(!/^\d+(\.\d{1,2})?$/.test(v))throw new Error('Enter a dollar amount with at most two decimals.');return Math.round(Number(v)*100);};
const errorText:Record<string,string>={VERSION_CONFLICT:'Someone saved this campaign first. Reload to see the latest version, then reapply your edits.',PAUSE_CAMPAIGN_FIRST:'Pause the active campaign before editing it.',VALIDATE_CAMPAIGN_FIRST:'Validate the campaign before requesting approval.',SIMULATE_CURRENT_REVISION_FIRST:'Run a dry-run simulation of this exact revision first.',CAMPAIGN_HAS_BLOCKING_ISSUES:'Resolve the blocking issues listed under Review.',APPROVAL_STALE:'This approval no longer matches the campaign. Request a fresh approval.',REAPPROVAL_REQUIRED:'The campaign changed after approval and needs re-approval.',CAMPAIGN_NOT_STARTED:'The scheduled start time has not arrived yet.',CAMPAIGN_BUDGET_EXHAUSTED:'The campaign budget is fully committed.',OWNER_PAUSED:'The workspace is paused by the owner.',SPEND_AUTHORIZATION_REQUIRED:'A non-zero budget needs an owner spend authorization reference.',TRANSITION_NOT_ALLOWED:'That step is not allowed from the current campaign state.',ASSIGN_AGENT_FIRST:'Assign an active agent to this project first.'};

type Fields={label:string;goal:string;offerId:string;strategyId:string;mailboxId:string;channel:string;allowedCountries:string;timezone:string;windowStartHour:string;windowEndHour:string;weekdaysOnly:boolean;frequencyCap:string;cadenceDays:string;dailyLimit:string;scheduleStartAt:string;scheduleEndAt:string;priority:string;agentIdentityId:string;authorityRef:string};
const fieldsOf=(c:Row):Fields=>({label:c.label??'',goal:c.goal??'',offerId:c.offer_id??'',strategyId:c.strategy_id??'',mailboxId:c.mailbox_id??'',channel:c.channel??'email',allowedCountries:(c.allowed_countries??[]).join(', '),timezone:c.timezone??'UTC',windowStartHour:String(c.send_window_start_hour??9),windowEndHour:String(c.send_window_end_hour??17),weekdaysOnly:c.weekdays_only!==false,frequencyCap:String(c.frequency_cap??1),cadenceDays:String(c.cadence_days??7),dailyLimit:String(c.daily_limit??10),scheduleStartAt:toLocalInput(c.schedule_start_at),scheduleEndAt:toLocalInput(c.schedule_end_at),priority:String(c.priority??50),agentIdentityId:c.agent_identity_id??'',authorityRef:c.authority_ref??''});
function patchOf(f:Fields,c:Row){
 const next:Row={label:f.label,goal:f.goal,offerId:f.offerId||null,strategyId:f.strategyId||null,mailboxId:f.mailboxId||null,channel:f.channel,allowedCountries:f.allowedCountries.split(',').map(s=>s.trim()).filter(Boolean),timezone:f.timezone,windowStartHour:Number(f.windowStartHour),windowEndHour:Number(f.windowEndHour),weekdaysOnly:f.weekdaysOnly,frequencyCap:Number(f.frequencyCap),cadenceDays:Number(f.cadenceDays),dailyLimit:Number(f.dailyLimit),scheduleStartAt:fromLocalInput(f.scheduleStartAt),scheduleEndAt:fromLocalInput(f.scheduleEndAt),priority:Number(f.priority),agentIdentityId:f.agentIdentityId||null,authorityRef:f.authorityRef||null};
 const before=fieldsOf(c);const out:Row={};for(const key of Object.keys(next) as (keyof Fields)[])if(String(f[key])!==String(before[key]))out[key]=next[key];return out;
}
const storageKey=(id:string)=>`dots.campaign-draft.${id}`;
function readLocal(id:string):Row|null{try{const raw=window.localStorage.getItem(storageKey(id));return raw?JSON.parse(raw):null;}catch{return null;}}
function writeLocal(id:string,value:Row|null){try{if(value)window.localStorage.setItem(storageKey(id),JSON.stringify(value));else window.localStorage.removeItem(storageKey(id));}catch{/* storage unavailable: server drafts still persist */}}

function Field({label:text,children,help}:{label:string;children:ReactNode;help?:string}){return <label className="cs-field"><span>{text}</span>{children}{help&&<small className="cs-source">{help}</small>}</label>;}
function Empty({title,children}:{title:string;children:ReactNode}){return <div className="cs-empty" role="status"><strong>{title}</strong><div>{children}</div></div>;}

export function CampaignStudioView(){
 const [snapshot,setSnapshot]=useState<Snapshot|null>(null);const [detail,setDetail]=useState<Detail|null>(null);
 const [selected,setSelected]=useState<string|null>(null);const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [notice,setNotice]=useState('');
 const [fields,setFields]=useState<Fields|null>(null);const [copy,setCopy]=useState({subject:'',bodyText:'',bodyHtml:''});
 const [audience,setAudience]=useState<Set<string>>(new Set());const [segment,setSegment]=useState({jurisdictions:'',consents:''});
 const [budget,setBudget]=useState({total:'0',perMessage:'0',authorizationRef:''});const [previews,setPreviews]=useState<Row|null>(null);
 const [fieldsOwner,setFieldsOwner]=useState<string|null>(null);
 const [newDraft,setNewDraft]=useState({projectId:'',label:'',purpose:'product',goal:''});const [restorable,setRestorable]=useState<Row|null>(null);
 const [variant,setVariant]=useState({label:'',strategyId:'',templateRevisionId:'',weight:'1',countries:''});
 const [priceRule,setPriceRule]=useState({prices:'',maxDiscount:'0',phrases:''});const [exception,setException]=useState({amount:'',discount:'',reason:''});

 const campaign=useMemo(()=>snapshot?.campaigns.find(c=>c.id===selected)??null,[snapshot,selected]);
 const load=useCallback(async(id:string|null)=>{
  setError('');const response=await fetch(`/api/v1/campaigns${id?`?campaign=${encodeURIComponent(id)}`:''}`,{cache:'no-store'});const body=await response.json().catch(()=>({}));
  if(!response.ok){setError(errorText[body.error]??`Campaign Studio is unavailable (${body.error??response.status}).`);return;}
  setSnapshot(body.snapshot);setDetail(body.detail);
 },[]);
 useEffect(()=>{void load(selected);},[load,selected]);
 useEffect(()=>{
  if(!campaign){setFields(null);setFieldsOwner(null);return;}
  setFields(fieldsOf(campaign));setFieldsOwner(campaign.id);setAudience(new Set((campaign.audience_contact_ids??[]) as string[]));
  setSegment({jurisdictions:(campaign.audience_segment?.jurisdictions??[]).join(', '),consents:(campaign.audience_segment?.consents??[]).join(', ')});
  setBudget({total:String(Number(campaign.budget_total_cents??0)/100),perMessage:String(Number(campaign.budget_per_message_cents??0)/100),authorizationRef:campaign.budget_authorization_ref??''});
  const local=readLocal(campaign.id);setRestorable(local&&Number(local.version)===Number(campaign.version)&&JSON.stringify(local.fields)!==JSON.stringify(fieldsOf(campaign))?local:null);
 },[campaign]);
 useEffect(()=>{if(detail?.template)setCopy({subject:detail.template.subject??'',bodyText:detail.template.body_text??'',bodyHtml:detail.template.body_html??''});else if(detail)setCopy({subject:'',bodyText:'',bodyHtml:''});},[detail]);
 const offer=snapshot?.offers.find(o=>o.id===fields?.offerId);
 useEffect(()=>{if(offer)setPriceRule({prices:(offer.authorized_prices_cents??[]).map((c:number)=>Number(c)/100).join(', '),maxDiscount:String(Number(offer.max_discount_bp??0)/100),phrases:(offer.restricted_phrases??[]).join(', ')});},[offer]);
 useEffect(()=>{if(campaign&&fields&&fieldsOwner===campaign.id&&!restorable)writeLocal(campaign.id,{version:campaign.version,fields});},[campaign,fields,fieldsOwner,restorable]);

 async function act(action:string,payload:Row={},success?:string){
  setBusy(true);setError('');setNotice('');
  try{
   const response=await fetch('/api/v1/campaigns',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,...payload})});const body=await response.json().catch(()=>({}));
   if(!response.ok){setError(errorText[body.error]??`The action failed (${body.error??response.status}).`);return null;}
   setSnapshot(body.snapshot);if(body.detail)setDetail(body.detail);if(success)setNotice(success);return body.outcome as Row;
  }catch(e){setError(e instanceof Error?e.message:'The action failed.');return null;}finally{setBusy(false);}
 }
 const version=()=>Number(campaign?.version);
 async function saveDraft(){if(!campaign||!fields)return;const patch=patchOf(fields,campaign);if(!Object.keys(patch).length){setNotice('No changes to save.');return;}if(await act('saveDraft',{id:campaign.id,version:version(),fields:patch},'Draft saved. Material changes create a new revision and revoke any approval.'))writeLocal(campaign.id,null);}
 async function create(){const outcome=await act('createDraft',{...newDraft},'Draft created.');if(outcome?.id){setSelected(String(outcome.id));setNewDraft({projectId:newDraft.projectId,label:'',purpose:newDraft.purpose,goal:''});}}
 async function preview(){const outcome=await act('previewTemplate',{subject:copy.subject,bodyText:copy.bodyText,bodyHtml:copy.bodyHtml||undefined,projectId:campaign?.project_id,offerId:fields?.offerId||undefined});if(outcome)setPreviews(outcome);}
 function money2(value:string,cb:(cents:number)=>void){try{cb(dollarsToCents(value));}catch(e){setError(e instanceof Error?e.message:'Invalid amount.');}}

 if(!snapshot)return <section className="cs-root" aria-busy="true"><div className="cs-header"><div><h2>Campaign Studio</h2><p>Loading campaigns…</p></div></div>{error&&<div className="cs-error" role="alert">{error}</div>}</section>;
 const state=String(campaign?.state??'');const can=(to:string)=>snapshot.lifecycle.transitions[state]?.includes(to);
 const blocking=(detail?.issues??[]).filter(i=>i.severity==='blocking');const pendingCampaignApproval=detail?.decisions.find(d=>d.action_kind==='campaign'&&d.status==='pending');
 const set=(key:keyof Fields)=>(event:{target:{value:string}})=>setFields(f=>f?{...f,[key]:event.target.value}:f);

 return <section className="cs-root" aria-labelledby="cs-title">
  <div className="cs-header"><div><h2 id="cs-title">Campaign Studio</h2><p>Plan, validate, simulate and approve campaigns. Simulations use synthetic prospects only; no message is sent and no paid request is made from this page. Outbound dispatch stays behind owner approval and server-side gates.</p></div>
   <div className="cs-row"><span className={`ops-badge ${snapshot.policy?.paused?'tone-bad':''}`}>Workspace {snapshot.policy?.paused?'paused':'running'}</span><span className="ops-badge">Outbound {snapshot.policy?.outbound_enabled?'enabled':'disabled'}</span></div></div>
  <p className="cs-notice" aria-live="polite">{notice}</p>
  {error&&<div className="cs-error" role="alert">{error}</div>}
  <div className="cs-split">
   <aside className="cs-list" aria-label="Campaigns">
    <h3>Campaigns</h3>
    {snapshot.campaigns.length?snapshot.campaigns.map(c=><button key={c.id} type="button" className="cs-list-item" aria-current={c.id===selected?'true':undefined} onClick={()=>{setSelected(c.id);setPreviews(null);}}><strong>{c.label}</strong><small>{label(c.state)} · revision {c.revision} · {label(c.purpose)}</small></button>)
     :<Empty title="No campaigns yet">Create a draft below. Nothing runs until it is validated, simulated and approved by the owner.</Empty>}
    <h3>New draft</h3>
    {snapshot.projects.length?<>
     <Field label="Project"><select value={newDraft.projectId} onChange={e=>setNewDraft({...newDraft,projectId:e.target.value})}><option value="">Choose a project</option>{snapshot.projects.map(p=><option key={p.id} value={p.id}>{p.label}</option>)}</select></Field>
     <Field label="Campaign name"><input value={newDraft.label} maxLength={160} onChange={e=>setNewDraft({...newDraft,label:e.target.value})}/></Field>
     <Field label="Purpose"><select value={newDraft.purpose} onChange={e=>setNewDraft({...newDraft,purpose:e.target.value})}><option value="product">Product sales</option><option value="grant">Grant</option><option value="investment">Investment</option></select></Field>
     <Field label="Goal"><input value={newDraft.goal} maxLength={2000} onChange={e=>setNewDraft({...newDraft,goal:e.target.value})}/></Field>
     <button type="button" className="live-primary" disabled={busy||!newDraft.projectId||!newDraft.label.trim()||!newDraft.goal.trim()} onClick={create}>Create draft</button>
    </>:<Empty title="No active projects">Add a project and offer in the catalog before planning a campaign.</Empty>}
   </aside>

   <div className="cs-panel">
    {!campaign||!fields?<Empty title="Select or create a campaign">The builder, copy editor, simulation and control room appear here.</Empty>:<>
     <div className="ops-card-heading"><h3>{campaign.label}</h3><span className="ops-badge">{label(state)} · r{campaign.revision} · v{campaign.version}</span></div>
     <ol className="cs-lifecycle" aria-label="Campaign lifecycle">{LIFECYCLE.map(s=><li key={s} aria-current={s===state?'step':undefined}>{label(s)}</li>)}</ol>
     {restorable&&<div className="cs-row" role="status"><span className="cs-source">Unsaved edits from this browser are available for this version.</span><button type="button" className="live-secondary" onClick={()=>{setFields(restorable.fields);setRestorable(null);setNotice('Unsaved edits restored. Save the draft to keep them.');}}>Restore unsaved edits</button><button type="button" className="live-secondary" onClick={()=>{writeLocal(campaign.id,null);setRestorable(null);}}>Discard</button></div>}
     <div className="cs-sections">
      <section className="cs-section" aria-labelledby="cs-goal"><h4 id="cs-goal">Goal and offer</h4>
       <Field label="Campaign name"><input value={fields.label} onChange={set('label')}/></Field>
       <Field label="Goal"><textarea value={fields.goal} onChange={set('goal')} style={{minHeight:70}}/></Field>
       <Field label="Offer"><select value={fields.offerId} onChange={set('offerId')}><option value="">No offer</option>{snapshot.offers.filter(o=>o.project_id===campaign.project_id).map(o=><option key={o.id} value={o.id}>{o.label}</option>)}</select></Field>
       <Field label="Strategy"><select value={fields.strategyId} onChange={set('strategyId')}><option value="">No strategy</option>{snapshot.strategies.map(s=><option key={s.id} value={s.id}>{s.label}</option>)}</select></Field>
       <Field label="Agent"><select value={fields.agentIdentityId} onChange={set('agentIdentityId')}><option value="">Highest-priority assigned agent</option>{snapshot.agents.filter(a=>a.project_id===campaign.project_id).map(a=><option key={a.id} value={a.id}>{a.display_name}</option>)}</select></Field>
       {campaign.purpose!=='product'&&<Field label="Owner/legal authority reference" help="Required for investment outreach."><input value={fields.authorityRef} onChange={set('authorityRef')}/></Field>}
      </section>
      <section className="cs-section" aria-labelledby="cs-sender"><h4 id="cs-sender">Sender, channel and rules</h4>
       <Field label="Sender mailbox">{snapshot.mailboxes.length?<select value={fields.mailboxId} onChange={set('mailboxId')}><option value="">Choose a sender</option>{snapshot.mailboxes.map(m=><option key={m.id} value={m.id}>{m.label} ({m.verified&&m.status==='active'?'verified':'not verified'})</option>)}</select>:<span className="cs-source">No sender mailbox is configured.</span>}</Field>
       <Field label="Channel"><select value={fields.channel} onChange={set('channel')}>{Object.entries(snapshot.channelPolicies).map(([key,p])=><option key={key} value={key}>{p.label}{p.enabled?'':' (disabled)'}</option>)}</select></Field>
       <Field label="Allowed countries (ISO codes, comma separated)" help={`Reviewed for ${fields.channel}: ${(snapshot.channelPolicies[fields.channel]?.countries??[]).join(', ')||'none'}`}><input value={fields.allowedCountries} onChange={set('allowedCountries')}/></Field>
       <div className="cs-grid2"><Field label="Daily sending cap"><input type="number" min={1} max={100} value={fields.dailyLimit} onChange={set('dailyLimit')}/></Field><Field label="Priority (0–100)"><input type="number" min={0} max={100} value={fields.priority} onChange={set('priority')}/></Field>
       <Field label="Messages per contact"><input type="number" min={1} max={10} value={fields.frequencyCap} onChange={set('frequencyCap')}/></Field><Field label="Per this many days"><input type="number" min={1} max={90} value={fields.cadenceDays} onChange={set('cadenceDays')}/></Field></div>
      </section>
      <section className="cs-section" aria-labelledby="cs-schedule"><h4 id="cs-schedule">Schedule</h4>
       <Field label="Time zone (IANA)"><input value={fields.timezone} onChange={set('timezone')}/></Field>
       <div className="cs-grid2"><Field label="Start"><input type="datetime-local" value={fields.scheduleStartAt} onChange={set('scheduleStartAt')}/></Field><Field label="End (optional)"><input type="datetime-local" value={fields.scheduleEndAt} onChange={set('scheduleEndAt')}/></Field>
       <Field label="Window opens (hour)"><input type="number" min={0} max={23} value={fields.windowStartHour} onChange={set('windowStartHour')}/></Field><Field label="Window closes (hour)"><input type="number" min={1} max={24} value={fields.windowEndHour} onChange={set('windowEndHour')}/></Field></div>
       <label className="cs-check"><input type="checkbox" checked={fields.weekdaysOnly} onChange={e=>setFields({...fields,weekdaysOnly:e.target.checked})}/>Weekdays only</label>
       <small className="cs-source">Quiet hours {snapshot.quietHours.startHour}:00–{snapshot.quietHours.endHour}:00 in the campaign time zone are always enforced.</small>
       <div className="cs-row"><button type="button" className="live-primary" disabled={busy} onClick={saveDraft}>Save draft</button></div>
      </section>
      <section className="cs-section" aria-labelledby="cs-budget"><h4 id="cs-budget">Budget</h4>
       <p className="cs-source">Current: {campaign.budget_revision_id?`${money(campaign.budget_total_cents)} total, up to ${money(campaign.budget_per_message_cents)} per message`:'no budget set'}. USD 0 is the default; paid spend needs an owner authorization reference.</p>
       <div className="cs-grid2"><Field label="Total (USD)"><input inputMode="decimal" value={budget.total} onChange={e=>setBudget({...budget,total:e.target.value})}/></Field><Field label="Max per message (USD)"><input inputMode="decimal" value={budget.perMessage} onChange={e=>setBudget({...budget,perMessage:e.target.value})}/></Field></div>
       <Field label="Owner spend authorization reference"><input value={budget.authorizationRef} onChange={e=>setBudget({...budget,authorizationRef:e.target.value})}/></Field>
       <div className="cs-row"><button type="button" className="live-secondary" disabled={busy} onClick={()=>money2(budget.total,total=>money2(budget.perMessage,per=>void act('setBudget',{id:campaign.id,version:version(),totalCents:total,perMessageMaxCents:per,authorizationRef:budget.authorizationRef||undefined},'Budget revision saved.')))}>Save budget revision</button></div>
      </section>
      <section className="cs-section wide" aria-labelledby="cs-audience"><h4 id="cs-audience">Audience</h4>
       <p className="cs-source">{campaign.audience_revision_id?`${campaign.audience_count} contacts in the current audience revision.`:'No audience revision yet.'} Consent, suppression, country and frequency rules are applied again at validation and before every work item.</p>
       <div className="cs-grid2"><Field label="Segment: countries (comma separated)"><input value={segment.jurisdictions} onChange={e=>setSegment({...segment,jurisdictions:e.target.value})}/></Field><Field label="Segment: consent types (comma separated)" help="opted_in, existing_customer, business_reviewed"><input value={segment.consents} onChange={e=>setSegment({...segment,consents:e.target.value})}/></Field></div>
       {snapshot.contacts.length?<fieldset className="cs-contacts"><legend className="cs-source">Or pick contacts</legend>{snapshot.contacts.map(c=><label key={c.id} className="cs-check"><input type="checkbox" checked={audience.has(c.id)} onChange={e=>{const next=new Set(audience);if(e.target.checked)next.add(c.id);else next.delete(c.id);setAudience(next);}}/>{c.display_name} · {c.jurisdiction} · {label(c.consent)}</label>)}</fieldset>:<Empty title="No active contacts">Import lawful, consented contacts in Contacts first.</Empty>}
       <div className="cs-row"><button type="button" className="live-secondary" disabled={busy} onClick={()=>void act('setAudience',{id:campaign.id,version:version(),contactIds:[...audience],segment:{jurisdictions:segment.jurisdictions.split(',').map(s=>s.trim()).filter(Boolean),consents:segment.consents.split(',').map(s=>s.trim()).filter(Boolean)}},'Audience revision saved.')}>Save audience revision</button></div>
      </section>
      <section className="cs-section wide" aria-labelledby="cs-copy"><h4 id="cs-copy">Copy</h4>
       <p className="cs-source">Variables: {snapshot.templateVariables.map(v=>`{{${v}}}`).join(' ')}. Cite numbers with {'{{fact:<id>}}'}. Every save is a new immutable revision{detail?.template?` (current: revision ${detail.template.revision})`:''}.</p>
       <Field label="Subject"><input value={copy.subject} maxLength={240} onChange={e=>setCopy({...copy,subject:e.target.value})}/></Field>
       <Field label="Plain-text body"><textarea value={copy.bodyText} onChange={e=>setCopy({...copy,bodyText:e.target.value})}/></Field>
       <Field label="HTML body (optional, sanitized to a safe allowlist)"><textarea value={copy.bodyHtml} onChange={e=>setCopy({...copy,bodyHtml:e.target.value})}/></Field>
       {snapshot.facts.filter(f=>f.projectId===campaign.project_id).length?<details><summary>Vetted facts for this project</summary><ul className="cs-issues">{snapshot.facts.filter(f=>f.projectId===campaign.project_id).map(f=><li key={f.id}><code>{`{{fact:${f.id}}}`}</code>{f.label}: {f.body} <span className="cs-source">{f.usable?`source ${f.sourceUrl}, expires ${when(f.expiresAt)}`:'not usable: missing source or expired'}</span></li>)}</ul></details>:<p className="cs-source">No vetted facts yet. Copy without numbers or measurable claims can still pass.</p>}
       <div className="cs-row"><button type="button" className="live-secondary" disabled={busy||!copy.subject.trim()||!copy.bodyText.trim()} onClick={preview}>Preview with synthetic prospects</button><button type="button" className="live-primary" disabled={busy||!copy.subject.trim()||!copy.bodyText.trim()} onClick={()=>void act('editCopy',{id:campaign.id,version:version(),...copy,bodyHtml:copy.bodyHtml||undefined},'Copy saved as a new revision. Any approval was revoked.')}>Save copy revision</button></div>
       {previews&&<div className="cs-preview" aria-label="Rendered previews">
        {(previews.issues??[]).length?<ul className="cs-issues">{previews.issues.map((i:Row,n:number)=><li key={n} className={i.severity}><code>{i.code}</code>{i.message}</li>)}</ul>:<p className="cs-source">No claim, price or variable issues found in this copy.</p>}
        {previews.previews.map((p:Row)=><article key={p.persona}><strong>{p.persona} (synthetic)</strong><span>Subject: {p.subject}</span><pre>{p.text}</pre>{p.html&&<iframe title={`HTML preview for ${p.persona}`} sandbox="" srcDoc={p.html}/>}</article>)}
       </div>}
      </section>
      <section className="cs-section wide" aria-labelledby="cs-pricing"><h4 id="cs-pricing">Offer pricing guardrails</h4>
       {offer?<>
        <div className="cs-grid2"><Field label="Authorized prices (USD, comma separated)"><input value={priceRule.prices} onChange={e=>setPriceRule({...priceRule,prices:e.target.value})}/></Field><Field label="Maximum discount (%)"><input inputMode="decimal" value={priceRule.maxDiscount} onChange={e=>setPriceRule({...priceRule,maxDiscount:e.target.value})}/></Field></div>
        <Field label="Restricted phrases (comma separated)"><input value={priceRule.phrases} onChange={e=>setPriceRule({...priceRule,phrases:e.target.value})}/></Field>
        <div className="cs-row"><button type="button" className="live-secondary" disabled={busy} onClick={()=>{try{const prices=priceRule.prices.split(',').map(s=>s.trim()).filter(Boolean).map(dollarsToCents);void act('setPriceRule',{offerId:offer.id,authorizedPricesCents:prices,maxDiscountBp:Math.round(Number(priceRule.maxDiscount||0)*100),restrictedPhrases:priceRule.phrases.split(',').map(s=>s.trim()).filter(Boolean)},'Price rule saved.');}catch(e){setError(e instanceof Error?e.message:'Invalid prices.');}}}>Save price rule</button></div>
        <div className="cs-grid2"><Field label="Exception price (USD)"><input inputMode="decimal" value={exception.amount} onChange={e=>setException({...exception,amount:e.target.value})}/></Field><Field label="Exception discount (%)"><input inputMode="decimal" value={exception.discount} onChange={e=>setException({...exception,discount:e.target.value})}/></Field></div>
        <Field label="Reason for the exception"><input value={exception.reason} onChange={e=>setException({...exception,reason:e.target.value})}/></Field>
        <div className="cs-row"><button type="button" className="live-secondary" disabled={busy||!exception.reason.trim()} onClick={()=>{try{void act('requestPriceException',{id:campaign.id,amountCents:exception.amount?dollarsToCents(exception.amount):undefined,discountBp:exception.discount?Math.round(Number(exception.discount)*100):undefined,reason:exception.reason},'Exception requested; it applies only after the owner approves it below.');}catch(e){setError(e instanceof Error?e.message:'Invalid exception.');}}}>Request price exception</button></div>
       </>:<p className="cs-source">Select an offer to manage its authorized prices and discounts.</p>}
      </section>
      <section className="cs-section wide" aria-labelledby="cs-variants"><h4 id="cs-variants">Strategy and copy variants</h4>
       {detail?.variants.length?<ul className="cs-issues">{detail.variants.map(v=><li key={v.id}><strong>{v.label}</strong> · {label(v.status)} · weight {v.weight} · countries {(v.eligibility?.countries??[]).join(', ')||'any'} <span className="cs-source">strategy {String(v.strategy_id).slice(0,8)} · content revision {String(v.template_revision_id).slice(0,8)}</span>{v.status==='active'&&<div className="ops-row-actions"><button type="button" disabled={busy} onClick={()=>void act('retireVariant',{id:campaign.id,version:version(),variantId:v.id},'Variant retired; approval revoked.')}>Retire</button></div>}</li>)}</ul>:<p className="cs-source">No variants: every contact gets the campaign copy and strategy.</p>}
       {snapshot.templates.length&&snapshot.strategies.length?<div className="cs-grid2">
        <Field label="Variant name"><input value={variant.label} onChange={e=>setVariant({...variant,label:e.target.value})}/></Field>
        <Field label="Strategy"><select value={variant.strategyId} onChange={e=>setVariant({...variant,strategyId:e.target.value})}><option value="">Choose</option>{snapshot.strategies.map(s=><option key={s.id} value={s.id}>{s.label}</option>)}</select></Field>
        <Field label="Content revision"><select value={variant.templateRevisionId} onChange={e=>setVariant({...variant,templateRevisionId:e.target.value})}><option value="">Choose</option>{snapshot.templates.filter(t=>t.latest_revision_id).map(t=><option key={t.latest_revision_id} value={t.latest_revision_id}>{t.label} r{t.latest_revision}</option>)}</select></Field>
        <Field label="Eligible countries (optional)"><input value={variant.countries} onChange={e=>setVariant({...variant,countries:e.target.value})}/></Field>
        <Field label="Weight"><input type="number" min={1} max={10000} value={variant.weight} onChange={e=>setVariant({...variant,weight:e.target.value})}/></Field>
        <div className="cs-row"><button type="button" className="live-secondary" disabled={busy||!variant.label.trim()||!variant.strategyId||!variant.templateRevisionId} onClick={()=>void act('addVariant',{id:campaign.id,version:version(),label:variant.label,strategyId:variant.strategyId,templateRevisionId:variant.templateRevisionId,weight:Number(variant.weight),eligibility:{countries:variant.countries.split(',').map(s=>s.trim()).filter(Boolean)}},'Variant added; approval revoked.')}>Add variant</button></div>
       </div>:<p className="cs-source">Save copy and add a strategy to create variants.</p>}
      </section>
      <section className="cs-section wide" aria-labelledby="cs-review"><h4 id="cs-review">Review, simulation and approval</h4>
       {detail?.issues.length?<ul className="cs-issues" aria-label="Validation findings">{detail.issues.map((i,n)=><li key={n} className={i.severity}><code>{i.severity==='blocking'?'Blocking':'Note'} · {i.code}</code>{i.message}</li>)}</ul>:<p className="cs-source">No findings.</p>}
       <p className="cs-source">{blocking.length?`${blocking.length} blocking issue(s) must be fixed before approval.`:'No blocking issues.'} Eligible contacts: {detail?.eligible??0}; excluded: {detail?.excluded.length??0}.</p>
       <div className="cs-row">
        {can('validated')&&<button type="button" className="live-secondary" disabled={busy} onClick={()=>void act('validate',{id:campaign.id},'Validation finished.')}>Validate</button>}
        {!['archived','aborted','completed'].includes(state)&&<button type="button" className="live-secondary" disabled={busy} onClick={()=>void act('simulate',{id:campaign.id,sampleSize:3},'Dry run recorded: 0 messages sent, 0 network or billable requests.')}>Run dry-run simulation</button>}
        {state==='validated'&&<button type="button" className="live-primary" disabled={busy} onClick={()=>void act('requestApproval',{id:campaign.id},'Approval requested for this exact revision.')}>Request owner approval</button>}
        {pendingCampaignApproval&&<><button type="button" className="live-primary" disabled={busy} onClick={()=>void act('decideApproval',{approvalId:pendingCampaignApproval.id,approved:true},'Approved for this exact sender, audience, copy, budget and schedule.')}>Approve revision {campaign.revision}</button><button type="button" className="live-secondary" disabled={busy} onClick={()=>void act('decideApproval',{approvalId:pendingCampaignApproval.id,approved:false},'Approval rejected; campaign returned to draft.')}>Reject</button></>}
        {state==='approved'&&<button type="button" className="live-primary" disabled={busy} onClick={()=>void act('schedule',{id:campaign.id},'Campaign scheduled.')}>Schedule</button>}
        {state==='scheduled'&&<button type="button" className="live-primary" disabled={busy} onClick={()=>void act('activate',{id:campaign.id},'Campaign activated.')}>Activate (start time reached)</button>}
        {state==='active'&&<button type="button" className="live-primary" disabled={busy} onClick={()=>void act('generateWork',{id:campaign.id},'Work queued within approved limits.')}>Queue approved work</button>}
        {can('paused')&&<button type="button" className="live-secondary" disabled={busy} onClick={()=>void act('pause',{id:campaign.id},'Campaign paused; queued work is held.')}>Pause</button>}
        {state==='paused'&&<button type="button" className="live-secondary" disabled={busy} onClick={()=>void act('resume',{id:campaign.id},'Campaign resumed.')}>Resume</button>}
        {can('completed')&&<button type="button" className="live-secondary" disabled={busy} onClick={()=>void act('complete',{id:campaign.id},'Campaign completed.')}>Complete</button>}
        {can('aborted')&&<button type="button" className="live-secondary" disabled={busy} onClick={()=>void act('abort',{id:campaign.id},'Campaign aborted; unsent work cancelled.')}>Abort</button>}
        {can('archived')&&<button type="button" className="live-secondary" disabled={busy} onClick={()=>void act('archive',{id:campaign.id},'Campaign archived.')}>Archive</button>}
       </div>
       {detail?.simulations[0]&&(()=>{const r=detail.simulations[0].report;return <div className="cs-preview"><strong>Latest dry run · revision {detail.simulations[0].campaign_revision} · {when(detail.simulations[0].created_at)}</strong>
        <p className="cs-source">Eligible {r.audience.eligible} of {r.audience.total}; predicted maximum cost {money(r.predictedMaxCostCents)}; network requests {r.networkRequests}; billable inference {r.billableInferenceRequests}; messages sent {r.messagesSent}.</p>
        {Object.keys(r.audience.exclusionCounts??{}).length>0&&<ul className="cs-issues">{Object.entries(r.audience.exclusionCounts).map(([k,v])=><li key={k}><code>{k}</code>{String(v)} excluded</li>)}</ul>}
        <ul className="cs-issues">{r.proposedToolActions.map((a:Row)=><li key={a.tool}><code>{a.tool} × {a.count}</code>{a.note}</li>)}</ul>
       </div>;})()}
      </section>
      <section className="cs-section wide" aria-labelledby="cs-control"><h4 id="cs-control">Control room</h4>
       {detail?<>
        <div className="cs-funnel">{detail.funnel.map(f=><article key={f.stage}><span>{f.label}</span><strong>{f.unit==='cents'?money(f.value):f.value}</strong><small>Source: {f.source}</small></article>)}</div>
        <p className="cs-source">Expenses: provider-recorded {money(detail.expenses.providerCents)}; committed maximum for generated work {money(detail.expenses.committedMaxCents)}{detail.expenses.budgetTotalCents!==null?` of ${money(detail.expenses.budgetTotalCents)} budget`:''}. {detail.expenses.source}</p>
        {detail.buckets.length>0&&<p className="cs-source">Project buckets: {detail.buckets.map(b=>b.label).join(', ')}</p>}
        <h4>Owner decisions</h4>
        {detail.decisions.length?<ul className="cs-issues">{detail.decisions.map(d=><li key={d.id}><code>{label(d.action_kind)} · {d.status}</code>{when(d.created_at)}{d.action_kind==='quotation'&&d.status==='pending'&&<span className="ops-row-actions"><button type="button" disabled={busy} onClick={()=>void act('decidePriceException',{approvalId:d.id,approved:true,id:campaign.id},'Price exception approved.')}>Approve exception</button><button type="button" disabled={busy} onClick={()=>void act('decidePriceException',{approvalId:d.id,approved:false,id:campaign.id},'Price exception rejected.')}>Reject exception</button></span>}</li>)}</ul>:<p className="cs-source">No owner decisions recorded yet.</p>}
        <h4>Timeline</h4>
        {detail.timeline.length?<ol className="cs-timeline">{detail.timeline.map(e=><li key={e.id}><strong>{label(e.event_type)}</strong> · {label(e.actor_kind)} · {when(e.occurred_at)}</li>)}</ol>:<p className="cs-source">No events yet.</p>}
       </>:<p className="cs-source">Loading the control room…</p>}
      </section>
     </div>
    </>}
   </div>
  </div>
 </section>;
}
