import { ownerSession } from "../../../lib/auth";
import { loadWorkspace, createProject, archiveProject, assignAgent, removeAssignment } from "../../../lib/workspace";
import { InputError, text, integer, entityId } from "../../../lib/workspace-input";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control":"private, no-store" };

export async function GET() {
  try {
    if (!await ownerSession()) return Response.json({error:"Sign in as the workspace owner"},{status:401,headers:noStore});
    return Response.json(await loadWorkspace(),{headers:noStore});
  } catch { return Response.json({error:"Workspace unavailable. Please try again."},{status:503,headers:noStore}); }
}

export async function POST(request: Request) {
  try {
    if (request.headers.get("origin") !== new URL(request.url).origin) {
      return Response.json({error:"Invalid origin"},{status:403});
    }
    if (!await ownerSession()) return Response.json({error:"Sign in as the workspace owner"},{status:401});
    if (!request.headers.get("content-type")?.startsWith("application/json")) throw new InputError("JSON is required");
    const raw = await request.text();
    if (raw.length > 10000) throw new InputError("Request is too large");
    const body = JSON.parse(raw);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new InputError("Invalid request");
    switch(body.action) {
      case "createProject": {
        const category = text(body.category,"Category",20);
        if (!["product","grant","investment"].includes(category)) throw new InputError("Choose a valid project category");
        await createProject(text(body.label,"Project name",120),text(body.description,"Brief",2000,true),category);
        break;
      }
      case "archiveProject": await archiveProject(entityId(body.id),integer(body.version,Number.MAX_SAFE_INTEGER)); break;
      case "assignAgent": await assignAgent(entityId(body.agentId),entityId(body.projectId),integer(body.allocation,100)*100); break;
      case "removeAssignment": await removeAssignment(entityId(body.id),integer(body.version,Number.MAX_SAFE_INTEGER)); break;
      default: throw new InputError("Unknown action");
    }
    return Response.json(await loadWorkspace(),{headers:noStore});
  } catch(error) {
    if (error instanceof InputError || error instanceof SyntaxError) return Response.json({error:error.message},{status:400});
    const message = error instanceof Error ? error.message : "";
    if (message === "PROJECT_HAS_ASSIGNMENTS") return Response.json({error:"Remove this project's agent assignments before archiving it."},{status:409});
    if (["NOT_FOUND_OR_STALE","TARGET_CONFLICT","ALLOCATION_EXCEEDED"].includes(message)) {
      return Response.json({error: message === "ALLOCATION_EXCEEDED" ? "This agent's total allocation would exceed 100%. Remove an assignment first." : "This record changed or already exists. Refresh and try again."},{status:409});
    }
    return Response.json({error:"Could not save this change. Please try again."},{status:503});
  }
}
