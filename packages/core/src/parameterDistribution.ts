import type { RigDeformer, RigDocument, RigPart } from "./types.js";

export type ParameterDistributionSeverity = "ok" | "info" | "review";

export interface ParameterDistributionTarget {
  id: string;
  name: string;
  kind: RigDeformer["kind"];
  parentId: string | null;
  uniqueParameterCount: number;
  parameterIds: string[];
  ownedParameterIds: string[];
  inheritedPartParameterIds: string[];
  parameterCategories: Record<string, number>;
  deformerBindingCount: number;
  warpPinBindingCount: number;
  partBindingCount: number;
  inheritedPartBindingCount: number;
  totalBindingCount: number;
  pinCount: number;
  directPartCount: number;
  branchPartCount: number;
  directPartIds: string[];
  branchPartIds: string[];
  childDeformerIds: string[];
  score: number;
  severity: ParameterDistributionSeverity;
  reasons: string[];
  splitSuggestions: string[];
}

export interface ParameterDistributionUsage {
  parameter: string;
  targetCount: number;
  bindingCount: number;
  targetIds: string[];
}

export interface ParameterDistributionAudit {
  targetCount: number;
  overloadedCount: number;
  reviewCount: number;
  maxUniqueParameters: number;
  maxBindingCount: number;
  targets: ParameterDistributionTarget[];
  overloadedTargets: ParameterDistributionTarget[];
  parameterUsage: ParameterDistributionUsage[];
}

const OVERLOAD_PARAMETER_REVIEW = 4;
const OVERLOAD_BINDING_REVIEW = 16;
const OVERLOAD_BRANCH_REVIEW = 28;

export function analyzeParameterDistribution(rig: RigDocument): ParameterDistributionAudit {
  const parts = Array.isArray(rig.parts) ? rig.parts : [];
  const deformers = Array.isArray(rig.deformers) ? rig.deformers : [];
  const partsById = new Map(parts.map((part) => [part.id, part]));
  const childrenByParent = buildChildrenByParent(parts);
  const childDeformersByParent = buildChildDeformersByParent(deformers);
  const directPartIdsByDeformer = buildDirectPartIdsByDeformer(parts, deformers);
  const usage = new Map<string, { bindingCount: number; targetIds: Set<string> }>();

  const targets = deformers.map((deformer) => {
    const directPartIds = [...(directPartIdsByDeformer.get(deformer.id) ?? new Set<string>())];
    const branchPartIds = collectBranchPartIds(directPartIds, childrenByParent);
    const branchParts = branchPartIds.map((partId) => partsById.get(partId)).filter((part): part is RigPart => Boolean(part));
    const deformerBindings = deformer.bindings ?? [];
    const pinBindings = (deformer.warp?.pins ?? []).flatMap((pin) => pin.bindings ?? []);
    const partBindings = branchParts.flatMap((part) => part.bindings ?? []);
    const ownedBindings = [...deformerBindings, ...pinBindings];
    const inheritedPartParameterIds = [...new Set(partBindings.map((binding) => binding.parameter).filter(Boolean))].sort();
    const parameterIds = [...new Set(ownedBindings.map((binding) => binding.parameter).filter(Boolean))].sort();
    for (const binding of ownedBindings) {
      const parameter = binding.parameter;
      if (!parameter) {
        continue;
      }
      const record = usage.get(parameter) ?? { bindingCount: 0, targetIds: new Set<string>() };
      record.bindingCount += 1;
      record.targetIds.add(deformer.id);
      usage.set(parameter, record);
    }

    const parameterCategories = parameterIds.reduce<Record<string, number>>((counts, parameter) => {
      const category = parameterCategory(parameter);
      counts[category] = (counts[category] ?? 0) + 1;
      return counts;
    }, {});
    const totalBindingCount = ownedBindings.length;
    const pinCount = deformer.warp?.pins?.length ?? 0;
    const childDeformerIds = childDeformersByParent.get(deformer.id) ?? [];
    const reasons = overloadReasons(parameterIds, parameterCategories, totalBindingCount, pinBindings.length, branchPartIds.length, childDeformerIds.length);
    const score = scoreTarget(parameterIds.length, totalBindingCount, pinBindings.length, branchPartIds.length, reasons.length);
    const severity: ParameterDistributionSeverity = reasons.length ? (score >= 75 ? "review" : score >= 45 ? "info" : "ok") : score >= 85 ? "info" : "ok";

    return {
      id: deformer.id,
      name: deformer.name,
      kind: deformer.kind,
      parentId: deformer.parentId,
      uniqueParameterCount: parameterIds.length,
      parameterIds,
      ownedParameterIds: parameterIds,
      inheritedPartParameterIds,
      parameterCategories,
      deformerBindingCount: deformerBindings.length,
      warpPinBindingCount: pinBindings.length,
      partBindingCount: partBindings.length,
      inheritedPartBindingCount: partBindings.length,
      totalBindingCount,
      pinCount,
      directPartCount: directPartIds.length,
      branchPartCount: branchPartIds.length,
      directPartIds,
      branchPartIds,
      childDeformerIds,
      score,
      severity,
      reasons,
      splitSuggestions: splitSuggestions(deformer, parameterIds, parameterCategories, branchPartIds.length, childDeformerIds.length)
    } satisfies ParameterDistributionTarget;
  });

  const sortedTargets = targets.sort((left, right) => right.score - left.score || right.uniqueParameterCount - left.uniqueParameterCount || left.id.localeCompare(right.id));
  const overloadedTargets = sortedTargets.filter((target) => target.severity !== "ok");
  const parameterUsage = [...usage]
    .map(([parameter, record]) => ({
      parameter,
      targetCount: record.targetIds.size,
      bindingCount: record.bindingCount,
      targetIds: [...record.targetIds].sort()
    }))
    .sort((left, right) => right.targetCount - left.targetCount || right.bindingCount - left.bindingCount || left.parameter.localeCompare(right.parameter));

  return {
    targetCount: targets.length,
    overloadedCount: overloadedTargets.length,
    reviewCount: overloadedTargets.filter((target) => target.severity === "review").length,
    maxUniqueParameters: sortedTargets[0]?.uniqueParameterCount ?? 0,
    maxBindingCount: sortedTargets[0]?.totalBindingCount ?? 0,
    targets: sortedTargets,
    overloadedTargets,
    parameterUsage
  };
}

function buildChildrenByParent(parts: RigPart[]): Map<string, string[]> {
  const children = new Map<string, string[]>();
  for (const part of parts) {
    if (!part.parentId) {
      continue;
    }
    const ids = children.get(part.parentId) ?? [];
    ids.push(part.id);
    children.set(part.parentId, ids);
  }
  return children;
}

function buildChildDeformersByParent(deformers: RigDeformer[]): Map<string, string[]> {
  const children = new Map<string, string[]>();
  for (const deformer of deformers) {
    if (!deformer.parentId) {
      continue;
    }
    const ids = children.get(deformer.parentId) ?? [];
    ids.push(deformer.id);
    children.set(deformer.parentId, ids);
  }
  return children;
}

function buildDirectPartIdsByDeformer(parts: RigPart[], deformers: RigDeformer[]): Map<string, Set<string>> {
  const byDeformer = new Map<string, Set<string>>();
  const add = (deformerId: string, partId: string) => {
    const ids = byDeformer.get(deformerId) ?? new Set<string>();
    ids.add(partId);
    byDeformer.set(deformerId, ids);
  };

  for (const part of parts) {
    if (part.deformerId) {
      add(part.deformerId, part.id);
    }
  }
  for (const deformer of deformers) {
    for (const partId of deformer.targetPartIds ?? []) {
      add(deformer.id, partId);
    }
  }
  return byDeformer;
}

function collectBranchPartIds(rootIds: string[], childrenByParent: Map<string, string[]>): string[] {
  const collected = new Set<string>();
  const visit = (partId: string) => {
    if (collected.has(partId)) {
      return;
    }
    collected.add(partId);
    for (const childId of childrenByParent.get(partId) ?? []) {
      visit(childId);
    }
  };
  rootIds.forEach(visit);
  return [...collected].sort();
}

function overloadReasons(
  parameterIds: string[],
  categories: Record<string, number>,
  totalBindings: number,
  pinBindings: number,
  branchPartCount: number,
  childDeformerCount: number
): string[] {
  const reasons: string[] = [];
  if (parameterIds.length >= OVERLOAD_PARAMETER_REVIEW) {
    reasons.push(`${parameterIds.length} unique parameters`);
  }
  if ((categories.angle ?? 0) && (categories.body ?? 0)) {
    reasons.push("face angle and body angle keys share one deformer");
  }
  if (((categories.mouth ?? 0) || (categories.eye ?? 0)) && ((categories.angle ?? 0) || (categories.body ?? 0))) {
    reasons.push("expression keys are mixed with pose-angle keys");
  }
  if (totalBindings >= OVERLOAD_BINDING_REVIEW) {
    reasons.push(`${totalBindings} total bindings`);
  }
  if (pinBindings >= 10) {
    reasons.push(`${pinBindings} warp-pin bindings`);
  }
  if (branchPartCount >= OVERLOAD_BRANCH_REVIEW && childDeformerCount === 0) {
    reasons.push(`${branchPartCount} branch parts with no child deformers`);
  }
  return reasons;
}

function splitSuggestions(
  deformer: RigDeformer,
  parameterIds: string[],
  categories: Record<string, number>,
  branchPartCount: number,
  childDeformerCount: number
): string[] {
  const suggestions: string[] = [];
  if ((categories.angle ?? 0) && (categories.body ?? 0)) {
    suggestions.push(`Split ${deformer.id} into a parent body/shoulder layer and a child face-angle layer so ParamAngle* and ParamBodyAngle* can be tuned independently.`);
  }
  if (((categories.mouth ?? 0) || (categories.eye ?? 0)) && ((categories.angle ?? 0) || (categories.body ?? 0))) {
    suggestions.push(`Move mouth/eye expression keys out of ${deformer.id} into local expression deformers or part-level keys.`);
  }
  if (parameterIds.length >= OVERLOAD_PARAMETER_REVIEW) {
    suggestions.push(`Keep ${deformer.id} to its main role and migrate secondary parameters (${parameterIds.join(", ")}) into child deformers.`);
  }
  if (branchPartCount >= OVERLOAD_BRANCH_REVIEW && childDeformerCount === 0) {
    suggestions.push(`Create child deformers under ${deformer.id} for high-risk branches instead of driving all ${branchPartCount} parts from one node.`);
  }
  if (!suggestions.length) {
    suggestions.push(`Review ${deformer.id} only if the next pose QA report shows cross-pose regressions.`);
  }
  return suggestions;
}

function scoreTarget(uniqueParameters: number, totalBindings: number, pinBindings: number, branchPartCount: number, reasonCount: number): number {
  const raw = uniqueParameters * 14 + totalBindings * 1.8 + pinBindings * 1.4 + Math.max(0, branchPartCount - 10) * 0.6 + reasonCount * 10;
  return Math.min(100, Math.round(raw));
}

function parameterCategory(parameter: string): string {
  if (/BodyAngle/i.test(parameter)) {
    return "body";
  }
  if (/Angle/i.test(parameter)) {
    return "angle";
  }
  if (/Mouth/i.test(parameter)) {
    return "mouth";
  }
  if (/Eye/i.test(parameter)) {
    return "eye";
  }
  return "other";
}



