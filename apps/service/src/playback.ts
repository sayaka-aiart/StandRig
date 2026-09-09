import type { ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { parameterDefinitionsForRig, previewParameterValuesForRig } from '@standrig/core/parameters';
import type { RigDocument } from '@standrig/core/types';
import { validateParameterPatch, type PlaybackSnapshot } from '@standrig/runtime/playback';
import { demoParameters, sampleDemo } from '@standrig/runtime/demo';
import { MOTION_PREVIEW_MODES, type MotionPreviewMode } from '@standrig/runtime/motionPreview';

export class PlaybackSession {
  private sequences = new Map<string, number>();
  private streams = new Set<ServerResponse>();
  private state: PlaybackSnapshot;
  private demoTimer: ReturnType<typeof setInterval> | undefined;
  private demoBase: { values: PlaybackSnapshot['values']; playing: boolean; lastSource: string | null } | undefined;
  private demoDefinitions: ReturnType<typeof demoParameters>;
  private demoMode: MotionPreviewMode = 'showcase-active';
  private pointer = { x: 0, y: 0 };
  private smoothedPointer = { x: 0, y: 0 };
  constructor(private rig: RigDocument) {
    this.demoDefinitions = demoParameters(rig);
    this.state = { version: 1, sessionId: randomUUID(), revision: 0, modelVersion: 0, playing: false,
      values: previewParameterValuesForRig(rig), lastSource: null };
  }
  snapshot() { return { ...this.state, values: { ...this.state.values }, connectedOutputs: this.streams.size,
    parameters: parameterDefinitionsForRig(this.rig), outputAcknowledged: false,
    demo: { active: !!this.demoTimer, parameterIds: this.demoDefinitions.map(p => p.id), mode: this.demoMode } }; }
  private stopDemo() {
    if (this.demoTimer) clearInterval(this.demoTimer);
    this.demoTimer = undefined;
    if (this.demoBase) Object.assign(this.state, this.demoBase);
    this.demoBase = undefined;
    this.pointer = { x: 0, y: 0 }; this.smoothedPointer = { x: 0, y: 0 };
  }
  private startDemo() {
    if (this.demoTimer) return;
    if (!this.demoDefinitions.length) throw new Error('No authored parameter bindings; load the sample or rig the PSD first.');
    this.demoBase = { values: { ...this.state.values }, playing: this.state.playing, lastSource: this.state.lastSource };
    const base = this.demoBase.values;
    const started = performance.now();
    this.state.playing = true;
    this.state.lastSource = 'standrig_demo';
    this.demoTimer = setInterval(() => {
      this.smoothedPointer.x += (this.pointer.x - this.smoothedPointer.x) * 0.82;
      this.smoothedPointer.y += (this.pointer.y - this.smoothedPointer.y) * 0.82;
      this.state.values = sampleDemo(parameterDefinitionsForRig(this.rig), base, this.demoMode, (performance.now() - started) / 1000, this.smoothedPointer);
      this.broadcast();
    }, 1000 / 30);
    this.demoTimer.unref();
  }
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
    this.stopDemo();
    Object.assign(this.state.values, patch);
    this.sequences.set(source, sequence);
    this.state.lastSource = source;
    this.broadcast();
    return this.snapshot();
  }
  control(command: unknown, options: Record<string, unknown> = {}) {
    if (!['play','pause','reset','demo-start','demo-stop','demo-pointer'].includes(String(command))) throw new Error('invalid playback command');
    if (command === 'demo-pointer') {
      const { x, y } = options;
      if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 1 || Math.abs(y) > 1) throw new Error('pointer x/y must be finite numbers in [-1,1]');
      if (!this.demoTimer || this.demoMode !== 'mouse-expression') throw new Error('mouse-expression demo is not active');
      this.pointer = { x, y };
      return this.snapshot();
    }
    if (command === 'demo-start') {
      const mode = options.mode ?? 'showcase-active';
      if (!MOTION_PREVIEW_MODES.includes(mode as MotionPreviewMode)) throw new Error('invalid demo mode');
      if (mode !== this.demoMode) this.stopDemo();
      this.demoMode = mode as MotionPreviewMode;
      this.startDemo();
    }
    else this.stopDemo();
    if (command === 'play') this.state.playing = true;
    if (command === 'pause') this.state.playing = false;
    if (command === 'reset') { this.state.values = previewParameterValuesForRig(this.rig); this.state.lastSource = null; }
    this.broadcast();
    return this.snapshot();
  }
  reload(rig: RigDocument) {
    this.stopDemo(); this.demoDefinitions = demoParameters(rig);
    this.rig = rig; this.sequences.clear(); this.state.modelVersion++;
    this.state.values = previewParameterValuesForRig(rig); this.state.lastSource = null;
    this.broadcast();
  }
  close() { this.stopDemo(); for (const stream of this.streams) stream.end(); this.streams.clear(); }
}
