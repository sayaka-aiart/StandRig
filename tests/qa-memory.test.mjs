import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtemp,rm,readdir} from 'node:fs/promises';
import {once} from 'node:events';
import path from 'node:path';
import os from 'node:os';
import {reserveQaMemory} from '../apps/service/dist/qaMemory.js';
import {qaWorkerCount,qaWorkerMemory} from '../apps/service/dist/qaRunner.js';

function launch(settings) {
 const child=fork(new URL('./fixtures/qa-memory-child.mjs',import.meta.url),[],{env:{...process.env,STANDRIG_QA_TEST:JSON.stringify(settings)},stdio:['ignore','ignore','pipe','ipc']});
 const messages=[];let stderr='';child.stderr.on('data',data=>stderr+=data);child.on('message',message=>messages.push(message));
 return {child,messages,async wait(kind){const deadline=Date.now()+10000;while(!messages.some(m=>m.kind===kind)){if(Date.now()>deadline)throw Error(`Waiting for ${kind}: ${JSON.stringify(messages)} ${stderr}`);await new Promise(r=>setTimeout(r,15));}return messages.find(m=>m.kind===kind);}};
}
test('memory estimate covers observed overhead and explicit 6000MiB keeps reserved worker bytes within budget',()=>{
 const MiB=1048576,model=83.3e6,texture=130*MiB,estimate=qaWorkerMemory(model,texture);
 assert.ok(estimate>1.7*1024**3);
 const count=qaWorkerCount(model,texture,128,{memoryMiB:6000},{cpus:24,memory:32*1024**3});assert.ok(count*estimate<=6000*MiB);assert.ok(count<6);
});
test('separate QA processes share reservations, cancellation does not leak, crashed owners are reclaimed',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'standrig-qa-memory-test-')),children=[];
 const listener=createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');const port=listener.address().port;await new Promise(r=>listener.close(r));
 const settings={directory,port,available:1000,perWorker:200,maximum:2};
 try {
  const a=launch(settings);children.push(a);assert.equal((await a.wait('acquired')).workers,2);
  const b=launch(settings);children.push(b);await b.wait('waiting');assert.equal(b.messages.some(m=>m.kind==='acquired'),false);
  const cancelled=once(b.child,'exit');b.child.send('abort');assert.match((await b.wait('error')).error,/AbortError/);await cancelled;
  const c=launch(settings);children.push(c);await c.wait('waiting');a.child.send('release');assert.equal((await c.wait('acquired')).workers,2);await a.wait('released');
  const dead=once(c.child,'exit');c.child.kill();await dead;
  const d=launch(settings);children.push(d);assert.equal((await d.wait('acquired')).workers,2);d.child.send('release');await d.wait('released');
  assert.equal((await readdir(directory)).filter(f=>f.endsWith('.json')).length,0);
  await assert.rejects(reserveQaMemory(501,1,undefined,()=>{},{directory,port,available:()=>1000}),/too small/);
 } finally {
  for(const {child} of children)if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill();await exited;}
  if(path.dirname(directory)!==path.resolve(os.tmpdir())||!path.basename(directory).startsWith('standrig-qa-memory-test-'))throw Error('Unsafe test cleanup');
  await rm(directory,{recursive:true,force:true});
 }
});
