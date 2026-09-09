import { resolveArtMesh } from "./artMesh.js";
import { identityMatrix, resolveRigFrame } from "./evaluator.js";
import { previewParameterValuesForRig } from "./parameters.js";
import type { ParameterValues, RigDocument } from "./types.js";

export interface MotionSweepRequest {
  parameters?: string[];
  samples?: number;
  maxDeltaSpikeRatio?: number;
  checkMonotonic?: boolean;
  monotonicParameters?: string[];
}

export interface MotionSweepParameterResult {
  parameter: string;
  min: number;
  max: number;
  sampleCount: number;
  responseSpan: number;
  maxFrameDelta: number;
  medianFrameDelta: number;
  spikeRatio: number;
  monotonicViolations: number;
  nonFinite: boolean;
  issues: string[];
  pass: boolean;
}

export interface MotionSweepAudit {
  enabled: true;
  pass: boolean;
  sampleCount: number;
  maxDeltaSpikeRatio: number;
  checkMonotonic: boolean;
  monotonicParameters: string[];
  parameters: MotionSweepParameterResult[];
  failed: MotionSweepParameterResult[];
}

const EPSILON = 1e-8;

export function auditMotionSweep(rig: RigDocument, request: MotionSweepRequest = {}): MotionSweepAudit {
  const sampleCount = clampInteger(request.samples ?? 25, 5, 121);
  const maxDeltaSpikeRatio = positive(request.maxDeltaSpikeRatio, 8);
  const checkMonotonic = request.checkMonotonic !== false;
  const monotonicParameters = new Set(request.monotonicParameters?.length ? request.monotonicParameters : ["ParamAngleX", "ParamAngleY", "ParamAngleZ", "ParamBodyAngleX", "ParamBodyAngleY", "ParamBodyAngleZ", "ParamEyeBallX", "ParamEyeBallY", "ParamEyeLOpen", "ParamEyeROpen", "ParamMouthOpen"]);
  const requested = request.parameters?.length ? new Set(request.parameters) : undefined;
  const parameters = rig.parameters.filter((parameter) => !requested || requested.has(parameter.id));
  const results = parameters.map((parameter) => auditParameter(rig, parameter.id, parameter.min, parameter.max, sampleCount, maxDeltaSpikeRatio, checkMonotonic && monotonicParameters.has(parameter.id)));
  const failed = results.filter((result) => !result.pass);
  return { enabled: true, pass: failed.length === 0, sampleCount, maxDeltaSpikeRatio, checkMonotonic, monotonicParameters: [...monotonicParameters], parameters: results, failed };
}

function auditParameter(rig: RigDocument, parameter: string, min: number, max: number, sampleCount: number, maxDeltaSpikeRatio: number, checkMonotonic: boolean): MotionSweepParameterResult {
  const vectors: number[][] = [];
  const baseValues = previewParameterValuesForRig(rig);
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const amount = sample / (sampleCount - 1);
    const values = { ...baseValues, [parameter]: min + (max - min) * amount };
    vectors.push(frameVector(rig, values));
  }
  const nonFinite = vectors.some((vector) => vector.some((value) => !Number.isFinite(value)));
  const deltas: number[] = [];
  for (let index = 1; index < vectors.length; index += 1) deltas.push(vectorDistance(vectors[index - 1], vectors[index]));
  const positiveDeltas = deltas.filter((value) => value > EPSILON && Number.isFinite(value));
  const maxFrameDelta = positiveDeltas.length ? Math.max(...positiveDeltas) : 0;
  const medianFrameDelta = median(deltas.filter((value) => Number.isFinite(value)));
  const spikeRatio = medianFrameDelta > EPSILON ? maxFrameDelta / medianFrameDelta : maxFrameDelta > EPSILON ? Number.POSITIVE_INFINITY : 1;
  const responseSpan = vectorDistance(vectors[0], vectors[vectors.length - 1]);
  const monotonicViolations = checkMonotonic && responseSpan > EPSILON ? countMonotonicViolations(vectors) : 0;
  const issues: string[] = [];
  if (nonFinite) issues.push("motion-non-finite");
  if (spikeRatio > maxDeltaSpikeRatio) issues.push("motion-delta-spike");
  if (monotonicViolations) issues.push("motion-non-monotonic");
  return { parameter, min, max, sampleCount, responseSpan, maxFrameDelta, medianFrameDelta, spikeRatio, monotonicViolations, nonFinite, issues, pass: issues.length === 0 };
}

function frameVector(rig: RigDocument, values: ParameterValues): number[] {
  const frame = resolveRigFrame(rig, values, identityMatrix(), { physics: false });
  const vector: number[] = [];
  for (const part of rig.parts) {
    const state = frame.parts.get(part.id);
    if (!state) continue;
    vector.push(state.matrix.a, state.matrix.b, state.matrix.c, state.matrix.d, state.matrix.e, state.matrix.f, state.pose.x, state.pose.y, state.pose.rotation, state.pose.scaleX, state.pose.scaleY, state.pose.opacity);
    const mesh = part.artMesh;
    if (!mesh?.enabled) continue;
    const asset = part.assetId ? rig.assets.find((entry) => entry.id === part.assetId) : undefined;
    const width = positive(asset?.width, Math.max(1, mesh.generator.alphaBounds.width));
    const height = positive(asset?.height, Math.max(1, mesh.generator.alphaBounds.height));
    const resolved = resolveArtMesh(part, width, height, values);
    for (const vertex of resolved?.vertices ?? []) vector.push(vertex.x, vertex.y);
  }
  return vector;
}

function countMonotonicViolations(vectors: number[][]): number {
  const first = vectors[0];
  const last = vectors[vectors.length - 1];
  const direction = last.map((value, index) => value - first[index]);
  const spanSquared = direction.reduce((sum, value) => sum + value * value, 0);
  if (spanSquared <= EPSILON) return 0;
  const tolerance = Math.max(1e-7, Math.sqrt(spanSquared) * 1e-5);
  let previous = -Infinity;
  let violations = 0;
  for (const vector of vectors) {
    const projection = vector.reduce((sum, value, index) => sum + (value - first[index]) * direction[index], 0) / spanSquared;
    if (projection < previous - tolerance) violations += 1;
    previous = projection;
  }
  return violations;
}

function vectorDistance(left: number[], right: number[]): number {
  const length = Math.max(left.length, right.length);
  let sum = 0;
  for (let index = 0; index < length; index += 1) {
    const delta = (right[index] ?? 0) - (left[index] ?? 0);
    sum += delta * delta;
  }
  return Math.sqrt(sum);
}
function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
function clampInteger(value: number, min: number, max: number) { const numeric = Number(value); return Number.isFinite(numeric) ? Math.max(min, Math.min(max, Math.round(numeric))) : min; }
function positive(value: unknown, fallback: number) { const numeric = Number(value); return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback; }
