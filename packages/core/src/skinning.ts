import { transformMatrixPoint, type Matrix2D } from "./evaluator.js";
import type { RigArtMesh, RigArtMeshSkinning, RigArtMeshSkinningInfluence, RigArtMeshVertex } from "./types.js";

export interface SkinningGenerationOptions {
  rootBand?: number;
  tipBand?: number;
}

export interface SkinningAuditResult {
  pass: boolean;
  vertexCount: number;
  weightedVertexCount: number;
  maxInfluences: number;
  maxWeightSumError: number;
  maxEdgeWeightDelta: number;
  rootPinnedCoverage: number;
  issues: string[];
}

export interface SkinningJointTransform {
  deformerId: string;
  matrix: Matrix2D;
}

/** Generate conservative root/middle/tip weights from the mesh's local V axis. */
export function generateArtMeshSkinning(mesh: RigArtMesh, deformerIds: string[], options: SkinningGenerationOptions = {}): { skinning?: RigArtMeshSkinning; issues: string[] } {
  const ids = deformerIds.filter((id): id is string => typeof id === "string" && Boolean(id.trim()));
  const issues: string[] = [];
  if (ids.length !== 3 || new Set(ids).size !== 3) return { issues: ["exactly three unique deformerIds are required for root/middle/tip skinning"] };
  if (!mesh.vertices.length) return { issues: ["mesh has no vertices"] };
  const minV = Math.min(...mesh.vertices.map((vertex) => vertex.v));
  const maxV = Math.max(...mesh.vertices.map((vertex) => vertex.v));
  const span = Math.max(0.0001, maxV - minV);
  const rootBand = clamp(Number(options.rootBand ?? 0.08), 0.01, 0.25);
  const tipBand = clamp(Number(options.tipBand ?? 0.05), 0.01, 0.25);
  const pinned = new Set(mesh.generator.quality?.pinnedVertexIds ?? []);
  const vertexWeights: Record<string, RigArtMeshSkinningInfluence[]> = {};
  for (const vertex of mesh.vertices) {
    const t = clamp((vertex.v - minV) / span, 0, 1);
    if (pinned.has(vertex.id) && t <= rootBand || t <= rootBand) {
      vertexWeights[vertex.id] = [{ deformerId: ids[0], weight: 1 }];
      continue;
    }
    if (t >= 1 - tipBand) {
      vertexWeights[vertex.id] = [{ deformerId: ids[2], weight: 1 }];
      continue;
    }
    const position = t * 2;
    if (position <= 1) vertexWeights[vertex.id] = [{ deformerId: ids[0], weight: 1 - position }, { deformerId: ids[1], weight: position }];
    else vertexWeights[vertex.id] = [{ deformerId: ids[1], weight: 2 - position }, { deformerId: ids[2], weight: position - 1 }];
  }
  return { skinning: { version: 1, joints: [{ deformerId: ids[0], role: "root" }, { deformerId: ids[1], role: "middle" }, { deformerId: ids[2], role: "tip" }], vertexWeights }, issues };
}

/** Validate weights before a candidate is allowed to reach a transaction. */
export function auditArtMeshSkinning(mesh: RigArtMesh, skinning: RigArtMeshSkinning | undefined, knownDeformerIds?: ReadonlySet<string>): SkinningAuditResult {
  const issues: string[] = [];
  const vertices = mesh.vertices ?? [];
  const vertexIds = new Set(vertices.map((vertex) => vertex.id));
  if (!skinning || skinning.version !== 1) return failAudit(vertices.length, "skinning profile is missing or has an unsupported version");
  if (skinning.joints.length !== 3 || new Set(skinning.joints.map((joint) => joint.deformerId)).size !== 3) issues.push("skinning must contain three unique joints");
  if (skinning.joints.map((joint) => joint.role).join(",") !== "root,middle,tip") issues.push("joint roles must be root,middle,tip in order");
  if (knownDeformerIds) for (const joint of skinning.joints) if (!knownDeformerIds.has(joint.deformerId)) issues.push(`missing deformer: ${joint.deformerId}`);
  let weightedVertexCount = 0;
  let maxInfluences = 0;
  let maxWeightSumError = 0;
  let rootPinnedCoverage = 1;
  const rootId = skinning.joints[0]?.deformerId;
  for (const vertex of vertices) {
    const weights = skinning.vertexWeights?.[vertex.id] ?? [];
    if (!weights.length) { issues.push(`vertex has no weights: ${vertex.id}`); continue; }
    weightedVertexCount += 1;
    maxInfluences = Math.max(maxInfluences, weights.length);
    const sum = weights.reduce((total, entry) => total + entry.weight, 0);
    maxWeightSumError = Math.max(maxWeightSumError, Math.abs(sum - 1));
    if (weights.length > 3) issues.push(`vertex has more than three influences: ${vertex.id}`);
    if (weights.some((entry) => !vertexIds.has(vertex.id) || !Number.isFinite(entry.weight) || entry.weight < 0 || !skinning.joints.some((joint) => joint.deformerId === entry.deformerId))) issues.push(`invalid influence: ${vertex.id}`);
    if ((vertex.v <= Math.min(...vertices.map((entry) => entry.v)) + 0.05) && rootId) rootPinnedCoverage = Math.min(rootPinnedCoverage, weights.find((entry) => entry.deformerId === rootId)?.weight ?? 0);
  }
  let maxEdgeWeightDelta = 0;
  for (let index = 0; index + 2 < mesh.triangles.length; index += 3) {
    const triangle = mesh.triangles.slice(index, index + 3);
    for (const [a, b] of [[triangle[0], triangle[1]], [triangle[1], triangle[2]], [triangle[2], triangle[0]]] as Array<[number, number]>) {
      const left = vertices[a]; const right = vertices[b];
      if (!left || !right) continue;
      maxEdgeWeightDelta = Math.max(maxEdgeWeightDelta, weightDelta(skinning.vertexWeights[left.id] ?? [], skinning.vertexWeights[right.id] ?? []));
    }
  }
  if (weightedVertexCount !== vertices.length) issues.push(`${vertices.length - weightedVertexCount} vertex weights are missing`);
  if (maxWeightSumError > 0.001) issues.push(`weight sums drift by ${maxWeightSumError.toFixed(5)}`);
  if (rootPinnedCoverage < 0.98) issues.push(`root band is not pinned strongly enough (${rootPinnedCoverage.toFixed(3)})`);
  if (maxEdgeWeightDelta > 1.25) issues.push(`neighboring weights jump by ${maxEdgeWeightDelta.toFixed(3)}`);
  return { pass: issues.length === 0, vertexCount: vertices.length, weightedVertexCount, maxInfluences, maxWeightSumError, maxEdgeWeightDelta, rootPinnedCoverage, issues };
}

export function applySkinningToVertex(vertex: RigArtMeshVertex, skinning: RigArtMeshSkinning, transforms: ReadonlyMap<string, Matrix2D>): { x: number; y: number } {
  const weights = skinning.vertexWeights[vertex.id] ?? [];
  let x = 0; let y = 0; let total = 0;
  for (const influence of weights) {
    const matrix = transforms.get(influence.deformerId);
    if (!matrix || !Number.isFinite(influence.weight)) continue;
    const point = transformMatrixPoint(matrix, vertex.x, vertex.y);
    x += point.x * influence.weight; y += point.y * influence.weight; total += influence.weight;
  }
  return total > 0 ? { x: x / total, y: y / total } : { x: vertex.x, y: vertex.y };
}

/** Apply the same weighted result to a resolved ArtMesh vertex list. */
export function applySkinningToVertices<T extends { id: string; x: number; y: number }>(
  vertices: readonly T[],
  skinning: RigArtMeshSkinning | undefined,
  transforms: ReadonlyMap<string, Matrix2D> | undefined
): T[] {
  if (!skinning || !transforms || !transforms.size) return vertices.map((vertex) => ({ ...vertex }));
  return vertices.map((vertex) => {
    const moved = applySkinningToVertex(vertex as unknown as RigArtMeshVertex, skinning, transforms);
    return { ...vertex, x: moved.x, y: moved.y };
  });
}

function weightDelta(left: RigArtMeshSkinningInfluence[], right: RigArtMeshSkinningInfluence[]): number {
  const ids = new Set([...left.map((entry) => entry.deformerId), ...right.map((entry) => entry.deformerId)]);
  return [...ids].reduce((sum, id) => sum + Math.abs((left.find((entry) => entry.deformerId === id)?.weight ?? 0) - (right.find((entry) => entry.deformerId === id)?.weight ?? 0)), 0);
}
function failAudit(vertexCount: number, issue: string): SkinningAuditResult { return { pass: false, vertexCount, weightedVertexCount: 0, maxInfluences: 0, maxWeightSumError: 1, maxEdgeWeightDelta: 0, rootPinnedCoverage: 0, issues: [issue] }; }
function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min)); }
