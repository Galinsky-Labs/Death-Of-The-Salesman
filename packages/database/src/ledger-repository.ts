import { createHash, randomUUID } from "node:crypto";
import { withTransaction, type TransactionClient } from "./index.js";
import { currency, minor, validateInvoice, validateJournal, validateReservation, type AccountKind, type BudgetAccount, type Currency, type InvoiceAmounts, type Journal, type Reservation } from "./ledger-domain.js";
type Actor = { organizationId: string; membershipId: string };
/** PostgreSQL microsecond keyset position; do not truncate to JS Date milliseconds. */
export type JournalHistoryCursor = { occurredAt: string; id: string };
export type JournalHistoryEntry = {
  id: string;
  currency: Currency;
  idempotencyKey: string;
  occurredAt: string;
  postings: { accountId: string; amountMinor: string }[];
};
export type JournalHistoryPage = { journals: JournalHistoryEntry[]; nextCursor: JournalHistoryCursor | null };
const utcMicrosecond = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const rows = (r: unknown) => (r as { rows: Record<string, unknown>[] }).rows;
export class LedgerRepository {
  constructor(private readonly client: TransactionClient) {}
  private transaction<T>(actor: Actor, write: boolean, operation: (tx: TransactionClient) => Promise<T>): Promise<T> {
    return withTransaction(this.client, async tx => {
      await tx.query("SELECT set_config('app.organization_id',$1,true)", [actor.organizationId]);
      const allowed = rows(await tx.query("SELECT id FROM app.memberships WHERE organization_id=$1 AND id=$2 AND status='active' AND (role='owner' OR ($3::boolean=false AND role='admin'))", [actor.organizationId, actor.membershipId, write]));
      if (!allowed.length) throw new Error("Ledger operation is not authorized");
      return operation(tx);
    });
  }
  createAccount(actor: Actor, code: Currency, kind: AccountKind): Promise<BudgetAccount> {
    currency(code);
    if (!["cash","allocated","reserved","incurred","paid","offset"].includes(kind)) throw new Error("Invalid account kind");
    return this.transaction(actor,true,async tx => {
      const id=randomUUID();
      await tx.query("INSERT INTO app.budget_accounts(id,organization_id,currency,kind) VALUES($1,$2,$3,$4)",[id,actor.organizationId,code,kind]);
      return {id,organizationId:actor.organizationId,currency:code,kind};
    });
  }
  postJournal(actor: Actor, journal: Journal): Promise<{id:string;replay:boolean}> {
    if (actor.organizationId!==journal.organizationId) throw new Error("Journal tenant mismatch");
    return this.transaction(actor,true,async tx => {
      const accounts=rows(await tx.query("SELECT id,currency,kind FROM app.budget_accounts WHERE organization_id=$1 AND id=ANY($2::uuid[])",[actor.organizationId,journal.postings.map(p=>p.accountId)])).map(r=>({id:String(r.id),organizationId:actor.organizationId,currency:r.currency as Currency,kind:r.kind as AccountKind}));
      validateJournal(journal,accounts);
      const hash=createHash("sha256").update(JSON.stringify({currency:journal.currency,postings:[...journal.postings].sort((a,b)=>a.accountId.localeCompare(b.accountId))})).digest("hex");
      const inserted=rows(await tx.query("INSERT INTO app.ledger_journals(id,organization_id,currency,idempotency_key,request_hash) VALUES($1,$2,$3,$4,$5) ON CONFLICT(organization_id,idempotency_key) DO NOTHING RETURNING id",[journal.id,actor.organizationId,journal.currency,journal.idempotencyKey,hash]));
      if (!inserted.length) {
        const prior=rows(await tx.query("SELECT id,request_hash FROM app.ledger_journals WHERE organization_id=$1 AND idempotency_key=$2",[actor.organizationId,journal.idempotencyKey]))[0];
        if (!prior || prior.request_hash!==hash) throw new Error("Idempotency key conflicts with a different journal");
        return {id:String(prior.id),replay:true};
      }
      for(const p of journal.postings) await tx.query("INSERT INTO app.ledger_postings(organization_id,journal_id,account_id,currency,amount_minor) VALUES($1,$2,$3,$4,$5::bigint)",[actor.organizationId,journal.id,p.accountId,journal.currency,p.amountMinor]);
      return {id:journal.id,replay:false};
    });
  }
  balances(actor: Actor): Promise<{accountId:string;currency:Currency;balanceMinor:string}[]> {
    return this.transaction(actor,false,async tx=>rows(await tx.query("SELECT a.id,a.currency,COALESCE(sum(p.amount_minor),0)::text AS balance FROM app.budget_accounts a LEFT JOIN app.ledger_postings p ON p.organization_id=a.organization_id AND p.account_id=a.id WHERE a.organization_id=$1 GROUP BY a.id,a.currency ORDER BY a.id",[actor.organizationId])).map(r=>({accountId:String(r.id),currency:r.currency as Currency,balanceMinor:String(r.balance)})));
  }
  /**
   * Bounded, tenant-authorized evidence view. A single SQL statement snapshot
   * prevents torn pages. Does not authorize payments or external side effects.
   */
  journalHistory(actor: Actor, options: { limit?: number; after?: JournalHistoryCursor } = {}): Promise<JournalHistoryPage> {
    const limit = options.limit ?? 25;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Journal history limit must be an integer between 1 and 100");
    }
    const after = options.after;
    if (after && (
      !utcMicrosecond.test(after.occurredAt) ||
      Number.isNaN(Date.parse(after.occurredAt)) ||
      !uuid.test(after.id)
    )) throw new Error("Invalid journal history cursor");
    return this.transaction(actor, false, async tx => {
      const results = rows(await tx.query(
        `WITH page AS (
           SELECT id, currency, idempotency_key, occurred_at
             FROM app.ledger_journals
            WHERE organization_id=$1
              AND ($2::timestamptz IS NULL OR (occurred_at, id) > ($2::timestamptz, $3::uuid))
            ORDER BY occurred_at, id
            LIMIT $4
         )
         SELECT page.id, page.currency, page.idempotency_key,
                to_char(page.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at_utc,
                p.account_id, p.amount_minor::text AS amount_minor
           FROM page
           JOIN app.ledger_postings p
             ON p.organization_id=$1 AND p.journal_id=page.id AND p.currency=page.currency
          ORDER BY page.occurred_at, page.id, p.account_id`,
        [actor.organizationId, after?.occurredAt ?? null, after?.id ?? null, limit + 1]
      ));
      const history: JournalHistoryEntry[] = [];
      for (const row of results) {
        const id = String(row.id);
        let entry = history[history.length - 1];
        if (!entry || entry.id !== id) {
          entry = {
            id, currency: currency(String(row.currency)),
            idempotencyKey: String(row.idempotency_key),
            occurredAt: String(row.occurred_at_utc), postings: []
          };
          history.push(entry);
        }
        const amountMinor = String(row.amount_minor);
        minor(amountMinor, true);
        entry.postings.push({ accountId: String(row.account_id), amountMinor });
      }
      for (const item of history) {
        if (item.postings.length < 2 || item.postings.length > 200 ||
            item.postings.reduce((total, p) => total + minor(p.amountMinor, true), 0n) !== 0n) {
          throw new Error("Ledger journal integrity check failed");
        }
      }
      const journals = history.slice(0, limit);
      const last = journals[journals.length - 1];
      return {
        journals,
        nextCursor: history.length > limit && last ? { occurredAt: last.occurredAt, id: last.id } : null
      };
    });
  }

  createInvoice(actor: Actor, invoice: InvoiceAmounts): Promise<string> {
    validateInvoice(invoice);
    return this.transaction(actor,true,async tx=>{
      const id=randomUUID();await tx.query("INSERT INTO app.ledger_invoices(id,organization_id,currency,allocated_minor,incurred_minor,paid_minor) VALUES($1,$2,$3,$4::bigint,$5::bigint,$6::bigint)",[id,actor.organizationId,invoice.currency,invoice.allocatedMinor,invoice.incurredMinor,invoice.paidMinor]);return id;
    });
  }
  createReservation(actor: Actor, input: Reservation): Promise<string> {
    if (input.organizationId!==actor.organizationId || input.state!=="open") throw new Error("New reservation must be open in the current tenant");
    return this.transaction(actor,true,async tx=>{
      const a=rows(await tx.query("SELECT id,currency,kind FROM app.budget_accounts WHERE organization_id=$1 AND id=$2",[actor.organizationId,input.accountId]))[0];
      if (!a) throw new Error("Reservation account unavailable");
      validateReservation(input,{id:String(a.id),organizationId:actor.organizationId,currency:a.currency as Currency,kind:a.kind as AccountKind});
      await tx.query("INSERT INTO app.ledger_reservations(id,organization_id,account_id,currency,amount_minor,state) VALUES($1,$2,$3,$4,$5::bigint,'open')",[input.id,actor.organizationId,input.accountId,input.currency,input.amountMinor]);return input.id;
    });
  }
}
