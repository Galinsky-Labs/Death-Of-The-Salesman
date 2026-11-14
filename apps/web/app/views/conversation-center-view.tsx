"use client";
// DOTS-097 / DOTS-099 / DOTS-101 / DOTS-103 / DOTS-106 / DOTS-107: Conversation Center.
// Navigation label: "Conversations". Three panes on desktop (thread list, transcript + composer, contact/campaign
// context); on narrow screens the panes become a drilldown (list -> thread -> context) with explicit back buttons.
// Every label comes from server evidence (provider receipts, triage rules, scan results); empty states say what is missing.
import {useCallback,useEffect,useState,type FormEvent,type ReactNode} from 'react';
import '../operations.css';
import './conversation-center-view.css';
type Row=Record<string,any>;
type Pane='list'|'thread'|'context';
const when=(value:unknown)=>value?new Date(String(value)).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'—';
const words=(value:unknown)=>String(value??'').replaceAll('_',' ');
function Badge({tone='neutral',children}:{tone?:string;children:ReactNode}){return <span className={`ops-badge ${tone==='good'?'tone-good':tone==='bad'?'tone-bad':''}`}>{children}</span>;}
function Empty({title,children}:{title:string;children:ReactNode}){return <div className="ops-empty"><h3>{title}</h3><p>{children}</p></div>;}

export function ConversationCenterView(){
 const [data,setData]=useState<Row|null>(null);const [selected,setSelected]=useState('');const [pane,setPane]=useState<Pane>('list');
 const [busy,setBusy]=useState(false);const [notice,setNotice]=useState('');const [error,setError]=useState('');
 const [compose,setCompose]=useState({mode:'reply',subject:'',body:'',cc:'',replyTo:'',attachments:[] as string[]});
 const [preview,setPreview]=useState<Row|null>(null);const [revision,setRevision]=useState<{id:string;revision:number;body:string}|null>(null);
 const load=useCallback(async(conversation=selected)=>{setError('');try{const response=await fetch(`/api/v1/communications${conversation?`?conversation=${encodeURIComponent(conversation)}`:''}`,{cache:'no-store'});const json=await response.json();if(!response.ok)throw new Error(json.error??'COMMUNICATIONS_UNAVAILABLE');setData(json);}catch(cause){setError(cause instanceof Error?cause.message:'COMMUNICATIONS_UNAVAILABLE');}},[selected]);
 useEffect(()=>{void load();},[load]);
 async function act(action:string,values:Row={},success='Saved'){setBusy(true);setError('');setNotice('');try{const response=await fetch('/api/v1/communications',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,...values})});const json=await response.json();if(!response.ok)throw new Error(json.error??'REQUEST_FAILED');setNotice(success);await load();return json.outcome as Row;}catch(cause){setError(words(cause instanceof Error?cause.message:'REQUEST_FAILED'));return null;}finally{setBusy(false);}}
 const conversation=data?.conversation as Row|null;const threads=(data?.threads??[]) as Row[];
 const openThread=(id:string)=>{setSelected(id);setPane('thread');setPreview(null);setRevision(null);void load(id);};
 const lastInbound=conversation?.messages?.filter((m:Row)=>m.direction==='inbound'&&m.state==='received').at(-1);
 const cleanAttachments=(conversation?.attachments??[]).filter((a:Row)=>a.scan_state==='clean');
 async function saveDraft(event:FormEvent){event.preventDefault();if(!conversation)return;
  const outcome=await act('composeDraft',{conversationId:conversation.id,mode:compose.mode,replyToMessageId:compose.mode==='reply'?(compose.replyTo||lastInbound?.id||conversation.messages?.at(-1)?.id):undefined,forwardMessageId:compose.mode==='forward'?compose.replyTo:undefined,subject:compose.subject||undefined,body:compose.body,cc:compose.cc?compose.cc.split(','):[],attachmentIds:compose.attachments,campaignId:conversation.campaign_id??undefined},'Draft saved. Review the exact preview before approving.');
  if(outcome){setCompose({...compose,body:'',subject:'',cc:'',attachments:[]});setPreview(await act('previewDraft',{id:outcome.id},'Preview ready'));}}
 async function upload(file:File|undefined){if(!file||!conversation)return;const buffer=new Uint8Array(await file.arrayBuffer());let binary='';buffer.forEach(byte=>{binary+=String.fromCharCode(byte);});await act('uploadAttachment',{conversationId:conversation.id,filename:file.name,declaredType:file.type||'application/octet-stream',base64:btoa(binary)},'Attachment scanned');}

 return <section className="cc-root" aria-labelledby="cc-title">
  <div className="ops-section-heading"><h3 id="cc-title">Conversations</h3><button className="live-secondary" type="button" disabled={busy} onClick={()=>void load()}>Refresh</button></div>
  <p aria-live="polite" className="cc-notice">{notice}</p>{error&&<p role="alert" className="ops-note danger-text">Request failed: {error}</p>}
  {!data&&!error&&<p className="ops-small">Loading conversations…</p>}
  {data&&<div className="cc-layout" data-pane={pane}>
   <aside className="cc-pane cc-threads" aria-label="Thread list">
    <h4>Thread list</h4>
    {threads.length?threads.map(thread=><button key={thread.id} type="button" className={thread.id===selected?'selected':''} aria-current={thread.id===selected?'true':undefined} onClick={()=>openThread(thread.id)}>
     <strong>{thread.contact_name}</strong><small>{thread.subject}</small>
     <span className="cc-tags">{thread.needs_owner&&<Badge tone="bad">Needs owner</Badge>}{thread.priority>0&&<Badge>Priority {thread.priority}</Badge>}{thread.human_takeover&&<Badge>Owner controls</Badge>}{thread.last_triage&&<Badge>{words(thread.last_triage)}</Badge>}{thread.last_label&&<Badge>{thread.last_label}</Badge>}</span>
     <span>{thread.sla_due_at?`Reply due ${when(thread.sla_due_at)}`:`Updated ${when(thread.updated_at)}`}</span>
    </button>):<Empty title="No conversations yet">Threads appear when an authenticated provider event, a mailbox poll or an owner draft creates them. Nothing is simulated here.</Empty>}
   </aside>
   <section className="cc-pane cc-transcript" aria-label="Transcript">
    <div className="cc-mobile-nav"><button type="button" className="live-secondary" onClick={()=>setPane('list')}>Back to threads</button>{conversation&&<button type="button" className="live-secondary" onClick={()=>setPane('context')}>Contact and campaign</button>}</div>
    <h4>Transcript</h4>
    {!conversation?<Empty title="Select a thread">Choose a conversation to see its full timeline with provider evidence for every delivery label.</Empty>:<>
     <div className="ops-card-heading"><h3>{conversation.subject}</h3>{conversation.human_takeover?<Badge>Owner controls{conversation.agent_delegated?' · agent delegated':''}</Badge>:<Badge>Agent may draft</Badge>}</div>
     <div className="ops-message-list">{conversation.messages.length?conversation.messages.map((message:Row)=><article key={message.id} className={`ops-message ${message.direction}`}>
      <div className="ops-card-heading"><strong>{message.direction==='inbound'?(message.from_address??conversation.contact_name):`From ${message.from_address??'owner mailbox'}`}</strong><Badge tone={message.label.tone}>{message.label.label}</Badge></div>
      <small>{message.direction==='inbound'?`Received ${when(message.received_at??message.created_at)}`:message.sent_at?`Sent ${when(message.sent_at)}`:`Drafted ${when(message.created_at)}`} · To {(message.to_addresses??[]).join(', ')||'—'}{(message.cc_addresses??[]).length?` · Cc ${message.cc_addresses.join(', ')}`:''}</small>
      <small className="cc-evidence">Evidence: {message.label.evidence}</small>
      {message.ai_generated&&<p className="ops-note">AI-drafted text. It is not verified fact; only linked vetted facts are verified.</p>}
      {message.triage&&<details><summary>Triage: {words(message.triage.label)} ({Math.round(message.triage.confidence_basis_points/100)}% rule confidence){message.triage.escalated?' · escalated to owner':''}</summary><ul>{(message.triage.citations??[]).map((c:Row,i:number)=><li key={i}><code>{c.rule}</code>: “{c.excerpt}”</li>)}</ul></details>}
      <pre>{message.body}</pre>
      {message.direction==='outbound'&&['draft','pending_approval','approved','failed'].includes(message.state)&&<div className="ops-row-actions">
       <button type="button" disabled={busy} onClick={async()=>setPreview(await act('previewDraft',{id:message.id},'Preview ready'))}>Preview exact message</button>
       <button type="button" disabled={busy} onClick={()=>setRevision({id:message.id,revision:Number(message.current_revision??1),body:message.body})}>Edit (creates new revision)</button>
      </div>}
      {message.direction==='inbound'&&message.state==='received'&&<div className="ops-row-actions"><button type="button" onClick={()=>setCompose({...compose,mode:'reply',replyTo:message.id})}>Reply</button><button type="button" onClick={()=>setCompose({...compose,mode:'forward',replyTo:message.id})}>Forward</button></div>}
     </article>):<Empty title="No messages">This thread has no imported or drafted messages yet.</Empty>}</div>
     {revision&&<form className="cc-form" onSubmit={async event=>{event.preventDefault();const out=await act('reviseDraft',{id:revision.id,revision:revision.revision,body:revision.body},'New revision saved; earlier approval invalidated');if(out){setRevision(null);setPreview(await act('previewDraft',{id:revision.id},'Preview ready'));}}}>
      <label htmlFor="cc-revise">Edit draft body (revision {revision.revision+1})</label><textarea id="cc-revise" rows={6} value={revision.body} onChange={e=>setRevision({...revision,body:e.target.value})} autoComplete="off" spellCheck/>
      <div className="ops-row-actions"><button className="live-primary" type="submit" disabled={busy}>Save revision</button><button className="live-secondary" type="button" onClick={()=>setRevision(null)}>Cancel</button></div></form>}
     {preview&&<section className="ops-card cc-preview" aria-label="Exact message preview">
      <div className="ops-card-heading"><h3>Plain-text preview · revision {preview.revision??'—'}</h3><Badge tone={preview.approved?'good':'neutral'}>{preview.approved?'Approved':'Not approved'}</Badge></div>
      <dl className="ops-definition"><dt>From</dt><dd>{preview.from??'No mailbox'}</dd><dt>To</dt><dd>{(preview.to??[]).join(', ')}</dd><dt>Cc</dt><dd>{(preview.cc??[]).join(', ')||'—'}</dd><dt>Subject</dt><dd>{preview.subject}</dd><dt>Provenance</dt><dd>{preview.provenance}</dd><dt>Expires</dt><dd>{when(preview.expiresAt)}</dd><dt>Headers</dt><dd>{Object.entries(preview.headers??{}).filter(([,v])=>v).map(([k,v])=>`${k}: ${v}`).join('\n')}</dd></dl>
      <pre className="ops-copy">{preview.plainText}</pre><small className="ops-hash">Revision hash {preview.revisionHash}</small>
      <div className="ops-row-actions"><button className="live-primary" type="button" disabled={busy||!preview.revisionHash||preview.approved} onClick={async()=>{await act('approveExact',{id:preview.messageId,revisionHash:preview.revisionHash},'This exact revision is approved');setPreview(await act('previewDraft',{id:preview.messageId},'Approved revision'));}}>Approve this exact message</button>
       <button className="live-secondary" type="button" disabled={busy||!preview.approved} onClick={async()=>{await act('sendMessage',{id:preview.messageId},'Dispatch attempted; label shows the provider result');setPreview(null);}}>Send approved message</button></div>
     </section>}
     <form className="cc-form" onSubmit={saveDraft} aria-label="Composer">
      <div className="cc-form-row"><label htmlFor="cc-mode">Mode</label><select id="cc-mode" value={compose.mode} onChange={e=>setCompose({...compose,mode:e.target.value})}><option value="reply">Reply</option><option value="forward">Forward</option><option value="new">New message</option></select></div>
      {compose.mode!=='reply'&&<div className="cc-form-row"><label htmlFor="cc-subject">Subject</label><input id="cc-subject" value={compose.subject} onChange={e=>setCompose({...compose,subject:e.target.value})} maxLength={240} required={compose.mode==='new'} autoComplete="off"/></div>}
      <div className="cc-form-row"><label htmlFor="cc-body">Message (plain text; pasted formatting is removed)</label><textarea id="cc-body" rows={6} value={compose.body} onChange={e=>setCompose({...compose,body:e.target.value})} required maxLength={50000} autoComplete="off" spellCheck/></div>
      <div className="cc-form-row"><label htmlFor="cc-cc">Cc (comma separated, optional)</label><input id="cc-cc" type="text" inputMode="email" value={compose.cc} onChange={e=>setCompose({...compose,cc:e.target.value})} autoComplete="off"/></div>
      <fieldset className="cc-form-row"><legend>Attachments (scanned clean files only)</legend>{cleanAttachments.length?cleanAttachments.map((a:Row)=><label key={a.id} className="cc-check"><input type="checkbox" checked={compose.attachments.includes(a.id)} onChange={e=>setCompose({...compose,attachments:e.target.checked?[...compose.attachments,a.id]:compose.attachments.filter(x=>x!==a.id)})}/>{a.filename}</label>):<small className="ops-small">No clean attachments in this thread.</small>}
       <label htmlFor="cc-upload" className="cc-upload">Upload and scan a file (PDF, PNG, JPEG, GIF, WebP, TXT, CSV; 5 MB max)</label><input id="cc-upload" type="file" accept=".pdf,.png,.jpg,.jpeg,.gif,.webp,.txt,.csv" onChange={e=>void upload(e.target.files?.[0])}/></fieldset>
      <div className="ops-row-actions"><button className="live-primary" type="submit" disabled={busy||!compose.body.trim()}>Save draft and preview</button></div>
      <p className="ops-small">Saving never sends. Sending requires approving the exact previewed revision; any edit creates a new revision and invalidates the approval.</p>
     </form>
    </>}
   </section>
   <aside className="cc-pane cc-context" aria-label="Contact and campaign context">
    <div className="cc-mobile-nav"><button type="button" className="live-secondary" onClick={()=>setPane('thread')}>Back to transcript</button></div>
    <h4>Contact and campaign context</h4>
    {conversation?<>
     <article className="ops-card"><h3>{conversation.contact_name}</h3><small>{conversation.contact_email??'No email'} · {words(conversation.contact_status)} · consent {words(conversation.contact_consent)}</small>
      <p>{conversation.campaign_label?`Campaign: ${conversation.campaign_label} (${words(conversation.campaign_state)})`:'No campaign linked. Replies link to a campaign only through threading evidence.'}</p>
      <p>{conversation.sla_due_at?`Owner reply due ${when(conversation.sla_due_at)}`:'No reply deadline set.'}</p>
      <div className="ops-row-actions">
       {!conversation.human_takeover?<button type="button" disabled={busy} onClick={()=>void act('claimThread',{id:conversation.id},'You now control this thread; agent sending is paused')}>Take over thread</button>:<>
        <button type="button" disabled={busy} onClick={()=>void act('releaseThread',{id:conversation.id},'Thread released to the agent workflow')}>Release thread</button>
        <button type="button" disabled={busy} onClick={()=>void act('delegateThread',{id:conversation.id,enabled:!conversation.agent_delegated},conversation.agent_delegated?'Agent delegation revoked':'Agent explicitly delegated')}>{conversation.agent_delegated?'Revoke agent delegation':'Delegate sending to agent'}</button></>}
       <button type="button" disabled={busy} onClick={()=>void act('markHandled',{id:conversation.id},'Marked handled')}>Mark handled</button>
       <label className="cc-inline" htmlFor="cc-priority">Priority<select id="cc-priority" value={conversation.priority} onChange={e=>void act('setPriority',{id:conversation.id,priority:Number(e.target.value)},'Priority saved')}>{[0,1,2,3].map(p=><option key={p} value={p}>{p}</option>)}</select></label>
       <button type="button" className="danger-text" disabled={busy} onClick={()=>void act('processOptOut',{contactId:conversation.contact_id},'Contact suppressed; pending drafts and sequence steps cancelled')}>Record opt-out</button>
      </div></article>
     <article className="ops-card"><h3>Follow-up status</h3>{conversation.enrollments.length?conversation.enrollments.map((e:Row)=><div key={e.id}><p>{e.label}: {words(e.state)}{e.state_reason?` (${words(e.state_reason)})`:''}</p><ul>{(e.steps??[]).map((s:Row)=><li key={s.touch}>Touch {s.touch}: {words(s.state)} · due {when(s.due_at)}{s.reason?` · ${words(s.reason)}`:''}</li>)}</ul>{['active','paused'].includes(e.state)&&<div className="ops-row-actions"><button type="button" onClick={()=>void act('cancelEnrollment',{id:e.id},'Sequence cancelled')}>Cancel sequence</button></div>}</div>):<p>No follow-up sequence for this thread.</p>}</article>
     <article className="ops-card"><h3>Attachments</h3>{conversation.attachments.length?<ul className="cc-list">{conversation.attachments.map((a:Row)=><li key={a.id}>{a.filename} · <Badge tone={a.scan_state==='clean'?'good':a.scan_state==='staged'?'neutral':'bad'}>{a.scan_state}</Badge>{a.scan_reason?` ${words(a.scan_reason)}`:''}{a.scan_state==='clean'&&<> · <a href={`/api/v1/communications?attachment=${a.id}`} download>Download</a></>}</li>)}</ul>:<p>No attachments.</p>}</article>
    </>:<Empty title="No thread selected">Contact, campaign, follow-up and takeover controls appear here for the selected thread.</Empty>}
   </aside>
  </div>}
  {data&&<OwnerPanels data={data} busy={busy} act={act}/>}
 </section>;
}

function OwnerPanels({data,busy,act}:{data:Row;busy:boolean;act:(action:string,values?:Row,success?:string)=>Promise<Row|null>}){
 const [profile,setProfile]=useState({legalName:data.senderProfile?.legal_name??'',postalAddress:data.senderProfile?.postal_address??''});
 const [mailbox,setMailbox]=useState({label:'',email:'',senderName:'',provider:'resend',tokenRef:''});
 const [resolution,setResolution]=useState<Record<string,{resolution:string;evidence:string;providerMessageId:string}>>({});
 const [sequence,setSequence]=useState({campaignId:'',label:'',subjectTemplate:'',bodyTemplate:'',maxTouches:3,intervalDays:3});
 return <>
  <div className="ops-section-heading"><h3>Reconciliation queue</h3><Badge tone={data.reconciliation.length?'bad':'good'}>{data.reconciliation.length} open</Badge></div>
  {data.reconciliation.length?<div className="ops-card-grid">{data.reconciliation.map((item:Row)=>{const value=resolution[item.id]??{resolution:item.kind==='uncertain_send'?'not_sent':'dismissed',evidence:'',providerMessageId:''};const set=(patch:Row)=>setResolution({...resolution,[item.id]:{...value,...patch}});
   return <form key={item.id} className="ops-card cc-form" onSubmit={e=>{e.preventDefault();void act('resolveReconciliation',{id:item.id,...value},'Resolution recorded with evidence');}}>
    <h3>{words(item.kind)}</h3><small>Opened {when(item.created_at)}{item.provider_ref?` · provider ref ${item.provider_ref}`:''}</small>
    <div className="cc-form-row"><label htmlFor={`res-${item.id}`}>Resolution</label><select id={`res-${item.id}`} value={value.resolution} onChange={e=>set({resolution:e.target.value})}>{(item.kind==='uncertain_send'?['not_sent','sent']:item.kind==='unverified_inbound'?['dismissed','accepted']:['dismissed']).map(o=><option key={o} value={o}>{words(o)}</option>)}</select></div>
    {value.resolution==='sent'&&<div className="cc-form-row"><label htmlFor={`pid-${item.id}`}>Provider message id (from provider logs)</label><input id={`pid-${item.id}`} value={value.providerMessageId} onChange={e=>set({providerMessageId:e.target.value})} required/></div>}
    <div className="cc-form-row"><label htmlFor={`ev-${item.id}`}>Evidence</label><input id={`ev-${item.id}`} value={value.evidence} onChange={e=>set({evidence:e.target.value})} required maxLength={500}/></div>
    <div className="ops-row-actions"><button className="live-primary" type="submit" disabled={busy}>Record resolution</button></div></form>;})}</div>:<p className="ops-small">No uncertain sends or unmatched provider events. Transport timeouts land here instead of being retried.</p>}

  <div className="ops-section-heading"><h3>Sender setup</h3></div>
  <div className="ops-card-grid">
   <form className="ops-card cc-form" onSubmit={e=>{e.preventDefault();void act('setSenderProfile',profile,'Sender postal profile saved');}}>
    <h3>Tenant postal address</h3><small>Required in every message footer before any mailbox can launch.</small>
    <div className="cc-form-row"><label htmlFor="sp-name">Legal name</label><input id="sp-name" value={profile.legalName} onChange={e=>setProfile({...profile,legalName:e.target.value})} required/></div>
    <div className="cc-form-row"><label htmlFor="sp-address">Postal address</label><textarea id="sp-address" rows={3} value={profile.postalAddress} onChange={e=>setProfile({...profile,postalAddress:e.target.value})} required/></div>
    <div className="ops-row-actions"><button className="live-primary" type="submit" disabled={busy}>Save profile</button></div></form>
   <form className="ops-card cc-form" onSubmit={e=>{e.preventDefault();void act('connectMailbox',{...mailbox,tokenRef:mailbox.tokenRef||undefined,scopes:mailbox.provider==='gmail'?['https://www.googleapis.com/auth/gmail.send','https://www.googleapis.com/auth/gmail.readonly']:mailbox.provider==='microsoft365'?['Mail.Send','Mail.Read','offline_access']:[]},'Mailbox connected (disabled until consent and authentication pass)');}}>
    <h3>Connect a mailbox</h3><small>Stores a secret reference such as env:NAME or vault:path — never the token itself.</small>
    <div className="cc-form-row"><label htmlFor="mb-label">Label</label><input id="mb-label" value={mailbox.label} onChange={e=>setMailbox({...mailbox,label:e.target.value})} required/></div>
    <div className="cc-form-row"><label htmlFor="mb-email">Sender email</label><input id="mb-email" type="email" value={mailbox.email} onChange={e=>setMailbox({...mailbox,email:e.target.value})} required/></div>
    <div className="cc-form-row"><label htmlFor="mb-name">Sender name</label><input id="mb-name" value={mailbox.senderName} onChange={e=>setMailbox({...mailbox,senderName:e.target.value})} required/></div>
    <div className="cc-form-row"><label htmlFor="mb-provider">Provider</label><select id="mb-provider" value={mailbox.provider} onChange={e=>setMailbox({...mailbox,provider:e.target.value})}><option value="resend">Resend (API key)</option><option value="gmail">Gmail (OAuth)</option><option value="microsoft365">Microsoft 365 (OAuth)</option></select></div>
    <div className="cc-form-row"><label htmlFor="mb-token">Token reference</label><input id="mb-token" value={mailbox.tokenRef} onChange={e=>setMailbox({...mailbox,tokenRef:e.target.value})} placeholder="vault:mail/owner" autoComplete="off"/></div>
    <div className="ops-row-actions"><button className="live-primary" type="submit" disabled={busy}>Connect mailbox</button></div></form>
  </div>
  {data.mailboxes.length?<div className="ops-table-wrap"><table className="ops-table"><caption className="ops-small">Mailboxes and sender authentication</caption><thead><tr><th scope="col">Mailbox</th><th scope="col">Status</th><th scope="col">SPF / DKIM / DMARC</th><th scope="col">Owner consent</th><th scope="col">Token</th><th scope="col">Actions</th></tr></thead><tbody>
   {data.mailboxes.map((m:Row)=><tr key={m.id}><td><strong>{m.label}</strong><small>{m.sender_email} · {m.provider}</small></td><td><Badge tone={m.status==='active'?'good':m.status==='paused'?'bad':'neutral'}>{m.status}</Badge>{m.pause_reason&&<small>{words(m.pause_reason)}</small>}</td><td>{m.spf_status} / {m.dkim_status} / {m.dmarc_status}<small>Checked {when(m.auth_checked_at)}</small></td><td>{m.owner_consent_at?when(m.owner_consent_at):'Not granted'}</td><td>{m.token_ref??'—'}<small>Rotated {when(m.token_rotated_at)}</small></td>
    <td><div className="ops-row-actions"><button type="button" disabled={busy} onClick={()=>void act('verifyMailbox',{id:m.id},'Provider verification recorded')}>Verify domain</button><button type="button" disabled={busy} onClick={()=>void act('checkDmarc',{id:m.id},'DMARC result recorded')}>Check DMARC</button>{m.owner_consent_at?<button type="button" className="danger-text" disabled={busy} onClick={()=>void act('revokeMailboxConsent',{id:m.id},'Consent revoked; mailbox disabled')}>Revoke consent</button>:<button type="button" disabled={busy} onClick={()=>void act('grantMailboxConsent',{id:m.id,consentRef:`owner-console-${new Date().toISOString().slice(0,10)}`},'Owner consent recorded')}>Grant consent</button>}</div></td></tr>)}
  </tbody></table></div>:<p className="ops-small">No mailbox connected. Outbound and inbound mail stay off until a tenant mailbox is connected, verified and consented.</p>}

  <div className="ops-section-heading"><h3>Sender health</h3><small className="ops-small">Pauses at {data.health.thresholds.bounceBasisPoints/100}% hard bounces or {data.health.thresholds.complaintBasisPoints/100}% complaints over {data.health.thresholds.windowDays} days</small></div>
  {[...data.health.mailboxes,...data.health.campaigns].length?<div className="ops-table-wrap"><table className="ops-table"><thead><tr><th scope="col">Sender or campaign</th><th scope="col">State</th><th scope="col">Provider-accepted sends</th><th scope="col">Hard bounces</th><th scope="col">Complaints</th></tr></thead><tbody>
   {[...data.health.mailboxes.map((m:Row)=>({...m,kind:'Mailbox',state:m.status})),...data.health.campaigns.map((c:Row)=>({...c,kind:'Campaign'}))].map((row:Row)=><tr key={`${row.kind}-${row.id}`}><td><strong>{row.label}</strong><small>{row.kind}</small></td><td>{row.state}</td><td>{row.sent}</td><td>{row.bounced}{row.bounceBasisPoints!=null?` (${row.bounceBasisPoints/100}%)`:''}</td><td>{row.complaints}{row.complaintBasisPoints!=null?` (${row.complaintBasisPoints/100}%)`:''}</td></tr>)}
  </tbody></table></div>:<p className="ops-small">No sends recorded yet, so there is no bounce or complaint rate to show.</p>}

  <div className="ops-section-heading"><h3>Follow-up sequences</h3><button className="live-secondary" type="button" disabled={busy} onClick={()=>void act('claimDueSteps',{},'Due follow-ups drafted for owner approval')}>Draft due follow-ups</button></div>
  <form className="ops-card cc-form" onSubmit={e=>{e.preventDefault();void act('createSequence',sequence,'Sequence created');}}>
   <div className="cc-form-row"><label htmlFor="sq-campaign">Campaign</label><select id="sq-campaign" value={sequence.campaignId} onChange={e=>setSequence({...sequence,campaignId:e.target.value})} required><option value="">Choose campaign</option>{data.campaigns.map((c:Row)=><option key={c.id} value={c.id}>{c.label} ({c.state})</option>)}</select></div>
   <div className="cc-form-row"><label htmlFor="sq-label">Label</label><input id="sq-label" value={sequence.label} onChange={e=>setSequence({...sequence,label:e.target.value})} required/></div>
   <div className="cc-form-row"><label htmlFor="sq-subject">Subject template (use {'{{contact_name}}'})</label><input id="sq-subject" value={sequence.subjectTemplate} onChange={e=>setSequence({...sequence,subjectTemplate:e.target.value})} required/></div>
   <div className="cc-form-row"><label htmlFor="sq-body">Body template</label><textarea id="sq-body" rows={4} value={sequence.bodyTemplate} onChange={e=>setSequence({...sequence,bodyTemplate:e.target.value})} required/></div>
   <div className="cc-form-row"><label htmlFor="sq-max">Maximum touches</label><input id="sq-max" type="number" min={1} max={10} value={sequence.maxTouches} onChange={e=>setSequence({...sequence,maxTouches:Number(e.target.value)})}/></div>
   <div className="cc-form-row"><label htmlFor="sq-interval">Days between touches</label><input id="sq-interval" type="number" min={1} max={90} value={sequence.intervalDays} onChange={e=>setSequence({...sequence,intervalDays:Number(e.target.value)})}/></div>
   <div className="ops-row-actions"><button className="live-primary" type="submit" disabled={busy}>Create sequence</button></div>
   <p className="ops-small">Quiet hours default to 18:00–09:00 America/New_York. A reply, opt-out, pause, suppression or owner takeover stops further touches; each drafted touch still needs exact owner approval.</p>
  </form>
  {data.sequences.length>0&&<ul className="cc-list">{data.sequences.map((s:Row)=><li key={s.id}>{s.label}: {s.state} · {s.active_enrollments} active · max {s.max_touches} touches every {s.interval_days} days{s.state!=='archived'&&<> · <button type="button" className="cc-link" disabled={busy} onClick={()=>void act('setSequenceState',{id:s.id,state:s.state==='active'?'paused':'active'},'Sequence updated')}>{s.state==='active'?'Pause':'Resume'}</button></>}</li>)}</ul>}
 </>;
}
