#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {collectSnapshot,isPartial} from '../src/collect.js';
export const help=`Cloud Resource Collectors

node bin/cloud-collect.js --cloud azure|aws|gcp --project ID [--project ID ...]
  [--region REGION ...] [--profile AWS_PROFILE] [--identity GCLOUD_ACCOUNT]
  [--resource-group AZURE_GROUP ...] --output FILE.json

Or: --cloud CLOUD --config CONFIG.json --output FILE.json
Offline: add --inventory INVENTORY.json (must match the configured scope).

--project means Azure subscription ID, AWS account ID, or GCP project ID.
--region is required for AWS/GCP flags-based scopes. Repeat it for more regions.
Azure resource groups optionally narrow the selected subscriptions.
For per-account AWS profiles/partitions or GCP project numbers use --config.
All observed resources in scope are exported, including unlabelled resources.
Cloud credentials must already be available through the relevant official CLI.
No existing output is overwritten. Exit 0=selected queries complete, 2=partial,
1=input/authentication/validation/output failure. See README.md for coverage.
`;
export function parseArgs(args){
 const repeat=new Set(['--project','--region','--resource-group']),single=new Set(['--cloud','--config','--output','--inventory','--profile','--identity']);const options={};
 for(let i=0;i<args.length;i+=2){const flag=args[i],value=args[i+1];if((!repeat.has(flag)&&!single.has(flag))||!value||value.startsWith('--'))throw new Error('Invalid arguments; run with --help');if(single.has(flag)&&options[flag]!==undefined)throw new Error('Duplicate option');if(repeat.has(flag))(options[flag]??=[]).push(value);else options[flag]=value;}
 if(!['azure','aws','gcp'].includes(options['--cloud'])||!options['--output'])throw new Error('Supply --cloud and --output');
 const cloud=options['--cloud'];if(options['--config']&&['--project','--region','--profile','--identity','--resource-group'].some(k=>options[k]!==undefined))throw new Error('Use either --config or scope flags, not both');
 if(!options['--config']){
  if(!options['--project']?.length)throw new Error('Supply one or more --project IDs');
  if(cloud!=='azure'&&!options['--region']?.length)throw new Error('Supply one or more --region values');
  if((cloud!=='azure'&&options['--resource-group'])||(cloud!=='aws'&&options['--profile'])||(cloud!=='gcp'&&options['--identity'])||(cloud==='azure'&&options['--region']))throw new Error('Option does not apply to this cloud');
 }
 return options;
}
export function configFromArgs(o){
 const projects=o['--project'];if(o['--cloud']==='azure')return {subscriptions:projects,...(o['--resource-group']?{resourceGroups:o['--resource-group']}:{})};
 if(o['--cloud']==='aws')return {accounts:projects.map(id=>({id,partition:'aws',regions:o['--region'],...(o['--profile']?{profile:o['--profile']}:{})}))};
 return {projects:projects.map(id=>({id,regions:o['--region']})),...(o['--identity']?{account:o['--identity']}:{})};
}
export async function main(args,{collect=collectSnapshot,log=console.log}={}){
 if(args.length===1&&['--help','-h'].includes(args[0])){log(help);return 0;}
 const o=parseArgs(args),dest=path.resolve(o['--output']);
 // Refuse an existing file before making any cloud calls.
 try{await fs.lstat(dest);throw new Error('Output already exists; choose a new file');}catch(error){if(error.code!=='ENOENT')throw error;}
 const read=async file=>JSON.parse(await fs.readFile(file,'utf8'));
 const config=o['--config']?await read(o['--config']):configFromArgs(o);
 const snapshot=await collect({cloud:o['--cloud'],config,...(o['--inventory']?{inventory:await read(o['--inventory'])}:{})});
 await fs.mkdir(path.dirname(dest),{recursive:true,mode:0o700});await fs.writeFile(dest,JSON.stringify(snapshot,null,2)+'\n',{flag:'wx',mode:0o600});
 const partial=isPartial(snapshot);log(`${snapshot.scopes.length} scope(s), ${snapshot.resources.length} resources: ${dest}`);if(partial)log('Partial collection: review query coverage before assessment.');return partial?2:0;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main(process.argv.slice(2)).then(code=>{process.exitCode=code;}).catch(error=>{console.error('Collection failed. '+(/^(Output already exists|Supply |Choose |Invalid arguments|Duplicate option|Use either|Option does not apply)/.test(error.message)?error.message:'Check configuration, existing cloud CLI authentication, selected scope and output path.'));process.exitCode=1;});
