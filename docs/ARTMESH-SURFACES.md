# Composing ArtMesh angle surfaces

An ArtMesh two- or three-parameter binding can declare `composition: "surface"` in a
RigDocument import. Its keyforms use the existing vertex IDs and offset format.
Bindings without this optional property retain their existing additive behavior.

Surface bindings map the already deformed vertex position through the rest mesh
and its sampled keyform. This allows a closed eyelid, mouth expression or cloth
motion to follow an angle surface. Adding the open-eye angle offsets to a closed
eye by vertex ID alone produces the wrong shape.

The order is legacy one-parameter bindings, legacy multi-parameter bindings,
blend shapes, then surface bindings in their authored array order. Surface
composition supersedes the binding's `additive` flag. An incomplete enclosing
keyform cell leaves the previous stage intact. Points outside the rest hull use
the nearest boundary triangle's affine extrapolation, preserving continuity.

One-parameter ArtMesh bindings may also declare `composition: "surface"`.
These run after the multi-parameter surface array, in one-parameter array order.
This supports rooted secondary cloth/hair displacement after the authored angle
material, while still following the part's later camera projection. Unmarked
one-parameter expression bindings retain their original first-stage behavior.

Both WebGL playback and server screenshots use this core resolver. This format
requires a StandRig build supporting surface composition; older builds add the
offsets and cannot reproduce the same model.

Numeric distortion QA checks each stage at the existing thresholds. For example,
an intentional mouth closure and a yaw foreshortening are checked separately.
Their combined compression is also reported under `composed`, with the number of
stage tests under `triangleStageTests`. Invalid expressions, inverted triangles
and excessive deformation within a surface stage still fail. These numeric
checks do not establish visual quality or replace the required reference review.

The feature has no Live2D SDK dependency. Reference sampling and character
artwork are separate local authoring inputs and are not part of StandRig.

## Local affine projection

`RigPart.affineBindings` is an optional array of two- or three-parameter stages. Each has
`parameters: ["X", "Y"]` or `["X", "Y", "Z"]` and a complete rectangular `keyforms` grid. A keyform
contains `inputs` and `matrix: {a,b,c,d,e,f}` in the standard 2D affine convention.
Matrices interpolate multilinearly, clamp at the grid limits, and act in array order
in pivot-relative part coordinates, inside the ordinary part/parent transforms. This
retains shear as well as rotation and foreshortening without decomposing matrices
into discontinuous Euler/SVD angles. Parent transforms and clipping use the same
evaluated matrix in both renderers.

This separates a measured local turn projection from a non-affine material
correction: inverse-project a target keyform to author its material surface, then
apply its affine projection at the part. Their keyform output remains unchanged.
Eye-local gaze can be authored as an ArtMesh binding before these stages.

Import validation rejects unknown parameters, incomplete/duplicate grid cells,
nonfinite matrices, singular keys and reflected keys. QA also checks the sampled
combined affine matrix at every requested pose, since positive key determinants
alone do not guarantee nonsingular interpolation. As with ordinary part/deformer
transforms, affine camera foreshortening is separate from ArtMesh material-strain
thresholds. Final silhouette, occlusion and connection review is still required.

## Combined XYZ and shared controls

Three-axis ArtMesh and projection grids interpolate the eight enclosing corners.
This permits authored combined poses rather than adding independently measured
XY and Z deformations in incompatible coordinate frames. Missing enclosing cells
produce an identity stage; invalid or duplicate parameter IDs are rejected.
Existing two-parameter modeling actions continue to edit only two-parameter grids.

Shared-warp control points also accept `multiBindings`, with two or three
`parameters`, `property: "offsetX" | "offsetY"`, and scalar `keyforms` containing
`inputs` and `value`. They run after one-parameter control bindings and before
blend shapes. The grid must be complete, finite, and refer to known parameters.
Normalization preserves the keys; resizing a keyed field requires explicit
remapping and is rejected by the ordinary resize helper.
