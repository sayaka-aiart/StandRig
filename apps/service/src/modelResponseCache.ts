import { fileStamp as stamp } from './fileStamp.js';
import { createHash } from 'node:crypto';
import { gzip, brotliCompress, constants } from 'node:zlib';
import { promisify } from 'node:util';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ModelingContext } from './application/context.js';
import { compactContextForRig, fullRigRevision, readRigFile, sanitizeRigAssetPayload } from './application/modelingSupport.js';
import { packRigDocument } from '@standrig/core/packedRig';

const zip = promisify(gzip), brotli = promisify(brotliCompress);
function accepted(header: string = '') {
  const q = new Map(header.split(',').filter(Boolean).map(token => { const [name, ...params] = token.trim().toLowerCase().split(';'); const value = params.find(p => p.trim().startsWith('q='))?.trim().slice(2); return [name.trim(), value === undefined ? 1 : Math.max(0, Math.min(1, Number(value) || 0))]; }));
  const score = (name: string) => q.get(name) ?? q.get('*') ?? 0;
  const compressed=['br', 'gzip'].filter(name => score(name) > 0).sort((a,b) => score(b)-score(a))[0];
  if(q.has('identity')&&q.get('identity')!>(compressed?score(compressed):0))return 'identity';
  return compressed ?? ((q.get('identity') ?? (q.get('*') === 0 ? 0 : 1)) > 0 ? 'identity' : undefined);
}
type Snapshot = { stamp: string; revision: string; rig: Awaited<ReturnType<typeof readRigFile>>; context?: ReturnType<typeof compactContextForRig>; views: Map<string, Buffer>; compressed: Map<string, Promise<Buffer>> };

/** One generation and its derived responses. Never hand this rig to a mutable editor. */
export class ModelResponseCache {
  private current?: Snapshot;
  private pending?: { stamp: string; value: Promise<Snapshot> };
  constructor(private context: ModelingContext) {}
  /** Internal read-only snapshot shared with playback; mutable editors must clone. */
  async readOnlyRig() { return (await this.snapshot()).rig; }
  private async snapshot(): Promise<Snapshot> {
    const version = await stamp(this.context.rigPath);
    if (this.current?.stamp === version) return this.current;
    if (this.pending?.stamp === version) return this.pending.value;
    const value = (async () => {
      const rig = await readRigFile(this.context.rigPath);
      if (await stamp(this.context.rigPath) !== version) return this.snapshot();
      const result: Snapshot = { stamp: version, revision: fullRigRevision(rig), rig, views: new Map(), compressed: new Map() };
      this.current = result; return result;
    })();
    this.pending = { stamp: version, value };
    try { return await value; } finally { if (this.pending?.value === value) this.pending = undefined; }
  }
  async respond(req: IncomingMessage, res: ServerResponse, contextOnly: boolean, includeAssets: boolean, packed = false) {
    const snapshot = await this.snapshot();
    const history = this.context.journal.slice(-12);
    const view = contextOnly ? `context:${history.at(-1)?.id ?? ''}` : (includeAssets ? 'full' : 'sanitized')+(packed?':packed':'');
    const etag = `W/"${createHash('sha256').update(snapshot.revision + view).digest('hex')}"`;
    res.setHeader('etag', etag); res.setHeader('vary', 'Accept-Encoding');
    res.setHeader('cache-control', 'private, max-age=0, must-revalidate');
    if (req.headers['if-none-match']?.split(',').some(v => v.trim() === '*' || v.trim().replace(/^W\//, '') === etag.slice(2))) { res.writeHead(304); res.end(); return; }
    const encoding = accepted(req.headers['accept-encoding']);
    if (!encoding) { res.writeHead(406); res.end(); return; }
    let bytes = snapshot.views.get(view);
    if (!bytes) {
      const rig=contextOnly||includeAssets?snapshot.rig:{...snapshot.rig,assets:snapshot.rig.assets.map(asset=>({...asset,src:asset.src.startsWith('data:')?`asset://${asset.id}`:asset.src}))};
      const value = contextOnly ? { ok: true, context: { ...(snapshot.context ??= compactContextForRig(snapshot.rig,[],snapshot.revision)), operationHistory: { scope: 'server-memory', available: true, entries: history } } } : packed?packRigDocument(rig):rig;
      bytes = Buffer.from(JSON.stringify(value));
      if (contextOnly) { for (const key of snapshot.views.keys()) if (key.startsWith('context:')) snapshot.views.delete(key);for(const key of snapshot.compressed.keys())if(key.startsWith('context:'))snapshot.compressed.delete(key); }
      snapshot.views.set(view, bytes);
    }
    if (encoding !== 'identity') {
      const key = `${view}:${encoding}`;
      let compressed = snapshot.compressed.get(key);
      if (!compressed) {
        compressed = encoding === 'br' ? brotli(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } }) : zip(bytes);
        snapshot.compressed.set(key, compressed);
        compressed.catch(() => snapshot.compressed.delete(key));
      }
      bytes = await compressed; res.setHeader('content-encoding', encoding);
    }
    if (res.destroyed) return;
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': bytes.length });
    res.end(req.method === 'HEAD' ? undefined : bytes);
  }
}
