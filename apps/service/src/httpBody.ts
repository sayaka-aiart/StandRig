import type { IncomingMessage } from 'node:http';
import { createGunzip, createBrotliDecompress } from 'node:zlib';

/** Bound both wire and expanded bytes; compressed requests do not bypass route limits. */
export async function readRequestBody(req: IncomingMessage, limit: number): Promise<string> {
  const encoding = req.headers['content-encoding']?.trim().toLowerCase() ?? 'identity';
  if (!['identity', 'gzip', 'br'].includes(encoding)) throw Error('unsupported_content_encoding');
  if (Number(req.headers['content-length'] ?? 0) > limit) throw Error(`request_body_too_large:${limit}`);
  const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'br' ? createBrotliDecompress() : undefined;
  let wire = 0, expanded = 0;
  const chunks: Buffer[] = [];
  const abort = () => decoder?.destroy(Error('request_aborted'));
  const failed = (error: Error) => decoder?.destroy(error);
  const count = (chunk: Buffer) => { wire += chunk.length; if (wire > limit) decoder?.destroy(Error(`request_body_too_large:${limit}`)); };
  req.once('aborted', abort);
  req.once('error',failed);
  req.once('close',()=>req.off('error',failed));
  const source = decoder ? req.pipe(decoder) : req;
  if (decoder) req.on('data', count);
  try {
    for await (const chunk of source) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      expanded += bytes.length;
      if (expanded > limit) throw Error(`request_body_too_large:${limit}`);
      chunks.push(bytes);
    }
    if (req.aborted) throw Error('request_aborted');
    return Buffer.concat(chunks, expanded).toString('utf8');
  } finally {
    req.off('aborted', abort); req.off('data', count);
    if (decoder) { req.unpipe(decoder); decoder.destroy(); }
  }
}
