import { test } from 'node:test';
import assert from 'node:assert/strict';
import { samplePartAffine, resolvePartAffine, partAffineIssues } from '@standrig/core/partAffine';
import { evaluateRigParts, identityMatrix, transformMatrixPoint } from '@standrig/core/evaluator';
import { DEFAULT_TRANSFORM } from '@standrig/core/types';
import { runQaCheck } from '@standrig/core/qaCheck';
import { encodePng } from '@standrig/core/png';

const matrix=(a=1,b=0,c=0,d=1,e=0,f=0)=>({a,b,c,d,e,f});
const binding=(fn)=>({parameters:['X','Y'],keyforms:[-1,1].flatMap(x=>[-1,1].map(y=>({inputs:{X:x,Y:y},matrix:fn(x,y)})))});
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);

test('local turn projection samples finite affine matrices and clamps to its grid',()=>{
 const b=binding((x,y)=>matrix(1+.2*x,0,.1*y,1,10*x,5*y));
 assert.deepEqual(samplePartAffine(b,{X:0,Y:0}),matrix());
 const p=samplePartAffine(b,{X:2,Y:-2});near(p.a,1.2);near(p.c,-.1);near(p.e,10);near(p.f,-5);
 assert.deepEqual(samplePartAffine({...b,keyforms:b.keyforms.slice(1)},{X:0,Y:0}),matrix());
});

test('affine stages run in authored order inside the part and parent transforms',()=>{
 const part={id:'p',name:'p',kind:'image',parentId:'root',visible:true,drawOrder:0,transform:{...DEFAULT_TRANSFORM,x:10,y:20},affineBindings:[binding(()=>matrix(1,0,0,1,3,4)),binding(()=>matrix(2,0,0,3))]};
 const parent={id:'root',name:'root',kind:'group',parentId:null,visible:true,drawOrder:0,transform:{...DEFAULT_TRANSFORM,x:100,y:200}};
 const rig={parts:[parent,part],parameters:[],assets:[],physics:{enabled:false,chains:[]}};
 const combined=resolvePartAffine(part,{X:0,Y:0});assert.deepEqual(combined,matrix(2,0,0,3,6,12));
 const frame=evaluateRigParts(rig,{X:0,Y:0},identityMatrix());const p=transformMatrixPoint(frame.get('p').matrix,1,2);near(p.x,118);near(p.y,238);
});

test('affine import validation rejects singular, reflected, duplicate and incomplete grids',()=>{
 const params=new Set(['X','Y']);const valid={affineBindings:[binding(()=>matrix(.5,0,.2,1))]};assert.deepEqual(partAffineIssues(valid,params),[]);
 for(const mutate of [b=>b.keyforms.pop(),b=>b.keyforms.push(b.keyforms[0]),b=>b.keyforms[0].matrix.a=0,b=>b.keyforms[0].matrix.a=-1,b=>b.keyforms[0].matrix.e=NaN,b=>b.parameters[1]='missing']){
  const p=structuredClone(valid);mutate(p.affineBindings[0]);assert.ok(partAffineIssues(p,params).length);
 }
});

test('QA detects singular interpolation even when every affine key preserves orientation',async()=>{
 const b=binding(x=>matrix(0,x,-x,0));const part={id:'p',name:'p',kind:'image',parentId:null,visible:true,drawOrder:0,assetId:'a',transform:{...DEFAULT_TRANSFORM,x:16,y:16},affineBindings:[b]};
 assert.deepEqual(partAffineIssues(part,new Set(['X','Y'])),[]);
 const src='data:image/png;base64,'+Buffer.from(encodePng({width:2,height:2,data:new Uint8ClampedArray(Array.from({length:4},()=>[255,100,50,255]).flat())})).toString('base64');
 const rig={schemaVersion:'0.1.0',name:'projection',stage:{width:32,height:32},assets:[{id:'a',name:'pixel',type:'image',width:2,height:2,src}],parts:[part],parameters:['X','Y'].map(id=>({id,label:id,min:-1,max:1,default:0})),physics:{enabled:false,chains:[]}};
 const result=await runQaCheck(rig,'.',{poseSamples:[{poseId:'middle',values:{X:0,Y:0}}],regions:['full'],physics:false});
 assert.equal(result.ok,false);assert.ok(result.failed[0].issues.includes('part-affine-degenerate'));
});
