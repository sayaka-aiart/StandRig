import { Worker } from 'node:worker_threads';
import { availableParallelism, freemem, tmpdir } from 'node:os';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileStamp } from './fileStamp.js';
import { reserveQaMemory } from './qaMemory.js';
import { modelingPoseValuesForRig } from '@standrig/core/modeling';
import { previewParameterValuesForRig } from '@standrig/core/parameters';
import type { RigDocument } from '@standrig/core/types';
import type { QaCheckRequest, QaCheckResult } from '@standrig/core/qaCheck';

export interface QaOptions { workers?: number; memoryMiB?: number }
export interface QaProgress { stage: string; completed?: number; total?: number; workers?: number }
export function qaWorkerMemory(modelBytes: number, textureBytes: number) {
  // Calibration includes decoded geometry, renderer scratch buffers and V8 heap
  // growth. The earlier estimate measured only about 60% of actual peak RSS.
  return Math.ceil(2 * (128 * 1048576 + modelBytes * 8 + textureBytes * 1.3));
}
export function qaWorkerCount(modelBytes: number, textureBytes: number, tasks: number, options: QaOptions = {}, capacity = { cpus: availableParallelism(), memory: Math.min(freemem(), process.availableMemory?.() ?? Infinity) }) {
  const memory = options.memoryMiB === undefined ? capacity.memory * .5 : Math.min(capacity.memory * .75, options.memoryMiB * 1048576);
  const perWorker = qaWorkerMemory(modelBytes, textureBytes);
  const cap = options.workers ?? 8;
  if (!Number.isInteger(cap) || cap < 1 || !Number.isFinite(memory) || memory <= 0) throw Error('Invalid QA resource limits');
  // Large snapshots and decoded textures have a substantial cold-start cost.
  const workLimit=options.workers===undefined&&modelBytes>32*1048576?Math.max(1,Math.floor(tasks/4)):tasks;
  return Math.max(0, Math.min(workLimit, cap, Math.max(1, capacity.cpus - 1), Math.floor(memory / perWorker)));
}
function estimatedTextures(rig:RigDocument) {
  const parts=new Map(rig.parts.map(p=>[p.id,p])),memo=new Map<string,boolean>();
  const visible=(id:string,seen=new Set<string>()):boolean=>{if(memo.has(id))return memo.get(id)!;const p=parts.get(id);if(!p||!p.visible||seen.has(id))return false;seen.add(id);const yes=!p.parentId||!parts.has(p.parentId)||visible(p.parentId,seen);memo.set(id,yes);return yes;};
  const needed=new Set(rig.parts.filter(p=>visible(p.id)).map(p=>p.assetId));
  for(const p of rig.parts){if(p.clip?.maskOpacity==='ignore')for(const id of [p.clip.maskPartId,...(p.clip.maskPartIds??[])])needed.add(id?parts.get(id)?.assetId:undefined);if(p.rasterMaskPartId&&visible(p.id))needed.add(parts.get(p.rasterMaskPartId)?.assetId);}
  return rig.assets.filter(a=>needed.has(a.id)).reduce((sum,a)=>sum+(a.width??4096)*(a.height??4096)*4,0);
}

/** This instance queues requests before loading them; qaMemory coordinates other processes. */
let tail: Promise<unknown> = Promise.resolve(), waiting = 0;
const resultsCache=new Map<string,{result:QaCheckResult;bytes:number}>();let cachedBytes=0;
async function assetsStamp(rig:RigDocument,publicDir:string){
  const root=path.resolve(publicDir),entries:string[]=[];
  for(const asset of rig.assets){if(asset.src.startsWith('data:'))continue;const file=path.resolve(root,asset.src.replace(/^\/+/,''));
    if(!file.startsWith(root+path.sep)){entries.push('invalid:'+asset.id);continue;}
    entries.push(asset.id+':'+await fileStamp(file).catch(()=> 'missing'));
  }return entries.join('|');
}
export async function runServiceQa(rig: RigDocument | (()=>Promise<RigDocument>), publicDir: string, request: QaCheckRequest, options: QaOptions = {}, progress: (value: QaProgress) => void = () => {}, signal?: AbortSignal): Promise<QaCheckResult> {
  if (waiting >= 8) throw Error('QA queue is full');
  waiting++;
  let release!: () => void;
  const previous = tail;
  const gate = new Promise<void>(r => { release = r; });
  tail = previous.then(()=>gate);
  try {
    await new Promise<void>((resolve,reject)=>{
      const abort=()=>{signal?.removeEventListener('abort',abort);reject(signal?.reason??Error('QA cancelled'));};
      if(signal?.aborted){abort();return;}
      signal?.addEventListener('abort',abort,{once:true});previous.then(()=>{signal?.removeEventListener('abort',abort);resolve();},reject);
    });
    signal?.throwIfAborted();
    return await execute(typeof rig==='function'?await rig():rig, publicDir, request, options, progress, signal);
  } finally { waiting--; release(); }
}

async function execute(rig: RigDocument, publicDir: string, request: QaCheckRequest, options: QaOptions, progress: (value: QaProgress) => void, signal?: AbortSignal): Promise<QaCheckResult> {
  const defaults = previewParameterValuesForRig(rig);
  if(request.poseSamples!==undefined&&(!Array.isArray(request.poseSamples)||request.poseSamples.some(s=>!s||typeof s.poseId!=='string'||!s.values||typeof s.values!=='object'||Array.isArray(s.values))))throw Error('Invalid QA poseSamples');
  const requested = request.poseSamples?.length ? request.poseSamples.map(s => ({ ...s, values: { ...defaults, ...s.values } })) : [...new Set(request.poses?.length ? request.poses : ['neutral'])].map(poseId => {
    const values = modelingPoseValuesForRig(rig, poseId, defaults); if (!values) throw Error(`Unknown QA pose: ${poseId}`); return { poseId, values };
  });
  if (!requested.length || requested.some(p => !p || typeof p.poseId !== 'string' || !p.poseId.trim() || Object.values(p.values).some(v => typeof v !== 'number' || !Number.isFinite(v))) || new Set(requested.map(p => p.poseId.trim())).size !== requested.length) throw Error('Invalid or duplicate QA samples');
  const samples = requested.map(p => ({ ...p, poseId: p.poseId.trim() }));
  const neutral = samples.find(p => p.poseId === 'neutral') ?? { poseId: 'neutral', values: defaults };
  const text = JSON.stringify(rig);
  const assetsBefore=await assetsStamp(rig,publicDir);
  signal?.throwIfAborted();
  const cacheKey=createHash('sha256').update(text).update(path.resolve(publicDir)).update(assetsBefore).update(JSON.stringify(request)).digest('hex');
  const cached=resultsCache.get(cacheKey);
  if(cached){progress({stage:'qa',completed:samples.length,total:samples.length,workers:0});return {...structuredClone(cached.result),cache:'hit'};}
  const textureBytes = estimatedTextures(rig);
  // Shared admission applies changing free RAM. Do not reject queued work just
  // because a different service currently owns that memory.
  const maximum = qaWorkerCount(Buffer.byteLength(text), textureBytes, samples.length, options, {cpus:availableParallelism(),memory:Number.MAX_SAFE_INTEGER});
  if(maximum<1)throw Error('QA memory budget is too small for one worker; use a smaller model or adjust --qa-memory-mib');
  const lease = await reserveQaMemory(qaWorkerMemory(Buffer.byteLength(text), textureBytes), maximum, signal, () => progress({stage:'queued-memory',workers:0}));
  const count = lease.workers;
  let directory: string | undefined;
  const workers: Worker[] = [];
  const timer = setTimeout(() => workers.forEach(w => { void w.terminate(); }), 30 * 60 * 1000); timer.unref();
  const abort = () => workers.forEach(w => { void w.terminate(); });
  signal?.addEventListener('abort', abort, { once: true });
  try {
    directory = await mkdtemp(path.join(tmpdir(), 'standrig-qa-'));
    const file = path.join(directory, 'snapshot.json'); await writeFile(file, text);
    signal?.throwIfAborted();
    let completed = 0;
    const groups = Array.from({length:count}, () => [] as typeof samples);
    samples.forEach((sample,i) => groups[i % count].push(sample));
    progress({stage:'qa',completed,total:samples.length,workers:count});
    signal?.throwIfAborted();
    const results = await Promise.all(groups.map((group,index) => new Promise<QaCheckResult>((resolve,reject) => {
      const worker = new Worker(new URL('./qaWorker.js', import.meta.url), { workerData: { file, publicDir } }); workers.push(worker);
      let settled = false;
      const fail = (error: unknown) => { if (!settled) { settled = true; reject(error); } };
      worker.once('error',fail); worker.once('exit',code => { if (!settled) fail(Error(`QA worker exited (${code})`)); });
      worker.on('message', message => {
        if (message.ready) worker.postMessage({...request, poses:undefined, poseSamples:group.some(p=>p.poseId==='neutral') ? group : [neutral,...group], motionSweep:index===0?request.motionSweep:false});
        else if (message.error) fail(Error(message.error));
        else if (message.result && !settled) { settled=true;completed+=group.length;progress({stage:'qa',completed,total:samples.length,workers:count});resolve(message.result); }
      });
    })));
    signal?.throwIfAborted();
    const regions = [...new Set(request.regions?.length ? request.regions : ['full'])];
    const byKey = new Map(results.flatMap(r=>r.entries).map(entry=>[`${entry.poseId}:${entry.region}`,entry]));
    const entries = regions.flatMap(region=>samples.map(p=>byKey.get(`${p.poseId}:${region}`)!));
    if (entries.some(e=>!e)) throw Error('Incomplete QA worker result');
    const failed = entries.filter(e=>!e.pass), failedKeys = new Set(failed.map(e=>`${e.poseId}:${e.region}`));
    const failureRegions = results.flatMap(r=>r.failureRegions).filter((e,i,all)=>failedKeys.has(`${e.poseId}:${e.region}`)&&all.findIndex(a=>a.poseId===e.poseId&&a.region===e.region)===i);
    failureRegions.sort((a,b)=>entries.findIndex(e=>e.poseId===a.poseId&&e.region===a.region)-entries.findIndex(e=>e.poseId===b.poseId&&e.region===b.region));
    const motionSweep = results[0].motionSweep, issues = motionSweep && !motionSweep.pass ? ['motion-sweep'] : undefined;
    if(await assetsStamp(rig,publicDir)!==assetsBefore)throw Error('Assets changed during QA; retry against a stable model');
    const result:QaCheckResult={ok:!failed.length&&!issues?.length,entries,failed,failureRegions,renderedCount:entries.length+(samples.some(s=>s.poseId==='neutral')?0:regions.length),imagePolicy:'numeric-only',cache:'miss',motionSweep,issues};
    const resultBytes=Buffer.byteLength(JSON.stringify(result));
    if(resultBytes<=16*1048576){while(resultsCache.size>=24||cachedBytes+resultBytes>32*1048576){const oldest=resultsCache.keys().next().value!;cachedBytes-=resultsCache.get(oldest)!.bytes;resultsCache.delete(oldest);}resultsCache.set(cacheKey,{result:structuredClone(result),bytes:resultBytes});cachedBytes+=resultBytes;}
    return result;
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort',abort); await Promise.all(workers.map(w=>w.terminate()));
    try {
      if (directory) {
        if (path.dirname(directory) !== path.resolve(tmpdir()) || !path.basename(directory).startsWith('standrig-qa-')) throw Error('Invalid QA temporary directory');
        await rm(directory,{recursive:true,force:true});
      }
    } finally { await lease.release(); }
  }
}
