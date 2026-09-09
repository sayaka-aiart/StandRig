import { createLocalService } from '../apps/service/dist/service.js';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { writePsdUint8Array } from 'ag-psd';

const dir=await mkdtemp(path.join(os.tmpdir(),'standrig-browser-'));
const image=(color)=>({width:32,height:32,data:new Uint8ClampedArray(Array.from({length:32*32},()=>color).flat())});
const layers=[{name:'Head',left:16,top:8,imageData:image([100,210,190,255])},{name:'Body',left:16,top:40,imageData:image([50,110,150,255])}];
for (const [name,children] of [['parts',layers],['single',[layers[0]]]]) {
  const psd=writePsdUint8Array({width:64,height:80,children},{generateThumbnail:false});
  await writeFile(path.join(dir,name+'.psd'),psd);
}
const service=await createLocalService({dataDir:dir,port:Number(process.env.STANDRIG_TEST_PORT??5192)});
await mkdir('reports',{recursive:true});
await writeFile('reports/browser-session.json',JSON.stringify({dir,url:service.url},null,2));
console.log(JSON.stringify({dir,url:service.url}));
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>void service.close().then(()=>process.exit(0)));
