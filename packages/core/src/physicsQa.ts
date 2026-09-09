import { applyPhysicsParameterOffsets, evaluateRigParts, identityMatrix, resolvePhysicsFrame, type PhysicsValue } from "./evaluator.js";
import { auditPhysicsRootSafety } from "./physicsPresets.js";
import type { ParameterValues, RigDocument } from "./types.js";

export interface PhysicsTemporalQaResult {
  frames: number;
  enabledChains: number;
  changedOutputs: number;
  finite: boolean;
  structuralMotion: number;
  issues: string[];
}

export function runPhysicsTemporalQa(rig: RigDocument, frames = 120, dt = 1 / 60): PhysicsTemporalQaResult {
  const safeFrames = Math.max(1, Math.min(600, Math.round(frames)));
  const values = sourceDrivenValues(rig);
  const state = new Map<string, PhysicsValue>();
  const structuralIds = new Set(rig.parts.filter((part) => part.id === "root" || part.role === "neck" || part.role === "face" || part.role === "torso").map((part) => part.id));
  let finite = true;
  let structuralMotion = 0;
  let changedOutputs = 0;
  const seenOutputs = new Map<string, number>();
  const enabledChains = (rig.physics?.chains ?? []).filter((chain) => chain.enabled).length;
  const canEvaluateStructure = rig.parts.every((part) => Boolean(part.transform && part.kind));
  const baseline = canEvaluateStructure ? evaluateRigParts(rig, values, identityMatrix()) : undefined;
  for (let frame = 0; frame < safeFrames; frame += 1) {
    const resolved = resolvePhysicsFrame(rig, values, state, dt, frame * dt);
    if (baseline) {
      const evaluated = evaluateRigParts(rig, applyPhysicsParameterOffsets(values, resolved.parameterOffsets), identityMatrix(), { physicsOffsets: resolved.partOffsets, physicsDeformerOffsets: resolved.deformerOffsets });
      for (const partId of structuralIds) {
        const reference = baseline.get(partId); const current = evaluated.get(partId);
        if (reference && current && evaluatedStateDifference(reference, current) > 0.00001) structuralMotion += 1;
      }
    }
    for (const [deformerId, offsets] of resolved.deformerOffsets) {
      const magnitude = Object.values(offsets).reduce((sum, value) => sum + Math.abs(value ?? 0), 0);
      if (!Number.isFinite(magnitude)) finite = false;
      const previous = seenOutputs.get(`deformer:${deformerId}`) ?? 0;
      if (Math.abs(magnitude - previous) > 0.00001) changedOutputs += 1;
      seenOutputs.set(`deformer:${deformerId}`, magnitude);
    }
    for (const [partId, offsets] of resolved.partOffsets) {
      const magnitude = Object.values(offsets).reduce((sum, value) => sum + Math.abs(value ?? 0), 0);
      if (!Number.isFinite(magnitude)) finite = false;
      if (!baseline && structuralIds.has(partId) && magnitude > 0.00001) structuralMotion += 1;
      const previous = seenOutputs.get(`part:${partId}`) ?? 0;
      if (Math.abs(magnitude - previous) > 0.00001) changedOutputs += 1;
      seenOutputs.set(`part:${partId}`, magnitude);
    }
    for (const [parameter, value] of Object.entries(resolved.parameterOffsets)) {
      if (!Number.isFinite(value)) finite = false;
      const previous = seenOutputs.get(`parameter:${parameter}`) ?? 0;
      if (Math.abs(value - previous) > 0.00001) changedOutputs += 1;
      seenOutputs.set(`parameter:${parameter}`, value);
    }
  }
  const issues: string[] = [];
  if (!finite) issues.push("Physics produced a non-finite output.");
  if (structuralMotion) issues.push(`Structural parts received physics motion in ${structuralMotion} sampled frame(s).`);
  const rootWarnings = auditPhysicsRootSafety(rig);
  if (rootWarnings.length) issues.push(`${rootWarnings.length} structural direct-target configuration warning(s).`);
  if (enabledChains && changedOutputs === 0) issues.push("Enabled physics chains produced no changing output under the QA input.");
  return { frames: safeFrames, enabledChains, changedOutputs, finite, structuralMotion, issues };
}

function evaluatedStateDifference(left: { matrix: { a: number; b: number; c: number; d: number; e: number; f: number }; pose: { x: number; y: number; rotation: number; scaleX: number; scaleY: number; pivotX: number; pivotY: number; opacity: number } }, right: { matrix: { a: number; b: number; c: number; d: number; e: number; f: number }; pose: { x: number; y: number; rotation: number; scaleX: number; scaleY: number; pivotX: number; pivotY: number; opacity: number } }): number {
  const matrix = Math.max(...(["a", "b", "c", "d", "e", "f"] as const).map((key) => Math.abs(left.matrix[key] - right.matrix[key])));
  const pose = Math.max(...(["x", "y", "rotation", "scaleX", "scaleY", "pivotX", "pivotY", "opacity"] as const).map((key) => Math.abs(left.pose[key] - right.pose[key])));
  return Math.max(matrix, pose);
}
function sourceDrivenValues(rig: RigDocument): ParameterValues {
  const values: ParameterValues = {};
  for (const parameter of rig.parameters ?? []) values[parameter.id] = parameter.default;
  for (const chain of rig.physics?.chains ?? []) {
    for (const source of chain.sourceParameters ?? []) {
      const parameter = rig.parameters?.find((entry) => entry.id === source.parameter);
      values[source.parameter] = parameter?.max ?? 1;
    }
  }
  return values;
}