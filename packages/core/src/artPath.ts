import { blendWeight } from './extendedBlendShape.js';
import { sampleBinding } from "./bindings.js";
import type { ParameterValues, RigArtPath, RigArtPathPoint, RigPart } from "./types.js";

export interface ResolvedArtPathPoint {
  id: string;
  u: number;
  v: number;
}

export interface ResolvedArtPath {
  id: string;
  points: ResolvedArtPathPoint[];
  closed: boolean;
  curve: "polyline" | "smooth";
  strokeColor: [number, number, number, number];
  strokeWidth: number;
  opacity: number;
}

export function readRigArtPaths(part: RigPart): RigArtPath[] {
  return Array.isArray(part.artPaths) ? part.artPaths : [];
}

export function normalizeArtPath(path: RigArtPath, fallbackId = "art-path"): RigArtPath {
  path.version = 1;
  path.id = typeof path.id === "string" && path.id.trim() ? path.id : fallbackId;
  path.name = typeof path.name === "string" && path.name.trim() ? path.name : path.id;
  path.enabled = path.enabled !== false;
  path.closed = path.closed === true;
  path.curve = path.curve === "smooth" ? "smooth" : "polyline";
  path.strokeColor = normalizeColor(path.strokeColor);
  path.strokeWidth = clamp(Number(path.strokeWidth), 0.25, 64, 2);
  path.opacity = clamp(Number(path.opacity), 0, 1, 1);
  path.points = Array.isArray(path.points)
    ? path.points.filter((point): point is RigArtPathPoint => Boolean(point && typeof point.id === "string"))
      .slice(0, 128)
      .map((point, index) => normalizePoint(point, index))
    : [];
  path.bindings = Array.isArray(path.bindings) ? path.bindings.slice(0, 32) : [];
  return path;
}

export function normalizeRigArtPaths(part: RigPart): RigArtPath[] {
  if (!Array.isArray(part.artPaths)) part.artPaths = [];
  part.artPaths.forEach((path, index) => normalizeArtPath(path, `${part.id}-path-${index + 1}`));
  return part.artPaths;
}

export function validateArtPath(path: RigArtPath): string[] {
  const issues: string[] = [];
  normalizeArtPath(path);
  if (path.points.length < 2) issues.push("art-path-needs-two-points");
  if (path.closed && path.points.length < 3) issues.push("closed-art-path-needs-three-points");
  const ids = new Set<string>();
  for (const point of path.points) {
    if (ids.has(point.id)) issues.push("duplicate-art-path-point-id:" + point.id);
    ids.add(point.id);
  }
  if (path.strokeWidth <= 0) issues.push("art-path-stroke-width-invalid");
  return issues;
}

export function resolveArtPath(path: RigArtPath, values: ParameterValues, width: number, height: number): ResolvedArtPath | undefined {
  normalizeArtPath(path);
  if (!path.enabled || path.points.length < 2) return undefined;
  const pointValues = path.points.map((point) => {
    let u = point.u;
    let v = point.v;
    for (const binding of point.bindings ?? []) {
      const sampled = sampleBinding(binding, values[binding.parameter] ?? 0);
      if (binding.property === "u") u += sampled / Math.max(1, width);
      else v += sampled / Math.max(1, height);
    }
    for(const shape of path.blendShapes??[]){const delta=shape.points?.find(p=>p.id===point.id);if(delta){const w=blendWeight(shape,values);u+=delta.x*w;v+=delta.y*w;}}
    return { id: point.id, u: clamp(u, 0, 1, point.u), v: clamp(v, 0, 1, point.v) };
  });
  let offsetX = 0;
  let offsetY = 0;
  let strokeWidth = path.strokeWidth;
  let opacity = path.opacity;
  for (const binding of path.bindings ?? []) {
    const sampled = sampleBinding(binding, values[binding.parameter] ?? 0);
    if (binding.property === "offsetX") offsetX += sampled / Math.max(1, width);
    else if (binding.property === "offsetY") offsetY += sampled / Math.max(1, height);
    else if (binding.property === "width") strokeWidth += sampled;
    else if (binding.property === "opacity") opacity += sampled;
  }
  for(const shape of path.blendShapes??[]){const w=blendWeight(shape,values);strokeWidth+=(shape.width??0)*w;opacity+=(shape.opacity??0)*w;}
  return {
    id: path.id,
    points: pointValues.map((point) => ({ ...point, u: clamp(point.u + offsetX, 0, 1, point.u), v: clamp(point.v + offsetY, 0, 1, point.v) })),
    closed: path.closed === true,
    curve: path.curve === "smooth" ? "smooth" : "polyline",
    strokeColor: parseColor(path.strokeColor, opacity),
    strokeWidth: clamp(strokeWidth, 0.25, 64, path.strokeWidth),
    opacity: clamp(opacity, 0, 1, path.opacity)
  };
}

function normalizePoint(point: RigArtPathPoint, index: number): RigArtPathPoint {
  point.id = point.id.trim() || `point-${index + 1}`;
  point.u = clamp(Number(point.u), 0, 1, 0);
  point.v = clamp(Number(point.v), 0, 1, 0);
  point.bindings = Array.isArray(point.bindings) ? point.bindings.slice(0, 16) : [];
  return point;
}

function normalizeColor(value: unknown): string {
  return typeof value === "string" && /^#[0-9a-f]{6,8}$/i.test(value) ? value : "#20202aff";
}

function parseColor(value: string, opacity: number): [number, number, number, number] {
  const normalized = normalizeColor(value).slice(1);
  const hex = normalized.length === 6 ? normalized + "ff" : normalized;
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16), Math.round(parseInt(hex.slice(6, 8), 16) * clamp(opacity, 0, 1, 1))];
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}
