import assert from "node:assert/strict";
import test from "node:test";
import { hasTrustedOrigin } from "../apps/web/lib/request-origin.ts";

test("browser origin uses the configured HTTPS origin behind Render's HTTP proxy", () => {
  const savedOrigin = process.env.APP_ORIGIN;
  const savedEnvironment = process.env.APP_ENV;
  try {
    process.env.APP_ORIGIN="https://workspace.example";
    process.env.APP_ENV="production";
    const request = (origin,extra={})=>new Request("http://internal:10000/api/workspace",{
      method:"POST",headers:{...(origin ? {origin} : {}),...extra},
    });
    assert.equal(hasTrustedOrigin(request("https://workspace.example")),true);
    assert.equal(hasTrustedOrigin(request("http://workspace.example")),false);
    assert.equal(hasTrustedOrigin(request("https://attacker.example")),false);
    assert.equal(hasTrustedOrigin(request(undefined)),false);
    assert.equal(hasTrustedOrigin(request("null")),false);
    assert.equal(hasTrustedOrigin(request("https://attacker.example",{"x-forwarded-host":"attacker.example","x-forwarded-proto":"https"})),false);
    delete process.env.APP_ORIGIN;
    assert.equal(hasTrustedOrigin(request("http://internal:10000")),false);
  } finally {
    if(savedOrigin === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN=savedOrigin;
    if(savedEnvironment === undefined) delete process.env.APP_ENV; else process.env.APP_ENV=savedEnvironment;
  }
});
