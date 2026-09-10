import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLocalService } from '../apps/service/dist/service.js';
import { CubismBridge } from '../apps/service/dist/application/cubismBridge.js';
import { bridgeReadSchema, bridgePoseSchema } from '@standrig/contracts/bridge';

test('bridge strict schemas reject malformed and persistent writes', () => {
  for (const input of [{method:'DeleteObject',data:{ModelUID:'a',ObjectId:'b'}},{method:'GetCurrentModelUID',data:{token:'secret'}}]) assert.equal(bridgeReadSchema.safeParse(input).success,false);
  assert.equal(bridgePoseSchema.safeParse({method:'SetParameterValues',data:{ModelUID:'a',Parameters:[{Id:'x',Value:'five'}]}}).success,false);
});
test('service adapter authenticates server-side, fails closed, and does not leak credentials', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(),'standrig-bridge-'));
  let state='idle', fail=false, calls=0;
  const mock=createServer(async(req,res)=>{
    assert.equal(req.headers.authorization,'Bearer private-test-token');
    assert.equal(req.headers.origin,undefined);
    res.setHeader('content-type','application/json');
    if(fail){res.statusCode=500;res.end(JSON.stringify({ok:false,error:'private-test-token'}));return;}
    let result=req.url==='/v1/status'?{state}:req.url==='/v1/capabilities'?{apiVersion:'1.1.0'}:{ModelUID:'test-model'};
    if(req.url==='/v1/read')calls++;
    res.end(JSON.stringify({ok:true,result}));
  });
  await new Promise(r=>mock.listen(0,'127.0.0.1',r));
  let service;
  try {
    const session=path.join(dir,'session.json');
    await writeFile(session,JSON.stringify({url:`http://127.0.0.1:${mock.address().port}`,token:'private-test-token'}));
    service=await createLocalService({dataDir:path.join(dir,'data'),port:0,bridgeSessionFile:session});
    const request=async(route,input)=>fetch(service.url+'/api/bridge/'+route,input?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)}:undefined);
    assert.equal((await (await request('status')).json()).result.connected,true);
    const input={method:'GetCurrentModelUID',data:{}};
    assert.equal((await (await request('read',input)).json()).result.ModelUID,'test-model');
    state='editing';assert.equal((await request('read',input)).status,400);assert.equal(calls,1);
    state='idle';fail=true;assert.equal((await (await request('status')).json()).result.connected,false);
    assert.ok(!(await (await request('read',input)).text()).includes('private-test-token'));
    await writeFile(session,JSON.stringify({url:'http://example.com',token:'private-test-token'}));
    await assert.rejects(CubismBridge.fromSessionFile(session),/bridge_configuration_invalid/);
    assert.deepEqual(await (await CubismBridge.fromSessionFile()).status(),{configured:false,connected:false});
  } finally {await service?.close();mock.closeAllConnections();await new Promise(r=>mock.close(r));await rm(dir,{recursive:true,force:true});}
});
