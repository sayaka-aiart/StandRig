import { CubismBridge } from './application/cubismBridge.js';
import { motionRequestSchema, facialRequestSchema } from '@standrig/contracts';
import { migrateRigDocument } from '@standrig/core/migration';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile,mkdir,readdir,readFile,realpath,writeFile,stat } from 'node:fs/promises';
import { createServer,type IncomingMessage,type ServerResponse } from 'node:http';
import path from 'node:path';
import { MODEL_BODY_LIMIT } from './httpLimits.js';
import { fileURLToPath } from 'node:url';
import { ApplicationError,ModelingService } from './application/modelingService.js';
import type { ApiHandler } from './host.js';
import { PlaybackSession } from './playback.js';
import { portableBundle } from './portableBundle.js';
import { registerModelingApi } from './rigApiPlugin.js';
import { transactionRoutes } from './routes/transactionRoutes.js';
import { ModelResponseCache } from './modelResponseCache.js';
import { readRequestBody } from './httpBody.js';
import { READ_ONLY_BODY_ROUTES } from '@standrig/contracts';
import { ModelingJobs } from './modelingJobs.js';

const json = (res: ServerResponse, status: number, data: unknown) => {
  if(res.destroyed||res.writableEnded)return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
};
async function body(req: IncomingMessage, limit = 1024 * 1024): Promise<Record<string, unknown>> {
  const text = await readRequestBody(req, limit);
  const value = JSON.parse(text || '{}');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected an object');
  return value;
}

/** One local service owns one data directory. Vite is used only to build/develop the optional UI. */
export async function createLocalService(options: { dataDir: string; port?: number; previewDir?: string; allowLegacyWrites?: boolean; bridgeSessionFile?: string; qaWorkers?: number; qaMemoryMiB?: number; checkpointLimit?:number; checkpointMiB?:number }) {
  if (options.qaWorkers !== undefined && (!Number.isInteger(options.qaWorkers) || options.qaWorkers < 1) || options.qaMemoryMiB !== undefined && (!Number.isFinite(options.qaMemoryMiB) || options.qaMemoryMiB <= 0)) throw Error('Invalid QA resource limits');
  const bridge = await CubismBridge.fromSessionFile(options.bridgeSessionFile);
  const dataDir = path.resolve(options.dataDir);
  const publicDir = path.join(dataDir, 'public');
  const rigPath = path.join(publicDir, 'rig.json');
  await mkdir(publicDir, { recursive: true });
  for (const name of ['rig.json','rig.schema.json']) {
    try { await copyFile(new URL(`../../../templates/${name}`, import.meta.url), path.join(publicDir, name), constants.COPYFILE_EXCL); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  const previewDir = options.previewDir ?? fileURLToPath(new URL('../../preview/dist/', import.meta.url));
  const readRig = async () => modelResponses.readOnlyRig();
  const handlers: { prefix: string; handler: ApiHandler }[] = [];
  let changeVersion = 0;
  const apiHost = {
    middlewares: { use(prefix: string, handler: ApiHandler) { handlers.push({ prefix, handler }); } },
    ws: { send() { changeVersion++; } }
  };
  const context = registerModelingApi(dataDir, apiHost, {allowLegacyWrites:options.allowLegacyWrites,qaOptions:{workers:options.qaWorkers,memoryMiB:options.qaMemoryMiB},checkpointOptions:{limit:options.checkpointLimit,memoryMiB:options.checkpointMiB}});
  const modelResponses = new ModelResponseCache(context);
  const playback = new PlaybackSession(await readRig());
  // Publish the validated, owned generation before any successful commit
  // response. Parallel reads must not observe stale facial/motion metadata.
  const application = new ModelingService(context, rig => playback.reload(rig));
  const jobs = new ModelingJobs(application, run=>scheduleWrite(run), async()=>{});
  transactionRoutes(application, apiHost);
  // Exact route boundaries avoid accidental dispatch into a parent route.
  handlers.sort((a, b) => b.prefix.length - a.prefix.length);
  const checkpointDir = path.join(dataDir, 'checkpoints');
  const checkpoint = () => application.checkpoint();
  async function staticFile(req: IncomingMessage, res: ServerResponse, base: string, relative: string) {
    const resolvedBase = await realpath(base);
    const candidate = path.resolve(resolvedBase, relative);
    if (!candidate.startsWith(resolvedBase + path.sep)) throw new Error('invalid asset path');
    const resolved = await realpath(candidate);
    if (!resolved.startsWith(resolvedBase + path.sep)) throw new Error('invalid asset link');
    const metadata = await stat(resolved, { bigint: true });
    const etag = `W/"${metadata.size}-${metadata.mtimeNs}-${metadata.ctimeNs}"`;
    res.setHeader('etag', etag);
    res.setHeader('cache-control', base === publicDir && /[a-f0-9]{64}\.[a-z]+$/i.test(relative) ? 'public, max-age=31536000, immutable' : 'no-cache');
    if (req.headers['if-none-match'] === etag) { res.writeHead(304); res.end(); return; }
    const bytes = req.method === 'HEAD' ? undefined : await readFile(resolved);
    const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };
    res.writeHead(200, { 'content-type': types[path.extname(resolved)] ?? 'application/octet-stream', 'content-length': String(metadata.size) });
    res.end(bytes);
  }
  async function dispatch(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const route = url.pathname;
    if (route === '/api/modeling/jobs' && req.method === 'POST') {
      if (!jobs.capacity()&&!jobs.hasKey(req.headers['idempotency-key'])) { json(res,429,{ok:false,error:'Modeling job queue is full'});return; }
      const input = JSON.parse(await readRequestBody(req,MODEL_BODY_LIMIT));
      const job=jobs.submit(input,typeof req.headers['idempotency-key']==='string'?req.headers['idempotency-key']:undefined);
      res.setHeader('location',`/api/modeling/jobs/${job.id}`);json(res,202,{ok:true,job});return;
    }
    if (route.startsWith('/api/modeling/jobs/')) {
      const id=route.slice('/api/modeling/jobs/'.length);
      if(req.method==='GET')json(res,200,{ok:true,job:jobs.get(id)});
      else if(req.method==='DELETE')json(res,200,{ok:true,job:jobs.cancel(id)});
      else json(res,405,{ok:false,error:'method_not_allowed'});
      return;
    }
    if(route==='/api/modeling/jobs'){json(res,405,{ok:false,error:'method_not_allowed'});return;}
    if (['GET','HEAD'].includes(req.method ?? '') && (route === '/api/rig' || route === '/api/context')) {
      await modelResponses.respond(req, res, route === '/api/context', url.searchParams.get('includeAssets') === '1',url.searchParams.get('packed')==='1'); return;
    }
    if (route === '/api/bridge/status' && req.method === 'GET') { json(res,200,{ok:true,result:await bridge.status()}); return; }
    if (route === '/api/bridge/read' && req.method === 'POST') { json(res,200,{ok:true,result:await bridge.call(await body(req),false)}); return; }
    if (route === '/api/bridge/pose' && req.method === 'POST') { json(res,200,{ok:true,result:await bridge.call(await body(req),true)}); return; }
    if (route === '/api/sample' && req.method === 'GET') {
      json(res, 200, JSON.parse(await readFile(new URL('../../../examples/sample.standrig.json', import.meta.url), 'utf8'))); return;
    }
    if (route === '/api/exports/bundle' && req.method === 'POST') {
      const bundle = await portableBundle(await readRig(), publicDir);
      const dir = path.join(dataDir, 'exports');
      await mkdir(dir, { recursive: true });
      const file = path.join(dir, `model-${randomUUID()}.standrig.json`);
      await writeFile(file, JSON.stringify(bundle), { flag: 'wx' });
      json(res, 201, { ok: true, path: file, format: 'standrig-bundle' }); return;
    }
    if (route === '/api/playback/facial' && req.method === 'GET') { json(res,200,{ok:true,presets:playback.facialCatalog(),playback:playback.snapshot()});return; }
    if (route === '/api/playback/facial' && req.method === 'POST') { json(res,200,{ok:true,playback:playback.facialCommand(facialRequestSchema.parse(await body(req)))});return; }
    if (route === '/api/playback/motion' && req.method === 'GET') { json(res,200,{ok:true,clip:playback.motionDocument(),playback:playback.snapshot()});return; }
    if (route === '/api/playback/motion' && req.method === 'POST') { json(res,200,{ok:true,playback:playback.motionCommand(motionRequestSchema.parse(await body(req, 16 * 1024 * 1024)))});return; }
    if (route === '/api/playback/events' && req.method === 'GET') { playback.subscribe(res, url.searchParams.get('delta') === '1'); return; }
    if (route === '/api/playback' && req.method === 'GET') { json(res, 200, { ok: true, playback: playback.snapshot() }); return; }
    if (route === '/api/playback/parameters' && req.method === 'POST') { json(res, 200, { ok: true, playback: playback.input(await body(req)) }); return; }
    if (route === '/api/playback/control' && req.method === 'POST') { const input = await body(req); json(res, 200, { ok: true, playback: playback.control(input.command, input) }); return; }
    if (route === '/api/playback/reload' && req.method === 'POST') {
      playback.reload(await readRig()); json(res, 200, { ok: true, playback: playback.snapshot() }); return;
    }
    if (route === '/api/checkpoints' && req.method === 'GET') {
      const checkpoints = await context.checkpoints.list();
      json(res, 200, { ok: true, checkpoints }); return;
    }
    if (route === '/api/checkpoints' && req.method === 'POST') { json(res, 201, { ok: true, checkpoint: await checkpoint() }); return; }
    if (route === '/api/checkpoints/restore' && req.method === 'POST') {
      const input = await body(req);
      if (typeof input.id !== 'string' || !/^[a-f0-9-]{36}$/.test(input.id)) throw new Error('invalid checkpoint id');
      const result = await application.execute({kind:'restore',checkpointId:input.id,expectedRevision:input.expectedRevision,commit:true});
      json(res,200,{...result,restored:input.id,revision:result.revisionAfter,rollback:result.rollbackCheckpoint}); return;
    }
    if (route.startsWith('/api/playback') || route.startsWith('/api/checkpoints')) { json(res, 405, { ok: false, error: 'method_or_route_not_supported' }); return; }
    const match = handlers.find(h => route === h.prefix || route.startsWith(h.prefix + '/'));
    if (match) {
      req.url = (route.slice(match.prefix.length) || '/') + url.search;
      const before = changeVersion;
      await match.handler(req, res);
      if (changeVersion !== before && !['GET','HEAD'].includes(req.method ?? '') && !READ_ONLY_BODY_ROUTES.has(route)) playback.reload(await readRig());
      return;
    }
    if (route.startsWith('/api/') || /^\/(obs|tracker|geometry-assist)(\/|$)/.test(route)) { json(res, 404, { ok: false, error: 'endpoint_not_in_distribution' }); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { json(res, 405, { ok: false, error: 'method_not_allowed' }); return; }
    try {
      if (route.startsWith('/assets/') && !route.endsWith('.js') && !route.endsWith('.css')) {
        await staticFile(req, res, publicDir, decodeURIComponent(route.slice(1)));
      } else {
        await staticFile(req, res, previewDir, route === '/' ? 'index.html' : route === '/player' ? 'player.html' : decodeURIComponent(route.slice(1)));
      }
    } catch { json(res, 404, { ok: false, error: 'file_not_found; build the preview before starting' }); }
  }
  // Writes retain CAS order. Reads use atomic saved snapshots and never wait behind QA.
  let queue: Promise<unknown> = Promise.resolve();
  function scheduleWrite<T>(run:()=>Promise<T>):Promise<T> { const result=queue.then(run,run);queue=result;return result; }
  const httpServer = createServer((req, res) => {
    res.setHeader('x-content-type-options', 'nosniff');
    const address = httpServer.address();
    const port = address && typeof address === 'object' ? address.port : 0;
    const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!allowedHosts.includes(req.headers.host ?? '')) { json(res, 403, { ok: false, error: 'host_not_allowed' }); return; }
    if (req.headers.origin && !allowedHosts.map(h => `http://${h}`).includes(req.headers.origin)) {
      json(res, 403, { ok: false, error: 'origin_not_allowed' }); return;
    }
    if (Number(req.headers['content-length'] ?? 0) > MODEL_BODY_LIMIT) { json(res, 413, { ok: false, error: 'body_too_large' }); return; }
    const run = async () => {
      if (req.aborted || res.destroyed) return;
      try { await dispatch(req, res); }
      catch (error) { if (!res.headersSent) json(res, error instanceof ApplicationError ? error.status : 400, { ok: false, error: String(error), ...(error instanceof ApplicationError ? error.details : {}) }); }
    };
    const route = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (['GET','HEAD'].includes(req.method ?? '') || (req.method === 'POST' && READ_ONLY_BODY_ROUTES.has(route)) || route.startsWith('/api/playback') || route==='/api/modeling/jobs' || route.startsWith('/api/modeling/jobs/')) { void run(); }
    else { void scheduleWrite(run); }
  });
  await new Promise<void>((resolve, reject) => { httpServer.once('error', reject); httpServer.listen(options.port ?? 5180, '127.0.0.1', resolve); });
  const address = httpServer.address();
  const port = address && typeof address === 'object' ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, httpServer, playback,
    async close() { jobs.close(); playback.close(); httpServer.closeAllConnections(); await new Promise<void>((resolve, reject) => httpServer.close(error => error ? reject(error) : resolve())); await queue.catch(()=>{}); } };
}
