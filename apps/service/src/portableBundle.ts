import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createModelBundle } from '@standrig/core/bundle';
import type { RigDocument } from '@standrig/core/types';

/** Embed local PNG assets so the exported bundle survives moving to another PC. */
export async function portableBundle(rig: RigDocument, publicDir: string) {
  const candidate = structuredClone(rig);
  const root = await realpath(publicDir);
  for (const asset of candidate.assets) {
    if (asset.src.startsWith('data:')) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(asset.src)) throw new Error('Bundle requires local PNG assets: ' + asset.id);
    const resolved = path.resolve(root, asset.src.replace(/^\/+/, ''));
    if (!resolved.startsWith(root + path.sep)) throw new Error('Asset path escaped public directory');
    const actual = await realpath(resolved);
    if (!actual.startsWith(root + path.sep)) throw new Error('Asset link escaped public directory');
    const bytes = await readFile(actual);
    if (!bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('Bundle requires PNG assets: ' + asset.id);
    asset.src = 'data:image/png;base64,' + bytes.toString('base64');
  }
  return createModelBundle(candidate);
}
