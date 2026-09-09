import type {
  RigDocument,
  RigGlue,
  RigGlueCandidate,
  RigGlueCandidateBBox,
  RigGlueCandidateEvidence,
  RigGlueCandidateKind,
  RigGlueCandidateStatus,
  RigGlueMode,
  RigGlueStatus,
  RigGlueVertexPair
} from "./types.js";

const GLUE_KINDS = new Set<RigGlueCandidateKind>(["overlap", "near-gap", "manual"]);
const GLUE_STATUSES = new Set<RigGlueCandidateStatus>(["candidate", "accepted", "rejected"]);
const RIG_GLUE_STATUSES = new Set<RigGlueStatus>(["draft", "active", "disabled"]);
const MAX_GLUE_VERTEX_PAIRS = 256;
const RIG_GLUE_MODES = new Set<RigGlueMode>(["seam-debug", "soft-seam", "stitch"]);

export interface RigGlueListItem {
  id: string;
  name: string;
  enabled: boolean;
  status: RigGlueStatus;
  mode: RigGlueMode;
  sourceCandidateId?: string;
  partAId: string;
  partAName: string;
  partBId: string;
  partBName: string;
  region?: string;
  weightA: number;
  weightB: number;
  strength: number;
  priority: number;
  debugVisible: boolean;
  tags: string[];
  notes?: string;
  seamPoints: RigGlue["seamPoints"];
  evidence?: RigGlueCandidateEvidence;
}

export interface PromoteGlueCandidatesOptions {
  candidateIds?: string[];
  acceptedOnly?: boolean;
  activate?: boolean;
  markAccepted?: boolean;
  mode?: RigGlueMode;
}

export interface PromoteGlueCandidatesResult {
  promoted: RigGlueListItem[];
  updated: RigGlueListItem[];
  skipped: Array<{ candidateId: string; reason: string }>;
}

export interface RigGlueCandidateListItem {
  id: string;
  name: string;
  enabled: boolean;
  status: RigGlueCandidateStatus;
  kind: RigGlueCandidateKind;
  partAId: string;
  partAName: string;
  partBId: string;
  partBName: string;
  region?: string;
  priority: number;
  weightA: number;
  weightB: number;
  tags: string[];
  notes?: string;
  evidence: RigGlueCandidateEvidence;
}

export function ensureRigGlueCandidates(rig: RigDocument): RigGlueCandidate[] {
  if (!Array.isArray(rig.glueCandidates)) {
    rig.glueCandidates = [];
  }
  rig.glueCandidates.forEach((candidate) => normalizeGlueCandidate(candidate, rig));
  return rig.glueCandidates;
}

export function readRigGlueCandidates(rig: RigDocument): RigGlueCandidate[] {
  return Array.isArray(rig.glueCandidates) ? rig.glueCandidates : [];
}

export function normalizeGlueCandidate(candidate: RigGlueCandidate, rig?: RigDocument): RigGlueCandidate {
  const fallbackPartA = rig?.parts?.[0]?.id ?? "";
  const fallbackPartB = rig?.parts?.find((part) => part.id !== fallbackPartA)?.id ?? fallbackPartA;
  candidate.id = nonEmptyString(candidate.id) ?? uniqueGlueId(candidate.partAId ?? fallbackPartA, candidate.partBId ?? fallbackPartB, candidate.region);
  candidate.partAId = nonEmptyString(candidate.partAId) ?? fallbackPartA;
  candidate.partBId = nonEmptyString(candidate.partBId) ?? fallbackPartB;
  candidate.name = nonEmptyString(candidate.name) ?? defaultGlueName(rig, candidate.partAId, candidate.partBId);
  candidate.enabled = typeof candidate.enabled === "boolean" ? candidate.enabled : true;
  candidate.status = GLUE_STATUSES.has(candidate.status) ? candidate.status : "candidate";
  candidate.kind = GLUE_KINDS.has(candidate.kind) ? candidate.kind : "manual";
  candidate.weightA = clamp01(candidate.weightA, 0.5);
  candidate.weightB = clamp01(candidate.weightB, 0.5);
  candidate.priority = finiteNumber(candidate.priority) ? Math.max(0, Math.round(candidate.priority)) : 50;
  if (typeof candidate.region !== "string" || !candidate.region.trim()) {
    delete candidate.region;
  }
  candidate.tags = Array.isArray(candidate.tags) ? uniqueStrings(candidate.tags) : [];
  if (typeof candidate.notes !== "string" || !candidate.notes.trim()) {
    delete candidate.notes;
  }
  candidate.evidence = normalizeGlueEvidence(candidate.evidence, candidate.region);
  return candidate;
}

export function glueCandidateListItem(rig: RigDocument, candidate: RigGlueCandidate): RigGlueCandidateListItem {
  normalizeGlueCandidate(candidate, rig);
  return {
    id: candidate.id,
    name: candidate.name,
    enabled: candidate.enabled,
    status: candidate.status,
    kind: candidate.kind,
    partAId: candidate.partAId,
    partAName: partName(rig, candidate.partAId),
    partBId: candidate.partBId,
    partBName: partName(rig, candidate.partBId),
    region: candidate.region,
    priority: candidate.priority,
    weightA: candidate.weightA,
    weightB: candidate.weightB,
    tags: candidate.tags ?? [],
    notes: candidate.notes,
    evidence: candidate.evidence
  };
}

export function patchGlueCandidate(candidate: RigGlueCandidate, rawPatch: Record<string, unknown>, rig: RigDocument): RigGlueCandidate {
  const patch = (rawPatch.glueCandidate && typeof rawPatch.glueCandidate === "object" && !Array.isArray(rawPatch.glueCandidate)
    ? rawPatch.glueCandidate
    : rawPatch) as Partial<RigGlueCandidate> & { evidence?: Partial<RigGlueCandidateEvidence> };

  if (patch.id !== undefined && patch.id !== candidate.id) {
    throw new Error("Changing glue candidate id through PATCH is not supported.");
  }
  if (typeof patch.name === "string") candidate.name = patch.name;
  if (typeof patch.enabled === "boolean") candidate.enabled = patch.enabled;
  if (patch.status && GLUE_STATUSES.has(patch.status)) candidate.status = patch.status;
  if (patch.kind && GLUE_KINDS.has(patch.kind)) candidate.kind = patch.kind;
  if (typeof patch.partAId === "string") candidate.partAId = patch.partAId;
  if (typeof patch.partBId === "string") candidate.partBId = patch.partBId;
  if (typeof patch.region === "string") candidate.region = patch.region;
  if (typeof patch.weightA === "number") candidate.weightA = patch.weightA;
  if (typeof patch.weightB === "number") candidate.weightB = patch.weightB;
  if (typeof patch.priority === "number") candidate.priority = patch.priority;
  if (Array.isArray(patch.tags)) candidate.tags = patch.tags.filter((tag): tag is string => typeof tag === "string");
  if (typeof patch.notes === "string") candidate.notes = patch.notes;
  if (patch.evidence && typeof patch.evidence === "object") {
    candidate.evidence = normalizeGlueEvidence({ ...(candidate.evidence ?? { source: "manual" }), ...patch.evidence }, candidate.region);
  }
  return normalizeGlueCandidate(candidate, rig);
}

export function ensureRigGlue(rig: RigDocument): RigGlue[] {
  if (!Array.isArray(rig.glue)) {
    rig.glue = [];
  }
  rig.glue.forEach((glue) => normalizeGlue(glue, rig));
  return rig.glue;
}

export function readRigGlue(rig: RigDocument): RigGlue[] {
  return Array.isArray(rig.glue) ? rig.glue : [];
}

export function normalizeGlue(glue: RigGlue, rig?: RigDocument): RigGlue {
  const fallbackPartA = rig?.parts?.[0]?.id ?? "";
  const fallbackPartB = rig?.parts?.find((part) => part.id !== fallbackPartA)?.id ?? fallbackPartA;
  glue.id = nonEmptyString(glue.id) ?? uniqueGlueObjectId(glue.sourceCandidateId, glue.partAId ?? fallbackPartA, glue.partBId ?? fallbackPartB, glue.region);
  glue.partAId = nonEmptyString(glue.partAId) ?? fallbackPartA;
  glue.partBId = nonEmptyString(glue.partBId) ?? fallbackPartB;
  glue.name = nonEmptyString(glue.name) ?? defaultGlueName(rig, glue.partAId, glue.partBId);
  glue.enabled = typeof glue.enabled === "boolean" ? glue.enabled : true;
  glue.status = RIG_GLUE_STATUSES.has(glue.status) ? glue.status : "draft";
  glue.mode = RIG_GLUE_MODES.has(glue.mode) ? glue.mode : "soft-seam";
  glue.weightA = clamp01(glue.weightA, 0.5);
  glue.weightB = clamp01(glue.weightB, 0.5);
  glue.strength = clamp01(glue.strength, 0.35);
  glue.priority = finiteNumber(glue.priority) ? Math.max(0, Math.round(glue.priority)) : 50;
  glue.debugVisible = typeof glue.debugVisible === "boolean" ? glue.debugVisible : true;
  glue.seamPoints = normalizeGlueSeamPoints(glue.seamPoints);
  if (!glue.seamPoints?.length) {
    delete glue.seamPoints;
  }
  glue.vertexPairs = normalizeGlueVertexPairs(glue.vertexPairs);
  if (!glue.vertexPairs?.length) {
    delete glue.vertexPairs;
  }
  if (typeof glue.sourceCandidateId !== "string" || !glue.sourceCandidateId.trim()) {
    delete glue.sourceCandidateId;
  }
  if (typeof glue.region !== "string" || !glue.region.trim()) {
    delete glue.region;
  }
  glue.tags = Array.isArray(glue.tags) ? uniqueStrings(glue.tags) : [];
  if (typeof glue.notes !== "string" || !glue.notes.trim()) {
    delete glue.notes;
  }
  if (glue.evidence !== undefined) {
    glue.evidence = normalizeGlueEvidence(glue.evidence, glue.region);
  }
  return glue;
}

export function glueListItem(rig: RigDocument, glue: RigGlue): RigGlueListItem {
  normalizeGlue(glue, rig);
  return {
    id: glue.id,
    name: glue.name,
    enabled: glue.enabled,
    status: glue.status,
    mode: glue.mode,
    sourceCandidateId: glue.sourceCandidateId,
    partAId: glue.partAId,
    partAName: partName(rig, glue.partAId),
    partBId: glue.partBId,
    partBName: partName(rig, glue.partBId),
    region: glue.region,
    weightA: glue.weightA,
    weightB: glue.weightB,
    strength: glue.strength,
    priority: glue.priority,
    debugVisible: glue.debugVisible !== false,
    seamPoints: glue.seamPoints,
    tags: glue.tags ?? [],
    notes: glue.notes,
    evidence: glue.evidence
  };
}

export function patchGlue(glue: RigGlue, rawPatch: Record<string, unknown>, rig: RigDocument): RigGlue {
  const patch = (rawPatch.glue && typeof rawPatch.glue === "object" && !Array.isArray(rawPatch.glue)
    ? rawPatch.glue
    : rawPatch) as Partial<RigGlue> & { evidence?: Partial<RigGlueCandidateEvidence> };

  if (patch.id !== undefined && patch.id !== glue.id) {
    throw new Error("Changing glue id through PATCH is not supported.");
  }
  if (typeof patch.name === "string") glue.name = patch.name;
  if (typeof patch.enabled === "boolean") glue.enabled = patch.enabled;
  if (patch.status && RIG_GLUE_STATUSES.has(patch.status)) glue.status = patch.status;
  if (patch.mode && RIG_GLUE_MODES.has(patch.mode)) glue.mode = patch.mode;
  if (typeof patch.sourceCandidateId === "string") glue.sourceCandidateId = patch.sourceCandidateId;
  if (typeof patch.partAId === "string") glue.partAId = patch.partAId;
  if (typeof patch.partBId === "string") glue.partBId = patch.partBId;
  if (typeof patch.region === "string") glue.region = patch.region;
  if (typeof patch.weightA === "number") glue.weightA = patch.weightA;
  if (typeof patch.weightB === "number") glue.weightB = patch.weightB;
  if (typeof patch.strength === "number") glue.strength = patch.strength;
  if (typeof patch.priority === "number") glue.priority = patch.priority;
  if (typeof patch.debugVisible === "boolean") glue.debugVisible = patch.debugVisible;
  if (Array.isArray(patch.seamPoints)) glue.seamPoints = patch.seamPoints;
  if (Array.isArray(patch.vertexPairs)) glue.vertexPairs = patch.vertexPairs;
  if (Array.isArray(patch.tags)) glue.tags = patch.tags.filter((tag): tag is string => typeof tag === "string");
  if (typeof patch.notes === "string") glue.notes = patch.notes;
  if (patch.evidence && typeof patch.evidence === "object") {
    glue.evidence = normalizeGlueEvidence({ ...(glue.evidence ?? { source: "manual" }), ...patch.evidence }, glue.region);
  }
  return normalizeGlue(glue, rig);
}

export function promoteGlueCandidates(rig: RigDocument, options: PromoteGlueCandidatesOptions = {}): PromoteGlueCandidatesResult {
  const candidates = ensureRigGlueCandidates(rig);
  const glues = ensureRigGlue(rig);
  const candidateIdSet = new Set(options.candidateIds ?? []);
  const hasExplicitCandidates = candidateIdSet.size > 0;
  const acceptedOnly = options.acceptedOnly ?? !hasExplicitCandidates;
  const mode = options.mode && RIG_GLUE_MODES.has(options.mode) ? options.mode : "soft-seam";
  const status: RigGlueStatus = options.activate === false ? "draft" : "active";
  const promoted: RigGlueListItem[] = [];
  const updated: RigGlueListItem[] = [];
  const skipped: PromoteGlueCandidatesResult["skipped"] = [];

  for (const candidate of candidates) {
    normalizeGlueCandidate(candidate, rig);
    if (hasExplicitCandidates && !candidateIdSet.has(candidate.id)) {
      continue;
    }
    if (!candidate.enabled) {
      skipped.push({ candidateId: candidate.id, reason: "candidate-disabled" });
      continue;
    }
    if (acceptedOnly && candidate.status !== "accepted") {
      skipped.push({ candidateId: candidate.id, reason: "candidate-not-accepted" });
      continue;
    }

    const existing = glues.find((glue) => glue.sourceCandidateId === candidate.id) ?? glues.find((glue) => sameGlueParts(glue, candidate));
    if (existing) {
      existing.sourceCandidateId = existing.sourceCandidateId ?? candidate.id;
      existing.name = nonEmptyString(existing.name) ?? glueFromCandidate(candidate, status, mode).name;
      existing.status = status;
      existing.mode = mode;
      existing.enabled = true;
      existing.region = candidate.region;
      existing.weightA = candidate.weightA;
      existing.weightB = candidate.weightB;
      existing.priority = candidate.priority;
      existing.evidence = candidate.evidence;
      existing.tags = uniqueStrings([...(existing.tags ?? []), "promoted-glue", mode]);
      normalizeGlue(existing, rig);
      updated.push(glueListItem(rig, existing));
    } else {
      const glue = glueFromCandidate(candidate, status, mode);
      glues.push(normalizeGlue(glue, rig));
      promoted.push(glueListItem(rig, glue));
    }

    if (options.markAccepted !== false) {
      candidate.status = "accepted";
    }
  }

  return { promoted, updated, skipped };
}

function sameGlueParts(glue: RigGlue, candidate: RigGlueCandidate): boolean {
  const sameDirection = glue.partAId === candidate.partAId && glue.partBId === candidate.partBId;
  const reversed = glue.partAId === candidate.partBId && glue.partBId === candidate.partAId;
  return (sameDirection || reversed) && (glue.region ?? "") === (candidate.region ?? "");
}

function glueFromCandidate(candidate: RigGlueCandidate, status: RigGlueStatus, mode: RigGlueMode): RigGlue {
  return {
    id: uniqueGlueObjectId(candidate.id, candidate.partAId, candidate.partBId, candidate.region),
    name: candidate.name.replace(/\s*\(([^)]+)\)$/, "") + " Glue",
    enabled: true,
    status,
    mode,
    sourceCandidateId: candidate.id,
    partAId: candidate.partAId,
    partBId: candidate.partBId,
    region: candidate.region,
    weightA: candidate.weightA,
    weightB: candidate.weightB,
    strength: candidate.kind === "near-gap" ? 0.45 : 0.3,
    priority: candidate.priority,
    debugVisible: true,
    tags: uniqueStrings([...(candidate.tags ?? []), "promoted-glue", mode]),
    notes: candidate.notes ? `Promoted from candidate. ${candidate.notes}` : "Promoted from glue candidate.",
    evidence: candidate.evidence
  };
}

function uniqueGlueObjectId(sourceCandidateId: string | undefined, partAId: string, partBId: string, region?: string): string {
  const fromCandidate = nonEmptyString(sourceCandidateId)?.replace(/^glue-/, "seam-");
  return fromCandidate ?? uniqueGlueId(partAId, partBId, region, "seam").replace(/^glue-/, "seam-");
}

function uniqueGlueId(partAId: string, partBId: string, region?: string, prefix = "glue"): string {
  const regionSlug = slug(region ?? "");
  const regionPart = regionSlug ? `${regionSlug}-` : "";
  return `${prefix}-${regionPart}${slug(partAId) || "part-a"}-${slug(partBId) || "part-b"}`;
}

function normalizeGlueSeamPoints(value: unknown): RigGlue["seamPoints"] {
  if (!Array.isArray(value)) {
    return [];
  }
  const points: NonNullable<RigGlue["seamPoints"]> = [];
  for (const entry of value.slice(0, 32)) {
    const source = entry && typeof entry === "object" ? entry as Partial<NonNullable<RigGlue["seamPoints"]>[number]> : {};
    const a = source.a && typeof source.a === "object" ? source.a as { u?: unknown; v?: unknown } : undefined;
    const b = source.b && typeof source.b === "object" ? source.b as { u?: unknown; v?: unknown } : undefined;
    if (!a || !b) {
      continue;
    }
    const point: NonNullable<RigGlue["seamPoints"]>[number] = {
      a: { u: clamp01(a.u, 0.5), v: clamp01(a.v, 0.5) },
      b: { u: clamp01(b.u, 0.5), v: clamp01(b.v, 0.5) }
    };
    if (finiteNumber(source.weightA)) point.weightA = clamp01(source.weightA, 0.5);
    if (finiteNumber(source.weightB)) point.weightB = clamp01(source.weightB, 0.5);
    if (finiteNumber(source.radius)) point.radius = clampNumber(source.radius, 0.001, 1.5);
    if (finiteNumber(source.strength)) point.strength = clamp01(source.strength, 0.5);
    points.push(point);
  }
  return points;
}

function normalizeGlueVertexPairs(value: unknown): RigGlue["vertexPairs"] {
  if (!Array.isArray(value)) {
    return [];
  }
  const pairs: RigGlueVertexPair[] = [];
  const seen = new Set<string>();
  for (const entry of value.slice(0, MAX_GLUE_VERTEX_PAIRS)) {
    const source = entry && typeof entry === "object" ? entry as Partial<RigGlueVertexPair> : {};
    const a = nonEmptyString(source.a);
    const b = nonEmptyString(source.b);
    if (!a || !b) {
      continue;
    }
    // A vertex may only be bound once per glue; two targets would fight over the same position.
    const key = a + "|" + b;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const pair: RigGlueVertexPair = { a, b };
    if (finiteNumber(source.weight)) pair.weight = clamp01(source.weight, 0.5);
    // The rest offset is recorded in stage units and can legitimately be large, so it is range
    // checked for sanity rather than clamped to a design budget.
    if (finiteNumber(source.restDx)) pair.restDx = clampNumber(source.restDx, -4096, 4096);
    if (finiteNumber(source.restDy)) pair.restDy = clampNumber(source.restDy, -4096, 4096);
    pairs.push(pair);
  }
  return pairs;
}

function normalizeGlueEvidence(evidence: unknown, fallbackRegion?: string): RigGlueCandidateEvidence {
  const source = evidence && typeof evidence === "object" ? evidence as Partial<RigGlueCandidateEvidence> : {};
  const normalized: RigGlueCandidateEvidence = {
    source: source.source === "boundary-diagnostics" ? "boundary-diagnostics" : "manual"
  };
  copyString(source, normalized, "runDir");
  copyString(source, normalized, "summaryPath");
  copyString(source, normalized, "imagePath");
  const region = nonEmptyString(source.region) ?? fallbackRegion;
  if (region) normalized.region = region;
  copyString(source, normalized, "poseId");
  copyFinite(source, normalized, "overlapPixels");
  copyFinite(source, normalized, "overlapRatio");
  copyFinite(source, normalized, "gapPixels");
  if (source.unionBBox) {
    const bbox = normalizeBBox(source.unionBBox);
    if (bbox) normalized.unionBBox = bbox;
  }
  return normalized;
}

function normalizeBBox(value: unknown): RigGlueCandidateBBox | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Partial<RigGlueCandidateBBox>;
  const keys: Array<keyof RigGlueCandidateBBox> = ["left", "top", "right", "bottom", "width", "height"];
  if (!keys.every((key) => finiteNumber(source[key]))) return undefined;
  return {
    left: source.left!,
    top: source.top!,
    right: source.right!,
    bottom: source.bottom!,
    width: source.width!,
    height: source.height!
  };
}

function defaultGlueName(rig: RigDocument | undefined, partAId: string, partBId: string): string {
  return `${partName(rig, partAId)} / ${partName(rig, partBId)}`;
}

function partName(rig: RigDocument | undefined, id: string): string {
  return rig?.parts?.find((part) => part.id === id)?.name ?? id;
}

function copyString<T extends Record<string, unknown>>(source: T, target: T, key: keyof T) {
  const value = source[key];
  if (typeof value === "string" && value.trim()) {
    target[key] = value as T[keyof T];
  }
}

function copyFinite<T extends Record<string, unknown>>(source: T, target: T, key: keyof T) {
  const value = source[key];
  if (finiteNumber(value)) {
    target[key] = value as T[keyof T];
  }
}

function uniqueStrings(values: unknown[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim()))];
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clamp01(value: unknown, fallback = 0): number {
  return clampNumber(finiteNumber(value) ? value : fallback, 0, 1);
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}