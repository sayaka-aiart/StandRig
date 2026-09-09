import {
  PARAMETER_IDS,
  RIG_SCHEMA_VERSION,
  TRANSFORM_PROPERTIES,
  WARP_BINDING_PROPERTIES,
  WARP_PIN_BINDING_PROPERTIES,
  type BindingProperty,
  type ParameterBinding,
  type RigDeformer,
  type RigDocument,
  type RigGlue,
  type RigGlueCandidate,
  type RigPart,
  type Transform2D,
  type TransformProperty
} from "./types.js";
import { DEFAULT_TRACKING_INPUTS } from "./tracking.js";
import { isParameterInterpolation } from "./bindings.js";
import { inspectArtMeshQuality, isValidArtMesh } from "./artMesh.js";
import { validateArtPath } from "./artPath.js";
import { validatePartTint } from "./tint.js";
import { validateContourShade } from "./contourShade.js";
import { validateAlphaReveal } from "./alphaReveal.js";

export type ValidationSeverity = "error" | "warning" | "info";

export interface RigValidationIssue {
  severity: ValidationSeverity;
  code: string;
  message: string;
  path: string;
  partId?: string;
  assetId?: string;
  deformerId?: string;
  glueCandidateId?: string;
  glueId?: string;
}

export interface RigSummary {
  name: string;
  schemaVersion: string;
  stage: {
    width: number;
    height: number;
    background?: string;
  };
  counts: {
    assets: number;
    parts: number;
    imageParts: number;
    groups: number;
    visibleParts: number;
    hiddenParts: number;
    parameters: number;
    bindings: number;
    deformers: number;
    deformerBindings: number;
    glueCandidates: number;
    glue: number;
    physicsChains: number;
    trackingMappings: number;
    artMeshParts: number;
    artMeshVertices: number;
    artMeshTriangles: number;
  };
  importReport?: {
    kind: string;
    fileName: string;
    imageLayers: number;
    skippedLayers: number;
    warnings: number;
  };
  topWarnings: string[];
}

export interface RigValidationResult {
  ok: boolean;
  issueCount: number;
  errorCount: number;
  warningCount: number;
  infoCount: number;
  issues: RigValidationIssue[];
}

export interface RigInspectionResult {
  summary: RigSummary;
  validation: RigValidationResult;
}

const TRANSFORM_KEYS: Array<keyof Transform2D> = ["x", "y", "rotation", "scaleX", "scaleY", "pivotX", "pivotY", "opacity"];
const BINDING_PROPERTIES = new Set<BindingProperty>([...TRANSFORM_PROPERTIES, ...WARP_BINDING_PROPERTIES]);
const WARP_PIN_BINDING_PROPERTY_SET = new Set<string>(WARP_PIN_BINDING_PROPERTIES);

export function inspectRig(rig: RigDocument): RigInspectionResult {
  return {
    summary: summarizeRig(rig),
    validation: validateRig(rig)
  };
}

export function summarizeRig(rig: RigDocument): RigSummary {
  const parts = Array.isArray(rig.parts) ? rig.parts : [];
  const assets = Array.isArray(rig.assets) ? rig.assets : [];
  const parameters = Array.isArray(rig.parameters) ? rig.parameters : [];
  const deformers = Array.isArray(rig.deformers) ? rig.deformers : [];
  const glueCandidates = Array.isArray(rig.glueCandidates) ? rig.glueCandidates : [];
  const glues = Array.isArray(rig.glue) ? rig.glue : [];
  const physicsChains = Array.isArray(rig.physics?.chains) ? rig.physics.chains : [];
  const trackingMappings = Array.isArray(rig.tracking?.mappings) ? rig.tracking.mappings : [];
  const importReport = rig.metadata?.importReport;
  const partBindings = parts.reduce((total, part) => total + (Array.isArray(part.bindings) ? part.bindings.length : 0), 0);
  const deformerBindings = deformers.reduce((total, deformer) => total + (Array.isArray(deformer.bindings) ? deformer.bindings.length : 0), 0);
  const artMeshParts = parts.filter((part) => Boolean(part.artMesh?.enabled)).length;
  const artMeshVertices = parts.reduce((total, part) => total + (part.artMesh?.enabled ? part.artMesh.vertices.length : 0), 0);
  const artMeshTriangles = parts.reduce((total, part) => total + (part.artMesh?.enabled ? part.artMesh.triangles.length / 3 : 0), 0);

  return {
    name: typeof rig.name === "string" ? rig.name : "Untitled rig",
    schemaVersion: typeof rig.schemaVersion === "string" ? rig.schemaVersion : "unknown",
    stage: {
      width: numberOrZero(rig.stage?.width),
      height: numberOrZero(rig.stage?.height),
      background: rig.stage?.background
    },
    counts: {
      assets: assets.length,
      parts: parts.length,
      imageParts: parts.filter((part) => part.kind === "image").length,
      groups: parts.filter((part) => part.kind === "group").length,
      visibleParts: parts.filter((part) => part.visible).length,
      hiddenParts: parts.filter((part) => !part.visible).length,
      parameters: parameters.length,
      bindings: partBindings + deformerBindings,
      deformers: deformers.length,
      deformerBindings,
      glueCandidates: glueCandidates.length,
      glue: glues.length,
      physicsChains: physicsChains.length,
      trackingMappings: trackingMappings.length,
      artMeshParts,
      artMeshVertices,
      artMeshTriangles
    },
    importReport: importReport
      ? {
          kind: importReport.kind,
          fileName: importReport.fileName,
          imageLayers: importReport.totals.imageLayers,
          skippedLayers: importReport.totals.skippedLayers,
          warnings: importReport.totals.warnings
        }
      : undefined,
    topWarnings: importReport?.warnings?.slice(0, 12) ?? []
  };
}

export function validateRig(rig: RigDocument): RigValidationResult {
  const issues: RigValidationIssue[] = [];
  const addIssue = (issue: RigValidationIssue) => issues.push(issue);

  if (rig.schemaVersion !== RIG_SCHEMA_VERSION) {
    addIssue({
      severity: "warning",
      code: "schema-version-mismatch",
      message: `Expected schemaVersion ${RIG_SCHEMA_VERSION}, got ${String(rig.schemaVersion)}`,
      path: "schemaVersion"
    });
  }

  if (!rig.name || typeof rig.name !== "string") {
    addIssue({ severity: "warning", code: "missing-name", message: "Rig name is empty or missing.", path: "name" });
  }

  validateStage(rig, addIssue);

  const parts = Array.isArray(rig.parts) ? rig.parts : [];
  const assets = Array.isArray(rig.assets) ? rig.assets : [];
  const parameters = Array.isArray(rig.parameters) ? rig.parameters : [];
  const deformers = Array.isArray(rig.deformers) ? rig.deformers : [];
  const glueCandidates = Array.isArray(rig.glueCandidates) ? rig.glueCandidates : [];
  const glues = Array.isArray(rig.glue) ? rig.glue : [];
  const partIds = new Set(parts.map((part) => part.id));
  const assetIds = new Set(assets.map((asset) => asset.id));
  const parameterIds = new Set(parameters.map((parameter) => parameter.id));
  const deformerIds = new Set(deformers.map((deformer) => deformer.id));

  if (!Array.isArray(rig.assets)) {
    addIssue({ severity: "error", code: "assets-not-array", message: "assets must be an array.", path: "assets" });
  }
  if (!Array.isArray(rig.parts)) {
    addIssue({ severity: "error", code: "parts-not-array", message: "parts must be an array.", path: "parts" });
  }
  if (!Array.isArray(rig.parameters)) {
    addIssue({ severity: "error", code: "parameters-not-array", message: "parameters must be an array.", path: "parameters" });
  }
  if (rig.deformers !== undefined && !Array.isArray(rig.deformers)) {
    addIssue({ severity: "error", code: "deformers-not-array", message: "deformers must be an array when present.", path: "deformers" });
  }
  if (rig.glueCandidates !== undefined && !Array.isArray(rig.glueCandidates)) {
    addIssue({ severity: "error", code: "glue-candidates-not-array", message: "glueCandidates must be an array when present.", path: "glueCandidates" });
  }
  if (rig.glue !== undefined && !Array.isArray(rig.glue)) {
    addIssue({ severity: "error", code: "glue-not-array", message: "glue must be an array when present.", path: "glue" });
  }

  validateDuplicateIds("asset", assets, "assets", addIssue);
  validateDuplicateIds("part", parts, "parts", addIssue);
  validateDuplicateIds("parameter", parameters, "parameters", addIssue);
  validateDuplicateIds("deformer", deformers, "deformers", addIssue);
  validateDuplicateIds("glue-candidate", glueCandidates, "glueCandidates", addIssue);
  validateDuplicateIds("glue", glues, "glue", addIssue);
  validateAssets(assets, addIssue);
  validateParameters(parameters, addIssue);
  validateParts(parts, assetIds, parameterIds, deformerIds, addIssue);
  validateDeformers(deformers, partIds, parameterIds, addIssue);
  validateParentGraph(parts, partIds, addIssue);
  validateDeformerParentGraph(deformers, deformerIds, addIssue);
  validateGlueCandidates(glueCandidates, partIds, addIssue);
  const glueVertexIdsByPart = new Map<string, Set<string>>();
  for (const part of rig.parts) {
    const vertices = part.artMesh?.vertices;
    if (Array.isArray(vertices) && vertices.length) {
      glueVertexIdsByPart.set(part.id, new Set(vertices.map((vertex) => vertex.id)));
    }
  }
  validateGlue(glues, partIds, glueVertexIdsByPart, addIssue);
  validateRecommendedParameters(parameterIds, addIssue);
  validatePhysics(rig, partIds, parameterIds, deformerIds, addIssue);
  validateTracking(rig, parameterIds, addIssue);

  const errorCount = issues.filter((issue) => issue.severity === "error").length;
  const warningCount = issues.filter((issue) => issue.severity === "warning").length;
  const infoCount = issues.filter((issue) => issue.severity === "info").length;

  return {
    ok: errorCount === 0,
    issueCount: issues.length,
    errorCount,
    warningCount,
    infoCount,
    issues
  };
}

function validateStage(rig: RigDocument, addIssue: (issue: RigValidationIssue) => void) {
  if (!rig.stage || typeof rig.stage !== "object") {
    addIssue({ severity: "error", code: "missing-stage", message: "stage is missing.", path: "stage" });
    return;
  }
  if (!positiveNumber(rig.stage.width)) {
    addIssue({ severity: "error", code: "invalid-stage-width", message: "stage.width must be a positive number.", path: "stage.width" });
  }
  if (!positiveNumber(rig.stage.height)) {
    addIssue({ severity: "error", code: "invalid-stage-height", message: "stage.height must be a positive number.", path: "stage.height" });
  }
}

function validateAssets(assets: RigDocument["assets"], addIssue: (issue: RigValidationIssue) => void) {
  assets.forEach((asset, index) => {
    const path = `assets[${index}]`;
    if (!asset.id) {
      addIssue({ severity: "error", code: "missing-asset-id", message: "Asset id is missing.", path, assetId: asset.id });
    }
    if (asset.type !== "image") {
      addIssue({ severity: "error", code: "unsupported-asset-type", message: `Unsupported asset type: ${String(asset.type)}`, path, assetId: asset.id });
    }
    if (!asset.src || typeof asset.src !== "string") {
      addIssue({ severity: "error", code: "missing-asset-src", message: "Image asset src is missing.", path: `${path}.src`, assetId: asset.id });
    }
    if (asset.width !== undefined && !positiveNumber(asset.width)) {
      addIssue({ severity: "warning", code: "invalid-asset-width", message: "Asset width should be positive.", path: `${path}.width`, assetId: asset.id });
    }
    if (asset.height !== undefined && !positiveNumber(asset.height)) {
      addIssue({ severity: "warning", code: "invalid-asset-height", message: "Asset height should be positive.", path: `${path}.height`, assetId: asset.id });
    }
  });
}

function validateParameters(parameters: RigDocument["parameters"], addIssue: (issue: RigValidationIssue) => void) {
  parameters.forEach((parameter, index) => {
    const path = `parameters[${index}]`;
    if (!parameter.id) {
      addIssue({ severity: "error", code: "missing-parameter-id", message: "Parameter id is missing.", path });
    }
    if (!finiteNumber(parameter.min) || !finiteNumber(parameter.max) || parameter.min >= parameter.max) {
      addIssue({ severity: "error", code: "invalid-parameter-range", message: "Parameter min/max range is invalid.", path });
    }
    if (!finiteNumber(parameter.default) || parameter.default < parameter.min || parameter.default > parameter.max) {
      addIssue({ severity: "warning", code: "parameter-default-out-of-range", message: "Parameter default is outside min/max.", path });
    }
  });
}

function validateParts(
  parts: RigPart[],
  assetIds: Set<string>,
  parameterIds: Set<string>,
  deformerIds: Set<string>,
  addIssue: (issue: RigValidationIssue) => void
) {
  const partsById = new Map(parts.map((part) => [part.id, part]));
  const maskIsDescendant = (maskPartId: string, ownerPartId: string): boolean => {
    const visited = new Set<string>();
    let current = partsById.get(maskPartId);
    while (current?.parentId && !visited.has(current.id)) {
      visited.add(current.id);
      if (current.parentId === ownerPartId) return true;
      current = partsById.get(current.parentId);
    }
    return false;
  };  const maskClipAncestorId = (maskPartId: string): string | undefined => {
    const visited = new Set<string>();
    let current = partsById.get(maskPartId);
    while (current?.parentId && !visited.has(current.id)) {
      visited.add(current.id);
      current = partsById.get(current.parentId);
      if (current?.clip) return current.id;
    }
    return undefined;
  };

  parts.forEach((part, index) => {
    const path = `parts[${index}]`;
    if (!part.id) {
      addIssue({ severity: "error", code: "missing-part-id", message: "Part id is missing.", path, partId: part.id });
    }
    if (part.kind !== "group" && part.kind !== "image") {
      addIssue({ severity: "error", code: "invalid-part-kind", message: `Invalid part kind: ${String(part.kind)}`, path, partId: part.id });
    }
    if (part.kind === "image") {
      if (!part.assetId) {
        addIssue({ severity: "error", code: "image-part-missing-asset", message: "Image part is missing assetId.", path, partId: part.id });
      } else if (!assetIds.has(part.assetId)) {
        addIssue({
          severity: "error",
          code: "image-part-missing-asset-ref",
          message: `Image part references missing asset ${part.assetId}.`,
          path: `${path}.assetId`,
          partId: part.id,
          assetId: part.assetId
        });
      }
    }
    if (part.blendMode !== undefined && part.blendMode !== "normal" && part.blendMode !== "multiply" && part.blendMode !== "screen" && part.blendMode !== "additive") {
      addIssue({ severity: "warning", code: "unsupported-part-blend-mode", message: `Unsupported part blendMode: ${String(part.blendMode)}`, path: `${path}.blendMode`, partId: part.id });
    }
    for (const issue of validatePartTint(part.tint)) addIssue({ severity: "warning", code: `part-tint-${issue}`, message: `Invalid part tint: ${issue}`, path: `${path}.tint`, partId: part.id });
    if (part.contourShade && !validateContourShade(part.contourShade)) addIssue({ severity: "error", code: "part-contour-shade-invalid", message: "Invalid contour shade", path: `${path}.contourShade`, partId: part.id });
    if (part.alphaReveal && (!validateAlphaReveal(part.alphaReveal) || !parameterIds.has(part.alphaReveal.parameter))) addIssue({ severity: "error", code: "part-alpha-reveal-invalid", message: "Invalid alpha aperture or missing parameter", path: `${path}.alphaReveal`, partId: part.id });
    if (part.contourShade && [part.contourShade.yawParameter, part.contourShade.pitchParameter].some(id => !parameterIds.has(id))) addIssue({ severity: "error", code: "part-contour-shade-parameter", message: "Contour shade parameter is missing", path: `${path}.contourShade`, partId: part.id });
    if (part.clip) {
      const clipPath = `${path}.clip`;
      const rawClip = part.clip as { mode?: unknown; maskPartId?: unknown; maskPartIds?: unknown; maskOpacity?: unknown };
      if (rawClip.mode !== "alpha") {
        addIssue({ severity: "error", code: "unsupported-clip-mode", message: `Unsupported clip mode: ${String(rawClip.mode)}`, path: `${clipPath}.mode`, partId: part.id });
      }
      const rawMaskPartId = rawClip.maskPartId;
      const rawMaskPartIds = rawClip.maskPartIds;
      const hasSingleMaskSource = typeof rawMaskPartId === "string" && rawMaskPartId.trim().length > 0;
      const hasArrayMaskSource = rawMaskPartIds !== undefined;
      const validArrayMaskSources = Array.isArray(rawMaskPartIds) && rawMaskPartIds.length >= 1 && rawMaskPartIds.length <= 8 && rawMaskPartIds.every((id): id is string => typeof id === "string" && id.trim().length > 0 && id === id.trim()) && new Set(rawMaskPartIds).size === rawMaskPartIds.length;
      if (!hasSingleMaskSource && !hasArrayMaskSource) {
        addIssue({ severity: "error", code: "clip-missing-mask-part", message: "Clip requires maskPartId or maskPartIds.", path: clipPath, partId: part.id });
      } else if (hasSingleMaskSource && hasArrayMaskSource) {
        addIssue({ severity: "error", code: "clip-ambiguous-mask-source", message: "Use either maskPartId or maskPartIds, not both.", path: clipPath, partId: part.id });
      }
      if (hasArrayMaskSource && !validArrayMaskSources) {
        addIssue({ severity: "error", code: "invalid-clip-mask-parts", message: "clip.maskPartIds must contain 1 to 8 unique, trimmed string ids.", path: `${clipPath}.maskPartIds`, partId: part.id });
      }
      if (rawClip.maskOpacity !== undefined && rawClip.maskOpacity !== "rendered" && rawClip.maskOpacity !== "ignore") {
        addIssue({ severity: "error", code: "invalid-clip-mask-opacity", message: "clip.maskOpacity must be rendered or ignore.", path: `${clipPath}.maskOpacity`, partId: part.id });
      }
      const maskPartIds = hasSingleMaskSource && !hasArrayMaskSource ? [rawMaskPartId] : validArrayMaskSources ? rawMaskPartIds : [];
      for (const maskPartId of maskPartIds) {
        const maskPath = validArrayMaskSources ? `${clipPath}.maskPartIds` : `${clipPath}.maskPartId`;
        const maskPart = partsById.get(maskPartId);
        if (!maskPart) {
          addIssue({ severity: "error", code: "clip-missing-mask-part-ref", message: `Clip mask part ${maskPartId} does not exist.`, path: maskPath, partId: part.id });
        } else if (maskPart.id === part.id) {
          addIssue({ severity: "error", code: "clip-self-mask", message: "A part cannot clip itself.", path: maskPath, partId: part.id });
        } else if (maskPart.kind !== "image" || !maskPart.assetId) {
          addIssue({ severity: "error", code: "clip-mask-not-image", message: `Clip mask part ${maskPart.id} must be an image part with an asset.`, path: maskPath, partId: part.id });
        } else if (maskIsDescendant(maskPart.id, part.id)) {
          addIssue({ severity: "error", code: "clip-mask-descendant", message: "A clip mask cannot be inside the clipped part subtree.", path: maskPath, partId: part.id });
        } else if (maskPart.clip) {
          addIssue({ severity: "error", code: "clip-mask-nested", message: "A clip mask cannot itself be clipped.", path: maskPath, partId: part.id });
        } else if (maskClipAncestorId(maskPart.id)) {
          addIssue({ severity: "error", code: "clip-mask-inherits-clip", message: "A clip mask cannot inherit another clip because mask rendering uses its raw evaluated alpha.", path: maskPath, partId: part.id });
        }
      }
    }    for (const [artPathIndex, artPath] of (part.artPaths ?? []).entries()) {
      for (const issue of validateArtPath(artPath)) {
        addIssue({ severity: "error", code: "invalid-art-path", message: issue, path: `${path}.artPaths[${artPathIndex}]`, partId: part.id });
      }
      for (const binding of artPath.bindings ?? []) {
        if (!parameterIds.has(binding.parameter)) {
          addIssue({ severity: "warning", code: "art-path-binding-missing-parameter-ref", message: `ArtPath binding references missing parameter ${binding.parameter}.`, path: `${path}.artPaths[${artPathIndex}].bindings`, partId: part.id });
        }
      }
      for (const point of artPath.points ?? []) {
        for (const binding of point.bindings ?? []) {
          if (!parameterIds.has(binding.parameter)) {
            addIssue({ severity: "warning", code: "art-path-point-binding-missing-parameter-ref", message: `ArtPath point binding references missing parameter ${binding.parameter}.`, path: `${path}.artPaths[${artPathIndex}].points`, partId: part.id });
          }
        }
      }
    }
    if (part.artMesh && !isValidArtMesh(part.artMesh)) {
      addIssue({ severity: "error", code: "invalid-artmesh", message: "ArtMesh must have valid vertices, triangles, UVs, generator data, and vertex offsets.", path: `${path}.artMesh`, partId: part.id });
    }
    for (const qualityIssue of part.artMesh ? inspectArtMeshQuality(part.artMesh) : []) {
      if (qualityIssue.code === "invalid") continue;
      addIssue({ severity: qualityIssue.severity, code: `artmesh-${qualityIssue.code}`, message: qualityIssue.message, path: `${path}.artMesh`, partId: part.id });
    }
    for (const binding of part.artMesh?.bindings ?? []) {
      if (!parameterIds.has(binding.parameter)) {
        addIssue({ severity: "warning", code: "artmesh-binding-missing-parameter-ref", message: `ArtMesh binding references missing parameter ${binding.parameter}.`, path: `${path}.artMesh.bindings`, partId: part.id });
      }
    }
    if (part.deformerId && !deformerIds.has(part.deformerId)) {
      addIssue({ severity: "warning", code: "part-missing-deformer", message: `Part references missing deformer ${part.deformerId}.`, path: `${path}.deformerId`, partId: part.id, deformerId: part.deformerId });
    }
    if (!finiteNumber(part.drawOrder)) {
      addIssue({ severity: "error", code: "invalid-draw-order", message: "drawOrder must be a finite number.", path: `${path}.drawOrder`, partId: part.id });
    }
    validateTransform(part.transform, path, part.id, addIssue);
    validateBindings(part.bindings ?? [], path, part.id, parameterIds, addIssue);
  });
}

function validateDeformers(
  deformers: RigDeformer[],
  partIds: Set<string>,
  parameterIds: Set<string>,
  addIssue: (issue: RigValidationIssue) => void
) {
  deformers.forEach((deformer, index) => {
    const path = `deformers[${index}]`;
    if (!deformer.id) {
      addIssue({ severity: "error", code: "missing-deformer-id", message: "Deformer id is missing.", path, deformerId: deformer.id });
    }
    if (deformer.kind !== "group" && deformer.kind !== "rotate" && deformer.kind !== "warp") {
      addIssue({ severity: "error", code: "invalid-deformer-kind", message: `Invalid deformer kind: ${String(deformer.kind)}`, path, deformerId: deformer.id });
    }
    if (!deformer.origin || !finiteNumber(deformer.origin.x) || !finiteNumber(deformer.origin.y)) {
      addIssue({ severity: "error", code: "invalid-deformer-origin", message: "Deformer origin x/y must be finite numbers.", path: `${path}.origin`, deformerId: deformer.id });
    }
    validateTransform(deformer.transform, path, deformer.id, addIssue);
    validateWarp(deformer.warp, path, deformer.id, parameterIds, addIssue);
    validateBindings(deformer.bindings ?? [], path, deformer.id, parameterIds, addIssue);
    for (const targetPartId of deformer.targetPartIds ?? []) {
      if (!partIds.has(targetPartId)) {
        addIssue({ severity: "warning", code: "deformer-missing-target", message: `Deformer target part ${targetPartId} does not exist.`, path: `${path}.targetPartIds`, partId: targetPartId, deformerId: deformer.id });
      }
    }
  });
}

function validateTransform(
  transform: Transform2D,
  path: string,
  id: string,
  addIssue: (issue: RigValidationIssue) => void
) {
  if (!transform || typeof transform !== "object") {
    addIssue({ severity: "error", code: "missing-transform", message: "Transform is missing.", path: `${path}.transform`, partId: id });
    return;
  }
  for (const key of TRANSFORM_KEYS) {
    if (!finiteNumber(transform[key])) {
      addIssue({ severity: "error", code: "invalid-transform-value", message: `transform.${key} must be a finite number.`, path: `${path}.transform.${key}`, partId: id });
    }
  }
  if (transform.opacity < 0 || transform.opacity > 1) {
    addIssue({ severity: "warning", code: "opacity-out-of-range", message: "opacity should be between 0 and 1.", path: `${path}.transform.opacity`, partId: id });
  }
  if (Math.abs(transform.scaleX) < 0.001 || Math.abs(transform.scaleY) < 0.001) {
    addIssue({ severity: "warning", code: "near-zero-scale", message: "scale is very close to zero, so this element may disappear.", path: `${path}.transform`, partId: id });
  }
}

function validateWarp(
  warp: RigDeformer["warp"],
  parentPath: string,
  deformerId: string,
  parameterIds: Set<string>,
  addIssue: (issue: RigValidationIssue) => void
) {
  if (!warp) {
    return;
  }
  const path = `${parentPath}.warp`;
  for (const property of ["bendX", "bendY", "taperX", "taperY"] as const) {
    if (!finiteNumber(warp[property])) {
      addIssue({ severity: "error", code: "invalid-warp-value", message: `Warp ${property} must be a finite number.`, path: `${path}.${property}`, deformerId });
    }
  }
  if (!warp.grid || !finiteNumber(warp.grid.columns) || !finiteNumber(warp.grid.rows) || warp.grid.columns < 1 || warp.grid.rows < 1) {
    addIssue({ severity: "error", code: "invalid-warp-grid", message: "Warp grid columns/rows must be finite numbers greater than 0.", path: `${path}.grid`, deformerId });
  }

  const rawPins = (warp as { pins?: unknown }).pins;
  if (rawPins === undefined) {
    return;
  }
  if (!Array.isArray(rawPins)) {
    addIssue({ severity: "error", code: "invalid-warp-pins", message: "Warp pins must be an array when present.", path: `${path}.pins`, deformerId });
    return;
  }
  if (rawPins.length > 32) {
    addIssue({ severity: "warning", code: "too-many-warp-pins", message: "Only the first 32 warp pins are used by the runtime.", path: `${path}.pins`, deformerId });
  }

  const seenPinIds = new Set<string>();
  rawPins.forEach((rawPin, index) => {
    const pin = rawPin as {
      id?: unknown;
      name?: unknown;
      enabled?: unknown;
      u?: unknown;
      v?: unknown;
      offsetX?: unknown;
      offsetY?: unknown;
      radius?: unknown;
      strength?: unknown;
      linkedMirrorId?: unknown;
      bindings?: unknown;
    };
    const pinPath = `${path}.pins[${index}]`;
    if (!rawPin || typeof rawPin !== "object") {
      addIssue({ severity: "error", code: "invalid-warp-pin", message: "Warp pin must be an object.", path: pinPath, deformerId });
      return;
    }
    if (typeof pin.id !== "string" || !pin.id.trim()) {
      addIssue({ severity: "error", code: "missing-warp-pin-id", message: "Warp pin id is missing.", path: `${pinPath}.id`, deformerId });
    } else if (seenPinIds.has(pin.id)) {
      addIssue({ severity: "error", code: "duplicate-warp-pin-id", message: `Duplicate warp pin id: ${pin.id}`, path: `${path}.pins`, deformerId });
    } else {
      seenPinIds.add(pin.id);
    }
    if (typeof pin.name !== "string" || !pin.name.trim()) {
      addIssue({ severity: "warning", code: "missing-warp-pin-name", message: "Warp pin name is empty or missing.", path: `${pinPath}.name`, deformerId });
    }
    if (typeof pin.enabled !== "boolean") {
      addIssue({ severity: "error", code: "invalid-warp-pin-enabled", message: "Warp pin enabled must be a boolean.", path: `${pinPath}.enabled`, deformerId });
    }
    if (!finiteNumber(pin.u) || pin.u < 0 || pin.u > 1) {
      addIssue({ severity: "error", code: "invalid-warp-pin-u", message: "Warp pin u must be between 0 and 1.", path: `${pinPath}.u`, deformerId });
    }
    if (!finiteNumber(pin.v) || pin.v < 0 || pin.v > 1) {
      addIssue({ severity: "error", code: "invalid-warp-pin-v", message: "Warp pin v must be between 0 and 1.", path: `${pinPath}.v`, deformerId });
    }
    if (!finiteNumber(pin.offsetX) || !finiteNumber(pin.offsetY)) {
      addIssue({ severity: "error", code: "invalid-warp-pin-offset", message: "Warp pin offsetX/offsetY must be finite numbers.", path: pinPath, deformerId });
    }
    if (!finiteNumber(pin.radius) || pin.radius <= 0 || pin.radius > 1.5) {
      addIssue({ severity: "error", code: "invalid-warp-pin-radius", message: "Warp pin radius must be greater than 0 and at most 1.5.", path: `${pinPath}.radius`, deformerId });
    }
    if (!finiteNumber(pin.strength) || pin.strength < 0 || pin.strength > 1) {
      addIssue({ severity: "error", code: "invalid-warp-pin-strength", message: "Warp pin strength must be between 0 and 1.", path: `${pinPath}.strength`, deformerId });
    }
    if (pin.linkedMirrorId !== undefined && (typeof pin.linkedMirrorId !== "string" || !pin.linkedMirrorId.trim())) {
      addIssue({ severity: "warning", code: "invalid-warp-pin-linked-mirror", message: "linkedMirrorId should be a non-empty string when present.", path: `${pinPath}.linkedMirrorId`, deformerId });
    }
    if (pin.bindings !== undefined) {
      validateWarpPinBindings(pin.bindings, pinPath, deformerId, parameterIds, addIssue);
    }
  });

  rawPins.forEach((rawPin, index) => {
    const pin = rawPin as { id?: unknown; linkedMirrorId?: unknown };
    if (typeof pin.id !== "string" || typeof pin.linkedMirrorId !== "string" || !pin.linkedMirrorId.trim()) {
      return;
    }
    const pinPath = `${path}.pins[${index}]`;
    if (pin.linkedMirrorId === pin.id) {
      addIssue({ severity: "warning", code: "warp-pin-linked-mirror-self", message: "Warp pin linkedMirrorId should reference a different pin.", path: `${pinPath}.linkedMirrorId`, deformerId });
    } else if (!seenPinIds.has(pin.linkedMirrorId)) {
      addIssue({ severity: "warning", code: "warp-pin-linked-mirror-missing", message: `Warp pin linkedMirrorId references missing pin ${pin.linkedMirrorId}.`, path: `${pinPath}.linkedMirrorId`, deformerId });
    }
  });
}

function validateWarpPinBindings(
  rawBindings: unknown,
  parentPath: string,
  deformerId: string,
  parameterIds: Set<string>,
  addIssue: (issue: RigValidationIssue) => void
) {
  if (!Array.isArray(rawBindings)) {
    addIssue({ severity: "error", code: "invalid-warp-pin-bindings", message: "Warp pin bindings must be an array when present.", path: `${parentPath}.bindings`, deformerId });
    return;
  }
  if (rawBindings.length > 16) {
    addIssue({ severity: "warning", code: "too-many-warp-pin-bindings", message: "Only the first 16 warp pin bindings are used by the runtime.", path: `${parentPath}.bindings`, deformerId });
  }

  rawBindings.forEach((rawBinding, bindingIndex) => {
    const binding = rawBinding as {
      parameter?: unknown;
      property?: unknown;
      additive?: unknown;
      interpolation?: unknown;
      keys?: unknown;
    };
    const path = `${parentPath}.bindings[${bindingIndex}]`;
    if (!rawBinding || typeof rawBinding !== "object") {
      addIssue({ severity: "error", code: "invalid-warp-pin-binding", message: "Warp pin binding must be an object.", path, deformerId });
      return;
    }
    if (typeof binding.parameter !== "string" || !binding.parameter.trim()) {
      addIssue({ severity: "error", code: "warp-pin-binding-missing-parameter", message: "Warp pin binding parameter is missing.", path: `${path}.parameter`, deformerId });
    } else if (!parameterIds.has(binding.parameter)) {
      addIssue({ severity: "warning", code: "warp-pin-binding-missing-parameter-ref", message: `Warp pin binding references missing parameter ${binding.parameter}.`, path: `${path}.parameter`, deformerId });
    }
    if (typeof binding.property !== "string" || !WARP_PIN_BINDING_PROPERTY_SET.has(binding.property)) {
      addIssue({ severity: "error", code: "warp-pin-binding-invalid-property", message: `Warp pin binding property is invalid: ${String(binding.property)}`, path: `${path}.property`, deformerId });
    }
    if (binding.additive !== undefined && typeof binding.additive !== "boolean") {
      addIssue({ severity: "error", code: "warp-pin-binding-invalid-additive", message: "Warp pin binding additive must be a boolean when present.", path: `${path}.additive`, deformerId });
    }
    if (binding.interpolation !== undefined && !isParameterInterpolation(binding.interpolation)) {
      addIssue({ severity: "error", code: "warp-pin-binding-invalid-interpolation", message: `Warp pin binding interpolation is invalid: ${String(binding.interpolation)}`, path: `${path}.interpolation`, deformerId });
    }
    if (!Array.isArray(binding.keys) || binding.keys.length === 0) {
      addIssue({ severity: "warning", code: "warp-pin-binding-empty-keys", message: "Warp pin binding has no keyframes.", path: `${path}.keys`, deformerId });
      return;
    }
    binding.keys.forEach((rawKey, keyIndex) => {
      const key = rawKey as { input?: unknown; value?: unknown };
      if (!rawKey || typeof rawKey !== "object" || !finiteNumber(key.input) || !finiteNumber(key.value)) {
        addIssue({ severity: "error", code: "warp-pin-binding-invalid-key", message: "Warp pin binding key input/value must be finite numbers.", path: `${path}.keys[${keyIndex}]`, deformerId });
      }
    });
  });
}
function validateBindings(
  bindings: ParameterBinding[],
  parentPath: string,
  id: string,
  parameterIds: Set<string>,
  addIssue: (issue: RigValidationIssue) => void
) {
  bindings.forEach((binding, index) => {
    const path = `${parentPath}.bindings[${index}]`;
    if (!parameterIds.has(binding.parameter)) {
      addIssue({ severity: "warning", code: "binding-missing-parameter", message: `Binding references missing parameter ${binding.parameter}.`, path, partId: id });
    }
    if (!BINDING_PROPERTIES.has(binding.property)) {
      addIssue({ severity: "error", code: "binding-invalid-property", message: `Binding property is invalid: ${String(binding.property)}`, path, partId: id });
    }
    if (binding.interpolation !== undefined && !isParameterInterpolation(binding.interpolation)) {
      addIssue({ severity: "error", code: "binding-invalid-interpolation", message: `Binding interpolation is invalid: ${String(binding.interpolation)}`, path: `${path}.interpolation`, partId: id });
    }
    if (!Array.isArray(binding.keys) || binding.keys.length === 0) {
      addIssue({ severity: "warning", code: "binding-empty-keys", message: "Binding has no keyframes.", path, partId: id });
      return;
    }
    binding.keys.forEach((key, keyIndex) => {
      if (!finiteNumber(key.input) || !finiteNumber(key.value)) {
        addIssue({ severity: "error", code: "binding-invalid-key", message: "Binding key input/value must be finite numbers.", path: `${path}.keys[${keyIndex}]`, partId: id });
      }
    });
  });
}

function validateParentGraph(parts: RigPart[], partIds: Set<string>, addIssue: (issue: RigValidationIssue) => void) {
  const partById = new Map(parts.map((part) => [part.id, part]));
  const root = parts.find((part) => part.id === "root");
  if (!root) {
    addIssue({ severity: "warning", code: "missing-root-part", message: "No part with id 'root' exists.", path: "parts" });
  }

  parts.forEach((part, index) => {
    const path = `parts[${index}].parentId`;
    if (part.parentId && !partIds.has(part.parentId)) {
      addIssue({ severity: "error", code: "missing-parent", message: `Parent part ${part.parentId} does not exist.`, path, partId: part.id });
    }
    if (part.parentId === part.id) {
      addIssue({ severity: "error", code: "self-parent", message: "Part cannot be its own parent.", path, partId: part.id });
    }
  });

  for (const part of parts) {
    const seen = new Set<string>();
    let current: RigPart | undefined = part;
    while (current?.parentId) {
      if (seen.has(current.id)) {
        addIssue({ severity: "error", code: "parent-cycle", message: "Parent hierarchy contains a cycle.", path: "parts", partId: part.id });
        break;
      }
      seen.add(current.id);
      current = partById.get(current.parentId);
    }
  }
}

function validateDeformerParentGraph(deformers: RigDeformer[], deformerIds: Set<string>, addIssue: (issue: RigValidationIssue) => void) {
  const deformerById = new Map(deformers.map((deformer) => [deformer.id, deformer]));
  deformers.forEach((deformer, index) => {
    const path = `deformers[${index}].parentId`;
    if (deformer.parentId && !deformerIds.has(deformer.parentId)) {
      addIssue({ severity: "error", code: "missing-deformer-parent", message: `Parent deformer ${deformer.parentId} does not exist.`, path, deformerId: deformer.id });
    }
    if (deformer.parentId === deformer.id) {
      addIssue({ severity: "error", code: "self-deformer-parent", message: "Deformer cannot be its own parent.", path, deformerId: deformer.id });
    }
  });

  for (const deformer of deformers) {
    const seen = new Set<string>();
    let current: RigDeformer | undefined = deformer;
    while (current?.parentId) {
      if (seen.has(current.id)) {
        addIssue({ severity: "error", code: "deformer-parent-cycle", message: "Deformer hierarchy contains a cycle.", path: "deformers", deformerId: deformer.id });
        break;
      }
      seen.add(current.id);
      current = deformerById.get(current.parentId);
    }
  }
}

function validateGlueCandidates(
  glueCandidates: RigGlueCandidate[],
  partIds: Set<string>,
  addIssue: (issue: RigValidationIssue) => void
) {
  glueCandidates.forEach((candidate, index) => {
    const path = `glueCandidates[${index}]`;
    if (!candidate.id) {
      addIssue({ severity: "error", code: "missing-glue-candidate-id", message: "Glue candidate id is missing.", path, glueCandidateId: candidate.id });
    }
    if (candidate.kind !== "overlap" && candidate.kind !== "near-gap" && candidate.kind !== "manual") {
      addIssue({ severity: "error", code: "invalid-glue-candidate-kind", message: `Invalid glue candidate kind: ${String(candidate.kind)}`, path: `${path}.kind`, glueCandidateId: candidate.id });
    }
    if (candidate.status !== "candidate" && candidate.status !== "accepted" && candidate.status !== "rejected") {
      addIssue({ severity: "error", code: "invalid-glue-candidate-status", message: `Invalid glue candidate status: ${String(candidate.status)}`, path: `${path}.status`, glueCandidateId: candidate.id });
    }
    if (!partIds.has(candidate.partAId)) {
      addIssue({ severity: "warning", code: "glue-candidate-missing-part-a", message: `Glue candidate partA ${candidate.partAId} does not exist.`, path: `${path}.partAId`, partId: candidate.partAId, glueCandidateId: candidate.id });
    }
    if (!partIds.has(candidate.partBId)) {
      addIssue({ severity: "warning", code: "glue-candidate-missing-part-b", message: `Glue candidate partB ${candidate.partBId} does not exist.`, path: `${path}.partBId`, partId: candidate.partBId, glueCandidateId: candidate.id });
    }
    if (candidate.partAId && candidate.partAId === candidate.partBId) {
      addIssue({ severity: "warning", code: "glue-candidate-same-parts", message: "Glue candidate should connect two different parts.", path, glueCandidateId: candidate.id });
    }
    if (!finiteNumber(candidate.weightA) || candidate.weightA < 0 || candidate.weightA > 1 || !finiteNumber(candidate.weightB) || candidate.weightB < 0 || candidate.weightB > 1) {
      addIssue({ severity: "error", code: "invalid-glue-candidate-weight", message: "Glue candidate weights must be between 0 and 1.", path, glueCandidateId: candidate.id });
    }
    if (!finiteNumber(candidate.priority) || candidate.priority < 0) {
      addIssue({ severity: "error", code: "invalid-glue-candidate-priority", message: "Glue candidate priority must be a non-negative finite number.", path, glueCandidateId: candidate.id });
    }
    if (!candidate.evidence || typeof candidate.evidence !== "object") {
      addIssue({ severity: "warning", code: "missing-glue-candidate-evidence", message: "Glue candidate evidence is missing.", path: `${path}.evidence`, glueCandidateId: candidate.id });
      return;
    }
    if (candidate.evidence.source !== "boundary-diagnostics" && candidate.evidence.source !== "manual") {
      addIssue({ severity: "warning", code: "invalid-glue-candidate-evidence-source", message: "Glue candidate evidence.source should be boundary-diagnostics or manual.", path: `${path}.evidence.source`, glueCandidateId: candidate.id });
    }
    if (candidate.evidence.overlapRatio !== undefined && (!finiteNumber(candidate.evidence.overlapRatio) || candidate.evidence.overlapRatio < 0)) {
      addIssue({ severity: "warning", code: "invalid-glue-candidate-overlap-ratio", message: "Glue candidate overlapRatio should be non-negative when present.", path: `${path}.evidence.overlapRatio`, glueCandidateId: candidate.id });
    }
    if (candidate.evidence.gapPixels !== undefined && (!finiteNumber(candidate.evidence.gapPixels) || candidate.evidence.gapPixels < 0)) {
      addIssue({ severity: "warning", code: "invalid-glue-candidate-gap", message: "Glue candidate gapPixels should be non-negative when present.", path: `${path}.evidence.gapPixels`, glueCandidateId: candidate.id });
    }
  });
}

function validateGlue(glues: RigGlue[], partIds: Set<string>, vertexIdsByPart: Map<string, Set<string>>, addIssue: (issue: RigValidationIssue) => void) {
  // Only a vertex that two stitches both *move* is over-constrained; the solver can then reach a
  // compromise at best, so both seams keep a residual. A stitch that merely reads a vertex as its
  // pinned reference is a chain, not a conflict, and chains resolve exactly.
  const stitchOwner = new Map<string, string>();
  glues.forEach((glue, index) => {
    const path = `glue[${index}]`;
    if (!glue.id) {
      addIssue({ severity: "error", code: "missing-glue-id", message: "Glue id is missing.", path, glueId: glue.id });
    }
    if (glue.status !== "draft" && glue.status !== "active" && glue.status !== "disabled") {
      addIssue({ severity: "error", code: "invalid-glue-status", message: `Invalid glue status: ${String(glue.status)}`, path: `${path}.status`, glueId: glue.id });
    }
    if (glue.mode !== "seam-debug" && glue.mode !== "soft-seam" && glue.mode !== "stitch") {
      addIssue({ severity: "error", code: "invalid-glue-mode", message: `Invalid glue mode: ${String(glue.mode)}`, path: `${path}.mode`, glueId: glue.id });
    }
    if (!partIds.has(glue.partAId)) {
      addIssue({ severity: "warning", code: "glue-missing-part-a", message: `Glue partA ${glue.partAId} does not exist.`, path: `${path}.partAId`, partId: glue.partAId, glueId: glue.id });
    }
    if (!partIds.has(glue.partBId)) {
      addIssue({ severity: "warning", code: "glue-missing-part-b", message: `Glue partB ${glue.partBId} does not exist.`, path: `${path}.partBId`, partId: glue.partBId, glueId: glue.id });
    }
    if (glue.partAId && glue.partAId === glue.partBId) {
      addIssue({ severity: "warning", code: "glue-same-parts", message: "Glue should connect two different parts.", path, glueId: glue.id });
    }
    if (!finiteNumber(glue.weightA) || glue.weightA < 0 || glue.weightA > 1 || !finiteNumber(glue.weightB) || glue.weightB < 0 || glue.weightB > 1) {
      addIssue({ severity: "error", code: "invalid-glue-weight", message: "Glue weights must be between 0 and 1.", path, glueId: glue.id });
    }
    if (!finiteNumber(glue.strength) || glue.strength < 0 || glue.strength > 1) {
      addIssue({ severity: "error", code: "invalid-glue-strength", message: "Glue strength must be between 0 and 1.", path: `${path}.strength`, glueId: glue.id });
    }
    if (!finiteNumber(glue.priority) || glue.priority < 0) {
      addIssue({ severity: "error", code: "invalid-glue-priority", message: "Glue priority must be a non-negative finite number.", path: `${path}.priority`, glueId: glue.id });
    }
    if (glue.seamPoints !== undefined) {
      if (!Array.isArray(glue.seamPoints)) {
        addIssue({ severity: "error", code: "invalid-glue-seam-points", message: "Glue seamPoints must be an array when present.", path: `${path}.seamPoints`, glueId: glue.id });
      } else {
        glue.seamPoints.forEach((point, pointIndex) => {
          const pointPath = `${path}.seamPoints[${pointIndex}]`;
          for (const side of ["a", "b"] as const) {
            const uv = point[side];
            if (!uv || !finiteNumber(uv.u) || uv.u < 0 || uv.u > 1 || !finiteNumber(uv.v) || uv.v < 0 || uv.v > 1) {
              addIssue({ severity: "error", code: "invalid-glue-seam-point", message: "Glue seam point UV values must be between 0 and 1.", path: `${pointPath}.${side}`, glueId: glue.id });
            }
          }
          if (point.weightA !== undefined && (!finiteNumber(point.weightA) || point.weightA < 0 || point.weightA > 1)) {
            addIssue({ severity: "error", code: "invalid-glue-seam-weight", message: "Glue seam point weightA must be between 0 and 1.", path: `${pointPath}.weightA`, glueId: glue.id });
          }
          if (point.weightB !== undefined && (!finiteNumber(point.weightB) || point.weightB < 0 || point.weightB > 1)) {
            addIssue({ severity: "error", code: "invalid-glue-seam-weight", message: "Glue seam point weightB must be between 0 and 1.", path: `${pointPath}.weightB`, glueId: glue.id });
          }
          if (point.radius !== undefined && (!finiteNumber(point.radius) || point.radius <= 0)) {
            addIssue({ severity: "error", code: "invalid-glue-seam-radius", message: "Glue seam point radius must be positive when present.", path: `${pointPath}.radius`, glueId: glue.id });
          }
          if (point.strength !== undefined && (!finiteNumber(point.strength) || point.strength < 0 || point.strength > 1)) {
            addIssue({ severity: "error", code: "invalid-glue-seam-strength", message: "Glue seam point strength must be between 0 and 1.", path: `${pointPath}.strength`, glueId: glue.id });
          }
        });
      }
    }
    if (glue.vertexPairs !== undefined) {
      if (!Array.isArray(glue.vertexPairs)) {
        addIssue({ severity: "error", code: "invalid-glue-vertex-pairs", message: "Glue vertexPairs must be an array when present.", path: `${path}.vertexPairs`, glueId: glue.id });
      } else {
        // A stitch moves named vertices, so a pair that names a vertex the mesh does not have would
        // silently do nothing. Catch it here rather than at draw time.
        const aVertexIds = vertexIdsByPart.get(glue.partAId);
        const bVertexIds = vertexIdsByPart.get(glue.partBId);
        const seenA = new Set<string>();
        const seenB = new Set<string>();
        glue.vertexPairs.forEach((pair, pairIndex) => {
          const pairPath = `${path}.vertexPairs[${pairIndex}]`;
          if (!pair?.a || !pair?.b) {
            addIssue({ severity: "error", code: "invalid-glue-vertex-pair", message: "Glue vertex pair must name a vertex on both sides.", path: pairPath, glueId: glue.id });
            return;
          }
          if (aVertexIds && !aVertexIds.has(pair.a)) {
            addIssue({ severity: "error", code: "glue-vertex-not-found", message: `Glue vertex ${pair.a} does not exist on ${glue.partAId}.`, path: `${pairPath}.a`, partId: glue.partAId, glueId: glue.id });
          }
          if (bVertexIds && !bVertexIds.has(pair.b)) {
            addIssue({ severity: "error", code: "glue-vertex-not-found", message: `Glue vertex ${pair.b} does not exist on ${glue.partBId}.`, path: `${pairPath}.b`, partId: glue.partBId, glueId: glue.id });
          }
          if (seenA.has(pair.a) || seenB.has(pair.b)) {
            addIssue({ severity: "warning", code: "duplicate-glue-vertex-binding", message: "A vertex is bound more than once in the same glue; the last pair wins.", path: pairPath, glueId: glue.id });
          }
          seenA.add(pair.a);
          seenB.add(pair.b);
          if (glue.mode === "stitch") {
            const total = glue.weightA + glue.weightB;
            const weight = Number.isFinite(pair.weight) ? (pair.weight as number) : (total > 0 ? glue.weightB / total : 0.5);
            const moved: Array<readonly [string, string]> = [];
            if (weight > 0) moved.push([glue.partAId, pair.a] as const);
            if (weight < 1) moved.push([glue.partBId, pair.b] as const);
            for (const [partId, vertexId] of moved) {
              const key = partId + "/" + vertexId;
              const owner = stitchOwner.get(key);
              if (owner && owner !== glue.id) {
                addIssue({ severity: "warning", code: "over-constrained-glue-vertex", message: `Vertex ${vertexId} on ${partId} is moved by both ${owner} and ${glue.id}; both seams will keep a residual.`, path: pairPath, partId, glueId: glue.id });
              } else if (!owner) {
                stitchOwner.set(key, glue.id);
              }
            }
          }
          if (pair.weight !== undefined && (!finiteNumber(pair.weight) || pair.weight < 0 || pair.weight > 1)) {
            addIssue({ severity: "error", code: "invalid-glue-vertex-weight", message: "Glue vertex pair weight must be between 0 and 1.", path: `${pairPath}.weight`, glueId: glue.id });
          }
          for (const axis of ["restDx", "restDy"] as const) {
            if (pair[axis] !== undefined && !finiteNumber(pair[axis])) {
              addIssue({ severity: "error", code: "invalid-glue-vertex-rest", message: "Glue vertex pair rest offset must be finite when present.", path: `${pairPath}.${axis}`, glueId: glue.id });
            }
          }
        });
        if (glue.mode === "stitch" && !glue.vertexPairs.length) {
          addIssue({ severity: "warning", code: "empty-glue-stitch", message: "A stitch glue without vertex pairs has no effect.", path: `${path}.vertexPairs`, glueId: glue.id });
        }
      }
    } else if (glue.mode === "stitch") {
      addIssue({ severity: "warning", code: "empty-glue-stitch", message: "A stitch glue without vertex pairs has no effect.", path: `${path}.vertexPairs`, glueId: glue.id });
    }
    if (glue.evidence?.source && glue.evidence.source !== "boundary-diagnostics" && glue.evidence.source !== "manual") {
      addIssue({ severity: "warning", code: "invalid-glue-evidence-source", message: "Glue evidence.source should be boundary-diagnostics or manual.", path: `${path}.evidence.source`, glueId: glue.id });
    }
  });
}
function validateRecommendedParameters(parameterIds: Set<string>, addIssue: (issue: RigValidationIssue) => void) {
  for (const id of PARAMETER_IDS) {
    if (!parameterIds.has(id)) {
      addIssue({ severity: "warning", code: "missing-standard-parameter", message: `Standard parameter ${id} is missing.`, path: "parameters" });
    }
  }
}

function validatePhysics(
  rig: RigDocument,
  partIds: Set<string>,
  parameterIds: Set<string>,
  deformerIds: Set<string>,
  addIssue: (issue: RigValidationIssue) => void
) {
  if (!rig.physics || typeof rig.physics !== "object") {
    addIssue({ severity: "warning", code: "missing-physics", message: "physics section is missing.", path: "physics" });
    return;
  }

  const chains = Array.isArray(rig.physics.chains) ? rig.physics.chains : [];
  validateDuplicateIds("physics-chain", chains, "physics.chains", addIssue);

  chains.forEach((chain, index) => {
    const path = `physics.chains[${index}]`;
    for (const targetDeformerId of chain.targetDeformerIds ?? []) {
      if (!deformerIds.has(targetDeformerId)) {
        addIssue({ severity: "warning", code: "physics-missing-deformer-target", message: `Physics target deformer ${targetDeformerId} does not exist.`, path, deformerId: targetDeformerId });
      }
    }
    for (const targetPartId of chain.targetPartIds ?? []) {
      if (!partIds.has(targetPartId)) {
        addIssue({ severity: "warning", code: "physics-missing-target", message: `Physics target part ${targetPartId} does not exist.`, path, partId: targetPartId });
      }
    }
    for (const source of chain.sourceParameters ?? []) {
      if (!parameterIds.has(source.parameter)) {
        addIssue({ severity: "warning", code: "physics-missing-parameter", message: `Physics source parameter ${source.parameter} does not exist.`, path });
      }
      if (!finiteNumber(source.scale)) {
        addIssue({ severity: "error", code: "physics-invalid-input-scale", message: "Physics input scale must be finite.", path });
      }
    }
    if (chain.mass <= 0 || !finiteNumber(chain.mass)) {
      addIssue({ severity: "error", code: "physics-invalid-mass", message: "Physics mass must be positive.", path });
    }
    if (chain.parameterOutput) {
      const output = chain.parameterOutput;
      if (!output.parameter) {
        addIssue({ severity: "error", code: "physics-invalid-output-parameter", message: "Physics output parameter is required.", path });
      }
      if (!finiteNumber(output.scale)) {
        addIssue({ severity: "error", code: "physics-invalid-output-scale", message: "Physics parameter output scale must be finite.", path });
      }
      if (output.min !== undefined && !finiteNumber(output.min)) {
        addIssue({ severity: "error", code: "physics-invalid-output-min", message: "Physics parameter output minimum must be finite.", path });
      }
      if (output.max !== undefined && !finiteNumber(output.max)) {
        addIssue({ severity: "error", code: "physics-invalid-output-max", message: "Physics parameter output maximum must be finite.", path });
      }
      if (finiteNumber(output.min) && finiteNumber(output.max) && output.min! > output.max!) {
        addIssue({ severity: "error", code: "physics-invalid-output-range", message: "Physics parameter output minimum must not exceed maximum.", path });
      }
    }    if (!(TRANSFORM_PROPERTIES as readonly string[]).includes(chain.output?.property)) {
      addIssue({ severity: "error", code: "physics-invalid-output-property", message: "Physics output property is invalid.", path });
    }
  });
}

function validateTracking(rig: RigDocument, parameterIds: Set<string>, addIssue: (issue: RigValidationIssue) => void) {
  if (!rig.tracking) {
    return;
  }

  const sourceIds = new Set(DEFAULT_TRACKING_INPUTS.map((input) => input.id));
  if (rig.tracking.provider !== "manual" && rig.tracking.provider !== "mediapipe-face-landmarker") {
    addIssue({ severity: "error", code: "tracking-invalid-provider", message: "Tracking provider is invalid.", path: "tracking.provider" });
  }
  if (!finiteNumber(rig.tracking.inputSmoothing) || rig.tracking.inputSmoothing < 0 || rig.tracking.inputSmoothing > 1) {
    addIssue({ severity: "error", code: "tracking-invalid-input-smoothing", message: "Tracking inputSmoothing must be between 0 and 1.", path: "tracking.inputSmoothing" });
  }

  const mappings = Array.isArray(rig.tracking.mappings) ? rig.tracking.mappings : [];
  validateDuplicateIds("tracking-mapping", mappings, "tracking.mappings", addIssue);
  mappings.forEach((mapping, index) => {
    const path = `tracking.mappings[${index}]`;
    if (!sourceIds.has(mapping.source)) {
      addIssue({ severity: "warning", code: "tracking-missing-source", message: `Tracking source ${mapping.source} is not a known input source.`, path });
    }
    if (!parameterIds.has(mapping.parameter)) {
      addIssue({ severity: "warning", code: "tracking-missing-parameter", message: `Tracking target parameter ${mapping.parameter} does not exist.`, path });
    }
    if (!finiteNumber(mapping.scale)) {
      addIssue({ severity: "error", code: "tracking-invalid-scale", message: "Tracking scale must be finite.", path });
    }
    if (!finiteNumber(mapping.offset)) {
      addIssue({ severity: "error", code: "tracking-invalid-offset", message: "Tracking offset must be finite.", path });
    }
    if (!finiteNumber(mapping.smoothing) || mapping.smoothing < 0 || mapping.smoothing > 1) {
      addIssue({ severity: "error", code: "tracking-invalid-smoothing", message: "Tracking smoothing must be between 0 and 1.", path });
    }
  });
}

function validateDuplicateIds(
  label: string,
  items: Array<{ id: string }>,
  path: string,
  addIssue: (issue: RigValidationIssue) => void
) {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const item of items) {
    if (!item.id) {
      continue;
    }
    if (seen.has(item.id)) {
      duplicates.add(item.id);
    }
    seen.add(item.id);
  }
  for (const id of duplicates) {
    addIssue({ severity: "error", code: `duplicate-${label}-id`, message: `Duplicate ${label} id: ${id}`, path });
  }
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function positiveNumber(value: unknown): value is number {
  return finiteNumber(value) && value > 0;
}

function numberOrZero(value: unknown): number {
  return finiteNumber(value) ? value : 0;
}
