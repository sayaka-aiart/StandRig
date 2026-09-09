import { PARAMETER_IDS, type ParameterDefinition, type ParameterValues, type RigDocument } from "./types.js";

/**
 * Reserved vocabulary shared with the modeling side. Definitions exist ahead
 * of model keyforms so tracking mappings and URL/API access stay stable.
 * See PARAMETERS.md before changing ids or ranges.
 */
export const RESERVED_PARAMETERS: ParameterDefinition[] = [
  { id: "ParamBodyAngleZ", label: "Body Z", min: -10, max: 10, default: 0, step: 0.1, group: "Body" },
  { id: "ParamBreath", label: "Breath", min: 0, max: 1, default: 0, step: 0.01, group: "Body" },
  { id: "ParamCheek", label: "Cheek", min: 0, max: 1, default: 0, step: 0.01, group: "Expression" },
  { id: "ParamEyeLSmile", label: "Eye L Smile", min: 0, max: 1, default: 0, step: 0.01, group: "Expression" },
  { id: "ParamEyeRSmile", label: "Eye R Smile", min: 0, max: 1, default: 0, step: 0.01, group: "Expression" },
  { id: "ParamBrowLY", label: "Brow L Y", min: -1, max: 1, default: 0, step: 0.01, group: "Brow" },
  { id: "ParamBrowRY", label: "Brow R Y", min: -1, max: 1, default: 0, step: 0.01, group: "Brow" },
  { id: "ParamBrowLX", label: "Brow L X", min: -1, max: 1, default: 0, step: 0.01, group: "Brow" },
  { id: "ParamBrowRX", label: "Brow R X", min: -1, max: 1, default: 0, step: 0.01, group: "Brow" },
  { id: "ParamBrowLAngle", label: "Brow L Angle", min: -1, max: 1, default: 0, step: 0.01, group: "Brow" },
  { id: "ParamBrowRAngle", label: "Brow R Angle", min: -1, max: 1, default: 0, step: 0.01, group: "Brow" },
  { id: "ParamBrowLForm", label: "Brow L Form", min: -1, max: 1, default: 0, step: 0.01, group: "Brow" },
  { id: "ParamBrowRForm", label: "Brow R Form", min: -1, max: 1, default: 0, step: 0.01, group: "Brow" },
  { id: "ParamHairFront", label: "Hair Front", min: -1, max: 1, default: 0, step: 0.01, group: "Physics" },
  { id: "ParamHairSide", label: "Hair Side", min: -1, max: 1, default: 0, step: 0.01, group: "Physics" },
  { id: "ParamHairBack", label: "Hair Back", min: -1, max: 1, default: 0, step: 0.01, group: "Physics" },
  { id: "ParamSkirt", label: "Skirt", min: -1, max: 1, default: 0, step: 0.01, group: "Physics" },
  { id: "ParamRibbon", label: "Ribbon", min: -1, max: 1, default: 0, step: 0.01, group: "Physics" }
];

export const DEFAULT_PARAMETERS: ParameterDefinition[] = [
  { id: "ParamAngleX", label: "Angle X", min: -30, max: 30, default: 0, step: 1, group: "Face" },
  { id: "ParamAngleY", label: "Angle Y", min: -30, max: 30, default: 0, step: 1, group: "Face" },
  { id: "ParamAngleZ", label: "Angle Z", min: -30, max: 30, default: 0, step: 1, group: "Face" },
  { id: "ParamEyeBallX", label: "Eye Ball X", min: -1, max: 1, default: 0, step: 0.01, group: "Gaze" },
  { id: "ParamEyeBallY", label: "Eye Ball Y", min: -1, max: 1, default: 0, step: 0.01, group: "Gaze" },
  { id: "ParamBodyAngleX", label: "Body X", min: -30, max: 30, default: 0, step: 1, group: "Body" },
  { id: "ParamBodyAngleY", label: "Body Y", min: -30, max: 30, default: 0, step: 1, group: "Body" },
  { id: "ParamMouthOpen", label: "Mouth", min: 0, max: 1, default: 0, step: 0.01, group: "Expression" },
  { id: "ParamMouthForm", label: "Mouth Form", min: -1, max: 1, default: 0, step: 0.01, group: "Expression" },
  { id: "ParamMouthSmile", label: "Mouth Smile", min: -1, max: 1, default: 0, step: 0.01, group: "Expression" },
  { id: "ParamEyeLOpen", label: "Eye L", min: 0, max: 1, default: 1, step: 0.01, group: "Expression" },
  { id: "ParamEyeROpen", label: "Eye R", min: 0, max: 1, default: 1, step: 0.01, group: "Expression" },
  ...RESERVED_PARAMETERS
];

const QUERY_ALIASES: Record<string, string> = {
  angleX: "ParamAngleX",
  angleY: "ParamAngleY",
  angleZ: "ParamAngleZ",
  eyeBallX: "ParamEyeBallX",
  eyeBallY: "ParamEyeBallY",
  bodyAngleX: "ParamBodyAngleX",
  bodyAngleY: "ParamBodyAngleY",
  mouthOpen: "ParamMouthOpen",
  mouthForm: "ParamMouthForm",
  mouthSmile: "ParamMouthSmile",
  mouthWide: "ParamMouthForm",
  mouthRound: "ParamMouthForm",
  eyeLOpen: "ParamEyeLOpen",
  eyeROpen: "ParamEyeROpen",
  bodyAngleZ: "ParamBodyAngleZ",
  breath: "ParamBreath",
  cheek: "ParamCheek",
  eyeLSmile: "ParamEyeLSmile",
  eyeRSmile: "ParamEyeRSmile",
  browLY: "ParamBrowLY",
  browRY: "ParamBrowRY",
  browLX: "ParamBrowLX",
  browRX: "ParamBrowRX",
  browLAngle: "ParamBrowLAngle",
  browRAngle: "ParamBrowRAngle",
  browLForm: "ParamBrowLForm",
  browRForm: "ParamBrowRForm",
  hairFront: "ParamHairFront",
  hairSide: "ParamHairSide",
  hairBack: "ParamHairBack"
};

export function parameterDefinitionsForRig(rig: RigDocument): ParameterDefinition[] {
  const merged = new Map<string, ParameterDefinition>();
  for (const parameter of DEFAULT_PARAMETERS) {
    merged.set(parameter.id, parameter);
  }
  for (const parameter of rig.parameters ?? []) {
    merged.set(parameter.id, { ...merged.get(parameter.id), ...parameter });
  }
  return Array.from(merged.values());
}

export function defaultParameterValues(rig: RigDocument): ParameterValues {
  const values: ParameterValues = {};
  for (const parameter of parameterDefinitionsForRig(rig)) {
    values[parameter.id] = parameter.default;
  }
  return values;
}
export function storedPreviewParameterValues(rig: RigDocument): Partial<ParameterValues> {
  const raw = rig.metadata?.previewParams;
  if (!raw || typeof raw !== "object") {
    return {};
  }

  const values: Partial<ParameterValues> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      values[key] = clampParameterValue(rig, key, value);
    }
  }
  return values;
}

export function previewParameterValuesForRig(rig: RigDocument, overrides: Partial<ParameterValues> = {}): ParameterValues {
  return mergeParameterValues(rig, { ...storedPreviewParameterValues(rig), ...overrides });
}

export function writePreviewParameterValues(rig: RigDocument, values: Partial<ParameterValues>): ParameterValues {
  const merged = mergeParameterValues(rig, { ...storedPreviewParameterValues(rig), ...values });
  rig.metadata = {
    ...(rig.metadata ?? {}),
    previewParams: merged
  };
  return merged;
}

export function normalizeParameterKey(key: string): string {
  if ((PARAMETER_IDS as readonly string[]).includes(key)) {
    return key;
  }
  return QUERY_ALIASES[key] ?? key;
}

export function parseUrlParameters(search = window.location.search): Partial<ParameterValues> {
  const params = new URLSearchParams(search);
  const values: Partial<ParameterValues> = {};

  for (const [rawKey, rawValue] of params) {
    const key = normalizeParameterKey(rawKey);
    const value = Number(rawValue);
    if (Number.isFinite(value)) {
      values[key] = value;
    }
  }

  return values;
}

export function clampParameterValue(rig: RigDocument, id: string, value: number): number {
  const definition = parameterDefinitionsForRig(rig).find((parameter) => parameter.id === id);
  if (!definition) {
    return value;
  }
  return Math.min(definition.max, Math.max(definition.min, value));
}

export function mergeParameterValues(rig: RigDocument, overrides: Partial<ParameterValues>): ParameterValues {
  const values = defaultParameterValues(rig);
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      values[key] = clampParameterValue(rig, key, value);
    }
  }
  return values;
}
