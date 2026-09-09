import type { RigDeformer, RigWarpPin, RigWarpPinBinding } from "./types.js";
import { normalizeWarpDeformer } from "./warp.js";

export type WarpPinMirrorAction = "link" | "apply" | "unlink";

export interface WarpPinMirrorOptions {
  create?: boolean;
  tolerance?: number;
}

export interface WarpPinMirrorResult {
  ok: boolean;
  action: WarpPinMirrorAction;
  deformerId?: string;
  sourcePinId?: string;
  targetPinId?: string;
  sourcePinIndex?: number;
  targetPinIndex?: number;
  created?: boolean;
  applied?: boolean;
  linked?: boolean;
  reason?: string;
}

export function linkWarpPinMirrorInDeformer(
  deformer: RigDeformer,
  sourcePinIndex: number,
  options: WarpPinMirrorOptions = {}
): WarpPinMirrorResult {
  return updateWarpPinMirrorLink(deformer, sourcePinIndex, "link", options);
}

export function applyWarpPinMirrorInDeformer(
  deformer: RigDeformer,
  sourcePinIndex: number,
  options: WarpPinMirrorOptions = {}
): WarpPinMirrorResult {
  return updateWarpPinMirrorLink(deformer, sourcePinIndex, "apply", options);
}

export function unlinkWarpPinMirrorInDeformer(deformer: RigDeformer, sourcePinIndex: number): WarpPinMirrorResult {
  if (deformer.kind !== "warp") {
    return { ok: false, action: "unlink", deformerId: deformer.id, reason: "deformer is not warp" };
  }
  const warp = normalizeWarpDeformer(deformer.warp);
  const pins = warp.pins ?? [];
  const source = pins[sourcePinIndex];
  if (!source) {
    return { ok: false, action: "unlink", deformerId: deformer.id, reason: "source pin not found" };
  }
  const targetIndex = source.linkedMirrorId ? pins.findIndex((pin) => pin.id === source.linkedMirrorId) : -1;
  const target = targetIndex >= 0 ? pins[targetIndex] : undefined;
  const targetId = source.linkedMirrorId;
  delete source.linkedMirrorId;
  if (target?.linkedMirrorId === source.id) {
    delete target.linkedMirrorId;
  }
  warp.pins = pins;
  deformer.warp = normalizeWarpDeformer(warp);
  return {
    ok: true,
    action: "unlink",
    deformerId: deformer.id,
    sourcePinId: source.id,
    targetPinId: targetId,
    sourcePinIndex,
    targetPinIndex: targetIndex >= 0 ? targetIndex : undefined,
    linked: false
  };
}

function updateWarpPinMirrorLink(
  deformer: RigDeformer,
  sourcePinIndex: number,
  action: "link" | "apply",
  options: WarpPinMirrorOptions
): WarpPinMirrorResult {
  if (deformer.kind !== "warp") {
    return { ok: false, action, deformerId: deformer.id, reason: "deformer is not warp" };
  }

  const warp = normalizeWarpDeformer(deformer.warp);
  const pins = warp.pins ?? [];
  const source = pins[sourcePinIndex];
  if (!source) {
    return { ok: false, action, deformerId: deformer.id, reason: "source pin not found" };
  }

  const create = options.create !== false;
  const tolerance = Math.max(0.001, options.tolerance ?? 0.08);
  const targetU = roundPinUv(1 - source.u);
  const targetV = roundPinUv(source.v);
  let targetIndex = source.linkedMirrorId ? pins.findIndex((pin) => pin.id === source.linkedMirrorId) : -1;
  if (targetIndex < 0) {
    targetIndex = findMirroredWarpPinIndex(pins, sourcePinIndex, targetU, targetV, tolerance);
  }
  let target = targetIndex >= 0 ? pins[targetIndex] : undefined;
  let created = false;

  if (!target) {
    if (!create || pins.length >= 32) {
      return {
        ok: false,
        action,
        deformerId: deformer.id,
        sourcePinId: source.id,
        sourcePinIndex,
        reason: pins.length >= 32 ? "pin limit reached" : "mirror target not found"
      };
    }
    target = mirrorWarpPin(source);
    target.id = uniqueWarpPinId(pins, mirroredWarpPinId(source.id));
    target.name = mirroredWarpPinName(source.name);
    pins.push(target);
    targetIndex = pins.length - 1;
    created = true;
  } else if (action === "apply") {
    copyMirroredWarpPinInto(source, target);
  }

  source.linkedMirrorId = target.id;
  target.linkedMirrorId = source.id;
  if (created || action === "apply") {
    target.u = targetU;
    target.v = targetV;
  }

  warp.pins = pins;
  deformer.warp = normalizeWarpDeformer(warp);
  const normalizedTarget = deformer.warp.pins?.[targetIndex];
  return {
    ok: true,
    action,
    deformerId: deformer.id,
    sourcePinId: source.id,
    targetPinId: normalizedTarget?.id ?? target.id,
    sourcePinIndex,
    targetPinIndex: targetIndex,
    created,
    applied: action === "apply",
    linked: true
  };
}

function copyMirroredWarpPinInto(source: RigWarpPin, target: RigWarpPin) {
  const id = target.id;
  const name = target.name;
  const linkedMirrorId = target.linkedMirrorId;
  Object.assign(target, mirrorWarpPin(source));
  target.id = id;
  target.name = name;
  target.linkedMirrorId = linkedMirrorId;
}

function findMirroredWarpPinIndex(pins: RigWarpPin[], sourceIndex: number, targetU: number, targetV: number, tolerance: number): number {
  let bestIndex = -1;
  let bestScore = Number.POSITIVE_INFINITY;
  pins.forEach((pin, index) => {
    if (index === sourceIndex) {
      return;
    }
    const uDistance = Math.abs(pin.u - targetU);
    const vDistance = Math.abs(pin.v - targetV);
    if (uDistance > tolerance || vDistance > tolerance) {
      return;
    }
    const score = uDistance + vDistance * 1.5;
    if (score < bestScore) {
      bestIndex = index;
      bestScore = score;
    }
  });
  return bestIndex;
}

function mirrorWarpPin(source: RigWarpPin): RigWarpPin {
  return {
    ...structuredClone(source),
    linkedMirrorId: undefined,
    u: roundPinUv(1 - source.u),
    v: roundPinUv(source.v),
    offsetX: roundForEditor(-source.offsetX),
    offsetY: roundForEditor(source.offsetY),
    bindings: (source.bindings ?? []).map(mirrorWarpPinBinding)
  };
}

function mirrorWarpPinBinding(binding: RigWarpPinBinding): RigWarpPinBinding {
  const mirrored = structuredClone(binding);
  mirrored.keys = mirrored.keys
    .map((key) => ({
      input: key.input,
      value: roundForEditor(binding.property === "offsetX" ? -key.value : key.value)
    }))
    .sort((left, right) => left.input - right.input);
  return mirrored;
}

function uniqueWarpPinId(pins: RigWarpPin[], preferredId: string): string {
  const existing = new Set(pins.map((pin) => pin.id));
  let id = preferredId || "pin-mirror";
  let index = 1;
  while (existing.has(id)) {
    id = `${preferredId || "pin-mirror"}-${index}`;
    index += 1;
  }
  return id;
}

function mirroredWarpPinId(id: string): string {
  const mirrored = swapSideText(id);
  return mirrored === id ? `${id}-mirror` : mirrored;
}

function mirroredWarpPinName(name: string): string {
  const mirrored = swapSideText(name);
  return mirrored === name ? `${name} Mirror` : mirrored;
}

function swapSideText(value: string): string {
  const map: Record<string, string> = {
    left: "right",
    right: "left",
    Left: "Right",
    Right: "Left",
    LEFT: "RIGHT",
    RIGHT: "LEFT",
    左: "右",
    右: "左"
  };
  return value.replace(/left|right|Left|Right|LEFT|RIGHT|左|右/g, (token) => map[token] ?? token);
}

function roundForEditor(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundPinUv(value: number): number {
  return Math.round(value * 1000) / 1000;
}
