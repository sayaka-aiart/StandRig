import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
const source=await readFile(new URL('../apps/preview/src/poseInput.ts',import.meta.url),'utf8');
const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const {PoseInput}=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
const tick=()=>new Promise(r=>setImmediate(r));
test('slow requests coalesce newest values across parameters and retain optimistic pose',async()=>{
 const requests=[],replies=[];const queue=new PoseInput(p=>new Promise(resolve=>requests.push({p,resolve})),r=>replies.push(r),assert.fail);
 queue.enqueue({x:1});for(let i=2;i<=100;i++)queue.enqueue({x:i});queue.enqueue({y:5});
 assert.equal(requests.length,1);assert.deepEqual(queue.optimistic,{x:100,y:5});
 requests[0].resolve(1);await tick();assert.equal(requests.length,2);assert.deepEqual(requests[1].p,{x:100,y:5});
 requests[1].resolve(2);await tick();assert.deepEqual(queue.optimistic,{});assert.deepEqual(replies,[1,2]);
});
test('failed requests do not replay and old model replies are discarded',async()=>{
 const requests=[],replies=[],errors=[];const queue=new PoseInput(p=>new Promise((resolve,reject)=>requests.push({p,resolve,reject})),r=>replies.push(r),e=>errors.push(e));
 queue.enqueue({x:1});queue.enqueue({x:2});requests[0].reject('offline');await tick();
 assert.deepEqual(errors,['offline']);assert.deepEqual(requests[1].p,{x:2});
 queue.reset();queue.enqueue({z:3});requests[1].resolve('old');await tick();assert.deepEqual(replies,[]);assert.deepEqual(queue.optimistic,{z:3});
 requests[2].resolve('new');await tick();assert.deepEqual(replies,['new']);assert.deepEqual(queue.optimistic,{});
});
