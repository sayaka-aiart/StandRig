import type { PartBlendShape, DeformerBlendShape, ArtPathBlendShape, GlueBlendShape } from './deformTypes.js';
export const RIG_SCHEMA_VERSION = "0.1.0";

export const PARAMETER_IDS = [
  "ParamAngleX",
  "ParamAngleY",
  "ParamAngleZ",
  "ParamEyeBallX",
  "ParamEyeBallY",
  "ParamBodyAngleX",
  "ParamBodyAngleY",
  "ParamMouthOpen",
  "ParamMouthForm",
  "ParamMouthSmile",
  "ParamEyeLOpen",
  "ParamEyeROpen"
] as const;

export type KnownParameterId = (typeof PARAMETER_IDS)[number];

/**
 * Reserved vocabulary shared with the modeling side (see PARAMETERS.md).
 * These parameters exist as definitions/sliders and tracking targets even
 * before the model implements keyforms for them. They are intentionally NOT
 * part of PARAMETER_IDS so `missing-standard-parameter` validation does not
 * flag current rigs.
 */
export const RESERVED_PARAMETER_IDS = [
  "ParamBodyAngleZ",
  "ParamBreath",
  "ParamCheek",
  "ParamEyeLSmile",
  "ParamEyeRSmile",
  "ParamBrowLY",
  "ParamBrowRY",
  "ParamBrowLX",
  "ParamBrowRX",
  "ParamBrowLAngle",
  "ParamBrowRAngle",
  "ParamBrowLForm",
  "ParamBrowRForm",
  "ParamHairFront",
  "ParamHairSide",
  "ParamHairBack"
] as const;

export type ReservedParameterId = (typeof RESERVED_PARAMETER_IDS)[number];
export type ParameterValues = Record<string, number>;

export type PartKind = "group" | "image";
export type DeformerKind = "group" | "rotate" | "warp";
export type RigBlendMode = "normal" | "multiply" | "screen" | "additive";
export type RigTintMode = "multiply" | "screen";
export interface RigPartTint { mode: RigTintMode; color: string; opacity: number; }
export const TRANSFORM_PROPERTIES = ["x", "y", "rotation", "scaleX", "scaleY", "opacity"] as const;
export const WARP_BINDING_PROPERTIES = ["warp.bendX", "warp.bendY", "warp.taperX", "warp.taperY"] as const;
export const WARP_PIN_BINDING_PROPERTIES = ["offsetX", "offsetY"] as const;
export const PARAMETER_INTERPOLATIONS = ["linear", "smoothstep", "hold", "arc", "curve"] as const;

export type TransformProperty = (typeof TRANSFORM_PROPERTIES)[number];
export type WarpBindingProperty = (typeof WARP_BINDING_PROPERTIES)[number];
export type WarpPinBindingProperty = (typeof WARP_PIN_BINDING_PROPERTIES)[number];
export type BindingProperty = TransformProperty | WarpBindingProperty;
export type ParameterInterpolation = (typeof PARAMETER_INTERPOLATIONS)[number];

export interface StageDefinition {
  width: number;
  height: number;
  background?: "transparent" | "checker" | "solid";
  solidColor?: string;
}

export interface AssetDefinition {
  id: string;
  name: string;
  type: "image";
  src: string;
  sha256?: string;
  width?: number;
  height?: number;
}

export interface Transform2D {
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  pivotX: number;
  pivotY: number;
  opacity: number;
}

export interface ParameterDefinition {
  id: string;
  label: string;
  min: number;
  max: number;
  default: number;
  step?: number;
  group?: string;
}

export interface ParameterKeyframe {
  input: number;
  value: number;
}

/** Normalized easing curve used by interpolation="curve". Endpoints should be t=0/1. */
export interface ParameterCurveControlPoint {
  t: number;
  value: number;
}

export interface ParameterCurve {
  controlPoints: ParameterCurveControlPoint[];
}

export interface ParameterBinding {
  parameter: string;
  property: BindingProperty;
  keys: ParameterKeyframe[];
  additive?: boolean;
  /** Explicit composition for scale/opacity. Omit for legacy additive behavior. */
  composition?: "legacy-additive" | "multiply";
  interpolation?: ParameterInterpolation;
  curve?: ParameterCurve;
}

export interface MultiParameterKeyform {
  inputs: Record<string, number>;
  value: number;
}

export interface MultiParameterBinding {
  parameters: [string, string];
  composition?: "legacy-additive" | "multiply";
  property: BindingProperty | WarpBindingProperty | WarpPinBindingProperty;
  keyforms: MultiParameterKeyform[];
  additive?: boolean;
  interpolation?: ParameterInterpolation;
  curve?: ParameterCurve;
}

export interface DeformerOrigin {
  x: number;
  y: number;
}

/** Standardized authoring metadata for a Rotation Deformer. The evaluator ignores this descriptive contract so existing matrix output is unchanged. */
export interface RigRotationDeformerMetadata {
  version: 1;
  angleRange: { min: number; max: number };
  angleUnit: "deg";
  pivot: { x: number; y: number };
  pivotSpace: "stage" | "normalized";
  shapePreservation: "rigid" | "rigid-plus-warp" | "none";
  parentComposition: "parent-first" | "child-first";
}

export interface RigWarpPinBinding {
  parameter: string;
  property: WarpPinBindingProperty;
  keys: ParameterKeyframe[];
  additive?: boolean;
  interpolation?: ParameterInterpolation;
  curve?: ParameterCurve;
}

export interface RigWarpPinMultiBinding {
  parameters: [string, string];
  property: WarpPinBindingProperty;
  keyforms: MultiParameterKeyform[];
  additive?: boolean;
  interpolation?: ParameterInterpolation;
  curve?: ParameterCurve;
}

export interface RigWarpPin {
  id: string;
  name: string;
  enabled: boolean;
  u: number;
  v: number;
  offsetX: number;
  offsetY: number;
  radius: number;
  strength: number;
  linkedMirrorId?: string;
  bindings?: RigWarpPinBinding[];
  multiBindings?: RigWarpPinMultiBinding[];
}

export interface RigWarpDeformer {
  enabled: boolean;
  pinBlendMode?: "legacy" | "normalized";
  bendX: number;
  bendY: number;
  taperX: number;
  taperY: number;
  grid: {
    columns: number;
    rows: number;
  };
  pins?: RigWarpPin[];
}

export type RigArtMeshPreset = "eyelid" | "eye" | "mouth" | "outline" | "hair-root" | "face-feature";
export type RigArtMeshTopology = "rect-grid" | "alpha-contour";

export interface RigArtMeshVertex {
  id: string;
  x: number;
  y: number;
  u: number;
  v: number;
}

export interface RigArtMeshVertexOffset {
  vertexId: string;
  x: number;
  y: number;
}

export interface RigArtMeshSkinningInfluence {
  deformerId: string;
  weight: number;
}

/** Optional multi-deformer skinning contract for an ArtMesh. */
export interface RigArtMeshSkinning {
  version: 1;
  joints: Array<{ deformerId: string; role: "root" | "middle" | "tip" }>;
  vertexWeights: Record<string, RigArtMeshSkinningInfluence[]>;
}
export interface RigArtMeshBinding {
  parameter: string;
  additive?: boolean;
  interpolation?: ParameterInterpolation;
  curve?: ParameterCurve;
  keys: Array<{
    input: number;
    offsets: RigArtMeshVertexOffset[];
  }>;
}

export interface RigArtMeshMultiBinding {
  parameters: [string, string];
  additive?: boolean;
  interpolation?: ParameterInterpolation;
  curve?: ParameterCurve;
  keyforms: Array<{
    inputs: Record<string, number>;
    offsets: RigArtMeshVertexOffset[];
  }>;
}

export interface RigArtMeshBlendShape {
  id: string;
  parameter: string;
  neutralInput: number;
  targetInput: number;
  interpolation?: ParameterInterpolation;
  curve?: ParameterCurve;
  additive?: boolean;
  offsets: RigArtMeshVertexOffset[];
}
export interface RigArtMeshQuality {
  minTriangleArea?: number;
  maxTriangleAspectRatio?: number;
  boundaryVertexIds?: string[];
  lockedVertexIds?: string[];
  pinnedVertexIds?: string[];
}

export type RigArtPathProperty = "u" | "v" | "width" | "opacity" | "offsetX" | "offsetY";

export interface RigArtPathPointBinding {
  parameter: string;
  property: "u" | "v";
  keys: ParameterKeyframe[];
  interpolation?: ParameterInterpolation;
  curve?: ParameterCurve;
}

export interface RigArtPathPoint {
  id: string;
  u: number;
  v: number;
  bindings?: RigArtPathPointBinding[];
}

export interface RigArtPathBinding {
  parameter: string;
  property: Exclude<RigArtPathProperty, "u" | "v">;
  keys: ParameterKeyframe[];
  interpolation?: ParameterInterpolation;
  curve?: ParameterCurve;
}

export interface RigArtPath {
  blendShapes?: ArtPathBlendShape[];
  version: 1;
  id: string;
  name: string;
  enabled: boolean;
  closed?: boolean;
  curve?: "polyline" | "smooth";
  strokeColor: string;
  strokeWidth: number;
  opacity: number;
  points: RigArtPathPoint[];
  bindings?: RigArtPathBinding[];
}

export interface RigArtMesh {
  version: 1;
  enabled: boolean;
  generator: {
    preset: RigArtMeshPreset;
    /** Omitted meshes were generated by the original rectangular-grid generator. */
    topology?: RigArtMeshTopology;
    columns: number;
    rows: number;
    alphaThreshold: number;
    alphaBounds: { left: number; top: number; width: number; height: number };
    quality?: RigArtMeshQuality;
  };
  vertices: RigArtMeshVertex[];
  triangles: number[];
  bindings?: RigArtMeshBinding[];
  multiBindings?: RigArtMeshMultiBinding[];
  blendShapes?: RigArtMeshBlendShape[];
  skinning?: RigArtMeshSkinning;
}

/** A stage-coordinate field shared by every descendant of a deformer. */
export interface RigSharedWarpBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface RigSharedWarpControlPoint {
  bindings?: RigWarpPinBinding[];
  id: string;
  column: number;
  row: number;
  offsetX: number;
  offsetY: number;
  enabled?: boolean;
}

export interface RigSharedWarpField {
  version: 1;
  enabled: boolean;
  bounds: RigSharedWarpBounds;
  grid: { columns: number; rows: number };
  controlPoints: RigSharedWarpControlPoint[];
}

export interface RigDeformer {
  blendShapes?: DeformerBlendShape[];
  id: string;
  name: string;
  kind: DeformerKind;
  parentId: string | null;
  visible: boolean;
  locked?: boolean;
  origin: DeformerOrigin;
  transform: Transform2D;
  warp?: RigWarpDeformer;
  bindings?: ParameterBinding[];
  sharedWarp?: RigSharedWarpField;
  targetPartIds?: string[];
  multiBindings?: MultiParameterBinding[];
  tags?: string[];
  rotationMetadata?: RigRotationDeformerMetadata;
}

export interface RigClip {
  mode: "alpha";
  /** v1 single-source shorthand retained for existing eye masks. */
  maskPartId?: string;
  /** Alpha-union sources for a shared clipped group. */
  maskPartIds?: string[];
  /** Ignore source visibility/opacity while retaining evaluated geometry. */
  maskOpacity?: "rendered" | "ignore";
}

export type RigPartRole =
  | "unknown"
  | "face"
  | "eye-left"
  | "eye-right"
  | "brow-left"
  | "brow-right"
  | "face-feature"
  | "mouth"
  | "hair-front"
  | "hair-back"
  | "hair-side"
  | "hair-tail-left"
  | "hair-tail-right"
  | "neck"
  | "torso"
  | "soft-tissue"
  | "clothing"
  | "accessory";

export type RigPartRoleStatus = "suggested" | "confirmed";
export interface RigContourShade {
  color: string;
  /** Gaussian band width as a fraction of the source image width. */
  width: number;
  strength: number;
  axisStrength: number;
  yawParameter: string;
  pitchParameter: string;
  maxYaw: number;
  maxPitch: number;
  /** Optional cheek-shaped side plane; omitted retains the original edge band. */
  profile?: "cheek";
  /** Fade the far cheek's ink toward adjacent skin, without changing coverage. */
  farContourFade?: number;
  /** Soften the near cheek ink into its shaded side plane, retaining the chin tip. */
  nearContourFade?: number;
  /** Fade the lower jaw on negative (upward) pitch. */
  upContourFade?: number;
  /** Underside shadow on negative (upward) pitch. */
  upShadowStrength?: number;
  /** Width of the ink repair region, relative to source width. */
  lineWidth?: number;
}

export interface RigAlphaReveal {
  /** 0 closes toward the upper edge; 1 toward the lower edge. */
  anchor?: number;
  parameter: string;
  closed: number;
  open: number;
  exponent: number;
}

export interface RigPart {
  blendShapes?: PartBlendShape[];
  alphaReveal?: RigAlphaReveal;
  contourShade?: RigContourShade;
  id: string;
  name: string;
  kind: PartKind;
  assetId?: string;
  parentId: string | null;
  deformerId?: string | null;
  blendMode?: RigBlendMode;
  tint?: RigPartTint;
  clip?: RigClip;
  artMesh?: RigArtMesh;
  artPaths?: RigArtPath[];
  role?: RigPartRole;
  roleStatus?: RigPartRoleStatus;
  roleConfidence?: number;
  visible: boolean;
  locked?: boolean;
  drawOrder: number;
  transform: Transform2D;
  warp?: RigWarpDeformer;
  bindings?: ParameterBinding[];
  tags?: string[];
  multiBindings?: MultiParameterBinding[];
}

export interface PhysicsInput {
  parameter: string;
  scale: number;
}

export interface PhysicsOutput {
  property: TransformProperty;
  scale: number;
}

export interface PhysicsParameterOutput {
  parameter: string;
  scale: number;
  min?: number;
  max?: number;
}

export interface PhysicsSegment {
  id: string;
  length: number;
  delay: number;
  damping: number;
}
export interface PhysicsChain {
  id: string;
  name: string;
  enabled: boolean;
  targetPartIds: string[];
  sourceParameters: PhysicsInput[];
  stiffness: number;
  damping: number;
  mass: number;
  gravity: number;
  wind: number;
  output: PhysicsOutput;
  /** Prefer deformer targets when the output must rotate around an authored origin. */
  targetDeformerIds?: string[];
  parameterOutput?: PhysicsParameterOutput;
  segments?: PhysicsSegment[];
}

export interface RigPhysics {
  enabled: boolean;
  chains: PhysicsChain[];
}

export type RigGlueCandidateKind = "overlap" | "near-gap" | "manual";
export type RigGlueCandidateStatus = "candidate" | "accepted" | "rejected";

export interface RigGlueCandidateBBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface RigGlueCandidateEvidence {
  source: "boundary-diagnostics" | "manual";
  runDir?: string;
  summaryPath?: string;
  imagePath?: string;
  region?: string;
  poseId?: string;
  overlapPixels?: number;
  overlapRatio?: number;
  gapPixels?: number;
  unionBBox?: RigGlueCandidateBBox;
}

export interface RigGlueCandidate {
  id: string;
  name: string;
  enabled: boolean;
  status: RigGlueCandidateStatus;
  kind: RigGlueCandidateKind;
  partAId: string;
  partBId: string;
  region?: string;
  weightA: number;
  weightB: number;
  priority: number;
  tags?: string[];
  notes?: string;
  evidence: RigGlueCandidateEvidence;
}
/**
 * `soft-seam` nudges both parts toward each other with generated warp pins and can only ever close
 * a fraction of a gap. `stitch` is the vertex-level bind: paired ArtMesh vertices are moved onto a
 * single shared position after every deformer, warp and skinning step, so the seam cannot open.
 */
export type RigGlueMode = "seam-debug" | "soft-seam" | "stitch";
export type RigGlueStatus = "draft" | "active" | "disabled";

/**
 * One stitched vertex pair. `weight` is the share of the correction taken by the A side, so 0 pins
 * A and drags B onto it.
 *
 * `restDx`/`restDy` are the neutral-pose offset from A to B. Parts here overlap by design (the neck
 * is drawn under the jaw), so their paired boundary vertices do not coincide at neutral. Holding
 * that recorded offset keeps the neutral pose pixel-identical while still locking the seam under
 * motion. Omit both to collapse the pair onto a single point, which is the classic glue behaviour
 * and is correct when the vertices were authored to coincide.
 */
export interface RigGlueVertexPair {
  a: string;
  b: string;
  weight?: number;
  restDx?: number;
  restDy?: number;
}

export interface RigGlueSeamUv {
  u: number;
  v: number;
}

export interface RigGlueSeamPoint {
  a: RigGlueSeamUv;
  b: RigGlueSeamUv;
  weightA?: number;
  weightB?: number;
  radius?: number;
  strength?: number;
}
export interface RigGlue {
  blendShapes?: GlueBlendShape[];
  id: string;
  name: string;
  enabled: boolean;
  status: RigGlueStatus;
  mode: RigGlueMode;
  sourceCandidateId?: string;
  partAId: string;
  partBId: string;
  region?: string;
  weightA: number;
  weightB: number;
  strength: number;
  priority: number;
  debugVisible?: boolean;
  seamPoints?: RigGlueSeamPoint[];
  vertexPairs?: RigGlueVertexPair[];
  tags?: string[];
  notes?: string;
  evidence?: RigGlueCandidateEvidence;
}
export type TrackingProvider = "manual" | "mediapipe-face-landmarker";
export type TrackingInputValues = Record<string, number>;
export type TrackingFilter = "ema" | "one-euro";
/** Shape applied to a normalized tracking input before scale/offset. */
export type TrackingResponseCurve = "linear" | "smoothstep" | "gamma";

export interface OneEuroFilterOptions {
  minCutoff?: number;
  beta?: number;
  derivativeCutoff?: number;
}

export interface TrackingMapping {
  id: string;
  enabled: boolean;
  source: string;
  parameter: string;
  scale: number;
  offset: number;
  min?: number;
  max?: number;
  smoothing: number;
  invert?: boolean;
  /** Normalized dead zone (0..0.95) applied around the calibrated neutral. */
  deadZone?: number;
  /** Input filter used before scale/offset are applied. */
  filter?: TrackingFilter;
  oneEuro?: OneEuroFilterOptions;
  /** Response shaping applied after input filtering (defaults to linear). */
  responseCurve?: TrackingResponseCurve;
  /** Exponent used by the gamma response curve (clamped to 0.25..4). */
  responseGamma?: number;
}

export interface TrackingEyeSync {
  enabled: boolean;
  /** Difference between eye openings below which both eyes are averaged. */
  winkThreshold: number;
  /** Hard keeps the legacy cutoff; smoothstep fades the sync weight at the threshold. */
  winkCurve?: "hard" | "smoothstep";
  /** Per-eye opening gain applied around the closed state (no offset). */
  leftGain?: number;
  rightGain?: number;
}

export interface RigTracking {
  enabled: boolean;
  provider: TrackingProvider;
  inputSmoothing: number;
  mappings: TrackingMapping[];
  /** Neutral-pose offsets per input source, captured by calibration. */
  calibration?: Record<string, number>;
  eyeSync?: TrackingEyeSync;
}

export interface ImportLayerBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface ImportLayerReport {
  path: string;
  name: string;
  kind: "group" | "image" | "skipped";
  hidden: boolean;
  rawOpacity?: number;
  opacity: number;
  blendMode?: string;
  parentId: string;
  partId?: string;
  assetId?: string;
  hasCanvas: boolean;
  hasPixels: boolean;
  sampledPixels: number;
  nonTransparentSamples: number;
  transparentRatio: number;
  bounds: ImportLayerBounds;
  warnings: string[];
}

export interface RigImportReport {
  kind: "psd" | "images";
  fileName: string;
  importedAt: string;
  document: {
    width: number;
    height: number;
  };
  totals: {
    groups: number;
    imageLayers: number;
    skippedLayers: number;
    hiddenLayers: number;
    transparentLayers: number;
    lowOpacityLayers: number;
    warnings: number;
  };
  warnings: string[];
  layers: ImportLayerReport[];
}

export interface RigPhonemeReferenceTarget {
  id: string;
  label: string;
  partId: string;
  assetId?: string;
  sourcePath: string;
  aliases?: string[];
  compare?: {
    poseId?: string;
    parameterValues?: Partial<ParameterValues>;
  };
}

export interface RigPhonemeReferences {
  version: number;
  sourceGroupPartId?: string;
  sourceTags: string[];
  runtimePolicy: "hidden-runtime";
  targets: RigPhonemeReferenceTarget[];
}

export interface RigMetadata {
  source?: string;
  importedAt?: string;
  format?: string;
  notes?: string;
  importReport?: RigImportReport;
  previewParams?: Partial<ParameterValues>;
  phonemeReferences?: RigPhonemeReferences;
  [key: string]: unknown;
}

export type RigSymmetryLinkKind = "part" | "deformer" | "warp-pin" | "physics";
export interface RigSymmetryLink {
  kind: RigSymmetryLinkKind;
  sourceId: string;
  targetId: string;
  axis: "x";
  invertX?: boolean;
  preserveY?: boolean;
}
export interface RigSymmetryContract {
  version: 1;
  axis: "vertical";
  axisU: number;
  tolerance: number;
  confidence: number;
  protectedPartIds: string[];
  protectedDeformerIds: string[];
  protectedVertexIds: Record<string, string[]>;
  links: RigSymmetryLink[];
}
export interface RigDocument {
  schemaVersion: string;
  name: string;
  stage: StageDefinition;
  metadata?: RigMetadata;
  assets: AssetDefinition[];
  parameters: ParameterDefinition[];
  parts: RigPart[];
  deformers?: RigDeformer[];
  glueCandidates?: RigGlueCandidate[];
  glue?: RigGlue[];
  physics: RigPhysics;
  tracking?: RigTracking;
  symmetry?: RigSymmetryContract;
}

export const DEFAULT_TRANSFORM: Transform2D = {
  x: 0,
  y: 0,
  rotation: 0,
  scaleX: 1,
  scaleY: 1,
  pivotX: 0.5,
  pivotY: 0.5,
  opacity: 1
};

export function cloneRig(rig: RigDocument): RigDocument {
  return structuredClone(rig);
}
