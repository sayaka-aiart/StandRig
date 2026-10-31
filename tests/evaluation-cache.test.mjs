import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EvaluationCache,withEvaluationCache} from '@standrig/core/evaluationCache';
import {sampleParameterGrid} from '@standrig/core/parameterGrid';
import {sampleMultiArtMeshBinding} from '@standrig/core/artMeshMulti';
import {isValidArtMesh,resolveArtMesh} from '@standrig/core/artMesh';
import {sampleBinding} from '@standrig/core/bindings';
import {RigRuntime} from '@standrig/runtime/renderer';

const grid=()=>({parameters:['X','Y','Z'],keyforms:[-1,0,1].flatMap(X=>[-1,0,1].flatMap(Y=>[-1,0,1].map(Z=>({inputs:{X,Y,Z},offsets:[{vertexId:'a',x:X+Y*Z,y:Z-X*Y},{vertexId:'c',x:Y*.2,y:X*Z*.2}]}))))});
const mesh=()=>({version:1,enabled:true,generator:{preset:'face-feature',columns:1,rows:1,alphaThreshold:1,alphaBounds:{left:0,top:0,width:10,height:10}},vertices:[{id:'a',x:0,y:0,u:0,v:0},{id:'b',x:10,y:0,u:1,v:0},{id:'c',x:10,y:10,u:1,v:1}],triangles:[0,1,2],bindings:[],multiBindings:[grid()]});

test('prepared grids preserve exact outputs across cells, boundaries and interpolation modes',()=>{
 const b=grid(),m=mesh(),cache=new EvaluationCache();
 for(const mode of ['linear','smoothstep','hold','arc','curve'])for(const X of [-3,-1,-.6,0,.4,1,3])for(const Y of [-1,-.2,0,1])for(const Z of [-1,.3,1]){
  b.interpolation=mode;b.curve={controlPoints:[{t:0,value:0},{t:.5,value:.3},{t:1,value:1}]};
  const v={X,Y,Z},expected=sampleMultiArtMeshBinding(b,v),actual=withEvaluationCache(cache,()=>sampleMultiArtMeshBinding(b,v));
  assert.deepEqual(actual,expected);
  assert.deepEqual(withEvaluationCache(cache,()=>resolveArtMesh({artMesh:m},10,10,v)),resolveArtMesh({artMesh:m},10,10,v));
 }
});

test('prepared grid lookup does not rescan key coordinates for each frame',()=>{
 let reads=0;const parameters=['X','Y'],keyforms=Array.from({length:40},(_,X)=>Array.from({length:40},(_,Y)=>({get inputs(){reads++;return {X,Y};},value:X+Y}))).flat(),cache=new EvaluationCache();
 withEvaluationCache(cache,()=>sampleParameterGrid(parameters,keyforms,{X:.2,Y:.3}));const initial=reads;assert.ok(initial>=1600);
 for(let i=0;i<50;i++)assert.equal(withEvaluationCache(cache,()=>sampleParameterGrid(parameters,keyforms,{X:i*.7,Y:i*.4})).length,4);
 assert.equal(reads,initial);
});

test('missing grid corners and last duplicate keys retain legacy behavior',()=>{
 const b=grid();b.keyforms=b.keyforms.filter(k=>!(k.inputs.X===0&&k.inputs.Y===0&&k.inputs.Z===0));
 const cache=new EvaluationCache();assert.deepEqual(withEvaluationCache(cache,()=>sampleMultiArtMeshBinding(b,{X:.2,Y:.2,Z:.2})),sampleMultiArtMeshBinding(b,{X:.2,Y:.2,Z:.2}));
 assert.equal(withEvaluationCache(cache,()=>sampleParameterGrid(b.parameters,b.keyforms,{X:.2,Y:.2,Z:.2})).length,0);
 const parameters=['X','Y'],keys=[0,1].flatMap(X=>[0,1].map(Y=>({inputs:{X,Y},value:1})));keys.push({inputs:{X:1,Y:1},value:9});
 assert.equal(withEvaluationCache(new EvaluationCache(),()=>sampleParameterGrid(parameters,keys,{X:1,Y:1})).at(-1).key.value,9);
});

test('offset caches preserve last-wins duplicates, zero corners and independent result values',()=>{
 const b={parameters:['X','Y'],keyforms:[0,1].flatMap(X=>[0,1].map(Y=>({inputs:{X,Y},offsets:[{vertexId:'a',x:1,y:1},{vertexId:'a',x:5*X,y:3},{vertexId:'high-only',x:10*X,y:0}]})))},cache=new EvaluationCache();
 const first=withEvaluationCache(cache,()=>sampleMultiArtMeshBinding(b,{X:1,Y:1}));assert.deepEqual(first.get('a'),{x:5,y:3});first.get('a').x=99;
 assert.deepEqual(withEvaluationCache(cache,()=>sampleMultiArtMeshBinding(b,{X:1,Y:1})).get('a'),{x:5,y:3});
 assert.deepEqual(withEvaluationCache(cache,()=>sampleMultiArtMeshBinding(b,{X:0,Y:0})).get('high-only'),{x:0,y:0});
});

test('mutable callers remain live outside a snapshot and a fresh cache sees same-object edits',()=>{
 const m=mesh(),b=m.multiBindings[0],cache=new EvaluationCache(),v={X:1,Y:1,Z:1};
 const before=withEvaluationCache(cache,()=>sampleMultiArtMeshBinding(b,v));
 b.keyforms.at(-1).offsets.push({vertexId:'a',x:42,y:8});
 assert.equal(sampleMultiArtMeshBinding(b,v).get('a').x,42);
 assert.equal(withEvaluationCache(new EvaluationCache(),()=>sampleMultiArtMeshBinding(b,v)).get('a').x,42);
 assert.notEqual(before.get('a').x,42);
 const single={keys:[{input:1,value:10},{input:0,value:0}]};assert.equal(withEvaluationCache(cache,()=>sampleBinding(single,.5)),5);single.keys[0].input=2;
 assert.equal(sampleBinding(single,1),5);assert.equal(withEvaluationCache(new EvaluationCache(),()=>sampleBinding(single,1)),5);
});

test('validation cache is scoped, checks dimensions and cannot bypass normal validation after edits',()=>{
 const m=mesh(),cache=new EvaluationCache();assert.equal(withEvaluationCache(cache,()=>isValidArtMesh(m,10,10)),true);
 assert.equal(withEvaluationCache(cache,()=>isValidArtMesh(m,0,10)),false);
 m.vertices[0].u=2;assert.equal(isValidArtMesh(m,10,10),false);assert.equal(withEvaluationCache(new EvaluationCache(),()=>isValidArtMesh(m,10,10)),false);
});

test('nested and throwing evaluations restore scope and never mutate frozen source data',()=>{
 const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
 const b=freeze(grid()),before=JSON.stringify(b),outer=new EvaluationCache(),inner=new EvaluationCache();
 assert.throws(()=>withEvaluationCache(outer,()=>withEvaluationCache(inner,()=>{throw Error('draw failed');})),/draw failed/);
 const a=withEvaluationCache(outer,()=>sampleMultiArtMeshBinding(b,{X:.2,Y:.3,Z:.4}));const c=withEvaluationCache(inner,()=>sampleMultiArtMeshBinding(b,{X:.8,Y:.3,Z:.4}));
 a.get('a').x=999;assert.notEqual(c.get('a').x,999);assert.equal(JSON.stringify(b),before);
 const m=mesh();assert.ok(isValidArtMesh(m,10,10));m.vertices[0].x=NaN;assert.equal(isValidArtMesh(m,10,10),false);
});

test('runtime reload invalidates prepared indexes even when the rig object is reused',async()=>{
 const binding={parameters:['X','Y'],property:'x',keyforms:[0,1].flatMap(X=>[0,1].map(Y=>({inputs:{X,Y},value:X*10})))};
 const rig={schemaVersion:'0.1.0',name:'Mutable synthetic',stage:{width:10,height:10},assets:[],parameters:[],parts:[{id:'r',kind:'group',visible:true,drawOrder:0,transform:{x:0,y:0,rotation:0,scaleX:1,scaleY:1,pivotX:0,pivotY:0,opacity:1},multiBindings:[binding]}],physics:{enabled:false,chains:[]}};
 // Instrument the synchronous drawing boundary; this test needs no browser/GPU.
 const value=()=>sampleParameterGrid(binding.parameters,binding.keyforms,{X:1,Y:.5}).reduce((sum,c)=>sum+c.weight*c.key.value,0);
 const runtime=new RigRuntime(rig,{cacheEvaluation:true});runtime.renderFrame=value;
 assert.equal(runtime.render({},{}),10);for(const k of binding.keyforms)if(k.inputs.X===1)k.inputs.X=2;
 await runtime.setRig(rig);assert.equal(runtime.render({},{}),5);
 // Default mutable runtimes must also stay uncached when nested in another scope.
 const mutable=new RigRuntime(rig);mutable.renderFrame=value;const outer=new EvaluationCache();
 assert.equal(withEvaluationCache(outer,()=>mutable.render({},{})),5);
 for(const k of binding.keyforms)if(k.inputs.X===2)k.inputs.X=4;
 assert.equal(withEvaluationCache(outer,()=>mutable.render({},{})),2.5);
 runtime.dispose();mutable.dispose();
});
