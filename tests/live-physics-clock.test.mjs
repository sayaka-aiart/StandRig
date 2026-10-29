import {test} from 'node:test';
import assert from 'node:assert/strict';
import {prepareLivePhysicsStep} from '@standrig/runtime/physicsStepping';
import {resolvePhysicsFrame} from '@standrig/core/evaluator';

const rig={physics:{enabled:true,chains:[{id:'spring',enabled:true,targetPartIds:[],sourceParameters:[{parameter:'Head',scale:1}],stiffness:35,damping:8,mass:1,gravity:0,wind:.05,output:{property:'x',scale:0},parameterOutput:{parameter:'Hair',scale:1},segments:[{id:'tip',length:1,delay:.1,damping:1}]}]}};
const frame=(state,values,previous,elapsed,time)=>{const step=prepareLivePhysicsStep(rig,values,previous,state,elapsed,time);return{step,output:resolvePhysicsFrame(rig,values,state,step.dt,step.time).parameterOffsets.Hair};};

test('5-120 FPS advances the entire live interval without losing time',()=>{
 for(const fps of[5,10,17,20,30,60,120]){
  const state=new Map();let elapsed=0,previous,output;
  for(let i=1;i<=fps*4;i++){const values={Head:1};const result=frame(state,values,previous,1/fps,i/fps);elapsed+=result.step.dt*result.step.steps;output=result.output;previous=values;}
  assert.ok(Math.abs(elapsed-4)<1e-10,`${fps} FPS lost simulation time`);
  assert.ok(Number.isFinite(output));
 }
});

test('a slow frame matches explicit interpolated substeps, including wind time',()=>{
 const actual=new Map(),expected=new Map(),previous={Head:-1},current={Head:1};
 const {step,output}=frame(actual,current,previous,.1,3);
 let reference;
 for(let i=1;i<=step.steps;i++)reference=resolvePhysicsFrame(rig,{Head:-1+2*i/step.steps},expected,step.dt,3-.1+step.dt*i).parameterOffsets.Hair;
 assert.equal(output,reference);assert.deepStrictEqual(actual,expected);
 assert.deepStrictEqual(previous,{Head:-1});assert.deepStrictEqual(current,{Head:1});
});

test('display cadence preserves the phase and size of a smooth moving driver',()=>{
 function run(fps){const state=new Map(),samples=[];let previous={Head:0};for(let i=1;i<=fps*12;i++){const t=i/fps,values={Head:Math.sin(t*1.2)},r=frame(state,values,previous,1/fps,t);previous=values;if(i%fps===0)samples.push(r.output);}return samples;}
 const reference=run(120);for(const fps of[5,10,17,30,60]){const output=run(fps);assert.ok(Math.max(...output.map((v,i)=>Math.abs(v-reference[i])))<.035,`${fps} FPS changed the response`);}
});

test('suspension catch-up is bounded and a resumed first frame uses current input',()=>{
 const state=new Map(),r=frame(state,{Head:1},undefined,120,120);assert.equal(r.step.duration,.25);assert.equal(r.step.steps,15);assert.ok(Number.isFinite(r.output));
 for(const elapsed of[0,-1,NaN,Infinity]){const r=frame(new Map(),{Head:1},undefined,elapsed,0);assert.ok(r.step.dt>0&&r.step.dt<=1/60);assert.ok(Number.isFinite(r.output));}
});
