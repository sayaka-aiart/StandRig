import { defaultParameterValues } from "./parameters.js";
import { identityMatrix, resolveRigFrame } from "./evaluator.js";
import { resolveArtMesh } from "./artMesh.js";
import { deformerForPart } from "./deformers.js";
import { applySkinningToVertex, applySkinningToVertices, auditArtMeshSkinning } from "./skinning.js";
import type { ParameterValues, RigDeformer, RigDocument, RigPart } from "./types.js";

export interface SkinningQaOptions {
  samples?: ParameterValues[];
  neutralTolerance?: number;
  rootBlendTolerance?: number;
  maxDisplacement?: number;
}

export interface SkinningQaPartResult {
  partId: string;
  vertexCount: number;
  sampleCount: number;
  neutralMaxDrift: number;
  maxDisplacement: number;
  maxRootBlendError: number;
  maxAllowedDisplacement: number;
  doubleTransformRisk: boolean;
  doubleTransformDeformerIds: string[];
  finite: boolean;
  pass: boolean;
  issues: string[];
}

export interface SkinningQaResult {
  pass: boolean;
  partCount: number;
  sampleCount: number;
  neutralTolerance: number;
  rootBlendTolerance: number;
  maxDisplacement: number;
  doubleTransformRiskCount: number;
  parts: SkinningQaPartResult[];
  issues: string[];
}

/**
 * Numeric gate for a candidate skinning profile. This intentionally evaluates
 * the candidate rig only; it never mutates or persists production data.
 */
export function runSkinningQa(rig: RigDocument, partIds?: readonly string[], options: SkinningQaOptions = {}): SkinningQaResult {
  const neutralTolerance = clamp(Number(options.neutralTolerance ?? 0.001), 0, 1, 0.001);
  const rootBlendTolerance = clamp(Number(options.rootBlendTolerance ?? 0.001), 0, 4, 0.001);
  const defaults = defaultParameterValues(rig);
  const samples = (options.samples ?? []).map((sample) => ({ ...defaults, ...sample }));
  const wanted = partIds?.length ? new Set(partIds) : undefined;
  const parts = rig.parts.filter((part) => part.kind === "image" && part.artMesh?.enabled && part.artMesh.skinning && (!wanted || wanted.has(part.id)));
  const results = parts.map((part) => auditPart(rig, part, defaults, samples, { neutralTolerance, rootBlendTolerance, maxDisplacement: options.maxDisplacement }));
  const issues = results.flatMap((entry) => entry.issues.map((issue) => `${entry.partId}: ${issue}`));
  return {
    pass: results.length > 0 && issues.length === 0,
    partCount: results.length,
    sampleCount: samples.length,
    neutralTolerance,
    rootBlendTolerance,
    maxDisplacement: finiteMaximum(results.map((entry) => entry.maxDisplacement), 0),
    doubleTransformRiskCount: results.filter((entry) => entry.doubleTransformRisk).length,
    parts: results,
    issues
  };
}

function auditPart(
  rig: RigDocument,
  part: RigPart,
  defaults: ParameterValues,
  samples: ParameterValues[],
  limits: { neutralTolerance: number; rootBlendTolerance: number; maxDisplacement?: number }
): SkinningQaPartResult {
  const mesh = part.artMesh!;
  const asset = part.assetId ? rig.assets.find((entry) => entry.id === part.assetId) : undefined;
  const width = positive(asset?.width, Math.max(1, mesh.generator.alphaBounds.width));
  const height = positive(asset?.height, Math.max(1, mesh.generator.alphaBounds.height));
  const generatedAudit = auditArtMeshSkinning(mesh, mesh.skinning, new Set((rig.deformers ?? []).map((entry) => entry.id)));
  const doubleTransformDeformerIds = findDoubleTransformDeformers(rig, part);
  const doubleTransformRisk = doubleTransformDeformerIds.length > 0;
  const neutralMesh = resolveArtMesh(part, width, height, defaults);
  const neutralFrame = resolveRigFrame(rig, defaults, identityMatrix(), { physics: false });
  let neutralMaxDrift = 0;
  let maxDisplacement = 0;
  let maxRootBlendError = 0;
  let finite = generatedAudit.pass;
  const maxAllowedDisplacement = positive(limits.maxDisplacement, Math.max(width, height) * 0.75);
  if (!neutralMesh) finite = false;
  if (neutralMesh) {
    const neutralVertices = applySkinningToVertices(neutralMesh.vertices, mesh.skinning, neutralFrame.skinningTransforms);
    neutralMaxDrift = maxVertexDelta(neutralMesh.vertices, neutralVertices);
    finite = finite && neutralVertices.every((vertex) => Number.isFinite(vertex.x) && Number.isFinite(vertex.y));
  }
  for (const values of samples) {
    const frame = resolveRigFrame(rig, values, identityMatrix(), { physics: false });
    const resolved = resolveArtMesh(part, width, height, values);
    if (!resolved) { finite = false; continue; }
    const vertices = applySkinningToVertices(resolved.vertices, mesh.skinning, frame.skinningTransforms);
    maxDisplacement = Math.max(maxDisplacement, maxVertexDelta(resolved.vertices, vertices));
    finite = finite && vertices.every((vertex) => Number.isFinite(vertex.x) && Number.isFinite(vertex.y));
    const rootId = mesh.skinning!.joints[0]?.deformerId;
    if (rootId) {
      const rootOnly = new Map([[rootId, frame.skinningTransforms.get(rootId) ?? identityMatrix()]]);
      for (const vertex of resolved.vertices) {
        const weight = mesh.skinning!.vertexWeights[vertex.id]?.find((entry) => entry.deformerId === rootId)?.weight ?? 0;
        if (weight < 0.98) continue;
        const full = applySkinningToVertex(vertex, mesh.skinning!, frame.skinningTransforms);
        const root = applySkinningToVertex(vertex, mesh.skinning!, rootOnly);
        maxRootBlendError = Math.max(maxRootBlendError, Math.hypot(full.x - root.x, full.y - root.y));
      }
    }
  }
  const issues: string[] = [];
  if (!generatedAudit.pass) issues.push(...generatedAudit.issues);
  if (!finite) issues.push("non-finite skinned vertex");
  if (neutralMaxDrift > limits.neutralTolerance) issues.push(`neutral drift ${neutralMaxDrift.toFixed(4)} exceeds ${limits.neutralTolerance.toFixed(4)}`);
  if (maxRootBlendError > limits.rootBlendTolerance) issues.push(`root blend error ${maxRootBlendError.toFixed(4)} exceeds ${limits.rootBlendTolerance.toFixed(4)}`);
  if (maxDisplacement > maxAllowedDisplacement) issues.push(`local displacement ${maxDisplacement.toFixed(3)} exceeds ${maxAllowedDisplacement.toFixed(3)}`);
  if (doubleTransformRisk) issues.push(`joint overlaps dynamic part/deformer chain(s) and may double-transform: ${doubleTransformDeformerIds.join(", ")}`);
  return { partId: part.id, vertexCount: mesh.vertices.length, sampleCount: samples.length, neutralMaxDrift, maxDisplacement, maxRootBlendError, maxAllowedDisplacement, doubleTransformRisk, doubleTransformDeformerIds, finite, pass: issues.length === 0, issues };
}

const MATRIX_PROPERTIES = new Set(["x", "y", "rotation", "scaleX", "scaleY"]);

function collectDeformerChainIds(startId: string | undefined, byId: Map<string, RigDeformer>): Set<string> {
  const ids = new Set<string>(); let current = startId;
  while (current && !ids.has(current)) { ids.add(current); current = byId.get(current)?.parentId ?? undefined; }
  return ids;
}

function collectAppliedDeformerIds(rig: RigDocument, part: RigPart, byDeformer: Map<string, RigDeformer>): Set<string> {
  const byPart = new Map(rig.parts.map((entry) => [entry.id, entry])); const ids = new Set<string>(); const visited = new Set<string>();
  let current: RigPart | undefined = part;
  while (current && !visited.has(current.id)) {
    visited.add(current.id); const assigned = deformerForPart(current, [...byDeformer.values()]);
    for (const id of collectDeformerChainIds(assigned?.id, byDeformer)) ids.add(id);
    current = current.parentId ? byPart.get(current.parentId) : undefined;
  }
  return ids;
}

function findDoubleTransformDeformers(rig: RigDocument, part: RigPart): string[] {
  const byDeformer = new Map((rig.deformers ?? []).map((entry) => [entry.id, entry]));
  const applied = collectAppliedDeformerIds(rig, part, byDeformer); const jointChain = new Set<string>();
  for (const joint of part.artMesh?.skinning?.joints ?? []) for (const id of collectDeformerChainIds(joint.deformerId, byDeformer)) jointChain.add(id);
  return [...applied].filter((id) => jointChain.has(id) && deformerCanMove(rig, byDeformer.get(id))).sort();
}

function deformerCanMove(rig: RigDocument, deformer: RigDeformer | undefined): boolean {
  if (!deformer) return false;
  const bindingMoves = (deformer.bindings ?? []).some((binding) => {
    if (!MATRIX_PROPERTIES.has(binding.property)) return false;
    const values = (binding.keys ?? []).map((key) => { const record = key as unknown as Record<string, unknown>; return Number(record.value ?? record[binding.property]); }).filter(Number.isFinite);
    return values.length > 1 && Math.max(...values) - Math.min(...values) > 1e-6;
  });
  const physicsMoves = (rig.physics?.chains ?? []).some((chain) => chain.enabled !== false && chain.targetDeformerIds?.includes(deformer.id) && MATRIX_PROPERTIES.has(chain.output?.property) && Math.abs(Number(chain.output?.scale ?? 0)) > 1e-6);
  return bindingMoves || physicsMoves;
}

function maxVertexDelta(left: readonly { x: number; y: number }[], right: readonly { x: number; y: number }[]): number {
  let maximum = 0;
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) maximum = Math.max(maximum, Math.hypot(right[index].x - left[index].x, right[index].y - left[index].y));
  return maximum;
}
function positive(value: number | undefined, fallback: number): number { return Number.isFinite(value) && value! > 0 ? value! : fallback; }
function finiteMaximum(values: number[], fallback: number): number { const finite = values.filter(Number.isFinite); return finite.length ? Math.max(...finite) : fallback; }
function clamp(value: number, min: number, max: number, fallback: number): number { return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback; }