# Modeling operation actions

Generated from `packages/core/src/operationRegistry.ts`. Read `packages/core/src/types.ts` for referenced Rig*, Binding*, Parameter* and Transform* types.

TypeScript action types and Zod schemas are derived from the same registry. HTTP and MCP share a `type`-discriminated union in `packages/contracts`; unknown keys in typed objects are rejected. Run `npm run schemas` after changing types.

Each operation requires `id`, `name`, `target`, `action`; `enabled` is optional. Target is `{partIds?: string[], roles?: RigPartRole[], deformerIds?: string[]}`. Confirm IDs from this model. Some actions require matching target and action IDs.

## blend-shape-set

```ts
{ type: "blend-shape-set"; shape: ExtendedBlendShape }
```

## deform-brush

```ts
{ type: "deform-brush"; brush: DeformBrush }
```

## transform

```ts
{ type: "transform"; property: TransformProperty; operator: "add" | "set" | "multiply"; value: number }
```

## part-visibility

```ts
{ type: "part-visibility"; visible: boolean }
```

## part-draw-order

```ts
{ type: "part-draw-order"; drawOrder: number }
```

## part-blend-mode

```ts
{ type: "part-blend-mode"; mode: RigBlendMode }
```

## part-tint

```ts
{ type: "part-tint"; tint: RigPartTint | null }
```

## part-contour-shade

```ts
{ type: "part-contour-shade"; shade: RigContourShade | null }
```

## part-alpha-reveal

```ts
{ type: "part-alpha-reveal"; reveal: RigAlphaReveal | null }
```

## part-clip

```ts
{ type: "part-clip"; clip: RigClip | null }
```

## role-confirm

```ts
{ type: "role-confirm"; role: RigPartRole }
```

## role-reclassify

```ts
{ type: "role-reclassify"; expectedRole: RigPartRole; role: RigPartRole; reason: string }
```

## parameter-add

```ts
{ type: "parameter-add"; parameter: ParameterDefinition }
```

## deformer-create

```ts
{ type: "deformer-create"; deformer: RigDeformer }
```

## deformer-kind-set

```ts
{ type: "deformer-kind-set"; deformerId: string; kind: "group" | "rotate" | "warp"; warp?: RigDeformer["warp"] }
```

## deformer-targets-set

```ts
{ type: "deformer-targets-set"; deformerId: string; targetPartIds: string[]; mode?: "replace" | "merge" }
```

## deformer-parent-set

```ts
{ type: "deformer-parent-set"; deformerId: string; parentId: string | null }
```

## deformer-origin

```ts
{ type: "deformer-origin"; deformerId: string; x: number; y: number }
```

## deformer-transform

```ts
{ type: "deformer-transform"; deformerId: string; property: TransformProperty; operator: "set" | "add" | "multiply"; value: number }
```

## artmesh-offset

```ts
{ type: "artmesh-offset"; x: number; y: number; uv?: { minU: number; maxU: number; minV: number; maxV: number } }
```

## artmesh-binding-key

```ts
{ type: "artmesh-binding-key"; parameter: string; input: number; offsets: RigArtMeshVertexOffset[]; additive?: boolean; interpolation?: ParameterInterpolation; curve?: ParameterCurve }
```

## artmesh-multi-key

```ts
{ type: "artmesh-multi-key"; parameters: [string, string]; inputs: Record<string, number>; offsets: RigArtMeshVertexOffset[]; additive?: boolean; interpolation?: ParameterInterpolation; curve?: ParameterCurve }
```

## artmesh-blend-shape

```ts
{ type: "artmesh-blend-shape"; id: string; parameter: string; neutralInput: number; targetInput: number; offsets: RigArtMeshVertexOffset[]; additive?: boolean; interpolation?: ParameterInterpolation; curve?: ParameterCurve }
```

## artmesh-mirror-key

```ts
{ type: "artmesh-mirror-key"; parameter: string; sourceInput: number; targetInput: number; axisU?: number; tolerance?: number; protectVertexIds?: string[]; additive?: boolean; interpolation?: ParameterInterpolation; curve?: ParameterCurve }
```

## artmesh-generate

```ts
{ type: "artmesh-generate"; preset: RigArtMeshPreset; topology?: RigArtMeshTopology; columns: number; rows: number; alphaThreshold?: number; quality?: RigArtMeshQuality }
```

## artmesh-rebuild

```ts
{ type: "artmesh-rebuild"; preset: RigArtMeshPreset; topology?: RigArtMeshTopology; columns: number; rows: number; alphaThreshold?: number; quality?: RigArtMeshQuality; preserveBindings?: boolean }
```

## artmesh-quality

```ts
{ type: "artmesh-quality"; quality: RigArtMeshQuality; merge?: boolean }
```

## binding-key

```ts
{ type: "binding-key"; parameter: string; property: TransformProperty; input: number; value: number; additive?: boolean; interpolation?: ParameterInterpolation; curve?: ParameterCurve }
```

## warp-pin-binding-key

```ts
{ type: "warp-pin-binding-key"; deformerId: string; pinId: string; parameter: string; property: WarpPinBindingProperty; input: number; value: number; additive?: boolean; interpolation?: ParameterInterpolation; curve?: ParameterCurve }
```

## deformer-binding-key

```ts
{ type: "deformer-binding-key"; deformerId: string; parameter: string; property: BindingProperty; input: number; value: number; additive?: boolean; interpolation?: ParameterInterpolation; curve?: ParameterCurve }
```

## deformer-binding-remove

```ts
{ type: "deformer-binding-remove"; deformerId: string; parameter: string; property: BindingProperty }
```

## deformer-split

```ts
{ type: "deformer-split"; sourceDeformerId: string; parentDeformerId: string; moveParameterIds: string[]; parentName?: string; expectedParentId?: string; parentTags?: string[]; sourceTags?: string[] }
```

## deformer-rotation-metadata

```ts
{ type: "deformer-rotation-metadata"; deformerId: string; metadata: RigRotationDeformerMetadata }
```

## symmetry-contract

```ts
{ type: "symmetry-contract"; contract: RigSymmetryContract }
```

## symmetry-artmesh-bindings

```ts
{ type: "symmetry-artmesh-bindings"; links: RigSymmetryLink[]; overwrite?: boolean }
```
