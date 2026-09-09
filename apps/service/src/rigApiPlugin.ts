import { mkdir,readFile,rename,writeFile } from "node:fs/promises";
import path from "node:path";
import type { ApiHost } from "./host.js";
import { deriveAlphaBleedAssets,type AlphaBleedAssetRequest } from "@standrig/core/alphaBleed";
import { createArtMeshAlphaSampler,type ArtMeshAlphaSampler } from "@standrig/core/artMeshAsset";
import { generateArtMeshKeyCandidates,modelingOperationsForArtMeshCandidates } from "@standrig/core/artMeshCandidates";
import { artMeshGenerationProfiles,artMeshProfileCandidates } from "@standrig/core/artMeshPresets";
import { runArtPathQa,type ArtPathQaRequest } from "@standrig/core/artPathQa";
import { applyArtPathTransactionOperations,type ArtPathTransactionOperation } from "@standrig/core/artPathTransaction";
import { ASSET_MANIFEST_FORMAT,decodeDataUrl,diagnoseRigAssets,externalizeRigAssets,type RigAssetManifest } from "@standrig/core/assetManifest";
import { portableBundle } from "./portableBundle.js";
import { correspondenceOperationsForSolution,solveCorrespondence,type CorrespondenceSolveRequest } from "@standrig/core/correspondenceSolver";
import { ensureRigDeformers,normalizeDeformer } from "@standrig/core/deformers";
import { detailRegionDefinitionsForRig } from "@standrig/core/detailRegions";
import { runExposureSweep,type ExposureSweepRequest } from "@standrig/core/exposureQa";
import { createGenerationRequest,deletePersistedGeneratedAsset,evaluateGenerationAsset,getGenerationRequest,listGenerationRequests,listPersistedGeneratedAssets,persistAcceptedGeneration,regenerateGenerationRequest,type GenerationAcceptanceInput,type GenerationRequestInput } from "@standrig/core/generationRequests";
import { exportGeometryPart,GEOMETRY_EXPORT_LIMITS,geometryExportByteLength,GeometryExportError } from "@standrig/core/geometryExport";
import { exportGeometryPartV11 } from "@standrig/core/geometryExportV11";
import { ensureRigGlue,ensureRigGlueCandidates,glueCandidateListItem,glueListItem,patchGlue,patchGlueCandidate,promoteGlueCandidates } from "@standrig/core/glue";
import { buildGlueVertexPairs } from "@standrig/core/glueVertexCandidates";
import { fitHeadProxy,headProxyPoseCandidates } from "@standrig/core/headProxy";
import { calibrateHeadProxy,normalizeHeadProxyCalibrationSamples } from "@standrig/core/headProxyCalibration";
import { inspectRig,summarizeRig,validateRig } from "@standrig/core/inspect";
import { runJoinQa,type JoinQaRequest } from "@standrig/core/joinQa";
import { applyJoinTransactionOperations,type JoinTransactionOperation } from "@standrig/core/joinTransaction";
import { runL2ReadinessQa } from "@standrig/core/l2ReadinessQa";
import { migrateRigDocument } from "@standrig/core/migration";
import { evaluateModelFreezeReadiness } from "@standrig/core/modelFreeze";
import { modelingPosePresetsForRig,modelingPoseValuesForRig } from "@standrig/core/modeling";
import { auditModelingRig } from "@standrig/core/modelingAudit";
import { executeModelingOperation,type ModelingOperation } from "@standrig/core/modelingOps";
import { modelingTechniqueGuideForRig } from "@standrig/core/modelingTechniqueGuide";
import { clampParameterValue,parameterDefinitionsForRig,previewParameterValuesForRig,writePreviewParameterValues } from "@standrig/core/parameters";
import { inferPartRole } from "@standrig/core/partRoles";
import { mouthPhonemeTargetsForRig } from "@standrig/core/phonemes";
import { runPhysicsTemporalQa } from "@standrig/core/physicsQa";
import { auditPhysicsSafety,type PhysicsSafetyOptions } from "@standrig/core/physicsSafety";
import { runPhysicsSettlingQa } from "@standrig/core/physicsSettlingQa";
import { decodePng } from "@standrig/core/png";
import { runQaCheck,type QaCheckRequest } from "@standrig/core/qaCheck";
import { renderQaFailureComparison,type QaFailureImageRequest } from "@standrig/core/qaFailureImage";
import { evaluateRigReadiness,type ReadinessLevel } from "@standrig/core/readiness";
import { calibrateRigReadiness } from "@standrig/core/readinessCalibration";
import { evaluateRecipePromotion } from "@standrig/core/recipePromotion";
import { referenceSheetDefinitionsForRig } from "@standrig/core/reference";
import { renderRigScreenshot,screenshotOptionsFromUrl } from "@standrig/core/serverRenderer";
import { deriveShadowSeparationAssets,type ShadowSeparationAssetRequest } from "@standrig/core/shadowSeparation";
import { auditArtMeshSkinning,generateArtMeshSkinning } from "@standrig/core/skinning";
import { runSkinningQa,type SkinningQaOptions } from "@standrig/core/skinningQa";
import { runSkinningRenderQa,type SkinningRenderQaOptions } from "@standrig/core/skinningRenderQa";
import { estimateSymmetryAxis,symmetryContractFromEstimate,symmetryContractWithInferredLinks } from "@standrig/core/symmetry";
import { auditAngleXSymmetry,auditSymmetryArtMeshBindings } from "@standrig/core/symmetryQa";
import { ensureRigTracking,normalizeTracking } from "@standrig/core/tracking";
import { createTrackingProfile,parseTrackingProfile,type TrackingProfile } from "@standrig/core/trackingProfile";
import type { ParameterBinding,ParameterValues,RigDeformer,RigDocument,RigPart,RigTracking,RigWarpPin,TrackingInputValues,TransformProperty } from "@standrig/core/types";
import { normalizeWarpDeformer } from "@standrig/core/warp";
import { applyWarpPinMirrorInDeformer,linkWarpPinMirrorInDeformer,unlinkWarpPinMirrorInDeformer } from "@standrig/core/warpPinLinks";
import { normalizeModelingTransactionResult } from "./modelingTransactionResult.js";

function sanitizeRigAssetPayload(rig: RigDocument): RigDocument {
  const sanitized = structuredClone(rig);
  for (const asset of sanitized.assets) if (asset.src.startsWith("data:")) asset.src = `asset://${asset.id}`;
  return sanitized;
}

export function fullRigRevision(rig: RigDocument): string {
  const source = JSON.stringify(rig);
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) { hash ^= source.charCodeAt(index); hash = Math.imul(hash, 0x01000193); }
  return `rig-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
interface ServerTransactionJournalEntry { id: string; appliedAt: string; revisionBefore: string; revisionAfter: string; operationIds: string[] }
const SERVER_TRANSACTION_JOURNAL: ServerTransactionJournalEntry[] = [];

interface ArtMeshSamplerLoadResult {
  samplers: Map<string, ArtMeshAlphaSampler>;
  requiredAssetIds: string[];
  loadedAssetIds: string[];
  skipped: Array<{ assetId: string; reason: string }>;
}

function operationTargetsPart(part: RigPart, operation: ModelingOperation): boolean {
  const target = operation.target;
  if (!target.partIds?.length && !target.roles?.length) return false;
  if (target.partIds?.length && !target.partIds.includes(part.id)) return false;
  if (target.roles?.length && (part.roleStatus !== "confirmed" || !part.role || !target.roles.includes(part.role))) return false;
  return true;
}

async function loadArtMeshAlphaSamplers(rig: RigDocument, publicDir: string, operations: ModelingOperation[]): Promise<ArtMeshSamplerLoadResult> {
  const alphaOperations = operations.filter((operation) => (operation.action.type === "artmesh-generate" || operation.action.type === "artmesh-rebuild") && (operation.action.topology ?? "rect-grid") === "alpha-contour");
  const requiredAssetIds = [...new Set(rig.parts
    .filter((part) => part.assetId && alphaOperations.some((operation) => operationTargetsPart(part, operation)))
    .map((part) => part.assetId!))];
  const samplers = new Map<string, ArtMeshAlphaSampler>();
  const loadedAssetIds: string[] = [];
  const skipped: Array<{ assetId: string; reason: string }> = [];
  for (const assetId of requiredAssetIds) {
    const asset = rig.assets.find((entry) => entry.id === assetId);
    if (!asset) { skipped.push({ assetId, reason: "missing-asset" }); continue; }
    try {
      const embedded = decodeDataUrl(asset.src);
      let bytes: Uint8Array;
      let mediaType = embedded?.mediaType ?? "";
      if (embedded) bytes = embedded.bytes;
      else {
        if (/^https?:\/\//i.test(asset.src)) throw new Error("remote-asset-unsupported");
        const assetPath = path.resolve(publicDir, asset.src.replace(/^\/+/, ""));
        if (assetPath !== publicDir && !assetPath.startsWith(publicDir + path.sep)) throw new Error("asset-path-escaped-public-directory");
        bytes = new Uint8Array(await readFile(assetPath));
        mediaType = path.extname(assetPath).toLowerCase() === ".png" ? "image/png" : "";
      }
      if (mediaType !== "image/png") throw new Error("unsupported-media-type:" + (mediaType || "unknown"));
      const image = decodePng(bytes);
      samplers.set(asset.id, createArtMeshAlphaSampler(asset, image));
      loadedAssetIds.push(asset.id);
    } catch (error) {
      skipped.push({ assetId, reason: "load-failed:" + String(error) });
    }
  }
  return { samplers, requiredAssetIds, loadedAssetIds, skipped };
}

function modelingOperationGateIssues(operations: ModelingOperation[], operationResults: ReturnType<typeof executeModelingOperation>[]) {
  const issues: Array<{ operationId: string; partId: string; reason: string }> = [];
  operations.forEach((operation, index) => {
    const result = operationResults[index];
    if (!result) return;
    const matched = new Set(result.matchedPartIds);
    if (operation.action.type === "role-confirm" || operation.action.type === "role-reclassify") {
      if (!result.matchedPartIds.length) {
        issues.push({ operationId: operation.id, partId: operation.target.partIds?.[0] ?? "unknown", reason: "no-matching-parts" });
        return;
      }
      for (const skipped of result.skipped) {
        if (matched.has(skipped.partId)) issues.push({ operationId: operation.id, partId: skipped.partId, reason: skipped.reason });
      }
      return;
    }
    for (const skipped of result.skipped) {
      if (!matched.has(skipped.partId)) continue;
      if (skipped.reason === "artmesh-exists") continue;
      issues.push({ operationId: operation.id, partId: skipped.partId, reason: skipped.reason });
    }
  });
  return issues;
}
function sendJson(res: import("node:http").ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body, null, 2));
}

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return readBodyLimited(req, 64 * 1024 * 1024);
}

function readBodyLimited(req: import("node:http").IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    let settled = false;
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      if (settled) return;
      size += Buffer.byteLength(chunk, "utf8");
      if (size > limit) {
        settled = true;
        reject(new Error(`request_body_too_large:${limit}`));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on("end", () => { if (!settled) { settled = true; resolve(body); } });
    req.on("error", (error) => { if (!settled) { settled = true; reject(error); } });
  });
}

function geometryAssistLocalPolicy(req: import("node:http").IncomingMessage): { allowed: boolean; reason?: string } {
  const origin = req.headers.origin;
  if (origin) {
    try {
      const hostname = new URL(origin).hostname.toLowerCase();
      if (!["localhost", "127.0.0.1", "::1"].includes(hostname)) return { allowed: false, reason: "origin_not_local" };
    } catch { return { allowed: false, reason: "origin_invalid" }; }
  }
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    const client = String(forwarded).split(",")[0].trim().toLowerCase();
    if (!["127.0.0.1", "::1", "localhost"].includes(client)) return { allowed: false, reason: "forwarded_client_not_local" };
  }
  return { allowed: true };
}
async function readRigFile(rigPath: string): Promise<RigDocument> {
  return migrateRigDocument(JSON.parse(await readFile(rigPath, "utf8")));
}

function compactContextForRig(rig: RigDocument) {
  const audit = auditModelingRig(rig);
  const physicsSafety = auditPhysicsSafety(rig);
  const physicsSettling = runPhysicsSettlingQa(rig);
  const roles = rig.parts.filter((part) => part.role && part.role !== "unknown").map((part) => ({ id: part.id, name: part.name, role: part.role, status: part.roleStatus ?? "unassigned" }));
  const semanticSource = JSON.stringify({ schemaVersion: rig.schemaVersion, name: rig.name, parts: rig.parts.map((part) => ({ id: part.id, parentId: part.parentId, role: part.role, bindings: part.bindings?.length ?? 0, blendMode: part.blendMode ?? "normal", tint: part.tint ?? null, artMesh: Boolean(part.artMesh), artPaths: (part.artPaths ?? []).map((path) => ({ id: path.id, points: path.points?.length ?? 0, bindings: path.bindings?.length ?? 0, strokeWidth: path.strokeWidth, opacity: path.opacity, enabled: path.enabled })) })), deformers: rig.deformers?.map((deformer) => ({ id: deformer.id, parentId: deformer.parentId, bindings: deformer.bindings?.length ?? 0 })), physics: rig.physics, symmetry: rig.symmetry });
  return {
    semanticHash: fnv1a(semanticSource),
    revision: fullRigRevision(rig),
    summary: summarizeRig(rig),
    modelFreeze: evaluateModelFreezeReadiness(rig),
    unresolvedIssues: audit.issues.filter((issue) => issue.severity === "error" || issue.severity === "warning").slice(0, 24),
    roles,
    physicsQa: runPhysicsTemporalQa(rig),
    physicsSafety: { pass: physicsSafety.pass, rootLockPass: physicsSafety.rootLock.pass, structuralViolations: physicsSafety.rootLock.violations.length, temporalStructuralMotion: physicsSafety.temporal.structuralMotion, chainCount: physicsSafety.chains.length, issues: physicsSafety.issues.slice(0, 12) },
    physicsSettling: { pass: physicsSettling.pass, finite: physicsSettling.finite, chainCount: physicsSettling.chains.length, issues: physicsSettling.issues.slice(0, 12) },
    operationHistory: { scope: "server-memory", available: true, entries: SERVER_TRANSACTION_JOURNAL.slice(-12) },
    assetPayloadPolicy: "no-data-url",
    symmetry: rig.symmetry ? { version: rig.symmetry.version, axis: rig.symmetry.axis, axisU: rig.symmetry.axisU, tolerance: rig.symmetry.tolerance, confidence: rig.symmetry.confidence, protectedPartCount: rig.symmetry.protectedPartIds.length, protectedDeformerCount: rig.symmetry.protectedDeformerIds.length, linkCount: rig.symmetry.links.length } : undefined
  };
}
function fnv1a(value: string): string { let hash = 0x811c9dc5; for (let index = 0; index < value.length; index += 1) { hash ^= value.charCodeAt(index); hash = Math.imul(hash, 0x01000193); } return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`; }
async function readRigFromRequestOrFile(req: import("node:http").IncomingMessage, rigPath: string): Promise<RigDocument> {
  if (req.method === "POST" || req.method === "PUT") {
    return migrateRigDocument(JSON.parse(await readBody(req)));
  }
  return readRigFile(rigPath);
}

function mouthPhonemeTargetsWithUrls(rig: RigDocument) {
  return mouthPhonemeTargetsForRig(rig).map((target) => {
    const params = new URLSearchParams({
      detail: "mouth",
      width: "180",
      height: "180",
      padding: "24",
      transparent: "1",
      forceParts: "1",
      partId: target.sourcePartId
    });
    const previewParams = new URLSearchParams();
    const setNumberParam = (queryKey: string, parameterId: string) => {
      const value = target.values[parameterId];
      if (typeof value === "number" && Number.isFinite(value)) {
        params.set(queryKey, String(value));
        previewParams.set(queryKey, String(value));
      }
    };
    setNumberParam("mouthOpen", "ParamMouthOpen");
    setNumberParam("mouthForm", "ParamMouthForm");
    setNumberParam("mouthSmile", "ParamMouthSmile");
    const screenshotUrl = `/api/screenshot?${params.toString()}`;
    const previewQuery = previewParams.toString();
    return {
      ...target,
      screenshotUrl,
      referenceUrl: screenshotUrl,
      previewUrl: previewQuery ? `/preview?${previewQuery}` : "/preview"
    };
  });
}
async function writeRigFile(rigPath: string, rig: RigDocument) {
  await writeJsonFile(rigPath, rig);
}
async function writeJsonFile(filePath: string, value: unknown) {
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}
`, "utf8");
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rename(tmpPath, filePath);
      return;
    } catch (error) {
      if (attempt === 9 || !isRetryableFileReplaceError(error)) {
        throw error;
      }
      await delay(25 * (attempt + 1));
    }
  }
}

function isRetryableFileReplaceError(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
  return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseJsonObject(raw: string): Record<string, unknown> {
  const parsed = raw ? JSON.parse(raw) : {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Request body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}


function deformerRouteId(req: import("node:http").IncomingMessage): string | undefined {
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = decodeURIComponent(url.pathname).replace(/^\/api\/deformers\/?/, "").replace(/^\//, "");
  return pathname || undefined;
}

function glueCandidateRouteId(req: import("node:http").IncomingMessage): string | undefined {
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = decodeURIComponent(url.pathname).replace(/^\/api\/glue-candidates\/?/, "").replace(/^\//, "");
  return pathname || undefined;
}

function glueRouteId(req: import("node:http").IncomingMessage): string | undefined {
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = decodeURIComponent(url.pathname).replace(/^\/api\/glue\/?/, "").replace(/^\//, "");
  return pathname || undefined;
}
function trackingArtifactId(value: unknown, fallback: string): string {
  const raw = typeof value === "string" && value.trim() ? value.trim() : fallback;
  const normalized = raw.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return normalized || fallback;
}

function trackingRouteId(req: import("node:http").IncomingMessage, prefix: string): string | undefined {
  const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
  const id = pathname.replace(new RegExp(`^${prefix}/?`), "").replace(/^\//, "");
  return id && /^[a-zA-Z0-9_-]+$/.test(id) ? id : undefined;
}
function assignedPartIdsForDeformer(rig: RigDocument, deformer: RigDeformer): string[] {
  const targetIds = new Set(deformer.targetPartIds ?? []);
  return rig.parts.filter((part) => part.deformerId === deformer.id || targetIds.has(part.id)).map((part) => part.id);
}

function deformerListItem(rig: RigDocument, deformer: RigDeformer) {
  const assignedPartIds = assignedPartIdsForDeformer(rig, deformer);
  return {
    id: deformer.id,
    name: deformer.name,
    kind: deformer.kind,
    parentId: deformer.parentId,
    visible: deformer.visible,
    origin: deformer.origin,
    targetPartIds: deformer.targetPartIds ?? [],
    assignedPartIds,
    assignedPartCount: assignedPartIds.length,
    tags: deformer.tags ?? [],
    rotationMetadata: deformer.rotationMetadata
  };
}

function patchDeformer(deformer: RigDeformer, rawPatch: Record<string, unknown>, rig: RigDocument) {
  const patch = (rawPatch.deformer && typeof rawPatch.deformer === "object" && !Array.isArray(rawPatch.deformer)
    ? rawPatch.deformer
    : rawPatch) as Partial<RigDeformer> & { origin?: Partial<RigDeformer["origin"]>; transform?: Partial<RigDeformer["transform"]> };

  if (patch.id !== undefined && patch.id !== deformer.id) {
    throw new Error("Changing deformer.id through PATCH is not supported.");
  }
  if (typeof patch.name === "string") {
    deformer.name = patch.name;
  }
  if (patch.kind === "group" || patch.kind === "rotate" || patch.kind === "warp") {
    deformer.kind = patch.kind;
  }
  if (patch.parentId === null || typeof patch.parentId === "string") {
    deformer.parentId = patch.parentId;
  }
  if (typeof patch.visible === "boolean") {
    deformer.visible = patch.visible;
  }
  if (typeof patch.locked === "boolean") {
    deformer.locked = patch.locked;
  }
  if (Array.isArray(patch.tags)) {
    deformer.tags = patch.tags.filter((tag): tag is string => typeof tag === "string");
  }
  if (Array.isArray(patch.bindings)) {
    deformer.bindings = patch.bindings;
  }
  if (Array.isArray(patch.targetPartIds)) {
    deformer.targetPartIds = patch.targetPartIds.filter((id): id is string => typeof id === "string");
  }
  if (patch.origin && typeof patch.origin === "object") {
    for (const [key, value] of Object.entries(patch.origin)) {
      if ((key === "x" || key === "y") && typeof value === "number" && Number.isFinite(value)) {
        deformer.origin[key] = value;
      }
    }
  }
  if (patch.transform && typeof patch.transform === "object") {
    for (const [key, value] of Object.entries(patch.transform)) {
      if (typeof value === "number" && Number.isFinite(value) && key in deformer.transform) {
        deformer.transform[key as keyof RigDeformer["transform"]] = value;
      }
    }
  }
  normalizeDeformer(deformer, rig);
}
function compactCorrespondenceAction(action: ModelingOperation["action"]) {
  if (action.type === "artmesh-binding-key") return { type: action.type, parameter: action.parameter, input: action.input, offsetCount: action.offsets.length, interpolation: action.interpolation };
  if (action.type === "artmesh-multi-key") return { type: action.type, parameters: action.parameters, inputs: action.inputs, offsetCount: action.offsets.length, interpolation: action.interpolation };
  return { type: action.type };
}function partRouteId(req: import("node:http").IncomingMessage): string | undefined {
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = decodeURIComponent(url.pathname).replace(/^\/api\/parts\/?/, "").replace(/^\//, "");
  return pathname || undefined;
}

function partListItem(part: RigPart) {
  return {
    id: part.id,
    name: part.name,
    kind: part.kind,
    parentId: part.parentId,
    visible: part.visible,
    drawOrder: part.drawOrder,
    assetId: part.assetId,
    deformerId: part.deformerId ?? null,
    blendMode: part.blendMode ?? "normal",
    tint: part.tint ?? null,
    clip: part.clip ?? null,
    tags: part.tags ?? []
  };
}

function patchPart(part: RigPart, rawPatch: Record<string, unknown>) {
  const patch = (rawPatch.part && typeof rawPatch.part === "object" && !Array.isArray(rawPatch.part)
    ? rawPatch.part
    : rawPatch) as Partial<RigPart> & { transform?: Partial<RigPart["transform"]> };

  if (patch.id !== undefined && patch.id !== part.id) {
    throw new Error("Changing part.id through PATCH is not supported.");
  }
  if (patch.kind !== undefined && patch.kind !== part.kind) {
    throw new Error("Changing part.kind through PATCH is not supported.");
  }
  if (patch.assetId !== undefined && patch.assetId !== part.assetId) {
    throw new Error("Changing part.assetId through PATCH is not supported.");
  }

  if (typeof patch.name === "string") {
    part.name = patch.name;
  }
  if (patch.parentId === null || typeof patch.parentId === "string") {
    part.parentId = patch.parentId;
  }
  if (patch.deformerId === null || typeof patch.deformerId === "string") {
    part.deformerId = patch.deformerId;
  }
  if (patch.blendMode !== undefined) {
    if (patch.blendMode === "multiply" || patch.blendMode === "screen" || patch.blendMode === "additive") {
      part.blendMode = patch.blendMode;
    } else if (patch.blendMode === "normal") {
      delete part.blendMode;
    } else {
      throw new Error("blendMode must be normal, multiply, screen, or additive.");
    }
  }
  const rawTint = (patch as { tint?: unknown }).tint;
  if (rawTint !== undefined) {
    if (rawTint === null) delete part.tint;
    else if (typeof rawTint === "object" && !Array.isArray(rawTint)) {
      const tint = rawTint as RigPart["tint"];
      if (!tint || (tint.mode !== "multiply" && tint.mode !== "screen") || typeof tint.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(tint.color) || !Number.isFinite(tint.opacity) || tint.opacity < 0 || tint.opacity > 1) throw new Error("tint must contain mode, #RRGGBB color, and opacity 0..1.");
      part.tint = { mode: tint.mode, color: tint.color.toLowerCase(), opacity: tint.opacity };
    } else throw new Error("tint must be null or an object.");
  }
  const rawClip = (patch as { clip?: unknown }).clip;
  if (rawClip !== undefined) {
    if (rawClip === null) {
      delete part.clip;
    } else if (typeof rawClip === "object" && !Array.isArray(rawClip)) {
      const clip = rawClip as { mode?: unknown; maskPartId?: unknown; maskPartIds?: unknown; maskOpacity?: unknown };
      const hasSingleSource = typeof clip.maskPartId === "string" && clip.maskPartId.trim().length > 0;
      const rawMaskPartIds = Array.isArray(clip.maskPartIds) ? clip.maskPartIds : clip.maskPartIds === undefined ? undefined : null;
      const hasArraySource = rawMaskPartIds !== undefined;
      const validMultipleSources = Array.isArray(rawMaskPartIds) && rawMaskPartIds.length >= 1 && rawMaskPartIds.length <= 8 && rawMaskPartIds.every((id): id is string => typeof id === "string" && id.trim().length > 0 && id === id.trim()) && new Set(rawMaskPartIds).size === rawMaskPartIds.length;
      const maskPartIds = validMultipleSources ? rawMaskPartIds : undefined;
      const validMaskOpacity = clip.maskOpacity === undefined || clip.maskOpacity === "rendered" || clip.maskOpacity === "ignore";
      if (clip.mode !== "alpha" || hasSingleSource === hasArraySource || (hasArraySource && !validMultipleSources) || !validMaskOpacity) {
        throw new Error("clip must use exactly one of maskPartId or 1-8 unique trimmed maskPartIds; maskOpacity is rendered or ignore.");
      }      if (hasSingleSource) {
        part.clip = { mode: "alpha", maskPartId: clip.maskPartId as string, ...(clip.maskOpacity ? { maskOpacity: clip.maskOpacity as "rendered" | "ignore" } : {}) };
      } else {
        part.clip = { mode: "alpha", maskPartIds: maskPartIds!.map((id) => id), ...(clip.maskOpacity ? { maskOpacity: clip.maskOpacity as "rendered" | "ignore" } : {}) };
      }
    } else {
      throw new Error("clip must be { mode: 'alpha', maskPartId | maskPartIds } or null.");
    }
  }  if (typeof patch.visible === "boolean") {
    part.visible = patch.visible;
  }
  if (typeof patch.locked === "boolean") {
    part.locked = patch.locked;
  }
  if (typeof patch.drawOrder === "number" && Number.isFinite(patch.drawOrder)) {
    part.drawOrder = patch.drawOrder;
  }
  if (Array.isArray(patch.tags)) {
    part.tags = patch.tags.filter((tag): tag is string => typeof tag === "string");
  }
  if (Array.isArray(patch.bindings)) {
    part.bindings = patch.bindings;
  }
  if (patch.transform && typeof patch.transform === "object") {
    for (const [key, value] of Object.entries(patch.transform)) {
      if (typeof value === "number" && Number.isFinite(value) && key in part.transform) {
        part.transform[key as keyof RigPart["transform"]] = value;
      }
    }
  }
}

function trackingPatchFromBody(body: Record<string, unknown>, rig: RigDocument): RigTracking {
  const current = ensureRigTracking(rig);
  const source = body.tracking && typeof body.tracking === "object" && !Array.isArray(body.tracking) ? (body.tracking as Record<string, unknown>) : body;
  return normalizeTracking(
    {
      ...current,
      ...source,
      mappings: Array.isArray(source.mappings) ? (source.mappings as RigTracking["mappings"]) : current.mappings
    } as RigTracking,
    rig
  );
}

function trackingInputFromBody(body: Record<string, unknown>): Partial<TrackingInputValues> {
  const source = body.values && typeof body.values === "object" && !Array.isArray(body.values) ? body.values : body;
  const values: Partial<TrackingInputValues> = {};
  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      values[key] = value;
    }
  }
  return values;
}
function parameterPatchFromBody(body: Record<string, unknown>): Partial<ParameterValues> {
  const source = body.values && typeof body.values === "object" && !Array.isArray(body.values) ? body.values : body;
  const values: Partial<ParameterValues> = {};
  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      values[key] = value;
    }
  }
  return values;
}


const PART_KEY_PROPERTIES = new Set<string>(["x", "y", "rotation", "scaleX", "scaleY", "opacity"]);

function isPartKeyProperty(value: unknown): value is TransformProperty {
  return typeof value === "string" && PART_KEY_PROPERTIES.has(value);
}

function neutralPartKeyValue(property: TransformProperty): number {
  return property === "scaleX" || property === "scaleY" || property === "opacity" ? 1 : 0;
}

function ensurePartModelingBinding(
  part: RigPart,
  parameter: string,
  property: TransformProperty,
  rig: RigDocument,
  options: { additive?: boolean; interpolation?: ParameterBinding["interpolation"] } = {}
): ParameterBinding {
  part.bindings ??= [];
  const existing = part.bindings.find((binding) => binding.parameter === parameter && binding.property === property);
  if (existing) {
    existing.keys ??= [];
    if (typeof options.additive === "boolean") {
      existing.additive = options.additive;
    }
    if (options.interpolation) {
      existing.interpolation = options.interpolation;
    }
    return existing;
  }

  const definition = parameterDefinitionsForRig(rig).find((entry) => entry.id === parameter);
  const binding: ParameterBinding = {
    parameter,
    property,
    additive: options.additive ?? true,
    interpolation: options.interpolation ?? "smoothstep",
    keys: [{ input: definition?.default ?? 0, value: 0 }]
  };
  part.bindings.push(binding);
  return binding;
}

function upsertModelingBindingKey(binding: ParameterBinding, input: number, value: number) {
  binding.keys ??= [];
  const existing = binding.keys.find((key) => Math.abs(key.input - input) < 0.0001);
  if (existing) {
    existing.input = input;
    existing.value = value;
  } else {
    binding.keys.push({ input, value });
  }
  binding.keys.sort((left, right) => left.input - right.input);
}

function modelingPartKeySummary(part: RigPart) {
  return {
    id: part.id,
    name: part.name,
    kind: part.kind,
    bindingCount: part.bindings?.length ?? 0,
    bindings: part.bindings ?? []
  };
}

function modelingInterpolation(value: unknown): ParameterBinding["interpolation"] | undefined {
  return value === "linear" || value === "smoothstep" || value === "hold" || value === "arc" || value === "curve" ? value : undefined;
}

function warpPinMirrorAction(value: unknown): "link" | "apply" | "unlink" | undefined {
  return value === "link" || value === "apply" || value === "unlink" ? value : undefined;
}

function resolveWarpPinIndexForApi(pins: RigWarpPin[], pinIdOrIndex: unknown): number {
  const pinIndex = typeof pinIdOrIndex === "number"
    ? pinIdOrIndex
    : typeof pinIdOrIndex === "string"
      ? pins.findIndex((pin) => pin.id === pinIdOrIndex)
      : -1;
  return Number.isInteger(pinIndex) && pinIndex >= 0 && pinIndex < pins.length ? pinIndex : -1;
}
export function registerModelingApi(rootDir: string, server: ApiHost): void {
  const publicDir = path.resolve(rootDir, "public");
  const rigPath = path.resolve(publicDir, "rig.json");
  const schemaPath = path.resolve(publicDir, "rig.schema.json");
  const trackingProfilePath = path.resolve(publicDir, "tracking-profile.json");
  const trackingRecordingsDir = path.resolve(publicDir, "tracking-recordings");
  const trackingRunsDir = path.resolve(rootDir, "tracking-runs");
  const assetManifestPath = path.resolve(publicDir, "assets-manifest.json");
  const assetsDir = path.resolve(publicDir, "assets");
  const goldenRoot = path.resolve(publicDir, "goldens");

  const readTrackingProfileFile = async (rig: RigDocument): Promise<TrackingProfile | undefined> => {
    const raw = await readFile(trackingProfilePath, "utf8").catch(() => undefined);
    if (raw === undefined) {
      return undefined;
    }
    try {
      return parseTrackingProfile(JSON.parse(raw), rig);
    } catch (_error) {
      return undefined;
    }
  };


      server.middlewares.use("/api/health", (_req, res) => {
        sendJson(res, 200, {
          ok: true,
          app: "standrig-modeling-tools",
          version: "0.2.0",
          capabilities: { modeling: true, playback: true, mcp: "separate-stdio-process", tracker: "external", obs: "external-browser-source", live2dBridge: false },
          endpoints: ["/api/health","/api/schema","/api/assets/externalize","/api/assets/alpha-bleed","/api/assets/shadow-separation","/api/qa/exposure","/api/qa/check","/api/qa/symmetry-angle-x","/api/qa/symmetry-artmesh-bindings","/api/generation/requests/from-exposure","/api/generation/requests","/api/generation/accept","/api/generation/assets","/api/generation/regenerate","/api/generation/delete","/api/qa/joins","/api/qa/failure-image","/api/changes","/api/geometry/export","/api/context","/api/readiness/calibration","/api/readiness/l2-qa","/api/readiness/promotion","/api/readiness","/api/rig/summary","/api/rig/validate","/api/rig/inspect","/api/modeling/audit","/api/audit/modeling","/api/modeling/symmetry-artmesh-candidates","/api/modeling/symmetry-artmesh-transaction-dry-run","/api/modeling/head-proxy/calibrate","/api/modeling/correspondence","/api/modeling/physics-safety","/api/modeling/skinning-candidates","/api/modeling/skinning-approval","/api/modeling/head-proxy","/api/modeling/symmetry","/api/qa/golden","/api/modeling/join-transaction","/api/qa/art-paths","/api/modeling/art-path-transaction","/api/modeling/transaction","/api/modeling/role-suggestions","/api/modeling/artmesh-presets","/api/modeling/part-key","/api/modeling/warp-pin-mirror","/api/modeling/techniques","/api/modeling","/api/reference/sheet","/api/reference","/api/phonemes","/api/screenshot","/api/glue/vertex-pairs","/api/glue-candidates","/api/glue","/api/parts","/api/deformers","/api/bundle","/api/params","/api/rig","/api/sample","/api/playback","/api/playback/events","/api/playback/parameters","/api/playback/control","/api/playback/reload","/api/checkpoints","/api/checkpoints/restore","/api/exports/bundle"],
          rigPath
        });
      });

      

      server.middlewares.use("/api/schema", async (_req, res) => {
        try {
          res.statusCode = 200;
          res.setHeader("content-type", "application/schema+json; charset=utf-8");
          res.end(await readFile(schemaPath, "utf8"));
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error) });
        }
      });

      server.middlewares.use("/api/assets/externalize", async (req, res) => {
        try {
          if (req.method === "GET") {
            const rig = await readRigFile(rigPath);
            const manifestRaw = await readFile(assetManifestPath, "utf8").catch(() => undefined);
            const manifest = manifestRaw ? JSON.parse(manifestRaw) : undefined;
            sendJson(res, 200, { ok: true, diagnostics: diagnoseRigAssets(rig, manifest), manifest });
            return;
          }
          if (req.method !== "POST" && req.method !== "PUT") { sendJson(res, 405, { ok: false, error: "method not allowed" }); return; }
          const body = parseJsonObject(await readBody(req));
          const sourceRig = migrateRigDocument(body.rig ?? body);
          const dryRun = body.dryRun !== false;
          const externalized = await externalizeRigAssets(sourceRig, "/assets");
          const validation = validateRig(externalized.rig);
          const originalBytes = Buffer.byteLength(JSON.stringify(sourceRig));
          const rigBytes = Buffer.byteLength(JSON.stringify(externalized.rig));
          const summary = { assetEntries: externalized.manifest.entries.length, uniqueFiles: externalized.files.size, originalBytes, rigBytes, savedBytes: Math.max(0, originalBytes - rigBytes) };
          if (!validation.ok) { sendJson(res, 400, { ok: false, error: "externalized rig is invalid", validation, summary }); return; }
          if (!dryRun) {
            await mkdir(assetsDir, { recursive: true });
            for (const [assetUrl, bytes] of externalized.files) {
              const destination = path.resolve(publicDir, assetUrl.replace(/^\/+/, ""));
              if (destination !== assetsDir && !destination.startsWith(assetsDir + path.sep)) throw new Error("Asset path escaped public/assets");
              await writeFile(destination, bytes);
            }
            await writeJsonFile(assetManifestPath, externalized.manifest);
            await writeRigFile(rigPath, externalized.rig);
          }
          sendJson(res, 200, { ok: true, dryRun, summary, manifest: externalized.manifest, rig: externalized.rig, diagnostics: diagnoseRigAssets(externalized.rig, externalized.manifest) });
        } catch (error) { sendJson(res, 500, { ok: false, error: String(error) }); }
      });
      server.middlewares.use("/api/assets/alpha-bleed", async (req, res) => {
        try {
          if (req.method !== "POST") { sendJson(res, 405, { ok: false, error: "method not allowed; use POST" }); return; }
          const body = parseJsonObject(await readBody(req)) as AlphaBleedAssetRequest & { dryRun?: boolean };
          const dryRun = body.dryRun !== false;
          const rig = await readRigFile(rigPath);
          const result = await deriveAlphaBleedAssets(rig, body, async (asset) => {
            const embedded = decodeDataUrl(asset.src);
            if (embedded) return embedded;
            const sourcePath = path.resolve(publicDir, asset.src.replace(/^\/+/, ""));
            if (sourcePath !== publicDir && !sourcePath.startsWith(publicDir + path.sep)) throw new Error(`Asset path escaped public directory: ${asset.id}`);
            const mediaType = path.extname(sourcePath).toLowerCase() === ".png" ? "image/png" : "application/octet-stream";
            return { mediaType, bytes: new Uint8Array(await readFile(sourcePath)) };
          });
          const existingManifest = await readFile(assetManifestPath, "utf8")
            .then((raw) => JSON.parse(raw) as RigAssetManifest)
            .catch(() => ({ format: ASSET_MANIFEST_FORMAT, version: 1 as const, entries: [] }));
          const manifestByAsset = new Map(existingManifest.entries.map((entry) => [entry.assetId, entry]));
          for (const entry of result.manifestEntries) manifestByAsset.set(entry.assetId, entry);
          const manifest: RigAssetManifest = { format: ASSET_MANIFEST_FORMAT, version: 1, entries: [...manifestByAsset.values()] };
          const validation = validateRig(result.rig);
          if (!validation.ok) { sendJson(res, 400, { ok: false, error: "alpha-bleed candidate rig is invalid", validation, assets: result.assets, skipped: result.skipped }); return; }
          if (!dryRun && result.changed) {
            await mkdir(assetsDir, { recursive: true });
            for (const [assetUrl, bytes] of result.files) {
              const destination = path.resolve(publicDir, assetUrl.replace(/^\/+/, ""));
              if (destination !== assetsDir && !destination.startsWith(assetsDir + path.sep)) throw new Error("Alpha bleed asset path escaped public/assets");
              await writeFile(destination, bytes);
            }
            await writeJsonFile(assetManifestPath, manifest);
            await writeRigFile(rigPath, result.rig);
            server.ws.send({ type: "full-reload" });
          }
          sendJson(res, 200, {
            ok: true,
            dryRun,
            changed: result.changed,
            scope: body.assetIds?.length ? "assetIds" : body.partIds?.length ? "partIds" : body.scope ?? "artmesh",
            summary: {
              processedAssets: result.assets.length,
              skippedAssets: result.skipped.length,
              rewiredParts: result.assets.reduce((total, entry) => total + entry.rewiredPartIds.length, 0),
              changedPixels: result.assets.reduce((total, entry) => total + entry.audit.changedPixelCount, 0),
              outputBytes: [...result.files.values()].reduce((total, bytes) => total + bytes.byteLength, 0)
            },
            assets: result.assets,
            skipped: result.skipped,
            manifestEntries: result.manifestEntries,
            validation,
            rig: sanitizeRigAssetPayload(result.rig)
          });
        } catch (error) { sendJson(res, 400, { ok: false, error: String(error) }); }
      });
      server.middlewares.use("/api/assets/shadow-separation", async (req, res) => {
        try {
          if (req.method !== "POST") { sendJson(res, 405, { ok: false, error: "method not allowed; use POST" }); return; }
          const body = parseJsonObject(await readBody(req)) as ShadowSeparationAssetRequest & { dryRun?: boolean; expectedRevision?: string };
          const dryRun = body.dryRun !== false;
          const rig = await readRigFile(rigPath);
          const currentRevision = fullRigRevision(rig);
          if (body.expectedRevision && body.expectedRevision !== currentRevision) {
            sendJson(res, 409, { ok: false, error: "revision-mismatch", expectedRevision: body.expectedRevision, currentRevision });
            return;
          }
          if (!dryRun && !body.expectedRevision) {
            sendJson(res, 400, { ok: false, error: "expectedRevision is required for shadow-separation commit" });
            return;
          }
          const result = await deriveShadowSeparationAssets(rig, body, async (asset) => {
            const embedded = decodeDataUrl(asset.src);
            if (embedded) return embedded;
            const sourcePath = path.resolve(publicDir, asset.src.replace(/^\/+/, ""));
            if (sourcePath !== publicDir && !sourcePath.startsWith(publicDir + path.sep)) throw new Error(`Asset path escaped public directory: ${asset.id}`);
            const mediaType = path.extname(sourcePath).toLowerCase() === ".png" ? "image/png" : "application/octet-stream";
            return { mediaType, bytes: new Uint8Array(await readFile(sourcePath)) };
          });
          const shadowQa = {
            ok: result.assets.length > 0 && result.assets.every((entry) => entry.audit.reconstructionPass && entry.audit.alphaChangedPixelCount === 0),
            entries: result.assets.map((entry) => ({ sourceAssetId: entry.sourceAssetId, neutralAssetId: entry.neutralAssetId, shadowAssetId: entry.shadowAssetId, audit: entry.audit }))
          };
          const validation = validateRig(result.rig);
          if (!validation.ok || !shadowQa.ok) {
            sendJson(res, 400, { ok: false, error: !validation.ok ? "shadow-separation candidate rig is invalid" : "shadow-separation reconstruction gate failed", validation, shadowQa, assets: result.assets, skipped: result.skipped, rig: sanitizeRigAssetPayload(result.rig) });
            return;
          }
          const existingManifest = await readFile(assetManifestPath, "utf8")
            .then((raw) => JSON.parse(raw) as RigAssetManifest)
            .catch(() => ({ format: ASSET_MANIFEST_FORMAT, version: 1 as const, entries: [] }));
          const manifestByAsset = new Map(existingManifest.entries.map((entry) => [entry.assetId, entry]));
          for (const entry of result.manifestEntries) manifestByAsset.set(entry.assetId, entry);
          const manifest: RigAssetManifest = { format: ASSET_MANIFEST_FORMAT, version: 1, entries: [...manifestByAsset.values()] };
          if (!dryRun && result.changed) {
            await mkdir(assetsDir, { recursive: true });
            for (const [assetUrl, bytes] of result.files) {
              const destination = path.resolve(publicDir, assetUrl.replace(/^\/+/, ""));
              if (destination !== assetsDir && !destination.startsWith(assetsDir + path.sep)) throw new Error("Shadow separation asset path escaped public/assets");
              await writeFile(destination, bytes);
            }
            await writeJsonFile(assetManifestPath, manifest);
            await writeRigFile(rigPath, result.rig);
            server.ws.send({ type: "full-reload" });
          }
          sendJson(res, 200, {
            ok: true,
            dryRun,
            changed: result.changed,
            expectedRevision: body.expectedRevision ?? currentRevision,
            currentRevision,
            summary: {
              processedAssets: result.assets.length,
              skippedAssets: result.skipped.length,
              rewiredParts: result.assets.reduce((total, entry) => total + entry.rewiredPartIds.length, 0),
              shadowParts: result.assets.reduce((total, entry) => total + entry.shadowPartIds.length, 0),
              outputBytes: [...result.files.values()].reduce((total, bytes) => total + bytes.byteLength, 0)
            },
            shadowQa,
            assets: result.assets,
            skipped: result.skipped,
            manifestEntries: result.manifestEntries,
            validation,
            rig: sanitizeRigAssetPayload(result.rig)
          });
        } catch (error) { sendJson(res, 400, { ok: false, error: String(error) }); }
      });      server.middlewares.use("/api/qa/exposure", async (req, res) => {
        try {
          if (req.method !== "POST") { sendJson(res, 405, { ok: false, error: "method not allowed; use POST" }); return; }
          const body = parseJsonObject(await readBody(req)) as ExposureSweepRequest;
          const rig = await readRigFile(rigPath);
          const result = await runExposureSweep(rig, publicDir, body);
          sendJson(res, 200, { ok: result.ok, revision: fullRigRevision(rig), result });
        } catch (error) { sendJson(res, 400, { ok: false, error: String(error) }); }
      });      server.middlewares.use("/api/qa/check", async (req, res) => {
        try {
          if (req.method !== "POST") { sendJson(res, 405, { ok: false, error: "method not allowed; use POST" }); return; }
          const body = parseJsonObject(await readBody(req)) as QaCheckRequest;
          const rig = await readRigFile(rigPath);
          const result = await runQaCheck(rig, publicDir, body);
          sendJson(res, 200, { ...result, revision: fullRigRevision(rig) });
        } catch (error) { sendJson(res, 400, { ok: false, error: String(error) }); }
      });
      server.middlewares.use("/api/qa/symmetry-angle-x", async (req, res) => {
        try {
          if (req.method !== "GET") { sendJson(res, 405, { ok: false, error: "method not allowed; use GET" }); return; }
          const current = await readRigFile(rigPath);
          const url = new URL(req.url ?? "/api/qa/symmetry-angle-x", "http://localhost");
          const sample = Number(url.searchParams.get("sample"));
          const tolerance = Number(url.searchParams.get("tolerance"));
          const includePassing = url.searchParams.get("includePassing") === "1";
          const audit = auditAngleXSymmetry(current, {
            sample: Number.isFinite(sample) && sample > 0 ? sample : undefined,
            tolerance: Number.isFinite(tolerance) && tolerance > 0 ? tolerance : undefined,
            includePassing
          });
          sendJson(res, 200, { ok: audit.pass, revision: fullRigRevision(current), audit });
        } catch (error) { sendJson(res, 400, { ok: false, error: String(error) }); }
      });
      server.middlewares.use("/api/qa/symmetry-artmesh-bindings", async (req, res) => {
        try {
          if (req.method !== "GET") { sendJson(res, 405, { ok: false, error: "method not allowed; use GET" }); return; }
          const current = await readRigFile(rigPath);
          const audit = auditSymmetryArtMeshBindings(current);
          sendJson(res, 200, { ok: true, revision: fullRigRevision(current), audit });
        } catch (error) { sendJson(res, 400, { ok: false, error: String(error) }); }
      });
      server.middlewares.use("/api/generation/requests/from-exposure", async (req, res) => {
        try {
          if (req.method !== "POST") { sendJson(res, 405, { ok: false, error: "method not allowed; use POST" }); return; }
          const body = parseJsonObject(await readBody(req)) as ExposureSweepRequest & { role?: string; prompt?: string; targetWidth?: number; targetHeight?: number; maxRequests?: number };
          const rig = await readRigFile(rigPath);
          const revision = fullRigRevision(rig);
          const exposure = await runExposureSweep(rig, publicDir, body);
          const maxRequests = Math.max(1, Math.min(32, Math.round(Number(body.maxRequests) || 8)));
          const requests = [];
          for (const entry of exposure.suspect.slice(0, maxRequests)) {
            const request = await createGenerationRequest(rig, publicDir, revision, {
              role: body.role ?? entry.region,
              region: entry.region,
              prompt: body.prompt ?? "inpaint exposed " + entry.region + " while preserving the source style",
              targetWidth: body.targetWidth,
              targetHeight: body.targetHeight,
              provenance: {
                trigger: "exposure-qa",
                sweepRevision: revision,
                poseId: entry.poseId,
                exposedPixels: entry.exposedPixels,
                exposedRatio: entry.exposedRatio,
                lostPixels: entry.lostPixels,
                exposedBBox: entry.exposedBBox ?? null
              }
            });
            requests.push(request);
          }
          sendJson(res, 201, { ok: true, revision, exposure: { ok: exposure.ok, summary: exposure.summary, suspect: exposure.suspect }, requests, capped: exposure.suspect.length > requests.length });
        } catch (error) { sendJson(res, 400, { ok: false, error: String(error) }); }
      });
      server.middlewares.use("/api/generation/requests", async (req, res) => {
        try {
          const requestUrl = new URL(req.url ?? "/", "http://localhost");
          const requestId = decodeURIComponent(requestUrl.pathname.replace(/^\/+/, ""));
          if (req.method === "GET") {
            if (requestId) {
              const request = getGenerationRequest(requestId);
              if (!request) { sendJson(res, 404, { ok: false, error: "generation request not found" }); return; }
              sendJson(res, 200, { ok: true, request });
              return;
            }
            sendJson(res, 200, { ok: true, requests: listGenerationRequests() });
            return;
          }
          if (req.method !== "POST") { sendJson(res, 405, { ok: false, error: "method not allowed; use GET or POST" }); return; }
          const body = parseJsonObject(await readBody(req)) as GenerationRequestInput;
          const rig = await readRigFile(rigPath);
          const request = await createGenerationRequest(rig, publicDir, fullRigRevision(rig), body);
          sendJson(res, 201, { ok: true, request });
        } catch (error) { sendJson(res, 400, { ok: false, error: String(error) }); }
      });
      server.middlewares.use("/api/generation/accept", async (req, res) => {
        try {
          if (req.method !== "POST") { sendJson(res, 405, { ok: false, error: "method not allowed; use POST" }); return; }
          const body = parseJsonObject(await readBody(req)) as unknown as GenerationAcceptanceInput;
          const rig = await readRigFile(rigPath);
          const result = await evaluateGenerationAsset(rig, publicDir, fullRigRevision(rig), body);
          let commit: { manifestPath: string; provenancePath: string } | undefined;
          if (result.accepted && result.requestedCommit) commit = await persistAcceptedGeneration(publicDir, result);
          const { bytes, ...safeResult } = result;
          sendJson(res, 200, { ...safeResult, committed: Boolean(commit), commit });
        } catch (error) { sendJson(res, 400, { ok: false, error: String(error) }); }
      });      server.middlewares.use("/api/generation/assets", async (req, res) => {
        try {
          if (req.method !== "GET") { sendJson(res, 405, { ok: false, error: "method not allowed; use GET" }); return; }
          const listing = await listPersistedGeneratedAssets(publicDir);
          const active = listing.entries.filter((entry) => entry.status !== "deleted");
          sendJson(res, 200, { ok: true, assets: active, historyCount: listing.entries.length });
        } catch (error) { sendJson(res, 400, { ok: false, error: String(error) }); }
      });
      server.middlewares.use("/api/generation/regenerate", async (req, res) => {
        try {
          if (req.method !== "POST") { sendJson(res, 405, { ok: false, error: "method not allowed; use POST" }); return; }
          const body = parseJsonObject(await readBody(req)) as { assetId?: string; requestId?: string; prompt?: string; provenance?: Record<string, unknown>; acceptance?: Record<string, unknown>; targetWidth?: number; targetHeight?: number };
          if (!body.assetId && !body.requestId) { sendJson(res, 400, { ok: false, error: "assetId or requestId is required" }); return; }
          const rig = await readRigFile(rigPath);
          const request = await regenerateGenerationRequest(rig, publicDir, fullRigRevision(rig), body);
          sendJson(res, 201, { ok: true, request, lineage: { parentAssetId: body.assetId ?? null, parentRequestId: body.requestId ?? null, generationIndex: request.provenance.generationIndex ?? null } });
        } catch (error) { sendJson(res, 400, { ok: false, error: String(error) }); }
      });
      server.middlewares.use("/api/generation/delete", async (req, res) => {
        try {
          if (req.method !== "POST" && req.method !== "DELETE") { sendJson(res, 405, { ok: false, error: "method not allowed; use POST or DELETE" }); return; }
          const requestUrl = new URL(req.url ?? "/", "http://localhost");
          const pathAssetId = decodeURIComponent(requestUrl.pathname.replace(/^\/+/, ""));
          const body = req.method === "POST" ? parseJsonObject(await readBody(req)) as { assetId?: string; commit?: boolean } : {};
          const assetId = String(body.assetId ?? pathAssetId);
          if (!assetId) { sendJson(res, 400, { ok: false, error: "assetId is required" }); return; }
          const result = await deletePersistedGeneratedAsset(publicDir, assetId, body.commit === true);
          sendJson(res, result.ok ? 200 : 404, result);
        } catch (error) { sendJson(res, 400, { ok: false, error: String(error) }); }
      });      server.middlewares.use("/api/qa/joins", async (req, res) => {
        try {
          if (req.method !== "POST") { sendJson(res, 405, { ok: false, error: "method not allowed; use POST" }); return; }
          const body = parseJsonObject(await readBody(req)) as unknown as JoinQaRequest;
          const rig = await readRigFile(rigPath);
          const result = await runJoinQa(rig, publicDir, body);
          sendJson(res, 200, { ok: result.ok, revision: fullRigRevision(rig), result });
        } catch (error) { sendJson(res, 400, { ok: false, error: String(error) }); }
      });      server.middlewares.use("/api/qa/failure-image", async (req, res) => {
        try {
          if (req.method !== "POST") { sendJson(res, 405, { ok: false, error: "method not allowed; use POST" }); return; }
          const body = parseJsonObject(await readBody(req)) as unknown as QaFailureImageRequest;
          const png = await renderQaFailureComparison(await readRigFile(rigPath), publicDir, body);
          res.statusCode = 200; res.setHeader("content-type", "image/png"); res.setHeader("cache-control", "no-store"); res.end(Buffer.from(png));
        } catch (error) { sendJson(res, 400, { ok: false, error: String(error) }); }
      });
      server.middlewares.use("/api/changes", async (req, res) => {
        try {
          if (req.method !== "GET") { sendJson(res, 405, { ok: false, error: "method not allowed" }); return; }
          const requestUrl = new URL(req.url ?? "/api/changes", "http://localhost");
          const since = requestUrl.searchParams.get("since") ?? "";
          const rig = await readRigFile(rigPath); const currentRevision = fullRigRevision(rig);
          if (!since || since === currentRevision) { sendJson(res, 200, { ok: true, changed: false, currentRevision, since: since || null, transactions: [] }); return; }
          const startIndex = SERVER_TRANSACTION_JOURNAL.findIndex((entry) => entry.revisionBefore === since || entry.revisionAfter === since);
          if (startIndex < 0) { sendJson(res, 200, { ok: true, changed: true, resyncRequired: true, reason: "revision-not-in-server-journal", currentRevision, since, transactions: [] }); return; }
          const transactions = SERVER_TRANSACTION_JOURNAL.slice(startIndex).map((entry) => ({ id: entry.id, appliedAt: entry.appliedAt, revisionBefore: entry.revisionBefore, revisionAfter: entry.revisionAfter, operationIds: entry.operationIds }));
          sendJson(res, 200, { ok: true, changed: transactions.length > 0, resyncRequired: false, currentRevision, since, transactions });
        } catch (error) { sendJson(res, 500, { ok: false, error: String(error) }); }
      });
      server.middlewares.use("/api/geometry/export", async (req, res) => {
        try {
          if (req.method !== "GET") { sendJson(res, 405, { ok: false, error: "method_not_allowed" }); return; }
          const rawUrl = req.url ?? "";
          if (rawUrl.length > GEOMETRY_EXPORT_LIMITS.maxQueryLength) { sendJson(res, 400, { ok: false, error: "query_too_long" }); return; }
          const url = new URL(rawUrl || "/api/geometry/export", "http://localhost");
          const keys = [...url.searchParams.keys()];
          const contractValues = url.searchParams.getAll("contractVersion");
          if (keys.length === 0 || (keys.length === 1 && keys[0] === "partId" && !url.searchParams.get("partId"))) { sendJson(res, 400, { ok: false, error: "missing_part_id" }); return; }
          if (keys.some((key) => key !== "partId" && key !== "contractVersion") || url.searchParams.getAll("partId").length !== 1 || contractValues.length > 1) {
            sendJson(res, 400, { ok: false, error: "invalid_query" }); return;
          }
          const requestedVersion = contractValues[0];
          if (requestedVersion !== undefined && !["1", "1.0", "1.1"].includes(requestedVersion)) { sendJson(res, 400, { ok: false, error: "unsupported_geometry_export_version" }); return; }
          const useV11 = requestedVersion === "1.1";
          const partId = url.searchParams.get("partId") ?? "";
          if (!partId) { sendJson(res, 400, { ok: false, error: "missing_part_id" }); return; }
          if (partId.length > GEOMETRY_EXPORT_LIMITS.maxPartIdLength) { sendJson(res, 400, { ok: false, error: "part_id_too_long" }); return; }
          const rig = await readRigFile(rigPath);
          const revision = fullRigRevision(rig);
          const semanticHash = compactContextForRig(rig).semanticHash;
          const exported = useV11
            ? exportGeometryPartV11(rig, partId, { revision, semanticHash, exportedAt: new Date().toISOString() })
            : exportGeometryPart(rig, partId, { revision, semanticHash, exportedAt: new Date().toISOString() });
          const response = { ok: true, export: exported };
          const responseLimit = useV11 ? GEOMETRY_EXPORT_LIMITS.maxV11ResponseBytes : GEOMETRY_EXPORT_LIMITS.maxResponseBytes;
          if (geometryExportByteLength(exported) > responseLimit || Buffer.byteLength(JSON.stringify(response), "utf8") > responseLimit) {
            sendJson(res, 413, { ok: false, error: useV11 ? "geometry_export_response_too_large" : "response_too_large" }); return;
          }
          sendJson(res, 200, response);
        } catch (error) {
          if (error instanceof GeometryExportError) {
            const status = error.code === "part_not_found" ? 404 : ["response_too_large", "geometry_export_response_too_large"].includes(error.code) ? 413 : error.code === "revision_unavailable" ? 503 : error.code === "part_has_no_artmesh" ? 422 : 422;
            sendJson(res, status, { ok: false, error: error.code }); return;
          }
          const requestVersion = new URL(req.url ?? "/api/geometry/export", "http://localhost").searchParams.get("contractVersion");
          sendJson(res, 500, { ok: false, error: requestVersion === "1.1" ? "geometry_export_internal_error" : "export_internal_error" });
        }
      });
      
      
      
      
                                          
      
      
      server.middlewares.use("/api/context", async (req, res) => {
        try {
          if (req.method !== "GET") { sendJson(res, 405, { ok: false, error: "method not allowed" }); return; }
          const rig = await readRigFile(rigPath);
          sendJson(res, 200, { ok: true, context: compactContextForRig(rig) });
        } catch (error) { sendJson(res, 500, { ok: false, error: String(error) }); }
      });
      server.middlewares.use("/api/readiness/calibration", async (req, res) => {
        try {
          if (req.method !== "GET") {
            sendJson(res, 405, { ok: false, error: "method not allowed; use GET" });
            return;
          }
          const url = new URL(req.url ?? "/api/readiness/calibration", "http://localhost");
          const width = Number(url.searchParams.get("width") ?? 768);
          const height = Number(url.searchParams.get("height") ?? 0);
          const fitPadding = Number(url.searchParams.get("padding") ?? 16);
          const alphaThreshold = Number(url.searchParams.get("alphaThreshold") ?? 8);
          const rig = await readRigFile(rigPath);
          const report = await calibrateRigReadiness(rig, publicDir, {
            width: Number.isFinite(width) ? width : undefined,
            height: Number.isFinite(height) && height > 0 ? height : undefined,
            fitPadding: Number.isFinite(fitPadding) ? fitPadding : undefined,
            alphaThreshold: Number.isFinite(alphaThreshold) ? alphaThreshold : undefined
          });
          sendJson(res, 200, { ok: report.status !== "missing", ready: report.status === "calibrated", revision: fullRigRevision(rig), report });
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error) });
        }
      });

      server.middlewares.use("/api/readiness/l2-qa", async (req, res) => {
        try {
          if (req.method !== "GET") {
            sendJson(res, 405, { ok: false, error: "method not allowed; use GET" });
            return;
          }
          const rig = await readRigFile(rigPath);
          const report = await runL2ReadinessQa(rig, publicDir);
          sendJson(res, 200, { ok: report.status === "pass", ready: report.status === "pass", revision: fullRigRevision(rig), report });
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error) });
        }
      });

      server.middlewares.use("/api/readiness/promotion", async (req, res) => {
        try {
          if (req.method !== "GET") {
            sendJson(res, 405, { ok: false, error: "method not allowed; use GET" });
            return;
          }
          const rig = await readRigFile(rigPath);
          const revision = fullRigRevision(rig);
          const readiness = evaluateRigReadiness(rig, { level: "L2" });
          const calibration = await calibrateRigReadiness(rig, publicDir);
          const l2Qa = await runL2ReadinessQa(rig, publicDir);
          const report = evaluateRecipePromotion({
            readiness,
            calibration,
            l2Qa,
            source: { kind: "production-rig", id: `production-rig:${revision}`, fingerprint: revision }
          });
          sendJson(res, 200, { ok: report.status === "eligible", ready: report.status === "eligible", revision, report });
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error) });
        }
      });

      server.middlewares.use("/api/readiness", async (req, res) => {
        try {
          if (req.method !== "GET") {
            sendJson(res, 405, { ok: false, error: "method not allowed; use GET" });
            return;
          }
          const url = new URL(req.url ?? "/api/readiness", "http://localhost");
          const requested = String(url.searchParams.get("level") ?? "L2").toUpperCase();
          if (requested !== "L1" && requested !== "L2" && requested !== "L3") {
            sendJson(res, 400, { ok: false, error: "level must be L1, L2, or L3" });
            return;
          }
          const rig = await readRigFile(rigPath);
          const report = evaluateRigReadiness(rig, { level: requested as ReadinessLevel });
          sendJson(res, 200, { ok: true, ready: report.requestedLevelReady, revision: fullRigRevision(rig), report });
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error) });
        }
      });

      server.middlewares.use("/api/rig/summary", async (req, res) => {
        try {
          if (req.method !== "GET") {
            sendJson(res, 405, { ok: false, error: "method not allowed" });
            return;
          }
          sendJson(res, 200, { ok: true, summary: summarizeRig(await readRigFile(rigPath)) });
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error) });
        }
      });

      server.middlewares.use("/api/rig/validate", async (req, res) => {
        try {
          if (req.method !== "GET" && req.method !== "POST" && req.method !== "PUT") {
            sendJson(res, 405, { ok: false, error: "method not allowed" });
            return;
          }
          const rig = await readRigFromRequestOrFile(req, rigPath);
          sendJson(res, 200, { ok: true, validation: validateRig(rig), summary: summarizeRig(rig) });
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error) });
        }
      });

      server.middlewares.use("/api/rig/inspect", async (req, res) => {
        try {
          if (req.method !== "GET" && req.method !== "POST" && req.method !== "PUT") {
            sendJson(res, 405, { ok: false, error: "method not allowed" });
            return;
          }
          sendJson(res, 200, { ok: true, ...inspectRig(await readRigFromRequestOrFile(req, rigPath)) });
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error) });
        }
      });

      const sendModelingAudit = async (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
        try {
          if (req.method !== "GET" && req.method !== "POST" && req.method !== "PUT") {
            sendJson(res, 405, { ok: false, error: "method not allowed" });
            return;
          }
          const rig = await readRigFromRequestOrFile(req, rigPath);
          sendJson(res, 200, { ok: true, audit: auditModelingRig(rig), summary: summarizeRig(rig) });
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error) });
        }
      };

      server.middlewares.use("/api/modeling/audit", sendModelingAudit);
      server.middlewares.use("/api/audit/modeling", sendModelingAudit);
      server.middlewares.use("/api/modeling/symmetry-artmesh-candidates", async (req, res) => {
        try {
          if (req.method !== "GET") { sendJson(res, 405, { ok: false, error: "method not allowed; use GET" }); return; }
          const current = await readRigFile(rigPath);
          const url = new URL(req.url ?? "/api/modeling/symmetry-artmesh-candidates", "http://localhost");
          const rawPartIds = url.searchParams.get("partIds");
          const rawParameters = url.searchParams.get("parameters");
          const rawSample = Number(url.searchParams.get("sample"));
          const rawMaxPairs = Number(url.searchParams.get("maxPairs"));
          const includeOffsets = url.searchParams.get("includeOffsets") === "1";
          const report = generateArtMeshKeyCandidates(current, {
            partIds: rawPartIds ? rawPartIds.split(",").map((id) => id.trim()).filter(Boolean) : undefined,
            parameters: rawParameters ? rawParameters.split(",").map((id) => id.trim()).filter(Boolean) : undefined,
            sample: Number.isFinite(rawSample) && rawSample > 0 ? rawSample : undefined,
            maxPairs: Number.isFinite(rawMaxPairs) && rawMaxPairs > 0 ? rawMaxPairs : undefined,
            includeOffsets
          });
          sendJson(res, 200, { ok: report.qa.pass, revision: fullRigRevision(current), report });
        } catch (error) { sendJson(res, 400, { ok: false, error: String(error) }); }
      });
      server.middlewares.use("/api/modeling/symmetry-artmesh-transaction-dry-run", async (req, res) => {
        try {
          if (req.method !== "POST") { sendJson(res, 405, { ok: false, error: "method not allowed; use POST" }); return; }
          const body = parseJsonObject(await readBody(req));
          if (body.commit === true) { sendJson(res, 400, { ok: false, error: "this endpoint is dry-run only; use /api/modeling/transaction after approval" }); return; }
          const current = await readRigFile(rigPath);
          const revisionBefore = fullRigRevision(current);
          const rawPartIds = Array.isArray(body.partIds) ? body.partIds.filter((id): id is string => typeof id === "string" && !!id.trim()) : undefined;
          const rawParameters = Array.isArray(body.parameters) ? body.parameters.filter((id): id is string => typeof id === "string" && !!id.trim()) : undefined;
          const rawSample = Number(body.sample);
          const rawMaxPairs = Number(body.maxPairs);
          const report = generateArtMeshKeyCandidates(current, {
            partIds: rawPartIds,
            parameters: rawParameters,
            sample: Number.isFinite(rawSample) && rawSample > 0 ? rawSample : undefined,
            maxPairs: Number.isFinite(rawMaxPairs) && rawMaxPairs > 0 ? rawMaxPairs : undefined,
            includeOffsets: true
          });
          const returnOffsets = body.returnOffsets === true;
          const responseReport = returnOffsets ? report : { ...report, candidates: report.candidates.map(({ offsets, ...summary }) => summary) };
          if (!report.qa.pass) {
            sendJson(res, 200, { ok: false, committed: false, dryRun: true, revisionBefore, revisionAfter: revisionBefore, gate: "candidate-distortion", report: responseReport, summary: summarizeRig(current) });
            return;
          }
          const operations = modelingOperationsForArtMeshCandidates(report);
          const candidate = structuredClone(current);
          const operationResults = operations.map((operation) => executeModelingOperation(candidate, operation, { dryRun: false }));
          const operationGateIssues = modelingOperationGateIssues(operations, operationResults);
          const validation = validateRig(candidate);
          const poses = ["neutral", "face-left", "face-right", "face-up", "face-down", "tilt-left", "tilt-right", "mouth-flat", "mouth-half", "mouth-open", "blink"];
          const regions = Array.isArray(body.regions) ? body.regions.filter((region): region is string => typeof region === "string" && !!region.trim()) : ["face", "eyes", "hair-roots", "hair-tail-left", "hair-tail-right", "neck", "shoulders"];
          const qaFull = await runQaCheck(candidate, publicDir, { poses, regions, width: 240, height: 240, physics: false, checkTriangleDistortion: true });
          const qa = {
            ok: qaFull.ok,
            poseCount: poses.length,
            regionCount: regions.length,
            renderedCount: qaFull.renderedCount,
            failed: qaFull.failed.map((entry) => ({ poseId: entry.poseId, region: entry.region, issues: entry.issues, coverage: entry.coverage, motionDiffPixelRatio: entry.motionDiffPixelRatio })),
            failureRegions: qaFull.failureRegions.map((entry) => ({ poseId: entry.poseId, region: entry.region, issues: entry.issues }))
          };
          const passed = report.qa.pass && validation.ok && qa.ok && operationGateIssues.length === 0;
          sendJson(res, 200, { ok: passed, committed: false, dryRun: true, revisionBefore, revisionAfter: fullRigRevision(candidate), operationCount: operations.length, operationResults, operationGateIssues, validation, candidateGate: report.qa, qa, report: responseReport, summary: summarizeRig(candidate) });
        } catch (error) { sendJson(res, 400, { ok: false, committed: false, dryRun: true, error: String(error) }); }
      });
      server.middlewares.use("/api/modeling/head-proxy/calibrate", async (req, res) => {
        try {
          if (req.method !== "POST") { sendJson(res, 405, { ok: false, error: "method not allowed; use POST" }); return; }
          const body = parseJsonObject(await readBody(req));
          const rig = await readRigFile(rigPath);
          const proxy = fitHeadProxy(rig);
          if (!proxy) { sendJson(res, 422, { ok: false, error: "unable to fit head proxy: confirmed face part or asset dimensions are missing" }); return; }
          const samples = normalizeHeadProxyCalibrationSamples(body.samples);
          const units = body.units === "normalized" ? "normalized" : "stage";
          const rawThreshold = Number(body.thresholdNorm);
          const report = calibrateHeadProxy(proxy, samples, {
            units,
            thresholdNorm: Number.isFinite(rawThreshold) && rawThreshold > 0 ? rawThreshold : undefined
          });
          const includeOffsets = body.includeOffsets === true;
          const compactReport = includeOffsets
            ? report
            : { ...report, samples: report.samples.map(({ corrections, ...summary }) => summary) };
          sendJson(res, 200, {
            ok: report.pass,
            revision: fullRigRevision(rig),
            proxy: { fitMethod: proxy.fitMethod, bounds: proxy.bounds, landmarkCount: Object.keys(proxy.landmarks).length },
            report: compactReport
          });
        } catch (error) { sendJson(res, 400, { ok: false, error: String(error) }); }
      });
      server.middlewares.use("/api/modeling/correspondence", async (req, res) => {
        try {
          if (req.method !== "POST") { sendJson(res, 405, { ok: false, error: "method not allowed; use POST" }); return; }
          const body = parseJsonObject(await readBody(req));
          const current = await readRigFile(rigPath);
          const revisionBefore = fullRigRevision(current);
          if (typeof body.expectedRevision === "string" && body.expectedRevision !== revisionBefore) {
            sendJson(res, 409, { ok: false, error: "revision mismatch", revisionBefore, summary: summarizeRig(current) }); return;
          }
          if (!body.landmarks || typeof body.landmarks !== "object" || Array.isArray(body.landmarks)) {
            sendJson(res, 400, { ok: false, error: "landmarks must be an object keyed by head-proxy landmark id" }); return;
          }
          const proxy = fitHeadProxy(current);
          if (!proxy) { sendJson(res, 422, { ok: false, error: "unable to fit head proxy: confirmed face part or asset dimensions are missing" }); return; }
          const request = {
            values: body.values && typeof body.values === "object" && !Array.isArray(body.values) ? body.values : {},
            landmarks: body.landmarks,
            regularization: body.regularization,
            maxResidual: body.maxResidual,
            maxOffset: body.maxOffset,
            partIds: Array.isArray(body.partIds) ? body.partIds : undefined,
            roles: Array.isArray(body.roles) ? body.roles : undefined,
            includeOffsets: body.includeOffsets === true
          } as CorrespondenceSolveRequest;
          const solution = solveCorrespondence(proxy, request);
          const report = correspondenceOperationsForSolution(current, proxy, solution, request);
          const candidate = structuredClone(current);
          const operationResults = report.operations.map((operation) => executeModelingOperation(candidate, operation, { dryRun: false }));
          const operationGateIssues = modelingOperationGateIssues(report.operations, operationResults);
          const validation = validateRig(candidate);
          const physicsSafety = auditPhysicsSafety(candidate);
          const qaRequest = body.qa && typeof body.qa === "object" && !Array.isArray(body.qa) ? body.qa as QaCheckRequest : undefined;
          const qa = qaRequest ? await runQaCheck(candidate, publicDir, qaRequest) : undefined;
          const candidateGate = solution.pass && report.finite && report.distortionPass && report.issues.length === 0 && report.operations.length > 0;
          const passed = candidateGate && validation.ok && physicsSafety.pass && operationGateIssues.length === 0 && (qa ? qa.ok : true);
          const commit = body.commit === true;
          if (commit && !passed) {
            sendJson(res, 422, { ok: false, committed: false, error: "correspondence transaction gate failed", revisionBefore, solver: solution, candidateGate: { pass: candidateGate, issues: report.issues, maxOffset: report.maxOffset, distortion: report.distortion }, operationResults, operationGateIssues, validation, physicsSafety, qa: qa ? { ok: qa.ok, failed: qa.failed, failureRegions: qa.failureRegions } : undefined, summary: summarizeRig(current) }); return;
          }
          if (commit) {
            const latest = await readRigFile(rigPath);
            const latestRevision = fullRigRevision(latest);
            if (latestRevision !== revisionBefore) { sendJson(res, 409, { ok: false, committed: false, error: "revision changed during correspondence transaction", revisionBefore, currentRevision: latestRevision }); return; }
            await writeRigFile(rigPath, candidate);
            server.ws.send({ type: "full-reload" });
          }
          const operationSummaries = report.summaries.map(({ operation, ...summary }) => ({ ...summary, operationId: operation.id, action: request.includeOffsets ? operation.action : compactCorrespondenceAction(operation.action) }));
          const revisionAfter = fullRigRevision(candidate);
          sendJson(res, 200, { ok: passed, committed: commit && passed, dryRun: !commit, revisionBefore, revisionAfter, proxy: { fitMethod: proxy.fitMethod, bounds: proxy.bounds, landmarkCount: Object.keys(proxy.landmarks).length }, solver: solution, candidateGate: { pass: candidateGate, issues: report.issues, maxOffset: report.maxOffset, distortionPass: report.distortionPass, distortion: report.distortion }, operationCount: report.operations.length, operationSummaries, operationResults, operationGateIssues, validation, qa, summary: summarizeRig(candidate) });
        } catch (error) { sendJson(res, 400, { ok: false, committed: false, error: String(error) }); }
      });
      server.middlewares.use("/api/modeling/physics-safety", async (req, res) => {
        try {
          if (req.method !== "GET" && req.method !== "POST") { sendJson(res, 405, { ok: false, error: "method not allowed; use GET or POST" }); return; }
          const current = await readRigFile(rigPath);
          const revisionBefore = fullRigRevision(current);
          const body = req.method === "POST" ? parseJsonObject(await readBody(req)) : {};
          if (typeof body.expectedRevision === "string" && body.expectedRevision !== revisionBefore) {
            sendJson(res, 409, { ok: false, error: "revision mismatch", revisionBefore, summary: summarizeRig(current) }); return;
          }
          const candidate = structuredClone(current);
          if (body.physics !== undefined) {
            if (!body.physics || typeof body.physics !== "object" || Array.isArray(body.physics)) { sendJson(res, 400, { ok: false, error: "physics must be an object" }); return; }
            candidate.physics = structuredClone(body.physics) as RigDocument["physics"];
          }
          const rawFrames = Number(body.frames);
          const rawDt = Number(body.dt);
          const options: PhysicsSafetyOptions = {
            frames: Number.isFinite(rawFrames) ? rawFrames : undefined,
            dt: Number.isFinite(rawDt) ? rawDt : undefined,
            chainIds: Array.isArray(body.chainIds) ? body.chainIds.filter((id): id is string => typeof id === "string") : undefined,
            driveFrames: typeof body.driveFrames === "number" ? body.driveFrames : undefined,
            settleFrames: typeof body.settleFrames === "number" ? body.settleFrames : undefined,
            releaseExternalForces: body.releaseExternalForces === true
          };
          const safety = auditPhysicsSafety(candidate, options);
          const settling = runPhysicsSettlingQa(candidate, options);
          const validation = validateRig(candidate);
          const qaBody = body.qa && typeof body.qa === "object" && !Array.isArray(body.qa) ? body.qa as Record<string, unknown> : {};
          let renderQa: { ok: boolean; renderedCount: number; failed: Array<{ poseId: string; region: string; issues: string[]; coverage: number; motionDiffPixelRatio: number | null }>; failureRegions: Array<{ poseId: string; region: string; issues: string[] }> } | undefined;
          if (qaBody.render && typeof qaBody.render === "object" && !Array.isArray(qaBody.render)) {
            const renderRequest = qaBody.render as QaCheckRequest;
            const qaFull = await runQaCheck(candidate, publicDir, { ...renderRequest, physics: renderRequest.physics !== false });
            renderQa = { ok: qaFull.ok, renderedCount: qaFull.renderedCount, failed: qaFull.failed.map((entry) => ({ poseId: entry.poseId, region: entry.region, issues: entry.issues, coverage: entry.coverage, motionDiffPixelRatio: entry.motionDiffPixelRatio })), failureRegions: qaFull.failureRegions.map((entry) => ({ poseId: entry.poseId, region: entry.region, issues: entry.issues })) };
          }
          const passed = safety.pass && settling.pass && validation.ok && (renderQa ? renderQa.ok : true);
          const commit = req.method === "POST" && body.commit === true;
          if (commit && !passed) {
            sendJson(res, 422, { ok: false, committed: false, error: "physics safety gate failed", revisionBefore, safety, settling, validation, ...(renderQa ? { renderQa } : {}), summary: summarizeRig(current) }); return;
          }
          if (commit) {
            const latest = await readRigFile(rigPath);
            const latestRevision = fullRigRevision(latest);
            if (latestRevision !== revisionBefore) { sendJson(res, 409, { ok: false, committed: false, error: "revision changed during physics safety transaction", revisionBefore, currentRevision: latestRevision }); return; }
            await writeRigFile(rigPath, candidate);
            server.ws.send({ type: "full-reload" });
          }
          sendJson(res, 200, { ok: passed, committed: commit && passed, dryRun: !commit, revisionBefore, revisionAfter: fullRigRevision(candidate), safety, settling, validation, ...(renderQa ? { renderQa } : {}), summary: summarizeRig(candidate) });
        } catch (error) { sendJson(res, 400, { ok: false, committed: false, error: String(error) }); }
      });
      server.middlewares.use("/api/modeling/skinning-candidates", async (req, res) => {
        try {
          if (req.method !== "POST") { sendJson(res, 405, { ok: false, error: "method not allowed; use POST" }); return; }
          const body = parseJsonObject(await readBody(req));
          const current = await readRigFile(rigPath);
          const revisionBefore = fullRigRevision(current);
          if (typeof body.expectedRevision === "string" && body.expectedRevision !== revisionBefore) { sendJson(res, 409, { ok: false, error: "revision mismatch", revisionBefore, summary: summarizeRig(current) }); return; }
          const commitRequested = body.commit === true;
          if (commitRequested && typeof body.expectedRevision !== "string") { sendJson(res, 400, { ok: false, committed: false, dryRun: false, error: "skinning commit requires expectedRevision, one part, and passing qa.render", revisionBefore, summary: summarizeRig(current) }); return; }
          const partIds = Array.isArray(body.partIds) ? body.partIds.filter((id): id is string => typeof id === "string") : undefined;
          const roles = Array.isArray(body.roles) ? body.roles : undefined;
          const jointIds = Array.isArray(body.deformerIds) ? body.deformerIds.filter((id): id is string => typeof id === "string") : [];
          if (jointIds.length !== 3) { sendJson(res, 400, { ok: false, error: "deformerIds must contain exactly three root/middle/tip rotation deformers" }); return; }
          const knownDeformerIds = new Set((current.deformers ?? []).filter((deformer) => deformer.kind === "rotate").map((deformer) => deformer.id));
          const selected = current.parts.filter((part) => (!partIds?.length || partIds.includes(part.id)) && (!roles?.length || (part.roleStatus === "confirmed" && Boolean(part.role && roles.includes(part.role)))));
          if (commitRequested && selected.length !== 1) { sendJson(res, 400, { ok: false, committed: false, dryRun: false, error: "skinning commit requires exactly one selected part", revisionBefore, selectedPartIds: selected.map((part) => part.id), summary: summarizeRig(current) }); return; }
          const candidate = structuredClone(current);
          const summaries = [];
          const issues: string[] = [];
          for (const part of selected) {
            if (!part.artMesh?.enabled) { issues.push(`${part.id}: artMesh is missing or disabled`); continue; }
            const generated = generateArtMeshSkinning(part.artMesh, jointIds, { rootBand: typeof body.rootBand === "number" ? body.rootBand : undefined, tipBand: typeof body.tipBand === "number" ? body.tipBand : undefined });
            if (!generated.skinning) { issues.push(`${part.id}: ${generated.issues.join(", ")}`); continue; }
            const target = candidate.parts.find((entry) => entry.id === part.id);
            if (!target?.artMesh) { issues.push(`${part.id}: candidate artMesh is missing`); continue; }
            target.artMesh.skinning = generated.skinning;
            const audit = auditArtMeshSkinning(target.artMesh, target.artMesh.skinning, knownDeformerIds);
            summaries.push({ partId: part.id, name: part.name, role: part.role, vertexCount: target.artMesh.vertices.length, joints: generated.skinning.joints, audit, ...(body.includeWeights === true ? { vertexWeights: generated.skinning.vertexWeights } : {}) });
            if (!audit.pass) issues.push(`${part.id}: ${audit.issues.join(", ")}`);
          }
          if (!selected.length) issues.push("no matching ArtMesh parts");
          const validation = validateRig(candidate);
          const qaBody = body.qa && typeof body.qa === "object" && !Array.isArray(body.qa) ? body.qa as Record<string, unknown> : {};
          const skinningQa = runSkinningQa(candidate, selected.map((part) => part.id), {
            samples: Array.isArray(qaBody.samples) ? qaBody.samples.filter((sample): sample is ParameterValues => Boolean(sample && typeof sample === "object" && !Array.isArray(sample))) : undefined,
            neutralTolerance: typeof qaBody.neutralTolerance === "number" ? qaBody.neutralTolerance : undefined,
            rootBlendTolerance: typeof qaBody.rootBlendTolerance === "number" ? qaBody.rootBlendTolerance : undefined,
            maxDisplacement: typeof qaBody.maxDisplacement === "number" ? qaBody.maxDisplacement : undefined
          } satisfies SkinningQaOptions);
          let joinQa: Awaited<ReturnType<typeof runJoinQa>> | undefined;
          if (qaBody.join && typeof qaBody.join === "object" && !Array.isArray(qaBody.join)) joinQa = await runJoinQa(candidate, publicDir, qaBody.join as JoinQaRequest);
          if (joinQa && !joinQa.ok) issues.push("skinning candidate: join QA failed");
          let renderQa: Awaited<ReturnType<typeof runSkinningRenderQa>> | undefined;
          if (qaBody.render && typeof qaBody.render === "object" && !Array.isArray(qaBody.render) && selected.length > 0) {
            const renderBody = qaBody.render as Record<string, unknown>;
            renderQa = await runSkinningRenderQa(current, candidate, publicDir, selected.map((part) => part.id), {
              samples: Array.isArray(renderBody.samples) ? renderBody.samples.filter((sample): sample is ParameterValues => Boolean(sample && typeof sample === "object" && !Array.isArray(sample))) : undefined,
              width: typeof renderBody.width === "number" ? renderBody.width : undefined,
              height: typeof renderBody.height === "number" ? renderBody.height : undefined,
              maxAlphaLossRatio: typeof renderBody.maxAlphaLossRatio === "number" ? renderBody.maxAlphaLossRatio : undefined,
              maxCoverageLossRatio: typeof renderBody.maxCoverageLossRatio === "number" ? renderBody.maxCoverageLossRatio : undefined,
              maxEdgeContactIncrease: typeof renderBody.maxEdgeContactIncrease === "number" ? renderBody.maxEdgeContactIncrease : undefined,
              diffChannelThreshold: typeof renderBody.diffChannelThreshold === "number" ? renderBody.diffChannelThreshold : undefined
            } satisfies SkinningRenderQaOptions);
            if (!renderQa.pass) issues.push("skinning candidate: focused render QA failed");
          }
          if (commitRequested && !renderQa) issues.push("skinning commit requires qa.render");
          let goldenQa: { name: string; manifestRevision?: string; pass: boolean; checkCount: number; failed: Array<{ poseId: string; region: string; issues: string[] }> } | undefined;
          const goldenName = typeof body.goldenName === "string" ? body.goldenName.trim() : "";
          if (commitRequested && !goldenName) issues.push("skinning commit requires goldenName");
          if (goldenName) {
            if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(goldenName)) {
              issues.push(`golden name is invalid: ${goldenName}`);
            } else {
              const goldenManifest = await readFile(path.join(goldenRoot, goldenName, "manifest.json"), "utf8").then((raw) => JSON.parse(raw) as { revision?: unknown; checks?: unknown[]; render?: Record<string, unknown> }).catch(() => undefined);
              const goldenChecks = Array.isArray(goldenManifest?.checks) ? goldenManifest!.checks.map((entry) => entry && typeof entry === "object" ? entry as Record<string, unknown> : {}).map((entry) => ({ poseId: typeof entry.poseId === "string" ? entry.poseId : "", region: typeof entry.region === "string" ? entry.region : "", baselineHash: typeof entry.baselineHash === "string" ? entry.baselineHash : "" })).filter((entry) => entry.poseId && entry.region && entry.baselineHash) : [];
              if (!goldenManifest || !goldenChecks.length) {
                goldenQa = { name: goldenName, pass: false, checkCount: goldenChecks.length, failed: [] };
                issues.push(`golden not found or empty: ${goldenName}`);
              } else {
                const goldenRevision = typeof goldenManifest.revision === "string" ? goldenManifest.revision : undefined;
                const goldenResult = await runQaCheck(current, publicDir, {
                  poses: goldenChecks.map((entry) => entry.poseId),
                  regions: goldenChecks.map((entry) => entry.region),
                  width: typeof goldenManifest.render?.width === "number" ? goldenManifest.render.width : 240,
                  height: typeof goldenManifest.render?.height === "number" ? goldenManifest.render.height : 240,
                  physics: goldenManifest.render?.physics === true,
                  expectedHashes: Object.fromEntries(goldenChecks.map((entry) => [`${entry.poseId}:${entry.region}`, entry.baselineHash]))
                });
                const failed = goldenResult.failed.map((entry) => ({ poseId: entry.poseId, region: entry.region, issues: entry.issues }));
                const revisionPass = goldenRevision === revisionBefore;
                goldenQa = { name: goldenName, manifestRevision: goldenRevision, pass: goldenResult.ok && revisionPass, checkCount: goldenChecks.length, failed };
                if (!revisionPass) issues.push(`golden ${goldenName} revision is stale; register a current-revision Golden before commit`);
                if (!goldenResult.ok) issues.push(`skinning candidate: Golden QA failed (${goldenName})`);
              }
            }
          }
          const passed = issues.length === 0 && validation.ok && summaries.length > 0 && skinningQa.pass && (joinQa?.ok ?? true) && (renderQa?.pass ?? true) && (!commitRequested || Boolean(goldenQa?.pass));
          if (commitRequested && !passed) { sendJson(res, 422, { ok: false, committed: false, dryRun: false, error: "skinning commit gate failed", revisionBefore, revisionAfter: fullRigRevision(candidate), operation: "artmesh-skinning-candidate", joints: jointIds, summaries, issues, validation, skinningQa, ...(joinQa ? { joinQa } : {}), ...(goldenQa ? { goldenQa } : {}), summary: summarizeRig(candidate), ...(renderQa ? { renderQa } : {}) }); return; }
          let committed = false;
          if (commitRequested) {
            const latest = await readRigFile(rigPath);
            const latestRevision = fullRigRevision(latest);
            if (latestRevision !== revisionBefore) { sendJson(res, 409, { ok: false, committed: false, dryRun: false, error: "revision changed during skinning transaction", revisionBefore, currentRevision: latestRevision, summary: summarizeRig(latest) }); return; }
            await writeRigFile(rigPath, candidate);
            server.ws.send({ type: "full-reload" });
            committed = true;
            SERVER_TRANSACTION_JOURNAL.push({ id: `skinning-candidate-${Date.now()}`, appliedAt: new Date().toISOString(), revisionBefore, revisionAfter: fullRigRevision(candidate), operationIds: [`artmesh-skinning:${selected[0]?.id ?? "unknown"}`] });
            if (SERVER_TRANSACTION_JOURNAL.length > 30) SERVER_TRANSACTION_JOURNAL.shift();
          }
          sendJson(res, 200, { ok: passed, committed, dryRun: !commitRequested, revisionBefore, revisionAfter: fullRigRevision(candidate), operation: "artmesh-skinning-candidate", joints: jointIds, summaries, issues, validation, skinningQa, ...(joinQa ? { joinQa } : {}), ...(goldenQa ? { goldenQa } : {}), summary: summarizeRig(candidate), ...(renderQa ? { renderQa } : {}) });
        } catch (error) { sendJson(res, 400, { ok: false, committed: false, error: String(error) }); }
      });
      server.middlewares.use("/api/modeling/skinning-approval", async (req, res) => {
        try {
          if (req.method !== "POST") { sendJson(res, 405, { ok: false, error: "method not allowed; use POST" }); return; }
          const body = parseJsonObject(await readBody(req));
          if (body.commit === true) { sendJson(res, 400, { ok: false, committed: false, dryRun: true, error: "skinning approval is dry-run only; use skinning-candidates commit after approval" }); return; }
          const current = await readRigFile(rigPath);
          const revisionBefore = fullRigRevision(current);
          if (typeof body.expectedRevision !== "string") { sendJson(res, 400, { ok: false, approved: false, error: "expectedRevision is required" }); return; }
          if (body.expectedRevision !== revisionBefore) { sendJson(res, 409, { ok: false, approved: false, error: "revision mismatch", revisionBefore, summary: summarizeRig(current) }); return; }
          const partIds = Array.isArray(body.partIds) ? body.partIds.filter((id): id is string => typeof id === "string") : undefined;
          const roles = Array.isArray(body.roles) ? body.roles : undefined;
          const jointIds = Array.isArray(body.deformerIds) ? body.deformerIds.filter((id): id is string => typeof id === "string") : [];
          if (jointIds.length !== 3) { sendJson(res, 400, { ok: false, approved: false, error: "deformerIds must contain exactly three root/middle/tip rotation deformers" }); return; }
          const selected = current.parts.filter((part) => (!partIds?.length || partIds.includes(part.id)) && (!roles?.length || (part.roleStatus === "confirmed" && Boolean(part.role && roles.includes(part.role)))));
          if (selected.length !== 1) { sendJson(res, 400, { ok: false, approved: false, error: "approval requires exactly one selected ArtMesh part", selectedPartIds: selected.map((part) => part.id), revisionBefore }); return; }
          const selectedPart = selected[0];
          const candidate = structuredClone(current);
          const issues: string[] = [];
          const knownDeformerIds = new Set((current.deformers ?? []).filter((deformer) => deformer.kind === "rotate").map((deformer) => deformer.id));
          const generated = selectedPart.artMesh?.enabled ? generateArtMeshSkinning(selectedPart.artMesh, jointIds, { rootBand: typeof body.rootBand === "number" ? body.rootBand : undefined, tipBand: typeof body.tipBand === "number" ? body.tipBand : undefined }) : { skinning: undefined, issues: ["artMesh is missing or disabled"] };
          const target = candidate.parts.find((part) => part.id === selectedPart.id);
          let summary: Record<string, unknown> | undefined;
          if (!generated.skinning) issues.push(`${selectedPart.id}: ${generated.issues.join(", ")}`);
          if (!target?.artMesh) issues.push(`${selectedPart.id}: candidate artMesh is missing`);
          if (generated.skinning && target?.artMesh) {
            target.artMesh.skinning = generated.skinning;
            const audit = auditArtMeshSkinning(target.artMesh, target.artMesh.skinning, knownDeformerIds);
            summary = { partId: selectedPart.id, name: selectedPart.name, role: selectedPart.role, vertexCount: target.artMesh.vertices.length, joints: generated.skinning.joints, audit };
            if (!audit.pass) issues.push(`${selectedPart.id}: ${audit.issues.join(", ")}`);
          }
          const validation = validateRig(candidate);
          const qaBody = body.qa && typeof body.qa === "object" && !Array.isArray(body.qa) ? body.qa as Record<string, unknown> : {};
          const sampleValues = Array.isArray(qaBody.samples) ? qaBody.samples.filter((sample): sample is ParameterValues => Boolean(sample && typeof sample === "object" && !Array.isArray(sample))) : undefined;
          const skinningQa = runSkinningQa(candidate, [selectedPart.id], {
            samples: sampleValues,
            neutralTolerance: typeof qaBody.neutralTolerance === "number" ? qaBody.neutralTolerance : undefined,
            rootBlendTolerance: typeof qaBody.rootBlendTolerance === "number" ? qaBody.rootBlendTolerance : undefined,
            maxDisplacement: typeof qaBody.maxDisplacement === "number" ? qaBody.maxDisplacement : undefined
          } satisfies SkinningQaOptions);
          let renderQa: Awaited<ReturnType<typeof runSkinningRenderQa>> | undefined;
          if (qaBody.render && typeof qaBody.render === "object" && !Array.isArray(qaBody.render)) {
            const renderBody = qaBody.render as Record<string, unknown>;
            renderQa = await runSkinningRenderQa(current, candidate, publicDir, [selectedPart.id], {
              samples: Array.isArray(renderBody.samples) ? renderBody.samples.filter((sample): sample is ParameterValues => Boolean(sample && typeof sample === "object" && !Array.isArray(sample))) : undefined,
              width: typeof renderBody.width === "number" ? renderBody.width : undefined,
              height: typeof renderBody.height === "number" ? renderBody.height : undefined,
              maxAlphaLossRatio: typeof renderBody.maxAlphaLossRatio === "number" ? renderBody.maxAlphaLossRatio : undefined,
              maxCoverageLossRatio: typeof renderBody.maxCoverageLossRatio === "number" ? renderBody.maxCoverageLossRatio : undefined,
              maxEdgeContactIncrease: typeof renderBody.maxEdgeContactIncrease === "number" ? renderBody.maxEdgeContactIncrease : undefined,
              diffChannelThreshold: typeof renderBody.diffChannelThreshold === "number" ? renderBody.diffChannelThreshold : undefined
            } satisfies SkinningRenderQaOptions);
            if (!renderQa.pass) issues.push("skinning approval: focused render QA failed");
          } else issues.push("skinning approval requires qa.render");
          let joinQa: Awaited<ReturnType<typeof runJoinQa>> | undefined;
          if (qaBody.join && typeof qaBody.join === "object" && !Array.isArray(qaBody.join)) {
            joinQa = await runJoinQa(candidate, publicDir, qaBody.join as JoinQaRequest);
            if (!joinQa.ok) issues.push("skinning approval: join QA failed");
          } else issues.push("skinning approval requires qa.join");
          const goldenNames = Array.isArray(qaBody.goldenNames) ? qaBody.goldenNames.filter((name): name is string => typeof name === "string") : [];
          const goldenResults: Array<{ name: string; pass: boolean; failed: number; mismatches: Array<{ poseId: string; region: string; issues: string[] }> }> = [];
          const goldenBody = qaBody.golden && typeof qaBody.golden === "object" && !Array.isArray(qaBody.golden) ? qaBody.golden as Record<string, unknown> : {};
          if (!goldenNames.length) issues.push("skinning approval requires qa.goldenNames");
          for (const name of goldenNames) {
            if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name)) { issues.push(`golden name is invalid: ${name}`); continue; }
            const manifest = await readFile(path.join(goldenRoot, name, "manifest.json"), "utf8").then((raw) => JSON.parse(raw) as { checks?: unknown[]; render?: Record<string, unknown> }).catch(() => undefined);
            const checks = Array.isArray(manifest?.checks) ? manifest!.checks.map((entry) => entry && typeof entry === "object" ? entry as Record<string, unknown> : {}).map((entry) => ({ poseId: typeof entry.poseId === "string" ? entry.poseId : "", region: typeof entry.region === "string" ? entry.region : "", baselineHash: typeof entry.baselineHash === "string" ? entry.baselineHash : "" })).filter((entry) => entry.poseId && entry.region && entry.baselineHash) : [];
            if (!checks.length) { goldenResults.push({ name, pass: false, failed: 0, mismatches: [] }); issues.push(`golden not found or empty: ${name}`); continue; }
            const goldenQa = await runQaCheck(current, publicDir, {
              poses: checks.map((entry) => entry.poseId),
              regions: checks.map((entry) => entry.region),
              width: typeof goldenBody.width === "number" ? goldenBody.width : (typeof manifest?.render?.width === "number" ? manifest.render.width : 240),
              height: typeof goldenBody.height === "number" ? goldenBody.height : (typeof manifest?.render?.height === "number" ? manifest.render.height : 240),
              physics: typeof goldenBody.physics === "boolean" ? goldenBody.physics : manifest?.render?.physics === true,
              expectedHashes: Object.fromEntries(checks.map((entry) => [`${entry.poseId}:${entry.region}`, entry.baselineHash]))
            });
            const mismatches = goldenQa.failed.map((entry) => ({ poseId: entry.poseId, region: entry.region, issues: entry.issues }));
            goldenResults.push({ name, pass: goldenQa.ok, failed: mismatches.length, mismatches });
            if (!goldenQa.ok) issues.push(`golden ${name} failed`);
          }
          let settling: { candidate: ReturnType<typeof runPhysicsSettlingQa>; baseline: ReturnType<typeof runPhysicsSettlingQa>; regressionFree: boolean } | undefined;
          if (qaBody.settling && typeof qaBody.settling === "object" && !Array.isArray(qaBody.settling)) {
            const settlingBody = qaBody.settling as Record<string, unknown>;
            const settlingOptions = {
              driveFrames: typeof settlingBody.driveFrames === "number" ? settlingBody.driveFrames : undefined,
              settleFrames: typeof settlingBody.settleFrames === "number" ? settlingBody.settleFrames : undefined,
              dt: typeof settlingBody.dt === "number" ? settlingBody.dt : undefined,
              chainIds: Array.isArray(settlingBody.chainIds) ? settlingBody.chainIds.filter((id): id is string => typeof id === "string") : undefined,
              releaseExternalForces: settlingBody.releaseExternalForces === true
            };
            const candidateSettling = runPhysicsSettlingQa(candidate, settlingOptions);
            const baselineSettling = runPhysicsSettlingQa(current, settlingOptions);
            const regressionFree = candidateSettling.issues.length <= baselineSettling.issues.length;
            settling = { candidate: candidateSettling, baseline: baselineSettling, regressionFree };
            if (!candidateSettling.pass) issues.push("skinning approval: physics settling failed");
          } else issues.push("skinning approval requires qa.settling");
          const parity = { pass: Boolean(skinningQa.pass && renderQa?.pass), sharedEvaluator: true, serverRenderer: Boolean(renderQa?.pass), webglContract: "shared-applySkinningToVertices" };
          if (!parity.pass) issues.push("skinning approval: shared evaluator parity failed");
          const approved = issues.length === 0 && validation.ok && Boolean(summary?.audit && (summary.audit as { pass?: boolean }).pass) && skinningQa.pass && Boolean(renderQa?.pass) && Boolean(joinQa?.ok) && goldenResults.length > 0 && goldenResults.every((entry) => entry.pass) && Boolean(settling?.candidate.pass) && parity.pass;
          const compactSettling = settling ? { candidate: { pass: settling.candidate.pass, finite: settling.candidate.finite, chainCount: settling.candidate.chains.length, failedChains: settling.candidate.chains.filter((entry) => !entry.pass).map((entry) => entry.chainId), issues: settling.candidate.issues }, baseline: { pass: settling.baseline.pass, finite: settling.baseline.finite, chainCount: settling.baseline.chains.length, failedChains: settling.baseline.chains.filter((entry) => !entry.pass).map((entry) => entry.chainId), issues: settling.baseline.issues }, regressionFree: settling.regressionFree } : undefined;
          const compactJoin = joinQa ? { ok: joinQa.ok, summary: joinQa.summary, failedPairs: joinQa.failedPairs.map((entry) => ({ poseId: entry.poseId, partAId: entry.partAId, partBId: entry.partBId, issues: entry.issues })), failedMasks: joinQa.failedMasks.map((entry) => ({ poseId: entry.poseId, ownerPartId: entry.ownerPartId, issues: entry.issues })), drawOrderPass: joinQa.drawOrder.pass } : undefined;
          sendJson(res, 200, { ok: approved, approved, committed: false, dryRun: true, revisionBefore, revisionAfter: fullRigRevision(candidate), operation: "artmesh-skinning-approval", partId: selectedPart.id, summary, issues, validation, skinningQa, renderQa, joinQa: compactJoin, golden: goldenResults, settling: compactSettling, parity });
        } catch (error) { sendJson(res, 400, { ok: false, approved: false, committed: false, error: String(error) }); }
      });
      server.middlewares.use("/api/modeling/head-proxy", async (req, res) => {
        try {
          if (req.method !== "GET") { sendJson(res, 405, { ok: false, error: "method not allowed; use GET" }); return; }
          const rig = await readRigFile(rigPath);
          const url = new URL(req.url ?? "/api/modeling/head-proxy", "http://localhost");
          const calibratedRequested = ["1", "true", "yes"].includes(String(url.searchParams.get("calibrated") ?? "").toLowerCase());
          const calibrationReport = calibratedRequested ? await calibrateRigReadiness(rig, publicDir) : undefined;
          const calibrationPoint = (id: string) => {
            const value = calibrationReport?.items.find((item) => item.id === id)?.value;
            if (!value || typeof value !== "object" || !("x" in value) || !("y" in value)) return undefined;
            const x = Number(value.x);
            const y = Number(value.y);
            return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined;
          };
          const calibration = {
            leftEye: calibrationPoint("eye-center-left"),
            rightEye: calibrationPoint("eye-center-right"),
            chin: calibrationPoint("jaw-tip")
          };
          const hasCalibration = Object.values(calibration).some(Boolean);
          const proxy = fitHeadProxy(rig, hasCalibration ? { calibration } : {});
          if (!proxy) { sendJson(res, 422, { ok: false, error: "unable to fit head proxy: confirmed face part or asset dimensions are missing" }); return; }
          const candidates = headProxyPoseCandidates(proxy);
          sendJson(res, 200, {
            ok: true,
            revision: fullRigRevision(rig),
            proxy,
            candidates,
            calibration: { requested: calibratedRequested, status: calibrationReport?.status ?? "not-requested", calibratedCount: calibrationReport?.items.filter((item) => item.status === "calibrated").length ?? 0 },
            summary: { landmarkCount: Object.keys(proxy.landmarks).length, candidateCount: candidates.length, fitMethod: proxy.fitMethod }
          });
        } catch (error) { sendJson(res, 400, { ok: false, error: String(error) }); }
      });
      server.middlewares.use("/api/modeling/symmetry", async (req, res) => {
        try {
          if (req.method !== "GET") { sendJson(res, 405, { ok: false, error: "method not allowed; use GET" }); return; }
          const current = await readRigFile(rigPath);
          const url = new URL(req.url ?? "/api/modeling/symmetry", "http://localhost");
          const rawPartIds = url.searchParams.get("partIds");
          const partIds = rawPartIds ? rawPartIds.split(",").map((id) => id.trim()).filter(Boolean) : undefined;
          const estimate = estimateSymmetryAxis(current, partIds);
          const recommendedContract = symmetryContractWithInferredLinks(current, symmetryContractFromEstimate(estimate));
          sendJson(res, 200, { ok: true, revision: fullRigRevision(current), estimate, recommendedContract, linkSummary: { total: recommendedContract.links.length, byKind: Object.fromEntries(["part", "deformer", "warp-pin", "physics"].map((kind) => [kind, recommendedContract.links.filter((link) => link.kind === kind).length])) } });
        } catch (error) { sendJson(res, 400, { ok: false, error: String(error) }); }
      });
      server.middlewares.use("/api/qa/golden", async (req, res) => {
        try {
          if (req.method === "GET") {
            const entries = await readFile(path.join(goldenRoot, "index.json"), "utf8").then((raw) => JSON.parse(raw)).catch(() => ({ entries: [] }));
            sendJson(res, 200, { ok: true, entries: Array.isArray(entries.entries) ? entries.entries : [] }); return;
          }
          if (req.method !== "POST") { sendJson(res, 405, { ok: false, error: "method not allowed; use POST" }); return; }
          const body = parseJsonObject(await readBody(req));
          const name = typeof body.name === "string" ? body.name.trim() : "";
          if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name)) { sendJson(res, 400, { ok: false, error: "name must be 1-64 safe characters" }); return; }
          const action = body.action === "check" ? "check" : body.action === "register" ? "register" : body.action === "propose" ? "propose" : "check";
          const manifestPath = path.join(goldenRoot, name, "manifest.json");
          const qaRequest = body.qa && typeof body.qa === "object" && !Array.isArray(body.qa) ? body.qa as QaCheckRequest : {};
          if (action === "propose") {
            const expectedRevision = typeof body.expectedRevision === "string" ? body.expectedRevision : "";
            const rig = await readRigFile(rigPath);
            const revision = fullRigRevision(rig);
            if (!expectedRevision) { sendJson(res, 400, { ok: false, action, error: "expectedRevision is required for golden proposal", revision }); return; }
            if (expectedRevision !== revision) { sendJson(res, 409, { ok: false, action, error: "revision mismatch", revision, expectedRevision }); return; }
            const qa = await runQaCheck(rig, publicDir, qaRequest);
            if (!qa.ok) { sendJson(res, 422, { ok: false, action, error: "cannot propose a failed QA result", revision, qa: { ok: qa.ok, failed: qa.failed.map((entry) => ({ poseId: entry.poseId, region: entry.region, issues: entry.issues })) } }); return; }
            const manifest = { format: "standrig-golden", version: 1, name, createdAt: new Date().toISOString(), revision, render: { width: qaRequest.width ?? 240, height: qaRequest.height ?? 240, physics: qaRequest.physics === true }, checks: qa.entries.map((entry) => ({ poseId: entry.poseId, region: entry.region, baselineHash: entry.baselineHash, coverage: entry.coverage, alphaBBox: entry.audit.alphaBBox })) };
            sendJson(res, 200, { ok: true, action, committed: false, dryRun: true, revision, existingManifest: await readFile(manifestPath, "utf8").then((raw) => JSON.parse(raw)).catch(() => undefined), manifest: { ...manifest, checks: manifest.checks.map((entry) => ({ poseId: entry.poseId, region: entry.region, baselineHash: entry.baselineHash })) }, qa: { ok: qa.ok, entryCount: qa.entries.length } }); return;
          }
          if (action === "register") {
            const expectedRevision = typeof body.expectedRevision === "string" ? body.expectedRevision : "";
            const rig = await readRigFile(rigPath);
            const revision = fullRigRevision(rig);
            if (!expectedRevision) { sendJson(res, 400, { ok: false, action, committed: false, dryRun: false, error: "expectedRevision is required for golden registration", revision }); return; }
            if (expectedRevision !== revision) { sendJson(res, 409, { ok: false, action, committed: false, dryRun: false, error: "revision mismatch", expectedRevision, revision }); return; }
            const qa = await runQaCheck(rig, publicDir, qaRequest);
            if (!qa.ok) { sendJson(res, 422, { ok: false, action, committed: false, dryRun: false, error: "cannot register a failed QA result", revision, qa: { ok: qa.ok, failed: qa.failed } }); return; }
            const latest = await readRigFile(rigPath);
            const latestRevision = fullRigRevision(latest);
            if (latestRevision !== revision) { sendJson(res, 409, { ok: false, action, committed: false, dryRun: false, error: "revision changed during golden registration", revision, currentRevision: latestRevision }); return; }
            const manifest = { format: "standrig-golden", version: 1, name, createdAt: new Date().toISOString(), revision, render: { width: qaRequest.width ?? 240, height: qaRequest.height ?? 240, physics: qaRequest.physics === true }, checks: qa.entries.map((entry) => ({ poseId: entry.poseId, region: entry.region, baselineHash: entry.baselineHash, coverage: entry.coverage, alphaBBox: entry.audit.alphaBBox })) };
            await mkdir(path.join(goldenRoot, name), { recursive: true }); await writeJsonFile(manifestPath, manifest);
            const indexPath = path.join(goldenRoot, "index.json"); const index = await readFile(indexPath, "utf8").then((raw) => JSON.parse(raw)).catch(() => ({ entries: [] })); const entries = Array.isArray(index.entries) ? index.entries.filter((entry: { name?: string }) => entry.name !== name) : []; entries.push({ name, createdAt: manifest.createdAt, revision: manifest.revision, checkCount: manifest.checks.length }); await writeJsonFile(indexPath, { format: "standrig-golden-index", version: 1, entries });
            sendJson(res, 200, { ok: true, action, committed: true, dryRun: false, revision, manifest: { ...manifest, checks: manifest.checks.map((entry) => ({ poseId: entry.poseId, region: entry.region, baselineHash: entry.baselineHash })) } }); return;
          }
          const manifest = await readFile(manifestPath, "utf8").then((raw) => JSON.parse(raw)).catch(() => undefined);
          if (!manifest || !Array.isArray(manifest.checks)) { sendJson(res, 404, { ok: false, error: `golden not found: ${name}` }); return; }
          const goldenChecks = manifest.checks as Array<{ poseId: string; region: string; baselineHash: string }>;
          const expectedHashes: Record<string, string> = {}; for (const entry of goldenChecks) expectedHashes[`${entry.poseId}:${entry.region}`] = entry.baselineHash;
          const qa = await runQaCheck(await readRigFile(rigPath), publicDir, { ...qaRequest, poses: qaRequest.poses ?? goldenChecks.map((entry) => entry.poseId), regions: qaRequest.regions ?? goldenChecks.map((entry) => entry.region), expectedHashes });
          sendJson(res, 200, { ok: qa.ok, action, name, goldenRevision: manifest.revision, currentRevision: fullRigRevision(await readRigFile(rigPath)), mismatches: qa.failed.filter((entry) => entry.issues.includes("baseline-mismatch")).map((entry) => ({ poseId: entry.poseId, region: entry.region, expectedHash: entry.expectedHash, actualHash: entry.baselineHash })), qa: { ok: qa.ok, entries: qa.entries.map((entry) => ({ poseId: entry.poseId, region: entry.region, pass: entry.pass, issues: entry.issues, motionDiffPixelRatio: entry.motionDiffPixelRatio })), failureRegions: qa.failureRegions } });
        } catch (error) { sendJson(res, 400, { ok: false, error: String(error) }); }
      });
      server.middlewares.use("/api/modeling/join-transaction", async (req, res) => {
        try {
          if (req.method !== "POST") { sendJson(res, 405, { ok: false, error: "method not allowed; use POST" }); return; }
          const body = parseJsonObject(await readBody(req));
          const current = await readRigFile(rigPath);
          const revisionBefore = fullRigRevision(current);
          if (typeof body.expectedRevision === "string" && body.expectedRevision !== revisionBefore) {
            sendJson(res, 409, { ok: false, error: "revision mismatch", revisionBefore, summary: summarizeRig(current) }); return;
          }
          if (!Array.isArray(body.operations) || !body.operations.length) { sendJson(res, 400, { ok: false, error: "operations must be a non-empty array" }); return; }
          const operations = body.operations as JoinTransactionOperation[];
          const candidate = structuredClone(current);
          const applied = applyJoinTransactionOperations(candidate, operations, false);
          const validation = validateRig(candidate);
          const qaRequest = body.qa && typeof body.qa === "object" && !Array.isArray(body.qa) ? body.qa as JoinQaRequest : { poses: ["neutral"], includeExposure: false };
          const joinQa = await runJoinQa(candidate, publicDir, qaRequest);
          const skipped = applied.operationResults.flatMap((entry) => entry.skipped.map((skip) => ({ operationId: entry.operationId, ...skip })));
          const passed = validation.ok && joinQa.ok && applied.issues.length === 0 && skipped.length === 0;
          const commit = body.commit === true;
          if (commit && !passed) {
            sendJson(res, 422, { ok: false, committed: false, error: "join transaction gate failed", revisionBefore, operationResults: applied.operationResults, issues: applied.issues, skipped, validation, joinQa, summary: summarizeRig(current) }); return;
          }
          if (commit) {
            const latest = await readRigFile(rigPath);
            const latestRevision = fullRigRevision(latest);
            if (latestRevision !== revisionBefore) { sendJson(res, 409, { ok: false, committed: false, error: "revision changed during transaction", revisionBefore, currentRevision: latestRevision }); return; }
            await writeRigFile(rigPath, candidate);
            server.ws.send({ type: "full-reload" });
          }
          const revisionAfter = fullRigRevision(candidate);
          if (commit && passed) {
            SERVER_TRANSACTION_JOURNAL.push({ id: "join-transaction-" + Date.now(), appliedAt: new Date().toISOString(), revisionBefore, revisionAfter, operationIds: operations.map((operation) => operation.id) });
            if (SERVER_TRANSACTION_JOURNAL.length > 30) SERVER_TRANSACTION_JOURNAL.shift();
          }
          sendJson(res, 200, { ok: passed, committed: commit && passed, dryRun: !commit, revisionBefore, revisionAfter, operationResults: applied.operationResults, issues: applied.issues, skipped, validation, joinQa, summary: summarizeRig(candidate), history: { scope: "server-transaction-response", persisted: false } });
        } catch (error) { sendJson(res, 400, { ok: false, committed: false, error: String(error) }); }
      });      server.middlewares.use("/api/qa/art-paths", async (req, res) => {
        try {
          if (req.method !== "POST") { sendJson(res, 405, { ok: false, error: "method not allowed; use POST" }); return; }
          const body = parseJsonObject(await readBody(req)) as unknown as ArtPathQaRequest;
          const rig = await readRigFile(rigPath);
          const result = runArtPathQa(rig, body);
          sendJson(res, 200, { ok: result.ok, revision: fullRigRevision(rig), result });
        } catch (error) { sendJson(res, 400, { ok: false, error: String(error) }); }
      });
      server.middlewares.use("/api/modeling/art-path-transaction", async (req, res) => {
        try {
          if (req.method !== "POST") { sendJson(res, 405, { ok: false, error: "method not allowed; use POST" }); return; }
          const body = parseJsonObject(await readBody(req));
          const current = await readRigFile(rigPath);
          const revisionBefore = fullRigRevision(current);
          if (typeof body.expectedRevision === "string" && body.expectedRevision !== revisionBefore) {
            sendJson(res, 409, { ok: false, error: "revision mismatch", revisionBefore, summary: summarizeRig(current) }); return;
          }
          if (!Array.isArray(body.operations) || !body.operations.length) { sendJson(res, 400, { ok: false, error: "operations must be a non-empty array" }); return; }
          const operations = body.operations as ArtPathTransactionOperation[];
          const candidate = structuredClone(current);
          const applied = applyArtPathTransactionOperations(candidate, operations);
          const validation = validateRig(candidate);
          const qaBody = body.qa && typeof body.qa === "object" && !Array.isArray(body.qa) ? body.qa as Record<string, unknown> : {};
          const structuralQaRequest = qaBody.structural && typeof qaBody.structural === "object" && !Array.isArray(qaBody.structural)
            ? qaBody.structural as ArtPathQaRequest
            : qaBody as ArtPathQaRequest;
          const artPathQa = runArtPathQa(candidate, structuralQaRequest);
          // Optional render QA closes the gap between a valid path record and a
          // visually safe candidate. It remains numeric-only and returns no PNG.
          const renderQaRequest = qaBody.render && typeof qaBody.render === "object" && !Array.isArray(qaBody.render)
            ? qaBody.render as QaCheckRequest
            : undefined;
          const renderQaFull = renderQaRequest ? await runQaCheck(candidate, publicDir, renderQaRequest) : undefined;
          const renderQa = renderQaFull ? {
            ok: renderQaFull.ok,
            renderedCount: renderQaFull.renderedCount,
            failed: renderQaFull.failed.map((entry) => ({ poseId: entry.poseId, region: entry.region, issues: entry.issues, coverage: entry.coverage, motionDiffPixelRatio: entry.motionDiffPixelRatio })),
            failureRegions: renderQaFull.failureRegions.map((entry) => ({ poseId: entry.poseId, region: entry.region, issues: entry.issues }))
          } : undefined;
          const skipped = applied.operationResults.flatMap((entry) => entry.skipped.map((skip) => ({ operationId: entry.operationId, ...skip })));
          const passed = validation.ok && artPathQa.ok && (renderQa ? renderQa.ok : true) && applied.issues.length === 0 && skipped.length === 0;
          const commit = body.commit === true;
          if (commit && !passed) {
            sendJson(res, 422, { ok: false, committed: false, error: "art-path transaction gate failed", revisionBefore, operationResults: applied.operationResults, issues: applied.issues, skipped, validation, artPathQa, renderQa, summary: summarizeRig(current) }); return;
          }
          if (commit) {
            const latest = await readRigFile(rigPath);
            const latestRevision = fullRigRevision(latest);
            if (latestRevision !== revisionBefore) { sendJson(res, 409, { ok: false, committed: false, error: "revision changed during transaction", revisionBefore, currentRevision: latestRevision }); return; }
            await writeRigFile(rigPath, candidate);
            server.ws.send({ type: "full-reload" });
          }
          const revisionAfter = fullRigRevision(candidate);
          if (commit && passed) {
            SERVER_TRANSACTION_JOURNAL.push({ id: "art-path-transaction-" + Date.now(), appliedAt: new Date().toISOString(), revisionBefore, revisionAfter, operationIds: operations.map((operation) => operation.id) });
            if (SERVER_TRANSACTION_JOURNAL.length > 30) SERVER_TRANSACTION_JOURNAL.shift();
          }
          sendJson(res, 200, { ok: passed, committed: commit && passed, dryRun: !commit, revisionBefore, revisionAfter, operationResults: applied.operationResults, issues: applied.issues, skipped, validation, artPathQa, renderQa, summary: summarizeRig(candidate), history: { scope: "server-transaction-response", persisted: false } });
        } catch (error) { sendJson(res, 400, { ok: false, committed: false, error: String(error) }); }
      });      server.middlewares.use("/api/modeling/transaction", async (req, res) => {
        try {
          if (req.method !== "POST") { sendJson(res, 405, { ok: false, error: "method not allowed; use POST" }); return; }
          const body = parseJsonObject(await readBody(req));
          const current = await readRigFile(rigPath);
          const revisionBefore = fullRigRevision(current);
          if (typeof body.expectedRevision === "string" && body.expectedRevision !== revisionBefore) {
            sendJson(res, 409, { ok: false, error: "revision mismatch", revisionBefore, summary: summarizeRig(current) }); return;
          }
          if (!Array.isArray(body.operations) || !body.operations.length) { sendJson(res, 400, { ok: false, error: "operations must be a non-empty array" }); return; }
          const operations = body.operations as ModelingOperation[];
          const samplerRig = structuredClone(current);
          for (const operation of operations) {
            if (operation.action.type === "role-confirm") executeModelingOperation(samplerRig, operation, { dryRun: false });
          }
          const alphaSamplerLoad = await loadArtMeshAlphaSamplers(samplerRig, publicDir, operations);
          const candidate = structuredClone(current);
          const operationResults = [];
          for (const operation of operations) operationResults.push(executeModelingOperation(candidate, operation, { dryRun: false, assetAlphaSamplers: alphaSamplerLoad.samplers }));
          const validation = validateRig(candidate);
          const physicsSafety = auditPhysicsSafety(candidate);
          const qaRequest = body.qa && typeof body.qa === "object" && !Array.isArray(body.qa) ? body.qa as QaCheckRequest : undefined;
          const qa = qaRequest ? await runQaCheck(candidate, publicDir, qaRequest) : undefined;
          const alphaSamplerGate = alphaSamplerLoad.skipped.length === 0;
          const operationGateIssues = modelingOperationGateIssues(operations, operationResults);
          const passed = validation.ok && physicsSafety.pass && (qa ? qa.ok : true) && alphaSamplerGate && operationGateIssues.length === 0;
          const commit = body.commit === true;
          if (commit && !passed) {
            sendJson(res, 422, { ok: false, committed: false, error: "transaction gate failed", revisionBefore, operationResults, operationGateIssues, validation, physicsSafety, qa: qa ? { ok: qa.ok, failed: qa.failed, failureRegions: qa.failureRegions } : undefined, artMeshSampler: { requiredAssetIds: alphaSamplerLoad.requiredAssetIds, loadedAssetIds: alphaSamplerLoad.loadedAssetIds, skipped: alphaSamplerLoad.skipped }, summary: summarizeRig(current) }); return;
          }
          if (commit) {
            const latest = await readRigFile(rigPath);
            const latestRevision = fullRigRevision(latest);
            if (latestRevision !== revisionBefore) { sendJson(res, 409, { ok: false, committed: false, error: "revision changed during transaction", revisionBefore, currentRevision: latestRevision }); return; }
            await writeRigFile(rigPath, candidate);
            server.ws.send({ type: "full-reload" });
          }
          const revisionAfter = fullRigRevision(candidate);
          const transactionResult = normalizeModelingTransactionResult({
            committed: commit && passed,
            dryRun: !commit,
            revisionBefore,
            revisionAfter,
            operationResults,
            operationGateIssues
          });
          if (commit && passed) { SERVER_TRANSACTION_JOURNAL.push({ id: `transaction-${Date.now()}`, appliedAt: new Date().toISOString(), revisionBefore, revisionAfter, operationIds: operationResults.map((result) => result.operationId) }); if (SERVER_TRANSACTION_JOURNAL.length > 30) SERVER_TRANSACTION_JOURNAL.shift(); }
          sendJson(res, 200, { ok: passed, committed: commit && passed, dryRun: !commit, revisionBefore, revisionAfter, operationResults, operationGateIssues, validation, physicsSafety, qa, artMeshSampler: { requiredAssetIds: alphaSamplerLoad.requiredAssetIds, loadedAssetIds: alphaSamplerLoad.loadedAssetIds, skipped: alphaSamplerLoad.skipped }, transactionResult, noWrite: transactionResult.noWrite, summary: summarizeRig(candidate), history: { scope: "server-transaction-response", persisted: false, note: "Persistent transaction journal is planned for the next E2 increment." } });
        } catch (error) { sendJson(res, 400, { ok: false, committed: false, error: String(error) }); }
      });
      server.middlewares.use("/api/modeling/role-suggestions", async (req, res) => {
        try {
          if (req.method !== "GET") { sendJson(res, 405, { ok: false, error: "method not allowed; use GET" }); return; }
          const requestUrl = new URL(req.url ?? "/api/modeling/role-suggestions", "http://localhost");
          const includeHidden = requestUrl.searchParams.get("includeHidden") === "1";
          const rawMinConfidence = requestUrl.searchParams.get("minConfidence");
          const requestedMinConfidence = rawMinConfidence === null ? Number.NaN : Number(rawMinConfidence);
          const minConfidence = Number.isFinite(requestedMinConfidence) ? Math.max(0, Math.min(1, requestedMinConfidence)) : 0.8;
          const rig = await readRigFile(rigPath);
          const suggestions = rig.parts
            .filter((part) => part.kind === "image" && part.roleStatus !== "confirmed")
            .filter((part) => includeHidden || (part.visible && !(part.tags ?? []).some((tag) => tag === "reference" || tag === "hidden-runtime")))
            .map((part) => {
              const suggestion = inferPartRole(part);
              return suggestion ? { partId: part.id, name: part.name, currentRole: part.role ?? null, currentStatus: part.roleStatus ?? "unassigned", suggestion } : undefined;
            })
            .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
            .filter((entry) => entry.suggestion.confidence >= minConfidence);
          const byRole: Record<string, number> = {};
          for (const entry of suggestions) byRole[entry.suggestion.role] = (byRole[entry.suggestion.role] ?? 0) + 1;
          sendJson(res, 200, { ok: true, revision: fullRigRevision(rig), includeHidden, minConfidence, suggestions, summary: { count: suggestions.length, byRole } });
        } catch (error) { sendJson(res, 400, { ok: false, error: String(error) }); }
      });
      server.middlewares.use("/api/modeling/artmesh-presets", async (req, res) => {
        try {
          if (req.method !== "GET") { sendJson(res, 405, { ok: false, error: "method not allowed; use GET" }); return; }
          const rig = await readRigFile(rigPath);
          const requestUrl = new URL(req.url ?? "/api/modeling/artmesh-presets", "http://localhost");
          const profileId = requestUrl.searchParams.get("profile")?.trim();
          if (profileId) {
            const result = artMeshProfileCandidates(rig, profileId);
            if (!result) { sendJson(res, 404, { ok: false, error: "ArtMesh profile not found: " + profileId }); return; }
            sendJson(res, 200, {
              ok: true,
              ...result,
              recommendedOperation: {
                id: "artmesh-profile-" + result.profile.id,
                name: "ArtMesh profile: " + result.profile.label,
                target: { roles: result.profile.roles },
                action: {
                  type: "artmesh-generate",
                  preset: result.profile.preset,
                  topology: result.profile.topology,
                  columns: result.profile.columns,
                  rows: result.profile.rows,
                  alphaThreshold: result.profile.alphaThreshold,
                  quality: result.profile.quality
                }
              },
              requiresAlphaSampler: result.profile.topology === "alpha-contour"
            });
            return;
          }
          const profiles = artMeshGenerationProfiles().map((profile) => ({
            ...artMeshProfileCandidates(rig, profile.id),
            profile
          }));
          sendJson(res, 200, { ok: true, profiles, summary: summarizeRig(rig) });
        } catch (error) { sendJson(res, 400, { ok: false, error: String(error) }); }
      });
      server.middlewares.use("/api/modeling/part-key", async (req, res) => {
        try {
          if (req.method !== "GET" && req.method !== "POST" && req.method !== "PATCH") {
            sendJson(res, 405, { ok: false, error: "method not allowed" });
            return;
          }

          const rig = await readRigFile(rigPath);
          if (req.method === "GET") {
            const requestUrl = new URL(req.url ?? "/", "http://localhost/api/modeling/part-key");
            const partId = requestUrl.searchParams.get("partId");
            if (partId) {
              const part = rig.parts.find((entry) => entry.id === partId);
              if (!part) {
                sendJson(res, 404, { ok: false, error: `part not found: ${partId}` });
                return;
              }
              sendJson(res, 200, { ok: true, part: modelingPartKeySummary(part), parameters: parameterDefinitionsForRig(rig), values: previewParameterValuesForRig(rig) });
              return;
            }

            sendJson(res, 200, {
              ok: true,
              parts: rig.parts.filter((part) => (part.bindings?.length ?? 0) > 0).map(modelingPartKeySummary),
              parameters: parameterDefinitionsForRig(rig),
              values: previewParameterValuesForRig(rig),
              summary: summarizeRig(rig)
            });
            return;
          }

          const body = parseJsonObject(await readBody(req));
          const partId = typeof body.partId === "string" ? body.partId : undefined;
          const parameterId = typeof body.parameter === "string" ? body.parameter : undefined;
          const property = isPartKeyProperty(body.property) ? body.property : undefined;
          const part = partId ? rig.parts.find((entry) => entry.id === partId) : undefined;
          const parameter = parameterId ? parameterDefinitionsForRig(rig).find((entry) => entry.id === parameterId) : undefined;

          if (!partId || !part) {
            sendJson(res, 404, { ok: false, error: `part not found: ${partId ?? ""}` });
            return;
          }
          if (!parameterId || !parameter) {
            sendJson(res, 400, { ok: false, error: `parameter not found: ${parameterId ?? ""}` });
            return;
          }
          if (!property) {
            sendJson(res, 400, { ok: false, error: "property must be one of x, y, rotation, scaleX, scaleY, opacity" });
            return;
          }

          const input = clampParameterValue(
            rig,
            parameterId,
            typeof body.input === "number" && Number.isFinite(body.input)
              ? body.input
              : previewParameterValuesForRig(rig)[parameterId] ?? parameter.default
          );
          let value = typeof body.value === "number" && Number.isFinite(body.value) ? body.value : 0;
          if (body.captureFromTransform === true) {
            value = part.transform[property] - neutralPartKeyValue(property);
            part.transform[property] = neutralPartKeyValue(property);
          }

          const binding = ensurePartModelingBinding(part, parameterId, property, rig, {
            additive: typeof body.additive === "boolean" ? body.additive : undefined,
            interpolation: modelingInterpolation(body.interpolation)
          });
          upsertModelingBindingKey(binding, Math.round(input * 1000) / 1000, Math.round(value * 1000) / 1000);

          const validation = validateRig(rig);
          if (!validation.ok) {
            sendJson(res, 400, { ok: false, error: "modeling part key produced invalid rig", validation });
            return;
          }

          await writeRigFile(rigPath, rig);
          sendJson(res, 200, { ok: true, part: modelingPartKeySummary(part), binding, validation, summary: summarizeRig(rig) });
          server.ws.send({ type: "full-reload" });
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error) });
        }
      });
      server.middlewares.use("/api/modeling/warp-pin-mirror", async (req, res) => {
        try {
          if (req.method !== "POST" && req.method !== "PATCH") {
            sendJson(res, 405, { ok: false, error: "method not allowed" });
            return;
          }

          const rig = await readRigFile(rigPath);
          const body = parseJsonObject(await readBody(req));
          const deformerId = typeof body.deformerId === "string" ? body.deformerId : undefined;
          const action = warpPinMirrorAction(body.action);
          const pinIdOrIndex = body.pinIdOrIndex ?? body.pinId ?? body.pinIndex;
          const deformers = ensureRigDeformers(rig);
          const deformer = deformerId ? deformers.find((entry) => entry.id === deformerId) : undefined;
          if (!deformerId || !deformer) {
            sendJson(res, 404, { ok: false, error: `deformer not found: ${deformerId ?? ""}` });
            return;
          }
          if (deformer.kind !== "warp") {
            sendJson(res, 400, { ok: false, error: `deformer is not warp: ${deformerId}` });
            return;
          }
          if (!action) {
            sendJson(res, 400, { ok: false, error: "action must be link, apply, or unlink" });
            return;
          }

          normalizeDeformer(deformer, rig);
          const pins = normalizeWarpDeformer(deformer.warp).pins ?? [];
          const pinIndex = resolveWarpPinIndexForApi(pins, pinIdOrIndex);
          if (pinIndex < 0) {
            sendJson(res, 404, { ok: false, error: `warp pin not found: ${String(pinIdOrIndex ?? "")}` });
            return;
          }

          const options = {
            create: typeof body.create === "boolean" ? body.create : undefined,
            tolerance: typeof body.tolerance === "number" && Number.isFinite(body.tolerance) ? body.tolerance : undefined
          };
          const result = action === "link"
            ? linkWarpPinMirrorInDeformer(deformer, pinIndex, options)
            : action === "apply"
              ? applyWarpPinMirrorInDeformer(deformer, pinIndex, options)
              : unlinkWarpPinMirrorInDeformer(deformer, pinIndex);
          if (!result.ok) {
            sendJson(res, 400, { ok: false, error: result.reason ?? "warp pin mirror update failed", result, summary: summarizeRig(rig) });
            return;
          }

          normalizeDeformer(deformer, rig);
          const validation = validateRig(rig);
          if (!validation.ok) {
            sendJson(res, 400, { ok: false, error: "warp pin mirror update produced invalid rig", result, validation });
            return;
          }

          const dryRun = body.dryRun === true;
          if (!dryRun) {
            await writeRigFile(rigPath, rig);
            server.ws.send({ type: "full-reload" });
          }
          sendJson(res, 200, { ok: true, dryRun, action, result, deformer, validation, summary: summarizeRig(rig), audit: auditModelingRig(rig) });
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error) });
        }
      });
      server.middlewares.use("/api/modeling/techniques", async (req, res) => {
        try {
          if (req.method !== "GET") {
            sendJson(res, 405, { ok: false, error: "method not allowed" });
            return;
          }
          const rig = await readRigFile(rigPath);
          sendJson(res, 200, { ok: true, guide: modelingTechniqueGuideForRig(rig), summary: summarizeRig(rig) });
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error) });
        }
      });
      server.middlewares.use("/api/modeling", async (req, res) => {
        try {
          if (req.method !== "GET" && req.method !== "PATCH") {
            sendJson(res, 405, { ok: false, error: "method not allowed" });
            return;
          }

          const rig = await readRigFile(rigPath);
          let activePoseId: string | undefined;
          if (req.method === "PATCH") {
            const body = parseJsonObject(await readBody(req));
            activePoseId = typeof body.poseId === "string" ? body.poseId : undefined;
            const overrides = parameterPatchFromBody(body);
            const values = activePoseId ? modelingPoseValuesForRig(rig, activePoseId, overrides) : previewParameterValuesForRig(rig, overrides);
            if (!values) {
              sendJson(res, 404, { ok: false, error: `modeling pose not found: ${activePoseId}` });
              return;
            }
            writePreviewParameterValues(rig, values);
            const validation = validateRig(rig);
            if (!validation.ok) {
              sendJson(res, 400, { ok: false, error: "modeling pose produced invalid rig", validation });
              return;
            }
            await writeRigFile(rigPath, rig);
            server.ws.send({ type: "full-reload" });
          }

          sendJson(res, 200, {
            ok: true,
            activePoseId,
            values: previewParameterValuesForRig(rig),
            presets: modelingPosePresetsForRig(rig),
            screenshot: {
              modeling: "/api/screenshot?set=modeling&width=260&height=360",
              angles: "/api/screenshot?set=angles&width=260&height=360",
              expressions: "/api/screenshot?set=expressions&width=260&height=360"
            },
            summary: summarizeRig(rig)
          });
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error) });
        }
      });

      server.middlewares.use("/api/reference/sheet", async (req, res) => {
        try {
          if (req.method !== "GET") {
            sendJson(res, 405, { ok: false, error: "method not allowed" });
            return;
          }

          const rig = await readRigFile(rigPath);
          const requestUrl = new URL(req.url ?? "/", "http://localhost/api/reference/sheet");
          if (!requestUrl.searchParams.has("set")) {
            requestUrl.searchParams.set("set", "reference-all");
          }
          const result = await renderRigScreenshot(rig, publicDir, screenshotOptionsFromUrl(rig, requestUrl));
          if (requestUrl.searchParams.get("format") === "json") {
            sendJson(res, 200, {
              ok: true,
              set: result.set,
              detail: result.detail,
              focusParts: result.focusParts,
              partIds: result.partIds,
              forceParts: result.forceParts,
              width: result.width,
              height: result.height,
              parameters: result.parameters,
              physics: result.physics,
              physicsTime: result.physicsTime,
              physicsSteps: result.physicsSteps,
              supersample: result.supersample,
              presets: result.presets,
              dataUrl: `data:image/png;base64,${Buffer.from(result.png).toString("base64")}`
            });
            return;
          }
          res.statusCode = 200;
          res.setHeader("content-type", "image/png");
          res.setHeader("cache-control", "no-store");
          res.setHeader("x-codex-reference-set", result.set);
          if (result.detail) {
            res.setHeader("x-codex-reference-detail", result.detail);
          }
          res.setHeader("x-codex-focus-parts", result.focusParts ? "1" : "0");
          if (result.partIds.length) {
            res.setHeader("x-codex-part-ids", result.partIds.join(","));
          }
          res.setHeader("x-codex-force-parts", result.forceParts ? "1" : "0");
          res.end(Buffer.from(result.png));
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error) });
        }
      });

      server.middlewares.use("/api/reference", async (req, res) => {
        try {
          if (req.method !== "GET") {
            sendJson(res, 405, { ok: false, error: "method not allowed" });
            return;
          }

          const rig = await readRigFile(rigPath);
          const sheets = referenceSheetDefinitionsForRig(rig).map((sheet) => ({
            ...sheet,
            sheetUrl: `/api/reference/sheet?set=${sheet.id}&width=360&height=500`,
            screenshotUrl: `/api/screenshot?set=${sheet.id}&width=360&height=500`
          }));
          const detailRegions = detailRegionDefinitionsForRig(rig).map((region) => ({
            ...region,
            sheetUrl: `/api/reference/sheet?set=reference-all&detail=${region.id}&width=300&height=300`,
            screenshotUrl: `/api/screenshot?set=modeling&detail=${region.id}&width=300&height=300`
          }));
          const phonemeReferences = mouthPhonemeTargetsWithUrls(rig);
          sendJson(res, 200, { ok: true, sheets, detailRegions, phonemeReferences, summary: summarizeRig(rig) });
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error) });
        }
      });
      server.middlewares.use("/api/phonemes", async (req, res) => {
        try {
          if (req.method !== "GET") {
            sendJson(res, 405, { ok: false, error: "method not allowed" });
            return;
          }

          const rig = await readRigFile(rigPath);
          const phonemeReferences = mouthPhonemeTargetsWithUrls(rig);
          sendJson(res, 200, { ok: true, phonemeReferences, count: phonemeReferences.length, summary: summarizeRig(rig) });
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error) });
        }
      });
      server.middlewares.use("/api/screenshot", async (req, res) => {
        try {
          if (req.method !== "GET") {
            sendJson(res, 405, { ok: false, error: "method not allowed" });
            return;
          }

          const requestUrl = new URL(req.url ?? "/", "http://localhost/api/screenshot");
          const rig = await readRigFile(rigPath);
          const result = await renderRigScreenshot(rig, publicDir, screenshotOptionsFromUrl(rig, requestUrl));

          if (requestUrl.searchParams.get("format") === "json") {
            sendJson(res, 200, {
              ok: true,
              width: result.width,
              height: result.height,
              set: result.set,
              detail: result.detail,
              focusParts: result.focusParts,
              partIds: result.partIds,
              forceParts: result.forceParts,
              parameters: result.parameters,
              physics: result.physics,
              physicsTime: result.physicsTime,
              physicsSteps: result.physicsSteps,
              supersample: result.supersample,
              presets: result.presets,
              dataUrl: `data:image/png;base64,${Buffer.from(result.png).toString("base64")}`
            });
            return;
          }

          const downloadName = requestUrl.searchParams.get("download");
          res.statusCode = 200;
          res.setHeader("content-type", "image/png");
          res.setHeader("x-codex-screenshot-width", String(result.width));
          res.setHeader("x-codex-screenshot-height", String(result.height));
          res.setHeader("x-codex-screenshot-set", result.set);
          if (result.detail) {
            res.setHeader("x-codex-screenshot-detail", result.detail);
          }
          res.setHeader("x-codex-focus-parts", result.focusParts ? "1" : "0");
          if (result.partIds.length) {
            res.setHeader("x-codex-part-ids", result.partIds.join(","));
          }
          res.setHeader("x-codex-force-parts", result.forceParts ? "1" : "0");
          if (downloadName) {
            res.setHeader("content-disposition", `attachment; filename="${downloadName.replace(/[^a-z0-9_.-]/gi, "_")}"`);
          }
          res.end(Buffer.from(result.png));
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error) });
        }
      });
      server.middlewares.use("/api/glue/vertex-pairs", async (req, res) => {
        try {
          if (req.method !== "POST") {
            sendJson(res, 405, { ok: false, error: "method not allowed; use POST" });
            return;
          }
          const body = parseJsonObject(await readBody(req));
          const rig = await readRigFile(rigPath);
          const partAId = typeof body.partAId === "string" ? body.partAId : "";
          const partBId = typeof body.partBId === "string" ? body.partBId : "";
          if (!partAId || !partBId) {
            sendJson(res, 400, { ok: false, error: "partAId and partBId are required" });
            return;
          }
          const result = buildGlueVertexPairs(rig, {
            partAId,
            partBId,
            maxDistance: typeof body.maxDistance === "number" ? body.maxDistance : undefined,
            weight: typeof body.weight === "number" ? body.weight : undefined,
            maxPairs: typeof body.maxPairs === "number" ? body.maxPairs : undefined
          });
          // Numeric only by default: the point list is what a caller commits, the coordinates are
          // diagnostic and are large enough to be worth opting into.
          const includePoints = body.includePoints === true;
          sendJson(res, 200, {
            ok: result.ok,
            revision: fullRigRevision(rig),
            partAId: result.partAId,
            partBId: result.partBId,
            maxDistance: result.maxDistance,
            weight: result.weight,
            aBoundaryVertices: result.aBoundaryVertices,
            bBoundaryVertices: result.bBoundaryVertices,
            pairCount: result.pairs.length,
            maxPairDistance: result.pairs.reduce((max, pair) => Math.max(max, pair.distance), 0),
            meanPairDistance: result.pairs.length ? result.pairs.reduce((sum, pair) => sum + pair.distance, 0) / result.pairs.length : 0,
            vertexPairs: result.pairs.map((pair) => (includePoints ? pair : { a: pair.a, b: pair.b, weight: pair.weight, restDx: pair.restDx, restDy: pair.restDy })),
            issues: result.issues
          });
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error) });
        }
      });
      server.middlewares.use("/api/glue-candidates", async (req, res) => {
        try {
          if (req.method !== "GET" && req.method !== "PATCH") {
            sendJson(res, 405, { ok: false, error: "method not allowed" });
            return;
          }

          const rig = await readRigFile(rigPath);
          const candidates = ensureRigGlueCandidates(rig);
          const id = glueCandidateRouteId(req);
          if (!id) {
            if (req.method === "GET") {
              sendJson(res, 200, {
                ok: true,
                glueCandidates: candidates.map((candidate) => glueCandidateListItem(rig, candidate)),
                counts: summarizeRig(rig).counts
              });
              return;
            }

            const body = parseJsonObject(await readBody(req));
            const rawCandidates = Array.isArray(body.glueCandidates) ? body.glueCandidates : Array.isArray(body.candidates) ? body.candidates : undefined;
            if (!rawCandidates) {
              sendJson(res, 400, { ok: false, error: "PATCH body must include glueCandidates array when no candidate id is provided." });
              return;
            }
            rig.glueCandidates = structuredClone(rawCandidates as typeof candidates);
            ensureRigGlueCandidates(rig);
            const validation = validateRig(rig);
            if (!validation.ok) {
              sendJson(res, 400, { ok: false, error: "patched glueCandidates are invalid", validation });
              return;
            }
            await writeRigFile(rigPath, rig);
            sendJson(res, 200, { ok: true, glueCandidates: ensureRigGlueCandidates(rig).map((candidate) => glueCandidateListItem(rig, candidate)), validation, summary: summarizeRig(rig) });
            server.ws.send({ type: "full-reload" });
            return;
          }

          const candidate = candidates.find((entry) => entry.id === id);
          if (!candidate) {
            sendJson(res, 404, { ok: false, error: `glue candidate not found: ${id}` });
            return;
          }

          if (req.method === "GET") {
            sendJson(res, 200, { ok: true, glueCandidate: glueCandidateListItem(rig, candidate), raw: candidate });
            return;
          }

          patchGlueCandidate(candidate, parseJsonObject(await readBody(req)), rig);
          const validation = validateRig(rig);
          if (!validation.ok) {
            sendJson(res, 400, { ok: false, error: "patched glue candidate is invalid", validation });
            return;
          }

          await writeRigFile(rigPath, rig);
          sendJson(res, 200, { ok: true, glueCandidate: glueCandidateListItem(rig, candidate), raw: candidate, validation, summary: summarizeRig(rig) });
          server.ws.send({ type: "full-reload" });
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error) });
        }
      });
      server.middlewares.use("/api/glue", async (req, res) => {
        try {
          if (req.method !== "GET" && req.method !== "PATCH" && req.method !== "POST") {
            sendJson(res, 405, { ok: false, error: "method not allowed" });
            return;
          }

          const rig = await readRigFile(rigPath);
          const id = glueRouteId(req);
          if (id === "promote") {
            if (req.method !== "POST") {
              sendJson(res, 405, { ok: false, error: "method not allowed" });
              return;
            }
            const body = parseJsonObject(await readBody(req));
            const candidateIds = Array.isArray(body.candidateIds)
              ? body.candidateIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
              : typeof body.candidateId === "string"
                ? [body.candidateId]
                : undefined;
            const mode = body.mode === "seam-debug" || body.mode === "soft-seam" ? body.mode : undefined;
            const result = promoteGlueCandidates(rig, {
              candidateIds,
              acceptedOnly: typeof body.acceptedOnly === "boolean" ? body.acceptedOnly : undefined,
              activate: typeof body.activate === "boolean" ? body.activate : undefined,
              markAccepted: typeof body.markAccepted === "boolean" ? body.markAccepted : undefined,
              mode
            });
            const validation = validateRig(rig);
            if (!validation.ok) {
              sendJson(res, 400, { ok: false, error: "promoted glue is invalid", result, validation });
              return;
            }
            await writeRigFile(rigPath, rig);
            sendJson(res, 200, {
              ok: true,
              result,
              glue: ensureRigGlue(rig).map((glue) => glueListItem(rig, glue)),
              glueCandidates: ensureRigGlueCandidates(rig).map((candidate) => glueCandidateListItem(rig, candidate)),
              validation,
              summary: summarizeRig(rig)
            });
            server.ws.send({ type: "full-reload" });
            return;
          }

          const glues = ensureRigGlue(rig);
          if (!id) {
            if (req.method === "GET") {
              sendJson(res, 200, {
                ok: true,
                glue: glues.map((glue) => glueListItem(rig, glue)),
                counts: summarizeRig(rig).counts
              });
              return;
            }
            if (req.method !== "PATCH") {
              sendJson(res, 405, { ok: false, error: "method not allowed" });
              return;
            }
            const body = parseJsonObject(await readBody(req));
            const rawGlue = Array.isArray(body.glue) ? body.glue : Array.isArray(body.glues) ? body.glues : undefined;
            if (!rawGlue) {
              sendJson(res, 400, { ok: false, error: "PATCH body must include glue array when no glue id is provided." });
              return;
            }
            rig.glue = structuredClone(rawGlue as typeof glues);
            ensureRigGlue(rig);
            const validation = validateRig(rig);
            if (!validation.ok) {
              sendJson(res, 400, { ok: false, error: "patched glue is invalid", validation });
              return;
            }
            await writeRigFile(rigPath, rig);
            sendJson(res, 200, { ok: true, glue: ensureRigGlue(rig).map((glue) => glueListItem(rig, glue)), validation, summary: summarizeRig(rig) });
            server.ws.send({ type: "full-reload" });
            return;
          }

          const glue = glues.find((entry) => entry.id === id);
          if (!glue) {
            sendJson(res, 404, { ok: false, error: `glue not found: ${id}` });
            return;
          }
          if (req.method === "GET") {
            sendJson(res, 200, { ok: true, glue: glueListItem(rig, glue), raw: glue });
            return;
          }
          if (req.method !== "PATCH") {
            sendJson(res, 405, { ok: false, error: "method not allowed" });
            return;
          }

          patchGlue(glue, parseJsonObject(await readBody(req)), rig);
          const validation = validateRig(rig);
          if (!validation.ok) {
            sendJson(res, 400, { ok: false, error: "patched glue is invalid", validation });
            return;
          }
          await writeRigFile(rigPath, rig);
          sendJson(res, 200, { ok: true, glue: glueListItem(rig, glue), raw: glue, validation, summary: summarizeRig(rig) });
          server.ws.send({ type: "full-reload" });
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error) });
        }
      });
      server.middlewares.use("/api/parts", async (req, res) => {
        try {
          if (req.method !== "GET" && req.method !== "PATCH") {
            sendJson(res, 405, { ok: false, error: "method not allowed" });
            return;
          }

          const rig = await readRigFile(rigPath);
          const id = partRouteId(req);
          if (!id) {
            sendJson(res, 200, {
              ok: true,
              parts: rig.parts.map(partListItem),
              counts: summarizeRig(rig).counts
            });
            return;
          }

          const part = rig.parts.find((entry) => entry.id === id);
          if (!part) {
            sendJson(res, 404, { ok: false, error: `part not found: ${id}` });
            return;
          }

          if (req.method === "GET") {
            sendJson(res, 200, { ok: true, part });
            return;
          }

          patchPart(part, parseJsonObject(await readBody(req)));
          const validation = validateRig(rig);
          if (!validation.ok) {
            sendJson(res, 400, { ok: false, error: "patched rig is invalid", validation });
            return;
          }

          await writeRigFile(rigPath, rig);
          sendJson(res, 200, { ok: true, part, validation, summary: summarizeRig(rig) });
          server.ws.send({ type: "full-reload" });
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error) });
        }
      });


      server.middlewares.use("/api/deformers", async (req, res) => {
        try {
          if (req.method !== "GET" && req.method !== "PATCH") {
            sendJson(res, 405, { ok: false, error: "method not allowed" });
            return;
          }

          const rig = await readRigFile(rigPath);
          const deformers = ensureRigDeformers(rig);
          const id = deformerRouteId(req);
          if (!id) {
            sendJson(res, 200, {
              ok: true,
              deformers: deformers.map((deformer) => deformerListItem(rig, deformer)),
              counts: summarizeRig(rig).counts
            });
            return;
          }

          const deformer = deformers.find((entry) => entry.id === id);
          if (!deformer) {
            sendJson(res, 404, { ok: false, error: `deformer not found: ${id}` });
            return;
          }

          if (req.method === "GET") {
            sendJson(res, 200, { ok: true, deformer, assignedPartIds: assignedPartIdsForDeformer(rig, deformer) });
            return;
          }

          patchDeformer(deformer, parseJsonObject(await readBody(req)), rig);
          const validation = validateRig(rig);
          if (!validation.ok) {
            sendJson(res, 400, { ok: false, error: "patched rig is invalid", validation });
            return;
          }

          await writeRigFile(rigPath, rig);
          sendJson(res, 200, { ok: true, deformer, assignedPartIds: assignedPartIdsForDeformer(rig, deformer), validation, summary: summarizeRig(rig) });
          server.ws.send({ type: "full-reload" });
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error) });
        }
      });
      // Live tracking-input relay: a visible sender page (editor) POSTs the
      // latest raw input values; display-only receivers (/obs?receive=1)
      // subscribe via Server-Sent Events. Registered before /api/tracking so
      // the prefix match does not swallow /api/tracking/stream.
      const trackingStreamClients = new Set<import("node:http").ServerResponse>();
      let lastTrackingStreamPayload: string | undefined;
      const trackingStreamHeartbeat = setInterval(() => {
        for (const client of trackingStreamClients) {
          client.write(":hb\\n\\n");
        }
      }, 15000);
      trackingStreamHeartbeat.unref?.();

      

      

      
      

      server.middlewares.use("/api/bundle", async (req, res) => {
        try {
          if (req.method !== "GET") {
            sendJson(res, 405, { ok: false, error: "method not allowed" });
            return;
          }
          const rig = await readRigFile(rigPath);
          sendJson(res, 200, await portableBundle(rig, publicDir));
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error) });
        }
      });

      

      
      server.middlewares.use("/api/params", async (req, res) => {
        try {
          if (req.method !== "GET" && req.method !== "PATCH") {
            sendJson(res, 405, { ok: false, error: "method not allowed" });
            return;
          }

          const rig = await readRigFile(rigPath);
          if (req.method === "PATCH") {
            writePreviewParameterValues(rig, parameterPatchFromBody(parseJsonObject(await readBody(req))));
            await writeRigFile(rigPath, rig);
            server.ws.send({ type: "full-reload" });
          }

          sendJson(res, 200, {
            ok: true,
            parameters: parameterDefinitionsForRig(rig),
            values: previewParameterValuesForRig(rig),
            summary: summarizeRig(rig)
          });
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error) });
        }
      });

      server.middlewares.use("/api/rig", async (req, res) => {
        try {
          if (req.method === "GET") {
            const requestUrl = new URL(req.url ?? "/api/rig", "http://localhost");
            const rig = await readRigFile(rigPath);
            sendJson(res, 200, requestUrl.searchParams.get("includeAssets") === "1" ? rig : sanitizeRigAssetPayload(rig));
            return;
          }

          if (req.method === "PUT" || req.method === "POST") {
            const body = await readBody(req);
            const parsed = migrateRigDocument(JSON.parse(body));
            await writeRigFile(rigPath, parsed);
            sendJson(res, 200, { ok: true, rigPath });
            server.ws.send({ type: "full-reload" });
            return;
          }

          sendJson(res, 405, { ok: false, error: "method not allowed" });
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error) });
        }
      });
}
