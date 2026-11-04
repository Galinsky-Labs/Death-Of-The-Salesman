import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:https";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { createApiServer } from "../packages/api/dist/http-server.js";
import { AssignmentWriteError } from "../packages/database/dist/agent-project-assignments.js";
import { deploymentFixture, ids } from "../tests/helpers/deployment-fixture.mjs";
// Run against a local production web build; the API below uses an isolated PostgreSQL engine.
const base = process.env.DEPLOYMENT_BROWSER_URL ?? "https://127.0.0.1:3003";
if (!/^https?:\/\/(127\.0\.0\.1|localhost):\d+$/.test(base)) throw new Error("Browser tests require a local web server");
const fixture = await deploymentFixture();
const save = fixture.deps.store.save;
const preference = fixture.deps.store.preference;
let fault = "";
let preferenceFault = "";
let unblock;
fixture.deps.store.save = async (...args) => {
  if (fault === "conflict") { fault = ""; throw new AssignmentWriteError("NOT_FOUND_OR_STALE"); }
  if (fault === "delay") { fault = ""; await new Promise(resolve => { unblock = resolve; }); }
  const result = await save(...args);
  if (fault === "ambiguous") { fault = ""; throw new Error("Simulated lost confirmation after commit"); }
  return result;
};
fixture.deps.store.preference = async (...args) => {
  if (preferenceFault === "conflict") { preferenceFault = ""; throw new Error("Simulated preference conflict"); }
  const result = await preference(...args);
  if (preferenceFault === "ambiguous") { preferenceFault = ""; throw new Error("Simulated lost preference confirmation"); }
  return result;
};
const api = createApiServer(fixture.deps);
await new Promise(resolve => api.listen(3001, "127.0.0.1", resolve));
let browser;
let web;
let nextApp;
let tlsDir;
try {
  if (!process.env.DEPLOYMENT_BROWSER_URL) {
    process.env.DOTS_WEB_ORIGIN = base;
    tlsDir = await mkdtemp(join(tmpdir(), "dots-browser-tls-"));
    const key = join(tlsDir, "key.pem"), cert = join(tlsDir, "cert.pem");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-keyout", key, "-out", cert, "-days", "1", "-nodes", "-subj", "/CN=localhost"], { stdio: "ignore" });
    const require = createRequire(new URL("../apps/web/package.json", import.meta.url));
    const next = require("next");
    nextApp = next({ dev: false, dir: fileURLToPath(new URL("../apps/web", import.meta.url)), hostname: "127.0.0.1", port: 3003 });
    await nextApp.prepare();
    web = createServer({ key: await readFile(key), cert: await readFile(cert) }, nextApp.getRequestHandler());
    await new Promise(resolve => web.listen(3003, "127.0.0.1", resolve));
  }
  browser = await chromium.launch({ headless: true, executablePath: process.env.DEPLOYMENT_CHROMIUM_PATH, args: ["--disable-dev-shm-usage", "--no-sandbox"] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, colorScheme: "dark", viewport: { width: 1440, height: 1100 } });
  await context.addCookies([{ name: "__Host-dots-session", value: "synthetic-session", url: base, secure: true, httpOnly: true, sameSite: "Strict" }, { name: "dots-csrf", value: "synthetic-csrf", url: base, sameSite: "Strict" }]);
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await mkdir("docs/evidence/DOTS-026", { recursive: true });
  await page.goto(`${base}/deployment`);
  await page.getByRole("status").filter({ hasText: "Assignments loaded from server." }).waitFor();
  const oversized = await page.evaluate(async () => (await fetch("/api/deployment", { method: "POST", headers: { "Content-Type": "application/json" }, body: "x".repeat(4097) })).status);
  assert.equal(oversized, 413);
  const rejected = await context.request.post(`${base}/api/deployment`, { headers: { origin: "https://untrusted.example" }, data: {} });
  assert.equal(rejected.status(), 403);
  const buckets = page.locator(".deployment-bucket");
  // Native HTML drag-and-drop opens settings without prematurely claiming persistence.
  await page.locator(".deployment-roster li").first().dragTo(buckets.first());
  await page.getByRole("dialog").waitFor();
  assert.match(await page.getByRole("status").innerText(), /Unsaved/);
  await page.getByLabel("Allocation (basis points; 100 = 1%)", { exact: true }).fill("4000");
  await page.screenshot({ path: "docs/evidence/DOTS-026/unsaved-settings.png", fullPage: true });
  fault = "delay";
  await page.getByRole("button", { name: "Save assignment", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Unsaved — confirming" }).waitFor();
  assert.equal(await buckets.first().locator("li").count(), 1);
  await page.waitForFunction(() => document.querySelector(".deployment")?.getAttribute("aria-busy") === "true");
  for (let i = 0; i < 20 && !unblock; i++) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(unblock, "API save should be waiting");
  await page.screenshot({ path: "docs/evidence/DOTS-026/pending-save.png", fullPage: true });
  unblock();
  await page.getByRole("status").filter({ hasText: "Assignment saved and reloaded from server." }).waitFor();
  await page.reload();
  await page.getByRole("status").filter({ hasText: "Assignments loaded from server." }).waitFor();
  assert.equal(await buckets.first().locator("li").count(), 1);
  // A conflicting move rolls back and the original assignment remains visible.
  fault = "conflict";
  await buckets.first().locator("li").dragTo(buckets.nth(1));
  await page.getByRole("button", { name: "Save assignment", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Conflicting drop" }).waitFor();
  assert.equal(await buckets.first().locator("li").count(), 1);
  assert.equal(await buckets.nth(1).locator("li").count(), 0);
  await page.screenshot({ path: "docs/evidence/DOTS-026/conflicting-drop.png", fullPage: true });
  // If commit succeeds but the response is lost, reconcile server state without a blind retry.
  fault = "ambiguous";
  await buckets.first().locator("li").dragTo(buckets.nth(1));
  await page.getByRole("button", { name: "Save assignment", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Server state reloaded" }).waitFor();
  assert.equal(await buckets.first().locator("li").count(), 0);
  assert.equal(await buckets.nth(1).locator("li").count(), 1);
  assert.equal(await page.locator(".deployment-bucket li").count(), 1);
  const checks = page.locator(".bucket-selection input");
  preferenceFault = "conflict";
  await checks.nth(1).uncheck();
  await page.getByRole("alert").filter({ hasText: "Server state reloaded" }).waitFor();
  await page.getByRole("status").filter({ hasText: "Bucket preference result reloaded" }).waitFor();
  assert.equal(await checks.nth(1).isChecked(), true);
  preferenceFault = "ambiguous";
  await checks.nth(1).uncheck();
  await page.getByRole("alert").filter({ hasText: "Server state reloaded" }).waitFor();
  assert.equal(await checks.nth(1).isChecked(), false);
  assert.equal(await buckets.count(), 1);
  await checks.nth(1).check();
  await page.getByRole("status").filter({ hasText: "Bucket preference saved" }).waitFor();
  assert.equal(await page.locator(".deployment-bucket li").count(), 1);
  let failReload = true;
  await page.route("**/api/deployment", async route => {
    if (failReload && route.request().method() === "GET") { failReload = false; await route.abort(); }
    else await route.continue();
  });
  await page.getByRole("button", { name: "Reload server state" }).click();
  await page.getByRole("status").filter({ hasText: "Server assignments could not be loaded." }).waitFor();
  await page.unroute("**/api/deployment");
  await page.reload();
  await page.getByRole("status").filter({ hasText: "Assignments loaded from server." }).waitFor();
  await mkdir("docs/evidence/DOTS-026", { recursive: true });
  for (const width of [1440, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1100 });
    await page.screenshot({ path: `docs/evidence/DOTS-026/board-${width}.png`, fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `horizontal page overflow at ${width}px`);
  }
  assert.deepEqual(errors, []);
  console.log("PASS: drag/drop, optimistic rollback, assignment and preference reconciliation, truthful reload failures, hide/show preservation; screenshots at 1440/1024/768/390/320px.");
} finally {
  unblock?.(); await browser?.close(); await new Promise(resolve => api.close(resolve)); await fixture.db.close();
  if (web) { web.closeAllConnections(); await new Promise(resolve => web.close(resolve)); }
  await nextApp?.close();
  if (tlsDir) await rm(tlsDir, { recursive: true, force: true });
}
