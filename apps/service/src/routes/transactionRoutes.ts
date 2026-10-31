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
            const controller = new AbortController();
            const abort = () => controller.abort();
            res.once('close',abort);
            try { sendJson(res, 200, await application.execute(parseJsonObject(await readBody(req)),{owned:true,signal:controller.signal})); }
            finally { res.off('close',abort); }
        }
        catch (error) {
            sendJson(res, error instanceof ApplicationError ? error.status : 400, { ok: false, committed: false, error: error instanceof Error ? error.message : String(error), ...(error instanceof ApplicationError ? error.details : {}) });
        }
    });
}
