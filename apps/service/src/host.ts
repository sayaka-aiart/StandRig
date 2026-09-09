import type { IncomingMessage, ServerResponse } from 'node:http';

export type ApiHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
export interface ApiHost {
  middlewares: { use(path: string, handler: ApiHandler): void };
  ws: { send(event: { type: 'full-reload' }): void };
}
