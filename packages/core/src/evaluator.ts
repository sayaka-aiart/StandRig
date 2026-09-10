import { applyTransformShapes, resolveSharedShape } from './extendedBlendShape.js';
import { sampleBinding } from "./bindings.js";
import { sampleMultiParameterBinding } from "./multiBindings.js";
import { deformerForPart } from "./deformers.js";
import { defaultParameterValues } from "./parameters.js";
import { isTransformBindingProperty, mergeResolvedWarpDeformers, resolveDeformerWarp, type ResolvedWarpDeformer } from "./warp.js";
import type { ParameterValues, PhysicsChain, RigDeformer, RigDocument, RigPart, Transform2D, TransformProperty } from "./types.js";
import type { RigSharedWarpField } from "./types.js";

export interface Matrix2D {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export interface PhysicsValue {
  value: number;
  velocity: number;
  target?: number;
}

export interface EvaluatedPartState {
  parameterValues?: ParameterValues;
  matrix: Matrix2D;
  parentMatrix: Matrix2D;
  opacity: number;
  visible: boolean;
  pose: Transform2D;
  warp?: ResolvedWarpDeformer;
  sharedWarps?: RigSharedWarpField[];

}
export interface EvaluatedDeformerState {
  matrix: Matrix2D;
  opacity: number;
  visible: boolean;
  pose: Transform2D;
  warp?: ResolvedWarpDeformer;
  sharedWarps?: RigSharedWarpField[];

}
export interface RigEvaluationOptions {
  physicsOffsets?: Map<string, Partial<Record<TransformProperty, number>>>;
  physicsDeformerOffsets?: Map<string, Partial<Record<TransformProperty, number>>>;
}

export interface RigFrameOptions {
  /** Disable physics while keeping the same transform/deformer evaluation path. */
  physics?: boolean;
  /** Reuse a state map for live temporal physics in Preview/OBS. */
  physicsState?: Map<string, PhysicsValue>;
  /** Deterministic or live evaluation time in seconds. */
  physicsTime?: number;
  /** Number of deterministic warm-up steps when no live state is supplied. */
  physicsSteps?: number;
  /** Live physics timestep. Deterministic callers may override this too. */
  physicsDt?: number;
}

export interface RigEvaluationFrame {
  values: ParameterValues;
  parts: Map<string, EvaluatedPartState>;
  physics: ResolvedPhysicsFrame;
  /** Neutral-relative deformer matrices consumed by the shared ArtMesh skinning path. */
  skinningTransforms: Map<string, Matrix2D>;
}

const MIN_SCALE = 0.001;

/**
 * Resolve one complete model frame for every renderer.
 *
 * Preview/OBS pass a live `physicsState`, while server screenshots omit it and
 * use deterministic warm-up steps. Both paths still share the same effective
 * parameter and part/deformer evaluation afterwards.
 */
export function resolveRigFrame(
  rig: RigDocument,
  values: ParameterValues,
  baseMatrix: Matrix2D,
  options: RigFrameOptions = {}
): RigEvaluationFrame {
  const physicsEnabled = options.physics !== false;
  const physics = physicsEnabled
    ? options.physicsState
      ? resolvePhysicsFrame(
        rig,
        values,
        options.physicsState,
        clampPhysicsDt(options.physicsDt),
        finiteOr(options.physicsTime, 0)
      )
      : resolveDeterministicPhysicsFrame(
        rig,
        values,
        finiteOr(options.physicsTime, 0),
        options.physicsSteps ?? 18,
        clampPhysicsDt(options.physicsDt)
      )
    : emptyPhysicsFrame();
  const effectiveValues = applyPhysicsParameterOffsets(values, physics.parameterOffsets);
  const deformerStates = evaluateDeformers(rig.deformers ?? [], effectiveValues, physics.deformerOffsets);
  const neutralDeformerStates = evaluateDeformers(rig.deformers ?? [], defaultParameterValues(rig));
  return {
    values: effectiveValues,
    physics,
    skinningTransforms: resolveDeformerSkinningTransforms(deformerStates, neutralDeformerStates),
    parts: evaluateRigParts(rig, effectiveValues, baseMatrix, {
      physicsOffsets: physics.partOffsets,
      physicsDeformerOffsets: physics.deformerOffsets
    })
  };
}

/**
 * Build neutral-relative transforms for ArtMesh skinning. Keeping this pure and
 * independent of any renderer makes Canvas/server/WebGL consume the same
 * vertex deformation result. The neutral-relative matrix is identity at the
 * default pose, so rigs without a skinning profile are unaffected.
 */
export function resolveDeformerSkinningTransforms(
  current: ReadonlyMap<string, EvaluatedDeformerState>,
  neutral: ReadonlyMap<string, EvaluatedDeformerState>
): Map<string, Matrix2D> {
  const transforms = new Map<string, Matrix2D>();
  const ids = new Set([...current.keys(), ...neutral.keys()]);
  for (const id of ids) {
    const currentState = current.get(id);
    const neutralState = neutral.get(id);
    if (!currentState || !neutralState) continue;
    transforms.set(id, multiplyMatrices(currentState.matrix, invertMatrix(neutralState.matrix)));
  }
  return transforms;
}

function emptyPhysicsFrame(): ResolvedPhysicsFrame {
  return { partOffsets: new Map(), deformerOffsets: new Map(), parameterOffsets: {} };
}

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clampPhysicsDt(value: number | undefined): number {
  return Math.min(0.1, Math.max(0.0001, finiteOr(value, 1 / 60)));
}

export function evaluateRigParts(
  rig: RigDocument,
  values: ParameterValues,
  baseMatrix: Matrix2D,
  options: RigEvaluationOptions = {}
): Map<string, EvaluatedPartState> {
  const byId = new Map(rig.parts.map((part) => [part.id, part]));
  const deformers = rig.deformers ?? [];
  const deformerStates = evaluateDeformers(deformers, values, options.physicsDeformerOffsets);
  const computed = new Map<string, EvaluatedPartState>();
  const visiting = new Set<string>();

  const computePart = (part: RigPart): EvaluatedPartState => {
    const existing = computed.get(part.id);
    if (existing) {
      return existing;
    }
    if (visiting.has(part.id)) {
      const fallback = {
        matrix: baseMatrix,
        parentMatrix: baseMatrix,
        opacity: 1,
        visible: part.visible,
        pose: zeroPose(),
        warp: undefined
      };
      computed.set(part.id, fallback);
      return fallback;
    }

    visiting.add(part.id);
    const parent = part.parentId ? byId.get(part.parentId) : undefined;
    const parentComputed = parent
      ? computePart(parent)
      : { matrix: baseMatrix, parentMatrix: baseMatrix, opacity: 1, visible: true, pose: zeroPose(), warp: undefined };
    const deformer = deformerForPart(part, deformers);
    const deformerComputed = deformer ? deformerStates.get(deformer.id) : undefined;
    const pose = resolvePartPose(part, values, options.physicsOffsets?.get(part.id));
    const localMatrix = multiplyMatrices(
      multiplyMatrices(translateMatrix(pose.x, pose.y), rotateMatrix(pose.rotation)),
      scaleMatrix(safeScale(pose.scaleX), safeScale(pose.scaleY))
    );
    const parentMatrix = deformerComputed ? multiplyMatrices(parentComputed.matrix, deformerComputed.matrix) : parentComputed.matrix;
    const activeWarp = mergeResolvedWarpDeformers(parentComputed.warp, deformerComputed?.warp);

    const result: EvaluatedPartState = {
      parameterValues: values,
      matrix: multiplyMatrices(parentMatrix, localMatrix),
      parentMatrix,
      opacity: parentComputed.opacity * (deformerComputed?.opacity ?? 1) * pose.opacity,
      visible: parentComputed.visible && (deformerComputed?.visible ?? true) && part.visible,
      pose,
      warp: activeWarp,
      sharedWarps: mergeSharedWarpFields(parentComputed.sharedWarps, deformerComputed?.sharedWarps)
    };
    computed.set(part.id, result);
    visiting.delete(part.id);
    return result;
  };

  for (const part of rig.parts) {
    computePart(part);
  }

  return computed;
}

export function evaluateDeformers(
  deformers: RigDeformer[],
  values: ParameterValues,
  physicsOffsets: Map<string, Partial<Record<TransformProperty, number>>> | undefined = undefined
): Map<string, EvaluatedDeformerState> {
  const byId = new Map(deformers.map((deformer) => [deformer.id, deformer]));
  const computed = new Map<string, EvaluatedDeformerState>();
  const visiting = new Set<string>();

  const computeDeformer = (deformer: RigDeformer): EvaluatedDeformerState => {
    const existing = computed.get(deformer.id);
    if (existing) {
      return existing;
    }
    if (visiting.has(deformer.id)) {
      const fallback = { matrix: identityMatrix(), opacity: 1, visible: deformer.visible, pose: zeroPose(), warp: undefined };
      computed.set(deformer.id, fallback);
      return fallback;
    }

    visiting.add(deformer.id);
    const parent = deformer.parentId ? byId.get(deformer.parentId) : undefined;
    const parentComputed = parent ? computeDeformer(parent) : { matrix: identityMatrix(), opacity: 1, visible: true, pose: zeroPose(), warp: undefined };
    const pose = resolveDeformerPose(deformer, values, physicsOffsets?.get(deformer.id));
    const ownWarp = resolveDeformerWarp(deformer, values, sampleBinding);
    const result: EvaluatedDeformerState = {
      matrix: multiplyMatrices(parentComputed.matrix, deformerMatrix(deformer, pose)),
      opacity: parentComputed.opacity * pose.opacity,
      visible: parentComputed.visible && deformer.visible,
      pose,
      warp: mergeResolvedWarpDeformers(parentComputed.warp, ownWarp),
      sharedWarps: mergeSharedWarpFields(parentComputed.sharedWarps, deformer.sharedWarp ? [resolveSharedShape(deformer.sharedWarp, deformer.blendShapes, values)!] : undefined)
    };
    computed.set(deformer.id, result);
    visiting.delete(deformer.id);
    return result;
  };

  for (const deformer of deformers) {
    computeDeformer(deformer);
  }

  return computed;
}
function mergeSharedWarpFields(parent: RigSharedWarpField[] | undefined, own: RigSharedWarpField[] | undefined): RigSharedWarpField[] | undefined {
  const fields = [...(parent ?? []), ...(own ?? [])].filter((field) => field.enabled);
  return fields.length ? fields : undefined;
}


export function resolvePartPose(
  part: RigPart,
  values: ParameterValues,
  physicsOffset: Partial<Record<TransformProperty, number>> | undefined
): Transform2D {
  const pose: Transform2D = { ...part.transform };

  for (const binding of part.bindings ?? []) {
    if (!isTransformBindingProperty(binding.property)) {
      continue;
    }
    const sampled = sampleBinding(binding, values[binding.parameter] ?? 0);
    applyTransformBindingSample(pose, binding.property, sampled, binding.additive, binding.composition);
  }
  for (const binding of part.multiBindings ?? []) {
    if (!isTransformBindingProperty(binding.property)) continue;
    const sampled = sampleMultiParameterBinding(binding, values);
    if (sampled === undefined) continue;
    applyTransformBindingSample(pose, binding.property, sampled, binding.additive, binding.composition);
  }

  applyTransformShapes(pose, part.blendShapes, values);
  if (physicsOffset) {
    for (const [property, value] of Object.entries(physicsOffset) as Array<[TransformProperty, number]>) {
      pose[property] += value;
    }
  }

  pose.opacity = Math.min(1, Math.max(0, pose.opacity));
  return pose;
}

export function resolveDeformerPose(
  deformer: RigDeformer,
  values: ParameterValues,
  physicsOffset: Partial<Record<TransformProperty, number>> | undefined = undefined
): Transform2D {
  const pose: Transform2D = { ...deformer.transform };

  for (const binding of deformer.bindings ?? []) {
    if (!isTransformBindingProperty(binding.property)) {
      continue;
    }
    const sampled = sampleBinding(binding, values[binding.parameter] ?? 0);
    applyTransformBindingSample(pose, binding.property, sampled, binding.additive, binding.composition);
  }
  for (const binding of deformer.multiBindings ?? []) {
    if (!isTransformBindingProperty(binding.property)) continue;
    const sampled = sampleMultiParameterBinding(binding, values);
    if (sampled === undefined) continue;
    applyTransformBindingSample(pose, binding.property, sampled, binding.additive, binding.composition);
  }

  applyTransformShapes(pose, deformer.blendShapes, values);
  if (physicsOffset) {
    for (const [property, value] of Object.entries(physicsOffset) as Array<[TransformProperty, number]>) {
      pose[property] += value;
    }
  }

  pose.opacity = Math.min(1, Math.max(0, pose.opacity));
  return pose;
}

function applyTransformBindingSample(
  pose: Transform2D,
  property: TransformProperty,
  sampled: number,
  additive: boolean | undefined,
  composition: "legacy-additive" | "multiply" | undefined
) {
  if (composition === "multiply" && (property === "scaleX" || property === "scaleY" || property === "opacity")) {
    pose[property] *= sampled;
  } else if (additive === false) {
    pose[property] = sampled;
  } else {
    pose[property] += sampled;
  }
}
export interface ResolvedPhysicsFrame {
  partOffsets: Map<string, Partial<Record<TransformProperty, number>>>;
  deformerOffsets: Map<string, Partial<Record<TransformProperty, number>>>;
  parameterOffsets: ParameterValues;
}

export function applyPhysicsParameterOffsets(values: ParameterValues, offsets: ParameterValues): ParameterValues {
  const resolved = { ...values };
  for (const [parameter, offset] of Object.entries(offsets)) {
    resolved[parameter] = (resolved[parameter] ?? 0) + offset;
  }
  return resolved;
}

export function resolvePhysicsFrame(
  rig: RigDocument,
  values: ParameterValues,
  state: Map<string, PhysicsValue>,
  dt: number,
  timeSeconds: number
): ResolvedPhysicsFrame {
  const partOffsets = new Map<string, Partial<Record<TransformProperty, number>>>();
  const deformerOffsets = new Map<string, Partial<Record<TransformProperty, number>>>();
  const parameterOffsets: ParameterValues = {};
  if (!rig.physics?.enabled) return { partOffsets, deformerOffsets, parameterOffsets };

  const safeDt = Math.min(0.1, Math.max(0.0001, dt));
  for (const chain of rig.physics.chains ?? []) {
    if (!chain.enabled) continue;
    const input = chain.sourceParameters.reduce((total, source) => total + (values[source.parameter] ?? 0) * source.scale, 0);
    const wind = chain.wind ? Math.sin(timeSeconds * 1.8) * chain.wind : 0;
    const target = input + chain.gravity + wind;

    if (chain.parameterOutput) {
      const output = chain.parameterOutput;
      const key = `${chain.id}:parameter:${output.parameter}`;
      const physicsValue = resolveChainPhysicsValue(state, key, target, chain, safeDt);
      let value = physicsValue * output.scale;
      if (Number.isFinite(output.min)) value = Math.max(output.min!, value);
      if (Number.isFinite(output.max)) value = Math.min(output.max!, value);
      parameterOffsets[output.parameter] = (parameterOffsets[output.parameter] ?? 0) + value;
      continue;
    }

    for (const deformerId of chain.targetDeformerIds ?? []) {
      const key = `${chain.id}:deformer:${deformerId}`;
      const physicsValue = resolveChainPhysicsValue(state, key, target, chain, safeDt);
      const deformerOffset = deformerOffsets.get(deformerId) ?? {};
      deformerOffset[chain.output.property] = (deformerOffset[chain.output.property] ?? 0) + physicsValue * chain.output.scale;
      deformerOffsets.set(deformerId, deformerOffset);
    }
    for (const partId of chain.targetPartIds ?? []) {
      const key = `${chain.id}:${partId}`;
      const physicsValue = resolveChainPhysicsValue(state, key, target, chain, safeDt);
      const partOffset = partOffsets.get(partId) ?? {};
      partOffset[chain.output.property] = (partOffset[chain.output.property] ?? 0) + physicsValue * chain.output.scale;
      partOffsets.set(partId, partOffset);
    }
  }
  return { partOffsets, deformerOffsets, parameterOffsets };
}

function resolveChainPhysicsValue(
  state: Map<string, PhysicsValue>,
  baseKey: string,
  target: number,
  chain: PhysicsChain,
  dt: number
): number {
  const segments = chain.segments?.filter((segment) => segment && segment.id);
  if (!segments?.length) {
    const physics = advancePhysicsValue(state.get(baseKey), target, chain, dt);
    state.set(baseKey, physics);
    return physics.value;
  }

  const substeps = Math.max(1, Math.min(12, Math.ceil(dt / (1 / 120))));
  const subDt = dt / substeps;
  let finalValue = 0;
  for (let step = 0; step < substeps; step += 1) {
    let driver = target;
    for (const segment of segments.slice(0, 8)) {
      const key = `${baseKey}:segment:${segment.id}`;
      const current = state.get(key) ?? { value: 0, velocity: 0, target: 0 };
      const delay = clampFinite(segment.delay, 0, 2, 0.08);
      const alpha = delay <= 0 ? 1 : 1 - Math.exp(-subDt / delay);
      current.target = (current.target ?? driver) + (driver - (current.target ?? driver)) * alpha;
      const stageChain = {
        ...chain,
        mass: chain.mass * clampFinite(segment.length, 0.05, 8, 1),
        damping: chain.damping * clampFinite(segment.damping, 0, 8, 1)
      };
      const physics = advancePhysicsValue(current, current.target, stageChain, subDt);
      state.set(key, physics);
      driver = physics.value;
      finalValue = physics.value;
    }
  }
  return finalValue;
}

function clampFinite(value: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}
function advancePhysicsValue(current: PhysicsValue | undefined, target: number, chain: PhysicsChain, dt: number): PhysicsValue {
  const physics = current ?? { value: 0, velocity: 0 };
  const mass = Math.max(0.001, chain.mass);
  const acceleration = ((target - physics.value) * chain.stiffness - physics.velocity * chain.damping) / mass;
  physics.velocity += acceleration * dt;
  physics.value += physics.velocity * dt;
  return physics;
}

export function resolvePhysicsOffsets(
  rig: RigDocument,
  values: ParameterValues,
  state: Map<string, PhysicsValue>,
  dt: number,
  timeSeconds: number
): Map<string, Partial<Record<TransformProperty, number>>> {
  return resolvePhysicsFrame(rig, values, state, dt, timeSeconds).partOffsets;
}

export function resolveDeterministicPhysicsFrame(
  rig: RigDocument,
  values: ParameterValues,
  timeSeconds: number,
  steps = 18,
  dt = 1 / 60
): ResolvedPhysicsFrame {
  const state = new Map<string, PhysicsValue>();
  let frame: ResolvedPhysicsFrame = { partOffsets: new Map(), deformerOffsets: new Map(), parameterOffsets: {} };
  const safeSteps = Math.max(0, Math.min(240, Math.round(steps)));
  for (let index = 0; index < safeSteps; index += 1) {
    frame = resolvePhysicsFrame(rig, values, state, dt, timeSeconds + index * dt);
  }
  return frame;
}

export function resolveDeterministicPhysicsOffsets(
  rig: RigDocument,
  values: ParameterValues,
  timeSeconds: number,
  steps = 18,
  dt = 1 / 60
): Map<string, Partial<Record<TransformProperty, number>>> {
  return resolveDeterministicPhysicsFrame(rig, values, timeSeconds, steps, dt).partOffsets;
}
export function identityMatrix(): Matrix2D {
  return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
}

export function translateMatrix(x: number, y: number): Matrix2D {
  return { a: 1, b: 0, c: 0, d: 1, e: x, f: y };
}

export function rotateMatrix(degrees: number): Matrix2D {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
}

export function scaleMatrix(x: number, y: number): Matrix2D {
  return { a: x, b: 0, c: 0, d: y, e: 0, f: 0 };
}

export function multiplyMatrices(left: Matrix2D, right: Matrix2D): Matrix2D {
  return {
    a: left.a * right.a + left.c * right.b,
    b: left.b * right.a + left.d * right.b,
    c: left.a * right.c + left.c * right.d,
    d: left.b * right.c + left.d * right.d,
    e: left.a * right.e + left.c * right.f + left.e,
    f: left.b * right.e + left.d * right.f + left.f
  };
}

export function invertMatrix(matrix: Matrix2D): Matrix2D {
  const determinant = matrix.a * matrix.d - matrix.b * matrix.c || 1;
  return {
    a: matrix.d / determinant,
    b: -matrix.b / determinant,
    c: -matrix.c / determinant,
    d: matrix.a / determinant,
    e: (matrix.c * matrix.f - matrix.d * matrix.e) / determinant,
    f: (matrix.b * matrix.e - matrix.a * matrix.f) / determinant
  };
}

export function transformMatrixPoint(matrix: Matrix2D, x: number, y: number): { x: number; y: number } {
  return {
    x: matrix.a * x + matrix.c * y + matrix.e,
    y: matrix.b * x + matrix.d * y + matrix.f
  };
}

export function safeScale(value: number): number {
  if (Math.abs(value) >= MIN_SCALE) return value;
  return value < 0 ? -MIN_SCALE : MIN_SCALE;
}
function zeroPose(): Transform2D {
  return { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, pivotX: 0.5, pivotY: 0.5, opacity: 1 };
}

function deformerMatrix(deformer: RigDeformer, pose: Transform2D): Matrix2D {
  return multiplyMatrices(
    multiplyMatrices(
      multiplyMatrices(translateMatrix(deformer.origin.x, deformer.origin.y), multiplyMatrices(translateMatrix(pose.x, pose.y), rotateMatrix(pose.rotation))),
      scaleMatrix(safeScale(pose.scaleX), safeScale(pose.scaleY))
    ),
    translateMatrix(-deformer.origin.x, -deformer.origin.y)
  );
}

