import { createHash } from "node:crypto";
import { GEOMETRY_EXPORT_LIMITS, GeometryExportError, exportGeometryPart, geometryExportByteLength, type GeometryExportDocument, type GeometryExportMeta } from "./geometryExport.js";
import type { RigArtMeshSkinning, RigDocument } from "./types.js";

export const GEOMETRY_EXPORT_CONTRACT_V11 = "1.1" as const;
export type GeometryExportDetailStatus = "complete" | "partial" | "not-present" | "unsupported" | "invalid" | "ambiguous";
export type GeometryLoopClassification = "outer" | "hole" | "unknown";

export interface GeometryTopologyComponentV11 {
  id: string;
  triangleIndices: number[];
  vertexIds: string[];
  triangleCount: number;
  vertexCount: number;
  boundaryLoopIds: string[];
  isolatedVertexIds: string[];
}
export interface GeometryBoundaryLoopV11 {
  id: string;
  componentId: string;
  orderedVertexIds: string[];
  orderedEdgePairs: Array<[string, string]>;
  closed: boolean;
  signedArea: number | null;
  absoluteArea: number | null;
  nestingDepth: number | null;
  classification: GeometryLoopClassification;
  orientation: "cw" | "ccw" | "unknown";
  diagnostics: string[];
}
export interface GeometryTopologyDetailsV11 {
  status: GeometryExportDetailStatus;
  topologyKind: "rect-grid" | "alpha-contour" | "unknown";
  componentCount: number;
  components: GeometryTopologyComponentV11[];
  boundaryLoops: GeometryBoundaryLoopV11[];
  completeness: {
    allTrianglesAssignedToComponent: boolean;
    allBoundaryEdgesAssigned: boolean;
    allLoopsClosed: boolean;
    outerHoleClassificationComplete: boolean;
    nonManifoldDetected: boolean;
    ambiguousBoundaryDetected: boolean;
    unsupportedCaseDetected: boolean;
  };
  diagnostics: string[];
}
export interface GeometrySkinningJointV11 {
  jointId: string;
  deformerId: string;
  role: "root" | "middle" | "tip" | "other" | "unknown";
  order: number;
  validDeformerReference: boolean;
  duplicate: boolean;
}
export interface GeometryVertexInfluenceV11 {
  jointId: string | null;
  deformerId: string;
  weight: number;
}
export interface GeometrySkinningDetailsV11 {
  status: GeometryExportDetailStatus;
  joints: GeometrySkinningJointV11[];
  vertexInfluences: Record<string, GeometryVertexInfluenceV11[]>;
  validation: {
    finite: boolean;
    nonNegative: boolean;
    duplicateJoint: boolean;
    unknownJoint: boolean;
    unknownVertex: boolean;
    maxInfluences: number;
    maximumSumError: number | null;
    normalizationStatus: "valid" | "invalid" | "not-evaluated";
    invalidVertexIds: string[];
    missingExpectedVertexIds: string[];
    zeroInfluenceVertexIds: string[];
  };
  runtimeComposition: {
    keyformOffsetsBeforeSkinning: true;
    skinningUsesNeutralRelativeDeformerTransforms: true;
    parentDeformerComposition: "present-in-render-path";
    doubleTransformRisk: "must-diagnose";
  };
  diagnostics: string[];
}
export interface GeometryExportV11Document extends GeometryExportDocument {
  contractVersion: typeof GEOMETRY_EXPORT_CONTRACT_V11;
  semanticHash?: string;
  topologyDetails: GeometryTopologyDetailsV11;
  skinningDetails: GeometrySkinningDetailsV11;
  capabilities: {
    topologyDetails: { status: GeometryExportDetailStatus; reasonCode: string | null };
    skinningDetails: { status: GeometryExportDetailStatus; reasonCode: string | null };
  };
  topologyDetailsHash: string;
  skinningDetailsHash: string;
  exportPayloadHash: string;
}

function stableStringify(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") { if (!Number.isFinite(value)) throw new Error("non-finite"); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object" && value !== null) { const record = value as Record<string, unknown>; return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`; }
  throw new Error("unsupported canonical value");
}
function hash(value: unknown): string { return `sha256:${createHash("sha256").update(stableStringify(value), "utf8").digest("hex")}`; }
function edgeKey(a: string, b: string): string { return [a, b].sort((left, right) => left.localeCompare(right)).join("|"); }
function compareStrings(left: string, right: string): number { return left.localeCompare(right); }
function canonicalLoop(vertices: string[]): string[] {
  if (!vertices.length) return [];
  const startIndex = vertices.reduce((best, value, index) => compareStrings(value, vertices[best]) < 0 ? index : best, 0);
  const rotated = (direction: 1 | -1): string[] => vertices.map((_, offset) => vertices[(startIndex + direction * offset + vertices.length * 4) % vertices.length]);
  const forward = rotated(1); const reverse = rotated(-1);
  return stableStringify(forward) <= stableStringify(reverse) ? forward : reverse;
}
function polygonArea(ids: string[], coords: Map<string, { x: number; y: number }>): number | null {
  if (ids.length < 3) return null;
  let area = 0;
  for (let index = 0; index < ids.length; index += 1) { const left = coords.get(ids[index]); const right = coords.get(ids[(index + 1) % ids.length]); if (!left || !right) return null; area += left.x * right.y - right.x * left.y; }
  return area / 2;
}
function pointOnSegment(point: { x: number; y: number }, left: { x: number; y: number }, right: { x: number; y: number }): boolean { const cross = (point.x - left.x) * (right.y - left.y) - (point.y - left.y) * (right.x - left.x); if (Math.abs(cross) > 1e-8) return false; return point.x >= Math.min(left.x, right.x) - 1e-8 && point.x <= Math.max(left.x, right.x) + 1e-8 && point.y >= Math.min(left.y, right.y) - 1e-8 && point.y <= Math.max(left.y, right.y) + 1e-8; }
function pointInPolygon(point: { x: number; y: number }, ids: string[], coords: Map<string, { x: number; y: number }>): "inside" | "outside" | "boundary" {
  let inside = false;
  for (let index = 0; index < ids.length; index += 1) { const left = coords.get(ids[index]); const right = coords.get(ids[(index + 1) % ids.length]); if (!left || !right) return "boundary"; if (pointOnSegment(point, left, right)) return "boundary"; const intersects = ((left.y > point.y) !== (right.y > point.y)) && point.x < ((right.x - left.x) * (point.y - left.y)) / (right.y - left.y) + left.x; if (intersects) inside = !inside; }
  return inside ? "inside" : "outside";
}
function representative(ids: string[], coords: Map<string, { x: number; y: number }>): { x: number; y: number } | undefined { const points = ids.map((id) => coords.get(id)).filter((point): point is { x: number; y: number } => Boolean(point)); if (!points.length) return undefined; return { x: points.reduce((sum, point) => sum + point.x, 0) / points.length, y: points.reduce((sum, point) => sum + point.y, 0) / points.length }; }

interface EdgeRecord { key: string; a: string; b: string; count: number; triangleIndices: number[] }
function buildEdges(triangles: [string, string, string][]): Map<string, EdgeRecord> {
  const map = new Map<string, EdgeRecord>();
  triangles.forEach((triangle, triangleIndex) => triangle.forEach((a, index) => { const b = triangle[(index + 1) % 3]; const key = edgeKey(a, b); const current = map.get(key); if (current) { current.count += 1; current.triangleIndices.push(triangleIndex); } else map.set(key, { key, a: [a, b].sort(compareStrings)[0], b: [a, b].sort(compareStrings)[1], count: 1, triangleIndices: [triangleIndex] }); }));
  return map;
}
function extractTopology(base: GeometryExportDocument, topologyKind: GeometryTopologyDetailsV11["topologyKind"]): GeometryTopologyDetailsV11 {
  const vertices = base.mesh.neutral.vertices; const triangles = base.mesh.neutral.triangles; const ids = vertices.map((vertex) => vertex.id); const coords = new Map(vertices.map((vertex) => [vertex.id, { x: vertex.x, y: vertex.y }]));
  const edges = buildEdges(triangles); const triangleAdjacency = new Map<number, Set<number>>(); triangles.forEach((_, index) => triangleAdjacency.set(index, new Set()));
  for (const edge of edges.values()) if (edge.triangleIndices.length > 1) for (const left of edge.triangleIndices) for (const right of edge.triangleIndices) if (left !== right) triangleAdjacency.get(left)?.add(right);
  const componentByTriangle = new Map<number, number>(); const triangleComponents: number[][] = [];
  for (let start = 0; start < triangles.length; start += 1) { if (componentByTriangle.has(start)) continue; const queue = [start]; const members: number[] = []; componentByTriangle.set(start, -1); while (queue.length) { const current = queue.shift()!; members.push(current); for (const next of triangleAdjacency.get(current) ?? []) if (!componentByTriangle.has(next)) { componentByTriangle.set(next, -1); queue.push(next); } } triangleComponents.push(members.sort((a, b) => a - b)); }
  const components = triangleComponents.map((triangleIndices) => { const vertexIds = [...new Set(triangleIndices.flatMap((index) => triangles[index]))].sort(compareStrings); return { triangleIndices, vertexIds, minVertexId: vertexIds[0] ?? "" }; }).sort((left, right) => compareStrings(left.minVertexId, right.minVertexId));
  const componentIdByTriangleIndex = new Map<number, string>(); components.forEach((component) => { const id = `component:${component.minVertexId}`; component.triangleIndices.forEach((index) => componentIdByTriangleIndex.set(index, id)); });
  const boundaryEdges = [...edges.values()].filter((edge) => edge.count === 1).sort((left, right) => compareStrings(left.key, right.key)); const nonManifold = [...edges.values()].filter((edge) => edge.count > 2); const adjacency = new Map<string, EdgeRecord[]>(); for (const edge of boundaryEdges) { const a = adjacency.get(edge.a) ?? []; a.push(edge); adjacency.set(edge.a, a); const b = adjacency.get(edge.b) ?? []; b.push(edge); adjacency.set(edge.b, b); } for (const list of adjacency.values()) list.sort((left, right) => compareStrings(left.key, right.key));
  const unused = new Set(boundaryEdges.map((edge) => edge.key)); const loops: GeometryBoundaryLoopV11[] = []; let ambiguous = false;
  while (unused.size) { const first = boundaryEdges.find((edge) => unused.has(edge.key))!; const start = compareStrings(first.a, first.b) <= 0 ? first.a : first.b; const ordered = [start]; const usedEdges: string[] = []; let current = start; let previous: string | undefined; let closed = false; const diagnostics: string[] = []; for (let guard = 0; guard < boundaryEdges.length + 2; guard += 1) { const candidates = (adjacency.get(current) ?? []).filter((edge) => unused.has(edge.key)).sort((left, right) => compareStrings(left.key, right.key)); const next = candidates.find((edge) => (edge.a === current ? edge.b : edge.a) !== previous) ?? candidates[0]; if (!next) break; unused.delete(next.key); usedEdges.push(next.key); const nextVertex = next.a === current ? next.b : next.a; if (nextVertex === start) { closed = true; break; } if (ordered.includes(nextVertex)) { diagnostics.push("self_intersection_or_repeated_vertex"); ambiguous = true; break; } ordered.push(nextVertex); previous = current; current = nextVertex; }
    if ((adjacency.get(start)?.length ?? 0) !== 2) diagnostics.push("branching_boundary"); if (!closed) diagnostics.push("open_boundary_chain"); if (diagnostics.length) ambiguous = true; const canonical = canonicalLoop(ordered); const area = closed ? polygonArea(canonical, coords) : null; const componentIds = [...new Set(usedEdges.flatMap((key) => edges.get(key)?.triangleIndices ?? []).map((index) => componentIdByTriangleIndex.get(index)).filter((id): id is string => Boolean(id)))].sort(compareStrings); const componentId = componentIds[0] ?? "component:unknown"; const id = `loop:${canonical.join("-") || first.key}`; loops.push({ id, componentId, orderedVertexIds: canonical, orderedEdgePairs: canonical.length && closed ? canonical.map((vertex, index) => [vertex, canonical[(index + 1) % canonical.length]]) : [], closed, signedArea: area, absoluteArea: area === null ? null : Math.abs(area), nestingDepth: null, classification: "unknown", orientation: area === null ? "unknown" : area < 0 ? "cw" : "ccw", diagnostics: [...new Set(diagnostics)].sort(compareStrings) }); }
  const loopsByComponent = new Map<string, GeometryBoundaryLoopV11[]>(); for (const loop of loops) { const list = loopsByComponent.get(loop.componentId) ?? []; list.push(loop); loopsByComponent.set(loop.componentId, list); }
  let classificationComplete = true; for (const list of loopsByComponent.values()) { for (const loop of list) { if (!loop.closed || loop.orderedVertexIds.length < 3) { classificationComplete = false; continue; } const point = representative(loop.orderedVertexIds, coords); if (!point) { loop.diagnostics.push("missing_representative_point"); classificationComplete = false; continue; } const containers = list.filter((other) => other.id !== loop.id && other.closed && pointInPolygon(point, other.orderedVertexIds, coords) === "inside").length; const touching = list.some((other) => other.id !== loop.id && other.closed && pointInPolygon(point, other.orderedVertexIds, coords) === "boundary"); if (touching) { loop.diagnostics.push("ambiguous_containment"); classificationComplete = false; continue; } loop.nestingDepth = containers; loop.classification = containers % 2 === 0 ? "outer" : "hole"; } }
  const componentRecords: GeometryTopologyComponentV11[] = components.map((component) => { const id = `component:${component.minVertexId}`; const componentBoundaryLoops = loops.filter((loop) => loop.componentId === id).map((loop) => loop.id).sort(compareStrings); const used = new Set(component.vertexIds); const isolatedVertexIds = [...used].filter((vertexId) => !component.triangleIndices.some((index) => triangles[index].includes(vertexId))).sort(compareStrings); return { id, triangleIndices: [...component.triangleIndices], vertexIds: [...component.vertexIds], triangleCount: component.triangleIndices.length, vertexCount: component.vertexIds.length, boundaryLoopIds: componentBoundaryLoops, isolatedVertexIds }; });
  const allTrianglesAssigned = componentRecords.reduce((sum, component) => sum + component.triangleCount, 0) === triangles.length; const allBoundaryEdgesAssigned = unused.size === 0; const allLoopsClosed = loops.every((loop) => loop.closed); const metadataBoundaryIds = new Set((base.mesh.neutral.boundaries ?? []).flatMap((boundary) => boundary.vertexIds)); const loopBoundaryIds = new Set(loops.flatMap((loop) => loop.orderedVertexIds)); const boundaryMetadataMismatch = metadataBoundaryIds.size > 0 && (metadataBoundaryIds.size !== loopBoundaryIds.size || [...metadataBoundaryIds].some((id) => !loopBoundaryIds.has(id))); const unsupportedCaseDetected = topologyKind === "unknown"; const nonManifoldDetected = nonManifold.length > 0; const ambiguousBoundaryDetected = ambiguous || boundaryMetadataMismatch || loops.some((loop) => loop.diagnostics.length > 0); const status: GeometryExportDetailStatus = unsupportedCaseDetected ? "unsupported" : nonManifoldDetected ? "ambiguous" : !allTrianglesAssigned || !allBoundaryEdgesAssigned || !allLoopsClosed || !classificationComplete || boundaryMetadataMismatch ? "partial" : "complete";
  const diagnostics = [...new Set([...nonManifold.map((edge) => `non_manifold_edge:${edge.key}`), ...loops.flatMap((loop) => loop.diagnostics.map((item) => `${loop.id}:${item}`)), ...(unused.size ? ["unassigned_boundary_edges"] : []), ...(boundaryMetadataMismatch ? ["boundary_metadata_mismatch"] : []), ...(ids.some((id) => !componentRecords.some((component) => component.vertexIds.includes(id))) ? ["isolated_vertex_present"] : [])])].sort(compareStrings);
  return { status, topologyKind, componentCount: componentRecords.length, components: componentRecords, boundaryLoops: loops.sort((left, right) => compareStrings(left.id, right.id)), completeness: { allTrianglesAssignedToComponent: allTrianglesAssigned, allBoundaryEdgesAssigned, allLoopsClosed, outerHoleClassificationComplete: classificationComplete, nonManifoldDetected, ambiguousBoundaryDetected, unsupportedCaseDetected }, diagnostics };
}

function extractSkinning(rig: RigDocument, partId: string, base: GeometryExportDocument): GeometrySkinningDetailsV11 {
  const part = rig.parts.find((entry) => entry.id === partId); const skinning = part?.artMesh?.skinning as RigArtMeshSkinning | undefined; const expectedVertexIds = base.mesh.neutral.vertices.map((vertex) => vertex.id).sort(compareStrings); const runtimeComposition = { keyformOffsetsBeforeSkinning: true as const, skinningUsesNeutralRelativeDeformerTransforms: true as const, parentDeformerComposition: "present-in-render-path" as const, doubleTransformRisk: "must-diagnose" as const };
  if (!skinning) return { status: "not-present", joints: [], vertexInfluences: {}, validation: { finite: true, nonNegative: true, duplicateJoint: false, unknownJoint: false, unknownVertex: false, maxInfluences: 0, maximumSumError: null, normalizationStatus: "not-evaluated", invalidVertexIds: [], missingExpectedVertexIds: [], zeroInfluenceVertexIds: [] }, runtimeComposition, diagnostics: ["part_has_no_skinning"] };
  const knownDeformers = new Set((rig.deformers ?? []).map((deformer) => deformer.id)); const seen = new Set<string>(); const joints: GeometrySkinningJointV11[] = skinning.joints.map((joint, order) => { const duplicate = seen.has(joint.deformerId); seen.add(joint.deformerId); const role = ["root", "middle", "tip"].includes(joint.role) ? joint.role : "unknown"; return { jointId: joint.deformerId, deformerId: joint.deformerId, role, order, validDeformerReference: knownDeformers.has(joint.deformerId), duplicate }; }); const jointIds = new Set(joints.map((joint) => joint.deformerId)); const vertexInfluences: Record<string, GeometryVertexInfluenceV11[]> = {}; const invalidVertexIds: string[] = []; const zeroInfluenceVertexIds: string[] = []; let finite = true; let nonNegative = true; let duplicateJoint = false; let unknownJoint = false; let maximumSumError = 0; let maxInfluences = 0; for (const vertexId of Object.keys(skinning.vertexWeights ?? {}).sort(compareStrings)) { const influences = (skinning.vertexWeights[vertexId] ?? []).map((influence) => ({ jointId: jointIds.has(influence.deformerId) ? influence.deformerId : null, deformerId: influence.deformerId, weight: influence.weight })).sort((left, right) => compareStrings(left.deformerId, right.deformerId)); vertexInfluences[vertexId] = influences; if (!expectedVertexIds.includes(vertexId)) invalidVertexIds.push(vertexId); if (!influences.length) zeroInfluenceVertexIds.push(vertexId); maxInfluences = Math.max(maxInfluences, influences.length); const idsForVertex = new Set<string>(); for (const influence of influences) { if (!Number.isFinite(influence.weight)) finite = false; if (influence.weight < 0) nonNegative = false; if (!jointIds.has(influence.deformerId)) unknownJoint = true; if (idsForVertex.has(influence.deformerId)) duplicateJoint = true; idsForVertex.add(influence.deformerId); } const sum = influences.reduce((total, influence) => total + (Number.isFinite(influence.weight) ? influence.weight : 0), 0); maximumSumError = Math.max(maximumSumError, Math.abs(sum - 1)); }
  const missingExpectedVertexIds = expectedVertexIds.filter((vertexId) => !Object.prototype.hasOwnProperty.call(vertexInfluences, vertexId)); const invalid = !finite || !nonNegative || duplicateJoint || unknownJoint || joints.some((joint) => joint.duplicate || !joint.validDeformerReference) || invalidVertexIds.length > 0 || zeroInfluenceVertexIds.length > 0 || maxInfluences > 3; const normalizationStatus = maximumSumError <= 0.001 && !missingExpectedVertexIds.length && !invalid ? "valid" : "invalid"; const status: GeometryExportDetailStatus = invalid ? "invalid" : missingExpectedVertexIds.length ? "partial" : "complete"; const diagnostics = [...(missingExpectedVertexIds.length ? ["missing_expected_vertex_weights"] : []), ...(maximumSumError > 0.001 ? ["weight_normalization_error"] : []), ...(duplicateJoint ? ["duplicate_influence"] : []), ...(unknownJoint ? ["unknown_joint"] : []), ...(joints.some((joint) => !joint.validDeformerReference) ? ["unknown_deformer_reference"] : []), ...(invalidVertexIds.length ? ["unknown_vertex_reference"] : []), ...(maxInfluences > 3 ? ["maximum_influence_exceeded"] : [])].sort(compareStrings);
  return { status, joints, vertexInfluences, validation: { finite, nonNegative, duplicateJoint, unknownJoint, unknownVertex: invalidVertexIds.length > 0, maxInfluences, maximumSumError, normalizationStatus, invalidVertexIds: [...new Set(invalidVertexIds)].sort(compareStrings), missingExpectedVertexIds, zeroInfluenceVertexIds: [...new Set(zeroInfluenceVertexIds)].sort(compareStrings) }, runtimeComposition, diagnostics };
}

function payloadWithoutVolatile(value: GeometryExportV11Document): Record<string, unknown> { const copy = JSON.parse(JSON.stringify(value)) as Record<string, unknown>; const metadata = copy.metadata as Record<string, unknown> | undefined; const standRig = metadata?.standRig as Record<string, unknown> | undefined; if (standRig) delete standRig.exportedAt; delete copy.exportPayloadHash; return copy; }
function enforceV11Limits(topology: GeometryTopologyDetailsV11, skinning: GeometrySkinningDetailsV11): void {
  const diagnostics = topology.diagnostics.length + topology.boundaryLoops.reduce((sum, loop) => sum + loop.diagnostics.length, 0) + skinning.diagnostics.length;
  const totalInfluences = Object.values(skinning.vertexInfluences).reduce((sum, influences) => sum + influences.length, 0);
  if (topology.components.length > GEOMETRY_EXPORT_LIMITS.maxV11Components || topology.boundaryLoops.length > GEOMETRY_EXPORT_LIMITS.maxV11BoundaryLoops || topology.boundaryLoops.some((loop) => loop.orderedVertexIds.length > GEOMETRY_EXPORT_LIMITS.maxV11LoopVertices) || skinning.joints.length > GEOMETRY_EXPORT_LIMITS.maxV11Joints || skinning.validation.maxInfluences > GEOMETRY_EXPORT_LIMITS.maxV11InfluencesPerVertex || totalInfluences > GEOMETRY_EXPORT_LIMITS.maxV11TotalInfluences || diagnostics > GEOMETRY_EXPORT_LIMITS.maxV11DiagnosticsEntries) throw new GeometryExportError("geometry_export_response_too_large", "v1.1 detail limits exceeded");
}

export function exportGeometryPartV11(rig: RigDocument, partId: string, meta: GeometryExportMeta): GeometryExportV11Document {
  const base = exportGeometryPart(rig, partId, meta); const part = rig.parts.find((entry) => entry.id === partId); if (!part?.artMesh) throw new GeometryExportError("part_has_no_artmesh", `part ${partId} has no ArtMesh`); const declaredTopology = (part.artMesh.generator as { topology?: unknown }).topology; const topologyKind = declaredTopology === "alpha-contour" ? "alpha-contour" : declaredTopology === "rect-grid" || declaredTopology === undefined ? "rect-grid" : "unknown"; const topologyDetails = extractTopology(base, topologyKind); const skinningDetails = extractSkinning(rig, partId, base); enforceV11Limits(topologyDetails, skinningDetails); const topologyDetailsHash = hash(topologyDetails); const skinningDetailsHash = hash(skinningDetails); const capabilities = { topologyDetails: { status: topologyDetails.status, reasonCode: topologyDetails.status === "complete" ? null : `topology_details_${topologyDetails.status}` }, skinningDetails: { status: skinningDetails.status, reasonCode: skinningDetails.status === "not-present" ? "part_has_no_skinning" : skinningDetails.status === "complete" ? null : `skinning_details_${skinningDetails.status}` } } as const; const result = { ...base, contractVersion: GEOMETRY_EXPORT_CONTRACT_V11, ...(meta.semanticHash ? { semanticHash: meta.semanticHash } : {}), topologyDetails, skinningDetails, capabilities, topologyDetailsHash, skinningDetailsHash, exportPayloadHash: "" } as GeometryExportV11Document; result.exportPayloadHash = hash(payloadWithoutVolatile(result)); if (geometryExportByteLength(result) > GEOMETRY_EXPORT_LIMITS.maxV11ResponseBytes) throw new GeometryExportError("geometry_export_response_too_large", `part ${partId} exceeds v1.1 response limits`); return result;
}




