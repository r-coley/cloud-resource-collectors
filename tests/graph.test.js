import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {prepareImport,entityId} from '../graph/src/model.js';
import {writePlan,importSnapshots,connectionFromEnv} from '../graph/src/neo4j.js';
import {chooseProject,resilienceEvidence,queryLimit} from '../graph/src/queries.js';
import {main,parseGraphArgs,readSnapshots} from '../bin/cloud-graph.js';
const load=async cloud=>JSON.parse(await fs.readFile(new URL('../examples/'+cloud+'-service.cloud-inventory.json',import.meta.url)));
const fixtures=await Promise.all(['azure','aws','gcp'].map(load));

test('graph projection preserves all cloud observations, unknowns and provenance',()=>{
 for(const snapshot of fixtures){
  const plan=prepareImport(snapshot),nodes=plan.nodes;
  assert.equal(nodes.filter(n=>n.label==='ResourceObservation').length,snapshot.resources.length);
  assert.equal(nodes.filter(n=>n.label==='Fact').length,snapshot.resources.reduce((n,r)=>n+r.facts.length,0));
  assert.equal(nodes.filter(n=>n.label==='Evidence').length,snapshot.evidence.length);
  assert.equal(nodes.filter(n=>n.label==='ConfigurationReference').length,snapshot.relationships.length);
  for(const node of nodes.filter(n=>n.label==='Fact'))if(node.properties.status==='unknown'){assert.equal(node.properties.valueJson,'null');assert.equal(node.properties.valueBoolean,null);}
  assert.ok(nodes.some(n=>n.label==='ResourceObservation'&&!n.properties.zonesKnown));
  assert.ok(nodes.filter(n=>n.label==='Evidence').every(n=>JSON.parse(n.properties.recordJson)));
  const ids=new Set([plan.snapshotNodeId,...nodes.map(n=>n.id)]);assert.ok(plan.edges.every(e=>ids.has(e.from)&&ids.has(e.to)));
 }
});
test('reimports have stable graph IDs while new snapshots retain separate observations',()=>{
 const first=prepareImport(fixtures[0]);assert.deepEqual(first,prepareImport(structuredClone(fixtures[0])));
 const changed=structuredClone(fixtures[0]);changed.snapshotId+='-later';const later=prepareImport(changed);
 const ids=(p,label)=>p.nodes.filter(n=>n.label===label).map(n=>n.id);
 assert.deepEqual(ids(first,'Resource'),ids(later,'Resource'));assert.deepEqual(ids(first,'Project'),ids(later,'Project'));
 assert.ok(ids(first,'ResourceObservation').every(id=>!ids(later,'ResourceObservation').includes(id)));
 const reordered=Object.fromEntries(Object.entries(fixtures[0]).reverse());assert.equal(prepareImport(reordered).payloadHash,first.payloadHash);
});
test('unresolved references become reference targets, never observed resources',()=>{
 const snapshot=structuredClone(fixtures[0]),edge=snapshot.relationships[0];edge.target={nativeId:'unseen-provider-id',resourceKey:null,resolution:'unresolved'};
 const plan=prepareImport(snapshot);assert.ok(plan.nodes.some(n=>n.label==='UnresolvedTarget'&&n.properties.nativeId==='unseen-provider-id'));
 assert.ok(!plan.nodes.some(n=>n.label==='ResourceObservation'&&n.properties.nativeId==='unseen-provider-id'));
 const ref=entityId('reference',snapshot.snapshotId,edge.id);assert.ok(plan.edges.some(e=>e.type==='POINTS_TO'&&e.from===ref));
});
test('graph labels are fixed and all resource-controlled values are bound as parameters',async()=>{
 const snapshot=structuredClone(fixtures[0]);snapshot.resources[0].name="x') MATCH (n) DETACH DELETE n //";
 const plan=prepareImport(snapshot),calls=[];
 const tx={run:async(query,params)=>{calls.push({query,params});return {records:query.includes('MERGE (s:')?[{get:key=>({payloadHash:params.hash,importToken:params.token,state:'importing',graphModelVersion:params.properties.graphModelVersion})[key]}]:[]};}};
 assert.equal((await writePlan(tx,plan,{batchSize:7})).status,'imported');
 assert.ok(calls.every(c=>!c.query.includes('DETACH DELETE')));assert.ok(calls.some(c=>JSON.stringify(c.params).includes('DETACH DELETE')));
 const invalid=structuredClone(plan);invalid.nodes[0].label='Unsafe';await assert.rejects(writePlan(tx,invalid),/Unsupported/);
});
test('same snapshot ID with changed content is rejected before schema writes',async()=>{
 const first=structuredClone(fixtures[0]),second=structuredClone(first);second.limitations.push('changed');
 let called=false;const driver={session:()=>{called=true;throw new Error();}};
 await assert.rejects(importSnapshots(driver,[first,second]),/different content/);assert.equal(called,false);
});
test('idempotent writes skip completed snapshots and reject database conflicts',async()=>{
 const plan=prepareImport(fixtures[0]);let calls=0;
 const tx={run:async()=>{calls++;return {records:[{get:k=>({payloadHash:plan.payloadHash,importToken:'earlier-import',state:'complete',graphModelVersion:plan.snapshotProperties.graphModelVersion})[k]}]};}};
 assert.equal((await writePlan(tx,plan)).status,'already-imported');assert.equal(calls,1);
 await assert.rejects(writePlan({run:async()=>({records:[{get:k=>k==='payloadHash'?'different':null}]})},plan),/different content/);
});
test('all files validate before opening a database connection',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'graph-validation-'));try{
  const good=path.join(dir,'good.json'),bad=path.join(dir,'bad.json');await fs.writeFile(good,JSON.stringify(fixtures[0]));await fs.writeFile(bad,'{}');let connected=false;
  await assert.rejects(main(['import','--input',good,'--input',bad],{env:{NEO4J_PASSWORD:'not-used'},createDriver:()=>{connected=true;}}));assert.equal(connected,false);
  await assert.rejects(readSnapshots([dir]),/Input must be/);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('project selection uses collection time and rejects ambiguous selectors or clouds',()=>{
 const base={project:'gcp:public:demo',selectorHash:'same',origin:'live',snapshotId:'old',collectedTo:'2026-11-07T12:00:00Z'};
 assert.equal(chooseProject([base,{...base,snapshotId:'new',collectedTo:'2026-11-07T12:00:00.900Z'}]).snapshotId,'new');
 assert.throws(()=>chooseProject([base,{...base,selectorHash:'subset'}]),/selectors or origins/);
 assert.throws(()=>chooseProject([base,{...base,origin:'synthetic'}]),/selectors or origins/);
 assert.throws(()=>chooseProject([base,{...base,project:'aws:aws:demo'}]),/ambiguous/);
 assert.equal(chooseProject([base],{snapshot:'old'}).snapshotId,'old');
});
test('resilience views expose false and unknown settings without treating them as passes',()=>{
 const selected={snapshotId:'example'},resources=[{key:'a',name:'service',kind:'database',region:'example',zones:null,facts:[{name:'MultiAZ',status:'observed',value:false,evidenceId:'e',sourcePointer:'/MultiAZ'},{name:'BackupRetentionPeriod',status:'unknown',value:null,evidenceId:'e',sourcePointer:'/retention'}]}];
 const report=resilienceEvidence(selected,resources,{coverage:[{status:'denied',paginationComplete:false,permissionCoverage:'unverified'}],counts:{resourceCount:10},limit:1});
 assert.equal(report.assessment,'requires-review');assert.equal(report.coverage.truncated,true);assert.equal(report.coverage.incompleteCollections,1);
 assert.equal(report.checks.find(c=>c.id==='data-availability').items[0].facts[0].value,false);
 assert.equal(report.checks.find(c=>c.id==='backup-recovery').status,'unknown');assert.equal(report.placement[0].zones,null);
});
test('graph CLI validates commands, limits, connection schemes and credential placement',()=>{
 assert.equal(parseGraphArgs(['import','--input','a','--input','b']).options.input.length,2);
 for(const args of [['import'],['resilience'],['resources','--project','x','--limit','0'],['projects','--password','secret'],['init','--input','x'],['resilience','--project','x','--kind','compute']])assert.throws(()=>parseGraphArgs(args));
 assert.throws(()=>queryLimit(5001));assert.equal(queryLimit(3).toNumber(),3);
 assert.throws(()=>connectionFromEnv({NEO4J_PASSWORD:'secret',NEO4J_URI:'https://example'}),/Invalid/);
 assert.throws(()=>connectionFromEnv({NEO4J_PASSWORD:'secret',NEO4J_URI:'bolt://neo4j:secret@localhost:7687'}),/Invalid/);
 assert.throws(()=>connectionFromEnv({}),/NEO4J_PASSWORD/);
});
test('calendar-invalid snapshot timestamps are rejected before graph preparation',()=>{
 const snapshot=structuredClone(fixtures[0]);snapshot.finishedAt='2026-02-30T12:00:00Z';assert.throws(()=>prepareImport(snapshot));
});
