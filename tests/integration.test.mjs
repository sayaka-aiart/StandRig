import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createLocalService } from '../apps/service/dist/service.js';
import { createStandRigMcp } from '../packages/mcp/src/server.mjs';
import { validateParameterPatch } from '@standrig/runtime/playback';
import { PlaybackSession } from '../apps/service/dist/playback.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const sample = JSON.parse(await readFile(new URL('../examples/sample.standrig.json', import.meta.url), 'utf8'));
test('new service sessions distinguish modelVersion zero after a restart',()=>{
  const first=new PlaybackSession(sample), second=new PlaybackSession(sample);
  assert.equal(first.snapshot().modelVersion,second.snapshot().modelVersion);
  assert.notEqual(first.snapshot().sessionId,second.snapshot().sessionId);
  const sessionId=first.snapshot().sessionId;
  first.reload(sample);
  assert.equal(first.snapshot().sessionId,sessionId);
});
test('reject external MCP origins', () => {
  for (const url of ['https://example.com','http://127.0.0.1:5180/api','http://user:secret@localhost:5180','http://localhost:5180/?x=1']) assert.throws(() => createStandRigMcp(url));
});
test('numeric input validates atomically and rejects unknown, nonfinite, out-of-range values', () => {
  assert.deepEqual(validateParameterPatch(sample,{ParamAngleZ:15}),{ParamAngleZ:15});
  for (const input of [{missing:1},{ParamAngleZ:NaN},{ParamAngleZ:31},[],null]) assert.throws(() => validateParameterPatch(sample,input));
});
test('real stdio MCP, transaction rollback, transient input and SSE', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(),'standrig-integration-'));
  let service, client, transport;
  const abort = new AbortController();
  try {
    service = await createLocalService({dataDir:dir,port:0});
    const call = async (route,method='GET',body) => {
      const response = await fetch(service.url+route,{method,headers:body===undefined?undefined:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
      return {status:response.status,data:await response.json()};
    };
    assert.equal((await call('/api/context')).data.context.summary.counts.assets,0);
    const health=(await call('/api/health')).data;
    assert.ok(health.endpoints.includes('/api/checkpoints/restore'));
    assert.ok(health.endpoints.includes('/api/playback/parameters'));
    assert.equal((await call('/api/modeling/transaction','POST',{kind:'import',rig:sample,expectedRevision:(await call('/api/context')).data.context.revision,commit:true,qa:{poses:['neutral'],regions:['full'],width:240,height:240,physics:false}})).status,200);
    const stored = await readFile(path.join(dir,'public/rig.json'),'utf8');
    assert.equal((await fetch(service.url+'/api/context',{headers:{origin:'https://untrusted.example'}})).status,403);
    const foreignHost = await new Promise((resolve, reject) => {
      const request = httpRequest(service.url+'/api/context',{headers:{host:'untrusted.example'}}, response => { response.resume(); resolve(response.statusCode); });
      request.on('error',reject); request.end();
    });
    assert.equal(foreignHost,403);
    assert.equal((await call('/api/tracking')).status,404);
    const guardedState=(await call('/api/playback')).data.playback;
    assert.equal(guardedState.inputContractVersion,2);
    for (const guard of [{expectedSessionId:'stale'}, {expectedModelVersion:guardedState.modelVersion+1}]) {
      assert.equal((await call('/api/playback/parameters','POST',{source:'guard-test',sequence:1,values:{ParamAngleZ:20},...guard})).status,400);
      assert.deepEqual((await call('/api/playback')).data.playback,guardedState);
    }
    assert.equal((await call('/api/playback/parameters','POST',{source:'tracker',sequence:1,values:{ParamAngleZ:20}})).status,200);
    assert.equal((await call('/api/playback/parameters','POST',{source:'tracker',sequence:1,values:{ParamAngleZ:0}})).status,400);
    assert.equal((await call('/api/playback/parameters','POST',{source:'tracker',sequence:2,values:{ParamAngleZ:0,invalid:1}})).status,400);
    assert.equal((await call('/api/playback')).data.playback.values.ParamAngleZ,20);
    assert.equal(await readFile(path.join(dir,'public/rig.json'),'utf8'),stored);
    const stream = await fetch(service.url+'/api/playback/events',{signal:abort.signal});
    const reader=stream.body.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value),/event: playback/);
    await call('/api/playback/control','POST',{command:'play'});
    assert.match(new TextDecoder().decode((await reader.read()).value),/"playing":true/);
    assert.equal((await call('/api/playback')).data.playback.connectedOutputs,1);
    assert.equal((await call('/api/playback')).data.playback.outputAcknowledged,false);
    abort.abort();
    transport = new StdioClientTransport({command:process.execPath,args:[path.join(root,'packages/mcp/src/cli.mjs')],env:{...process.env,STANDRIG_URL:service.url},stderr:'pipe',cwd:os.tmpdir()});
    let stderr=''; transport.stderr?.on('data',chunk=>stderr+=chunk);
    client=new Client({name:'standrig-integration',version:'1.0.0'});
    await client.connect(transport);
    const tools=await client.listTools();
    assert.equal(tools.tools.length,13);
    const actionSchema=tools.tools.find(tool=>tool.name==='standrig_modeling_transaction').inputSchema.properties.operations.items.properties.action;
    assert.equal(actionSchema.oneOf.length,35);
    assert.ok(actionSchema.oneOf.every(schema=>schema.additionalProperties===false));
    const invoke=(name,args={})=>client.callTool({name,arguments:args});
    const motionClip=JSON.parse(await readFile(path.join(root,'examples/sample.standrig-motion.json'),'utf8'));
    let motionRequests=0;
    const observeMotion=req=>{if(req.url==='/api/playback/motion')motionRequests++;};
    service.httpServer.on('request',observeMotion);
    for(const args of [{action:'play',extra:1},{action:'seek',time:'five'},{action:'configure',speed:5},{action:'load',clip:{...motionClip,extra:1}}])assert.equal((await invoke('standrig_motion',args)).isError,true);
    assert.equal(motionRequests,0,'invalid motion structures must fail before HTTP');
    service.httpServer.off('request',observeMotion);
    assert.equal((await invoke('standrig_motion',{action:'load',clip:motionClip})).structuredContent.playback.motion.loaded,true);
    assert.deepEqual((await call('/api/playback/motion')).data.clip,motionClip);
    assert.equal((await invoke('standrig_motion',{action:'play'})).structuredContent.playback.motion.running,true);
    assert.equal((await invoke('standrig_motion',{action:'pause'})).structuredContent.playback.motion.running,false);
    const seek=await invoke('standrig_motion',{action:'seek',time:0.5});
    assert.equal(seek.structuredContent.playback.values.ParamAngleZ,-20);
    const unchanged=(await call('/api/playback')).data.playback;
    assert.equal((await call('/api/playback/motion','POST',{action:'seek',time:3})).status,400);
    assert.deepEqual((await call('/api/playback')).data.playback,unchanged);
    assert.equal((await call('/api/playback/motion','POST',{action:'load',clip:{Version:3}})).status,400);
    await invoke('standrig_motion',{action:'configure',speed:1.3,loop:true});
    const stopped=await invoke('standrig_motion',{action:'stop'});
    assert.equal(stopped.structuredContent.playback.values.ParamAngleZ,20);
    await invoke('standrig_motion',{action:'clear'});
    assert.equal((await call('/api/playback/motion')).data.clip,null);
    assert.equal(await readFile(path.join(dir,'public/rig.json'),'utf8'),stored);
    assert.match((await client.readResource({uri:'standrig://docs/motion'})).contents[0].text,/not implemented/);
    const beforeDemo=(await call('/api/playback')).data.playback.values;
    const demo = await invoke('standrig_playback_control',{command:'demo-start',mode:'mouse-expression'});
    assert.equal(demo.structuredContent.playback.demo.active,true);
    assert.equal((await invoke('standrig_playback_control',{command:'demo-pointer',x:0.5,y:-0.5})).isError,undefined);
    assert.equal((await invoke('standrig_playback_control',{command:'demo-stop'})).structuredContent.playback.demo.active,false);
    assert.deepEqual((await call('/api/playback')).data.playback.values,beforeDemo);
    assert.equal(await readFile(path.join(dir,'public/rig.json'),'utf8'),stored);
    const context=(await invoke('standrig_context')).structuredContent.context;
    assert.equal(context.summary.counts.assets,4);
    assert.equal((await invoke('standrig_render',{kind:'snapshot'})).isError,true);
    const input={expectedRevision:context.revision,commit:false,operations:[{id:'move',name:'Move demo body',target:{partIds:['body']},action:{type:'transform',property:'x',operator:'add',value:2}}],qa:{poses:['neutral'],regions:['full'],width:240,height:240,physics:false}};
    let transactionRequests=0;
    const observeRequest=req=>{if(req.url==='/api/modeling/transaction')transactionRequests++;};
    service.httpServer.on('request',observeRequest);
    for(const action of [
      ...[0,51,1.5].map(iterations=>({type:'deform-brush',brush:{surface:{kind:'artmesh',space:'mesh-local'},center:[0,0],radius:10,effect:{mode:'inflate',distance:1},iterations,maxDisplacement:1,falloff:'linear',destination:{kind:'base'}}})),
      {type:'warp-create',divisionX:'five'},
      {type:'artmesh-generate',preset:'face-feature',columns:'five',rows:5},
      {type:'deformer-origin',deformerId:'missing',x:'five',y:0},
      {...input.operations[0].action,unexpected:true}
    ]) {
      const rejected=await invoke('standrig_modeling_transaction',{...input,commit:true,operations:[{...input.operations[0],action}]});
      assert.equal(rejected.isError,true,JSON.stringify(rejected));
    }
    assert.equal(transactionRequests,0,'MCP must reject invalid actions before HTTP');
    service.httpServer.off('request',observeRequest);
    const dry=await invoke('standrig_modeling_transaction',input);
    assert.equal(dry.isError,undefined,JSON.stringify(dry));
    assert.equal(dry.structuredContent.committed,false);
    assert.equal(await readFile(path.join(dir,'public/rig.json'),'utf8'),stored);
    const committed=await invoke('standrig_modeling_transaction',{...input,commit:true});
    assert.equal(committed.structuredContent.committed,true,JSON.stringify(committed));
    assert.ok(committed.structuredContent.rollbackCheckpoint.id);
    const stale=await invoke('standrig_modeling_transaction',{...input,commit:true});
    assert.equal(stale.isError,true);
    assert.equal(stale.structuredContent.error,'revision mismatch');
    const revision=(await invoke('standrig_context')).structuredContent.context.revision;
    const restored=await invoke('standrig_restore',{id:committed.structuredContent.rollbackCheckpoint.id,expectedRevision:revision});
    assert.equal(restored.isError,undefined,JSON.stringify(restored));
    assert.equal((await invoke('standrig_context')).structuredContent.context.revision,context.revision);
    const deformInput={expectedRevision:context.revision,commit:false,operations:[
      {id:'shape',name:'Body shape',target:{partIds:['body']},action:{type:'blend-shape-set',shape:{kind:'part',id:'smile',parameter:'ParamAngleX',neutralInput:0,targetInput:30,transform:{x:2,rotation:3}}}},
      {id:'mesh',name:'Mesh',target:{partIds:['body']},action:{type:'artmesh-generate',preset:'face-feature',columns:4,rows:4}},
      {id:'brush',name:'Bounded inflate',target:{partIds:['body']},action:{type:'deform-brush',brush:{surface:{kind:'artmesh',space:'mesh-local'},center:[30,30],radius:200,effect:{mode:'inflate',distance:2},iterations:2,maxDisplacement:3,falloff:'smooth',destination:{kind:'blend-shape',shape:{id:'inflate',parameter:'ParamAngleX',neutralInput:0,targetInput:30}}}}}
    ],qa:{poseSamples:[{poseId:'neutral',values:{ParamAngleX:0}},{poseId:'half',values:{ParamAngleX:15}},{poseId:'full',values:{ParamAngleX:30}}],regions:['full'],width:240,height:240,physics:false}};
    const deformDry=await invoke('standrig_modeling_transaction',deformInput);
    assert.equal(deformDry.isError,undefined,JSON.stringify(deformDry));
    assert.equal(deformDry.structuredContent.ok,true,JSON.stringify(deformDry));
    assert.equal((await invoke('standrig_context')).structuredContent.context.revision,context.revision);
    const deformCommit=await invoke('standrig_modeling_transaction',{...deformInput,commit:true});
    assert.equal(deformCommit.structuredContent.committed,true,JSON.stringify(deformCommit));
    assert.ok(deformCommit.structuredContent.operationResults[2].deformReports[0].maxDisplacement<=3);
    const deformExport=(await invoke('standrig_export')).structuredContent;
    const deformBundle=JSON.parse(await readFile(deformExport.path,'utf8'));
    assert.equal(deformBundle.rig.parts.find(p=>p.id==='body').blendShapes[0].id,'smile');
    assert.equal(deformBundle.rig.parts.find(p=>p.id==='body').artMesh.blendShapes[0].id,'inflate');
    const deformRestored=await invoke('standrig_restore',{id:deformCommit.structuredContent.rollbackCheckpoint.id,expectedRevision:deformCommit.structuredContent.revisionAfter});
    assert.equal(deformRestored.isError,undefined,JSON.stringify(deformRestored));
    assert.equal((await invoke('standrig_context')).structuredContent.context.revision,context.revision);
    const qa=await invoke('standrig_qa_check',{poses:['neutral'],regions:['full']});
    assert.equal(qa.isError,undefined,JSON.stringify(qa));
    const rendered=await invoke('standrig_render',{kind:'snapshot'});
    assert.equal(rendered.content[0].type,'image',JSON.stringify(rendered));
    assert.deepEqual([...Buffer.from(rendered.content[0].data,'base64').subarray(0,8)],[137,80,78,71,13,10,26,10]);
    assert.equal((await invoke('standrig_playback_parameters',{values:{ParamMouthOpen:0.8}})).isError,undefined);
    assert.equal((await invoke('standrig_playback_state')).structuredContent.playback.values.ParamMouthOpen,0.8);
    const exported=(await invoke('standrig_export')).structuredContent;
    const bundle=JSON.parse(await readFile(exported.path,'utf8'));
    assert.equal(bundle.format,'standrig-bundle');
    assert.ok(bundle.rig.assets.every(a=>a.src.startsWith('data:image/png;base64,')));
    const resources=await client.listResources(); assert.equal(resources.resources.length,8);
    assert.match((await client.readResource({uri:'standrig://docs/deform'})).contents[0].text,/maxDisplacement/);
    const contract=await client.readResource({uri:'standrig://docs/contract'});
    assert.match(contract.contents[0].text,/Mandatory pre-model visual reference gate/);
    const guide=await client.readResource({uri:'standrig://docs/guide'});
    assert.match(guide.contents[0].text,/parts-separated PSD/);
    const failedQa=await invoke('standrig_qa_check',{poseSamples:[{poseId:'custom-failed-pose',values:{ParamAngleZ:25}}],regions:['full'],minCoverage:1});
    assert.equal(failedQa.isError,true);
    assert.equal(failedQa.structuredContent.failureRegions[0].imageRequest.values.ParamAngleZ,25);
    const failure=await invoke('standrig_render',{kind:'failure',poseId:'custom-failed-pose',region:'full'});
    assert.equal(failure.isError,undefined,JSON.stringify(failure));
    assert.equal(failure.content[0].type,'image');
    assert.equal((await invoke('standrig_render',{kind:'failure',poseId:'unreported',region:'full'})).isError,true);
    assert.equal(stderr,'');
  } finally {
    abort.abort(); await client?.close(); await transport?.close(); await service?.close();
    assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('standrig-integration-'));
    await rm(dir,{recursive:true,force:true});
  }
});
