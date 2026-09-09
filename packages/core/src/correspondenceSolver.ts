import { auditRigArtMeshDistortion } from "./artMeshDistortion.js";
import { defaultParameterValues, parameterDefinitionsForRig } from "./parameters.js";
import { evaluateRigParts, identityMatrix, invertMatrix, transformMatrixPoint } from "./evaluator.js";
import { fitHeadProxy, headProxyPoseCandidates, type HeadProxy, type HeadProxyLandmarkId, type HeadProxyPoseCandidate } from "./headProxy.js";
import type { ModelingOperation } from "./modelingOps.js";
import type { ParameterValues, RigArtMeshVertexOffset, RigDocument, RigPartRole } from "./types.js";

export type CorrespondenceLandmarks = Partial<Record<HeadProxyLandmarkId, { x: number; y: number; weight?: number }>>;

export interface CorrespondenceSolveRequest {
  values?: ParameterValues;
  landmarks: CorrespondenceLandmarks;
  regularization?: number;
  maxResidual?: number;
  maxOffset?: number;
  partIds?: string[];
  roles?: RigPartRole[];
  includeOffsets?: boolean;
}

export interface CorrespondenceSolution {
  values: ParameterValues;
  candidateValues: ParameterValues;
  matched: HeadProxyLandmarkId[];
  missing: HeadProxyLandmarkId[];
  translation: { x: number; y: number };
  scale: { x: number; y: number };
  residualRms: number;
  maxResidual: number;
  regularization: number;
  pass: boolean;
  diagnostics: Array<{ landmark: HeadProxyLandmarkId; target: { x: number; y: number }; predicted: { x: number; y: number }; corrected: { x: number; y: number }; error: number }>;
}

export interface CorrespondenceOperationSummary {
  operation: ModelingOperation;
  partId: string;
  offsetCount: number;
  lockedExcluded: number;
  maxOffset: number;
  meanOffset: number;
}

export interface CorrespondenceOperationReport {
  operations: ModelingOperation[];
  summaries: CorrespondenceOperationSummary[];
  selectedPartIds: string[];
  maxOffset: number;
  finite: boolean;
  distortionPass: boolean;
  distortion: ReturnType<typeof auditRigArtMeshDistortion> | undefined;
  issues: string[];
}

export function solveCorrespondence(proxy: HeadProxy, request: CorrespondenceSolveRequest): CorrespondenceSolution {
  const values = { ...request.values };
  const candidate = nearestPoseCandidate(proxy, values);
  const centerY = proxy.bounds.top + proxy.bounds.height * 0.5;
  const points = (Object.entries(request.landmarks) as Array<[HeadProxyLandmarkId, { x: number; y: number; weight?: number } | undefined]>)
    .filter((entry): entry is [HeadProxyLandmarkId, { x: number; y: number; weight?: number }] => { const target = entry[1]; return target !== undefined && Number.isFinite(target.x) && Number.isFinite(target.y) && proxy.landmarks[entry[0]] !== undefined; })
    .map(([landmark, target]) => {
      const base = proxy.landmarks[landmark]!;
      const predicted = candidatePoint(proxy, candidate, landmark);
      return { landmark, target, predicted, relX: base.x - proxy.axisX, relY: base.y - centerY, weight: Math.max(0.05, Number.isFinite(target!.weight) ? Number(target!.weight) : base.weight) };
    });
  const missing = (Object.keys(proxy.landmarks) as HeadProxyLandmarkId[]).filter((landmark) => !points.some((point) => point.landmark === landmark));
  const regularization = Math.max(0.000001, Number.isFinite(request.regularization) ? Math.abs(Number(request.regularization)) : 0.001);
  const xFit = fitAxis(points.map((point) => ({ relative: point.relX, delta: point.target.x - point.predicted.x, weight: point.weight })), regularization);
  const yFit = fitAxis(points.map((point) => ({ relative: point.relY, delta: point.target.y - point.predicted.y, weight: point.weight })), regularization);
  const diagnostics = points.map((point) => {
    const corrected = { x: point.predicted.x + xFit.offset + xFit.scale * point.relX, y: point.predicted.y + yFit.offset + yFit.scale * point.relY };
    return { landmark: point.landmark, target: { x: point.target.x, y: point.target.y }, predicted: point.predicted, corrected, error: round(Math.hypot(corrected.x - point.target.x, corrected.y - point.target.y)) };
  });
  const residualRms = points.length ? Math.sqrt(diagnostics.reduce((sum, point) => sum + point.error * point.error, 0) / points.length) : Number.POSITIVE_INFINITY;
  const maxResidual = diagnostics.reduce((maximum, point) => Math.max(maximum, point.error), 0);
  const residualGate = Math.max(0.01, Number.isFinite(request.maxResidual) ? Math.abs(Number(request.maxResidual)) : Math.max(proxy.bounds.width, proxy.bounds.height) * 0.02);
  return {
    values,
    candidateValues: candidate.values,
    matched: points.map((point) => point.landmark),
    missing,
    translation: { x: round(xFit.offset), y: round(yFit.offset) },
    scale: { x: round(xFit.scale), y: round(yFit.scale) },
    residualRms: round(residualRms),
    maxResidual: round(maxResidual),
    regularization,
    pass: points.length >= 3 && Number.isFinite(residualRms) && maxResidual <= residualGate,
    diagnostics
  };
}

export function correspondenceOperationsForSolution(rig: RigDocument, proxy: HeadProxy, solution: CorrespondenceSolution, request: CorrespondenceSolveRequest = { landmarks: {} }): CorrespondenceOperationReport {
  const definitions = parameterDefinitionsForRig(rig);
  const defaults = defaultParameterValues(rig);
  const values = { ...defaults, ...solution.values };
  const parameterIds = ["ParamAngleX", "ParamAngleY"].filter((parameter) => definitions.some((entry) => entry.id === parameter) && Number.isFinite(values[parameter]) && Math.abs(values[parameter]) > 0.0001);
  const selected = rig.parts.filter((part) => part.kind === "image" && part.artMesh?.enabled && selectedPart(part, request));
  const states = evaluateRigParts(rig, values, identityMatrix());
  const operations: ModelingOperation[] = [];
  const summaries: CorrespondenceOperationSummary[] = [];
  const maxAllowedOffset = Math.max(1, Number.isFinite(request.maxOffset) ? Math.abs(Number(request.maxOffset)) : Math.max(proxy.bounds.width, proxy.bounds.height) * 0.08);
  let finite = true;
  let maxOffset = 0;
  const selectedPartIds: string[] = [];
  for (const part of selected) {
    const state = states.get(part.id);
    const size = partSize(rig, part);
    if (!state || !size || !part.artMesh) continue;
    const inverse = invertMatrix(state.matrix);
    const locked = new Set(part.artMesh.generator.quality?.lockedVertexIds ?? []);
    const offsets: RigArtMeshVertexOffset[] = [];
    for (const vertex of part.artMesh.vertices) {
      if (locked.has(vertex.id)) continue;
      const local = { x: -part.transform.pivotX * size.width + vertex.x, y: -part.transform.pivotY * size.height + vertex.y };
      const world = transformMatrixPoint(state.matrix, local.x, local.y);
      const correctedWorld = applyAffineCorrection(world, proxy, solution);
      const correctedLocal = transformMatrixPoint(inverse, correctedWorld.x, correctedWorld.y);
      const x = round(correctedLocal.x - local.x);
      const y = round(correctedLocal.y - local.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) { finite = false; continue; }
      const magnitude = Math.hypot(x, y);
      maxOffset = Math.max(maxOffset, magnitude);
      offsets.push({ vertexId: vertex.id, x, y });
    }
    if (!offsets.length) continue;
    selectedPartIds.push(part.id);
    const magnitudeValues = offsets.map((offset) => Math.hypot(offset.x, offset.y));
    const action = parameterIds.length >= 2
      ? { type: "artmesh-multi-key" as const, parameters: [parameterIds[0], parameterIds[1]] as [string, string], inputs: { [parameterIds[0]]: values[parameterIds[0]], [parameterIds[1]]: values[parameterIds[1]] }, offsets, additive: false, interpolation: "smoothstep" as const }
      : parameterIds.length === 1
        ? { type: "artmesh-binding-key" as const, parameter: parameterIds[0], input: values[parameterIds[0]], offsets, additive: false, interpolation: "smoothstep" as const }
        : undefined;
    if (!action) continue;
    const operation: ModelingOperation = { id: `correspondence-${part.id}-${parameterIds.join("-") || "neutral"}`, name: "Landmark correspondence ArtMesh candidate", target: { partIds: [part.id] }, action };
    operations.push(operation);
    summaries.push({ operation, partId: part.id, offsetCount: offsets.length, lockedExcluded: part.artMesh.vertices.length - offsets.length, maxOffset: round(Math.max(...magnitudeValues, 0)), meanOffset: round(magnitudeValues.reduce((sum, value) => sum + value, 0) / magnitudeValues.length) });
  }
  const candidateRig = structuredClone(rig);
  const issues: string[] = [];
  for (const operation of operations) {
    const result = executeOperation(candidateRig, operation);
    if (result.skipped.length) issues.push(...result.skipped.map((entry) => `${operation.id}:${entry.reason}`));
  }
  const distortion = operations.length ? auditRigArtMeshDistortion(candidateRig, values, { maxStretchRatio: 4, maxCompressionRatio: 4, maxAnisotropy: 6 }) : undefined;
  const distortionPass = distortion ? distortion.pass : false;
  if (maxOffset > maxAllowedOffset) issues.push(`max-offset-exceeded:${round(maxOffset)}>${round(maxAllowedOffset)}`);
  return { operations, summaries, selectedPartIds, maxOffset: round(maxOffset), finite, distortionPass, distortion, issues, };
}

function executeOperation(rig: RigDocument, operation: ModelingOperation) {
  // Kept local to avoid making the solver a second transaction endpoint.
  const part = rig.parts.find((entry) => operation.target.partIds?.includes(entry.id));
  if (!part?.artMesh) return { skipped: [{ partId: operation.target.partIds?.[0] ?? "unknown", reason: "artmesh-required" }] };
  const action = operation.action;
  if (action.type === "artmesh-binding-key") {
    part.artMesh.bindings ??= [];
    const binding = part.artMesh.bindings.find((entry) => entry.parameter === action.parameter) ?? { parameter: action.parameter, additive: false, interpolation: action.interpolation, keys: [] };
    const key = { input: action.input, offsets: action.offsets };
    const index = binding.keys.findIndex((entry) => Math.abs(entry.input - action.input) < 0.0001);
    if (index >= 0) binding.keys[index] = key; else binding.keys.push(key);
    if (!part.artMesh.bindings.includes(binding)) part.artMesh.bindings.push(binding);
  } else if (action.type === "artmesh-multi-key") {
    part.artMesh.multiBindings ??= [];
    const binding = part.artMesh.multiBindings.find((entry) => entry.parameters[0] === action.parameters[0] && entry.parameters[1] === action.parameters[1]) ?? { parameters: action.parameters, additive: false, interpolation: action.interpolation, keyforms: [] };
    const key = { inputs: action.inputs, offsets: action.offsets };
    const index = binding.keyforms.findIndex((entry) => Math.abs((entry.inputs[action.parameters[0]] ?? 0) - action.inputs[action.parameters[0]]) < 0.0001 && Math.abs((entry.inputs[action.parameters[1]] ?? 0) - action.inputs[action.parameters[1]]) < 0.0001);
    if (index >= 0) binding.keyforms[index] = key; else binding.keyforms.push(key);
    if (!part.artMesh.multiBindings.includes(binding)) part.artMesh.multiBindings.push(binding);
  }
  return { skipped: [] as Array<{ partId: string; reason: string }> };
}

function applyAffineCorrection(point: { x: number; y: number }, proxy: HeadProxy, solution: CorrespondenceSolution) {
  const centerY = proxy.bounds.top + proxy.bounds.height * 0.5;
  return {
    x: point.x + solution.translation.x + solution.scale.x * (point.x - proxy.axisX),
    y: point.y + solution.translation.y + solution.scale.y * (point.y - centerY)
  };
}

function candidatePoint(proxy: HeadProxy, candidate: HeadProxyPoseCandidate, landmark: HeadProxyLandmarkId) {
  const point = proxy.landmarks[landmark];
  const centerY = proxy.bounds.top + proxy.bounds.height * 0.5;
  const offset = candidate.landmarkOffsets[landmark] ?? { x: 0, y: 0 };
  return { x: round(proxy.axisX + (point.x - proxy.axisX) * candidate.scaleX + offset.x), y: round(centerY + (point.y - centerY) * candidate.scaleY + offset.y) };
}

function nearestPoseCandidate(proxy: HeadProxy, values: ParameterValues) {
  const angleX = Number(values.ParamAngleX ?? 0);
  const angleY = Number(values.ParamAngleY ?? 0);
  return headProxyPoseCandidates(proxy).reduce((best, candidate) => {
    const distance = Math.hypot((candidate.values.ParamAngleX ?? 0) - angleX, (candidate.values.ParamAngleY ?? 0) - angleY);
    const bestDistance = Math.hypot((best.values.ParamAngleX ?? 0) - angleX, (best.values.ParamAngleY ?? 0) - angleY);
    return distance < bestDistance ? candidate : best;
  });
}

function fitAxis(points: Array<{ relative: number; delta: number; weight: number }>, regularization: number) {
  let a00 = regularization, a01 = 0, a11 = regularization, b0 = 0, b1 = 0;
  for (const point of points) {
    a00 += point.weight;
    a01 += point.weight * point.relative;
    a11 += point.weight * point.relative * point.relative;
    b0 += point.weight * point.delta;
    b1 += point.weight * point.delta * point.relative;
  }
  const determinant = a00 * a11 - a01 * a01;
  if (Math.abs(determinant) < 0.000001) return { offset: points.length ? points.reduce((sum, point) => sum + point.delta * point.weight, 0) / points.reduce((sum, point) => sum + point.weight, 0) : 0, scale: 0 };
  return { offset: (b0 * a11 - b1 * a01) / determinant, scale: (a00 * b1 - a01 * b0) / determinant };
}

function selectedPart(part: RigDocument["parts"][number], request: CorrespondenceSolveRequest) {
  if (request.partIds?.length) return request.partIds.includes(part.id);
  if (request.roles?.length) return Boolean(part.role && request.roles.includes(part.role));
  return part.role === "face" || part.role === "eye-left" || part.role === "eye-right" || part.role === "mouth";
}

function partSize(rig: RigDocument, part: RigDocument["parts"][number]) {
  const asset = part.assetId ? rig.assets.find((entry) => entry.id === part.assetId) : undefined;
  const width = asset?.width ?? part.artMesh?.generator.alphaBounds.width;
  const height = asset?.height ?? part.artMesh?.generator.alphaBounds.height;
  return Number.isFinite(width) && Number.isFinite(height) && (width ?? 0) > 0 && (height ?? 0) > 0 ? { width: width!, height: height! } : undefined;
}

function round(value: number) { return Math.round(value * 1000000) / 1000000; }
