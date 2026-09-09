import { createHash } from "node:crypto";
import type { RigArtMesh, RigDocument, RigPart } from "./types.js";

export const GEOMETRY_EXPORT_FORMAT = "standrig-geometry-export" as const;
export const GEOMETRY_EXPORT_VERSION = 1 as const;
export const GEOMETRY_EXPORT_LIMITS = {
  maxVertices: 2048,
  maxTriangles: 8192,
  maxResponseBytes: 256 * 1024,
  maxV11ResponseBytes: 512 * 1024,
  maxV11Components: 2048,
  maxV11BoundaryLoops: 4096,
  maxV11LoopVertices: 4096,
  maxV11Joints: 128,
  maxV11InfluencesPerVertex: 8,
  maxV11TotalInfluences: 65536,
  maxV11DiagnosticsEntries: 8192,
  maxPartIdLength: 128,
  maxQueryLength: 2048,
} as const;

export type GeometryExportErrorCode =
  | "missing_part_id"
  | "part_not_found"
  | "part_has_no_artmesh"
  | "invalid_artmesh"
  | "non_finite_geometry"
  | "invalid_triangle_reference"
  | "response_too_large"
  | "geometry_export_response_too_large"
  | "revision_unavailable"
  | "export_internal_error"
  | "geometry_export_internal_error";

export class GeometryExportError extends Error {
  readonly code: GeometryExportErrorCode;
  constructor(code: GeometryExportErrorCode, message: string) {
    super(message);
    this.name = "GeometryExportError";
    this.code = code;
  }
}

interface GeometryVertex { id: string; x: number; y: number; u?: number; v?: number }
interface GeometryBoundary {
  id: string;
  kind: "outer" | "hole" | "feature" | "unknown";
  vertexIds: string[];
}
interface GeometryMesh {
  coordinateSpace: "standrig-part-local";
  vertices: GeometryVertex[];
  triangles: [string, string, string][];
  boundaries: GeometryBoundary[];
}
interface GeometryConstraints {
  format: "standrig-geometry-constraints";
  version: 1;
  sourceMeshHash: string;
  fixedAnchors: Array<{ vertexId: string; mode: "fixed" }>;
  handles: Array<{ vertexId: string; target: { x: number; y: number }; mode: "hard" }>;
  softHandles: [];
  regions: [];
  weights: [];
  metadata: Record<string, unknown>;
}
export interface GeometryExportDocument {
  format: typeof GEOMETRY_EXPORT_FORMAT;
  version: typeof GEOMETRY_EXPORT_VERSION;
  revision: string;
  sourceHash: string;
  part: { id: string; name: string; role: string; parentId?: string };
  mesh: { neutral: GeometryMesh };
  constraints: GeometryConstraints;
  metadata: {
    source: "standrig-read-only";
    readOnly: true;
    omitted: string[];
    sourceSemanticHash?: string;
    standRig: Record<string, unknown>;
  };
}
export interface GeometryExportMeta {
  revision: string;
  semanticHash?: string;
  exportedAt: string;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
function stableStringify(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
  }
  throw new Error("unsupported canonical value");
}
function sha256(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableStringify(value), "utf8").digest("hex")}`;
}
function edgeKey(a: string, b: string): string {
  return [a, b].sort((left, right) => left.localeCompare(right)).join("|");
}

function deriveBoundaries(triangles: [string, string, string][]): GeometryBoundary[] {
  const counts = new Map<string, { a: string; b: string; count: number }>();
  for (const triangle of triangles) for (let index = 0; index < 3; index += 1) {
    const a = triangle[index];
    const b = triangle[(index + 1) % 3];
    const key = edgeKey(a, b);
    const edge = counts.get(key);
    if (edge) edge.count += 1;
    else counts.set(key, { a, b, count: 1 });
  }
  const edges = [...counts.entries()]
    .filter(([, edge]) => edge.count === 1)
    .map(([key, edge]) => ({ key, a: edge.a, b: edge.b }))
    .sort((a, b) => a.key.localeCompare(b.key));
  const adjacency = new Map<string, Array<{ id: string; key: string }>>();
  for (const edge of edges) {
    const left = adjacency.get(edge.a) ?? [];
    left.push({ id: edge.b, key: edge.key });
    adjacency.set(edge.a, left);
    const right = adjacency.get(edge.b) ?? [];
    right.push({ id: edge.a, key: edge.key });
    adjacency.set(edge.b, right);
  }
  for (const entries of adjacency.values()) entries.sort((a, b) => a.id.localeCompare(b.id));
  const unused = new Set(edges.map((edge) => edge.key));
  const loops: GeometryBoundary[] = [];
  while (unused.size) {
    const firstKey = [...unused].sort((a, b) => a.localeCompare(b))[0];
    const first = edges.find((edge) => edge.key === firstKey)!;
    const start = [first.a, first.b].sort((a, b) => a.localeCompare(b))[0];
    let previous: string | undefined;
    let current = start;
    const loop = [start];
    let guard = 0;
    while (guard++ < edges.length + 2) {
      const next = (adjacency.get(current) ?? []).find((entry) => unused.has(entry.key) && entry.id !== previous)
        ?? (adjacency.get(current) ?? []).find((entry) => unused.has(entry.key));
      if (!next) break;
      unused.delete(next.key);
      previous = current;
      current = next.id;
      if (current === start) break;
      loop.push(current);
    }
    if (loop.length >= 2) loops.push({ id: `boundary:${loop.join("-")}`, kind: "outer", vertexIds: loop });
  }
  return loops.length
    ? loops
    : edges.map((edge) => ({ id: `boundary:${edge.key}`, kind: "outer" as const, vertexIds: [edge.a, edge.b] }));
}

function validateMesh(part: RigPart, artMesh: RigArtMesh): GeometryMesh {
  if (
    artMesh.enabled === false
    || !Array.isArray(artMesh.vertices)
    || !Array.isArray(artMesh.triangles)
    || artMesh.vertices.length < 3
    || artMesh.triangles.length < 3
    || artMesh.triangles.length % 3 !== 0
  ) {
    throw new GeometryExportError("invalid_artmesh", `part ${part.id} has invalid ArtMesh shape`);
  }
  if (
    artMesh.vertices.length > GEOMETRY_EXPORT_LIMITS.maxVertices
    || artMesh.triangles.length / 3 > GEOMETRY_EXPORT_LIMITS.maxTriangles
  ) {
    throw new GeometryExportError("response_too_large", `part ${part.id} exceeds geometry limits`);
  }
  const ids = new Set<string>();
  const vertices: GeometryVertex[] = [];
  for (const vertex of artMesh.vertices) {
    if (!vertex.id || ids.has(vertex.id)) {
      throw new GeometryExportError("invalid_artmesh", `part ${part.id} has duplicate or empty vertex IDs`);
    }
    if (!isFiniteNumber(vertex.x) || !isFiniteNumber(vertex.y) || (vertex.u !== undefined && !isFiniteNumber(vertex.u)) || (vertex.v !== undefined && !isFiniteNumber(vertex.v))) {
      throw new GeometryExportError("non_finite_geometry", "part " + part.id + " has non-finite vertex data");
    }
    ids.add(vertex.id);
    vertices.push({ id: vertex.id, x: vertex.x, y: vertex.y, ...(vertex.u !== undefined ? { u: vertex.u } : {}), ...(vertex.v !== undefined ? { v: vertex.v } : {}) });
  }
  const triangles: [string, string, string][] = [];
  for (let index = 0; index < artMesh.triangles.length; index += 3) {
    const indexes = artMesh.triangles.slice(index, index + 3);
    if (indexes.some((value) => !Number.isInteger(value) || value < 0 || value >= vertices.length)) {
      throw new GeometryExportError("invalid_triangle_reference", `part ${part.id} has an invalid triangle reference`);
    }
    const triangle = indexes.map((value) => vertices[value].id) as [string, string, string];
    if (new Set(triangle).size !== 3) throw new GeometryExportError("invalid_artmesh", `part ${part.id} has a degenerate triangle`);
    const [a, b, c] = indexes.map((value) => vertices[value]);
    if (Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) <= 1e-10) {
      throw new GeometryExportError("invalid_artmesh", `part ${part.id} has a zero-area triangle`);
    }
    triangles.push(triangle);
  }
  vertices.sort((a, b) => a.id.localeCompare(b.id));
  return { coordinateSpace: "standrig-part-local", vertices, triangles, boundaries: deriveBoundaries(triangles) };
}

function candidateIds(value: string[] | undefined, vertexIds: Set<string>): string[] {
  return [...new Set((value ?? []).filter((id) => vertexIds.has(id)))].sort((a, b) => a.localeCompare(b));
}
function buildConstraints(artMesh: RigArtMesh, mesh: GeometryMesh, sourceHash: string): GeometryConstraints {
  const vertexIds = new Set(mesh.vertices.map((vertex) => vertex.id));
  const vertices = new Map(mesh.vertices.map((vertex) => [vertex.id, vertex]));
  const pinned = candidateIds(artMesh.generator.quality?.pinnedVertexIds, vertexIds);
  const locked = candidateIds(artMesh.generator.quality?.lockedVertexIds, vertexIds).filter((id) => !pinned.includes(id));
  return {
    format: "standrig-geometry-constraints",
    version: 1,
    sourceMeshHash: sourceHash,
    fixedAnchors: locked.map((vertexId) => ({ vertexId, mode: "fixed" })),
    handles: pinned.map((vertexId) => ({ vertexId, target: { x: vertices.get(vertexId)!.x, y: vertices.get(vertexId)!.y }, mode: "hard" })),
    softHandles: [],
    regions: [],
    weights: [],
    metadata: { source: "standrig-read-only", derivedFrom: ["artMesh.generator.quality"], semanticConstraints: false },
  };
}

export function exportGeometryPart(rig: RigDocument, partId: string, meta: GeometryExportMeta): GeometryExportDocument {
  if (!meta.revision) throw new GeometryExportError("revision_unavailable", "source revision is unavailable");
  const part = rig.parts.find((entry) => entry.id === partId);
  if (!part) throw new GeometryExportError("part_not_found", `part ${partId} was not found`);
  if (!part.artMesh) throw new GeometryExportError("part_has_no_artmesh", `part ${partId} has no ArtMesh`);
  const mesh = validateMesh(part, part.artMesh);
  const meshDocument = {
    format: "standrig-geometry-mesh",
    version: 1,
    coordinateSpace: mesh.coordinateSpace,
    part: { id: part.id, name: part.name, role: part.role ?? "unknown" },
    vertices: mesh.vertices,
    triangles: mesh.triangles,
    boundaries: mesh.boundaries,
    metadata: { source: "standrig-read-only", partId: part.id },
  };
  const sourceHash = sha256(meshDocument);
  const constraints = buildConstraints(part.artMesh, mesh, sourceHash);
  const deformer = part.deformerId ? rig.deformers?.find((entry) => entry.id === part.deformerId) : undefined;
  const symmetryLinks = (rig.symmetry?.links ?? [])
    .filter((link) => link.sourceId === part.id || link.targetId === part.id)
    .map((link) => ({ kind: link.kind, sourceId: link.sourceId, targetId: link.targetId, axis: link.axis, invertX: link.invertX ?? false }));
  return {
    format: GEOMETRY_EXPORT_FORMAT,
    version: GEOMETRY_EXPORT_VERSION,
    revision: meta.revision,
    sourceHash,
    part: { id: part.id, name: part.name, role: part.role ?? "unknown", ...(part.parentId ? { parentId: part.parentId } : {}) },
    mesh: { neutral: mesh },
    constraints,
    metadata: {
      source: "standrig-read-only",
      readOnly: true,
      omitted: ["texture", "data-url", "PSD", "asset-path", "production-rig", "keyforms", "bindings", "physics", "tracking", "camera", "OBS", "renderer", "history", "undo", "journal", "images", "solver-results", "suggestions", "ARAP", "Laplacian"],
      ...(meta.semanticHash ? { sourceSemanticHash: meta.semanticHash } : {}),
      standRig: {
        exportContractVersion: 1,
        sourceRevision: meta.revision,
        sourceMeshHash: sourceHash,
        semanticHash: meta.semanticHash ?? null,
        exportedAt: meta.exportedAt,
        part: { type: part.kind, visible: part.visible, hasArtMesh: true, roleStatus: part.roleStatus ?? "unconfirmed", roleConfidence: part.roleConfidence ?? null, parentId: part.parentId },
        geometry: { topology: part.artMesh.generator.topology ?? "rect-grid", preset: part.artMesh.generator.preset, quality: part.artMesh.generator.quality ?? null },
        constraints: {
          boundaryVertexIds: mesh.boundaries.flatMap((boundary) => boundary.vertexIds).filter((id, index, list) => list.indexOf(id) === index),
          lockedVertexIds: constraints.fixedAnchors.map((entry) => entry.vertexId),
          pinnedVertexIds: constraints.handles.map((entry) => entry.vertexId),
          parentDeformerId: part.deformerId ?? null,
          parentDeformerKind: deformer?.kind ?? null,
          parentDeformerParentId: deformer?.parentId ?? null,
          symmetry: rig.symmetry ? { axis: rig.symmetry.axis, axisU: rig.symmetry.axisU, pairs: symmetryLinks } : null,
          skinningJoints: part.artMesh.skinning?.joints.map((joint) => ({ deformerId: joint.deformerId, role: joint.role })) ?? [],
          skinningHandleVertexIds: part.artMesh.skinning ? Object.keys(part.artMesh.skinning.vertexWeights).sort((a, b) => a.localeCompare(b)) : [],
        },
      },
    },
  };
}

export function geometryExportByteLength(value: GeometryExportDocument): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
export function geometryExportHashForTest(value: unknown): string { return sha256(value); }





