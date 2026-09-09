import { resolveArtMesh } from "./artMesh.js";
import type { ParameterValues, RigArtMeshVertex, RigDocument } from "./types.js";

export interface ArtMeshDistortionThresholds {
  maxStretchRatio?: number;
  maxCompressionRatio?: number;
  maxAnisotropy?: number;
}

export interface ArtMeshTriangleDistortion {
  partId: string;
  triangleIndex: number;
  stretchRatio: number;
  compressionRatio: number;
  anisotropy: number;
  areaRatio: number;
  inverted: boolean;
  degenerate: boolean;
}

export interface ArtMeshDistortionAudit {
  partCount: number;
  triangleCount: number;
  maxStretchRatio: number;
  maxCompressionRatio: number;
  maxAnisotropy: number;
  invertedTriangleCount: number;
  degenerateTriangleCount: number;
  thresholds: Required<ArtMeshDistortionThresholds>;
  violations: ArtMeshTriangleDistortion[];
  worstTriangles: ArtMeshTriangleDistortion[];
  pass: boolean;
}

const EPSILON = 1e-8;

export function auditRigArtMeshDistortion(
  rig: RigDocument,
  values: ParameterValues,
  options: ArtMeshDistortionThresholds = {}
): ArtMeshDistortionAudit {
  const thresholds = {
    maxStretchRatio: positive(options.maxStretchRatio, 4),
    maxCompressionRatio: positive(options.maxCompressionRatio, 4),
    maxAnisotropy: positive(options.maxAnisotropy, 6)
  };
  const triangles: ArtMeshTriangleDistortion[] = [];
  let partCount = 0;
  for (const part of rig.parts) {
    const mesh = part.artMesh;
    if (!mesh?.enabled) continue;
    const asset = part.assetId ? rig.assets.find((entry) => entry.id === part.assetId) : undefined;
    const width = positive(asset?.width, Math.max(1, mesh.generator.alphaBounds.width));
    const height = positive(asset?.height, Math.max(1, mesh.generator.alphaBounds.height));
    const resolved = resolveArtMesh(part, width, height, values);
    if (!resolved) continue;
    partCount += 1;
    for (let offset = 0; offset < mesh.triangles.length; offset += 3) {
      const indices = mesh.triangles.slice(offset, offset + 3);
      const rest = indices.map((index) => mesh.vertices[index]);
      const posed = indices.map((index) => resolved.vertices[index]);
      if (rest.some((vertex) => !vertex) || posed.some((vertex) => !vertex)) continue;
      triangles.push(measureTriangle(part.id, offset / 3, rest as [RigArtMeshVertex, RigArtMeshVertex, RigArtMeshVertex], posed as [RigArtMeshVertex, RigArtMeshVertex, RigArtMeshVertex]));
    }
  }
  const violations = triangles.filter((entry) => entry.degenerate || entry.inverted || entry.stretchRatio > thresholds.maxStretchRatio || entry.compressionRatio > thresholds.maxCompressionRatio || entry.anisotropy > thresholds.maxAnisotropy);
  const rankedTriangles = violations.length ? violations : triangles;
  const worstTriangles = [...rankedTriangles]
    .sort((left, right) => distortionScore(right, thresholds) - distortionScore(left, thresholds) || left.partId.localeCompare(right.partId) || left.triangleIndex - right.triangleIndex)
    .slice(0, violations.length ? 8 : 3);
  return {
    partCount,
    triangleCount: triangles.length,
    maxStretchRatio: finiteMaximum(triangles.map((entry) => entry.stretchRatio), 1),
    maxCompressionRatio: finiteMaximum(triangles.map((entry) => entry.compressionRatio), 1),
    maxAnisotropy: finiteMaximum(triangles.map((entry) => entry.anisotropy), 1),
    invertedTriangleCount: triangles.filter((entry) => entry.inverted).length,
    degenerateTriangleCount: triangles.filter((entry) => entry.degenerate).length,
    thresholds,
    violations: violations.slice(0, 32),
    worstTriangles,
    pass: violations.length === 0
  };
}

function measureTriangle(
  partId: string,
  triangleIndex: number,
  rest: [RigArtMeshVertex, RigArtMeshVertex, RigArtMeshVertex],
  posed: [RigArtMeshVertex, RigArtMeshVertex, RigArtMeshVertex]
): ArtMeshTriangleDistortion {
  const restMatrix = edgeMatrix(rest);
  const posedMatrix = edgeMatrix(posed);
  const restDeterminant = determinant(restMatrix);
  if (Math.abs(restDeterminant) <= EPSILON) return { partId, triangleIndex, stretchRatio: Number.POSITIVE_INFINITY, compressionRatio: Number.POSITIVE_INFINITY, anisotropy: Number.POSITIVE_INFINITY, areaRatio: 0, inverted: false, degenerate: true };
  const inverseRest = { a: restMatrix.d / restDeterminant, b: -restMatrix.b / restDeterminant, c: -restMatrix.c / restDeterminant, d: restMatrix.a / restDeterminant };
  const affine = multiply(posedMatrix, inverseRest);
  const affineDeterminant = determinant(affine);
  const singular = singularValues(affine);
  const degenerate = singular.min <= EPSILON || !Number.isFinite(singular.max) || !Number.isFinite(singular.min);
  return {
    partId,
    triangleIndex,
    stretchRatio: degenerate ? Number.POSITIVE_INFINITY : Math.max(1, singular.max),
    compressionRatio: degenerate ? Number.POSITIVE_INFINITY : Math.max(1, 1 / singular.min),
    anisotropy: degenerate ? Number.POSITIVE_INFINITY : Math.max(1, singular.max / singular.min),
    areaRatio: Math.abs(affineDeterminant),
    inverted: affineDeterminant < 0,
    degenerate
  };
}

function edgeMatrix(vertices: [RigArtMeshVertex, RigArtMeshVertex, RigArtMeshVertex]) {
  const [a, b, c] = vertices;
  return { a: b.x - a.x, b: c.x - a.x, c: b.y - a.y, d: c.y - a.y };
}
function multiply(left: { a: number; b: number; c: number; d: number }, right: { a: number; b: number; c: number; d: number }) {
  return { a: left.a * right.a + left.b * right.c, b: left.a * right.b + left.b * right.d, c: left.c * right.a + left.d * right.c, d: left.c * right.b + left.d * right.d };
}
function determinant(matrix: { a: number; b: number; c: number; d: number }) { return matrix.a * matrix.d - matrix.b * matrix.c; }
function singularValues(matrix: { a: number; b: number; c: number; d: number }) {
  const m00 = matrix.a * matrix.a + matrix.c * matrix.c;
  const m01 = matrix.a * matrix.b + matrix.c * matrix.d;
  const m11 = matrix.b * matrix.b + matrix.d * matrix.d;
  const trace = m00 + m11;
  const discriminant = Math.sqrt(Math.max(0, (m00 - m11) * (m00 - m11) + 4 * m01 * m01));
  return { max: Math.sqrt(Math.max(0, (trace + discriminant) / 2)), min: Math.sqrt(Math.max(0, (trace - discriminant) / 2)) };
}
function distortionScore(entry: ArtMeshTriangleDistortion, thresholds: Required<ArtMeshDistortionThresholds>) {
  if (entry.degenerate || entry.inverted) return Number.POSITIVE_INFINITY;
  return Math.max(entry.stretchRatio / thresholds.maxStretchRatio, entry.compressionRatio / thresholds.maxCompressionRatio, entry.anisotropy / thresholds.maxAnisotropy);
}
function finiteMaximum(values: number[], fallback: number) { return values.some((value) => !Number.isFinite(value)) ? Number.POSITIVE_INFINITY : values.length ? Math.max(...values) : fallback; }
function positive(value: unknown, fallback: number) { const numeric = Number(value); return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback; }
