import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileFinancialRecords} from '../packages/database/dist/index.js';
const make=(id='invoice')=>({id,kind:'invoice',currency:'USD',amounts:{allocated:'9007199254740993',incurred:'8',paid:'5'},evidence:[
 {phase:'allocated',journalId:'j1',accountId:'a1',amountMinor:'9007199254740993',currency:'USD',accountKind:'allocated'},
 {phase:'incurred',journalId:'j2',accountId:'a2',amountMinor:'8',currency:'USD',accountKind:'incurred'},
 {phase:'paid',journalId:'j3',accountId:'a3',amountMinor:'5',currency:'USD',accountKind:'paid'}]});
test('reconciliation retains exact amounts and separates currencies and phases',()=>{
 const reserve={id:'reserve',kind:'reservation',currency:'JPY',accountId:'a4',amounts:{reserved:'17'},evidence:[{phase:'reserved',journalId:'j4',accountId:'a4',amountMinor:'17',currency:'JPY',accountKind:'reserved'}]};
 assert.deepEqual(reconcileFinancialRecords([make(),reserve]),{USD:{allocated:'9007199254740993',incurred:'8',paid:'5'},JPY:{reserved:'17'}});
 assert.deepEqual(reconcileFinancialRecords([{id:'zero',kind:'invoice',currency:'USD',amounts:{allocated:'0',incurred:'0',paid:'0'},evidence:[]}]),{USD:{allocated:'0',incurred:'0',paid:'0'}});
});
test('missing, duplicate, mismatched and reused supporting evidence fails closed',()=>{
 for(const change of [r=>r.evidence.pop(),r=>r.evidence.push(r.evidence[0]),r=>r.evidence[0].amountMinor='7',r=>r.evidence[0].currency='EUR',r=>r.evidence[0].accountKind='cash',r=>r.amounts.extra='1',r=>r.amounts.allocated='1.1']){
  const record=make();change(record);assert.throws(()=>reconcileFinancialRecords([record]));
 }
 assert.throws(()=>reconcileFinancialRecords([make(),make()]),/Duplicate/);
 assert.throws(()=>reconcileFinancialRecords([make(),make('different')]),/does not reconcile/);
 const record=make();record.amounts.paid='9';assert.throws(()=>reconcileFinancialRecords([record]),/exceed/);
});
test('reservation requires positive exact evidence bound to its account',()=>{
 const record={id:'r',kind:'reservation',currency:'USD',accountId:'expected',amounts:{reserved:'10'},evidence:[{phase:'reserved',journalId:'j',accountId:'other',amountMinor:'10',currency:'USD',accountKind:'reserved'}]};
 assert.throws(()=>reconcileFinancialRecords([record]),/does not reconcile/);
 record.accountId='other';assert.deepEqual(reconcileFinancialRecords([record]),{USD:{reserved:'10'}});
 record.amounts.reserved='0';assert.throws(()=>reconcileFinancialRecords([record]),/Invalid reservation/);
});
