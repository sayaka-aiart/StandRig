import { FacialController } from '@standrig/runtime/facial';
import type { FacialRequest } from '@standrig/core/facial';
import { MotionController } from '@standrig/runtime/motion';
import type { MotionRequest } from '@standrig/core/motion';
import type { ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { parameterDefinitionsForRig, previewParameterValuesForRig } from '@standrig/core/parameters';
import type { RigDocument } from '@standrig/core/types';
import { validateParameterPatch, type PlaybackSnapshot } from '@standrig/runtime/playback';
import { demoParameters, sampleDemo } from '@standrig/runtime/demo';
import { MOTION_PREVIEW_MODES, type MotionPreviewMode } from '@standrig/runtime/motionPreview';
import { PlaybackEncoder } from '@standrig/runtime/playbackWire';
import { startFrameTimer, type FrameTimer } from './frameTimer.js';

export class PlaybackSession {
  private facial:FacialController;
  private facialTimer:FrameTimer|undefined;
  private baseValues:PlaybackSnapshot["values"];
  private motion:MotionController;
  private motionTimer:FrameTimer|undefined;
  private sequences = new Map<string, number>();
  private streams = new Set<ServerResponse>();
  private encoders = new Map<ServerResponse, PlaybackEncoder>();
  /** Backed-up outputs waiting for 'drain'; the value records whether a frame was skipped meanwhile. */
  private congested = new Map<ServerResponse, boolean>();
  private state: PlaybackSnapshot;
  private demoTimer: FrameTimer | undefined;
  private demoBase: { values: PlaybackSnapshot['values']; playing: boolean; lastSource: string | null } | undefined;
  private demoDefinitions: ReturnType<typeof demoParameters>;
  private parameterCatalogue: ReturnType<typeof parameterDefinitionsForRig>;
  private demoMode: MotionPreviewMode = 'showcase-active';
  private pointer = { x: 0, y: 0 };
  private smoothedPointer = { x: 0, y: 0 };
  constructor(private rig: RigDocument) {
    this.parameterCatalogue=parameterDefinitionsForRig(rig);
    this.facial=new FacialController(rig);
    this.baseValues=previewParameterValuesForRig(rig);
    this.motion=new MotionController(parameterDefinitionsForRig(rig));
    this.demoDefinitions = demoParameters(rig);
    this.state = { version: 1, sessionId: randomUUID(), revision: 0, modelVersion: 0, playing: false,
      physicsEpoch:0,values: previewParameterValuesForRig(rig), lastSource: null };
  }
  snapshot(ownedMetadata=false) { const now=performance.now();return { ...this.state, values:this.facial.evaluate(this.baseValues,now),baseValues:{...this.baseValues},facial:this.facial.snapshot(now), connectedOutputs: this.streams.size,
    parameters: ownedMetadata?this.parameterCatalogue:structuredClone(this.parameterCatalogue), outputAcknowledged: false,
    motion:this.motion.snapshot(), inputContractVersion:2,
    demo: { active: !!this.demoTimer, parameterIds: this.demoDefinitions.map(p => p.id), mode: this.demoMode } }; }
  private stopDemo() {
    this.demoTimer?.stop();
    this.demoTimer = undefined;
    if (this.demoBase) {this.baseValues={...this.demoBase.values};this.state.playing=this.demoBase.playing;this.state.lastSource=this.demoBase.lastSource;}
    this.demoBase = undefined;
    this.pointer = { x: 0, y: 0 }; this.smoothedPointer = { x: 0, y: 0 };
  }
  private startDemo() {
    if (this.demoTimer) return;
    if (!this.demoDefinitions.length) throw new Error('No authored parameter bindings; load the sample or rig the PSD first.');
    this.demoBase = { values: { ...this.baseValues }, playing: this.state.playing, lastSource: this.state.lastSource };
    const base = this.demoBase.values;
    const started = performance.now();
    this.state.playing = true;
    this.state.lastSource = 'standrig_demo';
    this.demoTimer = startFrameTimer(() => {
      this.smoothedPointer.x += (this.pointer.x - this.smoothedPointer.x) * 0.82;
      this.smoothedPointer.y += (this.pointer.y - this.smoothedPointer.y) * 0.82;
      this.baseValues = sampleDemo(this.parameterCatalogue, base, this.demoMode, (performance.now() - started) / 1000, this.smoothedPointer);
      this.broadcast();
    });
    this.demoTimer.unref();
  }
  private broadcast() {
    this.state.revision++;
    const snapshot = this.snapshot(true);
    for (const stream of this.streams) this.send(stream, snapshot);
  }
  // A slow output must not accumulate an unbounded queue of frames, but it must not be dropped either: every
  // snapshot carries the whole state (and the parameter catalogue), so a few queued frames of a large model reach
  // the high-water mark during normal playback. While a stream is backed up, skip frames; once it drains, send the
  // current state so a skipped final frame (stop, pause, model change) is never lost.
  private send(stream: ServerResponse, snapshot: ReturnType<PlaybackSession['snapshot']>) {
    if (stream.destroyed) { this.streams.delete(stream); this.congested.delete(stream); return; }
    if (this.congested.has(stream)) { this.congested.set(stream, true); return; }
    const payload = this.encoders.get(stream)?.encode(snapshot) ?? snapshot;
    if (stream.write(`event: playback\ndata: ${JSON.stringify(payload)}\n\n`)) return;
    this.congested.set(stream, false);
    stream.once('drain', () => {
      const skipped = this.congested.get(stream);
      this.congested.delete(stream);
      if (skipped && this.streams.has(stream)) this.send(stream, this.snapshot(true));
    });
  }
  subscribe(res: ServerResponse, delta = false) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'connection': 'keep-alive' });
    this.streams.add(res);
    if (delta) this.encoders.set(res, new PlaybackEncoder());
    this.send(res, this.snapshot(true));
    const heartbeat = setInterval(() => {if(!res.destroyed&&!res.writableLength&&!this.congested.has(res))res.write(': heartbeat\n\n');}, 15000);
    res.on('close', () => { clearInterval(heartbeat); this.streams.delete(res); this.congested.delete(res); this.encoders.delete(res); });
  }
  input(body: Record<string, unknown>) {
    const { source, sequence, values } = body;
    if (body.expectedSessionId !== undefined && body.expectedSessionId !== this.state.sessionId) throw new Error('playback session changed');
    if (body.expectedModelVersion !== undefined && body.expectedModelVersion !== this.state.modelVersion) throw new Error('playback model changed');
    if (typeof source !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(source)) throw new Error('invalid source');
    if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 0) throw new Error('invalid sequence');
    const previous = this.sequences.get(source);
    if (previous !== undefined && sequence <= previous) throw new Error('stale sequence');
    if (!this.sequences.has(source) && this.sequences.size >= 64) throw new Error('too many sources; reload model');
    const patch = validateParameterPatch(this.rig, values);
    this.stopDemo();
    Object.assign(this.baseValues,this.motion.external(patch), patch);
    this.syncMotionTimer();
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
      if(!this.demoDefinitions.length)throw Error('No authored parameter bindings; load the sample or rig the PSD first.');
      Object.assign(this.baseValues,this.motion.stop());this.syncMotionTimer();
      if (mode !== this.demoMode) this.stopDemo();
      this.demoMode = mode as MotionPreviewMode;
      this.startDemo();
    }
    else this.stopDemo();
    if (command === 'play') { if(this.motion.snapshot().loaded)Object.assign(this.baseValues,this.motion.play(this.baseValues,performance.now()));this.state.playing = true; }
    if (command === 'pause') { if(this.motion.snapshot().loaded)Object.assign(this.baseValues,this.motion.pause(performance.now()));this.state.playing = false; }
    if (command === 'reset') { this.facial.reset();this.syncFacialTimer();this.motion.stop();this.state.physicsEpoch=(this.state.physicsEpoch??0)+1;this.baseValues = previewParameterValuesForRig(this.rig); this.state.lastSource = null; }
    this.syncMotionTimer();
    this.broadcast();
    return this.snapshot();
  }
  private syncMotionTimer() {
    if(!this.motion.snapshot().running){this.motionTimer?.stop();this.motionTimer=undefined;return;}
    if(this.motionTimer)return;
    this.motionTimer=startFrameTimer(()=>{Object.assign(this.baseValues,this.motion.tick(performance.now()));this.syncMotionTimer();this.broadcast();});this.motionTimer.unref();
  }
  private syncFacialTimer(){
    if(!this.facial.snapshot(performance.now()).transitioning){this.facialTimer?.stop();this.facialTimer=undefined;return;}
    if(this.facialTimer)return;
    this.facialTimer=startFrameTimer(()=>{this.broadcast();this.syncFacialTimer();});this.facialTimer.unref();
  }
  facialCatalog(){return this.facial.catalog();}
  facialCommand(request:FacialRequest){this.facial.command(request,performance.now());this.syncFacialTimer();this.broadcast();return this.snapshot();}
  motionDocument(){return this.motion.document();}
  motionCommand(input:MotionRequest){
    const now=performance.now();
    if(input.action==='load'){this.motion.prepare(input.clip);this.stopDemo();Object.assign(this.baseValues,this.motion.load(input.clip));this.state.playing=false;}
    else if(input.action==='play'){if(!this.motion.snapshot().loaded)throw Error('no motion loaded');this.stopDemo();Object.assign(this.baseValues,this.motion.play(this.baseValues,now));this.state.playing=true;}
    else if(input.action==='pause'){if(!this.motion.snapshot().loaded)throw Error('no motion loaded');this.stopDemo();Object.assign(this.baseValues,this.motion.pause(now));this.state.playing=false;}
    else if(input.action==='stop'||input.action==='clear'){this.stopDemo();Object.assign(this.baseValues,input.action==='stop'?this.motion.stop():this.motion.clear());this.state.playing=false;}
    else if(input.action==='seek'){const motion=this.motion.snapshot();if(!motion.loaded||!Number.isFinite(input.time)||input.time<0||input.time>motion.duration)throw Error('seek outside loaded motion duration');this.stopDemo();Object.assign(this.baseValues,this.motion.seek(input.time,this.baseValues,now));this.state.playing=this.motion.snapshot().running;}
    else if(input.action==='configure'){Object.assign(this.baseValues,this.motion.configure(input.speed,input.loop,now));}
    else throw Error('invalid motion command');
    if(['load','seek','stop','clear'].includes(input.action))this.state.physicsEpoch=(this.state.physicsEpoch??0)+1;
    if(input.action!=='configure'||this.motion.snapshot().active)this.state.lastSource=this.motion.snapshot().active?'standrig_motion':null;
    this.syncMotionTimer();this.broadcast();return this.snapshot();
  }
  reload(rig: RigDocument) {
    this.parameterCatalogue=parameterDefinitionsForRig(rig);
    this.facial.reset();this.syncFacialTimer();this.facial=new FacialController(rig);
    this.motion.clear();this.syncMotionTimer();this.motion=new MotionController(parameterDefinitionsForRig(rig));
    this.state.physicsEpoch=(this.state.physicsEpoch??0)+1;
    this.stopDemo(); this.demoDefinitions = demoParameters(rig);
    this.rig = rig; this.sequences.clear(); this.state.modelVersion++;
    this.baseValues = previewParameterValuesForRig(rig); this.state.lastSource = null;
    this.broadcast();
  }
  close() { this.facial.reset();this.syncFacialTimer();this.motion.clear();this.syncMotionTimer();this.stopDemo(); for (const stream of this.streams) stream.end(); this.streams.clear(); this.congested.clear(); this.encoders.clear(); }
}
