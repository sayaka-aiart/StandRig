import { matchesPartTarget } from "./modelingTarget.js";
import { keyformParameter, sampleWarpKeyform, writeWarpKeyform } from './warpKeyforms.js';
import { applyDeformBrush, type BrushGraph } from './deformBrush.js';
import { validateBlendWeight, validateExtendedShape } from './extendedBlendShape.js';
import type { DeformBrush, DeformerBlendShape, ExtendedBlendShape } from './deformTypes.js';
import type { ModelingOperation, ModelingOperationResult } from './modelingOps.js';
import type { RigDocument, RigPart } from './types.js';
function upsert<T extends {
    id: string;
}>(list: T[], shape: T) { const index = list.findIndex(s => s.id === shape.id); if (index < 0) {
    if (list.length >= 128)
        throw Error('too many blend shapes');
    list.push(structuredClone(shape));
}
else
    list[index] = structuredClone(shape); }
function selectedParts(rig: RigDocument, operation: ModelingOperation) {
    const parts = rig.parts.filter(p => matchesPartTarget(p, operation.target).matched);
    if (operation.target.partIds?.some(id => !rig.parts.some(p => p.id === id)))
        throw Error('target part not found');
    if (operation.target.roles?.some(role => !rig.parts.some(p => p.role === role && p.roleStatus === 'confirmed')))
        throw Error('confirmed role not found');
    if (parts.some(p => p.locked))
        throw Error('target part locked');
    return parts;
}
function selectedDeformers(rig: RigDocument, operation: ModelingOperation) {
    const ids = operation.target.deformerIds ?? [];
    if (!ids.length)
        throw Error('explicit deformerIds required');
    return [...new Set(ids)].map(id => { const d = rig.deformers?.find(d => d.id === id); if (!d || d.locked)
        throw Error('target deformer missing or locked'); return d; });
}
function writeShape(rig: RigDocument, op: ModelingOperation, shape: ExtendedBlendShape): string[] {
    if (shape.kind === 'deformer')
        return selectedDeformers(rig, op).map(d => { validateExtendedShape(shape, rig, d.id); upsert(d.blendShapes ??= [], shape); return d.id; });
    const parts = selectedParts(rig, op);
    if (!parts.length)
        throw Error('explicit part targets required');
    if (shape.kind === 'glue') {
        const glue = rig.glue?.find(g => g.id === shape.glueId);
        if (!glue || ![glue.partAId, glue.partBId].every(id => parts.some(p => p.id === id)))
            throw Error('both glue parts must be targeted');
        validateExtendedShape(shape, rig, glue.id);
        upsert(glue.blendShapes ??= [], shape);
        return [glue.partAId, glue.partBId];
    }
    return parts.map(p => { validateExtendedShape(shape, rig, p.id); if (shape.kind === 'part')
        upsert(p.blendShapes ??= [], shape);
    else
        upsert(p.artPaths!.find(a => a.id === shape.pathId)!.blendShapes ??= [], shape); return p.id; });
}
function meshBrush(rig: RigDocument, part: RigPart, brush: DeformBrush) {
    const mesh = part.artMesh, asset = rig.assets.find(a => a.id === part.assetId);
    if (!mesh?.enabled || !asset || !asset.width || !asset.height)
        throw Error('enabled ArtMesh and asset required');
    const width = asset.width, height = asset.height;
    const destination = brush.destination;
    let offsets: Array<{
        vertexId: string;
        x: number;
        y: number;
    }> = [];
    if (destination.kind === 'blend-shape') {
        validateBlendWeight(destination.shape, rig);
        const existing = mesh.blendShapes?.find(s => s.id === destination.shape.id);
        if (existing?.additive === false)
            throw Error('brush requires additive blend shape');
        offsets = existing?.offsets ?? [];
    }
    else if (destination.kind === 'keyform') {
        const parameter = rig.parameters.find(p => p.id === destination.parameter);
        if (!parameter || !Number.isFinite(destination.input) || destination.input < parameter.min || destination.input > parameter.max)
            throw Error('invalid keyform parameter/input');
        const bindings = mesh.bindings?.filter(b => b.parameter === destination.parameter) ?? [];
        if (bindings.length > 1 || bindings[0]?.additive === false)
            throw Error('ambiguous/nonadditive keyform');
        offsets = bindings[0]?.keys.find(k => k.input === destination.input)?.offsets ?? [];
    }
    const graph: BrushGraph = { points: mesh.vertices.map(v => { const d = offsets.find(d => d.vertexId === v.id); return { id: v.id, x: v.x + (d?.x ?? 0), y: v.y + (d?.y ?? 0), referenceX: destination.kind === 'base' ? v.u * width : v.x, referenceY: destination.kind === 'base' ? v.v * height : v.y }; }), edges: [], boundary: new Set(), locked: new Set(), triangles: mesh.triangles };
    const edges = new Map<string, {
        a: number;
        b: number;
        count: number;
    }>();
    for (let i = 0; i < mesh.triangles.length; i += 3) {
        const tri = mesh.triangles.slice(i, i + 3);
        for (let j = 0; j < 3; j++) {
            const a = Math.min(tri[j], tri[(j + 1) % 3]), b = Math.max(tri[j], tri[(j + 1) % 3]), key = a + ':' + b;
            const e = edges.get(key);
            if (e)
                e.count++;
            else
                edges.set(key, { a, b, count: 1 });
        }
    }
    for (const { a, b, count } of edges.values()) {
        graph.edges.push([a, b]);
        if (count === 1) {
            graph.boundary.add(mesh.vertices[a].id);
            graph.boundary.add(mesh.vertices[b].id);
        }
    }
    for (const id of [...mesh.generator.quality?.lockedVertexIds ?? [], ...mesh.generator.quality?.pinnedVertexIds ?? [], ...rig.symmetry?.protectedVertexIds?.[part.id] ?? []])
        graph.locked.add(id);
    if (rig.symmetry?.protectedPartIds.includes(part.id))
        throw Error('part protected by symmetry contract');
    const result = applyDeformBrush(graph, brush);
    const next = result.points.map((p, i) => ({ vertexId: p.id, x: p.x - mesh.vertices[i].x, y: p.y - mesh.vertices[i].y })).filter(d => Math.abs(d.x) + Math.abs(d.y) > 1e-12);
    if (destination.kind === 'base')
        result.points.forEach((p, i) => { mesh.vertices[i].x = p.x; mesh.vertices[i].y = p.y; });
    else if (destination.kind === 'blend-shape')
        upsert(mesh.blendShapes ??= [], { ...destination.shape, offsets: next, additive: true });
    else {
        mesh.bindings ??= [];
        let binding = mesh.bindings.find(b => b.parameter === destination.parameter);
        if (!binding) {
            binding = { parameter: destination.parameter, keys: [], additive: true };
            mesh.bindings.push(binding);
            const value = rig.parameters.find(p => p.id === destination.parameter)!.default;
            if (value !== destination.input)
                binding.keys.push({ input: value, offsets: [] });
        }
        const key = binding.keys.find(k => k.input === destination.input);
        if (key)
            key.offsets = next;
        else
            binding.keys.push({ input: destination.input, offsets: next });
        binding.keys.sort((a, b) => a.input - b.input);
    }
    return result.report;
}
function warpBrush(rig: RigDocument, op: ModelingOperation, brush: DeformBrush) {
    if (brush.surface.kind === 'artmesh')
        throw Error('warp surface required');
    const destination = brush.destination;
    const parameter = destination.kind === 'keyform' ? keyformParameter(rig,destination.parameter,destination.input) : undefined;
    return selectedDeformers(rig, op).map(d => {
        if (rig.symmetry?.protectedDeformerIds.includes(d.id))
            throw Error('deformer protected by symmetry contract');
        const surface = brush.surface;
        if (surface.kind === 'artmesh')
            throw Error('warp surface required');
        const shared = surface.kind === 'shared-warp';
        if (shared ? !d.sharedWarp?.enabled : (d.kind !== 'warp' || !d.warp?.enabled))
            throw Error('enabled warp field required');
        const controls = shared ? d.sharedWarp!.controlPoints : d.warp!.pins ?? [];
        let old: DeformerBlendShape | undefined;
        if (destination.kind === 'blend-shape') {
            validateBlendWeight(destination.shape, rig);
            old = d.blendShapes?.find(s => s.id === destination.shape.id);
        }
        const oldOffsets = shared ? old?.sharedPoints : old?.pins;
        const graph: BrushGraph = { points: [], edges: [], boundary: new Set(), locked: new Set() };
        controls.forEach(p => {
            let x: number, y: number;
            if ('column' in p) {
                const field = d.sharedWarp!;
                x = field.bounds.left + p.column / field.grid.columns * field.bounds.width;
                y = field.bounds.top + p.row / field.grid.rows * field.bounds.height;
                if (p.column === 0 || p.row === 0 || p.column === field.grid.columns || p.row === field.grid.rows)
                    graph.boundary.add(p.id);
            }
            else {
                if (surface.kind !== 'warp-pins' || !Number.isFinite(surface.width) || !Number.isFinite(surface.height) || surface.width <= 0 || surface.height <= 0)
                    throw Error('warp-local dimensions required');
                x = p.u * surface.width;
                y = p.v * surface.height;
            }
            const delta = destination.kind === 'keyform' ? sampleWarpKeyform(p,destination.parameter,destination.input) : oldOffsets?.find(v => v.id === p.id);
            graph.points.push({ id: p.id, x: x + p.offsetX + (delta?.x ?? 0), y: y + p.offsetY + (delta?.y ?? 0), referenceX: x + (destination.kind === 'base' ? 0 : p.offsetX), referenceY: y + (destination.kind === 'base' ? 0 : p.offsetY) });
            if (p.enabled === false)
                graph.locked.add(p.id);
        });
        if (shared) {
            const grid = d.sharedWarp!;
            const at = (c: number, r: number) => grid.controlPoints.findIndex(p => p.column === c && p.row === r);
            graph.triangles = [];
            for (let row = 0; row <= grid.grid.rows; row++)
                for (let column = 0; column <= grid.grid.columns; column++) {
                    const a = at(column, row);
                    if (a < 0)
                        throw Error('shared warp must have a complete grid');
                    if (column < grid.grid.columns)
                        graph.edges.push([a, at(column + 1, row)]);
                    if (row < grid.grid.rows)
                        graph.edges.push([a, at(column, row + 1)]);
                    if (column < grid.grid.columns && row < grid.grid.rows) {
                        const b = at(column + 1, row), c = at(column, row + 1), e = at(column + 1, row + 1);
                        graph.triangles.push(a, b, c, b, e, c);
                    }
                }
        }
        else {
            if (brush.effect.mode === 'contour-follow')
                throw Error('contour-follow requires mesh or shared-grid boundary');
            for (const [a, b] of brush.edges ?? [])
                graph.edges.push([controls.findIndex(p => p.id === a), controls.findIndex(p => p.id === b)]);
            controls.forEach((p, i) => { if (graph.edges.filter(e => e.includes(i)).length <= 1)
                graph.boundary.add(p.id); });
        }
        const result = applyDeformBrush(graph, brush);
        const deltas = result.points.map((p, i) => ({ id: p.id, x: p.x - graph.points[i].referenceX, y: p.y - graph.points[i].referenceY }));
        if (destination.kind === 'base')
            deltas.forEach((p, i) => { controls[i].offsetX = p.x; controls[i].offsetY = p.y; });
        else if (destination.kind === 'keyform') {
            deltas.forEach((delta,i)=>{
                if(controls[i].enabled===false || graph.locked.has(controls[i].id) || brush.lockedIds?.includes(controls[i].id))return;
                const previous=sampleWarpKeyform(controls[i],destination.parameter,destination.input);
                writeWarpKeyform(controls[i],destination.parameter,destination.input,parameter!.default,delta,previous);
            });
        }
        else {
            const shape: DeformerBlendShape = { ...old, ...destination.shape, kind: 'deformer', ...(shared ? { sharedPoints: deltas.filter((_, i) => controls[i].enabled !== false) } : { pins: deltas.filter((_, i) => controls[i].enabled !== false) }) };
            validateExtendedShape(shape, rig, d.id);
            upsert(d.blendShapes ??= [], shape);
        }
        return { ownerId: d.id, ...result.report };
    });
}
/** All new operations stage a full candidate so direct core callers also avoid partial multi-target writes. */
export function executeDeformOperation(rig: RigDocument, op: ModelingOperation, dryRun: boolean): ModelingOperationResult {
    const candidate = structuredClone(rig);
    const action = op.action;
    if (action.type === 'deform-brush' && action.brush.edges !== undefined && action.brush.surface.kind !== 'warp-pins')
        throw Error('explicit edges are only supported for warp-pins');
    let ids: string[] = [];
    const reports: Array<Record<string, number | string | null>> = [];
    if (action.type === 'blend-shape-set')
        ids = writeShape(candidate, op, action.shape);
    else if (action.type === 'deform-brush') {
        if (action.brush.surface.kind === 'artmesh') {
            const parts = selectedParts(candidate, op);
            if (!parts.length)
                throw Error('part target required');
            for (const part of parts)
                reports.push({ ownerId: part.id, ...meshBrush(candidate, part, action.brush) });
            ids = parts.map(p => p.id);
        }
        else {
            reports.push(...warpBrush(candidate, op, action.brush));
            ids = reports.map(r => String(r.ownerId));
        }
    }
    else
        throw Error('unsupported deform operation');
    const changed = JSON.stringify(candidate) !== JSON.stringify(rig);
    if (!dryRun && changed)
        Object.assign(rig, candidate);
    return { operationId: op.id, dryRun, matchedPartIds: ids, skipped: [], deformReports: reports, changes: changed ? ids.map(partId => ({ partId, path: action.type, before: undefined, after: JSON.stringify(reports.length ? reports : action) })) : [] };
}
