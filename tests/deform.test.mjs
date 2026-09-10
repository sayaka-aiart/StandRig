import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {sampleArtMeshBlendShapeWeight,sampleArtMeshBlendShape} from '@standrig/core/artMeshBlendShape';
import {resolvePartPose,resolveDeformerPose,evaluateDeformers,identityMatrix,resolveRigFrame} from '@standrig/core/evaluator';
import {resolveDeformerWarp,defaultWarpDeformer} from '@standrig/core/warp';
import {sampleBinding} from '@standrig/core/bindings';
import {resolveArtPath} from '@standrig/core/artPath';
import {resolveGlueStitchOffsets} from '@standrig/core/glueVertex';
import {glueBlendStrength} from '@standrig/core/extendedBlendShape';
import {executeModelingOperation} from '@standrig/core/modelingOps';
import {validateRig} from '@standrig/core/inspect';
import {applyDeformBrush} from '@standrig/core/deformBrush';
import {createRectArtMesh,resolveArtMesh} from '@standrig/core/artMesh';
import {operationSchema} from '@standrig/contracts';
const sample=JSON.parse(await readFile(new URL('../examples/sample.standrig.json',import.meta.url),'utf8'));
const weight={id:'expression',parameter:'ParamAngleX',neutralInput:0,targetInput:30};
const zero={x:0,y:0,rotation:0,scaleX:1,scaleY:1,pivotX:0,pivotY:0,opacity:1};
const deformer=()=>({id:'d',name:'D',kind:'warp',parentId:null,visible:true,origin:{x:0,y:0},transform:{...zero},warp:{...defaultWarpDeformer(),enabled:true,pins:[{id:'pin',name:'pin',enabled:true,u:0.5,v:0.5,offsetX:0,offsetY:0,radius:1,strength:1}]}});
const op=(action,target={partIds:['body']})=>({id:'test',name:'test',target,action});
function meshRig(){const rig=structuredClone(sample),p=rig.parts.find(p=>p.id==='body'),a=rig.assets.find(a=>a.id===p.assetId);p.artMesh=createRectArtMesh(a.width,a.height,{preset:'face-feature',columns:4,rows:4});p.artMesh.generator.quality={};return {rig,p,a};}
const brush=(effect,destination={kind:'base'})=>({surface:{kind:'artmesh',space:'mesh-local'},center:[30,30],radius:200,effect,iterations:2,maxDisplacement:5,falloff:'smooth',destination});
test('positive and negative blend directions are zero at neutral and one at target',()=>{
 for(const targetInput of [1,-1]){const shape={...weight,targetInput,offsets:[{vertexId:'v',x:10,y:4}]};assert.equal(sampleArtMeshBlendShapeWeight(shape,0),0);assert.equal(sampleArtMeshBlendShapeWeight(shape,targetInput),1);assert.equal(sampleArtMeshBlendShapeWeight(shape,targetInput/2),0.5);assert.equal(sampleArtMeshBlendShapeWeight(shape,-targetInput),0);assert.equal(sampleArtMeshBlendShape(shape,0).get('v').x,0);}
});
test('Part and Deformer blends compose after keyforms, multiply scale, before physics, without mutation',()=>{
 const p={...sample.parts[0],transform:{...zero},bindings:[{parameter:'ParamAngleX',property:'x',additive:false,keys:[{input:0,value:10},{input:30,value:20}]}],blendShapes:[{...weight,kind:'part',transform:{x:4,rotation:10,scaleX:4,opacity:-0.4}}]};
 const before=JSON.stringify(p),pose=resolvePartPose(p,{ParamAngleX:15},{x:1});assert.equal(pose.x,18);assert.equal(pose.scaleX,2);assert.equal(pose.rotation,5);assert.equal(pose.opacity,0.8);assert.equal(JSON.stringify(p),before);
 const d=deformer();d.blendShapes=[{...weight,kind:'deformer',transform:{rotation:20}}];assert.equal(resolveDeformerPose(d,{ParamAngleX:30}).rotation,20);
});
test('Warp pins and shared fields resolve shape deltas in frame and neutral skinning',()=>{
 const d=deformer();d.sharedWarp={version:1,enabled:true,bounds:{left:0,top:0,width:100,height:100},grid:{columns:1,rows:1},controlPoints:[{id:'s',column:0,row:0,offsetX:0,offsetY:0}]};d.blendShapes=[{...weight,kind:'deformer',pins:[{id:'pin',x:8,y:2}],sharedPoints:[{id:'s',x:4,y:0}],warp:{bendX:2}}];
 const before=JSON.stringify(d),warp=resolveDeformerWarp(d,{ParamAngleX:15},sampleBinding);assert.equal(warp.pins[0].offsetX,4);assert.equal(warp.bendX,1);assert.equal(evaluateDeformers([d],{ParamAngleX:30}).get('d').sharedWarps[0].controlPoints[0].offsetX,4);assert.equal(JSON.stringify(d),before);
});
test('ArtPath point and style shapes and Glue strength use shared weights',()=>{
 const path={version:1,id:'line',name:'line',enabled:true,strokeColor:'#000000',strokeWidth:2,opacity:1,points:[{id:'a',u:0.2,v:0.2},{id:'b',u:0.8,v:0.8}],blendShapes:[{...weight,kind:'art-path',pathId:'line',points:[{id:'a',x:0.1,y:0}],width:2,opacity:-0.5}]};
 const output=resolveArtPath(path,{ParamAngleX:30},100,100);assert.ok(Math.abs(output.points[0].u-0.3)<1e-9);assert.equal(output.strokeWidth,4);assert.equal(output.opacity,0.5);
 const glue={id:'g',partAId:'a',partBId:'b',enabled:true,status:'active',mode:'stitch',strength:0.35,weightA:0.5,weightB:0.5,priority:0,vertexPairs:[{a:'v',b:'v'}],blendShapes:[{...weight,kind:'glue',glueId:'g',strength:-1}]};const rig={...sample,glue:[glue]};
 const solve=value=>resolveGlueStitchOffsets(rig,{values:{ParamAngleX:value},projectVertex:partId=>({x:partId==='a'?0:10,y:0}),iterations:32});
 assert.equal(solve(30).offsets.size,0);assert.ok(Math.abs(solve(15).offsets.get('a').get('v').dx-2.5)<1e-5);assert.ok(Math.abs(solve(0).offsets.get('a').get('v').dx-5)<1e-5);
 assert.equal(glueBlendStrength({...glue,mode:'soft-seam'},{ParamAngleX:0}),0.35);
});
test('six brush effects are deterministic, bounded and preserve topology/UV and locks',()=>{
 for(const effect of [{mode:'smooth',strength:0.5},{mode:'relax',strength:0.5},{mode:'inflate',distance:3},{mode:'pinch',strength:0.4,axis:[0,1]},{mode:'bend',angle:15,axis:[0,1]}]){
  const {rig,p}=meshRig();const vertex=p.artMesh.vertices.find(v=>v.u>0&&v.u<1&&v.v>0&&v.v<1);vertex.x+=2;
  const before=structuredClone(p.artMesh),request=op({type:'deform-brush',brush:{...brush(effect),lockedIds:[before.vertices[0].id]}});
  const twin=structuredClone(rig);executeModelingOperation(rig,request);executeModelingOperation(twin,request);assert.deepEqual(rig,twin);
  const after=rig.parts.find(p=>p.id==='body').artMesh;assert.deepEqual(after.triangles,before.triangles);assert.deepEqual(after.vertices.map(v=>[v.id,v.u,v.v]),before.vertices.map(v=>[v.id,v.u,v.v]));assert.deepEqual(after.vertices[0],before.vertices[0]);assert.ok(after.vertices.every((v,i)=>Math.hypot(v.x-before.vertices[i].x,v.y-before.vertices[i].y)<=5+1e-8));
 }
 const graph={points:[{id:'a',x:0,y:0,referenceX:0,referenceY:0},{id:'b',x:10,y:0,referenceX:10,referenceY:0},{id:'c',x:20,y:0,referenceX:20,referenceY:0}],edges:[[0,1],[1,2]],boundary:new Set(['a','b','c']),locked:new Set()};
 const result=applyDeformBrush(graph,{...brush({mode:'contour-follow',strength:1,vertexIds:['a','b','c'],guide:[[0,2],[20,2]]}),center:[10,0]});assert.ok(result.points.every(p=>p.y>1.9));
});
test('smooth edits displacement while relax preserves boundary and improves interior spacing',()=>{
 const graph={points:[{id:'a',x:0,y:0,referenceX:0,referenceY:0},{id:'b',x:15,y:0,referenceX:10,referenceY:0},{id:'c',x:20,y:0,referenceX:20,referenceY:0}],edges:[[0,1],[1,2]],boundary:new Set(['a','c']),locked:new Set()};
 const result=applyDeformBrush(graph,brush({mode:'relax',strength:0.5}));assert.deepEqual(result.points[0],graph.points[0]);assert.deepEqual(result.points[2],graph.points[2]);assert.ok(result.points[1].x<15&&result.points[1].x>=10);
 assert.throws(()=>applyDeformBrush(graph,brush({mode:'pinch',strength:0.5,axis:[0,0]})),/axis/);
});
test('Brush creates additive shape/keyform without changing base and dry-run has no writes',()=>{
 for(const destination of [{kind:'blend-shape',shape:weight},{kind:'keyform',parameter:'ParamAngleX',input:30}]){
 const {rig,p,a}=meshRig();const before=JSON.stringify(rig);const action=op({type:'deform-brush',brush:brush({mode:'inflate',distance:3},destination)});
 executeModelingOperation(rig,action,{dryRun:true});assert.equal(JSON.stringify(rig),before);executeModelingOperation(rig,action);const part=rig.parts.find(p=>p.id==='body');assert.deepEqual(part.artMesh.vertices,p.artMesh.vertices);const neutral=resolveArtMesh(part,a.width,a.height,{ParamAngleX:0}),extreme=resolveArtMesh(part,a.width,a.height,{ParamAngleX:30});assert.deepEqual(neutral.vertices,part.artMesh.vertices);assert.notDeepEqual(extreme.vertices,neutral.vertices);
 }
});
test('invalid shape references or multi-target errors do not partially modify the core document',()=>{
 const rig=structuredClone(sample),before=JSON.stringify(rig);assert.throws(()=>executeModelingOperation(rig,op({type:'blend-shape-set',shape:{...weight,kind:'part',transform:{x:3}}},{partIds:['body','missing']})),/not found/);assert.equal(JSON.stringify(rig),before);
 assert.throws(()=>executeModelingOperation(rig,op({type:'blend-shape-set',shape:{...weight,parameter:'unknown',kind:'part',transform:{x:3}}})),/parameter/);
 rig.parts.find(p=>p.id==='body').blendShapes=[{...weight,kind:'part',transform:{scaleX:-1}}];assert.equal(validateRig(rig).ok,false);
});
test('Warp brush saves pin/shared field differences as deformer shapes',()=>{
 for(const surface of [{kind:'warp-pins',space:'warp-local',width:100,height:100},{kind:'shared-warp',space:'stage'}]){
  const rig=structuredClone(sample),d=deformer();d.sharedWarp={version:1,enabled:true,bounds:{left:0,top:0,width:100,height:100},grid:{columns:1,rows:1},controlPoints:[{id:'00',column:0,row:0,offsetX:0,offsetY:0},{id:'10',column:1,row:0,offsetX:0,offsetY:0},{id:'01',column:0,row:1,offsetX:0,offsetY:0},{id:'11',column:1,row:1,offsetX:0,offsetY:0}]};rig.deformers=[d];
  const request=op({type:'deform-brush',brush:{...brush({mode:'inflate',distance:3},{kind:'blend-shape',shape:weight}),surface}},{deformerIds:['d']});executeModelingOperation(rig,request);const after=rig.deformers[0];assert.deepEqual(after.warp,d.warp);assert.deepEqual(after.sharedWarp,d.sharedWarp);assert.equal(after.blendShapes.length,1);assert.equal(validateRig(rig).ok,true,JSON.stringify(validateRig(rig).issues));
 }
});
test('new action payloads reject misspelled fields and nonnumeric values at the schema boundary',()=>{
 const request=op({type:'deform-brush',brush:brush({mode:'inflate',distance:3})});assert.equal(operationSchema.safeParse(request).success,true);request.action.brush.effect.distance='three';assert.equal(operationSchema.safeParse(request).success,false);
});

test('import validation rejects shapes attached to a different ArtPath or Glue',()=>{
 const rig=structuredClone(sample),p=rig.parts[0];
 const path=id=>({version:1,id,name:id,enabled:true,strokeColor:'#000000',strokeWidth:2,opacity:1,points:[{id:'a',u:0,v:0},{id:'b',u:1,v:1}]});
 p.artPaths=[path('first'),path('second')];p.artPaths[0].blendShapes=[{...weight,kind:'art-path',pathId:'second',width:2}];
 assert.equal(validateRig(rig).ok,false);
 delete p.artPaths[0].blendShapes;
 rig.glue=['first','second'].map(id=>({id,partAId:rig.parts[0].id,partBId:rig.parts[1].id,enabled:true,status:'active',mode:'soft-seam',strength:0.5}));
 rig.glue[0].blendShapes=[{...weight,kind:'glue',glueId:'second',strength:-0.2}];assert.equal(validateRig(rig).ok,false);
});
test('triangle inversion is rejected without changing the input graph',()=>{
 const graph={points:[{id:'a',x:0,y:0,referenceX:0,referenceY:0},{id:'b',x:10,y:0,referenceX:10,referenceY:0},{id:'c',x:0,y:10,referenceX:0,referenceY:10}],edges:[[0,1],[1,2],[2,0]],triangles:[0,1,2],boundary:new Set(['a','b','c']),locked:new Set()};
 const before=structuredClone(graph);
 assert.throws(()=>applyDeformBrush(graph,{...brush({mode:'contour-follow',strength:1,vertexIds:['a','b'],guide:[[0,20],[10,20]]}),radius:10000,maxDisplacement:30,iterations:1}),/inverted/);
 assert.deepEqual(graph,before);
});

test('multiple shape channels compose without order-dependent transform replacement',()=>{
 const p={...sample.parts[0],transform:{...zero},bindings:[],blendShapes:[{...weight,kind:'part',transform:{x:2,scaleX:4}},{...weight,id:'second',parameter:'ParamAngleY',kind:'part',transform:{x:6,scaleX:9}}]};
 const pose=resolvePartPose(p,{ParamAngleX:15,ParamAngleY:15});assert.equal(pose.x,4);assert.equal(pose.scaleX,6);
 p.blendShapes.reverse();assert.deepEqual(resolvePartPose(p,{ParamAngleX:15,ParamAngleY:15}),pose);
});
test('Warp Brush ignores disabled pins and duplicate owner selectors apply once',()=>{
 const rig=structuredClone(sample),d=deformer();d.warp.pins.push({...d.warp.pins[0],id:'disabled',enabled:false});rig.deformers=[d];
 const action={type:'deform-brush',brush:{...brush({mode:'inflate',distance:3},{kind:'blend-shape',shape:weight}),surface:{kind:'warp-pins',space:'warp-local',width:100,height:100}}};
 const twin=structuredClone(rig);executeModelingOperation(rig,op(action,{deformerIds:['d','d']}));executeModelingOperation(twin,op(action,{deformerIds:['d']}));assert.deepEqual(rig,twin);assert.equal(rig.deformers[0].blendShapes[0].pins.length,1);
});
