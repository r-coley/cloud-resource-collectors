#!/usr/bin/env node
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {redactGcp as redact} from './src/gcp-collector.js';
import {collectGcp,validateGcpConfig} from './src/gcp-collector.js';
import {inventoryReport} from './src/inventory-report.js';
import {normaliseGcp} from './src/gcp-normalise.js';
import {validateCloudInventory} from './src/validate-cloud-inventory.js';
export async function main(args){
 const options={};for(let i=0;i<args.length;i+=2){if(!['--config','--inventory','--output'].includes(args[i])||!args[i+1]||args[i+1].startsWith('--')||options[args[i]])throw new Error('Usage: node gcp-discover.js --config CONFIG.json [--inventory INVENTORY.json] --output NEW_DIRECTORY');options[args[i]]=args[i+1];}
 if(!options['--config']||!options['--output'])throw new Error('Configuration and output directory required');
 const config=JSON.parse(await fs.readFile(options['--config'],'utf8'));validateGcpConfig(config);
 const inventory=options['--inventory']?JSON.parse(await fs.readFile(options['--inventory'],'utf8')):await collectGcp(config);
 const snapshot=normaliseGcp(inventory,config,{origin:inventory.synthetic===true?'synthetic':options['--inventory']?'provided':'live'});validateCloudInventory(snapshot);
 const dest=path.resolve(options['--output']);await fs.mkdir(dest,{recursive:false,mode:0o700});
 await fs.writeFile(path.join(dest,'cloud-inventory.json'),JSON.stringify(snapshot,null,2)+'\n',{mode:0o600});
 // Only save the filtered observations used by the export, never the unfiltered input.
 await fs.writeFile(path.join(dest,'gcp-inventory.json'),JSON.stringify(redact({inventoryVersion:inventory.inventoryVersion,provider:inventory.provider,projects:inventory.projects,startedAt:inventory.startedAt,finishedAt:inventory.finishedAt,collections:inventory.collections,records:snapshot.evidence.map(e=>e.record),limitations:inventory.limitations,synthetic:inventory.synthetic===true}),null,2)+'\n',{mode:0o600});
 await fs.writeFile(path.join(dest,'report.html'),inventoryReport(snapshot),{mode:0o600});
 await fs.mkdir(path.join(dest,'services'),{mode:0o700});
 for(const [i,s] of snapshot.services.entries()){
  const selected=new Set(s.memberships.map(m=>m.resourceKey)),resources=snapshot.resources.filter(r=>selected.has(r.key));
  const relationships=snapshot.relationships.filter(e=>selected.has(e.from)).map(e=>({...e,target:e.target.resourceKey&&!selected.has(e.target.resourceKey)?{...e.target,resourceKey:null,resolution:'unresolved'}:e.target}));
  const evidenceIds=new Set([...resources.flatMap(r=>r.evidenceIds),...relationships.map(r=>r.evidenceId)]),evidence=snapshot.evidence.filter(e=>evidenceIds.has(e.id));
  const serviceSnapshot={...snapshot,snapshotId:'',services:[s],resources,relationships,evidence};serviceSnapshot.snapshotId='sha256:'+createHash('sha256').update(JSON.stringify({...serviceSnapshot,snapshotId:undefined})).digest('hex');validateCloudInventory(serviceSnapshot);
  await fs.writeFile(path.join(dest,'services',String(i+1).padStart(5,'0')+'.json'),JSON.stringify(serviceSnapshot,null,2)+'\n',{mode:0o600});
 }
 const partial=snapshot.collections.some(c=>c.status!=='collected'||!c.paginationComplete)||snapshot.services.some(s=>s.gaps.some(g=>g.code==='partial-collection'));
 console.log(`${snapshot.services.length} service snapshots; ${snapshot.resources.length} selected resources written to ${dest}`);
 console.log(`Open ${path.join(dest,'report.html')}`);
 console.log(partial?'Collection is partial. Review coverage gaps before assessment.':'Selected API queries completed. Permission coverage and unsupported types still require review.');
 return partial?2:0;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main(process.argv.slice(2)).then(code=>{process.exitCode=code;}).catch(()=>{console.error('GCP discovery could not complete. Check the explicit project/region scope, gcloud sign-in, input files and new output directory.');process.exitCode=1;});
