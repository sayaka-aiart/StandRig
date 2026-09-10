import { parseTrackingProfile } from '@standrig/core/trackingProfile';
import type { RigDocument } from '@standrig/core/types';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ServerTransactionJournalEntry } from './modelingSupport.js';
export function createModelingContext(rootDir: string) {
    const publicDir = path.resolve(rootDir, 'public');
    const trackingProfilePath = path.join(publicDir, 'tracking-profile.json');
    return { rootDir, publicDir, rigPath: path.join(publicDir, 'rig.json'), schemaPath: path.join(publicDir, 'rig.schema.json'), trackingProfilePath,
        trackingRecordingsDir: path.join(publicDir, 'tracking-recordings'), trackingRunsDir: path.join(rootDir, 'tracking-runs'),
        assetManifestPath: path.join(publicDir, 'assets-manifest.json'), assetsDir: path.join(publicDir, 'assets'), goldenRoot: path.join(publicDir, 'goldens'),
        journal: [] as ServerTransactionJournalEntry[],
        async readTrackingProfileFile(rig: RigDocument) { try {
            return parseTrackingProfile(JSON.parse(await readFile(trackingProfilePath, 'utf8')), rig);
        }
        catch {
            return undefined;
        } }
    };
}
export type ModelingContext = ReturnType<typeof createModelingContext>;
