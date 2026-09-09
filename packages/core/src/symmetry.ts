import type { RigDocument, RigPart, RigSymmetryContract, RigSymmetryLink, RigWarpPin } from "./types.js";

export interface SymmetryPartScore {
  partId: string;
  name: string;
  pairCount: number;
  coverage: number;
  error: number;
}

export interface SymmetryAxisEstimate {
  axis: "vertical";
  axisU: number;
  confidence: number;
  tolerance: number;
  sampleCount: number;
  averageError: number;
  partScores: SymmetryPartScore[];
  protectedPartIds: string[];
}

/** Estimate the normalized vertical symmetry axis from neutral ArtMesh UVs. */
export function estimateSymmetryAxis(rig: RigDocument, requestedPartIds?: string[]): SymmetryAxisEstimate {
  const requested = requestedPartIds?.length ? new Set(requestedPartIds) : undefined;
  const parts = rig.parts.filter((part) => part.artMesh?.enabled && (!requested || requested.has(part.id)));
  const tolerance = 0.035;
  const candidates = Array.from({ length: 41 }, (_, index) => 0.4 + index * 0.005);
  let best = { axisU: 0.5, score: Number.POSITIVE_INFINITY, pairCount: 0, error: Number.POSITIVE_INFINITY };
  for (const axisU of candidates) {
    let pairCount = 0;
    let totalError = 0;
    for (const part of parts) {
      const vertices = part.artMesh?.vertices ?? [];
      const left = vertices.filter((vertex) => vertex.u < axisU - tolerance * 0.25);
      const usedTargets = new Set<string>();
      for (const vertex of left) {
        const mirrorU = 2 * axisU - vertex.u;
        const target = vertices
          .filter((candidate) => candidate.u > axisU + tolerance * 0.25 && !usedTargets.has(candidate.id))
          .map((candidate) => ({ candidate, error: Math.abs(candidate.u - mirrorU) + Math.abs(candidate.v - vertex.v) }))
          .sort((a, b) => a.error - b.error)[0];
        if (!target || target.error > tolerance) continue;
        pairCount += 1;
        usedTargets.add(target.candidate.id);
        totalError += target.error;
      }
    }
    const averageError = pairCount ? totalError / pairCount : 1;
    const coveragePenalty = parts.length ? Math.max(0, 1 - pairCount / Math.max(1, parts.reduce((sum, part) => sum + Math.floor((part.artMesh?.vertices.length ?? 0) / 2), 0))) * 0.02 : 0.02;
    const score = averageError + coveragePenalty;
    if (score < best.score) best = { axisU, score, pairCount, error: averageError };
  }
  const partScores = parts.map((part) => scorePart(part, best.axisU, tolerance));
  const confidence = clamp01(1 - best.error / tolerance) * (best.pairCount ? 1 : 0);
  const protectedPartIds = inferProtectedPartIds(rig.parts);
  return {
    axis: "vertical",
    axisU: round(best.axisU, 6),
    confidence: round(confidence, 6),
    tolerance,
    sampleCount: best.pairCount,
    averageError: round(best.error, 8),
    partScores,
    protectedPartIds
  };
}

export function symmetryContractFromEstimate(estimate: SymmetryAxisEstimate): RigSymmetryContract {
  return {
    version: 1,
    axis: "vertical",
    axisU: estimate.axisU,
    tolerance: estimate.tolerance,
    confidence: estimate.confidence,
    protectedPartIds: [...estimate.protectedPartIds],
    protectedDeformerIds: [],
    protectedVertexIds: {},
    links: []
  };
}

/** Infer safe mirror relationships without changing geometry or bindings. */
export function inferSymmetryLinks(rig: RigDocument, contract: RigSymmetryContract): RigSymmetryLink[] {
  const links: RigSymmetryLink[] = [];
  const seen = new Set<string>();
  const protectedParts = new Set(contract.protectedPartIds);
  const protectedDeformers = new Set(contract.protectedDeformerIds);
  const add = (link: RigSymmetryLink) => {
    if (link.sourceId === link.targetId) return;
    const key = `${link.kind}:${[link.sourceId, link.targetId].sort().join("|")}`;
    if (seen.has(key) || links.length >= 256) return;
    seen.add(key);
    links.push(link.sourceId < link.targetId ? link : { ...link, sourceId: link.targetId, targetId: link.sourceId });
  };
  pairNamed(rig.parts, (part) => part.id, (part) => part.name, (source, target) => {
    if (protectedParts.has(source) || protectedParts.has(target)) return;
    add({ kind: "part", sourceId: source, targetId: target, axis: "x", invertX: true, preserveY: true });
  }, (part) => part.kind);
  pairNamed(rig.deformers ?? [], (deformer) => deformer.id, (deformer) => deformer.name, (source, target) => {
    if (protectedDeformers.has(source) || protectedDeformers.has(target)) return;
    add({ kind: "deformer", sourceId: source, targetId: target, axis: "x", invertX: true, preserveY: true });
  }, (deformer) => deformer.kind);
  for (const deformer of rig.deformers ?? []) {
    if (deformer.kind !== "warp" || protectedDeformers.has(deformer.id)) continue;
    const pins = deformer.warp?.pins ?? [];
    pairWarpPins(pins, contract.tolerance, (source, target) => {
      add({ kind: "warp-pin", sourceId: `${deformer.id}:${source}`, targetId: `${deformer.id}:${target}`, axis: "x", invertX: true, preserveY: true });
    });
  }
  pairNamed(rig.physics?.chains ?? [], (chain) => chain.id, (chain) => chain.name, (source, target) => {
    add({ kind: "physics", sourceId: source, targetId: target, axis: "x", invertX: true, preserveY: true });
  });
  return links;
}

export function symmetryContractWithInferredLinks(rig: RigDocument, contract: RigSymmetryContract): RigSymmetryContract {
  return { ...structuredClone(contract), links: inferSymmetryLinks(rig, contract) };
}

function pairNamed<T>(items: T[], getId: (item: T) => string, getName: (item: T) => string, onPair: (sourceId: string, targetId: string) => void, getCategory?: (item: T) => string) {
  const byName = new Map<string, T[]>();
  const usedTargets = new Set<string>();
  for (const item of items) {
    const name = getName(item).trim();
    const current = byName.get(name) ?? [];
    current.push(item);
    byName.set(name, current);
  }
  for (const item of items) {
    const sourceId = getId(item);
    const sourceName = getName(item).trim();
    const targetName = swapSideText(sourceName);
    const candidates = byName.get(targetName) ?? [];
    if (targetName === sourceName && swapSideText(sourceId) === sourceId) continue;
    const category = getCategory?.(item);
    const swappedId = swapSideText(sourceId);
    const target = candidates
      .filter((candidate) => getId(candidate) !== sourceId && !usedTargets.has(getId(candidate)) && (!getCategory || getCategory(candidate) === category))
      .sort((left, right) => {
        const leftExact = getId(left) === swappedId ? 0 : 1;
        const rightExact = getId(right) === swappedId ? 0 : 1;
        return leftExact - rightExact || getId(left).localeCompare(getId(right));
      })[0];
    if (target) usedTargets.add(getId(target));
    if (target) onPair(sourceId, getId(target));
  }
}

function pairWarpPins(pins: RigWarpPin[], tolerance: number, onPair: (sourceId: string, targetId: string) => void) {
  const byName = new Map(pins.map((pin) => [pin.name.trim(), pin.id]));
  const used = new Set<string>();
  for (const pin of pins) {
    if (used.has(pin.id)) continue;
    const named = byName.get(swapSideText(pin.name.trim()));
    const target = named && named !== pin.id ? pins.find((candidate) => candidate.id === named) : undefined;
    const geometric = target ?? pins
      .filter((candidate) => candidate.id !== pin.id && !used.has(candidate.id) && Math.abs(candidate.u - (1 - pin.u)) <= tolerance && Math.abs(candidate.v - pin.v) <= tolerance)
      .sort((left, right) => (Math.abs(left.u - (1 - pin.u)) + Math.abs(left.v - pin.v)) - (Math.abs(right.u - (1 - pin.u)) + Math.abs(right.v - pin.v)))[0];
    if (!geometric) continue;
    used.add(pin.id);
    used.add(geometric.id);
    onPair(pin.id, geometric.id);
  }
}

function swapSideText(value: string): string {
  const map: Record<string, string> = { left: "right", right: "left", Left: "Right", Right: "Left", LEFT: "RIGHT", RIGHT: "LEFT", 左: "右", 右: "左" };
  return value.replace(/left|right|Left|Right|LEFT|RIGHT|左|右/g, (token) => map[token] ?? token);
}
function scorePart(part: RigPart, axisU: number, tolerance: number): SymmetryPartScore {
  const vertices = part.artMesh?.vertices ?? [];
  const left = vertices.filter((vertex) => vertex.u < axisU - tolerance * 0.25);
  const usedTargets = new Set<string>();
  let pairCount = 0;
  let error = 0;
  for (const vertex of left) {
    const mirrorU = 2 * axisU - vertex.u;
    const target = vertices
      .filter((candidate) => candidate.u > axisU + tolerance * 0.25 && !usedTargets.has(candidate.id))
      .map((candidate) => ({ candidate, error: Math.abs(candidate.u - mirrorU) + Math.abs(candidate.v - vertex.v) }))
      .sort((a, b) => a.error - b.error)[0];
    if (!target || target.error > tolerance) continue;
    pairCount += 1;
        usedTargets.add(target.candidate.id);
    error += target.error;
  }
  return {
    partId: part.id,
    name: part.name,
    pairCount,
    coverage: left.length ? round(pairCount / left.length, 6) : 0,
    error: round(pairCount ? error / pairCount : 1, 8)
  };
}

function inferProtectedPartIds(parts: RigPart[]): string[] {
  return parts
    .filter((part) => part.role === "accessory" || (part.tags ?? []).some((tag) => tag === "asymmetric" || tag === "non-symmetric") || /髪飾り|リボン|非対称|asymmetr/i.test(part.name))
    .map((part) => part.id);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}