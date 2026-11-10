"use client";

import { useEffect, useState, type FormEvent } from "react";
import type { WorkspaceData, Project, Agent } from "../lib/workspace";
import type { OperationsSnapshot } from "../lib/operations";
import { OperationsConsole } from "./operations-console";
import { authClient } from "../lib/auth-client";

const categories = { product:"Product sales",grant:"Grants",investment:"Investor relations" };

export function LiveWorkspace({ initial, initialOperations }: { initial: WorkspaceData; initialOperations?: OperationsSnapshot }) {
  const [data, setData] = useState(initial);
  const [operations, setOperations] = useState<OperationsSnapshot|null>(initialOperations??null);
  const [evidenceNow, setEvidenceNow] = useState(Date.parse(initialOperations?.observedAt??initial.observedAt));
  const [view, setView] = useState("Overview");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState("");
  const [selectedProject, setSelectedProject] = useState("");
  const [allocation, setAllocation] = useState(50);
  const [dragging, setDragging] = useState<string | null>(null);
  const operationViews=["Work queue","Campaigns","Contacts","Pipeline","Conversations","Strategy Lab","Funding","Revenue","Documents","Catalog","Approvals","Budget","Settings","Activity"];
  async function refreshWorkspace(){const response=await fetch('/api/workspace',{cache:'no-store'});if(response.ok)setData(await response.json());}
  useEffect(()=>{const timer=setInterval(()=>setEvidenceNow(Date.now()),5000);return()=>clearInterval(timer);},[]);
  useEffect(()=>{if(view!=="Work queue"&&view!=="Agents")return;let pending=false;const timer=setInterval(async()=>{if(document.hidden||pending)return;pending=true;try{const response=await fetch('/api/operations',{cache:'no-store'});if(response.ok)setOperations(await response.json());}finally{pending=false;}},5000);return()=>clearInterval(timer);},[view]);

  async function request(action?: Record<string, unknown>, success = "Workspace refreshed") {
    if (busy) return;
    setBusy(true);setError("");setNotice("");
    try {
      const response = await fetch("/api/workspace",action ? {
        method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(action),
      } : {cache:"no-store"});
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Request failed");
      setData(result);setNotice(success);
      return true;
    } catch(cause) {setError(cause instanceof Error ? cause.message : "Could not reach the workspace");return false;}
    finally {setBusy(false);}
  }
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();const fields = new FormData(event.currentTarget);
    if (await request({action:"createProject",label:fields.get("label"),description:fields.get("description"),category:fields.get("category")},"Project created and saved")) setCreating(false);
  }
  function assign(agentId: string, projectId: string) {
    return request({action:"assignAgent",agentId,projectId,allocation},"Assignment saved. Queue work from the agent controls.");
  }
  async function signOut() {
    try {
      const result = await authClient.signOut();
      if(result.error) throw new Error(result.error.message ?? "Sign-out failed");
      window.location.assign("/auth/sign-in");
    } catch {setError("Could not sign out. Please try again.");}
  }
  const projects = data.projects.filter(p=>`${p.label} ${p.content.description ?? ""}`.toLowerCase().includes(query.toLowerCase()));
  const agents = data.agents.filter(a=>a.display_name.toLowerCase().includes(query.toLowerCase()));
  function avatar(agent: Agent, small = false) {
    return <span className={`live-avatar ${small ? "small" : ""}`} aria-hidden="true">{agent.display_name.split(" ").map(w=>w[0]).slice(0,2).join("")}</span>;
  }
  function projectCard(project: Project, index: number) {
    const assigned = data.assignments.filter(a=>a.project_id===project.id);
    return <article key={project.id} className={`project-card accent-${index%3} ${dragging ? "drop-ready" : ""}`}
      onDragOver={e=>{if(dragging)e.preventDefault();}}
      onDrop={e=>{e.preventDefault();const id=e.dataTransfer.getData("text/plain");setDragging(null);
        if(data.agents.some(a=>a.id===id)) void assign(id,project.id);}}>
      <div className="project-card-top"><span className="project-glyph" aria-hidden="true">{project.content.category==="grant" ? "◇" : project.content.category==="investment" ? "↗" : "◈"}</span>
        <span className="category-tag">{categories[project.content.category as keyof typeof categories] ?? "Project"}</span></div>
      <h3>{project.label}</h3><p className="project-description">{project.content.description || "Add your brief and assign a sales agent to get organized."}</p>
      <div className="project-team"><span className="muted">Assigned agents</span><strong>{assigned.length.toString().padStart(2,"0")}</strong></div>
      <div className="assigned-list">{assigned.length===0 ? <p className="muted">Drop an agent here or use the assignment form.</p> : assigned.map(assignment=>{
        const agent=data.agents.find(a=>a.id===assignment.agent_identity_id);
        return <div className="assigned-row" key={assignment.id}>{agent && avatar(agent,true)}<span>{agent?.display_name ?? "Agent"}<small>{assignment.allocation_basis_points/100}% allocation</small></span>
          <button type="button" disabled={busy} className="icon-button" aria-label={`Remove ${agent?.display_name ?? "agent"} from ${project.label}`}
            onClick={()=>void request({action:"removeAssignment",id:assignment.id,version:assignment.version},"Assignment removed")}>×</button></div>;
      })}</div>
      <div className="project-card-footer"><span className="waiting-label"><i /> {operations?.records.controls?.[0]?.paused?"Queue paused":"Owner-managed work"}</span>
        <button className="text-button" disabled={busy || assigned.length>0} title={assigned.length ? "Remove assignments before archiving" : "Archive project"} onClick={()=>{if(window.confirm(`Archive “${project.label}”? Its history is retained.`)) void request({action:"archiveProject",id:project.id,version:project.version},"Project archived");}}>Archive</button></div>
    </article>;
  }

  return <div className="live-frame">
    <a href="#live-main" className="live-skip">Skip to workspace</a>
    <aside className="live-sidebar"><a href="/dashboard" className="live-brand">DS <span>SALESROOM</span></a>
      <p className="sidebar-caption">WORKSPACE</p><nav aria-label="Workspace">{["Overview","Projects","Agents",...operationViews].map((label,index)=><button key={label}
        className={view===label ? "nav-active" : ""} aria-current={view===label ? "page" : undefined} onClick={()=>{setView(label);setQuery("");}}>
        <span aria-hidden="true">{["▦","◈","◎","↗"][index%4]}</span>{label}{label==="Projects" && <small>{data.projects.length}</small>}</button>)}</nav>
      <div className="sidebar-bottom"><span className="workspace-icon">GL</span><div><strong>Galinsky Labs</strong><small>Owner workspace</small></div></div>
    </aside>
    <div className="live-body"><header className="live-topbar"><span className="breadcrumb">Workspace <span>/</span> <strong>{view}</strong></span>
      <div className="topbar-actions"><span className="database-badge"><i /> Saved in Neon</span><button className="text-button" onClick={()=>void signOut()}>Sign out</button><span className="owner-icon" aria-hidden="true">GL</span></div></header>
      <main id="live-main" className="live-main"><div className="live-heading"><div><p className="eyebrow">YOUR SALES & FUNDRAISING COMMAND CENTER</p><h1>{view==="Overview" ? "Make your next move." : view}</h1>
        <p className="muted">{view==="Overview" ? "Bring your projects, people, and priorities together." : view==="Agents" ? "Your roster. Every assignment in one place." : view==="Activity" ? "A durable record of changes to your workspace." : "Give every project a focused team."}</p></div>
        <div className="heading-actions"><button disabled={busy} className="live-secondary" onClick={()=>void request()}>↻ Refresh</button><button className="live-primary" onClick={()=>{setCreating(!creating);setView("Projects");}}>{creating ? "Cancel" : "+ New project"}</button></div></div>
        <div className="execution-banner"><span aria-hidden="true">◉</span><div><strong>{operations?.records.controls?.[0]?.paused?"Queue paused":operations?.capabilities.workerEnabled?"Agent workspace ready":"Workspace controls"}</strong><p>Execution cap: {new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(Number(operations?.capabilities.hardCapCents??0)/100)}. {operations?.records.controls?.[0]?.outbound_enabled?"Outbound actions require exact owner approval, consent, and policy checks.":"Outbound delivery is disabled. Queue a $0 rehearsal to verify agent execution."}</p></div><span className="mode-tag">{operations?.records.controls?.[0]?.outbound_enabled?"OWNER GATED":"OUTBOUND OFF"}</span></div>
        <div aria-live="polite">{notice && <p className="live-notice">{notice}</p>}</div>{error && <p role="alert" className="live-error">{error}</p>}
        {creating && <section className="create-panel"><h2>Create a project</h2><form className="live-form" onSubmit={create}>
          <div className="form-columns"><div><label htmlFor="project-label">Project name</label><input name="label" id="project-label" required maxLength={120} autoFocus /></div>
            <div><label htmlFor="project-category">Focus</label><select name="category" id="project-category">{Object.entries(categories).map(([value,label])=><option value={value} key={value}>{label}</option>)}</select></div></div>
          <label htmlFor="project-description">Project brief</label><textarea id="project-description" name="description" maxLength={2000} rows={3} placeholder="What are you selling, building, or raising funds for?" />
          <button className="live-primary" disabled={busy}>{busy ? "Saving…" : "Create project"}</button></form></section>}
        {view==="Overview" && <section className="live-stats" aria-label="Workspace totals">{[
          ["Active projects",data.projects.length,"From your workspace"],["Agent identities",data.agents.length,"Owner-managed identities"],
          ["Assignments",data.assignments.filter(a=>data.projects.some(p=>p.id===a.project_id)).length,"Saved team allocations"],["Execution hard cap",new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(Number(operations?.capabilities.hardCapCents??0)/100),"Owner-authorized limit"],
        ].map(([label,value,caption])=><article key={label}><span>{label}</span><strong>{value}</strong><small>{caption}</small></article>)}</section>}
        {view==="Overview"&&operations&&<div className="ops-overview-strip"><div><span>Contacts</span><strong>{operations.totals.contacts??0}</strong></div><div><span>Campaigns</span><strong>{operations.totals.campaigns??0}</strong></div><div><span>Verified sales receipts</span><strong>{new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(Number(operations.summary.received_sales_cents??0)/100)}</strong></div></div>}
        {operationViews.includes(view)&&<OperationsConsole view={view} data={operations} workspace={data} onData={setOperations} onWorkspaceChange={()=>void refreshWorkspace()}/>}
        {(view==="Overview" || view==="Projects") && <section aria-labelledby="projects-title"><div className="live-section-heading"><div><h2 id="projects-title">Your projects <span>{data.projects.length}</span></h2><p className="muted">A place for every opportunity.</p></div>
          <input className="live-search" type="search" aria-label="Search projects" placeholder="Search projects…" value={query} onChange={e=>setQuery(e.target.value)} /></div>
          {projects.length ? <div className="project-board">{projects.map(projectCard)}</div> : <div className="live-empty"><span aria-hidden="true">◈</span><h3>{query ? "No matching projects" : "Start with your first project"}</h3>
            <p>{query ? "Try a different search." : "Create a product, grant, or investor relations project. Your work is saved automatically."}</p>{!query && <button className="live-primary" onClick={()=>setCreating(true)}>+ Create project</button>}</div>}
          {data.projects.length>0 && <form className="assignment-form" onSubmit={e=>{e.preventDefault();void assign(selectedAgent,selectedProject);}}><div><h3>Assign an agent</h3><p className="muted">Drag a roster card onto a project, or choose below.</p></div>
            <label>Agent<select aria-label="Agent" required value={selectedAgent} onChange={e=>setSelectedAgent(e.target.value)}><option value="">Choose agent</option>{data.agents.filter(a=>a.status==="active").map(a=><option key={a.id} value={a.id}>{a.display_name}</option>)}</select></label>
            <label>Project<select aria-label="Project" required value={selectedProject} onChange={e=>setSelectedProject(e.target.value)}><option value="">Choose project</option>{data.projects.map(p=><option key={p.id} value={p.id}>{p.label}</option>)}</select></label>
            <label>Allocation %<input type="number" min={1} max={100} step={1} required value={allocation} onChange={e=>setAllocation(Number(e.target.value))} /></label><button disabled={busy} className="live-primary">Assign</button></form>}
        </section>}
        {(view==="Overview" || view==="Agents") && <section aria-labelledby="roster-title"><div className="live-section-heading"><div><h2 id="roster-title">Meet your agents <span>{data.agents.length}</span></h2><p className="muted">Ready for direction. Waiting for execution setup.</p></div>
          {view==="Agents" && <input className="live-search" type="search" aria-label="Search agents" placeholder="Find an agent…" value={query} onChange={e=>setQuery(e.target.value)} />}</div>
          <div className="live-agent-grid">{(view==="Agents" ? agents : data.agents).map(agent=><article key={agent.id} className="live-agent-card" draggable={!busy && agent.status==="active"}
            onDragStart={e=>{e.dataTransfer.setData("text/plain",agent.id);e.dataTransfer.effectAllowed="copy";setDragging(agent.id);}}
            onDragEnd={()=>setDragging(null)}><div className="agent-portrait">{avatar(agent)}<span className="waiting-label"><i /> {operations?.records.jobs?.some(job=>job.agent_identity_id===agent.id&&job.lease_is_live&&Date.parse(job.lease_expires_at)>evidenceNow)?"Running":operations?.records.jobs?.some(job=>job.agent_identity_id===agent.id&&['queued','waiting'].includes(job.state))?"Waiting":"Inactive"}</span></div><h3>{agent.display_name}</h3><p className="muted">{operations?.records.agentConfig?.find(config=>config.agent_identity_id===agent.id)?.role_label??(agent.display_name.includes("Eddie") ? "Sales strategy" : "Fundraising research")}</p>
            <div className="agent-detail-line"><span>Model</span><strong>{operations?.records.agentConfig?.find(config=>config.agent_identity_id===agent.id)?.provider_id??"Not configured"}</strong></div><div className="agent-detail-line"><span>Allocation</span><strong>{data.assignments.filter(a=>a.agent_identity_id===agent.id).reduce((sum,a)=>sum+a.allocation_basis_points,0)/100}%</strong></div>
            <p className="agent-foot">No provider or campaign connected</p><button className="live-secondary" onClick={()=>{setSelectedAgent(agent.id);setView("Projects");}}>Assign to project ↗</button></article>)}</div>
        </section>}
        {view==="Overview" && <section className="activity-section"><div className="live-section-heading"><div><h2>Recent activity</h2><p className="muted">Changes are recorded automatically.</p></div><span className="category-tag">AUDIT LOG</span></div>
          {data.activity.length ? <ol className="activity-list">{data.activity.map(item=><li key={item.id}><span className="activity-dot" aria-hidden="true" /><div><strong>{item.event_type.replaceAll("_"," ").replace("."," · ")}</strong><small>Owner workspace</small></div><time dateTime={item.occurred_at}>{new Date(item.occurred_at).toLocaleString("en-US",{timeZone:"America/New_York",month:"short",day:"numeric",hour:"numeric",minute:"2-digit"})} ET</time></li>)}</ol> : <p className="muted">Your first workspace change will appear here.</p>}</section>}
        <footer className="live-footer"><span>Death Of The Salesman</span><span>Last refreshed {new Date(data.observedAt).toLocaleTimeString("en-US",{timeZone:"America/New_York"})} ET · Render + Neon</span></footer>
      </main></div>
  </div>;
}
