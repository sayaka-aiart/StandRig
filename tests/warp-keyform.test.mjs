import {test} from 'node:test';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {executeModelingOperation} from '@standrig/core/modelingOps';
import {defaultWarpDeformer,resolveDeformerWarp} from '@standrig/core/warp';
import {evaluateDeformers} from '@standrig/core/evaluator';
import {sampleBinding} from '@standrig/core/bindings';
import {normalizeSharedWarpField,resizeSharedWarpField} from '@standrig/core/sharedWarp';
import {createLocalService} from '../apps/service/dist/service.js';
const sample=JSON.parse(await readFile(new URL('../examples/sample.standrig.json',import.meta.url),'utf8'));
function fixture(shared){
 const rig=structuredClone(sample);
 const d={id:'keywarp',name:'Key Warp',kind:'warp',parentId:null,visible:true,origin:{x:0,y:0},transform:{x:0,y:0,rotation:0,scaleX:1,scaleY:1,pivotX:0,pivotY:0,opacity:1},warp:{...defaultWarpDeformer(),enabled:true,pins:[{id:'a',name:'A',enabled:true,u:0.5,v:0.5,offsetX:2,offsetY:3,radius:1,strength:1}]}};
 d.sharedWarp={version:1,enabled:true,bounds:{left:0,top:0,width:100,height:100},grid:{columns:1,rows:1},controlPoints:[{id:'a',column:0,row:0,offsetX:2,offsetY:3},{id:'b',column:1,row:0,offsetX:0,offsetY:0},{id:'c',column:0,row:1,offsetX:0,offsetY:0},{id:'e',column:1,row:1,offsetX:0,offsetY:0}]};
 rig.deformers=[d];rig.parts.find(p=>p.id==='body').deformerId=d.id;
 const surface=shared?{kind:'shared-warp',space:'stage'}:{kind:'warp-pins',space:'warp-local',width:100,height:100};
 const operation={id:'key',name:'Warp key',target:{deformerIds:[d.id]},action:{type:'deform-brush',brush:{surface,center:[-50,-50],radius:500,effect:{mode:'inflate',distance:2},iterations:1,maxDisplacement:3,falloff:'smooth',destination:{kind:'keyform',parameter:'ParamAngleX',input:15}}}};
 const controls=doc=>shared?doc.deformers[0].sharedWarp.controlPoints:doc.deformers[0].warp.pins;
 const resolve=(doc,input)=>shared?evaluateDeformers(doc.deformers,{ParamAngleX:input}).get(d.id).sharedWarps[0].controlPoints:resolveDeformerWarp(doc.deformers[0],{ParamAngleX:input},sampleBinding).pins;
 return {rig,d,operation,controls,resolve};
}
test('Warp Pin and shared-grid Brush keyforms preserve base, default, other keys and metadata',()=>{
 for(const shared of [false,true]){
  const {rig,operation,controls,resolve}=fixture(shared),p=controls(rig)[0];
  p.bindings=[{parameter:'ParamAngleX',property:'offsetX',additive:true,interpolation:'smoothstep',keys:[{input:-30,value:-8},{input:30,value:8}]},{parameter:'ParamAngleY',property:'offsetY',additive:true,keys:[{input:0,value:0},{input:30,value:4}]}];
  const before=structuredClone(rig),neutral=resolve(rig,0)[0].offsetX,mid=resolve(rig,15)[0].offsetX;
  executeModelingOperation(rig,operation,{dryRun:true});assert.deepEqual(rig,before);
  executeModelingOperation(rig,operation);const after=controls(rig)[0],binding=after.bindings[0];
  assert.equal(after.offsetX,p.offsetX);assert.equal(after.offsetY,p.offsetY);
  assert.equal(resolve(rig,0)[0].offsetX,neutral);assert.ok(resolve(rig,15)[0].offsetX>mid);
  assert.deepEqual(binding.keys.filter(k=>Math.abs(k.input)===30),p.bindings[0].keys);
  assert.equal(binding.interpolation,'smoothstep');assert.deepEqual(after.bindings[1],p.bindings[1]);
  const once=resolve(rig,15)[0].offsetX;executeModelingOperation(rig,operation);assert.ok(resolve(rig,15)[0].offsetX>once);
 }
});
test('negative keys interpolate, and locked controls do not acquire bindings',()=>{
 for(const shared of [false,true]){
  const {rig,operation,controls,resolve}=fixture(shared);operation.action.brush.destination.input=-30;
  executeModelingOperation(rig,operation);
  const a=resolve(rig,0)[0].offsetX,b=resolve(rig,-30)[0].offsetX;
  assert.ok(b>a);assert.ok(Math.abs(resolve(rig,-15)[0].offsetX-(a+b)/2)<1e-8);
  const before=structuredClone(controls(rig)[0]);operation.action.brush.lockedIds=['a'];executeModelingOperation(rig,operation);assert.deepEqual(controls(rig)[0],before);
 }
});
test('invalid, ambiguous and nonadditive key destinations reject atomically',()=>{
 for(const shared of [false,true])for(const mode of ['range','duplicate','nonadditive','multi']){
  const {rig,operation,controls}=fixture(shared),point=controls(rig)[0];
  const binding={parameter:'ParamAngleX',property:'offsetX',keys:[{input:0,value:0}],additive:true};
  if(mode==='range')operation.action.brush.destination.input=31;
  if(mode==='duplicate')point.bindings=[binding,structuredClone(binding)];
  if(mode==='nonadditive')point.bindings=[{...binding,additive:false}];
  if(mode==='multi')point.multiBindings=[{parameters:['ParamAngleX','ParamAngleY'],property:'offsetX',keyforms:[]}];
  const before=structuredClone(rig);assert.throws(()=>executeModelingOperation(rig,operation));assert.deepEqual(rig,before);
 }
 const f=fixture(false),second=structuredClone(f.rig.deformers[0]);second.id='second';second.warp.pins[0].bindings=[{parameter:'ParamAngleX',property:'offsetX',additive:false,keys:[{input:0,value:0}]}];f.rig.deformers.push(second);f.operation.target.deformerIds.push('second');const before=structuredClone(f.rig);assert.throws(()=>executeModelingOperation(f.rig,f.operation));assert.deepEqual(f.rig,before);
});
test('shared normalization retains keys, resize refuses silent key loss, curves reach pin runtime',()=>{
 const {rig,operation,controls,resolve}=fixture(true);executeModelingOperation(rig,operation);
 assert.deepEqual(normalizeSharedWarpField(rig.deformers[0].sharedWarp).controlPoints[0].bindings,controls(rig)[0].bindings);
 assert.throws(()=>resizeSharedWarpField(rig.deformers[0].sharedWarp,2,2),/keyframed/);
 const f=fixture(false),curve={controlPoints:[{t:0,value:0},{t:0.5,value:0.2},{t:1,value:1}]};
 f.controls(f.rig)[0].bindings=[{parameter:'ParamAngleX',property:'offsetX',keys:[{input:0,value:0},{input:30,value:10}],interpolation:'curve',curve}];
 assert.equal(f.resolve(f.rig,15)[0].offsetX,4);
 executeModelingOperation(f.rig,f.operation);assert.deepEqual(f.controls(f.rig)[0].bindings[0].curve,curve);
});
test('HTTP/MCP Warp keyform transaction saves and restores both surfaces under QA',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'standrig-warp-key-'));let service,client,transport;
 try{
  service=await createLocalService({dataDir:dir,port:0});
  const call=async(route,body)=>{const r=await fetch(service.url+route,{method:body?'POST':'GET',headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json()};};
  const qa={poseSamples:[{poseId:'neutral',values:{ParamAngleX:0}},{poseId:'mid',values:{ParamAngleX:7.5}},{poseId:'key',values:{ParamAngleX:15}}],regions:['full'],width:240,height:240,physics:false};
  const {rig,operation}=fixture(false),shared=fixture(true).operation;shared.id='shared';
  const imported=await call('/api/modeling/transaction',{kind:'import',rig,qa,commit:true,expectedRevision:(await call('/api/context')).data.context.revision});assert.equal(imported.status,200,JSON.stringify(imported));
  const before=await readFile(path.join(dir,'public/rig.json'),'utf8');
  const input={expectedRevision:imported.data.revisionAfter,operations:[operation,shared],qa,commit:false};
  const dry=await call('/api/modeling/transaction',input);assert.equal(dry.data.ok,true,JSON.stringify(dry));assert.equal(await readFile(path.join(dir,'public/rig.json'),'utf8'),before);
  transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../packages/mcp/src/cli.mjs',import.meta.url))],env:{...process.env,STANDRIG_URL:service.url},stderr:'pipe'});
  client=new Client({name:'warp-key-test',version:'1'});await client.connect(transport);
  const tool=await client.callTool({name:'standrig_modeling_transaction',arguments:{...input,commit:true}});assert.equal(tool.isError,undefined,JSON.stringify(tool));
  const saved={data:tool.structuredContent};assert.equal(saved.data.committed,true,JSON.stringify(saved));
  const stored=JSON.parse(await readFile(path.join(dir,'public/rig.json'),'utf8'));assert.ok(stored.deformers[0].warp.pins[0].bindings.length);assert.ok(stored.deformers[0].sharedWarp.controlPoints[0].bindings.length);
  const restored=await call('/api/modeling/transaction',{kind:'restore',checkpointId:saved.data.rollbackCheckpoint.id,expectedRevision:saved.data.revisionAfter,commit:true});assert.equal(restored.status,200,JSON.stringify(restored));assert.equal(restored.data.revisionAfter,input.expectedRevision);
 }finally{await client?.close();await transport?.close();await service?.close();assert.equal(path.dirname(dir),os.tmpdir());assert.ok(path.basename(dir).startsWith('standrig-warp-key-'));await rm(dir,{recursive:true,force:true});}
});
