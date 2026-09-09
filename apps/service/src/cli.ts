import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalService } from './service.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const option = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const port = Number(option('--port') ?? process.env.STANDRIG_PORT ?? 5180);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
const service = await createLocalService({ dataDir: path.resolve(option('--data-dir') ?? process.env.STANDRIG_DATA_DIR ?? path.join(root, 'workspace')), port });
console.log(`StandRig local service: ${service.url}\nPlayer: ${service.url}/player`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void service.close().then(() => process.exit(0)); });
