import fs from 'node:fs';
import Ajv from 'ajv';
const schema=JSON.parse(fs.readFileSync(new URL('../cloud-inventory.schema.json',import.meta.url)));
const validate=new Ajv({strict:true,allErrors:true}).compile(schema);
export function validateCloudInventory(snapshot){
 if(!validate(snapshot))throw new Error('Cloud inventory does not match schema');
 const fail=()=>{throw new Error('Cloud inventory has invalid references, evidence or timestamps');};
 const unique=(rows,field)=>{const map=new Map();for(const row of rows){if(map.has(row[field]))fail();map.set(row[field],row);}return map;};
 const scopes=unique(snapshot.scopes,'id'),collections=unique(snapshot.collections,'id'),resources=unique(snapshot.resources,'key'),evidence=unique(snapshot.evidence,'id');unique(snapshot.relationships,'id');unique(snapshot.services,'id');
 const time=value=>{if(!/^\d{4}-\d{2}-\d{2}T.*Z$/.test(value)||!Number.isFinite(Date.parse(value)))fail();return Date.parse(value);};
 if(time(snapshot.startedAt)>time(snapshot.finishedAt))fail();
 for(const c of collections.values())if(!scopes.has(c.scopeId)||time(c.startedAt)>time(c.finishedAt))fail();
 for(const e of evidence.values()){if(!collections.has(e.collectionId))fail();time(e.observedAt);}
 const resolve=(id,pointer)=>{if(!evidence.has(id)||!pointer.startsWith('/'))fail();let value=evidence.get(id).record;for(const part of pointer.slice(1).split('/'))value=value?.[part.replace(/~1/g,'/').replace(/~0/g,'~')];return value;};
 for(const r of resources.values()){
  if(!scopes.has(r.scopeId)||r.evidenceIds.some(id=>!evidence.has(id)||collections.get(evidence.get(id).collectionId)?.scopeId!==r.scopeId))fail();
  for(const f of r.facts){const value=resolve(f.evidenceId,f.sourcePointer);if(f.status==='observed'&&JSON.stringify(value)!==JSON.stringify(f.value))fail();}
 }
 for(const s of snapshot.services){unique(s.memberships,'resourceKey');if(s.memberships.some(m=>!resources.has(m.resourceKey)))fail();}
 for(const e of snapshot.relationships){if(!resources.has(e.from)||(e.target.resourceKey!==null&&!resources.has(e.target.resourceKey))||resolve(e.evidenceId,e.sourcePointer)===undefined)fail();if((e.target.resolution==='unresolved')!==(e.target.resourceKey===null))fail();}
 return true;
}
