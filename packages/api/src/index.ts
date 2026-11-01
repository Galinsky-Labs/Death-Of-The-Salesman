import { Pool } from "pg";
import type { DeploymentDependencies } from "./deployment.js";
import { createApiServer } from "./http-server.js";
import { deploymentDependencies } from "./deployment-store.js";
export { healthReport, createApiServer } from "./http-server.js";
let pool: Pool | undefined;
let dependencies: DeploymentDependencies | undefined;
if (process.env.NODE_ENV !== "test" && process.env.DATABASE_URL && process.env.DEPLOYMENT_ORGANIZATION_ID) {
  const organizationId = process.env.DEPLOYMENT_ORGANIZATION_ID;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(organizationId)) throw new Error("DEPLOYMENT_ORGANIZATION_ID must be a UUID");
  pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
  dependencies = deploymentDependencies(pool, organizationId);
}
export const server = createApiServer(dependencies);
if (process.env.NODE_ENV !== "test") {
  const port = Number.parseInt(process.env.API_PORT ?? "3001", 10);
  server.listen(port, "127.0.0.1", () => console.log(`API listening on http://127.0.0.1:${port}`));
  const stop = () => { server.close(() => { void pool?.end(); }); };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
}
