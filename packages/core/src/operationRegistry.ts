import type { DeformBrush, ExtendedBlendShape } from './deformTypes.js';
import type { BindingProperty,ParameterCurve,ParameterDefinition,ParameterInterpolation,RigAlphaReveal,RigArtMeshPreset,RigArtMeshQuality,RigArtMeshTopology,RigArtMeshVertexOffset,RigBlendMode,RigClip,RigContourShade,RigDeformer,RigPartRole,RigPartTint,RigRotationDeformerMetadata,RigSymmetryContract,RigSymmetryLink,TransformProperty,WarpPinBindingProperty } from "./types.js";

/** Authoritative action definitions. Registry keys must equal their type literals. */
export interface ModelingActionRegistry {
  "blend-shape-set": { type: "blend-shape-set"; shape: ExtendedBlendShape };
  "deform-brush": { type: "deform-brush"; brush: DeformBrush };
  "transform": { type: "transform"; property: TransformProperty; operator: "add" | "set" | "multiply"; value: number };
  "part-visibility": { type: "part-visibility"; visible: boolean };
  "part-draw-order": { type: "part-draw-order"; drawOrder: number };
  "part-blend-mode": { type: "part-blend-mode"; mode: RigBlendMode };
  "part-tint": { type: "part-tint"; tint: RigPartTint | null };
  "part-contour-shade": { type: "part-contour-shade"; shade: RigContourShade | null };
  "part-alpha-reveal": { type: "part-alpha-reveal"; reveal: RigAlphaReveal | null };
  "part-clip": { type: "part-clip"; clip: RigClip | null };
  "role-confirm": { type: "role-confirm"; role: RigPartRole };
  "role-reclassify": { type: "role-reclassify"; expectedRole: RigPartRole; role: RigPartRole; reason: string };
  "parameter-add": { type: "parameter-add"; parameter: ParameterDefinition };
  "deformer-create": { type: "deformer-create"; deformer: RigDeformer };
  "deformer-kind-set": { type: "deformer-kind-set"; deformerId: string; kind: "group" | "rotate" | "warp"; warp?: RigDeformer["warp"] };
  "deformer-targets-set": { type: "deformer-targets-set"; deformerId: string; targetPartIds: string[]; mode?: "replace" | "merge" };
  "deformer-parent-set": { type: "deformer-parent-set"; deformerId: string; parentId: string | null };
  "deformer-origin": { type: "deformer-origin"; deformerId: string; x: number; y: number };
  "deformer-transform": { type: "deformer-transform"; deformerId: string; property: TransformProperty; operator: "set" | "add" | "multiply"; value: number };
  "artmesh-offset": { type: "artmesh-offset"; x: number; y: number; uv?: { minU: number; maxU: number; minV: number; maxV: number } };
  "artmesh-binding-key": { type: "artmesh-binding-key"; parameter: string; input: number; offsets: RigArtMeshVertexOffset[]; additive?: boolean; interpolation?: ParameterInterpolation; curve?: ParameterCurve };
  "artmesh-multi-key": { type: "artmesh-multi-key"; parameters: [string, string]; inputs: Record<string, number>; offsets: RigArtMeshVertexOffset[]; additive?: boolean; interpolation?: ParameterInterpolation; curve?: ParameterCurve };
  "artmesh-blend-shape": { type: "artmesh-blend-shape"; id: string; parameter: string; neutralInput: number; targetInput: number; offsets: RigArtMeshVertexOffset[]; additive?: boolean; interpolation?: ParameterInterpolation; curve?: ParameterCurve };
  "artmesh-mirror-key": { type: "artmesh-mirror-key"; parameter: string; sourceInput: number; targetInput: number; axisU?: number; tolerance?: number; protectVertexIds?: string[]; additive?: boolean; interpolation?: ParameterInterpolation; curve?: ParameterCurve };
  "artmesh-generate": { type: "artmesh-generate"; preset: RigArtMeshPreset; topology?: RigArtMeshTopology; columns: number; rows: number; alphaThreshold?: number; quality?: RigArtMeshQuality };
  "artmesh-rebuild": { type: "artmesh-rebuild"; preset: RigArtMeshPreset; topology?: RigArtMeshTopology; columns: number; rows: number; alphaThreshold?: number; quality?: RigArtMeshQuality; preserveBindings?: boolean };
  "artmesh-quality": { type: "artmesh-quality"; quality: RigArtMeshQuality; merge?: boolean };
  "binding-key": { type: "binding-key"; parameter: string; property: TransformProperty; input: number; value: number; additive?: boolean; interpolation?: ParameterInterpolation; curve?: ParameterCurve };
  "warp-pin-binding-key": { type: "warp-pin-binding-key"; deformerId: string; pinId: string; parameter: string; property: WarpPinBindingProperty; input: number; value: number; additive?: boolean; interpolation?: ParameterInterpolation; curve?: ParameterCurve };
  "deformer-binding-key": { type: "deformer-binding-key"; deformerId: string; parameter: string; property: BindingProperty; input: number; value: number; additive?: boolean; interpolation?: ParameterInterpolation; curve?: ParameterCurve };
  "deformer-binding-remove": { type: "deformer-binding-remove"; deformerId: string; parameter: string; property: BindingProperty };
  "deformer-split": { type: "deformer-split"; sourceDeformerId: string; parentDeformerId: string; moveParameterIds: string[]; parentName?: string; expectedParentId?: string; parentTags?: string[]; sourceTags?: string[] };
  "deformer-rotation-metadata": { type: "deformer-rotation-metadata"; deformerId: string; metadata: RigRotationDeformerMetadata };
  "symmetry-contract": { type: "symmetry-contract"; contract: RigSymmetryContract };
  "symmetry-artmesh-bindings": { type: "symmetry-artmesh-bindings"; links: RigSymmetryLink[]; overwrite?: boolean };
}

export type ModelingOperationAction = ModelingActionRegistry[keyof ModelingActionRegistry];
