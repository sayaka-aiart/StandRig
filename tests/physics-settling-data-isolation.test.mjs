import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runPhysicsSettlingQa} from '../packages/core/dist/physicsSettlingQa.js';
const sample=JSON.parse(await readFile(new URL('../examples/sample.standrig.json',import.meta.url)));
const freeze=value=>{if(value&&typeof value==='object'&&!Object.isFrozen(value)){Object.freeze(value);for(const child of Object.values(value))freeze(child);}return value;};
test('settling does not traverse unrelated artwork or mutate shared model/chain data',()=>{
 const rig=structuredClone(sample);
 rig.parameters.push({id:'PhysA',label:'A',min:-1,max:1,default:0},{id:'PhysB',label:'B',min:-1,max:1,default:0});
 const chain=(id,gravity,wind)=>({id,name:id,enabled:true,targetPartIds:[],sourceParameters:[{parameter:'ParamAngleX',scale:.015}],stiffness:40,damping:8,mass:1,gravity,wind,output:{property:'rotation',scale:1},parameterOutput:{parameter:id,scale:1,min:-1,max:1},segments:[{id:'root',length:1,delay:.03,damping:1},{id:'tip',length:1.2,delay:.08,damping:1}]});
 rig.physics={enabled:true,chains:[chain('PhysA',.1,.05),chain('PhysB',-.2,0)]};
 const baseline=structuredClone(rig),before=JSON.stringify(rig);freeze(rig);
 const withoutArtwork={...rig,assets:[{id:'unread-art',get src(){throw Error('Artwork must not be read/cloned by settling QA');}}]};
 for(const releaseExternalForces of [false,true]){
  const expected=runPhysicsSettlingQa(baseline,{releaseExternalForces});
  assert.deepEqual(runPhysicsSettlingQa(withoutArtwork,{releaseExternalForces}),expected);
  assert.deepEqual(runPhysicsSettlingQa(rig,{releaseExternalForces}),expected);
 }
 assert.equal(JSON.stringify(rig),before);
});
