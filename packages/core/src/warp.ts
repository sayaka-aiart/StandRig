import { normalizeParameterInterpolation } from "./bindings.js";
import { sampleMultiParameterBinding } from "./multiBindings.js";
import {
  PARAMETER_IDS,
  TRANSFORM_PROPERTIES,
  WARP_BINDING_PROPERTIES,
  WARP_PIN_BINDING_PROPERTIES,
  type BindingProperty,
  type ParameterBinding,
  type ParameterValues,
  type RigDeformer,
  type RigWarpDeformer,
  type RigWarpPin,
  type RigWarpPinBinding,
  type TransformProperty,
  type WarpBindingProperty,
  type WarpPinBindingProperty
} from "./types.js";

export type ResolvedWarpDeformer = RigWarpDeformer;

const resolvedPinScopes = new WeakMap<RigWarpPin, string>();

export interface WarpBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface WarpPoint {
  x: number;
  y: number;
}

export const WARP_PROPERTY_LABELS: Record<WarpBindingProperty, string> = {
  "warp.bendX": "Warp Bend X",
  "warp.bendY": "Warp Bend Y",
  "warp.taperX": "Warp Taper X",
  "warp.taperY": "Warp Taper Y"
};

export const WARP_PIN_PROPERTY_LABELS: Record<WarpPinBindingProperty, string> = {
  offsetX: "Pin Offset X",
  offsetY: "Pin Offset Y"
};

export function defaultWarpDeformer(): RigWarpDeformer {
  return {
    enabled: true,
    bendX: 0,
    bendY: 0,
    taperX: 0,
    taperY: 0,
    grid: {
      columns: 4,
      rows: 4
    },
    pins: []
  };
}

export function createDefaultWarpPin(index = 0): RigWarpPin {
  const side = index % 3;
  return normalizeWarpPin({
    id: `pin-${index + 1}`,
    name: `Pin ${index + 1}`,
    enabled: true,
    u: side === 0 ? 0.5 : side === 1 ? 0.25 : 0.75,
    v: index < 3 ? 0.5 : 0.85,
    offsetX: 0,
    offsetY: 0,
    radius: 0.28,
    strength: 0.75,
    bindings: []
  }, index);
}

export function createDefaultWarpPinBinding(parameter: string = PARAMETER_IDS[0], property: WarpPinBindingProperty = "offsetX", magnitude = 8): RigWarpPinBinding {
  return normalizeWarpPinBinding({
    parameter,
    property,
    additive: true,
    interpolation: "smoothstep",
    keys: [
      { input: -1, value: -magnitude },
      { input: 0, value: 0 },
      { input: 1, value: magnitude }
    ]
  });
}

export function normalizeWarpDeformer(warp: Partial<RigWarpDeformer> | undefined): RigWarpDeformer {
  const fallback = defaultWarpDeformer();
  const grid = warp?.grid;
  return {
    enabled: warp?.enabled !== false,
    pinBlendMode: warp?.pinBlendMode === "normalized" ? "normalized" : "legacy",
    bendX: finiteNumber(warp?.bendX, fallback.bendX),
    bendY: finiteNumber(warp?.bendY, fallback.bendY),
    taperX: finiteNumber(warp?.taperX, fallback.taperX),
    taperY: finiteNumber(warp?.taperY, fallback.taperY),
    grid: {
      columns: clampInteger(finiteNumber(grid?.columns, fallback.grid.columns), 1, 16),
      rows: clampInteger(finiteNumber(grid?.rows, fallback.grid.rows), 1, 16)
    },
    pins: Array.isArray(warp?.pins) ? warp.pins.slice(0, 32).map((pin, index) => normalizeWarpPin(pin, index)) : []
  };
}

export function normalizeWarpPin(pin: Partial<RigWarpPin> | undefined, index = 0): RigWarpPin {
  return {
    id: typeof pin?.id === "string" && pin.id.trim() ? pin.id : `pin-${index + 1}`,
    name: typeof pin?.name === "string" && pin.name.trim() ? pin.name : `Pin ${index + 1}`,
    enabled: pin?.enabled !== false,
    multiBindings: Array.isArray(pin?.multiBindings) ? structuredClone(pin.multiBindings) : [],
    u: clamp01(finiteNumber(pin?.u, 0.5)),
    v: clamp01(finiteNumber(pin?.v, 0.5)),
    offsetX: finiteNumber(pin?.offsetX, 0),
    offsetY: finiteNumber(pin?.offsetY, 0),
    radius: clamp(finiteNumber(pin?.radius, 0.28), 0.001, 1.5),
    strength: clamp(finiteNumber(pin?.strength, 0.75), 0, 1),
    linkedMirrorId: typeof pin?.linkedMirrorId === "string" && pin.linkedMirrorId.trim() ? pin.linkedMirrorId : undefined,
    bindings: Array.isArray(pin?.bindings) ? pin.bindings.slice(0, 16).map((binding) => normalizeWarpPinBinding(binding)) : []
  };
}

export function normalizeWarpPinBinding(binding: Partial<RigWarpPinBinding> | undefined): RigWarpPinBinding {
  const property = isWarpPinBindingProperty(binding?.property) ? binding.property : "offsetX";
  const keys = Array.isArray(binding?.keys)
    ? binding.keys
        .map((key) => ({ input: finiteNumber(key?.input, 0), value: finiteNumber(key?.value, 0) }))
        .sort((left, right) => left.input - right.input)
    : [];
  return {
    parameter: typeof binding?.parameter === "string" && binding.parameter.trim() ? binding.parameter : PARAMETER_IDS[0],
    property,
    keys: keys.length ? keys : [{ input: 0, value: 0 }],
    additive: binding?.additive !== false,
    interpolation: normalizeParameterInterpolation(binding?.interpolation)
  };
}

export function isTransformBindingProperty(property: BindingProperty | string): property is TransformProperty {
  return (TRANSFORM_PROPERTIES as readonly string[]).includes(property);
}

export function isWarpBindingProperty(property: BindingProperty | string): property is WarpBindingProperty {
  return (WARP_BINDING_PROPERTIES as readonly string[]).includes(property);
}

export function isWarpPinBindingProperty(property: unknown): property is WarpPinBindingProperty {
  return typeof property === "string" && (WARP_PIN_BINDING_PROPERTIES as readonly string[]).includes(property);
}

export function getWarpBindingProperty(warp: RigWarpDeformer, property: WarpBindingProperty): number {
  if (property === "warp.bendX") {
    return warp.bendX;
  }
  if (property === "warp.bendY") {
    return warp.bendY;
  }
  if (property === "warp.taperX") {
    return warp.taperX;
  }
  return warp.taperY;
}

export function setWarpBindingProperty(warp: RigWarpDeformer, property: WarpBindingProperty, value: number) {
  if (property === "warp.bendX") {
    warp.bendX = value;
  } else if (property === "warp.bendY") {
    warp.bendY = value;
  } else if (property === "warp.taperX") {
    warp.taperX = value;
  } else {
    warp.taperY = value;
  }
}

export function hasWarpEffect(warp: RigWarpDeformer | undefined): warp is RigWarpDeformer {
  return !!warp && warp.enabled && (
    Math.abs(warp.bendX) > 0.001 ||
    Math.abs(warp.bendY) > 0.001 ||
    Math.abs(warp.taperX) > 0.001 ||
    Math.abs(warp.taperY) > 0.001 ||
    (warp.pins ?? []).some(
      (pin) =>
        pin.enabled !== false &&
        pin.strength > 0.001 &&
        (Math.abs(pin.offsetX) > 0.001 || Math.abs(pin.offsetY) > 0.001 || hasWarpPinBindingEffect(pin))
    )
  );
}

export function resolveDeformerWarp(
  deformer: RigDeformer,
  values: ParameterValues,
  sampleBinding: (binding: ParameterBinding | RigWarpPinBinding, input: number) => number
): ResolvedWarpDeformer | undefined {
  if (deformer.kind !== "warp") {
    return undefined;
  }

  const warp = normalizeWarpDeformer(deformer.warp);
  for (const pin of warp.pins ?? []) {
    resolvedPinScopes.set(pin, deformer.id);
  }
  for (const binding of deformer.bindings ?? []) {
    if (!isWarpBindingProperty(binding.property)) {
      continue;
    }
    const sampled = sampleBinding(binding, values[binding.parameter] ?? 0);
    if (binding.additive === false) {
      setWarpBindingProperty(warp, binding.property, sampled);
    } else {
      setWarpBindingProperty(warp, binding.property, getWarpBindingProperty(warp, binding.property) + sampled);
    }
  }

  for (const binding of deformer.multiBindings ?? []) {
    if (!isWarpBindingProperty(binding.property)) continue;
    const sampled = sampleMultiParameterBinding(binding, values);
    if (sampled === undefined) continue;
    if (binding.additive === false) {
      setWarpBindingProperty(warp, binding.property, sampled);
    } else {
      setWarpBindingProperty(warp, binding.property, getWarpBindingProperty(warp, binding.property) + sampled);
    }
  }

  for (const pin of warp.pins ?? []) {
    for (const binding of pin.bindings ?? []) {
      const sampled = sampleBinding(binding, values[binding.parameter] ?? 0);
      const current = binding.property === "offsetX" ? pin.offsetX : pin.offsetY;
      const value = binding.additive === false ? sampled : current + sampled;
      if (binding.property === "offsetX") {
        pin.offsetX = value;
      } else {
        pin.offsetY = value;
      }
    }
    for (const binding of pin.multiBindings ?? []) {
      const sampled = sampleMultiParameterBinding(binding, values);
      if (sampled === undefined) continue;
      const current = binding.property === "offsetX" ? pin.offsetX : pin.offsetY;
      const value = binding.additive === false ? sampled : current + sampled;
      if (binding.property === "offsetX") {
        pin.offsetX = value;
      } else {
        pin.offsetY = value;
      }
    }
  }

  return warp.enabled ? warp : undefined;
}

export function mergeResolvedWarpDeformers(
  parentWarp: ResolvedWarpDeformer | undefined,
  childWarp: ResolvedWarpDeformer | undefined
): ResolvedWarpDeformer | undefined {
  if (!parentWarp) {
    return childWarp ? cloneResolvedWarp(childWarp) : undefined;
  }
  if (!childWarp) {
    return cloneResolvedWarp(parentWarp);
  }

  const parent = cloneResolvedWarp(parentWarp);
  const child = cloneResolvedWarp(childWarp);
  const pins: RigWarpPin[] = [];
  const pinsById = new Map<string, RigWarpPin>();
  const addPin = (pin: RigWarpPin) => {
    const next = cloneWarpPin(pin);
    if (next.enabled === false) {
      next.offsetX = 0;
      next.offsetY = 0;
    }
    const scope = resolvedPinScopes.get(next);
    const key = scope ? `${scope}\u0000${next.id}` : next.id;
    const existing = pinsById.get(key);
    if (!existing) {
      pins.push(next);
      pinsById.set(key, next);
      return;
    }
    existing.enabled = existing.enabled !== false || next.enabled !== false;
    if (next.enabled !== false) {
      existing.offsetX += next.offsetX;
      existing.offsetY += next.offsetY;
    }
    existing.radius = Math.max(existing.radius, next.radius);
    existing.strength = Math.max(existing.strength, next.strength);
    existing.name = next.name || existing.name;
    existing.bindings = [...(existing.bindings ?? []), ...(next.bindings ?? [])];
  };

  for (const pin of parent.pins ?? []) {
    addPin(pin);
  }
  for (const pin of child.pins ?? []) {
    addPin(pin);
  }

  return {
    enabled: parent.enabled !== false || child.enabled !== false,
    pinBlendMode: child.pinBlendMode === "normalized" ? "normalized" : parent.pinBlendMode,
    bendX: parent.bendX + child.bendX,
    bendY: parent.bendY + child.bendY,
    taperX: parent.taperX + child.taperX,
    taperY: parent.taperY + child.taperY,
    grid: {
      columns: Math.max(parent.grid.columns, child.grid.columns),
      rows: Math.max(parent.grid.rows, child.grid.rows)
    },
    pins
  };
}

function cloneResolvedWarp(warp: ResolvedWarpDeformer): ResolvedWarpDeformer {
  return {
    enabled: warp.enabled,
    pinBlendMode: warp.pinBlendMode,
    bendX: warp.bendX,
    bendY: warp.bendY,
    taperX: warp.taperX,
    taperY: warp.taperY,
    grid: { ...warp.grid },
    pins: (warp.pins ?? []).map(cloneWarpPin)
  };
}

function cloneWarpPin(pin: RigWarpPin): RigWarpPin {
  const clone: RigWarpPin = {
    ...pin,
    bindings: (pin.bindings ?? []).map((binding) => ({
      ...binding,
      keys: binding.keys.map((key) => ({ ...key }))
    }))
  };
  const scope = resolvedPinScopes.get(pin);
  if (scope) {
    resolvedPinScopes.set(clone, scope);
  }
  return clone;

}
export function warpPoint(x: number, y: number, bounds: WarpBounds, warp: RigWarpDeformer): WarpPoint {
  if (!bounds.width || !bounds.height || !warp.enabled) {
    return { x, y };
  }

  const u = (x - bounds.left) / bounds.width;
  const v = (y - bounds.top) / bounds.height;
  const xNorm = u * 2 - 1;
  const yNorm = v * 2 - 1;
  const bendX = warp.bendX * (1 - yNorm * yNorm);
  const bendY = warp.bendY * (1 - xNorm * xNorm);
  const taperX = warp.taperX * xNorm * yNorm;
  const taperY = warp.taperY * yNorm * xNorm;
  let dx = bendX + taperX;
  let dy = bendY + taperY;

  if (warp.pinBlendMode === "normalized") {
    let total = 0;
    let pinX = 0;
    let pinY = 0;
    for (const pin of warp.pins ?? []) {
      if (pin.enabled === false || pin.strength <= 0) continue;
      const distance = Math.hypot(u - pin.u, v - pin.v) / Math.max(0.001, pin.radius);
      if (distance >= 1) continue;
      const influence = smoothstep01(1 - distance) * pin.strength;
      total += influence;
      pinX += pin.offsetX * influence;
      pinY += pin.offsetY * influence;
    }
    if (total > 0) {
      const baseWeight = Math.max(0, 1 - total);
      dx = (dx * baseWeight + pinX) / (baseWeight + total);
      dy = (dy * baseWeight + pinY) / (baseWeight + total);
    }
    return { x: x + dx, y: y + dy };
  }
  for (const pin of warp.pins ?? []) {
    if (pin.enabled === false || pin.strength <= 0) {
      continue;
    }
    const distance = Math.hypot(u - pin.u, v - pin.v) / Math.max(0.001, pin.radius);
    if (distance >= 1) {
      continue;
    }
    const influence = smoothstep01(1 - distance) * pin.strength;
    dx += (pin.offsetX - dx) * influence;
    dy += (pin.offsetY - dy) * influence;
  }

  return {
    x: x + dx,
    y: y + dy
  };
}

function hasWarpPinBindingEffect(pin: RigWarpPin): boolean {
  return (pin.bindings ?? []).some((binding) => binding.keys.some((key) => Math.abs(key.value) > 0.001));
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function smoothstep01(value: number): number {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
}


