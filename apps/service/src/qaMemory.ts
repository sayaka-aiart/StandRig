import { createServer, type Server } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { freemem, homedir, hostname, tmpdir } from 'node:os';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const identity = createHash('sha256').update(homedir()).update(hostname()).digest();
const instance = randomUUID();
const defaults = {
  directory: path.join(process.env.LOCALAPPDATA || tmpdir(), `standrig-qa-memory-${identity.toString('hex').slice(0, 16)}`),
  port: 27000 + identity.readUInt16LE(0) % 2000,
  available: () => Math.min(freemem(), process.availableMemory?.() ?? Infinity)
};
interface Coordinator {
  directory: string;
  port: number;
  available(): number;
}
interface Lease { pid: number; instance: string; bytes: number }
export interface QaMemoryLease { workers: number; release(): Promise<void> }

// The listener is held only during metadata changes. The OS releases it on
// process death, so there is no stale-lock deletion race between services.
async function lock(port: number, signal?: AbortSignal): Promise<Server> {
  const deadline = performance.now() + 10_000;
  for (;;) {
    signal?.throwIfAborted();
    const server = createServer(socket => socket.destroy());
    const acquired = await new Promise<boolean>((resolve, reject) => {
      server.once('error', (error: NodeJS.ErrnoException) => error.code === 'EADDRINUSE' ? resolve(false) : reject(error));
      server.listen({ host: '127.0.0.1', port, exclusive: true }, () => resolve(true));
    });
    if (acquired) return server;
    if (performance.now() >= deadline) throw Error(`QA memory coordinator port ${port} is unavailable`);
    await delay(25, undefined, { signal });
  }
}
async function unlock(server: Server) {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
function alive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw error;
  }
}
async function reserved(directory: string) {
  const files = (await readdir(directory)).filter(name => /^[0-9a-f-]{36}\.json$/.test(name));
  if (files.length > 256) throw Error('Too many QA memory leases');
  let bytes = 0;
  for (const name of files) {
    const file = path.join(directory, name);
    const text = await readFile(file, 'utf8');
    if (text.length > 1024) throw Error('Invalid QA memory lease');
    const lease = JSON.parse(text) as Lease;
    if (!Number.isSafeInteger(lease.pid) || lease.pid < 1 || !Number.isSafeInteger(lease.bytes) || lease.bytes < 1 || typeof lease.instance !== 'string') throw Error('Invalid QA memory lease');
    if (!alive(lease.pid) || lease.pid === process.pid && lease.instance !== instance) await unlink(file);
    else bytes += lease.bytes;
  }
  return bytes;
}

/** Admission shared by updated services on this machine/user, regardless of port/data directory. */
export async function reserveQaMemory(perWorker: number, maximumWorkers: number, signal?: AbortSignal, waiting: () => void = () => {}, coordinator: Coordinator = defaults): Promise<QaMemoryLease> {
  if (!Number.isSafeInteger(perWorker) || perWorker < 1 || !Number.isSafeInteger(maximumWorkers) || maximumWorkers < 1) throw Error('Invalid QA memory reservation');
  await mkdir(coordinator.directory, { recursive: true });
  const file = path.join(coordinator.directory, randomUUID() + '.json');
  const deadline = performance.now() + 30 * 60 * 1000;
  let announced = false;
  for (;;) {
    const mutex = await lock(coordinator.port, signal);
    let workers = 0, peers = 0;
    try {
      signal?.throwIfAborted();
      peers = await reserved(coordinator.directory);
      // Free RAM already excludes resident workers. Counting reservations again
      // deliberately leaves headroom for growth, the parent service and other apps.
      const budget = Math.floor(coordinator.available() * .5);
      workers = Math.max(0, Math.min(maximumWorkers, Math.floor((budget - peers) / perWorker)));
      if (workers) {
        const temporary = file + '.tmp';
        try {
          await writeFile(temporary, JSON.stringify({ pid: process.pid, instance, bytes: workers * perWorker } satisfies Lease), { flag: 'wx' });
          await rename(temporary, file);
        } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      }
    } finally { await unlock(mutex); }
    if (workers) {
      let released = false;
      return { workers, async release() {
        if (released) return;
        // Cancellation must not prevent releasing an existing reservation.
        const mutex = await lock(coordinator.port);
        try { await unlink(file); released = true; } finally { await unlock(mutex); }
      } };
    }
    if (!peers) throw Error('QA memory budget is too small for one worker; free memory or reduce model size');
    if (performance.now() >= deadline) throw Error('Timed out waiting for the shared QA memory budget');
    if (!announced) { waiting(); announced = true; }
    await delay(200, undefined, { signal });
  }
}
