import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Ajv from 'ajv';
import {normaliseAzure} from '../src/normalise.js';
import {validateCloudInventory} from '../src/validate-cloud-inventory.js';
import {toCloudInventory} from '../src/cloud-inventory.js';
const read=name=>JSON.parse(fs.readFileSync(new URL('../'+name,import.meta.url)));
const schema=read('cloud-inventory.schema.json');
const validate=new Ajv({strict:true,allErrors:true}).compile(schema);
const fixture=read('examples/azure-service.inventory.json');
const config=read('examples/azure-service.config.json');
const build=inventory=>toCloudInventory(normaliseAzure(inventory,{tagKey:config.serviceTagKey,catalogue:config.services}),{origin:'synthetic'});
test('Azure fixture exports a valid cloud-neutral inventory with referential integrity',()=>{
 const snapshot=build(fixture);assert.equal(validateCloudInventory(snapshot),true);assert.ok(validate(snapshot),JSON.stringify(validate.errors));
 const keys=new Set(snapshot.resources.map(r=>r.key));assert.equal(keys.size,snapshot.resources.length);
 const evidence=new Set(snapshot.evidence.map(e=>e.id));const collections=new Set(snapshot.collections.map(c=>c.id));
 for(const service of snapshot.services)for(const m of service.memberships)assert.ok(keys.has(m.resourceKey));
 for(const e of snapshot.relationships){assert.ok(keys.has(e.from));if(e.target.resourceKey)assert.ok(keys.has(e.target.resourceKey));assert.ok(evidence.has(e.evidenceId));}
 for(const e of snapshot.evidence)assert.ok(collections.has(e.collectionId));
 for(const r of snapshot.resources)for(const f of r.facts){assert.ok(evidence.has(f.evidenceId));if(f.status==='observed'){let value=snapshot.evidence.find(e=>e.id===f.evidenceId).record;for(const part of f.sourcePointer.slice(1).split('/'))value=value[part.replace(/~1/g,'/').replace(/~0/g,'~')];assert.deepEqual(value,f.value);}}
 assert.equal(snapshot.services.find(s=>s.id==='DEMO-SERVICE-C').memberships.length,0);
 assert.ok(snapshot.services.find(s=>s.id==='DEMO-SERVICE-C').gaps.some(g=>g.code==='no-tagged-resources'));
 assert.equal(snapshot.simulationReady,false);
});
test('discovery facts preserve capacity configuration without inferring throughput',()=>{
 const snapshot=build(fixture);const groups=snapshot.resources.filter(r=>r.nativeType.toLowerCase()==='microsoft.compute/virtualmachinescalesets');
 assert.deepEqual(groups.map(r=>r.facts.find(f=>f.name==='sku.capacity').value).sort((a,b)=>a-b),[2,6]);
 assert.ok(groups.some(r=>r.zones===null));
 const fg=snapshot.resources.find(r=>r.kind==='replication-policy');assert.equal(fg.facts.find(f=>f.name==='properties.readWriteEndpoint').value.failoverPolicy,'Automatic');
 assert.equal(fg.facts.find(f=>f.name==='properties.readWriteEndpoint').value.failoverWithDataLossGracePeriodMinutes,60);
 assert.ok(snapshot.services.every(s=>s.gaps.some(g=>g.code==='transaction-capacity')));
 assert.deepEqual(build(fixture),snapshot);
});
test('partial collection and unresolved references survive export',()=>{
 const inventory=structuredClone(fixture);inventory.collections[0].paginationComplete=false;inventory.records.find(r=>r.resource.tags?.serviceId==='DEMO-SERVICE-A').resource.properties.missingDependency={id:'/subscriptions/'+inventory.subscriptions[0]+'/resourceGroups/missing/providers/Microsoft.Storage/storageAccounts/absent'};
 const snapshot=build(inventory);assert.equal(snapshot.collections[0].status,'partial');
 assert.ok(snapshot.services.every(s=>s.gaps.some(g=>g.code==='partial-collection')));
 assert.ok(snapshot.relationships.some(e=>e.target.resolution==='unresolved'&&e.target.resourceKey===null));
});
test('contract rejects unsupported versions, clouds and readiness claims',()=>{
 for(const mutate of [s=>s.schemaVersion='cloud-inventory/2.0.0',s=>s.scopes[0].provider='other',s=>s.simulationReady=true,s=>s.unrecognised=true]){const s=build(fixture);mutate(s);assert.equal(validate(s),false);}
});
