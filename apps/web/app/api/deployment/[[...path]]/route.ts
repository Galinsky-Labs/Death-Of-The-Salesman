import type { NextRequest } from "next/server";
export const dynamic = "force-dynamic";
async function proxy(request: NextRequest) {
  const suffix = request.nextUrl.pathname.slice("/api/deployment".length);
  if (suffix !== "" && suffix !== "/preferences") return Response.json({ code: "NOT_FOUND" }, { status: 404 });
  if (request.method === "POST" && request.headers.get("origin") !== request.nextUrl.origin) return Response.json({ code: "ORIGIN_REJECTED" }, { status: 403 });
  const base = process.env.DOTS_API_ORIGIN ?? "http://127.0.0.1:3001";
  const endpoint = new URL(`/deployment${suffix}`, base);
  if (endpoint.username || endpoint.password || !["http:", "https:"].includes(endpoint.protocol)) return Response.json({ code: "DEPLOYMENT_UNAVAILABLE" }, { status: 503 });
  try {
    const body = request.method === "POST" ? await request.text() : undefined;
    if (body && new TextEncoder().encode(body).length > 4096) return Response.json({ code: "BODY_TOO_LARGE" }, { status: 413 });
    const response = await fetch(endpoint, { method: request.method, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10000), headers: { cookie: request.headers.get("cookie") ?? "", "x-csrf-token": request.headers.get("x-csrf-token") ?? "", "content-type": "application/json", origin: endpoint.origin }, ...(body !== undefined ? { body } : {}) });
    return new Response(await response.text(), { status: response.status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  } catch { return Response.json({ code: "DEPLOYMENT_UNAVAILABLE" }, { status: 503, headers: { "Cache-Control": "no-store" } }); }
}
export const GET = proxy;
export const POST = proxy;
