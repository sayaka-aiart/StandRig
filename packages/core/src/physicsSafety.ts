import { runPhysicsTemporalQa, type PhysicsTemporalQaResult } from "./physicsQa.js";
import type { RigDeformer, RigDocument, RigPart, RigPartRole } from "./types.js";

/** Parts that are treated as a fixed skeleton during secondary motion. */
export const PHYSICS_STRUCTURAL_ROLES: ReadonlySet<RigPartRole> = new Set(["face", "neck", "torso"]);

/** Only these confirmed roles may receive direct secondary-motion output. */
export const PHYSICS_ALLOWED_ROLES: ReadonlySet<RigPartRole> = new Set([
  "hair-front",
  "hair-back",
  "hair-side",
  "hair-tail-left",
  "hair-tail-right",
  "soft-tissue",
  "clothing",
  "accessory"
]);

export interface PhysicsSafetyOptions {
  frames?: number;
  dt?: number;
  chainIds?: string[];
  driveFrames?: number;
  settleFrames?: number;
  releaseExternalForces?: boolean;
}

export interface PhysicsSafetyTarget {
  partId: string;
  name: string;
  role?: RigPartRole;
  roleStatus?: string;
  structural: boolean;
  allowed: boolean;
  source: "part" | "deformer" | "parameter";
  deformerId?: string;
  parameter?: string;
}

export interface PhysicsSafetyChain {
  chainId: string;
  enabled: boolean;
  outputMode: "part" | "deformer" | "parameter";
  targetDeformerIds: string[];
  targets: PhysicsSafetyTarget[];
  structuralTargetCount: number;
  disallowedTargetCount: number;
  issues: string[];
}

export interface PhysicsSafetyReport {
  pass: boolean;
  rootLock: {
    pass: boolean;
    structuralPartIds: string[];
    violations: PhysicsSafetyTarget[];
  };
  chains: PhysicsSafetyChain[];
  temporal: PhysicsTemporalQaResult;
  issues: string[];
  policy: {
    structuralRoles: RigPartRole[];
    allowedRoles: RigPartRole[];
    directPartOutput: "forbidden-for-structural";
  };
}

/**
 * Audits the complete physics output path, including parameter output bindings.
 * A chain may be structurally unsafe even when it has no direct targetPartIds:
 * a parameter output bound to face/neck/torso is still a root-lock violation.
 */
export function auditPhysicsSafety(rig: RigDocument, options: PhysicsSafetyOptions = {}): PhysicsSafetyReport {
  const parts = Array.isArray(rig.parts) ? rig.parts : [];
  const deformers = Array.isArray(rig.deformers) ? rig.deformers : [];
  const byPart = new Map(parts.map((part) => [part.id, part]));
  const structuralParts = parts.filter((part) => part.id === "root" || (part.role ? PHYSICS_STRUCTURAL_ROLES.has(part.role) : false));
  const structuralIds = new Set(structuralParts.map((part) => part.id));
  const selected = new Set(options.chainIds?.filter((id): id is string => typeof id === "string") ?? []);
  // Disabled chains are not active output paths. Keep the safety report focused on motion that can currently reach the evaluator; re-enabling a chain will make it subject to the same gate again.
  const chains = (rig.physics?.chains ?? []).filter((chain) => chain.enabled !== false && (!selected.size || selected.has(chain.id)));
  const reports: PhysicsSafetyChain[] = [];
  const violations: PhysicsSafetyTarget[] = [];
  const issues: string[] = [];

  for (const chain of chains) {
    const outputMode: PhysicsSafetyChain["outputMode"] = chain.parameterOutput
      ? "parameter"
      : chain.targetDeformerIds?.length
        ? "deformer"
        : "part";
    const targets: PhysicsSafetyTarget[] = [];
    const chainIssues: string[] = [];
    if (!chain.parameterOutput) {
      if (chain.targetPartIds?.length && chain.targetDeformerIds?.length) {
        chainIssues.push("direct output must choose either targetPartIds or targetDeformerIds, not both");
      }
      for (const partId of chain.targetPartIds ?? []) {
        const part = byPart.get(partId);
        if (part) {
          targets.push(makeTarget(part, "part", undefined, undefined, structuralIds));
          if (chain.output.property === "rotation" && part.kind === "group" && hasUnanchoredOrigin(part)) {
            chainIssues.push(`rotation output targets an unanchored group origin: ${part.id}`);
          }
        }
        else chainIssues.push(`missing target part: ${partId}`);
      }
      for (const deformerId of chain.targetDeformerIds ?? []) {
        const deformer = deformers.find((entry) => entry.id === deformerId);
        if (!deformer) {
          chainIssues.push(`missing target deformer: ${deformerId}`);
          continue;
        }
        for (const part of partsForDeformer(deformer, parts)) targets.push(makeTarget(part, "deformer", deformer.id, undefined, structuralIds));
      }
      if (!chain.targetPartIds?.length && !chain.targetDeformerIds?.length) chainIssues.push("direct output has no target part or deformer");
    } else {
      const parameter = chain.parameterOutput.parameter;
      for (const part of parts) {
        if ((part.blendShapes ?? []).some(s=>s.parameter===parameter)
          || (part.artPaths??[]).some(p=>(p.blendShapes??[]).some(s=>s.parameter===parameter))
          || (rig.glue??[]).some(g=>(g.partAId===part.id||g.partBId===part.id)&&(g.blendShapes??[]).some(s=>s.parameter===parameter))
          || (part.bindings ?? []).some((binding) => binding.parameter === parameter)
          || (part.multiBindings ?? []).some((binding) => binding.parameters.includes(parameter))
          || (part.artMesh?.bindings ?? []).some((binding) => binding.parameter === parameter)
          || (part.artMesh?.multiBindings ?? []).some((binding) => binding.parameters.includes(parameter))
          || (part.artMesh?.blendShapes ?? []).some((shape) => shape.parameter === parameter)) {
          targets.push(makeTarget(part, "parameter", undefined, parameter, structuralIds));
        }
      }
      for (const deformer of deformers) {
        if ((deformer.blendShapes??[]).some(s=>s.parameter===parameter) || (deformer.bindings ?? []).some((binding) => binding.parameter === parameter) || (deformer.multiBindings ?? []).some((binding) => binding.parameters.includes(parameter))) {
          for (const part of partsForDeformer(deformer, parts)) targets.push(makeTarget(part, "parameter", deformer.id, parameter, structuralIds));
        }
        for (const pin of deformer.warp?.pins ?? []) {
          if (!(pin.bindings ?? []).some((binding) => binding.parameter === parameter)) continue;
          for (const part of partsForDeformer(deformer, parts)) targets.push(makeTarget(part, "parameter", deformer.id, parameter, structuralIds));
        }
      }
      if (!targets.length) chainIssues.push(`parameter output is unbound: ${parameter}`);
    }
    const uniqueTargets = uniqueTargetList(targets);
    for (const target of uniqueTargets) {
      if (target.structural || !target.allowed) violations.push(target);
    }
    const structuralTargetCount = uniqueTargets.filter((target) => target.structural).length;
    const disallowedTargetCount = uniqueTargets.filter((target) => !target.allowed).length;
    if (structuralTargetCount) chainIssues.push(`${structuralTargetCount} structural target(s) violate root lock`);
    if (disallowedTargetCount) chainIssues.push(`${disallowedTargetCount} target(s) use an unconfirmed or disallowed role`);
    reports.push({ chainId: chain.id, enabled: chain.enabled, outputMode, targetDeformerIds: [...(chain.targetDeformerIds ?? [])], targets: uniqueTargets, structuralTargetCount, disallowedTargetCount, issues: chainIssues });
  }

  const temporal = runPhysicsTemporalQa(rig, options.frames, options.dt);
  if (temporal.structuralMotion > 0) issues.push(`temporal QA observed ${temporal.structuralMotion} structural motion sample(s)`);
  if (!temporal.finite) issues.push("temporal QA produced a non-finite output");
  for (const report of reports) for (const issue of report.issues) issues.push(`${report.chainId}: ${issue}`);
  const uniqueViolations = uniqueTargetList(violations);
  const rootLockPass = uniqueViolations.length === 0 && temporal.structuralMotion === 0;
  if (!rootLockPass && uniqueViolations.length) issues.unshift(`${uniqueViolations.length} root-lock target violation(s)`);
  return {
    pass: rootLockPass && temporal.finite && issues.length === 0,
    rootLock: { pass: rootLockPass, structuralPartIds: structuralParts.map((part) => part.id), violations: uniqueViolations },
    chains: reports,
    temporal,
    issues,
    policy: { structuralRoles: [...PHYSICS_STRUCTURAL_ROLES], allowedRoles: [...PHYSICS_ALLOWED_ROLES], directPartOutput: "forbidden-for-structural" }
  };
}

function makeTarget(part: RigPart, source: PhysicsSafetyTarget["source"], deformerId: string | undefined, parameter: string | undefined, structuralIds: ReadonlySet<string>): PhysicsSafetyTarget {
  const structural = structuralIds.has(part.id);
  const allowed = !structural && part.roleStatus === "confirmed" && Boolean(part.role && PHYSICS_ALLOWED_ROLES.has(part.role));
  return { partId: part.id, name: part.name, role: part.role, roleStatus: part.roleStatus, structural, allowed, source, deformerId, parameter };
}

function partsForDeformer(deformer: RigDeformer, parts: RigPart[]): RigPart[] {
  const direct = new Set(deformer.targetPartIds ?? []);
  return parts.filter((part) => direct.has(part.id) || part.deformerId === deformer.id);
}

function uniqueTargetList(targets: PhysicsSafetyTarget[]): PhysicsSafetyTarget[] {
  const seen = new Set<string>();
  return targets.filter((target) => {
    const key = `${target.partId}:${target.source}:${target.deformerId ?? ""}:${target.parameter ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function hasUnanchoredOrigin(part: RigPart): boolean {
  const epsilon = 1e-6;
  return [part.transform?.x, part.transform?.y, part.transform?.pivotX, part.transform?.pivotY]
    .every((value) => Math.abs(Number(value ?? 0)) <= epsilon);
}
