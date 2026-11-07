import {createHash} from 'node:crypto';
import {validateCloudInventory} from '../../src/validate-cloud-inventory.js';

export const GRAPH_MODEL_VERSION='cloud-resource-graph/1.0.0';
export function canonical(value){
 if(Array.isArray(value))return value.map(canonical);
 if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));
 return value;
}
export const fingerprint=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export const entityId=(kind,...parts)=>kind+':'+fingerprint(parts);

export function prepareImport(snapshot){
 validateCloudInventory(snapshot);
 const nodes=[],edges=[],snapshotNodeId=entityId('snapshot',snapshot.snapshotId);
 const add=(label,id,properties)=>{nodes.push({label,id,properties:{...properties,id}});return id;};
 const link=(type,from,to,properties={})=>edges.push({type,from,to,properties});
 const sid=snapshot.snapshotId;
 const projectIds=new Map(),resourceIds=new Map(),evidenceIds=new Map(),collectionIds=new Map();
 const resourceScopes=new Map(snapshot.resources.map(r=>[r.key,r.scopeId]));
 for(const scope of snapshot.scopes){
  const project=add('Project',entityId('project',scope.id),{scopeId:scope.id,cloud:scope.provider,partition:scope.partition,accountId:scope.accountId});
  const po=add('ProjectObservation',entityId('project-observation',sid,scope.id),{snapshotId:sid,scopeId:scope.id,tenantId:scope.tenantId,selectorJson:JSON.stringify(scope.selector),selectorHash:fingerprint(scope.selector)});
  projectIds.set(scope.id,po);link('HAS_PROJECT',snapshotNodeId,po);link('OF_PROJECT',po,project);
 }
 for(const c of snapshot.collections){
  const id=add('Collection',entityId('collection',sid,c.id),{snapshotId:sid,localId:c.id,source:c.source,status:c.status,paginationComplete:c.paginationComplete,permissionCoverage:c.permissionCoverage,startedAt:c.startedAt,finishedAt:c.finishedAt,recordCount:c.recordCount,errorCode:c.errorCode});
  collectionIds.set(c.id,id);link('HAS_COLLECTION',snapshotNodeId,id);link('IN_PROJECT',id,projectIds.get(c.scopeId));
 }
 for(const e of snapshot.evidence){
  const id=add('Evidence',entityId('evidence',sid,e.id),{snapshotId:sid,localId:e.id,observedAt:e.observedAt,redaction:e.redaction,recordJson:JSON.stringify(e.record)});
  evidenceIds.set(e.id,id);link('HAS_EVIDENCE',snapshotNodeId,id);link('FROM_COLLECTION',id,collectionIds.get(e.collectionId));
 }
 for(const r of snapshot.resources){
  const resource=add('Resource',entityId('resource',r.key),{key:r.key});
  const ro=add('ResourceObservation',entityId('resource-observation',sid,r.key),{snapshotId:sid,key:r.key,nativeId:r.nativeId,nativeType:r.nativeType,kind:r.kind,name:r.name,region:r.region,zones:r.zones??[],zonesKnown:r.zones!==null,placementMeaning:r.placementMeaning,tagsJson:JSON.stringify(r.tags)});
  resourceIds.set(r.key,ro);link('HAS_RESOURCE',snapshotNodeId,ro);link('OF_RESOURCE',ro,resource);link('IN_PROJECT',ro,projectIds.get(r.scopeId));
  for(const eid of r.evidenceIds)link('SUPPORTED_BY',ro,evidenceIds.get(eid));
  for(const [i,f] of r.facts.entries()){
   const valueType=f.value===null?'null':Array.isArray(f.value)?'array':typeof f.value;
   const fact=add('Fact',entityId('fact',sid,r.key,i),{snapshotId:sid,name:f.name,status:f.status,valueType,valueJson:JSON.stringify(f.value),valueString:typeof f.value==='string'?f.value:null,valueNumber:typeof f.value==='number'?f.value:null,valueBoolean:typeof f.value==='boolean'?f.value:null,evidenceLocalId:f.evidenceId,sourcePointer:f.sourcePointer});
   link('HAS_FACT',ro,fact);link('SUPPORTED_BY',fact,evidenceIds.get(f.evidenceId));
  }
 }
 for(const service of snapshot.services){
  const stable=add('Service',entityId('service',service.id),{serviceId:service.id});
  const so=add('ServiceObservation',entityId('service-observation',sid,service.id),{snapshotId:sid,serviceId:service.id,name:service.name,catalogueStatus:service.catalogueStatus});
  link('HAS_SERVICE',snapshotNodeId,so);link('OF_SERVICE',so,stable);
  for(const member of service.memberships)link('HAS_MEMBER',so,resourceIds.get(member.resourceKey),{role:member.role});
  for(const [i,gap] of service.gaps.entries()){
   const id=add('Gap',entityId('gap',sid,service.id,i),{snapshotId:sid,code:gap.code,message:gap.message});link('HAS_GAP',so,id);
  }
 }
 for(const e of snapshot.relationships){
  const from=resourceIds.get(e.from);
  const ref=add('ConfigurationReference',entityId('reference',sid,e.id),{snapshotId:sid,localId:e.id,kind:e.kind,assertion:e.assertion,resolution:e.target.resolution,targetNativeId:e.target.nativeId,evidenceLocalId:e.evidenceId,sourcePointer:e.sourcePointer});
  link('HAS_REFERENCE',from,ref);link('SUPPORTED_BY',ref,evidenceIds.get(e.evidenceId));
  if(e.target.resourceKey!==null){
   const target=resourceIds.get(e.target.resourceKey);link('TARGETS',ref,target);
   link(e.kind==='contained-by'?'CONTAINED_BY':'CONFIGURATION_REFERENCE',from,target,{referenceId:ref,resolution:e.target.resolution,assertion:e.assertion});
  }else{
   const target=add('UnresolvedTarget',entityId('unresolved',sid,resourceScopes.get(e.from),e.target.nativeId),{snapshotId:sid,nativeId:e.target.nativeId});
   link('POINTS_TO',ref,target);link('UNRESOLVED_REFERENCE',from,target,{referenceId:ref});
  }
 }
 const uniqueNodes=new Map();for(const n of nodes){const prior=uniqueNodes.get(n.id);if(prior&&JSON.stringify(prior)!==JSON.stringify(n))throw new Error('Conflicting graph identity');uniqueNodes.set(n.id,n);}
 const knownIds=new Set([snapshotNodeId,...uniqueNodes.keys()]);
 if(edges.some(e=>!knownIds.has(e.from)||!knownIds.has(e.to)))throw new Error('Graph plan has unresolved internal IDs');
 return {snapshotId:sid,snapshotNodeId,payloadHash:fingerprint(snapshot),snapshotProperties:{snapshotId:sid,schemaVersion:snapshot.schemaVersion,origin:snapshot.origin,collectorName:snapshot.collector.name,collectorVersion:snapshot.collector.version,startedAt:snapshot.startedAt,finishedAt:snapshot.finishedAt,limitations:snapshot.limitations,graphModelVersion:GRAPH_MODEL_VERSION},nodes:[...uniqueNodes.values()],edges};
}
