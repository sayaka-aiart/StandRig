import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sampleMultiParameterBinding} from '@standrig/core/multiBindings';
import {resolvePartPose} from '@standrig/core/evaluator';
import {prepareRigBindingOrder} from '@standrig/core/bindingPreparation';

// The two-parameter sampler this generalizes, kept verbatim as the reference for exactness.
function legacyBilinear(binding,values){
 const [x,y]=binding.parameters,points=new Map(),xs=new Set(),ys=new Set();
 for(const k of binding.keyforms){points.set(k.inputs[x]+'|'+k.inputs[y],k.value);xs.add(k.inputs[x]);ys.add(k.inputs[y]);}
 const span=(axis,v)=>{const a=[...axis].sort((p,q)=>p-q),c=Math.min(a.at(-1),Math.max(a[0],v));for(let i=0;i<a.length-1;i++)if(c>=a[i]&&c<=a[i+1])return{low:a[i],high:a[i+1]};};
 const xs1=span(xs,values[x]??0),ys1=span(ys,values[y]??0);
 const r=(v,l,h)=>Math.min(1,Math.max(0,(v-l)/(h-l||1)));
 const tx=r(values[x]??0,xs1.low,xs1.high),ty=r(values[y]??0,ys1.low,ys1.high);
 const q=(a,b)=>points.get(a+'|'+b);
 const bottom=q(xs1.low,ys1.low)+(q(xs1.high,ys1.low)-q(xs1.low,ys1.low))*tx;
 const top=q(xs1.low,ys1.high)+(q(xs1.high,ys1.high)-q(xs1.low,ys1.high))*tx;
 return bottom+(top-bottom)*ty;
}

test('two-parameter grids evaluate bit-identically to the original bilinear sampler',()=>{
 const binding={parameters:['A','B'],property:'opacity',keyforms:[-30,0,30].flatMap(A=>[0,0.5,1].map(B=>({inputs:{A,B},value:Math.sin(A*0.7+B*3.1)})))};
 let seed=7;const rand=()=>((seed=(seed*16807)%2147483647)/2147483647);
 for(let i=0;i<500;i++){
  const values={A:rand()*80-40,B:rand()*1.4-0.2};
  assert.equal(sampleMultiParameterBinding(binding,values),legacyBilinear(binding,values));
 }
});

test('three-parameter grids interpolate trilinearly, keep cross terms and clamp',()=>{
 const f=(X,Y,Z)=>2*X+3*Y+4*Z+X*Y*Z;
 const binding={parameters:['X','Y','Z'],property:'opacity',keyforms:[-1,1].flatMap(X=>[-1,1].flatMap(Y=>[-1,1].map(Z=>({inputs:{X,Y,Z},value:f(X,Y,Z)}))))};
 const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-12,`${a} != ${b}`);
 near(sampleMultiParameterBinding(binding,{X:.25,Y:-.5,Z:.75}),f(.25,-.5,.75));
 near(sampleMultiParameterBinding(binding,{X:9,Y:9,Z:9}),f(1,1,1));
 assert.equal(sampleMultiParameterBinding({...binding,keyforms:binding.keyforms.slice(1)},{}),undefined);
 assert.equal(sampleMultiParameterBinding({...binding,parameters:['X','X','Z']},{}),undefined);
 assert.equal(sampleMultiParameterBinding({...binding,parameters:['X','Y','Z','W']},{}),undefined);
});

test('a 2x2x2 opacity grid (expression toggles) drives part opacity',()=>{
 // Visible only when exactly one of key5/key6 is on, unless key3 overrides: the shape found in exported models.
 const visible=(a,b,c)=>c?1:(a^b);
 const part={id:'p',transform:{x:0,y:0,rotation:0,scaleX:1,scaleY:1,opacity:1},
  multiBindings:[{parameters:['key5','key6','key3'],property:'opacity',composition:'multiply',
   keyforms:[0,1].flatMap(a=>[0,1].flatMap(b=>[0,1].map(c=>({inputs:{key5:a,key6:b,key3:c},value:visible(a,b,c)}))))}]};
 for(const a of [0,1])for(const b of [0,1])for(const c of [0,1])
  assert.equal(resolvePartPose(part,{key5:a,key6:b,key3:c},undefined).opacity,visible(a,b,c));
 assert.equal(resolvePartPose(part,{key5:.5,key6:0,key3:0},undefined).opacity,.5);
});

test('binding preparation orders three-parameter keyforms lexicographically',()=>{
 const keyforms=[[1,1,1],[0,0,1],[1,0,0],[0,1,0],[0,0,0]].map(([a,b,c])=>({inputs:{a,b,c},value:0}));
 const rig={parts:[{id:'p',multiBindings:[{parameters:['a','b','c'],property:'opacity',keyforms}]}],deformers:[]};
 prepareRigBindingOrder(rig);
 assert.deepEqual(rig.parts[0].multiBindings[0].keyforms.map(k=>[k.inputs.a,k.inputs.b,k.inputs.c]),[[0,0,0],[0,0,1],[0,1,0],[1,0,0],[1,1,1]]);
});

test('mesh and scalar grids accept up to eight parameters and stay multilinear',async()=>{
 const {sampleMultiArtMeshBinding}=await import('@standrig/core/artMeshMulti');
 const {validGridParameters,MAX_GRID_PARAMETERS}=await import('@standrig/core/parameterGrid');
 assert.equal(MAX_GRID_PARAMETERS,8);
 const names=['A','B','C','D'];
 const f=(v)=>v.A+2*v.B-3*v.C+0.5*v.D+v.A*v.B*v.C*v.D;
 const cells=[];
 for(let bits=0;bits<16;bits++){const inputs=Object.fromEntries(names.map((n,i)=>[n,bits&(1<<i)?1:-1]));cells.push(inputs);}
 const mesh={parameters:names,keyforms:cells.map(inputs=>({inputs,offsets:[{vertexId:'v',x:f(inputs),y:0}]}))};
 const scalar={parameters:names,property:'opacity',keyforms:cells.map(inputs=>({inputs,value:f(inputs)}))};
 const values={A:.2,B:-.4,C:.6,D:-.8};
 assert.ok(Math.abs(sampleMultiArtMeshBinding(mesh,values).get('v').x-f(values))<1e-12);
 assert.ok(Math.abs(sampleMultiParameterBinding(scalar,values)-f(values))<1e-12);
 assert.ok(validGridParameters(['a','b','c','d','e','f','g','h']));
 assert.ok(!validGridParameters(['a','b','c','d','e','f','g','h','i']));
});
