import { resolveArtMesh } from "./artMesh.js";
import { resolveRigFrame, identityMatrix } from "./evaluator.js";
import { projectArtMeshVertex } from "./glueVertex.js";
import { previewParameterValuesForRig } from "./parameters.js";
import { applySkinningToVertices } from "./skinning.js";
import type { ParameterValues, RigDocument, RigGlueVertexPair, RigPart } from "./types.js";

/**
 * Seam pairing for vertex glue.
 *
 * Live2D authoring is "pick the two boundary vertices that should be the same point". This does the
 * same thing numerically: it evaluates both meshes at the neutral pose, keeps only vertices on the
 * outer boundary of each mesh, and matches each A boundary vertex to its nearest B boundary vertex
 * inside a distance budget. Matching happens once at neutral, so the pairing describes the intended
 * seam rather than whatever the current pose happens to look like.
 */

export interface GlueVertexPairCandidate extends RigGlueVertexPair {
  /** Neutral-pose distance between the two vertices, in stage units. */
  distance: number;
  aPoint: { x: number; y: number };
  bPoint: { x: number; y: number };
}

export interface GlueVertexPairRequest {
  partAId: string;
  partBId: string;
  /** Maximum neutral distance that still counts as the same seam point. */
  maxDistance?: number;
  /** Share of the correction taken by the A side. 0 pins A and drags B onto it. */
  weight?: number;
  maxPairs?: number;
  values?: ParameterValues;
}

export interface GlueVertexPairResult {
  ok: boolean;
  partAId: string;
  partBId: string;
  maxDistance: number;
  weight: number;
  aBoundaryVertices: number;
  bBoundaryVertices: number;
  pairs: GlueVertexPairCandidate[];
  issues: string[];
}

const DEFAULT_MAX_DISTANCE = 24;
const DEFAULT_MAX_PAIRS = 64;

export function buildGlueVertexPairs(rig: RigDocument, request: GlueVertexPairRequest): GlueVertexPairResult {
  const maxDistance = positiveNumber(request.maxDistance, DEFAULT_MAX_DISTANCE);
  const weight = clamp01(request.weight ?? 0.5);
  const maxPairs = Math.max(1, Math.min(256, Math.round(positiveNumber(request.maxPairs, DEFAULT_MAX_PAIRS))));
  const issues: string[] = [];
  const partA = rig.parts.find((part) => part.id === request.partAId);
  const partB = rig.parts.find((part) => part.id === request.partBId);
  const base: GlueVertexPairResult = {
    ok: false,
    partAId: request.partAId,
    partBId: request.partBId,
    maxDistance,
    weight,
    aBoundaryVertices: 0,
    bBoundaryVertices: 0,
    pairs: [],
    issues
  };
  if (!partA || !partB) {
    issues.push("part-not-found");
    return base;
  }
  if (partA.id === partB.id) {
    issues.push("parts-must-differ");
    return base;
  }

  const values = request.values ?? previewParameterValuesForRig(rig);
  const frame = resolveRigFrame(rig, values, identityMatrix(), { physics: false, physicsTime: 0, physicsSteps: 0 });
  const aPoints = boundaryPoints(rig, partA, frame, values, issues, "a");
  const bPoints = boundaryPoints(rig, partB, frame, values, issues, "b");
  base.aBoundaryVertices = aPoints.length;
  base.bBoundaryVertices = bPoints.length;
  if (!aPoints.length || !bPoints.length) {
    return base;
  }

  // Greedy nearest-neighbour over the candidate distances, shortest first. Each vertex may only be
  // claimed once, so two A vertices never fight over the same B target.
  const scored: GlueVertexPairCandidate[] = [];
  for (const a of aPoints) {
    for (const b of bPoints) {
      const distance = Math.hypot(b.point.x - a.point.x, b.point.y - a.point.y);
      if (distance <= maxDistance) {
        // Record the neutral A->B offset so the stitch holds the seam at its authored shape
        // instead of collapsing overlapping parts onto each other.
        scored.push({
          a: a.id,
          b: b.id,
          weight,
          restDx: b.point.x - a.point.x,
          restDy: b.point.y - a.point.y,
          distance,
          aPoint: a.point,
          bPoint: b.point
        });
      }
    }
  }
  scored.sort((left, right) => left.distance - right.distance);

  const usedA = new Set<string>();
  const usedB = new Set<string>();
  const pairs: GlueVertexPairCandidate[] = [];
  for (const candidate of scored) {
    if (pairs.length >= maxPairs) {
      break;
    }
    if (usedA.has(candidate.a) || usedB.has(candidate.b)) {
      continue;
    }
    usedA.add(candidate.a);
    usedB.add(candidate.b);
    pairs.push(candidate);
  }

  if (!pairs.length) {
    issues.push("no-vertex-pair-within-max-distance");
  }
  base.pairs = pairs;
  base.ok = pairs.length > 0;
  return base;
}

function boundaryPoints(
  rig: RigDocument,
  part: RigPart,
  frame: ReturnType<typeof resolveRigFrame>,
  values: ParameterValues,
  issues: string[],
  side: "a" | "b"
): Array<{ id: string; point: { x: number; y: number } }> {
  const state = frame.parts.get(part.id);
  const asset = rig.assets.find((entry) => entry.id === part.assetId);
  if (!state || !asset) {
    issues.push(`${side}-part-not-renderable`);
    return [];
  }
  if (!part.artMesh?.enabled) {
    issues.push(`${side}-part-has-no-artmesh`);
    return [];
  }
  const width = asset.width ?? 0;
  const height = asset.height ?? 0;
  if (!(width > 0 && height > 0)) {
    issues.push(`${side}-asset-size-unknown`);
    return [];
  }
  const baseMesh = resolveArtMesh(part, width, height, values);
  if (!baseMesh) {
    issues.push(`${side}-artmesh-unresolved`);
    return [];
  }
  const mesh = part.artMesh.skinning
    ? { ...baseMesh, vertices: applySkinningToVertices(baseMesh.vertices, part.artMesh.skinning, frame.skinningTransforms) }
    : baseMesh;

  const boundary = boundaryVertexIds(part, mesh);
  const points: Array<{ id: string; point: { x: number; y: number } }> = [];
  for (const vertex of mesh.vertices) {
    if (!boundary.has(vertex.id)) {
      continue;
    }
    const point = projectArtMeshVertex(vertex, {
      pose: state.pose,
      matrix: state.matrix,
      baseMatrix: identityMatrix(),
      sharedWarps: state.sharedWarps,
      warp: state.warp,
      sourceWidth: width,
      sourceHeight: height
    });
    if (Number.isFinite(point.x) && Number.isFinite(point.y)) {
      points.push({ id: vertex.id, point });
    }
  }
  return points;
}

/**
 * Outer boundary of the mesh. The generator records a boundary list, but a rebuilt mesh may not
 * have one, so fall back to topology: an edge used by exactly one triangle is on the outline.
 */
function boundaryVertexIds(part: RigPart, mesh: { vertices: Array<{ id: string }>; triangles: number[] }): Set<string> {
  const declared = part.artMesh?.generator?.quality?.boundaryVertexIds;
  if (Array.isArray(declared) && declared.length) {
    return new Set(declared);
  }
  const edgeUse = new Map<string, number>();
  const edgeKey = (left: number, right: number) => (left < right ? `${left}|${right}` : `${right}|${left}`);
  for (let index = 0; index < mesh.triangles.length; index += 3) {
    const a = mesh.triangles[index];
    const b = mesh.triangles[index + 1];
    const c = mesh.triangles[index + 2];
    for (const [left, right] of [[a, b], [b, c], [c, a]] as const) {
      const key = edgeKey(left, right);
      edgeUse.set(key, (edgeUse.get(key) ?? 0) + 1);
    }
  }
  const ids = new Set<string>();
  for (const [key, uses] of edgeUse) {
    if (uses !== 1) {
      continue;
    }
    for (const raw of key.split("|")) {
      const vertex = mesh.vertices[Number(raw)];
      if (vertex) {
        ids.add(vertex.id);
      }
    }
  }
  return ids;
}

function positiveNumber(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) > 0 ? (value as number) : fallback;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0.5));
}
