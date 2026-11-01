import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile,readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {minor,decimalToMinor,validateInvoice,validateJournal,reconcile,LedgerRepository,withTransaction} from '../packages/database/dist/index.js';
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
    await assert.rejects(repo.postJournal(actor,{...journal,postings:[{accountId:cash.id,amountMinor:'2'},{accountId:offset.id,amountMinor:'-2'}]}),/Idempotency/);
    assert.throws(()=>validateJournal({...journal,postings:[{accountId:cash.id,amountMinor:'2'},{accountId:offset.id,amountMinor:'-1'}]},[cash,offset]),/balance/);
    await assert.rejects(repo.balances({organizationId:other,membershipId:owner}),/not authorized/);
    await assert.rejects(withTransaction(client,async tx=>{await tx.query("SELECT set_config('app.organization_id',$1,true)",[org]);await tx.query("INSERT INTO app.ledger_journals(organization_id,currency,idempotency_key,request_hash) VALUES($1,'USD','unbalanced',repeat('a',64))",[org]);}),/not balanced/);
    await assert.rejects(withTransaction(client,async tx=>{await tx.query("SELECT set_config('app.organization_id',$1,true)",[org]);await tx.query("UPDATE app.ledger_postings SET amount_minor=1 WHERE journal_id=$1",[journal.id]);}),/immutable/);
    await assert.rejects(withTransaction(client,async tx=>{await tx.query("SELECT set_config('app.organization_id',$1,true)",[org]);await tx.query("INSERT INTO app.ledger_postings(organization_id,journal_id,account_id,currency,amount_minor) VALUES($1,$2,$3,'USD',1)",[org,journal.id,cash.id]);}),/already posted/);
    await assert.rejects(db.query('TRUNCATE app.ledger_postings'),/immutable/);
    assert.ok(await repo.createInvoice(actor,{currency:'USD',allocatedMinor:'100',incurredMinor:'80',paidMinor:'20'}));
    assert.ok(await repo.createReservation(actor,{id:randomUUID(),organizationId:org,accountId:cash.id,currency:'USD',amountMinor:'20',state:'open'}));
    await assert.rejects(repo.createReservation(actor,{id:randomUUID(),organizationId:org,accountId:cash.id,currency:'JPY',amountMinor:'20',state:'open'}),/currency mismatch/);
    await assert.rejects(withTransaction(client,async tx=>{await tx.query("SELECT set_config('app.organization_id',$1,true)",[org]);await tx.query("UPDATE app.budget_accounts SET kind='paid' WHERE id=$1",[cash.id]);}),/immutable/);
    await withTransaction(client,async tx=>{await tx.query("SELECT set_config('app.organization_id',$1,true)",[other]);assert.equal((await tx.query("SELECT id FROM app.ledger_journals WHERE id=$1",[journal.id])).rows.length,0);});
    await db.exec('RESET ROLE');await db.exec(await readFile(new URL('0011_money_ledger.down.sql',dir),'utf8'));
    assert.equal((await db.query("SELECT to_regclass('app.ledger_journals') AS name")).rows[0].name,null);
  }finally{await db.close();}
});
