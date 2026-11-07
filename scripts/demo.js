import fs from 'node:fs/promises';
import {collectSnapshot} from '../src/collect.js';
import {inventoryReport} from '../src/inventory-report.js';
const read=async file=>JSON.parse(await fs.readFile(new URL('../examples/'+file,import.meta.url)));
const refresh=process.argv.includes('--refresh-examples');
for(const cloud of ['azure','aws','gcp']){
 const snapshot=await collectSnapshot({cloud,config:await read(cloud+'-service.config.json'),inventory:await read(cloud+'-service.inventory.json')});
 if(refresh)await fs.writeFile(new URL('../examples/'+cloud+'-service.cloud-inventory.json',import.meta.url),JSON.stringify(snapshot,null,2)+'\n');
 const out=new URL('../runs/demo/'+cloud+'/',import.meta.url);await fs.mkdir(out,{recursive:true,mode:0o700});
 await fs.writeFile(new URL('cloud-inventory.json',out),JSON.stringify(snapshot,null,2)+'\n',{mode:0o600});
 await fs.writeFile(new URL('report.html',out),inventoryReport(snapshot),{mode:0o600});
 console.log(`${cloud}: ${snapshot.scopes.length} scopes, ${snapshot.resources.length} resources; ${out.pathname}cloud-inventory.json`);
}
