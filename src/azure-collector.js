// Azure public cloud only. POST is solely the read-only Resource Graph query operation.
export const endpoint='https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2024-04-01';
export const tables=['Resources','ResourceContainers'];
const guid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sensitive=/^(password|adminPassword|administratorLoginPassword|clientSecret|accessToken|refreshToken|connectionStrings?|primaryKey|secondaryKey|customData|userData|protectedSettings|protectedSettingsFromKeyVault)$/i;
export function redact(value){
 if(Array.isArray(value))return value.map(redact);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,sensitive.test(k)?'[REDACTED]':redact(v)]));
 return value;
}
export function validateScope(subscriptions){
 if(!Array.isArray(subscriptions)||!subscriptions.length||subscriptions.length>5000||subscriptions.some(id=>!guid.test(id)))throw new Error('Supply 1–5000 explicit Azure subscription UUIDs.');
 if(new Set(subscriptions.map(s=>s.toLowerCase())).size!==subscriptions.length)throw new Error('Subscription scope contains duplicates.');
}
export async function collectAzure({subscriptions,resourceGroups,getToken,fetchImpl=fetch,sleep=ms=>new Promise(r=>setTimeout(r,ms)),now=()=>new Date().toISOString(),concurrency=4}){
 validateScope(subscriptions);
 if(resourceGroups!==undefined&&(!Array.isArray(resourceGroups)||!resourceGroups.length||resourceGroups.some(s=>typeof s!=='string'||! /^[\p{L}\p{N}_.()-]{1,90}$/u.test(s))))throw new Error('Invalid Azure resource groups');
 if(typeof getToken!=='function')throw new Error('An Azure token provider is required.');
 if(!Number.isInteger(concurrency)||concurrency<1||concurrency>8)throw new Error('Concurrency must be 1–8.');
 const inventory={inventoryVersion:'azure-resource-graph/0.1',provider:'azure',startedAt:now(),finishedAt:null,subscriptions:[...subscriptions],collections:[],records:[],limitations:['Resource Graph returns resources visible to the current identity; a successful query does not prove full subscription permissions.','Results are a collection interval, not an atomic snapshot.','Only Resource Graph Resources and ResourceContainers tables are collected; data-plane, provider detail APIs and runtime health are not queried.']};
 const tasks=subscriptions.flatMap(subscriptionId=>tables.map(table=>({subscriptionId,table})));
 let cursor=0;
 async function request(body){
  for(let attempt=0;attempt<4;attempt++){
   let response;
   try{response=await fetchImpl(endpoint,{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),headers:{Authorization:'Bearer '+await getToken(),'Content-Type':'application/json'},body:JSON.stringify(body)});}catch{throw new Error('Resource Graph transport or authentication failed.');}
   if(response.ok){try{return await response.json();}catch{throw new Error('Resource Graph returned invalid JSON.');}}
   if([429,500,502,503,504].includes(response.status)&&attempt<3){
    const header=response.headers.get('retry-after');const seconds=Number(header);const date=Date.parse(header);
    const delay=header!==null&&Number.isFinite(seconds)?seconds*1000:Number.isFinite(date)?Math.max(0,date-Date.now()):1000*2**attempt;
    if(delay>60000)throw new Error('Resource Graph requested a retry after more than 60 seconds; collection deferred.');
    await sleep(Math.max(0,delay));continue;
   }
   // Avoid retaining response bodies, which may contain identifiers or credentials in errors.
   throw new Error('Resource Graph HTTP '+response.status);
  }
 }
 async function worker(){while(cursor<tasks.length){
  const {subscriptionId,table}=tasks[cursor++];
  const collection={subscriptionId,table,status:'partial',paginationComplete:false,permissionCoverage:'unverified',startedAt:now(),finishedAt:null,pages:0,recordCount:0,error:null};
  inventory.collections.push(collection);let token=null;const seen=new Set();
  try{do{
   const filter=resourceGroups?' | where '+(table==='Resources'?'resourceGroup':'name')+' in~ ('+resourceGroups.map(s=>JSON.stringify(s)).join(',')+')':'';
   const body={subscriptions:[subscriptionId],query:table+filter+' | project id, name, type, location, subscriptionId, resourceGroup, tags, '+(table==='Resources'?'zones, sku, kind, ':'')+'properties | order by id asc',options:{$top:1000,resultFormat:'objectArray',...(token?{$skipToken:token}:{})}};
   const result=await request(body);
   if(!Array.isArray(result.data))throw new Error('Resource Graph returned an unsupported result shape.');
   collection.pages++;const observedAt=now();
   for(const resource of result.data){
    if(typeof resource.id!=='string')throw new Error('Resource Graph returned a resource without an ID.');
    inventory.records.push({table,subscriptionId,observedAt,resource:redact(resource)});collection.recordCount++;
   }
   const next=result.$skipToken;
   if(next&&typeof next!=='string')throw new Error('Invalid pagination token.');
   if(next&&seen.has(next))throw new Error('Resource Graph repeated a pagination token.');
   if(next)seen.add(next);
   if(!next&&(result.resultTruncated===true||String(result.resultTruncated).toLowerCase()==='true'))throw new Error('Results are truncated without a continuation token.');
   token=next??null;
  }while(token);
  collection.status='collected';collection.paginationComplete=true;
  }catch(error){collection.error=error.message;}finally{collection.finishedAt=now();}
 }}
 await Promise.all(Array.from({length:Math.min(concurrency,tasks.length)},worker));
 inventory.collections.sort((a,b)=>(a.subscriptionId+a.table).localeCompare(b.subscriptionId+b.table));
 inventory.records.sort((a,b)=>a.resource.id.localeCompare(b.resource.id));inventory.finishedAt=now();
 return inventory;
}
