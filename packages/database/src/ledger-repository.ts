import { createHash, randomUUID } from "node:crypto";
import { withTransaction, type TransactionClient } from "./index.js";
import { currency, minor, validateInvoice, validateJournal, validateReservation, type AccountKind, type BudgetAccount, type Currency, type InvoiceAmounts, type Journal, type Reservation, type PostingEvidence, type InvoiceEvidence, type FinancialRecord, reconcileFinancialRecords } from "./ledger-domain.js";
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

  createInvoice(actor: Actor, invoice: InvoiceAmounts, evidence: InvoiceEvidence): Promise<string> {
    validateInvoice(invoice);
    if (!evidence || Object.keys(evidence).some(key => !["allocated","incurred","paid"].includes(key))) throw new Error("Invalid invoice evidence");
    for (const phase of ["allocated","incurred","paid"] as const) {
      if ((minor(invoice[`${phase}Minor`]) > 0n) !== Boolean(evidence[phase])) throw new Error("Invoice evidence required exactly for nonzero amounts");
    }
    return this.transaction(actor,true,async tx=>{
      const id=randomUUID();await tx.query("INSERT INTO app.ledger_invoices(id,organization_id,currency,allocated_minor,incurred_minor,paid_minor) VALUES($1,$2,$3,$4::bigint,$5::bigint,$6::bigint)",[id,actor.organizationId,invoice.currency,invoice.allocatedMinor,invoice.incurredMinor,invoice.paidMinor]);
      for (const phase of ["allocated","incurred","paid"] as const) {
        const proof=evidence[phase];
        if(proof) await this.linkEvidence(tx,actor,{invoiceId:id,phase,proof});
      }
      return id;
    });
  }
  createReservation(actor: Actor, input: Reservation, evidence: PostingEvidence): Promise<string> {
    if (input.organizationId!==actor.organizationId || input.state!=="open") throw new Error("New reservation must be open in the current tenant");
    return this.transaction(actor,true,async tx=>{
      const a=rows(await tx.query("SELECT id,currency,kind FROM app.budget_accounts WHERE organization_id=$1 AND id=$2",[actor.organizationId,input.accountId]))[0];
      if (!a) throw new Error("Reservation account unavailable");
      validateReservation(input,{id:String(a.id),organizationId:actor.organizationId,currency:a.currency as Currency,kind:a.kind as AccountKind});
      await tx.query("INSERT INTO app.ledger_reservations(id,organization_id,account_id,currency,amount_minor,state) VALUES($1,$2,$3,$4,$5::bigint,'open')",[input.id,actor.organizationId,input.accountId,input.currency,input.amountMinor]);
      await this.linkEvidence(tx,actor,{reservationId:input.id,phase:"reserved",proof:evidence});
      return input.id;
    });
  }
  private async linkEvidence(tx: TransactionClient, actor: Actor, input: {invoiceId?:string;reservationId?:string;phase:string;proof:PostingEvidence}): Promise<void> {
    if (!input.proof || !uuid.test(input.proof.journalId) || !uuid.test(input.proof.accountId)) throw new Error("Invalid posting evidence");
    await tx.query("INSERT INTO app.ledger_fact_postings(organization_id,invoice_id,reservation_id,phase,journal_id,account_id) VALUES($1,$2,$3,$4,$5,$6)",
      [actor.organizationId,input.invoiceId??null,input.reservationId??null,input.phase,input.proof.journalId,input.proof.accountId]);
  }

  /** A bounded single-statement snapshot, with exact page totals (not portfolio totals). */
  financialRecords(actor: Actor, options: {limit?:number;after?:string} = {}): Promise<{records:FinancialRecord[];pageTotals:ReturnType<typeof reconcileFinancialRecords>;nextCursor:string|null}> {
    const limit=options.limit??25;
    if(!Number.isSafeInteger(limit)||limit<1||limit>100||options.after!==undefined&&!uuid.test(options.after)) throw new Error("Invalid financial records page");
    return this.transaction(actor,false,async tx=>{
      const results=rows(await tx.query(`WITH facts AS (
        SELECT id,'invoice'::text kind,currency,allocated_minor::text allocated_minor,incurred_minor::text incurred_minor,paid_minor::text paid_minor,NULL::text amount_minor,NULL::uuid account_id
        FROM app.ledger_invoices WHERE organization_id=$1
        UNION ALL
        SELECT id,'reservation'::text kind,currency,NULL,NULL,NULL,amount_minor::text,account_id
        FROM app.ledger_reservations WHERE organization_id=$1
      ), page AS (SELECT * FROM facts WHERE ($2::uuid IS NULL OR id>$2::uuid) ORDER BY id LIMIT $3)
      SELECT page.*,l.phase,l.journal_id,l.account_id evidence_account_id,p.amount_minor::text evidence_amount_minor,p.currency evidence_currency,a.kind account_kind
      FROM page LEFT JOIN app.ledger_fact_postings l ON l.organization_id=$1 AND
        ((page.kind='invoice' AND l.invoice_id=page.id) OR (page.kind='reservation' AND l.reservation_id=page.id))
      LEFT JOIN app.ledger_postings p ON p.organization_id=l.organization_id AND p.journal_id=l.journal_id AND p.account_id=l.account_id
      LEFT JOIN app.budget_accounts a ON a.organization_id=p.organization_id AND a.id=p.account_id
      ORDER BY page.id,l.phase`,[actor.organizationId,options.after??null,limit+1]));
      const records:FinancialRecord[]=[];
      for(const row of results){
        let record=records[records.length-1];
        if(!record||record.id!==row.id){
          if(row.kind!=="invoice"&&row.kind!=="reservation") throw new Error("Invalid financial record");
          record={id:String(row.id),kind:row.kind,currency:currency(String(row.currency)),
            amounts:row.kind==="invoice"?{allocated:String(row.allocated_minor),incurred:String(row.incurred_minor),paid:String(row.paid_minor)}:{reserved:String(row.amount_minor)},
            ...(row.kind==="reservation"?{accountId:String(row.account_id)}:{}),evidence:[]};
          records.push(record);
        }
        if(row.phase!==null)record.evidence.push({phase:String(row.phase),journalId:String(row.journal_id),accountId:String(row.evidence_account_id),amountMinor:String(row.evidence_amount_minor),currency:String(row.evidence_currency),accountKind:String(row.account_kind)});
      }
      // Validate even the lookahead row; malformed evidence never silently vanishes.
      reconcileFinancialRecords(records);
      const page=records.slice(0,limit);
      return {records:page,pageTotals:reconcileFinancialRecords(page),nextCursor:records.length>limit?page[page.length-1]!.id:null};
    });
  }

}

