import { resolvePhysicsFrame, type PhysicsValue } from "./evaluator.js";
import type { ParameterValues, PhysicsChain, RigDocument, TransformProperty } from "./types.js";

export interface PhysicsSettlingQaOptions {
  driveFrames?: number;
  settleFrames?: number;
  dt?: number;
  chainIds?: string[];
  /** When false (default), wind/gravity are removed after release so settling measures neutral damping, not continuous forcing. */
  releaseExternalForces?: boolean;
}

export interface PhysicsSettlingChainResult {
  chainId: string;
  driveFrames: number;
  settleFrames: number;
  peakMagnitude: number;
  magnitudeAtStop: number;
  magnitudeAtHalfSecond: number;
  magnitudeAtOneSecond: number;
  peakAfterQuarterSecond: number;
  residualRatioAfterQuarterSecond: number;
  reversalCount: number;
  finalMagnitude: number;
  settledFrame: number | null;
  finite: boolean;
  pass: boolean;
  issues: string[];
}

export interface PhysicsSettlingQaResult {
  pass: boolean;
  finite: boolean;
  dt: number;
  driveFrames: number;
  settleFrames: number;
  chains: PhysicsSettlingChainResult[];
  issues: string[];
}

/**
 * Drives each enabled chain to its source extrema, releases it to neutral, and
 * measures the fixed-dt tail response. This is deliberately numeric-only: it
 * provides the 0/0.5/1.0-second and settled samples needed before any image QA.
 */
export function runPhysicsSettlingQa(rig: RigDocument, options: PhysicsSettlingQaOptions = {}): PhysicsSettlingQaResult {
  const driveFrames = clampInteger(options.driveFrames ?? 60, 1, 600);
  const settleFrames = clampInteger(options.settleFrames ?? 240, 1, 1200);
  const dt = clampDt(options.dt ?? 1 / 60);
  const releaseExternalForces = options.releaseExternalForces === true;
  const selected = new Set(options.chainIds?.filter((id): id is string => typeof id === "string") ?? []);
  const chains = (rig.physics?.chains ?? []).filter((chain) => chain.enabled && (!selected.size || selected.has(chain.id)));
  const results = chains.map((chain) => measureChain(rig, chain, driveFrames, settleFrames, dt, releaseExternalForces));
  const issues = results.flatMap((result) => result.issues.map((issue) => `${result.chainId}: ${issue}`));
  return { pass: results.length > 0 && results.every((result) => result.pass), finite: results.every((result) => result.finite), dt, driveFrames, settleFrames, chains: results, issues };
}

function measureChain(rig: RigDocument, chain: PhysicsChain, driveFrames: number, settleFrames: number, dt: number, releaseExternalForces: boolean): PhysicsSettlingChainResult {
  const drivenRig = structuredClone(rig);
  drivenRig.physics = { enabled: true, chains: [structuredClone(chain)] };
  const releaseRig = structuredClone(rig);
  const releaseChain = releaseExternalForces ? structuredClone(chain) : { ...structuredClone(chain), wind: 0, gravity: 0 };
  releaseRig.physics = { enabled: true, chains: [releaseChain] };
  const driven = sourceDrivenValues(drivenRig, chain);
  const neutral = neutralValues(drivenRig);
  const state = new Map<string, PhysicsValue>();
  const totalFrames = driveFrames + settleFrames;
  const settleMagnitudes: number[] = [];
  const settleSignedValues: number[] = [];
  let peakMagnitude = 0;
  let magnitudeAtStop = 0;
  let magnitudeAtHalfSecond = 0;
  let magnitudeAtOneSecond = 0;
  let finite = true;
  for (let frame = 0; frame <= totalFrames; frame += 1) {
    const values = frame < driveFrames ? driven : neutral;
    const resolved = resolvePhysicsFrame(frame < driveFrames ? drivenRig : releaseRig, values, state, dt, frame * dt);
    const magnitude = physicsMagnitude(resolved);
    const signedValue = physicsSignedValue(resolved);
    if (!Number.isFinite(magnitude)) finite = false;
    peakMagnitude = Math.max(peakMagnitude, Math.abs(magnitude));
    if (frame === driveFrames) magnitudeAtStop = magnitude;
    if (frame === driveFrames + Math.round(0.5 / dt)) magnitudeAtHalfSecond = magnitude;
    if (frame === driveFrames + Math.round(1 / dt)) magnitudeAtOneSecond = magnitude;
    if (frame >= driveFrames) {
      settleMagnitudes.push(Math.abs(magnitude));
      settleSignedValues.push(signedValue);
    }
  }
  const finalMagnitude = settleMagnitudes[settleMagnitudes.length - 1] ?? 0;
  const tolerance = Math.max(0.0005, peakMagnitude * 0.03);
  const settledFrame = firstStableFrame(settleMagnitudes, tolerance, 8);
  const quarterSecondFrame = Math.min(settleMagnitudes.length - 1, Math.max(0, Math.round(0.25 / dt)));
  const oneAndHalfSecondFrame = Math.min(settleMagnitudes.length - 1, Math.max(quarterSecondFrame, Math.round(1.5 / dt)));
  const peakAfterQuarterSecond = Math.max(0, ...settleMagnitudes.slice(quarterSecondFrame, oneAndHalfSecondFrame + 1));
  const residualRatioAfterQuarterSecond = peakMagnitude > 0 ? peakAfterQuarterSecond / peakMagnitude : 0;
  const reversalCount = countReversals(settleSignedValues, tolerance);
  const issues: string[] = [];
  if (!finite) issues.push("non-finite output");
  if (peakMagnitude <= 0.0001) issues.push("chain produced no measurable response");
  if (settledFrame === null) issues.push(`did not settle within ${settleFrames} frames`);
  if (finalMagnitude > tolerance) issues.push(`final magnitude ${finalMagnitude.toFixed(5)} exceeds tolerance ${tolerance.toFixed(5)}`);
  return { chainId: chain.id, driveFrames, settleFrames, peakMagnitude, magnitudeAtStop, magnitudeAtHalfSecond, magnitudeAtOneSecond, peakAfterQuarterSecond, residualRatioAfterQuarterSecond, reversalCount, finalMagnitude, settledFrame, finite, pass: finite && peakMagnitude > 0.0001 && settledFrame !== null && finalMagnitude <= tolerance, issues };
}

function sourceDrivenValues(rig: RigDocument, chain: PhysicsChain): ParameterValues {
  const values = neutralValues(rig);
  for (const source of chain.sourceParameters ?? []) {
    const parameter = rig.parameters?.find((entry) => entry.id === source.parameter);
    values[source.parameter] = parameter?.max ?? 1;
  }
  return values;
}

function neutralValues(rig: RigDocument): ParameterValues {
  const values: ParameterValues = {};
  for (const parameter of rig.parameters ?? []) values[parameter.id] = parameter.default;
  return values;
}

function physicsMagnitude(frame: { partOffsets: Map<string, Partial<Record<TransformProperty, number>>>; deformerOffsets: Map<string, Partial<Record<TransformProperty, number>>>; parameterOffsets: ParameterValues }): number {
  let magnitude = 0;
  for (const offsets of [...frame.partOffsets.values(), ...frame.deformerOffsets.values()]) for (const value of Object.values(offsets)) if (typeof value === "number") magnitude += Math.abs(value);
  for (const value of Object.values(frame.parameterOffsets)) if (typeof value === "number") magnitude += Math.abs(value);
  return magnitude;
}

function physicsSignedValue(frame: { partOffsets: Map<string, Partial<Record<TransformProperty, number>>>; deformerOffsets: Map<string, Partial<Record<TransformProperty, number>>>; parameterOffsets: ParameterValues }): number {
  let value = 0;
  for (const offsets of [...frame.partOffsets.values(), ...frame.deformerOffsets.values()]) for (const offset of Object.values(offsets)) if (typeof offset === "number") value += offset;
  for (const offset of Object.values(frame.parameterOffsets)) if (typeof offset === "number") value += offset;
  return value;
}

function countReversals(values: number[], threshold: number): number {
  let previousSign = 0;
  let reversals = 0;
  for (const value of values) {
    if (!Number.isFinite(value) || Math.abs(value) <= threshold) continue;
    const sign = Math.sign(value);
    if (previousSign !== 0 && sign !== previousSign) reversals += 1;
    previousSign = sign;
  }
  return reversals;
}
function firstStableFrame(values: number[], tolerance: number, consecutive: number): number | null {
  for (let index = 0; index <= values.length - consecutive; index += 1) {
    if (values.slice(index, index + consecutive).every((value) => value <= tolerance)) return index;
  }
  return null;
}

function clampInteger(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, Math.round(Number.isFinite(value) ? value : min))); }
function clampDt(value: number): number { return Math.max(0.0001, Math.min(0.1, Number.isFinite(value) ? value : 1 / 60)); }
