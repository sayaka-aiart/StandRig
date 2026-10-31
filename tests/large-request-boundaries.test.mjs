import {test} from 'node:test';import assert from 'node:assert/strict';
import {readFile,mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {Readable} from 'node:stream';import {gzipSync,brotliCompressSync} from 'node:zlib';
import {readRequestBody} from '../apps/service/dist/httpBody.js';
import {runServiceQa} from '../apps/service/dist/qaRunner.js';
import {createLocalService} from '../apps/service/dist/service.js';
import {parameterDefinitionsForRig} from '@standrig/core/parameters';
const sample=JSON.parse(await readFile(new URL('../examples/sample.standrig.json',import.meta.url),'utf8'));
test('compressed bodies preserve split UTF-8 and reject excessive expanded data and unsupported encodings',async()=>{
 const text=JSON.stringify({text:'日本語'.repeat(100)}),bytes=Buffer.from(text);
 for(const [encoding,data]of [['identity',bytes],['gzip',gzipSync(bytes)],['br',brotliCompressSync(bytes)]]){
  const req=Readable.from(Array.from(data,b=>Buffer.from([b])));req.headers={'content-encoding':encoding};assert.equal(await readRequestBody(req,4096),text);
 }
 const bomb=Readable.from([gzipSync(Buffer.alloc(5000,65))]);bomb.headers={'content-encoding':'gzip'};await assert.rejects(readRequestBody(bomb,1024),/too_large/);
 const unknown=Readable.from([]);unknown.headers={'content-encoding':'unknown'};await assert.rejects(readRequestBody(unknown,1024),/unsupported/);
});
test('worker cancellation releases admission and cached QA results cannot be poisoned by callers',async()=>{
 const controller=new AbortController(),request={poseSamples:[{poseId:'cancel-live',values:{}}],width:96,height:96,regions:['full'],physics:false};
 await assert.rejects(runServiceQa(sample,'.',request,{workers:1},()=>setTimeout(()=>controller.abort(),0),controller.signal));
 const first=await runServiceQa(sample,'.',request,{workers:1});first.entries[0].issues.push('caller mutation');
 const cached=await runServiceQa(sample,'.',request,{workers:1});assert.equal(cached.cache,'hit');assert.equal(cached.entries[0].issues.includes('caller mutation'),false);
});
test('motion input accepts more than one MiB without thinning keys',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'standrig-motion-large-'));let service;
 try{await mkdir(path.join(dir,'public'));await writeFile(path.join(dir,'public/rig.json'),JSON.stringify(sample));service=await createLocalService({dataDir:dir,port:0});
  const definitions=parameterDefinitionsForRig(sample).slice(0,12),clip={format:'standrig-motion',version:1,name:'Large synthetic motion',duration:10,tracks:definitions.map(p=>({parameter:p.id,keys:Array.from({length:3500},(_,i)=>({time:10*i/3499,value:(p.min+p.max)/2}))}))};
  const body=JSON.stringify({action:'load',clip});assert.ok(Buffer.byteLength(body)>1048576);
  const response=await fetch(service.url+'/api/playback/motion',{method:'POST',headers:{'content-type':'application/json'},body});assert.equal(response.status,200,await response.text());
  const exported=await fetch(service.url+'/api/playback/motion').then(r=>r.json());assert.deepEqual(exported.clip,clip);
 }finally{await service?.close();await rm(dir,{recursive:true,force:true});}
});
