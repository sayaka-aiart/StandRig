import { readFile, realpath, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { AssetDefinition } from '@standrig/core/types';
export const assetHash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export async function pngBytes(asset: AssetDefinition, publicDir: string): Promise<Buffer> {
  let bytes: Buffer;
  if (asset.src.startsWith('data:image/png;base64,')) bytes=Buffer.from(asset.src.slice('data:image/png;base64,'.length),'base64');
  else {
    if(!asset.src.startsWith('/')||asset.src.startsWith('//')||asset.src.includes('?')||asset.src.includes('#'))throw Error('Bundle requires local PNG assets: '+asset.id);
    const root=await realpath(publicDir),file=await realpath(path.resolve(root,asset.src.slice(1)));
    if(!file.startsWith(root+path.sep))throw Error('Asset path escaped public directory');
    bytes=await readFile(file);
  }
  if(!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw Error('Bundle requires PNG assets: '+asset.id);
  return bytes;
}
export async function putAsset(directory: string, hash: string, bytes: Uint8Array) {
  return putContentObject(directory,hash,bytes,'png');
}
export async function putContentObject(directory:string,hash:string,bytes:Uint8Array,suffix:'png'|'json.gz') {
  if(!/^[a-f0-9]{64}$/.test(hash)||assetHash(bytes)!==hash)throw Error('Invalid content-addressed asset');
  await mkdir(directory,{recursive:true});
  // Never follow an existing assets-directory link outside its owning directory.
  const parent=await realpath(path.dirname(directory)),root=await realpath(directory);
  if(path.dirname(root)!==parent)throw Error('Asset directory escaped owner');
  const file=path.join(root,hash+'.'+suffix);
  try{await writeFile(file,bytes,{flag:'wx'});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
    const actual=await realpath(file);if(path.dirname(actual)!==root||assetHash(await readFile(actual))!==hash)throw Error('Existing asset content mismatch');}
}
