import {redact,validateScope} from './azure-collector.js';
export const canonicalId=id=>id.toLowerCase().replace(/\/+$/,'');
const resourceId=/^\/subscriptions\/[^/]+(?:\/resourcegroups\/[^/]+(?:\/providers\/.+)?|\/providers\/.+)?$/i;
const get=(obj,path)=>path.split('.').reduce((v,k)=>v?.[k],obj);
const mappings={
 'microsoft.compute/virtualmachines':{kind:'compute',fields:['properties.hardwareProfile.vmSize','properties.priority','properties.availabilitySet.id','properties.capacityReservation.capacityReservationGroup.id']},
 'microsoft.compute/virtualmachinescalesets':{kind:'compute-group',fields:['sku.capacity','sku.name','properties.zoneBalance','properties.orchestrationMode','properties.automaticRepairsPolicy.enabled','properties.automaticRepairsPolicy.gracePeriod','properties.automaticRepairsPolicy.repairAction','properties.virtualMachineProfile.priority','properties.virtualMachineProfile.capacityReservation.capacityReservationGroup.id','properties.virtualMachineProfile.networkProfile.healthProbe.id']},
 'microsoft.insights/autoscalesettings':{kind:'scaling-policy',fields:['properties.enabled','properties.targetResourceUri','properties.profiles']},
 'microsoft.network/loadbalancers':{kind:'routing',fields:['sku.name','properties.probes','properties.loadBalancingRules','properties.backendAddressPools','properties.frontendIPConfigurations']},
 'microsoft.network/applicationgateways':{kind:'routing',fields:['properties.sku','properties.autoscaleConfiguration','properties.probes','properties.backendAddressPools','properties.requestRoutingRules']},
 'microsoft.network/trafficmanagerprofiles':{kind:'routing',fields:['properties.trafficRoutingMethod','properties.monitorConfig','properties.endpoints']},
 'microsoft.cdn/profiles':{kind:'routing',fields:['sku.name']},
 'microsoft.cdn/profiles/origingroups':{kind:'routing',fields:['properties.healthProbeSettings','properties.loadBalancingSettings']},
 'microsoft.sql/servers':{kind:'data-host',fields:['properties.state']},
 'microsoft.sql/servers/databases':{kind:'database',fields:['sku','properties.zoneRedundant','properties.currentServiceObjectiveName','properties.readScale','properties.requestedBackupStorageRedundancy','properties.currentBackupStorageRedundancy']},
 'microsoft.sql/servers/failovergroups':{kind:'replication-policy',fields:['properties.replicationRole','properties.replicationState','properties.partnerServers','properties.databases','properties.readWriteEndpoint','properties.readOnlyEndpoint']},
 'microsoft.sql/servers/databases/backupshorttermretentionpolicies':{kind:'backup-policy',fields:['properties.retentionDays','properties.diffBackupIntervalInHours']},
 'microsoft.sql/servers/databases/backuplongtermretentionpolicies':{kind:'backup-policy',fields:['properties.weeklyRetention','properties.monthlyRetention','properties.yearlyRetention']},
 'microsoft.compute/capacityreservationgroups':{kind:'allocation-reservation',fields:['properties.capacityReservations','properties.virtualMachinesAssociated']},
 'microsoft.compute/capacityreservationgroups/capacityreservations':{kind:'allocation-reservation',fields:['sku','properties.provisioningState','properties.reservationId']},
 'microsoft.network/networkinterfaces':{kind:'network',fields:['properties.ipConfigurations']},
 'microsoft.network/virtualnetworks':{kind:'network',fields:['properties.subnets','properties.virtualNetworkPeerings']},
 'microsoft.keyvault/vaults':{kind:'key-management',fields:['properties.enableSoftDelete','properties.enablePurgeProtection']},
 'microsoft.storage/storageaccounts':{kind:'storage',fields:['sku.name','properties.allowCrossTenantReplication','properties.geoReplicationStats']},
 'microsoft.containerservice/managedclusters':{kind:'container-platform',fields:['properties.agentPoolProfiles','properties.autoScalerProfile']},
 'microsoft.web/serverfarms':{kind:'compute-group',fields:['sku','properties.zoneRedundant','properties.maximumElasticWorkerCount']},
 'microsoft.web/sites':{kind:'application-host',fields:['properties.serverFarmId','properties.siteConfig.healthCheckPath']},
 'microsoft.recoveryservices/vaults':{kind:'backup-vault',fields:['properties.provisioningState']}
};
function references(value,path='',found=[]){
 if(typeof value==='string'&&resourceId.test(value))found.push({id:canonicalId(value),path});
 else if(Array.isArray(value))value.forEach((v,i)=>references(v,path+'.'+i,found));
 else if(value&&typeof value==='object')for(const [k,v] of Object.entries(value))references(v,path?path+'.'+k:k,found);
 return found;
}
function owner(tags,tagKey){
 const matches=Object.entries(tags??{}).filter(([k])=>k.toLowerCase()===tagKey.toLowerCase()).map(([,v])=>typeof v==='string'?v.trim():'').filter(Boolean);
 return new Set(matches).size===1?matches[0]:null;
}
export function normaliseAzure(inventory,{tagKey='serviceId',catalogue=[],maxDependencyDepth=2,maxDependenciesPerService=1000,includeAllResources=false}={}){
 if(inventory?.inventoryVersion!=='azure-resource-graph/0.1'||!Array.isArray(inventory.records)||!Array.isArray(inventory.collections))throw new Error('Expected an Azure discovery inventory.');
 validateScope(inventory.subscriptions);
 if(typeof tagKey!=='string'||!tagKey.trim()||!Number.isInteger(maxDependencyDepth)||maxDependencyDepth<0||maxDependencyDepth>5||!Number.isInteger(maxDependenciesPerService)||maxDependenciesPerService<1)throw new Error('Invalid discovery grouping options.');
 if(!Array.isArray(catalogue)||catalogue.some(s=>typeof s.id!=='string'||!s.id.trim())||new Set(catalogue.map(s=>s.id)).size!==catalogue.length)throw new Error('Catalogue requires unique non-empty string service IDs.');
 const nodes=new Map(),evidence=[],relationships=[],warnings=[];
 for(const record of inventory.records){
  const r=redact(record.resource);if(typeof r?.id!=='string'||!resourceId.test(r.id))throw new Error('Invalid Azure resource ID in inventory.');
  const id=canonicalId(r.id);
  if(!inventory.subscriptions.some(s=>id.startsWith('/subscriptions/'+s.toLowerCase()+'/')||id==='/subscriptions/'+s.toLowerCase()))throw new Error('Resource is outside the inventory subscription scope.');
  const type=String(r.type??'').toLowerCase(),mapping=mappings[type],evidenceId='evidence-'+evidence.length;
  evidence.push({id:evidenceId,resourceId:id,table:record.table,subscriptionId:record.subscriptionId,observedAt:record.observedAt,source:'azure-resource-graph',record:r});
  if(nodes.has(id)){warnings.push({code:'duplicate-resource',resourceId:id,message:'Multiple observations retained; first observation used for grouping.'});continue;}
  const own=owner(r.tags,tagKey);
  if(!own&&Object.keys(r.tags??{}).some(k=>k.toLowerCase()===tagKey.toLowerCase()))warnings.push({code:'ambiguous-service-tag',resourceId:id,message:'Empty, invalid or conflicting service tags; ownership not inferred.'});
  const facts=(mapping?.fields??[]).map(path=>({name:path,value:get(r,path)??null,status:get(r,path)===undefined||get(r,path)===null?'unknown':'observed',evidence:{id:evidenceId,path}}));
  nodes.set(id,{id,name:r.name??id,type,kind:mapping?.kind??'uninterpreted',serviceId:own,location:r.location??null,subscriptionId:r.subscriptionId??record.subscriptionId,resourceGroup:r.resourceGroup??null,zones:Array.isArray(r.zones)?r.zones:null,zoneInterpretation:Array.isArray(r.zones)&&r.zones.length?'declared-placement-not-instance-distribution':'unknown-not-proof-of-no-zone-redundancy',facts,evidenceId});
  for(const ref of references(r.properties,'properties'))if(ref.id!==id)relationships.push({from:id,to:ref.id,kind:'configuration-reference',status:'observed',evidence:{id:evidenceId,path:ref.path},meaning:'A configuration reference; not proof of an application request path.'});
  // Child-resource containment is an ID fact, never assumed tag inheritance.
  const parts=id.split('/');if(parts.length>9){const parent=parts.slice(0,-2).join('/');relationships.push({from:id,to:parent,kind:'contained-by',status:'observed',evidence:{id:evidenceId,path:'id'}});}
 }
 // Resolve references to inline subresources (e.g. LB backend pool) to their inventoried ancestor.
 for(const edge of relationships){let candidate=edge.to;while(candidate&&!nodes.has(candidate)){const slash=candidate.lastIndexOf('/');if(slash<=0)break;candidate=candidate.slice(0,slash);}edge.resolvedTo=nodes.has(candidate)&&(candidate===edge.to||candidate.includes('/providers/'))?candidate:null;edge.resolution=edge.resolvedTo===edge.to?'exact-resource':edge.resolvedTo?'resource-ancestor-only':'unresolved';}
 const outgoing=new Map(),incomingPolicies=new Map(),ownership=new Map();
 for(const node of nodes.values())if(node.serviceId){if(!ownership.has(node.serviceId))ownership.set(node.serviceId,[]);ownership.get(node.serviceId).push(node.id);}
 for(const edge of relationships){
  if(!outgoing.has(edge.from))outgoing.set(edge.from,[]);outgoing.get(edge.from).push(edge);
  if(edge.resolvedTo&&['scaling-policy','replication-policy','backup-policy'].includes(nodes.get(edge.from)?.kind)){
   if(!incomingPolicies.has(edge.resolvedTo))incomingPolicies.set(edge.resolvedTo,[]);incomingPolicies.get(edge.resolvedTo).push(edge.from);
  }
 }
 const services=new Map(catalogue.map(s=>[s.id,{id:s.id,name:s.name??s.id,catalogueStatus:'catalogued'}]));
 for(const n of nodes.values())if(n.serviceId&&!services.has(n.serviceId))services.set(n.serviceId,{id:n.serviceId,name:n.serviceId,catalogueStatus:catalogue.length?'not-in-catalogue':'catalogue-not-supplied'});
 const partial=inventory.collections.some(c=>!c.paginationComplete||c.status!=='collected')||inventory.subscriptions.some(id=>['Resources','ResourceContainers'].some(table=>!inventory.collections.some(c=>c.subscriptionId===id&&c.table===table)));
 const snapshots=[];
 for(const service of services.values()){
  const owned=ownership.get(service.id)??[],ownedSet=new Set(owned),included=new Set(owned);let frontier=[...owned],limited=false;
  // Outgoing dependencies only. Incoming policy resources can refer to owned hosts.
  const policies=owned.flatMap(id=>incomingPolicies.get(id)??[]);
  for(const id of policies)if(!included.has(id)){if(included.size-owned.length>=maxDependenciesPerService){limited=true;continue;}included.add(id);frontier.push(id);}
  for(let depth=0;depth<maxDependencyDepth&&frontier.length;depth++){
   const next=[];
   for(const id of frontier)for(const edge of outgoing.get(id)??[]){
    const target=edge.resolvedTo;if(!target||included.has(target))continue;
    if(included.size-owned.length>=maxDependenciesPerService){limited=true;continue;}
    included.add(target);next.push(target);
   }frontier=next;
  }
  const edges=[...included].flatMap(id=>outgoing.get(id)??[]);
  const resources=[...included].sort().map(id=>({...nodes.get(id),membership:ownedSet.has(id)?'owned':nodes.get(id).serviceId?'external-service-dependency':'shared-or-untagged-dependency'}));
  const unknowns=[{code:'transaction-capacity',message:'Measured transaction capacity and workload demand are not discovered.'},{code:'application-paths',message:'Configuration references do not prove customer journey dependencies.'},{code:'runtime-health',message:'Configured resources are not assumed ready, healthy or able to serve transactions.'},{code:'visibility',message:'Resource Graph permission coverage and unsupported provider details require review.'}];
  if(!owned.length)unknowns.push({code:'no-tagged-resources',message:'No visible resources carry this service ID; this is not proof that the service is absent.'});
  if(partial)unknowns.push({code:'partial-collection',message:'At least one requested collection failed or was truncated; absence cannot establish deletion.'});
  if(limited)unknowns.push({code:'dependency-limit',message:'Dependency count limit reached.'});
  if(frontier.some(id=>(outgoing.get(id)??[]).some(e=>e.resolvedTo&&!included.has(e.resolvedTo))))unknowns.push({code:'dependency-depth',message:'Further dependencies exist beyond the traversal depth.'});
  if(edges.some(e=>!e.resolvedTo))unknowns.push({code:'unresolved-references',message:'Some referenced resources were not visible in the inventory.'});
  if(resources.some(r=>r.kind==='uninterpreted'))unknowns.push({code:'uninterpreted-types',message:'Some resource types have no resilience field mapping in this collector version.'});
  snapshots.push({...service,snapshotVersion:'cloud-service-discovery/0.1',provider:'azure',collectedFrom:inventory.startedAt,collectedTo:inventory.finishedAt,tagKey,collectionStatus:partial?'partial':'collected-with-unverified-permissions',regions:[...new Set(resources.map(r=>r.location).filter(Boolean))].sort(),resources,relationships:edges,unknowns,simulationReady:false});
 }
 return {...(includeAllResources?{allResources:[...nodes.values()],allRelationships:relationships}:{}),discoveryVersion:'cloud-estate-discovery/0.1',dataOrigin:inventory.synthetic===true?'synthetic-example':'provided-or-live-inventory',provider:'azure',startedAt:inventory.startedAt,finishedAt:inventory.finishedAt,scope:{subscriptions:inventory.subscriptions,tagKey},collections:inventory.collections,limitations:inventory.limitations??[],warnings,untaggedResourceCount:[...nodes.values()].filter(n=>!n.serviceId).length,services:snapshots.sort((a,b)=>a.id.localeCompare(b.id)),evidence};
}
