import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
const manifest=JSON.parse(await readFile(path.join(root,'DISTRIBUTION-MANIFEST.json'),'utf8'));
const failed=[];
for(const entry of manifest.files) {
  const target=path.resolve(root,entry.path);
  if(!target.startsWith(path.resolve(root)+path.sep)) throw new Error('Invalid manifest path');
  try {const raw=await readFile(target);const bytes=entry.normalization==='lf'?Buffer.from(raw.toString('utf8').replaceAll('\r\n','\n')):raw;const sha=createHash('sha256').update(bytes).digest('hex');if(sha!==entry.sha256)failed.push({path:entry.path,reason:'hash-mismatch'});}
  catch {failed.push({path:entry.path,reason:'missing'});}
}
console.log(JSON.stringify({ok:!failed.length,checked:manifest.files.length,failed},null,2));
if(failed.length)process.exitCode=1;
