import { DEFAULT_TRANSFORM, type RigDeformer, type RigDocument, type RigPart, type Transform2D } from "./types.js";
import { normalizeWarpDeformer } from "./warp.js";
import { normalizeSharedWarpField } from "./sharedWarp.js";

export function ensureRigDeformers(rig: RigDocument): RigDeformer[] {
  if (!Array.isArray(rig.deformers)) {
    rig.deformers = [];
  }
  return rig.deformers;
}

export function deformerDefinitionsForRig(rig: RigDocument): RigDeformer[] {
  return Array.isArray(rig.deformers) ? rig.deformers : [];
}

export function createDefaultDeformer(id: string, name: string, origin = centerOrigin(0, 0)): RigDeformer {
  return {
    id,
    name,
    kind: "rotate",
    parentId: null,
    visible: true,
    origin,
    transform: defaultDeformerTransform(),
    bindings: [],
    targetPartIds: [],
    tags: []
  };
}

export function defaultDeformerTransform(): Transform2D {
  return { ...DEFAULT_TRANSFORM, x: 0, y: 0, pivotX: 0, pivotY: 0 };
}

export function centerOrigin(width: number, height: number) {
  return {
    x: Math.max(0, width / 2),
    y: Math.max(0, height / 2)
  };
}

export function deformerForPart(part: RigPart, deformers: RigDeformer[]): RigDeformer | undefined {
  if (part.deformerId) {
    return deformers.find((deformer) => deformer.id === part.deformerId);
  }
  return deformers.find((deformer) => deformer.targetPartIds?.includes(part.id));
}

export function normalizeDeformer(deformer: RigDeformer, rig: RigDocument): RigDeformer {
  const ids = new Set(deformerDefinitionsForRig(rig).map((entry) => entry.id));
  if (deformer.parentId === deformer.id || (deformer.parentId && !ids.has(deformer.parentId))) {
    deformer.parentId = null;
  }
  deformer.kind = deformer.kind === "group" || deformer.kind === "warp" ? deformer.kind : "rotate";
  deformer.visible = deformer.visible !== false;
  deformer.origin = {
    x: finiteNumber(deformer.origin?.x) ? deformer.origin.x : rig.stage.width / 2,
    y: finiteNumber(deformer.origin?.y) ? deformer.origin.y : rig.stage.height / 2
  };
  deformer.transform = { ...defaultDeformerTransform(), ...(deformer.transform ?? {}) };
  if (deformer.kind === "warp" || deformer.warp) {
    deformer.warp = normalizeWarpDeformer(deformer.warp);
  }
  if (deformer.sharedWarp) {
    deformer.sharedWarp = normalizeSharedWarpField(deformer.sharedWarp);
  }
  deformer.targetPartIds = Array.isArray(deformer.targetPartIds)
    ? deformer.targetPartIds.filter((id): id is string => typeof id === "string")
    : [];
  deformer.bindings = Array.isArray(deformer.bindings) ? deformer.bindings : [];
  return deformer;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}