import { invertMatrix, transformMatrixPoint, type EvaluatedPartState } from "./evaluator.js";
import { readRigGlue } from "./glue.js";
import { hasWarpEffect, type ResolvedWarpDeformer } from "./warp.js";
import type { RigDocument, RigGlue, RigPart, RigWarpPin } from "./types.js";

export interface GlueWarpPartSize {
  width: number;
  height: number;
}

export function resolveGlueWarpForPart(
  rig: RigDocument,
  part: RigPart,
  state: EvaluatedPartState,
  size: GlueWarpPartSize,
  computed: Map<string, EvaluatedPartState>,
  sizeForPart: (part: RigPart) => GlueWarpPartSize | undefined
): ResolvedWarpDeformer | undefined {
  const gluePins = gluePinsForPart(rig, part, state, size, computed, sizeForPart);
  if (!gluePins.length) {
    return state.warp;
  }

  const warp = state.warp ? cloneWarp(state.warp) : emptyGlueWarp();
  warp.enabled = true;
  warp.grid = {
    columns: Math.max(warp.grid.columns, 5),
    rows: Math.max(warp.grid.rows, 5)
  };
  warp.pins = [...(warp.pins ?? []), ...gluePins];
  return warp;
}

function gluePinsForPart(
  rig: RigDocument,
  part: RigPart,
  state: EvaluatedPartState,
  size: GlueWarpPartSize,
  computed: Map<string, EvaluatedPartState>,
  sizeForPart: (part: RigPart) => GlueWarpPartSize | undefined
): RigWarpPin[] {
  const activeGlues = readRigGlue(rig)
    .filter((glue) => glue.enabled && glue.status === "active" && glue.mode === "soft-seam")
    .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
  const pins: RigWarpPin[] = [];
  for (const glue of activeGlues) {
    const currentSide = glue.partAId === part.id ? "A" : glue.partBId === part.id ? "B" : "";
    if (!currentSide) {
      continue;
    }
    const otherPartId = currentSide === "A" ? glue.partBId : glue.partAId;
    const otherPart = rig.parts.find((entry) => entry.id === otherPartId);
    const otherState = otherPart ? computed.get(otherPart.id) : undefined;
    const otherSize = otherPart ? sizeForPart(otherPart) : undefined;
    if (!otherPart || !otherState || !otherSize || !otherState.visible || otherState.opacity <= 0) {
      continue;
    }

    if (glue.seamPoints?.length) {
      glue.seamPoints.forEach((point, index) => {
        const pointWeight = currentSide === "A" ? point.weightA ?? glue.weightA : point.weightB ?? glue.weightB;
        const pin = gluePinForSeamPoint(glue.id, index, currentSide, point, pointWeight, glue.strength, state, size, otherState, otherSize);
        if (pin) {
          pins.push(pin);
        }
      });
    } else {
      const pin = gluePinForPair(
        glue.id,
        currentSide === "A" ? glue.weightA : glue.weightB,
        glue.strength,
        state,
        size,
        otherState,
        otherSize
      );
      if (pin) {
        pins.push(pin);
      }
    }
  }
  return pins.slice(0, 24);
}

function gluePinForSeamPoint(
  glueId: string,
  index: number,
  currentSide: "A" | "B",
  point: NonNullable<RigGlue["seamPoints"]>[number],
  weight: number,
  glueStrength: number,
  state: EvaluatedPartState,
  size: GlueWarpPartSize,
  otherState: EvaluatedPartState,
  otherSize: GlueWarpPartSize
): RigWarpPin | undefined {
  const currentUv = currentSide === "A" ? point.a : point.b;
  const otherUv = currentSide === "A" ? point.b : point.a;
  const left = -state.pose.pivotX * size.width;
  const top = -state.pose.pivotY * size.height;
  const otherLeft = -otherState.pose.pivotX * otherSize.width;
  const otherTop = -otherState.pose.pivotY * otherSize.height;
  const anchor = {
    x: left + clamp01(currentUv.u) * size.width,
    y: top + clamp01(currentUv.v) * size.height
  };
  const otherAnchorWorld = transformMatrixPoint(
    otherState.matrix,
    otherLeft + clamp01(otherUv.u) * otherSize.width,
    otherTop + clamp01(otherUv.v) * otherSize.height
  );
  const otherAnchorLocal = transformMatrixPoint(invertMatrix(state.matrix), otherAnchorWorld.x, otherAnchorWorld.y);
  const vector = { x: otherAnchorLocal.x - anchor.x, y: otherAnchorLocal.y - anchor.y };
  const length = Math.hypot(vector.x, vector.y);
  if (length < 0.001) {
    return undefined;
  }

  const direction = { x: vector.x / length, y: vector.y / length };
  const clampedWeight = clamp01(weight);
  const clampedStrength = clamp01(point.strength ?? glueStrength);
  const maxOffset = clamp(Math.min(size.width, size.height) * 0.06, 2, 28);
  const magnitude = Math.min(length * 0.24, maxOffset) * clampedStrength * (0.35 + clampedWeight * 0.65);
  if (magnitude < 0.05) {
    return undefined;
  }

  return {
    id: `glue-${glueId}-${index}`,
    name: `Glue ${glueId} ${index + 1}`,
    enabled: true,
    u: clamp01(currentUv.u),
    v: clamp01(currentUv.v),
    offsetX: direction.x * magnitude,
    offsetY: direction.y * magnitude,
    radius: clamp(point.radius ?? (0.16 + clampedStrength * 0.34), 0.08, 0.7),
    strength: clamp(0.14 + clampedStrength * (0.42 + clampedWeight * 0.28), 0.14, 0.72),
    bindings: []
  };
}
function gluePinForPair(
  glueId: string,
  weight: number,
  strength: number,
  state: EvaluatedPartState,
  size: GlueWarpPartSize,
  otherState: EvaluatedPartState,
  otherSize: GlueWarpPartSize
): RigWarpPin | undefined {
  const left = -state.pose.pivotX * size.width;
  const top = -state.pose.pivotY * size.height;
  const center = { x: left + size.width * 0.5, y: top + size.height * 0.5 };
  const otherCenterWorld = partCenterWorld(otherState, otherSize);
  const inverse = invertMatrix(state.matrix);
  const otherCenterLocal = transformMatrixPoint(inverse, otherCenterWorld.x, otherCenterWorld.y);
  const vector = { x: otherCenterLocal.x - center.x, y: otherCenterLocal.y - center.y };
  const length = Math.hypot(vector.x, vector.y);
  if (length < 0.001) {
    return undefined;
  }

  const direction = { x: vector.x / length, y: vector.y / length };
  const edgeDistance = rayToRectEdgeDistance(direction, size.width, size.height);
  const anchor = {
    x: center.x + direction.x * edgeDistance,
    y: center.y + direction.y * edgeDistance
  };
  const u = clamp01((anchor.x - left) / size.width);
  const v = clamp01((anchor.y - top) / size.height);
  const clampedWeight = clamp01(weight);
  const clampedStrength = clamp01(strength);
  const maxOffset = clamp(Math.min(size.width, size.height) * 0.045, 2, 24);
  const magnitude = maxOffset * clampedStrength * (0.35 + clampedWeight * 0.65);
  if (magnitude < 0.05) {
    return undefined;
  }

  return {
    id: `glue-${glueId}`,
    name: `Glue ${glueId}`,
    enabled: true,
    u,
    v,
    offsetX: direction.x * magnitude,
    offsetY: direction.y * magnitude,
    radius: clamp(0.18 + clampedStrength * 0.34, 0.18, 0.52),
    strength: clamp(0.16 + clampedStrength * (0.34 + clampedWeight * 0.32), 0.16, 0.66),
    bindings: []
  };
}

function partCenterWorld(state: EvaluatedPartState, size: GlueWarpPartSize): { x: number; y: number } {
  const localX = -state.pose.pivotX * size.width + size.width * 0.5;
  const localY = -state.pose.pivotY * size.height + size.height * 0.5;
  return transformMatrixPoint(state.matrix, localX, localY);
}

function rayToRectEdgeDistance(direction: { x: number; y: number }, width: number, height: number): number {
  const halfWidth = Math.max(0.001, width * 0.5);
  const halfHeight = Math.max(0.001, height * 0.5);
  const tx = Math.abs(direction.x) > 0.001 ? halfWidth / Math.abs(direction.x) : Number.POSITIVE_INFINITY;
  const ty = Math.abs(direction.y) > 0.001 ? halfHeight / Math.abs(direction.y) : Number.POSITIVE_INFINITY;
  return Math.min(tx, ty);
}

function emptyGlueWarp(): ResolvedWarpDeformer {
  return {
    enabled: true,
    bendX: 0,
    bendY: 0,
    taperX: 0,
    taperY: 0,
    grid: { columns: 5, rows: 5 },
    pins: []
  };
}

function cloneWarp(warp: ResolvedWarpDeformer): ResolvedWarpDeformer {
  return {
    enabled: warp.enabled || hasWarpEffect(warp),
    bendX: warp.bendX,
    bendY: warp.bendY,
    taperX: warp.taperX,
    taperY: warp.taperY,
    grid: { ...warp.grid },
    pins: (warp.pins ?? []).map((pin) => ({
      ...pin,
      bindings: (pin.bindings ?? []).map((binding) => ({
        ...binding,
        keys: binding.keys.map((key) => ({ ...key }))
      }))
    }))
  };
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}
