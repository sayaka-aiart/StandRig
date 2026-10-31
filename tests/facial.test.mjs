import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {parseExpression,importExpression,exportExpression,parseFacialPresets} from '@standrig/core/facial';
import {parameterDefinitionsForRig,defaultParameterValues} from '@standrig/core/parameters';
import {executeModelingOperation} from '@standrig/core/modelingOps';
import {validateRig} from '@standrig/core/inspect';
import {FacialController} from '@standrig/runtime/facial';
import {PlaybackSession} from '../apps/service/dist/playback.js';
import {createLocalService} from '../apps/service/dist/service.js';
import {facialRequestSchema,facialPresetsSetSchema} from '@standrig/contracts';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {fileURLToPath} from 'node:url';
const sample=JSON.parse(await readFile(new URL('../examples/sample.standrig.json',import.meta.url),'utf8'));
const document=(Parameters,FadeInTime=0,FadeOutTime=0)=>({Type:'Live2D Expression',FadeInTime,FadeOutTime,Parameters});
const presets={version:1,expressions:[
 {id:'smile',name:'Smile',document:document([{Id:'ParamMouthSmile',Value:.4}])},
 {id:'half',name:'Half eyes',document:document([{Id:'ParamEyeLOpen',Value:.5,Blend:'Multiply'},{Id:'ParamEyeROpen',Value:.5,Blend:'Multiply'}])},
 {id:'fixed',name:'Fixed eyes',document:document([{Id:'ParamEyeLOpen',Value:.25,Blend:'Overwrite'}])}
],visemes:{mode:'pose',fadeInTime:0,fadeOutTime:0,presets:[{id:'A',values:{ParamMouthOpen:1,ParamMouthForm:0}},{id:'I',values:{ParamMouthOpen:.3,ParamMouthForm:.8}},{id:'Silence',values:{ParamMouthOpen:0,ParamMouthForm:0}}]}};
const fixture=()=>({...structuredClone(sample),facialPresets:structuredClone(presets)});
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-10,`${a} != ${b}`);
const qa={poses:['neutral'],regions:['full'],width:240,height:240,physics:false};
const operation={id:'faces',name:'Register faces',target:{},action:{type:'facial-presets-set',presets}};

test('exp3 import/export keeps blend semantics, permits deltas/factors and maps only the documented alias',()=>{
 const exp=document([{Id:'ParamMouthOpenY',Value:.6,Blend:'Overwrite'},{Id:'ParamAngleZ',Value:-40,Blend:'Add'},{Id:'ParamEyeLOpen',Value:2,Blend:'Multiply'}]);
 const imported=importExpression(exp,sample);assert.equal(imported.Parameters[0].Id,'ParamMouthOpen');
 assert.deepEqual(exportExpression({id:'test',name:'test',document:imported},sample),exp);
 assert.equal(exp.Parameters[0].Id,'ParamMouthOpenY');
 assert.throws(()=>importExpression(document([{Id:'ParamMouthOpenY',Value:2,Blend:'Overwrite'}]),sample),/outside model range/);
 assert.throws(()=>importExpression(document([{Id:'CustomUnknown',Value:1}]),sample),/unknown/);
 assert.equal(importExpression(document([{Id:'Other',Value:.5}]),sample,{Other:'ParamMouthOpen'}).Parameters[0].Id,'ParamMouthOpen');
 assert.throws(()=>importExpression(document([{Id:'ParamMouthOpenY',Value:.5},{Id:'ParamMouthOpen',Value:.5}]),sample),/duplicate/);
 for(const value of [{...exp,extra:true},{...exp,Version:2},document([{Id:'x',Value:NaN}]),document([{Id:'x',Value:1,Blend:'Set'}]),{...exp,FadeInTime:-1}])assert.throws(()=>parseExpression(value));
});

test('catalog registration is strict, atomic, dry-runnable, portable and optional for old models',()=>{
 assert.equal(validateRig(sample).ok,true);assert.equal(validateRig(fixture()).ok,true);
 const rig=structuredClone(sample),original=JSON.stringify(rig);
 executeModelingOperation(rig,operation,{dryRun:true});assert.equal(JSON.stringify(rig),original);
 executeModelingOperation(rig,operation);assert.deepEqual(JSON.parse(JSON.stringify(rig)).facialPresets,presets);
 for(const key of Object.keys(sample))assert.deepEqual(rig[key],sample[key]);
 const before=JSON.stringify(rig),invalid=structuredClone(presets);invalid.visemes.presets[1].values={ParamMouthOpen:.3};
 assert.throws(()=>executeModelingOperation(rig,{...operation,action:{type:'facial-presets-set',presets:invalid}}),/same parameter/);assert.equal(JSON.stringify(rig),before);
 assert.throws(()=>executeModelingOperation(rig,{...operation,target:{partIds:['body']}}),/rig-wide/);
 assert.equal(validateRig({...rig,facialPresets:{...presets,version:2}}).ok,false);
 assert.throws(()=>parseFacialPresets({...presets,expressions:[presets.expressions[0],presets.expressions[0]]},rig),/duplicate/);
 assert.equal(facialPresetsSetSchema.safeParse({...operation.action,unknown:true}).success,false);
 for(const command of [{action:'expression',id:'half',strength:2},{action:'visemes',weights:{A:-.1}},{action:'visemes',weights:{unknown:1}},{action:'clear',id:'x'}])assert.equal(facialRequestSchema.safeParse(command).success,false);
 executeModelingOperation(rig,{...operation,action:{type:'facial-presets-set',presets:null}});assert.equal(JSON.stringify(rig),original);
});

test('expressions preserve live blinking, fades release to the current base and never accumulate',()=>{
 const rig=fixture(),f=new FacialController(rig),base=defaultParameterValues(rig),original=JSON.stringify(rig);
 f.command({action:'expression',id:'smile'},0);
 for(let i=0;i<100;i++)assert.equal(f.evaluate(base,i).ParamMouthSmile,.4);
 f.command({action:'expression',id:'half'},100);
 for(const open of [0,.2,.6,1])near(f.evaluate({...base,ParamEyeLOpen:open},101).ParamEyeLOpen,open*.5);
 f.command({action:'expression',id:'fixed'},200);assert.equal(f.evaluate({...base,ParamEyeLOpen:0},201).ParamEyeLOpen,.25);
 f.command({action:'clear'},202);assert.deepEqual(f.evaluate(base,203),base);assert.equal(JSON.stringify(rig),original);
 const fadeRig=fixture();fadeRig.facialPresets.expressions[0].document.FadeInTime=1;fadeRig.facialPresets.expressions[0].document.FadeOutTime=1;
 const fade=new FacialController(fadeRig);fade.command({action:'expression',id:'smile'},0);
 near(fade.evaluate(base,500).ParamMouthSmile,.2);fade.command({action:'clear'},1000);
 near(fade.evaluate({...base,ParamMouthSmile:.1},1500).ParamMouthSmile,.3);near(fade.evaluate({...base,ParamMouthSmile:.1},2000).ParamMouthSmile,.1);
 assert.equal(fade.snapshot(2000).transitioning,false);
});

test('vowel poses mix with expressions, normalized inputs, Silence, partial strength and restoration',()=>{
 const rig=fixture(),f=new FacialController(rig),base={...defaultParameterValues(rig),ParamMouthOpen:.2};
 f.command({action:'expression',id:'half'},0);f.command({action:'visemes',weights:{A:1,I:1}},0);
 const values=f.evaluate({...base,ParamEyeLOpen:.6},1);near(values.ParamMouthOpen,.65);near(values.ParamMouthForm,.4);near(values.ParamEyeLOpen,.3);
 f.command({action:'viseme',id:'Silence'},2);assert.equal(f.evaluate(base,3).ParamMouthOpen,0);
 f.command({action:'viseme',id:'A',strength:.5},4);near(f.evaluate(base,5).ParamMouthOpen,.6);
 f.command({action:'clear',layer:'viseme'},6);near(f.evaluate(base,7).ParamMouthOpen,.2);near(f.evaluate(base,7).ParamEyeLOpen,.5);
 const before=f.snapshot(7);for(const request of [{action:'viseme',id:'O'},{action:'visemes',weights:{A:.5,O:.5}},{action:'expression',id:'missing'},{action:'expression',id:'half',strength:-1},{action:'clear',layer:'unknown'}]){assert.throws(()=>f.command(request,7));assert.deepEqual(f.snapshot(7),before);}
});

test('extreme finite expression values saturate without poisoning paused/streamed playback',()=>{
 const rig=fixture();rig.facialPresets.expressions=[
  {id:'huge-add',name:'huge-add',document:document([{Id:'ParamAngleZ',Value:1e308,Blend:'Add'}],0,2)},
  {id:'huge-mult',name:'huge-mult',document:document([{Id:'ParamAngleZ',Value:1e308,Blend:'Multiply'}],0,2)},
  {id:'zero',name:'zero',document:document([{Id:'ParamAngleZ',Value:0,Blend:'Multiply'}],0,2)}
 ];
 const f=new FacialController(rig),base=defaultParameterValues(rig);
 f.command({action:'expression',id:'huge-add'},0);assert.equal(f.evaluate(base,0).ParamAngleZ,30);
 f.command({action:'expression',id:'huge-mult'},100);f.command({action:'expression',id:'zero'},100);
 assert(Object.values(f.evaluate(base,100)).every(Number.isFinite));
});

test('blend-shape vowel weights require authored zero-default channels and all-zero Silence',()=>{
 const rig=fixture();rig.parameters.push(...['ParamA','ParamI'].map(id=>({id,label:id,min:0,max:1,default:0})));
 rig.facialPresets.visemes={mode:'blend-shape',fadeInTime:0,fadeOutTime:0,presets:[{id:'A',values:{ParamA:1,ParamI:0}},{id:'I',values:{ParamA:0,ParamI:1}},{id:'Silence',values:{ParamA:0,ParamI:0}}]};
 const f=new FacialController(rig),base=defaultParameterValues(rig);f.command({action:'visemes',weights:{A:.6,I:.4}},0);const result=f.evaluate(base,1);near(result.ParamA,.6);near(result.ParamI,.4);
 f.command({action:'viseme',id:'Silence'},2);assert.equal(f.evaluate(base,3).ParamA,0);assert.equal(f.evaluate(base,3).ParamI,0);
 const invalid=structuredClone(rig.facialPresets);invalid.visemes.presets[2].values.ParamA=.2;assert.throws(()=>parseFacialPresets(invalid,rig),/zero weights/);
 rig.parameters.find(p=>p.id==='ParamA').default=.5;assert.throws(()=>new FacialController(rig),/zero-default/);
});

test('service combines live tracking/motion with facial layers without baking them into base or model',()=>{
 const rig=fixture(),original=JSON.stringify(rig),session=new PlaybackSession(rig);
 try {
  session.facialCommand({action:'expression',id:'half'});session.input({source:'tracker',sequence:1,values:{ParamEyeLOpen:.6,ParamAngleZ:10}});
  near(session.snapshot().values.ParamEyeLOpen,.3);assert.equal(session.snapshot().baseValues.ParamEyeLOpen,.6);
  session.motionCommand({action:'load',clip:{format:'standrig-motion',version:1,name:'Eye',duration:1,tracks:[{parameter:'ParamEyeLOpen',keys:[{time:0,value:0},{time:1,value:1}]}]}});
  session.motionCommand({action:'seek',time:.8});near(session.snapshot().values.ParamEyeLOpen,.4);
  session.facialCommand({action:'viseme',id:'A'});assert.equal(session.snapshot().motion.active,true);assert.equal(session.snapshot().values.ParamMouthOpen,1);
  session.facialCommand({action:'clear',immediate:true});near(session.snapshot().values.ParamEyeLOpen,.8);assert.equal(JSON.stringify(rig),original);
  session.reload(sample);assert.equal(session.snapshot().facial.expressionId,null);assert.deepEqual(session.facialCatalog(),{version:1,expressions:[]});
 }finally{session.close();}
});

test('commit publishes facial playback before sending success and reloads only once',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'standrig-facial-publish-'));let service;
 try{
  service=await createLocalService({dataDir:dir,port:0});
  const revision=(await (await fetch(service.url+'/api/context')).json()).context.revision;
  const initialVersion=service.playback.snapshot().modelVersion;
  let published;
  service.httpServer.on('request',(req,res)=>{
   if(req.method==='POST'&&req.url==='/api/modeling/transaction')res.once('finish',()=>{published={presets:service.playback.facialCatalog(),version:service.playback.snapshot().modelVersion};});
  });
  const response=await fetch(service.url+'/api/modeling/transaction',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({kind:'import',expectedRevision:revision,rig:fixture(),commit:true,qa})});
  assert.equal(response.status,200,JSON.stringify(await response.json()));
  assert.deepEqual(published,{presets,version:initialVersion+1});
  const immediate=await (await fetch(service.url+'/api/playback/facial')).json();assert.deepEqual(immediate.presets,presets);assert.equal(immediate.playback.modelVersion,initialVersion+1);
 }finally{await service?.close();assert.equal(path.dirname(dir),path.resolve(os.tmpdir()));await rm(dir,{recursive:true,force:true});}
});

test('HTTP/MCP register, play and export facial presets through CAS transactions only',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'standrig-facial-'));let service,client,transport;
 try{
  service=await createLocalService({dataDir:dir,port:0});
  const call=async(route,method='GET',body)=>{const r=await fetch(service.url+route,{method,headers:body?{'content-type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json()};};
  let revision=(await call('/api/context')).data.context.revision;
  const imported=await call('/api/modeling/transaction','POST',{kind:'import',expectedRevision:revision,rig:sample,commit:true,qa});assert.equal(imported.status,200);revision=imported.data.revisionAfter;
  const original=await readFile(path.join(dir,'public/rig.json'),'utf8');
  const dry=await call('/api/modeling/transaction','POST',{expectedRevision:revision,commit:false,operations:[operation],qa});assert.equal(dry.status,200);assert.equal(await readFile(path.join(dir,'public/rig.json'),'utf8'),original);
  const commit=await call('/api/modeling/transaction','POST',{expectedRevision:revision,commit:true,operations:[operation],qa});assert.equal(commit.status,200);assert.equal(commit.data.committed,true);
  const stored=await readFile(path.join(dir,'public/rig.json'),'utf8'),catalog=await call('/api/playback/facial');assert.deepEqual(catalog.data.presets,presets);
  assert.equal((await call('/api/playback/facial','POST',{action:'expression',id:'half'})).status,200);
  const tracker=await call('/api/playback/parameters','POST',{source:'tracker',sequence:1,values:{ParamEyeLOpen:.6}});near(tracker.data.playback.values.ParamEyeLOpen,.3);
  assert.equal((await call('/api/playback/facial','POST',{action:'expression',id:'half',strength:2})).status,400);
  assert.equal(await readFile(path.join(dir,'public/rig.json'),'utf8'),stored);
  assert.deepEqual((await call('/api/bundle')).data.rig.facialPresets,presets);
  transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../packages/mcp/src/cli.mjs',import.meta.url))],env:{...process.env,STANDRIG_URL:service.url},stderr:'pipe'});client=new Client({name:'facial-test',version:'1'});await client.connect(transport);
  const tools=(await client.listTools()).tools;assert(tools.some(t=>t.name==='standrig_facial'));assert(tools.some(t=>t.name==='standrig_facial_catalog'));
  const response=await client.callTool({name:'standrig_facial',arguments:{action:'viseme',id:'I'}});assert.equal(response.isError,undefined);
  near((await call('/api/playback')).data.playback.values.ParamMouthOpen,.3);
  assert.equal(await readFile(path.join(dir,'public/rig.json'),'utf8'),stored);
  assert.equal((await call('/api/modeling/transaction','POST',{expectedRevision:revision,commit:true,operations:[operation],qa})).status,409);
 }finally{await client?.close();await transport?.close();await service?.close();assert.equal(path.dirname(dir),path.resolve(os.tmpdir()));await rm(dir,{recursive:true,force:true});}
});
