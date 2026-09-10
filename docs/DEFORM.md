# AI deformation operations

`deform-brush` provides six deterministic 2D deformation operators. `blend-shape-set` adds owner-local shapes to Parts, Deformers, ArtPaths and Glue. Existing ArtMesh shapes remain supported by `artmesh-blend-shape` and the Brush destination below. These are numeric modeling APIs, not a mouse Brush UI or image-generation system.

Read the artwork reference gate in [AGENTS.md](../AGENTS.md) before editing a PSD. Fetch context and compact target records first. All persistent operations go through the revision-checked, QA-gated transaction. Start with `commit:false`, inspect the reports and the actual rendered result, then commit against the same revision. Keep the returned rollback checkpoint. Changes to multiple owners can be grouped in one transaction.

## Brush contract

| Effect | Required effect fields | Meaning |
| --- | --- | --- |
| smooth | `mode`, `strength` in 0..1 | Smooth displacement relative to the reference mesh; does not intentionally shrink an undeformed mesh |
| relax | `mode`, `strength` in 0..1 | Redistribute interior points toward their neighbours; keep the boundary fixed |
| inflate | `mode`, nonnegative `distance` | Move radially outward from the center; a point exactly at the center stays fixed |
| pinch | `mode`, `strength` in 0..1, nonzero `axis:[x,y]` | Pull toward the line through the center along the given axis |
| bend | `mode`, `angle` in -180..180 degrees, nonzero `axis` | Bend along that axis around a circular arc, with radius derived from Brush radius and angle |
| contour-follow | `mode`, `strength` in 0..1, ordered `vertexIds`, `guide:[[x,y],...]` | Match an explicitly ordered, connected boundary to the guide by arc length |

Every request also requires `center`, positive `radius`, `iterations` (integer 1..50), positive `maxDisplacement`, `falloff` (`linear` or `smooth`), `surface` and `destination`. Radius and maximum displacement use the selected surface's coordinate units. The maximum displacement is the total per-point change for this operation, not a limit per iteration. Falloff is measured from the original points. Smooth/relax/contour strength is applied per iteration; inflate distance and bend/pinch intensity are divided across iterations. Repeating an operation intentionally applies another edit; it is not an idempotent set.

| Surface | Coordinates and target | Destinations |
| --- | --- | --- |
| `{kind:"artmesh",space:"mesh-local"}` | Source asset local pixels; explicit Part IDs or confirmed roles | `base`, `blend-shape`, additive `keyform` |
| `{kind:"warp-pins",space:"warp-local",width,height}` | Pin UV multiplied by the supplied positive dimensions, plus pixel offsets; explicit Deformer IDs | `base`, `blend-shape`, additive `keyform` |
| `{kind:"shared-warp",space:"stage"}` | Shared field bounds in stage coordinates, plus offsets; explicit Deformer IDs | `base`, `blend-shape`, additive `keyform` |

Warp Pin smooth/relax requires explicit `edges:[[pinId,pinId],...]`. Adjacency for meshes and complete shared grids is derived automatically; do not supply `edges` for these surfaces. Irregular Warp Pins do not support contour-follow, because their boundary is not defined. The Brush does not sculpt ArtPath or Glue geometry; their Blend Shape channels are authored through `blend-shape-set`.

Brush calculations use base geometry plus the selected destination's existing deltas. They do not invert a currently posed/skinned screen-space mesh. For base ArtMesh smoothing the reference is UV multiplied by asset size; for shape/keyform smoothing it is the base mesh. Brush output preserves vertex IDs, UVs and topology. Existing locked/pinned/protected vertices and explicit `lockedIds` stay fixed. Protected Parts/Deformers are rejected. A final triangle inversion or degenerate triangle rejects the entire operation; irregular pin fields lack triangles and still require deformation QA. Combined shapes and intermediate animation poses also require QA and visual checks.

`operationResults[].deformReports` contains per-owner changed-point count, maximum displacement, clipped-point count, minimum triangle-area ratio (null for no triangles), and locked-point count. This is numeric evidence, not visual acceptance.

### Example: create an ArtMesh bend shape

Use an existing enabled ArtMesh and replace `body` and parameter IDs with confirmed IDs from context. The JSON below is the operation object inside `operations`:

```json
{
  "id": "bend-body",
  "name": "Create bounded body bend",
  "target": { "partIds": ["body"] },
  "action": {
    "type": "deform-brush",
    "brush": {
      "surface": { "kind": "artmesh", "space": "mesh-local" },
      "center": [80, 100],
      "radius": 160,
      "effect": { "mode": "bend", "angle": 15, "axis": [0, 1] },
      "iterations": 2,
      "maxDisplacement": 5,
      "falloff": "smooth",
      "destination": {
        "kind": "blend-shape",
        "shape": { "id": "body-bend", "parameter": "ParamAngleX", "neutralInput": 0, "targetInput": 30 }
      }
    }
  }
}
```

For an additive ArtMesh keyform use `destination:{kind:"keyform",parameter:"ParamAngleX",input:30}`. A new binding gets an empty key at the parameter default if it differs from the requested input. Ambiguous multiple bindings or nonadditive destinations are rejected. `destination:{kind:"base"}` directly edits the base; this can affect every existing pose.

## Extended Blend Shapes

Use `action:{type:"blend-shape-set",shape:{...}}`. Every shape has `id`, `kind`, `parameter`, `neutralInput`, `targetInput`, and optional `interpolation`/`curve`. IDs are owner-local, not a rig-global expression registry. A repeated ID replaces the whole shape; omitted channels are removed. Share a parameter across owners to drive one expression. At most 128 shapes per owner are accepted.

| Kind | Payload | Target |
| --- | --- | --- |
| `part` | `transform:{x?,y?,rotation?,scaleX?,scaleY?,opacity?}` | Parts |
| `deformer` | optional `transform`, `warp:{bendX?,bendY?,taperX?,taperY?}`, `pins:[{id,x,y}]`, `sharedPoints:[{id,x,y}]` | Explicit Deformer IDs |
| `art-path` | `pathId`, optional `points:[{id,x,y}]`, `width`, `opacity` | Owning Part; path must exist |
| `glue` | `glueId`, `strength` delta | Both connected Parts; soft-seam or stitch mode |

Translation and pin/shared-point offsets are pixels; rotation is degrees. Transform scale values are **positive multipliers**, not additive differences: `scaleX:1.1` means 10% wider at full weight. At weight `w` scale multiplies by `scaleX ** w`; other transform channels add `delta * w`. Shapes compose after keyforms and before direct physics offsets. Parameter physics is evaluated before shape sampling.

ArtPath point offsets are normalized UV; width uses pixels. Path UV/style retain the renderer's existing clamps. Opacity adds then clamps to 0..1. Glue strength adds then clamps to 0..1; stitch starts at 1 to preserve its previous full-constraint behavior, while soft-seam starts at its stored strength. Stitch weight 0.5 requests half of the gap correction, independent of solver iteration count for an isolated pair. Coupled seams still require combined QA.

```json
{
  "id": "cheek-expression",
  "name": "Part expression",
  "target": { "partIds": ["body"] },
  "action": {
    "type": "blend-shape-set",
    "shape": {
      "kind": "part", "id": "expression",
      "parameter": "ParamAngleX", "neutralInput": 0, "targetInput": 30,
      "transform": { "x": 2, "rotation": 3, "scaleX": 1.05 }
    }
  }
}
```

The APIs currently upsert shapes. To remove an accepted edit use checkpoint restore, or replace its channels with zero deltas (scale multiplier 1). There is no dedicated shape-delete operation yet.

## Compatibility and validation

A negative target previously sampled ArtMesh weight backwards. Weight now uses `clamp((input-neutralInput)/(targetInput-neutralInput),0,1)` before interpolation for both directions. Existing shapes with a target below neutral must be visually rechecked; their stored data is not automatically rewritten.

HTTP and MCP use generated strict action schemas. Wrong field types and unknown keys are rejected at the boundary. Numeric ranges, existing owner/point references, locks and geometric constraints are checked by the core; passing JSON Schema alone does not authorize a valid deformation. The generated document-schema Blend Shape definitions are also checked by `npm test`. Older runtimes do not evaluate these new channels; use the matching core/runtime build.

Use explicit QA `poseSamples` at neutral, intermediate and target weights, plus combinations of expressions. Automated synthetic checks and a Sample Bot browser check are recorded in [VALIDATION.md](VALIDATION.md); they do not qualify a production character or Model Freeze.


## Warp keyform output

For either Warp surface, use `destination:{"kind":"keyform","parameter":"ParamAngleX","input":15}`. Target explicit Deformer IDs. The Brush saves additive `offsetX` / `offsetY` keys in each point's `bindings` (Warp pins or shared-grid control points), leaving base offsets and Blend Shapes intact. Playback evaluates these bindings before Blend Shapes.

Editing a new key starts from the selected parameter's interpolated offsets at that input, not zero. Editing an existing key starts from its saved offsets. Other stored keys, other parameter channels and interpolation/curve metadata remain intact. If the parameter default has no explicit key, its previous sampled value is inserted to retain that default pose, except when editing the default itself. New channels start with a zero default key. Inserting or changing a key changes interpolation in adjacent intervals; it cannot preserve every intermediate pose. Existing key values are preserved, but values between them require review.

Only changed, unlocked, enabled point channels are written. Per-operation displacement limits apply relative to the sampled key. A point supports at most 16 bindings. Duplicate channels/duplicate key inputs, nonadditive channels, and overlapping two-parameter bindings are rejected rather than silently choosing a binding. Other parameter poses, skinning and Blend Shapes are excluded from the Brush working geometry; use combined-pose QA afterwards. Resizing a shared grid with keys is rejected until explicit key remapping is available.

The operation is still `deform-brush`; no new MCP tool or action discriminator is needed. Both HTTP and MCP support trial, QA-gated commit and checkpoint restore. Older runtimes do not evaluate shared-grid control-point bindings; update core and runtime together.


## Target selection and schema constraints

Part-target operations share `modelingTarget.ts`: nonempty `partIds` and `roles` filters intersect (AND across fields, OR within each list). Role selection requires a confirmed role; IDs alone can select unconfirmed Parts. Empty arrays count as absent filters, and an empty target never selects all Parts. Brush and extended shapes fail without writing when no Part matches; they also retain their stricter missing-reference and locked-target rejection. These error policies do not expand the matching set. For example, `{partIds:["a","b"],roles:["torso"]}` edits only listed IDs whose confirmed role is torso, never every torso or every listed Part.

Numeric constraint metadata is attached to the registry's referenced Brush types in `deformTypes.ts` using `@integer`, `@minimum`, `@maximum` and `@exclusiveMinimum`. The schema generator carries these into strict Zod, MCP JSON Schema and OpenAPI. This currently covers iterations 1..50 integer, positive radius/displacement/Warp dimensions, strength 0..1, nonnegative inflate distance and bend angle -180..180. Cross-field rules, nonzero axes, model-dependent parameter ranges, adjacency and geometry validation remain core responsibilities. Core checks remain active for direct calls; boundary tests check agreement with the generated constraints.
