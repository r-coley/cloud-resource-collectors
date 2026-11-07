import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {collectAws,validateAwsConfig,runAwsCli} from '../src/aws-collector.js';
import {awsSpecs,awsDetails} from '../src/aws-specs.js';
import {normaliseAws} from '../src/aws-normalise.js';
import {validateCloudInventory} from '../src/validate-cloud-inventory.js';
import {inventoryReport} from '../src/inventory-report.js';
import {main} from '../aws-discover.js';
const load=async name=>JSON.parse(await fs.readFile(new URL('../examples/'+name,import.meta.url)));
const fixture=await load('aws-service.inventory.json'),config=await load('aws-service.config.json');
const account=config.accounts[0],region=account.regions[0],single={...config,accounts:[{...account,regions:[region]}]};
const identity={Account:account.id,Arn:`arn:aws:sts::${account.id}:assumed-role/read-only/example`};
const empty=({service,operation})=>service==='sts'?identity:{[(awsSpecs.find(s=>s.service===service&&s.operation===operation)??awsDetails.find(s=>s.operation===operation)).result]:[]};
const opts=run=>({run,now:()=>fixture.startedAt,sleep:async()=>{}});
const build=(f=fixture,c=config)=>normaliseAws(f,c,{origin:'synthetic'});
test('AWS pagination handles native NextToken, Marker and PaginationToken without losing observations',async()=>{
 const calls=[];const inv=await collectAws(single,opts(async args=>{calls.push(args);const token=args.input.NextToken??args.input.Marker??args.input.PaginationToken;
  if(args.operation==='describe-instances')return token?{Reservations:[{Instances:[{InstanceId:'i-last'}]}]}:{Reservations:[{Instances:Array.from({length:1000},(_,i)=>({InstanceId:'i-'+i}))}],NextToken:'page2'};
  if(args.operation==='describe-db-clusters')return {DBClusters:[],...(!token?{Marker:'rds-next'}:{})};
  if(args.operation==='describe-load-balancers')return {LoadBalancers:[],...(!token?{NextMarker:'elb-next'}:{})};
  if(args.operation==='get-resources')return {ResourceTagMappingList:[],PaginationToken:token?'':'tags-next'};
  return empty(args);
 }));assert.equal(inv.records.length,1001);assert.ok(inv.collections.every(c=>c.paginationComplete));
 assert.ok(calls.some(c=>c.input.Marker==='rds-next'));assert.ok(calls.some(c=>c.input.Marker==='elb-next'));assert.ok(calls.some(c=>c.input.PaginationToken==='tags-next'));assert.ok(calls.every(c=>c.account.id===account.id&&c.region===region));
});
test('AWS account identity is verified before any resource queries',async()=>{
 const calls=[];await assert.rejects(collectAws(single,opts(async args=>{calls.push(args);return {...identity,Account:'999900001111'};})),/differs/);assert.deepEqual(calls.map(c=>c.operation),['get-caller-identity']);
 await assert.rejects(collectAws(single,opts(async()=>({...identity,Arn:identity.Arn.replace('arn:aws:','arn:aws-cn:')}))),/differs/);
});
test('invalid AWS account/region/profile scopes and mutation operations are rejected',async()=>{
 for(const mutate of [c=>c.accounts=[],c=>c.accounts[0].id='bad',c=>c.accounts[0].regions=['cn-north-1'],c=>c.accounts[0].profile='--endpoint-url',c=>c.accounts.push(c.accounts[0]),c=>c.services.push(c.services[0])]){const c=structuredClone(single);mutate(c);assert.throws(()=>validateAwsConfig(c));}
 await assert.rejects(runAwsCli({account,region,service:'ec2',operation:'terminate-instances'}),/Unsupported/);
});
test('AWS throttling retries are bounded and denied collection retains other APIs',async()=>{
 let count=0;const delays=[];const inv=await collectAws(single,{...opts(async args=>{
  if(args.operation==='describe-instances'&&count++<2)throw Object.assign(new Error('secret provider error'),{code:'Throttling'});
  if(args.operation==='describe-db-instances')throw Object.assign(new Error('secret provider error'),{code:'AccessDeniedException'});return empty(args);
 }),sleep:async n=>delays.push(n)});
 assert.deepEqual(delays,[250,500]);assert.equal(inv.collections.find(c=>c.source==='rds:describe-db-instances').status,'denied');assert.ok(!JSON.stringify(inv).includes('secret provider error'));
 assert.ok(build(inv,single).services.every(s=>s.gaps.some(g=>g.code==='partial-collection')));
});
test('repeated tokens, page limits and malformed results never establish complete coverage',async()=>{
 for(const result of [{Reservations:[],NextToken:'loop'},{Reservations:'bad'}, {Reservations:[{}]}]){const inv=await collectAws(single,opts(async a=>a.operation==='describe-instances'?result:empty(a)));assert.equal(inv.collections.find(c=>c.source==='ec2:describe-instances').paginationComplete,false);}
 const inv=await collectAws(single,{...opts(async a=>a.operation==='describe-instances'?{Reservations:[],NextToken:'next'}:empty(a)),maxPages:1});assert.equal(inv.collections.find(c=>c.source==='ec2:describe-instances').errorCode,'PageLimit');
});
test('AWS service fixture conforms to the same neutral schema and preserves evidence pointers',()=>{
 const s=build();assert.equal(validateCloudInventory(s),true);assert.deepEqual(s,build());assert.equal(s.services.length,3);assert.equal(s.scopes[0].provider,'aws');assert.equal(s.simulationReady,false);
 assert.ok(!s.services.some(x=>x.gaps.some(g=>g.code==='partial-collection')));
 const groups=s.resources.filter(r=>r.kind==='compute-group');assert.deepEqual(groups.map(r=>r.facts.find(f=>f.name==='DesiredCapacity').value).sort((a,b)=>a-b),[2,6]);
 assert.equal(s.resources.filter(r=>r.kind==='compute').length,8);
 assert.ok(s.resources.some(r=>r.kind==='routing-pool'&&r.facts.find(f=>f.name==='HealthCheckPath').value==='/ready'));
 assert.ok(s.resources.some(r=>r.kind==='database-cluster'&&r.facts.find(f=>f.name==='BackupRetentionPeriod').value===7));
 assert.ok(s.resources.some(r=>r.kind==='replication-policy'&&r.region===null));
});
test('service ownership is exact-case AWS tagging; untagged and unsupported resources remain explicit',()=>{
 const s=build(),payments=s.services.find(s=>s.id==='DEMO-SERVICE-A');assert.ok(payments.memberships.some(m=>m.role==='shared-or-untagged-dependency'));
 assert.ok(s.services.find(s=>s.id==='DEMO-SERVICE-B').gaps.some(g=>g.code==='uninterpreted-types'));
 assert.equal(s.services.find(s=>s.id==='DEMO-SERVICE-C').memberships.length,0);
 assert.ok(s.services.every(s=>s.gaps.some(g=>g.code==='transaction-capacity')));
 const f=structuredClone(fixture);for(const r of f.records)for(const t of r.configuration.Tags??r.configuration.TagList??[])if(t.Key==='serviceId')t.Key='ServiceId';assert.ok(build(f).services.every(s=>s.memberships.length===0));
});
test('native ARN case and cross-region global cluster relationships survive grouping',()=>{
 const f=structuredClone(fixture);const tagged=f.records.find(r=>r.nativeType==='tagged-resource'&&r.nativeId.includes('function:'));tagged.nativeId=tagged.nativeId.replace('balances','Balances');tagged.configuration.ResourceARN=tagged.nativeId;
 const s=build(f);assert.ok(s.resources.some(r=>r.nativeId.endsWith('function:Balances')&&r.key.endsWith('function:Balances')));
 const global=s.resources.find(r=>r.kind==='replication-policy');const targets=s.relationships.filter(e=>e.from===global.key);assert.equal(targets.length,2);assert.ok(targets.every(e=>e.target.resolution==='exact-resource'));
});
test('scope mismatch, foreign-account ARN and duplicate collection IDs are rejected',()=>{
 for(const mutate of [f=>f.accounts[0].id='999900001111',f=>f.records[0].nativeId=f.records[0].nativeId.replace(account.id,'999900001111'),f=>f.collections.push(f.collections[0])]){const f=structuredClone(fixture);mutate(f);assert.throws(()=>build(f));}
});
test('unknown values, bounded dependencies and source filtering survive export',()=>{
 const f=structuredClone(fixture);const group=f.records.find(r=>r.nativeType==='AWS::AutoScaling::AutoScalingGroup');group.configuration.TargetGroupARNs.push(`arn:aws:elasticloadbalancing:${region}:${account.id}:targetgroup/missing/unknown`);group.configuration.UserData='do-not-export';
 const s=build(f,{...config,maxDependenciesPerService:1,maxDependencyDepth:0});assert.equal(validateCloudInventory(s),true);assert.ok(!JSON.stringify(s).includes('do-not-export'));
 assert.ok(s.services.find(s=>s.id==='DEMO-SERVICE-A').gaps.some(g=>g.code==='dependency-limit'));assert.ok(s.relationships.some(e=>e.target.resolution==='unresolved'));
 assert.ok(s.resources.some(r=>r.facts.some(f=>f.status==='unknown'&&f.value===null)));
});
test('conflicting tag observations do not silently assign service ownership',()=>{
 const f=structuredClone(fixture);const r=f.records.find(r=>r.nativeType==='AWS::AutoScaling::AutoScalingGroup');const duplicate=structuredClone(r);duplicate.configuration.Tags=[{Key:'serviceId',Value:'OTHER-SERVICE'}];f.records.push(duplicate);
 const s=build(f);assert.ok(s.services.some(s=>s.gaps.some(g=>g.code==='conflicting-observations')));assert.ok(!s.services.find(s=>s.id==='DEMO-SERVICE-A').memberships.some(m=>m.role==='owned'&&m.resourceKey.endsWith(r.nativeId)));
});
test('semantic validation rejects broken graph links and source evidence',()=>{
 for(const mutate of [s=>s.resources[0].evidenceIds=['missing'],s=>s.relationships[0].from='missing',s=>s.resources.find(r=>r.facts.some(f=>f.status==='observed')).facts.find(f=>f.status==='observed').value='wrong']){const s=build();mutate(s);assert.throws(()=>validateCloudInventory(s));}
});
test('AWS CLI offline mode writes valid estate and service JSON; partial coverage returns status 2',async()=>{
 const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'collectors-aws-test-'));try{
  const configPath=path.join(tmp,'config.json'),input=path.join(tmp,'inventory.json'),output=path.join(tmp,'export');await fs.writeFile(configPath,JSON.stringify(config));await fs.writeFile(input,JSON.stringify(fixture));
  assert.equal(await main(['--config',configPath,'--inventory',input,'--output',output]),0);
  assert.equal(validateCloudInventory(JSON.parse(await fs.readFile(path.join(output,'cloud-inventory.json')))),true);
  for(const file of await fs.readdir(path.join(output,'services')))assert.equal(validateCloudInventory(JSON.parse(await fs.readFile(path.join(output,'services',file)))),true);
  await assert.rejects(main(['--config',configPath,'--inventory',input,'--output',output]));
  const partial=structuredClone(fixture);partial.collections[0].paginationComplete=false;await fs.writeFile(input,JSON.stringify(partial));assert.equal(await main(['--config',configPath,'--inventory',input,'--output',path.join(tmp,'partial')]),2);
 }finally{await fs.rm(tmp,{recursive:true,force:true});}
});

test('AWS review report escapes provider-controlled text and labels synthetic results',()=>{
 const s=build();s.services[0].name='<script>unsafe</script>';s.resources[0].name='<img src=x onerror=unsafe>';const html=inventoryReport(s);assert.ok(!html.includes('<script>unsafe'));assert.ok(!html.includes('<img src=x'));assert.ok(html.includes('&lt;script&gt;'));assert.ok(html.includes('Synthetic example'));
});
test('omitted child queries remain incomplete even when every remaining query succeeded',()=>{
 const f=structuredClone(fixture);f.collections=f.collections.filter(c=>c.source!=='elbv2:describe-listeners');f.records=f.records.filter(r=>r.nativeType!=='AWS::ElasticLoadBalancingV2::Listener');const s=build(f);assert.ok(s.collections.some(c=>c.errorCode==='NotCollected'));assert.ok(s.services.every(s=>s.gaps.some(g=>g.code==='partial-collection')));
});
