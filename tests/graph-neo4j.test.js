import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {openDriver,importSnapshots,readQuery} from '../graph/src/neo4j.js';
import {listProjects,projectResources,queryResilience,queryEvidence,selectProject} from '../graph/src/queries.js';

const uri=process.env.NEO4J_TEST_URI;
test('Neo4j integration: multi-cloud import, queries, history, conflicts and rollback',{skip:!uri,timeout:180000},async t=>{
 const driver=openDriver({uri,username:process.env.NEO4J_TEST_USERNAME??'neo4j',password:process.env.NEO4J_TEST_PASSWORD,database:process.env.NEO4J_TEST_DATABASE??'neo4j'}),database=process.env.NEO4J_TEST_DATABASE??'neo4j';
 const prefix='integration-'+randomUUID();
 const snapshots=await Promise.all(['azure','aws','gcp'].map(async cloud=>{const s=JSON.parse(await fs.readFile(new URL('../examples/'+cloud+'-service.cloud-inventory.json',import.meta.url)));s.snapshotId=prefix+'-'+cloud;return s;}));
 const count=async()=>Number((await readQuery(driver,database,'MATCH (n:InventoryEntity) RETURN count(n) AS count'))[0].count);
 try{
  await driver.verifyConnectivity();
  await t.test('imports the three clouds and lists project observations',async()=>{
   const results=await importSnapshots(driver,snapshots,{database,batchSize:50});assert.ok(results.every(r=>r.status==='imported'));
   const projects=(await listProjects(driver,{database})).filter(p=>p.snapshotId.startsWith(prefix));assert.equal(projects.length,snapshots.reduce((n,s)=>n+s.scopes.length,0));
   for(const s of snapshots)for(const scope of s.scopes){const result=await projectResources(driver,{database,project:scope.id,snapshot:s.snapshotId});assert.equal(result.resources.length,s.resources.filter(r=>r.scopeId===scope.id).length);}
  });
  await t.test('same files can be imported twice without duplication',async()=>{
   const before=await count();const results=await importSnapshots(driver,snapshots,{database});assert.ok(results.every(r=>r.status==='already-imported'));assert.equal(await count(),before);
  });
  await t.test('queries return facts, provenance and unverified coverage',async()=>{
   for(const s of snapshots){const report=await queryResilience(driver,{database,project:s.scopes[0].id,snapshot:s.snapshotId});assert.equal(report.assessment,'requires-review');assert.ok(report.coverage.unverifiedCollections>0);assert.ok(report.checks.some(c=>c.status==='evidence-recorded'));assert.equal(report.coverage.truncated,false);}
   const s=snapshots[0],e=s.evidence[0];const result=await queryEvidence(driver,{database,snapshot:s.snapshotId,evidenceId:e.id});assert.deepEqual(result[0].record,e.record);
  });
  await t.test('concurrent imports serialize without duplicate observations',async()=>{
   const snapshot=structuredClone(snapshots[0]);snapshot.snapshotId=prefix+'-concurrent';
   const results=await Promise.all([importSnapshots(driver,[snapshot],{database,initialize:false}),importSnapshots(driver,[snapshot],{database,initialize:false})]);
   assert.deepEqual(results.flat().map(r=>r.status).sort(),['already-imported','imported']);
   const rows=await readQuery(driver,database,'MATCH (s:Snapshot {snapshotId:$id}) RETURN count(s) AS count',{id:snapshot.snapshotId});assert.equal(rows[0].count,1);
  });
  await t.test('same ID with changed payload is rejected atomically',async()=>{
   const changed=structuredClone(snapshots[0]);changed.limitations.push('different content');const before=await count();await assert.rejects(importSnapshots(driver,[changed],{database}),/different content/);assert.equal(await count(),before);
  });
  await t.test('incomplete imports retain older resources and do not become deletions',async()=>{
   const s=structuredClone(snapshots[1]),oldCount=s.resources.length,removed=s.resources.at(-1).key;s.snapshotId=prefix+'-partial';s.startedAt='2026-11-07T13:00:00.000Z';s.finishedAt=s.startedAt;s.resources=s.resources.filter(r=>r.key!==removed);
   for(const service of s.services)service.memberships=service.memberships.filter(m=>m.resourceKey!==removed);
   s.relationships=s.relationships.filter(e=>e.from!==removed).map(e=>({...e,target:e.target.resourceKey===removed?{...e.target,resourceKey:null,resolution:'unresolved'}:e.target}));s.relationships[0].target={nativeId:'missing-in-integration',resourceKey:null,resolution:'unresolved'};s.collections[0].status='partial';s.collections[0].paginationComplete=false;
   await importSnapshots(driver,[s],{database});
   const old=await projectResources(driver,{database,project:s.scopes[0].id,snapshot:snapshots[1].snapshotId});assert.equal(old.resources.length,oldCount);
   const newer=await queryResilience(driver,{database,project:s.scopes[0].id,snapshot:s.snapshotId});assert.equal(newer.coverage.resourcesInProject,oldCount-1);assert.ok(newer.coverage.incompleteCollections>0);assert.ok(newer.coverage.unresolvedReferenceCount>0);const missing=await readQuery(driver,database,"MATCH (r:ResourceObservation {snapshotId:$id, nativeId:'missing-in-integration'}) RETURN count(r) AS count",{id:s.snapshotId});assert.equal(missing[0].count,0);
   const older=structuredClone(snapshots[1]);older.snapshotId=prefix+'-older-imported-last';older.startedAt='2026-11-07T11:00:00.000Z';older.finishedAt=older.startedAt;await importSnapshots(driver,[older],{database});
   const selected=await selectProject(driver,{database,project:s.scopes[0].id,origin:'synthetic'});assert.equal(selected.snapshotId,s.snapshotId);
  });
  await t.test('injected failure after node writes rolls back the entire snapshot',async()=>{
   const snapshot=structuredClone(snapshots[2]);snapshot.snapshotId=prefix+'-rollback';const before=await count();let failed=false;
   const wrapper={session:opts=>{const session=driver.session(opts);return {close:()=>session.close(),executeWrite:fn=>session.executeWrite(tx=>fn({run:async(query,params)=>{if(query.includes('SET n:Fact')){failed=true;throw new Error('Injected integration failure');}return tx.run(query,params);}}))};}};
   await assert.rejects(importSnapshots(wrapper,[snapshot],{database,initialize:false}),/Injected/);assert.equal(failed,true);assert.equal(await count(),before);
   const rows=await readQuery(driver,database,'MATCH (s:Snapshot {snapshotId:$id}) RETURN s.state AS state',{id:snapshot.snapshotId});assert.equal(rows.length,0);
  });
 }finally{await driver.close();}
});
