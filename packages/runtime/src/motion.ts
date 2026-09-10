import { parseMotion, sampleMotion, validateMotionParameters, type MotionClip, type MotionState } from '@standrig/core/motion';
import type { ParameterDefinition, ParameterValues } from '@standrig/core/types';
/** A monotonic-clock transport shared by embedded and service playback. One clip owns only its tracks. */
export class MotionController {
    private clip: MotionClip | undefined;
    private base: ParameterValues = {};
    private active = false;
    private running = false;
    private ended = false;
    private time = 0;
    private speed = 1;
    private loop = false;
    private last = 0;
    constructor(private parameters: ParameterDefinition[]) { this.parameters = structuredClone(parameters); }
    private checkClock(now: number) { if (!Number.isFinite(now))
        throw Error('motion clock must be finite'); }
    snapshot(): MotionState { return { loaded: !!this.clip, name: this.clip?.name ?? null, duration: this.clip?.duration ?? 0, time: this.time, running: this.running, active: this.active, ended: this.ended, speed: this.speed, loop: this.loop, parameterIds: this.clip?.tracks.map(t => t.parameter) ?? [] }; }
    document() { return this.clip ? structuredClone(this.clip) : null; }
    prepare(value: unknown) { const clip = parseMotion(value); validateMotionParameters(clip, this.parameters); return clip; }
    load(value: unknown) { const clip = this.prepare(value), restore = this.stop(); this.clip = clip; this.speed = 1; this.loop = false; return restore; }
    private requireClip() { if (!this.clip)
        throw Error('no motion loaded'); return this.clip; }
    private activate(values: ParameterValues) { const clip = this.requireClip(); if (!this.active) {
        this.base = Object.fromEntries(clip.tracks.map(t => [t.parameter, values[t.parameter] ?? this.parameters.find(p => p.id === t.parameter)!.default]));
        this.active = true;
    } }
    play(values: ParameterValues, now: number) { this.checkClock(now); const clip = this.requireClip(); if (this.running)
        return this.tick(now); this.activate(values); if (this.ended || this.time >= clip.duration)
        this.time = 0; this.ended = false; this.running = true; this.last = now; return sampleMotion(clip, this.time); }
    tick(now: number) {
        this.checkClock(now);
        if (!this.running || !this.clip)
            return {};
        const elapsed = Math.max(0, now - this.last) / 1000;
        this.last = now;
        this.time += elapsed * this.speed;
        if (this.time >= this.clip.duration) {
            if (this.loop)
                this.time %= this.clip.duration;
            else {
                this.time = this.clip.duration;
                this.running = false;
                this.ended = true;
            }
        }
        return sampleMotion(this.clip, this.time);
    }
    pause(now: number) { this.checkClock(now); this.requireClip(); const patch = this.tick(now); this.running = false; return patch; }
    seek(time: number, values: ParameterValues, now: number) { this.checkClock(now); const clip = this.requireClip(); if (!Number.isFinite(time) || time < 0 || time > clip.duration)
        throw Error('seek outside motion duration'); this.activate(values); this.time = time; this.last = now; this.ended = time === clip.duration; if (this.ended && !this.loop)
        this.running = false; return sampleMotion(clip, time); }
    configure(speed: number | undefined, loop: boolean | undefined, now: number) { this.checkClock(now); this.requireClip(); if (speed !== undefined && (!Number.isFinite(speed) || speed < 0.1 || speed > 4))
        throw Error('motion speed must be in [0.1,4]'); if (loop !== undefined && typeof loop !== 'boolean')
        throw Error('invalid motion loop'); const patch = this.tick(now); if (speed !== undefined)
        this.speed = speed; if (loop !== undefined)
        this.loop = loop; return patch; }
    stop() { const restore = this.active ? { ...this.base } : {}; this.active = false; this.running = false; this.ended = false; this.time = 0; this.base = {}; return restore; }
    clear() { const restore = this.stop(); this.clip = undefined; return restore; }
    external(patch: ParameterValues) { return this.active && this.clip?.tracks.some(t => Object.hasOwn(patch, t.parameter)) ? this.stop() : {}; }
}
