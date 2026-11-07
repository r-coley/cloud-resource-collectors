import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {gcpSpecs,kindForType} from './gcp-specs.js';
import {redact} from './azure-collector.js';
const exec=promisify(execFile);
export function redactGcp(value){
 if(Array.isArray(value))return value.map(redactGcp);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(redact(value)).map(([k,v])=>[k,/^(metadata|environmentVariables|env|rootPassword|privateKey|sshKeys|ssh-keys|startup-script|startupScript)$/i.test(k)?'[REDACTED]':redactGcp(v)]));
 return value;
}
export function validateGcpConfig(config){
 if(!Array.isArray(config.projects)||!config.projects.length||config.projects.length>1000)throw new Error('Supply 1–1000 explicit GCP projects');
 const ids=new Set();for(const p of config.projects){if(!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(p.id)||ids.has(p.id)||(p.number!==undefined&&!/^\d{6,20}$/.test(p.number)))throw new Error('Invalid or duplicate GCP project');ids.add(p.id);if(!Array.isArray(p.regions)||!p.regions.length||p.regions.length>100||new Set(p.regions).size!==p.regions.length||p.regions.some(r=>!/^[a-z]+(?:-[a-z]+)*\d+$/.test(r)))throw new Error('Supply explicit GCP regions');}
 if(config.account!==undefined&&(typeof config.account!=='string'||! /^[A-Za-z0-9][A-Za-z0-9_.+@-]{1,253}$/.test(config.account)))throw new Error('Invalid gcloud account');
 if(config.serviceLabelKey!==undefined&&!/^[a-z][a-z0-9_-]{0,62}$/.test(config.serviceLabelKey))throw new Error('Invalid service label key');
 if(config.serviceLabelValues!==undefined&&(!config.serviceLabelValues||typeof config.serviceLabelValues!=='object'||Array.isArray(config.serviceLabelValues)||Object.entries(config.serviceLabelValues).some(([k,v])=>! /^[a-z0-9_-]{1,63}$/.test(k)||typeof v!=='string'||!v.trim())))throw new Error('Invalid service label mapping');
 if(config.services!==undefined&&(!Array.isArray(config.services)||config.services.some(s=>typeof s.id!=='string'||!s.id.trim())||new Set(config.services.map(s=>s.id)).size!==config.services.length))throw new Error('Service IDs must be unique');
 for(const [name,max] of [['maxDependencyDepth',5],['maxDependenciesPerService',100000]])if(config[name]!==undefined&&(!Number.isInteger(config[name])||config[name]<0||config[name]>max))throw new Error('Invalid dependency limit');
}
export function canonicalGcpId(value){
 if(typeof value!=='string')return null;
 if(value.startsWith('projects/'))return '//compute.googleapis.com/'+value;
 if(value.startsWith('//'))return value.replace(/^\/\/sqladmin.googleapis.com\//,'//cloudsql.googleapis.com/');
 let url;try{url=new URL(value);}catch{return null;}
 if(url.protocol!=='https:'||url.search||url.hash)return null;
 if(['www.googleapis.com','compute.googleapis.com'].includes(url.hostname)&&url.pathname.startsWith('/compute/v1/projects/'))return '//compute.googleapis.com/'+url.pathname.slice('/compute/v1/'.length);
 if(url.hostname==='sqladmin.googleapis.com'){const path=url.pathname.replace(/^\/(?:sql\/)?v1(?:beta4)?\//,'');if(path.startsWith('projects/'))return '//cloudsql.googleapis.com/'+path;}
 return null;
}
export function gcpLocation(nativeId,configuration,hint=null){
 const zone=(configuration.zone??configuration.gceZone)?.split('/').at(-1)??nativeId.match(/\/zones\/([^/]+)/)?.[1];
 const region=configuration.region?.split('/').at(-1)??nativeId.match(/\/regions\/([^/]+)/)?.[1]??(zone?zone.replace(/-[a-z]$/,''):hint&&hint!=='global'?hint.replace(/-[a-z]$/,''):null);
 return {region,zone:zone??null};
}
export function gcloudTokenProvider(config){let token=null,expires=0;return async()=>{if(token&&Date.now()<expires)return token;try{const {stdout}=await exec('gcloud',['auth','print-access-token',...(config.account?['--account',config.account]:[]),'--quiet'],{timeout:30000,maxBuffer:1024*1024});token=stdout.trim();if(!token||/\s/.test(token))throw new Error();expires=Date.now()+240000;return token;}catch{throw new Error('Existing gcloud authentication unavailable');}};}
export async function collectGcp(config,{getToken=gcloudTokenProvider(config),fetchImpl=fetch,sleep=ms=>new Promise(r=>setTimeout(r,ms)),now=()=>new Date().toISOString(),maxPages=1000}={}){
 validateGcpConfig(config);if(typeof getToken!=='function'||!Number.isInteger(maxPages)||maxPages<1||maxPages>10000)throw new Error('Invalid GCP collector options');
 const inventory={inventoryVersion:'gcp-api-inventory/0.1',provider:'gcp',projects:[],startedAt:now(),finishedAt:null,collections:[],records:[],limitations:['Only selected Compute Engine, Cloud SQL and Cloud Asset Inventory APIs are covered; IAM, application dependencies and data-plane traffic are not collected.','Regional filtering applies after project-wide aggregated queries. Global resources and resources with unknown locations remain visible.','Cloud Asset Inventory is a supplementary inventory, may lag live configuration and is not proof of complete visibility.','Configured placement, labels and target sizes are not proof of current application health, transaction capacity or recovery guarantees.']};
 async function request(host,path,query={},method='GET'){
  if(!['cloudresourcemanager.googleapis.com','cloudasset.googleapis.com','compute.googleapis.com','sqladmin.googleapis.com'].includes(host))throw new Error('Unsupported GCP API host');
  const url=new URL('https://'+host+'/'+path);for(const [k,v] of Object.entries(query))url.searchParams.set(k,v);
  for(let attempt=0;attempt<4;attempt++){
   let response;try{response=await fetchImpl(url.href,{method,redirect:'error',signal:AbortSignal.timeout(30000),headers:{Authorization:'Bearer '+await getToken(),...(method==='POST'?{'Content-Type':'application/json'}:{})},...(method==='POST'?{body:'{}'}:{})});}catch{throw Object.assign(new Error('GCP transport or authentication failed'),{code:'TransportFailed'});}
   if(response.ok){let body;try{body=await response.json();}catch{throw Object.assign(new Error(),{code:'InvalidResponse'});}if(!body||typeof body!=='object'||Array.isArray(body)||body.error)throw Object.assign(new Error(),{code:'InvalidResponse'});return body;}
   if([429,500,502,503,504].includes(response.status)&&attempt<3){const retry=response.headers?.get('retry-after'),seconds=retry===null?NaN:Number(retry),date=Date.parse(retry);const delay=Number.isFinite(seconds)?seconds*1000:Number.isFinite(date)?Math.max(0,date-Date.now()):250*2**attempt;if(delay>60000)throw Object.assign(new Error(),{code:'RetryDeferred'});await sleep(Math.max(0,delay));continue;}
   throw Object.assign(new Error(),{code:'HTTP_'+response.status});
  }
 }
 // Verify immutable project numbers from explicit project IDs before collecting resources.
 for(const requested of config.projects){const project=await request('cloudresourcemanager.googleapis.com','v1/projects/'+requested.id);if(project.projectId!==requested.id||!/^\d{6,20}$/.test(String(project.projectNumber))||(requested.number&&requested.number!==String(project.projectNumber)))throw new Error('GCP project ID or project number differs from configured scope');inventory.projects.push({id:project.projectId,number:String(project.projectNumber),regions:[...requested.regions]});const id='collection-'+inventory.collections.length;inventory.collections.push({id,projectId:project.projectId,source:'cloudresourcemanager:projects.get',status:'collected',paginationComplete:true,permissionCoverage:'unverified',startedAt:now(),finishedAt:now(),recordCount:1,errorCode:null,pages:1});inventory.records.push({collectionId:id,projectId:project.projectId,projectNumber:String(project.projectNumber),observedAt:now(),nativeId:'//cloudresourcemanager.googleapis.com/projects/'+project.projectNumber,nativeType:'cloudresourcemanager.googleapis.com/Project',kind:'project',configuration:redactGcp(project),parentId:null});}
 async function collect(project,spec,region=null,parent=null){
  const id='collection-'+inventory.collections.length,c={id,projectId:project.id,source:spec.id+(region?':'+region:''),...(parent?{parentId:parent.nativeId}:{}),status:'partial',paginationComplete:false,permissionCoverage:'unverified',startedAt:now(),finishedAt:null,pages:0,recordCount:0,errorCode:null};inventory.collections.push(c);let token=null;const seen=new Set();let warning=false;
  try{do{
   if(c.pages>=maxPages)throw Object.assign(new Error(),{code:'PageLimit'});
   const result=await request(spec.host,spec.path(project,region),{...spec.query,...(token?{pageToken:token}:{})},spec.method??'GET');c.pages++;
   if(result.unreachables?.length||result.warnings?.length)warning=true;
   let rows;
   if(spec.aggregated){if(result.items!==undefined&&(!result.items||typeof result.items!=='object'||Array.isArray(result.items)))throw Object.assign(new Error(),{code:'InvalidResponse'});rows=[];for(const scope of Object.values(result.items??{})){if(scope.warning&&scope.warning.code!=='NO_RESULTS_ON_PAGE')warning=true;if(scope[spec.result]!==undefined&&!Array.isArray(scope[spec.result]))throw Object.assign(new Error(),{code:'InvalidResponse'});rows.push(...(scope[spec.result]??[]));}}
   else{rows=result[spec.result]??[];if(!Array.isArray(rows))throw Object.assign(new Error(),{code:'InvalidResponse'});}
   if(result.warning&&result.warning.code!=='NO_RESULTS_ON_PAGE')warning=true;
   for(const row of rows){const asset=spec.asset,configuration=redactGcp(row),data=asset?row.resource?.data??{}:row;
    let nativeId=canonicalGcpId(asset?row.name:row.selfLink);
    if(spec.id==='sql-instances'&&(typeof row.name!=='string'||!row.name))throw Object.assign(new Error(),{code:'InvalidResourceIdentity'});
    if(parent&&!canonicalGcpId(row.instance))throw Object.assign(new Error(),{code:'InvalidResourceIdentity'});
    if(spec.id==='sql-instances')nativeId='//cloudsql.googleapis.com/projects/'+project.id+'/instances/'+row.name;
    if(parent)nativeId=parent.nativeId+'/members/'+encodeURIComponent(canonicalGcpId(row.instance)??row.instance??'');
    if(!nativeId||(!spec.asset&&!nativeId.includes('/projects/')))throw Object.assign(new Error(),{code:'InvalidResourceIdentity'});
    const projectPart=nativeId.match(/\/projects\/([^/]+)/)?.[1];if(projectPart&&![project.id,project.number].includes(projectPart))throw Object.assign(new Error(),{code:'OutOfScopeResource'});
    const location=gcpLocation(nativeId,data,asset?row.resource?.location:null);
    if(location.region&&!project.regions.includes(location.region))continue;
    const type=asset?row.assetType:spec.type;if(typeof type!=='string'||!type)throw Object.assign(new Error(),{code:'InvalidResponse'});
    inventory.records.push({collectionId:id,projectId:project.id,projectNumber:project.number,observedAt:now(),nativeId,nativeType:type,kind:asset?kindForType(type):spec.kind,configuration,parentId:parent?.nativeId??null,asset:!!asset});c.recordCount++;
   }
   const next=result.nextPageToken;if(next!==undefined&&typeof next!=='string')throw Object.assign(new Error(),{code:'InvalidResponse'});if(next&&seen.has(next))throw Object.assign(new Error(),{code:'RepeatedToken'});if(next)seen.add(next);token=next||null;
  }while(token);c.status=warning?'partial':'collected';c.paginationComplete=true;if(warning)c.errorCode='ProviderWarning';
  }catch(error){c.errorCode=/^(HTTP_\d{3}|PageLimit|InvalidResponse|RepeatedToken|InvalidResourceIdentity|OutOfScopeResource|TransportFailed|RetryDeferred)$/.test(error.code)?error.code:'RequestFailed';c.status=c.errorCode==='HTTP_403'?'denied':'partial';}finally{c.finishedAt=now();}
 }
 for(const project of inventory.projects){
  for(const spec of gcpSpecs){if(spec.regional){for(const region of project.regions)await collect(project,spec,region);}else await collect(project,spec);}
  const groups=inventory.records.filter(r=>r.projectId===project.id&&r.nativeType==='compute.googleapis.com/InstanceGroupManager'&&!r.asset);
  for(const parent of groups){const relative=parent.nativeId.replace('//compute.googleapis.com/','');if(!/^projects\/[a-z0-9-]+\/(zones|regions)\/[a-z0-9-]+\/instanceGroupManagers\/[a-zA-Z0-9_-]+$/.test(relative))continue;await collect(project,{id:'managed-instances',host:'compute.googleapis.com',path:()=> 'compute/v1/'+relative+'/listManagedInstances',method:'POST',query:{maxResults:'500'},result:'managedInstances',type:'collector.gcp/ManagedInstanceObservation',kind:'health-observation'},null,parent);}
 }
 inventory.finishedAt=now();return inventory;
}
