import { inWorkspace } from "../../../lib/database";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await inWorkspace(async client=>{
      const result = await client.query("SELECT to_regclass('app.agent_project_assignments') IS NOT NULL AND to_regclass('app.task_queue') IS NOT NULL AND to_regclass('app.document_library') IS NOT NULL AND EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='app' AND table_name='action_approvals' AND column_name='proposed_payload') AS ready");
      if (!result.rows[0]?.ready) throw new Error("Migrations pending");
    });
    return Response.json({service:"web",status:"ok",database:"connected",execution:process.env.JOB_WORKER_ENABLED==="true"?"durable_queue":"disabled",paidExecution:process.env.MODEL_API_ENABLED==="true",revision:process.env.RENDER_GIT_COMMIT ?? "local"},
      {headers:{"Cache-Control":"no-store"}});
  } catch { return Response.json({service:"web",status:"unavailable"},{status:503,headers:{"Cache-Control":"no-store"}}); }
}
