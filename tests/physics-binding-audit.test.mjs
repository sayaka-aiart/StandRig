import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {auditModelingRig} from '@standrig/core/modelingAudit';
import {createRectArtMesh} from '@standrig/core/artMesh';
import {auditPhysicsSafety} from '@standrig/core/physicsSafety';
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

test('affine physics bindings are traced to their actual cloth or structural target',()=>{
 const rig=structuredClone(sample),p=rig.parts.find(p=>p.kind==='image');
 rig.parameters.push({id:'PhysAffine',label:'Test',min:-1,max:1,default:0});
 rig.physics={enabled:true,chains:[{id:'affine-spring',name:'spring',enabled:true,targetPartIds:[],sourceParameters:[{parameter:'ParamAngleX',scale:.01}],stiffness:40,damping:8,mass:1,gravity:0,wind:0,output:{property:'rotation',scale:1},parameterOutput:{parameter:'PhysAffine',scale:1}}]};
 p.role='clothing';p.roleStatus='confirmed';p.affineBindings=[{parameters:['PhysAffine','ParamAngleX'],keyforms:[-1,1].flatMap(a=>[-30,30].map(b=>({inputs:{PhysAffine:a,ParamAngleX:b},matrix:{a:1,b:0,c:0,d:1,e:a*2,f:0}})))}];
 assert.equal(auditModelingRig(rig).issues.some(i=>i.id==='physics-output-unbound-PhysAffine'),false);
 const safe=auditPhysicsSafety(rig);assert.equal(safe.pass,true);assert.equal(safe.chains[0].targets.some(t=>t.partId===p.id&&t.parameter==='PhysAffine'),true);
 p.role='face';const unsafe=auditPhysicsSafety(rig);assert.equal(unsafe.pass,false);assert.equal(unsafe.rootLock.violations.some(t=>t.partId===p.id&&t.parameter==='PhysAffine'),true);
});

test('physics output may follow through on eyes and brows but never on face, mouth or face-feature parts',()=>{
 const rig=structuredClone(sample),p=rig.parts.find(p=>p.kind==='image');
 rig.parameters.push({id:'PhysEye',label:'Test',min:-1,max:1,default:0});
 rig.physics={enabled:true,chains:[{id:'eye-spring',name:'spring',enabled:true,targetPartIds:[],sourceParameters:[{parameter:'ParamAngleX',scale:.01}],stiffness:40,damping:8,mass:1,gravity:0,wind:0,output:{property:'rotation',scale:1},parameterOutput:{parameter:'PhysEye',scale:1,min:-1,max:1}}]};
 p.roleStatus='confirmed';p.artMesh=createRectArtMesh(10,10,{preset:'hair-root',columns:1,rows:1});
 p.artMesh.bindings=[{parameter:'PhysEye',keys:[{input:0,offsets:[]},{input:1,offsets:[{vertexId:'v-1-1',x:1,y:0}]}]}];
 const target=()=>auditPhysicsSafety(rig).chains[0].targets.find(t=>t.partId===p.id);
 for(const role of ['eye-left','eye-right','brow-left','brow-right']){p.role=role;assert.equal(target().allowed,true,role);assert.equal(auditPhysicsSafety(rig).rootLock.violations.some(t=>t.partId===p.id),false,role);}
 for(const role of ['face','mouth','face-feature']){p.role=role;assert.equal(target().allowed,false,role);assert.equal(auditPhysicsSafety(rig).pass,false,role);}
 p.role='eye-left';p.roleStatus='suggested';assert.equal(target().allowed,false);
});
