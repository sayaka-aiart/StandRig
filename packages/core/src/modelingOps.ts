import { matchesPartTarget as matchesTarget, type ModelingOperationTarget } from "./modelingTarget.js";
export type { ModelingOperationTarget } from "./modelingTarget.js";
import { executeDeformOperation } from './deformOperations.js';
import { validateAlphaReveal } from "./alphaReveal.js";
import { createAlphaContourArtMesh,createRectArtMesh } from "./artMesh.js";
import type { ArtMeshAlphaSampler } from "./artMeshAsset.js";
import { validateContourShade } from "./contourShade.js";
import type { ModelingOperationAction } from "./operationRegistry.js";
import { validatePartTint } from "./tint.js";
import type { ParameterCurve,ParameterInterpolation,RigArtMeshBinding,RigArtMeshVertexOffset,RigDocument,RigPartRole,RigSymmetryContract,RigSymmetryLink } from "./types.js";
import { defaultWarpDeformer } from "./warp.js";
export type { ModelingActionRegistry,ModelingOperationAction } from "./operationRegistry.js";



function executeParameterAdd(rig: RigDocument, operation: ModelingOperation, dryRun: boolean): ModelingOperationResult {
  const action = operation.action;
  if (action.type !== "parameter-add") throw new Error("parameter-add action required");
  const result: ModelingOperationResult = { operationId: operation.id, dryRun, matchedPartIds: ["rig"], changes: [], skipped: [] };
  const definition = action.parameter;
  const existing = rig.parameters.find((parameter) => parameter.id === definition.id);
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(definition)) result.skipped.push({ partId: "rig", reason: "parameter-conflict" });
    return result;
  }
  result.changes.push({ partId: "rig", path: "parameters." + definition.id, before: undefined, after: definition });
  if (!dryRun) rig.parameters.push(structuredClone(definition));
  return result;
}

function executeDeformerCreate(rig: RigDocument, operation: ModelingOperation, dryRun: boolean): ModelingOperationResult {
  const action = operation.action;
  if (action.type !== "deformer-create") throw new Error("deformer-create action required");
  const result: ModelingOperationResult = { operationId: operation.id, dryRun, matchedPartIds: ["rig"], changes: [], skipped: [] };
  const next = action.deformer;
  const existing = (rig.deformers ?? []).find((entry) => entry.id === next.id);
  if (existing) {
    result.skipped.push({ partId: next.id, reason: "deformer-already-exists" });
    return result;
  }
  result.changes.push({ partId: "rig", path: "deformers." + next.id, before: undefined, after: JSON.stringify(next) });
  if (!dryRun) {
    rig.deformers ??= [];
    rig.deformers.push(structuredClone(next));
  }
  return result;
}

function executeDeformerKindSet(rig: RigDocument, operation: ModelingOperation, dryRun: boolean): ModelingOperationResult {
  const action = operation.action;
  if (action.type !== "deformer-kind-set") throw new Error("deformer-kind-set action required");
  const result: ModelingOperationResult = { operationId: operation.id, dryRun, matchedPartIds: [], changes: [], skipped: [] };
  if (!operation.target.deformerIds?.includes(action.deformerId)) {
    result.skipped.push({ partId: action.deformerId, reason: "deformer-target-mismatch" });
    return result;
  }
  const deformer = (rig.deformers ?? []).find((entry) => entry.id === action.deformerId);
  if (!deformer) {
    result.skipped.push({ partId: action.deformerId, reason: "deformer-not-found" });
    return result;
  }
  result.matchedPartIds.push(deformer.id);
  if (deformer.kind !== action.kind) {
    result.changes.push({ partId: deformer.id, path: "kind", before: deformer.kind, after: action.kind });
    if (!dryRun) deformer.kind = action.kind;
  }
  if (action.kind === "warp") {
    const nextWarp = structuredClone(action.warp ?? deformer.warp ?? defaultWarpDeformer());
    if (JSON.stringify(deformer.warp ?? null) !== JSON.stringify(nextWarp)) {
      result.changes.push({ partId: deformer.id, path: "warp", before: deformer.warp ?? null, after: nextWarp });
      if (!dryRun) deformer.warp = nextWarp;
    }
  }
  return result;
}
function executeDeformerTargetsSet(rig: RigDocument, operation: ModelingOperation, dryRun: boolean): ModelingOperationResult {
  const action = operation.action;
  if (action.type !== "deformer-targets-set") throw new Error("deformer-targets-set action required");
  const result: ModelingOperationResult = { operationId: operation.id, dryRun, matchedPartIds: [], changes: [], skipped: [] };
  if (!operation.target.deformerIds?.includes(action.deformerId)) {
    result.skipped.push({ partId: action.deformerId, reason: "deformer-target-mismatch" });
    return result;
  }
  const deformer = (rig.deformers ?? []).find((entry) => entry.id === action.deformerId);
  if (!deformer) {
    result.skipped.push({ partId: action.deformerId, reason: "deformer-not-found" });
    return result;
  }
  const existingTargets = Array.isArray(deformer.targetPartIds) ? deformer.targetPartIds : [];
  const nextTargets = action.mode === "merge"
    ? [...new Set([...existingTargets, ...action.targetPartIds])]
    : [...new Set(action.targetPartIds)];
  result.matchedPartIds.push(deformer.id);
  const before = JSON.stringify(existingTargets);
  const after = JSON.stringify(nextTargets);
  if (before !== after) {
    result.changes.push({ partId: deformer.id, path: "targetPartIds", before: existingTargets, after: nextTargets });
    if (!dryRun) deformer.targetPartIds = nextTargets;
  }
  return result;
}
function executeDeformerParentSet(rig: RigDocument, operation: ModelingOperation, dryRun: boolean): ModelingOperationResult {
  const action = operation.action;
  if (action.type !== "deformer-parent-set") throw new Error("deformer-parent-set action required");
  const result: ModelingOperationResult = { operationId: operation.id, dryRun, matchedPartIds: [], changes: [], skipped: [] };
  if (!operation.target.deformerIds?.includes(action.deformerId)) {
    result.skipped.push({ partId: action.deformerId, reason: "deformer-target-mismatch" });
    return result;
  }
  const deformer = (rig.deformers ?? []).find((entry) => entry.id === action.deformerId);
  if (!deformer) {
    result.skipped.push({ partId: action.deformerId, reason: "deformer-not-found" });
    return result;
  }
  if (action.parentId === action.deformerId) {
    result.skipped.push({ partId: action.deformerId, reason: "deformer-parent-cycle" });
    return result;
  }
  if (action.parentId !== null && !(rig.deformers ?? []).some((entry) => entry.id === action.parentId)) {
    result.skipped.push({ partId: action.deformerId, reason: "deformer-parent-not-found" });
    return result;
  }
  result.matchedPartIds.push(deformer.id);
  if (deformer.parentId !== action.parentId) {
    result.changes.push({ partId: deformer.id, path: "parentId", before: deformer.parentId, after: action.parentId });
    if (!dryRun) deformer.parentId = action.parentId;
  }
  return result;
}
/**
 * Set a deformer's own static transform. Deformer geometry could previously only be changed through
 * parameter bindings, which forced callers to fake a constant with a binding whose keys are all
 * equal, and that reads as motion the model does not have.
 */
function executeDeformerTransform(rig: RigDocument, operation: ModelingOperation, dryRun: boolean): ModelingOperationResult {
  const action = operation.action;
  if (action.type !== "deformer-transform") throw new Error("deformer-transform action required");
  const result: ModelingOperationResult = { operationId: operation.id, dryRun, matchedPartIds: [], changes: [], skipped: [] };
  const deformer = (rig.deformers ?? []).find((entry) => entry.id === action.deformerId);
  if (!deformer) {
    result.skipped.push({ partId: action.deformerId, reason: "deformer-not-found" });
    return result;
  }
  result.matchedPartIds.push(action.deformerId);
  const before = deformer.transform[action.property];
  const after = action.operator === "set" ? action.value : action.operator === "add" ? before + action.value : before * action.value;
  if (!Number.isFinite(after)) throw new Error("deformer-transform result must be finite");
  if (before !== after) {
    result.changes.push({ partId: action.deformerId, path: "transform." + action.property, before, after });
    if (!dryRun) deformer.transform[action.property] = after;
  }
  return result;
}

function executeDeformerOrigin(rig: RigDocument, operation: ModelingOperation, dryRun: boolean): ModelingOperationResult {
  const action = operation.action;
  if (action.type !== "deformer-origin") throw new Error("deformer-origin action required");
  const result: ModelingOperationResult = { operationId: operation.id, dryRun, matchedPartIds: [], changes: [], skipped: [] };
  const deformer = (rig.deformers ?? []).find((entry) => entry.id === action.deformerId);
  if (!deformer) {
    result.skipped.push({ partId: action.deformerId, reason: "deformer-not-found" });
    return result;
  }
  result.matchedPartIds.push(action.deformerId);
  if (deformer.origin.x !== action.x) result.changes.push({ partId: action.deformerId, path: "origin.x", before: deformer.origin.x, after: action.x });
  if (deformer.origin.y !== action.y) result.changes.push({ partId: action.deformerId, path: "origin.y", before: deformer.origin.y, after: action.y });
  if (!dryRun) {
    deformer.origin.x = action.x;
    deformer.origin.y = action.y;
  }
  return result;
}

export interface ModelingOperation { id: string; name: string; enabled?: boolean; target: ModelingOperationTarget; action: ModelingOperationAction }
export interface ModelingOperationChange { partId: string; path: string; before: unknown; after: unknown }
export interface ModelingOperationResult { deformReports?: Array<Record<string, number|string|null>>; operationId: string; dryRun: boolean; matchedPartIds: string[]; changes: ModelingOperationChange[]; skipped: Array<{ partId: string; reason: string }> }

type InterpolationOptions = { interpolation?: ParameterInterpolation; curve?: ParameterCurve };
function applyInterpolationOptions(binding: InterpolationOptions, options: InterpolationOptions) {
  if (options.interpolation !== undefined) {
    binding.interpolation = options.interpolation;
    binding.curve = options.interpolation === "curve" && options.curve ? structuredClone(options.curve) : undefined;
  } else if (options.curve !== undefined) {
    binding.curve = structuredClone(options.curve);
  }
}

export function executeModelingOperation(rig: RigDocument, operation: ModelingOperation, options: { dryRun?: boolean; assetAlphaSamplers?: ReadonlyMap<string, ArtMeshAlphaSampler> } = {}): ModelingOperationResult {
  validateOperation(operation);
  const dryRun = options.dryRun === true;

  const result: ModelingOperationResult = { operationId: operation.id, dryRun, matchedPartIds: [], changes: [], skipped: [] };
  if (operation.enabled === false) return result;
  if(operation.action.type==="blend-shape-set"||operation.action.type==="deform-brush")return executeDeformOperation(rig,operation,dryRun);
  if (operation.action.type === "warp-pin-binding-key") return executeWarpPinBindingKey(rig, operation, dryRun);
  if (operation.action.type === "deformer-create") return executeDeformerCreate(rig, operation, dryRun);
  if (operation.action.type === "deformer-kind-set") return executeDeformerKindSet(rig, operation, dryRun);
  if (operation.action.type === "deformer-targets-set") return executeDeformerTargetsSet(rig, operation, dryRun);
  if (operation.action.type === "deformer-parent-set") return executeDeformerParentSet(rig, operation, dryRun);
  if (operation.action.type === "deformer-origin") return executeDeformerOrigin(rig, operation, dryRun);
  if (operation.action.type === "deformer-transform") return executeDeformerTransform(rig, operation, dryRun);
  if (operation.action.type === "deformer-binding-key") return executeDeformerBindingKey(rig, operation, dryRun);
  if (operation.action.type === "deformer-binding-remove") return executeDeformerBindingRemove(rig, operation, dryRun);
  if (operation.action.type === "deformer-split") return executeDeformerSplit(rig, operation, dryRun);
  if (operation.action.type === "deformer-rotation-metadata") return executeDeformerRotationMetadata(rig, operation, dryRun);
  if (operation.action.type === "symmetry-contract") return executeSymmetryContract(rig, operation, dryRun);
  if (operation.action.type === "symmetry-artmesh-bindings") return executeSymmetryArtMeshBindings(rig, operation, dryRun);
  if (operation.action.type === "parameter-add") return executeParameterAdd(rig, operation, dryRun);
  for (const part of rig.parts) {
    const match = matchesTarget(part, operation.target);
    if (!match.matched) { if (match.reason) result.skipped.push({ partId: part.id, reason: match.reason }); continue; }
    result.matchedPartIds.push(part.id);
    if (operation.action.type === "role-confirm") {
      const before = part.role ?? "unassigned";
      if (part.roleStatus === "confirmed" && part.role !== operation.action.role) {
        result.skipped.push({ partId: part.id, reason: "role-conflict" });
        continue;
      }
      if (part.role !== operation.action.role || part.roleStatus !== "confirmed" || part.roleConfidence !== 1) {
        result.changes.push({ partId: part.id, path: "role", before, after: operation.action.role });
        if (!dryRun) {
          part.role = operation.action.role;
          part.roleStatus = "confirmed";
          part.roleConfidence = 1;
        }
      }
    } else if (operation.action.type === "role-reclassify") {
      if (part.roleStatus !== "confirmed" || part.role !== operation.action.expectedRole) {
        result.skipped.push({ partId: part.id, reason: "expected-role-mismatch" });
        continue;
      }
      if (part.role === operation.action.role && part.roleConfidence === 1) continue;
      result.changes.push({ partId: part.id, path: "role", before: part.role, after: operation.action.role });
      if (!dryRun) {
        part.role = operation.action.role;
        part.roleStatus = "confirmed";
        part.roleConfidence = 1;
      }
    } else if (operation.action.type === "part-draw-order") {
      const before = part.drawOrder;
      const after = operation.action.drawOrder;
      if (before === after) continue;
      result.changes.push({ partId: part.id, path: "drawOrder", before, after });
      if (!dryRun) part.drawOrder = after;
    } else if (operation.action.type === "part-blend-mode") {
      const before = part.blendMode ?? "normal";
      const after = operation.action.mode;
      if (before === after) continue;
      result.changes.push({ partId: part.id, path: "blendMode", before, after });
      if (!dryRun) {
        if (after === "normal") delete part.blendMode;
        else part.blendMode = after;
      }
    } else if (operation.action.type === "part-visibility") {
      const before = part.visible !== false;
      const after = operation.action.visible;
      if (before === after) continue;
      result.changes.push({ partId: part.id, path: "visible", before, after });
      if (!dryRun) part.visible = after;
    } else if (operation.action.type === "part-tint") {
      const before = part.tint ? structuredClone(part.tint) : null;
      const after = operation.action.tint ? structuredClone(operation.action.tint) : null;
      if (JSON.stringify(before) === JSON.stringify(after)) continue;
      result.changes.push({ partId: part.id, path: "tint", before: before ?? undefined, after: after ?? undefined });
      if (!dryRun) {
        if (after) part.tint = after;
        else delete part.tint;
      }
    } else if (operation.action.type === "part-contour-shade") {
      const before = part.contourShade ?? null;
      const after = operation.action.shade;
      if (JSON.stringify(before) === JSON.stringify(after)) continue;
      result.changes.push({ partId: part.id, path: "contourShade", before, after });
      if (!dryRun) {
        if (after) part.contourShade = structuredClone(after);
        else delete part.contourShade;
      }
    } else if (operation.action.type === "part-alpha-reveal") {
      const before = part.alphaReveal ?? null;
      const after = operation.action.reveal;
      if (JSON.stringify(before) === JSON.stringify(after)) continue;
      result.changes.push({ partId: part.id, path: "alphaReveal", before, after });
      if (!dryRun) {
        if (after) part.alphaReveal = structuredClone(after);
        else delete part.alphaReveal;
      }
    } else if (operation.action.type === "part-clip") {
      const before = part.clip ? structuredClone(part.clip) : null;
      const after = operation.action.clip ? structuredClone(operation.action.clip) : null;
      if (JSON.stringify(before) === JSON.stringify(after)) continue;
      result.changes.push({ partId: part.id, path: "clip", before: before ?? undefined, after: after ?? undefined });
      if (!dryRun) {
        if (after) part.clip = after;
        else delete part.clip;
      }
    } else if (operation.action.type === "transform") {
      const property = operation.action.property;
      const before = part.transform[property];
      let after = operation.action.operator === "set" ? operation.action.value : operation.action.operator === "multiply" ? before * operation.action.value : before + operation.action.value;
      if (property === "opacity") after = Math.min(1, Math.max(0, after));
      if (!Number.isFinite(after) || before === after) continue;
      result.changes.push({ partId: part.id, path: `transform.${property}`, before, after });
      if (!dryRun) part.transform[property] = after;
    } else if (operation.action.type === "artmesh-generate" || operation.action.type === "artmesh-rebuild") {
      const action = operation.action;
      if (action.type === "artmesh-generate" && part.artMesh?.enabled) { result.skipped.push({ partId: part.id, reason: "artmesh-exists" }); continue; }
      const asset = part.assetId ? rig.assets.find((entry) => entry.id === part.assetId) : undefined;
      const width = asset?.width;
      const height = asset?.height;
      if (!asset || typeof width !== "number" || typeof height !== "number" || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        result.skipped.push({ partId: part.id, reason: "asset-dimensions-required" });
        continue;
      }
      const topology = action.topology ?? "rect-grid";
      const sampler = topology === "alpha-contour" ? options.assetAlphaSamplers?.get(asset.id) : undefined;
      if (topology === "alpha-contour" && !sampler) {
        result.skipped.push({ partId: part.id, reason: "alpha-sampler-required" });
        continue;
      }
      const generated = sampler
        ? createAlphaContourArtMesh(width, height, sampler.alphaAt, {
          preset: action.preset,
          columns: action.columns,
          rows: action.rows,
          alphaThreshold: action.alphaThreshold,
          alphaBounds: sampler.alphaBounds,
          quality: action.quality
        })
        : createRectArtMesh(width, height, {
          preset: action.preset,
          columns: action.columns,
          rows: action.rows,
          alphaThreshold: action.alphaThreshold,
          quality: action.quality
        });
      const previous = part.artMesh;
      const next = action.type === "artmesh-rebuild" && action.preserveBindings !== false && previous
        ? preserveArtMeshBindings(generated, previous)
        : generated;
      result.changes.push({ partId: part.id, path: action.type === "artmesh-rebuild" ? "artMesh.rebuilt.vertices" : "artMesh.generated.vertices", before: previous?.vertices.length ?? 0, after: next.vertices.length });
      if (!dryRun) part.artMesh = next;
    } else if (operation.action.type === "artmesh-quality") {
      const action = operation.action;
      if (!part.artMesh?.enabled) { result.skipped.push({ partId: part.id, reason: "artmesh-required" }); continue; }
      const beforeQuality = part.artMesh.generator.quality ?? {};
      const nextQuality = action.merge === false ? { ...action.quality } : { ...beforeQuality, ...action.quality };
      if (JSON.stringify(beforeQuality) !== JSON.stringify(nextQuality)) {
        result.changes.push({
          partId: part.id,
          path: "artMesh.generator.quality",
          before: beforeQuality.boundaryVertexIds?.length ?? 0,
          after: nextQuality.boundaryVertexIds?.length ?? 0
        });
        if (!dryRun) part.artMesh.generator.quality = nextQuality;
      }
    } else if (operation.action.type === "artmesh-binding-key") {
      executeArtMeshBindingKey(part, operation.action, dryRun, result);
    } else if (operation.action.type === "artmesh-multi-key") {
      executeArtMeshMultiKey(part, operation.action, dryRun, result);
    } else if (operation.action.type === "artmesh-blend-shape") {
      executeArtMeshBlendShape(part, operation.action, dryRun, result);
    } else if (operation.action.type === "artmesh-mirror-key") {
      executeArtMeshMirrorKey(part, operation.action, dryRun, result);
    } else if (operation.action.type === "binding-key") {
      const action = operation.action;
      part.bindings ??= [];
      let binding = part.bindings.find((entry) => entry.parameter === action.parameter && entry.property === action.property);
      if (!binding) { binding = { parameter: action.parameter, property: action.property, additive: action.additive ?? true, interpolation: action.interpolation ?? "smoothstep", curve: action.curve, keys: [] }; part.bindings.push(binding); }
      applyInterpolationOptions(binding, action);
      if (action.additive !== undefined && binding.additive !== action.additive) {
        result.changes.push({ partId: part.id, path: "bindings." + action.parameter + "." + action.property + ".additive", before: binding.additive, after: action.additive });
        if (!dryRun) binding.additive = action.additive;
      }
      binding.keys = Array.isArray(binding.keys) ? binding.keys : [];
      const existing = binding.keys.find((key) => Math.abs(key.input - action.input) < 0.0001);
      const before = existing?.value ?? 0;
      if (before !== action.value) result.changes.push({ partId: part.id, path: `bindings.${action.parameter}.${action.property}[${action.input}]`, before, after: action.value });
      if (!dryRun) { if (existing) existing.value = action.value; else binding.keys.push({ input: action.input, value: action.value }); binding.keys.sort((left, right) => left.input - right.input); }
    } else {
      const action = operation.action;
      if (!part.artMesh?.enabled) { result.skipped.push({ partId: part.id, reason: "artmesh-required" }); continue; }
      const region = action.uv;
      const lockedVertexIds = new Set(part.artMesh.generator.quality?.lockedVertexIds ?? []);
      part.artMesh.vertices.forEach((vertex, index) => {
        if (lockedVertexIds.has(vertex.id)) {
          result.skipped.push({ partId: part.id, reason: `artmesh-vertex-locked:${vertex.id}` });
          return;
        }
        if (region && (vertex.u < region.minU || vertex.u > region.maxU || vertex.v < region.minV || vertex.v > region.maxV)) return;
        for (const axis of ["x", "y"] as const) {
          const delta = action[axis];
          if (!delta) continue;
          const before = vertex[axis]; const after = before + delta;
          result.changes.push({ partId: part.id, path: `artMesh.vertices[${index}].${axis}`, before, after });
          if (!dryRun) vertex[axis] = after;
        }
      });
    }
  }
  return result;
}

function executeArtMeshBindingKey(part: RigDocument["parts"][number], action: Extract<ModelingOperationAction, { type: "artmesh-binding-key" }>, dryRun: boolean, result: ModelingOperationResult) {
  const mesh = part.artMesh;
  if (!mesh?.enabled) { result.skipped.push({ partId: part.id, reason: "artmesh-required" }); return; }
  const offsets = normalizeArtMeshKeyOffsets(mesh, action.offsets, result, part.id);
  if (!offsets) return;
  mesh.bindings ??= [];
  let binding = mesh.bindings.find((entry) => entry.parameter === action.parameter);
  if (!binding) {
    binding = { parameter: action.parameter, additive: action.additive ?? true, interpolation: action.interpolation ?? "smoothstep", curve: action.curve, keys: [] };
    mesh.bindings.push(binding);
  }
  applyInterpolationOptions(binding, action);
  const existing = binding.keys.find((key) => Math.abs(key.input - action.input) < 0.0001);
  const beforeCount = existing?.offsets?.length ?? 0;
  if (!existing || JSON.stringify(existing.offsets) !== JSON.stringify(offsets)) {
    result.changes.push({ partId: part.id, path: "artMesh.bindings." + action.parameter + "[" + action.input + "]", before: beforeCount, after: offsets.length });
  }
  if (!dryRun) {
    if (existing) existing.offsets = offsets;
    else binding.keys.push({ input: action.input, offsets });
    binding.keys.sort((left, right) => left.input - right.input);
  }
}

function executeArtMeshMirrorKey(part: RigDocument["parts"][number], action: Extract<ModelingOperationAction, { type: "artmesh-mirror-key" }>, dryRun: boolean, result: ModelingOperationResult) {
  const mesh = part.artMesh;
  if (!mesh?.enabled) { result.skipped.push({ partId: part.id, reason: "artmesh-required" }); return; }
  const binding = mesh.bindings?.find((entry) => entry.parameter === action.parameter);
  const source = binding?.keys.find((key) => Math.abs(key.input - action.sourceInput) < 0.0001);
  if (!binding || !source) { result.skipped.push({ partId: part.id, reason: "artmesh-source-key-not-found" }); return; }
  const axisU = action.axisU ?? 0.5;
  const tolerance = action.tolerance ?? 0.01;
  const protectedIds = new Set(action.protectVertexIds ?? []);
  const vertices = mesh.vertices;
  const locked = new Set(mesh.generator.quality?.lockedVertexIds ?? []);
  const mirrored: RigArtMeshVertexOffset[] = [];
  const usedTargets = new Set<string>();
  for (const offset of source.offsets ?? []) {
    const sourceVertex = vertices.find((vertex) => vertex.id === offset.vertexId);
    if (!sourceVertex) { result.skipped.push({ partId: part.id, reason: "artmesh-vertex-not-found:" + offset.vertexId }); return; }
    const targetU = 2 * axisU - sourceVertex.u;
    const onAxis = Math.abs(targetU - sourceVertex.u) <= tolerance;
    if (protectedIds.has(sourceVertex.id) || locked.has(sourceVertex.id)) continue;
    let target = onAxis ? sourceVertex : undefined;
    if (!target) {
      target = vertices
        .filter((vertex) => vertex.id !== sourceVertex.id && !usedTargets.has(vertex.id) && !locked.has(vertex.id) && !protectedIds.has(vertex.id))
        .filter((vertex) => Math.abs(vertex.u - targetU) <= tolerance && Math.abs(vertex.v - sourceVertex.v) <= tolerance)
        .sort((left, right) => (Math.abs(left.u - targetU) + Math.abs(left.v - sourceVertex.v)) - (Math.abs(right.u - targetU) + Math.abs(right.v - sourceVertex.v)))[0];
    }
    if (!target) continue;
    usedTargets.add(target.id);
    mirrored.push({ vertexId: target.id, x: onAxis ? 0 : -offset.x, y: offset.y });
  }
  if (!mirrored.length) { result.skipped.push({ partId: part.id, reason: "artmesh-mirror-no-editable-targets" }); return; }
  mesh.bindings ??= [];
  let targetBinding = mesh.bindings.find((entry) => entry.parameter === action.parameter);
  if (!targetBinding) {
    targetBinding = { parameter: action.parameter, additive: action.additive ?? binding.additive ?? true, interpolation: action.interpolation ?? binding.interpolation ?? "smoothstep", curve: action.curve ?? binding.curve, keys: [] };
    mesh.bindings.push(targetBinding);
  }
  applyInterpolationOptions(targetBinding, action);
  const existing = targetBinding.keys.find((key) => Math.abs(key.input - action.targetInput) < 0.0001);
  const beforeCount = existing?.offsets?.length ?? 0;
  if (!existing || JSON.stringify(existing.offsets) !== JSON.stringify(mirrored)) {
    result.changes.push({ partId: part.id, path: "artMesh.bindings." + action.parameter + "[" + action.targetInput + "] mirrored", before: beforeCount, after: mirrored.length });
  }
  if (!dryRun) {
    if (existing) existing.offsets = mirrored;
    else targetBinding.keys.push({ input: action.targetInput, offsets: mirrored });
    targetBinding.keys.sort((left, right) => left.input - right.input);
  }
}
function executeArtMeshMultiKey(part: RigDocument["parts"][number], action: Extract<ModelingOperationAction, { type: "artmesh-multi-key" }>, dryRun: boolean, result: ModelingOperationResult) {
  const mesh = part.artMesh;
  if (!mesh?.enabled) { result.skipped.push({ partId: part.id, reason: "artmesh-required" }); return; }
  const offsets = normalizeArtMeshKeyOffsets(mesh, action.offsets, result, part.id);
  if (!offsets) return;
  mesh.multiBindings ??= [];
  let binding = mesh.multiBindings.find((entry) => entry.parameters[0] === action.parameters[0] && entry.parameters[1] === action.parameters[1]);
  if (!binding) {
    binding = { parameters: action.parameters, additive: action.additive ?? true, interpolation: action.interpolation ?? "smoothstep", curve: action.curve, keyforms: [] };
    mesh.multiBindings.push(binding);
  }
  applyInterpolationOptions(binding, action);
  const existing = binding.keyforms.find((keyform) => Math.abs((keyform.inputs[action.parameters[0]] ?? 0) - action.inputs[action.parameters[0]]) < 0.0001 && Math.abs((keyform.inputs[action.parameters[1]] ?? 0) - action.inputs[action.parameters[1]]) < 0.0001);
  const beforeCount = existing?.offsets?.length ?? 0;
  if (!existing || JSON.stringify(existing.offsets) !== JSON.stringify(offsets)) {
    result.changes.push({ partId: part.id, path: "artMesh.multiBindings." + action.parameters.join("x") + "(" + action.inputs[action.parameters[0]] + "," + action.inputs[action.parameters[1]] + ")", before: beforeCount, after: offsets.length });
  }
  if (!dryRun) {
    if (existing) existing.offsets = offsets;
    else binding.keyforms.push({ inputs: { ...action.inputs }, offsets });
    const [xParameter, yParameter] = binding.parameters;
    binding.keyforms.sort((left, right) => (left.inputs[xParameter] ?? 0) - (right.inputs[xParameter] ?? 0) || (left.inputs[yParameter] ?? 0) - (right.inputs[yParameter] ?? 0));
  }
}

function executeArtMeshBlendShape(part: RigDocument["parts"][number], action: Extract<ModelingOperationAction, { type: "artmesh-blend-shape" }>, dryRun: boolean, result: ModelingOperationResult) {
  const mesh = part.artMesh;
  if (!mesh?.enabled) { result.skipped.push({ partId: part.id, reason: "artmesh-required" }); return; }
  const offsets = normalizeArtMeshKeyOffsets(mesh, action.offsets, result, part.id);
  if (!offsets) return;
  mesh.blendShapes ??= [];
  const existing = mesh.blendShapes.find((shape) => shape.id === action.id);
  const next = { id: action.id, parameter: action.parameter, neutralInput: action.neutralInput, targetInput: action.targetInput, offsets, additive: action.additive, interpolation: action.interpolation, curve: action.curve };
  if (JSON.stringify(existing) !== JSON.stringify(next)) {
    result.changes.push({ partId: part.id, path: "artMesh.blendShapes." + action.id, before: existing ? JSON.stringify(existing) : undefined, after: JSON.stringify(next) });
  }
  if (!dryRun) {
    if (existing) Object.assign(existing, next); else mesh.blendShapes.push(next);
  }
}

function validateArtMeshKeyOffsets(offsets: RigArtMeshVertexOffset[]) {
  if (!Array.isArray(offsets) || !offsets.length || offsets.some((offset) => !offset || typeof offset.vertexId !== "string" || !offset.vertexId.trim() || !Number.isFinite(offset.x) || !Number.isFinite(offset.y)) || new Set(offsets.map((offset) => offset.vertexId)).size !== offsets.length) {
    throw new Error("ArtMesh key offsets must contain unique finite vertex offsets");
  }
}

function normalizeArtMeshKeyOffsets(mesh: NonNullable<RigDocument["parts"][number]["artMesh"]>, offsets: RigArtMeshVertexOffset[], result: ModelingOperationResult, partId: string) {
  const ids = new Set(mesh.vertices.map((vertex) => vertex.id));
  const locked = new Set(mesh.generator.quality?.lockedVertexIds ?? []);
  const unknown = offsets.filter((offset) => !ids.has(offset.vertexId));
  if (unknown.length) { result.skipped.push({ partId, reason: "artmesh-vertex-not-found" }); return undefined; }
  const lockedOffsets = offsets.filter((offset) => locked.has(offset.vertexId));
  if (lockedOffsets.length) { result.skipped.push({ partId, reason: "artmesh-vertex-locked:" + lockedOffsets[0].vertexId }); return undefined; }
  return offsets.map((offset) => ({ vertexId: offset.vertexId, x: offset.x, y: offset.y }));
}
function executeWarpPinBindingKey(rig: RigDocument, operation: ModelingOperation, dryRun: boolean): ModelingOperationResult {
  const result: ModelingOperationResult = { operationId: operation.id, dryRun, matchedPartIds: [], changes: [], skipped: [] };
  const action = operation.action;
  if (action.type !== "warp-pin-binding-key") return result;
  if (!operation.target.deformerIds?.includes(action.deformerId)) {
    result.skipped.push({ partId: action.deformerId + ":" + action.pinId, reason: "deformer-target-mismatch" });
    return result;
  }
  const deformer = rig.deformers?.find((entry) => entry.id === action.deformerId);
  if (!deformer) {
    result.skipped.push({ partId: action.deformerId, reason: "deformer-not-found" });
    return result;
  }
  const pin = deformer.warp?.pins?.find((entry) => entry.id === action.pinId);
  if (!pin) {
    result.skipped.push({ partId: action.deformerId + ":" + action.pinId, reason: "warp-pin-not-found" });
    return result;
  }
  result.matchedPartIds.push(deformer.id + ":" + pin.id);
  pin.bindings ??= [];
  let binding = pin.bindings.find((entry) => entry.parameter === action.parameter && entry.property === action.property);
  if (!binding) {
    binding = { parameter: action.parameter, property: action.property, additive: action.additive ?? true, interpolation: action.interpolation ?? "smoothstep", curve: action.curve, keys: [] };
    pin.bindings.push(binding);
  }
  applyInterpolationOptions(binding, action);
  binding.keys = Array.isArray(binding.keys) ? binding.keys : [];
  const existing = binding.keys.find((key) => Math.abs(key.input - action.input) < 0.0001);
  const before = existing?.value ?? 0;
  if (before !== action.value) {
    result.changes.push({ partId: deformer.id + ":" + pin.id, path: "warp.pins." + pin.id + ".bindings." + action.parameter + "." + action.property + "[" + action.input + "]", before, after: action.value });
  }
  if (!dryRun) {
    if (existing) existing.value = action.value;
    else binding.keys.push({ input: action.input, value: action.value });
    binding.keys.sort((left, right) => left.input - right.input);
  }
  return result;
}
function executeDeformerBindingKey(rig: RigDocument, operation: ModelingOperation, dryRun: boolean): ModelingOperationResult {
  const result: ModelingOperationResult = { operationId: operation.id, dryRun, matchedPartIds: [], changes: [], skipped: [] };
  const action = operation.action;
  if (action.type !== "deformer-binding-key") return result;
  if (!operation.target.deformerIds?.includes(action.deformerId)) {
    result.skipped.push({ partId: action.deformerId, reason: "deformer-target-mismatch" });
    return result;
  }
  const deformer = rig.deformers?.find((entry) => entry.id === action.deformerId);
  if (!deformer) {
    result.skipped.push({ partId: action.deformerId, reason: "deformer-not-found" });
    return result;
  }
  result.matchedPartIds.push(deformer.id);
  deformer.bindings ??= [];
  let binding = deformer.bindings.find((entry) => entry.parameter === action.parameter && entry.property === action.property);
  if (!binding) {
    binding = { parameter: action.parameter, property: action.property, additive: action.additive ?? true, interpolation: action.interpolation ?? "smoothstep", curve: action.curve, keys: [] };
    deformer.bindings.push(binding);
  }
  applyInterpolationOptions(binding, action);
  if (action.additive !== undefined && binding.additive !== action.additive) {
    result.changes.push({ partId: deformer.id, path: "deformer.bindings." + action.parameter + "." + action.property + ".additive", before: binding.additive, after: action.additive });
    if (!dryRun) binding.additive = action.additive;
  }
  binding.keys = Array.isArray(binding.keys) ? binding.keys : [];
  const existing = binding.keys.find((key) => Math.abs(key.input - action.input) < 0.0001);
  const before = existing?.value ?? 0;
  if (before !== action.value) {
    result.changes.push({ partId: deformer.id, path: "deformer.bindings." + action.parameter + "." + action.property + "[" + action.input + "]", before, after: action.value });
  }
  if (!dryRun) {
    if (existing) existing.value = action.value;
    else binding.keys.push({ input: action.input, value: action.value });
    binding.keys.sort((left, right) => left.input - right.input);
  }
  return result;
}
function executeDeformerBindingRemove(rig: RigDocument, operation: ModelingOperation, dryRun: boolean): ModelingOperationResult {
  const result: ModelingOperationResult = { operationId: operation.id, dryRun, matchedPartIds: [], changes: [], skipped: [] };
  const action = operation.action;
  if (action.type !== "deformer-binding-remove") return result;
  if (!operation.target.deformerIds?.includes(action.deformerId)) {
    result.skipped.push({ partId: action.deformerId, reason: "deformer-target-mismatch" });
    return result;
  }
  const deformer = rig.deformers?.find((entry) => entry.id === action.deformerId);
  if (!deformer) {
    result.skipped.push({ partId: action.deformerId, reason: "deformer-not-found" });
    return result;
  }
  result.matchedPartIds.push(deformer.id);
  const bindings = deformer.bindings ?? [];
  const index = bindings.findIndex((entry) => entry.parameter === action.parameter && entry.property === action.property);
  if (index < 0) return result;
  const before = structuredClone(bindings[index]);
  result.changes.push({ partId: deformer.id, path: "deformer.bindings." + action.parameter + "." + action.property, before, after: undefined });
  if (!dryRun) bindings.splice(index, 1);
  return result;
}
function executeSymmetryContract(rig: RigDocument, operation: ModelingOperation, dryRun: boolean): ModelingOperationResult {
  const result: ModelingOperationResult = { operationId: operation.id, dryRun, matchedPartIds: ["__rig__"], changes: [], skipped: [] };
  const action = operation.action;
  if (action.type !== "symmetry-contract") return result;
  const before = rig.symmetry ? JSON.stringify(rig.symmetry) : undefined;
  const after = JSON.stringify(action.contract);
  if (before === after) return result;
  result.changes.push({ partId: "__rig__", path: "symmetry", before, after });
  if (!dryRun) rig.symmetry = structuredClone(action.contract);
  return result;
}
function executeSymmetryArtMeshBindings(rig: RigDocument, operation: ModelingOperation, dryRun: boolean): ModelingOperationResult {
  const result: ModelingOperationResult = { operationId: operation.id, dryRun, matchedPartIds: [], changes: [], skipped: [] };
  const action = operation.action;
  if (action.type !== "symmetry-artmesh-bindings") return result;
  const seen = new Set<string>();
  for (const link of action.links) {
    if (link.kind !== "part") continue;
    const sourceId = link.sourceId < link.targetId ? link.sourceId : link.targetId;
    const targetId = link.sourceId < link.targetId ? link.targetId : link.sourceId;
    const pairKey = `${sourceId}|${targetId}`;
    if (seen.has(pairKey)) continue;
    seen.add(pairKey);
    const source = rig.parts.find((part) => part.id === sourceId);
    const target = rig.parts.find((part) => part.id === targetId);
    if (!source || !target || !source.artMesh?.enabled || !target.artMesh?.enabled) {
      result.skipped.push({ partId: pairKey, reason: "symmetry-artmesh-required" });
      continue;
    }
    const sourceBindings = source.artMesh.bindings ?? [];
    if (!sourceBindings.length) continue;
    result.matchedPartIds.push(source.id, target.id);
    target.artMesh.bindings ??= [];
    for (const sourceBinding of sourceBindings) {
      const targetParameter = mirrorSymmetryParameter(sourceBinding.parameter);
      const mirroredKeys = sourceBinding.keys.map((key) => ({ input: key.input, offsets: mirrorArtMeshOffsets(source.artMesh!, target.artMesh!, key.offsets ?? [], result, target.id) }));
      if (mirroredKeys.some((key) => !key.offsets)) continue;
      const existing: RigArtMeshBinding | undefined = target.artMesh.bindings.find((binding) => binding.parameter === targetParameter);
      const nextBinding: RigArtMeshBinding = existing ?? { parameter: targetParameter, additive: sourceBinding.additive, interpolation: sourceBinding.interpolation, curve: structuredClone(sourceBinding.curve), keys: [] };
      const nextKeys: RigArtMeshBinding["keys"] = action.overwrite === false ? [...(existing?.keys ?? [])] : [];
      for (const mirrored of mirroredKeys) {
        const index = nextKeys.findIndex((key) => Math.abs(key.input - mirrored.input) < 0.0001);
        if (index >= 0) {
          if (action.overwrite !== false) nextKeys[index] = mirrored;
        } else nextKeys.push(mirrored);
      }
      nextKeys.sort((left, right) => left.input - right.input);
      const before = existing ? JSON.stringify(existing.keys) : undefined;
      const after = JSON.stringify(nextKeys);
      if (before === after) continue;
      result.changes.push({ partId: target.id, path: `artMesh.bindings.${targetParameter}`, before, after });
      if (!dryRun) {
        nextBinding.keys = nextKeys;
        if (existing) Object.assign(existing, nextBinding);
        else target.artMesh.bindings.push(nextBinding);
      }
    }
  }
  result.matchedPartIds = [...new Set(result.matchedPartIds)];
  return result;
}
function mirrorArtMeshOffsets(sourceMesh: NonNullable<RigDocument["parts"][number]["artMesh"]>, targetMesh: NonNullable<RigDocument["parts"][number]["artMesh"]>, offsets: RigArtMeshVertexOffset[], result: ModelingOperationResult, targetPartId: string): RigArtMeshVertexOffset[] {
  const targetVertices = targetMesh.vertices;
  const locked = new Set(targetMesh.generator.quality?.lockedVertexIds ?? []);
  const mirrored: RigArtMeshVertexOffset[] = [];
  const used = new Set<string>();
  for (const offset of offsets) {
    const sourceVertex = sourceMesh.vertices.find((vertex) => vertex.id === offset.vertexId);
    if (!sourceVertex) { result.skipped.push({ partId: targetPartId, reason: "symmetry-artmesh-source-vertex-not-found:" + offset.vertexId }); return []; }
    const candidates = targetVertices.filter((vertex) => !used.has(vertex.id) && !locked.has(vertex.id)).sort((left, right) => {
      const leftScore = Math.abs(left.u - (1 - sourceVertex.u)) + Math.abs(left.v - sourceVertex.v);
      const rightScore = Math.abs(right.u - (1 - sourceVertex.u)) + Math.abs(right.v - sourceVertex.v);
      return leftScore - rightScore;
    });
    const targetVertex = candidates[0];
    if (!targetVertex || Math.abs(targetVertex.u - (1 - sourceVertex.u)) > 0.08 || Math.abs(targetVertex.v - sourceVertex.v) > 0.08) { result.skipped.push({ partId: targetPartId, reason: "symmetry-artmesh-target-vertex-not-found:" + offset.vertexId }); return []; }
    used.add(targetVertex.id);
    mirrored.push({ vertexId: targetVertex.id, x: linkInvertX(offset.x), y: offset.y });
  }
  return mirrored.sort((left, right) => left.vertexId.localeCompare(right.vertexId));
}
function linkInvertX(value: number): number { return Math.abs(value) < 0.000001 ? 0 : -value; }
function mirrorSymmetryParameter(parameter: string): string {
  return parameter.replace(/ParamEyeL/g, "ParamEye__TEMP__").replace(/ParamEyeR/g, "ParamEyeL").replace(/ParamEye__TEMP__/g, "ParamEyeR");
}
function executeDeformerRotationMetadata(rig: RigDocument, operation: ModelingOperation, dryRun: boolean): ModelingOperationResult {
  const result: ModelingOperationResult = { operationId: operation.id, dryRun, matchedPartIds: [], changes: [], skipped: [] };
  const action = operation.action;
  if (action.type !== "deformer-rotation-metadata") return result;
  const deformer = (rig.deformers ?? []).find((entry) => entry.id === action.deformerId);
  if (!deformer) {
    result.skipped.push({ partId: action.deformerId, reason: "deformer-not-found" });
    return result;
  }
  result.matchedPartIds.push(deformer.id);
  if (deformer.kind !== "rotate") {
    result.skipped.push({ partId: deformer.id, reason: "rotation-metadata-rotate-only" });
    return result;
  }
  const before = deformer.rotationMetadata ? JSON.stringify(deformer.rotationMetadata) : undefined;
  const after = JSON.stringify(action.metadata);
  if (before === after) return result;
  result.changes.push({ partId: deformer.id, path: "rotationMetadata", before, after });
  if (!dryRun) deformer.rotationMetadata = action.metadata;
  return result;
}
function executeDeformerSplit(rig: RigDocument, operation: ModelingOperation, dryRun: boolean): ModelingOperationResult {
  const result: ModelingOperationResult = { operationId: operation.id, dryRun, matchedPartIds: [], changes: [], skipped: [] };
  const action = operation.action;
  if (action.type !== "deformer-split") return result;
  if (!operation.target.deformerIds?.includes(action.sourceDeformerId)) {
    result.skipped.push({ partId: action.sourceDeformerId, reason: "deformer-target-mismatch" });
    return result;
  }
  const deformers = rig.deformers ?? (dryRun ? [] : (rig.deformers = []));
  const source = deformers.find((entry) => entry.id === action.sourceDeformerId);
  if (!source) {
    result.skipped.push({ partId: action.sourceDeformerId, reason: "deformer-not-found" });
    return result;
  }
  result.matchedPartIds.push(source.id);
  if (source.kind !== "rotate") {
    result.skipped.push({ partId: source.id, reason: "deformer-split-rotate-only" });
    return result;
  }
  if (action.expectedParentId !== undefined && source.parentId !== action.expectedParentId && source.parentId !== action.parentDeformerId) {
    result.skipped.push({ partId: source.id, reason: "deformer-parent-mismatch" });
    return result;
  }
  const existingParent = deformers.find((entry) => entry.id === action.parentDeformerId);
  if (existingParent && existingParent.id !== source.parentId && existingParent.parentId !== source.parentId) {
    result.skipped.push({ partId: existingParent.id, reason: "deformer-parent-conflict" });
    return result;
  }
  const movedParameters = new Set(action.moveParameterIds);
  if ((source.multiBindings ?? []).some((binding) => binding.parameters.some((parameter) => movedParameters.has(parameter)))) {
    result.skipped.push({ partId: source.id, reason: "deformer-split-multi-binding-conflict" });
    return result;
  }
  const sourceBindings = source.bindings ?? [];
  const movedBindings = sourceBindings.filter((binding) => movedParameters.has(binding.parameter));
  const retainedBindings = sourceBindings.filter((binding) => !movedParameters.has(binding.parameter));
  if (existingParent && existingParent.bindings?.some((binding) => movedBindings.some((moved) => moved.parameter === binding.parameter && moved.property === binding.property))) {
    result.skipped.push({ partId: existingParent.id, reason: "deformer-split-binding-conflict" });
    return result;
  }
  if (source.parentId === action.parentDeformerId && existingParent && movedBindings.length === 0) {
    return result;
  }
  if (!existingParent && movedBindings.length === 0) {
    result.skipped.push({ partId: source.id, reason: "deformer-split-no-bindings" });
    return result;
  }
  const previousParentId = source.parentId;
  if (!existingParent) {
    result.changes.push({ partId: source.id, path: "deformers." + action.parentDeformerId, before: undefined, after: "created" });
  }
  if (previousParentId !== action.parentDeformerId) {
    result.changes.push({ partId: source.id, path: "deformer.parentId", before: previousParentId ?? undefined, after: action.parentDeformerId });
  }
  if (movedBindings.length > 0) {
    result.changes.push({ partId: source.id, path: "deformer.bindings.moved", before: movedBindings.length, after: retainedBindings.length });
  }
  if (dryRun) return result;

  let parent = existingParent;
  if (!parent) {
    parent = {
      id: action.parentDeformerId,
      name: action.parentName ?? source.name + " Body Anchor",
      kind: "rotate",
      parentId: previousParentId,
      visible: source.visible,
      origin: structuredClone(source.origin),
      transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, pivotX: 0, pivotY: 0, opacity: 1 },
      bindings: [],
      targetPartIds: [],
      tags: []
    };
    const sourceIndex = Math.max(0, deformers.findIndex((entry) => entry.id === source.id));
    deformers.splice(sourceIndex, 0, parent);
  }
  parent.bindings = [...(parent.bindings ?? []), ...movedBindings.map((binding) => structuredClone(binding))];
  parent.tags = [...new Set([...(parent.tags ?? []), "body", "body-anchor", "deformer-split", ...(action.parentTags ?? [])])];
  source.parentId = parent.id;
  source.bindings = retainedBindings;
  source.tags = [...new Set([...(source.tags ?? []), "local-angle", "deformer-split", ...(action.sourceTags ?? [])])];
  return result;
}
function preserveArtMeshBindings(next: ReturnType<typeof createRectArtMesh>, previous: NonNullable<import("./types").RigArtMesh>): ReturnType<typeof createRectArtMesh> {
  const validIds = new Set(next.vertices.map((vertex) => vertex.id));
  const filterOffsets = (offsets: RigArtMeshVertexOffset[]) => offsets.filter((offset) => validIds.has(offset.vertexId));
  next.bindings = (previous.bindings ?? []).map((binding) => ({ ...binding, keys: binding.keys.map((key) => ({ ...key, offsets: filterOffsets(key.offsets) })) }));
  next.multiBindings = (previous.multiBindings ?? []).map((binding) => ({ ...binding, keyforms: binding.keyforms.map((keyform) => ({ ...keyform, offsets: filterOffsets(keyform.offsets) })) }));
  next.blendShapes = (previous.blendShapes ?? []).map((shape) => ({ ...shape, offsets: filterOffsets(shape.offsets) }));
  const previousQuality = previous.generator.quality;
  if (previousQuality) {
    const boundaryIds = next.vertices.filter((vertex) => vertex.u === 0 || vertex.u === 1 || vertex.v === 0 || vertex.v === 1).map((vertex) => vertex.id);
    const mergeQualityIds = (ids: string[] | undefined) => [...new Set([...(ids ?? []).filter((id) => validIds.has(id)), ...boundaryIds])];
    next.generator.quality = {
      ...previousQuality,
      boundaryVertexIds: mergeQualityIds(previousQuality.boundaryVertexIds),
      lockedVertexIds: mergeQualityIds(previousQuality.lockedVertexIds),
      pinnedVertexIds: mergeQualityIds(previousQuality.pinnedVertexIds)
    };
  }
  return next;
}

function validateInterpolationOptions(interpolation: ParameterInterpolation | undefined, curve: ParameterCurve | undefined, label: string) {
  const allowed = ["linear", "smoothstep", "hold", "arc", "curve"];
  if (interpolation !== undefined && !allowed.includes(interpolation)) throw new Error(label + " interpolation is invalid");
  if (curve !== undefined && interpolation !== "curve") throw new Error(label + " curve requires interpolation=curve");
  if (interpolation !== "curve") return;
  if (!curve || !Array.isArray(curve.controlPoints) || curve.controlPoints.length < 2 || curve.controlPoints.length > 16) throw new Error(label + " curve requires 2..16 control points");
  const points = curve.controlPoints;
  if (points.some((point) => !point || !Number.isFinite(point.t) || !Number.isFinite(point.value) || point.t < 0 || point.t > 1 || point.value < 0 || point.value > 1)) throw new Error(label + " curve control points must be finite and normalized");
  for (let index = 1; index < points.length; index += 1) if (points[index - 1].t >= points[index].t) throw new Error(label + " curve control points must be strictly increasing");
  if (Math.abs(points[0].t) > 0.000001 || Math.abs(points[points.length - 1].t - 1) > 0.000001) throw new Error(label + " curve must include t=0 and t=1 endpoints");
}
function validateSymmetryArtMeshLinks(links: RigSymmetryLink[]) {
  if (!Array.isArray(links) || links.length > 256) throw new Error("symmetry-artmesh-bindings links must contain at most 256 entries");
  for (const link of links) {
    if (!link || link.kind !== "part" || typeof link.sourceId !== "string" || !link.sourceId.trim() || typeof link.targetId !== "string" || !link.targetId.trim() || link.sourceId === link.targetId) throw new Error("symmetry-artmesh-bindings link is invalid");
  }
}
function validateSymmetryContract(contract: RigSymmetryContract) {
  if (!contract || contract.version !== 1 || contract.axis !== "vertical") throw new Error("symmetry-contract version or axis is invalid");
  if (!Number.isFinite(contract.axisU) || contract.axisU < 0 || contract.axisU > 1) throw new Error("symmetry-contract axisU is invalid");
  if (!Number.isFinite(contract.tolerance) || contract.tolerance <= 0 || contract.tolerance > 0.25) throw new Error("symmetry-contract tolerance is invalid");
  if (!Number.isFinite(contract.confidence) || contract.confidence < 0 || contract.confidence > 1) throw new Error("symmetry-contract confidence is invalid");
  const validateIds = (ids: unknown, label: string) => {
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !id.trim()) || new Set(ids).size !== ids.length) throw new Error("symmetry-contract " + label + " must contain unique non-empty strings");
  };
  validateIds(contract.protectedPartIds, "protectedPartIds");
  validateIds(contract.protectedDeformerIds, "protectedDeformerIds");
  if (!contract.protectedVertexIds || typeof contract.protectedVertexIds !== "object" || Array.isArray(contract.protectedVertexIds)) throw new Error("symmetry-contract protectedVertexIds is invalid");
  for (const [partId, ids] of Object.entries(contract.protectedVertexIds)) {
    if (!partId.trim()) throw new Error("symmetry-contract protectedVertexIds contains an empty part id");
    validateIds(ids, "protectedVertexIds[" + partId + "]");
  }
  if (!Array.isArray(contract.links) || contract.links.length > 256) throw new Error("symmetry-contract links must contain at most 256 entries");
  const kinds = new Set(["part", "deformer", "warp-pin", "physics"]);
  for (const link of contract.links) {
    if (!link || !kinds.has(link.kind) || typeof link.sourceId !== "string" || !link.sourceId.trim() || typeof link.targetId !== "string" || !link.targetId.trim() || link.sourceId === link.targetId || link.axis !== "x") throw new Error("symmetry-contract link is invalid");
    if (link.invertX !== undefined && typeof link.invertX !== "boolean") throw new Error("symmetry-contract link invertX is invalid");
    if (link.preserveY !== undefined && typeof link.preserveY !== "boolean") throw new Error("symmetry-contract link preserveY is invalid");
  }
}function validateOperation(operation: ModelingOperation) {
  if (!operation?.id?.trim() || !operation.name?.trim()) throw new Error("Modeling operation requires id and name");
  if (!operation.target?.roles?.length && !operation.target?.partIds?.length && !operation.target?.deformerIds?.length) throw new Error("Modeling operation requires a role, partId, or deformerId target");
  const action = operation.action;
  if (!action) throw new Error("Modeling operation requires an action");
  if(action.type==="blend-shape-set"||action.type==="deform-brush")return;
  if (action.type === "part-draw-order") {
    if (typeof action.drawOrder !== "number" || !Number.isFinite(action.drawOrder)) throw new Error("part-draw-order drawOrder must be finite");
    return;
  }
  if (action.type === "part-contour-shade") {
    if (action.shade !== null && !validateContourShade(action.shade)) throw new Error("part-contour-shade is invalid");
    return;
  }
  if (action.type === "part-alpha-reveal") {
    if (action.reveal !== null && !validateAlphaReveal(action.reveal)) throw new Error("part-alpha-reveal is invalid");
    return;
  }
  if (action.type === "symmetry-contract") validateSymmetryContract(action.contract);
  if (action.type === "symmetry-artmesh-bindings") validateSymmetryArtMeshLinks(action.links);
  const values = action.type === "role-confirm" || action.type === "role-reclassify" || action.type === "parameter-add" || action.type === "deformer-create" || action.type === "deformer-kind-set" || action.type === "deformer-targets-set" || action.type === "deformer-parent-set" || action.type === "deformer-origin" || action.type === "deformer-binding-remove" || action.type === "part-visibility" || action.type === "part-blend-mode" || action.type === "part-tint" || action.type === "part-clip" || action.type === "deformer-split" || action.type === "deformer-rotation-metadata" || action.type === "symmetry-contract" || action.type === "symmetry-artmesh-bindings" ? [] : action.type === "transform" || action.type === "deformer-transform" ? [action.value] : action.type === "binding-key" || action.type === "warp-pin-binding-key" || action.type === "deformer-binding-key" ? [action.input, action.value] : action.type === "artmesh-binding-key" ? [action.input, ...action.offsets.flatMap((offset) => [offset.x, offset.y])] : action.type === "artmesh-multi-key" ? [action.inputs[action.parameters[0]], action.inputs[action.parameters[1]], ...action.offsets.flatMap((offset) => [offset.x, offset.y])] : action.type === "artmesh-blend-shape" ? [action.neutralInput, action.targetInput, ...action.offsets.flatMap((offset) => [offset.x, offset.y])] : action.type === "artmesh-mirror-key" ? [action.sourceInput, action.targetInput, action.axisU ?? 0.5, action.tolerance ?? 0.01] : action.type === "artmesh-quality" ? [action.quality?.minTriangleArea ?? 0, action.quality?.maxTriangleAspectRatio ?? 0] : action.type === "artmesh-generate" || action.type === "artmesh-rebuild" ? [action.columns, action.rows, action.alphaThreshold ?? 8] : [action.x, action.y, ...(action.uv ? [action.uv.minU, action.uv.maxU, action.uv.minV, action.uv.maxV] : [])];
  if (action.type === "part-blend-mode" && !["normal", "multiply", "screen", "additive"].includes(action.mode)) throw new Error("part-blend-mode mode is invalid");
  if (action.type === "part-visibility" && typeof action.visible !== "boolean") throw new Error("part-visibility visible must be boolean");
  if (action.type === "part-tint" && action.tint && validatePartTint(action.tint).length) throw new Error("part-tint tint is invalid");
  if (action.type === "part-clip" && action.clip) {
    const clip = action.clip;
    const hasSingle = typeof clip.maskPartId === "string" && clip.maskPartId.trim().length > 0;
    const maskPartIds = Array.isArray(clip.maskPartIds) ? clip.maskPartIds : undefined;
    const hasMultiple = maskPartIds !== undefined;
    const validMultiple = maskPartIds !== undefined && maskPartIds.length >= 1 && maskPartIds.length <= 8 && maskPartIds.every((id) => typeof id === "string" && id.trim() === id && id.length > 0) && new Set(maskPartIds).size === maskPartIds.length;
    if (clip.mode !== "alpha" || hasSingle === hasMultiple || (hasMultiple && !validMultiple) || (clip.maskOpacity !== undefined && clip.maskOpacity !== "rendered" && clip.maskOpacity !== "ignore")) throw new Error("part-clip clip is invalid");
  }
  if (action.type === "artmesh-quality") {
    const quality = action.quality;
    if (!quality || typeof quality !== "object") throw new Error("artmesh-quality requires a quality object");
    for (const [name, value] of [["minTriangleArea", quality.minTriangleArea], ["maxTriangleAspectRatio", quality.maxTriangleAspectRatio]] as const) {
      if (value !== undefined && (!Number.isFinite(value) || (name === "minTriangleArea" ? value < 0 : value < 1))) throw new Error(`artmesh-quality ${name} is invalid`);
    }
    for (const [name, ids] of [["boundaryVertexIds", quality.boundaryVertexIds], ["lockedVertexIds", quality.lockedVertexIds], ["pinnedVertexIds", quality.pinnedVertexIds]] as const) {
      if (ids !== undefined && (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !id.trim()) || new Set(ids).size !== ids.length)) throw new Error(`artmesh-quality ${name} must contain unique non-empty strings`);
    }
  }
  if (!values.every(Number.isFinite)) throw new Error("Modeling operation values must be finite");
  if (action.type === "deformer-create") {
    if (!operation.target.deformerIds?.includes(action.deformer.id)) throw new Error("deformer-create target must include deformer id");
    const deformer = action.deformer;
    if (!deformer || !deformer.id?.trim() || !deformer.name?.trim()) throw new Error("deformer-create requires id and name");
    if (!["group", "rotate", "warp"].includes(deformer.kind)) throw new Error("deformer-create kind is invalid");
    if (!deformer.origin || !Number.isFinite(deformer.origin.x) || !Number.isFinite(deformer.origin.y)) throw new Error("deformer-create origin is invalid");
    if (!deformer.transform || [deformer.transform.x, deformer.transform.y, deformer.transform.rotation, deformer.transform.scaleX, deformer.transform.scaleY, deformer.transform.pivotX, deformer.transform.pivotY, deformer.transform.opacity].some((value) => !Number.isFinite(value))) throw new Error("deformer-create transform is invalid");
    if (deformer.parentId !== null && typeof deformer.parentId !== "string") throw new Error("deformer-create parentId is invalid");
    if (deformer.targetPartIds !== undefined && (!Array.isArray(deformer.targetPartIds) || deformer.targetPartIds.some((id) => typeof id !== "string" || !id.trim()))) throw new Error("deformer-create targetPartIds is invalid");
  }
  if (action.type === "deformer-kind-set") {
    if (!operation.target.deformerIds?.includes(action.deformerId)) throw new Error("deformer-kind-set target must include deformer id");
    if (!action.deformerId?.trim()) throw new Error("deformer-kind-set requires deformerId");
    if (!["group", "rotate", "warp"].includes(action.kind)) throw new Error("deformer-kind-set kind is invalid");
    if (action.warp !== undefined && (typeof action.warp !== "object" || Array.isArray(action.warp))) throw new Error("deformer-kind-set warp is invalid");
  }
  if (action.type === "deformer-targets-set") {
    if (!operation.target.deformerIds?.includes(action.deformerId)) throw new Error("deformer-targets-set target must include deformer id");
    if (!action.deformerId?.trim()) throw new Error("deformer-targets-set requires deformerId");
    if (!Array.isArray(action.targetPartIds) || action.targetPartIds.some((id) => typeof id !== "string" || !id.trim()) || new Set(action.targetPartIds).size !== action.targetPartIds.length) throw new Error("deformer-targets-set targetPartIds must contain unique non-empty strings");
    if (action.mode !== undefined && action.mode !== "replace" && action.mode !== "merge") throw new Error("deformer-targets-set mode is invalid");
  }
  if (action.type === "deformer-parent-set") {
    if (!operation.target.deformerIds?.includes(action.deformerId)) throw new Error("deformer-parent-set target must include deformer id");
    if (!action.deformerId?.trim()) throw new Error("deformer-parent-set requires deformerId");
    if (action.parentId !== null && (typeof action.parentId !== "string" || !action.parentId.trim())) throw new Error("deformer-parent-set parentId is invalid");
    if (action.parentId === action.deformerId) throw new Error("deformer-parent-set cannot parent a deformer to itself");
  }
  if (action.type === "deformer-origin") {
    if (!operation.target.deformerIds?.includes(action.deformerId)) throw new Error("deformer-origin target must include deformer id");
    if (!action.deformerId?.trim() || !Number.isFinite(action.x) || !Number.isFinite(action.y)) throw new Error("deformer-origin requires a deformer id and finite x/y");
  }
  if (action.type === "parameter-add") {
    const parameter = action.parameter;
    if (!parameter || typeof parameter !== "object" || !parameter.id?.trim()) throw new Error("parameter-add requires a parameter definition");
    if (!Number.isFinite(parameter.min) || !Number.isFinite(parameter.max) || parameter.min >= parameter.max) throw new Error("parameter-add min/max range is invalid");
    if (!Number.isFinite(parameter.default) || parameter.default < parameter.min || parameter.default > parameter.max) throw new Error("parameter-add default must be within min/max");
    if (parameter.step !== undefined && (!Number.isFinite(parameter.step) || parameter.step <= 0)) throw new Error("parameter-add step must be positive");
  }
  if (action.type === "role-confirm") {
    if (!operation.target.partIds?.length) throw new Error("role-confirm requires explicit partIds");
    if (action.role === "unknown") throw new Error("role-confirm cannot confirm unknown role");
  }
  if (action.type === "role-reclassify") {
    if (!operation.target.partIds?.length) throw new Error("role-reclassify requires explicit partIds");
    if (action.expectedRole === "unknown" || action.role === "unknown" || action.expectedRole === action.role) throw new Error("role-reclassify requires distinct known roles");
    if (typeof action.reason !== "string" || action.reason.trim().length < 8) throw new Error("role-reclassify requires an audit reason");
  }
  if (action.type === "artmesh-binding-key") {
    validateArtMeshKeyOffsets(action.offsets);
    if (!action.parameter?.trim()) throw new Error("artmesh-binding-key requires parameter");
    validateInterpolationOptions(action.interpolation, action.curve, "artmesh-binding-key");
  }
  if (action.type === "artmesh-mirror-key") {
    if (!action.parameter?.trim() || !Number.isFinite(action.sourceInput) || !Number.isFinite(action.targetInput) || Math.abs(action.sourceInput - action.targetInput) < 0.0001) throw new Error("artmesh-mirror-key requires distinct finite source and target inputs");
    if (action.axisU !== undefined && (!Number.isFinite(action.axisU) || action.axisU < 0 || action.axisU > 1)) throw new Error("artmesh-mirror-key axisU is invalid");
    if (action.tolerance !== undefined && (!Number.isFinite(action.tolerance) || action.tolerance <= 0 || action.tolerance > 0.25)) throw new Error("artmesh-mirror-key tolerance is invalid");
    if (action.protectVertexIds !== undefined && (!Array.isArray(action.protectVertexIds) || action.protectVertexIds.some((id) => typeof id !== "string" || !id.trim()))) throw new Error("artmesh-mirror-key protectVertexIds is invalid");
    validateInterpolationOptions(action.interpolation, action.curve, "artmesh-mirror-key");
  }
  if (action.type === "artmesh-multi-key") {
    validateArtMeshKeyOffsets(action.offsets);
    if (!Array.isArray(action.parameters) || action.parameters.length !== 2 || !action.parameters[0]?.trim() || !action.parameters[1]?.trim() || action.parameters[0] === action.parameters[1]) throw new Error("artmesh-multi-key requires two distinct parameters");
    if (!action.inputs || !Number.isFinite(action.inputs[action.parameters[0]]) || !Number.isFinite(action.inputs[action.parameters[1]])) throw new Error("artmesh-multi-key inputs are invalid");
    validateInterpolationOptions(action.interpolation, action.curve, "artmesh-multi-key");
  }
  if (action.type === "artmesh-blend-shape") {
    validateArtMeshKeyOffsets(action.offsets);
    if (!action.id?.trim() || action.id.length > 80 || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(action.id)) throw new Error("artmesh-blend-shape id is invalid");
    if (!action.parameter?.trim() || !Number.isFinite(action.neutralInput) || !Number.isFinite(action.targetInput) || action.neutralInput === action.targetInput) throw new Error("artmesh-blend-shape requires distinct finite neutral and target inputs");
    validateInterpolationOptions(action.interpolation, action.curve, "artmesh-blend-shape");
  }  if (action.type === "artmesh-generate" || action.type === "artmesh-rebuild") {
    const label = action.type;
    if (!["eyelid", "eye", "mouth", "outline", "hair-root", "face-feature"].includes(action.preset)) throw new Error(`${label} preset is invalid`);
    if (action.topology !== undefined && !["rect-grid", "alpha-contour"].includes(action.topology)) throw new Error(`${label} topology is invalid`);
    if (!Number.isInteger(action.columns) || action.columns < 1 || action.columns > 16 || !Number.isInteger(action.rows) || action.rows < 1 || action.rows > 16) throw new Error(`${label} columns/rows must be integers from 1 to 16`);
    if (action.alphaThreshold !== undefined && (!Number.isInteger(action.alphaThreshold) || action.alphaThreshold < 1 || action.alphaThreshold > 255)) throw new Error(`${label} alphaThreshold must be an integer from 1 to 255`);
    if (action.type === "artmesh-rebuild" && action.preserveBindings !== undefined && typeof action.preserveBindings !== "boolean") throw new Error("artmesh-rebuild preserveBindings must be boolean");
  }
  if (action.type === "deformer-transform" && !["x", "y", "rotation", "scaleX", "scaleY", "opacity"].includes(action.property)) throw new Error("deformer-transform property is invalid");
  if (action.type === "binding-key" && !["x", "y", "rotation", "scaleX", "scaleY", "opacity"].includes(action.property)) throw new Error("binding-key property is invalid");
  if (action.type === "binding-key") validateInterpolationOptions(action.interpolation, action.curve, "binding-key");
  if (action.type === "deformer-binding-key") {
    if (!action.deformerId?.trim() || !action.parameter?.trim()) throw new Error("deformer-binding-key requires deformerId and parameter");
    if (!["x", "y", "rotation", "scaleX", "scaleY", "opacity", "warp.bendX", "warp.bendY", "warp.taperX", "warp.taperY"].includes(action.property)) throw new Error("deformer-binding-key property is invalid");
    validateInterpolationOptions(action.interpolation, action.curve, "deformer-binding-key");
  }
  if (action.type === "deformer-binding-remove") {
    if (!operation.target.deformerIds?.includes(action.deformerId)) throw new Error("deformer-binding-remove target must include deformerId");
    if (!action.deformerId?.trim() || !action.parameter?.trim()) throw new Error("deformer-binding-remove requires deformerId and parameter");
    if (!["x", "y", "rotation", "scaleX", "scaleY", "opacity", "warp.bendX", "warp.bendY", "warp.taperX", "warp.taperY"].includes(action.property)) throw new Error("deformer-binding-remove property is invalid");
  }
  if (action.type === "deformer-rotation-metadata") {
    if (!operation.target.deformerIds?.includes(action.deformerId)) throw new Error("deformer-rotation-metadata target must include deformerId");
    if (!action.deformerId?.trim()) throw new Error("deformer-rotation-metadata requires deformerId");
    const metadata = action.metadata;
    if (!metadata || metadata.version !== 1 || metadata.angleUnit !== "deg") throw new Error("deformer-rotation-metadata version or angleUnit is invalid");
    if (!metadata.angleRange || !Number.isFinite(metadata.angleRange.min) || !Number.isFinite(metadata.angleRange.max) || metadata.angleRange.min >= metadata.angleRange.max || metadata.angleRange.min < -360 || metadata.angleRange.max > 360) throw new Error("deformer-rotation-metadata angleRange is invalid");
    if (!metadata.pivot || !Number.isFinite(metadata.pivot.x) || !Number.isFinite(metadata.pivot.y) || !["stage", "normalized"].includes(metadata.pivotSpace)) throw new Error("deformer-rotation-metadata pivot is invalid");
    if (metadata.pivotSpace === "normalized" && (metadata.pivot.x < 0 || metadata.pivot.x > 1 || metadata.pivot.y < 0 || metadata.pivot.y > 1)) throw new Error("deformer-rotation-metadata normalized pivot is invalid");
    if (!["rigid", "rigid-plus-warp", "none"].includes(metadata.shapePreservation) || !["parent-first", "child-first"].includes(metadata.parentComposition)) throw new Error("deformer-rotation-metadata composition is invalid");
  }  if (action.type === "deformer-split") {
    if (!operation.target.deformerIds?.includes(action.sourceDeformerId)) throw new Error("deformer-split target must include sourceDeformerId");
    if (!action.sourceDeformerId?.trim() || !action.parentDeformerId?.trim() || action.sourceDeformerId === action.parentDeformerId) throw new Error("deformer-split requires distinct source and parent ids");
    if (!Array.isArray(action.moveParameterIds) || !action.moveParameterIds.length || action.moveParameterIds.some((id) => typeof id !== "string" || !id.trim()) || new Set(action.moveParameterIds).size !== action.moveParameterIds.length) throw new Error("deformer-split moveParameterIds must contain unique non-empty strings");
    for (const [name, tags] of [["parentTags", action.parentTags], ["sourceTags", action.sourceTags]] as const) {
      if (tags !== undefined && (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string" || !tag.trim()) || new Set(tags).size !== tags.length)) throw new Error("deformer-split " + name + " is invalid");
    }
    if (action.parentName !== undefined && (!action.parentName.trim() || action.parentName.length > 120)) throw new Error("deformer-split parentName is invalid");
    if (action.expectedParentId !== undefined && !action.expectedParentId.trim()) throw new Error("deformer-split expectedParentId is invalid");
  }
  if (action.type === "warp-pin-binding-key") {
    if (!action.deformerId?.trim() || !action.pinId?.trim() || !action.parameter?.trim()) throw new Error("warp-pin-binding-key requires deformerId, pinId, and parameter");
    if (!["offsetX", "offsetY"].includes(action.property)) throw new Error("warp-pin-binding-key property is invalid");
    validateInterpolationOptions(action.interpolation, action.curve, "warp-pin-binding-key");
  }
  if (action.type === "artmesh-offset" && action.uv && (action.uv.minU > action.uv.maxU || action.uv.minV > action.uv.maxV)) throw new Error("Modeling operation UV bounds are invalid");
}
