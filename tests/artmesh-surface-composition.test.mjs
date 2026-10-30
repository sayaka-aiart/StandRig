import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRectArtMesh, resolveArtMesh, isValidArtMesh } from '@standrig/core/artMesh';
import { applyArtMeshSurface } from '@standrig/core/artMeshSurface';
import { auditRigArtMeshDistortion } from '@standrig/core/artMeshDistortion';

function mesh() { return createRectArtMesh(100, 100, { preset:'eye', columns:2, rows:2 }); }
function surface(m, transform, composition='surface') {
  return { parameters:['X','Y'],composition,additive:true,keyforms:[0,1].flatMap(x=>[0,1].map(y=>({inputs:{X:x,Y:y},offsets:m.vertices.map(v=>{const p=transform(v,x,y);return {vertexId:v.id,x:p.x-v.x,y:p.y-v.y};})}))) };
}
function closeEye(m) {
  m.bindings=[{parameter:'Open',additive:true,keys:[{input:0,offsets:m.vertices.map(v=>({vertexId:v.id,x:0,y:(50-v.y)*.96}))},{input:1,offsets:[]}]}];
}
function near(actual,expected) { assert.ok(Math.abs(actual-expected)<1e-7,`${actual} != ${expected}`); }

test('one-axis secondary surfaces run after the angle material and survive JSON import',()=>{
 const m=mesh();m.multiBindings=[surface(m,(v,x)=>({x:v.x+20*x,y:v.y}))];
 m.bindings=[{parameter:'Sway',composition:'surface',keys:[{input:0,offsets:[]},{input:1,offsets:m.vertices.map(v=>({vertexId:v.id,x:v.x*.1,y:0}))}]}];
 const copy=JSON.parse(JSON.stringify(m));assert.ok(isValidArtMesh(copy,100,100));
 const r=resolveArtMesh({artMesh:copy},100,100,{X:1,Y:0,Sway:1});
 r.vertices.forEach((v,i)=>near(v.x,(m.vertices[i].x+20)*1.1));
 copy.bindings[0].composition='surafce';assert.equal(isValidArtMesh(copy,100,100),false);
});

test('yaw surface rotates a closed eyelid instead of adding open-eye offsets to it',()=>{
 const m=mesh();closeEye(m);m.multiBindings=[surface(m,(v,x)=>({x:20*x+v.x*(1-.5*x),y:10*x+v.y*(1-.2*x)}))];
 const result=resolveArtMesh({artMesh:m},100,100,{Open:0,X:1,Y:0});
 const ys=result.vertices.map(v=>v.y);near(Math.max(...ys)-Math.min(...ys),3.2);
 for(let i=0;i<m.vertices.length;i++){const v=m.vertices[i];near(result.vertices[i].x,20+v.x*.5);near(result.vertices[i].y,10+(50+(v.y-50)*.04)*.8);}
 const legacy=structuredClone(m);delete legacy.multiBindings[0].composition;
 const bad=resolveArtMesh({artMesh:legacy},100,100,{Open:0,X:1,Y:0});
 assert.ok(Math.max(...bad.vertices.map(v=>v.y))-Math.min(...bad.vertices.map(v=>v.y))>10);
});

test('a point crossing into another triangle samples that rest surface',()=>{
 const m=mesh(),v=m.vertices.find(v=>v.x===0&&v.y===0);
 const samples=new Map(m.vertices.map(v=>[v.id,{x:v.x>=50?10:0,y:0}]));
 const offsets=new Map([[v.id,{x:75,y:25}]]);applyArtMeshSurface(m,samples,offsets);
 near(offsets.get(v.id).x,85);near(offsets.get(v.id).y,25);
});

test('outside-hull expression positions extrapolate an affine surface continuously',()=>{
 const m=mesh(),v=m.vertices[0];const samples=new Map(m.vertices.map(v=>[v.id,{x:10+v.x*.5,y:-v.y*.25}]));
 const offsets=new Map([[v.id,{x:-20-v.x,y:120-v.y}]]);applyArtMeshSurface(m,samples,offsets);
 near(v.x+offsets.get(v.id).x,-20);near(v.y+offsets.get(v.id).y,90);
});

test('surface stages compose in authored order after blend shapes',()=>{
 const m=mesh();m.blendShapes=[{id:'b',parameter:'B',neutralInput:0,targetInput:1,additive:true,offsets:m.vertices.map(v=>({vertexId:v.id,x:10,y:0}))}];
 m.multiBindings=[surface(m,(v,x)=>({x:v.x+20*x,y:v.y})),surface(m,(v,x)=>({x:v.x*(1+x),y:v.y}))];
 const r=resolveArtMesh({artMesh:m},100,100,{X:1,Y:0,B:1});
 r.vertices.forEach((v,i)=>near(v.x,(m.vertices[i].x+10+20)*2));
});

test('missing enclosing keyforms and an identity surface preserve expression geometry',()=>{
 const m=mesh();closeEye(m);const incomplete=surface(m,(v,x)=>({x:v.x+20*x,y:v.y}));incomplete.keyforms.pop();m.multiBindings=[incomplete];
 const a=resolveArtMesh({artMesh:m},100,100,{Open:0,X:.5,Y:.5});m.multiBindings=[surface(m,v=>v)];
 const b=resolveArtMesh({artMesh:m},100,100,{Open:0,X:.5,Y:.5});assert.deepEqual(a.vertices,b.vertices);
});

test('JSON roundtrip retains surface composition and rejects misspelled modes',()=>{
 const m=mesh();m.multiBindings=[surface(m,(v,x)=>({x:v.x+5*x,y:v.y}))];const copy=JSON.parse(JSON.stringify(m));
 assert.equal(copy.multiBindings[0].composition,'surface');assert.ok(isValidArtMesh(copy,100,100));
 copy.multiBindings[0].composition='surafce';assert.equal(isValidArtMesh(copy,100,100),false);
});

test('surface geometry cache follows in-place topology and vertex-ID edits',()=>{
 const m=mesh(),v=m.vertices[0],samples=()=>new Map(m.vertices.map(p=>[p.id,{x:p.x*.5,y:p.y*.5}]));
 applyArtMeshSurface(m,samples(),new Map([[v.id,{x:25,y:25}]]));
 m.vertices.forEach(p=>{p.x*=2;p.y*=2;p.id+='-edited';});
 const offsets=new Map([[v.id,{x:25,y:25}]]);applyArtMeshSurface(m,samples(),offsets);near(offsets.get(v.id).x,37.5);near(offsets.get(v.id).y,37.5);
});

test('QA checks closure and angle stages without hiding their final composed compression',()=>{
 const m=mesh();m.bindings=[{parameter:'Open',keys:[{input:0,offsets:m.vertices.map(v=>({vertexId:v.id,x:0,y:(50-v.y)*.7}))}]}];
 m.multiBindings=[surface(m,(v,x)=>({x:v.x,y:v.y*(1-.5*x)}))];
 const rig={assets:[{id:'a',width:100,height:100}],parts:[{id:'p',assetId:'a',artMesh:m}]};
 const result=auditRigArtMeshDistortion(rig,{Open:0,X:1,Y:0});
 assert.equal(result.pass,true);near(result.maxCompressionRatio,1/.3);near(result.composed.maxCompressionRatio,1/.15);
 assert.equal(result.triangleStageTests,result.triangleCount*2);
 // A broken surface remains a failure at the same thresholds.
 m.multiBindings=[surface(m,(v,x)=>({x:v.x,y:v.y*(1-.9*x)}))];
 const broken=auditRigArtMeshDistortion(rig,{Open:0,X:1,Y:0});assert.equal(broken.pass,false);assert.ok(broken.violations.some(v=>v.stage==='surface:X/Y'));
 // And so does an invalid legacy expression.
 m.multiBindings=[surface(m,v=>v)];m.bindings[0].keys[0].offsets=m.vertices.map(v=>({vertexId:v.id,x:0,y:(50-v.y)*.9}));
 assert.equal(auditRigArtMeshDistortion(rig,{Open:0,X:1,Y:0}).pass,false);
});

test('large staged meshes do not overflow the JavaScript argument stack in QA',()=>{
 const m=createRectArtMesh(100,100,{preset:'eye',columns:8,rows:8});m.multiBindings=[surface(m,(v,x)=>({x:v.x*(1-.5*x),y:v.y}))];
 const rig={assets:[{id:'a',width:100,height:100}],parts:Array.from({length:800},(_,i)=>({id:'p-'+i,assetId:'a',artMesh:m}))};
 const result=auditRigArtMeshDistortion(rig,{X:1,Y:0});assert.equal(result.pass,true);assert.equal(result.triangleStageTests,204800);near(result.maxCompressionRatio,2);
});
