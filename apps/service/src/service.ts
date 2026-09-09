import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, mkdir, writeFile, readdir, rename, realpath, copyFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateRigDocument } from '@standrig/core/migration';
import { validateRig } from '@standrig/core/inspect';
import { registerModelingApi, fullRigRevision } from './rigApiPlugin.js';
import { portableBundle } from './portableBundle.js';
import { PlaybackSession } from './playback.js';
import type { ApiHandler } from './host.js';

const json = (res: ServerResponse, status: number, data: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
};
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('body too large');
  }
  const value = JSON.parse(text || '{}');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected an object');
  return value;
}

/** One local service owns one data directory. Vite is used only to build/develop the optional UI. */
export async function createLocalService(options: { dataDir: string; port?: number; previewDir?: string }) {
  const dataDir = path.resolve(options.dataDir);
  const publicDir = path.join(dataDir, 'public');
  const rigPath = path.join(publicDir, 'rig.json');
  await mkdir(publicDir, { recursive: true });
  for (const name of ['rig.json','rig.schema.json']) {
    try { await copyFile(new URL(`../../../templates/${name}`, import.meta.url), path.join(publicDir, name), constants.COPYFILE_EXCL); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  const previewDir = options.previewDir ?? fileURLToPath(new URL('../../preview/dist/', import.meta.url));
  const readRig = async () => migrateRigDocument(JSON.parse(await readFile(rigPath, 'utf8')));
  const playback = new PlaybackSession(await readRig());
  const handlers: { prefix: string; handler: ApiHandler }[] = [];
  let changed = false;
  registerModelingApi(dataDir, {
    middlewares: { use(prefix, handler) { handlers.push({ prefix, handler }); } },
    ws: { send() { changed = true; } }
  });
  // Exact route boundaries avoid accidental dispatch into a parent route.
  handlers.sort((a, b) => b.prefix.length - a.prefix.length);
  const checkpointDir = path.join(dataDir, 'checkpoints');
  async function checkpoint() {
    await mkdir(checkpointDir, { recursive: true });
    const id = randomUUID();
    const rig = await readRig();
    const bundle = await portableBundle(rig, publicDir);
    const record = { id, createdAt: new Date().toISOString(), revision: fullRigRevision(rig), bundle };
    await writeFile(path.join(checkpointDir, `${id}.json`), JSON.stringify(record), { flag: 'wx' });
    return { id, createdAt: record.createdAt, revision: record.revision };
  }
  async function staticFile(res: ServerResponse, base: string, relative: string) {
    const resolvedBase = await realpath(base);
    const candidate = path.resolve(resolvedBase, relative);
    if (!candidate.startsWith(resolvedBase + path.sep)) throw new Error('invalid asset path');
    const resolved = await realpath(candidate);
    if (!resolved.startsWith(resolvedBase + path.sep)) throw new Error('invalid asset link');
    const bytes = await readFile(resolved);
    const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };
    res.writeHead(200, { 'content-type': types[path.extname(resolved)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(bytes);
  }
  async function dispatch(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const route = url.pathname;
    if (route === '/api/sample' && req.method === 'GET') {
      json(res, 200, JSON.parse(await readFile(new URL('../../../examples/sample.standrig.json', import.meta.url), 'utf8'))); return;
    }
    if (route === '/api/exports/bundle' && req.method === 'POST') {
      const bundle = await portableBundle(await readRig(), publicDir);
      const dir = path.join(dataDir, 'exports');
      await mkdir(dir, { recursive: true });
      const file = path.join(dir, `model-${randomUUID()}.standrig.json`);
      await writeFile(file, JSON.stringify(bundle, null, 2), { flag: 'wx' });
      json(res, 201, { ok: true, path: file, format: 'standrig-bundle' }); return;
    }
    if (route === '/api/playback/events' && req.method === 'GET') { playback.subscribe(res); return; }
    if (route === '/api/playback' && req.method === 'GET') { json(res, 200, { ok: true, playback: playback.snapshot() }); return; }
    if (route === '/api/playback/parameters' && req.method === 'POST') { json(res, 200, { ok: true, playback: playback.input(await body(req)) }); return; }
    if (route === '/api/playback/control' && req.method === 'POST') { json(res, 200, { ok: true, playback: playback.control((await body(req)).command) }); return; }
    if (route === '/api/playback/reload' && req.method === 'POST') {
      playback.reload(await readRig()); json(res, 200, { ok: true, playback: playback.snapshot() }); return;
    }
    if (route === '/api/checkpoints' && req.method === 'GET') {
      const checkpoints = [];
      for (const file of (await readdir(checkpointDir).catch(() => [])).filter(f => /^[a-f0-9-]{36}\.json$/.test(f))) {
        const record = JSON.parse(await readFile(path.join(checkpointDir, file), 'utf8'));
        checkpoints.push({ id: record.id, revision: record.revision, createdAt: record.createdAt });
      }
      json(res, 200, { ok: true, checkpoints }); return;
    }
    if (route === '/api/checkpoints' && req.method === 'POST') { json(res, 201, { ok: true, checkpoint: await checkpoint() }); return; }
    if (route === '/api/checkpoints/restore' && req.method === 'POST') {
      const input = await body(req);
      if (typeof input.id !== 'string' || !/^[a-f0-9-]{36}$/.test(input.id)) throw new Error('invalid checkpoint id');
      const current = await readRig();
      if (input.expectedRevision !== fullRigRevision(current)) { json(res, 409, { ok: false, error: 'revision-mismatch' }); return; }
      const record = JSON.parse(await readFile(path.join(checkpointDir, `${input.id}.json`), 'utf8'));
      const restored = migrateRigDocument(record.bundle.rig);
      if (!validateRig(restored).ok) throw new Error('checkpoint rig failed validation');
      const rollback = await checkpoint();
      const temporary = rigPath + '.' + randomUUID() + '.tmp';
      await writeFile(temporary, JSON.stringify(restored, null, 2) + '\n');
      await rename(temporary, rigPath);
      playback.reload(restored);
      json(res, 200, { ok: true, restored: input.id, revision: fullRigRevision(restored), rollback }); return;
    }
    if (route.startsWith('/api/playback') || route.startsWith('/api/checkpoints')) { json(res, 405, { ok: false, error: 'method_or_route_not_supported' }); return; }
    const match = handlers.find(h => route === h.prefix || route.startsWith(h.prefix + '/'));
    if (match) {
      req.url = (route.slice(match.prefix.length) || '/') + url.search;
      changed = false;
      await match.handler(req, res);
      if (changed) playback.reload(await readRig());
      return;
    }
    if (route.startsWith('/api/') || /^\/(obs|tracker|geometry-assist)(\/|$)/.test(route)) { json(res, 404, { ok: false, error: 'endpoint_not_in_distribution' }); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { json(res, 405, { ok: false, error: 'method_not_allowed' }); return; }
    try {
      if (route.startsWith('/assets/') && !route.endsWith('.js') && !route.endsWith('.css')) {
        await staticFile(res, publicDir, decodeURIComponent(route.slice(1)));
      } else {
        await staticFile(res, previewDir, route === '/' ? 'index.html' : route === '/player' ? 'player.html' : decodeURIComponent(route.slice(1)));
      }
    } catch { json(res, 404, { ok: false, error: 'file_not_found; build the preview before starting' }); }
  }
  // Serialize model reads/writes to make expectedRevision checks meaningful with several clients.
  let queue: Promise<unknown> = Promise.resolve();
  const httpServer = createServer((req, res) => {
    res.setHeader('x-content-type-options', 'nosniff');
    const address = httpServer.address();
    const port = address && typeof address === 'object' ? address.port : 0;
    const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!allowedHosts.includes(req.headers.host ?? '')) { json(res, 403, { ok: false, error: 'host_not_allowed' }); return; }
    if (req.headers.origin && !allowedHosts.map(h => `http://${h}`).includes(req.headers.origin)) {
      json(res, 403, { ok: false, error: 'origin_not_allowed' }); return;
    }
    if (Number(req.headers['content-length'] ?? 0) > 64 * 1024 * 1024) { json(res, 413, { ok: false, error: 'body_too_large' }); return; }
    const run = async () => {
      try { await dispatch(req, res); }
      catch (error) { if (!res.headersSent) json(res, 400, { ok: false, error: String(error) }); }
    };
    if ((req.url ?? '').startsWith('/api/playback')) { void run(); }
    else { queue = queue.then(run, run); }
  });
  await new Promise<void>((resolve, reject) => { httpServer.once('error', reject); httpServer.listen(options.port ?? 5180, '127.0.0.1', resolve); });
  const address = httpServer.address();
  const port = address && typeof address === 'object' ? address.port : 0;
  return { url: `http://127.0.0.1:${port}`, httpServer, playback,
    async close() { playback.close(); httpServer.closeAllConnections(); await new Promise<void>((resolve, reject) => httpServer.close(error => error ? reject(error) : resolve())); } };
}
