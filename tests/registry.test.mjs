import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parsePrRegistry, titleWorkUnitIds} from '../registry/pr-contract.mjs';

const raw=await readFile(new URL('../registry/prs.json',import.meta.url),'utf8');
const source=JSON.parse(raw);
const copy=()=>structuredClone(source);
const parse=x=>parsePrRegistry(JSON.stringify(x),source.repository);

test('canonical plan validates and planned unit count matches',()=>{
 const {document,items,pullRequests}=parsePrRegistry(raw,source.repository);
 assert.equal(document.plannedPrCount,items.length);
 assert.ok(items.length>100);
 assert.equal(pullRequests.length,3);
 assert.equal(items[0].sourceItemId,'DOTS-001');
 assert.equal(items[1].sourceItemId,'DOTS-002');
 assert.deepEqual(items[2].numbers,[4]);
 assert.deepEqual(items[3].numbers,[5]);
 assert.deepEqual(items[4].numbers,[7]);
 assert.deepEqual(items[5].numbers,[8]);
 assert.deepEqual(items[6].numbers,[9]);
 assert.deepEqual(items[7].numbers,[10]);
 assert.deepEqual(items[8].numbers,[11]);
 assert.deepEqual(items[9].numbers,[12]);
 assert.deepEqual(items[10].numbers,[13]);
 assert.deepEqual(items[11].numbers,[15]);
 assert.deepEqual(items[12].numbers,[16]);
 assert.deepEqual(items[13].numbers,[17]);
 assert.deepEqual(items[14].numbers,[18]);
 assert.deepEqual(items[15].numbers,[20]);
 assert.deepEqual(items[16].numbers,[21]);
 assert.deepEqual(items[17].numbers,[22]);
 assert.deepEqual(items[18].numbers,[23]);
 assert.deepEqual(items[19].numbers,[24]);
 assert.deepEqual(items[20].numbers,[25]);
 assert.deepEqual(items[21].numbers,[27]);
 assert.deepEqual(items[22].numbers,[28]);
 assert.deepEqual(items[24].numbers,[29]);
 assert.ok(items.slice(25).every(x=>x.numbers.length===0));
});

test('future PR titles use stable exact work IDs',()=>{
 assert.deepEqual(titleWorkUnitIds('DOTS-045: Finish controlled worker'),['DOTS-045']);
 assert.deepEqual(titleWorkUnitIds('Unrelated dashboard polishing'),[]);
});

test('rejects counts made up independently of actual units',()=>{
 const d=copy();d.plannedPrCount+=1;
 assert.throws(()=>parse(d),/Invalid repository identity/);
});

test('rejects invalid or duplicate IDs',()=>{
 const d=copy();d.units[3].id=d.units[2].id;
 assert.throws(()=>parse(d),/Invalid unit ID/);
});

test('rejects dependency graph cycles',()=>{
 const d=copy();d.units[0].dependsOn=[d.units[1].id];
 assert.throws(()=>parse(d),/cycle/);
});

test('rejects a missing local dependency rather than guessing',()=>{
 const d=copy();d.units[10].dependsOn=['DOTS-9999'];
 assert.throws(()=>parse(d),/Unknown local dependency/);
});

test('rejects fabricated PR observation timestamps',()=>{
 const d=copy();d.pullRequests[0].createdAt='2026-99-99T11:11:11Z';
 assert.throws(()=>parse(d),/Invalid, duplicate, or contradictory GitHub PR record/);
});

test('rejects cross-repo dependencies using this repository',()=>{
 const d=copy();d.units[15].externalDependencies=[{repository:source.repository,unitId:'DOTS-014'}];
 assert.throws(()=>parse(d),/Invalid external prerequisites|Invalid local dependencies|Invalid cross-repository dependencies/);
});

test('only real created PR numbers are linked; future work does not claim completed PRs',()=>{
 const refs=source.units.flatMap(u=>u.prs);
 assert.deepEqual(refs,[1,2,4,5,7,8,9,10,11,12,13,15,16,17,18,20,21,22,23,24,25,27,28,30,29]);
 assert.ok(source.pullRequests.find(p=>p.number===1)?.mergedAt);
 assert.ok(['open','closed'].includes(source.pullRequests.find(p=>p.number===2)?.state), 'dated snapshot may be open or closed');
});
