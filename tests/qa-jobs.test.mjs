import {test} from 'node:test';import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {runQaCheck} from '@standrig/core/qaCheck';
import {runServiceQa,qaWorkerCount} from '../apps/service/dist/qaRunner.js';
import {createLocalService} from '../apps/service/dist/service.js';
import {ModelingJobs} from '../apps/service/dist/modelingJobs.js';
const rig=JSON.parse(await readFile(new URL('../examples/sample.standrig.json',import.meta.url),'utf8'));
const qa={poseSamples:[{poseId:'custom-a',values:{ParamAngleZ:8}},{poseId:'neutral',values:{ParamAngleZ:2}},{poseId:'custom-b',values:{ParamAngleZ:-5}}],regions:['full','face'],width:96,height:96,physics:true,physicsSteps:2};
test('QA resource planning handles a single CPU, memory pressure, explicit caps and many cores',()=>{
 const GiB=1024**3;assert.equal(qaWorkerCount(1e6,10e6,20,{}, {cpus:1,memory:GiB}),1);
 assert.equal(qaWorkerCount(100e6,GiB,20,{}, {cpus:24,memory:GiB}),0);
 assert.equal(qaWorkerCount(1e6,1e6,20,{workers:3}, {cpus:24,memory:32*GiB}),3);
 assert.equal(qaWorkerCount(1e6,1e6,20,{}, {cpus:128,memory:32*GiB}),8);
 assert.equal(qaWorkerCount(100e6,1e6,3,{}, {cpus:24,memory:32*GiB}),1);
 assert.equal(qaWorkerCount(100e6,1e6,12,{}, {cpus:24,memory:32*GiB}),3);
});
test('worker QA preserves serial order, custom neutral, physics, failures and hashes',async()=>{
 const serial=await runQaCheck(structuredClone(rig),'.',qa),progress=[];
 const parallel=await runServiceQa(rig,'.',qa,{workers:2},p=>progress.push(p));
 assert.deepEqual({...parallel,cache:'miss'},{...serial,cache:'miss'});assert.equal(progress.at(-1).completed,3);assert.ok(progress[0].workers<=2);
 const abort=new AbortController();abort.abort();await assert.rejects(runServiceQa(rig,'.',qa,{},()=>{},abort.signal));
});
test('accepted modeling jobs expose progress, idempotency, CAS and responsive reads',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'standrig-jobs-'));let service;
 try{service=await createLocalService({dataDir:dir,port:0,qaWorkers:1});const call=async(route,method='GET',body,key)=>{const r=await fetch(service.url+route,{method,headers:{'content-type':'application/json',...(key?{'idempotency-key':key}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,...await r.json()};};
  const revision=(await call('/api/context')).context.revision,input={kind:'import',rig,expectedRevision:revision,qa,commit:true};
  const accepted=await call('/api/modeling/jobs','POST',input,'job-test');assert.equal(accepted.status,202);
  const repeat=await call('/api/modeling/jobs','POST',input,'job-test');assert.equal(repeat.job.id,accepted.job.id);
  assert.equal((await call('/api/modeling/jobs','POST',{...input,commit:false},'job-test')).status,409);
  assert.equal((await call('/api/rig')).status,200);assert.equal((await call('/api/playback')).status,200);
  let job;for(let i=0;i<200;i++){job=(await call('/api/modeling/jobs/'+accepted.job.id)).job;if(['completed','failed'].includes(job.status))break;await new Promise(r=>setTimeout(r,20));}
  assert.equal(job.status,'completed',JSON.stringify(job));assert.equal(job.result.committed,true);assert.notEqual(job.result.revisionAfter,revision);
  const stale=await call('/api/modeling/jobs','POST',input);let failure;for(let i=0;i<100;i++){failure=(await call('/api/modeling/jobs/'+stale.job.id)).job;if(failure.status==='failed')break;await new Promise(r=>setTimeout(r,10));}assert.equal(failure.error.status,409);
 }finally{await service?.close();await rm(dir,{recursive:true,force:true});}
});
test('job cancellation frees queued inputs, admission is bounded and atomic commits refuse cancellation',async()=>{
 const scheduled=[];let calls=0,hold=false,release,commits=0;
 const application={execute:async(_input,options)=>{calls++;options.progress({stage:'committing'});if(hold)await new Promise(r=>release=r);return {committed:hold};}};
 const schedule=run=>new Promise((resolve,reject)=>scheduled.push(async()=>{try{resolve(await run());}catch(error){reject(error);}}));
 const jobs=new ModelingJobs(application,schedule,async()=>{commits++;});
 const cancelled=jobs.submit({large:'owned input'});jobs.cancel(cancelled.id);await scheduled.shift()();assert.equal(calls,0);assert.equal(jobs.get(cancelled.id).status,'cancelled');
 const admitted=[0,1,2].map(i=>jobs.submit({i}));assert.equal(jobs.capacity(),false);assert.throws(()=>jobs.submit({i:3}),/queue is full/);
 jobs.cancel(admitted[1].id);assert.equal(jobs.capacity(),true);while(scheduled.length)await scheduled.shift()();assert.equal(calls,2);
 hold=true;const job=jobs.submit({atomic:true});const running=scheduled.shift()();await Promise.resolve();assert.throws(()=>jobs.cancel(job.id),/Atomic commit/);release();await running;await Promise.resolve();assert.equal(jobs.get(job.id).status,'completed');assert.equal(commits,1);jobs.close();
});
