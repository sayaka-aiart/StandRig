import {test} from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import * as z from 'zod';
import {executeModelingOperation} from '@standrig/core/modelingOps';import {matchesPartTarget} from '@standrig/core/modelingTarget';import {createRectArtMesh} from '@standrig/core/artMesh';import {validateBrush} from '@standrig/core/deformBrush';import {operationSchema} from '@standrig/contracts';
const sample=JSON.parse(await readFile(new URL('../examples/sample.standrig.json',import.meta.url),'utf8'));
const brush={surface:{kind:'artmesh',space:'mesh-local'},center:[30,30],radius:200,effect:{mode:'inflate',distance:2},iterations:1,maxDisplacement:3,falloff:'smooth',destination:{kind:'base'}};
const operation=(action,target)=>({id:'selection',name:'Selection',target,action});
function fixture(){const rig=structuredClone(sample),body=rig.parts.find(p=>p.id==='body'),asset=rig.assets.find(a=>a.id===body.assetId);rig.parts=['a','b','c'].map((id,i)=>({...structuredClone(body),id,role:i===1?'face':'torso',roleStatus:i===2?'suggested':'confirmed',artMesh:createRectArtMesh(asset.width,asset.height,{preset:'face-feature',columns:4,rows:4})}));return rig;}
test('legacy and deform selectors intersect IDs and confirmed roles, with empty fields absent',()=>{
 const rig=fixture();
 for(const target of [{partIds:['a','b'],roles:['torso']},{partIds:['b'],roles:[]},{partIds:[],roles:['torso']},{partIds:['c']},{roles:['face']},{partIds:['a','a'],roles:['torso','face']}]){
  const expected=rig.parts.filter(p=>matchesPartTarget(p,target).matched).map(p=>p.id);
  const legacy=executeModelingOperation(structuredClone(rig),operation({type:'transform',property:'x',operator:'add',value:1},target),{dryRun:true});assert.deepEqual(legacy.matchedPartIds,expected);
  for(const action of [{type:'deform-brush',brush},{type:'blend-shape-set',shape:{kind:'part',id:'shape',parameter:'ParamAngleX',neutralInput:0,targetInput:30,transform:{x:1}}}]){
   const candidate=structuredClone(rig),result=executeModelingOperation(candidate,operation(action,target));assert.deepEqual(result.matchedPartIds,expected);
   for(const p of candidate.parts)if(!expected.includes(p.id))assert.deepEqual(p,rig.parts.find(q=>q.id===p.id));
  }
 }
 for(const target of [{partIds:['b'],roles:['torso']},{partIds:['c'],roles:['torso']},{}]){
  assert.equal(rig.parts.some(p=>matchesPartTarget(p,target).matched),false);
  const before=structuredClone(rig);assert.throws(()=>executeModelingOperation(rig,operation({type:'deform-brush',brush},target)));assert.deepEqual(rig,before);
 }
});
test('Brush numeric metadata reaches JSON Schema and agrees with core bounds',()=>{
 const schema=z.toJSONSchema(operationSchema).properties.action.oneOf.find(s=>s.properties.type.const==='deform-brush').properties.brush;
 assert.equal(schema.properties.iterations.type,'integer');assert.equal(schema.properties.iterations.minimum,1);assert.equal(schema.properties.iterations.maximum,50);assert.equal(schema.properties.radius.exclusiveMinimum,0);
 for(const [field,values]of Object.entries({iterations:[-1,0,1,50,51,1.5],radius:[-1,0,0.1],maxDisplacement:[-1,0,0.1]}))for(const value of values){const input={...brush,[field]:value};let valid=true;try{validateBrush(input);}catch{valid=false;}assert.equal(operationSchema.safeParse(operation({type:'deform-brush',brush:input},{})).success,valid,field+':'+value);}
 for(const effect of [{mode:'smooth',strength:-0.1},{mode:'relax',strength:1.1},{mode:'pinch',axis:[1,0],strength:2},{mode:'inflate',distance:-1},{mode:'bend',axis:[0,1],angle:181}]){
  assert.equal(operationSchema.safeParse(operation({type:'deform-brush',brush:{...brush,effect}},{})).success,false);assert.throws(()=>validateBrush({...brush,effect}));
 }
 for(const dimension of ['width','height'])assert.equal(operationSchema.safeParse(operation({type:'deform-brush',brush:{...brush,surface:{kind:'warp-pins',space:'warp-local',width:100,height:100,[dimension]:0}}},{})).success,false);
});
