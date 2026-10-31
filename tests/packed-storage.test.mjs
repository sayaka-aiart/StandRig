import {test} from 'node:test';import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm,readdir,writeFile,unlink} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {packRigDocument} from '@standrig/core/packedRig';import {migrateRigDocument} from '@standrig/core/migration';
import {createModelBundle,packModelBundle,parseModelBundle} from '@standrig/core/bundle';
import {createTrackingProfile} from '@standrig/core/trackingProfile';
import {resolveArtMesh,createRectArtMesh} from '@standrig/core/artMesh';import {EvaluationCache,withEvaluationCache} from '@standrig/core/evaluationCache';
import {CheckpointStore} from '../apps/service/dist/checkpointStore.js';
import {writeRigFile,readRigFile,fullRigRevision} from '../apps/service/dist/application/modelingSupport.js';
const sample=JSON.parse(await readFile(new URL('../examples/sample.standrig.json',import.meta.url),'utf8'));
const fixture=()=>{const rig=structuredClone(sample),part=rig.parts[0];part.artMesh=createRectArtMesh(100,100,{preset:'face-feature',columns:2,rows:2});part.artMesh.multiBindings=[{parameters:['ParamAngleX','ParamAngleY'],keyforms:[-1,1].flatMap(X=>[-1,1].map(Y=>({inputs:{ParamAngleX:X,ParamAngleY:Y},offsets:part.artMesh.vertices.map((v,i)=>({vertexId:v.id,x:X*i*.123456789,y:Y*i/32}))})))}];return rig;};
test('portable compact bundle retains name, timestamp, tracking metadata and exact original rig',()=>{
 const rig=fixture(),bundle=createModelBundle(rig,createTrackingProfile(rig));bundle.name='保存名';bundle.exportedAt='2026-10-31T01:02:03.000Z';
 // Use a larger synthetic key bank to exercise the normal packing threshold.
 const binding=rig.parts[0].artMesh.multiBindings[0];binding.keyforms=Array.from({length:500},()=>structuredClone(binding.keyforms[0]));bundle.rig=rig;
 const wire=JSON.parse(JSON.stringify(packModelBundle(bundle)));assert.equal(wire.format,'standrig-bundle');assert.equal(wire.name,bundle.name);assert.equal(wire.exportedAt,bundle.exportedAt);assert.equal(wire.rig.format,'standrig-packed');
 assert.deepEqual(wire.trackingProfile,JSON.parse(JSON.stringify(bundle.trackingProfile)));assert.equal(JSON.stringify(parseModelBundle(wire).trackingProfile),JSON.stringify(bundle.trackingProfile));
 assert.equal(JSON.stringify(parseModelBundle(wire).rig),JSON.stringify(rig));
});
test('packed offsets preserve source and all numeric values, reject topology/data corruption and support explicit quantization',()=>{
 const rig=fixture(),before=JSON.stringify(rig),packed=packRigDocument(rig,'lossless',0);
 assert.equal(JSON.stringify(rig),before);const restored=migrateRigDocument(JSON.parse(JSON.stringify(packed)));assert.equal(JSON.stringify(restored),before);
 const key=packed.rig.parts[0].artMesh.multiBindings[0].keyforms[0];assert.equal(key.offsets,undefined);assert.equal(key.packedOffsets.encoding,'f64');
 const corrupt=structuredClone(packed);corrupt.rig.parts[0].artMesh.vertices.reverse();assert.throws(()=>migrateRigDocument(corrupt),/topology/);
 const truncated=structuredClone(packed);truncated.rig.parts[0].artMesh.multiBindings[0].keyforms[0].packedOffsets.data='AA==';assert.throws(()=>migrateRigDocument(truncated),/data/);
 const quantized=migrateRigDocument(packRigDocument(rig,'i16',0));const original=rig.parts[0].artMesh.multiBindings[0].keyforms[0].offsets,roundtrip=quantized.parts[0].artMesh.multiBindings[0].keyforms[0].offsets;
 roundtrip.forEach((o,i)=>assert.ok(Math.abs(o.x-original[i].x)<=1/64));
 rig.parts[0].artMesh.multiBindings[0].keyforms[0].offsets[0].x=1000000.123;assert.equal(packRigDocument(rig,'i16',0).rig.parts[0].artMesh.multiBindings[0].keyforms[0].packedOffsets.encoding,'f64');
});
test('numeric playback lanes preserve sparse/duplicate offsets, zero corners, surfaces and mutable edits',()=>{
 for(const surface of [false,true]){const rig=fixture(),part=rig.parts[0],b=part.artMesh.multiBindings[0];if(surface)b.composition='surface';b.keyforms[0].offsets.reverse();b.keyforms[0].offsets.pop();b.keyforms[1].offsets.push({...b.keyforms[1].offsets[0],x:2});const cache=new EvaluationCache();
  for(const x of [-1,-.7,0,.4,1])for(const y of [-1,0,.5,1])assert.deepEqual(withEvaluationCache(cache,()=>resolveArtMesh(part,100,100,{ParamAngleX:x,ParamAngleY:y})),resolveArtMesh(part,100,100,{ParamAngleX:x,ParamAngleY:y}));
 }
});
test('large model persistence preserves property order and logical CAS revisions through packed files',async()=>{
 const rig=fixture(),b=rig.parts[0].artMesh.multiBindings[0],offsets=b.keyforms[0].offsets;
 b.keyforms=Array.from({length:500},(_,i)=>({offsets:structuredClone(offsets),metadata:'after offsets',inputs:{ParamAngleX:i%25,ParamAngleY:Math.floor(i/25)}}));
 // Cross the normal persistence threshold with a complete synthetic grid.
 const packed=packRigDocument(rig);assert.equal(packed.format,'standrig-packed');
 const dir=await mkdtemp(path.join(os.tmpdir(),'standrig-packed-file-'));
 try{const file=path.join(dir,'rig.json');await writeRigFile(file,rig);assert.equal(fullRigRevision(await readRigFile(file)),fullRigRevision(rig));}
 finally{await rm(dir,{recursive:true,force:true});}
 const key=b.keyforms[0];key.offsets=offsets;const reordered={...rig,parts:[{...rig.parts[0],artMesh:{...rig.parts[0].artMesh,multiBindings:[{...b,keyforms:[key]}]}}]};
 assert.equal(JSON.stringify(migrateRigDocument(JSON.parse(JSON.stringify(packRigDocument(reordered,'lossless',0))))),JSON.stringify(reordered));
 key.packedOffsets={userMetadata:true};assert.equal(packRigDocument(reordered,'lossless',0),reordered);
});
test('checkpoints deduplicate PNG bytes, restore deleted images, retain legacy imports and bound new history',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'standrig-cas-')),publicDir=path.join(dir,'public');const store=new CheckpointStore(dir,publicDir,2);
 try{
  const a=await store.create(sample,'a'),b=await store.create(sample,'b'),c=await store.create(sample,'c');
  const list=await store.list();assert.equal(list.length,2);assert.ok(list.some(r=>r.id===c.id));
  const assets=await readdir(path.join(dir,'checkpoints/assets'));assert.equal(assets.length,new Set(sample.assets.map(a=>a.src)).size);
  assert.equal((await readdir(path.join(dir,'checkpoints/models'))).length,1,'identical model snapshots share one compressed object');
  assert.deepEqual(await store.restore(c.id),sample);await assert.rejects(store.restore(a.id));
  const legacy='11111111-1111-1111-1111-111111111111';await writeFile(path.join(dir,'checkpoints',legacy+'.json'),JSON.stringify({id:legacy,bundle:{rig:sample}}));assert.deepEqual(await store.restore(legacy),sample);
  const meta=JSON.parse(await readFile(path.join(dir,'checkpoints',c.id+'.meta.json')));await writeFile(path.join(dir,'checkpoints/assets',meta.assets[0].hash+'.png'),'corrupt');await assert.rejects(store.restore(c.id),/hash mismatch/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
