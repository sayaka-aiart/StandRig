import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRectArtMesh} from '@standrig/core/artMesh';
import {auditRigArtMeshDistortion} from '@standrig/core/artMeshDistortion';

function fixture(){
 const mesh=createRectArtMesh(10,10,{preset:'face-feature',columns:1,rows:1});mesh.enabled=true;
 const part={id:'large',kind:'image',assetId:'art',artMesh:mesh};
 return {mesh,rig:{parts:[part],assets:[{id:'art',width:10,height:10}]}};
}

test('large mesh audit retains maxima beyond the engine argument-count limit',()=>{
 const {mesh,rig}=fixture(),vertices=mesh.vertices.map(v=>({...v})),triangles=[...mesh.triangles];
 mesh.vertices.push(...vertices.map(v=>({...v,id:'last-'+v.id,x:v.x+30})));
 mesh.triangles=[];
 for(let i=0;i<90000;i++)mesh.triangles.push(...triangles);
 mesh.triangles.push(...triangles.map(i=>i+vertices.length));
 mesh.bindings=[{parameter:'stretch',additive:true,keys:[{input:0,offsets:[]},{input:1,offsets:vertices.map(v=>({vertexId:'last-'+v.id,x:v.x*2,y:0}))}]}];
 const result=auditRigArtMeshDistortion(rig,{stretch:1});
 assert.equal(result.triangleCount,180002);
 assert.equal(result.pass,true);
 assert.ok(Math.abs(result.maxStretchRatio-3)<1e-9);
 assert.ok(Math.abs(result.maxAnisotropy-3)<1e-9);
 assert.equal(result.maxCompressionRatio,1);
});

test('degenerate geometry keeps non-finite maxima visible to QA',()=>{
 const {mesh,rig}=fixture();mesh.bindings=[{parameter:'flatten',additive:true,keys:[{input:0,offsets:[]},{input:1,offsets:mesh.vertices.map(v=>({vertexId:v.id,x:0,y:-v.y}))}]}];
 const result=auditRigArtMeshDistortion(rig,{flatten:1});
 assert.equal(result.pass,false);
 assert.equal(result.maxStretchRatio,Infinity);
 assert.equal(result.maxCompressionRatio,Infinity);
 assert.equal(result.maxAnisotropy,Infinity);
});

test('empty audit keeps its default maxima',()=>{
 const result=auditRigArtMeshDistortion({parts:[],assets:[]},{});
 assert.equal(result.pass,true);
 assert.equal(result.maxStretchRatio,1);
 assert.equal(result.maxCompressionRatio,1);
 assert.equal(result.maxAnisotropy,1);
});
