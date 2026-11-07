import neo4j from 'neo4j-driver';
import {randomUUID} from 'node:crypto';
import {prepareImport,GRAPH_MODEL_VERSION} from './model.js';

export const labels=new Set(['Project','ProjectObservation','Collection','Evidence','Resource','ResourceObservation','Fact','Service','ServiceObservation','Gap','ConfigurationReference','UnresolvedTarget']);
export const relationshipTypes=new Set(['HAS_PROJECT','OF_PROJECT','HAS_COLLECTION','IN_PROJECT','HAS_EVIDENCE','FROM_COLLECTION','HAS_RESOURCE','OF_RESOURCE','SUPPORTED_BY','HAS_FACT','HAS_SERVICE','OF_SERVICE','HAS_MEMBER','HAS_GAP','HAS_REFERENCE','TARGETS','CONFIGURATION_REFERENCE','CONTAINED_BY','POINTS_TO','UNRESOLVED_REFERENCE']);
export function connectionFromEnv(env=process.env,overrides={}){
 const uri=overrides.uri??env.NEO4J_URI??'bolt://127.0.0.1:7687',username=env.NEO4J_USERNAME??'neo4j',password=env.NEO4J_PASSWORD,database=overrides.database??env.NEO4J_DATABASE??'neo4j';
 let parsed;try{parsed=new URL(uri);}catch{throw new Error('Invalid Neo4j URI');}
 if(!['bolt:','bolt+s:','bolt+ssc:','neo4j:','neo4j+s:','neo4j+ssc:'].includes(parsed.protocol)||parsed.username||parsed.password||!parsed.hostname)throw new Error('Invalid Neo4j URI');
 if(!password||!username||!database)throw new Error('Set NEO4J_PASSWORD and valid connection settings');
 return {uri,username,password,database};
}
export function openDriver(config){return neo4j.driver(config.uri,neo4j.auth.basic(config.username,config.password),{connectionTimeout:15000,maxTransactionRetryTime:15000});}
export function native(value){
 if(neo4j.isInt(value))return value.inSafeRange()?value.toNumber():value.toString();
 if(Array.isArray(value))return value.map(native);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,native(v)]));return value;
}
export async function ensureSchema(driver,database='neo4j'){
 const session=driver.session({database});try{
  await session.run('CREATE CONSTRAINT inventory_entity_id IF NOT EXISTS FOR (n:InventoryEntity) REQUIRE n.id IS UNIQUE');
  await session.run('CREATE INDEX inventory_project_scope IF NOT EXISTS FOR (n:Project) ON (n.scopeId)');
  await session.run('CREATE INDEX inventory_project_account IF NOT EXISTS FOR (n:Project) ON (n.accountId)');
  await session.run('CREATE INDEX inventory_snapshot_id IF NOT EXISTS FOR (n:Snapshot) ON (n.snapshotId)');
 }finally{await session.close();}
}
export async function writePlan(tx,plan,{batchSize=500,now=()=>new Date().toISOString()}={}){
 if(!Number.isInteger(batchSize)||batchSize<1||batchSize>5000)throw new Error('Invalid graph batch size');
 if(plan.nodes.some(n=>!labels.has(n.label))||plan.edges.some(e=>!relationshipTypes.has(e.type)))throw new Error('Unsupported graph label or relationship');
 const token=randomUUID();
 const result=await tx.run(`MERGE (s:InventoryEntity:Snapshot {id: $id})
 ON CREATE SET s += $properties, s.payloadHash=$hash, s.importToken=$token, s.importedAt=$now, s.state='importing'
 SET s.importLock=true
 RETURN s.payloadHash AS payloadHash, s.importToken AS importToken, s.state AS state, s.graphModelVersion AS graphModelVersion`,{id:plan.snapshotNodeId,properties:plan.snapshotProperties,hash:plan.payloadHash,token,now:now()});
 const row=result.records[0];
 if(row.get('payloadHash')!==plan.payloadHash||row.get('graphModelVersion')!==GRAPH_MODEL_VERSION)throw new Error('Snapshot ID already exists with different content or graph model');
 if(row.get('importToken')!==token){if(row.get('state')!=='complete')throw new Error('Snapshot is not in a complete state');return {snapshotId:plan.snapshotId,status:'already-imported'};}
 for(const label of labels){const rows=plan.nodes.filter(n=>n.label===label);for(let i=0;i<rows.length;i+=batchSize)await tx.run(`UNWIND $rows AS row MERGE (n:InventoryEntity {id: row.id}) SET n:${label} SET n += row.properties`,{rows:rows.slice(i,i+batchSize)});}
 for(const type of relationshipTypes){const rows=plan.edges.filter(e=>e.type===type);for(let i=0;i<rows.length;i+=batchSize)await tx.run(`UNWIND $rows AS row MATCH (a:InventoryEntity {id: row.from}), (b:InventoryEntity {id: row.to}) MERGE (a)-[r:${type} {identity: coalesce(row.properties.referenceId, '')}]->(b) SET r += row.properties`,{rows:rows.slice(i,i+batchSize)});}
 await tx.run("MATCH (s:InventoryEntity:Snapshot {id:$id}) SET s.state='complete'",{id:plan.snapshotNodeId});
 return {snapshotId:plan.snapshotId,status:'imported',nodes:plan.nodes.length+1,relationships:plan.edges.length};
}
export async function importSnapshots(driver,snapshots,{database='neo4j',batchSize=500,initialize=true}={}){
 // Prepare every input before schema or graph writes. Atomicity is per snapshot.
 const plans=snapshots.map(prepareImport);const seen=new Map();for(const p of plans){if(seen.has(p.snapshotId)&&seen.get(p.snapshotId)!==p.payloadHash)throw new Error('Snapshot ID is repeated with different content');seen.set(p.snapshotId,p.payloadHash);}if(initialize)await ensureSchema(driver,database);
 const results=[];for(const plan of plans){const session=driver.session({database});try{results.push(await session.executeWrite(tx=>writePlan(tx,plan,{batchSize})));}finally{await session.close();}}return results;
}
export async function readQuery(driver,database,query,params={}){
 const session=driver.session({database,defaultAccessMode:neo4j.session.READ});try{return await session.executeRead(async tx=>(await tx.run(query,params)).records.map(r=>native(r.toObject())));}finally{await session.close();}
}
