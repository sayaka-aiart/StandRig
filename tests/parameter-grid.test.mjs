import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sampleParameterGrid,parameterGridIssues} from '@standrig/core/parameterGrid';
import {sampleMultiArtMeshBinding} from '@standrig/core/artMeshMulti';
import {samplePartAffine} from '@standrig/core/partAffine';
import {resolveSharedShape} from '@standrig/core/extendedBlendShape';
import {normalizeSharedWarpField,resizeSharedWarpField} from '@standrig/core/sharedWarp';
import {sampleWarpKeyform} from '@standrig/core/warpKeyforms';

const parameters=['X','Y','Z'];
const keys=()=>[-1,1].flatMap(X=>[-1,1].flatMap(Y=>[-1,1].map(Z=>({inputs:{X,Y,Z},value:2*X+3*Y+4*Z+X*Y*Z}))));
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-9,`${a} != ${b}`);
test('zero-weight corners retain replacement IDs at exact legacy grid endpoints',()=>{
 const binding={parameters:['X','Y'],keyforms:[0,1].flatMap(X=>[0,1].map(Y=>({inputs:{X,Y},offsets:X===1?[{vertexId:'only-high',x:10,y:2}]:[]})))};
 assert.deepEqual(sampleMultiArtMeshBinding(binding,{X:0,Y:0}).get('only-high'),{x:0,y:0});
});
test('three-axis grids preserve cross-axis terms and clamp each axis',()=>{
 const keyforms=keys(),values={X:.25,Y:-.5,Z:.75};
 near(sampleParameterGrid(parameters,keyforms,values).reduce((s,c)=>s+c.key.value*c.weight,0),2*.25+3*-.5+4*.75+.25*-.5*.75);
 near(sampleParameterGrid(parameters,keyforms,{X:8,Y:8,Z:-8}).reduce((s,c)=>s+c.key.value*c.weight,0),0);
 assert.deepEqual(parameterGridIssues(parameters,keyforms,new Set(parameters)),[]);
 assert.ok(parameterGridIssues(parameters,keyforms.slice(1),new Set(parameters)).length);
 assert.equal(sampleParameterGrid(parameters,keyforms.slice(1),{}).length,0);
 assert.equal(sampleParameterGrid(['X','X','Z'],keyforms,{}).length,0);
});
test('mesh offsets and affine projection use the same XYZ interpolation',()=>{
 const k=keys(),values={X:.3,Y:.6,Z:-.4};
 const expected=sampleParameterGrid(parameters,k,values).reduce((s,c)=>s+c.key.value*c.weight,0);
 const mesh={parameters,keyforms:k.map(k=>({...k,offsets:[{vertexId:'v',x:k.value,y:-k.value}]}))};
 near(sampleMultiArtMeshBinding(mesh,values).get('v').x,expected);
 const aff={parameters,keyforms:k.map(k=>({...k,matrix:{a:1,b:0,c:0,d:1,e:k.value,f:0}}))};
 near(samplePartAffine(aff,values).e,expected);
 mesh.keyforms[0].offsets[0].x+=8;assert.notEqual(sampleMultiArtMeshBinding(mesh,values).get('v').x,expected);
});
test('shared warp XYZ controls retain bindings and reject destructive resizing and ambiguous editing',()=>{
 const multiBindings=[{parameters,property:'offsetX',keyforms:keys(),additive:true}];
 const field=normalizeSharedWarpField({enabled:true,bounds:{left:0,top:0,width:10,height:10},grid:{columns:1,rows:1},controlPoints:[{id:'p',column:0,row:0,offsetX:10,offsetY:0,multiBindings}]});
 assert.deepEqual(field.controlPoints[0].multiBindings,multiBindings);
 const resolved=resolveSharedShape(field,[],{X:1,Y:1,Z:1});near(resolved.controlPoints[0].offsetX,20);near(field.controlPoints[0].offsetX,10);
 assert.throws(()=>resizeSharedWarpField(field,2,2),/without remapping/);
 assert.throws(()=>sampleWarpKeyform(field.controlPoints[0],'X',0),/ambiguous/);
});
