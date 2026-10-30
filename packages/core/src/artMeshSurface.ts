import type { RigArtMesh } from "./types.js";

type Point = { x: number; y: number };
interface Triangle {
  ids: [string, string, string];
  a: Point; bx: number; by: number; cx: number; cy: number; determinant: number;
  left: number; top: number; right: number; bottom: number;
}
interface Geometry {
  coordinates: number[]; ids: string[]; indices: number[]; triangles: Triangle[];
  left: number; top: number; width: number; height: number; cells: number[][];
}
const GRID = 8;
const cache = new WeakMap<RigArtMesh, Geometry>();

/** Compose a measured 2D surface with expression/physics geometry. Adding the
 * angle offsets by vertex ID alone cannot rotate an already closed eyelid. */
export function applyArtMeshSurface(mesh: RigArtMesh, sampled: Map<string, Point>, offsets: Map<string, Point>): void {
  if (!sampled.size || ![...sampled.values()].some(p => p.x !== 0 || p.y !== 0)) return;
  let geometry: Geometry | undefined;
  for (const vertex of mesh.vertices) {
    const current = offsets.get(vertex.id);
    if (!current || (current.x === 0 && current.y === 0)) {
      const delta = sampled.get(vertex.id);
      if (delta) offsets.set(vertex.id, { ...delta });
      continue;
    }
    geometry ??= geometryFor(mesh);
    const point = { x: vertex.x + current.x, y: vertex.y + current.y };
    const triangle = locate(geometry, point);
    if (!triangle) continue;
    const [u, v] = barycentric(triangle, point), weights = [1 - u - v, u, v];
    let x = 0, y = 0;
    for (let i = 0; i < 3; i++) {
      const delta = sampled.get(triangle.ids[i]);
      x += (delta?.x ?? 0) * weights[i];
      y += (delta?.y ?? 0) * weights[i];
    }
    offsets.set(vertex.id, { x: current.x + x, y: current.y + y });
  }
}

function geometryFor(mesh: RigArtMesh): Geometry {
  const old = cache.get(mesh);
  if (old && old.coordinates.length === mesh.vertices.length * 2 && old.indices.length === mesh.triangles.length &&
    mesh.vertices.every((p, i) => p.id === old.ids[i] && p.x === old.coordinates[i * 2] && p.y === old.coordinates[i * 2 + 1]) &&
    mesh.triangles.every((v, i) => v === old.indices[i])) return old;
  const xs = mesh.vertices.map(p => p.x), ys = mesh.vertices.map(p => p.y);
  const geometry: Geometry = { coordinates: mesh.vertices.flatMap(p => [p.x, p.y]), ids: mesh.vertices.map(p => p.id), indices: [...mesh.triangles], triangles: [],
    left: Math.min(...xs), top: Math.min(...ys), width: Math.max(1e-9, Math.max(...xs) - Math.min(...xs)),
    height: Math.max(1e-9, Math.max(...ys) - Math.min(...ys)), cells: Array.from({ length: GRID * GRID }, () => []) };
  for (let i = 0; i < mesh.triangles.length; i += 3) {
    const [a, b, c] = mesh.triangles.slice(i, i + 3).map(j => mesh.vertices[j]);
    const bx = b.x - a.x, by = b.y - a.y, cx = c.x - a.x, cy = c.y - a.y, determinant = bx * cy - by * cx;
    if (Math.abs(determinant) < 1e-12) continue;
    const triangle: Triangle = { ids: [a.id, b.id, c.id], a: { x: a.x, y: a.y }, bx, by, cx, cy, determinant,
      left: Math.min(a.x, b.x, c.x), top: Math.min(a.y, b.y, c.y), right: Math.max(a.x, b.x, c.x), bottom: Math.max(a.y, b.y, c.y) };
    const index = geometry.triangles.push(triangle) - 1;
    const [left, top] = cell(geometry, triangle.left, triangle.top), [right, bottom] = cell(geometry, triangle.right, triangle.bottom);
    for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) geometry.cells[y * GRID + x].push(index);
  }
  cache.set(mesh, geometry); return geometry;
}

function cell(g: Geometry, x: number, y: number): [number, number] {
  return [Math.max(0, Math.min(GRID - 1, Math.floor((x - g.left) / g.width * GRID))),
    Math.max(0, Math.min(GRID - 1, Math.floor((y - g.top) / g.height * GRID)))];
}
function barycentric(t: Triangle, p: Point): [number, number] {
  const x = p.x - t.a.x, y = p.y - t.a.y;
  return [(x * t.cy - y * t.cx) / t.determinant, (t.bx * y - t.by * x) / t.determinant];
}
function locate(g: Geometry, p: Point): Triangle | undefined {
  const [x, y] = cell(g, p.x, p.y);
  for (const index of g.cells[y * GRID + x]) {
    const t = g.triangles[index], [u, v] = barycentric(t, p);
    if (u >= -1e-9 && v >= -1e-9 && u + v <= 1 + 1e-9) return t;
  }
  // Extrapolate the nearest boundary triangle so a small expression offset
  // outside the rest hull remains continuous; do not clamp/flatten that offset.
  let best: Triangle | undefined, distance = Infinity;
  for (const t of g.triangles) {
    const dx = Math.max(t.left - p.x, 0, p.x - t.right), dy = Math.max(t.top - p.y, 0, p.y - t.bottom);
    if (dx * dx + dy * dy > distance) continue;
    const a = t.a, b = { x: a.x + t.bx, y: a.y + t.by }, c = { x: a.x + t.cx, y: a.y + t.cy };
    const d = Math.min(segmentDistance(p, a, b), segmentDistance(p, b, c), segmentDistance(p, c, a));
    if (d < distance) { distance = d; best = t; }
  }
  return best;
}
function segmentDistance(p: Point, a: Point, b: Point): number {
  const x = b.x - a.x, y = b.y - a.y, length = x * x + y * y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * x + (p.y - a.y) * y) / (length || 1)));
  return (p.x - a.x - t * x) ** 2 + (p.y - a.y - t * y) ** 2;
}
