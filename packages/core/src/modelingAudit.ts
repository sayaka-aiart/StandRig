import { summarizeRig, validateRig } from "./inspect.js";
import { analyzeParameterDistribution, type ParameterDistributionAudit } from "./parameterDistribution.js";
import { PARAMETER_IDS, type ParameterBinding, type RigDeformer, type RigDocument, type RigPart, type RigWarpPin } from "./types.js";
import { auditPhysicsRootSafety, suggestPhysicsPresets } from "./physicsPresets.js";
import { runPhysicsTemporalQa } from "./physicsQa.js";

export type ModelingAuditSeverity = "error" | "warning" | "info" | "ok";
export type ModelingAuditCategory = "validation" | "coverage" | "deformer" | "physics" | "expression" | "tracking" | "import" | "workflow";

export interface ModelingAuditMetric {
  id: string;
  label: string;
  value: number | string;
  status: ModelingAuditSeverity;
  detail?: string;
}

export interface ModelingAuditIssue {
  id: string;
  severity: Exclude<ModelingAuditSeverity, "ok">;
  category: ModelingAuditCategory;
  title: string;
  detail: string;
  recommendation: string;
  partIds?: string[];
  deformerIds?: string[];
  parameterIds?: string[];
}

export interface ModelingAuditScreenshot {
  id: string;
  label: string;
  url: string;
}

export interface ModelingAuditResult {
  generatedAt: string;
  ok: boolean;
  score: number;
  summary: {
    name: string;
    stage: { width: number; height: number };
    counts: ReturnType<typeof summarizeRig>["counts"];
  };
  metrics: ModelingAuditMetric[];
  coverage: {
    imageParts: number;
    visibleImageParts: number;
    effectivelyDeformedVisibleImageParts: number;
    unassignedVisibleImageParts: Array<{ id: string; name: string; path: string }>;
    warpDeformers: number;
    warpPins: number;
    warpPinBindings: number;
    physicsCandidates: number;
    overloadedDeformers: number;
  };
  parameterDistribution: ParameterDistributionAudit;
  issues: ModelingAuditIssue[];
  nextActions: string[];
  screenshots: ModelingAuditScreenshot[];
}

const CONNECTION_DEFORMERS = [
  {
    id: "neck-bridge-deformer",
    label: "Neck bridge",
    keywords: ["neck", "首"],
    minPins: 3,
    recommendation: "首上部と首根元に左右/中央のピンキーを追加し、顔角度と体角度を分けて接続部を追従させる。"
  },
  {
    id: "outline-pin-deformer",
    label: "Outline pins",
    keywords: ["outline", "jaw", "輪郭", "顎"],
    minPins: 3,
    recommendation: "左右の顎/頬ピンをミラーリンクし、ParamAngleX の左右キーを比較しながら輪郭の3D感を調整する。"
  },
  {
    id: "shoulder-bridge-deformer",
    label: "Shoulder bridge",
    keywords: ["shoulder", "肩", "collar", "襟"],
    minPins: 4,
    recommendation: "首下、襟、左右肩の固定ピンを分け、体角度では肩側、顔角度では首側だけが追従するキーを作る。"
  }
] as const;

const PHYSICS_KEYWORDS = ["hair", "髪", "twintail", "ツイン", "ribbon", "リボン", "sleeve", "袖", "skirt", "スカート", "cloth", "服", "frill", "フリル", "胸", "ベルト"];
const MOUTH_KEYWORDS = ["mouth", "口", "唇", "舌", "歯", "あ", "い", "う", "え", "お", "U", "笑顔"];
const EYE_KEYWORDS = ["eye", "目", "まぶた", "瞳", "まつげ"];

export function auditModelingRig(rig: RigDocument): ModelingAuditResult {
  const summary = summarizeRig(rig);
  const validation = validateRig(rig);
  const parts = Array.isArray(rig.parts) ? rig.parts : [];
  const imageParts = parts.filter((part) => part.kind === "image");
  const effectiveVisiblePartIds = buildEffectiveVisiblePartIds(parts);
  const visibleImageParts = imageParts.filter((part) => effectiveVisiblePartIds.has(part.id));
  const deformers = Array.isArray(rig.deformers) ? rig.deformers : [];
  const physicsChains = Array.isArray(rig.physics?.chains) ? rig.physics.chains : [];
  const partPaths = buildPartPaths(parts);
  const issues: ModelingAuditIssue[] = [];
  const addIssue = (issue: ModelingAuditIssue) => issues.push(issue);
  const parameterDistribution = analyzeParameterDistribution(rig);

  if (!validation.ok) {
    addIssue({
      id: "rig-validation-errors",
      severity: "error",
      category: "validation",
      title: "Rig validation has errors",
      detail: `${validation.errorCount} validation errors must be fixed before modeling decisions are reliable.`,
      recommendation: "Open /api/rig/validate and fix the listed schema/reference errors first."
    });
  } else if (validation.warningCount > 0) {
    addIssue({
      id: "rig-validation-warnings",
      severity: "info",
      category: "validation",
      title: "Rig validation has warnings",
      detail: `${validation.warningCount} validation warnings were found.`,
      recommendation: "Review /api/rig/validate before major modeling edits."
    });
  }

  const importReport = rig.metadata?.importReport;
  if (importReport && importReport.totals.warnings > 0) {
    addIssue({
      id: "import-report-warnings",
      severity: "info",
      category: "import",
      title: "PSD import warnings remain",
      detail: `${importReport.totals.warnings} import warnings are recorded. Top warning: ${importReport.warnings[0] ?? "none"}.`,
      recommendation: "Keep these visible in Import Diagnostics while modeling, especially hidden layers and unsupported blend modes."
    });
  }

  const coverage = buildDeformerCoverage(parts, deformers, partPaths);
  const unassignedVisibleImageParts = visibleImageParts
    .filter((part) => !coverage.effectiveDeformerIdsByPartId.get(part.id)?.size)
    .map((part) => ({ id: part.id, name: part.name, path: partPaths.get(part.id) ?? part.name }));
  if (visibleImageParts.length > 0 && unassignedVisibleImageParts.length / visibleImageParts.length > 0.25) {
    addIssue({
      id: "many-visible-parts-without-effective-deformer",
      severity: "info",
      category: "coverage",
      title: "Many visible image parts do not inherit a deformer",
      detail: `${unassignedVisibleImageParts.length} of ${visibleImageParts.length} visible image parts have no direct or inherited deformer assignment.`,
      recommendation: "For parts that should move with head/body, assign their parent group or branch to an existing deformer before fine modeling.",
      partIds: unassignedVisibleImageParts.slice(0, 12).map((part) => part.id)
    });
  }

  if (!deformers.length) {
    addIssue({
      id: "no-deformers",
      severity: "warning",
      category: "deformer",
      title: "No deformers exist",
      detail: "Modeling is limited to per-part transform keys.",
      recommendation: "Create head/body/face connection deformers before tuning detailed poses."
    });
  }

  auditConnectionDeformers(deformers, addIssue);
  auditMirroredWarpPins(deformers, addIssue);
  auditHairWarpPins(deformers, addIssue);
  auditParameterDistribution(parameterDistribution, addIssue);

  const physicsCandidates = visibleImageParts.filter((part) => textMatchesAny(partPaths.get(part.id) ?? part.name, PHYSICS_KEYWORDS));
  if (!physicsChains.length && physicsCandidates.length > 0) {
    addIssue({
      id: "no-physics-chains",
      severity: "warning",
      category: "physics",
      title: "No physics chains are configured",
      detail: `${physicsCandidates.length} visible hair/cloth-like parts were found, but physics.chains is empty.`,
      recommendation: "Generate conservative physics chains for hair, ribbons, sleeves, skirt/frills, and chest accessories.",
      partIds: physicsCandidates.slice(0, 14).map((part) => part.id)
    });
  }
  const rootSafetyIssues = auditPhysicsRootSafety(rig);
  for (const issue of rootSafetyIssues) {
    addIssue({ id: `physics-root-${issue.chainId}-${issue.partId}`, severity: "warning", category: "physics", title: "Physics targets a structural root", detail: issue.message, recommendation: "Keep neck, face, and torso fixed; use a parameter output connected only to a tail or cloth mesh.", partIds: [issue.partId] });
  }
  const knownParameters = new Set([...PARAMETER_IDS, ...(rig.parameters ?? []).map((parameter) => parameter.id)]);
  for (const chain of physicsChains) {
    if (chain.parameterOutput && !knownParameters.has(chain.parameterOutput.parameter)) {
      addIssue({ id: `physics-output-parameter-${chain.id}`, severity: "warning", category: "physics", title: "Physics output parameter is unavailable", detail: `${chain.id} outputs to ${chain.parameterOutput.parameter}, which is not defined or reserved.`, recommendation: "Choose a reserved hair/cloth parameter or add a model parameter before assigning this chain.", parameterIds: [chain.parameterOutput.parameter] });
    }
    if (chain.segments?.length && chain.segments.length > 8) {
      addIssue({ id: `physics-segment-limit-${chain.id}`, severity: "warning", category: "physics", title: "Physics chain has too many stages", detail: `${chain.id} has ${chain.segments.length} stages; runtime evaluates at most eight.`, recommendation: "Reduce the chain to eight stages or fewer." });
    }
  }
  const physicsOutputParameters = new Set(physicsChains.flatMap((chain) => chain.parameterOutput ? [chain.parameterOutput.parameter] : []));
  for (const parameter of physicsOutputParameters) {
    if (countBindingsForParameter(parts, deformers, parameter) === 0) {
      addIssue({ id: `physics-output-unbound-${parameter}`, severity: "info", category: "physics", title: "Physics output has no model binding", detail: `${parameter} receives physics output but has no part, deformer, ArtMesh, or warp-pin binding.`, recommendation: `During model freeze, add ${parameter} keys only to tail/cloth meshes; do not bind it to structural roots.`, parameterIds: [parameter] });
    }
  }
  const temporalPhysicsQa = runPhysicsTemporalQa(rig);
  for (const detail of temporalPhysicsQa.issues) {
    addIssue({ id: `physics-temporal-${issues.length}`, severity: "warning", category: "physics", title: "Physics temporal QA warning", detail, recommendation: "Review the chain input, output parameter, and structural target assignments before applying physics to the model." });
  }
  const safePresetCandidates = suggestPhysicsPresets(rig);
  if (physicsCandidates.length > 0 && !safePresetCandidates.length) {
    addIssue({ id: "physics-role-candidates-missing", severity: "info", category: "physics", title: "No confirmed roles for safe physics presets", detail: `${physicsCandidates.length} hair/cloth-like parts exist, but no confirmed eligible hair role is available.`, recommendation: "Confirm hair-front, hair-side, hair-back, or hair-tail roles before generating a physics preset." });
  }
  if (!rig.physics?.enabled && physicsChains.length > 0) {
    addIssue({
      id: "physics-disabled",
      severity: "info",
      category: "physics",
      title: "Physics is configured but disabled",
      detail: `${physicsChains.length} chains exist while physics.enabled is false.`,
      recommendation: "Enable physics while checking OBS-style idle and tracking motion."
    });
  }

  auditExpressionCoverage(rig, parts, deformers, partPaths, effectiveVisiblePartIds, addIssue);
  auditTracking(rig, addIssue);

  const warpDeformers = deformers.filter((deformer) => deformer.kind === "warp");
  const warpPins = warpDeformers.flatMap((deformer) => deformer.warp?.pins ?? []);
  const warpPinBindings = warpPins.reduce((total, pin) => total + (pin.bindings?.length ?? 0), 0);
  const effectivelyDeformedVisibleImageParts = visibleImageParts.length - unassignedVisibleImageParts.length;
  const metrics: ModelingAuditMetric[] = [
    {
      id: "validation",
      label: "Validation",
      value: validation.ok ? `${validation.issueCount} issues` : `${validation.errorCount} errors`,
      status: validation.ok ? (validation.issueCount ? "info" : "ok") : "error"
    },
    {
      id: "deformer-coverage",
      label: "Deformer coverage",
      value: `${effectivelyDeformedVisibleImageParts}/${visibleImageParts.length}`,
      status: visibleImageParts.length && unassignedVisibleImageParts.length / visibleImageParts.length > 0.25 ? "info" : "ok"
    },
    {
      id: "warp-pins",
      label: "Warp pins",
      value: warpPins.length,
      status: warpPins.length ? "ok" : "warning"
    },
    {
      id: "parameter-distribution",
      label: "Param spread",
      value: `${parameterDistribution.overloadedCount}/${parameterDistribution.targetCount}`,
      status: parameterDistribution.overloadedCount ? "info" : "ok",
      detail: parameterDistribution.overloadedTargets[0]?.splitSuggestions[0]
    },
    {
      id: "physics",
      label: "Physics chains",
      value: physicsChains.length,
      status: physicsChains.length ? "ok" : "warning"
    },
    {
      id: "tracking",
      label: "Tracking",
      value: rig.tracking?.enabled ? "enabled" : "disabled",
      status: rig.tracking?.enabled ? "ok" : "info"
    }
  ];

  const sortedIssues = [...issues].sort((left, right) => severityWeight(right.severity) - severityWeight(left.severity));
  return {
    generatedAt: new Date().toISOString(),
    ok: !issues.some((issue) => issue.severity === "error" || issue.severity === "warning"),
    score: scoreIssues(issues),
    summary: {
      name: summary.name,
      stage: { width: summary.stage.width, height: summary.stage.height },
      counts: summary.counts
    },
    metrics,
    coverage: {
      imageParts: imageParts.length,
      visibleImageParts: visibleImageParts.length,
      effectivelyDeformedVisibleImageParts,
      unassignedVisibleImageParts: unassignedVisibleImageParts.slice(0, 24),
      warpDeformers: warpDeformers.length,
      warpPins: warpPins.length,
      warpPinBindings,
      physicsCandidates: physicsCandidates.length,
      overloadedDeformers: parameterDistribution.overloadedCount
    },
    parameterDistribution,
    issues: sortedIssues,
    nextActions: sortedIssues.slice(0, 5).map((issue) => issue.recommendation),
    screenshots: [
      { id: "modeling", label: "Modeling sheet", url: "/api/screenshot?set=modeling&width=260&height=360" },
      { id: "angles", label: "Angle sheet", url: "/api/screenshot?set=angles&width=260&height=360" },
      { id: "expressions", label: "Expression sheet", url: "/api/screenshot?set=expressions&width=260&height=360" }
    ]
  };
}

function auditParameterDistribution(distribution: ParameterDistributionAudit, addIssue: (issue: ModelingAuditIssue) => void) {
  for (const target of distribution.overloadedTargets.slice(0, 8)) {
    addIssue({
      id: `parameter-distribution-${target.id}`,
      severity: "info",
      category: "deformer",
      title: "Deformer mixes many parameter roles",
      detail: `${target.name} uses ${target.uniqueParameterCount} unique parameters across ${target.totalBindingCount} bindings, ${target.pinCount} pins, and ${target.branchPartCount} branch parts. ${target.reasons.join("; ") || "Review if pose QA regresses."}`,
      recommendation: target.splitSuggestions[0] ?? "Split broad motion into parent/child deformers before adding stronger keys.",
      deformerIds: [target.id],
      parameterIds: target.parameterIds
    });
  }
}
function auditConnectionDeformers(deformers: RigDeformer[], addIssue: (issue: ModelingAuditIssue) => void) {
  for (const config of CONNECTION_DEFORMERS) {
    const deformer = findDeformer(deformers, config.id, config.keywords);
    if (!deformer) {
      addIssue({
        id: `missing-${config.id}`,
        severity: "warning",
        category: "deformer",
        title: `${config.label} is missing`,
        detail: `Expected a connection deformer like ${config.id}.`,
        recommendation: config.recommendation
      });
      continue;
    }
    if (deformer.kind !== "warp") {
      addIssue({
        id: `${deformer.id}-not-warp`,
        severity: "warning",
        category: "deformer",
        title: `${config.label} is not a warp deformer`,
        detail: `${deformer.name} is ${deformer.kind}, so it cannot use local pins for connection cleanup.`,
        recommendation: config.recommendation,
        deformerIds: [deformer.id]
      });
      continue;
    }

    const pins = deformer.warp?.pins ?? [];
    if (pins.length < config.minPins) {
      addIssue({
        id: `${deformer.id}-few-pins`,
        severity: "warning",
        category: "deformer",
        title: `${config.label} needs more local pins`,
        detail: `${deformer.name} has ${pins.length} pins; ${config.minPins}+ pins are recommended for this joint.`,
        recommendation: config.recommendation,
        deformerIds: [deformer.id]
      });
    }

    const pinBindingCount = pins.reduce((total, pin) => total + (pin.bindings?.length ?? 0), 0);
    if (!pinBindingCount) {
      addIssue({
        id: `${deformer.id}-no-pin-bindings`,
        severity: "info",
        category: "deformer",
        title: `${config.label} pins have no parameter keys`,
        detail: `${deformer.name} has pins, but no pin bindings.`,
        recommendation: "Add ParamAngleX/Y and body angle pin offset keys so the seam follows the pose instead of staying static.",
        deformerIds: [deformer.id]
      });
    }
  }
}

function auditMirroredWarpPins(deformers: RigDeformer[], addIssue: (issue: ModelingAuditIssue) => void) {
  for (const deformer of deformers.filter((entry) => entry.kind === "warp")) {
    const pins = deformer.warp?.pins ?? [];
    const checked = new Set<string>();
    for (const leftPin of pins) {
      if (checked.has(leftPin.id) || !isLeftSideText(leftPin.id + " " + leftPin.name)) {
        continue;
      }
      const rightPin = pins.find((pin) => !checked.has(pin.id) && pin.id !== leftPin.id && isLikelyMirrorPin(leftPin, pin));
      if (!rightPin) {
        continue;
      }
      checked.add(leftPin.id);
      checked.add(rightPin.id);
      const mismatches = mirroredBindingMismatches(leftPin, rightPin);
      if (mismatches.length) {
        // Two different faults land here: a genuinely unmirrored pair, and a mirrored pair whose
        // magnitudes drifted apart during seam tuning. Reporting both as "same direction" hid the
        // second case, so name the condition and quote the values instead.
        const sameDirection = mismatches.filter((entry) => entry.sameDirection);
        const asymmetric = mismatches.filter((entry) => !entry.sameDirection);
        const describe = (entry: MirroredBindingMismatch) => `${entry.label} (${entry.leftValue} / ${entry.rightValue})`;
        const details = [
          sameDirection.length ? `drive offsetX in the same direction for ${sameDirection.map(describe).join(", ")}` : "",
          asymmetric.length ? `are opposite but unequal beyond the mirror tolerance for ${asymmetric.map(describe).join(", ")}` : ""
        ].filter(Boolean);
        addIssue({
          id: `${deformer.id}-${leftPin.id}-${rightPin.id}-mirror-bindings`,
          severity: "warning",
          category: "deformer",
          title: sameDirection.length ? "Mirrored pin pair has non-mirrored X keys" : "Mirrored pin pair has asymmetric X key magnitudes",
          detail: `${deformer.name}: ${leftPin.name} and ${rightPin.name} ${details.join("; ")}.`,
          recommendation: sameDirection.length
            ? "Use the Mirror X workflow or link the pair so offsetX keys become opposite signs while offsetY stays shared."
            : "Confirm the magnitude split is an intentional seam correction; otherwise even the pair up with the Mirror X workflow.",
          deformerIds: [deformer.id]
        });
      }
    }
  }
}

function auditHairWarpPins(deformers: RigDeformer[], addIssue: (issue: ModelingAuditIssue) => void) {
  const hairWarpWithoutPins = deformers.filter(
    (deformer) => deformer.kind === "warp" && textMatchesAny(`${deformer.id} ${deformer.name} ${(deformer.tags ?? []).join(" ")}`, ["hair", "髪", "ribbon", "リボン"]) && !(deformer.warp?.pins?.length)
  );
  if (hairWarpWithoutPins.length) {
    addIssue({
      id: "hair-warp-without-pins",
      severity: "info",
      category: "deformer",
      title: "Hair/accessory warp deformers have no local pins",
      detail: `${hairWarpWithoutPins.length} hair-like warp deformers currently rely on broad bend/taper only.`,
      recommendation: "Add root anchor and tip soft pins to hair/ribbon deformers before increasing motion strength.",
      deformerIds: hairWarpWithoutPins.slice(0, 8).map((deformer) => deformer.id)
    });
  }
}

function auditExpressionCoverage(
  rig: RigDocument,
  parts: RigPart[],
  deformers: RigDeformer[],
  partPaths: Map<string, string>,
  effectiveVisiblePartIds: Set<string>,
  addIssue: (issue: ModelingAuditIssue) => void
) {
  const imageParts = parts.filter((part) => part.kind === "image");
  const mouthParts = imageParts.filter((part) => textMatchesAny(partPaths.get(part.id) ?? part.name, MOUTH_KEYWORDS));
  const mouthReferenceParts = mouthParts.filter((part) => (partPaths.get(part.id) ?? part.name).includes("口参考"));
  const mouthBindingCount = countBindingsForParameter(parts, deformers, "ParamMouthOpen");
  if (mouthParts.length >= 5 && mouthBindingCount <= 2) {
    addIssue({
      id: "mouth-expression-mostly-single-deformer",
      severity: "info",
      category: "expression",
      title: "Mouth expression layers are not yet individually keyed",
      detail: `${mouthParts.length} mouth-like image parts were found, while ParamMouthOpen has ${mouthBindingCount} binding groups.`,
      recommendation: "Add visibility/opacity keys for mouth shape layers before phoneme or expression tracking work.",
      partIds: mouthParts.slice(0, 12).map((part) => part.id),
      parameterIds: ["ParamMouthOpen"]
    });
  }
  const visibleMouthReferenceParts = mouthReferenceParts.filter((part) => effectiveVisiblePartIds.has(part.id));
  if (visibleMouthReferenceParts.length) {
    addIssue({
      id: "visible-mouth-reference-layers",
      severity: "info",
      category: "expression",
      title: "Mouth reference layers are present",
      detail: `${visibleMouthReferenceParts.length} effectively visible parts are under a mouth reference layer set.`,
      recommendation: "Either bind these as real mouth shapes or hide/tag them as references so they do not confuse modeling audits.",
      partIds: visibleMouthReferenceParts.slice(0, 12).map((part) => part.id)
    });
  }

  const eyeParts = imageParts.filter((part) => textMatchesAny(partPaths.get(part.id) ?? part.name, EYE_KEYWORDS));
  for (const parameterId of ["ParamEyeLOpen", "ParamEyeROpen"]) {
    const bindingCount = countBindingsForParameter(parts, deformers, parameterId);
    const warpPinBindingCount = countWarpPinBindingsForParameter(deformers, parameterId);
    if (eyeParts.length && bindingCount > 0 && !warpPinBindingCount) {
      addIssue({
        id: `${parameterId}-no-warp-pin-keys`,
        severity: "info",
        category: "expression",
        title: `${parameterId} has no eyelid pin keys`,
        detail: "Blink/wink currently appears to be driven by transform bindings rather than curved eyelid deformation.",
        recommendation: "Add eyelid warp pins or mesh pins so blinks close along the eyelid curve instead of only scaling.",
        parameterIds: [parameterId]
      });
    } else if (eyeParts.length && !bindingCount) {
      addIssue({
        id: `${parameterId}-missing-bindings`,
        severity: "warning",
        category: "expression",
        title: `${parameterId} has no bindings`,
        detail: "Eye-open tracking will not affect visible eye parts.",
        recommendation: "Bind eyelid/eyelash groups to the eye-open parameter before camera tracking tuning.",
        parameterIds: [parameterId]
      });
    }
  }
  for (const parameterId of PARAMETER_IDS) {
    if (!rig.parameters.some((parameter) => parameter.id === parameterId)) {
      addIssue({
        id: `${parameterId}-missing-standard-param`,
        severity: "warning",
        category: "expression",
        title: `${parameterId} is missing`,
        detail: "The standard preview/tracking parameter set is incomplete.",
        recommendation: "Restore the standard parameter before generating comparison sheets.",
        parameterIds: [parameterId]
      });
    }
  }
}

function auditTracking(rig: RigDocument, addIssue: (issue: ModelingAuditIssue) => void) {
  if (!rig.tracking) {
    addIssue({
      id: "tracking-section-missing",
      severity: "info",
      category: "tracking",
      title: "Tracking section is missing",
      detail: "Camera input cannot be audited until tracking mappings exist.",
      recommendation: "Create tracking mappings after the model deformation pass is stable."
    });
    return;
  }
  if (!rig.tracking.enabled) {
    addIssue({
      id: "tracking-disabled",
      severity: "info",
      category: "tracking",
      title: "Tracking is disabled",
      detail: "Manual pose testing works, but live camera stability is not active by default.",
      recommendation: "After connection and expression modeling, add calibration/dead-zone gates and enable tracking for camera tests."
    });
  }
  const mappedParameters = new Set(rig.tracking.mappings.filter((mapping) => mapping.enabled).map((mapping) => mapping.parameter));
  const missingMappings = PARAMETER_IDS.filter((parameterId) => !mappedParameters.has(parameterId));
  if (missingMappings.length) {
    addIssue({
      id: "tracking-mapping-gaps",
      severity: "info",
      category: "tracking",
      title: "Tracking mappings do not cover all standard parameters",
      detail: `Missing enabled mappings: ${missingMappings.join(", ")}.`,
      recommendation: "Keep manual params usable, then add/enable mappings with clamp, smoothing, and confidence gates.",
      parameterIds: missingMappings
    });
  }
}

function buildDeformerCoverage(parts: RigPart[], deformers: RigDeformer[], partPaths: Map<string, string>) {
  const partById = new Map(parts.map((part) => [part.id, part]));
  const deformerIdsByTargetPartId = new Map<string, Set<string>>();
  for (const deformer of deformers) {
    for (const partId of deformer.targetPartIds ?? []) {
      const ids = deformerIdsByTargetPartId.get(partId) ?? new Set<string>();
      ids.add(deformer.id);
      deformerIdsByTargetPartId.set(partId, ids);
    }
  }

  const effectiveDeformerIdsByPartId = new Map<string, Set<string>>();
  for (const part of parts) {
    const ids = new Set<string>();
    let current: RigPart | undefined = part;
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      if (current.deformerId) {
        ids.add(current.deformerId);
      }
      for (const deformerId of deformerIdsByTargetPartId.get(current.id) ?? []) {
        ids.add(deformerId);
      }
      current = current.parentId ? partById.get(current.parentId) : undefined;
    }
    effectiveDeformerIdsByPartId.set(part.id, ids);
  }

  return { effectiveDeformerIdsByPartId, partPaths };
}

function buildEffectiveVisiblePartIds(parts: RigPart[]): Set<string> {
  const partById = new Map(parts.map((part) => [part.id, part]));
  const visibleById = new Map<string, boolean>();

  const isVisible = (part: RigPart): boolean => {
    const existing = visibleById.get(part.id);
    if (typeof existing === "boolean") {
      return existing;
    }
    const parent = part.parentId ? partById.get(part.parentId) : undefined;
    const visible = part.visible !== false && (!parent || isVisible(parent));
    visibleById.set(part.id, visible);
    return visible;
  };

  return new Set(parts.filter(isVisible).map((part) => part.id));
}
function buildPartPaths(parts: RigPart[]): Map<string, string> {
  const partById = new Map(parts.map((part) => [part.id, part]));
  const paths = new Map<string, string>();
  const pathForPart = (part: RigPart): string => {
    const existing = paths.get(part.id);
    if (existing) {
      return existing;
    }
    const seen = new Set<string>();
    const names: string[] = [];
    let current: RigPart | undefined = part;
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      names.push(current.name);
      current = current.parentId ? partById.get(current.parentId) : undefined;
    }
    const path = names.reverse().join("/");
    paths.set(part.id, path);
    return path;
  };
  for (const part of parts) {
    pathForPart(part);
  }
  return paths;
}

function findDeformer(deformers: RigDeformer[], id: string, keywords: readonly string[]): RigDeformer | undefined {
  return deformers.find((deformer) => deformer.id === id) ?? deformers.find((deformer) => textMatchesAny(`${deformer.id} ${deformer.name} ${(deformer.tags ?? []).join(" ")}`, keywords));
}

function countBindingsForParameter(parts: RigPart[], deformers: RigDeformer[], parameter: string): number {
  const partBindings = parts.filter((part) => (part.bindings ?? []).some((binding) => binding.parameter === parameter)).length;
  const deformerBindings = deformers.filter((deformer) => (deformer.bindings ?? []).some((binding) => binding.parameter === parameter)).length;
  const pinBindings = countWarpPinBindingsForParameter(deformers, parameter);
  return partBindings + deformerBindings + pinBindings;
}

function countWarpPinBindingsForParameter(deformers: RigDeformer[], parameter: string): number {
  return deformers.reduce(
    (total, deformer) =>
      total +
      (deformer.warp?.pins ?? []).reduce(
        (pinTotal, pin) => pinTotal + (pin.bindings ?? []).filter((binding) => binding.parameter === parameter).length,
        0
      ),
    0
  );
}

interface MirroredBindingMismatch {
  label: string;
  /** true when the pair pushes the same way, false when it is opposite but unequal in magnitude. */
  sameDirection: boolean;
  leftValue: number;
  rightValue: number;
}

function mirroredBindingMismatches(leftPin: RigWarpPin, rightPin: RigWarpPin): MirroredBindingMismatch[] {
  const mismatches: MirroredBindingMismatch[] = [];
  for (const leftBinding of leftPin.bindings ?? []) {
    if (leftBinding.property !== "offsetX") {
      continue;
    }
    const rightBinding = (rightPin.bindings ?? []).find((binding) => binding.parameter === leftBinding.parameter && binding.property === leftBinding.property);
    if (!rightBinding) {
      continue;
    }
    for (const leftKey of leftBinding.keys) {
      const rightKey = rightBinding.keys.find((key) => Math.abs(key.input - leftKey.input) < 0.001);
      if (!rightKey) {
        continue;
      }
      const maxAbs = Math.max(1, Math.abs(leftKey.value), Math.abs(rightKey.value));
      const shouldBeOpposite = Math.abs(leftKey.value + rightKey.value) <= Math.max(1.5, maxAbs * 0.25);
      const bothMove = Math.abs(leftKey.value) > 0.5 && Math.abs(rightKey.value) > 0.5;
      if (!shouldBeOpposite && bothMove) {
        mismatches.push({
          label: `${leftBinding.parameter}@${leftKey.input}`,
          sameDirection: Math.sign(leftKey.value) === Math.sign(rightKey.value),
          leftValue: leftKey.value,
          rightValue: rightKey.value
        });
      }
    }
  }
  return mismatches;
}

function isLikelyMirrorPin(leftPin: RigWarpPin, candidate: RigWarpPin): boolean {
  const text = candidate.id + " " + candidate.name;
  if (isRightSideText(text) && sideNeutralText(leftPin.id + " " + leftPin.name) === sideNeutralText(text)) {
    return true;
  }
  return isRightSideText(text) && Math.abs(leftPin.u + candidate.u - 1) < 0.12 && Math.abs(leftPin.v - candidate.v) < 0.14;
}

function sideNeutralText(value: string): string {
  return value
    .replace(/left|right|Left|Right|LEFT|RIGHT|左|右/g, "")
    .replace(/[-_\s]+/g, "")
    .toLowerCase();
}

function isLeftSideText(value: string): boolean {
  return /left|Left|LEFT|左/.test(value);
}

function isRightSideText(value: string): boolean {
  return /right|Right|RIGHT|右/.test(value);
}

function textMatchesAny(value: string, keywords: readonly string[]): boolean {
  const lower = value.toLowerCase();
  return keywords.some((keyword) => lower.includes(keyword.toLowerCase()));
}

function scoreIssues(issues: ModelingAuditIssue[]): number {
  const penalty = issues.reduce((total, issue) => total + severityWeight(issue.severity), 0);
  return Math.max(0, Math.min(100, 100 - penalty));
}

function severityWeight(severity: ModelingAuditIssue["severity"]): number {
  if (severity === "error") {
    return 30;
  }
  if (severity === "warning") {
    return 14;
  }
  return 4;
}


