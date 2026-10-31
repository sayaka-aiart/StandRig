import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';import http from 'node:http';
import {gzipSync,brotliDecompressSync,gunzipSync} from 'node:zlib';
import {createLocalService} from '../apps/service/dist/service.js';
import {ModelResponseCache} from '../apps/service/dist/modelResponseCache.js';
import {createModelingContext} from '../apps/service/dist/application/context.js';
import ts from 'typescript';
const request=(url,{method='GET',headers={},body}={})=>new Promise((resolve,reject)=>{const req=http.request(url,{method,headers},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,bytes:Buffer.concat(chunks)}));});req.on('error',reject);req.end(body);});
test('model responses negotiate compression, revalidate, isolate views and invalidate external replacements',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'standrig-transport-'));let service;
 try{service=await createLocalService({dataDir:dir,port:0});const url=service.url+'/api/rig?includeAssets=1';
  const direct=new ModelResponseCache(createModelingContext(dir));
  // Exercise negotiation directly too: host HTTP tooling may remove br from outgoing headers.
  const br={headers:{},setHeader(k,v){this.headers[k]=v;},writeHead(status,headers){this.status=status;Object.assign(this.headers,headers);},end(bytes){this.bytes=bytes;}};
  await direct.respond({method:'GET',headers:{'accept-encoding':'br,gzip;q=0.5'}},br,false,true);
  const plain=await request(url),zip=await request(url,{headers:{'accept-encoding':'gzip'}});
  assert.equal(zip.headers['content-encoding'],'gzip');assert.deepEqual(gunzipSync(zip.bytes),plain.bytes);assert.equal(br.status,200,br.bytes.toString());assert.equal(br.headers['content-encoding'],'br');assert.deepEqual(brotliDecompressSync(br.bytes),plain.bytes);
  const cached=await request(url,{headers:{'if-none-match':plain.headers.etag,'accept-encoding':'br'}});assert.equal(cached.status,304);assert.equal(cached.bytes.length,0);
  assert.notEqual((await request(service.url+'/api/rig')).headers.etag,plain.headers.etag);
  assert.equal((await request(url,{headers:{'accept-encoding':'br;q=0,gzip;q=0,identity;q=0'}})).status,406);
  const file=path.join(dir,'public/rig.json'),rig=JSON.parse(await readFile(file));rig.name='external replacement';await writeFile(file,JSON.stringify(rig));
  const next=await request(url,{headers:{'if-none-match':plain.headers.etag}});assert.equal(next.status,200);assert.equal(JSON.parse(next.bytes).name,rig.name);assert.notEqual(next.headers.etag,plain.headers.etag);
  const context=await request(service.url+'/api/context');assert.equal((await request(service.url+'/api/context',{headers:{'if-none-match':context.headers.etag}})).status,304);
  const good=await request(service.url+'/api/playback/parameters',{method:'POST',headers:{'content-encoding':'gzip'},body:gzipSync(JSON.stringify({source:'transport',sequence:1,values:{}}))});assert.equal(good.status,200);
  const bomb=await request(service.url+'/api/playback/parameters',{method:'POST',headers:{'content-encoding':'gzip'},body:gzipSync(JSON.stringify({padding:'a'.repeat(2*1024*1024)}))});assert.equal(bomb.status,400);
 }finally{await service?.close();await rm(dir,{recursive:true,force:true});}
});
test('player coalesces loads, backs off on failure and discards superseded models',async()=>{
 const source=await readFile(new URL('../apps/preview/src/modelReload.ts',import.meta.url),'utf8');
 const {ModelReload}=await import('data:text/javascript;base64,'+Buffer.from(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText).toString('base64'));
 let calls=0,active=0,maxActive=0,fail=true,release;const installed=[],discarded=[],errors=[];
 const loader=new ModelReload({key:s=>s.key,baseDelay:25,maxDelay:50,random:()=>.5,load:async s=>{calls++;active++;maxActive=Math.max(maxActive,active);try{if(fail)throw Error('offline');await new Promise(r=>release=r);return s.key;}finally{active--; }},install:m=>installed.push(m),apply:()=>{},discard:m=>discarded.push(m),error:e=>errors.push(e)});
 loader.update({key:'a'});await new Promise(r=>setTimeout(r,2));for(let i=0;i<100;i++)loader.update({key:'a'});assert.equal(calls,1);
 fail=false;await new Promise(r=>setTimeout(r,35));assert.equal(calls,2);loader.update({key:'b'});release();await new Promise(r=>setTimeout(r,2));assert.deepEqual(discarded,['a']);assert.equal(calls,3);release();await new Promise(r=>setTimeout(r,2));assert.deepEqual(installed,['b']);assert.equal(maxActive,1);loader.dispose();
});
test('player retry intervals double to the cap and stop after disposal',async t=>{
 const source=await readFile(new URL('../apps/preview/src/modelReload.ts',import.meta.url),'utf8');
 const {ModelReload}=await import('data:text/javascript;base64,'+Buffer.from(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText).toString('base64'));
 t.mock.timers.enable({apis:['setTimeout']});let calls=0;
 const flush=async()=>{for(let i=0;i<5;i++)await Promise.resolve();};
 const loader=new ModelReload({key:s=>s,baseDelay:100,maxDelay:250,random:()=>.5,load:async()=>{calls++;throw Error('offline');},install:()=>{},apply:()=>{},discard:()=>{},error:()=>{}});
 loader.update('model');await flush();assert.equal(calls,1);
 for(const [delay,expected]of [[100,2],[200,3],[250,4]]){t.mock.timers.tick(delay-1);await flush();assert.equal(calls,expected-1);t.mock.timers.tick(1);await flush();assert.equal(calls,expected);}
 loader.dispose();t.mock.timers.tick(1000);await flush();assert.equal(calls,4);
});
