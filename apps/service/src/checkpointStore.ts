import { mkdir, readFile, writeFile, readdir, unlink, rename } from 'node:fs/promises';
import path from 'node:path';import { randomUUID } from 'node:crypto';
import { gzip, gunzip } from 'node:zlib';import { promisify } from 'node:util';
import type { RigDocument } from '@standrig/core/types';
import { packRigDocument } from '@standrig/core/packedRig';
import { migrateRigDocument } from '@standrig/core/migration';
import { assetHash, pngBytes, putAsset, putContentObject } from './assetStorage.js';
const zip=promisify(gzip),unzip=promisify(gunzip),validId=(id:string)=>/^[a-f0-9-]{36}$/.test(id);
interface Metadata { format:'standrig-checkpoint';version:2;id:string;createdAt:string;revision:string;modelHash:string;modelBytes:number;assets:Array<{assetId:string;hash:string;bytes:number;src?:string;prefix?:string}> }
function checkedMetadata(value:Metadata,file:string):Metadata {
  if(!value||value.format!=='standrig-checkpoint'||value.version!==2||!validId(value.id)||file!==value.id+'.meta.json'||typeof value.createdAt!=='string'||typeof value.revision!=='string'||!/^[a-f0-9]{64}$/.test(value.modelHash)||!Number.isSafeInteger(value.modelBytes)||value.modelBytes<0||!Array.isArray(value.assets)||value.assets.some(a=>!a||typeof a.assetId!=='string'||!/^[a-f0-9]{64}$/.test(a.hash)||!Number.isSafeInteger(a.bytes)||a.bytes<0))throw Error('Invalid checkpoint metadata');
  return value;
}
export class CheckpointStore {
  readonly directory:string;
  constructor(root:string,private publicDir:string,private limit=10,private byteLimit=256*1048576){if(!Number.isInteger(limit)||limit<1||!Number.isFinite(byteLimit)||byteLimit<=0)throw Error('Invalid checkpoint limits');this.directory=path.join(root,'checkpoints');}
  async create(rig:RigDocument,revision:string,options:{owned?:boolean}={}) {
    // Owned snapshots permit shared read-only geometry; detached callers keep deep isolation.
    const copy=options.owned?{...rig,assets:rig.assets.map(asset=>({...asset}))}:structuredClone(rig),id=randomUUID();const assets:Metadata['assets']=[];
    for(const asset of copy.assets){const bytes=await pngBytes(asset,this.publicDir),hash=assetHash(bytes);await putAsset(path.join(this.directory,'assets'),hash,bytes);
      const embedded=asset.src.startsWith('data:');
      assets.push({assetId:asset.id,hash,bytes:bytes.length,...(embedded?{prefix:asset.src.slice(0,asset.src.indexOf(',')+1)}:{src:asset.src})});asset.src='';
    }
    let packed:unknown=packRigDocument(copy);const compare=packed!==copy;
    let compressed=await zip(Buffer.from(JSON.stringify(packed)));packed=undefined;
    if(compare){const plain=await zip(Buffer.from(JSON.stringify(copy)));if(plain.length<compressed.length)compressed=plain;}
    const metadata:Metadata={format:'standrig-checkpoint',version:2,id,createdAt:new Date().toISOString(),revision,modelHash:assetHash(compressed),modelBytes:compressed.length,assets};
    await mkdir(this.directory,{recursive:true});await putContentObject(path.join(this.directory,'models'),metadata.modelHash,compressed,'json.gz');
    const meta=path.join(this.directory,id+'.meta.json');await writeFile(meta+'.tmp',JSON.stringify(metadata),{flag:'wx'});await rename(meta+'.tmp',meta);
    await this.prune(id);return {id,createdAt:metadata.createdAt,revision};
  }
  async list(){
    const rows=[];for(const file of await readdir(this.directory).catch(()=>[])){
      if(/^[a-f0-9-]{36}\.meta\.json$/.test(file)){const raw=await readFile(path.join(this.directory,file),'utf8').catch(e=>{if(e.code==='ENOENT')return undefined;throw e;});if(!raw)continue;const m=checkedMetadata(JSON.parse(raw),file);rows.push({id:m.id,createdAt:m.createdAt,revision:m.revision});}
      else if(/^[a-f0-9-]{36}\.json$/.test(file)){const m=JSON.parse(await readFile(path.join(this.directory,file),'utf8'));rows.push({id:m.id,createdAt:m.createdAt,revision:m.revision});}
    }return rows.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  }
  async restore(id:string):Promise<RigDocument>{
    if(!validId(id))throw Error('Invalid checkpoint id');
    let metadata:Metadata;
    try{metadata=JSON.parse(await readFile(path.join(this.directory,id+'.meta.json'),'utf8'));}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;return JSON.parse(await readFile(path.join(this.directory,id+'.json'),'utf8')).bundle.rig;}
    checkedMetadata(metadata,id+'.meta.json');
    const bytes=await readFile(path.join(this.directory,'models',metadata.modelHash+'.json.gz')).catch(error=>{if(error.code!=='ENOENT')throw error;return readFile(path.join(this.directory,id+'.rig.json.gz'));});if(assetHash(bytes)!==metadata.modelHash)throw Error('Checkpoint model hash mismatch');
    const rig=migrateRigDocument(JSON.parse((await unzip(bytes,{maxOutputLength:384*1048576})).toString('utf8')));
    if(metadata.assets.length!==rig.assets.length)throw Error('Checkpoint asset table mismatch');
    for(const asset of rig.assets){const entry=metadata.assets.find(e=>e.assetId===asset.id);if(!entry||!/^[a-f0-9]{64}$/.test(entry.hash))throw Error('Invalid checkpoint asset');
      const png=await readFile(path.join(this.directory,'assets',entry.hash+'.png'));if(assetHash(png)!==entry.hash||png.length!==entry.bytes)throw Error('Checkpoint asset hash mismatch');
      if(entry.prefix){if(entry.prefix!=='data:image/png;base64,')throw Error('Invalid embedded PNG prefix');asset.src=entry.prefix+png.toString('base64');}
      else {asset.src=entry.src!;let retained=false;try{retained=assetHash(await pngBytes(asset,this.publicDir))===entry.hash;}catch{}if(!retained)asset.src='data:image/png;base64,'+png.toString('base64');}
    }return rig;
  }
  private async prune(newest:string){
    const records:Metadata[]=[];for(const file of await readdir(this.directory))if(/^[a-f0-9-]{36}\.meta\.json$/.test(file))records.push(checkedMetadata(JSON.parse(await readFile(path.join(this.directory,file),'utf8')),file));
    records.sort((a,b)=>a.id===newest?-1:b.id===newest?1:b.createdAt.localeCompare(a.createdAt));
    let total=0;const used=new Set<string>(),models=new Set<string>();
    for(let i=0;i<records.length;i++){const m=records[i],addedAssets=new Map(m.assets.filter(a=>!used.has(a.hash)).map(a=>[a.hash,a.bytes]));const added=(models.has(m.modelHash)?0:m.modelBytes)+[...addedAssets.values()].reduce((sum,n)=>sum+n,0);
      if(i>0&&(i>=this.limit||total+added>this.byteLimit)){await unlink(path.join(this.directory,m.id+'.meta.json'));await unlink(path.join(this.directory,m.id+'.rig.json.gz')).catch(e=>{if(e.code!=='ENOENT')throw e;});}
      else {total+=added;m.assets.forEach(a=>used.add(a.hash));models.add(m.modelHash);}
    }
    const directory=path.join(this.directory,'assets');for(const file of await readdir(directory).catch(()=>[]))if(/^[a-f0-9]{64}\.png$/.test(file)&&!used.has(file.slice(0,64)))await unlink(path.join(directory,file));
    const modelDirectory=path.join(this.directory,'models');for(const file of await readdir(modelDirectory).catch(()=>[]))if(/^[a-f0-9]{64}\.json\.gz$/.test(file)&&!models.has(file.slice(0,64)))await unlink(path.join(modelDirectory,file));
  }
}
