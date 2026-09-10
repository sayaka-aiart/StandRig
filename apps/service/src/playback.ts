import { MotionController } from '@standrig/runtime/motion';
import type { MotionRequest } from '@standrig/core/motion';
import type { ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { parameterDefinitionsForRig, previewParameterValuesForRig } from '@standrig/core/parameters';
import type { RigDocument } from '@standrig/core/types';
import { validateParameterPatch, type PlaybackSnapshot } from '@standrig/runtime/playback';
import { demoParameters, sampleDemo } from '@standrig/runtime/demo';
import { MOTION_PREVIEW_MODES, type MotionPreviewMode } from '@standrig/runtime/motionPreview';

export class PlaybackSession {
  private motion:MotionController;
  private motionTimer:ReturnType<typeof setInterval>|undefined;
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
    this.motion=new MotionController(parameterDefinitionsForRig(rig));
    this.demoDefinitions = demoParameters(rig);
    this.state = { version: 1, sessionId: randomUUID(), revision: 0, modelVersion: 0, playing: false,
      physicsEpoch:0,values: previewParameterValuesForRig(rig), lastSource: null };
  }
  snapshot() { return { ...this.state, values: { ...this.state.values }, connectedOutputs: this.streams.size,
    parameters: parameterDefinitionsForRig(this.rig), outputAcknowledged: false,
    motion:this.motion.snapshot(),
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
    Object.assign(this.state.values,this.motion.external(patch), patch);
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
      Object.assign(this.state.values,this.motion.stop());this.syncMotionTimer();
      if (mode !== this.demoMode) this.stopDemo();
      this.demoMode = mode as MotionPreviewMode;
      this.startDemo();
    }
    else this.stopDemo();
    if (command === 'play') { if(this.motion.snapshot().loaded)Object.assign(this.state.values,this.motion.play(this.state.values,performance.now()));this.state.playing = true; }
    if (command === 'pause') { if(this.motion.snapshot().loaded)Object.assign(this.state.values,this.motion.pause(performance.now()));this.state.playing = false; }
    if (command === 'reset') { this.motion.stop();this.state.physicsEpoch=(this.state.physicsEpoch??0)+1;this.state.values = previewParameterValuesForRig(this.rig); this.state.lastSource = null; }
    this.syncMotionTimer();
    this.broadcast();
    return this.snapshot();
  }
  private syncMotionTimer() {
    if(!this.motion.snapshot().running){if(this.motionTimer)clearInterval(this.motionTimer);this.motionTimer=undefined;return;}
    if(this.motionTimer)return;
    this.motionTimer=setInterval(()=>{Object.assign(this.state.values,this.motion.tick(performance.now()));this.syncMotionTimer();this.broadcast();},1000/30);this.motionTimer.unref();
  }
  motionDocument(){return this.motion.document();}
  motionCommand(input:MotionRequest){
    const now=performance.now();
    if(input.action==='load'){this.motion.prepare(input.clip);this.stopDemo();Object.assign(this.state.values,this.motion.load(input.clip));this.state.playing=false;}
    else if(input.action==='play'){if(!this.motion.snapshot().loaded)throw Error('no motion loaded');this.stopDemo();Object.assign(this.state.values,this.motion.play(this.state.values,now));this.state.playing=true;}
    else if(input.action==='pause'){if(!this.motion.snapshot().loaded)throw Error('no motion loaded');this.stopDemo();Object.assign(this.state.values,this.motion.pause(now));this.state.playing=false;}
    else if(input.action==='stop'||input.action==='clear'){this.stopDemo();Object.assign(this.state.values,input.action==='stop'?this.motion.stop():this.motion.clear());this.state.playing=false;}
    else if(input.action==='seek'){const motion=this.motion.snapshot();if(!motion.loaded||!Number.isFinite(input.time)||input.time<0||input.time>motion.duration)throw Error('seek outside loaded motion duration');this.stopDemo();Object.assign(this.state.values,this.motion.seek(input.time,this.state.values,now));this.state.playing=this.motion.snapshot().running;}
    else if(input.action==='configure'){Object.assign(this.state.values,this.motion.configure(input.speed,input.loop,now));}
    else throw Error('invalid motion command');
    if(['load','seek','stop','clear'].includes(input.action))this.state.physicsEpoch=(this.state.physicsEpoch??0)+1;
    if(input.action!=='configure'||this.motion.snapshot().active)this.state.lastSource=this.motion.snapshot().active?'standrig_motion':null;
    this.syncMotionTimer();this.broadcast();return this.snapshot();
  }
  reload(rig: RigDocument) {
    this.motion.clear();this.syncMotionTimer();this.motion=new MotionController(parameterDefinitionsForRig(rig));
    this.state.physicsEpoch=(this.state.physicsEpoch??0)+1;
    this.stopDemo(); this.demoDefinitions = demoParameters(rig);
    this.rig = rig; this.sequences.clear(); this.state.modelVersion++;
    this.state.values = previewParameterValuesForRig(rig); this.state.lastSource = null;
    this.broadcast();
  }
  close() { this.motion.clear();this.syncMotionTimer();this.stopDemo(); for (const stream of this.streams) stream.end(); this.streams.clear(); }
}
