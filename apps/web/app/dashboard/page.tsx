import { redirect } from "next/navigation";
import { ownerSession } from "../../lib/auth";
import { loadWorkspace } from "../../lib/workspace";
import { LiveWorkspace } from "../live-workspace";
import "../live-workspace.css";

export const dynamic = "force-dynamic";

export default async function Dashboard() {
  if (!await ownerSession()) redirect("/auth/sign-in");
  try { return <LiveWorkspace initial={await loadWorkspace()} />; }
  catch {
    return <main className="login-shell"><section className="login-panel"><h1>Workspace temporarily unavailable</h1>
      <p>Your saved data is retained. Please retry in a moment.</p><a href="/dashboard">Retry connection</a></section></main>;
  }
}
