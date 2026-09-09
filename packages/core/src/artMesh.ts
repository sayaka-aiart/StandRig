import { applyParameterInterpolation, normalizeParameterInterpolation } from "./bindings.js";
import { sortedKeysOrCopy } from "./bindingPreparation.js";
import { sampleMultiArtMeshBinding } from "./artMeshMulti.js";
import { sampleArtMeshBlendShape } from "./artMeshBlendShape.js";
import type { ParameterInterpolation, ParameterValues, RigArtMesh, RigArtMeshBinding, RigArtMeshQuality, RigArtMeshVertex, RigPart } from "./types.js";

export interface ResolvedArtMeshVertex extends RigArtMeshVertex {
  x: number;
  y: number;
}

export interface ResolvedArtMesh {
  vertices: ResolvedArtMeshVertex[];
  triangles: number[];
  topology?: "rect-grid" | "alpha-contour";
}

/**
 * A generated mesh that still describes the source image's exact rectangle
 * does not need triangle rasterization. Keeping that path on the image
 * renderer avoids tiny seams at transformed triangle edges while preserving
 * the ArtMesh data for later vertex deformation.
 */
export function isCanonicalArtMesh(mesh: ResolvedArtMesh, width: number, height: number, epsilon = 1e-4): boolean {
  if (mesh.topology === "alpha-contour" || !finite(width) || !finite(height) || width <= 0 || height <= 0 || !mesh.vertices.length || mesh.triangles.length < 3) {
    return false;
  }
  return mesh.vertices.every((vertex) =>
    Math.abs(vertex.x - vertex.u * width) <= epsilon &&
    Math.abs(vertex.y - vertex.v * height) <= epsilon
  );
}


export interface AddArtMeshVertexInput {
  id?: string;
  x: number;
  y: number;
  u: number;
  v: number;
}

export function addArtMeshVertex(mesh: RigArtMesh, input: AddArtMeshVertexInput): RigArtMeshVertex {
  if (![input.x, input.y, input.u, input.v].every(finite)) throw new TypeError("ArtMesh vertex coordinates must be finite numbers");
  if (input.u < 0 || input.u > 1 || input.v < 0 || input.v > 1) throw new RangeError("ArtMesh vertex UVs must be within 0..1");
  const ids = new Set(mesh.vertices.map((vertex) => vertex.id));
  const requested = input.id?.trim() || "v-custom";
  let id = requested;
  for (let suffix = 2; ids.has(id); suffix += 1) id = `${requested}-${suffix}`;
  const vertex = { id, x: input.x, y: input.y, u: input.u, v: input.v };
  mesh.vertices.push(vertex);
  return vertex;
}

export function removeArtMeshVertex(mesh: RigArtMesh, index: number): boolean {
  if (mesh.vertices.length <= 3 || !Number.isInteger(index) || index < 0 || index >= mesh.vertices.length) return false;
  const vertexId = mesh.vertices[index].id;
  mesh.vertices.splice(index, 1);
  const triangles: number[] = [];
  for (let offset = 0; offset + 2 < mesh.triangles.length; offset += 3) {
    const triangle = mesh.triangles.slice(offset, offset + 3);
    if (triangle.includes(index)) continue;
    triangles.push(...triangle.map((vertexIndex) => vertexIndex > index ? vertexIndex - 1 : vertexIndex));
  }
  mesh.triangles = triangles;
  for (const binding of mesh.bindings ?? []) for (const key of binding.keys) key.offsets = key.offsets.filter((entry) => entry.vertexId !== vertexId);
  for (const binding of mesh.multiBindings ?? []) for (const keyform of binding.keyforms) keyform.offsets = keyform.offsets.filter((entry) => entry.vertexId !== vertexId);
  return true;
}

export function retriangulateArtMesh(mesh: RigArtMesh): void {
  type Point = { x: number; y: number; original: number };
  const points: Point[] = mesh.vertices.map((vertex, original) => ({ x: vertex.x, y: vertex.y, original }))
    .filter((point) => finite(point.x) && finite(point.y))
    .sort((a, b) => a.x - b.x || a.y - b.y || a.original - b.original)
    .filter((point, index, all) => index === 0 || point.x !== all[index - 1].x || point.y !== all[index - 1].y);
  if (points.length < 3) { mesh.triangles = []; return; }
  const minX = Math.min(...points.map((point) => point.x));
  const maxX = Math.max(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxY = Math.max(...points.map((point) => point.y));
  const span = Math.max(maxX - minX, maxY - minY);
  if (span <= 1e-9) { mesh.triangles = []; return; }
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const work: Point[] = [...points,
    { x: centerX - span * 32, y: centerY - span * 2, original: -1 },
    { x: centerX, y: centerY + span * 32, original: -2 },
    { x: centerX + span * 32, y: centerY - span * 2, original: -3 }];
  const superStart = points.length;
  let triangles: Array<[number, number, number]> = [[superStart, superStart + 1, superStart + 2]];
  for (let pointIndex = 0; pointIndex < points.length; pointIndex += 1) {
    const bad = triangles.filter((triangle) => pointInCircumcircle(work[pointIndex], work[triangle[0]], work[triangle[1]], work[triangle[2]]));
    const edges = new Map<string, [number, number]>();
    const duplicates = new Set<string>();
    for (const triangle of bad) {
      for (const [a, b] of [[triangle[0], triangle[1]], [triangle[1], triangle[2]], [triangle[2], triangle[0]]] as Array<[number, number]>) {
        const key = a < b ? `${a}:${b}` : `${b}:${a}`;
        if (edges.has(key)) duplicates.add(key); else edges.set(key, [a, b]);
      }
    }
    const badSet = new Set(bad);
    triangles = triangles.filter((triangle) => !badSet.has(triangle));
    for (const [key, edge] of edges) {
      if (!duplicates.has(key) && Math.abs(triangleArea(work[edge[0]], work[edge[1]], work[pointIndex])) > 1e-9) triangles.push([edge[0], edge[1], pointIndex]);
    }
  }
  const result: number[] = [];
  for (const triangle of triangles) {
    if (triangle.some((index) => index >= superStart)) continue;
    let [a, b, c] = triangle.map((index) => points[index].original) as [number, number, number];
    const area = triangleArea(mesh.vertices[a], mesh.vertices[b], mesh.vertices[c]);
    if (Math.abs(area) < 0.0001) continue;
    if (area < 0) [b, c] = [c, b];
    result.push(a, b, c);
  }
  mesh.triangles = result;
}

function pointInCircumcircle(point: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }) {
  const ax = a.x - point.x, ay = a.y - point.y;
  const bx = b.x - point.x, by = b.y - point.y;
  const cx = c.x - point.x, cy = c.y - point.y;
  const determinant = (ax * ax + ay * ay) * (bx * cy - cx * by) - (bx * bx + by * by) * (ax * cy - cx * ay) + (cx * cx + cy * cy) * (ax * by - bx * ay);
  return triangleArea(a, b, c) > 0 ? determinant > 1e-9 : determinant < -1e-9;
}

export function createRectArtMesh(width: number, height: number, options: {
  preset: RigArtMesh["generator"]["preset"];
  columns: number;
  rows: number;
  alphaThreshold?: number;
  alphaBounds?: RigArtMesh["generator"]["alphaBounds"];
  quality?: RigArtMeshQuality;
}): RigArtMesh {
  const columns = clampInteger(options.columns, 1, 16);
  const rows = clampInteger(options.rows, 1, 16);
  const safeWidth = Math.max(1, Math.round(width));
  const safeHeight = Math.max(1, Math.round(height));
  const vertices: RigArtMeshVertex[] = [];
  const triangles: number[] = [];
  for (let row = 0; row <= rows; row += 1) {
    for (let column = 0; column <= columns; column += 1) {
      const u = column / columns;
      const v = row / rows;
      vertices.push({ id: `v-${row}-${column}`, x: safeWidth * u, y: safeHeight * v, u, v });
    }
  }
  const stride = columns + 1;
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const topLeft = row * stride + column;
      const topRight = topLeft + 1;
      const bottomLeft = topLeft + stride;
      const bottomRight = bottomLeft + 1;
      triangles.push(topLeft, topRight, bottomRight, topLeft, bottomRight, bottomLeft);
    }
  }
  return {
    version: 1,
    enabled: true,
    generator: {
      preset: options.preset,
      columns,
      rows,
      alphaThreshold: Math.max(1, Math.min(255, Math.round(options.alphaThreshold ?? 8))),
      alphaBounds: options.alphaBounds ?? { left: 0, top: 0, width: safeWidth, height: safeHeight },
      quality: options.quality
    },
    vertices,
    triangles,
    bindings: []
  };
}

/**
 * Alpha-aware grid generation. Fully transparent cells are omitted and unused
 * vertices are compacted while surviving vertices retain regular UVs.
 */
export function createAlphaContourArtMesh(
  width: number,
  height: number,
  alphaAt: (x: number, y: number) => number,
  options: {
    preset: RigArtMesh["generator"]["preset"];
    columns: number;
    rows: number;
    alphaThreshold?: number;
    alphaBounds?: RigArtMesh["generator"]["alphaBounds"];
    quality?: RigArtMeshQuality;
  }
): RigArtMesh {
  const mesh = createRectArtMesh(width, height, options);
  mesh.generator.topology = "alpha-contour";
  const threshold = mesh.generator.alphaThreshold;
  const columns = mesh.generator.columns;
  const rows = mesh.generator.rows;
  const kept: number[] = [];
  const stride = columns + 1;
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const centerX = ((column + 0.5) / columns) * width;
      const centerY = ((row + 0.5) / rows) * height;
      if (alphaAt(centerX, centerY) < threshold) continue;
      const topLeft = row * stride + column;
      const topRight = topLeft + 1;
      const bottomLeft = topLeft + stride;
      const bottomRight = bottomLeft + 1;
      kept.push(topLeft, topRight, bottomRight, topLeft, bottomRight, bottomLeft);
    }
  }
  if (kept.length >= 3) mesh.triangles = kept;
  compactArtMeshVertices(mesh);
  return mesh;
}
function compactArtMeshVertices(mesh: RigArtMesh): void {
  const used = new Set(mesh.triangles);
  const indexMap = new Map<number, number>();
  const vertices = mesh.vertices.filter((vertex, index) => {
    if (!used.has(index)) return false;
    indexMap.set(index, indexMap.size);
    return true;
  });
  mesh.triangles = mesh.triangles.map((index) => indexMap.get(index) ?? 0);
  mesh.vertices = vertices;
  const ids = new Set(vertices.map((vertex) => vertex.id));
  const boundary = vertices.filter((vertex) => vertex.u === 0 || vertex.u === 1 || vertex.v === 0 || vertex.v === 1).map((vertex) => vertex.id);
  const quality = mesh.generator.quality ?? {};
  mesh.generator.quality = {
    ...quality,
    boundaryVertexIds: quality.boundaryVertexIds?.filter((id) => ids.has(id)) ?? boundary,
    lockedVertexIds: quality.lockedVertexIds?.filter((id) => ids.has(id)) ?? boundary,
    pinnedVertexIds: quality.pinnedVertexIds?.filter((id) => ids.has(id)) ?? boundary
  };
}
export function resolveArtMesh(part: RigPart, width: number, height: number, values: ParameterValues): ResolvedArtMesh | undefined {
  const mesh = part.artMesh;
  if (!mesh?.enabled || !isValidArtMesh(mesh, width, height)) {
    return undefined;
  }
  const offsets = new Map<string, { x: number; y: number }>();
  for (const binding of mesh.bindings ?? []) {
    applyOffsets(offsets, sampleArtMeshBinding(binding, values[binding.parameter] ?? 0), binding.additive);
  }
  // Apply 2D correction only after the legacy 1D stage. The sampler returns an
  // empty map when its enclosing cell lacks any corner, leaving the 1D pose intact.
  for (const binding of mesh.multiBindings ?? []) {
    applyOffsets(offsets, sampleMultiArtMeshBinding(binding, values), binding.additive);
  }
  for (const shape of mesh.blendShapes ?? []) {
    applyOffsets(offsets, sampleArtMeshBlendShape(shape, values[shape.parameter] ?? shape.neutralInput), shape.additive);
  }
  return {
    vertices: mesh.vertices.map((vertex) => {
      const offset = offsets.get(vertex.id) ?? { x: 0, y: 0 };
      return { ...vertex, x: vertex.x + offset.x, y: vertex.y + offset.y };
    }),
    triangles: [...mesh.triangles],
    topology: mesh.generator.topology === "alpha-contour" ? "alpha-contour" : "rect-grid"
  };
}
export function isValidArtMesh(mesh: RigArtMesh | undefined, width?: number, height?: number): mesh is RigArtMesh {
  if (!mesh || mesh.version !== 1 || typeof mesh.enabled !== "boolean" || !Array.isArray(mesh.vertices) || mesh.vertices.length < 3 || !Array.isArray(mesh.triangles) || mesh.triangles.length < 3 || mesh.triangles.length % 3 !== 0) {
    return false;
  }
  if (!mesh.generator || !["eyelid", "eye", "mouth", "outline", "hair-root", "face-feature"].includes(mesh.generator.preset) || !Number.isInteger(mesh.generator.columns) || !Number.isInteger(mesh.generator.rows) || mesh.generator.columns < 1 || mesh.generator.columns > 16 || mesh.generator.rows < 1 || mesh.generator.rows > 16 || !Number.isInteger(mesh.generator.alphaThreshold) || mesh.generator.alphaThreshold < 1 || mesh.generator.alphaThreshold > 255 || !finite(mesh.generator.alphaBounds?.left) || !finite(mesh.generator.alphaBounds?.top) || !finite(mesh.generator.alphaBounds?.width) || !finite(mesh.generator.alphaBounds?.height) || mesh.generator.alphaBounds.width <= 0 || mesh.generator.alphaBounds.height <= 0) {
    return false;
  }
  const ids = new Set<string>();
  for (const vertex of mesh.vertices) {
    if (!vertex || !vertex.id || ids.has(vertex.id) || !finite(vertex.x) || !finite(vertex.y) || !finite(vertex.u) || !finite(vertex.v) || vertex.u < 0 || vertex.u > 1 || vertex.v < 0 || vertex.v > 1) {
      return false;
    }
    ids.add(vertex.id);
  }
  for (let index = 0; index < mesh.triangles.length; index += 3) {
    const a = mesh.triangles[index];
    const b = mesh.triangles[index + 1];
    const c = mesh.triangles[index + 2];
    if (![a, b, c].every((value) => Number.isInteger(value) && value >= 0 && value < mesh.vertices.length) || a === b || b === c || a === c) {
      return false;
    }
    const area = triangleArea(mesh.vertices[a], mesh.vertices[b], mesh.vertices[c]);
    if (Math.abs(area) < 0.0001) return false;
  }
  for (const binding of mesh.bindings ?? []) {
    if (!binding || typeof binding.parameter !== "string" || !binding.parameter.trim() || !Array.isArray(binding.keys)) return false;
    for (const key of binding.keys) {
      if (!key || !finite(key.input) || !Array.isArray(key.offsets)) return false;
      for (const offset of key.offsets) {
        if (!offset || !ids.has(offset.vertexId) || !finite(offset.x) || !finite(offset.y)) return false;
      }
    }
  }
  for (const binding of mesh.multiBindings ?? []) {
    if (!binding || !Array.isArray(binding.parameters) || binding.parameters.length !== 2 || !binding.parameters[0]?.trim() || !binding.parameters[1]?.trim() || binding.parameters[0] === binding.parameters[1] || !Array.isArray(binding.keyforms)) return false;
    for (const keyform of binding.keyforms) {
      if (!keyform || !keyform.inputs || !finite(keyform.inputs[binding.parameters[0]]) || !finite(keyform.inputs[binding.parameters[1]]) || !Array.isArray(keyform.offsets)) return false;
      for (const offset of keyform.offsets) {
        if (!offset || !ids.has(offset.vertexId) || !finite(offset.x) || !finite(offset.y)) return false;
      }
    }
  }
  for (const shape of mesh.blendShapes ?? []) {
    if (!shape || typeof shape.id !== "string" || !shape.id.trim() || typeof shape.parameter !== "string" || !shape.parameter.trim() || !finite(shape.neutralInput) || !finite(shape.targetInput) || shape.neutralInput === shape.targetInput || !Array.isArray(shape.offsets)) return false;
    for (const offset of shape.offsets) {
      if (!offset || !ids.has(offset.vertexId) || !finite(offset.x) || !finite(offset.y)) return false;
    }
  }
  if (mesh.skinning !== undefined) {
    if (mesh.skinning.version !== 1 || !Array.isArray(mesh.skinning.joints) || mesh.skinning.joints.length !== 3 || new Set(mesh.skinning.joints.map((joint) => joint.deformerId)).size !== 3 || !mesh.skinning.vertexWeights || typeof mesh.skinning.vertexWeights !== "object") return false;
    for (const vertex of mesh.vertices) {
      const weights = mesh.skinning.vertexWeights[vertex.id];
      if (!Array.isArray(weights) || !weights.length || weights.length > 3 || weights.some((entry) => !entry || typeof entry.deformerId !== "string" || !finite(entry.weight) || entry.weight < 0)) return false;
    }
  }
  if (width !== undefined && height !== undefined && (!finite(width) || !finite(height) || width <= 0 || height <= 0)) return false;
  return true;
}

export interface ArtMeshQualityIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
  triangleIndex?: number;
  vertexId?: string;
}

/**
 * Structural ArtMesh gate used by validation and numeric QA.
 * Rendering may still fall back to the source image for a malformed mesh, but
 * the malformed topology is now observable instead of silently accepted.
 */
export function inspectArtMeshQuality(mesh: RigArtMesh | undefined, width?: number, height?: number): ArtMeshQualityIssue[] {
  if (!mesh) {
    return [{ severity: "error", code: "missing", message: "ArtMesh is missing." }];
  }
  if (!isValidArtMesh(mesh, width, height)) {
    return [{ severity: "error", code: "invalid", message: "ArtMesh contains invalid generator, vertices, UVs, triangles, or bindings." }];
  }

  const issues: ArtMeshQualityIssue[] = [];
  const vertexIds = new Set(mesh.vertices.map((vertex) => vertex.id));
  const quality = mesh.generator.quality;
  const minTriangleArea = quality?.minTriangleArea;
  const maxTriangleAspectRatio = quality?.maxTriangleAspectRatio;
  if (quality) {
    if (minTriangleArea !== undefined && (!finite(minTriangleArea) || minTriangleArea < 0)) {
      issues.push({ severity: "error", code: "invalid-min-triangle-area", message: "minimum triangle area must be a finite non-negative number." });
    }
    if (maxTriangleAspectRatio !== undefined && (!finite(maxTriangleAspectRatio) || maxTriangleAspectRatio < 1)) {
      issues.push({ severity: "error", code: "invalid-max-triangle-aspect-ratio", message: "maximum triangle aspect ratio must be a finite number greater than or equal to 1." });
    }
    for (const [name, ids] of [["boundaryVertexIds", quality.boundaryVertexIds], ["lockedVertexIds", quality.lockedVertexIds], ["pinnedVertexIds", quality.pinnedVertexIds]] as const) {
      if (ids === undefined) continue;
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !vertexIds.has(id)) || new Set(ids).size !== ids.length) {
        issues.push({ severity: "error", code: `invalid-${name}`, message: `${name} must contain unique existing vertex ids.` });
      }
    }
  }
  const referenced = new Set<number>();
  for (let index = 0; index < mesh.triangles.length; index += 3) {
    const a = mesh.triangles[index];
    const b = mesh.triangles[index + 1];
    const c = mesh.triangles[index + 2];
    referenced.add(a);
    referenced.add(b);
    referenced.add(c);
    const area = triangleArea(mesh.vertices[a], mesh.vertices[b], mesh.vertices[c]);
    if (area < 0) {
      issues.push({ severity: "warning", code: "reversed-winding", message: "Triangle winding is reversed and will be normalized at draw time.", triangleIndex: index / 3 });
    }
    if (minTriangleArea !== undefined && finite(minTriangleArea) && Math.abs(area) < minTriangleArea) {
      issues.push({ severity: "warning", code: "small-triangle", message: `Triangle area ${Math.abs(area).toFixed(4)} is below the configured minimum ${minTriangleArea}.`, triangleIndex: index / 3 });
    }
    const aspect = triangleAspectRatio(mesh.vertices[a], mesh.vertices[b], mesh.vertices[c]);
    if (maxTriangleAspectRatio !== undefined && finite(maxTriangleAspectRatio) && aspect > maxTriangleAspectRatio) {
      issues.push({ severity: "warning", code: "thin-triangle", message: `Triangle aspect ratio ${aspect.toFixed(2)} exceeds the configured maximum ${maxTriangleAspectRatio}.`, triangleIndex: index / 3 });
    }
  }
  mesh.vertices.forEach((vertex, index) => {
    if (!referenced.has(index)) {
      issues.push({ severity: "warning", code: "unreferenced-vertex", message: `Vertex ${vertex.id} is not referenced by any triangle.`, vertexId: vertex.id });
    }
  });
  return issues;
}
function sampleArtMeshBinding(binding: RigArtMeshBinding, input: number): Map<string, { x: number; y: number }> {
  const keys = sortedKeysOrCopy(binding.keys);
  if (!keys.length) return new Map();
  if (input <= keys[0].input) return offsetsForKey(keys[0]);
  const last = keys[keys.length - 1];
  if (input >= last.input) return offsetsForKey(last);
  for (let index = 0; index < keys.length - 1; index += 1) {
    const from = keys[index];
    const to = keys[index + 1];
    if (input < from.input || input > to.input) continue;
    const amount = applyParameterInterpolation(normalizeParameterInterpolation(binding.interpolation), (input - from.input) / (to.input - from.input || 1), binding.curve);
    const fromOffsets = offsetsForKey(from);
    const toOffsets = offsetsForKey(to);
    const ids = new Set([...fromOffsets.keys(), ...toOffsets.keys()]);
    const result = new Map<string, { x: number; y: number }>();
    for (const id of ids) {
      const start = fromOffsets.get(id) ?? { x: 0, y: 0 };
      const end = toOffsets.get(id) ?? { x: 0, y: 0 };
      result.set(id, { x: start.x + (end.x - start.x) * amount, y: start.y + (end.y - start.y) * amount });
    }
    return result;
  }
  return new Map();
}

function offsetsForKey(key: RigArtMeshBinding["keys"][number]) {
  const offsets = new Map<string, { x: number; y: number }>();
  for (const offset of key.offsets ?? []) {
    if (offset && typeof offset.vertexId === "string" && finite(offset.x) && finite(offset.y)) offsets.set(offset.vertexId, { x: offset.x, y: offset.y });
  }
  return offsets;
}

function applyOffsets(target: Map<string, { x: number; y: number }>, sampled: Map<string, { x: number; y: number }>, additive: boolean | undefined) {
  for (const [vertexId, offset] of sampled) {
    const current = target.get(vertexId) ?? { x: 0, y: 0 };
    target.set(vertexId, additive === false ? offset : { x: current.x + offset.x, y: current.y + offset.y });
  }
}
function applyInterpolation(interpolation: ParameterInterpolation, amount: number) {
  const clamped = Math.min(1, Math.max(0, amount));
  if (interpolation === "smoothstep") return clamped * clamped * (3 - 2 * clamped);
  if (interpolation === "hold") return clamped >= 1 ? 1 : 0;
  return clamped;
}

function triangleArea(a: Pick<RigArtMeshVertex, "x" | "y">, b: Pick<RigArtMeshVertex, "x" | "y">, c: Pick<RigArtMeshVertex, "x" | "y">) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}
function triangleAspectRatio(a: Pick<RigArtMeshVertex, "x" | "y">, b: Pick<RigArtMeshVertex, "x" | "y">, c: Pick<RigArtMeshVertex, "x" | "y">) {
  const edges = [distance(a, b), distance(b, c), distance(c, a)];
  const shortest = Math.min(...edges);
  return shortest > 0 ? Math.max(...edges) / shortest : Number.POSITIVE_INFINITY;
}

function distance(a: Pick<RigArtMeshVertex, "x" | "y">, b: Pick<RigArtMeshVertex, "x" | "y">) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}
function clampInteger(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
