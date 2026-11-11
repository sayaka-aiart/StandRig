import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDefaultTracking,applyTrackingInput} from '@standrig/core/tracking';
import {resolveRigFrame,identityMatrix} from '@standrig/core/evaluator';

const near=(a,b,eps=1e-6)=>assert.ok(Math.abs(a-b)<=eps,`${a} != ${b}`);
const norm={position:{minimum:-10,default:0,maximum:10},angle:{minimum:-57.3,default:0,maximum:57.3}};
const particles=[{mobility:1,delay:1,acceleration:1,radius:0},{mobility:0.01,delay:10,acceleration:10,radius:10}];
/** A smoother: tracker input in, the standard angle overwritten (weight 100) or blended. */
const smoother=(inputs,output,weight=100)=>({id:`smooth-${output}`,inputs:inputs.map(([parameter,inputWeight=100,reflect=false])=>({parameter,type:'angle',weight:inputWeight,reflect})),
 outputs:[{parameter:output,vertexIndex:1,type:'angle',scale:28,weight}],particles,normalization:norm});
const parameter=(id,min=-30,max=30)=>({id,label:id,min,max,default:0});
const rigWith=(parameters,settings,enabled=true)=>({schemaVersion:'0.1.0',name:'t',stage:{width:10,height:10},assets:[],parts:[],deformers:[],
 parameters,physics:{enabled,chains:[],pendulum:{fps:60,settings}}});
const mapping=(rig,source)=>createDefaultTracking(rig).mappings.find((entry)=>entry.source===source);
/** Tracking input -> parameters -> settled pendulum, as a frame shows it. */
const settledAfterTracking=(rig,inputs)=>{
 const tracked={...rig,tracking:{...createDefaultTracking(rig),enabled:true}};
 const values=applyTrackingInput(tracked,{},inputs,{smoothing:false});
 return resolveRigFrame(tracked,values,identityMatrix(),{physicsSteps:18,physicsDt:1/60}).values;
};

test('defaults write the input of a pendulum that overwrites the standard angle, and the alternate mouth name',()=>{
 const rig=rigWith([parameter('ParamAngleX'),parameter('AngleX'),parameter('ParamMouthOpenY',0,1)],[smoother([['AngleX']],'ParamAngleX')]);
 const yaw=mapping(rig,'faceYaw');
 assert.deepEqual([yaw.parameter,yaw.scale,yaw.offset,yaw.min,yaw.max,yaw.invert],['AngleX',36,0,-30,30,false]);
 assert.equal(mapping(rig,'mouthOpen').parameter,'ParamMouthOpenY');
 // faceYaw 0.5 -> AngleX 18 -> the smoother settles ParamAngleX at 18/30 of 57.3 degrees, in radians, times 28.
 const values=settledAfterTracking(rig,{faceYaw:0.5,mouthOpen:0.8});
 near(values.AngleX,18);
 near(values.ParamAngleX,(18/30)*57.3*Math.PI/180*28,1e-9);
 near(values.ParamMouthOpenY,0.8);
});

test('a mirroring pendulum inverts the mapping, and another input range rescales it',()=>{
 const mirrored=rigWith([parameter('ParamAngleX'),parameter('AngleX')],[smoother([['AngleX',100,true]],'ParamAngleX')]);
 assert.equal(mapping(mirrored,'faceYaw').invert,true);
 assert.ok(settledAfterTracking(mirrored,{faceYaw:0.5}).ParamAngleX>16,'the head still turns the way the face turns');
 const narrow=rigWith([parameter('ParamAngleX'),parameter('AngleX',-10,10)],[smoother([['AngleX']],'ParamAngleX')]);
 const yaw=mapping(narrow,'faceYaw');
 assert.deepEqual([yaw.parameter,yaw.scale,yaw.offset,yaw.min,yaw.max],['AngleX',12,0,-10,10]);
});

test('each input feeds one default; the largest weight goes first',()=>{
 const rig=rigWith([parameter('ParamAngleX'),parameter('ParamAngleY'),parameter('Shared'),parameter('Other')],
  [smoother([['Shared']],'ParamAngleX'),smoother([['Other',40],['Shared',60]],'ParamAngleY')]);
 assert.equal(mapping(rig,'faceYaw').parameter,'Shared');
 assert.equal(mapping(rig,'facePitch').parameter,'Other');
});

test('defaults stay as they were without an overwriting pendulum',()=>{
 const plain={...rigWith([parameter('ParamAngleX'),parameter('AngleX'),parameter('ParamMouthOpen',0,1),parameter('ParamMouthOpenY',0,1)],[]),physics:{enabled:true,chains:[]}};
 const expected=createDefaultTracking({...plain,parameters:[]}).mappings.map(({source,parameter,scale,offset,min,max,invert})=>({source,parameter,scale,offset,min,max,invert}));
 const strip=(rig)=>createDefaultTracking(rig).mappings.map(({source,parameter,scale,offset,min,max,invert})=>({source,parameter,scale,offset,min,max,invert}));
 assert.deepEqual(strip(plain),expected,'a rig with ParamMouthOpen keeps it');
 assert.equal(mapping(plain,'faceYaw').parameter,'ParamAngleX');
 const cases={
  blending:rigWith([parameter('ParamAngleX'),parameter('AngleX')],[smoother([['AngleX']],'ParamAngleX',50)]),
  physicsOff:rigWith([parameter('ParamAngleX'),parameter('AngleX')],[smoother([['AngleX']],'ParamAngleX')],false),
  chainedInput:rigWith([parameter('ParamAngleX'),parameter('AngleX'),parameter('Raw')],[smoother([['Raw']],'AngleX'),smoother([['AngleX']],'ParamAngleX')]),
  selfSmoothing:rigWith([parameter('ParamAngleX')],[smoother([['ParamAngleX']],'ParamAngleX')])
 };
 for(const [name,rig] of Object.entries(cases))assert.equal(mapping(rig,'faceYaw').parameter,'ParamAngleX',name);
});
