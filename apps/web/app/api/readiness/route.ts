import { inWorkspace } from "../../../lib/database";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await inWorkspace(async client=>{
      const result = await client.query("SELECT to_regclass('app.agent_project_assignments') IS NOT NULL AS ready");
      if (!result.rows[0]?.ready) throw new Error("Migrations pending");
    });
    return Response.json({service:"web",status:"ok",database:"connected",execution:"disabled",revision:process.env.RENDER_GIT_COMMIT ?? "local"},
      {headers:{"Cache-Control":"no-store"}});
  } catch { return Response.json({service:"web",status:"unavailable"},{status:503,headers:{"Cache-Control":"no-store"}}); }
}
