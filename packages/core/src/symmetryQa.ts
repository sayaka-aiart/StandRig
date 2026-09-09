import { evaluateRigParts, identityMatrix, type EvaluatedPartState } from "./evaluator.js";
import { defaultParameterValues, parameterDefinitionsForRig } from "./parameters.js";
import type { ParameterValues, RigDocument, RigSymmetryLink, Transform2D } from "./types.js";

export interface SymmetryAngleXPairAudit {
  sourceId: string;
  targetId: string;
  sourceName: string;
  targetName: string;
  xError: number;
  yError: number;
  rotationError: number;
  scaleXError: number;
  scaleYError: number;
  maxError: number;
  pass: boolean;
}

export interface SymmetryAngleXAudit {
  parameter: string;
  sample: number;
  tolerance: number;
  pass: boolean;
  linkCount: number;
  pairCount: number;
  checkedCount: number;
  violationCount: number;
  maxError: number;
  violations: SymmetryAngleXPairAudit[];
}

export interface SymmetryAngleXAuditOptions {
  parameter?: string;
  sample?: number;
  tolerance?: number;
  includePassing?: boolean;
}

/**
 * Numerically verify the bilateral AngleX contract without rendering.
 * Source at +sample must mirror target at -sample: X/rotation invert while
 * Y/scale remain preserved. Physics is intentionally excluded from this
 * structural gate so the result is deterministic and isolates keyforms.
 */
export function auditAngleXSymmetry(rig: RigDocument, options: SymmetryAngleXAuditOptions = {}): SymmetryAngleXAudit {
  const parameter = options.parameter ?? "ParamAngleX";
  const sample = Math.abs(options.sample ?? parameterDefinitionsForRig(rig).find((entry) => entry.id === parameter)?.max ?? 30);
  const tolerance = Math.max(0.0001, options.tolerance ?? 0.25);
  const links = (rig.symmetry?.links ?? []).filter((link) => link.kind === "part");
  const parts = new Map(rig.parts.map((part) => [part.id, part]));
  const values = defaultParameterValues(rig);
  const neutral = evaluateRigParts(rig, values, identityMatrix());
  const plusValues = { ...values, [parameter]: sample };
  const minusValues = { ...values, [parameter]: -sample };
  const plus = evaluateRigParts(rig, plusValues, identityMatrix());
  const minus = evaluateRigParts(rig, minusValues, identityMatrix());
  const audits: SymmetryAngleXPairAudit[] = [];

  for (const link of links) {
    const source = parts.get(link.sourceId);
    const target = parts.get(link.targetId);
    const sourceNeutral = neutral.get(link.sourceId);
    const targetNeutral = neutral.get(link.targetId);
    const sourcePlus = plus.get(link.sourceId);
    const targetMinus = minus.get(link.targetId);
    if (!source || !target || !sourceNeutral || !targetNeutral || !sourcePlus || !targetMinus) continue;
    audits.push(comparePair(link, source.name, target.name, sourceNeutral, targetNeutral, sourcePlus, targetMinus, tolerance));
  }

  const violations = audits.filter((audit) => !audit.pass);
  const maxError = audits.reduce((maximum, audit) => Math.max(maximum, audit.maxError), 0);
  return {
    parameter,
    sample,
    tolerance,
    pass: violations.length === 0 && audits.length === links.length,
    linkCount: links.length,
    pairCount: audits.length,
    checkedCount: audits.length,
    violationCount: violations.length,
    maxError: round(maxError),
    violations: options.includePassing ? audits : violations
  };
}

function comparePair(
  link: RigSymmetryLink,
  sourceName: string,
  targetName: string,
  sourceNeutral: EvaluatedPartState,
  targetNeutral: EvaluatedPartState,
  sourcePlus: EvaluatedPartState,
  targetMinus: EvaluatedPartState,
  tolerance: number
): SymmetryAngleXPairAudit {
  const sourceDelta = delta(sourcePlus.pose, sourceNeutral.pose);
  const targetDelta = delta(targetMinus.pose, targetNeutral.pose);
  const xError = link.invertX === false ? Math.abs(sourceDelta.x - targetDelta.x) : Math.abs(sourceDelta.x + targetDelta.x);
  const yError = link.preserveY === false ? Math.abs(sourceDelta.y + targetDelta.y) : Math.abs(sourceDelta.y - targetDelta.y);
  const rotationError = link.invertX === false ? Math.abs(sourceDelta.rotation - targetDelta.rotation) : Math.abs(sourceDelta.rotation + targetDelta.rotation);
  const scaleXError = link.invertX === false ? Math.abs(sourceDelta.scaleX - targetDelta.scaleX) : Math.abs(sourceDelta.scaleX - targetDelta.scaleX);
  const scaleYError = Math.abs(sourceDelta.scaleY - targetDelta.scaleY);
  const maxError = Math.max(xError, yError, rotationError, scaleXError, scaleYError);
  return {
    sourceId: link.sourceId,
    targetId: link.targetId,
    sourceName,
    targetName,
    xError: round(xError),
    yError: round(yError),
    rotationError: round(rotationError),
    scaleXError: round(scaleXError),
    scaleYError: round(scaleYError),
    maxError: round(maxError),
    pass: maxError <= tolerance
  };
}

function delta(current: Transform2D, baseline: Transform2D): Transform2D {
  return {
    ...current,
    x: current.x - baseline.x,
    y: current.y - baseline.y,
    rotation: current.rotation - baseline.rotation,
    scaleX: current.scaleX - baseline.scaleX,
    scaleY: current.scaleY - baseline.scaleY,
    opacity: current.opacity - baseline.opacity
  };
}

function round(value: number): number {
  return Math.round(value * 1000000) / 1000000;
}


export function auditSymmetryArtMeshBindings(rig: RigDocument) {
  const parts = new Map(rig.parts.map((part) => [part.id, part]));
  const links = (rig.symmetry?.links ?? []).filter((link) => link.kind === "part");
  const seen = new Set<string>();
  const pairs: Array<Record<string, unknown>> = [];
  for (const link of links) {
    const [sourceId, targetId] = [link.sourceId, link.targetId].sort();
    const key = sourceId + "|" + targetId;
    if (seen.has(key)) continue;
    seen.add(key);
    const source = parts.get(sourceId);
    const target = parts.get(targetId);
    if (!source || !target || !source.artMesh?.enabled || !target.artMesh?.enabled) continue;
    const sourceMeshBindings = source.artMesh.bindings ?? [];
    const targetMeshBindings = target.artMesh.bindings ?? [];
    const sourcePartParameters = new Set((source.bindings ?? []).map((binding) => binding.parameter));
    const targetPartParameters = new Set((target.bindings ?? []).map((binding) => binding.parameter));
    const overlapParameters = [...new Set([
      ...sourceMeshBindings.map((binding) => binding.parameter).filter((parameter) => targetPartParameters.has(parameter)),
      ...targetMeshBindings.map((binding) => binding.parameter).filter((parameter) => sourcePartParameters.has(parameter))
    ])].sort();
    const sourceMeshKeyCount = sourceMeshBindings.reduce((sum, binding) => sum + binding.keys.length, 0);
    const targetMeshKeyCount = targetMeshBindings.reduce((sum, binding) => sum + binding.keys.length, 0);
    const sourcePartKeyCount = (source.bindings ?? []).reduce((sum, binding) => sum + binding.keys.length, 0);
    const targetPartKeyCount = (target.bindings ?? []).reduce((sum, binding) => sum + binding.keys.length, 0);
    const status = sourceMeshKeyCount > 0 && targetMeshKeyCount > 0 ? "paired" : sourceMeshKeyCount > 0 || targetMeshKeyCount > 0 ? "one-sided" : sourcePartKeyCount > 0 || targetPartKeyCount > 0 ? "part-transform-only" : "mesh-ready";
    pairs.push({ sourceId, targetId, sourceRole: source.role, targetRole: target.role, sourceMeshKeyCount, targetMeshKeyCount, sourcePartKeyCount, targetPartKeyCount, overlapParameters, status, safeToMirror: status === "paired" && overlapParameters.length === 0 });
  }
  return {
    linkCount: links.length,
    meshPairCount: pairs.length,
    pairedCount: pairs.filter((pair) => pair.status === "paired").length,
    oneSidedCount: pairs.filter((pair) => pair.status === "one-sided").length,
    partTransformOnlyCount: pairs.filter((pair) => pair.status === "part-transform-only").length,
    meshReadyCount: pairs.filter((pair) => pair.status === "mesh-ready").length,
    safeToMirrorCount: pairs.filter((pair) => pair.safeToMirror).length,
    pairs
  };
}
