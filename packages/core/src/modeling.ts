import { mergeParameterValues } from "./parameters.js";
import type { ParameterValues, RigDocument } from "./types.js";

export interface ModelingPosePreset {
  id: string;
  label: string;
  group: "Face" | "Body" | "Expression" | "Stress";
  values: Partial<ParameterValues>;
}

export const MODELING_POSE_PRESETS: ModelingPosePreset[] = [
  { id: "neutral", label: "Neutral", group: "Face", values: {} },
  { id: "face-left", label: "Face L", group: "Face", values: { ParamAngleX: -20, ParamBodyAngleX: -8 } },
  { id: "face-left-mid", label: "Face L 50%", group: "Face", values: { ParamAngleX: -10, ParamBodyAngleX: -4 } },
  { id: "face-right", label: "Face R", group: "Face", values: { ParamAngleX: 20, ParamBodyAngleX: 8 } },
  { id: "face-right-mid", label: "Face R 50%", group: "Face", values: { ParamAngleX: 10, ParamBodyAngleX: 4 } },
  { id: "face-up", label: "Face Up", group: "Face", values: { ParamAngleY: -15, ParamBodyAngleY: -6 } },
  { id: "face-up-mid", label: "Face Up 50%", group: "Face", values: { ParamAngleY: -7.5, ParamBodyAngleY: -3 } },
  { id: "face-down", label: "Face Down", group: "Face", values: { ParamAngleY: 15, ParamBodyAngleY: 6 } },
  { id: "face-down-mid", label: "Face Down 50%", group: "Face", values: { ParamAngleY: 7.5, ParamBodyAngleY: 3 } },
  { id: "tilt-left", label: "Tilt L", group: "Face", values: { ParamAngleZ: -15 } },
  { id: "tilt-right", label: "Tilt R", group: "Face", values: { ParamAngleZ: 15 } },
  { id: "body-left", label: "Body L", group: "Body", values: { ParamBodyAngleX: -18, ParamAngleX: -8 } },
  { id: "body-left-mid", label: "Body L 50%", group: "Body", values: { ParamBodyAngleX: -9, ParamAngleX: -4 } },
  { id: "body-left-max", label: "Body L Max", group: "Body", values: { ParamBodyAngleX: -30 } },
  { id: "body-right", label: "Body R", group: "Body", values: { ParamBodyAngleX: 18, ParamAngleX: 8 } },
  { id: "body-right-mid", label: "Body R 50%", group: "Body", values: { ParamBodyAngleX: 9, ParamAngleX: 4 } },
  { id: "body-right-max", label: "Body R Max", group: "Body", values: { ParamBodyAngleX: 30 } },
  { id: "body-up", label: "Body Up", group: "Body", values: { ParamBodyAngleY: -22, ParamAngleY: -9 } },
  { id: "body-up-mid", label: "Body Up 50%", group: "Body", values: { ParamBodyAngleY: -11, ParamAngleY: -4.5 } },
  { id: "body-down", label: "Body Down", group: "Body", values: { ParamBodyAngleY: 22, ParamAngleY: 9 } },
  { id: "body-down-mid", label: "Body Down 50%", group: "Body", values: { ParamBodyAngleY: 11, ParamAngleY: 4.5 } },
  { id: "mouth-open", label: "Mouth 1", group: "Expression", values: { ParamMouthOpen: 1 } },
  { id: "mouth-half", label: "Mouth .5", group: "Expression", values: { ParamMouthOpen: 0.5 } },
  { id: "mouth-i", label: "Mouth I", group: "Expression", values: { ParamMouthOpen: 0.35, ParamMouthForm: -1, ParamMouthSmile: 0 } },
  { id: "mouth-u", label: "Mouth U", group: "Expression", values: { ParamMouthOpen: 0.45, ParamMouthForm: 1, ParamMouthSmile: 0 } },
  { id: "mouth-e", label: "Mouth E", group: "Expression", values: { ParamMouthOpen: 0.6, ParamMouthForm: -0.55, ParamMouthSmile: 0.1 } },
  { id: "mouth-o", label: "Mouth O", group: "Expression", values: { ParamMouthOpen: 0.75, ParamMouthForm: 0.8, ParamMouthSmile: 0 } },
  { id: "mouth-smile", label: "Mouth Smile", group: "Expression", values: { ParamMouthOpen: 0.45, ParamMouthForm: -0.25, ParamMouthSmile: 1 } },
  { id: "mouth-flat", label: "Mouth Flat", group: "Expression", values: { ParamMouthOpen: 0, ParamMouthForm: -0.75, ParamMouthSmile: 0 } },
  { id: "mouth-downturn", label: "Mouth Down", group: "Expression", values: { ParamMouthOpen: 0.2, ParamMouthForm: -0.2, ParamMouthSmile: -1 } },
  { id: "blink", label: "Blink", group: "Expression", values: { ParamEyeLOpen: 0, ParamEyeROpen: 0 } },
  { id: "wink-left", label: "Wink L", group: "Expression", values: { ParamEyeLOpen: 0, ParamEyeROpen: 1 } },
  { id: "wink-right", label: "Wink R", group: "Expression", values: { ParamEyeLOpen: 1, ParamEyeROpen: 0 } },
  {
    id: "head-left-wink-open",
    label: "Head L + Wink + Open",
    group: "Stress",
    values: { ParamAngleX: -20, ParamBodyAngleX: -8, ParamEyeLOpen: 0, ParamEyeROpen: 1, ParamEyeBallX: -1, ParamMouthOpen: 0.75, ParamMouthForm: 0, ParamMouthSmile: 0 }
  },
  {
    id: "head-right-wink-smile",
    label: "Head R + Wink + Smile",
    group: "Stress",
    values: { ParamAngleX: 20, ParamBodyAngleX: 8, ParamEyeLOpen: 1, ParamEyeROpen: 0, ParamEyeBallX: 1, ParamMouthOpen: 0.45, ParamMouthForm: -0.25, ParamMouthSmile: 1 }
  },
  {
    id: "head-up-blink-flat",
    label: "Head Up + Blink + Flat",
    group: "Stress",
    values: { ParamAngleY: -15, ParamBodyAngleY: -6, ParamEyeLOpen: 0, ParamEyeROpen: 0, ParamEyeBallY: -1, ParamMouthOpen: 0, ParamMouthForm: -0.75, ParamMouthSmile: 0 }
  },
  {
    id: "head-down-gaze-mouth-o",
    label: "Head Down + Gaze Down + Mouth O",
    group: "Stress",
    values: { ParamAngleY: 15, ParamBodyAngleY: 6, ParamEyeBallY: 1, ParamMouthOpen: 0.75, ParamMouthForm: 0.8, ParamMouthSmile: 0 }
  },  {
    id: "head-left-blink-flat",
    label: "Head L + Blink + Flat",
    group: "Stress",
    values: { ParamAngleX: -20, ParamBodyAngleX: -8, ParamMouthOpen: 0, ParamMouthForm: -0.75, ParamMouthSmile: 0, ParamEyeLOpen: 0, ParamEyeROpen: 0, ParamEyeBallX: -0.35 }
  },
  {
    id: "head-right-smile-gaze",
    label: "Head R + Smile + Gaze",
    group: "Stress",
    values: { ParamAngleX: 20, ParamBodyAngleX: 8, ParamMouthOpen: 0.45, ParamMouthForm: -0.25, ParamMouthSmile: 1, ParamEyeBallX: 1, ParamEyeBallY: 0 }
  },
  {
    id: "head-up-gaze-up-open",
    label: "Head Up + Gaze Up + Open",
    group: "Stress",
    values: { ParamAngleY: -15, ParamBodyAngleY: -6, ParamEyeBallY: -1, ParamMouthOpen: 0.75, ParamMouthForm: 0.8, ParamMouthSmile: 0 }
  },
  {
    id: "head-down-gaze-down-blink",
    label: "Head Down + Gaze Down + Blink",
    group: "Stress",
    values: { ParamAngleY: 15, ParamBodyAngleY: 6, ParamEyeBallY: 1, ParamEyeLOpen: 0, ParamEyeROpen: 0, ParamMouthOpen: 0.2, ParamMouthForm: -0.2, ParamMouthSmile: -1 }
  },
  {
    id: "head-counter-open",
    label: "Head Counter + Open",
    group: "Stress",
    values: { ParamAngleX: 18, ParamAngleY: 6, ParamBodyAngleX: -16, ParamBodyAngleY: 3, ParamEyeBallX: -1, ParamEyeBallY: 0.4, ParamMouthOpen: 1 }
  },
  {
    id: "stress-left-open",
    label: "Stress L",
    group: "Stress",
    values: { ParamAngleX: -24, ParamAngleY: -12, ParamBodyAngleX: -16, ParamMouthOpen: 1, ParamEyeLOpen: 1, ParamEyeROpen: 1 }
  },
  {
    id: "stress-right-blink",
    label: "Stress R",
    group: "Stress",
    values: { ParamAngleX: 24, ParamAngleY: 12, ParamBodyAngleX: 16, ParamMouthOpen: 0.4, ParamEyeLOpen: 0, ParamEyeROpen: 0 }
  }
];

export function modelingPosePresetsForRig(rig: RigDocument, baseValues: Partial<ParameterValues> = {}) {
  return MODELING_POSE_PRESETS.map((pose) => ({
    ...pose,
    values: mergeParameterValues(rig, { ...baseValues, ...pose.values })
  }));
}

export function modelingPosePresetById(id: string): ModelingPosePreset | undefined {
  return MODELING_POSE_PRESETS.find((pose) => pose.id === id);
}

export function modelingPoseValuesForRig(rig: RigDocument, id: string, baseValues: Partial<ParameterValues> = {}): ParameterValues | undefined {
  const preset = modelingPosePresetById(id);
  return preset ? mergeParameterValues(rig, { ...baseValues, ...preset.values }) : undefined;
}

