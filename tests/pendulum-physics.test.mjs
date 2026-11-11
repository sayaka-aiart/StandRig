import {test} from 'node:test';
import assert from 'node:assert/strict';
import {evaluatePendulumPhysics,normalizeParameter,pendulumPhysicsIssues} from '@standrig/core/pendulumPhysics';
import {resolveRigFrame,identityMatrix} from '@standrig/core/evaluator';
import {validateRig} from '@standrig/core/inspect';

const near=(a,b,eps=1e-6)=>assert.ok(Math.abs(a-b)<=eps,`${a} != ${b}`);
const ranges=new Map([['AngleX',{min:-30,max:30,default:0}],['ParamAngleX',{min:-30,max:30,default:0}],['BodyX',{min:-10,max:10,default:0}],['Hair',{min:-1,max:1,default:0}],['Hair2',{min:-1,max:1,default:0}]]);
const norm={position:{minimum:-10,default:0,maximum:10},angle:{minimum:-57.3,default:0,maximum:57.3}};
// A tracking smoother: head angle in, heavily damped pendulum, angle out.
const smoother={id:'smooth',inputs:[{parameter:'AngleX',type:'angle',weight:100}],outputs:[{parameter:'ParamAngleX',vertexIndex:1,type:'angle',scale:28,weight:100}],
 particles:[{mobility:1,delay:1,acceleration:1,radius:0},{mobility:0.01,delay:10,acceleration:10,radius:10}],normalization:norm};
const hair={id:'hair',inputs:[{parameter:'BodyX',type:'x',weight:100}],outputs:[{parameter:'Hair',vertexIndex:1,type:'angle',scale:1,weight:100}],
 particles:[{mobility:1,delay:1,acceleration:1,radius:0},{mobility:0.95,delay:0.9,acceleration:1.5,radius:15},{mobility:0.95,delay:0.8,acceleration:1.5,radius:15}],normalization:norm};

test('inputs normalize around the middle of the parameter range, negated unless reflected',()=>{
 near(normalizeParameter(30,-30,30,norm.angle,false),-57.3);
 near(normalizeParameter(30,-30,30,norm.angle,true),57.3);
 near(normalizeParameter(-15,-30,30,norm.angle,true),-28.65);
 near(normalizeParameter(99,-30,30,norm.angle,true),57.3);          // clamped to the parameter range
 near(normalizeParameter(5,0,10,{minimum:-4,default:1,maximum:2},true),1); // middle maps to the default
});

test('a fresh evaluation starts settled: an angle input tilts gravity and the output reads the swing angle',()=>{
 const physics={fps:60,settings:[smoother]};
 // 57.3 degrees of tilt is one radian; times scale 28.
 near(evaluatePendulumPhysics(physics,ranges,{AngleX:30},0,undefined).outputs.ParamAngleX,57.3*Math.PI/180*28,1e-3);
 near(evaluatePendulumPhysics(physics,ranges,{AngleX:0},0,undefined).outputs.ParamAngleX,0);
 near(evaluatePendulumPhysics(physics,ranges,{AngleX:-15},0,undefined).outputs.ParamAngleX,-14.0,1e-2);
});

test('the output follows a step in its input with lag, then settles',()=>{
 const physics={fps:60,settings:[smoother]};
 let {state}=evaluatePendulumPhysics(physics,ranges,{AngleX:0},0,undefined);
 const trace=[];
 for(let frame=0;frame<240;frame++){const r=evaluatePendulumPhysics(physics,ranges,{AngleX:30},1/60,state);state=r.state;trace.push(r.outputs.ParamAngleX);}
 assert.ok(trace[0]<5,`first frame ${trace[0]} should lag`);
 assert.ok(trace[30]>trace[5]&&trace[30]<28.1);
 near(trace.at(-1),28,0.05);
});

test('a translation input swings the strand and the swing decays back to rest',()=>{
 const physics={fps:60,settings:[hair]};
 let {state}=evaluatePendulumPhysics(physics,ranges,{BodyX:0},0,undefined);
 const trace=[];
 for(let frame=0;frame<600;frame++){const r=evaluatePendulumPhysics(physics,ranges,{BodyX:frame<30?10:0},1/60,state);state=r.state;trace.push(r.outputs.Hair);}
 const peak=Math.max(...trace.map(Math.abs));
 assert.ok(peak>0.05,`swing ${peak}`);
 assert.ok(Math.abs(trace.at(-1))<peak*0.05,`still swinging ${trace.at(-1)}`);
 assert.ok(trace.every(Number.isFinite));
});

test('later settings read earlier outputs in the same step; weights blend; reflect flips',()=>{
 const second={...smoother,id:'second',inputs:[{parameter:'ParamAngleX',type:'angle',weight:100}],outputs:[{parameter:'Hair2',vertexIndex:1,type:'angle',scale:1,weight:50,reflect:true}]};
 const physics={fps:60,settings:[smoother,second]};
 const {outputs}=evaluatePendulumPhysics(physics,ranges,{AngleX:30,Hair2:0.2},0,undefined);
 near(outputs.ParamAngleX,57.3*Math.PI/180*28,1e-6);
 // ParamAngleX 28 of 30 tilts the second strand by 28/30 of 57.3 degrees; reflected, half weight against 0.2.
 const expected=Math.max(-1,Math.min(1,-(28/30)*57.3*Math.PI/180));
 near(outputs.Hair2,0.2*0.5+expected*0.5,2e-3);
});

test('the rig frame applies pendulum outputs on top of the incoming values',()=>{
 const rig={schemaVersion:'0.1.0',name:'p',stage:{width:10,height:10},assets:[],parts:[],deformers:[],
  parameters:[...ranges].map(([id,r])=>({id,label:id,...r})),physics:{enabled:true,chains:[],pendulum:{fps:60,settings:[smoother]}}};
 const frame=resolveRigFrame(rig,{AngleX:30,ParamAngleX:-5},identityMatrix(),{physicsSteps:18,physicsDt:1/60});
 near(frame.values.ParamAngleX,57.3*Math.PI/180*28,1e-6);
 assert.equal(frame.values.AngleX,30);
 assert.deepEqual(validateRig(rig).issues.filter(i=>i.code==='invalid-pendulum-physics'),[]);
 assert.ok(pendulumPhysicsIssues({settings:[{...smoother,outputs:[{...smoother.outputs[0],vertexIndex:5}]}]},new Set(ranges.keys())).length);
});

test('the strands live in the physics state map: a caller may copy the map each frame and keep the old copy to roll back',async()=>{
 const {PENDULUM_STATE_KEY}=await import('@standrig/core/evaluator');
 const rig={schemaVersion:'0.1.0',name:'p',stage:{width:10,height:10},assets:[],parts:[],deformers:[],
  parameters:[...ranges].map(([id,r])=>({id,label:id,...r})),physics:{enabled:true,chains:[],pendulum:{fps:60,settings:[hair]}}};
 // Connect copies the state entry by entry before every frame so a failed frame can be dropped.
 const copyState=(state)=>new Map([...state].map(([key,value])=>[key,{...value}]));
 const run=(copy)=>{
  let state=new Map();const trace=[];
  for(let frame=0;frame<90;frame++){
   const next=copy?copyState(state):state;
   if(copy&&frame===40){
    const kept=JSON.stringify(state.get(PENDULUM_STATE_KEY).pendulum);
    resolveRigFrame(rig,{BodyX:0},identityMatrix(),{physicsState:copyState(state),physicsTime:frame/60,physicsDt:1/60});
    assert.equal(JSON.stringify(state.get(PENDULUM_STATE_KEY).pendulum),kept,'evaluating a copy must leave the kept state as it was');
   }
   trace.push(resolveRigFrame(rig,{BodyX:frame<20?10:0},identityMatrix(),{physicsState:next,physicsTime:frame/60,physicsDt:1/60}).values.Hair);
   state=next;
  }
  return trace;
 };
 const copied=run(true);
 assert.deepEqual(copied,run(false));
 assert.ok(Math.max(...copied.map(Math.abs))>0.05,'the strand must keep swinging across copied frames');
});
