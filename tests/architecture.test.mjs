import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

test('core/runtime do not depend on service, preview, MCP, camera or OBS packages',async()=>{
  for(const name of ['core','runtime']) {
    const dir=new URL(`../packages/${name}/`,import.meta.url);
    const pkg=JSON.parse(await readFile(new URL('package.json',dir),'utf8'));
    assert.equal(pkg.license,'Apache-2.0');
    assert.ok(Object.keys(pkg.dependencies).every(dep=>!/(mcp|mediapipe|obs|vite|service|preview)/i.test(dep)));
    for(const file of await readdir(new URL('src/',dir))) {
      if(!file.endsWith('.ts'))continue;
      const source=await readFile(new URL('src/'+file,dir),'utf8');
      assert.doesNotMatch(source,/from\s+['"](?:@standrig\/(?:mcp|service|preview)|vite|@mediapipe)/,file);
    }
  }
  const core=await import('@standrig/core');
  assert.equal(typeof core.executeModelingOperation,'function');
});
