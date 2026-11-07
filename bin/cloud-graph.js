#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {prepareImport} from '../graph/src/model.js';
import {connectionFromEnv,openDriver,ensureSchema,importSnapshots} from '../graph/src/neo4j.js';
import {listProjects,projectResources,queryResilience,queryEvidence} from '../graph/src/queries.js';

export const help=`Cloud resource graph (Neo4j 5.26+)

cloud-graph init
cloud-graph import --input FILE.json [--input FILE.json ...]
cloud-graph projects [--cloud azure|aws|gcp] [--limit N]
cloud-graph resources --project SCOPE_OR_PROJECT_ID [--snapshot ID] [--kind KIND]
cloud-graph resilience --project SCOPE_OR_PROJECT_ID [--snapshot ID]
cloud-graph evidence --snapshot ID --evidence-id LOCAL_EVIDENCE_ID

Connection: NEO4J_URI (default bolt://127.0.0.1:7687), NEO4J_USERNAME (neo4j),
NEO4J_PASSWORD (required), NEO4J_DATABASE (neo4j). --uri and --database override.
Query filters: --cloud, --origin live|synthetic|provided, --snapshot, --limit 1–5000.
Imports validate every file first and commit each snapshot atomically. Reimports
are idempotent; the same snapshot ID with changed content is rejected.
Evidence views require review and are not resilience certification.
`;
export function parseGraphArgs(args){
 const command=args[0],o={input:[]};if(!['init','import','projects','resources','resilience','evidence'].includes(command))throw new Error('Choose init, import, projects, resources, resilience or evidence');
 const allowed={init:['uri','database'],import:['input','uri','database'],projects:['cloud','limit','uri','database'],resources:['project','snapshot','kind','cloud','origin','limit','uri','database'],resilience:['project','snapshot','cloud','origin','limit','uri','database'],evidence:['snapshot','evidence-id','uri','database']};
 for(let i=1;i<args.length;i+=2){const key=args[i]?.replace(/^--/,''),value=args[i+1];if(!args[i]?.startsWith('--')||!allowed[command].includes(key)||!value||value.startsWith('--'))throw new Error('Invalid graph options; run --help');if(key==='input')o.input.push(value);else{if(o[key]!==undefined)throw new Error('Duplicate graph option');o[key]=value;}}
 if(o.cloud&&!['azure','aws','gcp'].includes(o.cloud))throw new Error('Choose azure, aws or gcp');
 if(o.origin&&!['live','provided','synthetic'].includes(o.origin))throw new Error('Invalid origin');
 if(o.limit!==undefined&&(!/^\d+$/.test(o.limit)||Number(o.limit)<1||Number(o.limit)>5000))throw new Error('Limit must be 1–5000');
 if(command==='import'&&!o.input.length)throw new Error('Supply one or more --input files');
 if(['resources','resilience'].includes(command)&&!o.project)throw new Error('Supply --project');
 if(command==='evidence'&&(!o.snapshot||!o['evidence-id']))throw new Error('Supply --snapshot and --evidence-id');
 return {command,options:{...o,limit:o.limit===undefined?1000:Number(o.limit)}};
}
export async function readSnapshots(files){
 const snapshots=[];for(const file of files){const stat=await fs.stat(file);if(!stat.isFile()||stat.size>256*1024*1024)throw new Error('Input must be a JSON file no larger than 256 MiB');const snapshot=JSON.parse(await fs.readFile(file,'utf8'));prepareImport(snapshot);snapshots.push(snapshot);}
 const seen=new Map();for(const snapshot of snapshots){const plan=prepareImport(snapshot);if(seen.has(plan.snapshotId)&&seen.get(plan.snapshotId)!==plan.payloadHash)throw new Error('Snapshot ID is repeated with different content');seen.set(plan.snapshotId,plan.payloadHash);}return snapshots;
}
export async function main(args,{env=process.env,createDriver=openDriver,log=console.log}={}){
 if(args.length===1&&['--help','-h'].includes(args[0])){log(help);return 0;}
 const {command,options:o}=parseGraphArgs(args);
 // Read and validate all files before establishing a database connection.
 const snapshots=command==='import'?await readSnapshots(o.input):null;
 const config=connectionFromEnv(env,{uri:o.uri,database:o.database}),driver=createDriver(config);
 try{
  await driver.verifyConnectivity();
  const options={database:config.database,project:o.project,cloud:o.cloud??null,snapshot:o.snapshot??null,origin:o.origin??null,kind:o.kind??null,limit:o.limit,evidenceId:o['evidence-id']};
  let result;
  if(command==='init'){await ensureSchema(driver,config.database);result={status:'initialized',database:config.database};}
  if(command==='import')result={imports:await importSnapshots(driver,snapshots,{database:config.database})};
  if(command==='projects')result=await listProjects(driver,options);
  if(command==='resources')result=await projectResources(driver,options);
  if(command==='resilience')result=await queryResilience(driver,options);
  if(command==='evidence')result=await queryEvidence(driver,options);
  log(JSON.stringify(result,null,2));return 0;
 }finally{await driver.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main(process.argv.slice(2)).then(code=>{process.exitCode=code;}).catch(error=>{const safe=/^(Choose |Invalid graph options|Duplicate graph option|Limit must|Supply |Set NEO4J_PASSWORD|Invalid Neo4j URI|No imported project observation|Project is ambiguous|Project has multiple|Snapshot ID |Cloud inventory |Input must)/.test(error.message);console.error(safe?error.message:'Graph command failed. Check JSON validity, Neo4j connection and database permissions. Run --help for usage.');process.exitCode=1;});
