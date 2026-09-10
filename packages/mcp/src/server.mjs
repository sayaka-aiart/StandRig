import { transactionSchema } from '@standrig/contracts';
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { readFile } from 'node:fs/promises';

const repository = new URL('../../../', import.meta.url);
const documents = {
  contract: 'AGENTS.md', guide: 'AI_OPERATING_GUIDE.md', operations: 'docs/OPERATIONS.md',
  architecture: 'docs/ARCHITECTURE.md', adapters: 'docs/ADAPTERS.md', api: 'docs/API.md'
};
const values = z.record(z.string(), z.number().finite());
const qa = z.looseObject({
  poses: z.array(z.string()).optional(),
  poseSamples: z.array(z.object({ poseId: z.string(), values })).optional(),
  regions: z.array(z.string()).default(['full']),
  width: z.number().int().min(64).max(480).default(240),
  height: z.number().int().min(64).max(480).default(240), physics: z.boolean().default(false)
});

export function createStandRigMcp(baseUrl = 'http://127.0.0.1:5180') {
  const url = new URL(baseUrl);
  if (url.protocol !== 'http:' || !['127.0.0.1','localhost','[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('STANDRIG_URL must be a loopback HTTP origin');
  }
  const server = new McpServer({ name: 'standrig', version: '0.2.0' });
  let qaEvidence;
  let sequence = Date.now();
  const source = `mcp_${process.pid}`;
  async function request(endpoint, method = 'GET', data) {
    const response = await fetch(new URL(endpoint, url), {
      method, redirect: 'error', signal: AbortSignal.timeout(120000),
      headers: data === undefined ? undefined : { 'content-type': 'application/json' },
      body: data === undefined ? undefined : JSON.stringify(data)
    });
    if (response.headers.get('content-type')?.startsWith('image/png')) {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return { content: [{ type: 'image', mimeType: 'image/png', data: Buffer.from(await response.arrayBuffer()).toString('base64') }] };
    }
    const result = await response.json();
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result,
      ...(!response.ok || result.ok === false ? { isError: true } : {}) };
  }
  function tool(name, description, inputSchema, readOnly, handler) {
    server.registerTool(name, { description, inputSchema, annotations: {
      readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: false
    } }, async input => {
      try { return await handler(input); }
      catch (error) { return { isError: true, content: [{ type: 'text', text: String(error) }] }; }
    });
  }
  for (const [name, relative] of Object.entries(documents)) {
    server.registerResource(name, `standrig://docs/${name}`, { mimeType: 'text/markdown' }, async uri => ({
      contents: [{ uri: uri.href, mimeType: 'text/markdown', text: await readFile(new URL(relative, repository), 'utf8') }]
    }));
  }
  tool('standrig_context', 'Start here. Compact model revision, roles and capabilities; no embedded assets.', z.object({}), true, () => request('/api/context'));
  tool('standrig_changes', 'Poll since the confirmed stored revision. Resync context only if requested.', z.object({ since: z.string().min(1) }), true, input => request(`/api/changes?since=${encodeURIComponent(input.since)}`));
  tool('standrig_inspect', 'Read compact model metadata or a confirmed part/deformer. Read standrig://docs/operations before editing.', z.object({
    kind: z.enum(['summary','parts','deformers','audit','parameters','validation','poses','techniques','roles','reference']), id: z.string().min(1).optional()
  }), true, ({ kind, id }) => {
    const routes = { summary: '/api/rig/summary', parts: '/api/parts', deformers: '/api/deformers', audit: '/api/modeling/audit', parameters: '/api/params', validation: '/api/rig/validate', poses: '/api/modeling', techniques: '/api/modeling/techniques', roles: '/api/modeling/role-suggestions', reference: '/api/reference' };
    if (id && !['parts','deformers'].includes(kind)) throw new Error('id is valid only for parts/deformers');
    return request(routes[kind] + (id ? '/' + encodeURIComponent(id) : ''));
  });
  tool('standrig_modeling_transaction', 'Dry-run by default. Commit requires current revision and numeric QA; the service creates a rollback checkpoint after validation. Follow the visual-reference contract in the guide; numerical success is not visual acceptance.', transactionSchema, false, async input => {
    const result = await request('/api/modeling/transaction', 'POST', input);
    if (input.commit) qaEvidence = undefined;
    return result;
  });
  tool('standrig_qa_check', 'Run numeric QA before requesting images; maximum-pose visual review is still required.', qa, true, async input => {
    const result = await request('/api/qa/check', 'POST', input);
    qaEvidence = { revision: result.structuredContent?.revision, failed: result.structuredContent?.failed ?? [], failureRegions: result.structuredContent?.failureRegions ?? [], ok: !result.isError };
    return result;
  });
  tool('standrig_render', 'After QA on the current revision, request one PNG. Failure images require a failed pose/region pair. Use 240px diagnostics.', z.object({
    kind: z.enum(['snapshot','failure','reference']), poseId: z.string().optional(), region: z.string().optional(), values: values.optional(), set: z.string().optional()
  }), true, async input => {
    const context = await request('/api/context');
    if (!qaEvidence || qaEvidence.revision !== context.structuredContent?.context?.revision) throw new Error('Run standrig_qa_check on the current stored revision first');
    if (input.kind === 'failure') {
      if (!qaEvidence.failed.some(f => f.poseId === input.poseId && f.region === input.region)) throw new Error('poseId/region must be in the last QA failed list');
      const failure = qaEvidence.failureRegions.find(f => f.poseId === input.poseId && f.region === input.region);
      if (!failure?.imageRequest) throw new Error('QA did not return a reproducible failure image request');
      return request('/api/qa/failure-image', 'POST', { ...failure.imageRequest, width: 240, height: 240 });
    }
    if (!qaEvidence.ok) throw new Error('QA failed; use kind=failure for a returned failed region');
    if (input.kind === 'reference') {
      if (!input.set) throw new Error('Read standrig_inspect kind=reference and supply an available sheet set');
      return request('/api/reference/sheet?' + new URLSearchParams({ set: input.set, physics: '0' }));
    }
    const query = new URLSearchParams({ width: '240', height: '240', physics: '0' });
    for (const [key, value] of Object.entries(input.values ?? {})) query.set(key, String(value));
    return request('/api/screenshot?' + query);
  });
  tool('standrig_checkpoint', 'Create or list persistent self-contained rollback checkpoints in the local data directory.', z.object({ action: z.enum(['create','list']) }), false,
    ({ action }) => request('/api/checkpoints', action === 'create' ? 'POST' : 'GET', action === 'create' ? {} : undefined));
  tool('standrig_restore', 'Restore a checkpoint against the expected current revision. Saves the current model as another checkpoint first.', z.object({ id: z.string().uuid(), expectedRevision: z.string().min(1) }), false,
    input => { qaEvidence = undefined; return request('/api/checkpoints/restore', 'POST', input); });
  tool('standrig_export', 'Write a self-contained StandRig bundle to the local exports directory and return its path. No Cubism conversion.', z.object({}), false, () => request('/api/exports/bundle', 'POST', {}));
  tool('standrig_playback_state', 'Read transient playback state and connected outputs. An open output connection does not prove successful rendering or OBS capture.', z.object({}), true, () => request('/api/playback'));
  tool('standrig_playback_parameters', 'Set a pose/expression without modifying the model file. External trackers stream directly to the runtime/input API, outside MCP.', z.object({ values }), false,
    input => request('/api/playback/parameters', 'POST', { source, sequence: ++sequence, values: input.values }));
  tool('standrig_playback_control', 'Play, pause, reset or reload. demo-start runs Showcase Fast & Wide or Mouse + Expressions; demo-stop restores the starting pose. demo-pointer supplies normalized mouse x/y. Manual parameter input stops the demo. View in preview or /player.', z.object({ command: z.enum(['play','pause','reset','reload','demo-start','demo-stop','demo-pointer']), mode: z.enum(['showcase-active','mouse-expression']).optional(), x: z.number().min(-1).max(1).optional(), y: z.number().min(-1).max(1).optional() }), false,
    (input) => request(input.command === 'reload' ? '/api/playback/reload' : '/api/playback/control', 'POST', input));
  return server;
}
