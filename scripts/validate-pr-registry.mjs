import assert from 'node:assert/strict';
import {readFile, stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {parsePrRegistry} from '../registry/pr-contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = async p => readFile(path.join(root, p), 'utf8');
const source = await read('registry/prs.json');
const data = JSON.parse(source);
const repo = process.env.GITHUB_REPOSITORY || data.repository;
const {document, items, pullRequests} = parsePrRegistry(source, repo);
assert.equal(document.plannedPrCount, items.length);
assert.equal(document.planVerified, true, 'approved plan must be verified for planning');
assert.equal(document.schemaVersion, 1);
assert.ok(document.sourceFiles.every(x => typeof x === 'string' && x), 'sourceFiles must be paths');

const roster = JSON.parse(await read('registry/approved-salesman-names.json'));
assert.ok(Array.isArray(roster.approvedNames) && roster.approvedNames.length >= 2);
assert.equal(new Set(roster.approvedNames).size, roster.approvedNames.length, 'approved names must be deduplicated exactly');
for(const name of ['"Fast Eddie" Felson', 'Harry Wormwood']){
 assert.ok(roster.approvedNames.includes(name), 'missing initial persona ' + name);
 assert.ok(roster.initialAgents.includes(name), 'missing initial agent designation ' + name);
}
const models = JSON.parse(await read('registry/model-catalog.json'));
assert.deepEqual(models.candidates.map(x=>x.id).sort(), ['openai','claude','grok'].sort(), 'only reviewed direct API providers are present in candidate registry');
assert.equal(models.candidates.filter(x=>x.type==='open-weight').length,0);
assert.equal(models.candidates.filter(x=>x.type==='proprietary-api').length,3);
for(const model of models.candidates){
 assert.equal(model.enabled, false, 'model ' + model.id + ' must be disabled by default');
 if(model.type==='open-weight') assert.equal(model.weightsInRepository,false);
}

const md = await read('docs/DEVELOPMENT_PLAN.md');
const headings=[...md.matchAll(/^### (DOTS-\d{3}) — (.+)$/gm)];
assert.equal(headings.length, document.units.length, 'human-readable roadmap count differs from structured registry');
const seen=new Set();
for(let i=0;i<headings.length;i++){
 const heading=headings[i],id=heading[1],unit=document.units[i];
 assert.equal(id,unit.id,'human-readable work item ordinal ' + (i+1) + ' diverges');
 assert.equal(heading[2],unit.title,'title mismatch for ' + id);
 assert.ok(!seen.has(id),'duplicate human-readable heading ' + id);
 seen.add(id);
 const body=md.slice(heading.index,headings[i+1]?.index??md.length);
 for(const [label,expected] of [
   ['scope', unit.scope?.[0]],
   ['acceptance', unit.acceptanceCriteria],
   ['dependencies',unit.dependsOn?.length ? unit.dependsOn.join(', ') : 'None'],
   ['priority',unit.priority]
 ]){
  assert.ok(typeof expected==='string' && expected.length && body.includes(expected),
    id + ' human-readable ' + label + ' diverges from registry');
 }
 if(unit.externalPrerequisites?.length) for(const value of unit.externalPrerequisites)
  assert.ok(body.includes(value), id + ' missing external prerequisite');
}
const phases=[...new Set(document.units.map(x=>x.phase))];
for(const phase of phases){
 const total=document.units.filter(x=>x.phase===phase).length;
 assert.ok(md.includes('| ' + phase + ' |'),'phase ' + phase + ' index row missing');
 assert.ok(md.includes('(' + total + ' PR-sized work units;'),'phase ' + phase + ' count mismatch');
}
assert.ok(md.includes('**No random salesman quote'), 'UI no-quote constraint missing');
assert.ok(md.includes('$0'), '$0 default operating cost not documented');
const retired=JSON.parse(await read('registry/roadmap.json'));
assert.deepEqual(retired,{repository:repo,deprecated:true,redirectTo:'registry/prs.json'});
for(const sourcePath of document.sourceFiles) await stat(path.join(root,sourcePath));
assert.deepEqual(document.units[0].prs,[1], 'architecture baseline must map actual PR #1');
assert.deepEqual(document.units[1].prs,[2], 'canonical plan must map actual PR #2');
assert.ok(pullRequests.some(x=>x.number===1 && x.mergedAt), 'missing observed merged architecture PR #1');
assert.ok(pullRequests.some(x=>x.number===2), 'missing observed plan PR #2');
const activeCount=document.units.filter(x=>x.prs.length===0).length;
console.log('Verified canonical PR plan:', repo,
  '\nPhases:', phases.length,
  '\nTotal work units:', items.length,
  '\nUnlinked planned units:', activeCount,
  '\nApproved names:',roster.approvedNames.length,
  '\nModel candidates:',models.candidates.length);
