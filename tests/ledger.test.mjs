import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile,readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {minor,decimalToMinor,validateInvoice,validateJournal,reconcile,reconcileFinancialRecords,LedgerRepository,withTransaction} from '../packages/database/dist/index.js';
const org='11111111-1111-4111-8111-111111111111',owner='22222222-2222-4222-8222-222222222222',other='33333333-3333-4333-8333-333333333333';
test('money uses canonical strings, exact currency exponents and bounded integers',()=>{
  assert.equal(decimalToMinor('90071992547409.93','USD'),'9007199254740993');
  assert.equal(decimalToMinor('12','JPY'),'12');assert.equal(decimalToMinor('1.001','KWD'),'1001');
  for(const x of [0.1,1,NaN,'-0','01','1.0','1e3','9223372036854775808'])assert.throws(()=>minor(x));
  assert.throws(()=>decimalToMinor('1.001','USD'));assert.throws(()=>decimalToMinor('1.1','JPY'));assert.throws(()=>decimalToMinor('1','XXX'));
  assert.throws(()=>validateInvoice({currency:'USD',allocatedMinor:'10',incurredMinor:'5',paidMinor:'6'}));
});
test('ledger SQL: balanced atomic journals, exact reconciliation, idempotency, immutability and tenant isolation',async()=>{
  const db=new PGlite();try{
    const dir=new URL('../database/migrations/',import.meta.url);
    for(const name of (await readdir(dir)).filter(n=>n.endsWith('.up.sql')).sort())await db.exec(await readFile(new URL(name,dir),'utf8'));
    await db.query("INSERT INTO app.organizations(id,slug,display_name) VALUES($1,'first','Synthetic'),($2,'other','Synthetic')",[org,other]);
    await db.query("INSERT INTO app.owner_users(id,identity_subject,display_name) VALUES($1,'synthetic','Synthetic')",[owner]);
    await db.query("INSERT INTO app.memberships(id,organization_id,user_id,role) VALUES($1,$2,$1,'owner')",[owner,org]);
    await db.exec("CREATE ROLE ledger_runtime NOLOGIN NOBYPASSRLS;GRANT USAGE ON SCHEMA app TO ledger_runtime;GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE ON ALL TABLES IN SCHEMA app TO ledger_runtime;GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO ledger_runtime;SET ROLE ledger_runtime;");
    const client={query:(q,v)=>db.query(q,v)},repo=new LedgerRepository(client),actor={organizationId:org,membershipId:owner};
    const cash=await repo.createAccount(actor,'USD','cash'),offset=await repo.createAccount(actor,'USD','offset');
    const journal={id:randomUUID(),organizationId:org,currency:'USD',idempotencyKey:'synthetic-opening',postings:[{accountId:cash.id,amountMinor:'9007199254740993'},{accountId:offset.id,amountMinor:'-9007199254740993'}]};
    assert.equal((await repo.postJournal(actor,journal)).replay,false);assert.equal((await repo.postJournal(actor,{...journal,id:randomUUID()})).replay,true);
    assert.deepEqual(Object.fromEntries((await repo.balances(actor)).map(r=>[r.accountId,r.balanceMinor])),reconcile([cash,offset],[journal]));
    const firstHistory=await repo.journalHistory(actor,{limit:1});
    assert.equal(firstHistory.journals.length,1);
    assert.equal(firstHistory.journals[0].id,journal.id);
    assert.match(firstHistory.journals[0].occurredAt,/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    assert.deepEqual(firstHistory.journals[0].postings.map(p=>p.amountMinor).sort(),journal.postings.map(p=>p.amountMinor).sort());
    assert.equal(firstHistory.nextCursor,null);
    const secondJournal={...journal,id:randomUUID(),idempotencyKey:'synthetic-second',
      postings:[{accountId:cash.id,amountMinor:'7'},{accountId:offset.id,amountMinor:'-7'}]};
    await repo.postJournal(actor,secondJournal);
    const firstPage=await repo.journalHistory(actor,{limit:1});
    assert.ok(firstPage.nextCursor);
    const secondPage=await repo.journalHistory(actor,{limit:1,after:firstPage.nextCursor});
    assert.equal(secondPage.journals.length,1);
    assert.equal(secondPage.nextCursor,null);
    assert.deepEqual(new Set([...firstPage.journals,...secondPage.journals].map(j=>j.id)),new Set([journal.id,secondJournal.id]));
    assert.equal((await repo.journalHistory(actor)).journals.length,2);
    for(const limit of [0,-1,1.5,101])assert.throws(()=>repo.journalHistory(actor,{limit}),/limit/);
    assert.throws(()=>repo.journalHistory(actor,{after:{id:'invalid',occurredAt:firstPage.nextCursor.occurredAt}}),/cursor/);
    assert.throws(()=>repo.journalHistory(actor,{after:{id:journal.id,occurredAt:'2026-11-01T00:00:00Z'}}),/cursor/);
    await assert.rejects(repo.journalHistory({organizationId:other,membershipId:owner}),/not authorized/);
    await assert.rejects(repo.postJournal(actor,{...journal,postings:[{accountId:cash.id,amountMinor:'2'},{accountId:offset.id,amountMinor:'-2'}]}),/Idempotency/);
    assert.throws(()=>validateJournal({...journal,postings:[{accountId:cash.id,amountMinor:'2'},{accountId:offset.id,amountMinor:'-1'}]},[cash,offset]),/balance/);
    await assert.rejects(repo.balances({organizationId:other,membershipId:owner}),/not authorized/);
    await assert.rejects(withTransaction(client,async tx=>{await tx.query("SELECT set_config('app.organization_id',$1,true)",[org]);await tx.query("INSERT INTO app.ledger_journals(organization_id,currency,idempotency_key,request_hash) VALUES($1,'USD','unbalanced',repeat('a',64))",[org]);}),/not balanced/);
    await assert.rejects(withTransaction(client,async tx=>{await tx.query("SELECT set_config('app.organization_id',$1,true)",[org]);await tx.query("UPDATE app.ledger_postings SET amount_minor=1 WHERE journal_id=$1",[journal.id]);}),/immutable/);
    await assert.rejects(withTransaction(client,async tx=>{await tx.query("SELECT set_config('app.organization_id',$1,true)",[org]);await tx.query("INSERT INTO app.ledger_postings(organization_id,journal_id,account_id,currency,amount_minor) VALUES($1,$2,$3,'USD',1)",[org,journal.id,cash.id]);}),/already posted/);
    await assert.rejects(db.query('TRUNCATE app.ledger_postings'),/immutable/);
    const allocated=await repo.createAccount(actor,'USD','allocated'),incurred=await repo.createAccount(actor,'USD','incurred'),paid=await repo.createAccount(actor,'USD','paid'),reserved=await repo.createAccount(actor,'USD','reserved');
    const support={...journal,id:randomUUID(),idempotencyKey:'synthetic-invoice-evidence',postings:[
      {accountId:allocated.id,amountMinor:'100'},{accountId:incurred.id,amountMinor:'80'},
      {accountId:paid.id,amountMinor:'20'},{accountId:reserved.id,amountMinor:'20'},{accountId:offset.id,amountMinor:'-220'}]};
    await repo.postJournal(actor,support);
    const evidence={allocated:{journalId:support.id,accountId:allocated.id},incurred:{journalId:support.id,accountId:incurred.id},paid:{journalId:support.id,accountId:paid.id}};
    const invoice={currency:'USD',allocatedMinor:'100',incurredMinor:'80',paidMinor:'20'};
    const invoiceId=await repo.createInvoice(actor,invoice,evidence);
    const reservation={id:randomUUID(),organizationId:org,accountId:reserved.id,currency:'USD',amountMinor:'20',state:'open'};
    const proof={journalId:support.id,accountId:reserved.id};
    assert.ok(await repo.createReservation(actor,reservation,proof));
    const zeroInvoice=await repo.createInvoice(actor,{currency:'USD',allocatedMinor:'0',incurredMinor:'0',paidMinor:'0'},{});
    const financial=await repo.financialRecords(actor);
    assert.equal(financial.records.length,3);assert.equal(financial.nextCursor,null);
    assert.deepEqual(financial.pageTotals,{USD:{allocated:'100',incurred:'80',paid:'20',reserved:'20'}});
    assert.deepEqual(new Set(financial.records.map(r=>r.id)),new Set([invoiceId,reservation.id,zeroInvoice]));
    const page1=await repo.financialRecords(actor,{limit:1});assert.ok(page1.nextCursor);
    const page2=await repo.financialRecords(actor,{limit:1,after:page1.nextCursor});assert.ok(page2.nextCursor);
    const page3=await repo.financialRecords(actor,{limit:1,after:page2.nextCursor});assert.equal(page3.nextCursor,null);
    assert.equal(new Set([...page1.records,...page2.records,...page3.records].map(r=>r.id)).size,3);
    for(const limit of [0,101,1.5])assert.throws(()=>repo.financialRecords(actor,{limit}));
    assert.throws(()=>repo.financialRecords(actor,{after:'invalid'}));
    await assert.rejects(repo.financialRecords({organizationId:other,membershipId:owner}),/not authorized/);
    await assert.rejects(repo.createInvoice(actor,invoice,evidence),/duplicate key/);
    await assert.rejects(repo.createReservation(actor,{...reservation,id:randomUUID()},proof),/duplicate key/);
    await assert.rejects(repo.createReservation(actor,{...reservation,id:randomUUID(),currency:'JPY'},proof),/currency mismatch/);
    await assert.rejects(repo.createInvoice(actor,invoice,{}),/evidence required/);
    await assert.rejects(withTransaction(client,async tx=>{
      await tx.query("SELECT set_config('app.organization_id',$1,true)",[org]);
      await tx.query("INSERT INTO app.ledger_invoices(organization_id,currency,allocated_minor,incurred_minor,paid_minor) VALUES($1,'USD',1,0,0)",[org]);
    }),/evidence does not reconcile/);
    await assert.rejects(withTransaction(client,async tx=>{
      await tx.query("SELECT set_config('app.organization_id',$1,true)",[org]);
      await tx.query("UPDATE app.ledger_invoices SET incurred_minor=81 WHERE id=$1",[invoiceId]);
    }),/immutable/);
    await assert.rejects(db.query('TRUNCATE app.ledger_fact_postings'),/immutable/);
    // New unused evidence: wrong amount and wrong account kind are denied at COMMIT.
    const mismatch={...journal,id:randomUUID(),idempotencyKey:'synthetic-mismatch',postings:[{accountId:allocated.id,amountMinor:'7'},{accountId:cash.id,amountMinor:'-7'}]};
    await repo.postJournal(actor,mismatch);
    const invoiceCount=financial.records.length;
    await assert.rejects(repo.createInvoice(actor,{currency:'USD',allocatedMinor:'8',incurredMinor:'0',paidMinor:'0'},{allocated:{journalId:mismatch.id,accountId:allocated.id}}),/amount or account kind mismatch/);
    await assert.rejects(repo.createInvoice(actor,{currency:'USD',allocatedMinor:'0',incurredMinor:'7',paidMinor:'0'},{incurred:{journalId:mismatch.id,accountId:allocated.id}}),/amount or account kind mismatch/);
    assert.equal((await repo.financialRecords(actor)).records.length,invoiceCount);
    await assert.rejects(withTransaction(client,async tx=>{await tx.query("SELECT set_config('app.organization_id',$1,true)",[org]);await tx.query("UPDATE app.budget_accounts SET kind='paid' WHERE id=$1",[cash.id]);}),/immutable/);
    await withTransaction(client,async tx=>{await tx.query("SELECT set_config('app.organization_id',$1,true)",[other]);assert.equal((await tx.query("SELECT id FROM app.ledger_journals WHERE id=$1",[journal.id])).rows.length,0);});
    await db.exec('RESET ROLE');await db.exec(await readFile(new URL('0011_money_ledger.down.sql',dir),'utf8'));
    assert.equal((await db.query("SELECT to_regclass('app.ledger_journals') AS name")).rows[0].name,null);
  }finally{await db.close();}
});

