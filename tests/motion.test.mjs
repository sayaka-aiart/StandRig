import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {parseMotion,sampleMotion,validateMotionParameters,importMotionWith} from '@standrig/core/motion';
import {MotionController} from '@standrig/runtime/motion';
import {StandRigPlayer} from '@standrig/runtime/playback';
import {parameterDefinitionsForRig,previewParameterValuesForRig} from '@standrig/core/parameters';
import {motionRequestSchema} from '@standrig/contracts';
import {PlaybackSession} from '../apps/service/dist/playback.js';
const rig=JSON.parse(await readFile(new URL('../examples/sample.standrig.json',import.meta.url),'utf8'));
const defs=parameterDefinitionsForRig(rig),base=previewParameterValuesForRig(rig);
const clip={format:'standrig-motion',version:1,name:'Tilt',duration:2,tracks:[{parameter:'ParamAngleZ',keys:[{time:0,value:0},{time:2,value:20}]}]};
const changed=fn=>{const c=structuredClone(clip);fn(c);return c;};
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);

test('native curves sample exact keys, endpoint holds and time-inverted Bezier',()=>{
 for(const [kind,expected]of [['linear',5],['hold',0],['inverse-hold',20]]){
  const c=parseMotion(changed(c=>c.tracks[0].keys[0].segment={kind}));
  assert.equal(sampleMotion(c,0).ParamAngleZ,0);assert.equal(sampleMotion(c,2).ParamAngleZ,20);
  assert.equal(sampleMotion(c,0.5).ParamAngleZ,expected);
  assert.equal(sampleMotion(c,-1).ParamAngleZ,0);assert.equal(sampleMotion(c,3).ParamAngleZ,20);
 }
 // Cubic x(0.5)=0.625, y(0.5)=10: not a normalized-time cubic.
 const c=parseMotion(changed(c=>c.tracks[0].keys[0].segment={kind:'bezier',control1:{time:0,value:0},control2:{time:1,value:20}}));
 near(sampleMotion(c,0.625).ParamAngleZ,10);
 const late=parseMotion(changed(c=>c.tracks[0].keys[0].time=1));
 assert.equal(sampleMotion(late,0.5).ParamAngleZ,0);
 assert.throws(()=>sampleMotion(c,NaN));
 const huge=parseMotion(changed(c=>{c.tracks[0].keys[0].value=-1e308;c.tracks[0].keys[1].value=1e308;}));assert.equal(sampleMotion(huge,1).ParamAngleZ,0);
});

test('native parser rejects invalid format, structure, bounds and lossy ambiguity',()=>{
 const invalid=[null,[],{Version:3,Curves:[]},...[
  c=>c.version=2,c=>c.extra=1,c=>c.name='',c=>c.duration=0,c=>c.duration=3601,c=>c.duration=Infinity,
  c=>c.tracks=[],c=>c.tracks.push(structuredClone(c.tracks[0])),c=>c.tracks[0].keys=[],
  c=>c.tracks[0].keys[1].time=0,c=>c.tracks[0].keys[1].time=3,c=>c.tracks[0].keys[0].value=NaN,
  c=>c.tracks[0].keys[0].extra=1,c=>c.tracks[0].keys[1].segment={kind:'hold'},
  c=>c.tracks[0].keys[0].segment={kind:'linear',control1:{time:0,value:0}},
  c=>c.tracks[0].keys[0].segment={kind:'bezier',control1:{time:1.5,value:0},control2:{time:1,value:20}},
  c=>c.tracks[0].keys=Array.from({length:4097},(_,i)=>({time:i/4096,value:0}))
 ].map(changed)];
 for(const value of invalid)assert.throws(()=>parseMotion(value));
 for(const c of [changed(c=>c.tracks[0].parameter='missing'),changed(c=>c.tracks[0].keys[1].value=31),changed(c=>c.tracks[0].keys[0].segment={kind:'bezier',control1:{time:0,value:31},control2:{time:1,value:20}})])assert.throws(()=>validateMotionParameters(parseMotion(c),defs));
 const copy=parseMotion(clip);copy.tracks[0].keys[0].value=5;assert.equal(clip.tracks[0].keys[0].value,0);
 for(const request of [{action:'warp-create'},{action:'play',time:0},{action:'seek',time:'1'},{action:'seek',time:-1},{action:'configure',speed:5},{action:'configure',loop:'yes'},{action:'load',clip:changed(c=>c.duration=3601)}])assert.equal(motionRequestSchema.safeParse(request).success,false);
});

test('transport handles pause, speed, seek, loop, completion and ownership deterministically',()=>{
 const m=new MotionController(defs),values={...base,ParamAngleZ:7};
 m.load(clip);assert.equal(m.snapshot().active,false);
 assert.deepEqual(m.play(values,1000),{ParamAngleZ:0});
 near(m.play(values,1500).ParamAngleZ,5); // repeated play must not lose elapsed time
 near(m.pause(1800).ParamAngleZ,8);assert.deepEqual(m.tick(9000),{});
 near(m.play(values,10000).ParamAngleZ,8);
 near(m.configure(2,undefined,10200).ParamAngleZ,10);
 near(m.tick(10400).ParamAngleZ,14);
 near(m.seek(1,values,11000).ParamAngleZ,10);
 near(m.tick(11500).ParamAngleZ,20);assert.equal(m.snapshot().ended,true);assert.equal(m.snapshot().active,true);
 assert.equal(m.snapshot().running,false);near(m.play(values,12000).ParamAngleZ,0);
 m.configure(1,true,12000);near(m.tick(14500).ParamAngleZ,5);
 assert.deepEqual(m.external({ParamMouthOpen:0.5}),{});assert.equal(m.snapshot().running,true);
 assert.deepEqual(m.external({ParamAngleZ:3}),{ParamAngleZ:7});assert.equal(m.snapshot().active,false);
 m.seek(1,values,16000);assert.deepEqual(m.stop(),{ParamAngleZ:7});assert.equal(m.snapshot().loaded,true);
 m.clear();assert.equal(m.snapshot().loaded,false);assert.throws(()=>m.play(values,17000));
});

test('invalid transport commands preserve the running clip; documents are isolated',()=>{
 const m=new MotionController(defs);m.load(clip);m.play(base,0);const before=m.snapshot();
 for(const fn of [()=>m.load({...clip,version:3}),()=>m.load(changed(c=>c.tracks[0].parameter='missing')),()=>m.seek(-1,base,500),()=>m.configure(NaN,true,500),()=>m.play(base,NaN),()=>m.tick(Infinity),()=>m.configure(1,'yes',500)]){assert.throws(fn);assert.deepEqual(m.snapshot(),before);}
 const doc=m.document();doc.name='changed';assert.equal(m.document().name,'Tilt');
 near(m.tick(1000).ParamAngleZ,10);
});

test('future importer contract rejects reported loss, unknown IDs and duplicate destinations',()=>{
 const source={parameter:'ExternalAngle',sentinel:1},context={parameterMap:{ExternalAngle:'ParamAngleZ'}};
 const importer={format:'test-only',convert(input,{parameterMap}){input.sentinel=2;return {clip:changed(c=>c.tracks[0].parameter=parameterMap[input.parameter]),issues:[]};}};
 assert.equal(importMotionWith(source,importer,context,defs).clip.tracks[0].parameter,'ParamAngleZ');assert.equal(source.sentinel,1);
 assert.throws(()=>importMotionWith(source,{...importer,convert:()=>({clip,issues:[{code:'unsupported',message:'fade not represented'}]})},context,defs),/refused/);
 assert.throws(()=>importMotionWith(source,importer,{parameterMap:{}},defs));
 assert.throws(()=>importMotionWith(source,{...importer,convert:()=>({clip:changed(c=>c.tracks.push(structuredClone(c.tracks[0]))),issues:[]})},context,defs));
});

test('service arbitrates demo, motion and tracker without writes or surviving timers',async()=>{
 const original=JSON.stringify(rig),s=new PlaybackSession(rig);
 try {
  s.input({source:'manual',sequence:1,values:{ParamAngleZ:7}});
  s.motionCommand({action:'load',clip});s.motionCommand({action:'play'});
  await delay(80);assert.ok(s.snapshot().motion.time>0);
  s.input({source:'tracker',sequence:1,values:{ParamMouthOpen:0.7}});assert.equal(s.snapshot().motion.running,true);
  s.input({source:'tracker',sequence:2,values:{ParamAngleZ:3}});assert.equal(s.snapshot().motion.active,false);assert.equal(s.snapshot().values.ParamAngleZ,3);
  s.motionCommand({action:'play'});s.control('demo-start');assert.equal(s.snapshot().motion.active,false);
  const before=s.snapshot();
  for(const request of [{action:'load',clip:{Version:3}},{action:'seek',time:3},{action:'configure',speed:5}]){assert.throws(()=>s.motionCommand(request));assert.deepEqual(s.snapshot(),before);}
  s.motionCommand({action:'configure',loop:true});assert.equal(s.snapshot().demo.active,true);assert.equal(s.snapshot().lastSource,'standrig_demo');
  s.motionCommand({action:'seek',time:1});assert.equal(s.snapshot().demo.active,false);assert.equal(s.snapshot().values.ParamAngleZ,10);
  assert.ok(s.snapshot().physicsEpoch>before.physicsEpoch);
  s.motionCommand({action:'stop'});assert.equal(s.snapshot().values.ParamAngleZ,3);assert.equal(s.snapshot().values.ParamMouthOpen,0.7);
  s.control('demo-start');s.motionCommand({action:'pause'});assert.equal(s.snapshot().demo.active,false);
  s.motionCommand({action:'play'});s.control('reset');assert.equal(s.snapshot().motion.loaded,true);assert.equal(s.snapshot().motion.active,false);assert.deepEqual(s.snapshot().values,base);
  s.motionCommand({action:'play'});s.reload(rig);assert.equal(s.snapshot().motion.loaded,false);
  s.motionCommand({action:'load',clip});s.motionCommand({action:'play'});s.close();const revision=s.snapshot().revision;await delay(80);assert.equal(s.snapshot().revision,revision);
  assert.equal(JSON.stringify(rig),original);
 } finally{s.close();}
});

test('embedded player replays an ended motion while its render loop stays alive',()=>{
 const previous=Object.fromEntries(['ResizeObserver','requestAnimationFrame','cancelAnimationFrame'].map(k=>[k,globalThis[k]]));
 const frames=new Map();let next=0;
 globalThis.ResizeObserver=class{observe(){}disconnect(){}};
 globalThis.requestAnimationFrame=callback=>{frames.set(++next,callback);return next;};
 globalThis.cancelAnimationFrame=id=>frames.delete(id);
 let player;
 try {
  // No drawing context: exercise the real player transport, not image rendering.
  player=new StandRigPlayer({getContext:()=>null},rig);
  player.setParameters({ParamAngleZ:7});player.loadMotion(clip);player.play();
  assert.equal(frames.size,1);player.seekMotion(2);assert.equal(player.motionState.ended,true);
  assert.equal(player.playing,true);player.play();assert.equal(player.motionState.running,true);
  assert.equal(player.motionState.time,0);assert.equal(frames.size,1);
  player.pause();assert.equal(frames.size,0);player.seekMotion(1);assert.equal(player.parameters.ParamAngleZ,10);
  player.setParameters({ParamMouthOpen:0.8});assert.equal(player.motionState.active,true);
  player.stopMotion();assert.equal(player.parameters.ParamAngleZ,7);assert.equal(player.parameters.ParamMouthOpen,0.8);
  player.play();assert.throws(()=>player.loadMotion({...clip,version:2}));assert.equal(player.motionState.running,true);
  player.clearMotion();assert.equal(player.motionState.loaded,false);assert.equal(frames.size,0);
 } finally {player?.dispose();for(const [key,value]of Object.entries(previous)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}
});
