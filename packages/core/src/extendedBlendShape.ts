import { sampleArtMeshBlendShapeWeight } from './artMeshBlendShape.js';
import { isParameterInterpolation, sampleBinding } from './bindings.js';
import type { BlendWeight, DeformerBlendShape, ExtendedBlendShape, TransformDelta } from './deformTypes.js';
import type { ParameterValues, RigDocument, RigSharedWarpField, Transform2D } from './types.js';
export const blendWeight = (shape: BlendWeight, values: ParameterValues) => sampleArtMeshBlendShapeWeight(shape, values[shape.parameter] ?? shape.neutralInput);
export function applyTransformShapes(pose: Transform2D, shapes: Array<BlendWeight & {
    transform?: TransformDelta;
}> | undefined, values: ParameterValues) {
    for (const shape of shapes ?? []) {
        const w = blendWeight(shape, values);
        for (const [key, value] of Object.entries(shape.transform ?? {})) {
            const property = key as keyof TransformDelta;
            if (property === 'scaleX' || property === 'scaleY')
                pose[property] *= Math.pow(value, w);
            else
                pose[property] += value * w;
        }
    }
}
export function resolveSharedShape(field: RigSharedWarpField | undefined, shapes: DeformerBlendShape[] | undefined, values: ParameterValues) {
    if (!field || (!shapes?.some(s => s.sharedPoints?.length) && !field.controlPoints.some(p=>p.bindings?.length)))
        return field;
    const result = structuredClone(field);
    for (const point of result.controlPoints) for(const binding of (point.bindings??[]).slice(0,16)) {
        const value=sampleBinding(binding,values[binding.parameter]??0);
        point[binding.property]=binding.additive===false?value:point[binding.property]+value;
    }
    for (const shape of shapes ?? [])
        for (const delta of shape.sharedPoints ?? []) {
            const point = result.controlPoints.find(p => p.id === delta.id);
            if (point) {
                const w = blendWeight(shape, values);
                point.offsetX += delta.x * w;
                point.offsetY += delta.y * w;
            }
        }
    return result;
}
export function validateBlendWeight(shape: BlendWeight, rig: RigDocument) {
    if (!shape || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(shape.id))
        throw Error('invalid blend shape id');
    const parameter = rig.parameters.find(p => p.id === shape.parameter);
    if (!parameter)
        throw Error('blend shape parameter not found');
    if (![shape.neutralInput, shape.targetInput].every(Number.isFinite) || shape.neutralInput === shape.targetInput)
        throw Error('blend shape inputs must be distinct finite numbers');
    if ([shape.neutralInput, shape.targetInput].some(v => v < parameter.min || v > parameter.max))
        throw Error('blend shape input outside parameter range');
    if (shape.interpolation !== undefined && !isParameterInterpolation(shape.interpolation))
        throw Error('invalid blend interpolation');
    if (shape.curve && (!Array.isArray(shape.curve.controlPoints) || shape.curve.controlPoints.length < 2 || shape.curve.controlPoints.some(p => !Number.isFinite(p.t) || !Number.isFinite(p.value) || p.t < 0 || p.t > 1 || p.value < 0 || p.value > 1)))
        throw Error('invalid blend curve');
}
export function validateExtendedShape(shape: ExtendedBlendShape, rig: RigDocument, ownerId: string, editing = true) {
    validateBlendWeight(shape, rig);
    const finiteTree = (v: unknown): void => { if (typeof v === 'number' && !Number.isFinite(v))
        throw Error('nonfinite blend delta'); if (v && typeof v === 'object')
        Object.values(v).forEach(finiteTree); };
    finiteTree(shape);
    if ('transform' in shape && shape.transform) {
        if (Object.keys(shape.transform).some(k => !['x', 'y', 'rotation', 'scaleX', 'scaleY', 'opacity'].includes(k)) || Object.values(shape.transform).some(v => typeof v !== 'number'))
            throw Error('invalid transform delta');
        if ((shape.transform.scaleX ?? 1) <= 0 || (shape.transform.scaleY ?? 1) <= 0)
            throw Error('blend scale multipliers must be positive');
    }
    const points = (deltas: {
        id: string;
        x: number;
        y: number;
    }[] | undefined, ids: string[]) => {
        if (deltas === undefined)
            return;
        if (!Array.isArray(deltas) || deltas.length > 10000 || new Set(deltas.map(d => d.id)).size !== deltas.length || deltas.some(d => !ids.includes(d.id) || !Number.isFinite(d.x) || !Number.isFinite(d.y)))
            throw Error('invalid blend point references');
    };
    if (shape.kind === 'part') {
        const part = rig.parts.find(p => p.id === ownerId);
        if (!part || (editing && part.locked) || !shape.transform)
            throw Error('part missing or locked');
    }
    else if (shape.kind === 'deformer') {
        const deformer = rig.deformers?.find(d => d.id === ownerId);
        if (!deformer || (editing && deformer.locked))
            throw Error('deformer missing or locked');
        if ((shape.warp || shape.pins?.length) && (deformer.kind !== 'warp' || !deformer.warp?.enabled))
            throw Error('enabled warp required');
        if (shape.warp && (Object.keys(shape.warp).some(k => !['bendX', 'bendY', 'taperX', 'taperY'].includes(k)) || Object.values(shape.warp).some(v => typeof v !== 'number')))
            throw Error('invalid warp delta');
        points(shape.pins, (deformer.warp?.pins ?? []).filter(p => p.enabled).map(p => p.id));
        points(shape.sharedPoints, deformer.sharedWarp?.enabled ? deformer.sharedWarp.controlPoints.filter(p => p.enabled !== false).map(p => p.id) : []);
    }
    else if (shape.kind === 'art-path') {
        const part = rig.parts.find(p => p.id === ownerId);
        const path = part?.artPaths?.find(p => p.id === shape.pathId);
        if (!path || (editing && part?.locked))
            throw Error('ArtPath missing or part locked');
        points(shape.points, path.points.map(p => p.id));
        if (shape.width !== undefined && typeof shape.width !== 'number' || shape.opacity !== undefined && typeof shape.opacity !== 'number')
            throw Error('invalid path delta');
    }
    else if (shape.kind === 'glue') {
        const glue = rig.glue?.find(g => g.id === shape.glueId);
        if (!glue || glue.id !== ownerId || !['soft-seam', 'stitch'].includes(glue.mode) || !Number.isFinite(shape.strength))
            throw Error('invalid glue shape');
        if (editing && rig.parts.some(p => (p.id === glue.partAId || p.id === glue.partBId) && p.locked))
            throw Error('glue part locked');
    }
    else
        throw Error('unknown blend shape kind');
}
/** Validation for imported documents as well as transaction-created shapes. */
export function extendedBlendIssues(rig: RigDocument): string[] {
    const issues: string[] = [];
    const check = (shapes: ExtendedBlendShape[] | undefined, owner: string, kind: string, nestedId?: string) => {
        if (shapes === undefined)
            return;
        if (!Array.isArray(shapes) || shapes.length > 128) {
            issues.push('invalid blend shape list: ' + owner);
            return;
        }
        const ids = new Set<string>();
        for (const shape of shapes)
            try {
                if (shape.kind !== kind || ids.has(shape.id) || (shape.kind === 'art-path' && shape.pathId !== nestedId))
                    throw Error('blend kind/ID mismatch');
                ids.add(shape.id);
                validateExtendedShape(shape, rig, owner, false);
            }
            catch (e) {
                issues.push(owner + ': ' + String(e));
            }
    };
    for (const part of rig.parts) {
        check(part.blendShapes, part.id, 'part');
        for (const p of part.artPaths ?? [])
            check(p.blendShapes, part.id, 'art-path', p.id);
    }
    for (const d of rig.deformers ?? [])
        check(d.blendShapes, d.id, 'deformer');
    for (const g of rig.glue ?? [])
        check(g.blendShapes, g.id, 'glue');
    return issues;
}
export function glueBlendStrength(glue: import('./types.js').RigGlue, values: ParameterValues = {}) {
    const base = glue.mode === 'stitch' ? 1 : glue.strength;
    return Math.min(1, Math.max(0, base + (glue.blendShapes ?? []).reduce((sum, s) => sum + s.strength * blendWeight(s, values), 0)));
}
