#!/usr/bin/env node
// DOTS-109: owner-authorized real mailbox canary preflight, checklist and evidence verifier.
// This script never sends email itself and never prints secret values. The live send goes through the
// product's gated path (Conversations composer -> exact-message approval -> DeliveryGateway with
// communicationDispatchChecks), so every consent, suppression, sender-authentication and budget gate applies.
// Usage:
//   node scripts/mailbox-canary.mjs                      # preflight + checklist (refuses unless authorized)
//   node scripts/mailbox-canary.mjs --verify <file.json> # validate recorded canary evidence
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const emailPattern = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;
const list = (value) => String(value ?? "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
const mask = (email) => { const [local, domain] = email.split("@"); return `${local.slice(0, 1)}***@${domain}`; };

export function preflight(env = process.env) {
  const failures = [];
  if (env.MAILBOX_CANARY_ENABLED !== "true") failures.push("MAILBOX_CANARY_ENABLED must be exactly 'true' (explicit owner opt-in).");
  if (!/^[A-Za-z0-9_.:-]{6,120}$/.test(env.MAILBOX_CANARY_AUTHORIZATION_ID ?? "")) failures.push("MAILBOX_CANARY_AUTHORIZATION_ID must reference the owner's written canary authorization.");
  const sender = String(env.MAILBOX_CANARY_SENDER ?? "").toLowerCase();
  if (!emailPattern.test(sender)) failures.push("MAILBOX_CANARY_SENDER must be the owner's connected, consented sender address.");
  if (!env.SENDER_VERIFICATION_REFERENCE) failures.push("SENDER_VERIFICATION_REFERENCE is required (provider domain verification with SPF, DKIM and DMARC passing).");
  const allowed = new Set(list(env.MAILBOX_CANARY_ALLOWED_RECIPIENTS));
  const recipients = list(env.MAILBOX_CANARY_RECIPIENTS);
  if (!recipients.length || recipients.length > 5) failures.push("MAILBOX_CANARY_RECIPIENTS must list 1 to 5 owner-controlled test inboxes.");
  for (const recipient of recipients) {
    if (!emailPattern.test(recipient)) failures.push(`Recipient ${recipient ? mask(recipient) : "(empty)"} is not a valid address.`);
    else if (!allowed.has(recipient)) failures.push(`Recipient ${mask(recipient)} is not in MAILBOX_CANARY_ALLOWED_RECIPIENTS.`);
    else if (/@(example\.(com|org|net|invalid)|.*\.invalid)$/.test(recipient)) failures.push(`Recipient ${mask(recipient)} is a reserved test domain and cannot receive mail.`);
  }
  if (env.EMAIL_DELIVERY_ENABLED !== "true") failures.push("EMAIL_DELIVERY_ENABLED must be 'true' for the canary window only.");
  for (const name of ["EMAIL_DELIVERY_TOKEN", "OUTREACH_POLICY_AUTHORIZATION_ID", "UNSUBSCRIBE_SIGNING_KEY", "EMAIL_WEBHOOK_SECRET"]) if (!env[name]) failures.push(`${name} must be configured (value is never printed).`);
  if (!/^https:\/\//.test(env.APP_ORIGIN ?? "")) failures.push("APP_ORIGIN must be the deployed https origin so one-click unsubscribe and webhooks resolve.");
  const free = env.EMAIL_BILLING_MODE === "free" && env.EMAIL_FREE_PLAN_CONFIRMED === "true" && env.EMAIL_COST_CENTS === "0";
  if (!free && !(env.OWNER_SPEND_AUTHORIZATION_ID && Number(env.PAID_SPEND_LIMIT_CENTS ?? 0) > 0)) failures.push("Either a confirmed $0 email plan or an owner spend authorization with a hard cap is required.");
  return { ok: failures.length === 0, failures, sender: sender && emailPattern.test(sender) ? mask(sender) : null, recipients: recipients.filter((item) => emailPattern.test(item)).map(mask) };
}

export const checklist = [
  "Owner connects the canary mailbox in Conversations > Sender setup and saves the tenant postal address profile.",
  "Run domain verification (Resend) and the DMARC check; SPF, DKIM and DMARC must all show 'pass'.",
  "Owner grants mailbox consent; confirm status 'active' and no other tenant uses the sender.",
  "Add each allow-listed test inbox as a contact with consent evidence 'owner-controlled canary inbox' and jurisdiction in EMAIL_ALLOWED_JURISDICTIONS.",
  "Create a product campaign limited to those contacts, activate it with owner approval, daily limit <= recipient count.",
  "Compose one message per recipient, review the plain-text preview, approve the exact revision, then send.",
  "Record provider message id, 'Provider accepted' label, the signed delivered webhook and the Message-ID header seen in the test inbox.",
  "Reply from one test inbox; confirm it threads into the same conversation and attaches to the campaign.",
  "Use the List-Unsubscribe one-click (or reply 'unsubscribe') from one test inbox; confirm suppression and cancelled pending steps.",
  "Disable EMAIL_DELIVERY_ENABLED after the window and save the evidence JSON for --verify.",
];

export function verifyEvidence(evidence, env = process.env) {
  const problems = [];
  const allowed = new Set(list(env.MAILBOX_CANARY_ALLOWED_RECIPIENTS));
  if (!evidence || typeof evidence !== "object") return { ok: false, problems: ["Evidence must be a JSON object."] };
  if (!evidence.authorizationId || evidence.authorizationId !== env.MAILBOX_CANARY_AUTHORIZATION_ID) problems.push("authorizationId must match MAILBOX_CANARY_AUTHORIZATION_ID.");
  const sends = Array.isArray(evidence.sends) ? evidence.sends : [];
  if (!sends.length) problems.push("At least one send is required.");
  for (const [index, send] of sends.entries()) {
    if (!allowed.has(String(send?.recipient ?? "").toLowerCase())) problems.push(`sends[${index}] recipient is not allow-listed.`);
    if (!/^[A-Za-z0-9_.:@-]{1,200}$/.test(String(send?.providerMessageId ?? ""))) problems.push(`sends[${index}] needs the provider message id.`);
    if (!["delivered", "bounced"].includes(send?.finalReceipt)) problems.push(`sends[${index}] needs a signed delivered or bounced receipt.`);
  }
  if (evidence.replyThreaded !== true) problems.push("replyThreaded must be true (reply attached to the original conversation).");
  if (evidence.optOutSuppressed !== true) problems.push("optOutSuppressed must be true (one-click or reply opt-out suppressed the test contact).");
  return { ok: problems.length === 0, problems };
}

async function main(argv) {
  const verifyIndex = argv.indexOf("--verify");
  if (verifyIndex >= 0) {
    const file = argv[verifyIndex + 1];
    if (!file) { console.error("--verify needs an evidence file path"); return 2; }
    const result = verifyEvidence(JSON.parse(await readFile(file, "utf8")));
    console.log(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }
  const result = preflight();
  if (!result.ok) {
    console.error("Mailbox canary refused. Blocked on external prerequisite:");
    for (const failure of result.failures) console.error(` - ${failure}`);
    console.error("See docs/COMMUNICATIONS.md (DOTS-109). No message was sent.");
    return 2;
  }
  console.log(`Canary authorized for sender ${result.sender} and ${result.recipients.length} allow-listed recipient(s): ${result.recipients.join(", ")}`);
  console.log("This script does not send. Complete the checklist through the gated product path:");
  checklist.forEach((item, index) => console.log(`${index + 1}. ${item}`));
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = await main(process.argv.slice(2));
