import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {collectGcp,validateGcpConfig,canonicalGcpId,redactGcp} from '../src/gcp-collector.js';
import {normaliseGcp} from '../src/gcp-normalise.js';
import {validateCloudInventory} from '../src/validate-cloud-inventory.js';
import {main} from '../gcp-discover.js';
const read=async name=>JSON.parse(await fs.readFile(new URL('../examples/'+name,import.meta.url)));
const fixture=await read('gcp-service.inventory.json'),config=await read('gcp-service.config.json'),project=config.projects[0];
const single={...config,projects:[project]};
const response=(value,status=200,headers={})=>({ok:status===200,status,headers:new Headers(headers),json:async()=>value});
function empty(href){const url=new URL(href);if(url.hostname==='cloudresourcemanager.googleapis.com')return response({projectId:project.id,projectNumber:project.number,lifecycleState:'ACTIVE'});if(url.hostname==='cloudasset.googleapis.com')return response({assets:[]});return response(url.pathname.includes('/aggregated/')?{items:{}}:{items:[]});}
const options=fetchImpl=>({getToken:async()=> 'test-token',fetchImpl,sleep:async()=>{},now:()=>fixture.startedAt});
const instance=i=>({selfLink:`https://www.googleapis.com/compute/v1/projects/${project.id}/zones/europe-west2-a/instances/payments-${i}`,name:'payments-'+i,zone:'https://www.googleapis.com/compute/v1/projects/'+project.id+'/zones/europe-west2-a',labels:{service_id:'demo-service-a'}});
const build=(f=fixture,c=config)=>normaliseGcp(f,c,{origin:'synthetic'});
test('GCP aggregated and asset pagination preserve more than 1000 instances and explicit project URLs',async()=>{
 const calls=[];const inv=await collectGcp(single,options(async(href,opts)=>{calls.push({href,opts});const u=new URL(href),token=u.searchParams.get('pageToken');
  if(u.pathname.endsWith('/aggregated/instances'))return response({items:{'zones/europe-west2-a':{instances:token?[instance(1000)]:Array.from({length:1000},(_,i)=>instance(i))}},...(!token?{nextPageToken:'instances-next'}:{})});
  if(u.hostname==='cloudasset.googleapis.com')return response({assets:[],...(!token?{nextPageToken:'assets-next'}:{})});return empty(href);
 }));assert.equal(inv.records.filter(r=>r.nativeType==='compute.googleapis.com/Instance').length,1001);assert.ok(inv.collections.every(c=>c.paginationComplete));assert.ok(calls.some(c=>c.href.includes('pageToken=assets-next')));assert.ok(calls.every(c=>c.opts.redirect==='error'&&c.opts.method==='GET'));assert.ok(!JSON.stringify(inv).includes('test-token'));
});
test('project number mismatch aborts before resource collection and ignores ambient gcloud project',async()=>{
 const calls=[];await assert.rejects(collectGcp(single,options(async href=>{calls.push(href);return response({projectId:project.id,projectNumber:'999999999999'});})),/differs/);assert.equal(calls.length,1);assert.ok(calls[0].includes('/projects/'+project.id));
});
test('GCP scopes, labels and duplicate catalogue entries are validated before requests',()=>{
 for(const mutate of [c=>c.projects=[],c=>c.projects[0].id='../bad',c=>c.projects[0].number='bad',c=>c.projects[0].regions=['https://elsewhere'],c=>c.projects.push(c.projects[0]),c=>c.serviceLabelKey='serviceId',c=>c.account='--bad',c=>c.services.push(c.services[0])]){const c=structuredClone(single);mutate(c);assert.throws(()=>validateGcpConfig(c));}
});
test('GCP denied APIs and throttling remain explicit without provider error bodies or tokens',async()=>{
 let calls=0;const delays=[];const inv=await collectGcp(single,{...options(async href=>{const u=new URL(href);if(u.hostname==='cloudasset.googleapis.com')return response({error:{message:'sensitive-body'}},403);if(u.pathname.endsWith('/aggregated/instances')&&calls++===0)return response({},429,{'retry-after':'1'});return empty(href);}),sleep:async n=>delays.push(n)});
 assert.deepEqual(delays,[1000]);assert.equal(inv.collections.find(c=>c.source==='assets').status,'denied');assert.ok(!JSON.stringify(inv).includes('sensitive-body'));assert.ok(build(inv,single).services.every(s=>s.gaps.some(g=>g.code==='partial-collection')));
});
test('unreachable regions and provider warnings never count as full coverage',async()=>{
 for(const warning of [{items:{},unreachables:['europe-west2']},{items:{'zones/europe-west2-a':{warning:{code:'UNREACHABLE'}}}},{items:{},warnings:[{code:'REGION_UNREACHABLE'}]}]){const inv=await collectGcp(single,options(async href=>href.includes('/aggregated/instances')?response(warning):empty(href)));assert.equal(inv.collections.find(c=>c.source==='instances').status,'partial');}
 const inv=await collectGcp(single,options(async href=>href.includes('/aggregated/instances')?response({items:{global:{warning:{code:'NO_RESULTS_ON_PAGE'}}}}):empty(href)));assert.equal(inv.collections.find(c=>c.source==='instances').status,'collected');
});
test('GCP repeated tokens, malformed aggregates and page limits remain partial',async()=>{
 for(const value of [{items:{},nextPageToken:'loop'},{items:[]},{items:{global:{instances:'bad'}}}]){const inv=await collectGcp(single,options(async href=>href.includes('/aggregated/instances')?response(value):empty(href)));assert.equal(inv.collections.find(c=>c.source==='instances').paginationComplete,false);}
 const inv=await collectGcp(single,{...options(async href=>href.includes('/aggregated/instances')?response({items:{},nextPageToken:'next'}):empty(href)),maxPages:1});assert.equal(inv.collections.find(c=>c.source==='instances').errorCode,'PageLimit');
});
test('collector excludes out-of-scope regions and retains scoped unsupported global assets',async()=>{
 const inv=await collectGcp(single,options(async href=>{if(href.includes('/aggregated/instances'))return response({items:{'zones/us-central1-a':{instances:[{...instance(1),selfLink:instance(1).selfLink.replace('europe-west2-a','us-central1-a'),zone:'https://www.googleapis.com/compute/v1/projects/'+project.id+'/zones/us-central1-a'}]}}});if(href.startsWith('https://cloudasset.googleapis.com/'))return response({assets:[{name:'//storage.googleapis.com/example-example-bucket',assetType:'storage.googleapis.com/Bucket',resource:{location:'global',data:{name:'example-example-bucket',labels:{service_id:'demo-service-a'}}}}]});return empty(href);}));assert.ok(!inv.records.some(r=>r.nativeId.includes('us-central1')));assert.ok(inv.records.some(r=>r.nativeType==='storage.googleapis.com/Bucket'));assert.equal(validateCloudInventory(build(inv,single)),true);
});
test('managed instance membership uses only the documented read-only POST operation',async()=>{
 const group=`https://www.googleapis.com/compute/v1/projects/${project.id}/regions/europe-west2/instanceGroupManagers/payments`;
 const calls=[];const inv=await collectGcp(single,options(async(href,opts)=>{calls.push({href,opts});if(href.includes('/aggregated/instanceGroupManagers'))return response({items:{'regions/europe-west2':{instanceGroupManagers:[{selfLink:group,name:'payments',region:'https://www.googleapis.com/compute/v1/projects/'+project.id+'/regions/europe-west2'}]}}});if(href.includes('/listManagedInstances'))return response({managedInstances:[{instance:instance(0).selfLink,currentAction:'NONE',instanceStatus:'RUNNING'}]});return empty(href);}));
 const posts=calls.filter(c=>c.opts.method==='POST');assert.equal(posts.length,1);assert.ok(posts[0].href.includes('/instanceGroupManagers/payments/listManagedInstances'));assert.equal(posts[0].opts.body,'{}');assert.ok(inv.records.some(r=>r.nativeType==='collector.gcp/ManagedInstanceObservation'));
});
test('GCP service output conforms to the shared schema and maps labels explicitly',()=>{
 const s=build();assert.equal(validateCloudInventory(s),true);assert.deepEqual(build(),s);assert.equal(s.services.length,3);assert.ok(s.services.some(s=>s.id==='DEMO-SERVICE-A'&&s.memberships.length));assert.ok(!s.services.some(s=>s.id==='demo-service-a'));assert.equal(s.scopes[0].selector.projectNumber,project.number);assert.equal(s.simulationReady,false);
 assert.deepEqual(s.resources.filter(r=>r.kind==='compute-group').map(r=>r.facts.find(f=>f.name==='targetSize').value).sort((a,b)=>a-b),[2,6]);
 const db=s.resources.find(r=>r.name==='payments-primary');assert.equal(db.facts.find(f=>f.name==='settings.availabilityType').value,'REGIONAL');assert.equal(db.facts.find(f=>f.name==='settings.backupConfiguration').value.transactionLogRetentionDays,7);
 assert.ok(s.resources.some(r=>r.kind==='health-check'&&r.facts.find(f=>f.name==='httpHealthCheck').value.requestPath==='/ready'));
 assert.ok(s.services.find(s=>s.id==='DEMO-SERVICE-B').gaps.some(g=>g.code==='uninterpreted-types'));assert.equal(s.services.find(s=>s.id==='DEMO-SERVICE-C').memberships.length,0);
});
test('GCP numeric and textual project names deduplicate without losing evidence',()=>{
 const s=build();const vm=s.resources.find(r=>r.nativeId.endsWith('/instances/payments-primary-0'));assert.ok(vm.evidenceIds.length>=2);assert.equal(s.resources.filter(r=>r.key.endsWith('/instances/payments-primary-0')).length,1);assert.ok(vm.key.includes('/projects/'+project.id+'/'));
 assert.equal(canonicalGcpId('https://www.googleapis.com/compute/v1/projects/a/zones/z/instances/I'),'//compute.googleapis.com/projects/a/zones/z/instances/I');assert.equal(canonicalGcpId('http://untrusted/compute/v1/projects/a'),null);
});
test('wrong project observations and omitted detail collections cannot be silently accepted',()=>{
 const f=structuredClone(fixture);f.records[1].nativeId=f.records[1].nativeId.replace(/projects\/[^/]+/,'projects/foreign-project');assert.throws(()=>build(f));
 const missing=structuredClone(fixture);missing.collections=missing.collections.filter(c=>c.source!=='managed-instances');missing.records=missing.records.filter(r=>r.nativeType!=='collector.gcp/ManagedInstanceObservation');const s=build(missing);assert.ok(s.collections.some(c=>c.errorCode==='NotCollected'));assert.ok(s.services.every(s=>s.gaps.some(g=>g.code==='partial-collection')));
});
test('unknowns, label conflicts and dependency bounds are explicit; embedded scripts are filtered',()=>{
 const f=structuredClone(fixture),r=f.records.find(r=>r.nativeType==='compute.googleapis.com/Instance'&&!r.asset);r.configuration.metadata={items:[{key:'startup-script',value:'do-not-export'}]};r.configuration.rootPassword='do-not-export';const s=build(f,{...config,maxDependencyDepth:0,maxDependenciesPerService:0});assert.ok(!JSON.stringify(s).includes('do-not-export'));assert.ok(s.services.some(s=>s.gaps.some(g=>g.code==='dependency-limit')));assert.ok(s.resources.some(r=>r.facts.some(f=>f.status==='unknown')));
 assert.equal(redactGcp({env:[{value:'secret'}]}).env,'[REDACTED]');
 const conflict=structuredClone(fixture),asset=conflict.records.find(r=>r.asset&&r.nativeType==='compute.googleapis.com/Instance');asset.configuration.resource.data.labels.service_id='demo-service-b';assert.ok(build(conflict).services.some(s=>s.gaps.some(g=>g.code==='conflicting-observations')));
});
test('GCP offline command writes validated estate and service snapshots',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'collectors-gcp-test-'));try{const cp=path.join(root,'config.json'),ip=path.join(root,'inventory.json'),out=path.join(root,'export');await fs.writeFile(cp,JSON.stringify(config));await fs.writeFile(ip,JSON.stringify(fixture));assert.equal(await main(['--config',cp,'--inventory',ip,'--output',out]),0);assert.equal(validateCloudInventory(JSON.parse(await fs.readFile(path.join(out,'cloud-inventory.json')))),true);for(const file of await fs.readdir(path.join(out,'services')))assert.equal(validateCloudInventory(JSON.parse(await fs.readFile(path.join(out,'services',file)))),true);await assert.rejects(main(['--config',cp,'--inventory',ip,'--output',out]));const partial=structuredClone(fixture);partial.collections[1].status='denied';await fs.writeFile(ip,JSON.stringify(partial));assert.equal(await main(['--config',cp,'--inventory',ip,'--output',path.join(root,'partial')]),2);}finally{await fs.rm(root,{recursive:true,force:true});}
});
