"use client";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { assignmentsIn, EMPTY_BOARD, prepareDrop, type BoardSnapshot, type DropIntent } from "../deployment-model";
import "./deployment.css";
const dragType = "application/x-dots-agent";
const csrf = () => document.cookie.split(";").map(c => c.trim()).find(c => c.startsWith("dots-csrf="))?.slice("dots-csrf=".length) ?? "";
async function loadBoard(): Promise<BoardSnapshot> {
  const response = await fetch("/api/deployment", { cache: "no-store", credentials: "same-origin" });
  if (!response.ok) throw new Error(response.status === 401 ? "Sign in with an owner session to load assignments." : "Server assignments are unavailable. Reload when the service is available.");
  return response.json() as Promise<BoardSnapshot>;
}
export function DeploymentBoard() {
  const [board, setBoard] = useState<BoardSnapshot>(EMPTY_BOARD);
  const [loaded, setLoaded] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("Loading server assignments…");
  const [error, setError] = useState("");
  const [intent, setIntent] = useState<DropIntent | null>(null);
  const [query, setQuery] = useState("");
  const busy = useRef(false);
  const drag = useRef<{ agentIdentityId: string; assignmentId: string | null } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const requestRefresh = async () => {
    if (busy.current) return;
    busy.current = true; setPending(true); setMessage("Loading server assignments…");
    try { setBoard(await loadBoard()); setLoaded(true); setError(""); setMessage("Assignments loaded from server."); }
    catch (e) { setLoaded(false); setError((e as Error).message); setMessage("Server assignments could not be loaded."); }
    finally { busy.current = false; setPending(false); }
  };
  useEffect(() => { void requestRefresh(); }, []);
  useEffect(() => {
    if (intent) dialog.current?.showModal(); else dialog.current?.close();
  }, [intent !== null]);
  useEffect(() => {
    if (!pending && !intent) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [pending, intent]);
  const begin = (agentIdentityId: string, assignmentId: string | null, bucketId: string) => {
    if (!loaded || busy.current) return;
    const prior = board.assignments.find(a => a.id === assignmentId);
    setIntent({ agentIdentityId, assignmentId, bucketId, allocationBasisPoints: prior?.allocationBasisPoints ?? 1000, priority: prior?.priority ?? 50, quotaLimit: prior?.quotaLimit ?? 100, concurrencyCap: prior?.concurrencyCap ?? 1 });
    setError("");
  };
  const onDrag = (event: DragEvent, agentIdentityId: string, assignmentId: string | null) => {
    if (!loaded || busy.current) { event.preventDefault(); return; }
    drag.current = { agentIdentityId, assignmentId };
    event.dataTransfer.effectAllowed = assignmentId ? "move" : "copy";
    event.dataTransfer.setData(dragType, "deployment-agent");
  };
  const save = async () => {
    if (!intent || busy.current) return;
    let drop: ReturnType<typeof prepareDrop>;
    try { drop = prepareDrop(board, intent); } catch (e) { setError((e as Error).message); return; }
    const saved = board;
    busy.current = true; setPending(true); setBoard(drop.optimistic); setIntent(null); setError(""); setMessage("Unsaved — confirming assignment with server…");
    try {
      const response = await fetch("/api/deployment", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "x-csrf-token": csrf() }, body: JSON.stringify(drop.input) });
      if (!response.ok) throw new Error(response.status === 409 ? "Conflicting drop: another change or allocation limit prevented the save." : "The server did not confirm the save.");
      setBoard(await loadBoard()); setLoaded(true); setMessage("Assignment saved and reloaded from server.");
    } catch (e) {
      setBoard(saved); setMessage("Save was not confirmed. Optimistic changes rolled back.");
      try { setBoard(await loadBoard()); setLoaded(true); setError(`${(e as Error).message} Server state reloaded; inspect it before retrying.`); }
      catch { setLoaded(false); setError(`${(e as Error).message} Current server state is unknown. Reload before making another change.`); }
    } finally { busy.current = false; setPending(false); }
  };
  const toggle = async (bucketId: string, visible: boolean) => {
    if (busy.current || !loaded) return;
    const bucket = board.buckets.find(b => b.id === bucketId);
    if (!bucket) return;
    busy.current = true; setPending(true); setError(""); setMessage("Unsaved — confirming bucket preference…");
    setBoard({ ...board, buckets: board.buckets.map(b => b.id === bucketId ? { ...b, visible } : b) });
    try {
      const r = await fetch("/api/deployment/preferences", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "x-csrf-token": csrf() }, body: JSON.stringify({ bucketId, visible, position: bucket.position, expectedVersion: bucket.preferenceVersion }) });
      if (!r.ok) throw new Error("Bucket visibility was not confirmed; reload before retrying.");
      setBoard(await loadBoard()); setMessage("Bucket preference saved. Assignments are preserved.");
    } catch (e) {
      setBoard(board); setMessage("Bucket preference was not confirmed. Checking server state…");
      try { setBoard(await loadBoard()); setLoaded(true); setError(`${(e as Error).message} Server state reloaded; inspect it before retrying.`); setMessage("Bucket preference result reloaded from server."); }
      catch { setLoaded(false); setError(`${(e as Error).message} Current server state is unknown. Reload before making another change.`); setMessage("Server state is unknown; editing is disabled."); }
    } finally { busy.current = false; setPending(false); }
  };
  return <section className="deployment" aria-labelledby="deployment-title" aria-busy={pending}>
    <header className="deployment-header"><div><p className="eyebrow">Deployment</p><h1 id="deployment-title">Agent deployment board</h1><p>Choose visible buckets, then drag an agent to allocate work. This does not start workers or enable spending.</p></div><button disabled={pending || !!intent} onClick={() => void requestRefresh()}>Reload server state</button></header>
    <p role="status">{intent ? "Unsaved assignment settings — save or cancel." : message}</p>
    {error && <p role="alert" className="deployment-error">{error}</p>}
    <fieldset disabled={!loaded || pending || !!intent} className="bucket-selection"><legend>Checked project buckets</legend>{board.buckets.map(b => <label key={b.id}><input type="checkbox" checked={b.visible} onChange={e => void toggle(b.id, e.target.checked)} />{b.label}</label>)}{loaded && !board.buckets.length && <p>No project buckets have been created.</p>}</fieldset>
    <div className="deployment-layout"><aside aria-labelledby="available-agents"><h2 id="available-agents">Agents</h2><label>Search agents<input type="search" value={query} onChange={e => setQuery(e.target.value)} /></label><ul className="deployment-roster">{board.agents.filter(a => a.displayName.toLowerCase().includes(query.toLowerCase())).slice(0, 100).map(a => <li key={a.id} draggable={loaded && !pending && a.status === "active"} onDragStart={e => onDrag(e, a.id, null)} onDragEnd={() => { drag.current = null; }}><strong>{a.displayName}</strong><span>{a.status === "active" ? "Available to assign — worker status not verified" : "Identity inactive"}</span><button disabled={!loaded || pending || a.status !== "active" || !board.buckets.some(b => b.visible)} onClick={() => begin(a.id, null, board.buckets.find(b => b.visible)?.id ?? "")}>Assign {a.displayName}</button></li>)}</ul>{board.agents.length > 100 && <p>Search to narrow the first 100 visible agents.</p>}</aside>
    <div className="deployment-buckets">{board.buckets.filter(b => b.visible).map(b => <section key={b.id} className="deployment-bucket" aria-label={`${b.label} assignments`} onDragOver={e => { if (drag.current && loaded && !pending) { e.preventDefault(); e.dataTransfer.dropEffect = drag.current.assignmentId ? "move" : "copy"; } }} onDrop={e => { e.preventDefault(); const source = drag.current; drag.current = null; if (source) begin(source.agentIdentityId, source.assignmentId, b.id); }}><h2>{b.label}</h2><p>Drop an agent here</p><ul>{assignmentsIn(board, b).map(a => <li key={a.id} draggable={!pending} onDragStart={e => onDrag(e, a.agentIdentityId, a.id)} onDragEnd={() => { drag.current = null; }}><strong>{board.agents.find(agent => agent.id === a.agentIdentityId)?.displayName ?? "Unavailable identity"}</strong><span>{a.allocationBasisPoints / 100}% allocation · priority {a.priority}</span><span>Quota {a.quotaLimit} · concurrency {a.concurrencyCap}</span><button disabled={pending || !loaded} onClick={() => begin(a.agentIdentityId, a.id, b.id)}>Edit or move assignment</button></li>)}</ul></section>)}</div></div>
    <dialog ref={dialog} onCancel={() => setIntent(null)} aria-labelledby="assignment-settings"><form onSubmit={e => { e.preventDefault(); void save(); }}><h2 id="assignment-settings">Assignment settings</h2>{error && <p role="alert">{error}</p>}{intent && <><label>Target bucket<select value={intent.bucketId} onChange={e => setIntent({ ...intent, bucketId: e.target.value })}>{board.buckets.filter(b => b.visible).map(b => <option key={b.id} value={b.id}>{b.label}</option>)}</select></label>{([['allocationBasisPoints', 'Allocation (basis points; 100 = 1%)', 1, 10000], ['priority', 'Priority', 0, 100], ['quotaLimit', 'Work quota', 1, Number.MAX_SAFE_INTEGER], ['concurrencyCap', 'Concurrency cap', 1, 1000]] as const).map(([key, label, min, max]) => <label key={key}>{label}<input type="number" step="1" min={min} max={max} required value={intent[key]} onChange={e => setIntent({ ...intent, [key]: e.target.valueAsNumber })} /></label>)}</>}<div className="deployment-actions"><button type="button" onClick={() => setIntent(null)}>Cancel unsaved changes</button><button type="submit" disabled={pending}>Save assignment</button></div></form></dialog>
  </section>;
}
