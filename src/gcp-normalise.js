import {createHash} from 'node:crypto';
import {gcpSpecs,gcpFields,kindForType} from './gcp-specs.js';
import {validateGcpConfig,canonicalGcpId,gcpLocation,redactGcp} from './gcp-collector.js';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const get=(obj,path)=>path.split('.').reduce((v,k)=>v?.[k],obj);
const pointer=path=>'/configuration/'+path.split('.').map(s=>s.replace(/~/g,'~0').replace(/\//g,'~1')).join('/');
export function normaliseGcp(inventory,config,{origin='provided',includeAllResources=false}={}){
 validateGcpConfig(config);if(inventory?.inventoryVersion!=='gcp-api-inventory/0.1'||inventory.provider!=='gcp'||!Array.isArray(inventory.records)||!Array.isArray(inventory.collections)||!Array.isArray(inventory.projects))throw new Error('Expected a GCP inventory');
 if(inventory.projects.length!==config.projects.length||new Set(inventory.projects.map(p=>p.id)).size!==inventory.projects.length||new Set(inventory.projects.map(p=>p.number)).size!==inventory.projects.length)throw new Error('Project scope mismatch');
 for(const p of inventory.projects){const expected=config.projects.find(e=>e.id===p.id);if(!expected||!/^\d{6,20}$/.test(p.number)||(expected.number&&expected.number!==p.number)||JSON.stringify([...p.regions].sort())!==JSON.stringify([...expected.regions].sort()))throw new Error('Project scope mismatch');}
 const scopeId=id=>'gcp:public:'+id;
 const projectFor=name=>{const part=name.match(/\/projects\/([^/]+)/)?.[1];return inventory.projects.find(p=>p.id===part||p.number===part);};
 const identity=(name,project)=>{const p=projectFor(name);return p?name.replace(/\/projects\/[^/]+/,'/projects/'+p.id):name;};
 const resourceKey=(name,project)=>scopeId(project.id)+':'+identity(name,project);
 const scopes=inventory.projects.map(p=>({id:scopeId(p.id),provider:'gcp',partition:'public',accountId:p.id,tenantId:null,selector:{projectNumber:p.number,regions:p.regions,serviceLabelKey:config.serviceLabelKey??'service_id',serviceLabelValues:config.serviceLabelValues??{}}}));
 const collectionMap=new Map();for(const c of inventory.collections){if(collectionMap.has(c.id)||!inventory.projects.some(p=>p.id===c.projectId))throw new Error('Invalid collection scope or identity');collectionMap.set(c.id,c);}
 const collections=inventory.collections.map(c=>({id:c.id,scopeId:scopeId(c.projectId),source:c.source+(c.parentId?':'+c.parentId:''),status:c.status,paginationComplete:c.paginationComplete,permissionCoverage:c.permissionCoverage,startedAt:c.startedAt,finishedAt:c.finishedAt,recordCount:c.recordCount,errorCode:c.errorCode}));
 const nodes=new Map(),evidence=[],conflicts=[];
 for(const [i,raw] of inventory.records.entries()){
  const r=redactGcp(raw),p=inventory.projects.find(p=>p.id===r.projectId),c=collectionMap.get(r.collectionId),name=canonicalGcpId(r.nativeId);
  if(!p||!c||c.projectId!==p.id||r.projectNumber!==p.number||!name||typeof r.nativeType!=='string'||!r.configuration||typeof r.configuration!=='object')throw new Error('Invalid GCP observation');
  const projectPart=name.match(/\/projects\/([^/]+)/)?.[1];if(projectPart&&![p.id,p.number].includes(projectPart))throw new Error('Resource outside project scope');
  const data=r.asset?r.configuration.resource?.data??{}:r.configuration,location=gcpLocation(name,data,r.asset?r.configuration.resource?.location:null);
  if(location.region&&!p.regions.includes(location.region))throw new Error('Resource outside regional scope');
  const evidenceId='evidence-'+i;evidence.push({id:evidenceId,collectionId:r.collectionId,observedAt:r.observedAt,redaction:'collector-filtered-not-guaranteed-secret-free',record:r});
  const key=resourceKey(name,p);let n=nodes.get(key);if(!n){n={key,scopeId:scopeId(p.id),nativeId:name,nativeType:r.nativeType,kind:r.kind??kindForType(r.nativeType),name:data.name??name,region:location.region,zones:null,placementMeaning:'unknown-not-proof-of-no-zone-redundancy',tags:{},facts:[],evidenceIds:[],observations:[],conflict:false};nodes.set(key,n);}
  n.evidenceIds.push(evidenceId);n.observations.push({r,data,evidenceId,p});
  const labels=data.labels??data.settings?.userLabels??{};
  for(const [key,value] of Object.entries(labels)){if(typeof value!=='string')continue;if(key in n.tags&&n.tags[key]!==value){n.conflict=true;conflicts.push({code:'conflicting-observations',message:'Conflicting labels on '+name+'; ownership remains unknown.'});}else n.tags[key]=value;}
 }
 const byName=new Map();for(const n of nodes.values())for(const o of n.observations)byName.set(identity(o.r.nativeId,o.p),n);
 const edges=[];
 for(const n of nodes.values()){
  const o=n.observations.find(o=>!o.r.asset)??n.observations[0],{r,data,evidenceId,p}=o,prefix=r.asset?'resource.data.':'';
  n.nativeType=r.nativeType;n.kind=r.kind??kindForType(r.nativeType);n.name=data.name??n.nativeId;
  const location=gcpLocation(n.nativeId,data,r.asset?r.configuration.resource?.location:null);n.region=location.region;
  const zones=[location.zone,data.secondaryGceZone,...(data.distributionPolicy?.zones??[]).map(z=>z.zone?.split('/').at(-1))].filter(z=>typeof z==='string'&&z);if(zones.length){n.zones=[...new Set(zones)];n.placementMeaning='declared-placement-not-healthy-instance-distribution';}
  n.facts=(gcpFields[r.nativeType]??[]).map(name=>({name,status:get(data,name)==null?'unknown':'observed',value:get(data,name)??null,evidenceId,sourcePointer:pointer(prefix+name)}));
  const edge=(nativeId,path,kind='configuration-reference',context=false)=>{const name=canonicalGcpId(nativeId);if(!name)return;const target=byName.get(identity(name,p));if(target?.key===n.key)return;edges.push({id:'edge-'+hash([n.key,name,evidenceId,path,kind]),from:n.key,target:{nativeId:name,resourceKey:target?.key??null,resolution:target?'exact-resource':'unresolved'},kind,assertion:'declared',evidenceId,sourcePointer:context?path:pointer(prefix+path)});};
  function refs(value,path=''){
   if(typeof value==='string'){if(canonicalGcpId(value))edge(value,path);}
   else if(Array.isArray(value))value.forEach((v,i)=>refs(v,path+'.'+i));
   else if(value&&typeof value==='object')for(const [key,v] of Object.entries(value))if(!['selfLink','zone','region','machineType','labels','userLabels','metadata'].includes(key))refs(v,path?path+'.'+key:key);
  }
  refs(data);
  if(r.nativeType==='sqladmin.googleapis.com/Instance'){
   if(data.masterInstanceName)edge('//cloudsql.googleapis.com/projects/'+p.id+'/instances/'+data.masterInstanceName,'masterInstanceName');
   for(const [i,name] of (data.replicaNames??[]).entries())edge('//cloudsql.googleapis.com/projects/'+p.id+'/instances/'+name,'replicaNames.'+i);
   if(data.failoverReplica?.name)edge('//cloudsql.googleapis.com/projects/'+p.id+'/instances/'+data.failoverReplica.name,'failoverReplica.name');
  }
  if(r.parentId)edge(r.parentId,'/parentId','contained-by',true);
 }
 const labelKey=config.serviceLabelKey??'service_id',owner=n=>{const v=n.tags[labelKey];return !n.conflict&&typeof v==='string'&&v.trim()?config.serviceLabelValues?.[v]??v:null;};
 const catalogue=new Map((config.services??[]).map(s=>[s.id,{id:s.id,name:s.name??s.id,catalogueStatus:'catalogued'}])),ownership=new Map();
 for(const n of nodes.values()){const id=owner(n);if(!id)continue;if(!ownership.has(id))ownership.set(id,[]);ownership.get(id).push(n.key);if(!catalogue.has(id))catalogue.set(id,{id,name:id,catalogueStatus:config.services?.length?'not-in-catalogue':'catalogue-not-supplied'});}
 const outgoing=new Map(),incoming=new Map();for(const e of edges){if(!outgoing.has(e.from))outgoing.set(e.from,[]);outgoing.get(e.from).push(e);if(e.target.resourceKey&&['scaling-policy','routing','routing-pool','routing-rule','health-observation'].includes(nodes.get(e.from)?.kind)){if(!incoming.has(e.target.resourceKey))incoming.set(e.target.resourceKey,[]);incoming.get(e.target.resourceKey).push(e.from);}}
 const expected=[];for(const p of inventory.projects){expected.push({projectId:p.id,source:'cloudresourcemanager:projects.get'});for(const spec of gcpSpecs)for(const region of spec.regional?p.regions:[null])expected.push({projectId:p.id,source:spec.id+(region?':'+region:'')});}
 for(const r of inventory.records)if(r.nativeType==='compute.googleapis.com/InstanceGroupManager'&&!r.asset)expected.push({projectId:r.projectId,source:'managed-instances',parentId:r.nativeId});
 for(const e of expected)if(!inventory.collections.some(c=>c.projectId===e.projectId&&c.source===e.source&&(c.parentId??null)===(e.parentId??null)))collections.push({id:'missing-'+hash(e),scopeId:scopeId(e.projectId),source:e.source+(e.parentId?':'+e.parentId:''),status:'partial',paginationComplete:false,permissionCoverage:'unverified',startedAt:inventory.startedAt,finishedAt:inventory.finishedAt,recordCount:0,errorCode:'NotCollected'});
 const partial=collections.some(c=>c.status!=='collected'||!c.paginationComplete),all=new Set(),services=[];
 for(const service of catalogue.values()){
  const owned=ownership.get(service.id)??[],ownedSet=new Set(owned),included=new Set(owned);let frontier=[...owned],limited=false;
  for(let depth=0;depth<=(config.maxDependencyDepth??2)&&frontier.length;depth++){const next=[];for(const key of frontier){const candidates=[...(incoming.get(key)??[]),...(depth<(config.maxDependencyDepth??2)?(outgoing.get(key)??[]).map(e=>e.target.resourceKey).filter(Boolean):[])];for(const target of candidates){if(included.has(target))continue;if(included.size-owned.length>=(config.maxDependenciesPerService??1000)){limited=true;continue;}included.add(target);next.push(target);}}frontier=next;}
  const gaps=[{code:'transaction-capacity',message:'Target size, machine type and SQL tier are not measured transaction capacity.'},{code:'visibility',message:'Selected APIs only; permissions and Asset Inventory freshness remain unverified.'},{code:'application-paths',message:'Configuration references are not proven application workflows.'},...conflicts];
  if(partial)gaps.push({code:'partial-collection',message:'One or more selected queries were missing, denied, unreachable or incomplete.'});
  if(!owned.length)gaps.push({code:'no-tagged-resources',message:'No visible resources carry the service label; service absence is not established.'});
  if(limited)gaps.push({code:'dependency-limit',message:'Dependency count limit reached.'});
  if([...included].some(key=>((outgoing.get(key)??[]).some(e=>e.target.resourceKey&&!included.has(e.target.resourceKey))||(incoming.get(key)??[]).some(id=>!included.has(id)))))gaps.push({code:'dependency-depth',message:'Further dependencies exist outside traversal depth.'});
  if([...included].some(key=>(outgoing.get(key)??[]).some(e=>!e.target.resourceKey)))gaps.push({code:'unresolved-references',message:'Some referenced resources were not observed.'});
  if([...included].some(key=>nodes.get(key).kind==='uninterpreted'))gaps.push({code:'uninterpreted-types',message:'Some assets have no supported configuration mapping.'});
  for(const key of included)all.add(key);
  services.push({...service,memberships:[...included].sort().map(key=>({resourceKey:key,role:ownedSet.has(key)?'owned':owner(nodes.get(key))?'external-service-dependency':'shared-or-untagged-dependency'})),gaps});
 }
 if(includeAllResources)for(const key of nodes.keys())all.add(key);
 const resources=[...all].sort().map(key=>{const {observations,conflict,...node}=nodes.get(key);return node;});
 const relationships=edges.filter(e=>all.has(e.from)).map(e=>({...e,target:e.target.resourceKey&&!all.has(e.target.resourceKey)?{...e.target,resourceKey:null,resolution:'unresolved'}:e.target}));
 const snapshot={schemaVersion:'cloud-inventory/1.0.0',snapshotId:'',origin,collector:{name:'cloud-resource-collectors/gcp',version:'0.1.0'},startedAt:inventory.startedAt,finishedAt:inventory.finishedAt,scopes,collections,services:services.sort((a,b)=>a.id.localeCompare(b.id)),resources,relationships,evidence,limitations:inventory.limitations??[],simulationReady:false};snapshot.snapshotId='sha256:'+hash({...snapshot,snapshotId:undefined});return snapshot;
}
