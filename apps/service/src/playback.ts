import type { ServerResponse } from 'node:http';
import { parameterDefinitionsForRig, previewParameterValuesForRig } from '@standrig/core/parameters';
import type { RigDocument } from '@standrig/core/types';
import { validateParameterPatch, type PlaybackSnapshot } from '@standrig/runtime/playback';

export class PlaybackSession {
  private sequences = new Map<string, number>();
  private streams = new Set<ServerResponse>();
  private state: PlaybackSnapshot;
  constructor(private rig: RigDocument) {
    this.state = { version: 1, revision: 0, modelVersion: 0, playing: false,
      values: previewParameterValuesForRig(rig), lastSource: null };
  }
  snapshot() { return { ...this.state, values: { ...this.state.values }, connectedOutputs: this.streams.size,
    parameters: parameterDefinitionsForRig(this.rig), outputAcknowledged: false }; }
  private broadcast() {
    this.state.revision++;
    const message = `event: playback\ndata: ${JSON.stringify(this.snapshot())}\n\n`;
    for (const stream of this.streams) {
      // A stalled output must not accumulate an unbounded stream of tracking frames.
      if (!stream.write(message)) { this.streams.delete(stream); stream.destroy(); }
    }
  }
  subscribe(res: ServerResponse) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'connection': 'keep-alive' });
    this.streams.add(res);
    res.write(`event: playback\ndata: ${JSON.stringify(this.snapshot())}\n\n`);
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
    res.on('close', () => { clearInterval(heartbeat); this.streams.delete(res); });
  }
  input(body: Record<string, unknown>) {
    const { source, sequence, values } = body;
    if (typeof source !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(source)) throw new Error('invalid source');
    if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 0) throw new Error('invalid sequence');
    const previous = this.sequences.get(source);
    if (previous !== undefined && sequence <= previous) throw new Error('stale sequence');
    if (!this.sequences.has(source) && this.sequences.size >= 64) throw new Error('too many sources; reload model');
    const patch = validateParameterPatch(this.rig, values);
    Object.assign(this.state.values, patch);
    this.sequences.set(source, sequence);
    this.state.lastSource = source;
    this.broadcast();
    return this.snapshot();
  }
  control(command: unknown) {
    if (!['play','pause','reset'].includes(String(command))) throw new Error('invalid playback command');
    if (command === 'play') this.state.playing = true;
    if (command === 'pause') this.state.playing = false;
    if (command === 'reset') { this.state.values = previewParameterValuesForRig(this.rig); this.state.lastSource = null; }
    this.broadcast();
    return this.snapshot();
  }
  reload(rig: RigDocument) {
    this.rig = rig; this.sequences.clear(); this.state.modelVersion++;
    this.state.values = previewParameterValuesForRig(rig); this.state.lastSource = null;
    this.broadcast();
  }
  close() { for (const stream of this.streams) stream.end(); this.streams.clear(); }
}
