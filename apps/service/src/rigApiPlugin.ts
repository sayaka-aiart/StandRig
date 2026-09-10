import { READ_ONLY_BODY_ROUTES } from '@standrig/contracts';
export { READ_ONLY_BODY_ROUTES } from '@standrig/contracts';
import type { ApiHost } from './host.js';
import { assetRoutes } from './routes/assetRoutes.js';
import { analysisRoutes } from './routes/analysisRoutes.js';
import { modelingRoutes } from './routes/modelingRoutes.js';
import { rigRoutes } from './routes/rigRoutes.js';
import { createModelingContext } from './application/context.js';
import { sendJson } from './application/modelingSupport.js';
export { fullRigRevision } from './application/modelingSupport.js';
// Only handlers audited as read-only may accept request bodies by default.
export function registerModelingApi(rootDir: string, server: ApiHost, options: {
    allowLegacyWrites?: boolean;
} = {}) {
    const context = createModelingContext(rootDir);
    const guarded: ApiHost = { ws: server.ws, middlewares: { use(route, handler) {
                server.middlewares.use(route, async (req, res) => {
                    const method = req.method ?? 'GET';
                    if (!options.allowLegacyWrites && method !== 'GET' && !(method === 'POST' && READ_ONLY_BODY_ROUTES.has(route))) {
                        sendJson(res, 403, { ok: false, error: 'legacy_write_api_disabled', transaction: '/api/modeling/transaction' });
                        return;
                    }
                    await handler(req, res);
                });
            } } };
    for (const register of [assetRoutes, analysisRoutes, modelingRoutes, rigRoutes])
        register(context, guarded);
    return context;
}
