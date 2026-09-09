import { auditRigArtMeshDistortion } from "./artMeshDistortion.js";
import { defaultParameterValues, parameterDefinitionsForRig } from "./parameters.js";
import { evaluateRigParts, identityMatrix, invertMatrix, transformMatrixPoint } from "./evaluator.js";
import { fitHeadProxy, headProxyPoseCandidates, type HeadProxy, type HeadProxyPoseCandidate } from "./headProxy.js";
import { auditSymmetryArtMeshBindings } from "./symmetryQa.js";
import { executeModelingOperation, type ModelingOperation } from "./modelingOps.js";
import type { ParameterValues, RigArtMeshVertexOffset, RigDocument } from "./types.js";

export interface ArtMeshKeyCandidateOptions {
  partIds?: string[];
  parameters?: string[];
  sample?: number;
  maxPairs?: number;
  includeOffsets?: boolean;
}

export interface ArtMeshKeyCandidateSummary {
  partId: string;
  parameter: string;
  input: number;
  offsetCount: number;
  lockedExcluded: number;
  maxOffset: number;
  meanOffset: number;
  influence: number;
  fingerprint: string;
  offsets?: RigArtMeshVertexOffset[];
}

export interface ArtMeshKeyCandidateReport {
  revisionSafe: boolean;
  proxyAvailable: boolean;
  selectedPairCount: number;
  selectedPairs: Array<{ sourceId: string; targetId: string; sourceRole?: string; targetRole?: string }>;
  operationCount: number;
  candidates: ArtMeshKeyCandidateSummary[];
  qa: {
    pass: boolean;
    finite: boolean;
    distortionPass: boolean;
    maxStretchRatio: number;
    maxCompressionRatio: number;
    maxAnisotropy: number;
    issues: string[];
  };
}

/**
 * Generate non-committing ArtMesh key proposals from the head proxy.
 * Existing Part bindings are never copied; only symmetry pairs classified as
 * mesh-ready by the ownership audit are eligible.
 */
export function modelingOperationsForArtMeshCandidates(report: ArtMeshKeyCandidateReport): ModelingOperation[] {
  return report.candidates
    .filter((candidate): candidate is ArtMeshKeyCandidateSummary & { offsets: RigArtMeshVertexOffset[] } => Array.isArray(candidate.offsets) && candidate.offsets.length > 0)
    .map((candidate) => ({
      id: "proxy-artmesh-" + candidate.partId + "-" + candidate.parameter + "-" + candidate.input,
      name: "Head proxy ArtMesh candidate",
      target: { partIds: [candidate.partId] },
      action: { type: "artmesh-binding-key", parameter: candidate.parameter, input: candidate.input, offsets: candidate.offsets, additive: false, interpolation: "smoothstep" }
    }));
}

export function generateArtMeshKeyCandidates(rig: RigDocument, options: ArtMeshKeyCandidateOptions = {}): ArtMeshKeyCandidateReport {
  const proxy = fitHeadProxy(rig);
  const ownership = auditSymmetryArtMeshBindings(rig);
  const requested = options.partIds?.length ? new Set(options.partIds) : undefined;
  const maxPairs = Math.max(1, Math.min(16, Math.round(options.maxPairs ?? 4)));
  const selectedPairs = ownership.pairs
    .filter((pair) => pair.status === "mesh-ready")
    .filter((pair) => !requested || requested.has(String(pair.sourceId)) || requested.has(String(pair.targetId)))
    .slice(0, maxPairs);
  const selectedPairRecords = selectedPairs.map((pair) => ({ sourceId: String(pair.sourceId), targetId: String(pair.targetId), sourceRole: typeof pair.sourceRole === "string" ? pair.sourceRole : undefined, targetRole: typeof pair.targetRole === "string" ? pair.targetRole : undefined }));
  if (!proxy) {
    return emptyReport(selectedPairRecords, false, "head-proxy-unavailable");
  }

  const definitions = parameterDefinitionsForRig(rig);
  const defaults = defaultParameterValues(rig);
  const neutralStates = evaluateRigParts(rig, defaults, identityMatrix());
  const parameters = (options.parameters?.length ? options.parameters : ["ParamAngleX", "ParamAngleY"]).filter((parameter) => definitions.some((entry) => entry.id === parameter));
  const candidates: ArtMeshKeyCandidateSummary[] = [];
  const operations: ModelingOperation[] = [];
  const sampleFor = (parameter: string) => {
    const definition = definitions.find((entry) => entry.id === parameter);
    const requestedSample = Math.abs(options.sample ?? definition?.max ?? 30);
    return Math.min(Math.abs(definition?.max ?? requestedSample), Math.max(Math.abs(definition?.min ?? 0), requestedSample));
  };

  for (const pair of selectedPairs) {
    for (const partId of [String(pair.sourceId), String(pair.targetId)]) {
      const part = rig.parts.find((entry) => entry.id === partId);
      const mesh = part?.artMesh;
      const neutralState = neutralStates.get(partId);
      if (!part || !mesh?.enabled || !neutralState) continue;
      const size = partSize(rig, part);
      if (!size) continue;
      for (const parameter of parameters) {
        const sample = sampleFor(parameter);
        for (const input of [-sample, sample]) {
          const poseCandidate = poseCandidateFor(parameter, input, proxy);
          if (!poseCandidate) continue;
          const values: ParameterValues = { ...defaults, [parameter]: input };
          const posedState = evaluateRigParts(rig, values, identityMatrix()).get(partId);
          if (!posedState) continue;
          const influence = roleInfluence(part.role);
          const offsets = buildOffsets(part, mesh.vertices, size.width, size.height, neutralState.matrix, posedState.matrix, proxy, poseCandidate, influence);
          if (!offsets.length) continue;
          const summary: ArtMeshKeyCandidateSummary = {
            partId,
            parameter,
            input,
            offsetCount: offsets.length,
            lockedExcluded: mesh.vertices.length - offsets.length,
            maxOffset: round(Math.max(...offsets.map((offset) => Math.hypot(offset.x, offset.y)), 0)),
            meanOffset: round(offsets.reduce((sum, offset) => sum + Math.hypot(offset.x, offset.y), 0) / offsets.length),
            influence,
            fingerprint: fingerprint(offsets)
          };
          if (options.includeOffsets) summary.offsets = offsets;
          candidates.push(summary);
          operations.push({
            id: "proxy-artmesh-" + partId + "-" + parameter + "-" + input,
            name: "Head proxy ArtMesh candidate",
            target: { partIds: [partId] },
            action: { type: "artmesh-binding-key", parameter, input, offsets, additive: false, interpolation: "smoothstep" }
          });
        }
      }
    }
  }

  const qa = evaluateCandidateQa(rig, operations, defaults);
  return {
    revisionSafe: true,
    proxyAvailable: true,
    selectedPairCount: selectedPairs.length,
    selectedPairs: selectedPairRecords,
    operationCount: operations.length,
    candidates,
    qa
  };
}

function evaluateCandidateQa(rig: RigDocument, operations: ModelingOperation[], defaults: ParameterValues): ArtMeshKeyCandidateReport["qa"] {
  if (!operations.length) return { pass: false, finite: true, distortionPass: true, maxStretchRatio: 1, maxCompressionRatio: 1, maxAnisotropy: 1, issues: ["no-candidates"] };
  const candidateRig = structuredClone(rig);
  const issues: string[] = [];
  let finite = true;
  for (const operation of operations) {
    const result = executeModelingOperation(candidateRig, operation, { dryRun: false });
    if (result.skipped.length) issues.push(...result.skipped.map((entry) => entry.reason));
    const action = operation.action;
    if (action.type === "artmesh-binding-key" && action.offsets.some((offset) => !Number.isFinite(offset.x) || !Number.isFinite(offset.y))) finite = false;
  }
  const samples = [...new Set(operations.filter((operation) => operation.action.type === "artmesh-binding-key").map((operation) => operation.action.type === "artmesh-binding-key" ? operation.action.parameter + ":" + operation.action.input : ""))];
  let maxStretchRatio = 1;
  let maxCompressionRatio = 1;
  let maxAnisotropy = 1;
  let distortionPass = true;
  for (const sample of samples) {
    const [parameter, rawInput] = sample.split(":");
    const values = { ...defaults, [parameter]: Number(rawInput) };
    const audit = auditRigArtMeshDistortion(candidateRig, values, { maxStretchRatio: 4, maxCompressionRatio: 4, maxAnisotropy: 6 });
    maxStretchRatio = Math.max(maxStretchRatio, audit.maxStretchRatio);
    maxCompressionRatio = Math.max(maxCompressionRatio, audit.maxCompressionRatio);
    maxAnisotropy = Math.max(maxAnisotropy, audit.maxAnisotropy);
    if (!audit.pass) distortionPass = false;
  }
  return { pass: finite && distortionPass && issues.length === 0, finite, distortionPass, maxStretchRatio: round(maxStretchRatio), maxCompressionRatio: round(maxCompressionRatio), maxAnisotropy: round(maxAnisotropy), issues: [...new Set(issues)].slice(0, 16) };
}

function buildOffsets(part: RigDocument["parts"][number], vertices: NonNullable<RigDocument["parts"][number]["artMesh"]>["vertices"], width: number, height: number, neutralMatrix: ReturnType<typeof identityMatrix>, posedMatrix: ReturnType<typeof identityMatrix>, proxy: HeadProxy, candidate: HeadProxyPoseCandidate, influence: number): RigArtMeshVertexOffset[] {
  const inversePosed = invertMatrix(posedMatrix);
  const locked = new Set(part.artMesh?.generator.quality?.lockedVertexIds ?? []);
  const offsets: RigArtMeshVertexOffset[] = [];
  for (const vertex of vertices) {
    if (locked.has(vertex.id)) continue;
    const local = { x: -part.transform.pivotX * width + vertex.x, y: -part.transform.pivotY * height + vertex.y };
    const neutralWorld = transformMatrixPoint(neutralMatrix, local.x, local.y);
    const desiredWorld = proxyField(neutralWorld, proxy, candidate);
    const desiredLocal = transformMatrixPoint(inversePosed, desiredWorld.x, desiredWorld.y);
    offsets.push({ vertexId: vertex.id, x: round((desiredLocal.x - local.x) * influence), y: round((desiredLocal.y - local.y) * influence) });
  }
  return offsets;
}

function roleInfluence(role: RigDocument["parts"][number]["role"]): number {
  if (role === "hair-back") return 0.08;
  if (role === "hair-tail-left" || role === "hair-tail-right") return 0.15;
  if (role === "hair-front" || role === "hair-side") return 0.18;
  if (role === "eye-left" || role === "eye-right") return 0.12;
  if (role === "mouth") return 0.2;
  if (role === "face") return 1;
  return 0.15;
}

function proxyField(point: { x: number; y: number }, proxy: HeadProxy, candidate: HeadProxyPoseCandidate) {
  const center = proxy.landmarks.faceCenter;
  const relativeX = point.x - center.x;
  const relativeY = point.y - center.y;
  const nx = clamp(relativeX / Math.max(1, proxy.bounds.width * 0.5), -1.5, 1.5);
  const ny = clamp(relativeY / Math.max(1, proxy.bounds.height * 0.5), -1.5, 1.5);
  const centerOffset = candidate.landmarkOffsets.faceCenter;
  const left = candidate.landmarkOffsets.leftEar;
  const right = candidate.landmarkOffsets.rightEar;
  const chin = candidate.landmarkOffsets.chin;
  const yawShear = ((right.x - left.x) * 0.5) * nx;
  const pitchShear = (chin.y - centerOffset.y) * ny * 0.5;
  return {
    x: center.x + relativeX * candidate.scaleX + centerOffset.x + yawShear,
    y: center.y + relativeY * candidate.scaleY + centerOffset.y + pitchShear
  };
}

function poseCandidateFor(parameter: string, input: number, proxy: HeadProxy): HeadProxyPoseCandidate | undefined {
  const candidates = headProxyPoseCandidates(proxy);
  return candidates.find((candidate) => Math.abs((candidate.values[parameter] ?? 0) - input) < 0.0001 && Object.entries(candidate.values).filter(([key]) => key !== parameter).every(([, value]) => Math.abs(value) < 0.0001));
}

function partSize(rig: RigDocument, part: RigDocument["parts"][number]) {
  const asset = part.assetId ? rig.assets.find((entry) => entry.id === part.assetId) : undefined;
  const width = asset?.width ?? part.artMesh?.generator.alphaBounds.width;
  const height = asset?.height ?? part.artMesh?.generator.alphaBounds.height;
  return Number.isFinite(width) && Number.isFinite(height) && width! > 0 && height! > 0 ? { width: width!, height: height! } : undefined;
}

function emptyReport(selectedPairs: ArtMeshKeyCandidateReport["selectedPairs"], proxyAvailable: boolean, issue: string): ArtMeshKeyCandidateReport {
  return { revisionSafe: true, proxyAvailable, selectedPairCount: selectedPairs.length, selectedPairs, operationCount: 0, candidates: [], qa: { pass: false, finite: true, distortionPass: true, maxStretchRatio: 1, maxCompressionRatio: 1, maxAnisotropy: 1, issues: [issue] } };
}

function fingerprint(offsets: RigArtMeshVertexOffset[]): string {
  let hash = 0x811c9dc5;
  for (const offset of offsets) {
    const source = offset.vertexId + ":" + offset.x + ":" + offset.y;
    for (let index = 0; index < source.length; index += 1) { hash ^= source.charCodeAt(index); hash = Math.imul(hash, 0x01000193); }
  }
  return "fnv1a-" + (hash >>> 0).toString(16).padStart(8, "0");
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function round(value: number) {
  return Math.round(value * 1000000) / 1000000;
}
