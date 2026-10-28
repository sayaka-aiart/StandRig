import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolveSharedShape} from '@standrig/core/extendedBlendShape';
import {resolveRigFrame,evaluateRigParts,evaluateDeformers,resolveDeformerSkinningTransforms,identityMatrix} from '@standrig/core/evaluator';
import {defaultParameterValues} from '@standrig/core/parameters';

const pose=()=>({x:0,y:0,rotation:0,scaleX:1,scaleY:1,pivotX:0,pivotY:0,opacity:1});
const binding=(property,from,to,additive=true)=>({parameter:'P',property,additive,interpolation:'linear',keys:[{input:0,value:from},{input:1,value:to}]});
const field=()=>({version:1,enabled:true,bounds:{left:0,top:0,width:100,height:100},grid:{columns:1,rows:1},controlPoints:[{id:'point',column:0,row:0,offsetX:5,offsetY:-2,bindings:[binding('offsetX',0,10),binding('offsetY',0,8)]}]});
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};

test('resolved shared coordinates preserve override/additive order and positive/negative shape weights',()=>{
 const f=field();f.controlPoints[0].bindings.push(binding('offsetX',2,6,false),binding('offsetX',0,4));
 const shapes=[{id:'positive',kind:'deformer',parameter:'P',neutralInput:0,targetInput:1,sharedPoints:[{id:'point',x:4,y:2}]},{id:'negative',kind:'deformer',parameter:'N',neutralInput:0,targetInput:-1,sharedPoints:[{id:'point',x:-6,y:8}]}];
 const result=resolveSharedShape(f,shapes,{P:.5,N:-.5});
 assert.equal(result.controlPoints[0].offsetX,5); // override 4 + additive 2 + positive 2 - negative 3
 assert.equal(result.controlPoints[0].offsetY,7); // -2 + 4 + 1 + 4
});

test('shared evaluation never mutates frozen model data and keeps prior frame coordinates independent',()=>{
 const f=freeze(field()),before=JSON.stringify(f);
 const a=resolveSharedShape(f,undefined,{P:.25}),b=resolveSharedShape(f,undefined,{P:.75});
 assert.equal(a.controlPoints[0].offsetX,7.5);assert.equal(b.controlPoints[0].offsetX,12.5);
 a.bounds.left=99;a.grid.columns=4;a.controlPoints[0].offsetY=99;
 assert.equal(JSON.stringify(f),before);assert.equal(b.bounds.left,0);assert.equal(b.grid.columns,1);assert.equal(b.controlPoints[0].offsetY,4);
});

test('shared evaluation retains binding limits and first-id matching for malformed duplicate points',()=>{
 const f=field();f.controlPoints[0].bindings=Array.from({length:17},()=>binding('offsetX',0,1));
 f.controlPoints.push({...f.controlPoints[0],column:1,bindings:[]});
 const s={id:'shape',kind:'deformer',parameter:'P',neutralInput:0,targetInput:1,sharedPoints:[{id:'point',x:3,y:0},{id:'missing',x:100,y:0}]};
 const result=resolveSharedShape(f,[s],{P:1});assert.equal(result.controlPoints[0].offsetX,24);assert.equal(result.controlPoints[1].offsetX,5);
});

test('whole-frame part evaluation matches direct evaluation and sees in-place rig edits next frame',()=>{
 const rig={schemaVersion:'0.1.0',name:'Synthetic',stage:{width:100,height:100},assets:[],parameters:[{id:'P',default:0,min:0,max:1}],parts:[{id:'root',kind:'group',name:'root',visible:true,drawOrder:0,transform:pose()},{id:'part',parentId:'root',kind:'image',name:'part',visible:true,drawOrder:1,transform:pose(),deformerId:'d'}],deformers:[{id:'d',kind:'warp',name:'d',parentId:null,visible:true,origin:{x:0,y:0},transform:pose(),sharedWarp:field(),bindings:[binding('x',0,10)]}]};
 const v={P:.5},base=identityMatrix(),a=resolveRigFrame(rig,v,base,{physics:false});
 assert.deepStrictEqual(a.parts,evaluateRigParts(rig,v,base));assert.equal(a.parts.get('part').matrix.e,5);
 rig.deformers[0].bindings[0].keys[1].value=20;rig.deformers[0].sharedWarp.controlPoints[0].bindings[0].keys[1].value=20;
 const b=resolveRigFrame(rig,v,base,{physics:false});assert.equal(b.parts.get('part').matrix.e,10);assert.equal(b.parts.get('part').sharedWarps[0].controlPoints[0].offsetX,15);
 assert.equal(a.parts.get('part').matrix.e,5);assert.equal(a.parts.get('part').sharedWarps[0].controlPoints[0].offsetX,10);
 assert.deepStrictEqual(b.parts,evaluateRigParts(rig,v,base));
 // Neutral defaults and transform shapes still affect skinning, and edits to
 // defaults must take effect immediately rather than hitting a stale cache.
 rig.parameters[0].default=.25;
 rig.deformers[0].blendShapes=[{id:'turn',kind:'deformer',parameter:'P',neutralInput:0,targetInput:1,transform:{rotation:30,scaleX:1.5},sharedPoints:[{id:'point',x:9,y:2}]}];
 for(const neutral of[.25,.75]){
  rig.parameters[0].default=neutral;
  const frame=resolveRigFrame(rig,v,base,{physics:false});
  const reference=resolveDeformerSkinningTransforms(evaluateDeformers(rig.deformers,v),evaluateDeformers(rig.deformers,defaultParameterValues(rig)));
  assert.deepStrictEqual(frame.skinningTransforms,reference);
 }
});
