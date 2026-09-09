#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createStandRigMcp } from './server.mjs';

const handle = serveStdio(() => createStandRigMcp(process.env.STANDRIG_URL), {
  onerror: error => console.error('StandRig MCP:', error.message)
});
for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => { void handle.close().then(() => process.exit(0)); });
