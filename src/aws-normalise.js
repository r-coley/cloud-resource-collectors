import {createHash} from 'node:crypto';
import {awsFields,awsSpecs,awsDetails} from './aws-specs.js';
import {validateAwsConfig} from './aws-collector.js';
import {redact} from './azure-collector.js';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const get=(value,path)=>path.split('.').reduce((v,k)=>v?.[k],value);
const pointer=path=>'/configuration/'+path.split('.').map(s=>s.replace(/~/g,'~0').replace(/\//g,'~1')).join('/');
const tags=value=>Array.isArray(value)?Object.fromEntries(value.filter(t=>typeof t.Key==='string'&&typeof t.Value==='string').map(t=>[t.Key,t.Value])):{};
export function normaliseAws(inventory,config,{origin='provided',includeAllResources=false}={}){
 validateAwsConfig(config);
 if(inventory?.inventoryVersion!=='aws-api-inventory/0.1'||inventory.provider!=='aws'||!Array.isArray(inventory.records)||!Array.isArray(inventory.collections))throw new Error('Expected an AWS API inventory');
 const configured=config.accounts.map(a=>({id:a.id,partition:a.partition??'aws',regions:[...a.regions]}));
 const scopeShape=accounts=>JSON.stringify([...accounts].map(a=>({...a,regions:[...a.regions].sort()})).sort((a,b)=>a.id.localeCompare(b.id)));
 if(scopeShape(configured)!==scopeShape(inventory.accounts))throw new Error('Inventory differs from configured AWS scope');
 const scopeId=(partition,account)=>`aws:${partition}:${account}`;
 const key=(partition,account,id)=>`${scopeId(partition,account)}:${id}`;
 const scopes=configured.map(a=>({id:scopeId(a.partition,a.id),provider:'aws',partition:a.partition,accountId:a.id,tenantId:null,selector:{regions:a.regions,serviceTagKey:config.serviceTagKey??'serviceId'}}));
 const collections=inventory.collections.map(c=>{if(!configured.some(a=>a.id===c.accountId&&a.partition===c.partition&&a.regions.includes(c.region)))throw new Error('Collection outside configured AWS scope');return {id:c.id,scopeId:scopeId(c.partition,c.accountId),source:c.source+':'+c.region+(c.parentId?':'+c.parentId:''),status:c.status,paginationComplete:c.paginationComplete,permissionCoverage:c.permissionCoverage,startedAt:c.startedAt,finishedAt:c.finishedAt,recordCount:c.recordCount,errorCode:c.errorCode};});
 if(new Set(collections.map(c=>c.id)).size!==collections.length)throw new Error('Duplicate collection IDs');
 const collectionById=new Map(inventory.collections.map(c=>[c.id,c]));const nodes=new Map(),evidence=[],edges=[],gaps=[];
 for(const [index,raw] of inventory.records.entries()){
  const r=redact(raw),collection=collectionById.get(r.collectionId);
  if(!collection||r.accountId!==collection.accountId||r.partition!==collection.partition||r.region!==collection.region||typeof r.nativeId!=='string'||!r.nativeId.startsWith('arn:'+r.partition+':')||!r.configuration||typeof r.configuration!=='object')throw new Error('Invalid AWS resource observation');
  const arn=r.nativeId.split(':');if((arn[3]&&arn[3]!==r.region)||(arn[4]&&arn[4]!==r.accountId))throw new Error('Resource ARN outside account scope');
  const evidenceId='evidence-'+index;evidence.push({id:evidenceId,collectionId:r.collectionId,observedAt:r.observedAt,redaction:'collector-filtered-not-guaranteed-secret-free',record:r});
  const resourceKey=key(r.partition,r.accountId,r.nativeId),observedTags=tags(r.configuration.Tags??r.configuration.TagList);
  let node=nodes.get(resourceKey);
  if(!node){node={key:resourceKey,scopeId:scopeId(r.partition,r.accountId),nativeId:r.nativeId,nativeType:r.nativeType,kind:r.kind,name:r.configuration.AutoScalingGroupName??r.configuration.DBInstanceIdentifier??r.configuration.DBClusterIdentifier??r.configuration.LoadBalancerName??r.configuration.TargetGroupName??r.nativeId,region:arn[3]||null,zones:null,placementMeaning:'unknown-not-proof-of-no-zone-redundancy',tags:{},facts:[],evidenceIds:[],observations:[],tagConflict:false};nodes.set(resourceKey,node);}
  node.evidenceIds.push(evidenceId);node.observations.push({r,evidenceId});
  for(const [k,v] of Object.entries(observedTags)){if(k in node.tags&&node.tags[k]!==v){node.tagConflict=true;gaps.push({code:'conflicting-observations',message:'Conflicting tags observed for '+r.nativeId+'; service ownership is not inferred.'});}else node.tags[k]=v;}
  if(r.nativeType!=='tagged-resource'&&node.nativeType==='tagged-resource'){node.nativeType=r.nativeType;node.kind=r.kind;node.name=r.configuration.AutoScalingGroupName??r.configuration.DBInstanceIdentifier??r.configuration.DBClusterIdentifier??r.configuration.LoadBalancerName??r.configuration.TargetGroupName??r.nativeId;}
 }
 const byNative=new Map([...nodes.values()].map(n=>[n.nativeId,n]));
 const ec2=(r,type,id)=>`arn:${r.partition}:ec2:${r.region}:${r.accountId}:${type}/${id}`;
 const rds=(r,type,id)=>id.startsWith('arn:')?id:`arn:${r.partition}:rds:${r.region}:${r.accountId}:${type}:${id}`;
 for(const node of nodes.values()){
  const observation=node.observations.find(o=>o.r.nativeType!=='tagged-resource')??node.observations[0],{r,evidenceId}=observation,c=r.configuration;
  if(node.observations.filter(o=>o.r.nativeType!=='tagged-resource').length>1)gaps.push({code:'duplicate-observation',message:'Multiple observations of '+node.nativeId+'; the first detailed configuration is used.'});
  node.facts=(awsFields[node.nativeType]??[]).map(name=>({name,status:get(c,name)==null?'unknown':'observed',value:get(c,name)??null,evidenceId,sourcePointer:pointer(name)}));
  let zones=[];if(Array.isArray(c.AvailabilityZones))zones.push(...c.AvailabilityZones.map(z=>typeof z==='string'?z:z.ZoneName));
  zones.push(c.Placement?.AvailabilityZone,c.AvailabilityZone,c.SecondaryAvailabilityZone);zones=[...new Set(zones.filter(z=>typeof z==='string'&&z.length))];
  if(zones.length){node.zones=zones;node.placementMeaning='declared-placement-not-healthy-instance-distribution';}
  const edge=(id,path)=>{if(typeof id!=='string'||!id)return;const target=byNative.get(id);edges.push({id:'edge-'+hash([node.key,id,evidenceId,path]),from:node.key,target:{nativeId:id,resourceKey:target?.key??null,resolution:target?'exact-resource':'unresolved'},kind:'configuration-reference',assertion:'declared',evidenceId,sourcePointer:pointer(path)});};
  if(c.VpcId)edge(ec2(r,'vpc',c.VpcId),'VpcId');
  if(typeof c.VPCZoneIdentifier==='string')for(const id of c.VPCZoneIdentifier.split(',').filter(Boolean))edge(ec2(r,'subnet',id),'VPCZoneIdentifier');
  if(c.SubnetId)edge(ec2(r,'subnet',c.SubnetId),'SubnetId');
  if(c.CapacityReservationId)edge(ec2(r,'capacity-reservation',c.CapacityReservationId),'CapacityReservationId');
  const reservation=c.CapacityReservationSpecification?.CapacityReservationTarget?.CapacityReservationId;if(reservation)edge(ec2(r,'capacity-reservation',reservation),'CapacityReservationSpecification.CapacityReservationTarget.CapacityReservationId');
  if(c.LaunchTemplate?.LaunchTemplateId)edge(ec2(r,'launch-template',c.LaunchTemplate.LaunchTemplateId),'LaunchTemplate.LaunchTemplateId');
  for(const [i,item] of (c.Instances??[]).entries())if(item.InstanceId)edge(ec2(r,'instance',item.InstanceId),`Instances.${i}.InstanceId`);
  for(const [i,id] of (c.TargetGroupARNs??[]).entries())edge(id,`TargetGroupARNs.${i}`);
  for(const [i,id] of (c.LoadBalancerArns??[]).entries())edge(id,`LoadBalancerArns.${i}`);
  for(const [i,z] of (c.AvailabilityZones??[]).entries())if(z.SubnetId)edge(ec2(r,'subnet',z.SubnetId),`AvailabilityZones.${i}.SubnetId`);
  if(c.LoadBalancerArn)edge(c.LoadBalancerArn,'LoadBalancerArn');
  for(const [i,action] of (c.DefaultActions??[]).entries()){if(action.TargetGroupArn)edge(action.TargetGroupArn,`DefaultActions.${i}.TargetGroupArn`);for(const [j,t] of (action.ForwardConfig?.TargetGroups??[]).entries())edge(t.TargetGroupArn,`DefaultActions.${i}.ForwardConfig.TargetGroups.${j}.TargetGroupArn`);}
  if(c.Target?.Id&&/^i-[a-z0-9]+$/.test(c.Target.Id))edge(ec2(r,'instance',c.Target.Id),'Target.Id');
  if(c.DBClusterIdentifier)edge(rds(r,'cluster',c.DBClusterIdentifier),'DBClusterIdentifier');
  for(const [i,m] of (c.DBClusterMembers??[]).entries())if(m.DBInstanceIdentifier)edge(rds(r,'db',m.DBInstanceIdentifier),`DBClusterMembers.${i}.DBInstanceIdentifier`);
  for(const [i,m] of (c.GlobalClusterMembers??[]).entries())edge(m.DBClusterArn,`GlobalClusterMembers.${i}.DBClusterArn`);
  if(c.ReplicationSourceIdentifier)edge(c.ReplicationSourceIdentifier,'ReplicationSourceIdentifier');
  if(c.ReadReplicaSourceDBInstanceIdentifier)edge(rds(r,'db',c.ReadReplicaSourceDBInstanceIdentifier),'ReadReplicaSourceDBInstanceIdentifier');
  if(typeof c.DBSubnetGroup==='string'){const group=[...nodes.values()].find(n=>n.nativeType==='AWS::RDS::DBSubnetGroup'&&n.scopeId===node.scopeId&&n.region===node.region&&n.observations.some(o=>o.r.configuration.DBSubnetGroupName===c.DBSubnetGroup));if(group)edge(group.nativeId,'DBSubnetGroup');else edge(rds(r,'subgrp',c.DBSubnetGroup),'DBSubnetGroup');}
  else if(c.DBSubnetGroup?.DBSubnetGroupArn)edge(c.DBSubnetGroup.DBSubnetGroupArn,'DBSubnetGroup.DBSubnetGroupArn');
  for(const [i,s] of (c.Subnets??c.DBSubnetGroup?.Subnets??[]).entries())if(s.SubnetIdentifier)edge(ec2(r,'subnet',s.SubnetIdentifier),(c.Subnets?'Subnets.':'DBSubnetGroup.Subnets.')+i+'.SubnetIdentifier');
  if(c.AutoScalingGroupName&&r.nativeType==='AWS::AutoScaling::ScalingPolicy'){const group=[...nodes.values()].find(n=>n.nativeType==='AWS::AutoScaling::AutoScalingGroup'&&n.scopeId===node.scopeId&&n.region===node.region&&n.name===c.AutoScalingGroupName);if(group)edge(group.nativeId,'AutoScalingGroupName');}
  // Parent identity is collector context; its evidence pointer identifies that context, not a provider dependency field.
  if(r.parentId){const target=byNative.get(r.parentId);edges.push({id:'edge-'+hash([node.key,r.parentId,evidenceId]),from:node.key,target:{nativeId:r.parentId,resourceKey:target?.key??null,resolution:target?'exact-resource':'unresolved'},kind:'contained-by',assertion:'declared',evidenceId,sourcePointer:'/parentId'});}
 }
 const tagKey=config.serviceTagKey??'serviceId',owner=n=>!n.tagConflict&&typeof n.tags[tagKey]==='string'&&n.tags[tagKey].trim()?n.tags[tagKey].trim():null;
 const ownership=new Map();for(const n of nodes.values()){const id=owner(n);if(id){if(!ownership.has(id))ownership.set(id,[]);ownership.get(id).push(n.key);}}
 const catalogue=new Map((config.services??[]).map(s=>[s.id,{id:s.id,name:s.name??s.id,catalogueStatus:'catalogued'}]));
 for(const n of nodes.values()){const id=owner(n);if(id&&!catalogue.has(id))catalogue.set(id,{id,name:id,catalogueStatus:config.services?.length?'not-in-catalogue':'catalogue-not-supplied'});}
 const outgoing=new Map(),policies=new Map();for(const e of edges){if(!outgoing.has(e.from))outgoing.set(e.from,[]);outgoing.get(e.from).push(e);if(e.target.resourceKey&&['scaling-policy','replication-policy','routing-pool','routing-rule','health-observation'].includes(nodes.get(e.from)?.kind)){if(!policies.has(e.target.resourceKey))policies.set(e.target.resourceKey,[]);policies.get(e.target.resourceKey).push(e.from);}}
 const expected=[];
 for(const a of configured)for(const [i,region] of a.regions.entries())for(const spec of awsSpecs)if(!spec.once||i===0)expected.push({accountId:a.id,partition:a.partition,region,source:spec.service+':'+spec.operation});
 for(const r of inventory.records)for(const detail of awsDetails)if(r.nativeType===detail.parent)expected.push({accountId:r.accountId,partition:r.partition,region:r.region,source:detail.service+':'+detail.operation,parentId:r.nativeId});
 for(const e of expected)if(!inventory.collections.some(c=>c.accountId===e.accountId&&c.region===e.region&&c.source===e.source&&(c.parentId??null)===(e.parentId??null))){const id='missing-'+hash(e);if(!collections.some(c=>c.id===id))collections.push({id,scopeId:scopeId(e.partition,e.accountId),source:e.source+':'+e.region+(e.parentId?':'+e.parentId:''),status:'partial',paginationComplete:false,permissionCoverage:'unverified',startedAt:inventory.startedAt,finishedAt:inventory.finishedAt,recordCount:0,errorCode:'NotCollected'});}
 const partial=collections.some(c=>c.status!=='collected'||!c.paginationComplete);const includedAll=new Set(),services=[];
 for(const service of catalogue.values()){
  const owned=ownership.get(service.id)??[],ownedSet=new Set(owned),included=new Set(owned);let frontier=[...owned],limited=false;
  const max=config.maxDependenciesPerService??1000;for(let depth=0;depth<=(config.maxDependencyDepth??2)&&frontier.length;depth++){
   const next=[];for(const id of frontier){const candidates=[...(policies.get(id)??[]),...(depth<(config.maxDependencyDepth??2)?(outgoing.get(id)??[]).map(e=>e.target.resourceKey).filter(Boolean):[])];for(const target of candidates){if(included.has(target))continue;if(included.size-owned.length>=max){limited=true;continue;}included.add(target);next.push(target);}}frontier=next;
  }
  const serviceGaps=[{code:'transaction-capacity',message:'Instance counts and database classes are not measured transaction capacity.'},{code:'application-paths',message:'Cloud references do not establish application workflow dependencies.'},{code:'visibility',message:'Only selected APIs are collected; permission coverage is unverified.'},...gaps];
  if(!owned.length)serviceGaps.push({code:'no-tagged-resources',message:'No visible resources carry this service ID; absence is not established.'});
  if(partial)serviceGaps.push({code:'partial-collection',message:'Requested API coverage is missing, denied or incomplete; absence cannot establish deletion.'});
  if(limited)serviceGaps.push({code:'dependency-limit',message:'Dependency count limit reached.'});
  if([...included].some(id=>(outgoing.get(id)??[]).some(e=>e.target.resourceKey&&!included.has(e.target.resourceKey))))serviceGaps.push({code:'dependency-depth',message:'References exist beyond the traversal depth.'});
  if([...included].some(id=>(outgoing.get(id)??[]).some(e=>!e.target.resourceKey)))serviceGaps.push({code:'unresolved-references',message:'Some configuration references were not observed.'});
  if([...included].some(id=>nodes.get(id).kind==='uninterpreted'))serviceGaps.push({code:'uninterpreted-types',message:'Tagged resources include unsupported detail types.'});
  for(const id of included)includedAll.add(id);
  services.push({...service,memberships:[...included].sort().map(id=>({resourceKey:id,role:ownedSet.has(id)?'owned':owner(nodes.get(id))?'external-service-dependency':'shared-or-untagged-dependency'})),gaps:serviceGaps});
 }
 if(includeAllResources)for(const key of nodes.keys())includedAll.add(key);
 const resources=[...includedAll].sort().map(id=>{const {observations,tagConflict,...node}=nodes.get(id);return node;});
 const relationships=edges.filter(e=>includedAll.has(e.from)).map(e=>({...e,target:e.target.resourceKey&&!includedAll.has(e.target.resourceKey)?{...e.target,resourceKey:null,resolution:'unresolved'}:e.target}));
 const result={schemaVersion:'cloud-inventory/1.0.0',snapshotId:'',origin,collector:{name:'cloud-resource-collectors/aws',version:'0.1.0'},startedAt:inventory.startedAt,finishedAt:inventory.finishedAt,scopes,collections,services:services.sort((a,b)=>a.id.localeCompare(b.id)),resources,relationships,evidence,limitations:inventory.limitations??[],simulationReady:false};result.snapshotId='sha256:'+hash({...result,snapshotId:undefined});return result;
}
