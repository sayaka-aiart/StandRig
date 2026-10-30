import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {auditModelingRig} from '@standrig/core/modelingAudit';
import {createRectArtMesh} from '@standrig/core/artMesh';
const sample=JSON.parse(await readFile(new URL('../examples/sample.standrig.json',import.meta.url)));
test('physics audit recognizes mesh single/multi keys while retaining actual unbound-output errors',()=>{
 const rig=structuredClone(sample),p=rig.parts.find(p=>p.kind==='image');
 rig.parameters.push({id:'PhysAudit',label:'Test',min:-1,max:1,default:0});
 rig.physics={enabled:true,chains:[{id:'spring',name:'spring',enabled:true,targetPartIds:[],sourceParameters:[{parameter:'ParamAngleX',scale:.01}],stiffness:40,damping:8,mass:1,gravity:0,wind:0,output:{property:'rotation',scale:1},parameterOutput:{parameter:'PhysAudit',scale:1}}]};
 const unbound=()=>auditModelingRig(rig).issues.some(i=>i.id==='physics-output-unbound-PhysAudit');
 assert.equal(unbound(),true);
 p.artMesh=createRectArtMesh(10,10,{preset:'hair-root',columns:1,rows:1});
 p.artMesh.bindings=[{parameter:'PhysAudit',keys:[{input:0,offsets:[]},{input:1,offsets:[{vertexId:'v-1-1',x:1,y:0}]}]}];
 assert.equal(unbound(),false);
 p.artMesh.bindings=[];p.artMesh.multiBindings=[{parameters:['PhysAudit','ParamAngleX'],keyforms:[{inputs:{PhysAudit:1,ParamAngleX:0},offsets:[{vertexId:'v-1-1',x:1,y:0}]}]}];
 assert.equal(unbound(),false);p.artMesh.enabled=false;assert.equal(unbound(),true);
});
