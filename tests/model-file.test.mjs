import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
const source=await readFile(new URL('../apps/preview/src/modelFile.ts',import.meta.url),'utf8');
const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const {parseModelFile}=await import('data:text/javascript;base64,'+Buffer.from(js.replaceAll('@standrig/core/migration',import.meta.resolve('@standrig/core/migration'))).toString('base64'));
const rig={schemaVersion:'1',parts:[],assets:[{id:'a',src:'/assets/a.png'}]};
const awaitedSample=await readFile(new URL('../examples/sample.standrig.json',import.meta.url),'utf8');
test('loads plain, BOM-prefixed and bundled model documents without dropping asset references',()=>{
 assert.deepEqual(parseModelFile(JSON.stringify(rig)),rig);
 assert.deepEqual(parseModelFile('\uFEFF'+JSON.stringify(rig)),rig);
 assert.deepEqual(parseModelFile(JSON.stringify({format:'standrig-bundle',version:1,rig})),rig);
 const current=JSON.parse(awaitedSample);
 assert.equal(parseModelFile(JSON.stringify({format:'standrig-bundle',version:1,rig:{format:'standrig-packed',version:1,rig:current}})).schemaVersion,'0.1.0');
});
test('rejects broken JSON, unrelated documents and unsupported bundles',()=>{
 for(const text of ['{','null','[]','{}',JSON.stringify({format:'standrig-bundle',version:2,rig}),JSON.stringify({schemaVersion:'1',parts:[]})]) assert.throws(()=>parseModelFile(text));
});
