"use client";
// DOTS-080 CRM view. Navigation labels: "Contacts" (lead cards, account map, imports, merge review, do-not-contact
// and segments) and "Pipeline" (stage board, deals, forecast/invoiced/received and attribution).
// Pass section="contacts" or section="pipeline" from the navigation entry. Every number shown comes from the
// /api/v1/crm snapshot; empty states say which evidence is missing. Nothing here sends or queues outreach.
import {useCallback,useEffect,useState,type FormEvent,type ReactNode} from 'react';
import '../operations.css';
import './crm-view.css';

type Row=Record<string,any>;
type Snapshot={contacts:{items:Row[];nextCursor:string|null};accountMap:{accounts:Row[];unassignedContacts:number};candidates:Row[];imports:Row[];segments:Row[];pipelines:Row[];
 financials:{deals:Row[];totals:{forecastCents:number;invoicedCents:number;receivedCents:number}};claims:Row[];conflicts:Row[];contactPolicy:Row;regions:Row[];campaigns:Row[];agents:Row[];projects:Row[];
 counts:Row;attribution:{byCampaign:Row[];attributedDeals:number};inspector:Row|null;observedAt:string};
type Section='contacts'|'pipeline';
const money=(value:unknown)=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(Number(value??0)/100);
const when=(value:unknown)=>value?new Date(String(value)).toLocaleString('en-US',{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'}):'—';
const label=(value:unknown)=>String(value??'').replaceAll('_',' ');
const sourceKinds=['opt_in_form','owner_collected','existing_customer','event_registration','referral','public_business_directory'];
const consents=['unknown','opted_in','existing_customer','business_reviewed'];
const evidenceKinds=['owner_note','document','paid_invoice','provider_receipt','none'];
const errorText:Record<string,string>={WON_REQUIRES_VERIFIED_PAYMENT_OR_SIGNATURE:'Won needs a paid live invoice, a provider receipt or a stored signed agreement linked to this deal.',STAGE_REQUIRES_OWNER_NOTE:'This stage needs an owner note of at least 10 characters.',TRANSITION_NOT_ALLOWED:'This pipeline does not allow that move.',CROSS_ACCOUNT_MERGE_REQUIRES_CONFIRMATION:'These contacts belong to different accounts. Confirm the cross-account merge first.',SUPPRESSED_CONTACT_REQUIRES_LAWFUL_OVERRIDE:'This contact is on the do-not-contact list. Use a lawful override with an audit reference.',LAWFUL_AUDIT_REQUIRED:'An audit reference is required.',PRIVACY_ERASURE_CANNOT_BE_OVERRIDDEN:'Privacy erasures are permanent.',OPT_OUT_REQUIRES_NEW_OPT_IN:'An opt-out can only be lifted with a documented new opt-in.',PROHIBITED_SOURCE:'Purchased, scraped or unknown sources cannot be imported.',SEGMENT_FIELD_NOT_ALLOWED:'Segments may only use approved firmographic, consent and source fields.',STALE_RECORD:'This record changed. Refresh and try again.'};
const readable=(code:string)=>errorText[code]??`${label(code).toLowerCase()}.`;

function Field({id,text,children}:{id:string;text:string;children:ReactNode}){return <div className="ops-field"><label htmlFor={id}>{text}</label>{children}</div>;}
function Empty({title,children}:{title:string;children:ReactNode}){return <div className="ops-empty"><h3>{title}</h3><p>{children}</p></div>;}
function parseRows(textValue:string){
 return textValue.split(/\r?\n/).map(line=>line.trim()).filter(Boolean).slice(0,1000).map(line=>{const [name,email,account,jurisdiction,consent,consentEvidence]=line.split(',').map(part=>part?.trim());return {name,email,account,jurisdiction,consent,consentEvidence};});
}

export function CrmView({section:initial='contacts'}:{section?:Section}={}){
 const [section,setSection]=useState<Section>(initial);
 const [data,setData]=useState<Snapshot|null>(null);
 const [query,setQuery]=useState('');const [cursor,setCursor]=useState<string|null>(null);
 const [extra,setExtra]=useState<Row[]>([]);
 const [inspect,setInspect]=useState<string|null>(null);
 const [selected,setSelected]=useState<string[]>([]);
 const [notice,setNotice]=useState('');const [error,setError]=useState('');const [busy,setBusy]=useState(false);
 const [importReport,setImportReport]=useState<Row|null>(null);const [importPreview,setImportPreview]=useState<Row[]>([]);
 const [segmentPreview,setSegmentPreview]=useState<Row|null>(null);
 const [moves,setMoves]=useState<Record<string,{stage:string;kind:string;ref:string}>>({});
 const [pipelineId,setPipelineId]=useState<string>('');
 const [confirmCross,setConfirmCross]=useState(false);

 const load=useCallback(async(options:{q?:string;contact?:string|null}={})=>{
  const params=new URLSearchParams();const q=options.q??query;if(q)params.set('q',q);const contact=options.contact===undefined?inspect:options.contact;if(contact)params.set('contact',contact);
  const response=await fetch(`/api/v1/crm?${params}`,{cache:'no-store'});const body=await response.json().catch(()=>({error:'OPERATION_UNAVAILABLE'}));
  if(!response.ok){setError(readable(String(body.error)));return;}
  setData(body as Snapshot);setCursor((body as Snapshot).contacts.nextCursor);setExtra([]);setError('');
 },[query,inspect]);
 useEffect(()=>{void load();},[]);

 async function act(action:string,payload:Row,success:string){
  setBusy(true);setError('');setNotice('');
  try{
   const response=await fetch('/api/v1/crm',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,...payload})});
   const body=await response.json().catch(()=>({error:'OPERATION_UNAVAILABLE'}));
   if(!response.ok){setError(readable(String(body.error)));return null;}
   setNotice(success);await load();return body.outcome as Row;
  }finally{setBusy(false);}
 }
 async function more(){if(!cursor)return;const params=new URLSearchParams({cursor});if(query)params.set('q',query);const response=await fetch(`/api/v1/crm?${params}`,{cache:'no-store'});const body=await response.json();if(response.ok){setExtra(current=>[...current,...body.contacts.items]);setCursor(body.contacts.nextCursor);}}
 const form=(event:FormEvent<HTMLFormElement>)=>{event.preventDefault();return Object.fromEntries(new FormData(event.currentTarget).entries()) as Record<string,string>;};
 const toggle=(id:string)=>setSelected(current=>current.includes(id)?current.filter(item=>item!==id):[...current,id].slice(0,100));

 const contacts=[...(data?.contacts.items??[]),...extra];
 const pipeline=data?.pipelines.find(item=>item.id===pipelineId)??data?.pipelines[0];
 const deals=(data?.financials.deals??[]).filter(deal=>!pipeline||deal.pipeline_id===pipeline.id);

 return <section className="crm-view" aria-labelledby="crm-heading">
  <div className="ops-section-heading"><h3 id="crm-heading">{section==='contacts'?'Contacts':'Pipeline'}</h3>
   <div className="ops-tabs" role="tablist" aria-label="CRM sections">{(['contacts','pipeline'] as Section[]).map(item=><button key={item} role="tab" aria-selected={section===item} className={section===item?'selected':''} onClick={()=>setSection(item)}>{item==='contacts'?'Contacts':'Pipeline'}</button>)}</div>
  </div>
  <p className="crm-live" aria-live="polite">{notice}</p>
  {error&&<p className="ops-note crm-error" role="alert">{error}</p>}
  {!data&&!error&&<p className="ops-note" aria-busy="true">Loading CRM records…</p>}
  {data&&section==='contacts'&&<>
   <div className="ops-stat-grid">
    <article><span>Active contacts</span><strong>{data.counts.active}</strong><small>Stored records, not prospects contacted.</small></article>
    <article><span>Do-not-contact</span><strong>{data.counts.suppression_entries}</strong><small>Universal suppression entries across all agents and campaigns.</small></article>
    <article><span>Merged duplicates</span><strong>{data.counts.merged}</strong><small>Kept with original sources and conversations.</small></article>
    <article><span>Open merge reviews</span><strong>{data.candidates.length}</strong><small>Owner decision required; nothing merges automatically.</small></article>
   </div>

   <form className="ops-inline-tools" role="search" onSubmit={event=>{event.preventDefault();void load({q:query});}}>
    <label className="crm-sr" htmlFor="crm-search">Search contacts by name, alias, address or domain</label>
    <input id="crm-search" value={query} onChange={event=>setQuery(event.target.value)} placeholder="Name, alias, address or domain"/>
    <button className="live-secondary" type="submit">Search</button>
   </form>

   <div className="crm-bulk" aria-label="Bulk review">
    <strong>Bulk review</strong><span>{selected.length} selected</span>
    {[['assign_to_me','Assign to me'],['archive','Archive'],['suppress','Add to do-not-contact'],['detect_duplicates','Find duplicates']].map(([value,text])=><button key={value} className="live-secondary" disabled={busy||!selected.length} onClick={async()=>{if(await act('bulkReview',{contactIds:selected,bulkAction:value},`${text}: done.`))setSelected([]);}}>{text}</button>)}
   </div>

   <div className="crm-layout">
    <div>
     <h4 className="crm-subheading">Lead cards</h4>
     {contacts.length?<ul className="crm-cards">{contacts.map(contact=><li key={contact.id} className={`ops-card crm-lead${inspect===contact.id?' selected':''}`}>
      <div className="ops-card-heading"><h3>{contact.display_name}</h3><span className={`ops-badge ${contact.status==='active'?'tone-good':'tone-bad'}`}>{label(contact.status)}</span></div>
      <small>{contact.email_masked??'No address'} · {label(contact.consent)} · {contact.jurisdiction}</small>
      <div className="ops-row-actions">
       <label className="crm-check"><input type="checkbox" checked={selected.includes(contact.id)} onChange={()=>toggle(contact.id)}/> Select {contact.display_name}</label>
       <button className="live-secondary" onClick={()=>{setInspect(contact.id);void load({contact:contact.id});}}>Inspect</button>
      </div>
     </li>)}</ul>:<Empty title="No contacts yet">Add a person with a lawful source or stage an import. Nothing is contacted when records are created.</Empty>}
     {cursor&&<button className="live-secondary crm-more" onClick={()=>void more()}>Load more contacts</button>}
    </div>
    <aside className="ops-card crm-inspector" aria-label="Contact inspector">
     {data.inspector?<Inspector detail={data.inspector} busy={busy} act={act} campaigns={data.campaigns} agents={data.agents}/>:<Empty title="Contact inspector">Choose Inspect on a lead card to see sources, consent history, ownership and the evidence timeline.</Empty>}
    </aside>
   </div>

   <h4 className="crm-subheading">Account map</h4>
   {data.accountMap.accounts.length?<ul className="crm-accounts">{data.accountMap.accounts.map(account=><li key={account.id} className="ops-card">
    <div className="ops-card-heading"><h3>{account.name}</h3><span className="ops-badge">{account.contact_count} contacts</span></div>
    <small>{account.domain??'No domain'}{account.sector?` · ${account.sector}`:''}{account.aliases?.length?` · aka ${account.aliases.map((a:Row)=>a.alias).join(', ')}`:''}</small>
    <ul className="crm-chips">{account.contacts.map((contact:Row)=><li key={contact.id}><button onClick={()=>{setInspect(contact.id);void load({contact:contact.id});}}>{contact.display_name}</button></li>)}</ul>
   </li>)}</ul>:<Empty title="No accounts">Accounts appear when you add one or import rows with an account name.</Empty>}
   <p className="ops-small">{data.accountMap.unassignedContacts} contacts have no account.</p>

   <div className="ops-card-grid crm-forms">
    <form className="ops-card" onSubmit={event=>{const v=form(event);void act('createPerson',{name:v.name,email:v.email,role:v.role||undefined,consent:v.consent,consentEvidence:v.consentEvidence||undefined,jurisdiction:v.jurisdiction||undefined,source:{label:v.sourceLabel,kind:v.sourceKind,purpose:v.purpose,lawfulBasis:v.lawfulBasis}},'Person saved. No outreach was created.');}}>
     <h3>Add a person</h3>
     <Field id="p-name" text="Name"><input id="p-name" name="name" required maxLength={160}/></Field>
     <Field id="p-email" text="Email address"><input id="p-email" name="email" type="email" required/></Field>
     <Field id="p-role" text="Role (optional)"><input id="p-role" name="role" maxLength={160}/></Field>
     <Field id="p-source" text="Lead source"><input id="p-source" name="sourceLabel" required maxLength={500} placeholder="Where this person came from"/></Field>
     <SourceSelects prefix="p"/>
     <Field id="p-consent" text="Consent"><select id="p-consent" name="consent">{consents.map(item=><option key={item} value={item}>{label(item)}</option>)}</select></Field>
     <Field id="p-evidence" text="Consent evidence reference"><input id="p-evidence" name="consentEvidence" maxLength={1000}/></Field>
     <Field id="p-region" text="Jurisdiction (e.g. US)"><input id="p-region" name="jurisdiction" maxLength={6}/></Field>
     <button className="live-primary" disabled={busy}>Save person</button>
    </form>
    <form className="ops-card" onSubmit={async event=>{const v=form(event);const report=await act('createAccount',{name:v.name,domain:v.domain||undefined,sector:v.sector||undefined,allowSimilar:v.allowSimilar==='on'},'Account request processed.');if(report&&!report.created)setError(`Similar account exists: ${report.similar.map((s:Row)=>`${s.name} (${label(s.reason)})`).join(', ')}. Nothing was merged; tick “create anyway” only if it is a different organization.`);}}>
     <h3>Add an account</h3>
     <Field id="a-name" text="Organization name"><input id="a-name" name="name" required maxLength={160}/></Field>
     <Field id="a-domain" text="Domain (optional)"><input id="a-domain" name="domain"/></Field>
     <Field id="a-sector" text="Sector (optional)"><input id="a-sector" name="sector" maxLength={120}/></Field>
     <label className="crm-check"><input type="checkbox" name="allowSimilar"/> Create anyway if a similar organization exists</label>
     <button className="live-primary" disabled={busy}>Save account</button>
    </form>
   </div>

   <h4 className="crm-subheading">Import staging</h4>
   <div className="ops-card-grid">
    <form className="ops-card" onSubmit={async event=>{const v=form(event);const report=await act('stageImport',{source:{label:v.sourceLabel,kind:v.sourceKind,purpose:v.purpose,lawfulBasis:v.lawfulBasis},rows:parseRows(v.rows??'')},'Import staged for preview. Nothing has been created yet.');if(report){setImportReport(report);const preview=await act('previewImport',{id:report.batchId},'Preview loaded.');setImportPreview(preview?.items??[]);}}}>
     <h3>Stage rows</h3>
     <Field id="i-source" text="Source description"><input id="i-source" name="sourceLabel" required maxLength={500}/></Field>
     <SourceSelects prefix="i"/>
     <Field id="i-rows" text="Rows: name, email, account, jurisdiction, consent, consent evidence"><textarea id="i-rows" name="rows" rows={6} required/></Field>
     <button className="live-primary" disabled={busy}>Validate and preview</button>
    </form>
    <div className="ops-card" aria-live="polite">
     <h3>Validation report</h3>
     {importReport?<>
      <dl className="ops-card-metrics"><div><dt>Valid</dt><dd>{importReport.valid}</dd></div><div><dt>Quarantined</dt><dd>{importReport.quarantined}</dd></div><div><dt>Duplicates</dt><dd>{importReport.duplicate}</dd></div><div><dt>Suppressed</dt><dd>{importReport.suppressed}</dd></div></dl>
      <ul className="crm-reasons">{Object.entries(importReport.reasons??{}).map(([code,n])=><li key={code}><span className="ops-badge">{label(code)}</span> {String(n)}</li>)}</ul>
      <ul className="crm-preview">{importPreview.map(row=><li key={row.row_number}><strong>#{row.row_number} {row.display_name??'—'}</strong> <small>{row.email_masked??'invalid address'} · {label(row.status)}{row.reasons?.length?` · ${row.reasons.map(label).join(', ')}`:''}</small></li>)}</ul>
      <div className="ops-row-actions"><button className="live-primary" disabled={busy} onClick={async()=>{if(await act('commitImport',{id:importReport.batchId},'Import committed. Valid rows created; quarantined rows untouched; no outreach.')){setImportReport(null);setImportPreview([]);}}}>Commit valid rows</button>
       <button className="live-secondary" disabled={busy} onClick={async()=>{if(await act('discardImport',{id:importReport.batchId},'Import discarded.')){setImportReport(null);setImportPreview([]);}}}>Discard</button></div>
     </>:<p className="ops-small">Stage rows to see which are valid, quarantined, duplicated or suppressed before anything is committed.</p>}
     {data.imports.length>0&&<ul className="crm-preview">{data.imports.map(batch=><li key={batch.id}><strong>{batch.source_label}</strong> <small>{label(batch.state)} · {batch.valid_rows} valid · {batch.quarantined_rows} quarantined · {when(batch.created_at)}</small></li>)}</ul>}
    </div>
   </div>

   <h4 className="crm-subheading">Merge review</h4>
   <label className="crm-check"><input type="checkbox" checked={confirmCross} onChange={event=>setConfirmCross(event.target.checked)}/> I confirm merges across different accounts are the same person</label>
   {data.candidates.length?<ul className="crm-cards">{data.candidates.map(candidate=><li key={candidate.id} className="ops-card">
    <div className="ops-card-heading"><h3>{candidate.primary_name} ↔ {candidate.duplicate_name}</h3><span className="ops-badge">Score {candidate.score}</span></div>
    <small>{candidate.primary_email_masked} · {candidate.duplicate_email_masked}</small>
    <p className="ops-small">{candidate.reasons.map(label).join(', ')}</p>
    <div className="ops-row-actions"><button className="live-primary" disabled={busy} onClick={()=>void act('mergeContacts',{survivorId:candidate.primary_contact_id,duplicateId:candidate.duplicate_contact_id,candidateId:candidate.id,confirmCrossAccount:confirmCross},'Merged. Original sources and conversations were kept.')}>Merge into {candidate.primary_name}</button>
     <button className="live-secondary" disabled={busy} onClick={()=>void act('dismissCandidate',{id:candidate.id},'Kept as separate people.')}>Not the same person</button></div>
   </li>)}</ul>:<Empty title="No merge reviews">Possible duplicates appear here after creation or import. They are never merged without your decision.</Empty>}

   <h4 className="crm-subheading">Do-not-contact and policy</h4>
   <div className="ops-card-grid crm-forms">
    <form className="ops-card" onSubmit={event=>{const v=form(event);void act('suppress',{email:v.email,reason:v.reason||'OWNER_REQUEST'},'Address added to the universal do-not-contact list.');}}>
     <h3>Suppress an address</h3>
     <Field id="s-email" text="Email address"><input id="s-email" name="email" type="email" required/></Field>
     <Field id="s-reason" text="Reason code"><input id="s-reason" name="reason" maxLength={120}/></Field>
     <button className="live-primary" disabled={busy}>Add to do-not-contact</button>
    </form>
    <form className="ops-card" onSubmit={event=>{const v=form(event);void act('setRegionPolicy',{jurisdiction:v.jurisdiction,allowed:v.allowed==='on',requiresOptIn:v.optIn==='on',legalReviewRef:v.ref},'Region policy saved.');}}>
     <h3>Region policy</h3>
     <Field id="r-code" text="Jurisdiction code"><input id="r-code" name="jurisdiction" required maxLength={6}/></Field>
     <Field id="r-ref" text="Legal review reference"><input id="r-ref" name="ref" required maxLength={240}/></Field>
     <label className="crm-check"><input type="checkbox" name="allowed"/> Contact allowed</label>
     <label className="crm-check"><input type="checkbox" name="optIn" defaultChecked/> Requires explicit opt-in</label>
     <button className="live-primary" disabled={busy}>Save region</button>
     <ul className="crm-chips">{data.regions.map(region=><li key={region.jurisdiction}><span className={`ops-badge ${region.allowed?'tone-good':'tone-bad'}`}>{region.jurisdiction} {region.allowed?(region.requires_opt_in?'opt-in only':'allowed'):'blocked'}</span></li>)}</ul>
     {!data.regions.length&&<p className="ops-small">No region is allowed yet, so no contact is eligible.</p>}
    </form>
    <form className="ops-card" onSubmit={event=>{const v=form(event);void act('setContactPolicy',{maxTouches:Number(v.maxTouches),windowDays:Number(v.windowDays),exclusionDays:Number(v.exclusionDays)},'Frequency and exclusion policy saved.');}}>
     <h3>Frequency and ownership</h3>
     <Field id="c-max" text="Maximum outreach touches per window"><input id="c-max" name="maxTouches" type="number" min={1} max={20} defaultValue={data.contactPolicy.maxTouches}/></Field>
     <Field id="c-window" text="Window (days)"><input id="c-window" name="windowDays" type="number" min={1} max={365} defaultValue={data.contactPolicy.windowDays}/></Field>
     <Field id="c-excl" text="Agent exclusion after release (days)"><input id="c-excl" name="exclusionDays" type="number" min={0} max={365} defaultValue={data.contactPolicy.exclusionDays}/></Field>
     <button className="live-primary" disabled={busy}>Save policy</button>
     <p className="ops-small">{data.claims.length} active prospect claims · {data.conflicts.length} recent ownership conflicts.</p>
    </form>
   </div>

   <h4 className="crm-subheading">Segments</h4>
   <div className="ops-card-grid crm-forms">
    <form className="ops-card" onSubmit={async event=>{const v=form(event);const list=(value?:string)=>value?value.split(',').map(item=>item.trim()).filter(Boolean):undefined;
     const filter:Row={sectors:list(v.sectors),jurisdictions:list(v.jurisdictions),consents:list(v.consents),sourceKinds:list(v.sourceKinds),metadata:v.industry?{industry:v.industry}:undefined};Object.keys(filter).forEach(key=>filter[key]===undefined&&delete filter[key]);
     const submitter=(event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement|null;
     if(submitter?.value==='save')await act('saveSegment',{label:v.label||'Untitled segment',filter},'Segment saved.');else setSegmentPreview(await act('previewSegment',{filter},'Preview ready. No model or paid call was made.'));}}>
     <h3>Saved filter</h3>
     <Field id="g-label" text="Segment name"><input id="g-label" name="label" maxLength={160}/></Field>
     <Field id="g-sectors" text="Account sectors (comma separated)"><input id="g-sectors" name="sectors"/></Field>
     <Field id="g-regions" text="Jurisdictions (comma separated)"><input id="g-regions" name="jurisdictions"/></Field>
     <Field id="g-consents" text="Consent states (comma separated)"><input id="g-consents" name="consents"/></Field>
     <Field id="g-sources" text="Source kinds (comma separated)"><input id="g-sources" name="sourceKinds"/></Field>
     <Field id="g-industry" text="Industry metadata"><input id="g-industry" name="industry"/></Field>
     <div className="ops-row-actions"><button className="live-secondary" value="preview" disabled={busy}>Preview</button><button className="live-primary" value="save" disabled={busy}>Save segment</button></div>
    </form>
    <div className="ops-card" aria-live="polite">
     <h3>Preview</h3>
     {segmentPreview?<><dl className="ops-card-metrics"><div><dt>Matched</dt><dd>{segmentPreview.matched}</dd></div><div><dt>Eligible</dt><dd>{segmentPreview.eligible}</dd></div></dl>
      <ul className="crm-reasons">{segmentPreview.exclusions.map((item:Row)=><li key={item.reason}><span className="ops-badge tone-bad">{label(item.reason)}</span> {item.count}</li>)}</ul></>
      :<p className="ops-small">Preview a filter to see the count and every exclusion reason. Only stored fields are used.</p>}
     <ul className="crm-chips">{data.segments.map(segment=><li key={segment.id}><button onClick={async()=>setSegmentPreview(await act('previewSegment',{segmentId:segment.id},`Preview of ${segment.label} ready.`))}>{segment.label}</button></li>)}</ul>
    </div>
   </div>
  </>}

  {data&&section==='pipeline'&&<>
   <div className="ops-stat-grid">
    <article><span>Forecast (open deals)</span><strong>{money(data.financials.totals.forecastCents)}</strong><small>Owner-entered values; not revenue.</small></article>
    <article><span>Invoiced</span><strong>{money(data.financials.totals.invoicedCents)}</strong><small>Issued invoices linked to deals.</small></article>
    <article><span>Cash received</span><strong>{money(data.financials.totals.receivedCents)}</strong><small>Provider-verified receipts net of refunds only.</small></article>
    <article><span>Attributed paid wins</span><strong>{data.attribution.attributedDeals}</strong><small>Each won deal counts once per model.</small></article>
   </div>
   {data.pipelines.length>1&&<Field id="pl-select" text="Pipeline"><select id="pl-select" value={pipeline?.id??''} onChange={event=>setPipelineId(event.target.value)}>{data.pipelines.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}</select></Field>}
   {pipeline?<div className="ops-pipeline crm-board">{pipeline.stages.map((stage:Row)=>{const lane=deals.filter(deal=>deal.stage===stage.stage_key);return <section key={stage.stage_key} className="ops-lane" aria-label={`${stage.label} stage`}
     onDragOver={event=>event.preventDefault()} onDrop={event=>{event.preventDefault();const id=event.dataTransfer.getData('text/plain');if(id)setMoves(current=>({...current,[id]:{stage:stage.stage_key,kind:stage.evidence_rule==='owner_note'?'owner_note':stage.evidence_rule==='none'?'none':'paid_invoice',ref:current[id]?.ref??''}}));setNotice(`Confirm the move to ${stage.label} with evidence on the card.`);}}>
     <h3>{stage.label} <span>{lane.length}</span></h3><p className="ops-small">Needs: {label(stage.evidence_rule)}</p>
     {lane.map(deal=>{const move=moves[deal.id]??{stage:'',kind:'owner_note',ref:''};const targets:Row[]=pipeline.transitions.filter((t:Row)=>t.from_stage===deal.stage);return <article key={deal.id} className="ops-mini-card" draggable onDragStart={event=>event.dataTransfer.setData('text/plain',deal.id)}>
      <h4>{deal.label}</h4><strong>{money(deal.value_cents)}</strong>
      <p>{label(deal.probability_label)} likelihood · close {deal.expected_close_at?when(deal.expected_close_at):'not set'}</p>
      <p>Invoiced {money(deal.invoiced_cents)} · Received {money(deal.received_cents)}</p>
      <p>{(deal.contacts??[]).map((c:Row)=>c.name).join(', ')}</p>
      {targets.length>0&&<form className="crm-move" onSubmit={event=>{event.preventDefault();if(!move.stage)return;void act('transitionDeal',{id:deal.id,version:Number(deal.version),toStage:move.stage,evidence:{kind:move.kind,ref:move.ref||undefined}},'Stage updated with evidence.').then(result=>{if(result)setMoves(current=>{const next={...current};delete next[deal.id];return next;});});}}>
       <label htmlFor={`mv-${deal.id}`}>Move to stage</label>
       <select id={`mv-${deal.id}`} aria-label={`Move ${deal.label} to stage`} value={move.stage} onChange={event=>setMoves(current=>({...current,[deal.id]:{...move,stage:event.target.value}}))}><option value="">Choose…</option>{targets.map(t=><option key={t.to_stage} value={t.to_stage}>{label(t.to_stage)}</option>)}</select>
       <label htmlFor={`ek-${deal.id}`}>Evidence type</label>
       <select id={`ek-${deal.id}`} value={move.kind} onChange={event=>setMoves(current=>({...current,[deal.id]:{...move,kind:event.target.value}}))}>{evidenceKinds.map(kind=><option key={kind} value={kind}>{label(kind)}</option>)}</select>
       <label htmlFor={`er-${deal.id}`}>Evidence note or record ID</label>
       <input id={`er-${deal.id}`} value={move.ref} onChange={event=>setMoves(current=>({...current,[deal.id]:{...move,ref:event.target.value}}))}/>
       <button className="live-secondary" disabled={busy||!move.stage}>Move</button>
      </form>}
      <form className="crm-move" onSubmit={event=>{const v=form(event);void act('linkInvoice',{dealId:deal.id,invoiceId:v.invoiceId},'Invoice linked.');}}>
       <label htmlFor={`inv-${deal.id}`}>Link invoice ID</label><input id={`inv-${deal.id}`} name="invoiceId" required/><button className="live-secondary" disabled={busy}>Link</button>
      </form>
      {stage.outcome==='won'&&<button className="live-secondary" disabled={busy} onClick={()=>void act('attributeDeal',{id:deal.id},'Attribution recorded from verified receipts.')}>Attribute this win</button>}
     </article>;})}
     {!lane.length&&<p className="ops-small">No deals in this stage.</p>}
    </section>;})}</div>:<Empty title="No pipeline yet">Create a deal to start the default product pipeline.</Empty>}

   <div className="ops-card-grid crm-forms">
    <form className="ops-card" onSubmit={event=>{const v=form(event);const ids=Array.from(event.currentTarget.querySelectorAll<HTMLInputElement>('input[name="contactIds"]:checked')).map(input=>input.value);
     const amount=Math.round(Number(v.value||0)*100);void act('createDeal',{projectId:v.projectId,label:v.label,valueCents:amount,contactIds:ids,campaignId:v.campaignId||undefined,pipelineId:pipeline?.id,expectedCloseAt:v.expectedCloseAt||undefined},'Deal created.');}}>
     <h3>New deal</h3>
     <Field id="d-label" text="Deal name"><input id="d-label" name="label" required maxLength={160}/></Field>
     <Field id="d-project" text="Product project"><select id="d-project" name="projectId" required>{data.projects.map(project=><option key={project.id} value={project.id}>{project.label}</option>)}</select></Field>
     <Field id="d-campaign" text="Campaign (optional)"><select id="d-campaign" name="campaignId"><option value="">None</option>{data.campaigns.filter(c=>c.purpose==='product').map(c=><option key={c.id} value={c.id}>{c.label}</option>)}</select></Field>
     <Field id="d-value" text="Forecast value (USD)"><input id="d-value" name="value" type="number" min={0} step="0.01" required/></Field>
     <Field id="d-close" text="Expected close date"><input id="d-close" name="expectedCloseAt" type="date"/></Field>
     <fieldset className="ops-multi"><legend>Contacts on this deal</legend>{contacts.slice(0,24).map(contact=><label key={contact.id}><input type="checkbox" name="contactIds" value={contact.id}/> {contact.display_name}</label>)}{!contacts.length&&<p className="ops-small">Add contacts first.</p>}</fieldset>
     <button className="live-primary" disabled={busy}>Create deal</button>
    </form>
    <div className="ops-card">
     <h3>Attribution</h3>
     <p className="ops-small">First and last touch use only provider-verified sends within 90 days before a won deal with received cash; touches from the same campaign within 24 hours count once.</p>
     <button className="live-secondary" disabled={busy} onClick={()=>void act('recordVerifiedTouchpoints',{},'Verified touchpoints refreshed.')}>Refresh verified touchpoints</button>
     {data.attribution.byCampaign.length?<ul className="crm-preview">{data.attribution.byCampaign.map((row,index)=><li key={index}><strong>{row.campaign_label??'No campaign'}</strong> <small>{label(row.model)} · {row.won_deals} won · {money(row.received_cents)}</small></li>)}</ul>:<p className="ops-small">No attributed wins yet. A win needs verified received cash and a verified touch.</p>}
    </div>
   </div>
  </>}
 </section>;
}

function SourceSelects({prefix}:{prefix:string}){return <>
 <Field id={`${prefix}-kind`} text="Source type"><select id={`${prefix}-kind`} name="sourceKind">{sourceKinds.map(item=><option key={item} value={item}>{label(item)}</option>)}</select></Field>
 <Field id={`${prefix}-purpose`} text="Purpose"><select id={`${prefix}-purpose`} name="purpose"><option value="product">Product sales</option><option value="grant">Grant</option><option value="investment">Investment</option></select></Field>
 <Field id={`${prefix}-basis`} text="Lawful basis"><select id={`${prefix}-basis`} name="lawfulBasis"><option value="consent">Consent</option><option value="legitimate_interest">Legitimate interest</option><option value="contract">Contract</option></select></Field>
</>;}

function Inspector({detail,busy,act,campaigns,agents}:{detail:Row;busy:boolean;act:(action:string,payload:Row,success:string)=>Promise<Row|null>;campaigns:Row[];agents:Row[]}){
 const contact=detail.contact;const [check,setCheck]=useState<Row|null>(null);
 return <div>
  <div className="ops-card-heading"><h3>{contact.display_name}</h3><span className="ops-badge">{label(contact.status)}</span></div>
  <small>{contact.email_masked} · consent {label(contact.consent)} · {contact.jurisdiction}</small>
  {detail.mergedRecords.length>0&&<p className="ops-small">Includes {detail.mergedRecords.length} merged duplicate record(s).</p>}
  <h4 className="crm-subheading">Contact methods</h4>
  <ul className="crm-chips">{detail.methods.map((method:Row)=><li key={method.id}><span className="ops-badge">{method.kind}: {method.value_masked??'redacted'}</span></li>)}{detail.aliases.map((alias:Row)=><li key={alias.alias}><span className="ops-badge">aka {alias.alias}</span></li>)}</ul>
  <h4 className="crm-subheading">Sources</h4>
  <ul className="crm-preview">{detail.sources.map((source:Row)=><li key={source.id}><strong>{source.source_label}</strong> <small>{label(source.source_kind)} · {source.purpose} · {label(source.lawful_basis)}</small></li>)}</ul>
  <form className="crm-move" onSubmit={async event=>{event.preventDefault();const v=Object.fromEntries(new FormData(event.currentTarget).entries()) as Record<string,string>;setCheck(await act('checkContactable',{contactId:contact.id,campaignId:v.campaignId,agentId:v.agentId||undefined,channel:'email'},'Contactability checked. Nothing was sent.'));}}>
   <label htmlFor="ck-campaign">Check against campaign</label><select id="ck-campaign" name="campaignId" required>{campaigns.map(c=><option key={c.id} value={c.id}>{c.label}</option>)}</select>
   <label htmlFor="ck-agent">Agent (optional)</label><select id="ck-agent" name="agentId"><option value="">Owner</option>{agents.map(a=><option key={a.id} value={a.id}>{a.display_name}</option>)}</select>
   <button className="live-secondary" disabled={busy||!campaigns.length}>Check gates</button>
  </form>
  {check&&<p className={`ops-note ${check.allowed?'':'crm-error'}`}>{check.allowed?'All deterministic gates pass for this campaign.':`Blocked: ${check.reasons.map(label).join(', ')}`}</p>}
  {contact.status==='suppressed'&&<form className="crm-move" onSubmit={event=>{event.preventDefault();const v=Object.fromEntries(new FormData(event.currentTarget).entries()) as Record<string,string>;void act('overrideSuppression',{contactId:contact.id,lawfulBasis:v.basis,auditRef:v.audit,consentEvidence:v.evidence||undefined},'Suppression lifted with a lawful audit record.');}}>
   <label htmlFor="ov-basis">Lawful basis for override</label><select id="ov-basis" name="basis"><option value="documented_new_opt_in">Documented new opt-in</option><option value="owner_entry_error">Owner entry error</option></select>
   <label htmlFor="ov-audit">Audit reference</label><input id="ov-audit" name="audit" required minLength={3} maxLength={240}/>
   <label htmlFor="ov-evidence">New consent evidence</label><input id="ov-evidence" name="evidence" maxLength={1000}/>
   <button className="live-secondary" disabled={busy}>Lift suppression</button>
  </form>}
  <form className="crm-move" onSubmit={event=>{event.preventDefault();const input=event.currentTarget.elements.namedItem('note') as HTMLTextAreaElement;void act('addNote',{contactId:contact.id,summary:input.value},'Note added to the timeline.');input.value='';}}>
   <label htmlFor="in-note">Owner note</label><textarea id="in-note" name="note" rows={2} required maxLength={4000}/><button className="live-secondary" disabled={busy}>Add note</button>
  </form>
  <h4 className="crm-subheading">Timeline</h4>
  {detail.timeline.length?<ol className="ops-timeline crm-timeline">{detail.timeline.map((item:Row)=><li key={`${item.kind}-${item.id}`}>
   <strong>{label(item.kind)}</strong> {item.verified?<span className="ops-badge tone-good">{item.label}</span>:<span className="ops-badge tone-bad">{item.label}</span>}
   <p>{item.summary}</p><small>{when(item.occurred_at)} · {item.actor_kind} {String(item.actor_id).slice(0,12)} · {item.source}</small>
  </li>)}</ol>:<p className="ops-small">No recorded events yet.</p>}
 </div>;
}
