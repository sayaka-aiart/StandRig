import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';import {createHash} from 'node:crypto';
import {portableBundle} from '../apps/service/dist/portableBundle.js';
import {createSelfContainedModelBundle} from '@standrig/core/bundle';
import {stringifyModelDocument,MODEL_PRETTY_PRINT_LIMIT} from '@standrig/core/modelJson';
import {encodePng,createBlankRgba} from '@standrig/core/png';

test('model JSON stays readable when small and compact at large keyform sizes',()=>{
 const small={name:'small',values:[1,2,3]};assert.equal(stringifyModelDocument(small),JSON.stringify(small,null,2));
 const value={data:'x'.repeat(MODEL_PRETTY_PRINT_LIMIT-JSON.stringify({data:''}).length)};
 assert.equal(stringifyModelDocument(value),JSON.stringify(value,null,2));value.data+='x';
 const saved=stringifyModelDocument(value);assert.equal(saved,JSON.stringify(value));assert.deepEqual(JSON.parse(saved),value);
});

test('portable export embeds PNGs with one owned model clone and leaves inputs isolated',async t=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'standrig-portable-'));const rig=JSON.parse(await readFile(new URL('../examples/sample.standrig.json',import.meta.url),'utf8'));
 const png=encodePng(createBlankRgba(2,2));rig.assets=[{id:'a',src:'/pixel.png',width:2,height:2}];await writeFile(path.join(directory,'pixel.png'),png);
 const clone=globalThis.structuredClone;let calls=0;t.mock.method(globalThis,'structuredClone',value=>{calls++;return clone(value);});
 try{const result=await portableBundle(rig,directory);assert.equal(calls,1);assert.notEqual(result.rig,rig);assert.notEqual(result.rig.parts[0],rig.parts[0]);
  assert.equal(rig.assets[0].src,'/pixel.png');assert.deepEqual(Buffer.from(result.rig.assets[0].src.split(',')[1],'base64'),Buffer.from(png));
  result.rig.parts[0].transform.x=12345;assert.notEqual(rig.parts[0].transform.x,12345);
 }finally{t.mock.restoreAll();await rm(directory,{recursive:true,force:true});}
});

test('manifest-based bundle creation also clones only once and retains PNG verification',async t=>{
 const rig=JSON.parse(await readFile(new URL('../examples/sample.standrig.json',import.meta.url),'utf8')),png=encodePng(createBlankRgba(2,2));rig.assets=[{id:'a',src:'/pixel.png',width:2,height:2}];
 const manifest={format:'standrig-assets',version:1,entries:[{assetId:'a',path:'/pixel.png',sha256:createHash('sha256').update(png).digest('hex'),mediaType:'image/png',bytes:png.length}]};
 const clone=globalThis.structuredClone;let calls=0;t.mock.method(globalThis,'structuredClone',value=>{calls++;return clone(value);});
 const result=await createSelfContainedModelBundle(rig,manifest,async()=>png);assert.equal(calls,1);assert.equal(rig.assets[0].src,'/pixel.png');assert.notEqual(result.rig.parts[0],rig.parts[0]);
 await assert.rejects(()=>createSelfContainedModelBundle(rig,manifest,async()=>new Uint8Array([1,2,3])),/hash mismatch/);
});
