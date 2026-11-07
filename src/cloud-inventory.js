import {createHash} from 'node:crypto';
const hash=value=>createHash('sha256').update(value).digest('hex');
const pointer=path=>'/'+path.split('.').map(s=>s.replace(/~/g,'~0').replace(/\//g,'~1')).join('/');
// Native identity rules belong to each connector: Azure IDs are case insensitive.
const key=(scope,id)=>'azure:'+scope+':'+id.toLowerCase().replace(/\/+$/,'');
export function toCloudInventory(estate,{origin='provided'}={}){
 if(estate.discoveryVersion!=='cloud-estate-discovery/0.1'||estate.provider!=='azure')throw new Error('Expected an Azure estate snapshot');
 const scopes=estate.scope.subscriptions.map(id=>({id:'azure:'+id.toLowerCase(),provider:'azure',partition:'public',accountId:id,tenantId:null,selector:{serviceTagKey:estate.scope.tagKey}}));
 const collections=estate.collections.map((c,i)=>({id:'collection-'+i,scopeId:'azure:'+c.subscriptionId.toLowerCase(),source:c.table,status:c.status==='collected'?(c.paginationComplete?'collected':'partial'):c.status==='denied'?'denied':'failed',paginationComplete:c.paginationComplete,permissionCoverage:c.permissionCoverage??'unverified',startedAt:c.startedAt,finishedAt:c.finishedAt,recordCount:c.recordCount??0,errorCode:typeof c.error?.code==='string'?c.error.code:null}));
 const ev=new Map(estate.evidence.map(e=>[e.id,e]));
 const nodes=new Map();for(const r of estate.allResources??estate.services.flatMap(s=>s.resources))nodes.set(r.id,r);
 const resourceKey=id=>{const r=nodes.get(id),e=r&&ev.get(r.evidenceId);return e?key(e.subscriptionId.toLowerCase(),id):null;};
 const resources=[...nodes.values()].map(r=>{const e=ev.get(r.evidenceId);return {key:resourceKey(r.id),scopeId:'azure:'+e.subscriptionId.toLowerCase(),nativeId:e.record.id,nativeType:e.record.type,kind:r.kind,name:r.name,region:r.location,zones:r.zones,placementMeaning:r.zoneInterpretation,tags:e.record.tags??{},facts:r.facts.map(f=>({name:f.name,status:f.status,value:f.value,evidenceId:f.evidence.id,sourcePointer:pointer(f.evidence.path)})),evidenceIds:[r.evidenceId]};});
 const relationships=new Map();for(const e of estate.allRelationships??estate.services.flatMap(s=>s.relationships)){const edge={from:resourceKey(e.from),target:{nativeId:e.to,resourceKey:e.resolvedTo?resourceKey(e.resolvedTo):null,resolution:e.resolvedTo&&resourceKey(e.resolvedTo)?e.resolution:'unresolved'},kind:e.kind,assertion:'declared',evidenceId:e.evidence.id,sourcePointer:pointer(e.evidence.path)};const id=hash(JSON.stringify(edge));relationships.set(id,{id,...edge});}
 const evidence=estate.evidence.map(e=>{const index=estate.collections.findIndex(c=>c.subscriptionId.toLowerCase()===e.subscriptionId.toLowerCase()&&c.table===e.table);if(index<0)throw new Error('Evidence has no collection');return {id:e.id,collectionId:collections[index].id,observedAt:e.observedAt,redaction:'collector-filtered-not-guaranteed-secret-free',record:e.record};});
 const result={schemaVersion:'cloud-inventory/1.0.0',snapshotId:'',origin,collector:{name:'cloud-resource-collectors/azure',version:'0.1.0'},startedAt:estate.startedAt,finishedAt:estate.finishedAt,scopes,collections,services:estate.services.map(s=>({id:s.id,name:s.name,catalogueStatus:s.catalogueStatus,memberships:s.resources.map(r=>({resourceKey:resourceKey(r.id),role:r.membership})),gaps:s.unknowns})),resources,relationships:[...relationships.values()],evidence,limitations:estate.limitations,simulationReady:false};
 result.snapshotId='sha256:'+hash(JSON.stringify({...result,snapshotId:undefined}));return result;
}
