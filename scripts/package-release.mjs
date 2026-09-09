import { readFile, readdir, mkdir, writeFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=fileURLToPath(new URL('..',import.meta.url));
const pkg=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
const roots=['packages','apps','scripts','tests','examples','templates','docs','licenses','.github'];
const rootFiles=['package.json','package-lock.json','tsconfig.json','README.md','README.en.md','AI_OPERATING_GUIDE.md','AGENTS.md','LICENSE','NOTICE','THIRD_PARTY_NOTICES.md','CONTRIBUTING.md','SECURITY.md','SOURCE-PROVENANCE.json','.gitignore','.gitattributes','start-modeling-tools.cmd'];
const omitted=new Set(['node_modules','dist','workspace','reports','releases','public','.git','.vite','.vite-temp','backups','checkpoints','exports']);
const names=[...rootFiles];
async function walk(relative) {
  for(const entry of await readdir(path.join(root,relative),{withFileTypes:true})) {
    if(omitted.has(entry.name))continue;
    const name=relative+'/'+entry.name;
    if(entry.isSymbolicLink())throw new Error('Release cannot include symlinks: '+name);
    if(entry.isDirectory())await walk(name);
    else if(entry.isFile()) {
      if(/\.(psd|psb|log|zip)$/i.test(name)||/(^|\/)\.env/.test(name))throw new Error('Private/unexpected release file: '+name);
      names.push(name);
    }
  }
}
for(const folder of roots)await walk(folder);
names.sort();
const files=[];
const payloads=new Map();
for(const name of names) {
  if((await lstat(path.join(root,name))).isSymbolicLink())throw new Error('Symlink in release');
  const original=await readFile(path.join(root,name));
  const normalization=/\.(png|jpe?g|webp|gif|wasm)$/i.test(name)?'none':'lf';
  const bytes=normalization==='lf'?Buffer.from(original.toString('utf8').replaceAll('\r\n','\n')):original;
  payloads.set(name,bytes);
  files.push({path:name,normalization,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
}
const manifest=Buffer.from(JSON.stringify({format:'standrig-source-release-v2',version:pkg.version,files},null,2)+'\n');
await writeFile(path.join(root,'DISTRIBUTION-MANIFEST.json'),manifest);
payloads.set('DISTRIBUTION-MANIFEST.json',manifest);

// ZIP32 writer using only Node built-ins; deterministic timestamps and UTF-8 names.
const table=Array.from({length:256},(_,n)=>{let c=n;for(let i=0;i<8;i++)c=(c&1)?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
const crc32=bytes=>{let crc=0xffffffff;for(const b of bytes)crc=table[(crc^b)&255]^(crc>>>8);return (crc^0xffffffff)>>>0;};
const local=[],central=[];let offset=0;
const prefix=`StandRig-${pkg.version}/`;
for(const [name,bytes] of [...payloads].sort(([a],[b])=>a.localeCompare(b,'en'))) {
  const filename=Buffer.from(prefix+name);const compressed=deflateRawSync(bytes,{level:9});const crc=crc32(bytes);
  const header=Buffer.alloc(30);header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);header.writeUInt16LE(8,8);header.writeUInt16LE(33,12);header.writeUInt32LE(crc,14);header.writeUInt32LE(compressed.length,18);header.writeUInt32LE(bytes.length,22);header.writeUInt16LE(filename.length,26);
  local.push(header,filename,compressed);
  const entry=Buffer.alloc(46);entry.writeUInt32LE(0x02014b50);entry.writeUInt16LE(20,4);entry.writeUInt16LE(20,6);entry.writeUInt16LE(0x800,8);entry.writeUInt16LE(8,10);entry.writeUInt16LE(33,14);entry.writeUInt32LE(crc,16);entry.writeUInt32LE(compressed.length,20);entry.writeUInt32LE(bytes.length,24);entry.writeUInt16LE(filename.length,28);entry.writeUInt32LE(offset,42);
  central.push(entry,filename);offset+=header.length+filename.length+compressed.length;
}
const directory=Buffer.concat(central);const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(payloads.size,8);end.writeUInt16LE(payloads.size,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
const zip=Buffer.concat([...local,directory,end]);
await mkdir(path.join(root,'releases'),{recursive:true});
const filename=`StandRig-${pkg.version}-source.zip`;
await writeFile(path.join(root,'releases',filename),zip);
const sha256=createHash('sha256').update(zip).digest('hex');
await writeFile(path.join(root,'releases',filename+'.sha256'),`${sha256}  ${filename}\n`);
console.log(JSON.stringify({file:'releases/'+filename,files:payloads.size,bytes:zip.length,sha256}));
