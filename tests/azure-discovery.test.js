import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {collectAzure,redact} from '../src/azure-collector.js';
import {normaliseAzure,canonicalId} from '../src/normalise.js';
import {discoveryReport} from '../src/report.js';
const load=name=>JSON.parse(fs.readFileSync(new URL('../examples/'+name,import.meta.url)));
const fixture=load('azure-service.inventory.json'),config=load('azure-service.config.json'),subscription=config.subscriptions[0];
const options={tagKey:config.serviceTagKey,catalogue:config.services};
const response=(data,status=200,headers={})=>({ok:status===200,status,headers:new Headers(headers),json:async()=>data});
const requestOptions=fetchImpl=>({subscriptions:[subscription],getToken:async()=> 'test-token',fetchImpl,concurrency:1,now:()=>fixture.startedAt,sleep:async()=>{}});
test('Azure inventory paginates past 1000 resources using continuation tokens',async()=>{
 const calls=[];const result=await collectAzure(requestOptions(async(url,opts)=>{
  const body=JSON.parse(opts.body);calls.push({url,opts,body});
  if(body.query.startsWith('ResourceContainers'))return response({data:[],resultTruncated:'false'});
  if(!body.options.$skipToken)return response({data:Array.from({length:1000},(_,i)=>({id:`/subscriptions/${subscription}/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm-${i}`})),$skipToken:'second',resultTruncated:'true'});
  return response({data:[{id:`/subscriptions/${subscription}/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/last`}],resultTruncated:'false'});
 }));
 assert.equal(result.records.length,1001);assert.ok(result.collections.every(c=>c.paginationComplete));assert.equal(calls[1].body.options.$skipToken,'second');
 assert.ok(calls.every(c=>c.opts.method==='POST'&&c.body.subscriptions[0]===subscription&&c.body.query.endsWith('order by id asc')));
 assert.ok(calls.every(c=>c.url.startsWith('https://management.azure.com/providers/Microsoft.ResourceGraph/resources?')));
 assert.ok(!JSON.stringify(result).includes('test-token'));
});
test('Azure throttling is retried, while partial permission failures retain collected evidence',async()=>{
 let calls=0,sleeps=[];
 const result=await collectAzure({...requestOptions(async(url,opts)=>{
  if(JSON.parse(opts.body).query.startsWith('ResourceContainers'))return response({},403);
  if(calls++===0)return response({},429,{'retry-after':'2'});
  return response({data:[fixture.records[0].resource],resultTruncated:false});
 }),sleep:async ms=>sleeps.push(ms)});
 assert.deepEqual(sleeps,[2000]);assert.equal(result.records.length,1);
 assert.equal(result.collections.find(c=>c.table==='ResourceContainers').status,'partial');
 const estate=normaliseAzure(result,options);assert.ok(estate.services.every(s=>s.collectionStatus==='partial'));assert.ok(estate.services[0].unknowns.some(u=>u.code==='partial-collection'));
});
test('truncated and repeating pages never count as complete collections',async()=>{
 for(const result of [{data:[],resultTruncated:true},{data:[],$skipToken:'loop',resultTruncated:true}]){
  const inventory=await collectAzure(requestOptions(async()=>response(result)));
  assert.ok(inventory.collections.every(c=>!c.paginationComplete&&c.status==='partial'));
 }
});
test('subscription scopes are explicit and invalid scope never sends a request',async()=>{
 let calls=0;for(const subscriptions of [[],['not-an-id'],[subscription,subscription]])await assert.rejects(collectAzure({...requestOptions(async()=>{calls++;}),subscriptions}));assert.equal(calls,0);
});
test('transport errors cannot leak tokens or provider response bodies into inventory',async()=>{
 const inv=await collectAzure(requestOptions(async()=>{throw new Error('test-token secret details');}));
 assert.ok(inv.collections.every(c=>c.status==='partial'));assert.ok(!JSON.stringify(inv).includes('test-token'));
 assert.equal(redact({properties:{administratorLoginPassword:'secret',customData:'secret',profiles:[{clientSecret:'secret'}]}}).properties.profiles[0].clientSecret,'[REDACTED]');
});
test('tagged service ownership, shared dependencies and SQL policy references stay distinct',()=>{
 const estate=normaliseAzure(fixture,options);assert.equal(estate.services.length,3);
 const p=estate.services.find(s=>s.id==='DEMO-SERVICE-A'),b=estate.services.find(s=>s.id==='DEMO-SERVICE-B');
 assert.ok(p.resources.some(r=>r.kind==='scaling-policy'&&r.membership==='shared-or-untagged-dependency'));
 assert.ok(p.resources.some(r=>r.kind==='replication-policy'));
 assert.ok(p.resources.some(r=>r.kind==='backup-policy'));
 assert.ok(p.resources.some(r=>r.kind==='allocation-reservation'&&r.membership!=='owned'));
 assert.equal(b.resources.find(r=>r.kind==='application-host').membership,'owned');
 assert.equal(b.resources.find(r=>r.kind==='compute-group').membership,'shared-or-untagged-dependency');
 assert.ok(p.resources.every(r=>r.id===canonicalId(r.id)));
 const scale=p.resources.find(r=>r.name==='payments-primary');assert.deepEqual(scale.zones,['1','2']);
 assert.equal(scale.facts.find(f=>f.name==='sku.capacity').value,6);
 const sql=p.resources.find(r=>r.kind==='replication-policy');assert.equal(sql.facts.find(f=>f.name==='properties.readWriteEndpoint').value.failoverPolicy,'Automatic');
 assert.ok(estate.evidence.every(e=>e.observedAt));assert.equal(p.simulationReady,false);
});
test('unknown placement, unsupported types and absent tagged services are never resilience passes',()=>{
 const e=normaliseAzure(fixture,options),p=e.services.find(s=>s.id==='DEMO-SERVICE-A');
 const r=p.resources.find(r=>r.name==='payments-recovery');assert.equal(r.zones,null);assert.match(r.zoneInterpretation,/unknown/);
 assert.ok(p.unknowns.some(u=>u.code==='uninterpreted-types'));
 assert.ok(e.services.find(s=>s.id==='DEMO-SERVICE-C').unknowns.some(u=>u.code==='no-tagged-resources'));
 assert.ok(p.resources.find(r=>r.kind==='database').facts.some(f=>f.status==='unknown'));
});
test('dependency traversal is bounded and unresolved references retain provenance',()=>{
 const e=normaliseAzure(fixture,{...options,maxDependencyDepth:0,maxDependenciesPerService:1}),p=e.services.find(s=>s.id==='DEMO-SERVICE-A');
 assert.ok(p.unknowns.some(u=>u.code==='dependency-limit'));
 assert.ok(p.relationships.every(e=>e.evidence.id&&e.evidence.path));
 const f=structuredClone(fixture);f.records[0].resource.properties.missing={id:`/subscriptions/${subscription}/resourceGroups/missing/providers/Microsoft.KeyVault/vaults/key`};
 assert.ok(normaliseAzure(f,options).services.find(s=>s.id==='DEMO-SERVICE-A').unknowns.some(u=>u.code==='unresolved-references'));
});
test('duplicate observations, conflicting tags and unrecognised service IDs are visible',()=>{
 const f=structuredClone(fixture);f.records.push(f.records[0]);f.records[1].resource.tags={serviceId:'A',SERVICEID:'B'};f.records[2].resource.tags={serviceId:'UNKNOWN-SERVICE'};
 const e=normaliseAzure(f,options);assert.ok(e.warnings.some(w=>w.code==='duplicate-resource'));assert.ok(e.warnings.some(w=>w.code==='ambiguous-service-tag'));
 assert.equal(e.services.find(s=>s.id==='UNKNOWN-SERVICE').catalogueStatus,'not-in-catalogue');
});
test('review report escapes arbitrary provider names and contains no assumed throughput',()=>{
 const e=normaliseAzure(fixture,options);e.services[0].name='<script>alert(1)</script>';
 const html=discoveryReport(e);assert.ok(!html.includes('<script>alert(1)'));assert.ok(html.includes('&lt;script&gt;'));assert.ok(html.includes('not a resilience score or simulation'));assert.ok(!html.includes('100 checkouts/s'));
});
test('estate grouping supports 4000 tagged services without a query per service',()=>{
 const f=structuredClone(fixture);f.records=Array.from({length:4000},(_,i)=>({...f.records[0],resource:{...f.records[0].resource,id:f.records[0].resource.id+'-'+i,tags:{serviceId:'DEMO-'+i},properties:{}}}));
 const e=normaliseAzure(f);assert.equal(e.services.length,4000);assert.equal(e.evidence.length,4000);assert.ok(e.services.every(s=>s.resources.length===1));
});
