import { inferPartRole } from "./partRoles.js";
import type { RigDocument, RigPart, RigPartRole } from "./types.js";

export type ReadinessLevel = "L1" | "L2" | "L3";
export type CoverageStatus = "covered" | "suggested-only" | "missing";

export interface RoleCoverageRequirement {
  role: Exclude<RigPartRole, "unknown">;
  label: string;
  minParts: number;
  purpose: string;
}

export interface RoleCoverageEntry extends RoleCoverageRequirement {
  status: CoverageStatus;
  partIds: string[];
  confirmedPartIds: string[];
  suggestedPartIds: string[];
  artMeshPartIds: string[];
  vertexCount: number;
  bindingCount: number;
}

export interface ReadinessLevelResult {
  level: ReadinessLevel;
  label: string;
  requiredRoles: RoleCoverageEntry[];
  coveredRoleCount: number;
  requiredRoleCount: number;
  coverageRatio: number;
  missingRoles: string[];
  suggestedOnlyRoles: string[];
  ready: boolean;
}

export interface ReadinessRepairHint {
  role: Exclude<RigPartRole, "unknown">;
  label: string;
  action: "confirm-role" | "review-split";
  candidatePartIds: string[];
  candidateNames: string[];
  reasons: string[];
}

export type ReadinessMeasurementId = "eye-center-left" | "eye-center-right" | "jaw-tip" | "neck-width" | "shoulder-span" | "hairline";
export type ReadinessPoint = { x: number; y: number };
export type ReadinessRect = { left: number; top: number; width: number; height: number };

export interface ReadinessMeasurement {
  id: ReadinessMeasurementId;
  label: string;
  status: "proxy" | "missing";
  coordinateSpace: "part-local-aggregate";
  value?: number | { x: number; y: number } | { left: number; top: number; width: number; height: number };
  sourcePartIds: string[];
  confidence: number;
  note: string;
}

export interface RigRecipeRoleSummary {
  role: Exclude<RigPartRole, "unknown">;
  partCount: number;
  artMeshPartCount: number;
  averageWidthRatio?: number;
  averageHeightRatio?: number;
  averageVertexCount?: number;
  deformerIds: string[];
  bindingCount: number;
}

export interface RigReadinessReport {
  format: "standrig-readiness-report";
  version: 1;
  source: {
    name: string;
    schemaVersion: string;
    stage: { width: number; height: number };
    partCount: number;
    imagePartCount: number;
    confirmedRoleCount: number;
    suggestedRoleCount: number;
  };
  levels: Record<ReadinessLevel, ReadinessLevelResult>;
  recommendedLevel: ReadinessLevel | "none";
  requestedLevel: ReadinessLevel;
  requestedLevelReady: boolean;
  missingRoles: string[];
  suggestedOnlyRoles: string[];
  repairHints: ReadinessRepairHint[];
  measurements: {
    status: "proxy-only" | "missing";
    items: ReadinessMeasurement[];
    nextAction: string;
  };
  recipe: {
    format: "standrig-rig-recipe";
    version: 1;
    coordinateSpace: "stage-ratio";
    roles: RigRecipeRoleSummary[];
    notes: string[];
  };
  blockers: string[];
  warnings: string[];
  nextAction: string;
}

const L1_REQUIREMENTS: RoleCoverageRequirement[] = [
  { role: "hair-front", label: "Front hair", minParts: 1, purpose: "front-hair motion or static separation" },
  { role: "hair-back", label: "Back hair", minParts: 1, purpose: "back-hair motion" },
  { role: "hair-side", label: "Side hair", minParts: 1, purpose: "side-hair motion" },
  { role: "hair-tail-left", label: "Left hair tail", minParts: 1, purpose: "left-tail motion" },
  { role: "hair-tail-right", label: "Right hair tail", minParts: 1, purpose: "right-tail motion" },
  { role: "clothing", label: "Clothing", minParts: 1, purpose: "cloth or shoulder motion" }
];

const L2_REQUIREMENTS: RoleCoverageRequirement[] = [
  { role: "face", label: "Face", minParts: 1, purpose: "face XY and head deformation" },
  { role: "eye-left", label: "Left eye", minParts: 1, purpose: "left blink and gaze" },
  { role: "eye-right", label: "Right eye", minParts: 1, purpose: "right blink and gaze" },
  { role: "mouth", label: "Mouth", minParts: 1, purpose: "mouth open/form" },
  { role: "neck", label: "Neck", minParts: 1, purpose: "head-to-body bridge" }
];

const L3_REQUIREMENTS: RoleCoverageRequirement[] = [
  ...L1_REQUIREMENTS,
  ...L2_REQUIREMENTS,
  { role: "torso", label: "Torso", minParts: 1, purpose: "full-body motion anchor" }
];

export const READINESS_ROLE_MATRIX: Readonly<Record<ReadinessLevel, ReadonlyArray<RoleCoverageRequirement>>> = {
  L1: L1_REQUIREMENTS,
  L2: L2_REQUIREMENTS,
  L3: L3_REQUIREMENTS
};

const LEVEL_LABELS: Record<ReadinessLevel, string> = {
  L1: "Motion foundation",
  L2: "Face XY + blink + mouth",
  L3: "Full-body coverage"
};

interface LocalBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function round(value: number, digits = 6): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function boundsForPart(part: RigPart): LocalBounds | undefined {
  const vertices = part.artMesh?.vertices ?? [];
  const valid = vertices.filter((vertex) => finite(vertex.x) && finite(vertex.y));
  if (valid.length < 3) return undefined;
  return {
    left: Math.min(...valid.map((vertex) => vertex.x)),
    top: Math.min(...valid.map((vertex) => vertex.y)),
    right: Math.max(...valid.map((vertex) => vertex.x)),
    bottom: Math.max(...valid.map((vertex) => vertex.y))
  };
}

function unionBounds(parts: RigPart[]): { bounds?: LocalBounds; ids: string[] } {
  const entries = parts.map((part) => ({ part, bounds: boundsForPart(part) })).filter((entry): entry is { part: RigPart; bounds: LocalBounds } => Boolean(entry.bounds));
  if (!entries.length) return { ids: [] };
  return {
    bounds: {
      left: Math.min(...entries.map((entry) => entry.bounds.left)),
      top: Math.min(...entries.map((entry) => entry.bounds.top)),
      right: Math.max(...entries.map((entry) => entry.bounds.right)),
      bottom: Math.max(...entries.map((entry) => entry.bounds.bottom))
    },
    ids: entries.map((entry) => entry.part.id)
  };
}

function roleParts(rig: RigDocument, role: Exclude<RigPartRole, "unknown">): RigPart[] {
  return rig.parts.filter((part) => (part.kind === "image" || part.kind === "group") && part.role === role);
}

function coverageEntry(rig: RigDocument, requirement: RoleCoverageRequirement): RoleCoverageEntry {
  const parts = roleParts(rig, requirement.role);
  const confirmed = parts.filter((part) => part.roleStatus === "confirmed");
  const suggested = parts.filter((part) => part.roleStatus !== "confirmed");
  const artMeshParts = parts.filter((part) => Boolean(part.artMesh?.enabled && part.artMesh.vertices.length >= 3));
  const status: CoverageStatus = confirmed.length >= requirement.minParts
    ? "covered"
    : parts.length > 0
      ? "suggested-only"
      : "missing";
  return {
    ...requirement,
    status,
    partIds: parts.map((part) => part.id),
    confirmedPartIds: confirmed.map((part) => part.id),
    suggestedPartIds: suggested.map((part) => part.id),
    artMeshPartIds: artMeshParts.map((part) => part.id),
    vertexCount: artMeshParts.reduce((total, part) => total + (part.artMesh?.vertices.length ?? 0), 0),
    bindingCount: parts.reduce((total, part) => total + (part.bindings?.length ?? 0) + (part.multiBindings?.length ?? 0), 0)
  };
}

function levelResult(rig: RigDocument, level: ReadinessLevel): ReadinessLevelResult {
  const requiredRoles = READINESS_ROLE_MATRIX[level].map((requirement) => coverageEntry(rig, requirement));
  const coveredRoleCount = requiredRoles.filter((entry) => entry.status === "covered").length;
  return {
    level,
    label: LEVEL_LABELS[level],
    requiredRoles,
    coveredRoleCount,
    requiredRoleCount: requiredRoles.length,
    coverageRatio: round(coveredRoleCount / Math.max(1, requiredRoles.length), 4),
    missingRoles: requiredRoles.filter((entry) => entry.status === "missing").map((entry) => entry.role),
    suggestedOnlyRoles: requiredRoles.filter((entry) => entry.status === "suggested-only").map((entry) => entry.role),
    ready: requiredRoles.every((entry) => entry.status === "covered")
  };
}

function buildRepairHints(rig: RigDocument, missingRoles: string[]): ReadinessRepairHint[] {
  const unconfirmed = rig.parts.filter((part) => part.kind === "image" && part.roleStatus !== "confirmed");
  return missingRoles.map((role) => {
    const typedRole = role as Exclude<RigPartRole, "unknown">;
    const candidates = unconfirmed
      .map((part) => ({ part, suggestion: inferPartRole(part) }))
      .filter((entry) => entry.suggestion?.role === typedRole)
      .sort((left, right) => (right.suggestion?.confidence ?? 0) - (left.suggestion?.confidence ?? 0));
    return {
      role: typedRole,
      label: READINESS_ROLE_MATRIX.L3.find((entry) => entry.role === typedRole)?.label ?? typedRole,
      action: candidates.length ? "confirm-role" : "review-split",
      candidatePartIds: candidates.map((entry) => entry.part.id),
      candidateNames: candidates.map((entry) => entry.part.name),
      reasons: candidates.map((entry) => entry.suggestion?.reason ?? "unresolved")
    };
  });
}

function roleMeasurements(rig: RigDocument): ReadinessMeasurement[] {
  const byRole = (role: Exclude<RigPartRole, "unknown">) => unionBounds(roleParts(rig, role));
  const eyeLeft = byRole("eye-left");
  const eyeRight = byRole("eye-right");
  const face = byRole("face");
  const neck = byRole("neck");
  const clothing = byRole("clothing");
  const hairFront = byRole("hair-front");
  const center = (bounds: LocalBounds) => ({ x: round((bounds.left + bounds.right) / 2), y: round((bounds.top + bounds.bottom) / 2) });
  const optionalPoint = (id: ReadinessMeasurement["id"], label: string, entry: { bounds?: LocalBounds; ids: string[] }, value: { x: number; y: number } | undefined, note: string): ReadinessMeasurement => ({ id, label, status: value ? "proxy" : "missing", coordinateSpace: "part-local-aggregate", value, sourcePartIds: entry.ids, confidence: value ? 0.55 : 0, note });
  const optionalNumber = (id: ReadinessMeasurement["id"], label: string, entry: { bounds?: LocalBounds; ids: string[] }, value: number | undefined, note: string): ReadinessMeasurement => ({ id, label, status: value !== undefined ? "proxy" : "missing", coordinateSpace: "part-local-aggregate", value: value === undefined ? undefined : round(value), sourcePartIds: entry.ids, confidence: value !== undefined ? 0.55 : 0, note });
  return [
    optionalPoint("eye-center-left", "Left eye center", eyeLeft, eyeLeft.bounds ? center(eyeLeft.bounds) : undefined, "Mesh bounds proxy; neutral render calibration is still required."),
    optionalPoint("eye-center-right", "Right eye center", eyeRight, eyeRight.bounds ? center(eyeRight.bounds) : undefined, "Mesh bounds proxy; neutral render calibration is still required."),
    optionalPoint("jaw-tip", "Jaw tip", face, face.bounds ? { x: round((face.bounds.left + face.bounds.right) / 2), y: round(face.bounds.bottom) } : undefined, "Face mesh bottom proxy; silhouette landmark confirmation is still required."),
    optionalNumber("neck-width", "Neck width", neck, neck.bounds ? neck.bounds.right - neck.bounds.left : undefined, "Union width in part-local mesh space; composed stage width is not inferred."),
    optionalNumber("shoulder-span", "Shoulder span", clothing, clothing.bounds ? clothing.bounds.right - clothing.bounds.left : undefined, "Clothing-role union width proxy; shoulder landmark confirmation is still required."),
    optionalNumber("hairline", "Hairline top", hairFront, hairFront.bounds ? hairFront.bounds.top : undefined, "Front-hair mesh top proxy; neutral render calibration is still required.")
  ];
}

function recipeForRig(rig: RigDocument): RigReadinessReport["recipe"] {
  const stageWidth = Math.max(1, rig.stage.width);
  const stageHeight = Math.max(1, rig.stage.height);
  const roles = (Object.keys(ROLE_LABELS) as Array<Exclude<RigPartRole, "unknown">>).map((role) => {
    const parts = roleParts(rig, role);
    const bounds = parts.map((part) => boundsForPart(part)).filter((value): value is LocalBounds => Boolean(value));
    const deformerIds = [...new Set(parts.map((part) => part.deformerId).filter((value): value is string => Boolean(value)))].sort();
    const widths = bounds.map((value) => value.right - value.left);
    const heights = bounds.map((value) => value.bottom - value.top);
    const meshes = parts.filter((part) => part.artMesh?.vertices.length);
    return {
      role,
      partCount: parts.length,
      artMeshPartCount: meshes.length,
      averageWidthRatio: widths.length ? round(widths.reduce((sum, value) => sum + value, 0) / widths.length / stageWidth, 6) : undefined,
      averageHeightRatio: heights.length ? round(heights.reduce((sum, value) => sum + value, 0) / heights.length / stageHeight, 6) : undefined,
      averageVertexCount: meshes.length ? round(meshes.reduce((sum, part) => sum + (part.artMesh?.vertices.length ?? 0), 0) / meshes.length, 2) : undefined,
      deformerIds,
      bindingCount: parts.reduce((sum, part) => sum + (part.bindings?.length ?? 0) + (part.multiBindings?.length ?? 0), 0)
    };
  });
  return {
    format: "standrig-rig-recipe",
    version: 1,
    coordinateSpace: "stage-ratio",
    roles,
    notes: [
      "This is a read-only extraction of the current rig; it does not generate or apply modeling operations.",
      "Ratios are derived from neutral ArtMesh bounds and are recipe seeds, not final keyform amplitudes.",
      "Promote a recipe only after a rights-cleared PSD reaches L2 with numeric QA and explicit review."
    ]
  };
}

const ROLE_LABELS: Record<Exclude<RigPartRole, "unknown">, string> = {
  face: "Face", "eye-left": "Left eye", "eye-right": "Right eye", "brow-left": "Left brow", "brow-right": "Right brow", "face-feature": "Face feature", mouth: "Mouth", "hair-front": "Front hair", "hair-back": "Back hair", "hair-side": "Side hair", "hair-tail-left": "Left hair tail", "hair-tail-right": "Right hair tail", neck: "Neck", torso: "Torso", "soft-tissue": "Soft tissue", clothing: "Clothing", accessory: "Accessory"
};

export function evaluateRigReadiness(rig: RigDocument, options: { level?: ReadinessLevel } = {}): RigReadinessReport {
  const levels = {
    L1: levelResult(rig, "L1"),
    L2: levelResult(rig, "L2"),
    L3: levelResult(rig, "L3")
  } satisfies Record<ReadinessLevel, ReadinessLevelResult>;
  const recommendedLevel: ReadinessLevel | "none" = levels.L3.ready ? "L3" : levels.L2.ready ? "L2" : levels.L1.ready ? "L1" : "none";
  const requestedLevel = options.level ?? "L2";
  const requestedResult = levels[requestedLevel];
  const missingRoles = [...new Set(requestedResult.missingRoles)];
  const suggestedOnlyRoles = [...new Set(requestedResult.suggestedOnlyRoles)];
  const repairHints = buildRepairHints(rig, [...missingRoles, ...suggestedOnlyRoles]);
  const measurementItems = roleMeasurements(rig);
  const measurementsReady = measurementItems.every((item) => item.status === "proxy");
  const blockers = [
    ...missingRoles.map((role) => `missing-role:${role}`),
    ...suggestedOnlyRoles.map((role) => `role-confirmation-required:${role}`)
  ];
  const warnings = [
    ...(measurementItems.some((item) => item.status === "missing") ? ["some-art-measurements-missing"] : []),
    "art-measurements-are-proxy-only-until-neutral-render-calibration",
    ...(rig.parts.some((part) => part.kind === "image" && part.roleStatus !== "confirmed") ? ["unconfirmed-image-part-roles-present"] : [])
  ];
  return {
    format: "standrig-readiness-report",
    version: 1,
    source: {
      name: rig.name,
      schemaVersion: rig.schemaVersion,
      stage: { width: rig.stage.width, height: rig.stage.height },
      partCount: rig.parts.length,
      imagePartCount: rig.parts.filter((part) => part.kind === "image").length,
      confirmedRoleCount: rig.parts.filter((part) => (part.kind === "image" || part.kind === "group") && part.role && part.role !== "unknown" && part.roleStatus === "confirmed").length,
      suggestedRoleCount: rig.parts.filter((part) => (part.kind === "image" || part.kind === "group") && part.role && part.role !== "unknown" && part.roleStatus !== "confirmed").length
    },
    levels,
    recommendedLevel,
    requestedLevel,
    requestedLevelReady: requestedResult.ready,
    missingRoles,
    suggestedOnlyRoles,
    repairHints,
    measurements: {
      status: measurementsReady ? "proxy-only" : "missing",
      items: measurementItems,
      nextAction: "Calibrate proxy landmarks against a neutral render before recipe promotion."
    },
    recipe: recipeForRig(rig),
    blockers,
    warnings,
    nextAction: requestedResult.ready
      ? "Collect a rights-cleared second PSD and run this report before any Q7 recipe promotion."
      : `Resolve role coverage for ${requestedLevel}: ${[...missingRoles, ...suggestedOnlyRoles].join(", ") || "none"}.`,
  };
}
