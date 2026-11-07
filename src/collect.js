import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {collectAzure,validateScope} from './azure-collector.js';
import {normaliseAzure} from './normalise.js';
import {toCloudInventory} from './cloud-inventory.js';
import {collectAws,validateAwsConfig} from './aws-collector.js';
import {normaliseAws} from './aws-normalise.js';
import {collectGcp,validateGcpConfig} from './gcp-collector.js';
import {normaliseGcp} from './gcp-normalise.js';
import {validateCloudInventory} from './validate-cloud-inventory.js';
const exec=promisify(execFile);
export const digest=snapshot=>'sha256:'+createHash('sha256').update(JSON.stringify({...snapshot,snapshotId:undefined})).digest('hex');
export function validateAzureConfig(config){
 validateScope(config.subscriptions);
 if(config.resourceGroups!==undefined&&(!Array.isArray(config.resourceGroups)||!config.resourceGroups.length||new Set(config.resourceGroups.map(s=>String(s).toLowerCase())).size!==config.resourceGroups.length||config.resourceGroups.some(s=>typeof s!=='string'||! /^[\p{L}\p{N}_.()-]{1,90}$/u.test(s))))throw new Error('Supply distinct valid Azure resource group names');
 if(config.serviceTagKey!==undefined&&(typeof config.serviceTagKey!=='string'||!config.serviceTagKey.trim()))throw new Error('Invalid service tag key');
 if(config.services!==undefined&&(!Array.isArray(config.services)||config.services.some(s=>typeof s.id!=='string'||!s.id.trim())||new Set(config.services.map(s=>s.id)).size!==config.services.length))throw new Error('Service IDs must be unique');
 for(const [name,max] of [['maxDependencyDepth',5],['maxDependenciesPerService',100000]])if(config[name]!==undefined&&(!Number.isInteger(config[name])||config[name]<0||config[name]>max))throw new Error('Invalid dependency limit');
}
export function azureTokenProvider(config){let token=null,expires=0;return async()=>{
 if(token&&Date.now()<expires)return token;
 let auth;try{const {stdout}=await exec('az',['account','get-access-token','--resource','https://management.azure.com/','--subscription',config.subscriptions[0],'--output','json'],{timeout:30000,maxBuffer:1024*1024});auth=JSON.parse(stdout);}catch{throw new Error('Existing Azure CLI authentication unavailable');}
 if(typeof auth.accessToken!=='string'||!auth.accessToken)throw new Error('Existing Azure CLI authentication unavailable');token=auth.accessToken;expires=Math.min(Date.now()+240000,Number(auth.expires_on)*1000-60000||Date.now()+240000);return token;
};}
export async function collectSnapshot({cloud,config,inventory},{azure=collectAzure,aws=collectAws,gcp=collectGcp}={}){
 if(!['azure','aws','gcp'].includes(cloud))throw new Error('Choose azure, aws or gcp');
 ({azure:validateAzureConfig,aws:validateAwsConfig,gcp:validateGcpConfig}[cloud])(config);
 const supplied=inventory!==undefined;
 if(!supplied)inventory=cloud==='azure'?await azure({subscriptions:config.subscriptions,resourceGroups:config.resourceGroups,getToken:azureTokenProvider(config)}):await ({aws,gcp}[cloud])(config);
 const origin=inventory.synthetic===true?'synthetic':supplied?'provided':'live';
 let snapshot;
 if(cloud==='azure'){
  const normalize=ids=>[...ids].map(id=>id.toLowerCase()).sort();if(JSON.stringify(normalize(inventory.subscriptions??[]))!==JSON.stringify(normalize(config.subscriptions)))throw new Error('Inventory subscription scope differs from configured scope');
  if(config.resourceGroups){const selected=new Set(config.resourceGroups.map(s=>s.toLowerCase()));inventory={...inventory,records:inventory.records.filter(r=>{const group=r.resource?.id?.match(/\/resourcegroups\/([^/]+)/i)?.[1];return group&&selected.has(group.toLowerCase());})};}
  snapshot=toCloudInventory(normaliseAzure(inventory,{tagKey:config.serviceTagKey??'serviceId',catalogue:config.services??[],maxDependencyDepth:config.maxDependencyDepth??2,maxDependenciesPerService:config.maxDependenciesPerService??1000,includeAllResources:true}),{origin});
  for(const scope of snapshot.scopes)if(config.resourceGroups)scope.selector.resourceGroups=[...config.resourceGroups];
 }else snapshot=({aws:normaliseAws,gcp:normaliseGcp}[cloud])(inventory,config,{origin,includeAllResources:true});
 snapshot.snapshotId=digest(snapshot);validateCloudInventory(snapshot);return snapshot;
}
export const isPartial=snapshot=>snapshot.collections.some(c=>c.status!=='collected'||!c.paginationComplete)||snapshot.services.some(s=>s.gaps.some(g=>g.code==='partial-collection'));
