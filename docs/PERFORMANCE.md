# Large models and dense keyforms

The existing JSON and `.srig` formats remain supported. No artwork, motion keys or
deformation ranges are reduced by these optimizations.

## Storage and export

Small model JSON remains indented. Once its compact representation exceeds
8,388,608 characters, browser JSON exports and service model saves use compact
JSON. This avoids multiplying a dense offset document into a much larger
indented string. Parsing, JSON serialization and browser model loading still
need the full document in memory. This is not a streaming/binary model format.

Portable export and manifest hydration each create one owned geometry copy.
Embedding assets does not require a second complete model clone. Exported models
remain independent of the current model; PNG checks, local-path confinement,
manifest verification, transaction QA and atomic file replacement are retained.
Import/restore no longer clone a current model that will immediately be discarded.
Operation transactions still edit a separate candidate.

The HTTP model-body limit remains 384 MiB. Compressed-file size is not the same as
expanded JSON size. For larger projects, the next storage step is a versioned
container with separate geometry and PNG entries, bounded decompression and
streaming import/export. It needs a format/migration design and is not silently
substituted for existing `.srig` files here.

## Playback and editing

`StandRigPlayer` owns a cloned model snapshot. Its `RigRuntime` caches derived grid
indexes, key order, mesh structural validation and normalized sparse-offset lists
for that snapshot. Grid lookup selects only the enclosing 4 or 8 corners using
binary axis search. Valid offset arrays are reused directly; cached indexes do
not copy the complete vertex offsets or retain rendered frames.

Core functions and default `new RigRuntime(rig)` remain uncached for mutable
callers. In-place edits are visible on the next evaluation as before. An explicit
`new RigRuntime(rig, { cacheEvaluation: true })` requires an owned stable snapshot;
after any model edit, call `await runtime.setRig(rig)`, even if reusing the same
object. That discards the old indexes. Disposal also releases them. Cache scopes
are synchronous, nested safely and are restored after errors.

Motion-track time lookup already uses binary search. These changes primarily
address dense model keyforms, not the number of authored motion keys. Values,
interpolation, duplicate-key behavior, incomplete-grid rejection and zero-weight
replacement corners are preserved.

## Measuring locally

Build first, then run separate processes for comparable peaks:

```sh
node --expose-gc --max-old-space-size=8192 scripts/benchmark-model.mjs --model MODEL_JSON --poses POSE_FRAMES_JSON --output geometry-uncached.json
node --expose-gc --max-old-space-size=8192 scripts/benchmark-model.mjs --model MODEL_JSON --poses POSE_FRAMES_JSON --prepared --output geometry-prepared.json
node --expose-gc --max-old-space-size=8192 scripts/benchmark-model.mjs --mode bundle --model MODEL_JSON --public-dir PUBLIC_DIRECTORY --output bundle.json
```

The utility reads owner-specified local inputs and never uploads or copies them
into the source repository. It reports parsing separately, first-frame and warm
geometry time, the geometry-output hash, RSS/heap and process peak RSS. Geometry
timing excludes Canvas/WebGL drawing, GPU completion and display scheduling; it
is not an end-to-end FPS measurement. Cache construction remains cold-start work.

Further work should measure JSON parsing/transfer, checkpoint duplication and
texture residency separately. Workers, compressed transport, content-addressed
checkpoint assets and packed geometry can reduce those costs, but must preserve
revision/CAS checks, rollback completeness, mutation isolation and old-file import.
