import assert from "node:assert/strict";
import test from "node:test";
import { text, entityId, integer } from "../apps/web/lib/workspace-input.ts";

test("workspace mutations reject malformed and unbounded input before database access", () => {
  for (const value of [null, {}, [], 42, "", "  ", "x".repeat(121)]) {
    assert.throws(()=>text(value,"Project name",120));
  }
  assert.equal(text("  New product  ","Project name",120),"New product");
  assert.equal(text(" ","Brief",2000,true),"");
  for (const value of [null,{},"not-a-uuid","00000000-0000-0000-0000-000000000000","' OR true --"]) assert.throws(()=>entityId(value));
  assert.equal(entityId("11111111-1111-4111-8111-111111111111"),"11111111-1111-4111-8111-111111111111");
  for (const value of [null,"50",0,-1,100.1,101,NaN,Infinity]) assert.throws(()=>integer(value,100));
  assert.equal(integer(100,100),100);
});
