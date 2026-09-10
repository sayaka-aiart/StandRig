import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import * as z from 'zod';
import {operationSchema,actionSchema,actionSchemas,READ_ONLY_BODY_ROUTES} from '@standrig/contracts';
import {createLocalService} from '../apps/service/dist/service.js';
import {fullRigRevision} from '../apps/service/dist/rigApiPlugin.js';
const sample=JSON.parse(await readFile(new URL('../examples/sample.standrig.json',import.meta.url),'utf8'));
const qa={poses:['neutral'],regions:['full'],width:240,height:240,physics:false};
const move={id:'move',name:'Move body',target:{partIds:['body']},action:{type:'transform',property:'x',operator:'add',value:2}};
async function files(root){const map={};async function walk(dir){for(const entry of await readdir(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory())await walk(file);else map[path.relative(root,file)]=createHash('sha256').update(await readFile(file)).digest('hex');}}await walk(root);return map;}
async function harness(run,options={}){const dir=await mkdtemp(path.join(os.tmpdir(),'standrig-write-contract-'));let service;try{service=await createLocalService({dataDir:dir,port:0,...options});const call=async(route,method='GET',body)=>{const r=await fetch(service.url+route,{method,headers:body?{'content-type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});return{status:r.status,data:await r.json()};};await run(call,dir);}finally{await service?.close();assert.equal(path.dirname(dir),path.resolve(os.tmpdir()));await rm(dir,{recursive:true,force:true});}}

test('revisions use SHA-256 across the full model document',()=>{
 assert.equal(fullRigRevision(sample),'rig-sha256-'+createHash('sha256').update(JSON.stringify(sample)).digest('hex'));
 for(const change of [r=>r.name+=' changed',r=>r.assets[0].src+='x',r=>r.parts[0].visible=!r.parts[0].visible]){const rig=structuredClone(sample);change(rig);assert.notEqual(fullRigRevision(rig),fullRigRevision(sample));}
});

test('every legacy write route is denied by default without filesystem changes',()=>harness(async(call,dir)=>{
 const before=await files(dir);
 const inventory=JSON.parse(await readFile(new URL('../docs/api-routes.json',import.meta.url),'utf8'));
 for(const route of inventory.routes.filter(r=>!['/api/modeling/transaction'].includes(r)&&!r.startsWith('/api/playback')&&!r.startsWith('/api/checkpoints')&&!r.startsWith('/api/exports')&&r!=='/api/sample')){
  for(const method of ['POST','PUT','PATCH','DELETE']){
   if(method==='POST'&&READ_ONLY_BODY_ROUTES.has(route))continue;
   const result=await call(route,method,{...sample,commit:true,dryRun:false,action:'register',name:'probe',values:{ParamAngleX:10}});
   assert.equal(result.status,403,route+' '+method);assert.equal(result.data.error,'legacy_write_api_disabled');
  }
 }
 assert.deepEqual(await files(dir),before);
 const rev=(await call('/api/context')).data.context.revision;
 for(const body of [{operations:[move],qa,commit:true},{operations:[move],expectedRevision:rev,commit:true},{operations:[{...move,action:{...move.action,typo:1}}],expectedRevision:rev,qa,commit:true}])assert.equal((await call('/api/modeling/transaction','POST',body)).status,400);
 assert.equal((await call('/api/modeling/transaction/invalid','POST',{expectedRevision:rev,qa,operations:[move],commit:true})).status,404);
 assert.deepEqual(await files(dir),before);
}));

test('import, edits and restore share CAS, server checkpoints and isolated journal',()=>harness(async(call,dir)=>{
 const blank=(await call('/api/context')).data.context.revision;
 const initial=await files(dir);
 const draft={kind:'import',rig:sample,expectedRevision:blank,qa,commit:false};
 assert.equal((await call('/api/modeling/transaction','POST',draft)).data.committed,false);
 assert.deepEqual(await files(dir),initial);
 const imported=await call('/api/modeling/transaction','POST',{...draft,commit:true});
 assert.equal(imported.data.committed,true,JSON.stringify(imported));assert.ok(imported.data.rollbackCheckpoint.id);
 const revision=imported.data.revisionAfter;
 const input={operations:[move],expectedRevision:revision,qa,commit:true};
 const results=await Promise.all([call('/api/modeling/transaction','POST',input),call('/api/modeling/transaction','POST',input)]);
 assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
 const committed=results.find(r=>r.status===200).data;
 assert.ok(committed.rollbackCheckpoint.id);
 const history=(await call('/api/changes?since='+revision)).data;
 assert.equal(history.transactions.length,1);
 const beforeFailure=await files(dir);
 assert.equal((await call('/api/modeling/transaction','POST',{...input,expectedRevision:committed.revisionAfter,operations:[{...move,action:{type:'part-visibility',visible:false},target:{partIds:sample.parts.map(p=>p.id)}}]})).status,422);
 assert.deepEqual(await files(dir),beforeFailure);
 const restored=await call('/api/checkpoints/restore','POST',{id:committed.rollbackCheckpoint.id,expectedRevision:committed.revisionAfter});
 assert.equal(restored.status,200,JSON.stringify(restored));assert.equal(restored.data.revision,revision);
 const cleared=await call('/api/modeling/transaction','POST',{kind:'restore',checkpointId:imported.data.rollbackCheckpoint.id,expectedRevision:revision,commit:true});
 assert.equal(cleared.status,200);assert.equal(cleared.data.revisionAfter,blank);
 await harness(async(other)=>{assert.equal((await other('/api/context')).data.context.operationHistory.entries.length,0);assert.equal((await other('/api/changes?since='+revision)).data.resyncRequired,true);});
}));

test('legacy writes need an explicit server-side opt-in',()=>harness(async(call)=>{
 assert.equal((await call('/api/rig','POST',sample)).status,200);
},{allowLegacyWrites:true}));

test('all 33 operation variants are strict, including nested payloads',()=>{
 const schema=z.toJSONSchema(operationSchema);
 const variants=schema.properties.action.oneOf;
 assert.equal(variants.length,33);
 function fixture(s){if(Array.isArray(s.type))return fixture({...s,type:s.type[0]});if('const'in s)return s.const;if(s.anyOf)return fixture(s.anyOf[0]);if(s.type==='string')return 'fixture';if(s.type==='number')return 0;if(s.type==='boolean')return false;if(s.type==='null')return null;if(s.type==='array')return s.prefixItems?s.prefixItems.map(fixture):[];if(s.type==='object')return Object.fromEntries((s.required??[]).map(k=>[k,fixture(s.properties[k])]));return {};}
 function unknowns(s,value){if(value===null||typeof value!=='object')return;if(s.anyOf){unknowns(s.anyOf.find(v=>v.const===value||v.type===typeof value)||s.anyOf[0],value);return;}if(s.type==='object'&&s.additionalProperties===false){value.__unknown=true;}}
 for(const variant of variants){
  const operation={id:'op',name:'operation',target:{},action:fixture(variant)};
  assert.equal(operationSchema.safeParse(operation).success,true,variant.properties.type.const);
  assert.equal(operationSchema.safeParse({...operation,extra:true}).success,false);
  assert.equal(operationSchema.safeParse({...operation,target:{unknown:true}}).success,false);
  assert.equal(operationSchema.safeParse({...operation,action:{...operation.action,typo:true}}).success,false);
  for(const key of variant.required??[]){const bad=structuredClone(operation);delete bad.action[key];assert.equal(operationSchema.safeParse(bad).success,false,variant.properties.type.const+':'+key);}
  for(const [key,prop]of Object.entries(variant.properties)){if(key==='type')continue;const bad=structuredClone(operation);bad.action[key]=fixture(prop);unknowns(prop,bad.action[key]);if(bad.action[key]&&typeof bad.action[key]==='object'&&bad.action[key].__unknown)assert.equal(operationSchema.safeParse(bad).success,false);}
 }
 assert.equal(operationSchema.safeParse({...move,action:{...move.action,value:Infinity}}).success,false);
});


test('discriminator selects the action and reports its invalid field directly',()=>{
 assert.ok(actionSchema instanceof z.ZodDiscriminatedUnion);
 const advertised=z.toJSONSchema(actionSchema).oneOf.map(s=>s.properties.type.const);
 assert.deepEqual([...advertised].sort(),Object.keys(actionSchemas).sort());
 const invalid=operationSchema.safeParse({id:'bad',name:'bad',target:{},action:{type:'artmesh-generate',preset:'face-feature',columns:'five',rows:5}});
 assert.equal(invalid.success,false);
 assert.deepEqual(invalid.error.issues.map(i=>({code:i.code,path:i.path})),[{code:'invalid_type',path:['action','columns']}]);
 assert.equal(actionSchema.safeParse({type:'warp-create',divisionX:'five'}).success,false);
});
