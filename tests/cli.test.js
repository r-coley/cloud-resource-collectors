import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {main,parseArgs,configFromArgs} from '../bin/cloud-collect.js';
import {collectSnapshot} from '../src/collect.js';
import {validateCloudInventory} from '../src/validate-cloud-inventory.js';
import {collectAzure} from '../src/azure-collector.js';
const read=async file=>JSON.parse(await fs.readFile(new URL('../examples/'+file,import.meta.url)));
const fixture=Object.fromEntries(await Promise.all(['azure','aws','gcp'].map(async cloud=>[cloud,{config:await read(cloud+'-service.config.json'),inventory:await read(cloud+'-service.inventory.json')}])));
function untagged(value){if(Array.isArray(value))return value.map(untagged);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!['tags','Tags','TagList','labels','userLabels'].includes(key)).map(([k,v])=>[k,untagged(v)]));return value;}
test('one cloud-neutral output includes untagged resources for every cloud without a catalogue',async()=>{
 for(const cloud of ['azure','aws','gcp']){
  const {config,inventory}=fixture[cloud];const snapshot=await collectSnapshot({cloud,config:{...config,services:[]},inventory:untagged(inventory)});
  assert.equal(validateCloudInventory(snapshot),true);assert.ok(snapshot.resources.length>0,cloud);assert.equal(snapshot.services.length,0,cloud);assert.equal(snapshot.simulationReady,false);assert.equal(snapshot.origin,'synthetic');
 }
});
test('the Azure JSON contains multiple requested subscriptions without requiring service tags',async()=>{
 const {inventory,config}=structuredClone(fixture.azure),second='22222222-2222-4222-8222-222222222222',first=config.subscriptions[0];
 const extra=JSON.parse(JSON.stringify(inventory).replaceAll(first,second));inventory.subscriptions.push(second);config.subscriptions.push(second);inventory.records.push(...extra.records);inventory.collections.push(...extra.collections);
 const snapshot=await collectSnapshot({cloud:'azure',config,inventory});assert.equal(snapshot.scopes.length,2);assert.ok(snapshot.resources.some(r=>r.nativeId.includes(second)));assert.equal(validateCloudInventory(snapshot),true);
});
test('multiple AWS profiles/accounts use configuration and retain distinct scope identities',async()=>{
 const {inventory,config}=structuredClone(fixture.aws),first=config.accounts[0].id,second='444455556666';
 const extra=JSON.parse(JSON.stringify(inventory).replaceAll(first,second));for(const c of extra.collections)c.id='second-'+c.id;for(const r of extra.records)r.collectionId='second-'+r.collectionId;
 inventory.accounts.push(...extra.accounts);config.accounts.push({...config.accounts[0],id:second,profile:'second-readonly'});inventory.collections.push(...extra.collections);inventory.records.push(...extra.records);
 const snapshot=await collectSnapshot({cloud:'aws',config,inventory});assert.equal(snapshot.scopes.length,2);assert.ok(snapshot.resources.some(r=>r.key.includes(second)));assert.equal(validateCloudInventory(snapshot),true);
});
test('the unified command accepts repeated GCP project IDs and emits one valid JSON file',async()=>{
 const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'collectors-cli-'));try{
  const inventoryPath=path.join(tmp,'inventory.json'),output=path.join(tmp,'nested','resources.json');await fs.writeFile(inventoryPath,JSON.stringify(fixture.gcp.inventory));
  const args=['--cloud','gcp',...fixture.gcp.config.projects.flatMap(p=>['--project',p.id]),...fixture.gcp.config.projects[0].regions.flatMap(r=>['--region',r]),'--inventory',inventoryPath,'--output',output];
  assert.equal(await main(args,{log:()=>{}}),0);const snapshot=JSON.parse(await fs.readFile(output));assert.equal(snapshot.scopes.length,2);assert.equal(validateCloudInventory(snapshot),true);
  let called=false;await assert.rejects(main(args,{collect:async()=>{called=true;},log:()=>{}}),/already exists/);assert.equal(called,false);
 }finally{await fs.rm(tmp,{recursive:true,force:true});}
});
test('scope flags map clearly to provider configuration and reject ambiguous combinations',()=>{
 const azure=parseArgs(['--cloud','azure','--project','11111111-1111-4111-8111-111111111111','--resource-group','example-group','--output','a.json']);assert.deepEqual(configFromArgs(azure).resourceGroups,['example-group']);
 const aws=parseArgs(['--cloud','aws','--project','111122223333','--region','eu-west-2','--profile','readonly','--output','a.json']);assert.equal(configFromArgs(aws).accounts[0].profile,'readonly');
 for(const args of [[],['--cloud','gcp','--project','example-project','--output','a.json'],['--cloud','azure','--project','a','--region','eu-west-2','--output','a.json'],['--cloud','aws','--config','a.json','--project','a','--output','b.json'],['--cloud','gcp','--project','example-project','--region','europe-west2','--profile','wrong','--output','a.json']])assert.throws(()=>parseArgs(args));
});
test('Azure resource-group selection applies to the query and offline output',async()=>{
 const {config,inventory}=fixture.azure,group=inventory.records.find(r=>r.resource.id.toLowerCase().includes('/resourcegroups/')).resource.id.match(/\/resourcegroups\/([^/]+)/i)[1];
 const snapshot=await collectSnapshot({cloud:'azure',config:{...config,resourceGroups:[group]},inventory});assert.ok(snapshot.resources.length);assert.ok(snapshot.resources.every(r=>r.nativeId.toLowerCase().includes('/resourcegroups/'+group.toLowerCase()+'/')));assert.deepEqual(snapshot.scopes[0].selector.resourceGroups,[group]);
 const queries=[];await collectAzure({subscriptions:config.subscriptions,resourceGroups:[group],getToken:async()=> 'test',fetchImpl:async(url,args)=>{queries.push(JSON.parse(args.body).query);return {ok:true,json:async()=>({data:[]})};}});assert.ok(queries.every(q=>q.includes(' in~ ("'+group+'")')));
});
test('the unified command returns partial status and preserves JSON coverage',async()=>{
 const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'collectors-partial-'));try{
  const config=path.join(tmp,'config.json'),input=path.join(tmp,'input.json'),output=path.join(tmp,'result.json'),inventory=structuredClone(fixture.aws.inventory);inventory.collections[0].status='denied';inventory.collections[0].paginationComplete=false;
  await fs.writeFile(config,JSON.stringify(fixture.aws.config));await fs.writeFile(input,JSON.stringify(inventory));assert.equal(await main(['--cloud','aws','--config',config,'--inventory',input,'--output',output],{log:()=>{}}),2);
  assert.ok(JSON.parse(await fs.readFile(output)).collections.some(c=>c.status==='denied'));
 }finally{await fs.rm(tmp,{recursive:true,force:true});}
});
