import { clampParameterValue, parameterDefinitionsForRig } from "./parameters.js";
import type { OneEuroFilterOptions, ParameterValues, RigDocument, RigTracking, TrackingEyeSync, TrackingInputValues, TrackingMapping, TrackingResponseCurve } from "./types.js";

export interface TrackingInputDefinition {
  id: string;
  label: string;
  min: number;
  max: number;
  default: number;
  step: number;
}

export const DEFAULT_TRACKING_INPUTS: TrackingInputDefinition[] = [
  { id: "faceYaw", label: "Face X", min: -1, max: 1, default: 0, step: 0.01 },
  { id: "facePitch", label: "Face Y", min: -1, max: 1, default: 0, step: 0.01 },
  { id: "faceRoll", label: "Face Z", min: -1, max: 1, default: 0, step: 0.01 },
  { id: "bodyYaw", label: "Body X", min: -1, max: 1, default: 0, step: 0.01 },
  { id: "bodyPitch", label: "Body Y", min: -1, max: 1, default: 0, step: 0.01 },
  { id: "mouthOpen", label: "Mouth", min: 0, max: 1, default: 0.12, step: 0.01 },
  { id: "mouthForm", label: "Mouth Form", min: -1, max: 1, default: 0, step: 0.01 },
  { id: "mouthSmile", label: "Mouth Smile", min: -1, max: 1, default: 0, step: 0.01 },
  { id: "eyeLOpen", label: "Eye L", min: 0, max: 1, default: 1, step: 0.01 },
  { id: "eyeROpen", label: "Eye R", min: 0, max: 1, default: 1, step: 0.01 },
  { id: "eyeBallX", label: "Eye Ball X", min: -1, max: 1, default: 0, step: 0.01 },
  { id: "eyeBallY", label: "Eye Ball Y", min: -1, max: 1, default: 0, step: 0.01 },
  { id: "browLY", label: "Brow L Y", min: -1, max: 1, default: 0, step: 0.01 },
  { id: "browRY", label: "Brow R Y", min: -1, max: 1, default: 0, step: 0.01 },
  { id: "cheek", label: "Cheek", min: 0, max: 1, default: 0, step: 0.01 }
];

export const DEFAULT_TRACKING_EYE_GAIN = 1.25;

export const DEFAULT_TRACKING_EYE_SYNC: TrackingEyeSync = {
  enabled: false,
  winkThreshold: 0.35,
  winkCurve: "hard",
  leftGain: DEFAULT_TRACKING_EYE_GAIN,
  rightGain: DEFAULT_TRACKING_EYE_GAIN
};

export const DEFAULT_ONE_EURO_FILTER: Required<OneEuroFilterOptions> = {
  minCutoff: 1.1,
  beta: 0.08,
  derivativeCutoff: 1.0
};

export interface TrackingFilterState {
  oneEuro: Record<string, { value: number; derivative: number; timestampMs: number }>;
}

export function createTrackingFilterState(): TrackingFilterState {
  return { oneEuro: {} };
}

const DEFAULT_MAPPING_SPECS: Array<Omit<TrackingMapping, "id" | "enabled">> = [
  { source: "faceYaw", parameter: "ParamAngleX", scale: 36, offset: 0, min: -30, max: 30, smoothing: 0.08, filter: "one-euro", oneEuro: { ...DEFAULT_ONE_EURO_FILTER, beta: 0.1 } },
  { source: "facePitch", parameter: "ParamAngleY", scale: 42, offset: 0, min: -30, max: 30, smoothing: 0.08, filter: "one-euro", oneEuro: { ...DEFAULT_ONE_EURO_FILTER, beta: 0.1 } },
  { source: "faceRoll", parameter: "ParamAngleZ", scale: 36, offset: 0, min: -30, max: 30, smoothing: 0.08, filter: "one-euro", oneEuro: { ...DEFAULT_ONE_EURO_FILTER, beta: 0.08 } },
  { source: "bodyYaw", parameter: "ParamBodyAngleX", scale: 24, offset: 0, min: -30, max: 30, smoothing: 0.16, filter: "one-euro", oneEuro: { ...DEFAULT_ONE_EURO_FILTER, minCutoff: 0.9, beta: 0.08 } },
  { source: "bodyPitch", parameter: "ParamBodyAngleY", scale: 28, offset: 0, min: -30, max: 30, smoothing: 0.16, filter: "one-euro", oneEuro: { ...DEFAULT_ONE_EURO_FILTER, minCutoff: 0.9, beta: 0.08 } },
  { source: "mouthOpen", parameter: "ParamMouthOpen", scale: 1, offset: 0, min: 0, max: 1, smoothing: 0.12 },
  { source: "mouthForm", parameter: "ParamMouthForm", scale: 1, offset: 0, min: -1, max: 1, smoothing: 0.18 },
  { source: "mouthSmile", parameter: "ParamMouthSmile", scale: 1, offset: 0, min: -1, max: 1, smoothing: 0.18 },
  { source: "eyeLOpen", parameter: "ParamEyeLOpen", scale: 1, offset: 0, min: 0, max: 1, smoothing: 0.08 },
  { source: "eyeROpen", parameter: "ParamEyeROpen", scale: 1, offset: 0, min: 0, max: 1, smoothing: 0.08 },
  { source: "eyeBallX", parameter: "ParamEyeBallX", scale: 1, offset: 0, min: -1, max: 1, smoothing: 0.15 },
  { source: "eyeBallY", parameter: "ParamEyeBallY", scale: 1, offset: 0, min: -1, max: 1, smoothing: 0.15 },
  { source: "browLY", parameter: "ParamBrowLY", scale: 1, offset: 0, min: -1, max: 1, smoothing: 0.2 },
  { source: "browRY", parameter: "ParamBrowRY", scale: 1, offset: 0, min: -1, max: 1, smoothing: 0.2 },
  { source: "cheek", parameter: "ParamCheek", scale: 1, offset: 0, min: 0, max: 1, smoothing: 0.25 }
];

export function defaultTrackingInputValues(): TrackingInputValues {
  const values: TrackingInputValues = {};
  for (const input of DEFAULT_TRACKING_INPUTS) {
    values[input.id] = input.default;
  }
  return values;
}

export function createDefaultTracking(rig: RigDocument): RigTracking {
  return {
    enabled: false,
    provider: "manual",
    inputSmoothing: 0.25,
    mappings: DEFAULT_MAPPING_SPECS.map((mapping, index) => normalizeTrackingMapping({ id: `tracking-map-${index + 1}`, enabled: true, ...mapping }, rig, index)),
    eyeSync: { ...DEFAULT_TRACKING_EYE_SYNC }
  };
}

export function createDefaultTrackingMapping(rig: RigDocument, index = 0): TrackingMapping {
  const parameter = parameterDefinitionsForRig(rig)[0]?.id ?? "ParamAngleX";
  return normalizeTrackingMapping(
    {
      id: uniqueTrackingMappingId(rig, "tracking-map"),
      enabled: true,
      source: DEFAULT_TRACKING_INPUTS[index % DEFAULT_TRACKING_INPUTS.length]?.id ?? "faceYaw",
      parameter,
      scale: 1,
      offset: 0,
      smoothing: 0.2
    },
    rig,
    index
  );
}

export function ensureRigTracking(rig: RigDocument): RigTracking {
  rig.tracking = normalizeTracking(rig.tracking, rig);
  return rig.tracking;
}

export function normalizeTracking(tracking: RigTracking | undefined, rig: RigDocument): RigTracking {
  if (!tracking || typeof tracking !== "object") {
    return createDefaultTracking(rig);
  }

  const normalized: RigTracking = {
    enabled: typeof tracking.enabled === "boolean" ? tracking.enabled : false,
    provider: tracking.provider === "mediapipe-face-landmarker" ? "mediapipe-face-landmarker" : "manual",
    inputSmoothing: clamp01(finiteNumber(tracking.inputSmoothing, 0.25)),
    mappings: Array.isArray(tracking.mappings) ? tracking.mappings.map((mapping, index) => normalizeTrackingMapping(mapping, rig, index)) : [],
    calibration: normalizeTrackingCalibration(tracking.calibration),
    eyeSync: normalizeTrackingEyeSync(tracking.eyeSync)
  };

  if (!normalized.mappings.length) {
    normalized.mappings = createDefaultTracking(rig).mappings;
  }

  return normalized;
}

export function applyTrackingInput(
  rig: RigDocument,
  currentParams: ParameterValues,
  inputValues: Partial<TrackingInputValues>,
  options: { force?: boolean; smoothing?: boolean; filterState?: TrackingFilterState; timestampMs?: number } = {}
): ParameterValues {
  const tracking = normalizeTracking(rig.tracking, rig);
  if (!options.force && !tracking.enabled) {
    return { ...currentParams };
  }

  const processed = preprocessTrackingInputs(tracking, inputValues);
  const next: ParameterValues = { ...currentParams };
  for (const mapping of tracking.mappings) {
    if (!mapping.enabled) {
      continue;
    }
    const rawInput = processed[mapping.source];
    if (!Number.isFinite(rawInput)) {
      continue;
    }

    let signedInput = mapping.invert ? -Number(rawInput) : Number(rawInput);
    if (mapping.deadZone) {
      signedInput = applyDeadZone(signedInput, mapping.deadZone);
    }
    if (mapping.filter === "one-euro" && options.filterState) {
      signedInput = applyOneEuroFilter(signedInput, options.filterState, mapping.id, mapping.oneEuro, options.timestampMs);
    }
    signedInput = applyTrackingResponseCurve(signedInput, mapping.responseCurve, mapping.responseGamma);
    let target = signedInput * mapping.scale + mapping.offset;
    if (Number.isFinite(mapping.min)) {
      target = Math.max(Number(mapping.min), target);
    }
    if (Number.isFinite(mapping.max)) {
      target = Math.min(Number(mapping.max), target);
    }
    target = clampParameterValue(rig, mapping.parameter, target);

    const previous = Number.isFinite(next[mapping.parameter]) ? next[mapping.parameter] : target;
    const smoothing = options.smoothing === false ? 0 : clamp01(mapping.smoothing);
    next[mapping.parameter] = roundForTracking(previous + (target - previous) * (1 - smoothing));
  }

  return next;
}

/**
 * Applies profile-level input corrections (neutral calibration offsets and
 * eye gain/calibration and eye sync) before per-mapping scale/offset/deadZone
 * are evaluated.
 */
export function preprocessTrackingInputs(tracking: RigTracking, values: Partial<TrackingInputValues>): Partial<TrackingInputValues> {
  const next: Partial<TrackingInputValues> = { ...values };
  const inputsById = new Map(DEFAULT_TRACKING_INPUTS.map((input) => [input.id, input]));

  for (const [source, offset] of Object.entries(tracking.calibration ?? {})) {
    const definition = inputsById.get(source);
    const raw = next[source];
    if (!definition || !Number.isFinite(raw) || !Number.isFinite(offset)) {
      continue;
    }
    next[source] = Math.min(definition.max, Math.max(definition.min, Number(raw) - Number(offset)));
  }

  const eyeSync = tracking.eyeSync;
  if (eyeSync) {
    const left = next.eyeLOpen;
    const right = next.eyeROpen;
    if (Number.isFinite(left)) {
      next.eyeLOpen = clamp01(Number(left) * clampTrackingEyeGain(eyeSync.leftGain));
    }
    if (Number.isFinite(right)) {
      next.eyeROpen = clamp01(Number(right) * clampTrackingEyeGain(eyeSync.rightGain));
    }
    if (eyeSync.enabled && Number.isFinite(next.eyeLOpen) && Number.isFinite(next.eyeROpen)) {
      const leftValue = Number(next.eyeLOpen);
      const rightValue = Number(next.eyeROpen);
      const difference = Math.abs(leftValue - rightValue);
      const threshold = eyeSync.winkThreshold;
      if (threshold > 0 && difference < threshold) {
        const average = (leftValue + rightValue) / 2;
        const syncWeight = eyeSync.winkCurve === "smoothstep"
          ? smoothstep(1 - difference / threshold)
          : 1;
        next.eyeLOpen = leftValue + (average - leftValue) * syncWeight;
        next.eyeROpen = rightValue + (average - rightValue) * syncWeight;
      }
    }
  }

  return next;
}

/**
 * Captures the current raw inputs as the neutral pose. Only zero-centered
 * sources are captured; sources like eyeLOpen (default 1) need gain
 * calibration instead, which is a Phase T1 item in TRACKING_ROADMAP.md.
 */
export function captureTrackingCalibration(inputValues: Partial<TrackingInputValues>): Record<string, number> {
  const calibration: Record<string, number> = {};
  for (const input of DEFAULT_TRACKING_INPUTS) {
    if (input.default !== 0) {
      continue;
    }
    const raw = inputValues[input.id];
    if (Number.isFinite(raw) && Math.abs(Number(raw)) > 0.0001) {
      calibration[input.id] = Math.round(Number(raw) * 10000) / 10000;
    }
  }
  return calibration;
}

function applyDeadZone(value: number, deadZone: number): number {
  const zone = Math.min(0.95, Math.max(0, deadZone));
  if (zone <= 0) {
    return value;
  }
  const magnitude = Math.abs(value);
  if (magnitude <= zone) {
    return 0;
  }
  return Math.sign(value) * ((magnitude - zone) / (1 - zone));
}

function applyTrackingResponseCurve(value: number, curve: TrackingResponseCurve | undefined, gamma: number | undefined): number {
  const normalizedCurve = curve ?? "linear";
  if (normalizedCurve === "linear") {
    return value;
  }
  const magnitude = Math.min(1, Math.max(0, Math.abs(value)));
  let shaped = magnitude;
  if (normalizedCurve === "smoothstep") {
    shaped = magnitude * magnitude * (3 - 2 * magnitude);
  } else if (normalizedCurve === "gamma") {
    shaped = Math.pow(magnitude, normalizeResponseGamma(gamma));
  }
  return Math.sign(value) * shaped;
}

export function normalizeTrackingInputValues(values: Partial<TrackingInputValues>): TrackingInputValues {
  const normalized = defaultTrackingInputValues();
  const inputsById = new Map(DEFAULT_TRACKING_INPUTS.map((input) => [input.id, input]));
  for (const [key, value] of Object.entries(values)) {
    const definition = inputsById.get(key);
    if (!definition || !Number.isFinite(value)) {
      continue;
    }
    normalized[key] = Math.min(definition.max, Math.max(definition.min, Number(value)));
  }
  return normalized;
}

function normalizeTrackingMapping(mapping: Partial<TrackingMapping>, rig: RigDocument, index: number): TrackingMapping {
  const sourceIds = new Set(DEFAULT_TRACKING_INPUTS.map((input) => input.id));
  const parameterIds = new Set(parameterDefinitionsForRig(rig).map((parameter) => parameter.id));
  const fallbackSpec = DEFAULT_MAPPING_SPECS[index % DEFAULT_MAPPING_SPECS.length] ?? DEFAULT_MAPPING_SPECS[0];
  const source = typeof mapping.source === "string" && sourceIds.has(mapping.source) ? mapping.source : fallbackSpec.source;
  const parameter = typeof mapping.parameter === "string" && parameterIds.has(mapping.parameter) ? mapping.parameter : fallbackSpec.parameter;

  return {
    id: typeof mapping.id === "string" && mapping.id.trim() ? mapping.id : `tracking-map-${index + 1}`,
    enabled: typeof mapping.enabled === "boolean" ? mapping.enabled : true,
    source,
    parameter,
    scale: finiteNumber(mapping.scale, fallbackSpec.scale),
    offset: finiteNumber(mapping.offset, fallbackSpec.offset),
    min: optionalFiniteNumber(mapping.min),
    max: optionalFiniteNumber(mapping.max),
    smoothing: clamp01(finiteNumber(mapping.smoothing, fallbackSpec.smoothing)),
    invert: mapping.invert === true,
    deadZone: normalizeDeadZone(mapping.deadZone),
    filter: mapping.filter === "one-euro" ? "one-euro" : mapping.filter === "ema" ? "ema" : fallbackSpec.filter ?? "ema",
    oneEuro: normalizeOneEuroOptions(mapping.oneEuro ?? fallbackSpec.oneEuro),
    responseCurve: normalizeResponseCurve(mapping.responseCurve ?? fallbackSpec.responseCurve),
    responseGamma: normalizeResponseGamma(mapping.responseGamma ?? fallbackSpec.responseGamma)
  };
}

function normalizeResponseCurve(value: unknown): TrackingResponseCurve {
  return value === "smoothstep" || value === "gamma" ? value : "linear";
}

function normalizeResponseGamma(value: unknown): number {
  return Math.min(4, Math.max(0.25, finiteNumber(value, 1)));
}

function normalizeOneEuroOptions(value: unknown): Required<OneEuroFilterOptions> {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as OneEuroFilterOptions : {};
  return {
    minCutoff: Math.max(0.01, finiteNumber(record.minCutoff, DEFAULT_ONE_EURO_FILTER.minCutoff)),
    beta: Math.max(0, finiteNumber(record.beta, DEFAULT_ONE_EURO_FILTER.beta)),
    derivativeCutoff: Math.max(0.01, finiteNumber(record.derivativeCutoff, DEFAULT_ONE_EURO_FILTER.derivativeCutoff))
  };
}

function applyOneEuroFilter(value: number, state: TrackingFilterState, mappingId: string, options: OneEuroFilterOptions | undefined, timestampMs?: number): number {
  const now = Number.isFinite(timestampMs) ? Number(timestampMs) : Date.now();
  const config = normalizeOneEuroOptions(options);
  const previous = state.oneEuro[mappingId];
  if (!previous || now <= previous.timestampMs) {
    state.oneEuro[mappingId] = { value, derivative: 0, timestampMs: now };
    return value;
  }
  const dt = Math.min(1, Math.max(1 / 240, (now - previous.timestampMs) / 1000));
  const derivative = (value - previous.value) / dt;
  const derivativeAlpha = smoothingAlpha(config.derivativeCutoff, dt);
  const filteredDerivative = derivativeAlpha * derivative + (1 - derivativeAlpha) * previous.derivative;
  const cutoff = config.minCutoff + config.beta * Math.abs(filteredDerivative);
  const valueAlpha = smoothingAlpha(cutoff, dt);
  const filteredValue = valueAlpha * value + (1 - valueAlpha) * previous.value;
  state.oneEuro[mappingId] = { value: filteredValue, derivative: filteredDerivative, timestampMs: now };
  return filteredValue;
}

function smoothingAlpha(cutoff: number, dt: number): number {
  const tau = 1 / (2 * Math.PI * Math.max(0.01, cutoff));
  return 1 / (1 + tau / dt);
}

function normalizeDeadZone(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.min(0.95, value);
}

function normalizeTrackingCalibration(calibration: unknown): Record<string, number> | undefined {
  if (!calibration || typeof calibration !== "object" || Array.isArray(calibration)) {
    return undefined;
  }
  const sourceIds = new Set(DEFAULT_TRACKING_INPUTS.map((input) => input.id));
  const normalized: Record<string, number> = {};
  for (const [key, value] of Object.entries(calibration as Record<string, unknown>)) {
    if (sourceIds.has(key) && typeof value === "number" && Number.isFinite(value) && value !== 0) {
      normalized[key] = value;
    }
  }
  return Object.keys(normalized).length ? normalized : undefined;
}

function normalizeTrackingEyeSync(eyeSync: unknown): TrackingEyeSync {
  if (!eyeSync || typeof eyeSync !== "object" || Array.isArray(eyeSync)) {
    return { ...DEFAULT_TRACKING_EYE_SYNC };
  }
  const record = eyeSync as Partial<TrackingEyeSync>;
  return {
    enabled: record.enabled === true,
    winkThreshold: clamp01(finiteNumber(record.winkThreshold, DEFAULT_TRACKING_EYE_SYNC.winkThreshold)),
    winkCurve: record.winkCurve === "smoothstep" ? "smoothstep" : "hard",
    leftGain: clampTrackingEyeGain(finiteNumber(record.leftGain, DEFAULT_TRACKING_EYE_GAIN)),
    rightGain: clampTrackingEyeGain(finiteNumber(record.rightGain, DEFAULT_TRACKING_EYE_GAIN))
  };
}

function clampTrackingEyeGain(value: unknown): number {
  return Math.min(2, Math.max(0.25, finiteNumber(value, DEFAULT_TRACKING_EYE_GAIN)));
}

function smoothstep(value: number): number {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
}

function uniqueTrackingMappingId(rig: RigDocument, prefix: string): string {
  const existing = new Set(rig.tracking?.mappings?.map((mapping) => mapping.id) ?? []);
  let index = existing.size + 1;
  let id = `${prefix}-${index}`;
  while (existing.has(id)) {
    index += 1;
    id = `${prefix}-${index}`;
  }
  return id;
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function optionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function roundForTracking(value: number): number {
  return Math.round(value * 10000) / 10000;
}