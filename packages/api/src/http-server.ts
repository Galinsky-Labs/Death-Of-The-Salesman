import { createServer } from "node:http";
import type { HealthReport } from "@dots/domain";
import { handleDeployment, type DeploymentDependencies } from "./deployment.js";
export const healthReport = (): HealthReport => ({ service: "api", status: "ok" });
export function createApiServer(dependencies?: DeploymentDependencies) {
  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(healthReport())); return;
    }
    if (!request.url?.startsWith("/deployment")) { response.writeHead(404).end(); return; }
    try {
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of request) {
        const bytes = Buffer.from(chunk); size += bytes.length;
        if (size > 4096) { response.writeHead(413, { "content-type": "application/json", "cache-control": "no-store" }).end('{"code":"BODY_TOO_LARGE"}'); return; }
        chunks.push(bytes);
      }
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(",") : value);
      const method = request.method ?? "GET";
      const req = new Request(`http://${request.headers.host ?? "127.0.0.1"}${request.url}`, { method, headers, ...(!["GET", "HEAD"].includes(method) ? { body: Buffer.concat(chunks).toString("utf8") } : {}) });
      const result = await handleDeployment(req, dependencies);
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(await result.text());
    } catch { response.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" }).end('{"code":"DEPLOYMENT_UNAVAILABLE"}'); }
  });
}
