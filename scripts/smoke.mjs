import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalService } from '../apps/service/dist/service.js';

const { emptyRig } = await import('./init-empty.mjs');
const { encodePng, createBlankRgba } = await import('@standrig/core/png');
const { DEFAULT_TRANSFORM } = await import('@standrig/core/types');
const root = fileURLToPath(new URL('..', import.meta.url));
const temporary = await mkdtemp(path.join(os.tmpdir(), 'standrig-modeling-smoke-'));
const checks = [];
let server;
try {
  await mkdir(path.join(temporary,'public'),{recursive:true});
  await mkdir(path.join(temporary,'docs'),{recursive:true});
  await copyFile(path.join(root,'docs/api-routes.json'),path.join(temporary,'docs/api-routes.json'));
  await copyFile(path.join(root,'templates/rig.schema.json'),path.join(temporary,'public/rig.schema.json'));
  await writeFile(path.join(temporary,'index.html'),'<html><body>Isolated test fixture</body></html>');
  await writeFile(path.join(temporary,'public/rig.json'),JSON.stringify(emptyRig()));
  server = await createLocalService({ dataDir:temporary,port:0 });
  const base = `http://127.0.0.1:${server.httpServer.address().port}`;
  async function api(endpoint, method='GET', body) {
    const response = await fetch(base+endpoint,{method,headers:body ? {'content-type':'application/json'} : undefined,body:body ? JSON.stringify(body) : undefined});
    return {status:response.status, data:await response.json()};
  }
  const blank = await api('/api/context');
  assert.equal(blank.status,200); assert.equal(blank.data.context.summary.counts.assets,0); checks.push('empty-context');
  const health = await api('/api/health');
  assert.equal(health.data.app,'standrig-modeling-tools');
  assert.ok(health.data.endpoints.every(route => !/tracking|tracker|geometry-assist/.test(route))); checks.push('modeling-only-health');
  for(const endpoint of ['/api/tracker/launch','/api/tracking','/api/tracking-profile','/api/tracking-recordings','/api/geometry-assist/status','/api/does-not-exist','/obs','/tracker']) {
    assert.equal((await api(endpoint)).status,404,endpoint);
  }
  checks.push('excluded-routes-404');
  const image = createBlankRgba(32,32);
  for(let i=0;i<image.data.length;i+=4) { image.data[i]=70; image.data[i+1]=180; image.data[i+2]=150; image.data[i+3]=255; }
  const rig = emptyRig();
  rig.name='Synthetic QA fixture'; rig.stage={width:128,height:128,background:'transparent'};
  rig.assets=[{id:'test-asset',name:'Generated square',type:'image',src:'data:image/png;base64,'+Buffer.from(encodePng(image)).toString('base64'),width:32,height:32}];
  rig.parts.push({id:'test-part',name:'Generated square',kind:'image',parentId:'root',assetId:'test-asset',visible:true,drawOrder:10,transform:{...DEFAULT_TRANSFORM,x:64,y:64}});
  assert.equal((await api('/api/rig?includeAssets=1','PUT',rig)).status,200); checks.push('isolated-rig-import');
  assert.equal((await api('/api/parts/test-part')).data.part.id,'test-part');
  assert.equal((await api('/api/rig/validate')).data.validation.ok,true); checks.push('parts-and-validation');
  const qa = {poses:['neutral'],regions:['full'],width:240,height:240,physics:false};
  assert.equal((await api('/api/qa/check','POST',qa)).data.ok,true); checks.push('numeric-qa-before-image');
  const screenshot = await fetch(base+'/api/screenshot?width=240&height=240&physics=0');
  assert.equal(screenshot.status,200); assert.equal(screenshot.headers.get('content-type'),'image/png');
  assert.deepEqual([...new Uint8Array(await screenshot.arrayBuffer()).slice(0,8)],[137,80,78,71,13,10,26,10]); checks.push('png-render');
  const context = (await api('/api/context')).data.context;
  const diskBefore = await readFile(path.join(temporary,'public/rig.json'),'utf8');
  const body = {expectedRevision:context.revision,commit:false,operations:[{id:'smoke-transform',name:'Move synthetic square',target:{partIds:['test-part']},action:{type:'transform',property:'x',operator:'add',value:2}}],qa};
  const dry = await api('/api/modeling/transaction','POST',body);
  assert.equal(dry.status,200); assert.equal(dry.data.ok,true,JSON.stringify(dry.data)); assert.equal(dry.data.committed,false);
  assert.equal(await readFile(path.join(temporary,'public/rig.json'),'utf8'),diskBefore);
  assert.equal((await api('/api/context')).data.context.revision,context.revision); checks.push('dry-run-no-write');
  assert.equal((await api('/api/modeling/transaction','POST',{...body,expectedRevision:'rig-stale',commit:true})).status,409);
  assert.equal(await readFile(path.join(temporary,'public/rig.json'),'utf8'),diskBefore); checks.push('stale-revision-no-write');
  const rejected = await api('/api/modeling/transaction','POST',{...body,commit:true,operations:[{id:'smoke-hide',name:'Reject empty render',target:{partIds:['test-part']},action:{type:'part-visibility',visible:false}}]});
  assert.equal(rejected.status,422); assert.equal(rejected.data.committed,false);
  assert.equal(await readFile(path.join(temporary,'public/rig.json'),'utf8'),diskBefore); checks.push('failed-qa-no-write');
  const committed = await api('/api/modeling/transaction','POST',{...body,commit:true});
  assert.equal(committed.status,200); assert.equal(committed.data.committed,true);
  assert.equal((await api('/api/parts/test-part')).data.part.transform.x,66); checks.push('qa-gated-commit');
  const change = await api('/api/changes?since='+context.revision);
  assert.equal(change.data.changed,true); assert.equal(change.data.resyncRequired,false); checks.push('revision-journal');
  const external = await api('/api/assets/externalize','POST',{rig: (await api('/api/rig?includeAssets=1')).data,dryRun:false});
  assert.equal(external.data.ok,true); assert.ok(external.data.rig.assets[0].src.startsWith('/assets/')); checks.push('asset-externalization');
  assert.equal((await api('/api/qa/check','POST',qa)).data.ok,true); checks.push('externalized-render-qa');
  const bundle = await api('/api/bundle');
  assert.equal(bundle.status,200);
  assert.equal(bundle.data.rig.assets[0].src,rig.assets[0].src);
  assert.ok((await api('/api/rig?includeAssets=1')).data.assets[0].src.startsWith('/assets/'));
  checks.push('self-contained-bundle-external-assets-no-write');
  const escaped = structuredClone(rig); escaped.assets[0].src='../outside.png';
  await writeFile(path.join(temporary,'public/rig.json'),JSON.stringify(escaped));
  assert.equal((await api('/api/bundle')).status,500); checks.push('bundle-path-escape-rejected');
  await mkdir(path.join(root,'reports'),{recursive:true});
  await writeFile(path.join(root,'reports/smoke.json'),JSON.stringify({passed:true,checkedAt:new Date().toISOString(),isolated:true,checks,realCharacterModelTested:false},null,2)+'\n');
  console.log(JSON.stringify({passed:true,checks:checks.length,details:checks}));
} finally {
  if(server) await server.close();
  // Only the unique directory created above is removed, never a user's rig.
  const resolved = path.resolve(temporary);
  assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('standrig-modeling-smoke-'));
  await rm(resolved,{recursive:true,force:true});
}
