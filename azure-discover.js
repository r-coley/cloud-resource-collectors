#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import {collectAzure,validateScope} from './src/azure-collector.js';
import {normaliseAzure} from './src/normalise.js';
import {toCloudInventory} from './src/cloud-inventory.js';
import {discoveryReport} from './src/report.js';
const exec=promisify(execFile);
export async function main(args){
 const opts={};for(let i=0;i<args.length;i+=2){if(!['--config','--inventory','--output'].includes(args[i])||!args[i+1]||args[i+1].startsWith('--')||opts[args[i]])throw new Error('Usage: node azure-discover.js --config CONFIG.json [--inventory INVENTORY.json] --output NEW_DIRECTORY');opts[args[i]]=args[i+1];}
 if(!opts['--config']||!opts['--output'])throw new Error('Both --config and --output are required.');
 const config=JSON.parse(await fs.readFile(opts['--config'],'utf8'));validateScope(config.subscriptions);
 let inventory;
 if(opts['--inventory']){
  inventory=JSON.parse(await fs.readFile(opts['--inventory'],'utf8'));
  if(JSON.stringify([...inventory.subscriptions].sort())!==JSON.stringify([...config.subscriptions].sort()))throw new Error('Inventory subscription scope differs from the configured scope.');
 }else{
  console.log('Collecting visible Azure configuration using the existing Azure CLI sign-in…');
  let token,expiresAt=0;
  const getToken=async()=>{
   if(token&&Date.now()<expiresAt)return token;
   let result;try{result=await exec('az',['account','get-access-token','--resource','https://management.azure.com/','--subscription',config.subscriptions[0],'--output','json'],{timeout:30000,maxBuffer:1024*1024});}catch{throw new Error('Azure CLI authentication unavailable. Install Azure CLI and sign in to the intended tenant first.');}
   const auth=JSON.parse(result.stdout);if(!auth.accessToken)throw new Error('Azure CLI did not return an access token.');token=auth.accessToken;expiresAt=Math.min(Date.now()+240000,Number(auth.expires_on)*1000-60000||Date.now()+240000);return token;
  };
  inventory=await collectAzure({subscriptions:config.subscriptions,getToken});
 }
 const estate=normaliseAzure(inventory,{tagKey:config.serviceTagKey??'serviceId',catalogue:config.services??[],maxDependencyDepth:config.maxDependencyDepth??2,maxDependenciesPerService:config.maxDependenciesPerService??1000});
 const dest=path.resolve(opts['--output']);await fs.mkdir(dest,{recursive:false,mode:0o700});
 const save=(name,value)=>fs.writeFile(path.join(dest,name),value,{mode:0o600});
 await save('cloud-inventory.json',JSON.stringify(toCloudInventory(estate,{origin:inventory.synthetic===true?'synthetic':opts['--inventory']?'provided':'live'}),null,2)+'\n');
 await save('estate.json',JSON.stringify(estate,null,2)+'\n');
 await fs.mkdir(path.join(dest,'services'),{mode:0o700});
 for(const [index,service] of estate.services.entries())await save('services/'+String(index+1).padStart(5,'0')+'.json',JSON.stringify({...service,evidence:estate.evidence.filter(e=>service.resources.some(r=>r.evidenceId===e.id))},null,2)+'\n');
 await save('report.html',discoveryReport(estate));
 const incomplete=estate.collections.some(c=>c.status!=='collected');
 console.log(`${estate.services.length} service snapshots written to ${dest}`);
 console.log(`Open ${path.join(dest,'report.html')}`);
 if(incomplete){console.log('Collection is partial. Review collection coverage before assessment.');return 2;}return 0;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main(process.argv.slice(2)).then(code=>{process.exitCode=code;}).catch(()=>{console.error('Discovery could not complete. Check the configuration, Azure CLI sign-in, input files and that the output directory does not already exist.');process.exitCode=1;});
