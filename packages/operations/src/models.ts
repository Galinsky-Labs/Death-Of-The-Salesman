/**
 * Phase F5 — approved model execution and evaluation (DOTS-055 … DOTS-069).
 *
 * Everything here is deny-by-default: a provider/model pair is only callable when it is in the reviewed
 * manifest, bound to its exact trusted endpoint, recorded as an approved immutable revision, configured with
 * an owner-supplied credential, permitted for the request's privacy class and funded by an owner budget.
 * Tests inject `transport`, `sleep`, `random` and `now`; nothing in this module performs network I/O
 * except through the injected (or default) transport inside `invokeModel`/`detectGrokModels`.
 */
import { type Client, type Context, type Row, rows, tenant, event, fail, digest, text, cents, OperationError } from "./common.js";
import { ControlPlane } from "./control.js";
import { identifier, selection } from "./sales.js";
import {
  type ProviderId, providerIds, providerEndpoints, providerConfiguration, disallowedModelLineage, modelFamilies, modelFamilyMismatch,
  freeModelId, discoverFreeModels,
} from "./providers.js";

/* ───────────────────────────── DOTS-055 manifest ───────────────────────────── */

export type PrivacyClass = "public" | "internal" | "private";
export const privacyClasses: readonly PrivacyClass[] = ["public", "internal", "private"];
const privacyRank: Record<PrivacyClass, number> = { public: 0, internal: 1, private: 2 };
export type ModelCapabilities = { tools: boolean; structuredOutput: "native-strict" | "native-json-schema" | "validated-post-hoc"; streaming: boolean; reasoningTokens: boolean; cachedTokens: boolean; capabilityDiscovery: "static-review" | "account-model-list" | "free-catalog" };
export type ProviderManifestEntry = {
  id: ProviderId; label: string; protocol: "openai-responses" | "anthropic-messages" | "xai-chat-completions" | "openrouter-free-chat";
  endpoint: string; discoveryEndpoint: string | null; approvedOrigin: string; billing: "paid" | "free";
  credentialEnv: string; modelEnv: string | null; privacyCeiling: PrivacyClass; privateDataAttestationEnv: string | null;
  modelFamily: string; pinnedModel: string | null; capabilities: ModelCapabilities; notes: string;
};
export const MODEL_MANIFEST_VERSION = 1;
export const MODEL_MANIFEST: Readonly<Record<ProviderId, ProviderManifestEntry>> = Object.freeze({
  openai: { id: "openai", label: "OpenAI", protocol: "openai-responses", endpoint: providerEndpoints.openai, discoveryEndpoint: null, approvedOrigin: "OpenAI direct API (United States)", billing: "paid", credentialEnv: "OPENAI_API_KEY", modelEnv: "OPENAI_MODEL", privacyCeiling: "private", privateDataAttestationEnv: "OPENAI_PRIVATE_DATA_APPROVED", modelFamily: modelFamilies.openai.source, pinnedModel: null, capabilities: { tools: true, structuredOutput: "native-strict", streaming: true, reasoningTokens: true, cachedTokens: true, capabilityDiscovery: "static-review" }, notes: "Responses API with store=false. A consumer ChatGPT subscription is not API credit; an API account with billing is required." },
  claude: { id: "claude", label: "Anthropic Claude", protocol: "anthropic-messages", endpoint: providerEndpoints.claude, discoveryEndpoint: null, approvedOrigin: "Anthropic direct API (United States)", billing: "paid", credentialEnv: "CLAUDE_API_KEY", modelEnv: "CLAUDE_MODEL", privacyCeiling: "private", privateDataAttestationEnv: "CLAUDE_PRIVATE_DATA_APPROVED", modelFamily: modelFamilies.claude.source, pinnedModel: null, capabilities: { tools: true, structuredOutput: "validated-post-hoc", streaming: true, reasoningTokens: false, cachedTokens: true, capabilityDiscovery: "static-review" }, notes: "Messages API. Tool use is tool_use/tool_result content blocks, not OpenAI function calls; structured output is validated after generation." },
  grok: { id: "grok", label: "xAI Grok", protocol: "xai-chat-completions", endpoint: providerEndpoints.grok, discoveryEndpoint: "https://api.x.ai/v1/models", approvedOrigin: "xAI direct API (United States)", billing: "paid", credentialEnv: "GROK_API_KEY", modelEnv: "GROK_MODEL", privacyCeiling: "private", privateDataAttestationEnv: "GROK_PRIVATE_DATA_APPROVED", modelFamily: modelFamilies.grok.source, pinnedModel: null, capabilities: { tools: true, structuredOutput: "native-json-schema", streaming: true, reasoningTokens: true, cachedTokens: true, capabilityDiscovery: "account-model-list" }, notes: "Chat completions endpoint. The configured model must appear in the account's model list or the call fails closed." },
  openrouter: { id: "openrouter", label: "Google Gemma via OpenRouter (free)", protocol: "openrouter-free-chat", endpoint: providerEndpoints.openrouter, discoveryEndpoint: "https://openrouter.ai/api/v1/models", approvedOrigin: "Google Gemma open weights, Google AI Studio route only", billing: "free", credentialEnv: "OPENROUTER_API_KEY", modelEnv: null, privacyCeiling: "public", privateDataAttestationEnv: null, modelFamily: modelFamilies.openrouter.source, pinnedModel: "google/gemma-4-31b-it:free", capabilities: { tools: false, structuredOutput: "validated-post-hoc", streaming: false, reasoningTokens: false, cachedTokens: false, capabilityDiscovery: "free-catalog" }, notes: "Pinned free route; public data only; no fallbacks; any reported cost fails closed." },
});

export type ModelPricing = { inputCentsPerMillion: number; outputCentsPerMillion: number; cachedInputCentsPerMillion?: number };
export type ModelBinding = { provider: ProviderId; model: string; endpoint: string; apiKey: string; pricing: ModelPricing; maxOutputTokens: number; billingMode: "free" | "paid"; privacyCeiling: PrivacyClass };

/** Build a binding from the environment. Returns null when the provider is not enabled or lacks a credential. */
export function modelBinding(provider: ProviderId, source: Record<string, string | undefined> = process.env): ModelBinding | null {
  const manifest = MODEL_MANIFEST[provider];
  if (!manifest) return fail("PROVIDER_NOT_ALLOWED", 403);
  const config = providerConfiguration(provider, source);
  if (!config) return null;
  const cached = source[`${provider.toUpperCase()}_CACHED_INPUT_CENTS_PER_MILLION`];
  const cachedRate = cached === undefined ? undefined : Number(cached);
  if (cachedRate !== undefined && (!Number.isFinite(cachedRate) || cachedRate < 0)) return fail("PROVIDER_CONFIGURATION_INVALID", 503);
  const attested = manifest.privateDataAttestationEnv && source[manifest.privateDataAttestationEnv] === "true";
  const ceiling: PrivacyClass = manifest.billing === "free" ? "public" : attested ? "private" : "internal";
  return { provider, model: config.model, endpoint: config.endpoint, apiKey: config.apiKey, pricing: { inputCentsPerMillion: config.inputCentsPerMillion, outputCentsPerMillion: config.outputCentsPerMillion, ...(cachedRate === undefined ? {} : { cachedInputCentsPerMillion: cachedRate }) }, maxOutputTokens: config.maxOutputTokens, billingMode: manifest.billing, privacyCeiling: ceiling };
}

export type CatalogProviderStatus = {
  id: ProviderId; label: string; protocol: string; endpointHost: string; approvedOrigin: string; billing: "paid" | "free";
  credential: { name: string; present: boolean }; enabledFlag: boolean; configuredModel: string | null;
  state: "not_connected" | "disabled" | "configuration_invalid" | "unfunded" | "ready";
  reasons: string[]; privacyCeiling: PrivacyClass; costStatus: "zero_cost_free_route" | "unfunded" | "funded_cap" | "pricing_missing";
  capabilities: ModelCapabilities; notes: string;
};
/** Every provider is listed; a provider without a credential is shown disabled with the exact missing variable name. Never returns secret values. */
export function modelCatalogStatus(source: Record<string, string | undefined> = process.env): CatalogProviderStatus[] {
  const paidAuthorized = source.MODEL_API_ENABLED === "true" && Boolean(source.OWNER_SPEND_AUTHORIZATION_ID) && Number(source.PAID_SPEND_LIMIT_CENTS ?? 0) > 0;
  return providerIds.map(id => {
    const manifest = MODEL_MANIFEST[id];
    const enabledFlag = source[`${id.toUpperCase()}_ENABLED`] === "true", present = Boolean(source[manifest.credentialEnv]);
    const reasons: string[] = [];
    let binding: ModelBinding | null = null, invalid = false;
    try { binding = modelBinding(id, source); if (binding) assertTrustedBinding(binding); } catch (error) { invalid = true; reasons.push(error instanceof OperationError ? error.code : "PROVIDER_CONFIGURATION_INVALID"); binding = null; }
    if (!present) reasons.push(`MISSING_${manifest.credentialEnv}`);
    if (!enabledFlag) reasons.push(`${id.toUpperCase()}_ENABLED_NOT_TRUE`);
    if (manifest.modelEnv && !source[manifest.modelEnv]) reasons.push(`MISSING_${manifest.modelEnv}`);
    const free = manifest.billing === "free";
    if (free && source.FREE_MODEL_API_ENABLED !== "true") reasons.push("FREE_MODEL_API_ENABLED_NOT_TRUE");
    if (!free && !paidAuthorized) reasons.push("OWNER_FUNDED_CAP_NOT_CONFIGURED");
    const pricingMissing = !free && (source[`${id.toUpperCase()}_INPUT_CENTS_PER_MILLION`] === undefined || source[`${id.toUpperCase()}_OUTPUT_CENTS_PER_MILLION`] === undefined);
    const state: CatalogProviderStatus["state"] = invalid ? "configuration_invalid" : !present ? "not_connected" : !enabledFlag || !binding ? "disabled" : free ? (source.FREE_MODEL_API_ENABLED === "true" ? "ready" : "disabled") : paidAuthorized ? "ready" : "unfunded";
    return {
      id, label: manifest.label, protocol: manifest.protocol, endpointHost: new URL(manifest.endpoint).host, approvedOrigin: manifest.approvedOrigin, billing: manifest.billing,
      credential: { name: manifest.credentialEnv, present }, enabledFlag, configuredModel: binding?.model ?? null, state, reasons: [...new Set(reasons)],
      privacyCeiling: binding?.privacyCeiling ?? (free ? "public" : "internal"), costStatus: free ? "zero_cost_free_route" : pricingMissing ? "pricing_missing" : paidAuthorized ? "funded_cap" : "unfunded",
      capabilities: manifest.capabilities, notes: manifest.notes,
    };
  });
}

/* ─────────────────────── DOTS-060 / 061 provenance and endpoints ─────────────────────── */

export type ApprovedRevision = { provider: string; model: string; revision: number; status: "approved" | "retired" | "denied" };
/**
 * Exact provider+model+endpoint binding. Rejects unknown providers, endpoint overrides, disallowed lineage (even when an
 * approved broker or host offers it), host/model mismatches, non-pinned free routes and — when an approved revision list is
 * supplied — any model whose latest immutable revision is not `approved`.
 */
export function assertTrustedBinding(binding: ModelBinding, approved?: readonly ApprovedRevision[]): void {
  const manifest = (MODEL_MANIFEST as Record<string, ProviderManifestEntry | undefined>)[binding.provider];
  if (!manifest) return fail("PROVIDER_NOT_ALLOWED", 403);
  let url: URL;
  try { url = new URL(binding.endpoint); } catch { return fail("PROVIDER_ENDPOINT_NOT_TRUSTED", 403); }
  if (binding.endpoint !== manifest.endpoint || url.protocol !== "https:" || url.username || url.password || url.port) return fail("PROVIDER_ENDPOINT_NOT_TRUSTED", 403);
  if (typeof binding.model !== "string" || !binding.model || binding.model.length > 200 || disallowedModelLineage(binding.model)) return fail("PROVIDER_MODEL_NOT_ALLOWED", 403);
  if (modelFamilyMismatch(binding.provider, binding.model) || !new RegExp(manifest.modelFamily).test(binding.model)) return fail("PROVIDER_MODEL_MISMATCH", 403);
  if (manifest.billing === "free") {
    if (!freeModelId(binding.model) || binding.model !== manifest.pinnedModel || binding.billingMode !== "free" || binding.pricing.inputCentsPerMillion !== 0 || binding.pricing.outputCentsPerMillion !== 0 || (binding.pricing.cachedInputCentsPerMillion ?? 0) !== 0) return fail("FREE_PROVIDER_CONFIGURATION_INVALID", 403);
  } else if (binding.billingMode !== "paid") return fail("PROVIDER_BILLING_MISMATCH", 403);
  if (privacyRank[binding.privacyCeiling] > privacyRank[manifest.privacyCeiling]) return fail("MODEL_PRIVACY_NOT_PERMITTED", 403);
  if (approved) {
    const latest = latestRevision(approved, binding.provider, binding.model);
    if (!latest) return fail("MODEL_NOT_REVIEWED", 403);
    if (latest.status !== "approved") return fail("MODEL_REVISION_NOT_APPROVED", 403);
  }
}
function latestRevision(list: readonly ApprovedRevision[], provider: string, model: string): ApprovedRevision | undefined {
  return list.filter(r => r.provider === provider && r.model === model).sort((a, b) => b.revision - a.revision)[0];
}
/** Fallback policy: never silent, never across billing classes free→paid, never to a third party outside the manifest. */
export function assertFailoverAllowed(from: ModelBinding, to: ModelBinding, options: { allowFailover: boolean; allowPaidFailover?: boolean }): void {
  if (!options.allowFailover) return fail("MODEL_FAILOVER_NOT_CONFIGURED", 403);
  if (from.billingMode === "free" && to.billingMode === "paid") return fail("MODEL_PAID_FALLBACK_FORBIDDEN", 403);
  if (to.billingMode === "paid" && options.allowPaidFailover !== true) return fail("MODEL_PAID_FALLBACK_FORBIDDEN", 403);
  if (privacyRank[to.privacyCeiling] < privacyRank[from.privacyCeiling]) return fail("MODEL_PRIVACY_NOT_PERMITTED", 403);
}

/* ─────────────────────────── DOTS-056 canonical contract ─────────────────────────── */

export type ToolDefinition = { name: string; description: string; parameters: Record<string, unknown> };
export type ToolCall = { id: string; name: string; arguments: Record<string, unknown> };
export type CanonicalMessage = { role: "user"; content: string } | { role: "assistant"; content: string; toolCalls?: ToolCall[] } | { role: "tool"; toolCallId: string; content: string };
export type JsonSchema = { type?: string; properties?: Record<string, JsonSchema>; required?: string[]; items?: JsonSchema; enum?: unknown[]; additionalProperties?: boolean };
export type ModelRequest = {
  system: string; messages: CanonicalMessage[]; tools?: ToolDefinition[]; maxOutputTokens: number; timeoutMs: number;
  responseSchema?: { name: string; schema: JsonSchema }; privacyClass: PrivacyClass; idempotencyKey: string; traceId?: string; stream?: boolean;
};
export type FinishReason = "stop" | "length" | "tool_calls" | "refusal" | "content_filter" | "other";
export type ModelUsage = { inputTokens: number; outputTokens: number; cachedInputTokens: number; reasoningTokens: number; source: "provider_reported" | "missing" };
export type ModelResult = {
  provider: ProviderId; model: string; responseModel: string | null; text: string; toolCalls: ToolCall[]; structured: unknown;
  finishReason: FinishReason; refusal: string | null; usage: ModelUsage; providerRequestId: string | null; wallTimeMs: number;
  costCents: number; costBasis: "provider_reported_usage" | "worst_case_estimate"; streamed: boolean; traceId: string | null; idempotencyKey: string;
};
/** Error raised by adapters. `executed` tells the resilience layer whether the provider may have performed (and billed) the call. */
export class ProviderCallError extends OperationError {
  constructor(code: string, status: number, readonly retryable: boolean, readonly executed: "no" | "unknown" | "yes", readonly retryAfterMs: number | null = null, readonly result: ModelResult | null = null) { super(code, status); this.name = "ProviderCallError"; }
}
const pfail = (code: string, status: number, retryable = false, executed: "no" | "unknown" | "yes" = "no", retryAfterMs: number | null = null, result: ModelResult | null = null): never => { throw new ProviderCallError(code, status, retryable, executed, retryAfterMs, result); };

const toolName = /^[A-Za-z0-9_-]{1,64}$/;
export function validateModelRequest(request: ModelRequest, binding?: ModelBinding): ModelRequest {
  if (!request || typeof request !== "object") return fail("MODEL_REQUEST_INVALID", 400);
  if (typeof request.system !== "string" || request.system.length > 100_000) return fail("MODEL_REQUEST_INVALID", 400);
  if (!Array.isArray(request.messages) || request.messages.length < 1 || request.messages.length > 200) return fail("MODEL_REQUEST_INVALID", 400);
  const declared = new Set<string>();
  for (const tool of request.tools ?? []) {
    if (!toolName.test(tool?.name ?? "") || typeof tool.description !== "string" || !tool.parameters || typeof tool.parameters !== "object" || declared.has(tool.name)) return fail("MODEL_TOOL_DEFINITION_INVALID", 400);
    declared.add(tool.name);
  }
  const callIds = new Set<string>();
  for (const message of request.messages) {
    if (message.role === "user") { if (typeof message.content !== "string" || !message.content) return fail("MODEL_REQUEST_INVALID", 400); }
    else if (message.role === "assistant") {
      if (typeof message.content !== "string") return fail("MODEL_REQUEST_INVALID", 400);
      for (const call of message.toolCalls ?? []) { if (!declared.has(call.name) || typeof call.id !== "string" || !call.id) return fail("MODEL_TOOL_UNDECLARED", 400); callIds.add(call.id); }
    } else if (message.role === "tool") { if (!callIds.has(message.toolCallId) || typeof message.content !== "string") return fail("MODEL_TOOL_RESULT_UNMATCHED", 400); }
    else return fail("MODEL_REQUEST_INVALID", 400);
  }
  if (!Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens < 1 || request.maxOutputTokens > 32_768 || (binding && request.maxOutputTokens > binding.maxOutputTokens)) return fail("MODEL_OUTPUT_LIMIT_INVALID", 400);
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1000 || request.timeoutMs > 120_000) return fail("MODEL_TIMEOUT_INVALID", 400);
  if (!privacyClasses.includes(request.privacyClass)) return fail("MODEL_PRIVACY_CLASS_INVALID", 400);
  text(request.idempotencyKey, "idempotency_key", 200);
  if (request.responseSchema && (!toolName.test(request.responseSchema.name) || typeof request.responseSchema.schema !== "object")) return fail("MODEL_SCHEMA_INVALID", 400);
  if (binding) {
    const manifest = MODEL_MANIFEST[binding.provider];
    if (privacyRank[request.privacyClass] > privacyRank[binding.privacyCeiling]) return fail("MODEL_PRIVACY_NOT_PERMITTED", 403);
    if (declared.size && !manifest.capabilities.tools) return fail("MODEL_CAPABILITY_UNSUPPORTED", 400);
    if (request.stream && !manifest.capabilities.streaming) return fail("MODEL_CAPABILITY_UNSUPPORTED", 400);
  }
  return request;
}
/** Minimal JSON-schema subset validator used for structured output (type/properties/required/items/enum/additionalProperties). */
export function schemaErrors(value: unknown, schema: JsonSchema, path = "$"): string[] {
  const errors: string[] = [];
  const kind = Array.isArray(value) ? "array" : value === null ? "null" : Number.isInteger(value) ? "integer" : typeof value;
  if (schema.type && !(schema.type === kind || (schema.type === "number" && kind === "integer"))) return [`${path}: expected ${schema.type}`];
  if (schema.enum && !schema.enum.some(item => item === value)) errors.push(`${path}: not in enum`);
  if (kind === "object" && value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in record)) errors.push(`${path}.${key}: required`);
    for (const [key, item] of Object.entries(record)) {
      const child = schema.properties?.[key];
      if (child) errors.push(...schemaErrors(item, child, `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${key}: not allowed`);
    }
  }
  if (kind === "array" && schema.items) (value as unknown[]).forEach((item, index) => errors.push(...schemaErrors(item, schema.items!, `${path}[${index}]`)));
  return errors;
}

/** Conservative input-token upper bound: one token per character plus framing per message. */
export function worstCaseInputTokens(request: ModelRequest): number {
  return request.system.length + JSON.stringify(request.messages).length + JSON.stringify(request.tools ?? []).length + JSON.stringify(request.responseSchema ?? {}).length + 32 * (request.messages.length + 1);
}
export function usageCostCents(pricing: ModelPricing, usage: Pick<ModelUsage, "inputTokens" | "outputTokens" | "cachedInputTokens">): number {
  for (const value of [usage.inputTokens, usage.outputTokens, usage.cachedInputTokens]) if (!Number.isSafeInteger(value) || value < 0) return fail("PROVIDER_USAGE_INVALID");
  const cached = Math.min(usage.cachedInputTokens, usage.inputTokens);
  const raw = (usage.inputTokens - cached) * pricing.inputCentsPerMillion + cached * (pricing.cachedInputCentsPerMillion ?? pricing.inputCentsPerMillion) + usage.outputTokens * pricing.outputCentsPerMillion;
  return Math.ceil(raw / 1_000_000 - 1e-9);
}
export function worstCaseCostCents(binding: ModelBinding, request: ModelRequest): number {
  return usageCostCents(binding.pricing, { inputTokens: worstCaseInputTokens(request), outputTokens: request.maxOutputTokens, cachedInputTokens: 0 });
}

/* ─────────────────────── DOTS-057 / 058 / 059 native adapters ─────────────────────── */

type Wire = { url: string; headers: Record<string, string>; body: Record<string, unknown> };
type Normalized = { id: string | null; model: string | null; text: string; toolCalls: Array<{ id: string; name: string; rawArguments: unknown }>; finishReason: FinishReason; refusal: string | null; usage: ModelUsage; reportedCost: unknown };
const n = (value: unknown): number => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0);
const has = (value: unknown) => typeof value === "number";

export function buildProviderRequest(binding: ModelBinding, request: ModelRequest): Wire {
  const stream = request.stream === true;
  if (binding.provider === "openai") {
    const input: unknown[] = [];
    for (const m of request.messages) {
      if (m.role === "user") input.push({ role: "user", content: [{ type: "input_text", text: m.content }] });
      else if (m.role === "assistant") { if (m.content) input.push({ role: "assistant", content: [{ type: "output_text", text: m.content }] }); for (const c of m.toolCalls ?? []) input.push({ type: "function_call", call_id: c.id, name: c.name, arguments: JSON.stringify(c.arguments) }); }
      else input.push({ type: "function_call_output", call_id: m.toolCallId, output: m.content });
    }
    const body: Record<string, unknown> = { model: binding.model, instructions: request.system, input, max_output_tokens: request.maxOutputTokens, store: false, stream };
    if (request.tools?.length) { body.tools = request.tools.map(t => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters, strict: true })); body.parallel_tool_calls = false; }
    if (request.responseSchema) body.text = { format: { type: "json_schema", name: request.responseSchema.name, schema: request.responseSchema.schema, strict: true } };
    return { url: binding.endpoint, headers: { "content-type": "application/json", authorization: `Bearer ${binding.apiKey}` }, body };
  }
  if (binding.provider === "claude") {
    const messages: Array<{ role: "user" | "assistant"; content: unknown[] }> = [];
    const push = (role: "user" | "assistant", block: unknown) => { const last = messages[messages.length - 1]; if (last && last.role === role) last.content.push(block); else messages.push({ role, content: [block] }); };
    for (const m of request.messages) {
      if (m.role === "user") push("user", { type: "text", text: m.content });
      else if (m.role === "assistant") { if (m.content) push("assistant", { type: "text", text: m.content }); for (const c of m.toolCalls ?? []) push("assistant", { type: "tool_use", id: c.id, name: c.name, input: c.arguments }); }
      else push("user", { type: "tool_result", tool_use_id: m.toolCallId, content: m.content });
    }
    const system = request.responseSchema ? `${request.system}\n\nRespond with only a JSON value matching this schema (${request.responseSchema.name}): ${JSON.stringify(request.responseSchema.schema)}` : request.system;
    const body: Record<string, unknown> = { model: binding.model, max_tokens: request.maxOutputTokens, system, messages, stream };
    if (request.tools?.length) body.tools = request.tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    return { url: binding.endpoint, headers: { "content-type": "application/json", "x-api-key": binding.apiKey, "anthropic-version": "2023-06-01" }, body };
  }
  const messages: unknown[] = [{ role: "system", content: request.system }];
  for (const m of request.messages) {
    if (m.role === "user") messages.push({ role: "user", content: m.content });
    else if (m.role === "assistant") messages.push({ role: "assistant", content: m.content || null, ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map(c => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) } : {}) });
    else messages.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
  }
  const body: Record<string, unknown> = { model: binding.model, messages, max_tokens: request.maxOutputTokens, stream };
  if (stream) body.stream_options = { include_usage: true };
  if (request.tools?.length) body.tools = request.tools.map(t => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
  if (request.responseSchema && binding.provider === "grok") body.response_format = { type: "json_schema", json_schema: { name: request.responseSchema.name, schema: request.responseSchema.schema, strict: true } };
  if (binding.provider === "openrouter") { delete body.stream_options; body.provider = { max_price: { prompt: 0, completion: 0, request: 0, image: 0 }, allow_fallbacks: false, only: ["google-ai-studio"], data_collection: "allow" }; }
  return { url: binding.endpoint, headers: { "content-type": "application/json", authorization: `Bearer ${binding.apiKey}` }, body };
}

function normalizeOpenAI(body: any): Normalized {
  const output: any[] = Array.isArray(body?.output) ? body.output : [];
  const texts: string[] = [], toolCalls: Normalized["toolCalls"] = []; let refusal: string | null = null;
  for (const item of output) {
    if (item?.type === "function_call") toolCalls.push({ id: String(item.call_id ?? item.id ?? ""), name: String(item.name ?? ""), rawArguments: item.arguments });
    for (const part of Array.isArray(item?.content) ? item.content : []) { if (part?.type === "output_text" && typeof part.text === "string") texts.push(part.text); if (part?.type === "refusal") refusal = String(part.refusal ?? "Refused"); }
  }
  const incomplete = body?.status === "incomplete" ? body?.incomplete_details?.reason : null;
  const finishReason: FinishReason = refusal ? "refusal" : incomplete === "max_output_tokens" ? "length" : incomplete === "content_filter" ? "content_filter" : incomplete ? "other" : toolCalls.length ? "tool_calls" : "stop";
  const u = body?.usage;
  return { id: body?.id ?? null, model: body?.model ?? null, text: texts.join("\n"), toolCalls, finishReason, refusal, reportedCost: undefined,
    usage: { inputTokens: n(u?.input_tokens), outputTokens: n(u?.output_tokens), cachedInputTokens: n(u?.input_tokens_details?.cached_tokens), reasoningTokens: n(u?.output_tokens_details?.reasoning_tokens), source: has(u?.input_tokens) && has(u?.output_tokens) ? "provider_reported" : "missing" } };
}
function normalizeClaude(body: any): Normalized {
  const content: any[] = Array.isArray(body?.content) ? body.content : [];
  const texts = content.filter(p => p?.type === "text" && typeof p.text === "string").map(p => p.text as string);
  const toolCalls = content.filter(p => p?.type === "tool_use").map(p => ({ id: String(p.id ?? ""), name: String(p.name ?? ""), rawArguments: p.input }));
  const stop = body?.stop_reason;
  const finishReason: FinishReason = stop === "refusal" ? "refusal" : stop === "max_tokens" ? "length" : stop === "tool_use" ? "tool_calls" : stop === "end_turn" || stop === "stop_sequence" ? "stop" : "other";
  const u = body?.usage, cachedRead = n(u?.cache_read_input_tokens), cacheWrite = n(u?.cache_creation_input_tokens);
  return { id: body?.id ?? null, model: body?.model ?? null, text: texts.join("\n"), toolCalls, finishReason, refusal: finishReason === "refusal" ? (texts.join("\n") || "Provider refused the request") : null, reportedCost: undefined,
    // Anthropic reports input_tokens excluding cache reads/writes; canonical inputTokens is the total prompt size.
    usage: { inputTokens: n(u?.input_tokens) + cachedRead + cacheWrite, outputTokens: n(u?.output_tokens), cachedInputTokens: cachedRead, reasoningTokens: 0, source: has(u?.input_tokens) && has(u?.output_tokens) ? "provider_reported" : "missing" } };
}
function normalizeChat(body: any): Normalized {
  const choice = body?.choices?.[0], message = choice?.message ?? {};
  const toolCalls = (Array.isArray(message.tool_calls) ? message.tool_calls : []).map((c: any) => ({ id: String(c?.id ?? ""), name: String(c?.function?.name ?? ""), rawArguments: c?.function?.arguments }));
  const refusal = typeof message.refusal === "string" && message.refusal ? message.refusal : null;
  const reason = choice?.finish_reason;
  const finishReason: FinishReason = refusal ? "refusal" : reason === "length" ? "length" : reason === "tool_calls" || (toolCalls.length && reason !== "content_filter") ? "tool_calls" : reason === "content_filter" ? "content_filter" : reason === "stop" ? "stop" : "other";
  const u = body?.usage;
  return { id: body?.id ?? null, model: body?.model ?? null, text: typeof message.content === "string" ? message.content : "", toolCalls, finishReason, refusal, reportedCost: u?.cost,
    usage: { inputTokens: n(u?.prompt_tokens), outputTokens: n(u?.completion_tokens), cachedInputTokens: n(u?.prompt_tokens_details?.cached_tokens), reasoningTokens: n(u?.completion_tokens_details?.reasoning_tokens), source: has(u?.prompt_tokens) && has(u?.completion_tokens) ? "provider_reported" : "missing" } };
}

/** Parse a server-sent-events body into JSON data payloads (ignores `[DONE]`). */
export function parseServerSentEvents(raw: string): any[] {
  const events: any[] = [];
  for (const block of raw.replace(/\r\n/g, "\n").split("\n\n")) {
    const data = block.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") continue;
    try { events.push(JSON.parse(data)); } catch { return pfail("PROVIDER_STREAM_INVALID", 502, false, "yes"); }
  }
  return events;
}
/** Re-assemble provider-native streamed events into the provider's non-streamed body shape, so one normalizer handles both. */
export function assembleStream(provider: ProviderId, events: any[]): any {
  if (provider === "openai") {
    const done = [...events].reverse().find(e => e?.type === "response.completed" || e?.type === "response.incomplete");
    if (done?.response) return done.response;
    if (events.some(e => e?.type === "response.failed" || e?.type === "error")) return pfail("PROVIDER_REJECTED", 502, false, "unknown");
    const textOut = events.filter(e => e?.type === "response.output_text.delta").map(e => String(e.delta ?? "")).join("");
    return { id: events.find(e => e?.response?.id)?.response?.id ?? null, output: textOut ? [{ type: "message", content: [{ type: "output_text", text: textOut }] }] : [], status: "incomplete", incomplete_details: { reason: "stream_truncated" } };
  }
  if (provider === "claude") {
    const body: any = { id: null, model: null, content: [] as any[], stop_reason: null, usage: {} }; const partial: Record<number, string> = {};
    for (const e of events) {
      if (e?.type === "message_start") { body.id = e.message?.id ?? null; body.model = e.message?.model ?? null; body.usage = { ...(e.message?.usage ?? {}) }; }
      else if (e?.type === "content_block_start") body.content[e.index] = { ...e.content_block, ...(e.content_block?.type === "text" ? { text: e.content_block.text ?? "" } : {}) };
      else if (e?.type === "content_block_delta") { const block = body.content[e.index]; if (!block) continue; if (e.delta?.type === "text_delta") block.text = (block.text ?? "") + e.delta.text; else if (e.delta?.type === "input_json_delta") partial[e.index] = (partial[e.index] ?? "") + e.delta.partial_json; }
      else if (e?.type === "message_delta") { body.stop_reason = e.delta?.stop_reason ?? body.stop_reason; body.usage = { ...body.usage, ...(e.usage ?? {}) }; }
      else if (e?.type === "error") return pfail("PROVIDER_UNAVAILABLE", 503, false, "unknown");
    }
    for (const [index, json] of Object.entries(partial)) { const block = body.content[Number(index)]; if (block) { try { block.input = json ? JSON.parse(json) : {}; } catch { block.input = json; } } }
    body.content = body.content.filter(Boolean);
    return body;
  }
  const message: any = { content: "", tool_calls: [] as any[] }; let finish: string | null = null, usage: any, id: string | null = null, model: string | null = null;
  for (const e of events) {
    id ??= e?.id ?? null; model ??= e?.model ?? null; if (e?.usage) usage = e.usage;
    const choice = e?.choices?.[0]; if (!choice) continue;
    if (typeof choice.delta?.content === "string") message.content += choice.delta.content;
    if (typeof choice.delta?.refusal === "string") message.refusal = (message.refusal ?? "") + choice.delta.refusal;
    for (const c of choice.delta?.tool_calls ?? []) { const slot = message.tool_calls[c.index ?? 0] ??= { id: "", type: "function", function: { name: "", arguments: "" } }; if (c.id) slot.id = c.id; if (c.function?.name) slot.function.name += c.function.name; if (c.function?.arguments) slot.function.arguments += c.function.arguments; }
    if (choice.finish_reason) finish = choice.finish_reason;
  }
  if (!message.tool_calls.length) delete message.tool_calls;
  return { id, model, choices: [{ message, finish_reason: finish }], usage };
}

export type InvokeOptions = { transport?: typeof fetch; signal?: AbortSignal; now?: () => number; approved?: readonly ApprovedRevision[]; skipDiscovery?: boolean };
/** xAI capability detection: the configured model must be listed for this account; disallowed lineages are filtered out even if listed. */
export async function detectGrokModels(binding: ModelBinding, transport: typeof fetch = fetch, signal?: AbortSignal): Promise<string[]> {
  if (binding.provider !== "grok") return fail("PROVIDER_NOT_ALLOWED", 403);
  let response: Response;
  try { response = await transport(MODEL_MANIFEST.grok.discoveryEndpoint!, { headers: { authorization: `Bearer ${binding.apiKey}` }, signal: signal ?? AbortSignal.timeout(10_000), redirect: "error" }); }
  catch { return pfail("PROVIDER_CAPABILITY_DISCOVERY_FAILED", 503, true, "no"); }
  if (response.status === 401 || response.status === 403) return pfail("PROVIDER_CREDENTIAL_REJECTED", 503);
  if (!response.ok) return pfail("PROVIDER_CAPABILITY_DISCOVERY_FAILED", 503, response.status === 429 || response.status >= 500, "no");
  const body = await response.json().catch(() => null) as { data?: Array<{ id?: unknown }> } | null;
  if (!body || !Array.isArray(body.data)) return pfail("PROVIDER_CAPABILITY_DISCOVERY_FAILED", 503);
  return body.data.map(item => String(item?.id ?? "")).filter(id => id && modelFamilies.grok.test(id) && !disallowedModelLineage(id));
}

function retryAfter(response: Response): number | null {
  const value = response.headers.get("retry-after"); if (!value) return null;
  const seconds = Number(value); if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000);
  const date = Date.parse(value); return Number.isFinite(date) ? Math.max(0, Math.min(date - Date.now(), 60_000)) : null;
}

/** Execute one canonical request against one trusted binding. Never falls back, never retries; see `executeModel` for resilience. */
export async function invokeModel(binding: ModelBinding, request: ModelRequest, options: InvokeOptions = {}): Promise<ModelResult> {
  const transport = options.transport ?? fetch, now = options.now ?? Date.now;
  assertTrustedBinding(binding, options.approved);
  validateModelRequest(request, binding);
  if (options.signal?.aborted) return pfail("MODEL_CANCELLED", 499);
  if (!options.skipDiscovery) {
    if (binding.provider === "grok" && !(await detectGrokModels(binding, transport, options.signal)).includes(binding.model)) return pfail("PROVIDER_MODEL_UNAVAILABLE", 503);
    if (binding.provider === "openrouter" && !(await discoverFreeModels(transport)).models.some(m => m.id === binding.model)) return pfail("FREE_MODEL_NOT_AVAILABLE", 503);
  }
  const wire = buildProviderRequest(binding, request);
  const timeout = AbortSignal.timeout(request.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const started = now();
  let response: Response;
  try { response = await transport(wire.url, { method: "POST", headers: wire.headers, body: JSON.stringify(wire.body), signal, redirect: "error" }); }
  catch (error) {
    if (options.signal?.aborted) return pfail("MODEL_CANCELLED", 499, false, "unknown");
    if (timeout.aborted || (error as Error)?.name === "TimeoutError") return pfail("PROVIDER_TIMEOUT", 504, false, "unknown");
    return pfail("PROVIDER_NETWORK_ERROR", 503, false, "unknown");
  }
  if (!response.ok) {
    const s = response.status;
    if (s === 429) return pfail("PROVIDER_RATE_LIMITED", 503, true, "no", retryAfter(response));
    if (s === 408) return pfail("PROVIDER_TIMEOUT", 504, false, "unknown");
    if (s >= 500) return pfail("PROVIDER_UNAVAILABLE", 503, true, "no", retryAfter(response));
    if (s === 401 || s === 403) return pfail("PROVIDER_CREDENTIAL_REJECTED", 503);
    if (s === 404) return pfail("PROVIDER_MODEL_UNAVAILABLE", 503);
    return pfail("PROVIDER_REJECTED", 502);
  }
  let raw: string;
  try { raw = await response.text(); } catch { return pfail(options.signal?.aborted ? "MODEL_CANCELLED" : "PROVIDER_TIMEOUT", options.signal?.aborted ? 499 : 504, false, "unknown"); }
  const streamed = request.stream === true || (response.headers.get("content-type") ?? "").includes("text/event-stream");
  let body: any;
  if (streamed) body = assembleStream(binding.provider, parseServerSentEvents(raw));
  else { try { body = JSON.parse(raw); } catch { return pfail("PROVIDER_RESPONSE_INVALID", 502, false, "yes"); } }
  const normalized = binding.provider === "openai" ? normalizeOpenAI(body) : binding.provider === "claude" ? normalizeClaude(body) : normalizeChat(body);
  const wallTimeMs = Math.max(0, Math.round(now() - started));
  const usageKnown = normalized.usage.source === "provider_reported";
  const costCents = usageKnown ? usageCostCents(binding.pricing, normalized.usage) : worstCaseCostCents(binding, request);
  const result: ModelResult = { provider: binding.provider, model: binding.model, responseModel: normalized.model, text: normalized.text, toolCalls: [], structured: undefined, finishReason: normalized.finishReason, refusal: normalized.refusal, usage: normalized.usage, providerRequestId: normalized.id, wallTimeMs, costCents, costBasis: usageKnown ? "provider_reported_usage" : "worst_case_estimate", streamed, traceId: request.traceId ?? null, idempotencyKey: request.idempotencyKey };
  const after = (code: string, status = 502): never => pfail(code, status, false, "yes", null, result);
  if (binding.billingMode === "free" && normalized.reportedCost !== undefined && normalized.reportedCost !== 0 && normalized.reportedCost !== "0") return after("FREE_PROVIDER_UNEXPECTED_COST", 409);
  // DOTS-061: no silent model substitution. Dated snapshots of the requested alias are accepted.
  if (normalized.model && normalized.model !== binding.model && !normalized.model.startsWith(`${binding.model}-`) && !(binding.provider === "openrouter" && normalized.model === binding.model.replace(/:free$/, ""))) return after("PROVIDER_MODEL_SUBSTITUTED", 409);
  if (normalized.model && disallowedModelLineage(normalized.model)) return after("PROVIDER_MODEL_NOT_ALLOWED", 403);
  const declared = new Map((request.tools ?? []).map(t => [t.name, t]));
  for (const call of normalized.toolCalls) {
    if (!declared.has(call.name) || !call.id) return after("MODEL_TOOL_UNDECLARED");
    let args: unknown = call.rawArguments;
    if (typeof args === "string") { try { args = args ? JSON.parse(args) : {}; } catch { return after("MODEL_TOOL_ARGUMENTS_INVALID"); } }
    if (!args || typeof args !== "object" || Array.isArray(args)) return after("MODEL_TOOL_ARGUMENTS_INVALID");
    if (schemaErrors(args, declared.get(call.name)!.parameters as JsonSchema).length) return after("MODEL_TOOL_ARGUMENTS_INVALID");
    result.toolCalls.push({ id: call.id, name: call.name, arguments: args as Record<string, unknown> });
  }
  if (result.text.length > 100_000) return after("PROVIDER_RESPONSE_INVALID");
  if (!result.text.trim() && !result.toolCalls.length && result.finishReason !== "refusal") return after("PROVIDER_RESPONSE_EMPTY");
  if (request.responseSchema && result.finishReason === "stop") {
    let parsed: unknown;
    try { parsed = JSON.parse(result.text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "")); } catch { return after("MODEL_SCHEMA_VIOLATION", 422); }
    if (schemaErrors(parsed, request.responseSchema.schema).length) return after("MODEL_SCHEMA_VIOLATION", 422);
    result.structured = parsed;
  }
  return result;
}

/* ─────────────────────────── DOTS-062 output isolation ─────────────────────────── */

export type OutputClassification = { contentType: "text/plain" | "text/markdown" | "application/json" | "text/html" | "application/x-executable-script" | "application/octet-stream"; executable: boolean; disposition: "publishable" | "quarantined"; findings: string[]; contentHash: string };
const outputRules: Array<[RegExp, string]> = [
  [/<script\b/i, "html_script_tag"], [/\bon[a-z]{3,20}\s*=\s*["']?[^"'>]/i, "html_event_handler"], [/javascript\s*:/i, "javascript_url"], [/<(?:iframe|object|embed|form|meta\s+http-equiv)\b/i, "active_html_element"],
  [/^#!\s*\//m, "shebang"], [/<\?php/i, "php_code"], [/```\s*(?:bash|sh|zsh|shell|powershell|ps1|pwsh|cmd|bat|python|py|javascript|js|typescript|ts|node|ruby|perl|php|sql|go|rust|c|cpp|java|csharp|vbscript|applescript)\b/i, "fenced_executable_code"],
  [/\b(?:curl|wget|iwr|Invoke-WebRequest)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/i, "pipe_to_shell"], [/\brm\s+-[a-z]*r[a-z]*f?\s+\/?/i, "destructive_shell_command"], [/\b(?:eval|exec|Function)\s*\(/, "dynamic_code_evaluation"],
  [/\b(?:powershell|cmd\.exe)\b.*(?:-enc|-encodedcommand|\/c)\b/i, "shell_invocation"], [/data:(?:text\/html|application\/(?:javascript|x-sh))/i, "executable_data_uri"],
];
const isJson = (value: string) => { try { JSON.parse(value); return true; } catch { return false; } };
/** Classify generated output by content type and trust. Executable, scripted or active-HTML output is quarantined. */
export function classifyGeneratedOutput(content: string): OutputClassification {
  if (typeof content !== "string") return fail("OUTPUT_INVALID", 400);
  const findings = outputRules.filter(([pattern]) => pattern.test(content)).map(([, name]) => name);
  if (/^(?:MZ|\x7fELF|\xca\xfe\xba\xbe|PK\x03\x04)/.test(content) || /[\x00-\x08\x0e-\x1f]/.test(content)) findings.push("binary_or_control_bytes");
  let contentType: OutputClassification["contentType"] = "text/plain";
  const trimmed = content.trim();
  if (findings.includes("binary_or_control_bytes")) contentType = "application/octet-stream";
  else if (findings.some(f => ["shebang", "php_code", "pipe_to_shell", "destructive_shell_command", "shell_invocation"].includes(f))) contentType = "application/x-executable-script";
  else if (/^<!doctype\s+html/i.test(trimmed) || /<\/?(?:html|head|body|div|p|span|script|a|table|img|iframe|svg|style|link|object|embed|form|input|button|meta|base)\b[^>]*>/i.test(trimmed)) contentType = "text/html";
  else if (/^[[{]/.test(trimmed) && isJson(trimmed)) contentType = "application/json";
  else if (/^#{1,6}\s|\n[-*]\s|```|\[[^\]]+\]\([^)]+\)/.test(content)) contentType = "text/markdown";
  const executable = findings.length > 0 || contentType === "text/html";
  if (contentType === "text/html" && !findings.length) findings.push("html_markup");
  return { contentType, executable, disposition: executable ? "quarantined" : "publishable", findings, contentHash: digest(content) };
}

/* ─────────────────── DOTS-063 opt-in checkpoint installer (dry-run only) ─────────────────── */

export type CheckpointSpec = { name: string; repository: string; revision: string; license: string; lineage: string; files: Array<{ path: string; bytes: number; sha256: string }> };
export const approvedCheckpointLicenses = ["apache-2.0", "mit", "gemma"] as const;
/**
 * Dry-run plan for an approved open-weight checkpoint. Reports weight volume and estimated monthly storage/egress cost.
 * The application has no download code path: even with every approval flag present this only returns an authorized
 * plan for an operator runbook (docs/MODEL_PROVIDERS.md). Without funding and storage approval, `downloadPermitted` is false.
 */
export function planCheckpointInstall(spec: CheckpointSpec, source: Record<string, string | undefined> = process.env) {
  const blockers: string[] = [];
  if (!spec || typeof spec !== "object") return fail("CHECKPOINT_SPEC_INVALID", 400);
  text(spec.name, "checkpoint_name", 200);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(spec.repository ?? "")) return fail("CHECKPOINT_SPEC_INVALID", 400);
  if (disallowedModelLineage(`${spec.repository} ${spec.lineage} ${spec.name}`)) return fail("PROVIDER_MODEL_NOT_ALLOWED", 403);
  if (!/^google\/gemma-/i.test(spec.repository)) blockers.push("CHECKPOINT_LINEAGE_NOT_REVIEWED");
  if (!/^[0-9a-f]{40}$/.test(spec.revision ?? "")) blockers.push("CHECKPOINT_REVISION_NOT_PINNED");
  if (!(approvedCheckpointLicenses as readonly string[]).includes(String(spec.license).toLowerCase())) blockers.push("CHECKPOINT_LICENSE_NOT_APPROVED");
  if (!Array.isArray(spec.files) || !spec.files.length || spec.files.length > 500) return fail("CHECKPOINT_SPEC_INVALID", 400);
  let totalBytes = 0;
  for (const file of spec.files) {
    if (!/^[A-Za-z0-9_./-]{1,200}$/.test(file.path ?? "") || file.path.includes("..") || !Number.isSafeInteger(file.bytes) || file.bytes <= 0) return fail("CHECKPOINT_SPEC_INVALID", 400);
    if (!/^[0-9a-f]{64}$/.test(file.sha256 ?? "")) blockers.push(`CHECKPOINT_FILE_HASH_MISSING:${file.path}`);
    if (/\.(?:bin|pt|pth|pkl|pickle|ckpt)$/i.test(file.path)) blockers.push(`CHECKPOINT_UNSAFE_SERIALIZATION:${file.path}`);
    totalBytes += file.bytes;
  }
  const gib = totalBytes / 1024 ** 3;
  const storageRate = Number(source.CHECKPOINT_STORAGE_CENTS_PER_GB_MONTH ?? NaN), egressRate = Number(source.CHECKPOINT_EGRESS_CENTS_PER_GB ?? NaN);
  const pricingKnown = Number.isFinite(storageRate) && storageRate >= 0 && Number.isFinite(egressRate) && egressRate >= 0;
  if (!pricingKnown) blockers.push("CHECKPOINT_STORAGE_PRICING_NOT_CONFIGURED");
  const monthlyStorageCents = pricingKnown ? Math.ceil(gib * storageRate) : null, downloadEgressCents = pricingKnown ? Math.ceil(gib * egressRate) : null;
  const capCents = Number(source.CHECKPOINT_SPEND_CAP_CENTS ?? 0);
  if (source.CHECKPOINT_INSTALL_ENABLED !== "true") blockers.push("CHECKPOINT_INSTALL_ENABLED_NOT_TRUE");
  if (!source.CHECKPOINT_FUNDING_AUTHORIZATION_ID) blockers.push("CHECKPOINT_FUNDING_NOT_AUTHORIZED");
  if (!source.CHECKPOINT_STORAGE_APPROVAL_ID) blockers.push("CHECKPOINT_STORAGE_NOT_APPROVED");
  if (!Number.isSafeInteger(capCents) || capCents <= 0) blockers.push("CHECKPOINT_SPEND_CAP_NOT_SET");
  else if (pricingKnown && (monthlyStorageCents! + downloadEgressCents!) > capCents) blockers.push("CHECKPOINT_COST_EXCEEDS_CAP");
  return { dryRun: true as const, name: spec.name, repository: spec.repository, revision: spec.revision, license: spec.license, fileCount: spec.files.length, totalBytes, totalGiB: Math.round(gib * 100) / 100, monthlyStorageCents, downloadEgressCents, blockers: [...new Set(blockers)], downloadPermitted: blockers.length === 0, downloadPerformed: false as const, note: "Dry run only. The application never downloads weights; an approved operator follows the runbook with the verified revision and hashes." };
}

/* ───────────────────────── DOTS-064 budget/privacy-aware router ───────────────────────── */

export type TaskClass = "research" | "draft" | "classification" | "tool_use" | "structured_extraction";
export const taskClasses: readonly TaskClass[] = ["research", "draft", "classification", "tool_use", "structured_extraction"];
export type BreakerState = { state: "closed" | "open" | "half_open"; consecutiveFailures: number; openedCount: number; retryAt: number | null };
export type RouteCandidate = { provider: ProviderId; binding: ModelBinding | null; configurationError?: string; revisionStatus: ApprovedRevision["status"] | null; executionAuthorized: boolean; weight: number; breaker: BreakerState; budgetRemainingCents: number };
export type RouteDecision = { selected: RouteCandidate | null; failover: RouteCandidate[]; considered: Array<{ provider: ProviderId; model: string | null; eligible: boolean; reason: string | null; estimateCents: number | null }> };
export function routeModel(input: { taskClass: TaskClass; request: ModelRequest; candidates: RouteCandidate[]; now: number; seed: string }): RouteDecision {
  selection(input.taskClass, taskClasses, "task_class");
  const needsTools = input.taskClass === "tool_use" || Boolean(input.request.tools?.length);
  const considered: RouteDecision["considered"] = [], eligible: RouteCandidate[] = [];
  for (const candidate of input.candidates) {
    const manifest = MODEL_MANIFEST[candidate.provider];
    let reason: string | null = null, estimate: number | null = null;
    if (!manifest) reason = "PROVIDER_NOT_ALLOWED";
    else if (candidate.configurationError) reason = candidate.configurationError;
    else if (!candidate.binding) reason = "NOT_CONFIGURED";
    else if (!candidate.executionAuthorized) reason = "EXECUTION_NOT_AUTHORIZED";
    else if (candidate.revisionStatus === null) reason = "MODEL_NOT_REVIEWED";
    else if (candidate.revisionStatus !== "approved") reason = "MODEL_REVISION_NOT_APPROVED";
    else if (candidate.weight <= 0) reason = "DISABLED_BY_ROUTING_WEIGHT";
    else if (privacyRank[input.request.privacyClass] > privacyRank[candidate.binding.privacyCeiling]) reason = "PRIVACY_NOT_PERMITTED";
    else if (needsTools && !manifest.capabilities.tools) reason = "CAPABILITY_MISSING_TOOLS";
    else if (input.request.stream && !manifest.capabilities.streaming) reason = "CAPABILITY_MISSING_STREAMING";
    else if (candidate.breaker.state === "open" && (candidate.breaker.retryAt ?? Infinity) > input.now) reason = "CIRCUIT_OPEN";
    else {
      try { assertTrustedBinding(candidate.binding); } catch (error) { reason = error instanceof OperationError ? error.code : "PROVIDER_NOT_TRUSTED"; }
      if (!reason) {
        estimate = worstCaseCostCents(candidate.binding, input.request);
        if (candidate.binding.billingMode === "paid" && candidate.budgetRemainingCents <= 0) reason = "BUDGET_ZERO";
        else if (estimate > candidate.budgetRemainingCents) reason = "BUDGET_INSUFFICIENT";
        else if (candidate.binding.billingMode === "paid" && input.request.maxOutputTokens > candidate.binding.maxOutputTokens) reason = "OUTPUT_LIMIT_EXCEEDS_CONFIGURATION";
      }
    }
    considered.push({ provider: candidate.provider, model: candidate.binding?.model ?? null, eligible: !reason, reason, estimateCents: estimate });
    if (!reason) eligible.push(candidate);
  }
  if (!eligible.length) return { selected: null, failover: [], considered };
  const total = eligible.reduce((sum, c) => sum + c.weight, 0);
  let point = parseInt(digest(input.seed).slice(0, 12), 16) % total;
  const ordered = [...eligible].sort((a, b) => b.weight - a.weight || a.provider.localeCompare(b.provider));
  let selected = ordered[0]!;
  for (const c of ordered) { if (point < c.weight) { selected = c; break; } point -= c.weight; }
  const failover = ordered.filter(c => c !== selected && !(selected.binding!.billingMode === "free" && c.binding!.billingMode === "paid"));
  return { selected, failover, considered };
}

/* ───────────────────────── DOTS-065 retries and circuit breaker ───────────────────────── */

export const breakerDefaults = { failureThreshold: 3, cooldownMs: 30_000, maxCooldownMs: 15 * 60_000 };
export function providerBackoffDelayMs(attempt: number, random: () => number = Math.random, baseMs = 500, maxMs = 8_000, retryAfterMs: number | null = null): number {
  if (!Number.isSafeInteger(attempt) || attempt < 0) return fail("INVALID_ATTEMPT", 400);
  const ceiling = Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 20));
  const jitter = Math.min(1, Math.max(0, random()));
  const delay = Math.round(ceiling / 2 + (ceiling / 2) * jitter);
  return Math.min(maxMs, Math.max(delay, retryAfterMs ?? 0));
}
export function nextBreakerState(state: BreakerState, outcome: "success" | "failure", now: number, config = breakerDefaults): BreakerState {
  if (outcome === "success") return { state: "closed", consecutiveFailures: 0, openedCount: 0, retryAt: null };
  const failures = state.consecutiveFailures + 1;
  if (state.state === "half_open" || failures >= config.failureThreshold) {
    const cooldown = Math.min(config.maxCooldownMs, config.cooldownMs * 2 ** Math.min(state.openedCount, 10));
    return { state: "open", consecutiveFailures: failures, openedCount: state.openedCount + 1, retryAt: now + cooldown };
  }
  return { ...state, state: "closed", consecutiveFailures: failures };
}
const closedBreaker = (): BreakerState => ({ state: "closed", consecutiveFailures: 0, openedCount: 0, retryAt: null });

/* ─────────────────────────── DOTS-068 benchmark harness ─────────────────────────── */

export type ScriptedReply = { text?: string; toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>; finish?: FinishReason; usage?: { input: number; output: number; cached?: number; reasoning?: number } | null; latencyMs: number; status?: number; model?: string };
/** Render a canonical scripted reply as the provider's native payload so the benchmark exercises the real adapter mappings. */
export function providerStubBody(provider: ProviderId, model: string, reply: ScriptedReply): Record<string, unknown> {
  const u = reply.usage, finish = reply.finish ?? (reply.toolCalls?.length ? "tool_calls" : "stop"), id = `stub-${provider}-${digest(reply).slice(0, 8)}`;
  if (provider === "openai") return { id, model: reply.model ?? model, status: finish === "length" ? "incomplete" : "completed", ...(finish === "length" ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
    output: [...(reply.text || finish === "refusal" ? [{ type: "message", content: [finish === "refusal" ? { type: "refusal", refusal: reply.text ?? "Refused" } : { type: "output_text", text: reply.text }] }] : []), ...(reply.toolCalls ?? []).map(c => ({ type: "function_call", call_id: c.id, name: c.name, arguments: JSON.stringify(c.arguments) }))],
    ...(u ? { usage: { input_tokens: u.input, output_tokens: u.output, input_tokens_details: { cached_tokens: u.cached ?? 0 }, output_tokens_details: { reasoning_tokens: u.reasoning ?? 0 } } } : {}) };
  if (provider === "claude") return { id, model: reply.model ?? model, stop_reason: { stop: "end_turn", length: "max_tokens", tool_calls: "tool_use", refusal: "refusal", content_filter: "refusal", other: "pause_turn" }[finish],
    content: [...(reply.text ? [{ type: "text", text: reply.text }] : []), ...(reply.toolCalls ?? []).map(c => ({ type: "tool_use", id: c.id, name: c.name, input: c.arguments }))],
    ...(u ? { usage: { input_tokens: u.input - (u.cached ?? 0), output_tokens: u.output, cache_read_input_tokens: u.cached ?? 0, cache_creation_input_tokens: 0 } } : {}) };
  return { id, model: reply.model ?? model, choices: [{ message: { content: finish === "refusal" ? null : reply.text ?? null, ...(finish === "refusal" ? { refusal: reply.text ?? "Refused" } : {}), ...(reply.toolCalls?.length ? { tool_calls: reply.toolCalls.map(c => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) } : {}) }, finish_reason: finish === "refusal" ? "stop" : finish }],
    ...(u ? { usage: { prompt_tokens: u.input, completion_tokens: u.output, prompt_tokens_details: { cached_tokens: u.cached ?? 0 }, completion_tokens_details: { reasoning_tokens: u.reasoning ?? 0 }, ...(provider === "openrouter" ? { cost: 0 } : {}) } } : {}) };
}
export type BenchmarkCase = { id: string; category: "quality" | "safety" | "tool" | "compliance" | "latency"; request: Omit<ModelRequest, "idempotencyKey">; reply: ScriptedReply; expect: { contains?: string[]; notContains?: string[]; toolName?: string; finishReason?: FinishReason; errorCode?: string; maxLatencyMs?: number; quarantined?: boolean } };
const sys = "Draft only from approved facts. Never send messages or approve actions.";
export const BENCHMARK_CASES: readonly BenchmarkCase[] = [
  { id: "quality-grounded-draft", category: "quality", request: { system: sys, messages: [{ role: "user", content: "Draft a two-sentence intro using [fact:F1]." }], maxOutputTokens: 200, timeoutMs: 10_000, privacyClass: "public" }, reply: { text: "Synthetic Product helps teams plan. See [fact:F1].", usage: { input: 40, output: 20 }, latencyMs: 900 }, expect: { contains: ["[fact:F1]"], finishReason: "stop" } },
  { id: "safety-refusal", category: "safety", request: { system: sys, messages: [{ role: "user", content: "Invent a customer testimonial." }], maxOutputTokens: 100, timeoutMs: 10_000, privacyClass: "public" }, reply: { text: "I can't fabricate testimonials.", finish: "refusal", usage: { input: 30, output: 8 }, latencyMs: 400 }, expect: { finishReason: "refusal" } },
  { id: "tool-crm-lookup", category: "tool", request: { system: sys, messages: [{ role: "user", content: "Look up the synthetic account stage." }], tools: [{ name: "lookup_account", description: "Read a synthetic CRM account", parameters: { type: "object", properties: { accountId: { type: "string" } }, required: ["accountId"], additionalProperties: false } }], maxOutputTokens: 100, timeoutMs: 10_000, privacyClass: "internal" }, reply: { toolCalls: [{ id: "call_1", name: "lookup_account", arguments: { accountId: "synthetic-1" } }], usage: { input: 60, output: 12, cached: 20 }, latencyMs: 700 }, expect: { toolName: "lookup_account", finishReason: "tool_calls" } },
  { id: "compliance-no-executable-output", category: "compliance", request: { system: sys, messages: [{ role: "user", content: "Write the follow-up email." }], maxOutputTokens: 200, timeoutMs: 10_000, privacyClass: "public" }, reply: { text: "Hello! <script>fetch('https://example.invalid')</script>", usage: { input: 30, output: 20 }, latencyMs: 500 }, expect: { quarantined: true } },
  { id: "compliance-model-substitution", category: "compliance", request: { system: sys, messages: [{ role: "user", content: "Summarize the synthetic brief." }], maxOutputTokens: 100, timeoutMs: 10_000, privacyClass: "public" }, reply: { text: "Summary.", usage: { input: 20, output: 4 }, latencyMs: 300, model: "substituted-model" }, expect: { errorCode: "PROVIDER_MODEL_SUBSTITUTED" } },
  { id: "latency-budget", category: "latency", request: { system: sys, messages: [{ role: "user", content: "One-line status." }], maxOutputTokens: 50, timeoutMs: 10_000, privacyClass: "public" }, reply: { text: "Queue is idle.", usage: { input: 15, output: 5 }, latencyMs: 1_200 }, expect: { maxLatencyMs: 2_000 } },
];
/**
 * Deterministic adapter benchmark: every case is replayed through the real adapter against a stub transport and a
 * virtual clock. Results are labelled as fixture evidence; no live performance or price claims are produced.
 */
export async function runAdapterBenchmark(bindings: ModelBinding[], cases: readonly BenchmarkCase[] = BENCHMARK_CASES) {
  const results: Array<{ provider: ProviderId; model: string; caseId: string; category: BenchmarkCase["category"]; status: "passed" | "failed" | "not_applicable"; detail: string; simulatedLatencyMs: number; fixtureCostCents: number }> = [];
  for (const binding of bindings) {
    for (const item of cases) {
      let clock = 0, calls = 0;
      const transport = (async (url: string) => {
        calls++;
        if (url === MODEL_MANIFEST.grok.discoveryEndpoint) return Response.json({ data: [{ id: binding.model }] });
        clock += item.reply.latencyMs;
        return Response.json(providerStubBody(binding.provider, binding.model, item.reply), { status: item.reply.status ?? 200 });
      }) as unknown as typeof fetch;
      let passed = true, applicable = true, detail = "ok", latency = 0, cost = 0;
      try {
        const result = await invokeModel(binding, { ...item.request, idempotencyKey: `bench:${item.id}` }, { transport, now: () => clock, skipDiscovery: binding.provider === "openrouter" });
        latency = result.wallTimeMs; cost = result.costCents;
        const output = classifyGeneratedOutput(result.text);
        const checks: Array<[boolean, string]> = [
          [!item.expect.errorCode, `expected ${item.expect.errorCode}`],
          [(item.expect.contains ?? []).every(s => result.text.includes(s)), "missing expected text"],
          [(item.expect.notContains ?? []).every(s => !result.text.includes(s)), "contains forbidden text"],
          [!item.expect.toolName || result.toolCalls[0]?.name === item.expect.toolName, "tool call not normalized"],
          [!item.expect.finishReason || result.finishReason === item.expect.finishReason, `finish ${result.finishReason}`],
          [item.expect.quarantined === undefined || (output.disposition === "quarantined") === item.expect.quarantined, "output isolation mismatch"],
          [!item.expect.maxLatencyMs || result.wallTimeMs <= item.expect.maxLatencyMs, `latency ${result.wallTimeMs}ms over budget`],
        ];
        const failed = checks.find(([ok]) => !ok); if (failed) { passed = false; detail = failed[1]; }
      } catch (error) {
        const code = error instanceof OperationError ? error.code : "UNEXPECTED_ERROR";
        if (code === "MODEL_CAPABILITY_UNSUPPORTED" || code === "MODEL_PRIVACY_NOT_PERMITTED") { applicable = false; detail = `not applicable: ${code}`; }
        else { passed = item.expect.errorCode === code; detail = passed ? `failed closed: ${code}` : code; }
      }
      if (calls > 2) { passed = false; detail = "unexpected extra transport calls"; }
      results.push({ provider: binding.provider, model: binding.model, caseId: item.id, category: item.category, status: !applicable ? "not_applicable" : passed ? "passed" : "failed", detail, simulatedLatencyMs: latency, fixtureCostCents: cost });
    }
  }
  const summary = bindings.map(b => { const mine = results.filter(r => r.provider === b.provider); return { provider: b.provider, model: b.model, passed: mine.filter(r => r.status === "passed").length, failed: mine.filter(r => r.status === "failed").length, notApplicable: mine.filter(r => r.status === "not_applicable").length, total: mine.length }; });
  return { evidenceKind: "stub-fixture" as const, liveEvidence: false as const, realChargesCents: 0, caseCount: cases.length, results, summary, note: "Deterministic fixture replay through the real adapters. Latency is the scripted virtual clock, not a live measurement." };
}

/** Bindings the benchmark replays: configured models when present, otherwise clearly-labelled fixture bindings. No credential is ever sent (stub transport). */
export function benchmarkBindings(source: Record<string, string | undefined> = process.env): ModelBinding[] {
  const fixtures: Record<ProviderId, string> = { openai: "gpt-benchmark-fixture", claude: "claude-benchmark-fixture", grok: "grok-benchmark-fixture", openrouter: MODEL_MANIFEST.openrouter.pinnedModel! };
  return providerIds.map(provider => {
    let configured: ModelBinding | null = null;
    try { configured = modelBinding(provider, source); } catch { configured = null; }
    const model = configured?.model ?? fixtures[provider], manifest = MODEL_MANIFEST[provider];
    return { provider, model, endpoint: manifest.endpoint, apiKey: "fixture-not-a-credential", pricing: configured?.pricing ?? { inputCentsPerMillion: 0, outputCentsPerMillion: 0 }, maxOutputTokens: 4096, billingMode: manifest.billing, privacyCeiling: manifest.billing === "free" ? "public" : "private" };
  });
}

/* ─────────────────────── DOTS-069 opt-in live smoke gate ─────────────────────── */

export const SMOKE_REQUEST: Readonly<Omit<ModelRequest, "idempotencyKey">> = Object.freeze({ system: "You are a connectivity check. Reply with the single word READY.", messages: [{ role: "user" as const, content: "Smoke check" }], maxOutputTokens: 16, timeoutMs: 20_000, privacyClass: "public" });
/** Decide, without any network I/O, whether a live smoke run is allowed and which providers it may exercise. */
export function planModelSmoke(source: Record<string, string | undefined> = process.env) {
  const blockers: string[] = [];
  if (source.MODEL_SMOKE_ENABLED !== "true") blockers.push("MODEL_SMOKE_ENABLED_NOT_TRUE");
  const requested = (source.MODEL_SMOKE_PROVIDERS ?? "").split(",").map(v => v.trim()).filter(Boolean);
  if (!requested.length) blockers.push("MODEL_SMOKE_PROVIDERS_NOT_SET");
  const cap = Number(source.MODEL_SMOKE_CAP_CENTS ?? 0), hard = Number(source.PAID_SPEND_LIMIT_CENTS ?? 0);
  if (!Number.isSafeInteger(cap) || cap <= 0) blockers.push("MODEL_SMOKE_CAP_CENTS_NOT_SET");
  const providers = requested.map(name => {
    const own: string[] = [];
    if (!(providerIds as string[]).includes(name)) return { provider: name, model: null as string | null, estimateCents: null as number | null, blockers: ["PROVIDER_NOT_ALLOWED"] };
    const id = name as ProviderId, manifest = MODEL_MANIFEST[id];
    let binding: ModelBinding | null = null;
    try { binding = modelBinding(id, source); if (binding) assertTrustedBinding(binding); } catch (error) { own.push(error instanceof OperationError ? error.code : "PROVIDER_CONFIGURATION_INVALID"); binding = null; }
    if (!source[manifest.credentialEnv]) own.push(`MISSING_${manifest.credentialEnv}`);
    if (source[`${id.toUpperCase()}_ENABLED`] !== "true") own.push(`${id.toUpperCase()}_ENABLED_NOT_TRUE`);
    if (manifest.modelEnv && !source[manifest.modelEnv]) own.push(`MISSING_${manifest.modelEnv}`);
    if (manifest.billing === "paid") {
      if (!paidExecutionAuthorized(source)) own.push("OWNER_FUNDED_CAP_NOT_CONFIGURED");
      if (Number.isSafeInteger(cap) && cap > hard) own.push("MODEL_SMOKE_CAP_EXCEEDS_PAID_SPEND_LIMIT");
    } else if (source.FREE_MODEL_API_ENABLED !== "true") own.push("FREE_MODEL_API_ENABLED_NOT_TRUE");
    const estimate = binding ? worstCaseCostCents(binding, { ...SMOKE_REQUEST, idempotencyKey: "smoke-plan" } as ModelRequest) : null;
    if (estimate !== null && Number.isSafeInteger(cap) && estimate > cap) own.push("MODEL_SMOKE_COST_EXCEEDS_CAP");
    return { provider: id, model: binding?.model ?? null, estimateCents: estimate, blockers: [...new Set(own)] };
  });
  const totalEstimate = providers.reduce((sum, p) => sum + (p.estimateCents ?? 0), 0);
  if (Number.isSafeInteger(cap) && cap > 0 && totalEstimate > cap) blockers.push("MODEL_SMOKE_TOTAL_ESTIMATE_EXCEEDS_CAP");
  const ready = !blockers.length && providers.length > 0 && providers.every(p => !p.blockers.length);
  return { ready, blockers, providers, capCents: Number.isSafeInteger(cap) ? cap : 0, worstCaseTotalCents: totalEstimate };
}
/** Run the bounded live smoke only when the plan is ready. Every outcome is reported; success is never assumed. */
export async function runModelSmoke(source: Record<string, string | undefined> = process.env, transport: typeof fetch = fetch, now: () => number = Date.now) {
  const plan = planModelSmoke(source);
  if (!plan.ready) return { status: "blocked" as const, networkCalls: false, plan, receipts: [] as unknown[] };
  const day = new Date(now()).toISOString().slice(0, 10), receipts: Array<Record<string, unknown>> = [];
  let spent = 0;
  for (const entry of plan.providers) {
    const binding = modelBinding(entry.provider as ProviderId, source)!;
    if (spent + (entry.estimateCents ?? 0) > plan.capCents) { receipts.push({ provider: entry.provider, passed: false, blocker: "MODEL_SMOKE_CAP_REACHED" }); continue; }
    try {
      const result = await invokeModel(binding, { ...SMOKE_REQUEST, idempotencyKey: `smoke:${entry.provider}:${day}` } as ModelRequest, { transport, now });
      spent += result.costCents;
      receipts.push({ provider: entry.provider, model: binding.model, responseModel: result.responseModel, providerRequestId: result.providerRequestId, usage: result.usage, costCents: result.costCents, costBasis: result.costBasis, wallTimeMs: result.wallTimeMs, outputDigest: digest(result.text), passed: /\bREADY\b/i.test(result.text) });
    } catch (error) {
      if (error instanceof ProviderCallError && error.result) spent += error.result.costCents;
      receipts.push({ provider: entry.provider, model: binding.model, passed: false, blocker: error instanceof OperationError ? error.code : "PROVIDER_NETWORK_ERROR" });
    }
  }
  return { status: receipts.every(r => r.passed === true) ? "passed" as const : "failed" as const, networkCalls: true, plan, receipts, spentCents: spent, reproducibility: { request: SMOKE_REQUEST, requestDigest: digest(SMOKE_REQUEST) } };
}

/* ─────────────────── persistence: revisions, pricing, weights, breakers, usage ─────────────────── */

type ExecutionEnv = Record<string, string | undefined>;
function paidExecutionAuthorized(env: ExecutionEnv) { return env.MODEL_API_ENABLED === "true" && Boolean(env.OWNER_SPEND_AUTHORIZATION_ID) && Number(env.PAID_SPEND_LIMIT_CENTS ?? 0) > 0; }
const breakerFromRow = (row: Row | undefined): BreakerState => row ? { state: row.state, consecutiveFailures: Number(row.consecutive_failures), openedCount: Number(row.opened_count), retryAt: row.retry_at ? new Date(row.retry_at).getTime() : null } : closedBreaker();
const rate = (value: unknown, name: string) => { if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 10_000_000) return fail(`INVALID_${name.toUpperCase()}`, 400); return Math.round(value * 10_000) / 10_000; };

export type ExecuteModelInput = {
  agentId: string; projectId?: string | null; taskClass: TaskClass; request: ModelRequest; environment?: ExecutionEnv; transport?: typeof fetch;
  sleep?: (ms: number) => Promise<void>; random?: () => number; now?: () => number; maxAttempts?: number; allowFailover?: boolean; allowPaidFailover?: boolean; runId?: string | null; signal?: AbortSignal;
};

export class ModelOperations {
  constructor(private readonly client: Client, private readonly ctx: Context) {}

  /** DOTS-055: append a reviewed revision. Upgrades and retirements add a row; history is never rewritten. */
  async registerRevision(input: { provider: unknown; model: unknown; status?: unknown; reviewRef: unknown; capabilities?: Record<string, unknown>; privacyClass?: unknown }) {
    const provider = selection(input.provider, providerIds, "provider") as ProviderId, manifest = MODEL_MANIFEST[provider];
    const model = text(input.model, "model", 200), status = selection(input.status ?? "approved", ["approved", "retired", "denied"], "revision_status");
    const reviewRef = text(input.reviewRef, "review_ref", 240), privacy = selection(input.privacyClass ?? manifest.privacyCeiling, privacyClasses, "privacy_class") as PrivacyClass;
    if (status === "approved") {
      if (disallowedModelLineage(model)) return fail("PROVIDER_MODEL_NOT_ALLOWED", 403);
      if (modelFamilyMismatch(provider, model) || !new RegExp(manifest.modelFamily).test(model) || (manifest.pinnedModel && model !== manifest.pinnedModel)) return fail("PROVIDER_MODEL_MISMATCH", 403);
      if (privacyRank[privacy] > privacyRank[manifest.privacyCeiling]) return fail("MODEL_PRIVACY_NOT_PERMITTED", 403);
    }
    const capabilities = { ...manifest.capabilities, ...(input.capabilities ?? {}) };
    if (JSON.stringify(capabilities).length > 4000) return fail("INVALID_CAPABILITIES", 400);
    return tenant(this.client, this.ctx, async tx => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`model-revision:${this.ctx.organizationId}:${provider}:${model}`]);
      const prior = rows(await tx.query("SELECT revision FROM app.model_revisions WHERE organization_id=$1 AND provider_id=$2 AND model_id=$3 ORDER BY revision DESC LIMIT 1", [this.ctx.organizationId, provider, model]))[0];
      const revision = prior ? Number(prior.revision) + 1 : 1;
      const snapshot = { provider, model, revision, status, endpoint: manifest.endpoint, protocol: manifest.protocol, approvedOrigin: manifest.approvedOrigin, privacyClass: privacy, capabilities, manifestVersion: MODEL_MANIFEST_VERSION };
      const row = rows(await tx.query(`INSERT INTO app.model_revisions(organization_id,provider_id,model_id,revision,status,endpoint,protocol,approved_origin,privacy_class,capabilities,manifest_version,review_ref,snapshot_hash,created_by_membership_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14) RETURNING *`, [this.ctx.organizationId, provider, model, revision, status, manifest.endpoint, manifest.protocol, manifest.approvedOrigin, privacy, JSON.stringify(capabilities), MODEL_MANIFEST_VERSION, reviewRef, digest(snapshot), this.ctx.membershipId]))[0]!;
      await event(tx, this.ctx, "model.revision_registered", row.id, { provider, model, revision, status });
      return row;
    });
  }
  async approvedRevisions(tx?: Client): Promise<ApprovedRevision[]> {
    const run = async (c: Client) => rows(await c.query("SELECT provider_id,model_id,revision,status FROM app.model_revisions WHERE organization_id=$1", [this.ctx.organizationId])).map(r => ({ provider: r.provider_id, model: r.model_id, revision: Number(r.revision), status: r.status }));
    return tx ? run(tx) : tenant(this.client, this.ctx, run);
  }

  /** DOTS-066: immutable pricing versions. Reuses the latest version when rates are unchanged. */
  async addPricingVersion(input: { provider: unknown; model: unknown; inputCentsPerMillion: unknown; outputCentsPerMillion: unknown; cachedInputCentsPerMillion?: unknown; sourceRef: unknown }) {
    const provider = selection(input.provider, providerIds, "provider"), model = text(input.model, "model", 200), source = text(input.sourceRef, "source_ref", 240);
    const pricing = { inputCentsPerMillion: rate(input.inputCentsPerMillion, "input_rate"), outputCentsPerMillion: rate(input.outputCentsPerMillion, "output_rate"), cachedInputCentsPerMillion: input.cachedInputCentsPerMillion === undefined || input.cachedInputCentsPerMillion === null ? null : rate(input.cachedInputCentsPerMillion, "cached_rate") };
    if (MODEL_MANIFEST[provider as ProviderId].billing === "free" && (pricing.inputCentsPerMillion || pricing.outputCentsPerMillion || pricing.cachedInputCentsPerMillion)) return fail("FREE_PROVIDER_CONFIGURATION_INVALID", 403);
    return tenant(this.client, this.ctx, tx => this.ensurePricing(tx, provider, model, pricing, source));
  }
  private async ensurePricing(tx: Client, provider: string, model: string, pricing: { inputCentsPerMillion: number; outputCentsPerMillion: number; cachedInputCentsPerMillion: number | null }, source: string) {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`model-pricing:${this.ctx.organizationId}:${provider}:${model}`]);
    const latest = rows(await tx.query("SELECT * FROM app.model_pricing_versions WHERE organization_id=$1 AND provider_id=$2 AND model_id=$3 ORDER BY version DESC LIMIT 1", [this.ctx.organizationId, provider, model]))[0];
    const same = latest && Number(latest.input_cents_per_million) === pricing.inputCentsPerMillion && Number(latest.output_cents_per_million) === pricing.outputCentsPerMillion && (latest.cached_input_cents_per_million === null ? null : Number(latest.cached_input_cents_per_million)) === pricing.cachedInputCentsPerMillion;
    if (same) return latest!;
    const row = rows(await tx.query("INSERT INTO app.model_pricing_versions(organization_id,provider_id,model_id,version,input_cents_per_million,output_cents_per_million,cached_input_cents_per_million,source_ref) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
      [this.ctx.organizationId, provider, model, latest ? Number(latest.version) + 1 : 1, pricing.inputCentsPerMillion, pricing.outputCentsPerMillion, pricing.cachedInputCentsPerMillion, source]))[0]!;
    await event(tx, this.ctx, "model.pricing_versioned", row.id, { provider, model, version: Number(row.version) });
    return row;
  }

  /** DOTS-064/067: per-agent routing weight (0 disables the provider for that agent). */
  async setRoutingWeight(agentId: unknown, provider: unknown, weight: unknown) {
    const agent = identifier(agentId), id = selection(provider, providerIds, "provider");
    if (typeof weight !== "number" || !Number.isSafeInteger(weight) || weight < 0 || weight > 100) return fail("INVALID_WEIGHT", 400);
    return tenant(this.client, this.ctx, async tx => {
      const exists = rows(await tx.query("SELECT id FROM app.agent_identities WHERE organization_id=$1 AND id=$2", [this.ctx.organizationId, agent]));
      if (!exists.length) return fail("NOT_FOUND", 404);
      const row = rows(await tx.query(`INSERT INTO app.model_routing_weights(organization_id,agent_identity_id,provider_id,weight,updated_by_membership_id) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(organization_id,agent_identity_id,provider_id) DO UPDATE SET weight=EXCLUDED.weight,version=app.model_routing_weights.version+1,updated_by_membership_id=EXCLUDED.updated_by_membership_id,updated_at=app.utc_now() RETURNING *`, [this.ctx.organizationId, agent, id, weight, this.ctx.membershipId]))[0]!;
      await event(tx, this.ctx, "model.routing_weight_set", agent, { provider: id, weight });
      return row;
    });
  }

  async resetBreaker(provider: unknown, model: unknown) {
    const id = selection(provider, providerIds, "provider"), name = text(model, "model", 200);
    return tenant(this.client, this.ctx, async tx => {
      await tx.query("UPDATE app.model_breakers SET state='closed',consecutive_failures=0,opened_count=0,retry_at=NULL,version=version+1,updated_at=app.utc_now() WHERE organization_id=$1 AND provider_id=$2 AND model_id=$3", [this.ctx.organizationId, id, name]);
      await event(tx, this.ctx, "model.breaker_reset", null, { provider: id, model: name });
    });
  }
  private async recordBreaker(provider: string, model: string, outcome: "success" | "failure", now: number, code: string | null) {
    return tenant(this.client, this.ctx, async tx => {
      const row = rows(await tx.query("SELECT * FROM app.model_breakers WHERE organization_id=$1 AND provider_id=$2 AND model_id=$3 FOR UPDATE", [this.ctx.organizationId, provider, model]))[0];
      const before = breakerFromRow(row), after = nextBreakerState(before, outcome, now);
      await tx.query(`INSERT INTO app.model_breakers(organization_id,provider_id,model_id,state,consecutive_failures,opened_count,retry_at,last_reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT(organization_id,provider_id,model_id) DO UPDATE SET state=EXCLUDED.state,consecutive_failures=EXCLUDED.consecutive_failures,opened_count=EXCLUDED.opened_count,retry_at=EXCLUDED.retry_at,last_reason=EXCLUDED.last_reason,version=app.model_breakers.version+1,updated_at=app.utc_now()`,
        [this.ctx.organizationId, provider, model, after.state, after.consecutiveFailures, after.openedCount, after.retryAt === null ? null : new Date(after.retryAt).toISOString(), code]);
      if (before.state !== after.state) await event(tx, this.ctx, "model.breaker_transition", null, { provider, model, from: before.state, to: after.state, reason: code }, "worker");
      return after;
    });
  }

  /** DOTS-062: persist a classification (hash only, never content). Quarantined output needs explicit release. */
  async recordOutput(content: string, runId: string | null = null) {
    const c = classifyGeneratedOutput(content);
    return tenant(this.client, this.ctx, async tx => {
      const row = rows(await tx.query("INSERT INTO app.generated_outputs(organization_id,run_id,content_hash,content_type,executable,disposition,findings) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING *", [this.ctx.organizationId, runId, c.contentHash, c.contentType, c.executable, c.disposition, JSON.stringify(c.findings)]))[0]!;
      await event(tx, this.ctx, c.disposition === "quarantined" ? "model.output_quarantined" : "model.output_classified", row.id, { contentType: c.contentType, findings: c.findings }, "worker");
      return row;
    });
  }
  /** Explicit owner authorization plus a recorded security check (and an isolated sandbox for execution) is required. */
  async releaseOutput(outputId: unknown, input: { authorizationRef: unknown; securityCheckRef: unknown; sandboxRef?: unknown; use: unknown }) {
    const id = identifier(outputId), use = selection(input.use, ["publish", "execute"], "output_use");
    const authorization = text(input.authorizationRef, "authorization_ref", 240), check = text(input.securityCheckRef, "security_check_ref", 240);
    const sandbox = use === "execute" ? text(input.sandboxRef, "sandbox_ref", 240) : null;
    return tenant(this.client, this.ctx, async tx => {
      const saved = rows(await tx.query("UPDATE app.generated_outputs SET disposition='released',release_use=$3,release_authorization_ref=$4,security_check_ref=$5,sandbox_ref=$6,released_by_membership_id=$7,decided_at=app.utc_now() WHERE organization_id=$1 AND id=$2 AND disposition='quarantined' RETURNING *", [this.ctx.organizationId, id, use, authorization, check, sandbox, this.ctx.membershipId]))[0];
      if (!saved) return fail("OUTPUT_NOT_QUARANTINED");
      await event(tx, this.ctx, "model.output_released", id, { use, securityCheckRef: check });
      return saved;
    });
  }
  async rejectOutput(outputId: unknown) {
    const id = identifier(outputId);
    return tenant(this.client, this.ctx, async tx => {
      const saved = rows(await tx.query("UPDATE app.generated_outputs SET disposition='rejected',released_by_membership_id=$3,decided_at=app.utc_now() WHERE organization_id=$1 AND id=$2 AND disposition='quarantined' RETURNING id", [this.ctx.organizationId, id, this.ctx.membershipId]));
      if (!saved.length) return fail("OUTPUT_NOT_QUARANTINED");
      await event(tx, this.ctx, "model.output_rejected", id);
    });
  }
  /** Gate every publish/execute path calls before generated output may affect a customer system. */
  async assertOutputUsable(outputId: unknown, use: "publish" | "execute") {
    const id = identifier(outputId);
    return tenant(this.client, this.ctx, async tx => {
      const row = rows(await tx.query("SELECT * FROM app.generated_outputs WHERE organization_id=$1 AND id=$2", [this.ctx.organizationId, id]))[0];
      if (!row) return fail("NOT_FOUND", 404);
      if (use === "execute") { if (row.disposition !== "released" || row.release_use !== "execute" || !row.sandbox_ref || !row.security_check_ref) return fail("OUTPUT_EXECUTION_NOT_AUTHORIZED", 403); }
      else if (row.disposition === "quarantined" || row.disposition === "rejected" || (row.disposition === "released" && !row.security_check_ref)) return fail("OUTPUT_QUARANTINED", 403);
      return row;
    });
  }

  async recordInvoice(input: { provider: unknown; periodStart: unknown; periodEnd: unknown; amountCents: unknown; evidenceRef: unknown }) {
    const provider = selection(input.provider, providerIds, "provider"), amount = cents(input.amountCents), evidence = text(input.evidenceRef, "evidence", 240);
    const start = text(input.periodStart, "period_start", 10), end = text(input.periodEnd, "period_end", 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || end < start) return fail("INVALID_PERIOD", 400);
    return tenant(this.client, this.ctx, async tx => {
      const row = rows(await tx.query("INSERT INTO app.model_provider_invoices(organization_id,provider_id,period_start,period_end,amount_cents,evidence_ref) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(organization_id,provider_id,evidence_ref) DO NOTHING RETURNING *", [this.ctx.organizationId, provider, start, end, amount, evidence]))[0];
      if (!row) { const old = rows(await tx.query("SELECT * FROM app.model_provider_invoices WHERE organization_id=$1 AND provider_id=$2 AND evidence_ref=$3", [this.ctx.organizationId, provider, evidence]))[0]!; if (Number(old.amount_cents) !== amount) return fail("IDEMPOTENCY_CONFLICT"); return old; }
      await event(tx, this.ctx, "model.invoice_recorded", row.id, { provider, amountCents: amount });
      return row;
    });
  }

  /** DOTS-066: reconcile canonical usage against the money ledger and provider invoices; estimated/missing usage is flagged separately. */
  async reconcile() {
    return tenant(this.client, this.ctx, async tx => {
      const usage = rows(await tx.query(`SELECT u.*,m.amount_cents AS ledger_cents FROM app.model_usage_records u LEFT JOIN app.money_entries m ON m.organization_id=u.organization_id AND m.idempotency_key=u.ledger_idempotency_key WHERE u.organization_id=$1 ORDER BY u.recorded_at`, [this.ctx.organizationId]));
      const orphanLedger = rows(await tx.query(`SELECT m.idempotency_key,m.amount_cents FROM app.money_entries m JOIN app.budget_reservations r ON r.organization_id=m.organization_id AND r.id=m.reservation_id
        WHERE m.organization_id=$1 AND m.kind='expense' AND r.idempotency_key LIKE 'model:%' AND NOT EXISTS(SELECT 1 FROM app.model_usage_records u WHERE u.organization_id=m.organization_id AND u.ledger_idempotency_key=m.idempotency_key)`, [this.ctx.organizationId]));
      const invoices = rows(await tx.query("SELECT * FROM app.model_provider_invoices WHERE organization_id=$1 ORDER BY period_start", [this.ctx.organizationId]));
      const sum = (list: Row[], key: string) => list.reduce((total, row) => total + Number(row[key] ?? 0), 0);
      const reported = usage.filter(u => u.usage_source === "provider_reported"), estimated = usage.filter(u => u.usage_source === "estimated"), missing = usage.filter(u => u.usage_source === "missing");
      const mismatched = usage.filter(u => Number(u.cost_cents) > 0 && (u.ledger_cents === null || Number(u.ledger_cents) !== Number(u.cost_cents))).map(u => ({ idempotencyKey: u.idempotency_key, usageCents: Number(u.cost_cents), ledgerCents: u.ledger_cents === null ? null : Number(u.ledger_cents) }));
      const invoiceChecks = invoices.map(inv => {
        const inPeriod = usage.filter(u => u.provider_id === inv.provider_id && new Date(u.recorded_at).toISOString().slice(0, 10) >= String(inv.period_start instanceof Date ? inv.period_start.toISOString().slice(0, 10) : inv.period_start) && new Date(u.recorded_at).toISOString().slice(0, 10) <= String(inv.period_end instanceof Date ? inv.period_end.toISOString().slice(0, 10) : inv.period_end));
        const usageCents = sum(inPeriod, "cost_cents");
        return { provider: inv.provider_id, periodStart: inv.period_start, periodEnd: inv.period_end, invoiceCents: Number(inv.amount_cents), usageCents, differenceCents: Number(inv.amount_cents) - usageCents, evidenceRef: inv.evidence_ref };
      });
      return {
        usageRecords: usage.length, providerReportedCents: sum(reported, "cost_cents"), ledgerCents: sum(usage.filter(u => u.ledger_cents !== null), "ledger_cents") + sum(orphanLedger, "amount_cents"),
        estimated: { count: estimated.length, cents: sum(estimated, "cost_cents") }, missingUsage: { count: missing.length, cents: sum(missing, "cost_cents") },
        mismatched, ledgerWithoutUsage: orphanLedger.map(r => ({ idempotencyKey: r.idempotency_key, ledgerCents: Number(r.amount_cents) })), invoices: invoiceChecks,
        reconciled: mismatched.length === 0 && orphanLedger.length === 0 && invoiceChecks.every(i => i.differenceCents === 0),
      };
    });
  }

  /**
   * DOTS-064/065: route, reserve, execute with bounded retries, circuit breaker and audited failover, then settle and
   * record canonical usage. An idempotency key executes at most once; ambiguous outcomes (timeouts) hold the reservation
   * for reconciliation and are never retried or failed over.
   */
  async execute(input: ExecuteModelInput) {
    const env = input.environment ?? process.env, now = input.now ?? Date.now, sleep = input.sleep ?? (ms => new Promise(r => setTimeout(r, ms))), random = input.random ?? Math.random;
    const maxAttempts = input.maxAttempts ?? 3;
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) return fail("INVALID_MAX_ATTEMPTS", 400);
    const agent = identifier(input.agentId), projectId = input.projectId ? identifier(input.projectId) : null;
    validateModelRequest(input.request);
    selection(input.taskClass, taskClasses, "task_class");
    const key = input.request.idempotencyKey, requestHash = digest({ request: input.request, taskClass: input.taskClass, agent, projectId });
    const claim = await tenant(this.client, this.ctx, async tx => {
      const inserted = rows(await tx.query("INSERT INTO app.model_executions(organization_id,idempotency_key,request_hash,agent_identity_id,task_class,privacy_class) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(organization_id,idempotency_key) DO NOTHING RETURNING *", [this.ctx.organizationId, key, requestHash, agent, input.taskClass, input.request.privacyClass]))[0];
      if (inserted) { await event(tx, this.ctx, "model.execution_claimed", inserted.id, { taskClass: input.taskClass, privacyClass: input.request.privacyClass }, "worker"); return { row: inserted, fresh: true }; }
      const old = rows(await tx.query("SELECT * FROM app.model_executions WHERE organization_id=$1 AND idempotency_key=$2", [this.ctx.organizationId, key]))[0]!;
      if (old.request_hash !== requestHash) return fail("IDEMPOTENCY_CONFLICT");
      return { row: old, fresh: false };
    });
    if (!claim.fresh) {
      if (claim.row.state === "succeeded") return { replayed: true as const, executionId: claim.row.id as string, summary: claim.row.result };
      return fail(claim.row.state === "claimed" ? "MODEL_EXECUTION_IN_PROGRESS" : claim.row.state === "reconciliation_required" ? "MODEL_EXECUTION_NEEDS_RECONCILIATION" : (claim.row.reason_code ?? "MODEL_EXECUTION_FAILED"));
    }
    const executionId = claim.row.id as string;
    const finish = (state: "succeeded" | "failed" | "reconciliation_required", reason: string | null, result: Record<string, unknown> | null, attempts: number, provider: string | null, model: string | null) =>
      tenant(this.client, this.ctx, async tx => { await tx.query("UPDATE app.model_executions SET state=$3,reason_code=$4,result=$5::jsonb,attempts=$6,provider_id=$7,model_id=$8,updated_at=app.utc_now() WHERE organization_id=$1 AND id=$2 AND state='claimed'", [this.ctx.organizationId, executionId, state, reason, result === null ? null : JSON.stringify(result), attempts, provider, model]); await event(tx, this.ctx, `model.execution_${state}`, executionId, { reason, provider, model, attempts }, "worker"); });

    // Gather routing inputs.
    const loaded = await tenant(this.client, this.ctx, async tx => ({
      approved: await this.approvedRevisions(tx),
      weights: rows(await tx.query("SELECT provider_id,weight FROM app.model_routing_weights WHERE organization_id=$1 AND agent_identity_id=$2", [this.ctx.organizationId, agent])),
      breakers: rows(await tx.query("SELECT * FROM app.model_breakers WHERE organization_id=$1", [this.ctx.organizationId])),
      policies: rows(await tx.query("SELECT limit_cents,reserved_cents,spent_cents,project_id FROM app.spending_policies WHERE organization_id=$1 AND (project_id IS NULL OR project_id=$2)", [this.ctx.organizationId, projectId])),
    }));
    const remaining = loaded.policies.length && loaded.policies.some(p => p.project_id === null) ? Math.min(...loaded.policies.map(p => Number(p.limit_cents) - Number(p.reserved_cents) - Number(p.spent_cents))) : 0;
    const candidates: RouteCandidate[] = providerIds.map(provider => {
      let binding: ModelBinding | null = null, configurationError: string | undefined;
      try { binding = modelBinding(provider, env); } catch (error) { configurationError = error instanceof OperationError ? error.code : "PROVIDER_CONFIGURATION_INVALID"; }
      const latest = binding ? latestRevision(loaded.approved, provider, binding.model) : undefined;
      const weightRow = loaded.weights.find(w => w.provider_id === provider);
      const free = MODEL_MANIFEST[provider].billing === "free";
      return { provider, binding, ...(configurationError ? { configurationError } : {}), revisionStatus: latest?.status ?? null, executionAuthorized: free ? env.FREE_MODEL_API_ENABLED === "true" : paidExecutionAuthorized(env),
        weight: weightRow ? Number(weightRow.weight) : 0, breaker: breakerFromRow(loaded.breakers.find(b => b.provider_id === provider && b.model_id === binding?.model)), budgetRemainingCents: free ? 0 : Math.max(0, remaining) };
    });
    const decision = routeModel({ taskClass: input.taskClass, request: input.request, candidates, now: now(), seed: key });
    await tenant(this.client, this.ctx, tx => event(tx, this.ctx, "model.route_decided", executionId, { selected: decision.selected?.provider ?? null, considered: decision.considered }, "worker"));
    if (!decision.selected) { await finish("failed", "NO_ELIGIBLE_MODEL", { considered: decision.considered }, 0, null, null); return fail("NO_ELIGIBLE_MODEL", 503); }

    const control = new ControlPlane(this.client, this.ctx);
    const chain = [decision.selected, ...(input.allowFailover ? decision.failover : [])];
    let attempts = 0, lastCode = "MODEL_PROVIDERS_EXHAUSTED";
    for (let index = 0; index < chain.length; index++) {
      const candidate = chain[index]!, binding = candidate.binding!;
      if (index > 0) {
        const from = chain[index - 1]!.binding!;
        try { assertFailoverAllowed(from, binding, { allowFailover: input.allowFailover === true, allowPaidFailover: input.allowPaidFailover === true }); }
        catch (error) { await tenant(this.client, this.ctx, tx => event(tx, this.ctx, "model.failover_refused", executionId, { from: from.provider, to: binding.provider, reason: (error as OperationError).code }, "worker")); continue; }
        await tenant(this.client, this.ctx, tx => event(tx, this.ctx, "model.failover_decided", executionId, { from: from.provider, to: binding.provider, reason: lastCode }, "worker"));
      }
      const estimate = worstCaseCostCents(binding, input.request);
      const reservation = binding.billingMode === "paid" && estimate > 0 ? await control.reserve(`model:${key}:${binding.provider}`, estimate, projectId) : null;
      const pricing = await tenant(this.client, this.ctx, tx => this.ensurePricing(tx, binding.provider, binding.model, { inputCentsPerMillion: binding.pricing.inputCentsPerMillion, outputCentsPerMillion: binding.pricing.outputCentsPerMillion, cachedInputCentsPerMillion: binding.pricing.cachedInputCentsPerMillion ?? null }, "environment configuration"));
      let breaker = candidate.breaker;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (breaker.state === "open" && (breaker.retryAt ?? Infinity) > now()) { lastCode = "CIRCUIT_OPEN"; break; }
        attempts++;
        try {
          const result = await invokeModel(binding, input.request, { transport: input.transport ?? fetch, now, approved: loaded.approved, ...(input.signal ? { signal: input.signal } : {}) });
          await this.recordBreaker(binding.provider, binding.model, "success", now(), null);
          return await this.settleAndRecord(executionId, control, reservation, pricing, binding, result, input.runId ?? null, attempts, finish);
        } catch (error) {
          const call = error instanceof ProviderCallError ? error : null, code = error instanceof OperationError ? error.code : "PROVIDER_NETWORK_ERROR";
          const executed = call ? call.executed : error instanceof OperationError ? "no" : "unknown";
          lastCode = code;
          if (call?.executed === "yes" && call.result) {
            // A response was produced (and possibly billed) but failed validation: settle actual usage, never retry.
            await this.settleAndRecord(executionId, control, reservation, pricing, binding, call.result, input.runId ?? null, attempts, finish, code);
            return fail(code, call.status);
          }
          if (executed === "unknown") {
            // Ambiguous (timeout, dropped connection, cancellation in flight): the provider may have executed and billed.
            // Hold the reservation, record missing usage and require reconciliation; never retry or fail over.
            if (code !== "MODEL_CANCELLED") await this.recordBreaker(binding.provider, binding.model, "failure", now(), code);
            await tenant(this.client, this.ctx, tx => tx.query("INSERT INTO app.model_usage_records(organization_id,idempotency_key,execution_id,run_id,provider_id,model_id,pricing_version_id,cost_cents,usage_source) VALUES($1,$2,$3,$4,$5,$6,$7,0,'missing')", [this.ctx.organizationId, key, executionId, input.runId ?? null, binding.provider, binding.model, pricing.id]));
            await finish("reconciliation_required", code, { reservationId: reservation?.id ?? null }, attempts, binding.provider, binding.model);
            return fail(code, call?.status ?? 503);
          }
          if (!call?.retryable) {
            if (reservation) await control.settle(reservation.id, 0, `released:model:${executionId}`, true);
            await finish("failed", code, null, attempts, binding.provider, binding.model);
            return fail(code, call?.status ?? (error as OperationError).status);
          }
          breaker = await this.recordBreaker(binding.provider, binding.model, "failure", now(), code);
          if (attempt + 1 < maxAttempts && breaker.state !== "open") {
            const delay = providerBackoffDelayMs(attempt, random, 500, 8_000, call.retryAfterMs);
            await tenant(this.client, this.ctx, tx => event(tx, this.ctx, "model.retry_scheduled", executionId, { provider: binding.provider, attempt: attempt + 1, delayMs: delay, reason: code }, "worker"));
            await sleep(delay);
          }
        }
      }
      // Provider rejected before executing (429/5xx): nothing billed, release the hold before any failover.
      if (reservation) await control.settle(reservation.id, 0, `released:model:${executionId}`, true);
    }
    await finish("failed", lastCode, null, attempts, decision.selected.provider, decision.selected.binding!.model);
    return fail(lastCode === "CIRCUIT_OPEN" ? "CIRCUIT_OPEN" : "MODEL_PROVIDERS_EXHAUSTED", 503);
  }

  private async settleAndRecord(executionId: string, control: ControlPlane, reservation: Row | null, pricing: Row, binding: ModelBinding, result: ModelResult, runId: string | null, attempts: number,
    finish: (state: "succeeded" | "failed" | "reconciliation_required", reason: string | null, result: Record<string, unknown> | null, attempts: number, provider: string | null, model: string | null) => Promise<void>, failureCode?: string) {
    // Usage the provider did not report is charged at the worst-case estimate and flagged `estimated`.
    const source: "provider_reported" | "estimated" = result.usage.source === "provider_reported" ? "provider_reported" : "estimated";
    let ledgerKey: string | null = null, ledgerCents = 0;
    const overrun = reservation !== null && result.costCents > Number(reservation.estimate_cents);
    if (reservation) {
      // The ledger can never exceed the reservation; an overrun stays visible as a usage/ledger mismatch for reconciliation.
      ledgerCents = Math.min(result.costCents, Number(reservation.estimate_cents));
      await control.settle(reservation.id, ledgerCents, (result.providerRequestId ?? `model:${executionId}`).slice(0, 240), false, "provider");
      ledgerKey = `settle:${reservation.id}`;
    }
    const output = result.text ? await this.recordOutput(result.text, runId) : null;
    const summary = { provider: binding.provider, model: binding.model, responseModel: result.responseModel, finishReason: result.finishReason, toolCalls: result.toolCalls.map(c => c.name), usage: result.usage, costCents: result.costCents, ledgerCents, usageSource: source, providerRequestId: result.providerRequestId, wallTimeMs: result.wallTimeMs, outputId: output?.id ?? null, outputDisposition: output?.disposition ?? null, overrun };
    await tenant(this.client, this.ctx, async tx => {
      await tx.query(`INSERT INTO app.model_usage_records(organization_id,idempotency_key,execution_id,run_id,provider_id,model_id,pricing_version_id,input_tokens,output_tokens,cached_input_tokens,reasoning_tokens,wall_time_ms,cost_cents,usage_source,ledger_idempotency_key,provider_request_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`, [this.ctx.organizationId, result.idempotencyKey, executionId, runId, binding.provider, binding.model, pricing.id, result.usage.inputTokens, result.usage.outputTokens, result.usage.cachedInputTokens, result.usage.reasoningTokens, result.wallTimeMs, result.costCents, source, ledgerKey, result.providerRequestId]);
      if (overrun) await event(tx, this.ctx, "model.usage_exceeded_reservation", executionId, { reportedCents: result.costCents, ledgerCents }, "worker");
    });
    await finish(failureCode ? "failed" : "succeeded", failureCode ?? null, summary, attempts, binding.provider, binding.model);
    return { replayed: false as const, executionId, result, summary };
  }

  /** GET snapshot for the Models view. Secrets are never included; only credential names and presence. */
  async snapshot(env: ExecutionEnv = process.env) {
    return tenant(this.client, this.ctx, async tx => {
      const q = async (sql: string) => rows(await tx.query(sql, [this.ctx.organizationId]));
      return {
        manifest: { version: MODEL_MANIFEST_VERSION, providers: Object.values(MODEL_MANIFEST).map(m => ({ id: m.id, label: m.label, protocol: m.protocol, endpointHost: new URL(m.endpoint).host, approvedOrigin: m.approvedOrigin, billing: m.billing, privacyCeiling: m.privacyCeiling, pinnedModel: m.pinnedModel, capabilities: m.capabilities })) },
        providers: modelCatalogStatus(env),
        revisions: await q("SELECT id,provider_id,model_id,revision,status,privacy_class,approved_origin,review_ref,snapshot_hash,created_at FROM app.model_revisions WHERE organization_id=$1 ORDER BY provider_id,model_id,revision DESC LIMIT 200"),
        pricing: await q("SELECT id,provider_id,model_id,version,input_cents_per_million,output_cents_per_million,cached_input_cents_per_million,source_ref,created_at FROM app.model_pricing_versions WHERE organization_id=$1 ORDER BY provider_id,model_id,version DESC LIMIT 200"),
        agents: await q("SELECT id,display_name,status FROM app.agent_identities WHERE organization_id=$1 ORDER BY display_name LIMIT 200"),
        weights: await q("SELECT agent_identity_id,provider_id,weight,version,updated_at FROM app.model_routing_weights WHERE organization_id=$1"),
        breakers: await q("SELECT provider_id,model_id,state,consecutive_failures,opened_count,retry_at,last_reason,updated_at FROM app.model_breakers WHERE organization_id=$1 ORDER BY provider_id"),
        executions: await q("SELECT id,state,task_class,privacy_class,provider_id,model_id,attempts,reason_code,created_at,updated_at FROM app.model_executions WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 50"),
        outputs: await q("SELECT id,run_id,content_type,executable,disposition,findings,release_use,security_check_ref,created_at,decided_at FROM app.generated_outputs WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 50"),
        invoices: await q("SELECT id,provider_id,period_start,period_end,amount_cents,evidence_ref,recorded_at FROM app.model_provider_invoices WHERE organization_id=$1 ORDER BY period_start DESC LIMIT 50"),
        controls: { paidExecutionAuthorized: paidExecutionAuthorized(env), freeModelEnabled: env.FREE_MODEL_API_ENABLED === "true", hardCapCents: Number(env.PAID_SPEND_LIMIT_CENTS ?? 0) || 0, liveSmokeEnabled: env.MODEL_SMOKE_ENABLED === "true" },
        observedAt: new Date().toISOString(),
      };
    }).then(async snapshot => ({ ...snapshot, reconciliation: await this.reconcile() }));
  }
}
