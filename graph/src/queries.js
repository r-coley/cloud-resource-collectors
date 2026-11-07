import fs from 'node:fs';
import neo4j from 'neo4j-driver';
import {readQuery} from './neo4j.js';
const names=['projects','select-project','coverage','resources','project-count','references','reference-count','service-gaps','evidence'];
export const queries=Object.fromEntries(names.map(name=>[name,fs.readFileSync(new URL('../queries/'+name+'.cypher',import.meta.url),'utf8')]));
export function queryLimit(value=1000){if(!Number.isInteger(value)||value<1||value>5000)throw new Error('Limit must be 1–5000');return neo4j.int(value);}
export function chooseProject(rows,{snapshot=null}={}){
 if(!rows.length)throw new Error('No imported project observation matches this selection');
 if(new Set(rows.map(r=>r.project)).size>1)throw new Error('Project is ambiguous; use a full scope ID or --cloud');
 if(!snapshot&&new Set(rows.map(r=>r.selectorHash+':'+r.origin)).size>1)throw new Error('Project has multiple selectors or origins; choose --snapshot');
 return [...rows].sort((a,b)=>Date.parse(b.collectedTo)-Date.parse(a.collectedTo)||b.snapshotId.localeCompare(a.snapshotId))[0];
}
export async function listProjects(driver,{database='neo4j',cloud=null,limit=1000}={}){return readQuery(driver,database,queries.projects,{cloud,limit:queryLimit(limit)});}
export async function selectProject(driver,{database='neo4j',project,cloud=null,snapshot=null,origin=null}={}){
 if(!project)throw new Error('Supply --project');
 return chooseProject(await readQuery(driver,database,queries['select-project'],{project,cloud,snapshot,origin}),{snapshot});
}
export async function projectResources(driver,options={}){
 const selected=await selectProject(driver,options),rows=await readQuery(driver,options.database??'neo4j',queries.resources,{projectObservationId:selected.projectObservationId,kind:options.kind??null,limit:queryLimit(options.limit??1000)});
 const resourceCount=(await readQuery(driver,options.database??'neo4j',queries['project-count'],{projectObservationId:selected.projectObservationId,kind:options.kind??null}))[0]?.resourceCount??0;
 return {project:selected,resourceCount,limit:options.limit??1000,truncated:resourceCount>rows.length,resources:rows.map(r=>({...r,tags:JSON.parse(r.tagsJson),tagsJson:undefined,zones:r.zonesKnown?r.zones:null,facts:r.facts.map(f=>({...f,value:JSON.parse(f.valueJson),valueJson:undefined}))}))};
}
const categories=[
 ['placement','Configured placement',/(?:zone|Zone|availabilityType|MultiAZ|distributionPolicy)/],
 ['automatic-recovery','Automatic recovery and scaling',/(?:automaticRepairsPolicy|autoHealingPolicies|HealthCheckGracePeriod|DefaultInstanceWarmup|CapacityRebalance|SuspendedProcesses|autoscalingPolicy|MinSize|MaxSize|DesiredCapacity|targetSize|updatePolicy|HealthStatus)/],
 ['data-availability','Database and replication settings',/(?:zoneRedundant|MultiAZ|availabilityType|readWriteEndpoint|partnerServers|replication|Replication|DBClusterMembers|GlobalClusterMembers|masterInstanceName|replicaNames|failoverReplica)/],
 ['backup-recovery','Backup and point-in-time recovery',/(?:[Bb]ackup|[Rr]etention|[Rr]estorable)/],
 ['health-routing','Health checks and routing',/(?:[Hh]ealthCheck|probes|loadBalancingRules|trafficRoutingMethod|monitorConfig|DefaultActions|failoverPolicy|readWriteEndpoint)/],
 ['allocation','Reservation and allocation settings',/(?:[Cc]apacityReservation|[Rr]eservation|InstanceLifecycle|priority|specificReservation|AvailableInstanceCount|TotalInstanceCount)/]
];
export function resilienceEvidence(selected,resources,{coverage=[],counts={},references=[],referenceCounts={},gaps=[],limit=1000}={}){
 const incomplete=coverage.filter(c=>c.status!=='collected'||!c.paginationComplete).length,unverified=coverage.filter(c=>c.permissionCoverage!=='verified').length;
 const truncated=(counts.resourceCount??resources.length)>resources.length;
 const checks=categories.map(([id,title,pattern])=>{
  const items=resources.flatMap(r=>{const facts=r.facts.filter(f=>pattern.test(f.name));return facts.length?[{resourceKey:r.key,resourceName:r.name,kind:r.kind,facts}]:[];});
  return {id,title,status:items.some(i=>i.facts.some(f=>f.status==='observed'))?'evidence-recorded':'unknown',items};
 });
 const placed=resources.filter(r=>['compute','compute-group','database','database-cluster','container-platform','application-host'].includes(r.kind)).map(r=>({resourceKey:r.key,kind:r.kind,region:r.region,zones:r.zones,placementMeaning:r.placementMeaning}));
 return {viewVersion:'resilience-evidence/1.0.0',project:selected,assessment:'requires-review',coverage:{collections:coverage.length,incompleteCollections:incomplete,unverifiedCollections:unverified,resourcesInProject:counts.resourceCount??resources.length,resourcesReturned:resources.length,resourceLimit:limit,truncated,referenceCount:referenceCounts.referenceCount??references.length,unresolvedReferenceCount:referenceCounts.unresolvedCount??0,referencesTruncated:(referenceCounts.referenceCount??references.length)>references.length},checks,placement:placed,references,serviceGaps:gaps,serviceGapsMayBeTruncated:gaps.length>=limit,collectionDetails:coverage,interpretation:'Configuration evidence only. Placement, capacity, failover, backup and reservation settings do not establish tested resilience, available transaction throughput or RTO/RPO.'};
}
export async function queryResilience(driver,options={}){
 const {project,resources}=await projectResources(driver,options),database=options.database??'neo4j',limit=options.limit??1000,params={projectObservationId:project.projectObservationId,kind:null,limit:queryLimit(limit)};
 const coverage=await readQuery(driver,database,queries.coverage,params),counts=(await readQuery(driver,database,queries['project-count'],params))[0]??{};
 const references=await readQuery(driver,database,queries.references,params),referenceCounts=(await readQuery(driver,database,queries['reference-count'],params))[0]??{};
 const gaps=await readQuery(driver,database,queries['service-gaps'],params);
 return resilienceEvidence(project,resources,{coverage,counts,references,referenceCounts,gaps,limit});
}
export async function queryEvidence(driver,{database='neo4j',snapshot,evidenceId}={}){
 if(!snapshot||!evidenceId)throw new Error('Supply --snapshot and --evidence-id');const rows=await readQuery(driver,database,queries.evidence,{snapshot,evidenceId});return rows.map(r=>({...r,record:JSON.parse(r.recordJson),recordJson:undefined}));
}
