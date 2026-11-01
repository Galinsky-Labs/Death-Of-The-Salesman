import { DeploymentBoard } from "./deployment-board";
import { WorkspaceNavigation } from "../workspace-navigation";
export default function DeploymentPage() {
  return <WorkspaceNavigation preview={false}><main className="shell"><DeploymentBoard /></main></WorkspaceNavigation>;
}
