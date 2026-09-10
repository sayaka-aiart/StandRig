import type { DeformBrush } from './deformTypes.js';
export interface BrushPoint {
    id: string;
    x: number;
    y: number;
    referenceX: number;
    referenceY: number;
}
export interface BrushGraph {
    points: BrushPoint[];
    edges: Array<[
        number,
        number
    ]>;
    boundary: Set<string>;
    locked: Set<string>;
    triangles?: number[];
}
const finite = (v: number) => Number.isFinite(v);
export function validateBrush(brush: DeformBrush) {
    if (!brush || !Array.isArray(brush.center) || brush.center.length !== 2 || !brush.center.every(finite) || !finite(brush.radius) || brush.radius <= 0)
        throw Error('invalid brush center/radius');
    if (!Number.isInteger(brush.iterations) || brush.iterations < 1 || brush.iterations > 50 || !finite(brush.maxDisplacement) || brush.maxDisplacement <= 0)
        throw Error('invalid brush iteration/displacement bound');
    if (!['linear', 'smooth'].includes(brush.falloff))
        throw Error('invalid brush falloff');
    const effect = brush.effect;
    if (!effect || !['smooth', 'relax', 'inflate', 'pinch', 'bend', 'contour-follow'].includes(effect.mode))
        throw Error('invalid brush effect');
    if ('strength' in effect && (!finite(effect.strength) || effect.strength < 0 || effect.strength > 1))
        throw Error('brush strength must be in [0,1]');
    if (effect.mode === 'inflate' && (!finite(effect.distance) || effect.distance < 0))
        throw Error('inflate distance must be nonnegative');
    if (effect.mode === 'bend' && (!finite(effect.angle) || Math.abs(effect.angle) > 180))
        throw Error('bend angle must be within +/-180 degrees');
    if ('axis' in effect && (!Array.isArray(effect.axis) || effect.axis.length !== 2 || !effect.axis.every(finite) || Math.hypot(...effect.axis) < 1e-8))
        throw Error('brush axis must be nonzero');
    if (effect.mode === 'contour-follow' && (!Array.isArray(effect.guide) || effect.guide.length < 2 || effect.guide.length > 256 || effect.guide.some(p => p.length !== 2 || !p.every(finite)) || effect.vertexIds.length < 2 || new Set(effect.vertexIds).size !== effect.vertexIds.length))
        throw Error('contour-follow requires ordered unique vertices and a finite guide');
    if (!['base', 'keyform', 'blend-shape'].includes(brush.destination?.kind))
        throw Error('invalid brush destination');
}
/** Deterministic Jacobi updates: every pass reads the previous pass, never partially updated neighbours. */
export function applyDeformBrush(graph: BrushGraph, brush: DeformBrush) {
    validateBrush(brush);
    const source = graph.points;
    if (!source.length || source.length > 10000 || source.some(p => ![p.x, p.y, p.referenceX, p.referenceY].every(finite)) || new Set(source.map(p => p.id)).size !== source.length)
        throw Error('invalid brush points');
    const ids = new Map(source.map((p, i) => [p.id, i]));
    const locked = new Set([...graph.locked, ...brush.lockedIds ?? []]);
    if ([...locked].some(id => !ids.has(id)))
        throw Error('unknown locked vertex');
    const neighbours = source.map(() => new Set<number>());
    for (const [a, b] of graph.edges) {
        if (!Number.isInteger(a) || !Number.isInteger(b) || !source[a] || !source[b] || a === b)
            throw Error('invalid brush adjacency');
        neighbours[a].add(b);
        neighbours[b].add(a);
    }
    const effect = brush.effect;
    if (effect.mode === 'relax')
        for (const id of graph.boundary)
            locked.add(id);
    const contourTargets = new Map<string, [
        number,
        number
    ]>();
    if (effect.mode === 'contour-follow') {
        if (effect.vertexIds.some(id => !ids.has(id) || !graph.boundary.has(id)))
            throw Error('contour vertices must belong to the boundary');
        for (let i = 1; i < effect.vertexIds.length; i++)
            if (!neighbours[ids.get(effect.vertexIds[i - 1])!].has(ids.get(effect.vertexIds[i])!))
                throw Error('contour vertices must follow connected edges');
        const lengths = (points: Array<[
            number,
            number
        ]>) => { const out = [0]; for (let i = 1; i < points.length; i++)
            out.push(out[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1])); return out; };
        const from = effect.vertexIds.map(id => { const p = source[ids.get(id)!]; return [p.x, p.y] as [
            number,
            number
        ]; });
        const a = lengths(from), b = lengths(effect.guide);
        if (a.at(-1)! <= 1e-8 || b.at(-1)! <= 1e-8)
            throw Error('contour/guide has zero length');
        effect.vertexIds.forEach((id, i) => { const d = a[i] / a.at(-1)! * b.at(-1)!; let k = 1; while (k < b.length - 1 && b[k] < d)
            k++; const t = (d - b[k - 1]) / (b[k] - b[k - 1] || 1); contourTargets.set(id, [effect.guide[k - 1][0] * (1 - t) + effect.guide[k][0] * t, effect.guide[k - 1][1] * (1 - t) + effect.guide[k][1] * t]); });
    }
    const weights = source.map(p => { const f = Math.max(0, 1 - Math.hypot(p.x - brush.center[0], p.y - brush.center[1]) / brush.radius); return brush.falloff === 'smooth' ? f * f * (3 - 2 * f) : f; });
    const clipped = new Set<string>();
    let points = source.map(p => ({ ...p }));
    for (let pass = 0; pass < brush.iterations; pass++)
        points = points.map((p, i) => {
            const w = weights[i];
            if (!w || locked.has(p.id))
                return p;
            let dx = 0, dy = 0;
            if (effect.mode === 'smooth' || effect.mode === 'relax') {
                const adjacent = [...neighbours[i]];
                if (!adjacent.length)
                    throw Error('brush requires connected neighbours');
                if (effect.mode === 'smooth') {
                    dx = adjacent.reduce((s, j) => s + points[j].x - points[j].referenceX, 0) / adjacent.length - (p.x - p.referenceX);
                    dy = adjacent.reduce((s, j) => s + points[j].y - points[j].referenceY, 0) / adjacent.length - (p.y - p.referenceY);
                }
                else {
                    dx = adjacent.reduce((s, j) => s + points[j].x, 0) / adjacent.length - p.x;
                    dy = adjacent.reduce((s, j) => s + points[j].y, 0) / adjacent.length - p.y;
                }
                dx *= effect.strength;
                dy *= effect.strength;
            }
            else if (effect.mode === 'inflate') {
                const x = p.x - brush.center[0], y = p.y - brush.center[1], n = Math.hypot(x, y);
                if (n > 1e-8) {
                    dx = x / n * effect.distance / brush.iterations;
                    dy = y / n * effect.distance / brush.iterations;
                }
            }
            else if (effect.mode === 'pinch' || effect.mode === 'bend') {
                const n = Math.hypot(...effect.axis), ax = effect.axis[0] / n, ay = effect.axis[1] / n;
                const x = p.x - brush.center[0], y = p.y - brush.center[1], along = x * ax + y * ay, across = -x * ay + y * ax;
                if (effect.mode === 'pinch') {
                    dx = ay * across * effect.strength / brush.iterations;
                    dy = -ax * across * effect.strength / brush.iterations;
                }
                else {
                    const angle = effect.angle * Math.PI / 180 / brush.iterations;
                    if (Math.abs(angle) > 1e-8) {
                        const radius = brush.radius / angle, t = along / radius;
                        const a = Math.sin(t) * (radius - across), b = radius - Math.cos(t) * (radius - across);
                        dx = (a - along) * ax - (b - across) * ay;
                        dy = (a - along) * ay + (b - across) * ax;
                    }
                }
            }
            else {
                const target = contourTargets.get(p.id);
                if (!target)
                    return p;
                dx = (target[0] - p.x) * effect.strength;
                dy = (target[1] - p.y) * effect.strength;
            }
            let x = p.x + dx * w, y = p.y + dy * w;
            const distance = Math.hypot(x - source[i].x, y - source[i].y);
            if (distance > brush.maxDisplacement) {
                const ratio = brush.maxDisplacement / distance;
                x = source[i].x + (x - source[i].x) * ratio;
                y = source[i].y + (y - source[i].y) * ratio;
                clipped.add(p.id);
            }
            if (!finite(x) || !finite(y))
                throw Error('nonfinite brush result');
            return { ...p, x, y };
        });
    const area = (p: BrushPoint[], a: number, b: number, c: number) => (p[b].x - p[a].x) * (p[c].y - p[a].y) - (p[b].y - p[a].y) * (p[c].x - p[a].x);
    let minAreaRatio = Infinity;
    for (let i = 0; i < (graph.triangles?.length ?? 0); i += 3) {
        const [a, b, c] = graph.triangles!.slice(i, i + 3);
        const before = area(source, a, b, c), after = area(points, a, b, c);
        if (Math.abs(before) < 1e-8 || before * after <= 0 || Math.abs(after) < 1e-8)
            throw Error('brush would produce degenerate or inverted triangles');
        minAreaRatio = Math.min(minAreaRatio, Math.abs(after / before));
    }
    const changed = points.filter((p, i) => Math.hypot(p.x - source[i].x, p.y - source[i].y) > 1e-9);
    return { points, report: { changedPointCount: changed.length, maxDisplacement: Math.max(0, ...points.map((p, i) => Math.hypot(p.x - source[i].x, p.y - source[i].y))), clippedPointCount: clipped.size, minAreaRatio: Number.isFinite(minAreaRatio) ? minAreaRatio : null, lockedPointCount: locked.size } };
}
