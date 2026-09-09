import { parameterDefinitionsForRig, previewParameterValuesForRig } from '@standrig/core/parameters';
import type { ParameterValues, RigDocument } from '@standrig/core/types';
import { RigRuntime } from './renderer.js';

/** Input is already mapped into model coordinates. Camera/face inference stays outside. */
export interface ParameterFrame { source: string; sequence: number; values: ParameterValues }
export interface PlaybackSnapshot {
  version: 1; revision: number; modelVersion: number;
  playing: boolean; values: ParameterValues; lastSource: string | null;
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

/** Browser-only player; no service, MCP, tracker or UI framework required. */
export class StandRigPlayer {
  private runtime: RigRuntime;
  private values: ParameterValues;
  private frameId: number | undefined;
  private disposed = false;
  private readonly resize: ResizeObserver;
  constructor(private canvas: HTMLCanvasElement, private rig: RigDocument) {
    this.runtime = new RigRuntime(structuredClone(rig));
    this.values = previewParameterValuesForRig(rig);
    this.resize = new ResizeObserver(() => { if (!this.disposed && !this.playing) this.render(); });
    this.resize.observe(canvas);
  }
  async load() { await this.runtime.loadAssets(); if (!this.disposed) this.render(); }
  get playing() { return this.frameId !== undefined; }
  get parameters() { return { ...this.values }; }
  setParameters(patch: ParameterValues) {
    Object.assign(this.values, validateParameterPatch(this.rig, patch));
    if (!this.playing) this.render();
  }
  reset() { this.values = previewParameterValuesForRig(this.rig); this.runtime.resetPhysics(); this.render(); }
  play() {
    if (this.disposed || this.playing) return;
    this.runtime.resumeClock();
    const tick = () => { this.render(); this.frameId = requestAnimationFrame(tick); };
    this.frameId = requestAnimationFrame(tick);
  }
  pause() { if (this.frameId !== undefined) cancelAnimationFrame(this.frameId); this.frameId = undefined; }
  private render() { if (!this.disposed) this.runtime.render(this.canvas, this.values, { transparent: true }); }
  dispose() { this.pause(); this.disposed = true; this.resize.disconnect(); }
}
