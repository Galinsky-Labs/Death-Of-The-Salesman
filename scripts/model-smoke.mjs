#!/usr/bin/env node
// DOTS-069 opt-in, credential-backed live model smoke gate.
//
// Refuses to make any network request unless ALL of the following are set by the owner:
//   MODEL_SMOKE_ENABLED=true, MODEL_SMOKE_PROVIDERS=<comma list of openai|claude|grok|openrouter>,
//   MODEL_SMOKE_CAP_CENTS=<positive integer, <= PAID_SPEND_LIMIT_CENTS for paid providers>,
//   and, for paid providers, MODEL_API_ENABLED=true, OWNER_SPEND_AUTHORIZATION_ID, PAID_SPEND_LIMIT_CENTS>0
//   plus <PROVIDER>_ENABLED, <PROVIDER>_API_KEY, <PROVIDER>_MODEL and per-million prices.
// Pass --plan to print the plan only (never calls a provider).
// Exit codes: 0 = every requested provider passed, 1 = a live call failed, 2 = blocked before any network call.
// Output never contains credential values. Build first: `pnpm typecheck`.
import { planModelSmoke, runModelSmoke } from "../packages/operations/dist/index.js";

const planOnly = process.argv.includes("--plan");
const plan = planModelSmoke(process.env);
if (planOnly || !plan.ready) {
  const status = plan.ready ? "ready" : "blocked";
  console.log(JSON.stringify({ status, networkCalls: false, plan, note: plan.ready ? "Plan only; rerun without --plan to spend up to the cap." : "Blocked on external prerequisite: owner-funded provider account, scoped API key and preapproved cap. No request was sent." }, null, 2));
  process.exit(plan.ready ? 0 : 2);
}
const outcome = await runModelSmoke(process.env);
console.log(JSON.stringify(outcome, null, 2));
process.exit(outcome.status === "passed" ? 0 : outcome.status === "blocked" ? 2 : 1);
