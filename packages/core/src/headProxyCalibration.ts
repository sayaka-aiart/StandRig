import type { ParameterValues } from "./types.js";
import { headProxyPoseCandidates, type HeadProxy, type HeadProxyLandmarkId, type HeadProxyPoseCandidate } from "./headProxy.js";

export type HeadProxyCalibrationUnits = "stage" | "normalized";

export interface HeadProxyCalibrationPoint {
  x: number;
  y: number;
}

export interface HeadProxyCalibrationSample {
  poseId: string;
  values: ParameterValues;
  landmarks: Partial<Record<HeadProxyLandmarkId, HeadProxyCalibrationPoint>>;
}

export interface HeadProxyCalibrationCorrection {
  landmark: HeadProxyLandmarkId;
  dx: number;
  dy: number;
  errorNorm: number;
}

export interface HeadProxyCalibrationSampleReport {
  poseId: string;
  values: ParameterValues;
  snappedValues: ParameterValues;
  inputSnapDistance: number;
  observedLandmarkCount: number;
  meanErrorNorm: number;
  maxErrorNorm: number;
  corrections: HeadProxyCalibrationCorrection[];
}

export interface HeadProxyCalibrationReport {
  units: HeadProxyCalibrationUnits;
  thresholdNorm: number;
  sampleCount: number;
  observedLandmarkCount: number;
  finite: boolean;
  pass: boolean;
  meanErrorNorm: number;
  maxErrorNorm: number;
  samples: HeadProxyCalibrationSampleReport[];
}

const LANDMARK_IDS: HeadProxyLandmarkId[] = ["faceCenter", "leftEye", "rightEye", "nose", "mouth", "chin", "leftEar", "rightEar"];

export function normalizeHeadProxyCalibrationSamples(value: unknown): HeadProxyCalibrationSample[] {
  if (!Array.isArray(value)) throw new Error("samples must be an array");
  const samples: HeadProxyCalibrationSample[] = [];
  value.forEach((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const record = raw as Record<string, unknown>;
    const rawValues = record.values && typeof record.values === "object" && !Array.isArray(record.values) ? record.values as Record<string, unknown> : {};
    const values: ParameterValues = {};
    for (const [id, input] of Object.entries(rawValues)) {
      if (Number.isFinite(Number(input))) values[id] = Number(input);
    }
    const rawLandmarks = record.landmarks && typeof record.landmarks === "object" && !Array.isArray(record.landmarks) ? record.landmarks as Record<string, unknown> : {};
    const landmarks: Partial<Record<HeadProxyLandmarkId, HeadProxyCalibrationPoint>> = {};
    for (const id of LANDMARK_IDS) {
      const point = rawLandmarks[id];
      if (!point || typeof point !== "object" || Array.isArray(point)) continue;
      const x = Number((point as Record<string, unknown>).x);
      const y = Number((point as Record<string, unknown>).y);
      if (Number.isFinite(x) && Number.isFinite(y)) landmarks[id] = { x, y };
    }
    if (!Object.keys(landmarks).length) return;
    samples.push({
      poseId: typeof record.poseId === "string" && record.poseId.trim() ? record.poseId.trim() : "sample-" + index,
      values,
      landmarks
    });
  });
  if (!samples.length) throw new Error("samples must contain at least one landmark-bearing sample");
  return samples;
}

export function calibrateHeadProxy(proxy: HeadProxy, samples: HeadProxyCalibrationSample[], options: { units?: HeadProxyCalibrationUnits; thresholdNorm?: number } = {}): HeadProxyCalibrationReport {
  const units = options.units === "normalized" ? "normalized" : "stage";
  const thresholdNorm = Number.isFinite(options.thresholdNorm) && (options.thresholdNorm ?? 0) > 0 ? Number(options.thresholdNorm) : 0.08;
  const candidates = headProxyPoseCandidates(proxy);
  const scale = Math.max(proxy.bounds.width, proxy.bounds.height, 1);
  let finite = true;
  let totalError = 0;
  let totalCount = 0;
  let maxErrorNorm = 0;
  const reports = samples.map((sample) => {
    const candidate = nearestCandidate(candidates, sample.values);
    const corrections: HeadProxyCalibrationCorrection[] = [];
    for (const [landmark, rawPoint] of Object.entries(sample.landmarks) as Array<[HeadProxyLandmarkId, HeadProxyCalibrationPoint]>) {
      const neutral = proxy.landmarks[landmark];
      const point = units === "normalized" ? normalizedToStage(proxy, rawPoint) : rawPoint;
      if (!neutral || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
        finite = false;
        continue;
      }
      const expected = candidate.landmarkOffsets[landmark] ?? { x: 0, y: 0 };
      const desired = { x: point.x - neutral.x, y: point.y - neutral.y };
      const dx = desired.x - expected.x;
      const dy = desired.y - expected.y;
      const errorNorm = Math.sqrt(dx * dx + dy * dy) / scale;
      if (!Number.isFinite(errorNorm)) {
        finite = false;
        continue;
      }
      corrections.push({ landmark, dx: round(dx), dy: round(dy), errorNorm: round(errorNorm) });
      totalError += errorNorm;
      totalCount += 1;
      maxErrorNorm = Math.max(maxErrorNorm, errorNorm);
    }
    const meanErrorNorm = corrections.length ? corrections.reduce((sum, correction) => sum + correction.errorNorm, 0) / corrections.length : 0;
    return {
      poseId: sample.poseId,
      values: sample.values,
      snappedValues: candidate.values,
      inputSnapDistance: round(inputSnapDistance(sample.values, candidate)),
      observedLandmarkCount: corrections.length,
      meanErrorNorm: round(meanErrorNorm),
      maxErrorNorm: round(corrections.reduce((max, correction) => Math.max(max, correction.errorNorm), 0)),
      corrections
    };
  });
  const meanErrorNorm = totalCount ? totalError / totalCount : 0;
  return {
    units,
    thresholdNorm: round(thresholdNorm),
    sampleCount: reports.length,
    observedLandmarkCount: totalCount,
    finite,
    pass: finite && totalCount > 0 && maxErrorNorm <= thresholdNorm,
    meanErrorNorm: round(meanErrorNorm),
    maxErrorNorm: round(maxErrorNorm),
    samples: reports
  };
}

function nearestCandidate(candidates: HeadProxyPoseCandidate[], values: ParameterValues): HeadProxyPoseCandidate {
  const angleX = finiteOrZero(values.ParamAngleX);
  const angleY = finiteOrZero(values.ParamAngleY);
  return candidates.reduce((best, candidate) => {
    const bestDistance = inputSnapDistance(values, best);
    const distance = Math.hypot(angleX - finiteOrZero(candidate.values.ParamAngleX), angleY - finiteOrZero(candidate.values.ParamAngleY));
    return distance < bestDistance ? candidate : best;
  });
}

function inputSnapDistance(values: ParameterValues, candidate: HeadProxyPoseCandidate): number {
  return Math.hypot(finiteOrZero(values.ParamAngleX) - finiteOrZero(candidate.values.ParamAngleX), finiteOrZero(values.ParamAngleY) - finiteOrZero(candidate.values.ParamAngleY));
}

function normalizedToStage(proxy: HeadProxy, point: HeadProxyCalibrationPoint): HeadProxyCalibrationPoint {
  return { x: proxy.bounds.left + point.x * proxy.bounds.width, y: proxy.bounds.top + point.y * proxy.bounds.height };
}

function finiteOrZero(value: unknown): number {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}
