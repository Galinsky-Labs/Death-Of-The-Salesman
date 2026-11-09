import { getAuth } from "../../../../lib/auth";
import { hasTrustedOrigin } from "../../../../lib/request-origin";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ path: string[] }> };

// Expose only the owner email-code flow and session lifecycle from the managed SDK.
// The provider also rate limits requests; no public password/social signup surface is exposed.
async function handle(request: Request, context: Context) {
  const path = (await context.params).path.join("/");
  const allowed = new Set(["email-otp/send-verification-otp", "sign-in/email-otp", "get-session", "sign-out"]);
  if (!allowed.has(path)) return Response.json({ error: "Unavailable" }, { status: 404 });
  if (request.method === "POST") {
    if (!hasTrustedOrigin(request)) {
      return Response.json({ error: "Invalid origin" }, { status: 403 });
    }
    if (path !== "sign-out") {
      const body = await request.clone().json().catch(() => null);
      if (!body || typeof body.email !== "string" || !process.env.OWNER_EMAIL ||
          body.email.trim().toLowerCase() !== process.env.OWNER_EMAIL.trim().toLowerCase()) {
        return Response.json({ error: "This workspace is restricted to its owner" }, { status: 403 });
      }
    }
  }
  const handlers = getAuth().handler();
  if (request.method === "GET") return handlers.GET(request, context);
  if (request.method === "POST") return handlers.POST(request, context);
  return Response.json({ error: "Method not allowed" }, { status: 405 });
}

export const GET = handle;
export const POST = handle;
