import { ApplicationError, ModelingService } from '../application/modelingService.js';
import { parseJsonObject, readBody, sendJson } from '../application/modelingSupport.js';
import type { ApiHost } from '../host.js';
export function transactionRoutes(application: ModelingService, server: ApiHost) {
    server.middlewares.use('/api/modeling/transaction', async (req, res) => {
        if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/') {
            sendJson(res, 404, { ok: false, error: 'unknown transaction route' });
            return;
        }
        if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'method not allowed; use POST' });
            return;
        }
        try {
            sendJson(res, 200, await application.execute(parseJsonObject(await readBody(req))));
        }
        catch (error) {
            sendJson(res, error instanceof ApplicationError ? error.status : 400, { ok: false, committed: false, error: error instanceof Error ? error.message : String(error), ...(error instanceof ApplicationError ? error.details : {}) });
        }
    });
}
