import type { PlaybackSnapshot } from './playback.js';
type Snapshot = PlaybackSnapshot & Record<string, unknown>;
export interface PlaybackPacket { protocol: 2; kind: 'full' | 'delta'; sequence: number; baseSequence?: number; state: Record<string, unknown> }
export class PlaybackEncoder {
  private previous?: Snapshot;
  private sequence = 0;
  encode(next: Snapshot): PlaybackPacket {
    const previous = this.previous;
    const full = !previous || previous.sessionId !== next.sessionId || previous.modelVersion !== next.modelVersion;
    const state: Record<string, unknown> = {};
    if (full) Object.assign(state, next);
    else for (const [key, value] of Object.entries(next)) {
      if (key === 'parameters') continue;
      if (key === 'values' || key === 'baseValues') {
        const old = (previous[key] ?? {}) as Record<string, unknown>;
        const patch = Object.fromEntries(Object.entries(value as object).filter(([id, v]) => v !== old[id]));
        if (Object.keys(patch).length) state[key] = patch;
      } else if (JSON.stringify(value) !== JSON.stringify(previous[key])) state[key] = value;
    }
    this.previous = next;
    const baseSequence = this.sequence++;
    return { protocol: 2, kind: full ? 'full' : 'delta', sequence: this.sequence, ...(full ? {} : { baseSequence }), state };
  }
}
export class PlaybackDecoder {
  private state?: Snapshot;
  private sequence = 0;
  accept(input: PlaybackPacket | Snapshot): Snapshot {
    if(!input||typeof input!=='object')throw Error('Invalid playback packet');
    const legacy=input as Snapshot;
    if(!('protocol' in input)&&legacy.version===1&&typeof legacy.sessionId==='string'&&Number.isSafeInteger(legacy.modelVersion)&&Number.isSafeInteger(legacy.revision)&&legacy.values&&typeof legacy.values==='object'&&!Array.isArray(legacy.values)){
      this.state=legacy;this.sequence=0;return this.state;
    }
    const packet=input as PlaybackPacket;
    if (!packet || packet.protocol !== 2 || !['full','delta'].includes(packet.kind) || !packet.state || typeof packet.state!=='object' || Array.isArray(packet.state) || !Number.isSafeInteger(packet.sequence) || packet.sequence < 1) throw Error('Invalid playback packet');
    if (packet.kind === 'full') { this.state = packet.state as Snapshot; }
    else {
      if (!this.state || packet.baseSequence !== this.sequence || packet.sequence !== this.sequence + 1) throw Error('Playback delta gap; reconnect for a full snapshot');
      this.state = { ...this.state, ...packet.state, values: { ...this.state.values, ...(packet.state.values as object ?? {}) }, baseValues: { ...this.state.baseValues, ...(packet.state.baseValues as object ?? {}) } };
    }
    this.sequence = packet.sequence; return this.state;
  }
}
