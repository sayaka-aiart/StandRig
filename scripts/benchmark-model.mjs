import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {resolveArtMesh} from '@standrig/core/artMesh';
import {defaultParameterValues} from '@standrig/core/parameters';
import {portableBundle} from '../apps/service/dist/portableBundle.js';

// Owner-local files are explicit inputs and are never copied into the repository.
const args=process.argv.slice(2),arg=(name,fallback)=>{const i=args.indexOf(name);return i<0?fallback:args[i+1];};
const file=arg('--model');if(!file)throw Error('Use --model PATH [--poses PATH] [--mode geometry|bundle] [--prepared] [--output PATH]');
const mode=arg('--mode','geometry'),start=performance.now(),raw=await fs.readFile(file,'utf8'),doc=JSON.parse(raw.replace(/^\uFEFF/,'')),rig=doc.rig??doc;
const result={mode,bytes:Buffer.byteLength(raw),parseMs:performance.now()-start,parts:rig.parts.length,assets:rig.assets.length,prepared:args.includes('--prepared')};
global.gc?.();const before=process.memoryUsage();
if(mode==='bundle'){
 const t=performance.now(),bundle=await portableBundle(rig,arg('--public-dir',path.dirname(file)));result.workMs=performance.now()-t;result.embeddedAssets=bundle.rig.assets.filter(a=>a.src.startsWith('data:')).length;
}else{
 let run=fn=>fn();if(result.prepared){const {EvaluationCache,withEvaluationCache}=await import('@standrig/core/evaluationCache');const cache=new EvaluationCache();run=fn=>withEvaluationCache(cache,fn);}
 const frames=arg('--poses')?JSON.parse(await fs.readFile(arg('--poses'),'utf8')):Array.from({length:8},(_,i)=>({values:{ParamAngleX:(i-4)*5,ParamBodyAngleZ:i-4}})),defaults=defaultParameterValues(rig),assets=new Map(rig.assets.map(a=>[a.id,a])),hash=crypto.createHash('sha256'),times=[];
 const inputs=Array.from({length:8},(_,i)=>frames[Math.round(i*(frames.length-1)/7)].values);
 for(const input of inputs){const t=performance.now(),meshes=run(()=>rig.parts.filter(p=>p.artMesh).map(p=>{const a=assets.get(p.assetId);return resolveArtMesh(p,a.width,a.height,{...defaults,...input});}));times.push(performance.now()-t);hash.update(JSON.stringify(meshes));}
 result.geometrySha256=hash.digest('hex');result.firstFrameMs=times[0];const sorted=times.slice(1).sort((a,b)=>a-b);result.warmMedianMs=sorted[Math.floor(sorted.length/2)];result.frameMs=times;
}
const after=process.memoryUsage();result.memory={rssBefore:before.rss,rssAfter:after.rss,heapBefore:before.heapUsed,heapAfter:after.heapUsed,peakRss:process.resourceUsage().maxRSS*1024};
if(arg('--output'))await fs.writeFile(arg('--output'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
