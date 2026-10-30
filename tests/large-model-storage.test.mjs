import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {writeJsonFile} from '../apps/service/dist/application/modelingSupport.js';
test('large model persistence stays compact and retains every value',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'standrig-storage-'));
 try{
  const file=path.join(directory,'rig.json'),value={data:Array.from({length:512},()=>({key:'x'.repeat(16384),offsets:[1,2,3]}))};
  await writeJsonFile(file,value);const saved=await readFile(file,'utf8');
  assert.equal(saved,JSON.stringify(value)+'\n');assert.deepEqual(JSON.parse(saved),value);
  await writeJsonFile(file,{small:true});assert.deepEqual(JSON.parse(await readFile(file,'utf8')),{small:true});
 }finally{await rm(directory,{recursive:true,force:true});}
});
