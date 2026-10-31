import { parentPort, workerData } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { runQaCheck } from '@standrig/core/qaCheck';
import { migrateRigDocument } from '@standrig/core/migration';
const rig = migrateRigDocument(JSON.parse(await readFile(workerData.file, 'utf8')));
parentPort!.on('message', async request => {
  try { parentPort!.postMessage({ result: await runQaCheck(rig, workerData.publicDir, request) }); }
  catch (error) { parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
});
parentPort!.postMessage({ ready: true });
