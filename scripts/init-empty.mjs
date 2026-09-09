import { writeFile, mkdir } from 'node:fs/promises';
import { DEFAULT_PARAMETERS } from '@standrig/core/parameters';
import { RIG_SCHEMA_VERSION, DEFAULT_TRANSFORM } from '@standrig/core/types';

export function emptyRig() {
  return {
    schemaVersion: RIG_SCHEMA_VERSION, name: 'Untitled model',
    stage: { width: 900, height: 1200, background: 'transparent' },
    assets: [], parameters: structuredClone(DEFAULT_PARAMETERS),
    parts: [{ id: 'root', name: 'Root', kind: 'group', parentId: null, visible: true, drawOrder: -10000, transform: { ...DEFAULT_TRANSFORM, pivotX: 0, pivotY: 0 } }],
    physics: { enabled: false, chains: [] }, deformers: []
  };
}
if (process.argv.includes('--create')) {
  await mkdir('public', { recursive: true });
  // Never replace an existing user's model.
  await writeFile('public/rig.json', JSON.stringify(emptyRig(), null, 2) + '\n', { flag: 'wx' });
}
