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
 requests[0].resolve(1);await tick();assert.equal(requests.length,2);assert.deepEqual(requests[1].p,{values:{x:100,y:5},clearViseme:false});
 requests[1].resolve(2);await tick();assert.deepEqual(queue.optimistic,{});assert.deepEqual(replies,[1,2]);
});
test('failed requests do not replay and old model replies are discarded',async()=>{
 const requests=[],replies=[],errors=[];const queue=new PoseInput(p=>new Promise((resolve,reject)=>requests.push({p,resolve,reject})),r=>replies.push(r),e=>errors.push(e));
 queue.enqueue({x:1});queue.enqueue({x:2});requests[0].reject('offline');await tick();
 assert.deepEqual(errors,['offline']);assert.deepEqual(requests[1].p,{values:{x:2},clearViseme:false});
 queue.reset();queue.enqueue({z:3});requests[1].resolve('old');await tick();assert.deepEqual(replies,[]);assert.deepEqual(queue.optimistic,{z:3});
 requests[2].resolve('new');await tick();assert.deepEqual(replies,['new']);assert.deepEqual(queue.optimistic,{});
});

test('rapid vowel clicks keep the newest selection and preserve their order relative to dragging', async () => {
 const requests = [];
 const queue = new PoseInput(input => new Promise(resolve => requests.push({ input, resolve })), () => {}, assert.fail);
 queue.enqueueViseme('A');
 queue.enqueueViseme('I');
 queue.enqueueViseme('U');
 queue.enqueue({ mouth: 0.2 }, true);
 queue.enqueue({ mouth: 0.4, form: -0.5 }, true);
 queue.enqueueViseme('E');
 assert.deepEqual(queue.optimistic, { mouth: 0.4, form: -0.5 });
 const expected = [{ id: 'A' }, { id: 'U' }, { values: { mouth: 0.4, form: -0.5 }, clearViseme: true }, { id: 'E' }];
 for (let i = 0; i < expected.length; i++) {
   assert.deepEqual(requests[i]?.input, expected[i]);
   requests[i].resolve();
   await tick();
 }
 assert.equal(requests.length, expected.length);
 assert.deepEqual(queue.optimistic, {});
});
