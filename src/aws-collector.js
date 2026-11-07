import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {awsSpecs,awsDetails} from './aws-specs.js';
import {redact} from './azure-collector.js';
const exec=promisify(execFile);
const codes=['AccessDenied','AccessDeniedException','UnauthorizedOperation','AuthFailure','Throttling','ThrottlingException','RequestLimitExceeded','ServiceUnavailable','ServiceUnavailableException','InternalError','InternalFailure','ExpiredToken','ExpiredTokenException'];
const retryable=new Set(['Throttling','ThrottlingException','RequestLimitExceeded','ServiceUnavailable','ServiceUnavailableException','InternalError','InternalFailure']);
export function validateAwsConfig(config){
 if(!Array.isArray(config.accounts)||!config.accounts.length||config.accounts.length>100)throw new Error('Supply 1–100 explicit AWS accounts');
 const ids=new Set();for(const a of config.accounts){
  if(!/^\d{12}$/.test(a.id)||ids.has(a.id)||!['aws','aws-us-gov','aws-cn'].includes(a.partition??'aws'))throw new Error('Invalid or duplicate AWS account');ids.add(a.id);
  if(a.profile!==undefined&&(typeof a.profile!=='string'||! /^[A-Za-z0-9][A-Za-z0-9_.@/-]{0,127}$/.test(a.profile)))throw new Error('Invalid AWS profile');
  if(!Array.isArray(a.regions)||!a.regions.length||a.regions.length>50||new Set(a.regions).size!==a.regions.length)throw new Error('Supply distinct explicit AWS regions');
  for(const region of a.regions)if(!/^[a-z]{2}(?:-[a-z0-9]+)+-\d+$/.test(region)||(a.partition==='aws-cn')!==region.startsWith('cn-')||(a.partition==='aws-us-gov')!==region.startsWith('us-gov-'))throw new Error('Region does not match supported AWS partition');
 }
 if(config.serviceTagKey!==undefined&&(typeof config.serviceTagKey!=='string'||!config.serviceTagKey.trim()))throw new Error('Invalid service tag key');
 if(config.services!==undefined&&(!Array.isArray(config.services)||config.services.some(s=>typeof s.id!=='string'||!s.id.trim())||new Set(config.services.map(s=>s.id)).size!==config.services.length))throw new Error('Service IDs must be unique');
 for(const [name,max] of [['maxDependencyDepth',5],['maxDependenciesPerService',100000]])if(config[name]!==undefined&&(!Number.isInteger(config[name])||config[name]<0||config[name]>max))throw new Error('Invalid dependency limit');
}
export function awsErrorCode(error){return codes.find(code=>error?.code===code)||'RequestFailed';}
const allowed=new Set([...awsSpecs,...awsDetails,{service:'sts',operation:'get-caller-identity'}].map(s=>s.service+':'+s.operation));
export async function runAwsCli({account,region,service,operation,input={}}){
 if(!allowed.has(service+':'+operation))throw new Error('Unsupported read operation');
 try{
  const {stdout}=await exec('aws',[service,operation,'--cli-input-json',JSON.stringify(input),'--region',region,...(account.profile?['--profile',account.profile]:[]),'--no-paginate','--no-cli-pager','--no-cli-auto-prompt','--output','json','--cli-connect-timeout','10','--cli-read-timeout','30'],{timeout:45000,maxBuffer:32*1024*1024,env:{...process.env,AWS_MAX_ATTEMPTS:'1',AWS_PAGER:''}});
  return JSON.parse(stdout);
 }catch(error){const stderr=String(error.stderr??'');const code=codes.find(c=>new RegExp('\\('+c+'\\)').test(stderr));const clean=new Error('AWS read operation failed');clean.code=code??'RequestFailed';throw clean;}
}
export async function collectAws(config,{run=runAwsCli,sleep=ms=>new Promise(r=>setTimeout(r,ms)),now=()=>new Date().toISOString(),maxPages=1000}={}){
 validateAwsConfig(config);if(!Number.isInteger(maxPages)||maxPages<1||maxPages>10000)throw new Error('Invalid pagination bound');
 const inventory={inventoryVersion:'aws-api-inventory/0.1',provider:'aws',accounts:config.accounts.map(a=>({id:a.id,partition:a.partition??'aws',regions:[...a.regions]})),startedAt:now(),finishedAt:null,collections:[],records:[],limitations:['Only selected EC2, Auto Scaling, ELBv2, RDS and regional tagging APIs are collected; other services and global routing are not covered.','Tagging API does not return all untagged or unsupported resources; explicit service APIs supplement it.','Configuration observations are not an atomic snapshot and do not establish workload paths, measured transaction capacity or recovery guarantees.','Launch-template versions/user data, scaling schedules, warm pools, listener non-default rules, IAM policies and network reachability are not collected.']};
 async function request(args){for(let attempt=0;;attempt++){try{return await run(args);}catch(error){if(attempt>=3||!retryable.has(awsErrorCode(error)))throw error;await sleep(250*2**attempt);}}}
 // Authenticate all requested scopes before collecting anything. Never scan a profile's wrong account.
 for(const account of config.accounts){const identity=await request({account,region:account.regions[0],service:'sts',operation:'get-caller-identity',input:{}});if(identity.Account!==account.id||!String(identity.Arn).startsWith('arn:'+(account.partition??'aws')+':'))throw new Error('AWS signed-in account or partition differs from configured scope');}
 async function collect(account,region,spec,input={},parentId=null){
  const id='collection-'+inventory.collections.length;const c={id,accountId:account.id,partition:account.partition??'aws',region,source:spec.service+':'+spec.operation,...(parentId?{parentId}:{}),status:'partial',paginationComplete:false,permissionCoverage:'unverified',startedAt:now(),finishedAt:null,pages:0,recordCount:0,errorCode:null};inventory.collections.push(c);
  let token;const seen=new Set();try{do{
   if(c.pages>=maxPages)throw Object.assign(new Error(),{code:'PageLimit'});
   const result=await request({account,region,service:spec.service,operation:spec.operation,input:{...input,...(token?{[spec.token]:token}:{})}});
   if(!Array.isArray(result[spec.result]))throw Object.assign(new Error(),{code:'InvalidResponse'});
   const rows=spec.flatten?result[spec.result].flatMap(row=>{if(!Array.isArray(row[spec.flatten]))throw Object.assign(new Error(),{code:'InvalidResponse'});return row[spec.flatten];}):result[spec.result];
   c.pages++;for(const row of rows){let nativeId=spec.id?row[spec.id]:parentId+'#target/'+encodeURIComponent(row.Target?.Id??'')+'/'+encodeURIComponent(row.Target?.Port??'')+'/'+encodeURIComponent(row.Target?.AvailabilityZone??'');
    if(typeof nativeId!=='string'||!nativeId)throw Object.assign(new Error(),{code:'InvalidResponse'});
    if(spec.arn)nativeId=`arn:${account.partition??'aws'}:ec2:${region}:${account.id}:${spec.arn}/${nativeId}`;
    inventory.records.push({collectionId:id,accountId:account.id,partition:account.partition??'aws',region,observedAt:now(),nativeId,nativeType:spec.type,kind:spec.kind,parentId,configuration:redact(row)});c.recordCount++;
   }
   const next=spec.token?result[spec.outToken??spec.token]:null;
   if(next!==undefined&&next!==null&&typeof next!=='string')throw Object.assign(new Error(),{code:'InvalidResponse'});
   if(next&&seen.has(next))throw Object.assign(new Error(),{code:'RepeatedToken'});
   if(next)seen.add(next);token=next||null;
  }while(token);c.status='collected';c.paginationComplete=true;
  }catch(error){const code=error.code;c.errorCode=['PageLimit','InvalidResponse','RepeatedToken'].includes(code)?code:awsErrorCode(error);c.status=['AccessDenied','AccessDeniedException','UnauthorizedOperation'].includes(c.errorCode)?'denied':'partial';}finally{c.finishedAt=now();}
 }
 for(const account of config.accounts)for(const region of account.regions){
  for(const spec of awsSpecs){if(spec.once&&region!==account.regions[0])continue;await collect(account,region,spec);}
  for(const detail of awsDetails){const parents=inventory.records.filter(r=>r.accountId===account.id&&r.region===region&&r.nativeType===detail.parent);for(const p of parents)await collect(account,region,detail,{[detail.parameter]:p.nativeId},p.nativeId);}
 }
 inventory.finishedAt=now();return inventory;
}
