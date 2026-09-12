import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
const source=await readFile(new URL('../apps/preview/src/modelFile.ts',import.meta.url),'utf8');
const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const {parseModelFile}=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
const rig={schemaVersion:'1',parts:[],assets:[{id:'a',src:'/assets/a.png'}]};
test('loads plain, BOM-prefixed and bundled model documents without dropping asset references',()=>{
 assert.deepEqual(parseModelFile(JSON.stringify(rig)),rig);
 assert.deepEqual(parseModelFile('\uFEFF'+JSON.stringify(rig)),rig);
 assert.deepEqual(parseModelFile(JSON.stringify({format:'standrig-bundle',version:1,rig})),rig);
});
test('rejects broken JSON, unrelated documents and unsupported bundles',()=>{
 for(const text of ['{','null','[]','{}',JSON.stringify({format:'standrig-bundle',version:2,rig}),JSON.stringify({schemaVersion:'1',parts:[]})]) assert.throws(()=>parseModelFile(text));
});
