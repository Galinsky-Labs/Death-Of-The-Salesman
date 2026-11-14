"use client";
/**
 * Funding command center (DOTS-121..134).
 * Navigation label: "Funding".
 * Grants, investor relations and sponsorships/partnerships are shown on separate boards. Nothing on this page
 * submits an application, signs, certifies or sends investor communication; it records owner actions and evidence.
 */
import {useCallback,useEffect,useId,useState,type FormEvent,type ReactNode} from 'react';
import '../operations.css';
import './funding-view.css';
type Row=Record<string,any>;
type Snapshot=Row&{pipeline:{grants:Row[];investors:Row[];sponsorships:Row[]};dashboard:Row};
type FieldType='text'|'textarea'|'select'|'dollars'|'date'|'datetime'|'list'|'checkbox'|'number';
type Field={name:string;label:string;type?:FieldType;options?:{value:string;label:string}[];required?:boolean;help?:string};
const tabs=['Pipeline','Directory','Applications','Calendar','Investors','Sponsorships','Awards'] as const;
const statusLanes=[{id:'lead',label:'Lead',note:'No money. Research, eligibility or interest only.'},{id:'pending_award',label:'Pending award',note:'Submitted or offered. Not cash.'},{id:'commitment',label:'Commitment',note:'Signed by owner. Not yet received.'},{id:'received',label:'Received',note:'Verified receipt in the ledger.'}];
const money=(value:unknown)=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(Number(value??0)/100);
const when=(value:unknown)=>value?new Date(String(value)).toLocaleString('en-US',{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}):'Not recorded';
const words=(value:unknown)=>String(value??'').replaceAll('_',' ');
function dollarsToCents(value:string){const input=value.trim();if(!input)return undefined;if(!/^\d+(\.\d{1,2})?$/.test(input))throw new Error('Enter a dollar amount with at most two decimal places.');const [d,f='']=input.split('.');return Number(d)*100+Number(f.padEnd(2,'0'));}
const tone=(value:string)=>['eligible','received','submitted','accepted','approved_after_legal_review','cleared_for_owner_send','ok','signed','exchanged'].includes(value)?'good':['ineligible','blocked','rejected','declined','overdue','waiting','blocked_external_prerequisite'].includes(value)?'bad':'neutral';
function Badge({value,label}:{value:unknown;label?:string}){const v=String(value??'unknown');return <span className={`ops-badge tone-${tone(v)}`}>{label?`${label}: `:''}{words(v)}</span>;}
function Empty({title,children}:{title:string;children:ReactNode}){return <div className="ops-empty"><h3>{title}</h3><p>{children}</p></div>;}

function ActionForm({title,action,fields,submit='Save',onRun,fixed={}}:{title:string;action:string;fields:Field[];submit?:string;onRun:(body:Row)=>Promise<boolean>;fixed?:Row}){
 const id=useId();const [values,setValues]=useState<Row>({});const [error,setError]=useState('');const [busy,setBusy]=useState(false);
 async function send(event:FormEvent){event.preventDefault();setError('');try{const body:Row={action,...fixed};for(const f of fields){const raw=values[f.name];
   if(f.type==='dollars'){const c=dollarsToCents(String(raw??''));if(c!==undefined)body[f.name]=c;}
   else if(f.type==='list')body[f.name]=String(raw??'').split(',').map(s=>s.trim()).filter(Boolean);
   else if(f.type==='checkbox')body[f.name]=raw===true;
   else if(f.type==='number'){if(raw!==undefined&&raw!=='')body[f.name]=Number(raw);}
   else if((f.type==='date'||f.type==='datetime')&&raw)body[f.name]=new Date(String(raw)).toISOString();
   else if(raw!==undefined&&raw!=='')body[f.name]=raw;}
  setBusy(true);if(await onRun(body))setValues({});}catch(e){setError(e instanceof Error?e.message:'Check the form values.');}finally{setBusy(false);}}
 return <form className="ops-form funding-form" onSubmit={send} aria-labelledby={`${id}-title`}><h3 id={`${id}-title`}>{title}</h3>
  {fields.map(f=>{const fid=`${id}-${f.name}`,value=values[f.name]??(f.type==='checkbox'?false:'');const set=(v:unknown)=>setValues({...values,[f.name]:v});
   return <div className="ops-field" key={f.name}><label htmlFor={fid}>{f.label}{f.required===false?<small> Optional</small>:null}</label>
    {f.type==='select'?<select id={fid} required={f.required!==false} value={String(value)} onChange={e=>set(e.target.value)}><option value="">Choose…</option>{f.options?.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}</select>
    :f.type==='textarea'?<textarea id={fid} rows={4} required={f.required!==false} value={String(value)} onChange={e=>set(e.target.value)}/>
    :f.type==='checkbox'?<input id={fid} type="checkbox" checked={Boolean(value)} onChange={e=>set(e.target.checked)}/>
    :<input id={fid} required={f.required!==false} inputMode={f.type==='dollars'||f.type==='number'?'decimal':undefined} type={f.type==='date'?'date':f.type==='datetime'?'datetime-local':'text'} value={String(value)} onChange={e=>set(e.target.value)} aria-describedby={f.help?`${fid}-help`:undefined}/>}
    {f.help?<p className="ops-field-help" id={`${fid}-help`}>{f.help}</p>:null}</div>;})}
  {error?<p role="alert" className="funding-error">{error}</p>:null}
  <div className="ops-form-actions"><button className="live-primary" type="submit" disabled={busy}>{busy?'Saving…':submit}</button></div></form>;
}

function OpportunityCard({card}:{card:Row}){
 const range=card.rangeMinCents!==null||card.rangeMaxCents!==null?`${card.rangeMinCents!==null?money(card.rangeMinCents):'?'} – ${card.rangeMaxCents!==null?money(card.rangeMaxCents):'?'}`:'Range not published';
 return <article className={`ops-card funding-card funding-${card.statusClass}`} aria-label={`${card.label}, ${words(card.statusClass)}`}>
  <div className="ops-card-heading"><h4>{card.label}</h4><span className="funding-status-label">{statusLanes.find(l=>l.id===card.statusClass)?.label}</span></div>
  <p className="ops-small">{card.funder} · Owner: {card.owner}</p>
  <dl className="ops-definition funding-facts">
   <div><dt>Funding range</dt><dd>{range}</dd></div>
   {card.kind!=='investment'?<div><dt>Requested (not money)</dt><dd>{money(card.requestedCents)}</dd></div>:null}
   <div><dt>Deadline</dt><dd>{when(card.deadline)} <Badge value={card.urgency}/></dd></div>
   <div><dt>Eligibility</dt><dd><Badge value={card.eligibility.result}/>{card.eligibility.citation?<> · <a href={card.eligibility.citation} rel="noreferrer noopener" target="_blank">rule source</a></>:null}</dd></div>
   {card.awardCents!==null?<div><dt>Award ({words(card.awardStatus)}, not cash)</dt><dd>{money(card.awardCents)}</dd></div>:null}
   {card.signedCommitmentCents>0?<div><dt>Signed, not received</dt><dd>{money(card.signedCommitmentCents)}</dd></div>:null}
   {card.hasInterest&&card.signedCommitmentCents===0?<div><dt>Investor interest</dt><dd>Recorded — not raised money</dd></div>:null}
   <div><dt>Received (ledger)</dt><dd>{money(card.receivedCents)}</dd></div>
  </dl>
  <p className="ops-source">{card.sourceUrl?<a href={card.sourceUrl} rel="noreferrer noopener" target="_blank">Official source</a>:'No source linked'}{card.sourceVerifiedAt?` · verified ${when(card.sourceVerifiedAt)}`:''}</p>
 </article>;
}
function Board({title,cards}:{title:string;cards:Row[]}){return <section className="funding-board" aria-label={title}><h3>{title}</h3>
 {cards.length?<div className="funding-lanes">{statusLanes.map(lane=>{const list=cards.filter(c=>c.statusClass===lane.id);return <section key={lane.id} className={`ops-lane funding-lane funding-${lane.id}`} aria-label={`${title}: ${lane.label}`}><h4>{lane.label} <span className="ops-small">({list.length})</span></h4><p className="ops-small">{lane.note}</p>{list.map(c=><OpportunityCard key={c.id} card={c}/>)}</section>;})}</div>
 :<Empty title={`No ${title.toLowerCase()} yet`}>Add an opportunity linked to a verified source. Nothing is shown until a real record exists.</Empty>}</section>;}

export function FundingView(){
 const [data,setData]=useState<Snapshot|null>(null);const [error,setError]=useState('');const [notice,setNotice]=useState('');const [tab,setTab]=useState<(typeof tabs)[number]>('Pipeline');const [filter,setFilter]=useState<Row>({});
 const load=useCallback(async(params:Row=filter)=>{const query=new URLSearchParams(Object.entries(params).filter(([,v])=>v)).toString();const response=await fetch(`/api/v1/funding${query?`?${query}`:''}`,{cache:'no-store'});const json=await response.json();if(!response.ok){setError(json.error??'FUNDING_UNAVAILABLE');return;}setError('');setData(json);},[filter]);
 useEffect(()=>{void load();},[load]);
 const run=useCallback(async(body:Row)=>{setNotice('');const response=await fetch('/api/v1/funding',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const json=await response.json();
  if(!response.ok){setError(json.error??'REQUEST_FAILED');return false;}setError('');setData(json.data);
  const o=json.outcome;setNotice(o?.saved===false?`Blocked: unsupported claims (${o.findings.map((f:Row)=>words(f.reason)).join(', ')}). Cite approved facts.`:o?.state==='waiting'?`Source unavailable (${words(o.reasonCode)}). Nothing was imported.`:o?.status==='blocked'?`Communication blocked: ${(o.findings??[]).join(', ')}`:`Saved: ${words(body.action)}.`);return true;},[]);
 const d:Row=data?.dashboard??{};const projects=(data?.projects??[]).map((p:Row)=>({value:p.id,label:p.label}));
 const sources=(data?.sources??[]).map((s:Row)=>({value:s.id,label:s.name}));const investors=(data?.investors??[]).map((i:Row)=>({value:i.id,label:i.name}));
 const opportunities=[...(data?.pipeline.grants??[]),...(data?.pipeline.investors??[]),...(data?.pipeline.sponsorships??[])].map((o:Row)=>({value:o.id,label:`${o.label} (${o.kind})`}));
 const button=(label:string,body:Row,className='live-secondary')=><button type="button" className={className} onClick={()=>void run(body)}>{label}</button>;
 return <section className="funding-view" aria-labelledby="funding-title">
  <div className="ops-section-heading"><div><h2 id="funding-title">Funding</h2><p className="ops-note">Grants, investor relations and sponsorships stay separate. The owner submits, signs and sends outside this system; the system records evidence and never treats interest, requests or awards as cash.</p></div></div>
  <div aria-live="polite" className="funding-notice">{notice}</div>
  {error?<p role="alert" className="funding-error">Error: {words(error)}</p>:null}
  {!data?<p className="ops-note">{error?'Funding data is unavailable.':'Loading funding records…'}</p>:<>
  <div className="ops-stat-grid funding-stats" aria-label="Funding performance">
   <div className="ops-card"><h3>Grants</h3><p>{d.grants.eligible} eligible · {d.grants.applied} applied · {d.grants.pending} pending · {d.grants.won} won</p><p className="ops-large-number">{money(d.grants.receivedCents)}</p><p className="ops-small">Received · {money(d.grants.restrictedReceivedCents)} restricted / {money(d.grants.unrestrictedReceivedCents)} unrestricted. Accepted awards {money(d.grants.wonAwardCents)} are not cash until received.</p></div>
   <div className="ops-card"><h3>Investors</h3><p>{d.investors.qualifiedMeetings} qualified meetings · {d.investors.interestedOpportunities} with interest (not money) · {d.investors.termSheets} term sheets</p><p className="ops-large-number">{money(d.investors.raisedCents)}</p><p className="ops-small">Raised = cash received. Signed but not received: {money(d.investors.signedCommitmentCents)}.</p></div>
   <div className="ops-card"><h3>Sponsorships &amp; partnerships</h3><p>{d.sponsorships.signed} signed</p><p className="ops-large-number">{money(d.sponsorships.cashReceivedCents)}</p><p className="ops-small">Cash received. In-kind value {money(d.sponsorships.inKindValueCents)} is tracked separately.</p></div>
   <div className="ops-card"><h3>Net funding received</h3><p className="ops-large-number">{money(d.netFunding.receivedCents)}</p><p><Badge value={d.netFunding.reconciled?'received':'blocked'} label={d.netFunding.reconciled?'Reconciled to ledger':'Ledger mismatch'}/></p><p className="ops-small">Excludes {d.netFunding.excluded.join(', ')}.</p></div>
  </div>
  <div className="ops-tabs" role="tablist" aria-label="Funding sections">{tabs.map(t=><button key={t} type="button" role="tab" aria-selected={tab===t} className={tab===t?'live-primary':'live-secondary'} onClick={()=>setTab(t)}>{t}</button>)}</div>
  <div role="tabpanel" aria-label={tab}>
  {tab==='Pipeline'?<>
   <Board title="Grants" cards={data.pipeline.grants}/><Board title="Investors" cards={data.pipeline.investors}/><Board title="Sponsorships and partnerships" cards={data.pipeline.sponsorships}/>
   <ActionForm title="Add funding opportunity" action="createOpportunity" onRun={run} fields={[{name:'projectId',label:'Project',type:'select',options:projects},{name:'kind',label:'Family',type:'select',options:['grant','investment','sponsorship','partnership'].map(v=>({value:v,label:v}))},{name:'label',label:'Opportunity name'},{name:'sourceId',label:'Directory source',type:'select',options:sources,required:false},{name:'investorId',label:'Investor (investment only)',type:'select',options:investors,required:false},{name:'funder',label:'Funder name if no source',required:false},{name:'ownerLabel',label:'Owner',required:false},{name:'requestedCents',label:'Requested amount (USD, not money)',type:'dollars',required:false},{name:'deadline',label:'Deadline',type:'datetime',required:false}]}/>
  </>:null}
  {tab==='Directory'?<>
   <form className="ops-toolbar funding-filter" onSubmit={e=>{e.preventDefault();void load(filter);}} aria-label="Filter funding sources">
    <label>Geography<input value={filter.geography??''} onChange={e=>setFilter({...filter,geography:e.target.value})} placeholder="US"/></label>
    <label>Entity type<input value={filter.entityType??''} onChange={e=>setFilter({...filter,entityType:e.target.value})} placeholder="nonprofit"/></label>
    <label>Type<select value={filter.kind??''} onChange={e=>setFilter({...filter,kind:e.target.value})}><option value="">Any</option>{['grant_program','foundation','government_agency','sponsor','partner','investor_fund'].map(k=><option key={k} value={k}>{words(k)}</option>)}</select></label>
    <label>Deadline before<input type="date" value={filter.deadlineBefore??''} onChange={e=>setFilter({...filter,deadlineBefore:e.target.value})}/></label>
    <button className="live-primary" type="submit">Apply filters</button><button className="live-secondary" type="button" onClick={()=>{setFilter({});void load({});}}>Clear</button>
   </form>
   {data.sources.length?<div className="ops-table-wrap"><table className="ops-table"><caption>Funding sources with provenance</caption><thead><tr><th scope="col">Source</th><th scope="col">Type</th><th scope="col">Geography / eligibility</th><th scope="col">Deadline</th><th scope="col">Verified</th><th scope="col">Provenance</th></tr></thead>
    <tbody>{data.sources.map((s:Row)=><tr key={s.id}><td><a href={s.source_url} target="_blank" rel="noreferrer noopener">{s.name}</a><br/><span className="ops-small">{s.funder}</span></td><td>{words(s.kind)}</td><td>{s.geography.join(', ')||'Unspecified'} / {s.entity_eligibility.join(', ')||'Review official notice'}</td><td>{when(s.deadline)} ({s.deadline_timezone})</td><td>{when(s.verified_at)} {s.needs_recheck||s.status==='stale'?<Badge value="waiting" label="Recheck"/>:null}</td><td className="ops-small">{words(s.connector)} · {String(s.provenance?.evidence??s.provenance?.opportunityNumber??'')}</td></tr>)}</tbody></table></div>
   :<Empty title="No sources match">Import a source with its official URL and evidence, or run the Grants.gov connector.</Empty>}
   <div className="ops-table-wrap"><table className="ops-table"><caption>Discovery connectors</caption><thead><tr><th scope="col">Connector</th><th scope="col">State</th><th scope="col">Last result</th></tr></thead><tbody>{data.connectors.map((c:Row)=><tr key={c.id}><td>{c.label}{c.prerequisite?<p className="ops-small">{c.prerequisite}</p>:null}</td><td><Badge value={c.state}/>{c.reasonCode?` ${words(c.reasonCode)}`:''}</td><td>{c.observedAt?`${c.lastResultCount} programs · ${when(c.observedAt)}`:'Not run'}</td></tr>)}</tbody></table></div>
   <div className="ops-card-grid">
    <ActionForm title="Search Grants.gov" action="discover" fixed={{connector:'grants_gov'}} submit="Search official source" onRun={run} fields={[{name:'keyword',label:'Keyword'}]}/>
    <ActionForm title="Import source manually" action="importSource" onRun={run} fields={[{name:'kind',label:'Type',type:'select',options:['grant_program','foundation','government_agency','sponsor','partner','investor_fund'].map(v=>({value:v,label:words(v)}))},{name:'name',label:'Program name'},{name:'funder',label:'Funder'},{name:'sourceUrl',label:'Official https URL'},{name:'evidence',label:'Evidence (what you reviewed)'},{name:'retrievedAt',label:'Retrieved at',type:'datetime'},{name:'geography',label:'Geographies (comma separated)',type:'list',required:false},{name:'entityEligibility',label:'Eligible entity types (comma separated)',type:'list',required:false},{name:'deadline',label:'Deadline',type:'datetime',required:false},{name:'deadlineTimezone',label:'Deadline timezone (IANA)',required:false,help:'Example: America/New_York'}]}/>
    <ActionForm title="Add eligibility rule" action="addEligibilityRule" onRun={run} fields={[{name:'sourceId',label:'Source',type:'select',options:sources},{name:'kind',label:'Rule kind',type:'select',options:['entity_type','jurisdiction','stage','restriction','required_document'].map(v=>({value:v,label:words(v)}))},{name:'allowed',label:'Allowed values (comma separated)',type:'list',required:false},{name:'description',label:'Rule text'},{name:'citationUrl',label:'Citation https URL'}]}/>
    <ActionForm title="Applicant profile" action="setApplicantProfile" onRun={run} fields={[{name:'projectId',label:'Project',type:'select',options:projects},{name:'entityType',label:'Entity type'},{name:'jurisdiction',label:'Jurisdiction (e.g. US-IL)'},{name:'stage',label:'Stage'}]}/>
   </div></>:null}
  {tab==='Applications'?<>
   {data.applications.length?data.applications.map((a:Row)=>{const answers=data.answers.filter((x:Row)=>x.application_id===a.id),docs=data.documents.filter((x:Row)=>x.application_id===a.id);return <article className="ops-card" key={a.id}><div className="ops-card-heading"><h3>{a.opportunity_label}</h3><Badge value={a.status}/></div>
    <ul className="ops-checklist">{answers.map((x:Row)=><li key={x.id}><strong>{x.question_key}</strong> <Badge value={x.status}/> <span className="ops-small">{words(x.source)} · {x.citations.length} citations</span><p>{x.answer||'No draft yet.'}</p>{x.status==='draft'?button('Mark reviewed',{action:'markAnswerReviewed',answerId:x.id,version:Number(x.version)}):null}</li>)}</ul>
    <ul className="ops-checklist">{docs.map((x:Row)=><li key={x.id}>{x.label} {x.required?'(required)':''} — {x.document_id?<Badge value="received" label="Attached"/>:<Badge value="waiting" label="Missing"/>} <span className="ops-small">{words(x.privacy_class)}</span></li>)}</ul>
    <div className="ops-row-actions">{a.status==='draft'?button('Request review',{action:'requestReview',applicationId:a.id}):null}{a.status==='in_review'?button('Approve for submission prep',{action:'reviewApplication',applicationId:a.id,decision:'approved_for_submission_prep'}):null}{a.status==='ready'?button('Freeze payload and request approval',{action:'prepareSubmission',applicationId:a.id},'live-primary'):null}
     {a.status==='awaiting_owner_submission'&&a.approval_id?button('Approve exact payload',{action:'decideSubmissionApproval',approvalId:a.approval_id,approved:true}):null}</div>
    {a.status==='ready'?<ActionForm title="Owner eligibility certification" action="certifyEligibility" fixed={{applicationId:a.id}} submit="Certify as owner" onRun={run} fields={[{name:'signerName',label:'Your full name'},{name:'statement',label:'Certification statement',type:'textarea'}]}/>:null}
    {a.status==='awaiting_owner_submission'?<ActionForm title="Record your manual submission" action="recordSubmission" fixed={{applicationId:a.id,approvalId:a.approval_id}} submit="Record submission evidence" onRun={run} fields={[{name:'evidenceKind',label:'Evidence type',type:'select',options:[{value:'provider_receipt',label:'Funder portal receipt number'},{value:'owner_verified',label:'Owner-verified confirmation'}]},{name:'evidenceRef',label:'Receipt or confirmation reference'}]}/>:null}
   </article>;}):<Empty title="No applications">Open an application from a grant opportunity. Drafts use only approved facts with citations.</Empty>}
   <div className="ops-card-grid">
    <ActionForm title="Open application" action="openApplication" onRun={async body=>run({...body,questions:(body.questions as string[]).map((q,i)=>({key:`q${i+1}`,prompt:q})),documents:(body.documents as string[]).map(label=>({label}))})} fields={[{name:'opportunityId',label:'Grant opportunity',type:'select',options:(data.pipeline.grants).map((o:Row)=>({value:o.id,label:o.label}))},{name:'questions',label:'Questions (comma separated)',type:'list'},{name:'documents',label:'Required documents (comma separated)',type:'list',required:false}]}/>
    <ActionForm title="Propose organization fact" action="addOrganizationFact" onRun={run} fields={[{name:'projectId',label:'Project',type:'select',options:projects},{name:'label',label:'Label'},{name:'statement',label:'Statement',type:'textarea'},{name:'evidenceRef',label:'Evidence reference'},{name:'category',label:'Category',type:'select',options:['organization','financial','traction','team','program'].map(v=>({value:v,label:v}))}]}/>
   </div>
   {data.facts.length?<div className="ops-table-wrap"><table className="ops-table"><caption>Organization facts (only approved facts can be cited)</caption><thead><tr><th scope="col">Fact id</th><th scope="col">Statement</th><th scope="col">Status</th><th scope="col">Action</th></tr></thead><tbody>{data.facts.map((f:Row)=><tr key={f.id}><td className="ops-hash">org:{f.id}</td><td>{f.statement}<br/><span className="ops-small">{f.evidence_ref}</span></td><td><Badge value={f.status}/></td><td>{f.status==='pending'?button('Approve',{action:'approveOrganizationFact',factId:f.id}):null}</td></tr>)}</tbody></table></div>:null}
  </>:null}
  {tab==='Calendar'?<>
   <div className="ops-row-actions">{button('Refresh reminders and stale rechecks',{action:'refreshReminders'},'live-primary')}<a className="live-secondary" href="/api/v1/funding?format=ics" download>Download deadlines (.ics)</a></div>
   {data.alerts.length?<ul className="ops-checklist" aria-label="Owner alerts">{data.alerts.map((a:Row)=><li key={a.id}><Badge value={a.alert_kind}/> {a.message} {button('Acknowledge',{action:'acknowledgeAlert',id:a.id})}</li>)}</ul>:<p className="ops-note">No open owner alerts.</p>}
   {data.milestones.length?<div className="ops-table-wrap"><table className="ops-table"><caption>Upcoming milestones (owner submits manually)</caption><thead><tr><th scope="col">Milestone</th><th scope="col">Due</th><th scope="col">Provenance</th><th scope="col">Action</th></tr></thead><tbody>{data.milestones.map((m:Row)=><tr key={m.id}><td>{m.label}</td><td>{new Date(m.due_at).toLocaleString('en-US',{timeZone:m.timezone,dateStyle:'medium',timeStyle:'short'})} {m.timezone}</td><td className="ops-small">{m.provenance?.sourceUrl?<a href={m.provenance.sourceUrl} target="_blank" rel="noreferrer noopener">source</a>:'no source'} · verified {when(m.provenance?.sourceVerifiedAt)} · published: {String(m.provenance?.deadlineAsPublished??'n/a')}</td><td>{button('Mark done',{action:'completeMilestone',id:m.id})}</td></tr>)}</tbody></table></div>:<Empty title="No milestones">Schedule a review timeline from an opportunity with a deadline.</Empty>}
   <ActionForm title="Schedule review timeline" action="scheduleTimeline" onRun={run} fields={[{name:'opportunityId',label:'Opportunity',type:'select',options:opportunities},{name:'timezone',label:'Timezone (IANA)',help:'Example: America/Chicago'}]}/>
  </>:null}
  {tab==='Investors'?<>
   {data.investors.length?<div className="ops-table-wrap"><table className="ops-table"><caption>Investor organizations</caption><thead><tr><th scope="col">Investor</th><th scope="col">Relationship</th><th scope="col">Accreditation</th><th scope="col">Allowed communication</th></tr></thead><tbody>{data.investors.map((i:Row)=><tr key={i.id}><td>{i.name}</td><td>{words(i.relationship)}</td><td><Badge value={i.accreditation}/></td><td>{i.allowed_communication_classes.map(words).join(', ')}</td></tr>)}</tbody></table></div>:<Empty title="No investors">Add an investor organization. Communication is classified, never sent automatically.</Empty>}
   {data.communications.length?<ul className="ops-checklist" aria-label="Communication reviews">{data.communications.map((c:Row)=><li key={c.id}><Badge value={c.status}/> {words(c.communication_class)} <span className="ops-small">{c.findings.join(', ')}</span>{c.status==='owner_legal_review_required'?<ActionForm title="Owner + legal decision" action="decideInvestorCommunication" fixed={{reviewId:c.id,approve:true}} submit="Approve after legal review" onRun={run} fields={[{name:'legalReviewRef',label:'Legal review reference'}]}/>:null}</li>)}</ul>:null}
   <div className="ops-card-grid">
    <ActionForm title="Add investor" action="addInvestor" onRun={run} fields={[{name:'name',label:'Organization name'},{name:'kind',label:'Kind',type:'select',options:['angel','venture_fund','corporate','family_office','accelerator','other'].map(v=>({value:v,label:words(v)}))},{name:'relationship',label:'Relationship',type:'select',options:['none','introduced','preexisting_substantive'].map(v=>({value:v,label:words(v)}))},{name:'allowedCommunicationClasses',label:'Allowed classes (comma separated)',type:'list',required:false,help:'meeting_logistics, relationship_update, factual_company_update, offering_material'}]}/>
    <ActionForm title="Record meeting" action="recordMeeting" onRun={run} fields={[{name:'investorId',label:'Investor',type:'select',options:investors},{name:'occurredAt',label:'Occurred at',type:'datetime'},{name:'qualified',label:'Qualified meeting',type:'checkbox',required:false},{name:'interestLevel',label:'Interest level',type:'select',options:['none','low','medium','high'].map(v=>({value:v,label:v}))},{name:'evidenceRef',label:'Evidence (calendar or notes reference)'}]}/>
    <ActionForm title="Classify investor communication" action="reviewInvestorCommunication" submit="Classify (does not send)" onRun={run} fields={[{name:'investorId',label:'Investor',type:'select',options:investors},{name:'communicationClass',label:'Class',type:'select',options:['meeting_logistics','relationship_update','factual_company_update','offering_material'].map(v=>({value:v,label:words(v)}))},{name:'content',label:'Draft content',type:'textarea'},{name:'projectId',label:'Project for fact citations',type:'select',options:projects,required:false},{name:'factIds',label:'Cited fact ids (comma separated)',type:'list',required:false}]}/>
   </div></>:null}
  {tab==='Sponsorships'?<>
   {data.sponsorships.length?<ul className="ops-checklist">{data.sponsorships.map((w:Row)=><li key={w.id}><Badge value={w.stage}/> {opportunities.find(o=>o.value===w.opportunity_id)?.label} {w.stage==='proposal'?button('Owner approve proposal',{action:'advanceSponsorship',workflowId:w.id,stage:'approved',version:Number(w.version)}):null}
    {w.stage==='contract_review'?<ActionForm title="Record owner signature" action="advanceSponsorship" fixed={{workflowId:w.id,stage:'signed',version:Number(w.version)}} submit="Record signed agreement" onRun={run} fields={[{name:'authorityRef',label:'Owner authority / signature reference'}]}/>:null}</li>)}</ul>:<Empty title="No sponsorship workflows">Start one from a sponsorship or partnership opportunity.</Empty>}
   <ActionForm title="Start workflow" action="startSponsorship" onRun={run} fields={[{name:'opportunityId',label:'Opportunity',type:'select',options:data.pipeline.sponsorships.map((o:Row)=>({value:o.id,label:o.label}))}]}/>
  </>:null}
  {tab==='Awards'?<>
   {data.awards.length?<div className="ops-table-wrap"><table className="ops-table"><caption>Awards (not cash until a receipt is recorded)</caption><thead><tr><th scope="col">Award</th><th scope="col">Status</th><th scope="col">Amount</th><th scope="col">Restricted</th><th scope="col">Action</th></tr></thead><tbody>{data.awards.map((a:Row)=><tr key={a.id}><td className="ops-small">{opportunities.find(o=>o.value===a.opportunity_id)?.label}</td><td><Badge value={a.status}/></td><td>{money(a.amount_cents)}</td><td>{money(a.restricted_cents)}</td><td>{a.status==='offered'?<ActionForm title="Accept award" action="decideAward" fixed={{awardId:a.id,accept:true,version:Number(a.version)}} submit="Accept as owner" onRun={run} fields={[{name:'authorityRef',label:'Signed acceptance reference'}]}/>:null}
    {a.status==='accepted'?<ActionForm title="Record received disbursement" action="recordDisbursement" fixed={{awardId:a.id}} submit="Record receipt" onRun={run} fields={[{name:'amountCents',label:'Amount received (USD)',type:'dollars'},{name:'evidenceRef',label:'Bank or funder receipt reference'},{name:'idempotencyKey',label:'Unique receipt key'}]}/>:null}</td></tr>)}</tbody></table></div>:<Empty title="No awards">Awards can be recorded only after an application is submitted with evidence.</Empty>}
  </>:null}
  </div></>}
 </section>;
}
