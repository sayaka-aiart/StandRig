import { MotionController } from './motion.js';
import type { MotionState } from '@standrig/core/motion';
import { parameterDefinitionsForRig, previewParameterValuesForRig } from '@standrig/core/parameters';
import type { ParameterValues, RigDocument } from '@standrig/core/types';
import { RigRuntime } from './renderer.js';

/** Input is already mapped into model coordinates. Camera/face inference stays outside. */
export interface ParameterFrame { source: string; sequence: number; values: ParameterValues }
export interface PlaybackSnapshot {
  version: 1; sessionId: string; revision: number; modelVersion: number;
  playing: boolean; values: ParameterValues; lastSource: string | null;
  physicsEpoch?: number; motion?: MotionState;
  demo?: { active: boolean; parameterIds: string[]; mode: 'showcase-active' | 'mouse-expression' };
}
export interface TrackingAdapter {
  start(emit: (frame: ParameterFrame) => void): Promise<void>;
  stop(): Promise<void>;
}
/** Capability discovery only. No Cubism implementation or format conversion is bundled. */
export interface BridgeAdapter {
  readonly id: string;
  capabilities(): Promise<readonly string[]>;
  disconnect(): Promise<void>;
}

/** Shared validation used by local playback and the HTTP input boundary. Rejects atomically. */
export function validateParameterPatch(rig: RigDocument, patch: unknown): ParameterValues {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('values must be an object');
  const definitions = new Map(parameterDefinitionsForRig(rig).map(p => [p.id, p]));
  const result: ParameterValues = {};
  for (const [id, value] of Object.entries(patch)) {
    const definition = definitions.get(id);
    if (!definition) throw new Error(`unknown parameter: ${id}`);
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`non-finite parameter: ${id}`);
    if (value < definition.min || value > definition.max) throw new Error(`out-of-range parameter: ${id}`);
    result[id] = value;
  }
  return result;
}

export type PlaybackRenderer = 'canvas' | 'webgl';

/** Browser-only player; no service, MCP, tracker or UI framework required. */
export class StandRigPlayer {
  private runtime: RigRuntime;
  private motion: MotionController;
  private values: ParameterValues;
  private frameId: number | undefined;
  private disposed = false;
  private renderer: PlaybackRenderer = 'canvas';
  private readonly resize: ResizeObserver;
  constructor(private canvas: HTMLCanvasElement, private rig: RigDocument) {
    this.motion = new MotionController(parameterDefinitionsForRig(rig));
    this.runtime = new RigRuntime(structuredClone(rig));
    this.values = previewParameterValuesForRig(rig);
    this.resize = new ResizeObserver(() => { if (!this.disposed && !this.playing) this.render(); });
    this.resize.observe(canvas);
  }
  async load() { await this.runtime.loadAssets(); if (!this.disposed) this.render(); }
  get playing() { return this.frameId !== undefined; }
  setRenderer(renderer: PlaybackRenderer) {
    if (renderer !== 'canvas' && renderer !== 'webgl') throw new Error('unknown playback renderer');
    this.renderer = renderer;
    if (!this.playing) this.render();
  }
  get rendererStatus() { return { requested: this.renderer, ...this.runtime.getWebGLMeshStatus() }; }
  get parameters() { return { ...this.values }; }
  setParameters(patch: ParameterValues) {
    const validated=validateParameterPatch(this.rig,patch);
    Object.assign(this.values,this.motion.external(validated),validated);
    if (!this.playing) this.render();
  }
  resetPhysics() { this.runtime.resetPhysics(); }
  loadMotion(clip:unknown) { const restore=this.motion.load(clip);this.pause();Object.assign(this.values,restore);this.resetPhysics();this.render();return this.motion.snapshot(); }
  get motionState() { return this.motion.snapshot(); }
  stopMotion() { Object.assign(this.values,this.motion.stop());this.pause();this.resetPhysics();this.render(); }
  clearMotion() { Object.assign(this.values,this.motion.clear());this.pause();this.resetPhysics();this.render(); }
  seekMotion(time:number) { Object.assign(this.values,this.motion.seek(time,this.values,performance.now()));this.resetPhysics();this.render(); }
  configureMotion(options:{speed?:number;loop?:boolean}) { Object.assign(this.values,this.motion.configure(options.speed,options.loop,performance.now()));this.render(); }
  reset() { this.motion.stop();this.values = previewParameterValuesForRig(this.rig); this.runtime.resetPhysics(); this.render(); }
  play() {
    if (this.disposed) return;
    if(this.motion.snapshot().loaded)Object.assign(this.values,this.motion.play(this.values,performance.now()));
    if (this.playing) return;
    this.runtime.resumeClock();
    const tick = () => { Object.assign(this.values,this.motion.tick(performance.now()));this.render(); this.frameId = requestAnimationFrame(tick); };
    this.frameId = requestAnimationFrame(tick);
  }
  pause() { if(this.motion.snapshot().loaded)Object.assign(this.values,this.motion.pause(performance.now()));if (this.frameId !== undefined) cancelAnimationFrame(this.frameId); this.frameId = undefined; this.render(); }
  private render() { if (!this.disposed) this.runtime.render(this.canvas, this.values, { transparent: true, webglWarp: this.renderer === 'webgl' }); }
  dispose() { this.pause(); this.disposed = true; this.resize.disconnect(); this.runtime.dispose(); }
}
