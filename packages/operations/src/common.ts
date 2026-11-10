import { createHash, randomUUID } from "node:crypto";
import { withTransaction, type TransactionClient } from "@dots/database";
export type Client = TransactionClient;
export type Context = { organizationId: string; membershipId: string };
export type Row = Record<string, any>;
export const rows = (value: unknown): Row[] => (value as { rows?: Row[] })?.rows ?? [];
export class OperationError extends Error {
  constructor(readonly code: string, readonly status = 409) { super(code); this.name="OperationError"; }
}
export const fail = (code: string, status=409): never => { throw new OperationError(code,status); };
export function text(value: unknown, field: string, maximum=240): string {
  if(typeof value!=="string" || !value.trim() || value.trim().length>maximum) return fail(`INVALID_${field.toUpperCase()}`,400);
  return value.trim();
}
export function cents(value: unknown): number {
  if(typeof value!=="number" || !Number.isSafeInteger(value) || value<0) return fail("INVALID_AMOUNT",400);
  return value;
}
export function canonical(value: unknown): string {
  if(value===null || typeof value!=="object") return JSON.stringify(value)??"null";
  if(value instanceof Date)return JSON.stringify(value.toISOString());
  if(Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string,unknown>).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}
export const digest = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");
export async function tenant<T>(client: Client, context: Context, fn: (tx: Client)=>Promise<T>): Promise<T> {
  return withTransaction(client,async tx=>{
    await tx.query("SELECT set_config('app.organization_id',$1,true),set_config('app.audit_actor_membership_id',$2,true)",[context.organizationId,context.membershipId]);
    const member=rows(await tx.query("SELECT id FROM app.memberships WHERE organization_id=$1 AND id=$2 AND status='active' AND role='owner'",[context.organizationId,context.membershipId]));
    if(!member.length) return fail("NOT_AUTHORIZED",403);
    return fn(tx);
  });
}
export async function event(tx: Client, ctx: Context, type: string, id: string|null, details: Record<string,unknown>={}, actor="human") {
  await tx.query("INSERT INTO app.operation_events(organization_id,actor_kind,actor_id,event_type,record_id,details) VALUES($1,$2,$3,$4,$5,$6::jsonb)",
    [ctx.organizationId,actor,actor==="human"?ctx.membershipId:actor==="provider"?"verified-integration":"durable-worker",type,id,JSON.stringify(details)]);
}
export async function outbox(tx: Client, ctx: Context, key: string, type: string, payload: Record<string,unknown>) {
  const result=rows(await tx.query("INSERT INTO app.event_outbox(organization_id,idempotency_key,event_type,payload) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING RETURNING id",[ctx.organizationId,key,type,JSON.stringify(payload)]));
  if(!result.length){const old=rows(await tx.query("SELECT id,event_type,payload FROM app.event_outbox WHERE organization_id=$1 AND idempotency_key=$2",[ctx.organizationId,key]))[0];if(!old || old.event_type!==type || digest(old.payload)!==digest(payload))return fail("IDEMPOTENCY_CONFLICT");return old.id as string;}
  return result[0]!.id as string;
}
export { randomUUID };
