import { readFile } from 'node:fs/promises';
import { bridgeReadSchema, bridgePoseSchema } from '@standrig/contracts/bridge';

/** Optional server-side HTTP adapter. Credentials never cross the StandRig API boundary. */
export class CubismBridge {
  private constructor(private readonly url?: string, private readonly token?: string) {}
  static async fromSessionFile(file?: string) {
    if (!file) return new CubismBridge();
    try {
      const config = JSON.parse(await readFile(file, 'utf8'));
      const url = new URL(config.url);
      if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash || typeof config.token !== 'string' || !config.token || /[\r\n]/.test(config.token)) throw new Error();
      return new CubismBridge(url.origin, config.token);
    } catch { throw new Error('bridge_configuration_invalid'); }
  }
  private async request(endpoint: string, input?: unknown): Promise<any> {
    if (!this.url) throw new Error('bridge_not_configured');
    try {
      const response = await fetch(this.url + endpoint, {
        method: input === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: input === undefined ? undefined : JSON.stringify(input),
      });
      const value = await response.json();
      if (!response.ok || value.ok !== true) throw new Error();
      return value.result;
    } catch { throw new Error('bridge_request_failed; inspect Bridge locally; do not automatically retry writes'); }
  }
  async status() {
    if (!this.url) return { configured: false, connected: false };
    try {
      const status = await this.request('/v1/status');
      const caps = await this.request('/v1/capabilities');
      return { configured: true, connected: true, state: status.state, apiVersion: caps.apiVersion, supported: caps.apiVersion === '1.1.0' };
    } catch { return { configured: true, connected: false }; }
  }
  async call(input: unknown, pose: boolean) {
    const parsed = (pose ? bridgePoseSchema : bridgeReadSchema).parse(input);
    const status = await this.status();
    if (!status.connected || !status.supported || status.state !== 'idle') throw new Error('bridge_not_ready; requires supported idle Bridge');
    return this.request(pose ? '/v1/call' : '/v1/read', parsed);
  }
}
