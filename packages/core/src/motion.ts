import type { MotionClip, MotionTrack } from './motionTypes.js';
import type { ParameterDefinition, ParameterValues } from './types.js';
export * from './motionTypes.js';
function object(value: unknown, keys: string[]): asserts value is Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k)))
    throw Error('invalid motion object/unknown field'); }
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
export function parseMotion(value: unknown): MotionClip {
    object(value, ['format', 'version', 'name', 'duration', 'tracks']);
    if (value.format !== 'standrig-motion' || value.version !== 1)
        throw Error('unsupported motion format/version; Live2D conversion is not installed');
    if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 160 || !finite(value.duration) || value.duration <= 0 || value.duration > 3600)
        throw Error('invalid motion name/duration');
    if (!Array.isArray(value.tracks) || !value.tracks.length || value.tracks.length > 256)
        throw Error('motion requires 1..256 tracks');
    const ids = new Set<string>();
    let total = 0;
    for (const track of value.tracks) {
        object(track, ['parameter', 'keys']);
        if (typeof track.parameter !== 'string' || !track.parameter || track.parameter.length > 160 || ids.has(track.parameter))
            throw Error('invalid/duplicate motion parameter');
        ids.add(track.parameter);
        if (!Array.isArray(track.keys) || !track.keys.length || track.keys.length > 4096 || (total += track.keys.length) > 50000)
            throw Error('invalid motion key count');
        for (let i = 0; i < track.keys.length; i++) {
            const key = track.keys[i];
            object(key, ['time', 'value', 'segment']);
            if (!finite(key.time) || !finite(key.value) || key.time < 0 || key.time > value.duration || (i && key.time <= track.keys[i - 1].time))
                throw Error('motion keys must have finite values and strictly increasing times');
            if (key.segment !== undefined) {
                object(key.segment, ['kind', 'control1', 'control2']);
                const s = key.segment;
                if (!['linear', 'hold', 'inverse-hold', 'bezier'].includes(String(s.kind)))
                    throw Error('unsupported motion segment');
                if (i === track.keys.length - 1)
                    throw Error('last motion key cannot have an outgoing segment');
                if (s.kind === 'bezier') {
                    for (const c of [s.control1, s.control2]) {
                        object(c, ['time', 'value']);
                        if (!finite(c.time) || !finite(c.value))
                            throw Error('invalid bezier controls');
                    }
                    const a = s.control1 as {
                        time: number;
                    }, b = s.control2 as {
                        time: number;
                    };
                    if (a.time < key.time || b.time < a.time || b.time > track.keys[i + 1].time)
                        throw Error('bezier control times must be monotone within the segment');
                }
                else if (s.control1 !== undefined || s.control2 !== undefined)
                    throw Error('unexpected segment controls');
            }
        }
    }
    return structuredClone(value) as unknown as MotionClip;
}
export function validateMotionParameters(clip: MotionClip, parameters: ParameterDefinition[]) {
    const defs = new Map(parameters.map(p => [p.id, p]));
    for (const track of clip.tracks) {
        const p = defs.get(track.parameter);
        if (!p)
            throw Error('unknown motion parameter: ' + track.parameter);
        for (const key of track.keys) {
            const values = [key.value, ...(key.segment?.kind === 'bezier' ? [key.segment.control1.value, key.segment.control2.value] : [])];
            if (values.some(v => v < p.min || v > p.max))
                throw Error('motion values/control hull outside model range: ' + p.id);
        }
    }
}
const cubic = (a: number, b: number, c: number, d: number, t: number) => { const u = 1 - t; return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d; };
export function sampleMotionTrack(track: MotionTrack, time: number): number {
    const keys = track.keys;
    if (time <= keys[0].time)
        return keys[0].value;
    if (time >= keys[keys.length - 1].time)
        return keys[keys.length - 1].value;
    let lo = 0, hi = keys.length - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (keys[mid].time <= time)
            lo = mid;
        else
            hi = mid;
    }
    const a = keys[lo], b = keys[hi], kind = a.segment?.kind ?? 'linear';
    if (time === a.time)
        return a.value;
    if (kind === 'hold')
        return a.value;
    if (kind === 'inverse-hold')
        return b.value;
    if (a.segment?.kind === 'bezier') {
        const s = a.segment;
        let left = 0, right = 1;
        for (let i = 0; i < 45; i++) {
            const t = (left + right) / 2;
            if (cubic(a.time, s.control1.time, s.control2.time, b.time, t) < time)
                left = t;
            else
                right = t;
        }
        return cubic(a.value, s.control1.value, s.control2.value, b.value, (left + right) / 2);
    }
    const fraction = (time - a.time) / (b.time - a.time);
    return (1 - fraction) * a.value + fraction * b.value;
}
/** Sample a previously validated clip. Values before/after a track's keys hold endpoints. */
export function sampleMotion(clip: MotionClip, time: number): ParameterValues { if (!Number.isFinite(time))
    throw Error('invalid motion sample time'); return Object.fromEntries(clip.tracks.map(t => [t.parameter, sampleMotionTrack(t, time)])); }
export interface MotionImportIssue {
    code: string;
    message: string;
    path?: string;
}
export interface MotionImportContext {
    parameterMap: Readonly<Record<string, string>>;
}
/** Future motion3 adapter converts to this representation; it must report every unsupported/lossy feature. */
export interface MotionImporter {
    readonly format: string;
    convert(source: unknown, context: MotionImportContext): {
        clip: unknown;
        issues: MotionImportIssue[];
    };
}
export function importMotionWith(source: unknown, importer: MotionImporter, context: MotionImportContext, parameters: ParameterDefinition[]): {
    clip: MotionClip;
    sourceFormat: string;
} {
    const result = importer.convert(structuredClone(source), { parameterMap: { ...context.parameterMap } });
    if (!Array.isArray(result.issues) || result.issues.length)
        throw Error('motion import refused: ' + JSON.stringify(result.issues));
    const clip = parseMotion(result.clip);
    validateMotionParameters(clip, parameters);
    return { clip, sourceFormat: importer.format };
}
