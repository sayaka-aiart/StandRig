import { previewParameterValuesForRig } from "./parameters.js";
import type { ParameterValues, RigDocument } from "./types.js";

export type ReferenceSheetSet = "reference-face" | "reference-expression" | "reference-body" | "reference-all";

export interface ReferencePosePreset {
  id: string;
  label: string;
  group: "face" | "expression" | "body";
  description: string;
  values: Partial<ParameterValues>;
}

export interface ReferenceSheetDefinition {
  id: ReferenceSheetSet;
  label: string;
  description: string;
  columns: number;
  poses: ReferencePosePreset[];
}

const FACE_REFERENCE_POSES: ReferencePosePreset[] = [
  { id: "face-neutral", label: "FACE NEUTRAL", group: "face", description: "Base head pose from the imported PSD.", values: {} },
  { id: "face-left", label: "FACE X -24", group: "face", description: "Head turns viewer-left with slight body counter motion.", values: { ParamAngleX: -24, ParamBodyAngleX: -8 } },
  { id: "face-right", label: "FACE X +24", group: "face", description: "Head turns viewer-right with slight body counter motion.", values: { ParamAngleX: 24, ParamBodyAngleX: 8 } },
  { id: "face-up", label: "FACE Y -18", group: "face", description: "Head tilts upward; checks jaw, neck, and hair roots.", values: { ParamAngleY: -18, ParamBodyAngleY: -5 } },
  { id: "face-down", label: "FACE Y +18", group: "face", description: "Head tilts downward; checks bangs, eyelids, and collar overlap.", values: { ParamAngleY: 18, ParamBodyAngleY: 6 } },
  { id: "face-roll-left", label: "FACE Z -16", group: "face", description: "Head roll left for neck and shoulder seams.", values: { ParamAngleZ: -16 } },
  { id: "face-roll-right", label: "FACE Z +16", group: "face", description: "Head roll right for neck and shoulder seams.", values: { ParamAngleZ: 16 } },
  { id: "face-stress", label: "FACE STRESS", group: "face", description: "Combined face angle used to expose connection issues.", values: { ParamAngleX: 24, ParamAngleY: 14, ParamAngleZ: 10, ParamBodyAngleX: 8, ParamBodyAngleY: 5 } }
];

const EXPRESSION_REFERENCE_POSES: ReferencePosePreset[] = [
  { id: "expression-neutral", label: "EXPR NEUTRAL", group: "expression", description: "Default closed-mouth expression target.", values: { ParamMouthOpen: 0, ParamEyeLOpen: 1, ParamEyeROpen: 1 } },
  { id: "mouth-closed", label: "MOUTH 0", group: "expression", description: "Closed mouth reference for lip contact.", values: { ParamMouthOpen: 0 } },
  { id: "mouth-half", label: "MOUTH .5", group: "expression", description: "Half-open mouth reference for lip curve and teeth overlap.", values: { ParamMouthOpen: 0.5 } },
  { id: "mouth-open", label: "MOUTH 1", group: "expression", description: "Open mouth reference for tongue, teeth, and lower-lip travel.", values: { ParamMouthOpen: 1 } },
  { id: "mouth-i", label: "MOUTH I", group: "expression", description: "Wide vowel target from the hidden mouth reference layer.", values: { ParamMouthOpen: 0.35, ParamMouthForm: -1, ParamMouthSmile: 0 } },
  { id: "mouth-u", label: "MOUTH U", group: "expression", description: "Rounded vowel target from the hidden mouth reference layer.", values: { ParamMouthOpen: 0.45, ParamMouthForm: 1, ParamMouthSmile: 0 } },
  { id: "mouth-e", label: "MOUTH E", group: "expression", description: "Wide-open vowel target for lip spread checks.", values: { ParamMouthOpen: 0.6, ParamMouthForm: -0.55, ParamMouthSmile: 0.1 } },
  { id: "mouth-o", label: "MOUTH O", group: "expression", description: "Rounded open vowel target for lip containment checks.", values: { ParamMouthOpen: 0.75, ParamMouthForm: 0.8, ParamMouthSmile: 0 } },
  { id: "mouth-smile", label: "SMILE", group: "expression", description: "Smile mouth target from the hidden mouth reference layer.", values: { ParamMouthOpen: 0.45, ParamMouthForm: -0.25, ParamMouthSmile: 1 } },
  { id: "mouth-downturn", label: "MOUTH HE", group: "expression", description: "Downturned mouth target from the hidden mouth reference layer.", values: { ParamMouthOpen: 0.2, ParamMouthForm: -0.2, ParamMouthSmile: -1 } },
  { id: "eye-left-closed", label: "EYE L 0", group: "expression", description: "Left wink reference for eyelid curve.", values: { ParamEyeLOpen: 0, ParamEyeROpen: 1 } },
  { id: "eye-right-closed", label: "EYE R 0", group: "expression", description: "Right wink reference for eyelid curve.", values: { ParamEyeLOpen: 1, ParamEyeROpen: 0 } },
  { id: "blink", label: "BLINK", group: "expression", description: "Both eyes closed reference for eyelid symmetry.", values: { ParamEyeLOpen: 0, ParamEyeROpen: 0 } },
  { id: "talk-blink", label: "TALK BLINK", group: "expression", description: "Mouth open plus blink to check layer ordering.", values: { ParamMouthOpen: 0.75, ParamEyeLOpen: 0, ParamEyeROpen: 0 } }
];

const EYE_GAZE_REFERENCE_POSES: ReferencePosePreset[] = [
  { id: "gaze-up-left", label: "GAZE UP L", group: "expression", description: "Eyes look up and viewer-left without moving the head.", values: { ParamEyeBallX: -1, ParamEyeBallY: -1 } },
  { id: "gaze-up", label: "GAZE UP", group: "expression", description: "Eyes look up without moving the head.", values: { ParamEyeBallX: 0, ParamEyeBallY: -1 } },
  { id: "gaze-up-right", label: "GAZE UP R", group: "expression", description: "Eyes look up and viewer-right without moving the head.", values: { ParamEyeBallX: 1, ParamEyeBallY: -1 } },
  { id: "gaze-left", label: "GAZE LEFT", group: "expression", description: "Eyes look viewer-left without moving the head.", values: { ParamEyeBallX: -1, ParamEyeBallY: 0 } },
  { id: "gaze-center", label: "GAZE CENTER", group: "expression", description: "Neutral independent eye gaze.", values: { ParamEyeBallX: 0, ParamEyeBallY: 0 } },
  { id: "gaze-right", label: "GAZE RIGHT", group: "expression", description: "Eyes look viewer-right without moving the head.", values: { ParamEyeBallX: 1, ParamEyeBallY: 0 } },
  { id: "gaze-down-left", label: "GAZE DOWN L", group: "expression", description: "Eyes look down and viewer-left without moving the head.", values: { ParamEyeBallX: -1, ParamEyeBallY: 1 } },
  { id: "gaze-down", label: "GAZE DOWN", group: "expression", description: "Eyes look down without moving the head.", values: { ParamEyeBallX: 0, ParamEyeBallY: 1 } },
  { id: "gaze-down-right", label: "GAZE DOWN R", group: "expression", description: "Eyes look down and viewer-right without moving the head.", values: { ParamEyeBallX: 1, ParamEyeBallY: 1 } }
];
const BODY_REFERENCE_POSES: ReferencePosePreset[] = [
  { id: "body-neutral", label: "BODY NEUTRAL", group: "body", description: "Base body pose from the imported PSD.", values: {} },
  { id: "body-left", label: "BODY X -22", group: "body", description: "Body turns viewer-left; checks shoulder/collar and skirt.", values: { ParamBodyAngleX: -22, ParamAngleX: -8 } },
  { id: "body-right", label: "BODY X +22", group: "body", description: "Body turns viewer-right; checks shoulder/collar and skirt.", values: { ParamBodyAngleX: 22, ParamAngleX: 8 } },
  { id: "body-up", label: "BODY Y -14", group: "body", description: "Body pitch up; checks chest, collar, and neck shadow.", values: { ParamBodyAngleY: -14, ParamAngleY: -6 } },
  { id: "body-down", label: "BODY Y +14", group: "body", description: "Body pitch down; checks collar and upper torso compression.", values: { ParamBodyAngleY: 14, ParamAngleY: 6 } },
  { id: "body-counter-left", label: "COUNTER L", group: "body", description: "Head/body counter turn for natural VTuber motion.", values: { ParamAngleX: 18, ParamBodyAngleX: -16, ParamAngleY: 6 } },
  { id: "body-counter-right", label: "COUNTER R", group: "body", description: "Opposite head/body counter turn.", values: { ParamAngleX: -18, ParamBodyAngleX: 16, ParamAngleY: 6 } },
  { id: "body-stress", label: "BODY STRESS", group: "body", description: "Combined body pose used to expose upper/lower seam issues.", values: { ParamAngleX: -16, ParamAngleY: 10, ParamBodyAngleX: 24, ParamBodyAngleY: 12 } }
];

export function isReferenceSheetSet(value: string): value is ReferenceSheetSet {
  return value === "reference-face" || value === "reference-expression" || value === "reference-body" || value === "reference-all";
}

export function referenceSheetDefinitionsForRig(rig: RigDocument): ReferenceSheetDefinition[] {
  return [
    sheetDefinition("reference-face", "Face Reference", "Head angle targets for face, neck, outline, eyes, and hair roots.", FACE_REFERENCE_POSES),
    sheetDefinition("reference-expression", "Expression Reference", "Mouth, eyelid, and independent gaze targets for expression modeling.", [...EXPRESSION_REFERENCE_POSES, ...EYE_GAZE_REFERENCE_POSES]),
    sheetDefinition("reference-body", "Body Reference", "Body turn and counter-motion targets for torso, shoulder, skirt, and neck seams.", BODY_REFERENCE_POSES),
    sheetDefinition("reference-all", "All References", "Combined reference sheet for full modeling passes.", [
      ...FACE_REFERENCE_POSES,
      ...EXPRESSION_REFERENCE_POSES,
      ...EYE_GAZE_REFERENCE_POSES,
      ...BODY_REFERENCE_POSES
    ])
  ].map((definition) => ({
    ...definition,
    poses: definition.poses.map((pose) => ({
      ...pose,
      values: previewParameterValuesForRig(rig, pose.values)
    }))
  }));
}

export function referenceSheetPresetsForRig(
  rig: RigDocument,
  baseValues: Partial<ParameterValues>,
  set: ReferenceSheetSet
): Array<{ id: string; label: string; values: ParameterValues }> {
  const definition = referenceSheetDefinitionsForRig(rig).find((entry) => entry.id === set) ?? referenceSheetDefinitionsForRig(rig)[0];
  return definition.poses.map((pose) => ({
    id: pose.id,
    label: pose.label,
    values: previewParameterValuesForRig(rig, { ...baseValues, ...pose.values })
  }));
}

export function referenceSheetColumns(set: ReferenceSheetSet): number {
  return set === "reference-all" ? 4 : 4;
}

function sheetDefinition(
  id: ReferenceSheetSet,
  label: string,
  description: string,
  poses: ReferencePosePreset[]
): ReferenceSheetDefinition {
  return {
    id,
    label,
    description,
    columns: referenceSheetColumns(id),
    poses
  };
}
